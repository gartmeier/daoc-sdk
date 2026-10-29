// Detour navmesh queries through Bun FFI, the same native library and .nav
// files the OpenDAoC server uses (server/core/Pathing/Detour,
// GameServer/world/Pathfinding/LocalPathfindingMgr.cs).
//
// Files come from `bun run navmesh:build` (scripts/build-navmesh.ts):
//   server/navmesh/zoneNNN.nav      one mesh per zone, region-global coordinates
//   server/navmesh/lib/Detour.dll   (libDetour.so / Detour.so on Linux)
// Override with DAOC_NAVMESH_DIR and DETOUR_LIB.
//
// Detour works in Recast space: (x, z, y) / 32 (Pathing/Detour.Managed/RecastCoords.cs).
// Everything here takes and returns game units.

import { dlopen, FFIType, type Pointer } from 'bun:ffi';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Vec3 } from './types';
import { getZoneAt, getZone } from '../data/zones';

/** Poly flags baked in by buildnav (Pathing/Detour.Managed/DetourEnums.cs). */
export const PolyFlags = { Walk: 0x01, Swim: 0x02, Door: 0x04, Jump: 0x08, Disabled: 0x10, All: 0xffff } as const;

const DT_FAILURE = 1 << 31 >>> 0;
const DT_SUCCESS = 1 << 30;
const DT_PARTIAL_RESULT = 1 << 6;
const DT_STRAIGHTPATH_ALL_CROSSINGS = 0x02;
/** DetourInterface.hpp MAX_POLY: corridor and straight-path buffer size. */
const MAX_POLY = 256;
const SCALE = 1 / 32;

/** Include every poly except Disabled, exclude nothing (PathfindingMgrBase.DefaultFilters). */
const DEFAULT_FILTER = new Uint16Array([PolyFlags.All ^ PolyFlags.Disabled, 0]);
/** Server default poly-pick half extents (RecastCoords.DefaultHalfExtents): 32 across, 64 up/down. */
export const DEFAULT_EXTENTS: Vec3 = { x: 32, y: 32, z: 64 };

const ROOT = join(import.meta.dir, '..');
export const DEFAULT_NAVMESH_DIR = join(ROOT, 'server', 'navmesh');

