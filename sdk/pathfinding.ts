// Path providers for bot.walkTo.
//
// OpenDAoC never validates walls or Z for player movement (only 2D speed,
// docs/research/daoc-world-gameplay.md §3.4-3.5). No navmeshes ship with the
// server; once `bun run navmesh:build` has generated them from a local client
// install, the default provider routes over them (NavmeshPathProvider, sdk/navmesh.ts).
// Without them it walks straight lines, split so Z can follow the terrain
// estimate from static spawn data.

import type { Vec3 } from './types';
import { estimateZ } from '../data/index';
import { getZoneAt, type ZoneInfo } from '../data/zones';
import { DEFAULT_EXTENTS, getNavmeshStore, PolyFlags, zoneLabel, type NavMesh, type NavmeshStore, type NavPathPoint } from './navmesh';

export interface PathRequest {
    regionId: number;
    from: Vec3;
    to: { x: number; y: number; z?: number };
}

export interface PathResult {
    success: boolean;
    /** Waypoints after `from`, ending at the destination. */
    waypoints: Vec3[];
    message?: string;
    /** Why there is no route, when the caller can act on it: 'door' = a shut door (NavMesh.setDoorBlocking) is in the way. */
    reason?: 'door';
}

/** Pluggable route planner for walkTo / travel. */
export interface PathProvider {
    readonly name: string;
    findPath(request: PathRequest): PathResult | Promise<PathResult>;
}

/** Ground height lookup: (region, x, y) → z or null. */
export type ZEstimator = (regionId: number, x: number, y: number) => number | null;

/** data/index.ts estimateZ (its first call builds an index from ~100k spawns, ~100 ms). */
export const dataZEstimator: ZEstimator = (regionId, x, y) => estimateZ(regionId, x, y);

export interface StraightLineOptions {
    /** Max leg length before a waypoint is inserted (default 1000 units, ~5 s of running). */
    maxSegment?: number;
    /** Ground height for inserted waypoints and a destination without z (default: data estimateZ). Pass null to interpolate only. */
    estimateZ?: ZEstimator | null;
    /** Ignore an intermediate estimate more than this far from the straight interpolation (default 600). */
    maxZDeviation?: number;
}

/** Straight line from → to, split every `maxSegment` units, z from the estimator (else interpolated). */
export class StraightLinePathProvider implements PathProvider {
    readonly name = 'straight-line';
    private readonly maxSegment: number;
    private readonly estimator: ZEstimator | null;
    private readonly maxZDeviation: number;

    constructor(opts: StraightLineOptions = {}) {
        this.maxSegment = Math.max(50, opts.maxSegment ?? 1000);
        this.estimator = opts.estimateZ === undefined ? dataZEstimator : opts.estimateZ;
        this.maxZDeviation = opts.maxZDeviation ?? 600;
    }

    findPath({ regionId, from, to }: PathRequest): PathResult {
        if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) {
            return { success: false, waypoints: [], message: 'non-finite coordinates' };
        }
        const estimate = (x: number, y: number, fallback: number): number => {
            const z = this.estimator?.(regionId, x, y);
            return z === null || z === undefined || !Number.isFinite(z) || Math.abs(z - fallback) > this.maxZDeviation ? fallback : Math.round(z);
        };
        const endEstimate = to.z === undefined ? this.estimator?.(regionId, to.x, to.y) : null;
        const endZ = to.z ?? (endEstimate !== null && endEstimate !== undefined && Number.isFinite(endEstimate) ? Math.round(endEstimate) : from.z);
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const legs = Math.max(1, Math.ceil(length / this.maxSegment));
        const waypoints: Vec3[] = [];
        for (let i = 1; i < legs; i++) {
            const f = i / legs;
            const x = Math.round(from.x + (to.x - from.x) * f);
            const y = Math.round(from.y + (to.y - from.y) * f);
            waypoints.push({ x, y, z: estimate(x, y, Math.round(from.z + (endZ - from.z) * f)) });
        }
        waypoints.push({ x: to.x, y: to.y, z: endZ });
        return { success: true, waypoints };
    }
}

/**
 * Escalating poly-pick boxes for points whose z is a guess (bot z, estimateZ): server default
 * first, then taller (x/y is known, z may be off by hundreds), then wider for points off the mesh.
 */
