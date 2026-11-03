import { describe, expect, test } from 'bun:test';
import { specLevelsAt } from '../../data/class-sheet';
import { getClass, getSpecialization } from '../../data/index';
import { MENTALIST_BUILDS, mentalist } from './mentalist';

const LIST_CASTER = getClass('Mentalist')!.specializationMultiplier;

describe('mentalist kit', () => {
    test('the plan names only lines the class has', () => {
        const specs = getClass('Mentalist')!.specializations.map(s => s.spec);
        for (const plan of Object.values(MENTALIST_BUILDS)) {
            for (const line of Object.keys(plan)) expect(specs).toContain(getSpecialization(line)!.keyName);
        }
    });

    test('rvr reaches the usual split at 50', () => {
        expect(specLevelsAt(MENTALIST_BUILDS.rvr, 50, LIST_CASTER)).toEqual({ Light: 46, Mentalism: 28, Mana: 4 });
    });

    test('levelling has the regen ranks when the level allows them', () => {
        expect(specLevelsAt(MENTALIST_BUILDS.levelling, 20, LIST_CASTER).Mana).toBeGreaterThanOrEqual(14);
        expect(specLevelsAt(MENTALIST_BUILDS.levelling, 30, LIST_CASTER).Mana).toBeGreaterThanOrEqual(24);
    });

    test('options choose the plan, and the plan is the bot\'s to change', () => {
        expect(mentalist().specPlan).toEqual(MENTALIST_BUILDS.levelling);
        const plan = mentalist({ build: 'rvr' }).specPlan;
        plan.Light = 2;
        expect(MENTALIST_BUILDS.rvr.Light).toBe(1);
    });

    test('it keeps the role\'s fight, so a bot adds only what it changes', () => {
        expect(mentalist().character).toEqual({ role: 'nuker' });
    });
});
