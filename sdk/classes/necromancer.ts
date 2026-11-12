// The standard Necromancer: a starting point a bot imports into bots/<bot>/character.ts and tunes. Its summon puts it in
// shade: nobody can attack it (AbstractServerRules.cs:449-455), it can't melee, and its servant is its body: the servant's
// health is what an enemy takes, and its death drops the owner out of shade at 10 % of its health. Every spell it has is a
// PetSpell, cast in two halves: the owner's, then the servant's (PetSpellHandler.cs). The group's pet behaviours leave a
// shade alone (pets.ts petControl), and its nukes are no Spellbook nukes, so this kit does all of it:
//  - raiseServant: the servant, 20 s of cast, only with nothing hostile near.
//  - fallBack: with no servant and enemies near, it walks away from them to raise one: out of shade it is cloth at 10 %.
//  - keepTether: the servant is lost past 1500 for 10 s, at once past 2000 (NecromancerPetBrain.cs:300-326): it follows.
//  - servantFight: the servant at the focus, then the PetSpell nuke servantNuke picks: under a melee one whose servant half is
//    instant (the owner casts, and a shade can't be interrupted), else the hardest hit.
//  - servantHeal and servantBuffs: its heal over time and its buffs, which no healer of the group casts on a pet.
// learnings/classes/necromancer.md has the runs, and what the group's heals, positions and death counts make of a shade.

import { buffRetryMs, QUIET_PHASES, type TacticsSettings } from '../group/behaviors';
import { dist } from '../group/battleground';
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import { onMap } from '../group/terrain';
import type { Point } from '../group/types';
import { focusToHit, hostileNear, HARM_TYPES, SUMMON_CLEAR_RADIUS, SUMMON_MAP_MARGIN, summonClear, through, waiting, type Through } from './summoner';

export interface NecromancerOptions {
    /** No nukes below this % power. 0 (the default): no floor. Its servant's heal goes at any. */
    saveBelow?: number;
    /** Area spells too (Channeled, Billowing Death): they wake a mezz beside the focus. Off by default. */
    aoe?: boolean;
}

/** The servant's leash, as the server has it: 1500 for 10 s, 2000 at once. The owner follows past this. */
export const TETHER_FOLLOW = 1200;
/** ... to within this of it. */
const TETHER_CLOSE = 700;
/** The same attack order no sooner than this. */
const ORDER_MS = 3000;
/** A heal on the servant below this % in a fight, between fights below QUIET_HEAL_BELOW with QUIET_HEAL_MANA. */
export const SERVANT_HEAL_BELOW = 60;
const QUIET_HEAL_BELOW = 85;
const QUIET_HEAL_MANA = 40;
/** The lifedrain ahead of an equal hit with the servant below this %: it heals the servant. */
export const DRAIN_BELOW = 70;
/** fallBack walks this far from the nearest enemy per turn. */
const FALL_BACK_STEP = 1500;
/** Servant buffs only with this % power, between fights. */
const BUFF_MANA = 40;

/** A PetSpell at one enemy, with what it does: `ownerCast` its owner's half has the cast time (the servant's is instant), `damage` per cast. */
export interface ServantNuke extends Through { ownerCast: boolean; damage: number; drain: boolean; area: boolean; range: number }

/** The PetSpells that hurt an enemy. */
export function servantNukes(known: readonly Through[]): ServantNuke[] {
    return known.filter(k => k.pick.target === 'Enemy' && !!k.sub && k.sub.target.toLowerCase() === 'enemy' && HARM_TYPES.has(k.sub.type) && (k.sub.damage > 0 || k.pick.damage > 0))
        .map(k => ({ ...k, ownerCast: k.pick.castTime > 0, damage: k.sub!.damage || k.pick.damage, drain: k.sub!.type === 'Lifedrain', area: (k.sub!.radius || k.pick.radius) > 0, range: k.pick.range || k.sub!.range }));
}

/**
 * Which nuke: never an area one unless `aoe`, nor a DoT (the servant's hit is the fight). Under a melee on the servant, one whose servant
 * half is instant first: a swing interrupts its 3 s cast, and the queue with it (learnings/pets.md "Shade"). Then the hardest hit, a
 * lifedrain ahead of an equal one with the servant below DRAIN_BELOW. `ready` says what can go now (power, recast).
 */
