// Path providers for bot.walkTo.
//
// OpenDAoC never validates walls or Z for player movement (only 2D speed,
// docs/research/daoc-world-gameplay.md §3.4-3.5), and no navmeshes ship with
// the server, so the default provider walks straight lines. Long legs are
// split so Z can follow the terrain estimate from static spawn data.

import type { Vec3 } from './types';
import { estimateZ } from '../data/index';

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
 * TODO: Detour navmesh routing (Bun FFI to a self-built Detour library plus
 * user-generated zoneNNN.nav files, see docs/research/daoc-world-gameplay.md §5).
 * Until then it reports failure so callers fall back to straight lines.
 */
export class NavmeshPathProvider implements PathProvider {
    readonly name = 'navmesh';
    findPath(_request: PathRequest): PathResult {
        return { success: false, waypoints: [], message: 'navmesh pathing is not implemented (no .nav files ship with OpenDAoC)' };
    }
}

let defaultProvider: PathProvider | null = null;

/** The provider walkTo uses when none is passed (StraightLinePathProvider by default). */
export function getDefaultPathProvider(): PathProvider {
    if (!defaultProvider) defaultProvider = new StraightLinePathProvider();
    return defaultProvider;
}

export function setDefaultPathProvider(provider: PathProvider | null): void {
    defaultProvider = provider;
}
