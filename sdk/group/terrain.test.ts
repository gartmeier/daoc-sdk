import { describe, expect, test } from 'bun:test';
import { findNpcSpawns } from '../../data/index';
import { aggroAt, aggroZones, chooseBase, keepOnMap, onMap, safePath } from './terrain';

describe('the map: Region.GetZone is null outside every zone, and the server dereferences that (NpcMovementComponent.cs:662, SummonSpellHandler.cs:77)', () => {
    // Run 160842: 'Calling RemoveFromWorld with (entityOwner: GameSummonedPet name=underhill companion oid=21205 loc=287881,650172,4617)' on a retreat toward
    // 'Calling KickPlayerToCharScreen with (... name=Petenc ... loc=286364,648697,4854 ...)'. Shannon Estuary's xOffset is 286720; west of it region 200 has no zone at that y.
    const EDGE_X = 286_720, Y = 648_697;

    test('onMap: in a zone, with a margin from its edge; a region with no zone data has nothing to go by', () => {
        expect(onMap(200, { x: EDGE_X + 1, y: Y })).toBe(true);
        expect(onMap(200, { x: EDGE_X - 1, y: Y })).toBe(false);
        expect(onMap(200, { x: EDGE_X + 50, y: Y }, 100)).toBe(false);
        expect(onMap(200, { x: EDGE_X + 150, y: Y }, 100)).toBe(true);
        expect(onMap(9999, { x: 1, y: 1 }, 100)).toBe(true);
    });

    test('a spot on the map stays what it was, to the unit', () => {
        const from = { x: 300_000, y: Y };
        expect(keepOnMap(200, from, { x: 297_500, y: Y })).toEqual({ x: 297_500, y: Y });
    });

    test('a retreat off the map turns or shortens until it holds: 2500 west from 800 inside the edge', () => {
        const from = { x: EDGE_X + 800, y: Y };
        const to = keepOnMap(200, from, { x: from.x - 2500, y: Y });
        expect(onMap(200, to, 300)).toBe(true);
        expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThan(1800);
        // The whole way there, not only its end.
        for (let i = 0; i <= 20; i++) expect(onMap(200, { x: from.x + (to.x - from.x) * i / 20, y: from.y + (to.y - from.y) * i / 20 })).toBe(true);
        // A second retreat chains from the first, and the check applies again.
        const second = keepOnMap(200, to, { x: to.x - 2500, y: to.y });
        expect(onMap(200, second, 300)).toBe(true);
    });

    test('a route goes round what is off the map too: the straight line along the edge dips out of it, the route doesn\'t', () => {
        // Silvermine Mts. is x 319488-385024, y 548864-614400, and Shannon Estuary x 286720-352256 from y 614400: below that, west of 319488, there is no zone.
        const from = { x: 321_000, y: 612_000 }, to = { x: 300_000, y: 616_000 };
        expect(onMap(200, { x: 315_000, y: 613_000 })).toBe(false);
        const route = safePath(200, 50, from, to);
        expect(route.length).toBeGreaterThan(1);
        let a = from;
        for (const p of route) {
            for (let i = 1; i <= 20; i++) expect(onMap(200, { x: a.x + (p.x - a.x) * i / 20, y: a.y + (p.y - a.y) * i / 20 })).toBe(true);
            a = p;
        }
    });

    test('from off the map or in a region with no zones: as given, there is nothing to go by', () => {
        expect(keepOnMap(200, { x: 1000, y: 1000 }, { x: 3000, y: 1000 })).toEqual({ x: 3000, y: 1000 });
        expect(keepOnMap(9999, { x: 1000, y: 1000 }, { x: 3000, y: 1000 })).toEqual({ x: 3000, y: 1000 });
    });
});

