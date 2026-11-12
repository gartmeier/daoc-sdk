import { describe, expect, test } from 'bun:test';
import { alliesNear, CALL_SETTINGS, chooseCall, flushAnswers, helpStep, noteArrival, type RealmCall } from './help';

const call = (id: string, over: Partial<RealmCall> = {}): RealmCall => ({
    id, kind: 'help', from: 'camelot-s1', why: 'outnumbered', at: { x: 15_000, y: 10_000, z: 0 }, foes: 4, ours: 2, want: 3, asked: ['camelot'], coming: [], since: 0, updatedAt: 0, ...over,
});
const muster = (over: Partial<RealmCall> = {}): RealmCall => call('albion-m', { kind: 'muster', from: 'director', why: 'raid', stage: 'rally', at: { x: 20_000, y: 10_000, z: 0 }, target: { x: 30_000, y: 10_000, z: 0 }, asked: [], want: 0, ...over });
const centre = { x: 10_000, y: 10_000 };
const S = CALL_SETTINGS;

describe('chooseCall', () => {
    test('a help call that names us within maxWay, nearest first; not one beyond it', () => {
        const far = call('a-1', { at: { x: 10_000 + S.maxWay + 100, y: 10_000, z: 0 } });
        const near = call('a-2', { at: { x: 14_000, y: 10_000, z: 0 } });
        const nearer = call('a-3', { at: { x: 12_000, y: 10_000, z: 0 } });
        expect(chooseCall([far, near, nearer], 'camelot', centre, S)?.id).toBe('a-3');
        expect(chooseCall([far], 'camelot', centre, S)).toBeNull();
    });

    test('one that does not name us only while it wants bodies and within maxWayOpen; never our own', () => {
        const open = call('a-1', { asked: ['camelot-2'], at: { x: 15_000, y: 10_000, z: 0 } });
        expect(chooseCall([open], 'camelot', centre, S)?.id).toBe('a-1');
        expect(chooseCall([{ ...open, want: 0 }], 'camelot', centre, S)).toBeNull();
        expect(chooseCall([{ ...open, at: { x: 10_000 + S.maxWayOpen + 100, y: 10_000, z: 0 } }], 'camelot', centre, S)).toBeNull();
        expect(chooseCall([call('a-2', { from: 'camelot' })], 'camelot', centre, S)).toBeNull();
    });

    test('an asked help call before the muster, the muster before an open one; the one we answer stays', () => {
        const asked = call('a-1');
        const open = call('a-2', { asked: [] , at: { x: 11_000, y: 10_000, z: 0 } });
        expect(chooseCall([muster(), open, asked], 'camelot', centre, S)?.id).toBe('a-1');
        expect(chooseCall([open, muster()], 'camelot', centre, S)?.id).toBe('albion-m');
        expect(chooseCall([muster(), open, asked], 'camelot', centre, S, { id: 'a-2', kind: 'help', state: 'coming', since: 0 })?.id).toBe('a-2');
        expect(chooseCall([open, muster()], 'camelot', centre, { ...S, muster: false })?.id).toBe('a-2');
        expect(chooseCall([asked], 'camelot', centre, { ...S, enabled: false })).toBeNull();
    });
});

