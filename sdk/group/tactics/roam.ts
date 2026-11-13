// A main group's roam (S3, 2026-11-13; the user, playing Niamh: "the roaming we currently do is not very good, we're doing the same
// back and forth every time"). Instead of the fixed ring round the meeting point in the same order, the group goes from place to
// place as a player group does: where our realm saw enemies lately (the director's sightings), and the battleground's meeting places
// (the ring round the meeting point, where two realms' halves meet, each realm's bank by the Faste's bridges). The next place is
// picked weighted and at random from those within a leg's reach, never one of the last few, never a 20k crossing when a nearer one
// will do; there the group stays a while (a small circle round it, a wait) before it moves on.
//
// Pure but for `rand` and memory.roam. decideRvr (rvr.ts) calls roamStep where its patrol was, when no settings.patrol is set.

import type { Point, Point3 } from '../types';
import { BATTLEGROUND_LAYOUTS, clearOf, type PlayerRealm } from '../keeps';
import type { Danger } from '../terrain';
import { raidPlan } from '../siege';

/** One place the roam may go. */
export interface RoamPlace extends Point {
    key: string;
    /** What it is, for the reason. */
    what: string;
    /** Base weight: a meeting place 1, a sighting more (roamPlaces). */
    weight: number;
}

/** An enemy sighting our realm made (director.ts Sighting): where, how many, when. */
export interface RoamSighting extends Point {
    n: number;
    at: number;
}

export interface RoamSettings {
    /** Places farther than this from the group are left while nearer ones exist (no 20k crossings back and forth). */
    maxLeg: number;
    /** The last this many places aren't picked again. */
    memory: number;
    /** A place this near counts as reached. */
    reach: number;
    /** How long the group stays at a place, at least and at most (ms). */
    stayMin: number;
    stayMax: number;
    /** While it stays, it walks a small circle of this radius round the place, a step every stepMs. */
    circle: number;
    stepMs: number;
    /** A sighting counts this long (ms), its weight fading to nothing. */
    sightingMs: number;
    /** A sighting's weight: this, plus one per enemy seen, at its freshest. */
    sightingWeight: number;
}

export const ROAM_SETTINGS: RoamSettings = {
    maxLeg: 12_000, memory: 3, reach: 900, stayMin: 60_000, stayMax: 150_000, circle: 700, stepMs: 25_000, sightingMs: 300_000, sightingWeight: 2,
};

/** memory.roam */
export interface RoamMemory {
    /** The place we go to, or stay at. */
    place: RoamPlace | null;
    /** When we reached it, and until when we stay. */
    reachedAt?: number;
    stayUntil?: number;
    /** The circle's current step (index) and when it was taken. */
    step?: number;
    stepAt?: number;
    /** Keys of the last places, newest last. */
    last: string[];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The battleground's meeting places for `realm`: `ring` (the old patrol's waypoints round the meeting point, already dry, level and
 * clear), where our realm's halves meet another's (BattlegroundLayout.pairs with our realm in the key), and each realm's bank by the
 * Faste's bridges (siege.ts raidPlan rallies). `ok` filters places (dry, clear of camps and keeps).
 */
