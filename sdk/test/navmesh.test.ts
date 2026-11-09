import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NavmeshStore, type NavMesh } from '../navmesh';
import { NavmeshPathProvider, navmeshGroundZ, simplifyPath, StraightLinePathProvider } from '../pathfinding';

// The FFI tests need meshes generated from a local client (bun run navmesh:build):
// zone 0 (Camelot Hills) and zone 1 (Salisbury Plains) in region 1. Skipped without them.
const store = new NavmeshStore();
const ready = store.available() && store.hasZone(0) && store.hasZone(1);
afterAll(() => store.dispose());

const straight = new StraightLinePathProvider({ estimateZ: null });
const pathLength = (from: { x: number; y: number }, pts: { x: number; y: number }[]) =>
    pts.reduce((s, p, i) => s + Math.hypot(p.x - (i ? pts[i - 1]!.x : from.x), p.y - (i ? pts[i - 1]!.y : from.y)), 0);

describe('simplifyPath', () => {
    test('drops collinear points with z on the chord, keeps turns, bumps and vertical hops', () => {
        const pts = [
            { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 10 }, { x: 200, y: 0, z: 20 }, // straight, linear z
            { x: 300, y: 0, z: 200 },                                                 // z bump
            { x: 400, y: 0, z: 30 }, { x: 400, y: 0, z: 300 },                        // ladder: same x/y
            { x: 400, y: 100, z: 300 },                                               // flat corner: only the turn check keeps it
            { x: 500, y: 100, z: 300 },
        ];
        expect(simplifyPath(pts)).toEqual([0, 2, 3, 4, 5, 6, 7].map(i => pts[i]!));
    });
});

describe('NavmeshStore without files', () => {
    test('reports why it is unavailable and the provider falls back to straight lines', async () => {
        const empty = new NavmeshStore({ dir: join(tmpdir(), 'no-navmesh-here') });
        expect(empty.available()).toBeFalse();
        expect(empty.unavailableReason()).toContain('navmesh:build');
        const p = new NavmeshPathProvider({ store: empty, fallback: straight });
        const r = await p.findPath({ regionId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 5 } });
        expect(r.success).toBeTrue();
        expect(r.waypoints).toEqual([{ x: 10, y: 0, z: 5 }]);
        expect(r.message).toContain('navmesh:build');
    });
});

// A store whose every zone has the same scripted mesh, for provider logic without the native library.
type FakeMesh = Pick<NavMesh, 'closestPoint' | 'findPath'>;
const fakeStore = (mesh: FakeMesh | null, loadError: string | null = null) =>
    ({ available: () => true, unavailableReason: () => '', forZone: () => mesh, at: () => mesh, loadError: () => loadError }) as unknown as NavmeshStore;
const camelotHills = { x: 560000, y: 500000, z: 2400 }; // region 1, zone 0

describe('NavmeshPathProvider fallbacks and edge cases', () => {
    test('a start zone whose mesh did not load walks straight and says why', async () => {
        const p = new NavmeshPathProvider({ store: fakeStore(null, 'cannot load zone000.nav (LoadNavMesh failed)'), fallback: straight });
        const r = await p.findPath({ regionId: 1, from: camelotHills, to: { x: 561000, y: 500000, z: 2400 } });
        expect(r.success).toBeTrue();
        expect(r.waypoints).toEqual([{ x: 561000, y: 500000, z: 2400 }]);
        expect(r.message).toContain('zone 0');
        expect(r.message).toContain('zone000.nav');
    });

    test('a start off the mesh walks straight and says so', async () => {
        const p = new NavmeshPathProvider({ store: fakeStore({ closestPoint: () => null, findPath: () => ({ status: 'none', points: [] }) }), fallback: straight });
        const r = await p.findPath({ regionId: 1, from: camelotHills, to: { x: 561000, y: 500000, z: 2400 } });
        expect(r.success).toBeTrue();
        expect(r.waypoints).toEqual([{ x: 561000, y: 500000, z: 2400 }]);
        expect(r.message).toContain('off the navmesh');
    });

    test('a zero-length leg on the mesh still ends at the destination', async () => {
        const mesh: FakeMesh = { closestPoint: p => ({ ...p }), findPath: start => ({ status: 'found', points: [{ ...start, flags: 0 }] }) };
        const p = new NavmeshPathProvider({ store: fakeStore(mesh), fallback: straight });
        const r = await p.findPath({ regionId: 1, from: camelotHills, to: { ...camelotHills } });
        expect(r).toEqual({ success: true, waypoints: [camelotHills] });
    });
});

describe('NavmeshPathProvider and water', () => {
    // From camelotHills 2000 east. The shortest way swims 1000 of it; the dry way bends round 800 north (or 1600 with `bend`).
    const { x, y, z } = camelotHills;
    const mesh = (bend: number): FakeMesh => ({
        closestPoint: p => ({ ...p }),
        findPath: (start, end, _ext, exclude = 0) => ({
            status: 'found',
            points: exclude
                ? [{ ...start, flags: 1 }, { x: x + 1000, y: y + bend, z, flags: 1 }, { ...end, flags: 1 }]
                : [{ ...start, flags: 1 }, { x: x + 500, y, z, flags: 2 }, { x: x + 1500, y, z, flags: 1 }, { ...end, flags: 1 }],
        }),
    });
    const to = { x: x + 2000, y, z };

    test('takes the dry way round while it is quicker than swimming across', async () => {
        // Swimming: 1000 + 1000 × 191/85 ≈ 3247 at run speed. Round: 2 × hypot(1000, 800) ≈ 2561.
        const r = await new NavmeshPathProvider({ store: fakeStore(mesh(800)), fallback: straight }).findPath({ regionId: 1, from: camelotHills, to });
        expect(r.waypoints.map(p => p.y)).toEqual([y + 800, y]);
    });

    test('swims when the way round is slower', async () => {
        // Round: 2 × hypot(1000, 1600) ≈ 3774.
        const r = await new NavmeshPathProvider({ store: fakeStore(mesh(1600)), fallback: straight }).findPath({ regionId: 1, from: camelotHills, to });
        expect(r.waypoints.every(p => p.y === y)).toBeTrue();
    });
});

