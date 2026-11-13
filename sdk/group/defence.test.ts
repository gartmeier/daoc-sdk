import { describe, expect, test } from 'bun:test';
import { defenceSettings, onStand } from './defence';
import { defenceOrders, defencePlan, type Defender } from './siege';

const plan = defencePlan('albion')!;
const yard = plan.stands.find(s => s.label === 'yard-gate')!;
const wall = plan.stands.find(s => s.label === 'wall-se')!;

describe('defenceSettings', () => {
    const defenders: Defender[] = [
        { id: 1, x: 33900, y: 38275, z: 3720, alive: true, jobs: ['yard'] },
        { id: 2, x: 33752, y: 38764, z: 3968, alive: true, jobs: ['wall', 'yard'] },
    ];
    const names = new Map([[1, 'Gawain'], [2, 'Vivien']]);

    test('seats by name, and the same object while nothing changes', () => {
        const o = defenceOrders(plan, { defenders, foes: [], owner: 'albion' });
        const a = defenceSettings(plan, o, names, [252000302])!;
        expect(a.seats.Gawain!.label).toBe('yard-gate');
        expect(a.seats.Vivien!.label).toBe('wall-se');
        expect(a.phase).toBe('holding');
        const b = defenceSettings(plan, defenceOrders(plan, { defenders, foes: [], owner: 'albion' }), names, [252000302], a);
        expect(b).toBe(a);
        const c = defenceSettings(plan, defenceOrders(plan, { defenders, foes: [{ ...plan.lord }], owner: 'albion' }), names, [252000302], a);
        expect(c).not.toBe(a);
        expect(c!.phase).toBe('roof');
    });

    test('none once the keep is lost', () => {
        expect(defenceSettings(plan, defenceOrders(plan, { defenders, foes: [], owner: 'midgard' }), names)).toBeNull();
    });
});

describe('onStand', () => {
    test('on it within 150 and 100 in height; the wall above is not the courtyard below', () => {
        expect(onStand({ x: 33950, y: 38300, z: 3720 }, yard, false)).toBe(true);
        expect(onStand({ x: 33752, y: 38764, z: 3722 }, wall, false)).toBe(false);
    });
    test('within its leash only in a fight; a leash of 0 never', () => {
        expect(onStand({ x: 34400, y: 38275, z: 3720 }, yard, true)).toBe(true);
        expect(onStand({ x: 34400, y: 38275, z: 3720 }, yard, false)).toBe(false);
        expect(onStand({ x: 33752, y: 38464, z: 3968 }, wall, true)).toBe(false);
    });
});
