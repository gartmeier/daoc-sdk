// The standard Cabalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role is what
// roleForClass gives: the list casts her DoTs first as it is, and they hold out on power without a floor. What is
// the class's own is spreading them: with the focus out of her reach she puts them on a free enemy in reach (offFocus),
// which Albion's Sorcerer and Theurgist kits use for their nukes too. learnings/classes/cabalist.md says what has been measured.

import { assist, ccHolds, ccSpellFor, ckey, claimedBy, foeInView, hammeredBy, isDown, noteNukeEnd, onMember, stopSwinging, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import { CC_IMMUNE_MS } from '../group/cc';
import { dist } from '../group/battleground';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { dotFamily, type SpellPick } from '../group/spells';
import type { Contact, MemberReport, Orders, Point } from '../group/types';
import { camelotMezzer } from './cleric';
import { thrifty } from './thrifty';

export interface CabalistOptions {
    /** No nukes below this % power; 0 (the default): no floor. */
    saveBelow?: number;
    /** DoTs and nukes on a free enemy in reach while the focus is out of it (offFocus). On by default. */
    offFocus?: boolean;
    /** Instant debuffs on a melee hitting her or a caster (meleeDebuff, the instant slot). On by default. */
    meleeDebuff?: boolean;
    /** Obscuring Dust on enemy casters and healers from 2300 (nearsight). On by default. */
    nearsight?: boolean;
}

/** No debuffs below this % power: the mezz and the nukes come first. Arena round 27: Merlin's 9 debuffs, then 2 mezzes and 4 nukes refused for power. */
export const DEBUFF_MIN_MANA = 35;
/** For a melee on another member, while we could be casting: round 28, Merlin and Taliesin each held the group 12 % of the run for power. */
export const DEBUFF_FOR_OTHERS_MIN_MANA = 60;
/** The server measures in 3D and from where it last had us: keep this far inside a spell's range. */
const RANGE_MARGIN = 50;

/** Instant debuffs that blunt a melee player, best first: fewer swings, then weaker ones, then worse aim. */
export const MELEE_DEBUFFS: readonly string[] = ['CombatSpeedDebuff', 'StrengthDebuff', 'DexterityQuicknessDebuff', 'DexterityDebuff'];

/**
 * The next instant debuff to put on a melee: the top rank of the first of MELEE_DEBUFFS we can cast now and that isn't on it from us
 * (`on`, by type). Single-target only: an area one (Imbalance, Banish Conviction) would wake a mezzed neighbour.
 */
export function nextMeleeDebuff(all: readonly SpellPick[], mana: number, on: ReadonlySet<string>): SpellPick | null {
    for (const type of MELEE_DEBUFFS) {
        if (on.has(type)) continue;
        const top = all.filter(s => s.type === type && s.target === 'Enemy' && s.castTime === 0 && s.radius === 0 && s.range > 0 && s.power <= mana && s.spell.cooldownRemaining <= 0)
            .sort((a, b) => b.spell.level - a.spell.level)[0];
        if (top) return top;
    }
    return null;
}

/** Whom to debuff: a free enemy player or pet in melee on us, else on one of our soft members, nearest first, within `range`. */
export function meleeDebuffTarget(me: Pick<MemberReport, 'name' | 'x' | 'y'>, members: readonly MemberReport[], threats: readonly Contact[], distanceTo: (id: number) => number, range: number, now = Date.now()): Contact | null {
    const soft = members.filter(m => !m.isDead && m.role !== 'tank' && m.role !== 'melee');
    const free = threats.filter(t => (t.kind === 'player' || !!t.isPet) && !t.stale && !t.cc && isAlive(t) && !untouchable(t, now) && distanceTo(t.objectId) <= range);
    return free.find(t => onMember(t, me)) ?? free.filter(t => soft.some(m => onMember(t, m))).sort((a, b) => distanceTo(a.objectId) - distanceTo(b.objectId))[0] ?? null;
}

/**
 * In the instant slot, above flee: while a melee is on her or a caster, her instant debuffs on it (Inflict Malaise, Enfeeble Body,
 * Magical Web; a Theurgist's Friction; a Sorcerer's Enfeeble Body and Mesh of Force). An instant goes out under the swings, where
 * every cast with a cast time is interrupted, and flee walks on the next turn. One per turn, each type once per its length. Arena
 * round 11: Morgana in melee 55 % of fight time with nothing she could cast.
 */
export const meleeDebuff = (): Behavior<TacticsSettings> => ({
    name: 'meleeDebuff',
    interruptible: false,
    async run(ctx) {
        if (ctx.orders().phase !== 'engage') return false;
        const me = ctx.me();
        const self = ctx.members().find(m => m.name === ctx.name);
        if (!self) return false;
        const distanceTo = (id: number) => foeInView(ctx, id)?.distance ?? Infinity;
        const target = meleeDebuffTarget(self, ctx.members(), ctx.threats(), distanceTo, 1500);
        if (!target) return false;
        // On us we can cast nothing else; on another member the power would otherwise go on nukes and the mezz.
        if (me.maxMana > 0 && me.manaPercent < (onMember(target, self) ? DEBUFF_MIN_MANA : DEBUFF_FOR_OTHERS_MIN_MANA)) return false;
        const until: Map<string, number> = ctx.memory.get('debuffUntil') ?? new Map();
        ctx.memory.set('debuffUntil', until);
        const now = Date.now();
        const on = new Set(MELEE_DEBUFFS.filter(type => (until.get(`${ckey(target)}:${type}`) ?? 0) > now));
        const sp = nextMeleeDebuff(ctx.spells.all(), me.mana, on);
        if (!sp || distanceTo(target.objectId) > sp.range) return false;
        ctx.doing('debuff', target.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false });
        ctx.result('debuff', c.success && c.resisted ? { ...c, success: false, reason: 'resisted' } : c, target.objectId);
        until.set(`${ckey(target)}:${sp.type}`, Date.now() + (c.success && !c.resisted ? sp.duration * 1000 : 3000));
        return true;
    },
});

