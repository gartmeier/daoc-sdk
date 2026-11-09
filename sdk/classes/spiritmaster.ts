// The standard Spiritmaster: a starting point a bot imports into bots/<bot>/character.ts and tunes. The nuker's list
// casts at the focus and her pet fights it; what is the class's own is not standing idle: with the focus out of her
// reach and the pack holding ground, she nukes a free enemy player that is in reach (nukeInReach). learnings/classes/
// spiritmaster.md has the runs.

import { assist, foeInView, hammeredBy, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { Contact } from '../group/types';

/** Kept inside a spell's range: positions are a moment old, and the server measures in 3D. */
const RANGE_MARGIN = 50;

/**
 * What to nuke while the focus is out of reach: a free enemy player (no crowd control on it: a nuke wakes a mezz) within
 * `range`, not the focus, healers first, then casters, then the most hurt, then the nearest. Null when none.
 */
export function inReachTarget(threats: readonly Contact[], focus: number | null, distanceTo: (id: number) => number, range: number, now = Date.now()): Contact | null {
    const rank = (c: Contact) => (c.healer ? 0 : c.caster ? 1 : 2);
    return threats
        .filter(c => c.kind === 'player' && !c.isPet && !c.stale && isAlive(c) && !c.cc && !untouchable(c, now) && c.objectId !== focus && distanceTo(c.objectId) <= range - RANGE_MARGIN)
        .sort((a, b) => rank(a) - rank(b) || a.hp - b.hp || distanceTo(a.objectId) - distanceTo(b.objectId))[0] ?? null;
}

/** A nuke at inReachTarget's pick, below assist: it gets the turn only when assist has none (focus out of reach, holding ground). */
export const nukeInReach = (): Behavior<TacticsSettings> => ({
    name: 'nukeInReach',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || hammeredBy(ctx)) return false;
        const sp = ctx.spells.nuke();
        if (!sp || sp.radius > 0) return false;
        const target = inReachTarget(ctx.threats(), o.focus ?? null, id => foeInView(ctx, id)?.distance ?? Infinity, sp.range);
        if (!target) return false;
        ctx.doing('nuke', target.objectId, `${sp.spell.name} (focus out of reach)`);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false });
        ctx.result('nuke', c, target.objectId);
        return true;
    },
});

export function spiritmaster(): Character {
    return { role: 'nuker', fight: [assist(), nukeInReach()] };
}
