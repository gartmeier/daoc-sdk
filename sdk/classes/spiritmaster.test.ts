import { describe, expect, test } from 'bun:test';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import { enemy } from '../group/fixtures';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { inReachTarget, spiritmaster } from './spiritmaster';

describe('spiritmaster kit', () => {
    test('a nuker whose fight is assist, then nukeInReach, in every list', () => {
        expect(spiritmaster().role).toBe('nuker');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.nuker as Behavior<any>[], spiritmaster()).map(b => b.name);
            expect(list.filter(n => n === 'assist')).toHaveLength(1);
            expect(list.indexOf('nukeInReach')).toBe(list.indexOf('assist') + 1);
            expect(list.indexOf('quickcast')).toBe(list.indexOf('flee') - 1);
        }
    });

    test('a free enemy player in reach, healers first; never the focus, a mezzed one, a pet or one out of reach', () => {
        const now = 1_000_000;
        const d: Record<number, number> = { 1: 900, 2: 1200, 3: 600, 4: 500, 5: 500, 6: 1480 };
        const distanceTo = (id: number) => d[id] ?? Infinity;
        const plain = enemy(1, 'hibernia', { hp: 40 });
        const healer = enemy(2, 'hibernia', { healer: true });
        const focus = enemy(3, 'hibernia');
        const mezzed = enemy(4, 'hibernia', { healer: true, cc: { by: 'Sigrid', kind: 'mezz', until: now + 9000 } });
        const pet = { ...enemy(5, 'hibernia'), kind: 'npc' as const, isPet: true };
        const edge = enemy(6, 'hibernia', { healer: true });
        expect(inReachTarget([plain, healer, focus, mezzed, pet, edge], 3, distanceTo, 1500, now)?.objectId).toBe(2);
        expect(inReachTarget([plain, focus, mezzed, pet, edge], 3, distanceTo, 1500, now)?.objectId).toBe(1);
        expect(inReachTarget([focus, mezzed, pet, edge], 3, distanceTo, 1500, now)).toBeNull();
        expect(inReachTarget([plain, healer], 3, distanceTo, 1500, now, new Map([[2, now + 5000]]))?.objectId).toBe(1);
        expect(inReachTarget([plain, healer], 3, distanceTo, 1500, now, new Map([[2, now - 1]]))?.objectId).toBe(2);
    });
});
