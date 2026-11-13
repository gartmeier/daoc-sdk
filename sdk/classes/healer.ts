// The standard Healer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list heals,
// mezzes and buffs from whatever she knows; what is the class's own:
// - Cleanse Mind, the mezz cure (baseline Pacification 23): a member held by an enemy mezz is lost for its whole length,
//   and she is Midgard's only cure. It goes in as urgent: in the pack's healer list below emergencyHeal and above heal.
// - Halt Attack, the baseline stun (2.5 s, range 1500, 8 s): the Cleric kit's stunPeel, on an enemy in melee on our soft
//   members, else on the enemy healer while our focus is low. Below heal and crowd control.
// Neither starts with an enemy swinging at her: a swing ends a cast half way.
// - Hinder Spirit, the instant attack slow (Pacification 2, 20 s, 5 s timer): on an enemy player in melee on her or a
//   soft member, which an instant can do even under the swings. In the instant slot, above flee, which otherwise takes
//   every turn while a melee is on her.
// - Cure Nearsight I (Mending 20, 6 s, 30 power): an enemy Nearsight (Albion's Obscuring Dust, -35 % spell range for
//   120 s) leaves a caster answered "too far away" from where it stands; she lifts it, our nuker first. In urgent after
//   the mezz cure: below the emergency heal, above heal (round 65: Dust on Ulfgar and Hrafna, no cure cast from react). learnings/classes/healer.md says what, and what has
//   been measured.

//
// Other kits import from here, so keep these names and signatures, or tell their class sessions first: slowTarget and
// slowSpell (Hibernia's Enchanter), cureNearsight and unlessHammered (Hibernia's Druid), unlessHammered (Midgard's Shaman).

import { cureMezz, foeInView, hammeredBy, onMember, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import { getSpells } from '../../data/index';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import type { Contact, MemberReport } from '../group/types';
import { stunPeel } from './cleric';
import { groupHeal } from './druid';
import { sightClock, standOutOfSight } from './healer-stand';

/** `inner` only while no enemy player is in melee on us: its cast would be interrupted (hammeredBy). */
export const unlessHammered = (inner: Behavior<TacticsSettings>): Behavior<TacticsSettings> => ({
    ...inner,
    run: ctx => (hammeredBy(ctx) ? ctx.skip(`${inner.name}: a melee is on us`) : inner.run(ctx)),
});

/** The instant single-target enemy attack slow we can cast now: Hinder Spirit and its ranks. Not an area one, which would wake a mezz beside the target. */
export function slowSpell(all: readonly SpellPick[], mana: number): SpellPick | null {
    return all.filter(s => s.type === 'CombatSpeedDebuff' && s.target === 'Enemy' && s.castTime === 0 && s.range > 0 && s.radius === 0 && s.power <= mana && s.spell.cooldownRemaining <= 0)
        .sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;
}

/**
 * Whom to slow: a free enemy player or pet in melee on us, else on one of our soft members (a pet too: a taunt doesn't move
 * an ordered one, so the tank's peel leaves it, and Albion's simulacrum is in every Camelot fight) (not the tank or the melee), nearest
 * first; never one whose slow from us still runs (`until`), nor one beyond `range`. Null when none.
 */
export function slowTarget(me: MemberReport, members: readonly MemberReport[], threats: readonly Contact[], until: ReadonlyMap<number, number>, distanceTo: (id: number) => number, range: number, now = Date.now()): Contact | null {
    const soft = members.filter(m => !m.isDead && m.role !== 'tank' && m.role !== 'melee');
    const free = threats.filter(t => (t.kind === 'player' || !!t.isPet) && !t.stale && isAlive(t) && !untouchable(t, now) && (until.get(t.objectId) ?? 0) <= now && distanceTo(t.objectId) <= range);
    return free.find(t => onMember(t, me)) ?? free.filter(t => soft.some(m => onMember(t, m))).sort((a, b) => distanceTo(a.objectId) - distanceTo(b.objectId))[0] ?? null;
}

/** Hinder Spirit at slowTarget's pick, in a fight. Instant: it goes under the swings, where her heals with a cast time don't. */
export const hinder = (): Behavior<TacticsSettings> => ({
    name: 'hinder',
    interruptible: false,
    async run(ctx) {
        if (ctx.orders().phase !== 'engage') return false;
        const me = ctx.me();
        const sp = slowSpell(ctx.spells.all(), me.mana);
        if (!sp) return false;
        const until: Map<number, number> = ctx.memory.get('slowUntil') ?? new Map();
        ctx.memory.set('slowUntil', until);
        const self = ctx.members().find(m => m.name === ctx.name);
        if (!self) return false;
        const distanceTo = (id: number) => foeInView(ctx, id)?.distance ?? Infinity;
        const target = slowTarget(self, ctx.members(), ctx.threats(), until, distanceTo, sp.range);
        if (!target) return false;
        ctx.doing('debuff', target.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false });
        ctx.result('debuff', c.success && c.resisted ? { ...c, success: false, reason: 'resisted' } : c, target.objectId);
        until.set(target.objectId, Date.now() + (c.success && !c.resisted ? sp.duration * 1000 : 3000));
        return true;
    },
});

