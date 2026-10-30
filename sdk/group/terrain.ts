// Where to hunt, from static spawn data: camps (dense spawns in a level band),
// a home base next to a camp, aggressive mobs to avoid, and routes around them.
// Ported from the Hibernian group's verified scripts (Shannon Estuary, levels 1-6).

import { findNpcSpawns, getZoneAt } from '../../data/index';
import type { Point, Point3 } from './types';

export interface Danger { x: number; y: number; r: number; name: string; level: number }

export interface Camp extends Point3 {
    zone: string;
    /** Spawns within 1500 of the centre. */
    count: number;
    /** "name level, ..." of what spawns there. */
    names: string;
}

const dangerCache = new Map<string, Danger[]>();

/** Aggressive spawns that would hurt a group of `level`: 3+ levels above it, or packs of 4+ (level ≥ L) within 1500. */
export function dangers(regionId: number, level: number): Danger[] {
    const key = `${regionId}:${level}`;
    const hit = dangerCache.get(key);
    if (hit) return hit;
    const agg = findNpcSpawns({ regionId, realm: 0, limit: 200_000 })
        .filter(s => s.aggroLevel > 0 && s.aggroRange > 0 && !(s.flags & 0x10) && s.level >= level);
    const out: Danger[] = [];
    for (const s of agg) {
        const strong = s.level >= level + 3;
        const pack = !strong && agg.filter(o => Math.abs(o.x - s.x) < 1500 && Math.abs(o.y - s.y) < 1500).length >= 4;
        if (strong || pack) out.push({ x: s.x, y: s.y, r: Math.max(500, s.aggroRange) + 500, name: s.name, level: s.level });
    }
    dangerCache.set(key, out);
    return out;
}

export function dangerNear(regionId: number, level: number, p: Point, pad = 0): Danger | null {
    for (const d of dangers(regionId, level)) if (Math.hypot(d.x - p.x, d.y - p.y) < d.r + pad) return d;
    return null;
}

type AggroSpawn = { x: number; y: number; level: number; range: number };
const aggroCache = new Map<number, Map<string, AggroSpawn[]>>();

/** Every spawn by name in a region, with its aggro (level 0 = passive). */
function spawnsByName(regionId: number): Map<string, AggroSpawn[]> {
    let m = aggroCache.get(regionId);
    if (m) return m;
    m = new Map();
    for (const s of findNpcSpawns({ regionId, realm: 0, limit: 200_000 })) {
        const list = m.get(s.name) ?? [];
        list.push({ x: s.x, y: s.y, level: s.aggroRange > 0 ? s.aggroLevel : 0, range: s.aggroRange });
        m.set(s.name, list);
    }
    aggroCache.set(regionId, m);
    return m;
}

/**
 * Aggro of a live monster (live data does not say whether a mob is aggressive):
 * that of the nearest spawn with its name within 2500, since the same name can be
 * passive in one camp and aggressive in another. Null when it is passive or unknown.
 */
export function aggroAt(regionId: number, name: string, p: Point): { level: number; range: number } | null {
    let best: AggroSpawn | null = null, bestD = 2500;
    for (const s of spawnsByName(regionId).get(name) ?? []) {
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bestD) { bestD = d; best = s; }
    }
    return best && best.level > 0 ? { level: best.level, range: best.range } : null;
}

/** Densest cluster of monster spawns in the level band, weighted by distance from `near`. */
export function findCamp(regionId: number, near: Point, lo: number, hi: number, opts: { maxDist?: number; avoid?: Point[] } = {}): Camp | null {
    const pool = findNpcSpawns({ regionId, realm: 0, near, radius: opts.maxDist ?? 60_000, limit: 100_000 })
        .filter(s => !(s.flags & 0x10) && s.name === s.name.toLowerCase() && !/new mob/.test(s.name) && s.level >= lo && s.level <= hi);
    let best: Camp | null = null, bestScore = 0;
    for (const c of pool) {
        if (dangerNear(regionId, lo + 1, c, 1000)) continue;
        if (opts.avoid?.some(a => Math.hypot(a.x - c.x, a.y - c.y) < 2500)) continue;
        const around = pool.filter(o => Math.hypot(o.x - c.x, o.y - c.y) < 1500);
        const score = around.length / (1 + Math.hypot(c.x - near.x, c.y - near.y) / 10_000);
        if (score <= bestScore) continue;
        bestScore = score;
        const avg = (f: (o: typeof c) => number) => Math.round(around.reduce((a, o) => a + f(o), 0) / around.length);
        const x = avg(o => o.x), y = avg(o => o.y);
        best = {
            x, y, z: avg(o => o.z), zone: getZoneAt(regionId, x, y)?.name ?? '?', count: around.length,
            names: [...new Set(around.map(o => `${o.name} ${o.level}`))].slice(0, 6).join(', '),
        };
    }
    return best;
}

