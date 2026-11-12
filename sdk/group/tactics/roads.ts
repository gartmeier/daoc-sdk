// No camping an enemy's way out of its portal keep (the user, 2026-11-12, field freeze). At 11:05 UTC Camelot lay in wait
// beside Midgard's way in, 5864 from Midgard's portal keep; at 12:20 local it sat recovering about 5000 out on Midgard's
// road out and fought each unit that came out of it. The user: neither an ambush spot nor where a group sits to recover
// on or near an enemy's road out of its portal keep.
//
// An enemy realm's roads out, from the battleground's layout alone (the same for every enemy, no roster, no sightings):
//   - everything within ROAD_OUT_NEAR of its portal keep, every way out of it;
//   - from where it arrives (and lands after a release) toward the meeting point and each pair point it meets at, out to
//     ROAD_OUT_LEN, and within ROAD_OUT_WIDTH of that line. A road stops RING_CLEAR short of its end, so a pair round's
//     ring stays a place to rest for the realm that meets there (Albion's ring with Midgard is 11.9k from Midgard's arrival).
// Walking through is fine (patrols, hunts, fall-backs): this only moves where a group stands still.

import { BATTLEGROUND_LAYOUTS, homeOf, type KeepSettings, type PlayerRealm } from '../keeps';
import type { Realm } from '../../types';
import type { Point } from '../types';

/** Every way out of an enemy portal keep: nobody rests or lies in wait this close to it. */
export const ROAD_OUT_NEAR = 8000;
/** A road out runs this far from the enemy's arrival ... */
export const ROAD_OUT_LEN = 12_000;
/** ... and this far either side of it is on it. */
export const ROAD_OUT_WIDTH = 2000;
/** A road stops this short of the meeting point or pair point it leads to (patrol rings: 5500 and 4000). */
export const RING_CLEAR = 5500;

export interface RoadOut {
    /** The enemy realm whose road it is. */
    realm: PlayerRealm;
    /** Its portal keep's name. */
    keep: string;
    /** Its portal keep's centre: within ROAD_OUT_NEAR of it is on the road. */
    centre: Point;
    /** Line pieces from its arrival out, each within ROAD_OUT_WIDTH. */
    lines: { a: Point; b: Point }[];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from `p` to the piece a-b. */
export function toLine(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** The roads out of every enemy portal keep in this region (keepOwners can't move a portal keep); empty outside a known battleground. */
export function roadsOut(regionId: number, realm: Realm, _settings: Partial<KeepSettings> = {}): RoadOut[] {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    if (!bg) return [];
    const out: RoadOut[] = [];
    for (const r of ['albion', 'midgard', 'hibernia'] as PlayerRealm[]) {
        if (r === realm) continue;
        const home = homeOf(regionId, r);
        if (!home) continue;
        const from = home.arrival;
        const ends: Point[] = [bg.meet, ...Object.entries(bg.pairs ?? {}).filter(([k]) => k.split('|').includes(r)).map(([, p]) => p)];
        const lines = ends.flatMap(end => {
            const d = dist(from, end);
            const len = Math.min(ROAD_OUT_LEN, d - RING_CLEAR);
            if (len <= 0) return [];
            return [{ a: { x: from.x, y: from.y }, b: { x: Math.round(from.x + (end.x - from.x) * len / d), y: Math.round(from.y + (end.y - from.y) * len / d) } }];
        });
        out.push({ realm: r, keep: home.keep.name, centre: { x: home.keep.x, y: home.keep.y }, lines });
    }
    return out;
}

/** The enemy road out `p` stands on or near, by `margin` more; null when it is on none. */
export function onRoadOut(p: Point, roads: readonly RoadOut[], margin = 0): RoadOut | null {
    return roads.find(r => dist(p, r.centre) < ROAD_OUT_NEAR + margin || r.lines.some(l => toLine(p, l.a, l.b) < ROAD_OUT_WIDTH + margin)) ?? null;
}

/** Rings searched for a spot off the roads: every 400 out to 7200, 16 ways round. */
const OFF_RADII = Array.from({ length: 18 }, (_, i) => 400 * (i + 1));
const OFF_WAYS = 16;
/** A spot found off a road stands this far clear of it, so the next look doesn't call it on it again. */
const OFF_MARGIN = 300;

/**
 * Where to stand instead of `p`: `p` itself when it is on no enemy road out, else the nearest spot clear of them all by
 * OFF_MARGIN that `ok` takes (dry, clear of keeps). Null when none is within reach (stay where we are then).
 */
export function offRoadsOut(p: Point, roads: readonly RoadOut[], ok: (q: Point) => boolean = () => true): (Point & { road: RoadOut | null }) | null {
    const road = onRoadOut(p, roads);
    if (!road) return { x: p.x, y: p.y, road: null };
    for (const r of OFF_RADII) for (let k = 0; k < OFF_WAYS; k++) {
        const a = k * 2 * Math.PI / OFF_WAYS;
        const q = { x: Math.round(p.x + Math.cos(a) * r), y: Math.round(p.y + Math.sin(a) * r) };
        if (!onRoadOut(q, roads, OFF_MARGIN) && ok(q)) return { ...q, road };
    }
    return null;
}
