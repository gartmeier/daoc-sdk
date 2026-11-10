import { describe, expect, test } from 'bun:test';
import { clockAt, clockPair } from './common';
import { DWELL, dwellFocus, dwellHold, dwellRecord, FINISH_LOW, finishLow, HOLD, holdFocus, type DwellOptions } from './focus-hold';
import { ctx, engage, foe } from './fixtures';

const inForce = (focus: number) => ({ phase: 'engage' as const, focus, anchor: { x: 11_000, y: 10_000, z: 0 } });

describe('holdFocus', () => {
    test('the focus in force stays over a new pick, out of crowd control', () => {
        const u = holdFocus(ctx([foe(1, 1000, { caster: true }), foe(2, 1100, { caster: true })], { orders: inForce(1) }), engage(2, { cc: [{ targetId: 1, by: 'Bard' }] }), HOLD);
        expect(u.focus).toBe(1);
        expect(u.cc).toEqual([]);
        expect(u.reason).toBe('raid (held #1 over #2)');
    });
    test('let go: mezzed, beyond reach + slack, dropped, the new one nearly dead, their back line over a front-liner', () => {
        const c = (foes: any[], memory = {}) => ctx(foes, { orders: inForce(1), memory });
        expect(holdFocus(c([foe(1, 1000, { cc: { by: 'x', kind: 'mezz', until: 0 } }), foe(2, 1100)]), engage(2), HOLD).focus).toBe(2);
        expect(holdFocus(c([foe(1, 2600), foe(2, 1100)]), engage(2), HOLD).focus).toBe(2);
        expect(holdFocus(c([foe(1, 1000), foe(2, 1100)], { dropped: { 1: 5 } }), engage(2), HOLD).focus).toBe(2);
        expect(holdFocus(c([foe(1, 1000), foe(2, 1100, { hp: 20 })]), engage(2), HOLD).focus).toBe(2);
        expect(holdFocus(c([foe(1, 1000), foe(2, 1100, { healer: true })]), engage(2), { ...HOLD, yieldToBackLine: true }).focus).toBe(2);
    });
    test('kept-only holds only near the anchor in force; kept-or-grid puts one on it', () => {
        const far = ctx([foe(1, 1000), foe(2, 1100)], { orders: { phase: 'engage', focus: 1, anchor: { x: 13_000, y: 10_000, z: 0 } } });
        expect(holdFocus(far, engage(2), HOLD).focus).toBe(2);
        const u = holdFocus(far, engage(2), { ...HOLD, anchor: 'kept-or-grid' });
        expect(u.focus).toBe(1);
        expect(u.anchor).toEqual({ x: 11_000, y: 10_000, z: 0 });
    });
});

describe('finishLow', () => {
    test('a focus in force under 40 % stays, with its anchor; above, the update as it is', () => {
        const u = finishLow(ctx([foe(1, 1000, { hp: 30 }), foe(2, 1100)], { orders: inForce(1) }), engage(2), FINISH_LOW);
        expect(u.focus).toBe(1);
        expect(u.reason).toBe('raid (finish #1 at 30 %)');
        const v = engage(2);
        expect(finishLow(ctx([foe(1, 1000, { hp: 50 }), foe(2, 1100)], { orders: inForce(1) }), v, FINISH_LOW)).toBe(v);
    });
});

describe('dwellFocus', () => {
    const at = (memory: Record<string, any>, now: number, foes = [foe(1, 1000), foe(2, 1100)]) => ctx(foes, { orders: inForce(1), memory, now });
    test('clock: a new focus stays ms, then may go', () => {
        const memory: Record<string, any> = {};
        expect(dwellFocus(at(memory, 0), engage(1), DWELL).focus).toBe(1);
        expect(dwellFocus(at(memory, 2000), engage(2), DWELL).focus).toBe(1);
        expect(dwellFocus(at(memory, 7000), engage(2), DWELL).focus).toBe(2);
        expect(memory.focusDwell).toEqual({ id: 2, since: 7000 });
    });
    test('clock: let go of a mezzed one; off an engage the clock is forgotten', () => {
        const memory: Record<string, any> = { focusDwell: { id: 1, since: 0 } };
        expect(dwellFocus(at(memory, 1000, [foe(1, 1000, { cc: { by: 'x', kind: 'mezz', until: 0 } }), foe(2, 1100)]), engage(2), DWELL).focus).toBe(2);
        dwellFocus(at(memory, 1500), { phase: 'recover', reason: 'rest' }, DWELL);
        expect(memory.focusDwell).toBeUndefined();
    });
    test('orders: held on the focus in force, its clock restarting on a change; a nearly dead pick goes through', () => {
        const O: DwellOptions = { ...DWELL, heldFrom: 'orders', clock: clockPair('dwellId', 'dwellSince'), letGo: { below: 30, alive: true }, forget: 'never' };
        const memory: Record<string, any> = { dwellId: 1, dwellSince: -2000 };
        expect(dwellFocus(at(memory, 0), engage(2), O).focus).toBe(1);
        expect(dwellFocus(at(memory, 0, [foe(1, 1000), foe(2, 1100, { hp: 20 })]), engage(2), O).focus).toBe(2);
        expect(memory).toEqual({ dwellId: 2, dwellSince: 0 });
        const fresh: Record<string, any> = { dwellId: 7, dwellSince: -9000 };
        expect(dwellFocus(at(fresh, 0), engage(2), O).focus).toBe(1);
        expect(fresh).toEqual({ dwellId: 1, dwellSince: 0 });
    });
    test('the two halves: hold first, pick in between, record what was settled', () => {
        const O: DwellOptions = { ...DWELL, clock: clockAt('held'), retarget: 'focus-only', note: undefined };
        const memory: Record<string, any> = { held: { id: 1, since: 0 } };
        const c = at(memory, 1000);
        const u = dwellHold(c, engage(2), O);
        expect(u).toEqual({ ...engage(2), focus: 1 });
        dwellRecord(c, { ...u, focus: 3 }, O);
        expect(memory.held).toEqual({ id: 3, since: 1000 });
    });
});
