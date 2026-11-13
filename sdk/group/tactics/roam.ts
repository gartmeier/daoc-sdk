// A main group's roam in a battleground: the user's own definition (2026-11-13, playing Niamh): "look for enemies on Hib's
// island, then Mid's, then Albion's", moving all the time. Two rules, nothing else:
//
//   1. The place picker (nextPlace): a fresh enemy sighting near us first; else the nearest place on the circuit's current
//      side we haven't passed this lap; with none left there, the next side (ours, then each enemy realm's, round again).
//   2. The leave rule (shouldLeave): a place is kept until it is passed (within `reach`, then straight on to the next: no stop)
//      or given up (it took far longer than the walk should). Only a fresh sighting takes over from a circuit place, and only
//      once the place has been held `holdMs`; nothing takes over from a sighting. A blocked place (the group we just ran from
//      stands that way) is left at once.
//
// Fights, hunts, calls, the defence, buffs, rests and breaks all come before the roam in decideRvr (rvr.ts): they take over
// whenever they have something to do, and the roam picks up where it was. Rivers are one check, made once: every place is
// on dry ground (placeOk), and the legs to it keep to dry ground (rvr.ts stepLeg); a swimmer is never hunted (rvr.ts).
//
// Replaces the pile from 2026-11-13 (weighted random places, looks and stays, 5-min areas, "roam near a friend", waves out to
// sightings, waiting ashore), which flipped between its own rules every few seconds. Pure: state in memory.roam.

import type { Point, Point3 } from '../types';
import { BATTLEGROUND_LAYOUTS, clearOf, type PlayerRealm } from '../keeps';
import type { Danger } from '../terrain';
import { raidPlan } from '../siege';

/** An approach to a portal keep stands this far out from the keep toward the meeting point (its guards reach about 4500). */
export const APPROACH = 7500;
/** Spots round the Faste stand this far from its centre (outside its guards for a realm that doesn't hold it). */
export const FASTE_RING = 5800;

/** One place the roam may go. */
export interface RoamPlace extends Point {
    key: string;
    /** What it is, for the reason. */
    what: string;
    /** Whose side of the battleground it is on (sideOf); undefined off a known battleground (then every side has it). */
    side?: PlayerRealm;
    /** A sighting's time (ms): set only on sightings. */
    at?: number;
}

/** An enemy sighting our realm made (director.ts Sighting): where, how many, when. */
export interface RoamSighting extends Point {
    n: number;
    at: number;
}

export interface RoamSettings {
    /** A place this near counts as passed. */
    reach: number;
    /** A place is held at least this long before a sighting takes over (no flips). */
    holdMs: number;
    /** A sighting counts this long (ms). */
    sightingMs: number;
    /** Only a sighting this near is worth turning for (no long crossings back and forth). */
    sightingReach: number;
    /** A place is given up after this, plus the walk at giveUpSpeed (units/s): stuck, or a detour that never ends. */
    giveUpMs: number;
    giveUpSpeed: number;
}

export const ROAM_SETTINGS: RoamSettings = { reach: 900, holdMs: 10_000, sightingMs: 300_000, sightingReach: 9000, giveUpMs: 30_000, giveUpSpeed: 100 };

/** memory.roam */
export interface RoamMemory {
    /** Where we go now, since when, and until when before giving up. */
    place: RoamPlace | null;
    since: number;
    until: number;
    /** The circuit's current side (an index into it). */
    side: number;
    /** Circuit places passed on this lap of their side. */
    done: string[];
    /** Sighting cells passed, and when: a sighting there older than that is no news. */
    passed: Record<string, number>;
}

export type RoamStep = { goal: Point; place: RoamPlace; reason: string };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Whose side of the battleground `p` is on: the realm of the nearest portal keep (undefined off a known battleground). */
export function sideOf(regionId: number, p: Point): PlayerRealm | undefined {
    const pks = (BATTLEGROUND_LAYOUTS[regionId]?.keeps ?? []).filter(k => k.portal && k.owner !== 'none');
    if (!pks.length) return undefined;
    return pks.reduce((a, b) => (dist(a, p) <= dist(b, p) ? a : b)).owner as PlayerRealm;
}

/** The circuit for `realm`: our own side first (enemies who came over), then the others, and round again. */
export function roamCircuit(realm: PlayerRealm): PlayerRealm[] {
    const order: PlayerRealm[] = ['hibernia', 'midgard', 'albion'];
    const i = Math.max(0, order.indexOf(realm));
    return [order[i]!, order[(i + 1) % 3]!, order[(i + 2) % 3]!];
}