const SNAP_EXTENTS: Vec3[] = [DEFAULT_EXTENTS, { x: 32, y: 32, z: 512 }, { x: 32, y: 32, z: 4000 }, { x: 128, y: 128, z: 4000 }, { x: 512, y: 512, z: 4000 }];
/** Pathfinder.TryGetZoneExitPoint: exit/entry points sit 8 units off the border, snapped within 128 x 128 x 4000. */
const BORDER_MARGIN = 8;
const BORDER_SNAP: Vec3 = { x: 128, y: 128, z: 4000 };
/** chain(): max Detour queries per leg (256 polys each, far more than a zone crossing needs). */
const MAX_CHAIN = 128;
/** chain(): a partial query ending this close to the leg start or an earlier end made no progress. */
const CHAIN_STALL = 4;
/** The door a route through shut doors passes, named in the message: a shut door within this of one of its points. */
const SHUT_DOOR_NEAR = 300;
/**
 * chain() weighs a way through water by run speed over swim speed: 191 against a real client's 85 at 100 % with no water
 * speed (client/movement.ts PLAYER_BASE_SWIM_SPEED). A dry way round is taken while it is no slower than that.
 */
const SWIM_COST = 191 / 85;

/** Length of a Detour path in run-speed units, its stretches in water (a segment starting on a Swim poly) at SWIM_COST. */
function pathCost(points: readonly NavPathPoint[]): { cost: number; swims: boolean } {
    let cost = 0, swims = false;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!;
        const wet = (a.flags & PolyFlags.Swim) !== 0;
        swims ||= wet;
        cost += Math.hypot(b.x - a.x, b.y - a.y) * (wet ? SWIM_COST : 1);
    }
    return { cost, swims };
}

function snapToMesh(mesh: NavMesh, p: Vec3): Vec3 | null {
    for (const ext of SNAP_EXTENTS) {
        const hit = mesh.closestPoint(p, ext);
        if (hit) return hit;
    }
    return null;
}

/** Ground height from the zone's navmesh nearest to `zHint` (default: data estimateZ), or null without a mesh there. */
export function navmeshGroundZ(regionId: number, x: number, y: number, zHint?: number, store: NavmeshStore = getNavmeshStore()): number | null {
    const mesh = store.at(regionId, x, y);
    if (!mesh) return null;
    const z = zHint ?? estimateZ(regionId, x, y) ?? 0;
    return snapToMesh(mesh, { x, y, z })?.z ?? null;
}

/** Navmesh first, then data estimateZ: the z estimator for straight legs off the mesh. */
export const navmeshThenDataZEstimator: ZEstimator = (regionId, x, y) => navmeshGroundZ(regionId, x, y) ?? estimateZ(regionId, x, y);

/** Drop vertices a straight 2D leg would pass anyway: < ~2° turn and z within `zTolerance` of the chord. */
export function simplifyPath(points: Vec3[], zTolerance = 16): Vec3[] {
    if (points.length <= 2) return points.slice();
    const out: Vec3[] = [points[0]!];
    for (let i = 1; i < points.length - 1; i++) {
        const a = out[out.length - 1]!, b = points[i]!, c = points[i + 1]!;
        const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y;
        const ab = Math.hypot(abx, aby), bc = Math.hypot(bcx, bcy);
        if (ab < 1 || bc < 1) { out.push(b); continue; } // vertical hop (ladder link): keep both ends
        const straight = (abx * bcx + aby * bcy) / (ab * bc) > Math.cos(Math.PI / 90);
        const zOnChord = a.z + (c.z - a.z) * (ab / (ab + bc));
        if (!straight || Math.abs(b.z - zOnChord) > zTolerance) out.push(b);
    }
    out.push(points[points.length - 1]!);
    return out;
}

export interface NavmeshOptions {
    /** Loaded meshes (default: the shared store over server/navmesh). */
    store?: NavmeshStore;
    /** Used where a zone has no mesh, or for the rest of a partial path (default: straight lines, z from navmesh then data). */
    fallback?: PathProvider;
    /** Max zone borders one path may cross (default 6). */
    maxZoneHops?: number;
}

/**
 * Detour routing over the zoneNNN.nav meshes from `bun run navmesh:build`.
 * Mirrors the server's Pathfinder: one mesh per zone, zone borders crossed at the
 * straight-line border point (snapped onto both meshes), long corridors chained
 * past Detour's 256-poly limit. Points with a guessed z are snapped with growing boxes.
 *
 * Where there is no mesh, or the destination is off the mesh / unreachable, the rest
 * of the route is the fallback's straight line (the server never blocks player
 * movement, so a bot still arrives); `message` then says so.
 */
export class NavmeshPathProvider implements PathProvider {
    readonly name = 'navmesh';
    readonly store: NavmeshStore;
    private readonly fallback: PathProvider;
    private readonly maxZoneHops: number;

    constructor(opts: NavmeshOptions = {}) {
        this.store = opts.store ?? getNavmeshStore();
        this.fallback = opts.fallback ?? new StraightLinePathProvider({ estimateZ: navmeshThenDataZEstimator });
        this.maxZoneHops = opts.maxZoneHops ?? 6;
    }

