import { describe, expect, test } from 'bun:test';
import { makeNpc, makePlayer, makePlayerObj, makeState } from '../test/fixtures';
import type { CombatEvent, NearbyNpc, NearbyPlayer } from '../types';
import { HUMAN_VISION, type GroundAt, type NoticeClock } from '../vision';
import { Blackboard, observeState, type MemberSelf } from './blackboard';
import { runVision, withVisionFlag } from './runner';

// We are Testbot (100, albion) at (560000, 511000, z 2500), heading 0: facing +Y.
const X = 560000, Y = 511000, Z = 2500;
const T = 1_000_000;
const self: MemberSelf = { bot: 'testbot', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } };
const flat: GroundAt = () => Z;
/** A hill 400 high across our path, 900..1100 ahead. */
const hill: GroundAt = (_r, _x, y) => (y > Y + 900 && y < Y + 1100 ? Z + 400 : Z);

const foe = (objectId: number, dx: number, dy: number, over: Partial<NearbyPlayer> = {}) =>
    makePlayerObj({ objectId, name: 'Norseman', realm: 'midgard', x: X + dx, y: Y + dy, z: Z, distance: Math.hypot(dx, dy), distance2d: Math.hypot(dx, dy), ...over });
const mob = (objectId: number, dx: number, dy: number, over: Partial<NearbyNpc> = {}) =>
    makeNpc({ objectId, name: 'wolf', level: 5, x: X + dx, y: Y + dy, z: Z, distance: Math.hypot(dx, dy), distance2d: Math.hypot(dx, dy), ...over });
let id = 0;
const ev = (kind: CombatEvent['kind'], attacker: number, target: number | null, ago: number): CombatEvent =>
    ({ id: ++id, kind, attackerObjectId: attacker, targetObjectId: target, receivedAt: T - ago });

const look = (o: { players?: NearbyPlayer[]; npcs?: NearbyNpc[]; events?: CombatEvent[]; heading?: number; target?: number | null; now?: number; x?: number } = {}) =>
    makeState({
        timestamp: o.now ?? T, player: makePlayer({ objectId: 100, x: o.x ?? X, y: Y, z: Z, heading: o.heading ?? 0, targetObjectId: o.target ?? null }),
        nearbyPlayers: o.players ?? [], nearbyNpcs: o.npcs ?? [], combatEvents: o.events ?? [],
    });
const ids = (o: ReturnType<typeof observeState>) => o!.sightings.map(s => s.objectId).sort();

describe('observeState with human vision', () => {
    const ahead = foe(301, 0, 2000), behind = foe(302, 0, -2000), near = foe(303, 0, -400), aside = foe(304, 2000, 100);

    test('omniscient (the default) reports everyone in range, as before', () => {
        const o = observeState(look({ players: [ahead, behind, near, aside] }), self);
        expect(ids(o)).toEqual([301, 302, 303, 304]);
        expect(o!.sight).toBeUndefined();
    });

    test('human: ahead and close are seen; behind and beside are not', () => {
        const o = observeState(look({ players: [ahead, behind, near, aside] }), self, 3000, HUMAN_VISION, flat);
        expect(ids(o)).toEqual([301, 303]);
        expect(o!.sight).toEqual({ heading: 0, vision: HUMAN_VISION });
        // Turned round, the other one.
        expect(ids(observeState(look({ players: [ahead, behind, near], heading: 2048 }), self, 3000, HUMAN_VISION, flat))).toEqual([302, 303]);
    });

    test('human: a hill between hides an enemy ahead', () => {
        expect(ids(observeState(look({ players: [ahead] }), self, 3000, HUMAN_VISION, hill))).toEqual([]);
        // One standing on top of it is seen.
        expect(ids(observeState(look({ players: [foe(305, 0, 1000, { z: Z + 400 })] }), self, 3000, HUMAN_VISION, hill))).toEqual([305]);
    });

    test('human: what hits us or our target is known whatever the facing', () => {
        expect(ids(observeState(look({ players: [behind], events: [ev('melee', 302, 100, 500)] }), self, 3000, HUMAN_VISION, flat))).toEqual([302]);
        expect(ids(observeState(look({ players: [behind], events: [ev('spellEffect', 302, 100, 500)] }), self, 3000, HUMAN_VISION, flat))).toEqual([302]);
        expect(ids(observeState(look({ players: [behind], target: 302 }), self, 3000, HUMAN_VISION, flat))).toEqual([302]);
        // Its swing at somebody else says nothing to us.
        expect(ids(observeState(look({ players: [behind], events: [ev('melee', 302, 555, 500)] }), self, 3000, HUMAN_VISION, flat))).toEqual([]);
    });

    test('human: an enemy realm pet behind us is unseen, a monster behind us still reported', () => {
        const pet = mob(401, 0, -2000, { name: 'spirit', realm: 'midgard', isPet: true });
        const wolf = mob(402, 0, -2000);
        expect(ids(observeState(look({ npcs: [pet, wolf] }), self, 3000, HUMAN_VISION, flat))).toEqual([402]);
        expect(ids(observeState(look({ npcs: [pet, wolf] }), self))).toEqual([401, 402]);
    });

    test('human with a notice clock: one only seen is reported after noticeMs; one that hits us at once', () => {
        const clock: NoticeClock = new Map();
        const at = (now: number, events: CombatEvent[] = []) => ids(observeState(look({ now, players: [ahead, behind], events }), self, 3000, HUMAN_VISION, flat, clock));
        expect(at(T)).toEqual([]);
        expect(at(T + 500)).toEqual([]);
        expect(at(T + HUMAN_VISION.noticeMs)).toEqual([301]);
        // The one behind us swings at us: known at once, no notice wait.
        expect(at(T + HUMAN_VISION.noticeMs, [ev('melee', 302, 100, -HUMAN_VISION.noticeMs + 200)])).toEqual([301, 302]);
    });
});