/**
 * The battleground's places for `realm`, each with its side: `ring` (the patrol ring round the meeting point), where our realm's
 * halves meet another's (BattlegroundLayout.pairs), the approach to every portal keep (ours too: enemies come over), spots round
 * the Faste, and each realm's bank by the Faste's bridges (siege.ts raidPlan rallies). `ok` keeps those dry and clear of keeps.
 */
export function roamPlaces(regionId: number, realm: PlayerRealm, ring: readonly Point3[], ok: (p: Point) => boolean): RoamPlace[] {
    const out: RoamPlace[] = ring.map((p, i) => ({ key: `ring${i}`, what: 'the meeting ground', x: p.x, y: p.y }));
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    for (const [key, p] of Object.entries(bg?.pairs ?? {})) {
        if (key.split('|').includes(realm)) out.push({ key: `pair:${key}`, what: `where ${key.replace('|', ' and ')} meet`, x: p.x, y: p.y });
    }
    const meet = bg?.meet;
    for (const k of bg?.keeps ?? []) {
        if (!k.portal || !meet) continue;
        const d = dist(k, meet) || 1;
        const whose = k.owner === realm ? 'our' : `${k.owner}'s`;
        for (const [i, turn] of [0, 0.35, -0.35].entries()) {
            const a = Math.atan2(meet.y - k.y, meet.x - k.x) + turn;
            out.push({ key: `pk:${k.owner}:${i}`, what: `the approach to ${whose} portal keep`, x: Math.round(k.x + Math.cos(a) * Math.min(APPROACH, d)), y: Math.round(k.y + Math.sin(a) * Math.min(APPROACH, d)) });
        }
    }
    const faste = bg?.keeps.find(k => !k.portal);
    if (faste) for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + 0.3;
        out.push({ key: `faste:${i}`, what: "the Faste's surroundings", x: Math.round(faste.x + Math.cos(a) * FASTE_RING), y: Math.round(faste.y + Math.sin(a) * FASTE_RING) });
    }
    for (const r of ['albion', 'midgard', 'hibernia'] as const) {
        const plan = raidPlan(r);
        if (plan && plan.regionId === regionId) out.push({ key: `bank:${r}`, what: `${r === realm ? 'our' : `${r}'s`} bank by the Faste`, x: plan.rally.x, y: plan.rally.y });
    }
    return out.filter(ok).map(p => ({ ...p, side: sideOf(regionId, p) }));
}

/** Fresh sightings (within sightingMs) as places, on dry ground (`ok`), by 2000-unit cell. */
export function sightingPlaces(regionId: number, sightings: readonly RoamSighting[], now: number, ok: (p: Point) => boolean, s: RoamSettings = ROAM_SETTINGS): RoamPlace[] {
    return sightings
        .filter(x => now - x.at < s.sightingMs && ok(x))
        .map(x => ({ key: `seen:${Math.round(x.x / 2000)}:${Math.round(x.y / 2000)}`, what: `where ${x.n} ${x.n === 1 ? 'enemy was' : 'enemies were'} seen ${Math.round((now - x.at) / 60_000)} min ago`, x: x.x, y: x.y, at: x.at, side: sideOf(regionId, x) }));
}

const isSighting = (p: RoamPlace | null | undefined) => p?.at !== undefined;

/** Rule 1, the place picker: a fresh sighting near us, else the nearest unpassed place on the circuit's side (turning to the next side when none is left). */
export function nextPlace(r: RoamMemory, o: { centre: Point; places: readonly RoamPlace[]; sightings: readonly RoamPlace[]; circuit: readonly PlayerRealm[]; blocked?: (p: Point) => boolean }, s: RoamSettings = ROAM_SETTINGS): RoamPlace | null {
    const away = (p: RoamPlace) => dist(p, o.centre) > s.reach && !o.blocked?.(p);
    const nearest = (ps: readonly RoamPlace[]) => (ps.length ? ps.reduce((a, b) => (dist(a, o.centre) <= dist(b, o.centre) ? a : b)) : null);
    const news = o.sightings.filter(p => away(p) && dist(p, o.centre) <= s.sightingReach && !((r.passed[p.key] ?? -Infinity) >= p.at!));
    const seen = nearest(news);
    if (seen) return seen;
    const sides = o.circuit.length ? o.circuit : [undefined];
    for (let turn = 0; turn <= sides.length; turn++) {
        const side = sides[r.side % sides.length];
        const left = o.places.filter(p => (p.side === side || p.side === undefined) && !r.done.includes(p.key) && away(p));
        const pick = nearest(left);
        if (pick) return pick;
        // This side done: on to the next, its places fresh again.
        r.side = (r.side + 1) % sides.length;
        const next = sides[r.side];
        r.done = r.done.filter(k => o.places.find(p => p.key === k)?.side !== next);
    }
    return null;
}

/** Rule 2, the leave rule: whether to drop the current place now (for `better`, when there is one). */
export function shouldLeave(r: RoamMemory, o: { centre: Point; now: number; better: RoamPlace | null; blocked?: (p: Point) => boolean }, s: RoamSettings = ROAM_SETTINGS): boolean {
    const p = r.place;
    if (!p) return true;
    if (dist(o.centre, p) <= s.reach || o.now >= r.until || o.blocked?.(p)) return true;
    return o.now - r.since >= s.holdMs && !isSighting(p) && isSighting(o.better);
}

/**
 * This tick's roam: mark what we pass, keep the place unless the leave rule says go, else pick the next (rule 1). Null with no
 * place at all (the caller patrols). `blocked`: a place not to walk toward now (the group we just ran from).
 */
export function roamStep(mem: Record<string, any>, o: { regionId: number; centre: Point; places: readonly RoamPlace[]; sightings?: readonly RoamSighting[]; circuit?: readonly PlayerRealm[]; now: number; ok?: (p: Point) => boolean; blocked?: (p: Point) => boolean; settings?: RoamSettings }): RoamStep | null {
    const s = o.settings ?? ROAM_SETTINGS;
    const r: RoamMemory = mem.roam?.passed ? mem.roam : (mem.roam = { place: null, since: o.now, until: o.now, side: 0, done: [], passed: {} });
    const circuit = o.circuit ?? [];
    const sightings = sightingPlaces(o.regionId, o.sightings ?? [], o.now, o.ok ?? (() => true), s);
    const was = r.place;
    const reached = !!was && dist(o.centre, was) <= s.reach;
    const gaveUp = !!was && !reached && o.now >= r.until;
    // A sighting reached on another side: the circuit goes on from that side, its places fresh (no crossing back).
    if (reached && isSighting(was) && was!.side && circuit.includes(was!.side) && circuit[r.side % circuit.length] !== was!.side) {
        r.side = circuit.indexOf(was!.side);
        r.done = r.done.filter(k => o.places.find(p => p.key === k)?.side !== was!.side);
    }
    // Passing through counts: every place we come within reach of, on the way to anything.
    for (const p of o.places) if (dist(p, o.centre) <= s.reach && !r.done.includes(p.key)) r.done.push(p.key);
    for (const p of sightings) if (dist(p, o.centre) <= s.reach) r.passed[p.key] = o.now;
    for (const [k, at] of Object.entries(r.passed)) if (o.now - at > s.sightingMs) delete r.passed[k];
    if (gaveUp && !isSighting(was) && !r.done.includes(was!.key)) r.done.push(was!.key);
    if (gaveUp && isSighting(was)) r.passed[was!.key] = o.now;
    const pickArgs = { centre: o.centre, places: o.places, sightings, circuit, blocked: o.blocked };
    const better = was && !isSighting(was) && o.now - r.since >= s.holdMs ? nextPlace({ ...r, done: [...r.done] }, pickArgs, s) : null;
    if (!shouldLeave(r, { centre: o.centre, now: o.now, better, blocked: o.blocked }, s)) return step(was!, o.centre, circuit, 'to');
    const place = nextPlace(r, pickArgs, s);
    r.place = place;
    if (!place) return null;
    r.since = o.now;
    r.until = o.now + s.giveUpMs + dist(o.centre, place) / s.giveUpSpeed * 1000;
    const how = !was ? 'to' : reached ? `past ${was.what}, on to` : gaveUp ? `gave up on ${was.what}, on to` : isSighting(place) && !isSighting(was) ? 'turning for' : 'keeping off the group we ran from, to';
    return step(place, o.centre, circuit, how);
}

function step(place: RoamPlace, centre: Point, circuit: readonly PlayerRealm[], how: string): RoamStep {
    const side = place.side && circuit.length ? `, ${place.side === circuit[0] ? 'our' : `${place.side}'s`} side` : '';
    return { goal: place, place, reason: `roam: ${how} ${place.what}${side} (${Math.round(place.x)}, ${Math.round(place.y)}), ${Math.round(dist(centre, place))} away` };
}

/** Keep `p` usable as a roam place: dry, level enough and clear of camps and keeps (by `dangers`). */
export const placeOk = (dangers: readonly Danger[], dry: (p: Point) => boolean) => (p: Point) => clearOf(p, dangers, 900) && dry(p);
