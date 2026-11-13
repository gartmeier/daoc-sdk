import { describe, expect, test } from 'bun:test';
import { makeMessage, makePlayer, makeState } from '../test/fixtures';
import { observeState, type MemberSelf } from './blackboard';
import { FASTE } from './siege';

const T = 1_800_000_000_000;
const self: MemberSelf = { bot: 'm', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } as any };
const gate = FASTE.targets.find(t => t.label === 'gate')!.doorId!;
const door = FASTE.targets.find(t => t.label === 'keep-door')!.doorId!;
const player = makePlayer({ objectId: 10, name: 'M0', realm: 'midgard', regionId: FASTE.regionId, x: 34_420, y: 38_275, z: 3720 });

describe('observeState: the server\'s door state (0x99) in the report', () => {
    test('open is broken, shut is shut; the broken line only for a door without one', () => {
        const line = [makeMessage(1, 'The Keep Door is broken!', { receivedAt: T - 500 })];
        // No 0x99 at all (a client from before the reader): the line by the nearest door, as before.
        const old = observeState(makeState({ timestamp: T, inGame: true, player, nearbyNpcs: [], nearbyPlayers: [], combatEvents: [], gameMessages: line }), self)!.report;
        expect(old.doorsBroken).toEqual([gate]);
        expect(old.doorsShut).toBeUndefined();
        // The gate repaired (shut by 0x99) beats the line; the building's door open by 0x99 is broken without one.
        const st = makeState({ timestamp: T, inGame: true, player, nearbyNpcs: [], nearbyPlayers: [], combatEvents: [], gameMessages: line, doors: [{ doorId: gate, open: false, receivedAt: T - 100 }, { doorId: door, open: true, receivedAt: T - 100 }] } as any);
        const r = observeState(st, self)!.report;
        expect(r.doorsBroken).toEqual([door]);
        expect(r.doorsShut).toEqual([gate]);
    });
});
