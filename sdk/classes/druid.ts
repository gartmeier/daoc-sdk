// The standard Druid: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list
// already heals, roots and buffs from whatever the bot knows. What is the class's own is her group heal (the
// Conflux line, Regrowth 13/22): `heal` picks the cheapest single heal that covers one member, so it never casts
// one. `groupHeal` does, when three or more of the group around her each miss most of what it restores.
// A Nature build also has DoTs (dotsAbove). learnings/classes/druid.md says what was measured.

import { assist, foeInView, hammeredBy, stopSwinging, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { Contact, MemberReport, Role } from '../group/types';
import type { SpellPick } from '../group/spells';
import { cureNearsight, unlessHammered } from './healer';
import { noteTooFar, tooFarOf, viewDistance } from './mentalist';
import { thrifty } from './thrifty';

export interface DruidOptions {
    /** For a Nature build: cast its DoTs on the focus, above this % power. Without a damage spell it does nothing. */
    dotsAbove?: number;
    /** groupHeal: how many members (her too) must each miss `share` of what it restores. */
    groupHealMin?: number;
    /** groupHeal: below this % power she keeps it for single heals. */
    groupHealAbove?: number;
}

/** Each counts when it misses this share of the heal: more of the heal is wasted on it than this leaves. */
const SHARE = 0.7;

/** A group heal (no radius, target Group: every member within its range of the caster, SpellHandler.cs SelectTargets GROUP). */
export const isGroupHeal = (s: Pick<SpellPick, 'type' | 'target' | 'radius' | 'pulse'>) => /^Heal$/.test(s.type) && s.target === 'Group' && s.radius === 0 && !s.pulse;

/** The members a group heal of `value` would be worth casting for: alive, in our region, within `range` of us, missing SHARE of it. */
export function groupHealTargets(me: { x: number; y: number; regionId: number }, members: readonly MemberReport[], range: number, value: number): MemberReport[] {
    return members.filter(m => !m.isDead && m.regionId === me.regionId && Math.hypot(m.x - me.x, m.y - me.y) <= range
        && (m.maxHp ?? 0) * (100 - m.hp) / 100 >= value * SHARE);
}

/** Renewing Conflux (or the best group heal she can pay for) when `min` members around her need it, in a fight. */
export const groupHeal = (min = 3, above = 25): Behavior => ({
    name: 'groupHeal',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (!ctx.threats().length && o.phase !== 'engage' && o.phase !== 'retreat') return false;
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < above) return false;
        const sp = ctx.spells.all().filter(s => isGroupHeal(s) && s.power <= me.mana && s.spell.cooldownRemaining <= 0).sort((a, b) => b.value - a.value)[0];
        if (!sp) return false;
        const self = ctx.members().find(m => m.name === me.name);
        const hurt = groupHealTargets({ x: me.x, y: me.y, regionId: self?.regionId ?? me.regionId }, ctx.members(), sp.range, sp.value);
        if (hurt.length < min) return false;
        await stopSwinging(ctx);
        ctx.doing('heal', me.objectId, `${sp.spell.name} for ${hurt.map(m => m.name).join(', ')}`);
        ctx.result('heal', await ctx.bot.castSpell(sp.spell), me.objectId);
        return true;
    },
});

/** The server measures range in 3D at the cast's end: a margin under the spell's range by our view, as the Mentalist's Flash (round 20: 2 of 5 Flashes out of range at 60). */
const RANGE_MARGIN = 150;
/** After a root ends a player takes no other for 60 s (immunity_timer_flat_length). */
const ROOT_IMMUNE_MS = 60_000;
/** Whose divers she roots first: the roles that hold the group up. A melee on the tank is the fight. */
const GUARD_FIRST: readonly Role[] = ['support', 'healer'];

/**
 * A melee player diving one of ours: swinging (not casting) at a member who isn't the tank, within `range` less a margin
 * by `distanceTo`, not crowd-controlled, not root-immune, not the focus (damage on it would break the root) and not
 * someone else's crowd control. On our support or healer first, then the nearest.
 */
