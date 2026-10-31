// Where to hunt, from static spawn data: camps (dense spawns in a level band),
// a home base next to a camp, aggressive mobs to avoid, and routes around them.
// Ported from the Hibernian group's verified scripts (Shannon Estuary, levels 1-6).

import { findNpcSpawns, getZoneAt } from '../../data/index';
import { conLevel } from '../actions-helpers';
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

/**
 * Densest cluster of monster spawns in the level band, weighted by distance from `near`.
 * `aggressiveWeight` (default 1) counts each aggressive spawn as that fraction of a
 * passive one: below 1 prefers camps the pull filter (avoidAggressive) can work.
 */
export function findCamp(regionId: number, near: Point, lo: number, hi: number, opts: { maxDist?: number; avoid?: Point[]; aggressiveWeight?: number; clear?: { radius: number; level: number } } = {}): Camp | null {
    const pool = findNpcSpawns({ regionId, realm: 0, near, radius: opts.maxDist ?? 60_000, limit: 100_000 })
        .filter(s => !(s.flags & 0x10) && s.name === s.name.toLowerCase() && !/new mob/.test(s.name) && s.level >= lo && s.level <= hi);
    // Aggressive spawns at or above `clear.level` that must not stand within `clear.radius` of the camp.
    const clear = opts.clear && opts.clear.radius > 0 ? opts.clear : null;
    const hostile = clear
        ? findNpcSpawns({ regionId, realm: 0, near, radius: (opts.maxDist ?? 60_000) + clear.radius, limit: 200_000 })
            .filter(s => s.aggroLevel > 0 && s.aggroRange > 0 && !(s.flags & 0x10) && s.level >= clear.level)
        : [];
    const w = opts.aggressiveWeight ?? 1;
    const weight = (s: (typeof pool)[number]) => (s.aggroLevel > 0 && s.aggroRange > 0 ? w : 1);
    let best: Camp | null = null, bestScore = 0;
    for (const c of pool) {
        if (dangerNear(regionId, lo + 1, c, 1000)) continue;
        if (opts.avoid?.some(a => Math.hypot(a.x - c.x, a.y - c.y) < 2500)) continue;
        if (clear && hostile.some(h => Math.abs(h.x - c.x) < clear.radius && Math.abs(h.y - c.y) < clear.radius && Math.hypot(h.x - c.x, h.y - c.y) < clear.radius)) continue;
        const around = pool.filter(o => Math.hypot(o.x - c.x, o.y - c.y) < 1500);
        const score = around.reduce((a, o) => a + weight(o), 0) / (1 + Math.hypot(c.x - near.x, c.y - near.y) / 10_000);
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
 * A home base near the camp: open ground (no spawn within `clearance`) away from danger,
 * as close to the camp as possible, on the side we come from. Spots lie 600 to
 * 2600 from the camp (up to 3600 for a larger clearance); when none meets the
 * clearance (and twice it from aggressive spawns near our level) it is
 * relaxed in steps of 200 down to 700.
 *
 * Why clearance matters: a mob that gets hit calls same-faction friends within
 * 450 + 150 per extra attacking group member (1050 for five; StandardMobBrain.BringFriends),
 * but not on a body pull. A body-pulled mob fought at a base this far from other
 * spawns brings no friends.
 */
export function chooseBase(regionId: number, level: number, camp: Point3, from: Point, clearance = 700): Point3 {
    const spawns = findNpcSpawns({ regionId, near: camp, radius: 7000, limit: 4000 });
    const toward = Math.atan2(from.y - camp.y, from.x - camp.x);
    const maxR = 2600 + Math.min(1000, Math.max(0, clearance - 700));
    // Aggressive monsters near our level wander into a base and come at it on their own.
    const aggressive = spawns.filter(s => s.aggroLevel > 0 && s.aggroRange > 0 && !(s.flags & 0x10) && s.level >= level - 1);
    // Every spot once: its distance from the camp, its score, and its distance to the nearest spawn (and aggressive spawn).
    const spots: { p: Point3; r: number; score: number; clear: number; aggClear: number }[] = [];
    for (let r = 600; r <= maxR; r += 250) {
        for (let a = 0; a < 24; a++) {
            const ang = (a / 24) * Math.PI * 2;
            const x = camp.x + Math.cos(ang) * r, y = camp.y + Math.sin(ang) * r;
            if (dangerNear(regionId, level, { x, y }, 600)) continue;
            let clear = Infinity, aggClear = Infinity;
            for (const s of spawns) clear = Math.min(clear, Math.hypot(s.x - x, s.y - y));
            for (const s of aggressive) aggClear = Math.min(aggClear, Math.hypot(s.x - x, s.y - y));
            const off = Math.abs(Math.atan2(Math.sin(ang - toward), Math.cos(ang - toward)));
            spots.push({ p: { x: Math.round(x), y: Math.round(y), z: camp.z }, r, score: r + off * 300, clear, aggClear });
        }
    }
    for (let need = Math.max(700, clearance); ; need = Math.max(700, need - 200)) {
        // The default clearance keeps the original 2600 reach; aggressive spawns get twice the room above it.
        const ok = spots.filter(s => s.clear >= need && (need > 700 || s.r <= 2600) && (need <= 700 || s.aggClear >= 2 * need));
        if (ok.length) return ok.reduce((a, b) => (b.score < a.score ? b : a)).p;
        if (need <= 700) return { x: camp.x, y: camp.y, z: camp.z };
    }
}

/** How far beyond its aggro range an aggressive mob can reach us: mobs wander around their spawn point. */
export const AGGRO_PAD = 300;

const zoneCache = new Map<string, Danger[]>();

/**
 * Where aggressive mobs would attack a player of `level`: every aggressive spawn that
 * doesn't con grey to that level (a mob only aggroes on players it is green or more
 * to: StandardMobBrain.CanAggroTarget, IsObjectGreyCon), out to its aggro range
 * (StandardMobBrain.CheckPlayerAggro, players within AggroRange) plus `pad`.
 */
export function aggroZones(regionId: number, level: number, pad = AGGRO_PAD): Danger[] {
    const key = `${regionId}:${level}:${pad}`;
    const hit = zoneCache.get(key);
    if (hit) return hit;
    const out = findNpcSpawns({ regionId, realm: 0, limit: 200_000 })
        .filter(s => s.aggroLevel > 0 && s.aggroRange > 0 && !(s.flags & 0x10) && conLevel(level, s.level) > -3)
        .map(s => ({ x: s.x, y: s.y, r: s.aggroRange + pad, name: s.name, level: s.level }));
    zoneCache.set(key, out);
    return out;
}

/** Circles bucketed on a coarse grid, for fast "is this point inside any" checks. */
class CircleIndex {
    private readonly buckets = new Map<number, Danger[]>();
    constructor(circles: Danger[], private readonly size = 1000) {
        for (const c of circles) {
            for (let gx = Math.floor((c.x - c.r) / size); gx <= Math.floor((c.x + c.r) / size); gx++) {
                for (let gy = Math.floor((c.y - c.r) / size); gy <= Math.floor((c.y + c.r) / size); gy++) {
                    const k = gx * 65_536 + gy;
                    const list = this.buckets.get(k);
                    if (list) list.push(c); else this.buckets.set(k, [c]);
                }
            }
        }
    }
    inside(x: number, y: number): boolean {
        const list = this.buckets.get(Math.floor(x / this.size) * 65_536 + Math.floor(y / this.size));
        return !!list && list.some(c => Math.hypot(c.x - x, c.y - y) < c.r);
    }
}

const indexCache = new Map<string, CircleIndex>();

/** Everything a route keeps out of: aggro zones (aggroZones) and danger circles (dangers). */
function avoidIndex(regionId: number, level: number): CircleIndex {
    const key = `${regionId}:${level}`;
    let idx = indexCache.get(key);
    if (!idx) indexCache.set(key, idx = new CircleIndex([...aggroZones(regionId, level), ...dangers(regionId, level)]));
    return idx;
}

/** Extra cost per unit walked inside an aggro zone: a route crosses one only when going around is 30x longer. */
const INSIDE_COST = 30;

/**
 * Waypoints from `from` to `to` around every mob that would attack a group of `level`
 * (aggroZones, plus the wider danger circles): just [to] when the straight line is clear.
 * Coarse grid A* (400-unit cells) where a cell inside a zone costs INSIDE_COST times more,
 * so a route always exists and crosses zones only where there is no way around.
 */
export function safePath(regionId: number, level: number, from: Point, to: Point): Point[] {
    const idx = avoidIndex(regionId, level);
    const clear = (a: Point, b: Point) => {
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 100);
        for (let i = 1; i < n; i++) if (idx.inside(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n)) return false;
        return true;
    };
    if (clear(from, to)) return [to];
    const cell = 400, pad = 12_000;
    const x0 = Math.min(from.x, to.x) - pad, y0 = Math.min(from.y, to.y) - pad;
    const w = Math.ceil((Math.abs(to.x - from.x) + 2 * pad) / cell), h = Math.ceil((Math.abs(to.y - from.y) + 2 * pad) / cell);
    const at = (i: number, j: number) => j * w + i;
    const cx = (i: number) => x0 + i * cell, cy = (j: number) => y0 + j * cell;
    const si = Math.round((from.x - x0) / cell), sj = Math.round((from.y - y0) / cell);
    const ti = Math.round((to.x - x0) / cell), tj = Math.round((to.y - y0) / cell);
    const start = at(si, sj), goal = at(ti, tj);
    const penalty = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) penalty[at(i, j)] = idx.inside(cx(i), cy(j)) ? INSIDE_COST : 0;
    const g = new Float64Array(w * h).fill(Infinity), prev = new Int32Array(w * h).fill(-1);
    const done = new Uint8Array(w * h);
    const hfn = (k: number) => Math.hypot((k % w) - ti, Math.floor(k / w) - tj);
    // Binary heap of [f, cell].
    const heap: [number, number][] = [];
    const push = (f: number, k: number) => {
        heap.push([f, k]);
        for (let i = heap.length - 1; i > 0;) {
            const up = (i - 1) >> 1;
            if (heap[up]![0] <= heap[i]![0]) break;
            [heap[up], heap[i]] = [heap[i]!, heap[up]!];
            i = up;
        }
    };
    const pop = (): number => {
        const top = heap[0]![1];
        const last = heap.pop()!;
        if (heap.length) {
            heap[0] = last;
            for (let i = 0; ;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
                if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
                if (m === i) break;
                [heap[m], heap[i]] = [heap[i]!, heap[m]!];
                i = m;
            }
        }
        return top;
    };
    g[start] = 0;
    push(hfn(start), start);
    while (heap.length) {
        const cur = pop();
        if (done[cur]) continue;
        done[cur] = 1;
        if (cur === goal) break;
        const ci = cur % w, cj = Math.floor(cur / w);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            if (!di && !dj) continue;
            const ni = ci + di, nj = cj + dj;
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            const nk = at(ni, nj);
            if (done[nk]) continue;
            const ng = g[cur]! + Math.hypot(di, dj) * (1 + penalty[nk]!);
            if (ng < g[nk]!) { g[nk] = ng; prev[nk] = cur; push(ng + hfn(nk), nk); }
        }
    }
    if (prev[goal] === -1) return [to];
    const cells: Point[] = [];
    for (let k = goal; k !== -1 && k !== start; k = prev[k]!) cells.unshift({ x: cx(k % w), y: cy(Math.floor(k / w)) });
    const out: Point[] = [];
    let a = from;
    for (let i = 0; i < cells.length; i++) {
        const next = cells[i + 1];
        if (!next || !clear(a, next)) { out.push(cells[i]!); a = cells[i]!; }
    }
    if (!out.length) return [to];
    out[out.length - 1] = to;
    return out;
}
