// Water and slope round a battleground's pair rings, the routes to them, and where the reports' fights were.
//
//   bun sdk/group/survey.ts [--png=<file>] [--since=20261109]
//
// Prints, per pair (BattlegroundLayout.pairs): how far the ring stays from water, how much of it is not level (slope.ts),
// how many of its points are near camps or keep circles, and per realm the route from its arrival to its first waypoint
// (length, swum, dry ground over 35° and over 45°). Then every RvR fight in groups/*/runs/<since...>.json with its wet share and the
// slope where it began. --png draws Thidranki at 64 units a pixel: water blue, slopes over 35° orange and over 45° red,
// camps purple, keep circles black, rings yellow, waypoints and routes in the realms' colours, fights as crosses
// (magenta at 30 % wet fight time or more). Reads only files; needs the client's terrain (bun run terrain:build).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { getZonesInRegion } from '../../data/zones';
import { BATTLEGROUND_LAYOUTS, clearOf, homeOf, keepDangers, THIDRANKI, type PlayerRealm } from './keeps';
import { defaultPatrol } from './rvr';
import { CLIFF, isLevel, slopeAlong, slopeAt, STEEP } from './slope';
import { aggroZones, safePath } from './terrain';
import type { Point } from './types';
import { isWet } from './water';

const ROOT = join(import.meta.dir, '..', '..');
const T = THIDRANKI;
const LEVEL = 24;
const RING = 4000;
const REALMS: PlayerRealm[] = ['albion', 'hibernia', 'midgard'];

/** The nearest water within `max` of `p` (rings 100 apart, 48 spots each), else `max`. */
function waterWithin(p: Point, max = 6000): number {
    for (let r = 0; r <= max; r += 100) for (let k = 0; k < 48; k++) if (isWet(T, { x: p.x + Math.cos(k * Math.PI / 24) * r, y: p.y + Math.sin(k * Math.PI / 24) * r })) return r;
    return max;
}

function swum(route: Point[]): number {
    let wet = 0;
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]!, b = route[i]!, d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.ceil(d / 50);
        for (let k = 0; k < n; k++) if (isWet(T, { x: a.x + (b.x - a.x) * (k + 0.5) / n, y: a.y + (b.y - a.y) * (k + 0.5) / n })) wet += d / n;
    }
    return Math.round(wet);
}

interface Fight { group: string; file: string; x: number; y: number; wet: number; enemyWet: number; s: number; realms: string }

function fights(since: string): Fight[] {
    const out: Fight[] = [];
    for (const g of readdirSync(join(ROOT, 'groups'))) {
        const dir = join(ROOT, 'groups', g, 'runs');
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter(f => /^\d{8}-\d{6}\.json$/.test(f) && f >= since)) {
            let j: any;
            try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
            if (!/rvr|pack/.test(j.strategy ?? '')) continue;
            for (const fi of j.fights ?? []) {
                if (!fi.where || !fi.enemyPlayers) continue;
                out.push({ group: g, file: f, x: fi.where.x, y: fi.where.y, wet: fi.wetPct ?? 0, enemyWet: fi.enemyWetPct ?? 0, s: Math.round(fi.durationMs / 1000), realms: (fi.enemyRealms ?? []).join('+') });
            }
        }
    }
    return out;
}

function png(w: number, h: number, rgb: Uint8Array): Uint8Array {
    const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Uint8Array) => {
        const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
        v.setUint32(0, data.length);
        out.set(new TextEncoder().encode(type), 4);
        out.set(data, 8);
        v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
        return out;
    };
    const raw = new Uint8Array(h * (w * 3 + 1));
    for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
    const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
    v.setUint32(0, w);
    v.setUint32(4, h);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