    async findPath(request: PathRequest): Promise<PathResult> {
        const { regionId, from, to } = request;
        if (![from.x, from.y, from.z, to.x, to.y].every(Number.isFinite)) {
            return { success: false, waypoints: [], message: 'non-finite coordinates' };
        }
        if (!this.store.available()) return this.straight(request, `no navmesh: ${this.store.unavailableReason()}; straight line`);
        const startZone = getZoneAt(regionId, from.x, from.y);
        if (!startZone) return this.straight(request, `(${from.x}, ${from.y}) is in no zone of region ${regionId}; straight line`);
        const startMesh = this.store.forZone(startZone.id);
        if (!startMesh) {
            const why = this.store.loadError(startZone.id) ?? 'no mesh';
            return this.straight(request, `no navmesh for ${zoneLabel(startZone.id)} (${why}); straight line`);
        }
        const start = snapToMesh(startMesh, from);
        if (!start) return this.straight(request, `start (${from.x}, ${from.y}) is off the navmesh of ${zoneLabel(startZone.id)}; straight line`);

        const endZone = getZoneAt(regionId, to.x, to.y);
        const endMesh = endZone ? this.store.forZone(endZone.id) : null;
        const zHint = to.z ?? estimateZ(regionId, to.x, to.y) ?? from.z;
        const endOnMesh = endMesh ? snapToMesh(endMesh, { x: to.x, y: to.y, z: zHint }) : null;
        const finalZ = to.z ?? endOnMesh?.z ?? Math.round(zHint);

        const pts: Vec3[] = [start];
        let cur = start;
        let mesh = startMesh;
        let note = '';
        for (let hop = 0; ; hop++) {
            const zone = getZoneAt(regionId, cur.x, cur.y);
            if (endZone && zone && zone.id === endZone.id) {
                if (endOnMesh) {
                    const leg = this.chain(mesh, cur, endOnMesh);
                    pts.push(...leg.points.slice(1));
                    if (!leg.reached) {
                        // A shut door (NavMesh.setDoorBlocking) in the way: the route ends, no straight line through the door, which the
                        // server lets a player walk and a real client cannot (2026-11-13: our raiders passed the Faste's shut doors).
                        const door = this.shutDoorInTheWay(mesh, cur, endOnMesh);
                        if (door) return { success: false, waypoints: [], message: `a shut door at (${door.x}, ${door.y}) is in the way: the navmesh reaches (${pts.at(-1)!.x}, ${pts.at(-1)!.y}), ${dist2(pts.at(-1)!, to)} units short`, reason: 'door' };
                        note = `navmesh reaches (${pts.at(-1)!.x}, ${pts.at(-1)!.y}), ${dist2(pts.at(-1)!, to)} units short; straight from there`;
                    }
                } else {
                    note = `destination is off the navmesh of ${zoneLabel(endZone.id)}; straight from (${cur.x}, ${cur.y})`;
                }
                break;
            }
            const border = zone && hop < this.maxZoneHops ? this.crossBorder(regionId, mesh, zone, cur, to) : null;
            if (!border) {
                note = `no navmesh route across the border of ${zone ? zoneLabel(zone.id) : 'this zone'}; straight from (${cur.x}, ${cur.y})`;
                break;
            }
            const leg = this.chain(mesh, cur, border.exit);
            pts.push(...leg.points.slice(1));
            if (!leg.reached) {
                note = `navmesh stops (${dist2(pts.at(-1)!, border.exit)} units) short of the zone border; straight from there`;
                break;
            }
            pts.push(border.entry);
            cur = border.entry;
            mesh = border.mesh;
        }

        const waypoints = simplifyPath(pts).slice(1);
        const last = waypoints.at(-1) ?? start;
        if (note) {
            const rest = await this.fallback.findPath({ regionId, from: last, to: { x: to.x, y: to.y, z: finalZ } });
            if (!rest.success) return rest;
            waypoints.push(...rest.waypoints);
        } else if (waypoints.length === 0 || last.x !== to.x || last.y !== to.y || last.z !== finalZ) {
            // Snapping moved the end onto the mesh (or the leg was zero-length): finish at the exact requested point.
            if (dist2(last, to) < 1) waypoints.pop();
            waypoints.push({ x: to.x, y: to.y, z: finalZ });
        }
        return { success: true, waypoints, ...(note ? { message: note } : {}) };
    }

    /** The fallback's straight line for the whole request, with `note` saying why. */
    private async straight(request: PathRequest, note: string): Promise<PathResult> {
        const r = await this.fallback.findPath(request);
        return r.success ? { ...r, message: r.message ? `${note}; ${r.message}` : note } : r;
    }

    /**
     * The way from `start` to `end` on this mesh: the shortest, unless it swims and a way with no water at all is no slower
     * (SWIM_COST). Detour weighs every poly alike, so a straight line across a river bend beat the bank round it.
     */
    private chain(mesh: NavMesh, start: Vec3, end: Vec3): { points: Vec3[]; reached: boolean } {
        const any = this.chainWith(mesh, start, end, 0);
        if (!any.reached || !any.swims) return any;
        const dry = this.chainWith(mesh, start, end, PolyFlags.Swim);
        return dry.reached && dry.cost <= any.cost ? dry : any;
    }

