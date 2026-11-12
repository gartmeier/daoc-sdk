// A small squad that keeps leaving and coming back (field run B, 2026-11-12 07:36-07:40 UTC): Albion's group hunted
// Hibernia's duo, the duo stepped out of sight, Albion turned back to its patrol, the duo came back, every 10 s for
// minutes. The user: "making a larger detour. Maybe project where the duo was going to and then catch them off guard."
//
// Everything here comes from what our members saw of it, its positions on the board over time (Contact.x/y/lastSeen):
// never its orders, waypoints or anything outside our sight.
//   - Lost once after a hunt: follow its trail, to where its last walk projects, a while. Never into a keep.
//   - Lost again (it came back once): it walks a way in. Lie in wait beside that way, ahead of where it came back
//     into sight, off its line and, where the terrain allows, behind a rise from it (vision.ts lineOfSight). While
//     it comes on toward a pass within AMBUSH_PASS of us, hold instead of walking out at it.

import { lineOfSight, terrainGround, type GroundAt } from '../../vision';
import type { Contact, Point } from '../types';

/** Positions kept per enemy player, at most this long back. */
export const TRACK_KEEP_MS = 120_000;
/** A gap this long in its positions starts a new appearance (it was out of sight). */
export const TRACK_GAP_MS = 5000;
/** Velocity over its last this long of positions. */
export const VELOCITY_MS = 6000;
/** A hunt that saw it this long before nothing is in sight lost it. */
export const LOST_WITHIN_MS = 6000;
/** The same squad (an id in common) lost again within this counts its losses on. */
export const QUARRY_MEMORY_MS = 300_000;
/** After the first loss: follow its projected walk this long. */
export const TRAIL_MS = 20_000;
/** ... aiming this many seconds of its walk past where it would be now, at most TRAIL_MAX ahead of its last sighting. */
export const TRAIL_AHEAD_S = 8;
export const TRAIL_MAX = 4000;
/** From this many losses: lie in wait. */
export const AMBUSH_AFTER = 2;
/** How long to wait at the spot (walking there counts too). */
export const AMBUSH_WAIT_MS = 150_000;
/** Hold at the spot while it comes on toward a pass within this of our centre, within PASS_WITHIN_S. */
export const AMBUSH_PASS = 1800;
export const PASS_WITHIN_S = 40;
/** A quarry: at most this many players. */
export const QUARRY_MAX = 3;
/** Slower than this (units/s) is standing, not walking anywhere. */
const WALKING = 60;

export interface TrackPoint { x: number; y: number; t: number }
export type Tracks = Record<number, TrackPoint[]>;

/** Add each enemy player's latest sighting (not stale) to its track; drop what is older than TRACK_KEEP_MS. */
export function noteTracks(tracks: Tracks, enemies: readonly Contact[], now: number): void {
    for (const c of enemies) {
        if (c.stale || c.kind !== 'player') continue;
        const pts = (tracks[c.objectId] ??= []);
        const last = pts.at(-1);
        if (!last || c.lastSeen > last.t) pts.push({ x: c.x, y: c.y, t: c.lastSeen });
    }
    for (const k of Object.keys(tracks)) {
        const pts = tracks[Number(k)]!.filter(p => now - p.t <= TRACK_KEEP_MS);
        if (pts.length) tracks[Number(k)] = pts.slice(-200);
        else delete tracks[Number(k)];
    }
}

/** The points of its latest appearance: those after the last gap of TRACK_GAP_MS. */
export function lastAppearance(pts: readonly TrackPoint[]): TrackPoint[] {
    let i = pts.length - 1;
    while (i > 0 && pts[i]!.t - pts[i - 1]!.t < TRACK_GAP_MS) i--;
    return pts.slice(i);
}

