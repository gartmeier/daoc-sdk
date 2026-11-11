// Settings that depend on how many we are. Group play was tuned for five: a pack of 3, a retreat margin of 3. At eight the
// same absolute numbers mean something else (3 of 8 is a broken group, not a pack), so these settings are shares of the
// group's size, rounded, with today's values at five: 0.6 × 5 = 3.
//
// A plain number still means that number, whatever the size: a CLI flag (--pack.minPack=1, --retreat.margin=99) or a
// strategy that sets one keeps its meaning.

import type { MemberReport } from './types';

/** A count of members or enemies: a fixed number, or a share of the group's size (at least `min`, default 1). */
export type Count = number | { share: number; min?: number };

/** The size the shares were tuned at: today's values hold at it. */
export const TUNED_SIZE = 5;

/** `c` for a group of `size`, rounded to the nearest: a share of 0.6 is 3 at five, 5 at eight, 2 at three. */
export function countFor(c: Count, size: number): number {
    if (typeof c === 'number') return c;
    if (c && typeof c === 'object' && typeof c.share === 'number') return Math.max(c.min ?? 1, Math.round(c.share * size));
    // A flag arrives as a string (--pack.minPack=4): a number all the same.
    const n = Number(c);
    return Number.isFinite(n) ? n : 0;
}

/** For a report or a finding: "3", or "3 (0.6 of 5)". */
export function describeCount(c: Count, size: number): string {
    const n = countFor(c, size);
    return typeof c === 'object' && c ? `${n} (${c.share} of ${size})` : String(n);
}

/**
 * The group's size for the shares: the most members the board has reported at once this run, kept in the coordinator's
 * memory, and never below TUNED_SIZE. Dead members count (they are still the group); a report that drops out for a
 * moment, or a member still logging in at the start, doesn't shrink it. A group of five or fewer keeps the numbers it had
 * before the shares: nothing was tuned below five, so only a larger group scales.
 *
 * Below five the floor stays on purpose. A squad of 1 to 3 (squad.ts) doesn't go by these counts: its inner decide runs
 * with retreat off, and it takes or leaves a fight by its own odds (squad.ts sizeUp). Shares there would round oddly
 * anyway: 0.6 of 1, 2 and 3 is 1, 1 and 2, so a duo would run from three enemies, as a solo would from two.
 */
export function groupSize(mem: Record<string, any>, members: readonly Pick<MemberReport, 'name'>[]): number {
    const n = new Set(members.map(m => m.name)).size;
    mem.groupSize = Math.max(mem.groupSize ?? 0, n);
    return Math.max(TUNED_SIZE, mem.groupSize);
}