export function servantNuke(nukes: readonly ServantNuke[], opts: { underMelee: boolean; servantHp: number; aoe?: boolean; ready?: (n: ServantNuke) => boolean }): ServantNuke | null {
    const ok = nukes.filter(n => (opts.aoe || !n.area) && n.sub!.type !== 'DamageOverTime' && (opts.ready?.(n) ?? true));
    const score = (n: ServantNuke) => n.damage * (n.drain && opts.servantHp < DRAIN_BELOW ? 1.25 : 1);
    return [...ok].sort((a, b) => (opts.underMelee ? Number(b.ownerCast) - Number(a.ownerCast) : 0) || score(b) - score(a) || b.pick.spell.level - a.pick.spell.level)[0] ?? null;
}

/** The servant's heal: a PetSpell on the pet whose half heals, the top level. */
export function servantHealPick(known: readonly Through[]): Through | null {
    return known.filter(k => k.pick.target === 'Pet' && !!k.sub && /^(Heal|HealOverTime|CombatHeal)$/.test(k.sub.type)).sort((a, b) => b.pick.spell.level - a.pick.spell.level)[0] ?? null;
}

/** The servant's buffs worth keeping up: PetSpells on the pet lasting 10 min or more, the top level per kind of buff. */
export function servantBuffPicks(known: readonly Through[]): Through[] {
    const top = new Map<string, Through>();
    for (const k of known) {
        if (k.pick.target !== 'Pet' || !k.sub || k.pick.duration < 600) continue;
        const kind = k.sub.type;
        if (!top.has(kind) || top.get(kind)!.pick.spell.level < k.pick.spell.level) top.set(kind, k);
    }
    return [...top.values()];
}

/** Where fallBack steps: FALL_BACK_STEP straight away from `from`. */
export function stepAway(me: Point, from: Point, step = FALL_BACK_STEP): Point {
    const d = dist(me, from);
    if (d === 0) return { x: me.x + step, y: me.y };
    return { x: me.x + (me.x - from.x) / d * step, y: me.y + (me.y - from.y) / d * step };
}

const isShade = (ctx: MemberContext) => !!ctx.me().isShade;
const ready = (ctx: MemberContext, t: Through) => t.pick.spell.cooldownRemaining <= 0 && ctx.me().mana >= ctx.spells.powerOf(t.pick);

/** The servant, cast with nothing hostile near: 20 s standing. A shade has one already. */
export const raiseServant = (): Behavior<TacticsSettings> => ({
    name: 'raiseServant',
    interruptible: false,
    async run(ctx) {
        if (isShade(ctx) || ctx.sdk.getPetState() || waiting(ctx.memory, 'raiseRetry') || !summonClear(ctx)) return false;
        const sp = [...ctx.spells.all()].filter(s => s.type === 'SummonNecroPet').sort((a, b) => b.spell.level - a.spell.level)[0];
        if (!sp || sp.spell.cooldownRemaining > 0) return false;
        if (ctx.me().mana < ctx.spells.powerOf(sp)) return ctx.skip('raiseServant: saving power');
        ctx.doing('summon', null, sp.spell.name);
        const c = await ctx.bot.summonPet(sp.spell);
        ctx.result('summon', c);
        if (!c.success) ctx.memory.set('raiseRetry', Date.now() + Math.max(5000, buffRetryMs(c)));
        return true;
    },
});

/** No servant, not a shade, an enemy within SUMMON_CLEAR_RADIUS: a step away from the nearest, so raiseServant can go. */
export const fallBack = (): Behavior<TacticsSettings> => ({
    name: 'fallBack',
    async run(ctx) {
        if (isShade(ctx) || ctx.sdk.getPetState() || ctx.bot.isDead() || ctx.orders().phase === 'retreat' || !hostileNear(ctx)) return false;
        if (!ctx.spells.all().some(s => s.type === 'SummonNecroPet')) return false;
        const me = ctx.me();
        const near = [...ctx.threats(), ...ctx.picture().contacts.filter(c => c.kind === 'player' && !c.isPet)]
            .filter(c => !c.stale && c.regionId === me.regionId && dist(c, me) < SUMMON_CLEAR_RADIUS)
            .sort((a, b) => dist(a, me) - dist(b, me))[0];
        if (!near) return false;
        const to = stepAway(me, near);
        if (!onMap(me.regionId, to, SUMMON_MAP_MARGIN)) return false;
        ctx.doing('flee', near.objectId, `no servant: away from ${near.name} to raise one`);
        const w = await ctx.bot.walkTo(to.x, to.y, { tolerance: 100, timeout: 6000 });
        if (!w.success && w.reason !== 'timeout') ctx.result('walk', w);
        return true;
    },
});

