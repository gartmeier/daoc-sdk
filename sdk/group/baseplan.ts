// Where a group's base goes: next to the monsters the tank can pull safely, instead of a
// fixed clearance from every spawn (chooseBase). From static spawn data; decidePve uses it
// when `basePlan` is on.
//
// Server rules it follows (OpenDAoC StandardMobBrain, GameNPC):
//  - A mob calls friends (bring-a-friend) once per fight, at its own spot when it first
//    targets someone, and only when it was hit and has a faction (BringFriends). A body-pulled
//    mob fought at the base calls nobody there, so passive spawns need no room from the base.
//  - An aggressive mob aggroes on players within its aggro range (mostly 500) of where it
//    stands, wanders around its spawn (RoamingRange 200 for most Lough Derg mobs, but the navmesh
//    roam overshoots to ~500: MOB_ROAM_REACH) and doesn't seek players beyond that. It only
//    aggroes on players it doesn't con grey to (CanAggroTarget).
// So a base keeps every slot of the formation out of aggressive reach, the tank's walk to
// each target and back stays out of it, and a target whose spot is in reach isn't pulled.

import { findNpcSpawns } from '../../data/index';
import { conLevel } from '../actions-helpers';
import { navmeshGroundZ } from '../pathfinding';
import { formationOffset, type TacticsSettings } from './behaviors';
import type { Point, Point3, Role } from './types';

/**
 * How far from its spawn a roaming mob can stand. Most spawns have RoamingRange 200, but the
 * server picks roam points with Detour findRandomPointAroundCircle, which returns any point of a
 * polygon touching that circle: sampled around Lough Derg's aggressive spawns, p99 407-561, max 616
 * (review of the first base planner; it assumed 250, and lucradans walked into the base twice).
 */
export const MOB_ROAM_REACH = 500;
/** Where a target may stand when the tank reaches it (the live pull check sees its real spot). */
export const TARGET_ROAM = 300;

/** Extra room beyond an aggressive mob's reach: for a target's spot, the walk to it, a formation slot, and the tank's fight spot. */
export const PLAN_PADS = { stand: 100, path: 100, slot: 150, fight: 300 };
/** Formation slots keep this far from every spawn (no caster resting on a monster's spawn point). */
export const SPAWN_PAD = 300;

export interface PlanSpawn { name: string; x: number; y: number; z: number; level: number; aggroLevel: number; aggroRange: number; flags: number }

export interface BasePlan {
    base: Point3;
    /** Where the group faces: the centre of the nearest safe targets. */
    facing: Point;
    /** Pullable spawns that are safe from this base, nearest first. */
    targets: (PlanSpawn & { d: number })[];
    /** Pullable spawns that aren't, and why ("stand: wild lucradan 873", "path: badger 640"). */
    unsafe: (PlanSpawn & { why: string })[];
    /** Mean distance to the nearest `targets` safe spawns (huntRadius for missing ones). */
    score: number;
    /** Smallest distance from a formation slot to the edge of an aggressive mob's reach. */
    margin: number;
}

export interface BasePlanOptions {
    level: number;
    minCon: number;
    maxCon: number;
    /** Aggressive spawns count as targets too. */
    pullAggressive: boolean;
    /** The tank pulls targets within this distance of the base. */
    huntRadius: number;
    /** One entry per member: their formation slots must be safe. */
    roles: Role[];
    formation: TacticsSettings['formation'];
    /** Pullable spawns within this of the camp centre (default 3500). */
    campRadius?: number;
    /** Score a base by the mean distance to this many nearest safe targets (default 6) ... */
    targets?: number;
    /** ... and require at least this many (default 3). */
    minTargets?: number;
    /** Grid step for candidate bases (default 100). */
    step?: number;
    /** No base within 2500 of these (camps given up on). */
    avoid?: Point[];
    /** Aggressive mobs at or below this con to `level` are welcome walk-ins, not obstacles (default -3: only grey ones, which never aggro). */
    tolerateCon?: number;
}

/** How far an aggressive mob can reach from its spawn point. */
export const aggroReach = (s: { aggroRange: number }) => s.aggroRange + MOB_ROAM_REACH;

/** Aggressive and not grey to `level` (the same test as aggroZones). */
export const isAggressiveTo = (s: PlanSpawn, level: number) =>
    s.aggroLevel > 0 && s.aggroRange > 0 && !(s.flags & 0x10) && conLevel(level, s.level) > -3;

