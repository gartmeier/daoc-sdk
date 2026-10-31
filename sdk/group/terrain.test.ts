import { describe, expect, test } from 'bun:test';
import { findNpcSpawns } from '../../data/index';
import { aggroAt, aggroZones, chooseBase, safePath } from './terrain';

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
