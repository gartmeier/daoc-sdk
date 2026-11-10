import { describe, expect, test } from 'bun:test';
import { byMakeUp, enemyMix, foeKind, healersRead, MAKE_UP, meleeHeavy, readMakeUp, withMakeUp } from './make-up';
import { ctx, engage, foe, guess } from './fixtures';

describe('foeKind and enemyMix', () => {
    test('the read first, the deeds when there is none', () => {
        expect(foeKind(foe(1, 0, guess('cc')))).toBe('caster');
        expect(foeKind(foe(1, 0, guess('support')))).toBe('fighter');
        expect(foeKind(foe(1, 0, { ...guess('tank'), healer: true }))).toBe('fighter');
        expect(foeKind(foe(1, 0, { healer: true }))).toBe('healer');
        expect(foeKind(foe(1, 0, { caster: true }))).toBe('caster');
        expect(foeKind(foe(1, 0))).toBe('fighter');
    });
    test('no dead and no shades in the mix', () => {
        expect(enemyMix([foe(1, 0, { healer: true }), foe(2, 0, { hp: 0, healer: true }), foe(3, 0, { isShade: true }), foe(4, 0, guess('caster'))])).toEqual({ healer: 1, caster: 1, fighter: 0 });
    });
    test('melee-heavy: at most one caster, three healers and fighters', () => {
        expect(meleeHeavy([foe(1, 0, guess('tank')), foe(2, 0, guess('support')), foe(3, 0, guess('healer')), foe(4, 0, guess('healer')), foe(5, 0, guess('caster'))])).toBe(true);
        expect(meleeHeavy([foe(1, 0, guess('tank')), foe(2, 0, guess('healer')), foe(3, 0, guess('cc')), foe(4, 0, guess('caster')), foe(5, 0, guess('caster'))])).toBe(false);
    });
    test('healersRead counts the read alone, fresh players only', () => {
        expect(healersRead([foe(1, 0, guess('healer')), foe(2, 0, { healer: true }), foe(3, 0, { ...guess('healer'), stale: true }), foe(4, 0, { ...guess('healer'), isPet: true })])).toBe(1);
    });
    test('a setting wins over the make-up', () => {
        expect(byMakeUp(undefined, 6000)).toBe(6000);
        expect(byMakeUp(0, 6000)).toBe(0);
    });
});

describe('readMakeUp / withMakeUp', () => {
    const heavy = [foe(1, 1000, guess('tank')), foe(2, 1100, guess('support')), foe(3, 1200, guess('healer')), foe(4, 1300, guess('healer')), foe(5, 1400, guess('caster'))];
    const PATCHES = { melee: { ccFlank: 3000 }, caster: { ccFlank: 0 } };
    test('nothing until three are in sight and 60 % read; then held, the same object each tick', () => {
        const memory: Record<string, any> = {};
        expect(withMakeUp(ctx(heavy.slice(0, 2), { memory }), engage(1), PATCHES).settings).toBeNull();
        expect(withMakeUp(ctx([foe(1, 0), foe(2, 0), foe(3, 0, guess('tank'))], { memory }), engage(1), PATCHES).settings).toBeNull();
        expect(withMakeUp(ctx(heavy, { memory }), engage(1), PATCHES).settings).toBe(PATCHES.melee);
        expect(withMakeUp(ctx(heavy.slice(0, 1), { memory }), engage(1), PATCHES).settings).toBe(PATCHES.melee);
    });
    test('forgotten a minute after the last enemy left sight', () => {
        const memory: Record<string, any> = {};
        readMakeUp(ctx(heavy, { memory, now: 0 }));
        expect(readMakeUp(ctx([], { memory, now: 59_000 }))).toBe('melee');
        expect(readMakeUp(ctx([], { memory, now: 61_000 }))).toBeNull();
        expect(memory[MAKE_UP.key]).toBeUndefined();
    });
});
