// Exact outdoor terrain height from the client's own heightmaps.
//
// `bun run terrain:build` (scripts/build-terrain.ts, also run by navmesh:build) writes one
// server/navmesh/zoneNNN.terrain per outdoor zone that has a navmesh (gitignored, derived from
// client assets). Each holds what buildnav exports as terrain (server/buildnav/Client/ZoneExporter/
// Heightmap.cs): a 256x256 vertex grid 256 units apart, height = terrain.pcx * scalefactor +
// offset.pcx * offsetfactor (sector.dat [terrain]), plus the water.pcx river index and the
// [riverNN] heights. Positions recorded by real clients sit at floor(terrainZ) on these
// triangles, while navmesh z is 0..13 units higher (Recast rounds span tops up to the 3.2-unit
// cell height and adds one more cell to detail vertices).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getZoneAt } from '../data/zones';
import { DEFAULT_NAVMESH_DIR } from './navmesh';

const MAGIC = 0x4e525444; // 'DTRN'
const VERSION = 1;
const HEADER_BYTES = 32;
/** water.pcx value for "no river here". */
export const NO_WATER = 255;

/** One zone's terrain grid (zone-local vertex (i, j) is at (xoff + i*cell, yoff + j*cell)). */
export interface TerrainGrid {
    zoneId: number;
    regionId: number;
    xoff: number;
    yoff: number;
    width: number;
    height: number;
    /** Vertices per side (256); vertex index size stands for size - 1, as buildnav repeats the last row/column. */
    size: number;
    /** Vertex heights, index j * size + i. */
    heights: Uint16Array;
    /** water.pcx river index per vertex (NO_WATER = none), index j * size + i. */
    water: Uint8Array;
    /** sector.dat [riverNN] surface heights. */
    waterHeights: Int32Array;
}

export interface TerrainSample {
    /** Ground height on the client's terrain triangles (the river bed in water). */
    z: number;
    /** The surface buildnav built the navmesh from: z, except that vertices under a river sit at its surface - 16. */
    navZ: number;
    /** Rise per unit of horizontal distance of z (0 = flat). */
    slope: number;
    /** Highest river surface over a corner of this cell, or null; the point is under water when waterZ > z. */
    waterZ: number | null;
    zoneId: number;
}

/** buildnav moves terrain vertices under a river to its surface minus this (Heightmap.cs WATER_SURFACE_DEPTH). */
export const WATER_SURFACE_DEPTH = 16;

export function encodeTerrain(g: TerrainGrid): Uint8Array {
    const n = g.size * g.size;
    if (g.heights.length !== n || g.water.length !== n) throw new Error(`terrain grid of zone ${g.zoneId}: expected ${n} vertices`);
    const buf = new ArrayBuffer(HEADER_BYTES + g.waterHeights.length * 4 + n * 2 + n);
    const v = new DataView(buf);
    v.setUint32(0, MAGIC, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, g.zoneId, true);
    v.setUint16(8, g.regionId, true);
    v.setUint16(10, g.size, true);
    v.setInt32(12, g.xoff, true);
    v.setInt32(16, g.yoff, true);
    v.setInt32(20, g.width, true);
    v.setInt32(24, g.height, true);
    v.setUint16(28, g.waterHeights.length, true);
    let at = HEADER_BYTES;
    for (const h of g.waterHeights) {
        v.setInt32(at, h, true);
        at += 4;
    }
    for (let k = 0; k < n; k++, at += 2) v.setUint16(at, g.heights[k]!, true);
    new Uint8Array(buf, at, n).set(g.water);
    return new Uint8Array(buf);
}

export function decodeTerrain(bytes: Uint8Array): TerrainGrid {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < HEADER_BYTES || v.getUint32(0, true) !== MAGIC) throw new Error('not a terrain grid');
    if (v.getUint16(4, true) !== VERSION) throw new Error(`terrain grid version ${v.getUint16(4, true)}, expected ${VERSION} (rerun: bun run terrain:build)`);
    const size = v.getUint16(10, true);
    const rivers = v.getUint16(28, true);
    const n = size * size;
    if (bytes.byteLength !== HEADER_BYTES + rivers * 4 + n * 3) throw new Error('truncated terrain grid');
    let at = HEADER_BYTES;
    const waterHeights = new Int32Array(rivers);
    for (let i = 0; i < rivers; i++, at += 4) waterHeights[i] = v.getInt32(at, true);
    const heights = new Uint16Array(n);
    for (let k = 0; k < n; k++, at += 2) heights[k] = v.getUint16(at, true);
    const water = bytes.slice(at, at + n);
    return {
        zoneId: v.getUint16(6, true), regionId: v.getUint16(8, true), size,
        xoff: v.getInt32(12, true), yoff: v.getInt32(16, true), width: v.getInt32(20, true), height: v.getInt32(24, true),
        heights, water, waterHeights,
    };
}