describe('terrain (static data, Shannon Estuary)', () => {
    test('aggro comes from the nearest spawn: the same name is aggressive in one camp and passive in another', () => {
        expect(aggroAt(200, 'wind ghoul', { x: 290348, y: 458975 })?.range).toBe(500);
        expect(aggroAt(200, 'wind ghoul', { x: 316154, y: 456937 })).toBeNull();
        // Mudmen are passive everywhere: their npctemplates (ReplaceMobValues) have AggroLevel 0,
        // whatever the stale mob rows say.
        expect(aggroAt(200, 'mudman', { x: 303753, y: 461624 })).toBeNull();
        // The lugradan whelp camp east of Mag Mell: passive, though "feccan" is aggressive elsewhere.
        expect(aggroAt(200, 'feccan', { x: 307784, y: 634226 })).toBeNull();
        expect(aggroAt(200, 'no such mob', { x: 0, y: 0 })).toBeNull();
    });

    test('chooseBase keeps the requested clearance from every spawn, relaxing it only when nothing qualifies', () => {
        const nearestSpawn = (p: { x: number; y: number }) => findNpcSpawns({ regionId: 200, near: p, limit: 1 })[0]!.distance!;
        // Water beetles near Tir na mBeo (Lough Derg), approached from the town.
        const camp = { x: 349053, y: 532689, z: 5400 }, from = { x: 345698, y: 528897 };
        expect(nearestSpawn(chooseBase(200, 8, camp, from))).toBeGreaterThanOrEqual(700);
        expect(nearestSpawn(chooseBase(200, 8, camp, from, 1300))).toBeGreaterThanOrEqual(1300);
        // Aggressive spawns near our level get twice the clearance: the passive red wolfhound camp
        // west of Tir na mBeo has wild lucradans (L9-10, aggressive) 4,700 east; a base on that side wiped the group.
        const wolves = { x: 333707, y: 529072, z: 5400 };
        const aggressive = findNpcSpawns({ regionId: 200, near: chooseBase(200, 9, wolves, from, 1300), radius: 2600 })
            .filter(s => s.aggroLevel > 0 && s.aggroRange > 0 && s.level >= 8 && !(s.flags & 0x10));
        expect(aggressive).toEqual([]);
        // No spot is 50,000 from every spawn: falls back to the smallest clearance instead of the camp centre.
        expect(nearestSpawn(chooseBase(200, 8, camp, from, 50_000))).toBeGreaterThanOrEqual(700);
    });

    test('safePath is a straight line where nothing dangerous is in the way', () => {
        expect(safePath(9999, 5, { x: 0, y: 0 }, { x: 5000, y: 0 })).toEqual([{ x: 5000, y: 0 }]);
    });

    test('aggro zones leave out mobs that con grey: they never attack', () => {
        const lunantishee = (level: number) => aggroZones(200, level).filter(z => z.name === 'lunantishee');
        expect(lunantishee(11).length).toBeGreaterThan(0);   // L8-9: blue to 11
        expect(lunantishee(20)).toEqual([]);                  // grey to 20
        expect(lunantishee(11)[0]!.r).toBe(500 + 300);        // aggro range plus wandering room
    });

    test('safePath goes around every aggro zone the straight line crosses', () => {
        // Session 2: from the red wolfhound camp west of Tir na mBeo to the next camp for level 11,
        // the straight line crosses aggressive red wolfhounds and badgers.
        const from = { x: 333707, y: 529072 }, to = { x: 333638, y: 536348 };
        const zones = aggroZones(200, 11);
        const inside = (pts: { x: number; y: number }[]) => {
            let n = 0, a = from;
            for (const b of pts) {
                const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 50);
                for (let i = 1; i <= steps; i++) {
                    const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps;
                    if (zones.some(z => Math.hypot(z.x - x, z.y - y) < z.r)) n++;
                }
                a = b;
            }
            return n;
        };
        expect(inside([to])).toBeGreaterThan(0);
        const path = safePath(200, 11, from, to);
        expect(path.at(-1)).toEqual(to);
        expect(inside(path)).toBe(0);
    });
});