describe.skipIf(!ready)('Detour via Bun FFI (generated Camelot Hills meshes)', () => {
    test('snaps a DB spawn onto the ground within a few units', () => {
        // bear cub spawn in Camelot Hills (DB z 2262)
        const p = store.forZone(0)!.closestPoint({ x: 548972, y: 493199, z: 2262 })!;
        expect(Math.abs(p.z - 2262)).toBeLessThan(32);
        expect(navmeshGroundZ(1, 548972, 493199, 2262 + 400, store)).toBe(p.z); // tall snap from a bad guess
        expect(store.forZone(0)).toBe(store.forZone(0)); // cached
    });

    test('chains past the 256-poly corridor across the whole zone', async () => {
        const from = { x: 548972, y: 493199, z: 2262 };
        const to = { x: 606376, y: 518572 };
        expect(store.forZone(0)!.findPath(store.forZone(0)!.closestPoint(from)!, { x: 606376, y: 518572, z: 2713 }).status).toBe('partial');
        const r = await new NavmeshPathProvider({ store, fallback: straight }).findPath({ regionId: 1, from, to });
        expect(r.success).toBeTrue();
        expect(r.message).toBeUndefined();
        expect(r.waypoints.at(-1)).toMatchObject(to);
        const len = pathLength(from, r.waypoints);
        expect(len).toBeGreaterThan(Math.hypot(to.x - from.x, to.y - from.y));
        expect(len).toBeLessThan(Math.hypot(to.x - from.x, to.y - from.y) * 1.5);
    });

    test('corrects a wrong start z and ends at the exact destination on the ground', async () => {
        const r = await new NavmeshPathProvider({ store, fallback: straight }).findPath({ regionId: 1, from: { x: 574797, y: 530161, z: 2596 }, to: { x: 576200, y: 528250 } });
        expect(r.success).toBeTrue();
        const end = r.waypoints.at(-1)!;
        expect(end).toMatchObject({ x: 576200, y: 528250 });
        expect(Math.abs(end.z - store.forZone(0)!.closestPoint({ ...end, z: end.z }, { x: 32, y: 32, z: 4000 })!.z)).toBeLessThan(2);
    });

    test('crosses a zone border onto the neighbouring mesh', async () => {
        // Camelot Hills (zone 0, y < 548864) north into Salisbury Plains (zone 1).
        const from = { x: 560000, y: 540000, z: 2400 };
        const to = { x: 560000, y: 556000 };
        const r = await new NavmeshPathProvider({ store, fallback: straight }).findPath({ regionId: 1, from, to });
        expect(r.success).toBeTrue();
        expect(r.message).toBeUndefined();
        expect(r.waypoints.at(-1)).toMatchObject(to);
        const ys = r.waypoints.map(w => w.y);
        expect(ys.some(y => y < 548864) && ys.some(y => y >= 548864)).toBeTrue();
    });

    test('a zero-length leg on a real mesh returns the destination', async () => {
        const at = store.forZone(0)!.closestPoint({ x: 548972, y: 493199, z: 2262 })!;
        const r = await new NavmeshPathProvider({ store, fallback: straight }).findPath({ regionId: 1, from: at, to: { ...at } });
        expect(r).toEqual({ success: true, waypoints: [at] });
    });

    test.skipIf(store.hasZone(26))('a zone without a .nav file walks straight and names the missing file', async () => {
        // City of Camelot (region 10, zone 26) has no mesh in this build.
        const r = await new NavmeshPathProvider({ store, fallback: straight }).findPath({ regionId: 10, from: { x: 40000, y: 40000, z: 0 }, to: { x: 41000, y: 40000, z: 0 } });
        expect(r.success).toBeTrue();
        expect(r.waypoints).toEqual([{ x: 41000, y: 40000, z: 0 }]);
        expect(r.message).toContain('zone026.nav');
    });
});

// Dartmoor (region 1, zone 4): Detour's first 256 polys lead sideways, so the second partial query
// barely gets closer (45 units) before the third finds the goal.
describe.skipIf(!store.available() || !store.hasZone(4))('chaining sideways partial corridors (generated Dartmoor mesh)', () => {
    test('keeps chaining while partial queries move and reaches the goal', async () => {
        const from = { x: 368211, y: 701267, z: 3132 };
        const to = { x: 400526, y: 702187, z: 1649 };
        const r = await new NavmeshPathProvider({ store, fallback: straight }).findPath({ regionId: 1, from, to });
        expect(r.success).toBeTrue();
        expect(r.message).toBeUndefined();
        expect(r.waypoints.at(-1)).toEqual(to);
    });
});
