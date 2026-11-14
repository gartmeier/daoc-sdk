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
    /** Sightings within this of each other are one area (the director keeps one per 2000 cell); passing within this of one passes it. */
    area: number;
    /** Only a sighting this near is worth turning for (no long crossings back and forth). */
    sightingReach: number;
    /** A place is given up after this, plus the walk at giveUpSpeed (units/s): stuck, or a detour that never ends. */
    giveUpMs: number;
    giveUpSpeed: number;
}

export const ROAM_SETTINGS: RoamSettings = { reach: 900, holdMs: 10_000, sightingMs: 150_000, area: 3000, sightingReach: 9000, giveUpMs: 30_000, giveUpSpeed: 100 };

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
    /** Where we passed a sighting area, and when: a sighting within `area` of one, and older, is no news. */
    passed: (Point & { at: number })[];
    /** The roam's last tick: a gap longer than PAUSE_MS (something else had the group) moves `until` on by it. */
    tick?: number;
}

/** A gap between roam ticks longer than this is a pause, not walking time. */
export const PAUSE_MS = 5000;

// ── Moving on after fights in one area ──
// The user, playing Niamh on 2026-11-14 09:36-09:42: "being a long time in the same place causes all sorts of trouble". Fights and
// the realm calls they bring draw the other realms there; after SPENT_FIGHTS in one area the roam leaves it for SPENT_MS.

/** Fights within this of each other are one area. */
export const FIGHT_AREA = 3000;
/** This many fights in one area within SPENT_MS: the roam moves on from it ... */
export const SPENT_FIGHTS = 2;
export const SPENT_MS = 300_000;
/** ... a fight being engages with gaps under this (a hunt or a stalk in between, the roam's 10 s hold after). */
export const FIGHT_GAP_MS = 12_000;

export interface FightNote extends Point { start: number; last: number }

/** Notes an engage this tick at `at` (memory.fights): the fight going on, or a new one. */
export function noteFight(mem: Record<string, any>, at: Point, now: number): void {
    const fights: FightNote[] = Array.isArray(mem.fights) ? mem.fights : [];
    const last = fights[fights.length - 1];
    if (last && now - last.last <= FIGHT_GAP_MS && dist(last, at) <= FIGHT_AREA) last.last = now;
    else fights.push({ x: Math.round(at.x), y: Math.round(at.y), start: now, last: now });
    mem.fights = fights.filter(f => now - f.last <= SPENT_MS).slice(-20);
}

