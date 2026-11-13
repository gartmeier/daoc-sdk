// Keep walls, buildings and other zone fixtures, for line of sight (sdk/vision.ts).
//
// The terrain heightmap (sdk/terrain.ts) has hills and nothing standing on them. A real client tests its sight lines
// against the fixtures too: a keep's walls and its building hide what is behind them. Each zone's fixtures are in
// server/navmesh/zoneNNN.occluders, written by scripts/build-occluders.ts from the zoneNNN.obj buildnav exports for
// Recast: every fixture's collision mesh (its "collide"/"collidee"/"collision" nodes, else its visible mesh), placed
// in region coordinates. Left out of it:
//   - the terrain, which the .terrain grid has exactly;
//   - the cylinders buildnav puts in place of a fixture with a collision radius (trees above all): they are its own
//     stand-ins, not client geometry, and trees don't block a player's line of sight;
//   - the ladder pads it appends for the navmesh.
// Like the meshes, the files are derived from client assets and gitignored.
//
// A sight line is blocked when the segment between its ends passes through a triangle, either face, more than
// END_MARGIN from either end (so an object standing against or slightly inside a wall still sees out of it on the
// near side only when nothing else is in the way).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getZoneAt } from '../data/zones';
import { DEFAULT_NAVMESH_DIR } from './navmesh';

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** Triangles plus a uniform 2D grid over them: cell -> the triangles whose x/y box touches it. */
export interface Occluders {
    /** 9 floats a triangle: x, y, z of each corner, region coordinates. */
    tris: Float32Array;
    cell: number;
    x0: number;
    y0: number;
    cols: number;
    rows: number;
    /** cellStart[c]..cellStart[c + 1] index cellItems. */
    cellStart: Uint32Array;
    cellItems: Uint32Array;
}

/** Grid cell size: a keep wall segment touches a few cells, a sight line of 2000 crosses ~16. */
export const OCCLUDER_CELL = 256;
/** Hits nearer than this to either end don't block (the end itself touching a wall or a floor). */
export const END_MARGIN = 8;

const MAGIC = 0x3143434f; // 'OCC1'

export const occludersName = (zoneId: number) => `zone${String(zoneId).padStart(3, '0')}.occluders`;

/** OBJ units are 1/32 of a game unit (NavmeshMgr.CONVERSION_FACTOR), written x, height, y (WavefrontObjFile.Save). */
const OBJ_SCALE = 32;

interface ObjGroup {
    name: string;
    verts: number[];
    faces: number[];
}

/** buildnav's terrain: a 33 x 33 vertex patch per subzone on the 256-unit grid (Heightmap.cs). */
function isTerrain(g: ObjGroup): boolean {
    if (g.verts.length !== 33 * 33 * 3) return false;
    for (let i = 0; i < g.verts.length; i += 3) if (g.verts[i]! % 256 !== 0 || g.verts[i + 1]! % 256 !== 0) return false;
    return true;
}

/** The fixture triangles of a buildnav zoneNNN.obj, as `tris` (9 floats each, region coordinates). */
export function fixtureTriangles(objText: string): Float32Array {
    const groups: ObjGroup[] = [];
    let g: ObjGroup | null = null;
    // Faces index the file's vertices from 1, across groups.
    const all: number[] = [];
    for (const line of objText.split('\n')) {
        const c0 = line.charCodeAt(0);
        if (c0 === 103 /* g */) {
            g = { name: line.slice(2).trim(), verts: [], faces: [] };
            groups.push(g);
        } else if (c0 === 118 /* v */ && line.charCodeAt(1) === 32) {
            const p = line.slice(2).trim().split(/\s+/);
            const x = Number(p[0]) * OBJ_SCALE, h = Number(p[1]) * OBJ_SCALE, y = Number(p[2]) * OBJ_SCALE;
            all.push(x, y, h);
            g?.verts.push(x, y, h);
        } else if (c0 === 102 /* f */ && g) {
            const p = line.slice(2).trim().split(/\s+/);
            g.faces.push(Number(p[0]) - 1, Number(p[1]) - 1, Number(p[2]) - 1);
        }
    }
    const out: number[] = [];
    for (const gr of groups) {
        if (gr.name.startsWith('ladder_pad')) continue;
        if (isTerrain(gr)) continue;
        // AddCylinder: 10 corners, 10 triangles.
        if (gr.verts.length === 30 && gr.faces.length === 30) continue;
        for (const i of gr.faces) out.push(all[i * 3]!, all[i * 3 + 1]!, all[i * 3 + 2]!);
    }
    return new Float32Array(out);
}