    /** When some door here is shut: the shut door a route through the shut doors would pass, if that route reaches `end`; else null. */
    private shutDoorInTheWay(mesh: NavMesh, start: Vec3, end: Vec3): Vec3 | null {
        if (!mesh.hasShutDoors()) return null;
        const through = this.chainWith(mesh, start, end, 0, true);
        if (!through.reached) return null;
        for (const p of through.points) {
            const d = mesh.shutDoorNear(p, SHUT_DOOR_NEAR);
            if (d) return d;
        }
        return null;
    }

    /** Chains Detour queries past the 256-poly corridor limit until `end` is reached or progress stops, leaving out polys with `exclude`. */
    private chainWith(mesh: NavMesh, start: Vec3, end: Vec3, exclude: number, throughShutDoors = false): { points: Vec3[]; reached: boolean; cost: number; swims: boolean } {
        const points: Vec3[] = [start];
        const ends: Vec3[] = [start];
        let cur = start;
        let cost = 0, swims = false;
        for (let i = 0; i < MAX_CHAIN; i++) {
            const path = mesh.findPath(cur, end, DEFAULT_EXTENTS, exclude, throughShutDoors);
            if (path.status === 'none' || path.points.length === 0) return { points, reached: false, cost, swims };
            const c = pathCost(path.points);
            cost += c.cost;
            swims ||= c.swims;
            for (const p of path.points.slice(1)) points.push({ x: p.x, y: p.y, z: p.z });
            const last = points[points.length - 1]!;
            if (path.status === 'found') return { points, reached: true, cost, swims };
            // Partial: the first 256 polys of the best corridor, which may lead sideways before it
            // turns toward the goal. Continue while each query moves on; stop when it stalls or loops back.
            if (ends.some(e => Math.hypot(last.x - e.x, last.y - e.y, last.z - e.z) < CHAIN_STALL)) return { points, reached: false, cost, swims };
            ends.push(last);
            cur = last;
        }
        return { points, reached: false, cost, swims };
    }

    /** Where the straight line cur → to leaves the zone, snapped onto this mesh and the neighbour's. */
    private crossBorder(regionId: number, mesh: NavMesh, zone: ZoneInfo, cur: Vec3, to: { x: number; y: number }): { exit: Vec3; entry: Vec3; mesh: NavMesh } | null {
        const inZone = (x: number, y: number) => x >= zone.xOffset && x < zone.xOffset + zone.width && y >= zone.yOffset && y < zone.yOffset + zone.height;
        let ix = cur.x, iy = cur.y, ox = to.x, oy = to.y;
        while (Math.hypot(ox - ix, oy - iy) > 0.5) {
            const mx = (ix + ox) / 2, my = (iy + oy) / 2;
            if (inZone(mx, my)) { ix = mx; iy = my; } else { ox = mx; oy = my; }
        }
        const len = Math.hypot(to.x - cur.x, to.y - cur.y) || 1;
        const dx = (to.x - cur.x) / len, dy = (to.y - cur.y) / len;
        const next = getZoneAt(regionId, ox + dx * BORDER_MARGIN, oy + dy * BORDER_MARGIN);
        const nextMesh = next && next.id !== zone.id ? this.store.forZone(next.id) : null;
        if (!nextMesh) return null;
        const exit = mesh.closestPoint({ x: ix - dx * BORDER_MARGIN, y: iy - dy * BORDER_MARGIN, z: cur.z }, BORDER_SNAP);
        if (!exit) return null;
        const entry = nextMesh.closestPoint({ x: ox + dx * BORDER_MARGIN, y: oy + dy * BORDER_MARGIN, z: exit.z }, BORDER_SNAP);
        return entry ? { exit, entry, mesh: nextMesh } : null;
    }
}

const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.round(Math.hypot(a.x - b.x, a.y - b.y));

let defaultProvider: PathProvider | null = null;

/**
 * The provider walkTo uses when none is passed: NavmeshPathProvider when the Detour
 * library and at least one zoneNNN.nav are present (bun run navmesh:build), else
 * StraightLinePathProvider. DAOC_NAVMESH=off forces straight lines.
 */
export function getDefaultPathProvider(): PathProvider {
    if (!defaultProvider) {
        const off = /^(0|off|false|no)$/i.test(process.env.DAOC_NAVMESH ?? '');
        defaultProvider = !off && getNavmeshStore().available() ? new NavmeshPathProvider() : new StraightLinePathProvider();
    }
    return defaultProvider;
}

export function setDefaultPathProvider(provider: PathProvider | null): void {
    defaultProvider = provider;
}