const symbols = {
    LoadNavMesh: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.bool },
    FreeNavMesh: { args: [FFIType.ptr], returns: FFIType.bool },
    CreateNavMeshQuery: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    FreeNavMeshQuery: { args: [FFIType.ptr], returns: FFIType.bool },
    // (query, start, end, pickExt, filter, options, *count, *points, *flags)
    PathStraight: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    // (query, center, pickExt, filter, *out)
    FindClosestPoint: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    // (query, center, radius, pickExt, filter, *out)
    FindRandomPointAroundCircle: { args: [FFIType.ptr, FFIType.ptr, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    // (query, start, end, pickExt, filter, *bool, *hit)
    HasLineOfSight: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
} as const;

type DetourLib = ReturnType<typeof dlopen<typeof symbols>>['symbols'];

const libNames = process.platform === 'win32' ? ['Detour.dll'] : process.platform === 'darwin' ? ['libDetour.dylib'] : ['libDetour.so', 'Detour.so'];

/** Candidate native library paths: $DETOUR_LIB, <navmesh dir>/lib, then the CMake build output. */
export function detourLibraryCandidates(navmeshDir: string, env: Record<string, string | undefined> = process.env): string[] {
    const build = join(ROOT, 'server', 'core', 'Pathing', 'Detour', 'Build');
    return [
        ...(env.DETOUR_LIB ? [env.DETOUR_LIB] : []),
        ...libNames.map(n => join(navmeshDir, 'lib', n)),
        ...libNames.flatMap(n => [join(build, 'Release', n), join(build, n)]),
    ];
}

const toRecast = (p: Vec3, out: Float32Array, at = 0): Float32Array => {
    out[at] = p.x * SCALE;
    out[at + 1] = p.z * SCALE;
    out[at + 2] = p.y * SCALE;
    return out;
};
const fromRecast = (a: Float32Array, at = 0): Vec3 => ({ x: Math.round(a[at]! / SCALE), y: Math.round(a[at + 2]! / SCALE), z: Math.round(a[at + 1]! / SCALE) });
const ok = (status: number) => (status & DT_SUCCESS) !== 0 && (status & DT_FAILURE) === 0;

export interface NavPathPoint extends Vec3 {
    /** Poly flags at this vertex (PolyFlags: Walk, Swim, Door, Jump = ladder/off-mesh link). */
    flags: number;
}

export interface NavPath {
    /** found: reaches `end`. partial: ends at the reachable point closest to it. */
    status: 'found' | 'partial' | 'none';
    /** Straight-path vertices from start to end (or the partial end), every poly-edge crossing included so z follows the ground. */
    points: NavPathPoint[];
}

/** One loaded zoneNNN.nav with its query object. Not thread-safe; Bun runs it on the JS thread. */
export class NavMesh {
    private readonly start = new Float32Array(3);
    private readonly end = new Float32Array(3);
    private readonly ext = new Float32Array(3);
    private readonly out = new Float32Array(3);
    private readonly pathPts = new Float32Array(MAX_POLY * 3);
    private readonly pathFlags = new Uint16Array(MAX_POLY);
    private readonly count = new Int32Array(1);
    private readonly losFlag = new Uint8Array(1);
    private disposed = false;

    constructor(private readonly lib: DetourLib, private mesh: Pointer, private query: Pointer, readonly zoneId: number | null, readonly file: string) {}

    /**
     * Nearest point on the mesh within `halfExtents` of `p` (game units; z is up/down).
     * Detour picks the poly nearest to `p`, so a tall box still prefers the floor closest to p.z.
     */
    closestPoint(p: Vec3, halfExtents: Vec3 = DEFAULT_EXTENTS): Vec3 | null {
        this.check();
        const s = this.lib.FindClosestPoint(this.query, toRecast(p, this.start), toRecast(halfExtents, this.ext), DEFAULT_FILTER, this.out);
        return ok(s) ? fromRecast(this.out) : null;
    }

    /** Straight path between two points that are already on (or within the default extents of) the mesh. */
    findPath(start: Vec3, end: Vec3, halfExtents: Vec3 = DEFAULT_EXTENTS): NavPath {
        this.check();
        this.count[0] = 0;
        const s = this.lib.PathStraight(this.query, toRecast(start, this.start), toRecast(end, this.end), toRecast(halfExtents, this.ext),
            DEFAULT_FILTER, DT_STRAIGHTPATH_ALL_CROSSINGS, this.count, this.pathPts, this.pathFlags);
        const n = Math.min(this.count[0]!, MAX_POLY);
        if (!ok(s) || n === 0) return { status: 'none', points: [] };
        const points: NavPathPoint[] = [];
        for (let i = 0; i < n; i++) points.push({ ...fromRecast(this.pathPts, i * 3), flags: this.pathFlags[i]! });
        return { status: s & DT_PARTIAL_RESULT ? 'partial' : 'found', points };
    }

    /** Random reachable point within `radius` of `center` (center must be on the mesh). */
    randomPoint(center: Vec3, radius: number, halfExtents: Vec3 = DEFAULT_EXTENTS): Vec3 | null {
        this.check();
        const s = this.lib.FindRandomPointAroundCircle(this.query, toRecast(center, this.start), radius * SCALE, toRecast(halfExtents, this.ext), DEFAULT_FILTER, this.out);
        return ok(s) ? fromRecast(this.out) : null;
    }

    /**
     * Walkability raycast along the mesh surface from `start` towards `end` (2D, like dtNavMeshQuery::raycast).
     * `clear` is true when nothing blocks the straight walk; `hit` is where it stops otherwise.
     * This is not visual line of sight: it ignores height and stops at mesh edges (walls, cliffs, water borders).
     */
    raycast(start: Vec3, end: Vec3, halfExtents: Vec3 = DEFAULT_EXTENTS): { clear: boolean; hit: Vec3 } | null {
        this.check();
        this.losFlag[0] = 0;
        const s = this.lib.HasLineOfSight(this.query, toRecast(start, this.start), toRecast(end, this.end), toRecast(halfExtents, this.ext), DEFAULT_FILTER, this.losFlag, this.out);
        return ok(s) ? { clear: this.losFlag[0] !== 0, hit: fromRecast(this.out) } : null;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.lib.FreeNavMeshQuery(this.query);
        this.lib.FreeNavMesh(this.mesh);
    }

    private check(): void {
        if (this.disposed) throw new Error(`navmesh ${this.file} was disposed`);
    }
}

export interface NavmeshStoreOptions {
    /** Folder with zoneNNN.nav (default $DAOC_NAVMESH_DIR or server/navmesh). */
    dir?: string;
    /** Native library path (default: detourLibraryCandidates). */
    library?: string;
}

/** Lazily loads one NavMesh per zone; a zone's first query loads its file (tens of MB, ~0.1-1 s). */
export class NavmeshStore {
    readonly dir: string;
    private lib: DetourLib | null | undefined;
    private libError = '';
    private readonly libPath: string | undefined;
    private readonly meshes = new Map<number, NavMesh | null>();
    private zoneFiles: Set<number> | null = null;

    constructor(opts: NavmeshStoreOptions = {}) {
        this.dir = opts.dir ?? process.env.DAOC_NAVMESH_DIR ?? DEFAULT_NAVMESH_DIR;
        this.libPath = opts.library;
    }

    /** Zone ids that have a zoneNNN.nav file (scanned once). */
    zones(): Set<number> {
        if (!this.zoneFiles) {
            this.zoneFiles = new Set();
            if (existsSync(this.dir)) {
                for (const f of readdirSync(this.dir)) {
                    const m = /^zone(\d{3,})\.nav$/.exec(f);
                    if (m) this.zoneFiles.add(Number(m[1]));
                }
            }
        }
        return this.zoneFiles;
    }

    /** True when the native library loads and at least one .nav file exists. */
    available(): boolean {
        return this.zones().size > 0 && this.library() !== null;
    }

    /** Why available() is false ('' when it is true). */
    unavailableReason(): string {
        if (this.zones().size === 0) return `no zoneNNN.nav files in ${this.dir} (run: bun run navmesh:build)`;
        return this.library() === null ? this.libError : '';
    }

    hasZone(zoneId: number): boolean {
        return this.zones().has(zoneId);
    }

    /** The zone's mesh, loading it on first use; null without a file or library. */
    forZone(zoneId: number): NavMesh | null {
        const cached = this.meshes.get(zoneId);
        if (cached !== undefined) return cached;
        const lib = this.hasZone(zoneId) ? this.library() : null;
        const mesh = lib ? this.load(lib, join(this.dir, `zone${String(zoneId).padStart(3, '0')}.nav`), zoneId) : null;
        this.meshes.set(zoneId, mesh);
        return mesh;
    }

    /** The mesh of the zone containing (x, y) in a region. */
    at(regionId: number, x: number, y: number): NavMesh | null {
        const zone = getZoneAt(regionId, x, y);
        return zone ? this.forZone(zone.id) : null;
    }

    /** Load any .nav file (e.g. the Detour test mesh) outside the zone cache. */
    loadFile(file: string): NavMesh | null {
        const lib = this.library();
        return lib ? this.load(lib, file, null) : null;
    }

    dispose(): void {
        for (const m of this.meshes.values()) m?.dispose();
        this.meshes.clear();
    }

    private load(lib: DetourLib, file: string, zoneId: number | null): NavMesh | null {
        const meshOut = new BigUint64Array(1);
        if (!lib.LoadNavMesh(Buffer.from(`${file}\0`, 'utf8'), meshOut) || meshOut[0] === 0n) return null;
        const mesh = Number(meshOut[0]) as Pointer;
        const queryOut = new BigUint64Array(1);
        if (!lib.CreateNavMeshQuery(mesh, queryOut) || queryOut[0] === 0n) {
            lib.FreeNavMesh(mesh);
            return null;
        }
        return new NavMesh(lib, mesh, Number(queryOut[0]) as Pointer, zoneId, file);
    }

    private library(): DetourLib | null {
        if (this.lib !== undefined) return this.lib;
        const candidates = this.libPath ? [this.libPath] : detourLibraryCandidates(this.dir);
        const path = candidates.find(p => existsSync(p));
        if (!path) {
            this.libError = `Detour library not found (tried ${candidates.join(', ')}; run: bun run navmesh:build)`;
            return (this.lib = null);
        }
        try {
            this.lib = dlopen(path, symbols).symbols;
        } catch (error) {
            this.libError = `cannot load ${path}: ${error instanceof Error ? error.message : error}`;
            this.lib = null;
        }
        return this.lib;
    }
}

let sharedStore: NavmeshStore | null = null;

/** Process-wide store over the default navmesh dir (meshes stay loaded once used). */
export function getNavmeshStore(): NavmeshStore {
    if (!sharedStore) sharedStore = new NavmeshStore();
    return sharedStore;
}

/** Name of a zone id for messages. */
export const zoneLabel = (zoneId: number) => `zone ${zoneId}${getZone(zoneId) ? ` (${getZone(zoneId)!.name})` : ''}`;