/** How long a cc claim keeps others' damage off its target: a mezz on its way. */
const CC_CLAIM_MS = 4000;

/**
 * Whom to hit while the focus is out of `range` (or held by crowd control): the nearest enemy player in reach that nobody
 * controls or is about to (a cc assignment, a cc claim), so no damage of ours wakes a mezz. Not a pet: its owner matters.
 * Null with the focus in reach and free, which is assist's.
 */
export function offFocusTarget(me: Point & { regionId: number }, focus: Contact | undefined, threats: readonly Contact[], orders: Pick<Orders, 'cc' | 'focus'>, range: number, focusHeld: boolean, claimed: (id: number) => boolean = () => false): Contact | null {
    if (focus && !focusHeld && dist(me, focus) <= range) return null;
    return threats
        .filter(t => t.kind === 'player' && !t.isPet && !t.stale && !t.cc && t.objectId !== orders.focus && t.regionId === me.regionId
            && !orders.cc.some(a => a.targetId === t.objectId) && !claimed(t.objectId) && dist(me, t) <= range)
        .sort((a, b) => dist(me, a) - dist(me, b))[0] ?? null;
}

/**
 * Below assist, which held its ground with the focus out of reach: her DoTs, then the top nuke, on offFocusTarget's pick, from
 * where she stands. The DoT families go in assist's memory for that target, so if it becomes the focus they aren't cast again.
 * Nothing with an enemy in melee on her (a cast would only be interrupted), and no area spells, which would wake a mezz.
 * Arena round 6 (2026-11-09): holding ground 700 behind the tank, Morgana idled 51 turns, Taliesin 67 and Merlin 39 on
 * "focus out of reach", and Morgana's nukes were out of range 10 times.
 */