export function encodeOccluders(tris: Float32Array): Uint8Array {
    const n = Math.floor(tris.length / 9);
    const buf = new ArrayBuffer(8 + n * 36);
    const dv = new DataView(buf);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, n, true);
    new Float32Array(buf, 8, n * 9).set(tris.subarray(0, n * 9));
    return new Uint8Array(buf);
}

export function decodeOccluders(bytes: Uint8Array, cell = OCCLUDER_CELL): Occluders {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('not an occluders file');
    const n = dv.getUint32(4, true);
    if (bytes.byteLength < 8 + n * 36) throw new Error('occluders file cut short');
    const tris = new Float32Array(n * 9);
    for (let i = 0; i < n * 9; i++) tris[i] = dv.getFloat32(8 + i * 4, true);
    return indexOccluders(tris, cell);
}

/** The grid over `tris`. */
export function indexOccluders(tris: Float32Array, cell = OCCLUDER_CELL): Occluders {
    const n = Math.floor(tris.length / 9);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n * 9; i += 3) {
        minX = Math.min(minX, tris[i]!); maxX = Math.max(maxX, tris[i]!);
        minY = Math.min(minY, tris[i + 1]!); maxY = Math.max(maxY, tris[i + 1]!);
    }
    if (n === 0) return { tris, cell, x0: 0, y0: 0, cols: 0, rows: 0, cellStart: new Uint32Array(1), cellItems: new Uint32Array(0) };
    const x0 = Math.floor(minX / cell) * cell, y0 = Math.floor(minY / cell) * cell;
    const cols = Math.floor((maxX - x0) / cell) + 1, rows = Math.floor((maxY - y0) / cell) + 1;
    const span = (t: number) => {
        const b = t * 9;
        const xs = [tris[b]!, tris[b + 3]!, tris[b + 6]!], ys = [tris[b + 1]!, tris[b + 4]!, tris[b + 7]!];
        return [
            Math.floor((Math.min(...xs) - x0) / cell), Math.floor((Math.max(...xs) - x0) / cell),
            Math.floor((Math.min(...ys) - y0) / cell), Math.floor((Math.max(...ys) - y0) / cell),
        ] as const;
    };
    const counts = new Uint32Array(cols * rows + 1);
    for (let t = 0; t < n; t++) {
        const [c0, c1, r0, r1] = span(t);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * cols + c]!++;
    }
    const cellStart = new Uint32Array(cols * rows + 1);
    for (let i = 0; i < cols * rows; i++) cellStart[i + 1] = cellStart[i]! + counts[i]!;
    const fill = cellStart.slice(0, cols * rows);
    const cellItems = new Uint32Array(cellStart[cols * rows]!);
    for (let t = 0; t < n; t++) {
        const [c0, c1, r0, r1] = span(t);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cellItems[fill[r * cols + c]!++] = t;
    }
    return { tris, cell, x0, y0, cols, rows, cellStart, cellItems };
}

/** Where along from->to (0..1) the segment passes through triangle `t`, either face, or -1 (Möller-Trumbore). */
function hitTriangle(tris: Float32Array, t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const b = t * 9;
    const ax = tris[b]!, ay = tris[b + 1]!, az = tris[b + 2]!;
    const e1x = tris[b + 3]! - ax, e1y = tris[b + 4]! - ay, e1z = tris[b + 5]! - az;
    const e2x = tris[b + 6]! - ax, e2y = tris[b + 7]! - ay, e2z = tris[b + 8]! - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-9) return -1;
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return s >= 0 && s <= 1 ? s : -1;
}

/** Scratch marks so a triangle in several cells is tested once per segment. */
let seen = new Uint32Array(0);
let seenStamp = 0;

/**
 * The first triangle the segment from `a` to `b` passes through, more than `margin` from either end, as its index
 * and where (0..1 along the segment), or null when nothing blocks it.
 */