/** Distance from p to the segment a-b. */
export function segDist(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The best base for `camp` from these spawns (realm 0, any distance), or null when no spot has minTargets safe targets. Pure. */
export function planBaseFrom(spawns: PlanSpawn[], camp: Point3, o: BasePlanOptions): BasePlan | null {
    const campRadius = o.campRadius ?? 3500, nTargets = o.targets ?? 6, minTargets = o.minTargets ?? 3, step = o.step ?? 100;
    const live = spawns.filter(s => !(s.flags & 0x10));
    const aggressive = live.filter(s => isAggressiveTo(s, o.level) && conLevel(o.level, s.level) > (o.tolerateCon ?? -3)).map(s => ({ s, reach: aggroReach(s) }));
    const nearestAggro = (p: Point, pad: number) => aggressive.find(a => a.s !== p && dist(a.s, p) < a.reach + pad);

    // Pullable spawns near the camp, and those whose own spot is unsafe whatever the base.
    const unsafeSpots: (PlanSpawn & { why: string })[] = [];
    const candidates: PlanSpawn[] = [];
    for (const s of live) {
        if (dist(s, camp) > campRadius || s.name !== s.name.toLowerCase() || /new mob|ambient/.test(s.name)) continue;
        const con = conLevel(o.level, s.level);
        if (con < o.minCon || con > o.maxCon) continue;
        // Aggressive targets only with pullAggressive, and only up to the tolerated con (orange and up are obstacles).
        if (isAggressiveTo(s, o.level) && (!o.pullAggressive || con > (o.tolerateCon ?? -3))) { unsafeSpots.push({ ...s, why: 'aggressive' }); continue; }
        // The tank hits it wherever it has roamed to.
        const a = nearestAggro(s, TARGET_ROAM + PLAN_PADS.stand);
        if (a) { unsafeSpots.push({ ...s, why: `stand: ${a.s.name} ${Math.round(dist(a.s, s))}` }); continue; }
        candidates.push(s);
    }
    if (candidates.length < minTargets) return null;

    const xs = candidates.map(c => c.x), ys = candidates.map(c => c.y);
    const x0 = Math.min(...xs) - 1500, x1 = Math.max(...xs) + 1500, y0 = Math.min(...ys) - 1500, y1 = Math.max(...ys) + 1500;
    // Same-role index per member, for the formation offsets.
    const seen = new Map<Role, number>();
    const members = o.roles.map(role => { const i = seen.get(role) ?? 0; seen.set(role, i + 1); return { role, i }; });

    let best: BasePlan | null = null;
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
            const b = { x, y };
            if (o.avoid?.some(a => dist(a, b) < 2500)) continue;
            const near = candidates.map(c => ({ c, d: dist(b, c) })).filter(n => n.d <= o.huntRadius).sort((p, q) => p.d - q.d);
            if (near.length < minTargets) continue;
            // The tank fights the pulled mob here.
            if (aggressive.some(a => dist(a.s, b) < a.reach + PLAN_PADS.fight)) continue;
            // The walk to each target and back.
            const safe: (PlanSpawn & { d: number })[] = [];
            const blocked: (PlanSpawn & { why: string })[] = [];
            for (const n of near) {
                const a = aggressive.find(a => segDist(a.s, b, n.c) < a.reach + PLAN_PADS.path);
                if (a) blocked.push({ ...n.c, why: `path: ${a.s.name} ${Math.round(segDist(a.s, b, n.c))}` });
                else safe.push({ ...n.c, d: Math.round(n.d) });
            }
            if (safe.length < minTargets) continue;
            let score = 0;
            for (let i = 0; i < nTargets; i++) score += safe[i]?.d ?? o.huntRadius;
            score /= nTargets;
            if (best && score > best.score) continue;
            // The formation faces the nearest safe targets: the facing decidePve orders, checked as formationSlot places members.
            const sf = safe.slice(0, nTargets);
            const facing = { x: Math.round(sf.reduce((t, s) => t + s.x, 0) / sf.length), y: Math.round(sf.reduce((t, s) => t + s.y, 0) / sf.length) };
            const away = dist(b, facing) > 1 ? Math.atan2(b.y - facing.y, b.x - facing.x) : 0;
            let margin = Infinity, ok = true;
            for (const m of members) {
                const off = formationOffset(o.formation, m.role, m.i, away);
                const slot = { x: Math.round(b.x + off.x), y: Math.round(b.y + off.y) };
                for (const a of aggressive) {
                    const room = dist(a.s, slot) - a.reach;
                    if (room < PLAN_PADS.slot) { ok = false; break; }
                    margin = Math.min(margin, room);
                }
                if (!ok || live.some(s => Math.abs(s.x - slot.x) < SPAWN_PAD && Math.abs(s.y - slot.y) < SPAWN_PAD && dist(s, slot) < SPAWN_PAD)) { ok = false; break; }
            }
            if (!ok || (best && score === best.score && margin <= best.margin)) continue;
            best = { base: { x, y, z: camp.z }, facing, targets: safe, unsafe: [...unsafeSpots, ...blocked], score: Math.round(score), margin: Math.round(margin) };
        }
    }
    return best;
}

/** planBaseFrom over the region's spawns around `camp`, with the base's height from the navmesh where there is one. */
export function planBase(regionId: number, camp: Point3, o: BasePlanOptions): BasePlan | null {
    const radius = (o.campRadius ?? 3500) + o.huntRadius + 3000;
    const plan = planBaseFrom(findNpcSpawns({ regionId, realm: 0, near: camp, radius, limit: 20_000 }), camp, o);
    if (plan) plan.base.z = navmeshGroundZ(regionId, plan.base.x, plan.base.y, camp.z) ?? camp.z;
    return plan;
}

/** Why a live monster shouldn't be pulled under this plan (its spawn is unsafe), or null: its spawn is a safe target or unknown. */
export function planRejects(plan: BasePlan, c: { name: string; x: number; y: number }): string | null {
    let best: { why: string | null } | null = null, bestD = MOB_ROAM_REACH + 100;
    for (const s of plan.targets) { const d = dist(s, c); if (s.name === c.name && d < bestD) { bestD = d; best = { why: null }; } }
    for (const s of plan.unsafe) { const d = dist(s, c); if (s.name === c.name && d < bestD) { bestD = d; best = { why: s.why }; } }
    return best?.why ? `unsafe spawn (${best.why})` : null;
}