export function diverTarget(contacts: readonly Contact[], members: readonly Pick<MemberReport, 'name' | 'role'>[], regionId: number, distanceTo: (c: Contact) => number, range: number, o: { focus: number | null; cc: readonly { targetId: number }[] }, now: number): Contact | null {
    const roleOf = new Map(members.map(m => [m.name, m.role]));
    const on = (c: Contact) => (c.target ? roleOf.get(c.target) : undefined);
    return contacts
        .filter(c => c.kind === 'player' && !c.isPet && !c.stale && c.regionId === regionId && !c.cc && (c.ccImmune?.root ?? 0) <= now
            && c.swinging && !c.targetBySpell && on(c) !== undefined && on(c) !== 'tank'
            && c.objectId !== o.focus && !o.cc.some(a => a.targetId === c.objectId) && distanceTo(c) <= range - RANGE_MARGIN)
        .sort((a, b) => Number(!GUARD_FIRST.includes(on(a)!)) - Number(!GUARD_FIRST.includes(on(b)!)) || distanceTo(a) - distanceTo(b))[0] ?? null;
}

/**
 * Holding Vines on a melee diving our Bard, herself or a caster (arena rounds 13 and 16: Midgard's melee killed Oisin
 * and Brigid first). A rooted melee can't follow, and flee walks the member out of its reach. Marked as crowd control
 * like any root, so nobody's damage breaks it. Not while a melee is on her: the 2.5 s cast would be interrupted.
 */
export const rootDiver = (above = 15): Behavior => ({
    name: 'rootDiver',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' && o.phase !== 'retreat') return false;
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < above) return false;
        const sp = ctx.spells.root();
        if (!sp || hammeredBy(ctx)) return false;
        const self = ctx.members().find(m => m.name === me.name);
        const far = tooFarOf(ctx.memory);
        const raw = (c: Contact) => { const v = foeInView(ctx, c.objectId); return !v || ('isDead' in v && v.isDead) ? Infinity : v.distance; };
        const seen = (c: Contact) => viewDistance(far, c.objectId, raw(c), Date.now());
        const foe = diverTarget(ctx.picture().contacts, ctx.members(), self?.regionId ?? me.regionId, seen, sp.range, o, Date.now());
        if (!foe) return false;
        await stopSwinging(ctx);
        ctx.doing('cc', foe.objectId, `${sp.spell.name} on the melee at ${foe.target}`);
        const c = await ctx.bot.castSpell(sp.spell, foe.objectId, { approach: false });
        const refused = !c.success ? null : c.effectImmune ? 'immune' : c.alreadyOn ? 'already_on' : c.resisted ? 'resisted' : c.effectLanded === false ? 'no_effect' : null;
        ctx.result('cc', refused ? { ...c, success: false, reason: refused } : c, foe.objectId);
        noteTooFar(far, foe.objectId, c.reason, raw(foe), Date.now());
        if (refused === 'immune') ctx.markCcImmune(foe.objectId, 'root', ROOT_IMMUNE_MS);
        else if (refused === 'already_on') ctx.markCcImmune(foe.objectId, 'root', sp.duration * 1000 + ROOT_IMMUNE_MS);
        else if (c.success && !refused) ctx.markCc(foe.objectId, 'root', sp.duration * 1000, c.landedOn);
        return true;
    },
});

/**
 * `inner` only above `floor` % power with enemies about, and without a word below it: thrifty's skip reason would stand as
 * her idle reason all fight whether anyone needs the cure or not (round 42: 33 turns of "cureNearsight: saving power").
 */
export const quietlyAbove = <S>(inner: Behavior<S>, floor: number): Behavior<S> => ({
    ...inner,
    run: ctx => (ctx.threats().length && ctx.me().maxMana > 0 && ctx.me().manaPercent < floor ? false : inner.run(ctx)),
});

/** Her heals' range (Regrowth), and how far past it she walks to a hurt member: farther is someone else's fight. */
const HEAL_RANGE = 2000;
const REACH_HURT_MAX = 3500;
/** She stops this far from the member, inside the range with room for its moves and the server's 3D. */
const REACH_HURT_TO = 1500;

