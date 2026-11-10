import { describe, expect, test } from 'bun:test';
import { BACK_LINE, CASTER_HEALER_CC, CC_HEALER_CASTER, focusBackLine, focusByRole, HEALER_CASTER_CC, HEALER_STICKY, roleOf } from './focus-role';
import { ctx, engage, foe, guess } from './fixtures';

describe('roleOf', () => {
    test('read alone, or the deeds when there is no read', () => {
        expect(roleOf(foe(1, 0, { healer: true }), 'read')).toBeUndefined();
        expect(roleOf(foe(1, 0, { healer: true }))).toBe('healer');
        expect(roleOf(foe(1, 0, { ...guess('tank'), healer: true }))).toBe('tank');
    });
});

describe('focusByRole, CC_HEALER_CASTER (up a rank only)', () => {
    const f = (foes: any[], focus: number, memory = {}) => focusByRole(ctx(foes, { memory }), engage(focus), CC_HEALER_CASTER);
    test('off their tank onto their crowd control, anchor on it', () => {
        const u = f([foe(1, 400, guess('tank')), foe(2, 1500, guess('healer')), foe(3, 1700, guess('cc'))], 1);
        expect(u.focus).toBe(3);
        expect(u.anchor).toEqual({ x: 11_800, y: 10_000, z: 0 });
        expect(u.reason).toBe('raid (cc first: 3)');
    });
    test('kept: a healer focus against a caster; a focus under 30 %; one beyond reach + 700', () => {
        expect(f([foe(2, 500, guess('healer')), foe(4, 900, guess('caster'))], 2).focus).toBe(2);
        expect(f([foe(1, 400, { ...guess('tank'), hp: 20 }), foe(3, 900, guess('cc'))], 1).focus).toBe(1);
        expect(f([foe(1, 400, guess('tank')), foe(3, 2700, guess('cc'))], 1).focus).toBe(1);
    });
    test('the deeds stand in; one dropped as out-healed is passed over', () => {
        expect(f([foe(1, 400), foe(5, 900, { healer: true })], 1).focus).toBe(5);
        expect(f([foe(1, 400), foe(5, 900, { healer: true })], 1, { dropped: { 5: 1 } }).focus).toBe(1);
    });
});

describe('focusByRole, CASTER_HEALER_CC (focus only)', () => {
    test('one healer: a caster first; two: a healer first', () => {
        const foes = [foe(1, 300, guess('tank')), foe(2, 1100, guess('healer')), foe(3, 1200, guess('caster'))];
        expect(focusByRole(ctx(foes), engage(1), CASTER_HEALER_CC)).toEqual({ ...engage(1), focus: 3 });
        expect(focusByRole(ctx([...foes, foe(4, 1250, guess('healer'))]), engage(1), HEALER_CASTER_CC).focus).toBe(2);
    });
    test('not one swinging at us; a caster in hand stays against another', () => {
        expect(focusByRole(ctx([foe(1, 300, guess('tank')), foe(3, 500, { ...guess('caster'), target: 'Tank' })]), engage(1), CASTER_HEALER_CC).focus).toBe(1);
        expect(focusByRole(ctx([foe(3, 1500, guess('caster')), foe(5, 1400, { ...guess('caster'), hp: 40 })]), engage(3), CASTER_HEALER_CC).focus).toBe(3);
    });
});

describe('focusByRole, HEALER_STICKY', () => {
    test('the chosen healer stays though dropped as out-healed; a new pick skips the dropped', () => {
        const foes = [foe(1, 800, { caster: true }), foe(2, 1000, { healer: true, hp: 80 }, 200), foe(3, 900, { healer: true, hp: 60 }, -200)];
        const memory: Record<string, any> = { roleFocus: 2, dropped: { 2: 2_000_000 } };
        expect(focusByRole(ctx(foes, { memory }), engage(1), HEALER_STICKY).focus).toBe(2);
        expect(focusByRole(ctx(foes, { memory: { dropped: { 2: 2_000_000 } } }), engage(1), HEALER_STICKY).focus).toBe(3);
    });
    test('the anchor goes at most 600 toward it; beyond a nuker\'s 1500 it is no candidate', () => {
        const u = focusByRole(ctx([foe(1, 800), foe(2, 1000, { healer: true })]), engage(1), HEALER_STICKY);
        expect(u.focus).toBe(2);
        expect(Math.hypot(u.anchor!.x - 9720, u.anchor!.y - 10_000)).toBeCloseTo(600, -1);
        expect(focusByRole(ctx([foe(1, 1000), foe(2, 1600, { healer: true })]), engage(1), { ...HEALER_STICKY, near: { centre: 900 } }).focus).toBe(1);
    });
    test('a pick off is left alone; no change returns the update itself', () => {
        const u = engage(1, { reason: 'pick off #1' });
        expect(focusByRole(ctx([foe(1, 1000), foe(2, 1200, { healer: true })]), u, HEALER_STICKY)).toBe(u);
    });
});

describe('focusBackLine', () => {
    test('a focus on their tank gives way to a known caster in range, and not to one far off', () => {
        const tank = foe(1, 300, { target: 'Tank' });
        expect(focusBackLine(ctx([tank, foe(2, 1500, { caster: true })]), engage(1), BACK_LINE).focus).toBe(2);
        expect(focusBackLine(ctx([tank, foe(2, 4000, { caster: true })]), engage(1), BACK_LINE).focus).toBe(1);
    });
    test('a focus the read calls a caster, or one the group keeps, stays', () => {
        expect(focusBackLine(ctx([foe(1, 300, guess('caster')), foe(2, 1500, { healer: true })]), engage(1), BACK_LINE).focus).toBe(1);
        expect(focusBackLine(ctx([foe(1, 300), foe(2, 1500, { healer: true })]), engage(1), { ...BACK_LINE, keep: c => c.objectId === 1 }).focus).toBe(1);
    });
});
