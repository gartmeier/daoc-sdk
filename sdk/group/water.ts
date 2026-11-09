// Where the ground is deep water. A member there swims at 85 against 191 on land (client/movement.ts), which slows a
// tank or a healer and hardly a caster who stands and casts: fights in rivers favoured casters. So the strategies stop
// on dry ground (drySpot), and routes weigh water by that speed (safePath, and the navmesh in sdk/pathfinding.ts).
// Crossing a river is fine: in Thidranki the only dry ways over are the Faste's three bridges, inside its guards.
//
// From the client's terrain (zoneNNN.terrain, bun run terrain:build), as the mover decides when to swim (sdk/ground.ts).
// Without it nothing is water, and every helper here passes its spot through unchanged. A stop also stands on level ground
// where it can (slope.ts): drySpot finds the two together.

import { getZoneAt } from '../../data/zones';
import { GROUND_TUNING } from '../ground';
import { getTerrainStore, sampleTerrain, type TerrainGrid } from '../terrain';
import { isLevel } from './slope';
import type { Point } from './types';

/** Each zone's grid, loaded once: TerrainStore.at checks the file on every call, and a route samples thousands of spots. */
const grids = new Map<number, TerrainGrid | null>();

function gridAt(regionId: number, x: number, y: number): TerrainGrid | null {
    const zone = getZoneAt(regionId, x, y);
    if (!zone) return null;
    if (!grids.has(zone.id)) grids.set(zone.id, getTerrainStore().forZone(zone.id));
    return grids.get(zone.id)!;
}

/** Whether a member at `p` swims: the river surface at least swimDepth above the bed, as the mover has it (groundAt). A bridge over it counts as water. */
export function isWet(regionId: number, p: Point): boolean {
    const grid = gridAt(regionId, p.x, p.y);
    const s = grid ? sampleTerrain(grid, p.x, p.y) : null;
    return !!s && s.waterZ !== null && s.waterZ - s.z >= GROUND_TUNING.swimDepth;
}

/** How far from water a stop stays (drySpot): casters stand up to ~700 behind the anchor, most of them 200-450. */
export const DRY_MARGIN = 300;

/** `p` and the four spots `margin` from it north, south, east and west are out of deep water. */
export function isDry(regionId: number, p: Point, margin = DRY_MARGIN): boolean {
    return !isWet(regionId, p) && (margin <= 0 || [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => !isWet(regionId, { x: p.x + dx! * margin, y: p.y + dy! * margin })));
}
/** drySpot searches rings this far apart ... */
const RING_STEP = 150;
/** ... with this many spots each ... */
const RING_SPOTS = 24;
/** ... out to this far: Thidranki's rivers are up to ~2900 wide where they meet the Faste. */
const MAX_RADIUS = 3000;
/** A dry spot on level ground (slope.ts isLevel) is looked for this far; beyond, the nearest dry one will do, steep or not. */
export const LEVEL_SEARCH = 800;

export interface DryOptions {
    /** Of the nearest dry spots, the one nearest this: the bank we are heading for, or the one we stand on. */
    toward?: Point;
    /** Dry this far round as well (default DRY_MARGIN). */
    margin?: number;
    /** A further test a spot must pass: out of keep circles, on the map. */
    ok?: (p: Point) => boolean;
    /** On level ground as well (slope.ts isLevel) when there is such a spot within LEVEL_SEARCH (default on). */
    level?: boolean;
}

/**
 * A spot to stop at near `p` with no water within `margin`, and on level ground (no slope steeper than 35° within 300,
 * slope.ts isLevel) when one is within LEVEL_SEARCH: `p` itself (the same object) when it is one, else the nearest such
 * spot on rings round it, the one nearest `toward` among those. No level one near: the nearest dry one. Nothing dry within
 * MAX_RADIUS, or no terrain: `p`.
 */
export function drySpot<P extends Point>(regionId: number, p: P, o: DryOptions = {}): P | Point {
    const margin = o.margin ?? DRY_MARGIN;
    const dry = (q: Point) => isDry(regionId, q, margin) && (o.ok?.(q) ?? true);
    const level = o.level ?? true;
    const pDry = dry(p);
    if (pDry && (!level || isLevel(regionId, p))) return p;
    const t = o.toward;
    const pick = (ring: Point[]) => (t ? ring.reduce((a, b) => (Math.hypot(b.x - t.x, b.y - t.y) < Math.hypot(a.x - t.x, a.y - t.y) ? b : a)) : ring[0]!);
    const ringAt = (r: number, test: (q: Point) => boolean) => {
        const ring: Point[] = [];
        for (let k = 0; k < RING_SPOTS; k++) {
            const q = { x: Math.round(p.x + Math.cos(2 * Math.PI * k / RING_SPOTS) * r), y: Math.round(p.y + Math.sin(2 * Math.PI * k / RING_SPOTS) * r) };
            if (test(q)) ring.push(q);
        }
        return ring;
    };
    // The nearest dry ring (none needed when `p` is dry) ...
    let base = 0, dryRing: Point[] = [];
    if (!pDry) {
        for (let r = RING_STEP; r <= MAX_RADIUS && !dryRing.length; r += RING_STEP) {
            dryRing = ringAt(r, dry);
            base = r;
        }
        if (!dryRing.length) return p;
    }
    // ... and level ground up to LEVEL_SEARCH beyond it: a river's banks are often its steepest ground.
    if (level) {
        for (let r = Math.max(RING_STEP, base); r <= base + LEVEL_SEARCH; r += RING_STEP) {
            const ring = ringAt(r, q => dry(q) && isLevel(regionId, q));
            if (ring.length) return pick(ring);
        }
    }
    return pDry ? p : pick(dryRing);
}