/** The server's warning: "Your servant is too far from you and will be lost in 10 seconds ..." (NecromancerPetBrain.cs TetherTimer). */
const TETHER_WARNING = /servant is too far from you/i;
/** A warning this recent still counts. */
const WARNING_MS = 4000;

/** In shade, within the servant's leash: past TETHER_FOLLOW (the server measures in 3D, as `distance` is), or with the server's warning just in, a walk to within TETHER_CLOSE of it. */
export const keepTether = (): Behavior<TacticsSettings> => ({
    name: 'keepTether',
    async run(ctx) {
        if (!isShade(ctx)) return false;
        const pet = ctx.sdk.getPet();
        const warned = ctx.sdk.getGameMessages().some(m => Date.now() - m.receivedAt < WARNING_MS && TETHER_WARNING.test(m.text));
        if (!pet || (pet.distance <= TETHER_FOLLOW && !(warned && pet.distance > TETHER_CLOSE))) return false;
        ctx.doing('move', pet.objectId, `after the servant (${Math.round(pet.distance)})`);
        const w = await ctx.bot.walkToObject(pet, { range: TETHER_CLOSE, timeout: 4000 });
        if (!w.success && w.reason !== 'timeout') ctx.result('walk', w);
        return true;
    },
});

/** Out of an engage a servant still fighting this far from us is called off: it was left on Thorgrim in the water while the squad waited ashore, then cut as the squad fled (r8 sortie 1, 2026-11-12). */
export const CALL_OFF_BEYOND = 1000;

/** What servantLeash sends: in a retreat passive and follow; out of an engage and a pull a follow for a fight beyond CALL_OFF_BEYOND, or with no threat left; else nothing. */
export function leashOrders(phase: string, pet: { aggression: string; walk: string; targetObjectId: number | null }, distance: number, threats: number): ('passive' | 'follow')[] {
    if (phase === 'retreat') return [...(pet.aggression !== 'passive' ? ['passive' as const] : []), ...(pet.walk !== 'follow' || pet.targetObjectId !== null ? ['follow' as const] : [])];
    if (phase === 'engage' || phase === 'pull' || pet.targetObjectId === null) return [];
    return distance > CALL_OFF_BEYOND || threats === 0 ? ['follow'] : [];
}

/**
 * The servant's leash on the side tick, as petControl does for other pets (it leaves a shade alone): leashOrders, 1.5 s apart. On the side tick because a retreat's
 * walk takes every turn: as a turn behaviour below it this never ran, and the servant fighting on was cut as she fled (sortie 1). Only sends.
 */
export const servantLeash = (): Behavior<TacticsSettings> => ({
    name: 'servantLeash',
    side: true,
    interruptible: false,
    async run(ctx) {
        const pet = ctx.sdk.getPetState();
        if (!pet || !isShade(ctx) || ctx.bot.isDead()) return false;
        const now = Date.now();
        if (waiting(ctx.memory, 'servantLeashAt', now - 1500)) return false;
        const orders = leashOrders(ctx.orders().phase, pet, ctx.sdk.getPet()?.distance ?? Infinity, ctx.threats().length);
        if (!orders.length) return false;
        ctx.memory.set('servantLeashAt', now);
        for (const o of orders) await ctx.sdk.sendPetCommand(o);
        return false;
    },
});

/** Whether anything swings at the servant: a contact on it, or an NPC the client sees on it. */
function servantUnderMelee(ctx: MemberContext): boolean {
    const pet = ctx.sdk.getPet();
    if (!pet) return false;
    return ctx.bot.getPetAttackers().some(a => dist(a, pet) < 400)
        || ctx.picture().contacts.some(c => !c.stale && c.targetPet === ctx.name && !c.targetBySpell && dist(c, pet) < 400);
}

