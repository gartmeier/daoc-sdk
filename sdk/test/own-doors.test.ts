import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { BotActions, getNavmeshStore, type NavmeshStore } from '../actions';
import { clearOwnDoors, doorApproach, doorFront, doorLanding, doorOnRoute, doorSide, ownDoors, setOwnDoors, type OwnDoor } from '../doors';
import { setDefaultPathProvider, StraightLinePathProvider } from '../pathfinding';
import { FASTE, useOwnDoors } from '../group/siege';
import { makeObject } from './fixtures';
import { FakeWorld } from './fake-world';

// The Faste's gate: heading 1024, its front (the courtyard) to the west.
const GATE: OwnDoor = { doorId: 252000301, at: { x: 34333, y: 38275, z: 3720 }, heading: 1024 };
const DOOR: OwnDoor = { doorId: 252000302, at: { x: 32654, y: 38180, z: 3720 }, heading: 1030 };
const p = (x: number, y: number, z = 3720) => ({ x, y, z });

describe('door geometry', () => {
    test('a heading of 1024 faces west, as GetPointFromHeading has it', () => {
        const f = doorFront(1024);
        expect(f.x).toBeCloseTo(-1, 6);
        expect(f.y).toBeCloseTo(0, 6);
    });

    test('outside the gate is behind it, the courtyard in front', () => {
        expect(doorSide(GATE, p(34650, 38250))).toBe(-1);
        expect(doorSide(GATE, p(33100, 38250))).toBe(1);
    });

    test('the jump lands 150 past a gate and 100 past an inner door, as live (34183 from outside)', () => {
        expect(doorLanding(GATE, -1)).toEqual(p(34183, 38275));
        expect(doorLanding(GATE, 1)).toEqual(p(34483, 38275));
        const inner = doorLanding(DOOR, -1);
        expect(Math.round(Math.hypot(inner.x - DOOR.at.x, inner.y - DOOR.at.y))).toBe(100);
        expect(inner.x).toBeLessThan(DOOR.at.x);
    });

    test('we use a door from 90 out on our side', () => {
        expect(doorApproach(GATE, -1)).toEqual(p(34423, 38275));
        expect(doorApproach(GATE, 1)).toEqual(p(34243, 38275));
    });
});

describe('doorOnRoute', () => {
    test('a route from outside into the courtyard passes the gate on its first leg', () => {
        expect(doorOnRoute(p(35500, 38250), [p(34000, 38240), p(33100, 38250)], [GATE])).toMatchObject({ door: GATE, index: 0, side: -1 });
    });

    test('the leg that crosses is named, and the way out goes the other way', () => {
        expect(doorOnRoute(p(33100, 38250), [p(33800, 38260), p(34600, 38270)], [GATE])).toMatchObject({ index: 1, side: 1 });
    });

    test('the wall-walk over the gate (256 up) and a pass beside it are no door', () => {
        expect(doorOnRoute(p(34500, 38275, 3976), [p(34100, 38275, 3976)], [GATE])).toBeNull();
        expect(doorOnRoute(p(34500, 37900), [p(34100, 37900)], [GATE])).toBeNull();
    });

    test('a route that ends on this side, or in the doorway, passes no door', () => {
        expect(doorOnRoute(p(35000, 38275), [p(34500, 38275)], [GATE])).toBeNull();
        expect(doorOnRoute(p(35000, 38275), [p(34333, 38275)], [GATE])).toBeNull();
    });

    test('of the two posterns at one spot, the one nearer our height', () => {
        const low: OwnDoor = { doorId: 252000306, at: { x: 32311, y: 38669, z: 3952 }, heading: 2058 };
        const high: OwnDoor = { doorId: 252000304, at: { x: 32311, y: 38669, z: 3976 }, heading: 2058 };
        expect(doorOnRoute(p(32311, 38400, 3975), [p(32311, 38900, 3978)], [low, high])?.door.doorId).toBe(252000304);
    });
});

describe('the keep\'s doors are ours to use only while the keep is', () => {
    afterEach(() => clearOwnDoors());

    test('our keep: every unbroken door, with its heading', () => {
        useOwnDoors(FASTE, { ours: true, broken: [252000302] });
        const ids = ownDoors(FASTE.regionId).map(d => d.doorId);
        expect(ids).toContain(252000301);
        expect(ids).not.toContain(252000302);
        expect(ids).toHaveLength(5);
        expect(ownDoors(FASTE.regionId).find(d => d.doorId === 252000301)!.heading).toBe(1024);
    });

    test('lost: none', () => {
        useOwnDoors(FASTE, { ours: true, broken: [] });
        useOwnDoors(FASTE, { ours: false, broken: [] });
        expect(ownDoors(FASTE.regionId)).toEqual([]);
    });
});

