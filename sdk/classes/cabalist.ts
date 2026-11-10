// The standard Cabalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role is what
// roleForClass gives: the list casts her DoTs first as it is, and they hold out on power without a floor. What is
// the class's own is spreading them: with the focus out of her reach she puts them on a free enemy in reach (offFocus),
// which Albion's Sorcerer and Theurgist kits use for their nukes too. learnings/classes/cabalist.md says what has been measured.

import { assist, ccHolds, ckey, claimedBy, foeInView, hammeredBy, isDown, noteNukeEnd, onMember, stopSwinging, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import { dist } from '../group/battleground';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { dotFamily, type SpellPick } from '../group/spells';
import type { Contact, MemberReport, Orders, Point } from '../group/types';
import { thrifty } from './thrifty';

export interface CabalistOptions {
    /** No nukes below this % power; 0 (the default): no floor. */
    saveBelow?: number;
    /** DoTs and nukes on a free enemy in reach while the focus is out of it (offFocus). On by default. */
    offFocus?: boolean;
    /** Instant debuffs on a melee hitting her or a caster (meleeDebuff, the instant slot). On by default. */
    meleeDebuff?: boolean;
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

/** The list's assist, then offFocus; both under the floor if there is one. */
export function nukerFight(saveBelow: number, withOffFocus: boolean): Behavior<TacticsSettings>[] {
    const floor = (b: Behavior<TacticsSettings>) => (saveBelow > 0 ? thrifty(b, saveBelow) : b);
    return [floor(assist()), ...(withOffFocus ? [floor(offFocus())] : [])];
}

export function cabalist({ saveBelow = 0, offFocus: off = true, meleeDebuff: debuff = true }: CabalistOptions = {}): Character {
    return { role: 'nuker', ...(debuff ? { instant: [meleeDebuff()] } : {}), fight: nukerFight(saveBelow, off) };
}