let nearsightNames: Set<string> | undefined;
/** Whether a member's effect is an enemy Nearsight: the server sends the spell's name. */
export function isNearsightEffect(name: string): boolean {
    nearsightNames ??= new Set(getSpells().filter(s => s.type === 'Nearsight').map(s => s.name));
    return nearsightNames.has(name);
}

/** Her extras (the stun, the Nearsight cure) stop below this much power: heals first. Round 52: 34 heals refused for power. */
export const EXTRAS_FLOOR = 40;

/** Kept inside the cure's range: the server measures in 3D, positions are a moment old, and the cast is 6 s. Round 87: 4 `nearsight:out_of_range` at 50. */
const CURE_RANGE_MARGIN = 150;

/** Whom to cure of Nearsight: a living member in 3D reach with one on it, our nuker first, then a healer, a support, the rest. Ourselves too. */
export function nearsightedMember(me: Pick<MemberReport, 'x' | 'y' | 'z' | 'regionId'>, members: readonly MemberReport[], range: number): MemberReport | null {
    const rank = (m: MemberReport) => (m.role === 'nuker' ? 0 : m.role === 'healer' ? 1 : m.role === 'support' ? 2 : 3);
    const reach = (m: MemberReport) => Math.hypot(me.x - m.x, me.y - m.y, (me.z ?? 0) - (m.z ?? 0)) <= range - CURE_RANGE_MARGIN;
    return members.filter(m => !m.isDead && m.regionId === me.regionId && reach(m) && m.effects.some(isNearsightEffect))
        .sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** No 6 s cure while a member is below this health: heals first. */
export const NEARSIGHT_HEALTH_FLOOR = 50;

/**
 * Whether a 6 s Nearsight cure fits now: nobody of ours below NEARSIGHT_HEALTH_FLOOR. A melee on her is unlessHammered's.
 * Round 77 (a floor of 60 and no cure while anything targeted her) stopped the cure taking heals; it also stopped it
 * almost always in a fight, and Camelot's Obscuring Dust stayed on Hrafna and Ulfgar (rounds 102-110, damage 4900 to 590).
 */
export function nearsightCalm(members: readonly Pick<MemberReport, 'isDead' | 'hp'>[]): boolean {
    return !members.some(m => !m.isDead && m.hp < NEARSIGHT_HEALTH_FLOOR);
}

/** A cure on one member at most this often: its effect list can lag the cure by a report. */
const NEARSIGHT_SPACING_MS = 8000;
/** ... and this long after the server called it out of range. */
const NEARSIGHT_FAR_MS = 20_000;

/** Cure Nearsight on nearsightedMember's pick, in or out of a fight. */
export const cureNearsight = (): Behavior<TacticsSettings> => ({
    name: 'cureNearsight',
    interruptible: false,
    async run(ctx) {
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < EXTRAS_FLOOR) return false;
        if (!nearsightCalm(ctx.members())) return false;
        const sp = ctx.spells.all().find(s => s.type === 'CureNearsightCustom' && s.spell.cooldownRemaining <= 0 && s.power <= me.mana);
        if (!sp) return false;
        const self = ctx.members().find(m => m.name === ctx.name);
        if (!self) return false;
        const m = nearsightedMember(self, ctx.members(), sp.range);
        if (!m) return false;
        const key = `nearsight:${m.objectId}`;
        if (Date.now() - (ctx.memory.get(key) ?? 0) < NEARSIGHT_SPACING_MS) return false;
        ctx.memory.set(key, Date.now());
        // Its own kind in the reports, apart from the mezz cure's `cure`.
        ctx.doing('nearsight', m.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, m.objectId, { approach: false });
        ctx.result('nearsight', c, m.objectId);
        // The server called it too far: that member is left 20 s, not 8 (round 96: 4 such answers at a margin of 150).
        if (c.reason === 'out_of_range') ctx.memory.set(key, Date.now() + NEARSIGHT_FAR_MS - NEARSIGHT_SPACING_MS);
        return true;
    },
});

export interface HealerOptions {
    /** groupHeal (the Druid's): Favor of Battle when this many around her (her too) each miss most of its 103. */
    groupHealMin?: number;
    /** groupHeal: below this % power she keeps it for single heals. */
    groupHealAbove?: number;
    /** standOutOfSight (healer-stand.ts): step out of the enemy's sight, in group-heal reach. On by default. */
    stand?: boolean;
}

/**
 * Favor of Battle (Mending 16: 103 on everyone within 2000, 3.7 s, 44 power) through the Druid's groupHeal, after the mezz
 * cure and before the Nearsight cure: heal() never picks a group heal (druid.ts). The stand and the clock: healer-stand.ts.
 */
export function healer({ groupHealMin = 3, groupHealAbove = 30, stand = true }: HealerOptions = {}): Character {
    return {
        role: 'healer', instant: [hinder()],
        urgent: [unlessHammered(cureMezz()), unlessHammered(groupHeal(groupHealMin, groupHealAbove)), ...(stand ? [standOutOfSight()] : []), unlessHammered(cureNearsight())],
        chores: [sightClock()],
        fight: [unlessHammered(stunPeel({ minMana: EXTRAS_FLOOR }))],
    };
}
