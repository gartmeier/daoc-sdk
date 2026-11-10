// Walking a trip in legs without stopping at each one. The coordinator's travel anchor jumps a leg (travelLeg, 1500)
// ahead once everyone is within LEG_REACHED of the last (rvr.ts stepLeg), and each member walks to its formation slot
// round it (holdFormation). Walking to the slot itself, the mover braked to rest there (its ramp, client/movement.ts),
// and the member stood until the next jump: measured 2026-11-10 in a Camelot patrol, every ~7 s the tank and three
// others stood 0.5-1 s and started again from rest, because Merlin's slot (~1150 back) came within 1200 of the leg only
// as he arrived. So a leg says where the trip goes on (Anchor.onward), and a member walking to its slot while
// travelling aims past it that way, as a column's follower aims past its place (COLUMN_LEAD): the next leg comes before
// it gets there, and it never brakes. A leg with nowhere on (the trip's end) is walked to the slot as before.
import type { Orders, Point } from './types';
import { isWet } from './water';

/** How far past its slot a member aims while the trip goes on: at most this, and never past the onward point. */
export const TRAVEL_LEAD = 400;
/** An onward point nearer the anchor than this says nothing about a way on. */
export const ONWARD_MIN = 300;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The way on from these orders: a unit vector and how far it reaches, or null (not travelling, or nowhere on). */
export function onwardWay(o: Pick<Orders, 'phase' | 'anchor' | 'column'>): { u: Point; reach: number } | null {
    const a = o.anchor, on = a?.onward;
    if (o.phase !== 'travel' || o.column || !a || !on) return null;
    const reach = dist(a, on);
    if (reach < ONWARD_MIN) return null;
    return { u: { x: (on.x - a.x) / reach, y: (on.y - a.y) / reach }, reach };
}

/**
 * Where a member walking to `slot` aims while these orders travel on: TRAVEL_LEAD past it along the way on (at most as
 * far as the onward point lies beyond the anchor). Null: aim at the slot itself (no way on, or past it lies water while
 * the slot is dry; then half the lead first).
 */
export function travelAim(regionId: number, slot: Point, o: Pick<Orders, 'phase' | 'anchor' | 'column'>): Point | null {
    const way = onwardWay(o);
    if (!way) return null;
    const dryHere = !isWet(regionId, slot);
    for (const lead of [Math.min(TRAVEL_LEAD, way.reach), Math.min(TRAVEL_LEAD, way.reach) / 2]) {
        const aim = { x: Math.round(slot.x + way.u.x * lead), y: Math.round(slot.y + way.u.y * lead) };
        if (!dryHere || !isWet(regionId, aim)) return aim;
    }
    return null;
}

/**
 * Whether a slot walk cut off by new orders may leave the mover running instead of braking: the orders still travel on
 * (a new leg with a way on), so the next turn re-aims it at full speed. Anything else (a fight, a stop, the last leg)
 * brakes as every aborted walk does.
 */
export function keepsTravelling(o: Pick<Orders, 'phase' | 'anchor' | 'column'>): boolean {
    return onwardWay(o) !== null;
}
