import { afterEach, describe, expect, test } from 'bun:test';
import { decodeTerrain, encodeTerrain, getTerrainStore, NO_WATER, sampleTerrain, type TerrainGrid, type TerrainSample, type TerrainStore } from '../terrain';
import { GROUND_TUNING, groundAt, moverGround } from '../ground';
import { getNavmeshStore, type NavmeshStore } from '../navmesh';
import type { Vec3 } from '../types';

/** 4x4 vertices 256 apart at (1000, 2000); heights 100 + 10*i + 20*j; river 0 (surface 300) on vertex (1,1). */
function grid(): TerrainGrid {
    const size = 4;
    const heights = new Uint16Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) heights[j * size + i] = 100 + 10 * i + 20 * j;
    const water = new Uint8Array(size * size).fill(NO_WATER);
    water[1 * size + 1] = 0;
    return { zoneId: 7, regionId: 1, xoff: 1000, yoff: 2000, width: 1024, height: 1024, size, heights, water, waterHeights: Int32Array.of(300) };
}

describe('terrain grids', () => {
    test('encode/decode round-trips', () => {
        const g = grid();
        expect(decodeTerrain(encodeTerrain(g))).toEqual(g);
    });

    test('decode rejects other files and truncation', () => {
        expect(() => decodeTerrain(new Uint8Array(64))).toThrow('not a terrain grid');
        expect(() => decodeTerrain(encodeTerrain(grid()).slice(0, -1))).toThrow('truncated');
    });

    test('samples the exported triangles, diagonal (x+1,y)-(x,y+1)', () => {
        // Vertex heights of cell (0,0): h00=100, h10=110, h01=120, h11=130 -> a plane, so both halves agree.
        const g = grid();
        expect(sampleTerrain(g, 1000, 2000)!.z).toBe(100);
        expect(sampleTerrain(g, 1128, 2128)!.z).toBeCloseTo(115);
        // Bend the far corner: only the upper-right triangle (fx + fy > 1) sees it.
        g.heights[1 * 4 + 1] = 170;
        expect(sampleTerrain(g, 1000 + 64, 2000 + 64)!.z).toBeCloseTo(100 + 2.5 + 5); // lower-left: h00, h10, h01
        expect(sampleTerrain(g, 1000 + 192, 2000 + 192)!.z).toBeCloseTo(170 - 0.25 * (170 - 120) - 0.25 * (170 - 110));
    });

    test('slope, water and bounds', () => {
        const g = grid();
        const s = sampleTerrain(g, 1100, 2100)!;
        expect(s.slope).toBeCloseTo(Math.hypot(10, 20) / 256);
        expect(s.waterZ).toBe(300); // a corner of the cell, vertex (1,1), is under the river
        const dry = sampleTerrain(g, 1000 + 2 * 256 + 10, 2000 + 2 * 256 + 10)!; // cell (2,2): no wet corner
        expect(dry.waterZ).toBeNull();
        expect(dry.navZ).toBe(dry.z);
        // buildnav moved vertex (1,1) (height 130) to the surface - 16 = 284: navZ follows, z keeps the bed.
        const wet = sampleTerrain(g, 1256, 2256)!;
        expect(wet).toMatchObject({ z: 130, navZ: 284, waterZ: 300 });
        expect(sampleTerrain(g, 999, 2000)).toBeNull();
        expect(sampleTerrain(g, 2024, 3024)).not.toBeNull(); // the far edge repeats the last vertex row/column
    });
});

