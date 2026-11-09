// How steep the ground is. The navmesh covers slopes of 45° and more (in Thidranki 99 % of ground steeper than 2:1 has a
// poly), and the server checks no z, so nothing but our own routes keeps a member off a cliff: a bot that runs up a bank a
// real client would slide down is easy to tell from a player, and a fight on a hillside puts the casters 100s of units
// above or below the focus. So stops (patrol waypoints, legs, fight anchors) stand on level ground (water.ts drySpot), and
// routes weigh steep ground (safePath).
//
// From the client's terrain (zoneNNN.terrain, bun run terrain:build), as water.ts: without it nothing is steep, and every
// helper here passes its spot through unchanged. Thidranki, its dry ground away from the map's edge: half of it rises
// less than 0.28 per unit, 10 % more than 0.94; the banks of its three rivers are its steepest ground inside the hills.

import { getZoneAt } from '../../data/zones';
import { getTerrainStore, type TerrainGrid } from '../terrain';
import type { Point } from './types';

/** Rise per unit (tan of the angle) a stop stays below: 35°. Members spread 200-700 round a stop, so it counts round it too (isLevel). */
export const STEEP = 0.7;
/** Rise per unit a route crosses only where there is no other way: 45°, the river banks and the hills round the map. */
export const CLIFF = 1.0;
/**
 * Ground steeper than this, 56°, is a cliff face no route takes while there is a way round at all: a real client slides
 * down it or falls (fall damage), and can't climb it. The banks of the west river are such a face 600-2400 high from
 * x 17000 to 27000 (Hibernia group session, 2026-11-09).
 */
export const SHEER = 1.5;
/** Below this a route walks as on the flat: 0.5 (27°) is a hill a real client runs up at full speed. */
export const GENTLE = 0.5;
/** How far round a stop the ground has to be level as well (isLevel). */
export const LEVEL_MARGIN = 300;

interface SlopeGrid {
    grid: TerrainGrid;
    /** The steeper of the two terrain triangles of each cell (cell (i, j) spans vertices i..i+1, j..j+1), index j * size + i. */
    cells: Float32Array;
}

/** Each zone's slope raster, built once: a route samples thousands of spots. */
const rasters = new Map<number, SlopeGrid | null>();

function build(grid: TerrainGrid): SlopeGrid {
    const n = grid.size, cell = grid.width / n, h = grid.heights;
    const at = (i: number, j: number) => h[Math.min(j, n - 1) * n + Math.min(i, n - 1)]!;
    const cells = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const h00 = at(i, j), h10 = at(i + 1, j), h01 = at(i, j + 1), h11 = at(i + 1, j + 1);
            // The two triangles sampleTerrain interpolates on, the diagonal (i+1, j)-(i, j+1).
            const lower = Math.hypot(h10 - h00, h01 - h00), upper = Math.hypot(h11 - h01, h11 - h10);
            cells[j * n + i] = Math.max(lower, upper) / cell;
        }
    }
    return { grid, cells };
}

function rasterAt(regionId: number, x: number, y: number): SlopeGrid | null {
    const zone = getZoneAt(regionId, x, y);
    if (!zone) return null;
    if (!rasters.has(zone.id)) {
        const grid = getTerrainStore().forZone(zone.id);
        rasters.set(zone.id, grid ? build(grid) : null);
    }
    return rasters.get(zone.id)!;
}

/** The slope of the ground at `p` (rise per unit; the steeper triangle of its 256-unit terrain cell); 0 without terrain. */
export function slopeAt(regionId: number, p: Point): number {
    const r = rasterAt(regionId, p.x, p.y);
    if (!r) return 0;
    const g = r.grid, cell = g.width / g.size;
    const i = Math.floor((p.x - g.xoff) / cell), j = Math.floor((p.y - g.yoff) / cell);
    if (i < 0 || j < 0 || i >= g.size || j >= g.size) return 0;
    return r.cells[j * g.size + i]!;
}

/** Whether the ground at `p` is steeper than `limit` (default STEEP). */
export const isSteep = (regionId: number, p: Point, limit = STEEP) => slopeAt(regionId, p) > limit;

/** `p` and the eight spots `margin` from it (and half way to them) on ground no steeper than STEEP. */
export function isLevel(regionId: number, p: Point, margin = LEVEL_MARGIN): boolean {
    if (isSteep(regionId, p)) return false;
    if (margin <= 0) return true;
    for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4, dx = Math.cos(a), dy = Math.sin(a);
        for (const r of [margin / 2, margin]) if (isSteep(regionId, { x: p.x + dx * r, y: p.y + dy * r })) return false;
    }
    return true;
}

/**
 * What a unit walked at `p` costs on top of a unit on the flat: nothing up to GENTLE, then rising to 2 at CLIFF (3× the
 * time, as a real client slows and zigzags), to 6 at SHEER (7×), and 60 beyond: a route goes round a steep bank unless
 * the way round is far longer, and over a cliff face only when there is no other way (an aggro zone costs 30).
 */
export function slopeCost(regionId: number, p: Point): number {
    const s = slopeAt(regionId, p);
    return s <= GENTLE ? 0 : s <= CLIFF ? 2 * (s - GENTLE) / (CLIFF - GENTLE) : s <= SHEER ? 2 + 4 * (s - CLIFF) / (SHEER - CLIFF) : 60;
}

export interface SlopeStretch {
    /** Units of the way on ground steeper than STEEP ... */
    steep: number;
    /** ... of these, steeper than CLIFF. */
    cliff: number;
    /** The steepest slope on it. */
    max: number;
}

/** How much of the straight way from `a` to `b` is steep, sampled every `step` units; `skip` leaves samples out (water.ts isWet: a swimmer is over the bed). */
export function slopeAlong(regionId: number, a: Point, b: Point, step = 64, skip?: (p: Point) => boolean): SlopeStretch {
    const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(d / step));
    const out: SlopeStretch = { steep: 0, cliff: 0, max: 0 };
    for (let k = 0; k < n; k++) {
        const p = { x: a.x + (b.x - a.x) * (k + 0.5) / n, y: a.y + (b.y - a.y) * (k + 0.5) / n };
        if (skip?.(p)) continue;
        const s = slopeAt(regionId, p);
        out.max = Math.max(out.max, s);
        if (s > STEEP) out.steep += d / n;
        if (s > CLIFF) out.cliff += d / n;
    }
    return out;
}
