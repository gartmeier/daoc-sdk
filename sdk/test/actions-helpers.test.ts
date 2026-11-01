import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { ChatHistory } from '../chat-history';
import { ATTACK_REFUSALS, CAST_REFUSALS, conColor, conLevel, diffInventory, experienceFromMessages, isCrowdControlled, isFatalAttackRefusal, isKillable, isPvpImmunity, MessageWatch, USE_ITEM_REFUSALS } from '../actions-helpers';
import { castFailureReason } from '../actions';
import { StraightLinePathProvider, getDefaultPathProvider, setDefaultPathProvider } from '../pathfinding';
import type { InventoryItem } from '../types';
import { makeMessage, makeNpc, makePlayer, makeState } from './fixtures';

const item = (slot: number, name: string, count = 1): InventoryItem => ({
    slot, name, count, level: 1, model: 1, objectType: 0, condition: 100, durability: 100, quality: 85, weight: 1, value1: 0, value2: 0,
});

describe('conLevel (ConLevelGrid.cs)', () => {
    test('level 1: level 0 is blue, 1 yellow, 2 orange, 3 red, 4+ purple', () => {
        expect([0, 1, 2, 3, 4, 10].map(l => conLevel(1, l))).toEqual([-1, 0, 1, 2, 3, 3]);
    });

    test('level 10 spans', () => {
        // [grey 7, green 1, blue 2, yellow 1, orange 1, red 2]
        expect([0, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(l => conLevel(10, l))).toEqual([-3, -3, -2, -1, -1, 0, 1, 2, 2, 3]);
    });

    test('level 50 and beyond', () => {
        expect(conLevel(50, 35)).toBe(-3);
        expect(conLevel(50, 36)).toBe(-2);
        expect(conLevel(50, 50)).toBe(0);
        expect(conLevel(55, 41)).toBe(-2);
        expect(conLevel(55, 40)).toBe(-3);
    });

    test('colors', () => {
        expect([-3, -2, -1, 0, 1, 2, 3].map(conColor)).toEqual(['grey', 'green', 'blue', 'yellow', 'orange', 'red', 'purple']);
    });
});

describe('isKillable', () => {
    const p = makePlayer();
    test('monsters yes, townsfolk and realm NPCs no', () => {
        expect(isKillable(makeNpc(), p)).toBeTrue();
        expect(isKillable(makeNpc({ realm: 'albion' }), p)).toBeFalse();
        expect(isKillable(makeNpc({ name: 'Grizelda', role: 'merchant' }), p)).toBeFalse();
        expect(isKillable(makeNpc({ name: 'Guard Ulf', role: 'guard' }), p)).toBeFalse();
        // The role is guessed from the name: a monster called "... royal guard" is still a monster.
        expect(isKillable(makeNpc({ name: 'wood-eater royal guard', role: 'guard' }), p)).toBeTrue();
        expect(isKillable(makeNpc({ isPeaceful: true }), p)).toBeFalse();
        expect(isKillable(makeNpc({ healthPercent: 0 }), p)).toBeFalse();
        expect(isKillable(makeNpc({ name: '' }), p)).toBeFalse();
    });
});

describe('deltas', () => {
    test('diffInventory counts stacks by name', () => {
        const before = [item(40, 'rat tail', 2), item(41, 'sword')];
        const after = [item(40, 'rat tail', 5), item(42, 'bag')];
        const d = diffInventory(before, after);
        expect(d.gained.map(i => [i.name, i.count])).toEqual([['rat tail', 3], ['bag', 1]]);
        expect(d.lost.map(i => [i.name, i.count])).toEqual([['sword', 1]]);
    });

    test('experienceFromMessages sums "You get N experience points"', () => {
        expect(experienceFromMessages([
            makeMessage(1, 'You get 17 experience points. (2 camp bonus) '),
            makeMessage(2, 'You get 1,234 experience points.'),
            makeMessage(3, 'The rat dies!'),
        ])).toBe(1251);
    });

    test('castFailureReason', () => {
        expect(castFailureReason("You don't have enough power to cast that!")).toBe('no_power');
        expect(castFailureReason('The puny skeleton attacks you and your spell is interrupted!')).toBe('interrupted');
        expect(castFailureReason('You must wait 2 seconds to cast a spell!')).toBe('must_wait');
        expect(castFailureReason('That target is too far away!')).toBe('out_of_range');
        expect(castFailureReason('Your target is not visible!')).toBe('not_visible');
        expect(castFailureReason('You must select a target for this spell!')).toBe('no_target');
    });

    test('PvP immunity is its own reason, though ours also reads like a fatal refusal (AbstractServerRules.cs:350-375)', () => {
        const ours = "You can't attack players until your PvP invulnerability timer wears off!";
        const theirs = ['Norseman is temporarily immune to PvP attacks!', 'Norseman is entering the game and cannot be attacked!'];
        for (const text of [ours, ...theirs]) {
            expect(isPvpImmunity(text)).toBeTrue();
            expect(castFailureReason(text)).toBe('immune');
            expect(ATTACK_REFUSALS.some(r => text.toLowerCase().includes(r))).toBeTrue();
        }
        expect(isPvpImmunity("You can't attack a friendly NPC!")).toBeFalse();
    });

    test('a mezz, stun or silence on us is reason crowd_controlled, for melee and spells (GamePlayer.txt:36-37, Spells.txt:18-20)', () => {
        const melee = ["You can't attack when you are mesmerized!", "You can't attack when you are stunned!"];
        const cast = ["You can't cast while mesmerized!", "You can't cast while stunned!", 'You are fumbling for your words, and cannot cast!'];
        for (const text of [...melee, ...cast]) {
            expect(isCrowdControlled(text)).toBeTrue();
            expect(castFailureReason(text)).toBe('crowd_controlled');
        }
        for (const text of melee) expect(isFatalAttackRefusal(text)).toBeTrue();
        // Before this, castSpell waited 3 s for these and reported no_response.
        for (const text of cast) expect(CAST_REFUSALS.some(r => text.toLowerCase().includes(r))).toBeTrue();
        // Our mezz on someone else, and its immunity, are no refusals of ours.
        for (const text of ['Norseman is mesmerized!', 'Your target is immune to this effect!', "You can't rest when you are stunned!"]) {
            expect(isCrowdControlled(text)).toBeFalse();
        }
    });

    test('the notice that our immunity ended matches no refusal (AbstractServerRules.cs:301)', () => {
        const notice = 'Your temporary PvP invulnerability timer has expired.';
        expect(isPvpImmunity(notice)).toBeFalse();
        expect(castFailureReason(notice)).toBe('refused');
        for (const list of [ATTACK_REFUSALS, CAST_REFUSALS, USE_ITEM_REFUSALS]) {
            expect(list.some(r => notice.toLowerCase().includes(r))).toBeFalse();
        }
    });

    test('range and view refusals are retryable, the rest of ATTACK_REFUSALS fatal', () => {
        for (const text of ['Norseman is too far away to attack!', 'Norseman is not in view!', "You can't see your target!"]) {
            expect(isFatalAttackRefusal(text)).toBeFalse();
        }
        for (const text of ["You can't attack when you are stunned!", 'Norseman is already dead!', "You can't attack players until your PvP invulnerability timer wears off!"]) {
            expect(isFatalAttackRefusal(text)).toBeTrue();
        }
        expect(isFatalAttackRefusal('You hit Norseman for 12 damage!')).toBeFalse();
    });
});

describe('MessageWatch', () => {
    test('collects only messages after the baseline, across snapshots', () => {
        const sdk = Object.create(BotSDK.prototype) as BotSDK;
        (sdk as any).config = { showChat: true };
        (sdk as any).stateListeners = new Set();
        (sdk as any).chatHistory = new ChatHistory();
        const feed = (ids: number[]) => (sdk as any).handleMessage(JSON.stringify({
            type: 'sdk_state', state: makeState({ gameMessages: ids.map(id => makeMessage(id, `msg ${id} ${id === 7 ? 'You can\'t see your target!' : ''}`)) }),
        }));
        feed([1, 2, 3]);
        const watch = new MessageWatch(sdk);
        feed([2, 3, 4, 5]);
        feed([6, 7]); // 4 and 5 scrolled out of this snapshot but were collected
        expect(watch.messages().map(m => m.id)).toEqual([4, 5, 6, 7]);
        expect(watch.find(["can't see your target"])?.id).toBe(7);
        expect(watch.findText([/msg 5/])).toContain('msg 5');
        watch.dispose();
        feed([8]);
        expect(watch.messages().map(m => m.id)).toEqual([4, 5, 6, 7]);
        expect((sdk as any).stateListeners.size).toBe(0);
    });
});

describe('path providers', () => {
    test('straight line splits long legs and interpolates z', () => {
        const provider = new StraightLinePathProvider({ maxSegment: 500, estimateZ: null });
        const r = provider.findPath({ regionId: 1, from: { x: 0, y: 0, z: 100 }, to: { x: 1500, y: 0, z: 400 } });
        expect(r.success).toBeTrue();
        expect(r.waypoints).toEqual([{ x: 500, y: 0, z: 200 }, { x: 1000, y: 0, z: 300 }, { x: 1500, y: 0, z: 400 }]);
    });

    test('estimator fills z, outliers fall back to interpolation', () => {
        const provider = new StraightLinePathProvider({ maxSegment: 500, estimateZ: (_r, x) => (x === 500 ? 5000 : 150), maxZDeviation: 600 });
        const r = provider.findPath({ regionId: 1, from: { x: 0, y: 0, z: 100 }, to: { x: 1500, y: 0 } });
        // x=500: 5000 is an outlier, so the 100→150 interpolation (117) is used.
        expect(r.waypoints.map(w => w.z)).toEqual([117, 150, 150]);
    });

    test('data estimator answers for Camelot Hills', () => {
        const r = new StraightLinePathProvider().findPath({ regionId: 1, from: { x: 574797, y: 530161, z: 2896 }, to: { x: 576200, y: 528250 } });
        expect(r.success).toBeTrue();
        const end = r.waypoints.at(-1)!;
        expect(Math.abs(end.z - 2179)).toBeLessThan(300);
    });

    test('default provider is swappable (navmesh tests: navmesh.test.ts)', () => {
        const custom = new StraightLinePathProvider({ estimateZ: null });
        setDefaultPathProvider(custom);
        expect(getDefaultPathProvider()).toBe(custom);
        setDefaultPathProvider(null);
        expect(getDefaultPathProvider()).not.toBe(custom);
    });
});