describe('groundAt', () => {
    const flat = (z: number, extra: Partial<TerrainSample> = {}): TerrainStore => ({ at: () => ({ z, navZ: z, slope: 0, waterZ: null, zoneId: 0, ...extra }) }) as unknown as TerrainStore;
    const noTerrain = { at: () => null } as unknown as TerrainStore;
    /** A mesh whose poly search answers per box: `z` for every box, or a function of the box. */
    const meshAt = (z: number | null | ((ext: Vec3) => number | null), seen: Vec3[] = []): NavmeshStore => ({
        at: () => ({ surfaceZ: (_p: Vec3, ext: Vec3) => (seen.push(ext), typeof z === 'function' ? z(ext) : z) }),
    }) as unknown as NavmeshStore;
    /** Only boxes taller than 64 (or wider than 2) find a poly: a roof above a gap in the mesh. */
    const roofOnly = (roof: number) => meshAt(ext => (ext.z > 64 || ext.x > 2 ? roof : null));
    const noMesh = { at: () => null } as unknown as NavmeshStore;

    test('the mesh within the band over the terrain is the terrain: exact terrain z', () => {
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(104.5), terrain: flat(100) })).toEqual({ z: 100, source: 'terrain', swimming: false });
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(98.5), terrain: flat(100) })!.source).toBe('terrain');
    });

    test('a surface above the band (bridge, roof) keeps the mesh, lowered by its bias', () => {
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(140), terrain: flat(100) })).toEqual({ z: 140 - GROUND_TUNING.meshBias, source: 'navmesh', swimming: false });
    });

    test('the band widens with slope', () => {
        const steep = flat(100, { slope: 1 });
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(112), terrain: flat(100) })!.source).toBe('navmesh');
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(112), terrain: steep })!.source).toBe('terrain');
    });

    test('terrain without a mesh poly, mesh without terrain, neither', () => {
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(null), terrain: flat(100) })!.z).toBe(100);
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(50), terrain: noTerrain })!.z).toBe(50 - GROUND_TUNING.meshBias);
        expect(groundAt(1, 0, 0, 0, { navmesh: noMesh, terrain: noTerrain })).toBeNull();
    });

    test('a gap in the mesh at our height stays on the terrain, not on a roof the wider searches find', () => {
        expect(groundAt(1, 0, 0, 100, { navmesh: roofOnly(526), terrain: flat(100) })).toEqual({ z: 100, source: 'terrain', swimming: false });
        // In water too: no deck, keep swimming.
        expect(groundAt(1, 0, 0, 1876, { navmesh: roofOnly(2318), terrain: flat(1648, { navZ: 1900, waterZ: 1916 }) })!.swimming).toBe(true);
        // Without a heightmap (cities, dungeons) the wider searches are all there is.
        expect(groundAt(1, 0, 0, 100, { navmesh: roofOnly(526), terrain: noTerrain })!.z).toBe(526 - GROUND_TUNING.meshBias);
    });

    test('a cave floor below the surface at our height is ground', () => {
        expect(groundAt(1, 0, 0, 40, { navmesh: meshAt(42), terrain: flat(100) })).toMatchObject({ z: 42 - GROUND_TUNING.meshBias, source: 'navmesh' });
    });

    test('deep water swims under the surface; shallow water wades on the bed; a deck above the water is ground', () => {
        const deep = flat(1700, { navZ: 1813, waterZ: 1829 });
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(1814), terrain: deep })).toEqual({ z: 1829 - GROUND_TUNING.swimBelowSurface, source: 'water', swimming: true });
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(1813), terrain: flat(1810, { navZ: 1813, waterZ: 1829 }) })).toEqual({ z: 1810, source: 'terrain', swimming: false });
        expect(groundAt(1, 0, 0, 0, { navmesh: meshAt(1850), terrain: deep })).toMatchObject({ source: 'navmesh', swimming: false });
    });

    test('a riverbank cell compares the mesh with the water-warped surface buildnav exported, not the bed', () => {
        // The bed under this point is 180 deep, but buildnav raised a corner to 1813: the mesh at 1815 is that surface.
        const bank = flat(1650, { navZ: 1810, waterZ: 1829 });
        expect(groundAt(1, 0, 0, 1800, { navmesh: meshAt(1815), terrain: bank })).toMatchObject({ source: 'water', swimming: true });
    });

    test('searches the layer nearest zHint first; with a heightmap only that one', () => {
        const seen: Vec3[] = [];
        groundAt(1, 0, 0, 0, { navmesh: meshAt(100, seen), terrain: noTerrain });
        expect(seen).toEqual([{ x: 2, y: 2, z: 64 }]);
        seen.length = 0;
        groundAt(1, 0, 0, 0, { navmesh: meshAt(null, seen), terrain: flat(0) });
        expect(seen).toEqual([{ x: 2, y: 2, z: 64 }]);
        seen.length = 0;
        groundAt(1, 0, 0, 0, { navmesh: meshAt(null, seen), terrain: noTerrain });
        expect(seen).toEqual([{ x: 2, y: 2, z: 64 }, { x: 32, y: 32, z: 64 }, { x: 2, y: 2, z: 512 }, { x: 32, y: 32, z: 512 }]);
    });

    describe('moverGround', () => {
        const saved = process.env.DAOC_NAVMESH;
        afterEach(() => {
            if (saved === undefined) delete process.env.DAOC_NAVMESH;
            else process.env.DAOC_NAVMESH = saved;
        });

        test('off with DAOC_NAVMESH=off or without any data', () => {
            const store = { available: () => true, at: () => null } as unknown as NavmeshStore & TerrainStore;
            process.env.DAOC_NAVMESH = 'off';
            expect(moverGround({ navmesh: store, terrain: store })).toBeUndefined();
            delete process.env.DAOC_NAVMESH;
            const none = { available: () => false } as unknown as NavmeshStore & TerrainStore;
            expect(moverGround({ navmesh: none, terrain: none })).toBeUndefined();
            expect(moverGround({ navmesh: store, terrain: store })).toBeFunction();
        });
    });
});

// The generated grids and meshes (bun run navmesh:build); skipped without them.
const haveData = getTerrainStore().forZone(0) !== null && getTerrainStore().forZone(7) !== null && getNavmeshStore().hasZone(0) && getNavmeshStore().hasZone(7);

describe.skipIf(!haveData)('ground on the generated zones', () => {
    test('Camelot Hills: on the terrain, below the navmesh', () => {
        const at = { x: 576649, y: 527930 };
        const t = getTerrainStore().at(1, at.x, at.y)!;
        const mesh = getNavmeshStore().at(1, at.x, at.y)!.surfaceZ({ ...at, z: t.z }, { x: 2, y: 2, z: 64 })!;
        const g = groundAt(1, at.x, at.y, t.z)!;
        expect(g).toEqual({ z: t.z, source: 'terrain', swimming: false });
        expect(mesh - g.z).toBeGreaterThan(0);
        expect(mesh - g.z).toBeLessThan(13);
    });

    test('Llyn Barfog (zone 7, water 1829): swimming under the surface', () => {
        const g = groundAt(1, 447076, 408704, 1814)!;
        expect(g).toEqual({ z: 1829 - GROUND_TUNING.swimBelowSurface, source: 'water', swimming: true });
    });
});
