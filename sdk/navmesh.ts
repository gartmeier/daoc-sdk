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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Vec3 } from './types';
import { getZoneAt, getZone } from '../data/zones';

/**
 * Poly flags baked in by buildnav (Pathing/Detour.Managed/DetourEnums.cs). BlockingDoor is set at runtime on a shut door's polys
 * (NavMesh.setDoorBlocking), as the server does for its NPCs (LocalPathfindingMgr.UpdateDoorFlags): every query leaves it out.
 */
export const PolyFlags = { Walk: 0x01, Swim: 0x02, Door: 0x04, Jump: 0x08, Disabled: 0x10, BlockingDoor: 0x20, All: 0xffff } as const;

const DT_FAILURE = 1 << 31 >>> 0;
const DT_SUCCESS = 1 << 30;
const DT_PARTIAL_RESULT = 1 << 6;
const DT_STRAIGHTPATH_ALL_CROSSINGS = 0x02;
/** DetourInterface.hpp MAX_POLY: corridor and straight-path buffer size. */
const MAX_POLY = 256;
const SCALE = 1 / 32;

/** Include every poly except Disabled; exclude a shut door's (PathfindingMgrBase.DefaultFilters, BlockingDoorAvoidanceFilters). */
const DEFAULT_FILTER = new Uint16Array([PolyFlags.All ^ PolyFlags.Disabled, PolyFlags.BlockingDoor]);
/** The server's box round a door for its polys (LocalPathfindingMgr.RegisterDoor: 128 x 128 x 32, at most 24). */
export const DOOR_POLY_EXTENTS: Vec3 = { x: 128, y: 128, z: 32 };
const MAX_DOOR_POLYS = 24;
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
    // (query, center, pickExt, filter, *polyRefs (64-bit), *count, maxPolys)
    GetPolysInBox: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    // (navMesh, *polyRefs, count, flagsToRemove, flagsToAdd)
    UpdateFlags: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u16, FFIType.u16], returns: FFIType.u32 },
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

const kernel32Symbols = {
    GetACP: { args: [], returns: FFIType.u32 },
    // (codePage, flags, wide, wideLen, *out, outLen, defaultChar, *usedDefault)
    WideCharToMultiByte: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    // (longPath, *out, outLen in WCHARs)
    GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
} as const;
const CP_UTF8 = 65001;
const WC_NO_BEST_FIT_CHARS = 0x400;
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

let kernel32: ReturnType<typeof dlopen<typeof kernel32Symbols>>['symbols'] | null | undefined;

/**
 * `file` as the NUL-terminated char* that Detour's std::fopen opens. On Windows fopen reads it in the
 * ANSI code page, not UTF-8 (the server marshals it with AnsiStringMarshaller), so a non-ASCII path is
 * converted to the ANSI code page when every character fits, else to its 8.3 short name (pure ASCII
 * when the volume keeps short names). Falls back to UTF-8, which then fails to open.
 */
export function nativePath(file: string, platform: string = process.platform): Buffer {
    const utf8 = Buffer.from(`${file}\0`, 'utf8');
    if (platform !== 'win32' || isAscii(file)) return utf8;
    if (kernel32 === undefined) {
        try {
            kernel32 = dlopen('kernel32.dll', kernel32Symbols).symbols;
        } catch {
            kernel32 = null;
        }
    }
    if (!kernel32) return utf8;
    const wide = Buffer.from(`${file}\0`, 'utf16le');
    const acp = kernel32.GetACP();
    if (acp === CP_UTF8) return utf8;
    const size = kernel32.WideCharToMultiByte(acp, WC_NO_BEST_FIT_CHARS, wide, -1, null, 0, null, null);
    if (size > 0) {
        const ansi = Buffer.alloc(size);
        const usedDefault = new Int32Array(1);
        if (kernel32.WideCharToMultiByte(acp, WC_NO_BEST_FIT_CHARS, wide, -1, ansi, size, null, usedDefault) === size && !usedDefault[0]) return ansi;
    }
    const len = kernel32.GetShortPathNameW(wide, null, 0);
    if (len > 0) {
        const out = Buffer.alloc(len * 2);
        const n = kernel32.GetShortPathNameW(wide, out, len);
        const short = n > 0 && n < len ? out.toString('utf16le', 0, n * 2) : '';
        if (short && isAscii(short)) return Buffer.from(`${short}\0`, 'ascii');
    }
    return utf8;
}

