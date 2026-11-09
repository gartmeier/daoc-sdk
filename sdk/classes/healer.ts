// The standard Healer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list heals,
// mezzes and buffs from whatever she knows; what is the class's own:
// - Cleanse Mind, the mezz cure (baseline Pacification 23): a member held by an enemy mezz is lost for its whole length,
//   and she is Midgard's only cure. It goes in as urgent: in the pack's healer list below emergencyHeal and above heal.
// - Halt Attack, the baseline stun (2.5 s, range 1500, 8 s): the Cleric kit's stunPeel, on an enemy in melee on our soft
//   members, else on the enemy healer while our focus is low. Below heal and crowd control.
// Neither starts with an enemy swinging at her: a swing ends a cast half way.
// - Hinder Spirit, the instant attack slow (Pacification 2, 20 s, 5 s timer): on an enemy player in melee on her or a
//   soft member, which an instant can do even under the swings. learnings/classes/healer.md says what, and what has
//   been measured.

import { cureMezz, foeInView, hammeredBy, onMember, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import type { Contact, MemberReport } from '../group/types';
import { stunPeel } from './cleric';

/** `inner` only while no enemy player is in melee on us: its cast would be interrupted (hammeredBy). */
export const unlessHammered = (inner: Behavior<TacticsSettings>): Behavior<TacticsSettings> => ({
    ...inner,
    run: ctx => (hammeredBy(ctx) ? ctx.skip(`${inner.name}: a melee is on us`) : inner.run(ctx)),
});

/** The instant enemy attack slow we can cast now: Hinder Spirit and its ranks. */
export function slowSpell(all: readonly SpellPick[], mana: number): SpellPick | null {
    return all.filter(s => s.type === 'CombatSpeedDebuff' && s.target === 'Enemy' && s.castTime === 0 && s.range > 0 && s.power <= mana && s.spell.cooldownRemaining <= 0)
        .sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;
}

/**
 * Whom to slow: a free enemy player in melee on us, else on one of our soft members (not the tank or the melee), nearest
 * first; never one whose slow from us still runs (`until`), nor one beyond `range`. Null when none.
 */
export function slowTarget(me: MemberReport, members: readonly MemberReport[], threats: readonly Contact[], until: ReadonlyMap<number, number>, distanceTo: (id: number) => number, range: number, now = Date.now()): Contact | null {
    const soft = members.filter(m => !m.isDead && m.role !== 'tank' && m.role !== 'melee');
    const free = threats.filter(t => t.kind === 'player' && !t.isPet && !t.stale && isAlive(t) && !untouchable(t, now) && (until.get(t.objectId) ?? 0) <= now && distanceTo(t.objectId) <= range);
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

export function healer(): Character {
    return { role: 'healer', urgent: [unlessHammered(cureMezz()), hinder()], fight: [unlessHammered(stunPeel())] };
}