export function meetingPlaces(regionId: number, realm: PlayerRealm, ring: readonly Point3[], ok: (p: Point) => boolean): RoamPlace[] {
    const out: RoamPlace[] = ring.map((p, i) => ({ key: `ring${i}`, what: 'the meeting ground', x: p.x, y: p.y, weight: 1 }));
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    for (const [key, p] of Object.entries(bg?.pairs ?? {})) {
        if (!key.split('|').includes(realm)) continue;
        out.push({ key: `pair:${key}`, what: `where ${key.replace('|', ' and ')} meet`, x: p.x, y: p.y, weight: 1 });
    }
    for (const r of ['albion', 'midgard', 'hibernia'] as const) {
        const plan = raidPlan(r);
        if (plan && plan.regionId === regionId) out.push({ key: `bank:${r}`, what: `${r === realm ? 'our' : `${r}'s`} bank by the Faste`, x: plan.rally.x, y: plan.rally.y, weight: r === realm ? 0.7 : 1 });
    }
    return out.filter(ok);
}

/** Sightings as places, their weight fading with age; none older than sightingMs. */
export function sightingPlaces(sightings: readonly RoamSighting[], now: number, ok: (p: Point) => boolean, s: RoamSettings = ROAM_SETTINGS): RoamPlace[] {
    return sightings
        .filter(x => now - x.at < s.sightingMs && ok(x))
        .map(x => ({ key: `seen:${Math.round(x.x / 2000)}:${Math.round(x.y / 2000)}`, what: `where ${x.n} ${x.n === 1 ? 'enemy was' : 'enemies were'} seen ${Math.round((now - x.at) / 60_000)} min ago`, x: x.x, y: x.y, weight: (s.sightingWeight + x.n) * (1 - (now - x.at) / s.sightingMs) }));
}

/** A place this near a friendly group counts as near it. */
export const FRIEND_NEAR = 4500;

/** The next place: weighted, at random, from those within maxLeg (the nearest few else), never the last `memory` ones nor where we stand. */
export function pickPlace(places: readonly RoamPlace[], centre: Point, last: readonly string[], rand: () => number, s: RoamSettings = ROAM_SETTINGS, friends: readonly Point[] = []): RoamPlace | null {
    const fresh = places.filter(p => !last.includes(p.key) && dist(p, centre) > s.reach * 1.5);
    const pool = fresh.length ? fresh : places.filter(p => dist(p, centre) > s.reach * 1.5);
    if (!pool.length) return null;
    const near = pool.filter(p => dist(p, centre) <= s.maxLeg);
    const from = near.length ? near : [...pool].sort((a, b) => dist(a, centre) - dist(b, centre)).slice(0, 2);
    // Nearer is likelier: a long walk is worth it for a fresh sighting, less for an empty meeting place.
    // And near a friendly group of ours (help.ts roamGoal keeps us within reach of one): three times as likely.
    const w = from.map(p => p.weight / (1 + dist(p, centre) / 5000) * (friends.some(f => dist(f, p) <= FRIEND_NEAR) ? 3 : 1));
    const total = w.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < from.length; i++) { r -= w[i]!; if (r <= 0) return from[i]!; }
    return from[from.length - 1]!;
}

export type RoamStep =
    | { kind: 'go'; goal: Point; place: RoamPlace; reason: string }
    | { kind: 'stay'; goal: Point; place: RoamPlace; reason: string };

/**
 * This tick's roam: go to the place, or stay at it (a step round a small circle every stepMs) until stayUntil, then pick the next.
 * `ok` checks a circle step (dry, clear). Null with no place at all (the caller patrols as before).
 */
export function roamStep(mem: Record<string, any>, o: { centre: Point; places: readonly RoamPlace[]; now: number; rand?: () => number; ok?: (p: Point) => boolean; settings?: RoamSettings; friends?: readonly Point[] }): RoamStep | null {
    const s = o.settings ?? ROAM_SETTINGS;
    const rand = o.rand ?? Math.random;
    const r: RoamMemory = mem.roam ??= { place: null, last: [] };
    const next = () => {
        if (r.place) { r.last = [...r.last.filter(k => k !== r.place!.key), r.place.key].slice(-s.memory); }
        r.place = pickPlace(o.places, o.centre, r.last, rand, s, o.friends ?? []);
        r.reachedAt = undefined; r.stayUntil = undefined; r.step = undefined; r.stepAt = undefined;
    };
    // A place that's gone from the list (a sighting faded) is still where we go: we picked it.
    if (!r.place || (r.stayUntil !== undefined && o.now >= r.stayUntil)) next();
    if (!r.place) return null;
    const place = r.place;
    const d = dist(o.centre, place);
    if (r.reachedAt === undefined && d > s.reach) {
        return { kind: 'go', goal: place, place, reason: `roam: to ${place.what} (${Math.round(place.x)}, ${Math.round(place.y)}), ${Math.round(d)} away` };
    }
    if (r.reachedAt === undefined) {
        r.reachedAt = o.now;
        r.stayUntil = o.now + s.stayMin + Math.round(rand() * (s.stayMax - s.stayMin));
        r.step = 0;
        r.stepAt = o.now;
    }
    // Round a small circle, a step every stepMs (a group looking about, not standing in formation).
    if (o.now - (r.stepAt ?? o.now) >= s.stepMs) { r.step = ((r.step ?? 0) + 1) % 4; r.stepAt = o.now; }
    const a = (r.step ?? 0) * Math.PI / 2 + (place.x % 7);
    let goal: Point = r.step ? { x: Math.round(place.x + Math.cos(a) * s.circle), y: Math.round(place.y + Math.sin(a) * s.circle) } : { x: place.x, y: place.y };
    if (o.ok && !o.ok(goal)) goal = { x: place.x, y: place.y };
    const left = Math.max(0, Math.round(((r.stayUntil ?? o.now) - o.now) / 1000));
    return { kind: 'stay', goal, place, reason: `roam: at ${place.what}, looking about, on in ${left} s` };
}

/** Keep `p` usable as a roam place: dry, level enough and clear of camps and keeps (by `dangers`). */
export const placeOk = (dangers: readonly Danger[], dry: (p: Point) => boolean) => (p: Point) => clearOf(p, dangers, 900) && dry(p);
