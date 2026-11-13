import { describe, expect, test } from 'bun:test';
import { withCharacter } from '../group/character';
import { rvrBehaviors } from '../group/rvr';
import { animist, turretOffCc } from './animist';
import { necromancer, servantOffCc } from './necromancer';
import { newlyHeld, offCcPlan } from './pet-cc';

describe('a pet off crowd control', () => {
    test('crowd control new near the pet wipes its list, its own target held always acts', () => {
        expect(newlyHeld([1, 2], [2, 3])).toEqual([3]);
        expect(newlyHeld([1, 2], [1])).toEqual([]);
        expect(offCcPlan({ targetHeld: false, fresh: false, busy: false, focusInReach: true })).toBe('none');
        expect(offCcPlan({ targetHeld: false, fresh: true, busy: false, focusInReach: true })).toBe('passive+focus');
        expect(offCcPlan({ targetHeld: false, fresh: true, busy: false, focusInReach: false })).toBe('passive');
        expect(offCcPlan({ targetHeld: false, fresh: true, busy: true, focusInReach: true })).toBe('none');
        expect(offCcPlan({ targetHeld: true, fresh: false, busy: true, focusInReach: false })).toBe('passive');
    });

    test('the turret and the servant, each on the side tick in its kit', () => {
        expect(turretOffCc().side).toBe(true);
        expect(servantOffCc().side).toBe(true);
        expect(withCharacter(rvrBehaviors().nuker, animist()).map(b => b.name)).toContain('turretOffCc');
        expect(withCharacter(rvrBehaviors().nuker, necromancer()).map(b => b.name)).toContain('servantOffCc');
    });
});