describe('Blackboard forget rule with human vision', () => {
    // An enemy player 1500 ahead that we saw; then it is gone from our sightings.
    const seenOnce = (b: Blackboard) => b.publish(observeState(look({ players: [foe(301, 0, 1500)] }), self, 3000, HUMAN_VISION, flat)!, T);

    test('a member that turned away keeps the contact: it could not have seen it', () => {
        const b = new Blackboard({ ground: flat });
        seenOnce(b);
        b.publish(observeState(look({ now: T + 2000, heading: 2048, players: [foe(301, 0, 1500)] }), self, 3000, HUMAN_VISION, flat)!, T + 2000);
        expect(b.picture(T + 2000).contacts.map(c => c.objectId)).toEqual([301]);
    });

    test('a member that looks at its spot and sees nothing forgets it', () => {
        const b = new Blackboard({ ground: flat });
        seenOnce(b);
        b.publish(observeState(look({ now: T + 2000 }), self, 3000, HUMAN_VISION, flat)!, T + 2000);
        expect(b.picture(T + 2000).contacts).toEqual([]);
    });

    test('a hill between the member and the spot keeps it too', () => {
        const b = new Blackboard({ ground: hill });
        // Seen once (here: as if over flat ground), then hidden by the hill.
        b.publish(observeState(look({ players: [foe(301, 0, 2000)] }), self, 3000, HUMAN_VISION, flat)!, T);
        const later = observeState(look({ now: T + 2000, players: [foe(301, 0, 2000)] }), self, 3000, HUMAN_VISION, hill)!;
        expect(later.sightings).toEqual([]);
        b.publish(later, T + 2000);
        expect(b.picture(T + 2000).contacts.map(c => c.objectId)).toEqual([301]);
    });

    test('omniscient members forget as before', () => {
        const b = new Blackboard();
        b.publish(observeState(look({ players: [foe(301, 0, 1500)] }), self)!, T);
        b.publish(observeState(look({ now: T + 2000, heading: 2048 }), self)!, T + 2000);
        expect(b.picture(T + 2000).contacts).toEqual([]);
    });
});

describe('withVisionFlag', () => {
    test('no flag keeps the strategy\'s', () => {
        expect(withVisionFlag(undefined, undefined)).toBeUndefined();
        expect(withVisionFlag('human', undefined)).toBe('human');
    });
    test('--vision=human / omniscient sets the mode and keeps the strategy\'s numbers', () => {
        expect(withVisionFlag(undefined, 'human')).toEqual({ mode: 'human' });
        expect(withVisionFlag({ mode: 'human', fovDegrees: 90 }, 'omniscient')).toEqual({ mode: 'omniscient', fovDegrees: 90 });
    });
    test('--vision.fovDegrees=120 means human with that cone', () => {
        expect(withVisionFlag(undefined, { fovDegrees: 120 })).toEqual({ mode: 'human', fovDegrees: 120 });
        expect(withVisionFlag('omniscient', { awareRadius: 300 })).toEqual({ mode: 'human', awareRadius: 300 });
        expect(withVisionFlag(undefined, { mode: 'omniscient' })).toEqual({ mode: 'omniscient' });
    });
});

describe('a group run sees as a player does unless told otherwise (runVision)', () => {
    test('no strategy vision and no flag: human', () => {
        expect(runVision(undefined, undefined)).toBe('human');
    });
    test('--vision=omniscient, or a strategy that says so, keeps all-seeing sight', () => {
        expect(runVision(undefined, 'omniscient')).toEqual({ mode: 'omniscient' });
        expect(runVision('omniscient', undefined)).toBe('omniscient');
    });
    test('a strategy with its own human options keeps them, and a flag tunes them', () => {
        expect(runVision({ mode: 'human', fovDegrees: 90 }, undefined)).toEqual({ mode: 'human', fovDegrees: 90 });
        expect(runVision(undefined, { fovDegrees: 120 })).toEqual({ mode: 'human', fovDegrees: 120 });
    });
});
