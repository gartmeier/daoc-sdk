import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NavmeshStore } from '../navmesh';
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
            { x: 400, y: 100, z: 300 },                                               // turn
        ];
        expect(simplifyPath(pts)).toEqual([0, 2, 3, 4, 5, 6].map(i => pts[i]!));
    });
});

describe('NavmeshStore without files', () => {
    test('reports why it is unavailable and the provider falls back to straight lines', async () => {
        const empty = new NavmeshStore({ dir: join(tmpdir(), 'no-navmesh-here') });
        expect(empty.available()).toBeFalse();
        expect(empty.unavailableReason()).toContain('navmesh:build');
        const p = new NavmeshPathProvider({ store: empty, fallback: straight });
        const r = await p.findPath({ regionId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 5 } });
        expect(r).toEqual({ success: true, waypoints: [{ x: 10, y: 0, z: 5 }] });
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
});
