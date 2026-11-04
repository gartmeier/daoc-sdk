// Ground height for our own position, the z the mover sends in 0xA9 (client/movement.ts).
//
// Navmesh z floats above the real ground: Recast rounds span tops up to its 3.2-unit cell height,
// adds one more cell to detail vertices and rounds higher on slopes. Over the 42 default zones it
// sits 0.9..12.5 units above the terrain (p1..p99, median 4.5), which a real client draws as feet
// above the grass. Positions recorded by real clients sit on the client's own terrain triangles
// (sdk/terrain.ts). So:
//   - on an object (bridge, roof, rock, deck: a mesh layer at our height clearly above the surface
//     buildnav fed Recast), and in cities and dungeons (no heightmap), use the mesh lowered by its
//     mean flat-ground offset;
//   - everywhere else outdoors, use the exact terrain height (or the water rule below);
//   - in water at least `swimDepth` deep, swim at `swimBelowSurface` under the river surface.
//     buildnav lays the mesh in water on a plane 16 units under the surface; spawns placed by
//     real clients while swimming sat 40 under it (before /fixnpcspawn moved them onto the mesh).

import { getNavmeshStore, type NavmeshStore } from './navmesh';
import { getTerrainStore, type TerrainStore } from './terrain';
import type { Vec3 } from './types';

export const GROUND_TUNING = {
    /** Mean height of a flat navmesh surface above the real one (subtracted where only the mesh is known). */
    meshBias: 2.5,
    /** A mesh layer is the terrain when meshZ - navZ is in [bandBelow, min(bandMax, bandAbove + bandPerSlope * slope)]. */
    bandBelow: -2,
    bandAbove: 8,
    bandPerSlope: 16,
    bandMax: 40,
    /** Swim where the river surface is at least this far above the bed. */
    swimDepth: 40,
    /** Swimming z below the river surface. */
    swimBelowSurface: 40,
    /** The mesh's plane in water, below the river surface. */
    meshBelowSurface: 16,
};

export interface Ground {
    z: number;
    /** terrain: exact heightmap; navmesh: mesh minus meshBias; water: swimming height. */
    source: 'terrain' | 'navmesh' | 'water';
    swimming: boolean;
    /** The river surface over this terrain cell (TerrainSample.waterZ), if any: the point is under water when it is above z. Not on a mesh layer, a deck over the river say. */
    waterZ?: number;
}

export interface GroundSources {
    navmesh?: NavmeshStore;
    terrain?: TerrainStore;
}

/** The poly search at our height: only a layer found this close counts as what we stand on. */
const TIGHT: Vec3 = { x: 2, y: 2, z: 64 };
/** Without a heightmap: then beside us at our height, then taller boxes (we may be off the mesh). */
const WIDER: Vec3[] = [{ x: 32, y: 32, z: 64 }, { x: 2, y: 2, z: 512 }, { x: 32, y: 32, z: 512 }];

/**
 * Ground at region (x, y), on the layer nearest `zHint` (the current or planned z). Null where
 * there is neither a navmesh nor a terrain grid: callers keep their own z then.
 */
export function groundAt(regionId: number, x: number, y: number, zHint: number, sources: GroundSources = {}): Ground | null {
    const t = GROUND_TUNING;
    const mesh = (sources.navmesh ?? getNavmeshStore()).at(regionId, x, y);
    const terrain = (sources.terrain ?? getTerrainStore()).at(regionId, x, y);
    const query = (ext: Vec3) => mesh?.surfaceZ({ x, y, z: zHint }, ext) ?? null;
    const onMesh = (z: number): Ground => ({ z: z - t.meshBias, source: 'navmesh', swimming: false });
    const tight = query(TIGHT);
    if (!terrain) {
        let z = tight;
        for (const ext of WIDER) z ??= query(ext);
        return z === null ? null : onMesh(z);
    }
    // A layer at our height that is not the surface the mesh was built from is an object (or a cave
    // floor). A miss means a gap in the mesh (eroded at walls, trees, steep slopes): the terrain is
    // still under us, while wider searches would find roofs and cliff tops.
    if (tight !== null) {
        const above = tight - terrain.navZ;
        const band = Math.min(t.bandMax, t.bandAbove + t.bandPerSlope * terrain.slope);
        if (above > band) return onMesh(tight);
        // A floor below the surface (cave, tunnel) only when we are down there, not when the
        // surface's own poly is missing over it.
        if (above < t.bandBelow && Math.abs(zHint - tight) < Math.abs(zHint - terrain.navZ)) return onMesh(tight);
    }
    const { waterZ } = terrain;
    if (waterZ !== null && waterZ - terrain.z >= t.swimDepth) return { z: waterZ - t.swimBelowSurface, source: 'water', swimming: true, waterZ };
    return { z: terrain.z, source: 'terrain', swimming: false, ...(waterZ !== null && { waterZ }) };
}

/**
 * The z for a ground target on this ground: the server drops one over 16 off the mesh (PlayerGroundTargetHandler.cs:63-85). Under a river the mesh is the plane 16 below its surface at any depth
 * (Heightmap.cs WATER_SURFACE_DEPTH), so the swimming height is 24 off it and the bed can be 23. Live, on 5 spots 20-39 deep: the bed dropped, the plane kept.
 */
export function groundTargetZ(ground: { z: number; swimming: boolean; waterZ?: number }): number {
    if (ground.swimming) return ground.z + GROUND_TUNING.swimBelowSurface - GROUND_TUNING.meshBelowSurface;
    return ground.waterZ !== undefined && ground.waterZ > ground.z ? ground.waterZ - GROUND_TUNING.meshBelowSurface : ground.z;
}

/** ground_target_snap_max_distance as it reaches the mesh: a search box of this half size per axis (ServerProperties.cs:2208, LocalPathfindingMgr.cs:341-349). */
const GROUND_TARGET_BOX: Vec3 = { x: 16, y: 16, z: 16 };

/**
 * Where the server would put a ground target it takes: the closest point on the nearest poly its box touches, kept with no further test (PlayerGroundTargetHandler.cs:81-86, LocalPathfindingMgr.cs:301-306).
 * On open ground that is the mesh's height, a few units off; beside a gap in the mesh the poly can reach well outside the box, 90-166 units at the worst measured. Null with no mesh here or nothing in the box. The same meshes as the gameserver's (docs/SERVER.md),
 * and over deep water the server snaps nothing, which this can't tell (PlayerGroundTargetHandler.cs:76-77).
 */
export function groundTargetSnap(regionId: number, spot: Vec3, sources: GroundSources = {}): Vec3 | null {
    return (sources.navmesh ?? getNavmeshStore()).at(regionId, spot.x, spot.y)?.closestPoint(spot, GROUND_TARGET_BOX) ?? null;
}

/**
 * groundAt for the client's mover, or undefined when ground correction is off (DAOC_NAVMESH=off) or
 * nothing is built (no server/navmesh). The mover then keeps interpolating waypoint z.
 */
export function moverGround(sources: GroundSources = {}): ((regionId: number, x: number, y: number, zHint: number) => Ground | null) | undefined {
    if (/^(0|off|false|no)$/i.test(process.env.DAOC_NAVMESH ?? '')) return undefined;
    const navmesh = sources.navmesh ?? getNavmeshStore();
    const terrain = sources.terrain ?? getTerrainStore();
    if (!navmesh.available() && !terrain.available()) return undefined;
    return (regionId, x, y, zHint) => groundAt(regionId, x, y, zHint, { navmesh, terrain });
}