/**
 * Terrain at region-global (x, y), interpolated on the triangles buildnav exports: per cell
 * (x,y+1),(x+1,y),(x,y) and (x,y+1),(x+1,y+1),(x+1,y), so the diagonal runs (x+1,y)-(x,y+1).
 * Null outside the grid.
 */
export function sampleTerrain(g: TerrainGrid, x: number, y: number): TerrainSample | null {
    if (!(x >= g.xoff && y >= g.yoff && x <= g.xoff + g.width && y <= g.yoff + g.height)) return null;
    const cell = g.width / g.size;
    const lx = (x - g.xoff) / cell;
    const ly = (y - g.yoff) / cell;
    const i = Math.min(Math.floor(lx), g.size - 1);
    const j = Math.min(Math.floor(ly), g.size - 1);
    const fx = lx - i;
    const fy = ly - j;
    const corners = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]].map(([a, b]) => {
        const k = Math.min(b!, g.size - 1) * g.size + Math.min(a!, g.size - 1);
        const h = g.heights[k]!;
        const w = g.water[k]!;
        const surface = w !== NO_WATER && w < g.waterHeights.length ? g.waterHeights[w]! : null;
        return { h, surface, nav: surface !== null && surface > h ? surface - WATER_SURFACE_DEPTH : h };
    });
    const lower = fx + fy <= 1;
    const tri = (v: number[]) => {
        const [h00, h10, h01, h11] = v as [number, number, number, number];
        return lower
            ? { z: h00 + fx * (h10 - h00) + fy * (h01 - h00), gx: h10 - h00, gy: h01 - h00 }
            : { z: h11 - (1 - fx) * (h11 - h01) - (1 - fy) * (h11 - h10), gx: h11 - h01, gy: h11 - h10 };
    };
    const ground = tri(corners.map(c => c.h));
    const surfaces = corners.flatMap(c => (c.surface === null ? [] : [c.surface]));
    return {
        z: ground.z,
        navZ: tri(corners.map(c => c.nav)).z,
        slope: Math.hypot(ground.gx, ground.gy) / cell,
        waterZ: surfaces.length ? Math.max(...surfaces) : null,
        zoneId: g.zoneId,
    };
}

export const terrainName = (zoneId: number) => `zone${String(zoneId).padStart(3, '0')}.terrain`;

/** Lazily loaded terrain grids of one directory (default: the navmesh dir, or $DAOC_NAVMESH_DIR). */
export class TerrainStore {
    private readonly grids = new Map<number, { grid: TerrainGrid | null; stamp: string }>();

    constructor(readonly dir: string = process.env.DAOC_NAVMESH_DIR ?? DEFAULT_NAVMESH_DIR) {}

    /** True when the directory has any zoneNNN.terrain. */
    available(): boolean {
        return existsSync(this.dir) && readdirSync(this.dir).some(f => /^zone\d{3,}\.terrain$/.test(f));
    }

    /** The grid of a zone, or null without a valid zoneNNN.terrain (rechecked when the file changes). */
    forZone(zoneId: number): TerrainGrid | null {
        const file = join(this.dir, terrainName(zoneId));
        const stamp = fileStamp(file);
        const cached = this.grids.get(zoneId);
        if (cached && cached.stamp === stamp) return cached.grid;
        let grid: TerrainGrid | null = null;
        if (stamp) {
            try {
                grid = decodeTerrain(readFileSync(file));
            } catch {
                grid = null;
            }
        }
        this.grids.set(zoneId, { grid, stamp });
        return grid;
    }

    /** Terrain at (x, y) in a region, or null without a grid there (no .terrain, city, dungeon). */
    at(regionId: number, x: number, y: number): TerrainSample | null {
        const zone = getZoneAt(regionId, x, y);
        const grid = zone ? this.forZone(zone.id) : null;
        return grid ? sampleTerrain(grid, x, y) : null;
    }
}

function fileStamp(file: string): string {
    try {
        if (!existsSync(file)) return '';
        const st = statSync(file);
        return `${st.size}:${st.mtimeMs}`;
    } catch {
        return '';
    }
}

let sharedStore: TerrainStore | null = null;

/** Process-wide store over the default navmesh dir. */
export function getTerrainStore(): TerrainStore {
    if (!sharedStore) sharedStore = new TerrainStore();
    return sharedStore;
}
