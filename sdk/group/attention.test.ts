import { describe, expect, test } from 'bun:test';
import { makePlayer, makePlayerObj, makeState } from '../test/fixtures';
import type { CombatEvent, NearbyPlayer } from '../types';
import { fighting, HUMAN_VISION, inFightVision, NOTICE_MAX_MS, type GroundAt, type NoticeClock } from '../vision';
import { Blackboard, observeState, type MemberSelf } from './blackboard';
import { fightAttention, SKILL_PRESETS } from './skill';

// In-fight attention (the user, 2026-11-12): a member that fights sees a narrower cone and notices a new enemy later,
// by its skill; what swings at it is known at once; omniscient sight is untouched.

// We are Testbot (100, albion) at (560000, 511000, z 2500), heading 0: facing +Y.
const X = 560000, Y = 511000, Z = 2500;
const T = 1_000_000;
const self: MemberSelf = { bot: 'testbot', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } };
const flat: GroundAt = () => Z;
const foe = (objectId: number, dx: number, dy: number) =>
    makePlayerObj({ objectId, name: 'Norseman', realm: 'midgard', x: X + dx, y: Y + dy, z: Z, distance: Math.hypot(dx, dy), distance2d: Math.hypot(dx, dy) });
let id = 0;
const ev = (kind: CombatEvent['kind'], attacker: number, target: number | null, at: number): CombatEvent =>
    ({ id: ++id, kind, attackerObjectId: attacker, targetObjectId: target, receivedAt: at });
const look = (o: { players?: NearbyPlayer[]; events?: CombatEvent[]; now?: number; target?: number | null; inCombat?: boolean } = {}) =>
    makeState({
        timestamp: o.now ?? T, player: makePlayer({ objectId: 100, x: X, y: Y, z: Z, heading: 0, targetObjectId: o.target ?? null, inCombat: o.inCombat ?? false }),
        nearbyPlayers: o.players ?? [], nearbyNpcs: [], combatEvents: o.events ?? [],
    });
const ids = (o: ReturnType<typeof observeState>) => o!.sightings.map(s => s.objectId).sort();
const average = inFightVision(HUMAN_VISION, fightAttention(SKILL_PRESETS.average));

describe('fightAttention and inFightVision', () => {
    test('scaled by the preset: novice narrowest and slowest, sharp least', () => {
        const at = (p: keyof typeof SKILL_PRESETS) => {
            const v = inFightVision(HUMAN_VISION, fightAttention(SKILL_PRESETS[p]));
            return [v.fovDegrees, v.awareRadius, v.noticeMs];
        };
        expect(at('novice')).toEqual([45, 225, 3000]);
        expect(at('average')).toEqual([65, 325, 2200]);
        expect(at('sharp')).toEqual([78, 390, 1680]);
    });

    test('a skill of zeros changes nothing: the same options object', () => {
        expect(inFightVision(HUMAN_VISION, fightAttention({ reactionMs: 0, switchMs: 0, mistakeRate: 0 }))).toBe(HUMAN_VISION);
    });

    test('fighting: own target set, and in combat or swinging', () => {
        expect(fighting(null)).toBe(false);
        expect(fighting({ targetObjectId: null, inCombat: true, attacking: true })).toBe(false);
        expect(fighting({ targetObjectId: 7, inCombat: false, attacking: false })).toBe(false);
        expect(fighting({ targetObjectId: 7, inCombat: true })).toBe(true);
        expect(fighting({ targetObjectId: 7, inCombat: false, attacking: true })).toBe(true);
    });
});

describe('observeState with in-fight vision', () => {
    // 45° off our heading: inside the 100° cone, outside the 65° one; 1500 off.
    const aside = foe(301, Math.round(1500 * Math.sin(45 * Math.PI / 180)), Math.round(1500 * Math.cos(45 * Math.PI / 180)));
    const ahead = foe(302, 0, 1500);

    test('the narrower cone leaves out an enemy the normal cone sees', () => {
        expect(ids(observeState(look({ players: [aside] }), self, 3000, { ...HUMAN_VISION, noticeMs: 0 }, flat))).toEqual([301]);
        expect(ids(observeState(look({ players: [aside] }), self, 3000, { ...average, noticeMs: 0 }, flat))).toEqual([]);
    });

    test('a new enemy ahead is noticed after the longer delay, and stays pending until then', () => {
        const clock: NoticeClock = new Map();
        const at = (now: number) => observeState(look({ now, players: [ahead] }), self, 3000, average, flat, clock)!;
        expect(ids(at(T))).toEqual([]);
        expect(ids(at(T + HUMAN_VISION.noticeMs))).toEqual([]);
        const waiting = at(T + 2000);
        expect(ids(waiting)).toEqual([]);
        expect(waiting.sight?.pending).toEqual([302]);
        const seen = at(T + average.noticeMs);
        expect(ids(seen)).toEqual([302]);
        expect(seen.sight?.pending).toBeUndefined();
    });

    test('one that swings at us is known at once, whatever the cone and the clock', () => {
        const clock: NoticeClock = new Map();
        const behind = foe(303, 0, -1500);
        expect(ids(observeState(look({ players: [behind], events: [ev('melee', 303, 100, T - 200)] }), self, 3000, average, flat, clock))).toEqual([303]);
    });

    test('human vision at its own delay reports no pending: the forget rule as before', () => {
        expect(NOTICE_MAX_MS).toBeLessThan(average.noticeMs);
        const o = observeState(look({ players: [ahead] }), self, 3000, HUMAN_VISION, flat, new Map())!;
        expect(o.sight).toEqual({ heading: 0, vision: HUMAN_VISION });
    });

    test('omniscient sight is unchanged: everyone in range, no sight', () => {
        const o = observeState(look({ players: [aside, ahead], target: 302, inCombat: true }), self)!;
        expect(ids(o)).toEqual([301, 302]);
        expect(o.sight).toBeUndefined();
    });
});

describe('Blackboard forget rule with a member that fights', () => {
    test('a contact the member has in view but is still noticing is not forgotten', () => {
        const b = new Blackboard({ ground: flat });
        // Seen at T (by this member, or another).
        b.publish(observeState(look({ players: [foe(302, 0, 1500)] }), self, 3000, { ...HUMAN_VISION, noticeMs: 0 }, flat)!, T);
        // Out of view past the clock's grace, then back in view while the member fights: pending, not yet noticed.
        const clock: NoticeClock = new Map();
        const later = observeState(look({ now: T + 2000, players: [foe(302, 0, 1500)] }), self, 3000, average, flat, clock)!;
        expect(later.sight?.pending).toEqual([302]);
        b.publish(later, T + 2000);
        expect(b.picture(T + 2000).contacts.map(c => c.objectId)).toEqual([302]);
    });

    test('a contact gone from its spot in the narrower cone is forgotten, as before', () => {
        const b = new Blackboard({ ground: flat });
        b.publish(observeState(look({ players: [foe(302, 0, 1500)] }), self, 3000, { ...HUMAN_VISION, noticeMs: 0 }, flat)!, T);
        b.publish(observeState(look({ now: T + 2000 }), self, 3000, average, flat, new Map())!, T + 2000);
        expect(b.picture(T + 2000).contacts).toEqual([]);
    });
});
