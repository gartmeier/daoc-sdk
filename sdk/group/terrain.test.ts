import { describe, expect, test } from 'bun:test';
import { findNpcSpawns } from '../../data/index';
import { aggroAt, chooseBase, safePath } from './terrain';

describe('terrain (static data, Shannon Estuary)', () => {
    test('aggro comes from the nearest spawn: the same name is aggressive in one camp and passive in another', () => {
        expect(aggroAt(200, 'mudman', { x: 303753, y: 461624 })?.range).toBe(500);
        expect(aggroAt(200, 'mudman', { x: 288913, y: 457729 })).toBeNull();
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
});