/**
 * A home base near the camp: open ground (no spawn within 700) away from danger,
 * as close to the camp as possible, on the side we come from.
 */
export function chooseBase(regionId: number, level: number, camp: Point3, from: Point): Point3 {
    const spawns = findNpcSpawns({ regionId, near: camp, radius: 5000, limit: 2000 });
    const toward = Math.atan2(from.y - camp.y, from.x - camp.x);
    let best: Point3 | null = null, bestScore = Infinity;
    for (let r = 600; r <= 2600; r += 250) {
        for (let a = 0; a < 24; a++) {
            const ang = (a / 24) * Math.PI * 2;
            const x = camp.x + Math.cos(ang) * r, y = camp.y + Math.sin(ang) * r;
            if (dangerNear(regionId, level, { x, y }, 600)) continue;
            if (spawns.some(s => Math.hypot(s.x - x, s.y - y) < 700)) continue;
            const off = Math.abs(Math.atan2(Math.sin(ang - toward), Math.cos(ang - toward)));
            const score = r + off * 300;
            if (score < bestScore) { bestScore = score; best = { x: Math.round(x), y: Math.round(y), z: camp.z }; }
        }
    }
    return best ?? { x: camp.x, y: camp.y, z: camp.z };
}

/** Waypoints from `from` to `to` around danger circles (just [to] when the line is clear). Coarse grid A*. */
export function safePath(regionId: number, level: number, from: Point, to: Point): Point[] {
    const ds = dangers(regionId, level);
    const blocked = (x: number, y: number) => ds.some(d => Math.hypot(d.x - x, d.y - y) < d.r);
    const clear = (a: Point, b: Point) => {
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 200);
        for (let i = 1; i <= n; i++) if (blocked(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n)) return false;
        return true;
    };
    if (clear(from, to)) return [to];
    const cell = 400, pad = 12_000;
    const x0 = Math.min(from.x, to.x) - pad, y0 = Math.min(from.y, to.y) - pad;
    const w = Math.ceil((Math.abs(to.x - from.x) + 2 * pad) / cell), h = Math.ceil((Math.abs(to.y - from.y) + 2 * pad) / cell);
    const idx = (i: number, j: number) => j * w + i;
    const cx = (i: number) => x0 + i * cell, cy = (j: number) => y0 + j * cell;
    const si = Math.round((from.x - x0) / cell), sj = Math.round((from.y - y0) / cell);
    const ti = Math.round((to.x - x0) / cell), tj = Math.round((to.y - y0) / cell);
    const g = new Float64Array(w * h).fill(Infinity), prev = new Int32Array(w * h).fill(-1);
    const block = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) block[idx(i, j)] = blocked(cx(i), cy(j)) ? 1 : 0;
    block[idx(si, sj)] = 0;
    block[idx(ti, tj)] = 0;
    const open = new Set<number>([idx(si, sj)]);
    g[idx(si, sj)] = 0;
    const hfn = (k: number) => Math.hypot((k % w) - ti, Math.floor(k / w) - tj);
    while (open.size) {
        let cur = -1, bestF = Infinity;
        for (const k of open) { const f = g[k]! + hfn(k); if (f < bestF) { bestF = f; cur = k; } }
        open.delete(cur);
        if (cur === idx(ti, tj)) break;
        const ci = cur % w, cj = Math.floor(cur / w);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            if (!di && !dj) continue;
            const ni = ci + di, nj = cj + dj;
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            const nk = idx(ni, nj);
            if (block[nk]) continue;
            const ng = g[cur]! + Math.hypot(di, dj);
            if (ng < g[nk]!) { g[nk] = ng; prev[nk] = cur; open.add(nk); }
        }
    }
    if (prev[idx(ti, tj)] === -1) return [to];
    const cells: Point[] = [];
    for (let k = idx(ti, tj); k !== -1 && k !== idx(si, sj); k = prev[k]!) cells.unshift({ x: cx(k % w), y: cy(Math.floor(k / w)) });
    const out: Point[] = [];
    let a = from;
    for (let i = 0; i < cells.length; i++) {
        const next = cells[i + 1];
        if (!next || !clear(a, next)) { out.push(cells[i]!); a = cells[i]!; }
    }
    out[out.length - 1] = to;
    return out;
}