export function firstHit(o: Occluders, a: Vec3, b: Vec3, margin = END_MARGIN): { tri: number; at: number } | null {
    if (o.cols === 0) return null;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len <= 2 * margin) return null;
    const lo = margin / len, hi = 1 - margin / len;
    const n = o.tris.length / 9;
    if (seen.length < n) seen = new Uint32Array(n);
    if (++seenStamp === 0xffffffff) { seen.fill(0); seenStamp = 1; }
    let best: { tri: number; at: number } | null = null;
    const test = (c: number, r: number) => {
        if (c < 0 || r < 0 || c >= o.cols || r >= o.rows) return;
        const k = r * o.cols + c;
        for (let i = o.cellStart[k]!; i < o.cellStart[k + 1]!; i++) {
            const t = o.cellItems[i]!;
            if (seen[t] === seenStamp) continue;
            seen[t] = seenStamp;
            const s = hitTriangle(o.tris, t, a.x, a.y, a.z, dx, dy, dz);
            if (s > lo && s < hi && (!best || s < best.at)) best = { tri: t, at: s };
        }
    };
    // Every cell the 2D segment crosses (Amanatides-Woo).
    const fx = (a.x - o.x0) / o.cell, fy = (a.y - o.y0) / o.cell;
    const tx = (b.x - o.x0) / o.cell, ty = (b.y - o.y0) / o.cell;
    let c = Math.floor(fx), r = Math.floor(fy);
    const cEnd = Math.floor(tx), rEnd = Math.floor(ty);
    const stepC = Math.sign(tx - fx), stepR = Math.sign(ty - fy);
    const ddx = tx - fx, ddy = ty - fy;
    const tDeltaC = stepC !== 0 ? Math.abs(1 / ddx) : Infinity;
    const tDeltaR = stepR !== 0 ? Math.abs(1 / ddy) : Infinity;
    let tMaxC = stepC > 0 ? (c + 1 - fx) / ddx : stepC < 0 ? (fx - c) / -ddx : Infinity;
    let tMaxR = stepR > 0 ? (r + 1 - fy) / ddy : stepR < 0 ? (fy - r) / -ddy : Infinity;
    const steps = Math.abs(cEnd - c) + Math.abs(rEnd - r);
    test(c, r);
    for (let i = 0; i < steps; i++) {
        if (tMaxC < tMaxR) { c += stepC; tMaxC += tDeltaC; }
        else { r += stepR; tMaxR += tDeltaR; }
        test(c, r);
    }
    return best;
}

/** True when a fixture stands between `a` and `b`. */
export function segmentBlocked(o: Occluders, a: Vec3, b: Vec3, margin = END_MARGIN): boolean {
    return firstHit(o, a, b, margin) !== null;
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

/** A zone's occluders are asked of the disk again after this (a stat per sight line would be too slow). */
const RECHECK_MS = 30_000;

/** Lazily loaded occluders of one directory (default: the navmesh dir, or $DAOC_NAVMESH_DIR). */
export class OccluderStore {
    private readonly zones = new Map<number, { occ: Occluders | null; stamp: string; at: number }>();

    constructor(readonly dir: string = process.env.DAOC_NAVMESH_DIR ?? DEFAULT_NAVMESH_DIR) {}

    /** True when the directory has any zoneNNN.occluders. */
    available(): boolean {
        return existsSync(this.dir) && readdirSync(this.dir).some(f => /^zone\d{3,}\.occluders$/.test(f));
    }

    /** The occluders of a zone, or null without a valid file. */
    forZone(zoneId: number): Occluders | null {
        const now = Date.now();
        const held = this.zones.get(zoneId);
        if (held && now - held.at <= RECHECK_MS) return held.occ;
        const file = join(this.dir, occludersName(zoneId));
        const stamp = fileStamp(file);
        if (held && held.stamp === stamp) {
            held.at = now;
            return held.occ;
        }
        let occ: Occluders | null = null;
        if (stamp) {
            try {
                occ = decodeOccluders(readFileSync(file));
            } catch {
                occ = null;
            }
        }
        this.zones.set(zoneId, { occ, stamp, at: now });
        return occ;
    }

    /**
     * Whether a fixture stands between `a` and `b` in a region. Each zone the segment's ends are in is tested (keeps
     * sit inside one zone; a line across a zone border tests both sides' fixtures).
     */
    blocked(regionId: number, a: Vec3, b: Vec3): boolean {
        const za = getZoneAt(regionId, a.x, a.y), zb = getZoneAt(regionId, b.x, b.y);
        for (const z of za && zb && za.id !== zb.id ? [za, zb] : [za ?? zb]) {
            const occ = z ? this.forZone(z.id) : null;
            if (occ && segmentBlocked(occ, a, b)) return true;
        }
        return false;
    }
}

let sharedStore: OccluderStore | null = null;

/** Process-wide store over the default navmesh dir. */
export function getOccluderStore(): OccluderStore {
    return (sharedStore ??= new OccluderStore());
}