export const offFocus = (): Behavior<TacticsSettings> => ({
    name: 'offFocus',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const focus = ctx.focus();
        const me = ctx.me();
        const best = ctx.spells.nuke({ aoe: false });
        if (!best) return false;
        const held = !!focus && ccHolds(ctx, focus);
        const t = offFocusTarget(me, focus, ctx.threats(), o, best.range - RANGE_MARGIN, held, id => claimedBy(ctx, 'cc', id, CC_CLAIM_MS).length > 0);
        if (!t) return false;
        const seen = foeInView(ctx, t.objectId);
        if (!seen || isDown(ctx, seen)) return false;
        const key = `dotted:${ckey(t)}`;
        const dotted: Set<string> = ctx.memory.get(key) ?? new Set();
        const sp = ctx.spells.nuke({ dotted, targetHp: t.hp, aoe: false, byDamage: ctx.settings.strongestNuke });
        if (!sp || seen.distance > sp.range - RANGE_MARGIN) return false;
        if (sp.castTime > 0 && hammeredBy(ctx)) return ctx.skip(`offFocus: ${sp.spell.name} would be interrupted`);
        await stopSwinging(ctx);
        ctx.doing('nuke', t.objectId, `${sp.spell.name} (off the focus)`);
        const c = await ctx.bot.castSpell(sp.spell, t.objectId, { approach: false });
        ctx.result('nuke', c, t.objectId);
        noteNukeEnd(ctx.memory, sp, c, Date.now());
        if (sp.type === 'DamageOverTime' && (c.success || /already has that effect/i.test(c.message ?? ''))) { dotted.add(dotFamily(sp)); ctx.memory.set(key, dotted); }
        if (!c.success && c.reason === 'out_of_range') await Bun.sleep(1000);
        else if (!c.success && (c.reason === 'crowd_controlled' || c.reason === 'no_power')) await Bun.sleep(Math.min(c.retryAfterMs ?? 2000, 3000));
        return true;
    },
});

// Shared with other realms' kits: healer.ts (stunPeel, from cleric.ts), spiritmaster.ts, enchanter.ts and mentalist.ts use
// quickcastUnderFire(); mentalist.ts also writes the 'quickcastReadyAt' memory key with QUICKCAST_REUSE_MS. Keep those names,
// the no-argument call and the key, or tell the Hibernia and Midgard class sessions first.
/** The server's Quickcast: one spell that can't be interrupted, at twice the power, then 30 s before the next (QuickCastAbilityHandler.cs). */
export const QUICKCAST_REUSE_MS = 31_000;
/** An interrupt this recent says the next cast would be cut too: a swing or a hit starts a 3 s timer. */
const UNDER_FIRE_MS = 5000;

/** A refusal that names a short wait ("You must wait 1 second to use this ability."): that long and a bit; null for any other. */
export function quickcastWaitMs(message: string | undefined): number | null {
    const m = /must wait (\d+) more second|must wait (\d+) second/i.exec(message ?? '');
    return m ? (Number(m[1] ?? m[2]) + 0.5) * 1000 : null;
}

/** Whether a Quickcast is worth its 30 s now: a melee on us, or our last cast cut short this recently. */
export function underFire(hammered: boolean, lastInterruptAt: number | undefined, now: number): boolean {
    return hammered || (lastInterruptAt !== undefined && now - lastInterruptAt < UNDER_FIRE_MS);
}

/**
 * In the instant slot: under fire (underFire), Quickcast and then one spell that lands whatever hits us: our crowd-control
 * assignment's mezz or root, else our nuke on the focus, from where we stand. Once per 30 s, with twice its power in hand.
 * Arena round 28: Hibernia's interrupts cut every cast with a cast time and Merlin and Morgana dealt 0; all three have Quickcast,
 * which nothing used.
 */
