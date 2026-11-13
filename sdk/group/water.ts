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
import type { MoveGuard } from '../index';
import { getTerrainStore, NO_WATER, sampleTerrain, type TerrainGrid } from '../terrain';
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
    return wetAt(regionId, p.x, p.y);
}

/** isWet by coordinates. A cell with no river at its four corners is dry without sampling it (most of a map): moves ask this for every one sent. */
function wetAt(regionId: number, x: number, y: number): boolean {
    const g = gridAt(regionId, x, y);
    if (!g) return false;
    const cell = g.width / g.size, n = g.size;
    const i = Math.floor((x - g.xoff) / cell), j = Math.floor((y - g.yoff) / cell);
    if (i >= 0 && j >= 0 && i < n && j < n) {
        const i1 = Math.min(i + 1, n - 1), j1 = Math.min(j + 1, n - 1), w = g.water;
        if (w[j * n + i] === NO_WATER && w[j * n + i1] === NO_WATER && w[j1 * n + i] === NO_WATER && w[j1 * n + i1] === NO_WATER) return false;
    }
    const s = sampleTerrain(g, x, y);
    return !!s && s.waterZ !== null && s.waterZ - s.z >= GROUND_TUNING.swimDepth;
}

/** settings.stayDry, on unless it says otherwise: a script's flag comes as the string 'false'. */
export function staysDry(s: { stayDry?: unknown }): boolean {
    return !/^(false|0|off|no)$/i.test(String(s.stayDry ?? true));
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

/** How far short of the water's edge bankStop stops, and how finely it samples the line. */
export const BANK_BACK = 40;
const BANK_STEP = 32;

/**
 * Where a walk along `from`, then `points`, should end so a member on dry ground doesn't walk into the river at its end:
 * null when it needs no cut (we already swim, its end is dry, no terrain), else the waypoints it keeps and the spot BANK_BACK
 * short of where the wet stretch that ends it begins (`from` itself when that stretch starts at our feet). A walk that only
 * crosses a river to dry ground is left alone: travel legs, crossings, flight and the way home stay as planned.
 */
export function bankCut<P extends Point>(regionId: number, from: Point, points: readonly P[]): { to: Point; kept: P[] } | null {
    const end = points[points.length - 1];
    if (!end || !wetAt(regionId, end.x, end.y) || wetAt(regionId, from.x, from.y)) return null;
    // From the end back towards us, segment by segment: the first dry sample is the far edge of the wet stretch.
    for (let k = points.length - 1; k >= 0; k--) {
        const a = k ? points[k - 1]! : from, b = points[k]!;
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < 1) continue;
        const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
        for (let t = d - BANK_STEP; t > -BANK_STEP; t -= BANK_STEP) {
            const tt = Math.max(0, t);
            if (wetAt(regionId, a.x + ux * tt, a.y + uy * tt)) continue;
            const back = Math.max(0, tt - BANK_BACK);
            return { to: { x: Math.round(a.x + ux * back), y: Math.round(a.y + uy * back) }, kept: points.slice(0, k) };
        }
    }
    // Wet all the way back to our feet (the samples missed the dry strip we stand on): stay.
    return { to: { x: from.x, y: from.y }, kept: [] };
}

/**
 * Where a move from `from` to `to` should end so a member on dry ground doesn't walk into the river: bankCut on the
 * straight line, with `to`'s other fields. Albion, rounds 18-67: its healer and casters walked into range of a target in the
 * river and spent 13-49 % of fight time swimming.
 */
export function bankStop<P extends Point>(regionId: number, from: Point, to: P): P | null {
    const cut = bankCut(regionId, from, [to]);
    return cut && { ...to, x: cut.to.x, y: cut.to.y };
}

/**
 * The move guard a member with stayDry sets (BotSDK.setMoveGuard, member.ts): every move that would end in the river ends
 * on the bank instead, at our own height (the bank is near us; the mover stands us on the terrain), and one cut to where we
 * stand is refused. `settings` is read on each move, so stayDry=false turns it off.
 */
export function dryMoveGuard(settings: () => { stayDry?: unknown }): MoveGuard {
    return (from, to, waypoints) => {
        // Most moves end on dry ground: one lookup, nothing built.
        if (!wetAt(from.regionId, to.x, to.y) || !staysDry(settings())) return null;
        const cut = bankCut(from.regionId, from, waypoints.length ? [...waypoints, to] : [to]);
        if (!cut) return null;
        const kept = cut.kept.map(w => ({ x: w.x, y: w.y, z: w.z ?? from.z }));
        return { to: { x: cut.to.x, y: cut.to.y, z: kept.at(-1)?.z ?? from.z }, waypoints: kept };
    };
}
