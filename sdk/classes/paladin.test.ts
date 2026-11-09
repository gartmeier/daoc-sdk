import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import { CHANT_TWIST } from '../group/songs';
import { paladin, selfBuffDue } from './paladin';
import { reachOfBuild } from './reach';

/** What Galahad knows at 24, shaped as the Spellbook's picks. */
const picks = () => reachOfBuild(getBuild('Paladin', 'Chants and sword')!, 24).known
    .map(k => ({ spell: { name: k.name, level: k.level } as any, type: k.info.type, target: k.info.target }));

describe('the paladin kit', () => {
    test('keeps Aura of Indestructability up while it is not on him', () => {
        expect(selfBuffDue(picks(), [])?.spell.name).toBe('Aura of Indestructability');
        expect(selfBuffDue(picks(), ["Crusader's Defense"])?.spell.name).toBe('Aura of Indestructability');
        expect(selfBuffDue(picks(), ['Aura of Indestructability'])).toBeNull();
    });

    test('below Chants 24 the lower rank, Aura of Defense (Chants 17); a rank on him counts as up', () => {
        expect(selfBuffDue(picks().filter(p => p.spell.name !== 'Aura of Indestructability'), [])?.spell.name).toBe('Aura of Defense');
        expect(selfBuffDue(picks(), ['Aura of Defense'])).toBeNull();
        expect(selfBuffDue(picks().filter(p => p.type !== 'PaladinArmorFactorBuff'), [])).toBeNull();
    });

    test('selfBuff is a chore below the fight, with and without the twist', () => {
        for (const kit of [paladin(), paladin({ twist: CHANT_TWIST })]) {
            const list = withCharacter(defaultBehaviors().tank, kit).map(b => b.name);
            expect(list.indexOf('selfBuff')).toBe(list.indexOf('tank') + 1);
            expect(list.indexOf('song')).toBe(list.indexOf('tank') - 1);
        }
    });
});