describe('helpStep', () => {
    test('answers coming once, walks there, arrived once, holds, then leaves after idleMs with nobody in sight', () => {
        const mem: Record<string, any> = { realmCalls: [call('a-1')] };
        const step = (now: number, at = centre, free = true) => helpStep(mem, { unit: 'camelot', centre: at, now, settings: S, free });
        let d = step(0);
        expect(d?.kind).toBe('go');
        expect(d?.reason).toBe('call a-1: camelot-s1 (outnumbered, 4 vs 2), 5000 away');
        expect(step(1000)?.kind).toBe('go');
        expect(mem.helpOut).toEqual([{ id: 'a-1', answer: 'coming' }]);
        const there = { x: 14_000, y: 10_000 };
        d = step(20_000, there);
        expect(d?.kind).toBe('hold');
        expect(d?.reason).toContain('nobody in sight, 20 s more');
        expect(mem.helpOut.at(-1)).toEqual({ id: 'a-1', answer: 'arrived' });
        for (let t = 21_000; t <= 30_000; t += 1000) expect(step(t, there)?.kind).toBe('hold');
        // A fight there (no quiet ticks for 10 s) starts the count again.
        for (let t = 40_000; t < 60_000; t += 1000) expect(step(t, there)?.kind).toBe('hold');
        expect(step(60_000, there)).toBeNull();
        expect(mem.helpOut.at(-1)).toEqual({ id: 'a-1', answer: 'left', why: 'nobody in sight' });
        // Not picked again.
        expect(step(51_000, there)).toBeNull();
        expect(mem.helpOut.filter((a: any) => a.answer === 'arrived')).toHaveLength(1);
    });

    test('not free: nothing, and the answer waits; a call that closed is dropped without an answer', () => {
        const mem: Record<string, any> = { realmCalls: [call('a-1')] };
        expect(helpStep(mem, { unit: 'camelot', centre, now: 0, settings: S, free: false })).toBeNull();
        expect(mem.helpOut ?? []).toHaveLength(0);
        helpStep(mem, { unit: 'camelot', centre, now: 1000, settings: S, free: true });
        mem.realmCalls = [];
        expect(helpStep(mem, { unit: 'camelot', centre, now: 2000, settings: S, free: true })).toBeNull();
        expect(mem.help).toBeUndefined();
        expect(mem.helpOut).toEqual([{ id: 'a-1', answer: 'coming' }]);
    });

    test('a better call leaves the one we answered', () => {
        const mem: Record<string, any> = { realmCalls: [muster()] };
        helpStep(mem, { unit: 'camelot', centre, now: 0, settings: S, free: true });
        // The muster is held (chooseCall keeps it): a help call asking us comes second.
        mem.realmCalls = [muster(), call('a-1')];
        expect(helpStep(mem, { unit: 'camelot', centre, now: 1000, settings: S, free: true })?.call.id).toBe('albion-m');
    });

    test('the muster: rally, wait for the go, then the target as a new walk', () => {
        const mem: Record<string, any> = { realmCalls: [muster()] };
        const rally = { x: 20_000, y: 10_000 };
        let d = helpStep(mem, { unit: 'camelot', centre, now: 0, settings: S, free: true });
        expect(d?.kind).toBe('go');
        d = helpStep(mem, { unit: 'camelot', centre: rally, now: 60_000, settings: S, free: true });
        expect(d?.kind).toBe('hold');
        expect(d?.reason).toContain('waiting for the go');
        // Far past idleMs: the rally doesn't time out.
        expect(helpStep(mem, { unit: 'camelot', centre: rally, now: 200_000, settings: S, free: true })?.kind).toBe('hold');
        mem.realmCalls = [muster({ stage: 'go' })];
        d = helpStep(mem, { unit: 'camelot', centre: rally, now: 201_000, settings: S, free: true });
        expect(d).toMatchObject({ kind: 'go', goal: { x: 30_000 } });
        d = helpStep(mem, { unit: 'camelot', centre: { x: 29_000, y: 10_000 }, now: 260_000, settings: S, free: true });
        expect(d?.kind).toBe('hold');
        expect(d?.reason).toContain('at the target');
        expect(mem.helpOut.filter((a: any) => a.answer === 'arrived')).toHaveLength(2);
    });
});

describe('noteArrival, alliesNear, flushAnswers', () => {
    test('arrival is noted in a fight too; allies count only near a help call', () => {
        const mem: Record<string, any> = { realmCalls: [call('a-1', { ours: 3 })], help: { id: 'a-1', kind: 'help', state: 'coming', since: 0 } };
        noteArrival(mem, { x: 14_500, y: 10_000 }, 5000, S);
        expect(mem.help.state).toBe('arrived');
        expect(alliesNear(mem, { x: 14_500, y: 10_000 }, 5000)).toBe(3);
        expect(alliesNear(mem, { x: 5000, y: 10_000 }, 5000)).toBe(0);
        // Our own living within 2000 of the call are in its `ours`: two of ours there leave one ally.
        expect(alliesNear(mem, { x: 14_500, y: 10_000 }, 5000, [{ x: 14_000, y: 10_000 }, { x: 16_500, y: 10_000 }, { x: 12_000, y: 10_000 }])).toBe(1);
        mem.realmCalls = [];
        expect(alliesNear(mem, { x: 14_500, y: 10_000 }, 5000)).toBe(0);
    });

    test('answers go out in order and once; a throwing source loses none of the others', () => {
        const got: string[] = [];
        const mem: Record<string, any> = { helpOut: [{ id: 'a', answer: 'coming' }, { id: 'a', answer: 'arrived' }] };
        flushAnswers(mem, { calls: () => [], answer: (id, a) => { if (a === 'coming') throw new Error('disk'); got.push(`${id}:${a}`); } });
        expect(got).toEqual(['a:arrived']);
        expect(mem.helpOut).toEqual([]);
        flushAnswers(mem, null);
    });
});