/** Units per second from the first point within `ms` of the last to the last; null with under 1.5 s of points. */
export function velocity(pts: readonly TrackPoint[], ms = VELOCITY_MS): Point | null {
    const last = pts.at(-1);
    if (!last) return null;
    const first = pts.find(p => last.t - p.t <= ms)!;
    const dt = (last.t - first.t) / 1000;
    if (dt < 1.5) return null;
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

/** Where it came back into sight and which way it walked then (its first VELOCITY_MS of the appearance); null if it stood. */
export function entryOf(pts: readonly TrackPoint[]): { at: Point; dir: Point } | null {
    const app = lastAppearance(pts);
    const start = app[0];
    if (!start) return null;
    const v = velocity(app.filter(p => p.t - start.t <= VELOCITY_MS));
    const speed = v ? Math.hypot(v.x, v.y) : 0;
    if (!v || speed < WALKING) return null;
    return { at: { x: start.x, y: start.y }, dir: { x: v.x / speed, y: v.y / speed } };
}

export interface Quarry {
    ids: number[];
    regionId: number;
    /** When it was last lost, and where it was then. */
    lostAt: number;
    at: Point;
    /** Its walk when lost, units/s. */
    vel: Point | null;
    losses: number;
    /** Its latest way in: where it came back into sight, and which way it walked. */
    entry: { at: Point; dir: Point } | null;
    /** The ambush spot, chosen once per loss; null when no candidate is a place to stand. */
    spot?: (Point & { hidden: number }) | null;
}

/** A squad worth remembering: one to three enemy players of one realm. */
export const quarryLike = (cs: readonly Contact[]) => cs.length > 0 && cs.length <= QUARRY_MAX && new Set(cs.map(c => c.realm)).size === 1;

/**
 * It was hunted and nothing is in sight now: the quarry, with its losses counted on when it shares an id with the one
 * before within QUARRY_MEMORY_MS. Its position and walk from the tracks.
 */
export function loseQuarry(prev: Quarry | undefined, ids: readonly number[], regionId: number, tracks: Tracks, now: number): Quarry | null {
    const pts = ids.map(id => tracks[id]).filter((p): p is TrackPoint[] => !!p?.length);
    if (!pts.length) return null;
    const lasts = pts.map(p => p.at(-1)!);
    const at = { x: lasts.reduce((a, p) => a + p.x, 0) / lasts.length, y: lasts.reduce((a, p) => a + p.y, 0) / lasts.length };
    const vs = pts.map(p => velocity(lastAppearance(p))).filter((v): v is Point => !!v);
    const vel = vs.length ? { x: vs.reduce((a, v) => a + v.x, 0) / vs.length, y: vs.reduce((a, v) => a + v.y, 0) / vs.length } : null;
    const entry = pts.map(entryOf).find(e => !!e) ?? null;
    const same = !!prev && prev.regionId === regionId && now - prev.lostAt <= QUARRY_MEMORY_MS && prev.ids.some(id => ids.includes(id));
    return { ids: [...new Set([...(same ? prev!.ids : []), ...ids])], regionId, lostAt: now, at, vel, losses: same ? prev!.losses + 1 : 1, entry };
}

/** Where its last walk projects at `now`, TRAIL_AHEAD_S on, at most TRAIL_MAX from where it was lost. */
export function trailGoal(q: Quarry, now: number): Point | null {
    if (!q.vel || Math.hypot(q.vel.x, q.vel.y) < WALKING) return null;
    const s = (now - q.lostAt) / 1000 + TRAIL_AHEAD_S;
    const dx = q.vel.x * s, dy = q.vel.y * s, d = Math.hypot(dx, dy);
    const k = d > TRAIL_MAX ? TRAIL_MAX / d : 1;
    return { x: q.at.x + dx * k, y: q.at.y + dy * k };
}

/**
 * The spot to wait at beside its way in: AHEAD along it from where it came back into sight, LATERAL off it, on either
 * side. Each candidate scores the share of its way (from 1500 before the entry to 300 short of the spot's mark) from which
 * the terrain hides it (lineOfSight; without terrain nothing hides, 0), then the nearer to `from`. `ok`: a place we may
 * stand (dry, clear of keeps).
 */
export function ambushSpot(regionId: number, entry: { at: Point; dir: Point }, from: Point, ok: (p: Point) => boolean, zAt: (p: Point) => number, ground: GroundAt = terrainGround): (Point & { hidden: number }) | null {
    const { at, dir } = entry;
    const perp = { x: -dir.y, y: dir.x };
    let best: (Point & { hidden: number; d: number }) | null = null;
    for (const ahead of [1000, 1500, 2000]) {
        const way: Point[] = [];
        for (let k = -1500; k <= ahead - 300; k += 300) way.push({ x: at.x + dir.x * k, y: at.y + dir.y * k });
        for (const lateral of [1000, 1400, 1800]) for (const side of [1, -1]) {
            const p = { x: Math.round(at.x + dir.x * ahead + perp.x * side * lateral), y: Math.round(at.y + dir.y * ahead + perp.y * side * lateral) };
            if (!ok(p)) continue;
            const pz = zAt(p);
            const hid = way.filter(w => !lineOfSight(regionId, { x: w.x, y: w.y, z: zAt(w) }, { x: p.x, y: p.y, z: pz }, ground)).length / way.length;
            const d = Math.hypot(p.x - from.x, p.y - from.y);
            if (!best || hid > best.hidden + 0.05 || (Math.abs(hid - best.hidden) <= 0.05 && d < best.d)) best = { ...p, hidden: hid, d };
        }
    }
    return best ? { x: best.x, y: best.y, hidden: Math.round(best.hidden * 100) / 100 } : null;
}

/**
 * Lying in wait (the quarry lost AMBUSH_AFTER times, its spot chosen, our centre within `reached` of it, the wait not
 * over), with only quarry players in sight: their pass by us, when they come on toward one within AMBUSH_PASS in
 * PASS_WITHIN_S. Hold then, instead of walking out at them. Null otherwise.
 */
export function lieInWait(q: Quarry | undefined, inSight: readonly Contact[], centre: Point, tracks: Tracks, now: number, reached: number): { d: number; inS: number } | null {
    if (!q?.spot || q.losses < AMBUSH_AFTER || now - q.lostAt > AMBUSH_WAIT_MS || !inSight.length) return null;
    if (Math.hypot(centre.x - q.spot.x, centre.y - q.spot.y) > reached || !inSight.every(c => q.ids.includes(c.objectId))) return null;
    const vs = inSight.map(c => velocity(lastAppearance(tracks[c.objectId] ?? []))).filter((v): v is Point => !!v);
    if (!vs.length) return null;
    const vel = { x: vs.reduce((a, v) => a + v.x, 0) / vs.length, y: vs.reduce((a, v) => a + v.y, 0) / vs.length };
    const them = { x: inSight.reduce((a, c) => a + c.x, 0) / inSight.length, y: inSight.reduce((a, c) => a + c.y, 0) / inSight.length };
    const pass = closestPass(them, vel, centre);
    return pass && pass.d <= AMBUSH_PASS && pass.inS <= PASS_WITHIN_S ? pass : null;
}

/** Its closest pass to `me` on its present walk: distance and seconds until then; null when it walks away or stands. */
export function closestPass(at: Point, vel: Point | null, me: Point): { d: number; inS: number } | null {
    if (!vel) return null;
    const v2 = vel.x * vel.x + vel.y * vel.y;
    if (Math.sqrt(v2) < WALKING) return null;
    const t = ((me.x - at.x) * vel.x + (me.y - at.y) * vel.y) / v2;
    if (t <= 0) return null;
    return { d: Math.hypot(at.x + vel.x * t - me.x, at.y + vel.y * t - me.y), inS: t };
}