/**
 * The fight: the servant at the focus (an order a new focus or a pet off it gets, ORDER_MS apart), then servantNuke's pick at it,
 * walking the owner into its range if need be (a shade can't be hit). A servant-cast spell waits for the last one's 3 s: the server
 * queues one behind the current cast, and the last sent wins, every one paid (learnings/pets.md "Shade").
 */
/** In a fight the shade stands within this of the focus: inside the server's 2000 for an attack order, and Vitality Theft's 1500 from the owner. */
export const OWNER_STAND = 1300;
/** ... walking in only once past it by this much, so a focus that moves a little doesn't start a walk every turn. */
const OWNER_SLACK = 150;

/**
 * A walk in lasts at most this, so a servant's death mid-walk (out of shade at 10 %) stops it soon: field run B, 20:47 the servant died and
 * at 20:49 Morgause died still on "Cannot reach Dwarf".
 */
const WALK_IN_MS = 1500;
/** With the servant below this %, no walk into a short-range nuke (Pain of the Dead, the Cackles at 500): its death would leave us there. */
export const NO_WALK_IN_BELOW = 40;

/** A shade's step toward the focus (nobody can hit it), briefly so the turn comes back. */
async function closeOn(ctx: MemberContext, mob: { objectId: number; name: string }, range: number): Promise<boolean> {
    ctx.doing('move', mob.objectId, `in to ${Math.round(range)} of ${mob.name}`);
    const w = await ctx.bot.walkToObject(mob.objectId, { range, timeout: WALK_IN_MS });
    if (!w.success && w.reason !== 'timeout') ctx.result('walk', w, mob.objectId);
    return true;
}

export const servantFight = (opts: { saveBelow?: number; aoe?: boolean } = {}): Behavior<TacticsSettings> => ({
    name: 'servantFight',
    interruptible: false,
    async run(ctx) {
        if (!isShade(ctx)) return false;
        const petState = ctx.sdk.getPetState();
        const go = focusToHit(ctx);
        if (!petState || !go) return false;
        const now = Date.now();
        // The owner's own distance counts twice on the server: an attack order needs it within 2000 of the target
        // (GamePlayer.CommandNpcAttack), and a PetSpell's owner half checks its range from the owner (SpellHandler.CheckBeginCast).
        // Standing back as a caster does, Morgause had 94 orders refused in field run B's first sortie. A shade can't be hit: walk in.
        if (go.seen.distance > OWNER_STAND + OWNER_SLACK) return closeOn(ctx, go.mob, OWNER_STAND);
        if (petState.targetObjectId !== go.mob.objectId && !(ctx.memory.get('servantOrder') === go.mob.objectId && waiting(ctx.memory, 'servantOrderAt', now - ORDER_MS))) {
            ctx.memory.set('servantOrder', go.mob.objectId);
            ctx.memory.set('servantOrderAt', now);
            ctx.doing('petAttack', go.mob.objectId, `servant at ${go.mob.name}`);
            const r = await ctx.bot.petAttack(go.mob.objectId);
            ctx.result('petAttack', r, go.mob.objectId);
            if (!r.success) return true;
        }
        const me = ctx.me();
        if ((opts.saveBelow ?? 0) > 0 && me.manaPercent < opts.saveBelow!) return ctx.skip('servantFight: saving power');
        const pet = ctx.sdk.getPet();
        const servantBusy = waiting(ctx.memory, 'servantCastUntil', now);
        const pick = servantNuke(servantNukes(through(ctx, 'PetSpell')), {
            underMelee: servantUnderMelee(ctx), servantHp: pet?.healthPercent ?? 100, aoe: opts.aoe,
            ready: n => ready(ctx, n) && (n.ownerCast || !servantBusy) && (!pet || dist(pet, go.seen) <= n.range)
                && (go.seen.distance <= n.range || (pet?.healthPercent ?? 100) >= NO_WALK_IN_BELOW),
        });
        if (!pick) return ctx.skip(servantBusy ? 'servantFight: the servant is casting' : 'servantFight: nothing to cast');
        if (pick.range > 0 && go.seen.distance > pick.range) return closeOn(ctx, go.mob, Math.max(pick.range - 50, 100));
        ctx.doing('nuke', go.mob.objectId, pick.pick.spell.name);
        const c = await ctx.bot.castSpell(pick.pick.spell, go.mob.objectId);
        ctx.result('nuke', c, go.mob.objectId);
        if (c.success && !pick.ownerCast) ctx.memory.set('servantCastUntil', Date.now() + (pick.sub?.castTime ?? 3) * 1000 + 300);
        if (!c.success && c.reason === 'must_wait') ctx.memory.set('servantCastUntil', Date.now() + (c.retryAfterMs ?? 1500));
        return true;
    },
});