/**
 * The member to walk toward: alive, in our region, below `limit` % (the tank its own), between HEAL_RANGE and
 * REACH_HURT_MAX away; the most hurt.
 */
export function hurtOutOfReach(me: { x: number; y: number; regionId: number; name: string }, members: readonly MemberReport[], limit: (m: MemberReport) => number): MemberReport | null {
    return members
        .filter(m => m.name !== me.name && !m.isDead && m.regionId === me.regionId && m.hp < limit(m))
        .filter(m => { const d = Math.hypot(m.x - me.x, m.y - me.y); return d > HEAL_RANGE && d <= REACH_HURT_MAX; })
        .sort((a, b) => a.hp - b.hp)[0] ?? null;
}

/**
 * In a fight, with nobody in reach to heal (it sits below heal), one leg toward the most hurt member beyond her heals'
 * range, never with a melee on her. Arena round 76: Brigid idle 57 % of the fights on "nothing to do" (187 turns) while
 * the others died 8 times.
 */
export const reachHurt = (): Behavior<TacticsSettings> => ({
    name: 'reachHurt',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' && o.phase !== 'retreat') return false;
        if (hammeredBy(ctx)) return false;
        const me = ctx.me();
        const self = ctx.members().find(m => m.name === me.name);
        const s = ctx.settings.heal;
        const m = hurtOutOfReach({ x: me.x, y: me.y, regionId: self?.regionId ?? me.regionId, name: me.name }, ctx.members(), x => (x.role === 'tank' ? s.tank : s.other));
        if (!m) return false;
        const d = Math.hypot(m.x - me.x, m.y - me.y);
        const to = { x: me.x + (m.x - me.x) * (d - REACH_HURT_TO) / d, y: me.y + (m.y - me.y) * (d - REACH_HURT_TO) / d };
        ctx.doing('move', m.objectId, `into heal reach of ${m.name} (${m.hp} %)`);
        await ctx.bot.walkTo(to.x, to.y, { tolerance: 100, timeout: 3000 });
        return true;
    },
});

/** `inner` at most once per `ms` (counted from a turn it acted), quietly between. */
export const atMostEvery = <S>(inner: Behavior<S>, ms: number): Behavior<S> => ({
    ...inner,
    async run(ctx) {
        const key = `every:${inner.name}`;
        if (Date.now() - (ctx.memory.get(key) ?? 0) < ms) return false;
        const acted = await inner.run(ctx);
        if (acted) ctx.memory.set(key, Date.now());
        return acted;
    },
});

/** `inner` only while no enemy aims at us, by swing or by spell (Contact.target): a long cast would only be interrupted. Quiet. */
export const unlessAimedAt = <S>(inner: Behavior<S>): Behavior<S> => ({
    ...inner,
    run: ctx => (ctx.threats().some(t => !t.stale && !t.cc && t.target === ctx.name) ? false : inner.run(ctx)),
});

export function druid({ dotsAbove, groupHealMin = 3, groupHealAbove = 25 }: DruidOptions = {}): Character {
    return {
        role: 'healer',
        urgent: [rootDiver(), groupHeal(groupHealMin, groupHealAbove)],
        // Cure Nearsight I (Regrowth, 6 s, 30 power): Albion's Obscuring Dust cut our spell ranges by 35 % in round 35
        // (orchestrator, 13f8de7). The Midgard Healer kit's cure, in her idle turns (react: at shedLoad in the pack's
        // healer list), never under a melee, and in a fight only above 40 % of her 197 power.
        // Not while any enemy aims at her either (round 62: 2 of 2 cures interrupted by spells, 12 s of her time).
        // A hurt member beyond her heals' 2000 is "nothing to do" for heal(): walk into reach (round 76: idle 57 %, 8 deaths).
        // Round 81: 4 cures (120 of her 197 power), then 34 turns of "heal: not enough power": above 60 %, one per 20 s.
        react: [reachHurt(), quietlyAbove(atMostEvery(unlessAimedAt(unlessHammered(cureNearsight())), 20_000), 60)],
        ...(dotsAbove === undefined ? {} : { fight: [thrifty(assist(), dotsAbove)] }),
    };
}
