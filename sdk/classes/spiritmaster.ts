// The standard Spiritmaster: a starting point a bot imports into bots/<bot>/character.ts and tunes. The nuker's list
// casts at the focus and her pet fights it; what is the class's own is not standing idle: with the focus out of her
// reach and the pack holding ground, she nukes a free enemy player that is in reach (nukeInReach). Under fire (a melee on
// her, or a cast interrupted in the last 5 s) Quickcast makes her next cast uninterruptible: the Cabalist kit's
// quickcastUnderFire, in the instant slot. learnings/classes/spiritmaster.md has the runs.

//
// Other kits import from here, so keep these names and signatures, or tell their class sessions first: steppingAssist()
// (named 'assist'; Hibernia's Mentalist and Enchanter). It keeps its wait in ctx.memory 'outSince', which nukeInReach
// resets on a cast; a kit without nukeInReach gets the long step and the leg 4 s after its last cast.

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
/** ... unless the focus has been out of reach this long with nothing cast meanwhile: then a step of LONG_STEP. Round 44 she stood 69 % of a 246 s fight at 250. */
export const LONG_AFTER_MS = 4000;
export const LONG_STEP = 750;

/** Which step assist gets: the short one, or the long one once `outSince` (focus out of reach, nothing cast since) is LONG_AFTER_MS old. */
export function stepFor(outSince: number | null, now = Date.now()): number {
    return outSince !== null && now - outSince >= LONG_AFTER_MS ? LONG_STEP : HOLD_GROUND;
}

/** A leg of the walk in when even the long step can't be taken (standStepTo: the focus too far, or an enemy at the spot). Round 52 she stood 80 % of a fight that way. */
const LEG_MS = 3000;
/** ... to this share of the nuke's range from the focus. */
const LEG_REACH = 0.85;
/**
 * ... and only with the focus at most this far beyond her range: farther is a caster behind their line, and chasing it
 * kept her walking 70 % of round 56 (Camelot) for 5 nukes, where Hibernia, closer in, gave 38 (round 55).
 */
export const LEG_MAX_GAP = 900;

/** Whether a leg toward a focus `distance` away is worth walking, for a nuke of `range`. */
export const legWorthIt = (distance: number, range: number): boolean => distance - range <= LEG_MAX_GAP;

/** assist with stepFor's step, and after LONG_AFTER_MS with nothing cast, a leg toward the focus when even that step can't be taken. Named assist, as the role's fight is. */
export const steppingAssist = (): Behavior<TacticsSettings> => {
    const short = assist({ holdGround: HOLD_GROUND }), long = assist({ holdGround: LONG_STEP });
    return {
        ...short,
        async run(ctx) {
            const o = ctx.orders();
            const sp = ctx.spells.nuke();
            const d = o.focus ? foeInView(ctx, o.focus)?.distance : undefined;
            const out = o.phase === 'engage' && !!sp && d !== undefined && d > sp.range;
            const was: number | null = ctx.memory.get('outSince') ?? null;
            const since = out ? was ?? Date.now() : null;
            ctx.memory.set('outSince', since);
            const longNow = stepFor(since) === LONG_STEP;
            const acted = await (longNow ? long : short).run(ctx);
            if (acted) {
                ctx.memory.set('outSince', null);
                return true;
            }
            const seen = longNow && o.focus ? foeInView(ctx, o.focus) : null;
            if (!seen || !sp || ctx.orders().phase !== 'engage' || !legWorthIt(seen.distance, sp.range)) return false;
            ctx.doing('move', o.focus, 'closing on the focus');
            await ctx.bot.walkToObject(seen, { range: sp.range * LEG_REACH, timeout: LEG_MS });
            return true;
        },
    };
};

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
        if (c.success) ctx.memory.set('outSince', null);
        // The server says it is farther than we see it: not again for a while, the next in reach gets the turn.
        if (c.reason === 'out_of_range') far.set(target.objectId, Date.now() + FAR_MS);
        return true;
    },
});

export function spiritmaster(): Character {
    return { role: 'nuker', instant: [quickcastUnderFire()], fight: [steppingAssist(), nukeInReach()] };
}
