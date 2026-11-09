import { describe, expect, test } from 'bun:test';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import type { CombatEvent } from '../types';
import { heldBySwing, lastSwungAt, warrior } from './warrior';

const ME = 10, FOE = 20, ALLY = 30;
const swing = (attacker: number, target: number, ago: number, now: number): CombatEvent =>
    ({ id: 0, kind: 'melee', attackerObjectId: attacker, targetObjectId: target, receivedAt: now - ago });

describe('warrior kit', () => {
    test('its fight is the tank\'s, once in every list', () => {
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.tank as Behavior<any>[], warrior()).map(b => b.name);
            expect(list.filter(n => n === 'tank')).toHaveLength(1);
        }
    });

    test('a player\'s last swing says whom it is on, while it is recent', () => {
        const now = 1_000_000;
        const state = { combatEvents: [swing(FOE, ME, 6000, now), swing(FOE, ALLY, 2000, now), swing(ALLY, FOE, 1000, now)] };
        expect(lastSwungAt(state, FOE, now)).toBe(ALLY);
        expect(lastSwungAt(state, FOE, now + 9000)).toBeNull();
        expect(lastSwungAt(state, 99, now)).toBeNull();
    });

    test('a player on someone else reads as held; on us, or a monster, as it was', () => {
        const now = Date.now();
        const seenTargets: unknown[] = [];
        const pick = heldBySwing(seen => { seenTargets.push((seen.target as any).targetObjectId); return null; });
        const run = (kind: 'player' | 'npc', events: CombatEvent[]) => pick({
            target: { kind, objectId: FOE, ...(kind === 'npc' ? { targetObjectId: 77 } : {}) } as any,
            player: { objectId: ME } as any, state: { combatEvents: events } as any, styles: [],
        });
        run('player', [swing(FOE, ALLY, 500, now)]);
        run('player', [swing(FOE, ME, 500, now)]);
        run('player', []);
        run('npc', [swing(FOE, ALLY, 500, now)]);
        expect(seenTargets).toEqual([ALLY, undefined, undefined, 77]);
    });
});