export const quickcastUnderFire = (): Behavior<TacticsSettings> => ({
    name: 'quickcast',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage') return false;
        const now = Date.now();
        if (now < (ctx.memory.get('quickcastReadyAt') ?? 0) || !ctx.sdk.findAbility('Quickcast')) return false;
        const broken: { at: number } | undefined = ctx.memory.get('nukeBroken');
        if (!underFire(!!hammeredBy(ctx), broken?.at, now)) return false;
        const me = ctx.me();
        // What to cast: our cc assignment first, else the nuke on the focus.
        const assigned = o.cc.filter(a => a.by === ctx.name).map(a => ctx.contact(a.targetId)).find(c => c && !c.stale && !c.cc);
        const ccSp = assigned ? ccSpellFor(ctx, assigned) : null;
        const focus = ctx.focus();
        const key = focus ? `dotted:${ckey(focus)}` : '';
        const dotted: Set<string> = (key && ctx.memory.get(key)) || new Set();
        const nukeSp = focus && !ccHolds(ctx, focus) ? ctx.spells.nuke({ dotted, targetHp: focus.hp, aoe: false }) : null;
        const pick = ccSp && assigned ? { sp: ccSp, target: assigned, cc: ccSp.kind } : nukeSp && focus ? { sp: nukeSp, target: focus, cc: null } : null;
        if (!pick || pick.sp.castTime <= 0 || me.mana < 2 * ctx.spells.powerOf(pick.sp)) return false;
        const seen = foeInView(ctx, pick.target.objectId);
        if (!seen || isDown(ctx, seen) || seen.distance > pick.sp.range - RANGE_MARGIN) return false;
        await stopSwinging(ctx);
        ctx.memory.set('quickcastReadyAt', now + QUICKCAST_REUSE_MS);
        const q = await ctx.bot.useAbility('Quickcast');
        ctx.result('quickcast', q);
        if (!q.success) {
            // "You must wait 1 second to use this ability." (any ability, just after another): not the 30 s lock. Arena round 32.
            const wait = quickcastWaitMs(q.message);
            if (wait !== null) ctx.memory.set('quickcastReadyAt', Date.now() + wait);
            return true;
        }
        ctx.doing(pick.cc ? 'cc' : 'nuke', pick.target.objectId, `${pick.sp.spell.name} (quickcast)`);
        const c = await ctx.bot.castSpell(pick.sp.spell, pick.target.objectId, { approach: false });
        if (pick.cc) {
            const refused = !c.success ? null : c.effectImmune ? 'immune' : c.resisted ? 'resisted' : null;
            ctx.result('cc', refused ? { ...c, success: false, reason: refused } : c, pick.target.objectId);
            if (refused === 'immune') ctx.markCcImmune(pick.target.objectId, pick.cc, CC_IMMUNE_MS);
            else if (c.success && !refused) ctx.markCc(pick.target.objectId, pick.cc, Math.max(3000, pick.sp.duration * 1000), c.landedOn);
        } else {
            ctx.result('nuke', c, pick.target.objectId);
            noteNukeEnd(ctx.memory, pick.sp, c, Date.now());
            if (pick.sp.type === 'DamageOverTime' && c.success) { dotted.add(dotFamily(pick.sp)); ctx.memory.set(key, dotted); }
        }
        return true;
    },
});

/** After a try that didn't land, leave that target this long: arena round 33, 7 tries on Hibernia's casters in under a minute, none landed, 57 damage. */
const NEARSIGHT_RETRY_MS = 20_000;
/** Range 2300 came back "too far away" at 2250 (round 33): the server measures in 3D and from where it last had us. */
const NEARSIGHT_MARGIN = 200;
/** A nearsighted target, then the immunity after it: 120 s of Obscuring Dust and 60 s of NearsightImmunity. */
const NEARSIGHT_HOLD_MS = 180_000;

/**
 * Whom to nearsight: an enemy caster or healer in `range` that nobody controls or is about to (a mezz would wake: GameLiving.cs
 * lists Nearsight among the spells that break one), not nearsighted by us lately (`until`). The group's marked mezzer first
 * (`marked`), then whoever was seen casting last, then a healer, then the nearest.
 */
