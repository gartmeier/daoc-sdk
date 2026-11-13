// Doors on the navmesh, as the server keeps them (LocalPathfindingMgr.UpdateDoorFlags): a shut door's polys are
// BlockingDoor and every query leaves them out. Against the real zone mesh of Thidranki (region 252) and the Faste's two
// doors; skipped where `bun run navmesh:build` has not run.
import { describe, expect, test } from 'bun:test';
import { NavmeshStore, PolyFlags } from '../navmesh';
import { NavmeshPathProvider } from '../pathfinding';

const store = new NavmeshStore();
const THIDRANKI = 252;
const ready = store.available() && store.at(THIDRANKI, 33089, 38271) !== null;

// The Faste: its gate (DbDoor 252000301) and the keep building's door (252000302), at their spots in the door table.
const GATE = { x: 34333, y: 38275, z: 3720 };
const KEEP_DOOR = { x: 32654, y: 38180, z: 3720 };
// The building's four posterns (252000303-306, IsPostern): never attackable, shut to every realm but the owner's.
const POSTERNS = [{ x: 32323, y: 37845, z: 3975 }, { x: 32311, y: 38669, z: 3976 }, { x: 32315, y: 37950, z: 3952 }, { x: 32311, y: 38669, z: 3952 }];
const STAGE = { x: 36300, y: 38300, z: 3349 };
const COURTYARD = { x: 33100, y: 38250, z: 3722 };
const ROOF = { x: 32238, y: 38298, z: 4592 };

describe.skipIf(!ready)('doors on the navmesh (the Faste)', () => {
    const mesh = () => store.at(THIDRANKI, GATE.x, GATE.y)!;

    test('each door has its Door polys, found once', () => {
        const m = mesh();
        const gate = m.doorPolys(GATE);
        expect(gate.length).toBeGreaterThan(0);
        expect(m.doorPolys(GATE)).toBe(gate);
        expect(m.doorPolys(KEEP_DOOR).length).toBeGreaterThan(0);
        expect(m.doorPolys({ x: 36300, y: 38300, z: 3349 }).length).toBe(0);
    });

    test('a shut gate is a wall: no way into the courtyard; open again, the way is back', () => {
        const m = mesh();
        expect(m.findPath(STAGE, COURTYARD).status).toBe('found');
        expect(m.setDoorBlocking(GATE, true)).toBe(true);
        try {
            const shut = m.findPath(STAGE, COURTYARD);
            expect(shut.status).not.toBe('found');
            expect(shut.points.some(p => p.flags & PolyFlags.BlockingDoor)).toBe(false);
        } finally {
            expect(m.setDoorBlocking(GATE, false)).toBe(true);
        }
        expect(m.findPath(STAGE, COURTYARD).status).toBe('found');
    });

    test('the keep building: its door and the four posterns shut, no way to the roof from the courtyard', () => {
        const m = mesh();
        expect(m.findPath(COURTYARD, ROOF).status).toBe('found');
        // The building's door alone is not enough: the way goes up the wall-walk and in by a postern (door table, IsPostern).
        m.setDoorBlocking(KEEP_DOOR, true);
        try {
            expect(m.findPath(COURTYARD, ROOF).status).toBe('found');
            for (const p of POSTERNS) m.setDoorBlocking(p, true);
            expect(m.findPath(COURTYARD, ROOF).status).not.toBe('found');
            // The gate is no part of that way: the courtyard stays open.
            expect(m.findPath(STAGE, COURTYARD).status).toBe('found');
        } finally {
            m.setDoorBlocking(KEEP_DOOR, false);
            for (const p of POSTERNS) m.setDoorBlocking(p, false);
        }
        expect(m.findPath(COURTYARD, ROOF).status).toBe('found');
    });

    test('a walk stops at a shut door: no straight line through it, reason door; open, the route is back', async () => {
        const m = mesh();
        const provider = new NavmeshPathProvider({ store });
        expect((await provider.findPath({ regionId: THIDRANKI, from: STAGE, to: COURTYARD })).success).toBe(true);
        m.setDoorBlocking(GATE, true);
        try {
            expect(m.shutDoorNear(GATE, 10)).not.toBeNull();
            const r = await provider.findPath({ regionId: THIDRANKI, from: STAGE, to: COURTYARD });
            expect(r.success).toBe(false);
            expect(r.reason).toBe('door');
            expect(r.message).toContain('a shut door at (34333, 38275) is in the way');
            // A walk that needs no door is untouched.
            expect((await provider.findPath({ regionId: THIDRANKI, from: STAGE, to: { x: 36000, y: 36500 } })).success).toBe(true);
        } finally {
            m.setDoorBlocking(GATE, false);
        }
        expect(m.shutDoorNear(GATE, 10)).toBeNull();
        expect((await provider.findPath({ regionId: THIDRANKI, from: STAGE, to: COURTYARD })).success).toBe(true);
    });

    test('an exclude mask still works beside a shut door', () => {
        const m = mesh();
        m.setDoorBlocking(GATE, true);
        try {
            expect(m.findPath(STAGE, COURTYARD, undefined, PolyFlags.Swim).status).not.toBe('found');
        } finally {
            m.setDoorBlocking(GATE, false);
        }
    });
});
