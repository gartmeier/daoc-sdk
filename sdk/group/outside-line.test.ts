import { describe, expect, test } from 'bun:test';
import { getOccluderStore } from '../occluders';
import { getTerrainStore } from '../terrain';
import { lineOfSight } from '../vision';
import { FASTE, outsideLine, raidOrders, raidPlan } from './siege';

const faste = getTerrainStore().forZone(252) !== null && getOccluderStore().forZone(252) !== null;
describe.skipIf(!faste)('outsideLine: the ray from a wall caster through its outside spot', () => {
    test('every point sees its wall caster, the spot first', () => {
        for (const t of FASTE.targets.filter(x => x.outside)) {
            const pts = outsideLine(252, t.at, t.outside!);
            expect(pts.length).toBeGreaterThan(2);
            for (const p of pts) expect(lineOfSight(252, p, t.at)).toBe(true);
            expect(pts[0]).toEqual({ x: t.outside!.x, y: t.outside!.y, z: t.outside!.z });
        }
    });
    test('the ranged half\'s outside task carries it (RaidTask.line)', () => {
        const plan = raidPlan('hibernia')!;
        const at = (l: string) => FASTE.targets.find(t => t.label === l)!;
        const members = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, x: 34600, y: 38200 + i * 20, z: 3722, alive: true }));
        const seen = ['wall-se', 'wall-e-s', 'wall-e-n'].map((l, i) => ({ id: 7 + i, name: 'Runemaster', realm: 'midgard', kind: 'npc' as const, ...at(l).at }));
        const o = raidOrders(plan, { members, seen, owner: 'midgard', staged: true, broken: [252000301], reach: () => true });
        expect(o.ranged.line?.length).toBeGreaterThan(2);
        expect(o.ranged.line![0]).toEqual(o.ranged.stand);
    });
});