export function nearsightTarget(me: Point & { regionId: number }, contacts: readonly Contact[], orders: Pick<Orders, 'cc'>, until: ReadonlyMap<number, number>, range: number, now: number, marked: number | null = null, claimed: (id: number) => boolean = () => false): Contact | null {
    const open = contacts.filter(c => c.kind === 'player' && !c.isPet && !c.stale && !c.cc && (c.caster || c.healer) && c.regionId === me.regionId
        && dist(me, c) <= range && (until.get(c.objectId) ?? 0) <= now && !orders.cc.some(a => a.targetId === c.objectId) && !claimed(c.objectId) && !untouchable(c, now));
    return open.find(c => c.objectId === marked)
        ?? [...open].sort((a, b) => (b.castingAt ?? 0) - (a.castingAt ?? 0) || Number(!!b.healer) - Number(!!a.healer) || dist(me, a) - dist(me, b))[0] ?? null;
}

/**
 * Obscuring Dust (Nearsight 35 %, range 2300, 2 s, 9 power, 120 s): an enemy caster's or healer's spell range goes to 65 %
 * (NearsightECSEffect.cs, SpellRangePercentCalculator.cs), 1500 to 975, from beyond its own reach. In a fight and on the approach
 * (travel with enemy players in reach), before her nukes. Arena rounds 12, 15, 24, 28, 30: Hibernia's casters mezzed,
 * amnesia'd and interrupted ours from range and won every time but one.
 */
export const nearsight = (opts: { marked?: (orders: unknown) => number | null } = {}): Behavior<TacticsSettings> => ({
    name: 'nearsight',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' && o.phase !== 'travel') return false;
        const me = ctx.me();
        const sp = ctx.spells.all().filter(s => s.type === 'Nearsight' && s.target === 'Enemy' && s.power <= me.mana && s.spell.cooldownRemaining <= 0)
            .sort((a, b) => b.spell.level - a.spell.level)[0];
        if (!sp) return false;
        const broken: { at: number } | undefined = ctx.memory.get('nukeBroken');
        if (sp.castTime > 0 && underFire(!!hammeredBy(ctx), broken?.at, Date.now())) return false;
        const until: Map<number, number> = ctx.memory.get('nearsightUntil') ?? new Map();
        ctx.memory.set('nearsightUntil', until);
        const now = Date.now();
        const t = nearsightTarget(me, ctx.picture().contacts, o, until, sp.range - NEARSIGHT_MARGIN, now, opts.marked?.(o) ?? null, id => claimedBy(ctx, 'cc', id, CC_CLAIM_MS).length > 0);
        if (!t) return false;
        const seen = foeInView(ctx, t.objectId);
        if (!seen || isDown(ctx, seen) || seen.distance > sp.range - NEARSIGHT_MARGIN) return false;
        await stopSwinging(ctx);
        ctx.doing('debuff', t.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, t.objectId, { approach: false });
        const refused = !c.success ? null : c.effectImmune || c.alreadyOn ? 'immune' : c.resisted ? 'resisted' : null;
        ctx.result('nearsight', refused ? { ...c, success: false, reason: refused } : c, t.objectId);
        until.set(t.objectId, Date.now() + (c.success && !refused ? NEARSIGHT_HOLD_MS : refused === 'immune' ? 60_000 : NEARSIGHT_RETRY_MS));
        // Amnesia'd or held: the turn is lost anyway; out of power, the nukes come first.
        if (!c.success && (c.reason === 'crowd_controlled' || c.reason === 'must_wait')) await Bun.sleep(Math.min(c.retryAfterMs ?? 2000, 3000));
        return true;
    },
});

/** The list's assist, then offFocus; both under the floor if there is one. */
export function nukerFight(saveBelow: number, withOffFocus: boolean): Behavior<TacticsSettings>[] {
    const floor = (b: Behavior<TacticsSettings>) => (saveBelow > 0 ? thrifty(b, saveBelow) : b);
    return [floor(assist()), ...(withOffFocus ? [floor(offFocus())] : [])];
}

export function cabalist({ saveBelow = 0, offFocus: off = true, meleeDebuff: debuff = true, nearsight: ns = true }: CabalistOptions = {}): Character {
    return { role: 'nuker', instant: [quickcastUnderFire(), ...(debuff ? [meleeDebuff()] : [])], ...(ns ? { react: [nearsight({ marked: camelotMezzer })] } : {}), fight: nukerFight(saveBelow, off) };
}
