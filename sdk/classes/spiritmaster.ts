// The standard Spiritmaster: a starting point a bot imports into bots/<bot>/character.ts and tunes. The nuker's list
// casts at the focus and her pet fights it; what is the class's own is not standing idle: with the focus out of her
// reach and the pack holding ground, she nukes a free enemy player that is in reach (nukeInReach). Under fire (a melee on
// her, or a cast interrupted in the last 5 s) Quickcast makes her next cast uninterruptible: the Cabalist kit's
// quickcastUnderFire, in the instant slot. learnings/classes/spiritmaster.md has the runs.

import { assist, foeInView, hammeredBy, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { Contact } from '../group/types';
import { quickcastUnderFire } from './cabalist';

/**
 * Her step toward an out-of-reach focus, whatever the group's standStep: a longer one against fanOut kept her walking
 * 73 % of rounds 27, 32 and 34, with nukeInReach there for a focus she can't reach.
 */
export const HOLD_GROUND = 250;

/** A target the server called out of range is left this long: round 37 had 15 such answers in 17 s on one target. */
export const FAR_MS = 8000;

/** Kept inside a spell's range: positions are a moment old, and the server measures in 3D. */
const RANGE_MARGIN = 50;

/**
 * What to nuke while the focus is out of reach: a free enemy player (no crowd control on it: a nuke wakes a mezz) within
 * `range`, not the focus, healers first, then casters, then the most hurt, then the nearest. Null when none.
 */
export function inReachTarget(threats: readonly Contact[], focus: number | null, distanceTo: (id: number) => number, range: number, now = Date.now(), far: ReadonlyMap<number, number> = new Map()): Contact | null {
    const rank = (c: Contact) => (c.healer ? 0 : c.caster ? 1 : 2);
    return threats
        .filter(c => c.kind === 'player' && !c.isPet && !c.stale && isAlive(c) && !c.cc && !untouchable(c, now) && c.objectId !== focus && (far.get(c.objectId) ?? 0) <= now && distanceTo(c.objectId) <= range - RANGE_MARGIN)
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
        const far: Map<number, number> = ctx.memory.get('nukeFar') ?? new Map();
        ctx.memory.set('nukeFar', far);
        const target = inReachTarget(ctx.threats(), o.focus ?? null, id => foeInView(ctx, id)?.distance ?? Infinity, sp.range, Date.now(), far);
        if (!target) return false;
        ctx.doing('nuke', target.objectId, `${sp.spell.name} (focus out of reach)`);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false });
        ctx.result('nuke', c, target.objectId);
        // The server says it is farther than we see it: not again for a while, the next in reach gets the turn.
        if (c.reason === 'out_of_range') far.set(target.objectId, Date.now() + FAR_MS);
        return true;
    },
});

export function spiritmaster(): Character {
    return { role: 'nuker', instant: [quickcastUnderFire()], fight: [assist({ holdGround: HOLD_GROUND }), nukeInReach()] };
}