/** The servant's heal over time: below SERVANT_HEAL_BELOW in a fight, below QUIET_HEAL_BELOW between fights with power to spare; not while one ticks (its icon on the pet). */
export const servantHeal = (): Behavior<TacticsSettings> => ({
    name: 'servantHeal',
    interruptible: false,
    async run(ctx) {
        if (!isShade(ctx) || waiting(ctx.memory, 'servantHealRetry')) return false;
        const petState = ctx.sdk.getPetState();
        const pet = ctx.sdk.getPet();
        if (!petState || !pet) return false;
        const quiet = QUIET_PHASES.has(ctx.orders().phase) && !ctx.threats().length;
        if (pet.healthPercent >= (quiet ? QUIET_HEAL_BELOW : SERVANT_HEAL_BELOW)) return false;
        if (quiet && ctx.me().manaPercent < QUIET_HEAL_MANA) return false;
        const h = servantHealPick(through(ctx, 'PetSpell'));
        if (!h || !ready(ctx, h) || (h.pick.icon > 0 && petState.icons.includes(h.pick.icon)) || pet.distance > (h.pick.range || 2000)) return false;
        ctx.doing('heal', pet.objectId, h.pick.spell.name);
        const c = await ctx.bot.castSpell(h.pick.spell);
        ctx.result('petHeal', c, pet.objectId);
        // The icon shows a snapshot later: no second one meanwhile.
        ctx.memory.set('servantHealRetry', Date.now() + (c.success ? 2000 : Math.max(3000, buffRetryMs(c))));
        return true;
    },
});

/** The servant's buffs, between fights, BUFF_MANA: each one whose icon the window doesn't show, timed per servant (ids are reused). */
export const servantBuffs = (): Behavior<TacticsSettings> => ({
    name: 'servantBuffs',
    interruptible: false,
    async run(ctx) {
        if (!isShade(ctx)) return false;
        const petState = ctx.sdk.getPetState();
        const pet = ctx.sdk.getPet();
        if (!petState || !pet || !QUIET_PHASES.has(ctx.orders().phase) || ctx.threats().length || ctx.me().manaPercent < BUFF_MANA) return false;
        const whose = `${pet.objectId}:${ctx.sdk.getState()?.lastPetLoss?.at ?? 0}`;
        if (ctx.memory.get('servantBuffsOf') !== whose) { ctx.memory.set('servantBuffsOf', whose); ctx.memory.set('servantBuffRetry', new Map()); }
        const retry: Map<string, number> = ctx.memory.get('servantBuffRetry');
        const now = Date.now();
        const next = servantBuffPicks(through(ctx, 'PetSpell')).find(b => !(b.pick.icon > 0 && petState.icons.includes(b.pick.icon)) && now >= (retry.get(b.pick.spell.name) ?? 0) && ready(ctx, b) && pet.distance <= (b.pick.range || 1000));
        if (!next) return false;
        ctx.doing('buff', pet.objectId, `${next.pick.spell.name} on ${pet.name}`);
        const c = await ctx.bot.castSpell(next.pick.spell);
        ctx.result('petBuff', c, pet.objectId);
        retry.set(next.pick.spell.name, Date.now() + (c.success ? next.pick.duration * 900 : buffRetryMs(c)));
        return true;
    },
});

export function necromancer({ saveBelow = 0, aoe = false }: NecromancerOptions = {}): Character {
    return {
        role: 'nuker',
        urgent: [servantLeash(), keepTether(), fallBack(), raiseServant()],
        react: [servantHeal()],
        fight: [servantFight({ saveBelow, aoe })],
        chores: [servantBuffs()],
    };
}
