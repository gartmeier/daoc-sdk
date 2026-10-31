// Where a caster or healer stands during a fight. Pure geometry; position() in
// behaviors.ts reads the picture and walks.
//
// The rule is limits, not a band to centre in: a member moves only when it is outside
// its role's [min, max] from the fight (TacticsSettings.combatRange, narrowed by the
// spell it casts: effectiveLimits). Inside them nobody moves.
//  - out: a danger stop (dangerStops) is closer than min, so a mob could reach us before
//    the cast lands. Step to min + 200 from that stop.
//  - in: the focus is settled on the tank (focusSettled) and farther than max (3D, which
//    is what the server checks). Step to max - 150 from it.
// The step goes along our own bearing from the stop or focus, so a member never crosses
// the fight. When that spot is in an aggressive mob's reach (safeSpot), too near another
// stop or too far from the focus, it is turned about the stop or focus by ±25°, ±50° and
// ±75°; when no bearing works, the member stays (no safe spot) and casts from where it is.
//
// How position() uses it (spec D6), with mob = ctx.focus() and live = ctx.sdk.getNearbyNpc(mob.objectId):
//   const [min, max] = effectiveLimits(band, role === 'nuker' ? ctx.spells.nuke() : ctx.spells.heal());
//   const stops = dangerStops(ctx.threats(), ctx.members(), ctx.me(), now);
//   const at = live ?? mob;
//   const trail = trackFocus(ctx.memory.get('focusTrail'), mob.objectId, at, now);
//   ctx.memory.set('focusTrail', trail);
//   const settled = focusSettled({ focus: mob, at, tank: ctx.tank(), speed: live?.speed, trail, now });
//   const spot = combatSpot({ me, anchor: o.anchor, stops, focus: { x: at.x, y: at.y, d3: live?.distance ?? dist(me, at) },
//                             settled, min, max, safe: safeSpot(me.regionId, me.level, settings.aggroTolerance ?? -3) });
//   spot === null      → no move: return false (assist casts this same turn)
//   spot.to === null   → ctx.skip('position: no safe spot')
//   otherwise          → walk to spot.to; doing text `position ${spot.move} ${spot.d}→${spot.want}`

import { conLevel } from '../actions-helpers';
import { MOB_ROAM_REACH, PLAN_PADS } from './baseplan';
import { aggroZones, type Danger } from './terrain';
import type { Contact, Point } from './types';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Spell range used when the member has no spell (or it reports none). */
const DEFAULT_RANGE = 1500;
/** Stay this far inside a spell's range: positions are a snapshot old. */
const RANGE_MARGIN = 100;
/** A threat this far from the member it targets is running at that member. */
const RUNNING_AT = 260;
/** Crowd control ending within this long counts as broken already (ms). */
const CC_ENDING_MS = 3000;
/** An 'out' step goes to min + OUT_STEP; every stop must stay at least min + CLEARANCE from the spot. */
const OUT_STEP = 200, CLEARANCE = 100;
/** An 'in' step goes to max - IN_STEP; the spot must stay within that of the focus. */
const IN_STEP = 150;
/** Bearings tried, in order (degrees from our own bearing). */
const TURNS = [0, 25, -25, 50, -50, 75, -75];
/** Slack on the distance checks: a spot exactly at max - 150 must pass despite rounding. */
const EPS = 1;
/** focusSettled: within this of the tank, and moved less than SETTLE_MOVE in the last SETTLE_MS. */
const SETTLE_NEAR = 260, SETTLE_MOVE = 60, SETTLE_MS = 1000;

/**
 * A role's [min, max] from the fight, given the spell it casts (spells.nuke() for nukers,
 * spells.heal() for healers and support; null without one).
 *  - min: at least the band's, and far enough that a mob can't reach us mid-cast: melee reach
 *    200 + a mob's ~200 units/s over half the cast + 50, i.e. 250 + 100 per second of cast
 *    (Moon Blast 2.6 s: 510; Greater Revival 3.6 s: 610).
 *  - max: at most the band's, and 100 inside the spell's range (1500 without one).
 * min can exceed max for a short-range spell; combatSpot then finds no spot and the member stays.
 */
export function effectiveLimits(band: readonly [number, number], spell: { castTime: number; range: number } | null): [number, number] {
    const min = Math.max(band[0], Math.round(250 + 100 * (spell?.castTime ?? 0)));
    const max = Math.min(band[1], (spell?.range || DEFAULT_RANGE) - RANGE_MARGIN);
    return [min, max];
}

/** A point a member keeps min away from: a threat, or the member it is running at. */
export interface DangerStop extends Point {
    objectId: number;
    /** The member the threat is running at (the stop is that member's position), or null (the threat's own). */
    toward: string | null;
}

/**
 * Where the threats that could hit us will stop: for each threat that is fresh and alive, does
 * not target us (flee() handles that) and isn't held by crowd control for 3 s more, the position
 * of the member it targets when it is more than 260 from that member (running at them), else
 * its own position. `threats` is ctx.threats(), `members` ctx.members(), `me` anything with our name.
 */
export function dangerStops(threats: readonly Contact[], members: readonly { name: string; x: number; y: number }[], me: { name: string }, now: number): DangerStop[] {
    const out: DangerStop[] = [];
    for (const c of threats) {
        if (c.stale || c.hp <= 0 || c.target === me.name) continue;
        if (c.cc && c.cc.until - now >= CC_ENDING_MS) continue;
        const m = c.target ? members.find(x => x.name === c.target) : undefined;
        out.push(m && dist(c, m) > RUNNING_AT
            ? { x: m.x, y: m.y, objectId: c.objectId, toward: m.name }
            : { x: c.x, y: c.y, objectId: c.objectId, toward: null });
    }
    return out;
}