function draw(file: string, routes: Map<PlayerRealm, Point[][]>, loops: Map<PlayerRealm, Point[][]>, fs: Fight[]): void {
    const zone = getZonesInRegion(T)[0]!;
    const X0 = zone.xOffset, Y0 = zone.yOffset, W = 1024, PX = zone.width / W;
    const img = new Uint8Array(W * W * 3);
    const set = (i: number, j: number, c: readonly number[]) => { if (i >= 0 && j >= 0 && i < W && j < W) img.set(c, (j * W + i) * 3); };
    const px = (p: Point) => [Math.round((p.x - X0) / PX), Math.round((p.y - Y0) / PX)] as const;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        const p = { x: X0 + (i + 0.5) * PX, y: Y0 + (j + 0.5) * PX }, s = slopeAt(T, p);
        set(i, j, isWet(T, p) ? [40, 90, 200] : s > CLIFF ? [200, 40, 40] : s > STEEP ? [220, 140, 60] : [130, 175, 120]);
    }
    const circle = (p: Point, r: number, c: readonly number[], fill = false) => {
        const [ci, cj] = px(p), rp = r / PX;
        for (let a = 0; a < 720; a++) set(Math.round(ci + Math.cos(a * Math.PI / 360) * rp), Math.round(cj + Math.sin(a * Math.PI / 360) * rp), c);
        if (fill) for (let di = -rp; di <= rp; di++) for (let dj = -rp; dj <= rp; dj++) if (di * di + dj * dj <= rp * rp) set(Math.round(ci + di), Math.round(cj + dj), c);
    };
    const line = (a: Point, b: Point, c: readonly number[]) => {
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 40);
        for (let t = 0; t <= n; t++) { const [i, j] = px({ x: a.x + (b.x - a.x) * t / n, y: a.y + (b.y - a.y) * t / n }); set(i, j, c); set(i + 1, j, c); }
    };
    const colour: Record<PlayerRealm, number[]> = { albion: [220, 30, 30], hibernia: [20, 140, 40], midgard: [30, 60, 230] };
    for (const z of aggroZones(T, LEVEL)) circle(z, z.r, [150, 60, 170]);
    for (const k of BATTLEGROUND_LAYOUTS[T]!.keeps) { circle(k, k.portal ? 4500 : 3000, [0, 0, 0]); circle(k, 300, [0, 0, 0], true); }
    for (const spot of Object.values(BATTLEGROUND_LAYOUTS[T]!.pairs ?? {})) { circle(spot, RING, [255, 255, 0]); circle(spot, 250, [255, 255, 0], true); }
    for (const [realm, rs] of routes) for (const r of rs) for (let i = 1; i < r.length; i++) line(r[i - 1]!, r[i]!, colour[realm]);
    for (const [realm, ls] of loops) for (const l of ls) for (const w of l) circle(w, 180, colour[realm], true);
    for (const f of fs) {
        const [i, j] = px(f), c = f.wet >= 30 ? [255, 0, 255] : [255, 255, 255];
        for (let d = -4; d <= 4; d++) { set(i + d, j + d, c); set(i + d, j - d, c); }
    }
    writeFileSync(file, png(W, W, img));
}

if (import.meta.main) {
    const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const since = flag('since') ?? '20261109';
    const bg = BATTLEGROUND_LAYOUTS[T]!;
    const zones = aggroZones(T, LEVEL);
    const routes = new Map<PlayerRealm, Point[][]>(), loops = new Map<PlayerRealm, Point[][]>();
    for (const [key, spot] of Object.entries(bg.pairs ?? {})) {
        const [a, b] = key.split('|') as [PlayerRealm, PlayerRealm];
        const ring = Array.from({ length: 36 }, (_, k) => ({ x: spot.x + Math.cos(k * Math.PI / 18) * RING, y: spot.y + Math.sin(k * Math.PI / 18) * RING }));
        const water = ring.map(p => waterWithin(p)).sort((p, q) => p - q);
        const keeps = [...keepDangers(T, a), ...keepDangers(T, b)];
        console.log(`${key} (${spot.x}, ${spot.y}): water ${water[0]} from the ring (median ${water[18]}), ${ring.filter(p => !isLevel(T, p)).length}/36 not level, ${ring.filter(p => !clearOf(p, [...zones, ...keeps], 900)).length}/36 within 900 of a camp or keep circle`);
        for (const [realm, opponent] of [[a, b], [b, a]] as const) {
            const home = homeOf(T, realm)!.arrival, loop = defaultPatrol(T, realm, LEVEL, { opponent });
            const route = [home, ...safePath(T, LEVEL, home, loop[0]!, keepDangers(T, realm))];
            const len = route.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - route[i]!.x, p.y - route[i]!.y), 0);
            const sl = route.slice(1).map((p, i) => slopeAlong(T, route[i]!, p, 64, q => isWet(T, q)));
            console.log(`  ${realm}: ${loop.length} waypoints, route ${Math.round(len)} (straight ${Math.round(Math.hypot(home.x - spot.x, home.y - spot.y))} to the spot), swum ${swum(route)}, over 35° ${Math.round(sl.reduce((s, x) => s + x.steep, 0))}, over 45° ${Math.round(sl.reduce((s, x) => s + x.cliff, 0))}`);
            routes.set(realm, [...(routes.get(realm) ?? []), route]);
            loops.set(realm, [...(loops.get(realm) ?? []), loop]);
        }
    }
    const fs = fights(since);
    console.log(`\n${fs.length} fights with enemy players in RvR reports since ${since}:`);
    for (const f of fs) console.log(`  ${f.group.padEnd(9)} ${f.file} ${f.realms.padEnd(16)} (${f.x}, ${f.y}) ${f.s} s, wet us ${f.wet}% them ${f.enemyWet}%, slope ${slopeAt(T, f).toFixed(2)}${isWet(T, f) ? ', in water' : ''}`);
    const file = flag('png');
    if (file) { draw(file, routes, loops, fs); console.log(`\nmap: ${file}`); }
}
