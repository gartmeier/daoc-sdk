import { describe, expect, test } from 'bun:test';
import { applyAnswer, envenom, isPoisoned, poisonId, poisonPlan } from './poison';

describe('poisonPlan', () => {
    test('Envenom 20 (Mordred, Scathach): greater lethal on the main hand, greater imbalancing on the off hand', () => {
        expect(poisonPlan(20)).toMatchObject({ main: { name: 'greater lethal poison' }, off: { name: 'greater imbalancing poison' } });
    });
    test('Envenom 22 (Hodur): the same, the snare ahead of the Str/Con debuff', () => {
        expect(poisonPlan(22).off?.name).toBe('greater imbalancing poison');
    });
    test('lower Envenom takes the best poison it may use', () => {
        expect(poisonPlan(16)).toMatchObject({ main: { name: 'major lethal poison' }, off: { name: 'major imbalancing poison' } });
        expect(poisonPlan(12)).toMatchObject({ main: { name: 'lethal poison' }, off: { name: 'major weakening poison' } });
        expect(poisonPlan(5)).toEqual({ main: null, off: null });
    });
});

test('poisonId: the DB ids by realm', () => {
    expect(poisonId('greater lethal poison', 'albion')).toBe('greater_lethal_poison');
    expect(poisonId('greater lethal poison', 'midgard')).toBe('greater_lethal_poison2');
    expect(poisonId('greater imbalancing poison', 'hibernia')).toBe('greater_imbalancing_poison3');
});

describe('reading the server', () => {
    test('a delve with charges left is poisoned, one without is clean', () => {
        expect(isPoisoned(['Offensive Proc Ability:', '    - 1 Charges', '    - 1 Max'])).toBe(true);
        expect(isPoisoned(['    - 0 Charges'])).toBe(false);
        expect(isPoisoned(['Damage Modifiers:', '- 8.4 Base DPS'])).toBe(false);
    });
    test('the application answers (GamePlayer.cs:7243-7323, language/EN/GameObjects/GamePlayer.txt:173-178)', () => {
        expect(applyAnswer(['You apply greater lethal poison to Thidranki Infiltrator Dirk.'])).toBe('applied');
        expect(applyAnswer(["You have been in combat recently and can't apply a poison yet!"])).toBe('in_combat');
        expect(applyAnswer(["You can't use this poison."])).toBe('cant_use');
        expect(applyAnswer(["You can't poison this weapon!"])).toBe('cant_poison');
        expect(applyAnswer(['You are now hidden!'])).toBeNull();
    });
});

test('envenom is a chore behaviour', () => {
    expect(envenom().name).toBe('envenom');
});