/** A step combatSpot asks for. */
export interface CombatSpot {
    /** 'out': a stop is closer than min. 'in': the settled focus is farther than max. */
    move: 'out' | 'in';
    /** Our distance now (to the stop; to the focus in 3D) and the distance the step aims for. */
    d: number;
    want: number;
    /** Where to walk, or null when no bearing is safe and within the limits (skip 'position: no safe spot'). */
    to: Point | null;
}

/**
 * Whether and where to step during a fight (rules in the header). Null when we are within
 * our limits: no move. `focus.d3` is our 3D distance to it (getNearbyNpc(id).distance);
 * `anchor` only breaks the tie when we stand exactly on a stop. Pure.
 */
export function combatSpot(o: {
    me: Point;
    anchor: Point | null;
    stops: readonly Point[];
    focus: (Point & { d3: number }) | null;
    settled: boolean;
    min: number;
    max: number;
    safe: (p: Point) => boolean;
}): CombatSpot | null {
    const { me, stops, focus, min, max } = o;
    let near: Point | null = null, dNear = Infinity;
    for (const s of stops) { const d = dist(me, s); if (d < dNear) { dNear = d; near = s; } }
    let move: CombatSpot['move'], center: Point, d: number, want: number, ux: number, uy: number;
    if (near && dNear < min) {
        move = 'out'; center = near; d = dNear; want = min + OUT_STEP;
        // On top of the stop there is no bearing: step away from the anchor, else east.
        const from = dNear >= 1 ? near : o.anchor && dist(me, o.anchor) >= 1 ? o.anchor : null;
        const len = from ? dist(me, from) : 1;
        ux = from ? (me.x - from.x) / len : 1; uy = from ? (me.y - from.y) / len : 0;
    } else if (o.settled && focus && focus.d3 > max) {
        move = 'in'; center = focus; d = focus.d3; want = max - IN_STEP;
        const len = dist(me, focus);
        ux = len >= 1 ? (me.x - focus.x) / len : 1; uy = len >= 1 ? (me.y - focus.y) / len : 0;
    } else {
        return null;
    }
    const step = { move, d: Math.round(d), want: Math.round(want) };
    for (const deg of TURNS) {
        const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
        const p = { x: center.x + (ux * cos - uy * sin) * want, y: center.y + (ux * sin + uy * cos) * want };
        if (!o.safe(p)) continue;
        if (stops.some(s => dist(p, s) < min + CLEARANCE - EPS)) continue;
        if (focus && dist(p, focus) > max - IN_STEP + EPS) continue;
        return { ...step, to: { x: Math.round(p.x), y: Math.round(p.y) } };
    }
    return { ...step, to: null };
}

const safeCache = new Map<string, (p: Point) => boolean>();

/**
 * A test for fight spots and slots: false inside the reach of an aggressive mob that cons above
 * `tolerateCon` to `level` (settings.aggroTolerance ?? -3): its aggro range plus MOB_ROAM_REACH
 * (it wanders off its spawn) plus PLAN_PADS.slot, the room the base planner keeps around slots.
 * Cached per region, level and tolerance.
 */
export function safeSpot(regionId: number, level: number, tolerateCon: number): (p: Point) => boolean {
    const key = `${regionId}:${level}:${tolerateCon}`;
    const hit = safeCache.get(key);
    if (hit) return hit;
    // Read here, not at load: baseplan imports behaviors, which imports this module.
    const zones: Danger[] = aggroZones(regionId, level, MOB_ROAM_REACH + PLAN_PADS.slot).filter(z => conLevel(level, z.level) > tolerateCon);
    const safe = (p: Point) => !zones.some(z => Math.abs(z.x - p.x) < z.r && Math.abs(z.y - p.y) < z.r && dist(z, p) < z.r);
    safeCache.set(key, safe);
    return safe;
}

/** One sample of the focus's position (memory 'focusTrail'). */
export interface TrailPoint extends Point { id: number; at: number }

/**
 * The focus's recent positions with `p` (its position now) added: points of other objects go,
 * and so do all but the newest one older than a second (focusSettled compares against it). Pure.
 */
export function trackFocus(trail: readonly TrailPoint[] | undefined, id: number, p: Point, now: number): TrailPoint[] {
    const mine = (trail ?? []).filter(t => t.id === id && t.at <= now);
    const old = mine.filter(t => now - t.at >= SETTLE_MS).at(-1);
    return [...(old ? [old] : []), ...mine.filter(t => now - t.at < SETTLE_MS), { id, x: p.x, y: p.y, at: now }];
}

/**
 * Settled: the tank is alive, the focus targets him (its kept target), stands within 260 of him,
 * and stands still on our own client (`speed` 0) or moved less than 60 in the last second (by
 * the trail). `at` is where the focus is now (our own client's, else the picture's). Only then may
 * a member step in: a running focus is no place to walk to.
 */
export function focusSettled(o: {
    focus: Pick<Contact, 'objectId' | 'target'>;
    at: Point;
    tank: { name: string; x: number; y: number; isDead?: boolean } | null | undefined;
    speed?: number | null;
    trail: readonly TrailPoint[];
    now: number;
}): boolean {
    const { tank } = o;
    if (!tank || tank.isDead || o.focus.target !== tank.name || dist(o.at, tank) >= SETTLE_NEAR) return false;
    if (o.speed === 0) return true;
    const before = o.trail.filter(t => t.id === o.focus.objectId && o.now - t.at >= SETTLE_MS).at(-1);
    return !!before && dist(before, o.at) < SETTLE_MOVE;
}
