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

/** An approach to another realm's portal keep stands this far out from the keep (its guards reach about 4500). */
export const APPROACH = 7500;
/** Spots round the Faste stand this far from its centre (outside its guards for a realm that doesn't hold it). */
export const FASTE_RING = 5800;

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
    /**
     * An area: the group within this of where it started roaming there (memory.roam.area). After areaMs in one with no enemy seen
     * in it (by us or our realm), it goes on to a place at least areaFar away, past maxLeg (the user at 19:51: "we're in the same
     * area forever. There are no enemies here. We're going in circles for like 20 minutes").
     */
    areaRadius: number;
    areaMs: number;
    areaFar: number;
}

// No stop: a place is a waypoint, and on reaching it (reach) the group walks on to the next (the user, playing Niamh at 19:45, the
// group standing 1-2 min at a sighting: "that's not human-like behaviour. You'd keep roaming"; on 8-18 s looks: "there shouldn't
// be stops"). A stay and its circle steps come only with stayMax above 0 (settings of one's own).
export const ROAM_SETTINGS: RoamSettings = {
    maxLeg: 16_000, memory: 4, reach: 900, stayMin: 0, stayMax: 0, circle: 700, stepMs: 25_000, sightingMs: 300_000, sightingWeight: 2,
    areaRadius: 5000, areaMs: 300_000, areaFar: 12_000,
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
    /** Where the group's current area started, and when (RoamSettings.areaRadius). */
    area?: Point & { since: number };
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
    // The user, 18:0x: "I would expect more variety: going by mid PK, alb PK, Faste." The approaches to the other realms' portal keeps
    // (APPROACH out from the keep toward the meeting point, beyond its guards' reach) and spots round the Faste (FASTE_RING out).
    const meet = bg?.meet;
    for (const k of bg?.keeps ?? []) {
        if (!k.portal || k.owner === realm || !meet) continue;
        const d = dist(k, meet) || 1;
        for (const [i, turn] of [0, 0.35, -0.35].entries()) {
            const a = Math.atan2(meet.y - k.y, meet.x - k.x) + turn;
            out.push({ key: `pk:${k.owner}:${i}`, what: `the approach to ${k.owner}'s portal keep`, x: Math.round(k.x + Math.cos(a) * Math.min(APPROACH, d)), y: Math.round(k.y + Math.sin(a) * Math.min(APPROACH, d)), weight: 0.8 });
        }
    }
    const faste = bg?.keeps.find(k => !k.portal);
    if (faste) for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + 0.3;
        out.push({ key: `faste:${i}`, what: "the Faste's surroundings", x: Math.round(faste.x + Math.cos(a) * FASTE_RING), y: Math.round(faste.y + Math.sin(a) * FASTE_RING), weight: 0.6 });
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
/**
 * A place we stay at (looking about), or one already judged near the friend, holds while the friend is within this of it: the
 * friend walking in and out of FRIEND_NEAR flipped hibernia between the place and closing on it every 6-12 s (19:43, the user's
 * report through the player-feedback session).
 */
export const STAY_FRIEND_FAR = 6000;

/**
 * The next place: weighted, at random, never the last `memory` ones nor where we stand. Where our realm saw enemies (a sighting,
 * key `seen:`) first, at any distance: the roam goes where the fighting is (the user at 19:51). Else from the meeting places
 * within maxLeg (the nearest few else); with `farFrom`, only those at least areaFar from that point, at any distance.
 */
export function pickPlace(places: readonly RoamPlace[], centre: Point, last: readonly string[], rand: () => number, s: RoamSettings = ROAM_SETTINGS, friends: readonly Point[] = [], farFrom?: Point): RoamPlace | null {
    const fresh = places.filter(p => !last.includes(p.key) && dist(p, centre) > s.reach * 1.5);
    const pool = fresh.length ? fresh : places.filter(p => dist(p, centre) > s.reach * 1.5);
    if (!pool.length) return null;
    const seen = pool.filter(p => p.key.startsWith('seen:') && (!farFrom || dist(p, farFrom) >= s.areaFar));
    const far = farFrom ? pool.filter(p => dist(p, farFrom) >= s.areaFar) : [];
    const near = pool.filter(p => dist(p, centre) <= s.maxLeg);
    const from = seen.length ? seen : far.length ? far : near.length ? near : [...pool].sort((a, b) => dist(a, centre) - dist(b, centre)).slice(0, 2);
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
export function roamStep(mem: Record<string, any>, o: { centre: Point; places: readonly RoamPlace[]; now: number; rand?: () => number; ok?: (p: Point) => boolean; settings?: RoamSettings; friends?: readonly Point[]; sightings?: readonly RoamSighting[] }): RoamStep | null {
    const s = o.settings ?? ROAM_SETTINGS;
    const rand = o.rand ?? Math.random;
    const r: RoamMemory = mem.roam ??= { place: null, last: [] };
    const next = (farFrom?: Point) => {
        if (r.place) { r.last = [...r.last.filter(k => k !== r.place!.key), r.place.key].slice(-s.memory); }
        r.place = pickPlace(o.places, o.centre, r.last, rand, s, o.friends ?? [], farFrom);
        r.reachedAt = undefined; r.stayUntil = undefined; r.step = undefined; r.stepAt = undefined;
    };
    // The area (areaRadius): areaMs in it with no enemy seen in it, and on to a place far off (areaFar), whatever we were going to.
    if (!r.area || dist(o.centre, r.area) > s.areaRadius) r.area = { x: Math.round(o.centre.x), y: Math.round(o.centre.y), since: o.now };
    const seenHere = Math.max(r.area.since, ...(o.sightings ?? []).filter(x => dist(x, r.area!) <= s.areaRadius).map(x => x.at));
    if (o.now - seenHere >= s.areaMs) {
        const left = r.area;
        r.area = { x: Math.round(o.centre.x), y: Math.round(o.centre.y), since: o.now };
        next(left);
        if (r.place) return { kind: 'go', goal: r.place, place: r.place, reason: `roam: ${Math.round((o.now - seenHere) / 60_000)} min here with no enemy seen, far off to ${r.place.what} (${Math.round(r.place.x)}, ${Math.round(r.place.y)}), ${Math.round(dist(o.centre, r.place))} away` };
    }
    // A place that's gone from the list (a sighting faded) is still where we go: we picked it.
    if (!r.place || (r.stayUntil !== undefined && o.now >= r.stayUntil)) next();
    if (!r.place) return null;
    const place = r.place;
    const d = dist(o.centre, place);
    if (r.reachedAt === undefined && d > s.reach) {
        return { kind: 'go', goal: place, place, reason: `roam: to ${place.what} (${Math.round(place.x)}, ${Math.round(place.y)}), ${Math.round(d)} away` };
    }
    // No stay: past it, on to the next place at once (the group never stands while it roams).
    if (r.reachedAt === undefined && s.stayMax <= 0) {
        next();
        const on = r.place as RoamPlace | null;
        if (on) return { kind: 'go', goal: on, place: on, reason: `roam: past ${place.what}, on to ${on.what} (${Math.round(on.x)}, ${Math.round(on.y)}), ${Math.round(dist(o.centre, on))} away` };
        r.place = place;
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