/** size:mtime of a file, '' when it is missing; a failed zone is retried once this changes. */
const fileStamp = (file: string): string => {
    try {
        const st = statSync(file);
        return `${st.size}:${st.mtimeMs}`;
    } catch {
        return '';
    }
};

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
    /** Include and exclude flags for a query that leaves some polys out (findPath's `exclude`). */
    private readonly filter = new Uint16Array(2);
    private readonly losFlag = new Uint8Array(1);
    /** Each door's polys by its spot (doorPolys), found once as the server does. */
    private readonly doors = new Map<string, BigUint64Array>();
    /** The doors shut now (setDoorBlocking), by the same key: where a route that stops short meets one. */
    private readonly shut = new Map<string, Vec3>();
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

    /** Unrounded height of closestPoint(p, halfExtents), or null when no poly is within the extents. */
    surfaceZ(p: Vec3, halfExtents: Vec3 = DEFAULT_EXTENTS): number | null {
        this.check();
        const s = this.lib.FindClosestPoint(this.query, toRecast(p, this.start), toRecast(halfExtents, this.ext), DEFAULT_FILTER, this.out);
        return ok(s) ? this.out[1]! / SCALE : null;
    }

    /**
     * Straight path between two points that are already on (or within the default extents of) the mesh. `exclude` leaves out polys
     * with those flags (PolyFlags.Swim: water), start and end included: an end in water then has no path ('none'). A shut door's
     * polys (setDoorBlocking) are left out too, unless `throughShutDoors` (to tell whether one is what is in the way).
     */
    findPath(start: Vec3, end: Vec3, halfExtents: Vec3 = DEFAULT_EXTENTS, exclude = 0, throughShutDoors = false): NavPath {
        this.check();
        this.count[0] = 0;
        this.filter[0] = PolyFlags.All ^ PolyFlags.Disabled;
        this.filter[1] = exclude | (throughShutDoors ? 0 : PolyFlags.BlockingDoor);
        const s = this.lib.PathStraight(this.query, toRecast(start, this.start), toRecast(end, this.end), toRecast(halfExtents, this.ext),
            this.filter, DT_STRAIGHTPATH_ALL_CROSSINGS, this.count, this.pathPts, this.pathFlags);
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
     * `clear` is true when nothing blocks the straight walk; `hit` is where it stops otherwise (`end` when clear).
     * This is not visual line of sight: it ignores height and stops at mesh edges (walls, cliffs, water borders).
     */
    raycast(start: Vec3, end: Vec3, halfExtents: Vec3 = DEFAULT_EXTENTS): { clear: boolean; hit: Vec3 } | null {
        this.check();
        this.losFlag[0] = 0;
        const s = this.lib.HasLineOfSight(this.query, toRecast(start, this.start), toRecast(end, this.end), toRecast(halfExtents, this.ext), DEFAULT_FILTER, this.losFlag, this.out);
        if (!ok(s)) return null;
        // Detour reports t = FLT_MAX when the ray reaches `end`, which makes the native hit point infinite.
        const clear = this.losFlag[0] !== 0;
        return { clear, hit: clear ? { x: end.x, y: end.y, z: end.z } : fromRecast(this.out) };
    }

    /**
     * The polys of the door at `at` (a door's spot, region units): the Door-flagged polys within DOOR_POLY_EXTENTS of it, found once
     * (blocking or not) and kept, as LocalPathfindingMgr.RegisterDoor does. Empty where the mesh has no door there.
     */
    doorPolys(at: Vec3): BigUint64Array {
        this.check();
        const key = `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}`;
        const known = this.doors.get(key);
        if (known) return known;
        const refs = new BigUint64Array(MAX_DOOR_POLYS);
        const filter = new Uint16Array([PolyFlags.Door | PolyFlags.BlockingDoor, 0]);
        this.count[0] = 0;
        const s = this.lib.GetPolysInBox(this.query, toRecast(at, this.start), toRecast(DOOR_POLY_EXTENTS, this.ext), filter, refs, this.count, MAX_DOOR_POLYS);
        const found = ok(s) ? refs.slice(0, Math.min(this.count[0]!, MAX_DOOR_POLYS)) : new BigUint64Array(0);
        this.doors.set(key, found);
        return found;
    }

    /**
     * Shut (`blocking`) or open the door at `at` for every later query on this mesh: its polys swap Door ↔ BlockingDoor
     * (LocalPathfindingMgr.UpdateDoorFlags). True when the mesh has polys there and the flags changed. The flags live in this process.
     */
    setDoorBlocking(at: Vec3, blocking: boolean): boolean {
        const polys = this.doorPolys(at);
        if (polys.length === 0) return false;
        const remove = blocking ? PolyFlags.Door : PolyFlags.BlockingDoor;
        const add = blocking ? PolyFlags.BlockingDoor : PolyFlags.Door;
        const done = ok(this.lib.UpdateFlags(this.mesh, polys, polys.length, remove, add));
        const key = `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}`;
        if (done && blocking) this.shut.set(key, { x: at.x, y: at.y, z: at.z });
        else if (done) this.shut.delete(key);
        return done;
    }

    /** Whether any door on this mesh is shut now (setDoorBlocking). */
    hasShutDoors(): boolean {
        return this.shut.size > 0;
    }

    /** A shut door (setDoorBlocking) within `radius` of `p` on the ground, the nearest; null with none. */
    shutDoorNear(p: { x: number; y: number }, radius: number): Vec3 | null {
        let best: Vec3 | null = null, bestD = radius;
        for (const d of this.shut.values()) {
            const dist = Math.hypot(d.x - p.x, d.y - p.y);
            if (dist <= bestD) { best = d; bestD = dist; }
        }
        return best;
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
    private readonly meshes = new Map<number, NavMesh>();
    /** Zones whose last load failed: the reason and the file's fileStamp at that time. */
    private readonly failures = new Map<number, { reason: string; stamp: string }>();
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

    /**
     * The zone's mesh, loading it on first use; null without a file or library (see loadError).
     * A failed zone is retried once its file's size or mtime changes.
     */
    forZone(zoneId: number): NavMesh | null {
        const cached = this.meshes.get(zoneId);
        if (cached) return cached;
        const file = join(this.dir, `zone${String(zoneId).padStart(3, '0')}.nav`);
        const stamp = fileStamp(file);
        if (this.failures.get(zoneId)?.stamp === stamp) return null;
        const lib = stamp ? this.library() : null;
        const result = !stamp ? `no ${basename(file)} in ${this.dir}` : lib ? this.load(lib, file, zoneId) : this.libError;
        if (typeof result === 'string') {
            this.failures.set(zoneId, { reason: result, stamp });
            return null;
        }
        this.failures.delete(zoneId);
        this.zones().add(zoneId);
        this.meshes.set(zoneId, result);
        return result;
    }

    /** Why forZone(zoneId) returned null; null when its mesh loaded or was never requested. */
    loadError(zoneId: number): string | null {
        return this.failures.get(zoneId)?.reason ?? null;
    }

    /** The mesh of the zone containing (x, y) in a region. */
    at(regionId: number, x: number, y: number): NavMesh | null {
        const zone = getZoneAt(regionId, x, y);
        return zone ? this.forZone(zone.id) : null;
    }

    /** Load any .nav file (e.g. the Detour test mesh) outside the zone cache. */
    loadFile(file: string): NavMesh | null {
        const lib = this.library();
        const mesh = lib ? this.load(lib, file, null) : null;
        return typeof mesh === 'string' ? null : mesh;
    }

    dispose(): void {
        for (const m of this.meshes.values()) m?.dispose();
        this.meshes.clear();
        this.failures.clear();
    }

    /** The loaded mesh, or why it failed. */
    private load(lib: DetourLib, file: string, zoneId: number | null): NavMesh | string {
        const meshOut = new BigUint64Array(1);
        if (!lib.LoadNavMesh(nativePath(file), meshOut) || meshOut[0] === 0n) return `cannot load ${file} (LoadNavMesh failed)`;
        const mesh = Number(meshOut[0]) as Pointer;
        const queryOut = new BigUint64Array(1);
        if (!lib.CreateNavMeshQuery(mesh, queryOut) || queryOut[0] === 0n) {
            lib.FreeNavMesh(mesh);
            return `cannot load ${file} (CreateNavMeshQuery failed)`;
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
