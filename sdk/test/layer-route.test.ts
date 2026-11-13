import { describe, expect, test } from 'bun:test';
import { getNavmeshStore, layerRoute } from '../actions';

const store = getNavmeshStore();
const meshReady = store.available() && store.at(252, 33089, 38271) !== null;

// The Faste (region 252): wall-e-s's Wizard stands on the wall-walk at z 3976, 256 over the courtyard below him.
const WIZARD = { x: 33971, y: 38815, z: 3976 };
const BELOW = { x: 33900, y: 38700, z: 3722 };

describe('layerRoute without a mesh to say', () => {
    test('the same layer is straight', () => expect(layerRoute(252, BELOW, { ...BELOW, x: BELOW.x + 50, z: 3780 })).toBe('straight'));
    test('a region with no mesh is straight, as before', () => expect(layerRoute(9999, BELOW, WIZARD)).toBe('straight'));
});

describe.skipIf(!meshReady)('layerRoute on the Faste\'s navmesh', () => {
    test('melee under a wall Wizard get no short way up: none', () => {
        const d3 = Math.hypot(WIZARD.x - BELOW.x, WIZARD.y - BELOW.y, WIZARD.z - BELOW.z);
        expect(layerRoute(252, BELOW, WIZARD, 1.5 * d3 + 100)).toBe('none');
    });

    test('a chase with no length limit goes up the stair, by the route', () => {
        const r = layerRoute(252, BELOW, WIZARD);
        expect(r).not.toBe('none');
        expect(r).not.toBe('straight');
        const pts = (r as { waypoints: { x: number; y: number; z: number }[] }).waypoints;
        // By the stair at (33530-33660, 38860-38960), not straight up the wall.
        expect(pts.some(p => p.x >= 33450 && p.x <= 33700 && p.y >= 38840 && p.y <= 38980)).toBe(true);
    });

    test('a merlon no walk ends on: none', () => {
        expect(layerRoute(252, BELOW, { x: 33971, y: 38815, z: 4100 })).toBe('none');
    });
});