/** The areas fought in SPENT_FIGHTS times within SPENT_MS: each such fight's spot, with the count of fights round it. */
export function spentAreas(mem: Record<string, any>, now: number): (Point & { n: number })[] {
    const fights = (Array.isArray(mem.fights) ? mem.fights as FightNote[] : []).filter(f => now - f.last <= SPENT_MS);
    return fights.map(f => ({ x: f.x, y: f.y, n: fights.filter(g => dist(g, f) <= FIGHT_AREA).length })).filter(a => a.n >= SPENT_FIGHTS);
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

/**
 * Fresh sightings (within sightingMs) as places, on dry ground (`ok`), one per area: the freshest of those within `area` of it
 * stands for them, with all their enemies (live 20:44, hibernia went "past X, on to Y" every 2-5 s through 2000-cells 1200-2500 apart).
 */
export function sightingPlaces(regionId: number, sightings: readonly RoamSighting[], now: number, ok: (p: Point) => boolean, s: RoamSettings = ROAM_SETTINGS): RoamPlace[] {
    const areas: RoamSighting[] = [];
    for (const x of sightings.filter(x => now - x.at < s.sightingMs && ok(x)).sort((a, b) => b.at - a.at || b.n - a.n)) {
        const a = areas.find(a => dist(a, x) <= s.area);
        if (a) a.n += x.n; else areas.push({ ...x });
    }
    return areas.map(x => ({ key: `seen:${Math.round(x.x)}:${Math.round(x.y)}`, what: `where ${x.n} ${x.n === 1 ? 'enemy was' : 'enemies were'} seen ${Math.round((now - x.at) / 1000)} s ago`, x: x.x, y: x.y, at: x.at, side: sideOf(regionId, x) }));
}

const isSighting = (p: RoamPlace | null | undefined) => p?.at !== undefined;
/** A realm call beyond the director's reach as a roam place (key `call:<id>`, rvr.ts): the best lead the roam has. The user, playing
 *  Niamh on 2026-11-14 10:07: "the group ignored Aine's call" (hibernia-s1 caught 19-25k away, the roam walking off the other way). */
export const isCall = (p: RoamPlace | null | undefined) => !!p?.key.startsWith('call:');

/** Rule 1, the place picker: a fresh sighting near us, else the nearest unpassed place on the circuit's side (turning to the next side when none is left). */
export function nextPlace(r: RoamMemory, o: { centre: Point; places: readonly RoamPlace[]; sightings: readonly RoamPlace[]; circuit: readonly PlayerRealm[]; blocked?: (p: Point) => boolean; calls?: readonly RoamPlace[] }, s: RoamSettings = ROAM_SETTINGS): RoamPlace | null {
    const away = (p: RoamPlace) => dist(p, o.centre) > s.reach && !o.blocked?.(p);
    const nearest = (ps: readonly RoamPlace[]) => (ps.length ? ps.reduce((a, b) => (dist(a, o.centre) <= dist(b, o.centre) ? a : b)) : null);
    // An open call of our realm's first, at any distance (a heading, not a commitment: help.ts takes it once within its reach).
    const call = nearest((o.calls ?? []).filter(p => away(p) && !r.done.includes(p.key)));
    if (call) return call;
    const news = o.sightings.filter(p => away(p) && dist(p, o.centre) <= s.sightingReach && !r.passed.some(q => q.at >= p.at! && dist(q, p) <= s.area));
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
export function shouldLeave(r: RoamMemory, o: { centre: Point; now: number; better: RoamPlace | null; blocked?: (p: Point) => boolean; gone?: boolean }, s: RoamSettings = ROAM_SETTINGS): boolean {
    const p = r.place;
    if (!p) return true;
    if (dist(o.centre, p) <= s.reach || o.now >= r.until || o.blocked?.(p) || o.gone) return true;
    // A call takes over from anything but a call; a sighting from a circuit place; each only after the place was held holdMs.
    return o.now - r.since >= s.holdMs && ((!isSighting(p) && isSighting(o.better)) || (!isCall(p) && isCall(o.better)));
}

/**
 * This tick's roam: mark what we pass, keep the place unless the leave rule says go, else pick the next (rule 1). Null with no
 * place at all (the caller patrols). `blocked`: a place not to walk toward now (the group we just ran from).
 */
export function roamStep(mem: Record<string, any>, o: { regionId: number; centre: Point; places: readonly RoamPlace[]; sightings?: readonly RoamSighting[]; circuit?: readonly PlayerRealm[]; now: number; ok?: (p: Point) => boolean; blocked?: (p: Point) => boolean; spent?: readonly Point[]; calls?: readonly RoamPlace[]; settings?: RoamSettings }): RoamStep | null {
    const s = o.settings ?? ROAM_SETTINGS;
    const r: RoamMemory = Array.isArray(mem.roam?.passed) ? mem.roam : (mem.roam = { place: null, since: o.now, until: o.now, side: 0, done: [], passed: [] });
    const circuit = o.circuit ?? [];
    // The give-up clock runs only while the roam does: a rest, a break, a hunt or a fight in between pauses it (live 20:22,
    // camelot-2 "gave up on" a sighting after a 2-min field rest it never walked in).
    if (r.place && r.tick !== undefined && o.now - r.tick > PAUSE_MS) r.until += o.now - r.tick;
    r.tick = o.now;
    const sightings = sightingPlaces(o.regionId, o.sightings ?? [], o.now, o.ok ?? (() => true), s);
    const was = r.place;
    const reached = !!was && dist(o.centre, was) <= s.reach;
    const calls = o.calls ?? [];
    // A call that closed before we got there: on from where we are.
    const gone = isCall(was) && !calls.some(c => c.key === was!.key);
    const gaveUp = !!was && !reached && o.now >= r.until;
    // A sighting reached on another side: the circuit goes on from that side, its places fresh (no crossing back).
    if (reached && isSighting(was) && was!.side && circuit.includes(was!.side) && circuit[r.side % circuit.length] !== was!.side) {
        r.side = circuit.indexOf(was!.side);
        r.done = r.done.filter(k => o.places.find(p => p.key === k)?.side !== was!.side);
    }
    // Passing through counts: every place we come within reach of, on the way to anything.
    for (const p of [...o.places, ...calls]) if (dist(p, o.centre) <= s.reach && !r.done.includes(p.key)) r.done.push(p.key);
    // A sighting area passed (any sighting within reach), or one given up: none within `area` of it is news until seen again.
    if (sightings.some(p => dist(p, o.centre) <= s.reach)) r.passed.push({ x: Math.round(o.centre.x), y: Math.round(o.centre.y), at: o.now });
    if (gaveUp && isSighting(was) && !isCall(was)) r.passed.push({ x: was!.x, y: was!.y, at: o.now });
    r.passed = r.passed.filter(q => o.now - q.at <= s.sightingMs).slice(-50);
    if (gaveUp && (!isSighting(was) || isCall(was)) && !r.done.includes(was!.key)) r.done.push(was!.key);
    r.done = r.done.filter(k => !k.startsWith('call:') || calls.some(c => c.key === k));
    // An area fought in SPENT_FIGHTS times (spentAreas) is blocked like the group we ran from: no place or sighting in it.
    const inSpent = (p: Point) => (o.spent ?? []).some(a => dist(a, p) <= s.area);
    const blocked = (p: Point) => !!o.blocked?.(p) || inSpent(p);
    const pickArgs = { centre: o.centre, places: o.places, sightings, circuit, blocked, calls };
    const better = was && !isCall(was) && o.now - r.since >= s.holdMs ? nextPlace({ ...r, done: [...r.done] }, pickArgs, s) : null;
    if (!shouldLeave(r, { centre: o.centre, now: o.now, better, blocked, gone }, s)) return step(was!, o.centre, circuit, 'to');
    const place = nextPlace(r, pickArgs, s);
    r.place = place;
    if (!place) return null;
    r.since = o.now;
    r.until = o.now + s.giveUpMs + dist(o.centre, place) / s.giveUpSpeed * 1000;
    const how = !was ? 'to' : reached ? `past ${was.what}, on to` : gaveUp ? `gave up on ${was.what}, on to` : gone ? `${was.what} closed, on to` : isCall(place) && !isCall(was) ? 'turning for' : isSighting(place) && !isSighting(was) ? 'turning for' : inSpent(was) ? 'moving on from where we fought, to' : 'keeping off the group we ran from, to';
    return step(place, o.centre, circuit, how);
}

function step(place: RoamPlace, centre: Point, circuit: readonly PlayerRealm[], how: string): RoamStep {
    const side = place.side && circuit.length ? `, ${place.side === circuit[0] ? 'our' : `${place.side}'s`} side` : '';
    return { goal: place, place, reason: `roam: ${how} ${place.what}${side} (${Math.round(place.x)}, ${Math.round(place.y)}), ${Math.round(dist(centre, place))} away` };
}

/** Keep `p` usable as a roam place: dry, level enough and clear of camps and keeps (by `dangers`). */
export const placeOk = (dangers: readonly Danger[], dry: (p: Point) => boolean) => (p: Point) => clearOf(p, dangers, 900) && dry(p);
