import { describe, expect, test } from 'bun:test';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { getBuild } from '../../data/builds';
import type { SpellPick } from '../group/spells';
import { dazzleSpells, enchanter } from './enchanter';
import { reachOfBuild } from './reach';

describe('enchanter kit', () => {
    test('the heat debuff above assist, and offFocus after it, in the pack', () => {
        const names = withCharacter(packBehaviors().nuker, enchanter()).map(b => b.name);
        expect(names.indexOf('resistDebuff')).toBeLessThan(names.indexOf('assist'));
        expect(names.indexOf('offFocus')).toBe(names.indexOf('assist') + 1);
        expect(names.slice(names.indexOf('flee') - 3, names.indexOf('flee'))).toEqual(['quickFlash', 'dazzle', 'quickcast']);
    });

    test('offFocus can be left out', () => {
        expect(enchanter({ offFocus: false }).fight!.map(b => b.name)).toEqual(['assist']);
    });
});

describe('enchanter dazzle', () => {
    const known = reachOfBuild(getBuild('Enchanter', 'Light nuker')!, 24).known;
    const pick = (name: string) => { const k = known.find(x => x.name === name)!; return { spell: { name, level: k.level, cooldownRemaining: 0 }, type: k.info.type, target: k.info.target, range: k.info.range, radius: k.info.radius, power: k.info.power, castTime: k.info.castTime, duration: k.info.duration } as unknown as SpellPick; };

    test('Light nuker at 24 has both instants and the area one; the attack slow first, never the area one', () => {
        const all = ['Dazzling Torch', 'Field of Scintillation', 'Blinding Scintillation'].map(pick);
        expect(dazzleSpells(all, 100).map(s => s.spell.name)).toEqual(['Blinding Scintillation', 'Dazzling Torch']);
    });

    test('none it cannot pay for', () => {
        expect(dazzleSpells(['Blinding Scintillation', 'Dazzling Torch'].map(pick), 5)).toEqual([]);
    });
});