describe('walkTo through our own door', () => {
    let navmeshAt: Mock<NavmeshStore['at']>;
    beforeAll(() => {
        setDefaultPathProvider(new StraightLinePathProvider({ estimateZ: null }));
        navmeshAt = spyOn(getNavmeshStore(), 'at').mockReturnValue(null);
    });
    afterAll(() => {
        setDefaultPathProvider(null);
        navmeshAt.mockRestore();
    });
    let worlds: FakeWorld[] = [];
    afterEach(() => {
        for (const w of worlds) w.dispose();
        worlds = [];
        clearOwnDoors();
    });

    /** A world at the Faste, outside its gate, with the gate in view: interact within 192 jumps us through when `opens`. */
    async function atGate(opens = true) {
        const w = new FakeWorld();
        worlds.push(w);
        Object.assign(w.player, { regionId: 252, x: 35000, y: 38275, z: 3720 });
        w.state.nearbyObjects = [makeObject({ objectId: 77, name: 'Keep Door', doorId: GATE.doorId, x: GATE.at.x, y: GATE.at.y, z: GATE.at.z, heading: 1024, isLoot: false, ownedByUs: false })];
        w.handlers.interact = (a, world) => {
            if (a.type !== 'interact' || !opens) return;
            const me = world.player;
            if (Math.hypot(me.x - GATE.at.x, me.y - GATE.at.y, me.z - GATE.at.z) > 192) { world.message('The Keep Door is too far away to interact with!'); return; }
            const to = doorLanding(GATE, doorSide(GATE, me));
            setTimeout(() => {
                Object.assign(world.player, to);
                world.state.movement = { ...world.state.movement, moving: false, destination: null, waypoints: [], lastStopReason: 'teleported' };
            }, 20);
        };
        await Bun.sleep(30); // a published snapshot at the Faste
        return { w, bot: new BotActions(w.sdk) };
    }

    test('without a door of ours the walk is as before: straight on, no interact', async () => {
        const { w, bot } = await atGate();
        const r = await bot.walkTo(33100, 38250, { z: 3720, tolerance: 30 });
        expect(r.success).toBeTrue();
        expect(w.sentOf('interact')).toHaveLength(0);
    });

    test('stops at the gate, interacts, jumps through and walks on', async () => {
        const { w, bot } = await atGate();
        setOwnDoors(252, 'Thidranki Faste', [GATE]);
        const r = await bot.walkTo(33100, 38250, { z: 3720, tolerance: 30 });
        expect(r).toMatchObject({ success: true, message: 'Arrived' });
        expect(w.sentOf('interact')).toEqual([expect.objectContaining({ objectId: 77 })]);
        // The first move ends on our side of the gate, at its approach.
        const first = w.sentOf('moveTo')[0]!;
        expect(first).toMatchObject({ x: 34423, y: 38275 });
        // No move after it starts behind the gate and ends inside: the rest begins past the door.
        for (const m of w.sentOf('moveTo').slice(1)) expect(m.x).toBeLessThan(34333);
    });

    test('a door that does not open is not ours: reason door, and it is forgotten', async () => {
        const { w, bot } = await atGate(false);
        setOwnDoors(252, 'Thidranki Faste', [GATE]);
        const r = await bot.walkTo(33100, 38250, { z: 3720, tolerance: 30 });
        expect(r).toMatchObject({ success: false, reason: 'door' });
        expect(w.player.x).toBeGreaterThan(34333);
        expect(w.sentOf('interact').length).toBe(2);
        expect(ownDoors(252)).toEqual([]);
    }, 10_000);

    test('a destination this side of the door within tolerance takes no jump', async () => {
        const { w, bot } = await atGate();
        setOwnDoors(252, 'Thidranki Faste', [GATE]);
        const r = await bot.walkTo(34300, 38275, { z: 3720, tolerance: 150 });
        expect(r.success).toBeTrue();
        expect(w.sentOf('interact')).toHaveLength(0);
        expect(w.player.x).toBeGreaterThan(34333);
    });
});
