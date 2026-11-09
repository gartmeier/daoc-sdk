import { describe, expect, test } from 'bun:test';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { enchanter } from './enchanter';

describe('enchanter kit', () => {
    test('the heat debuff above assist, and offFocus after it, in the pack', () => {
        const names = withCharacter(packBehaviors().nuker, enchanter()).map(b => b.name);
        expect(names.indexOf('resistDebuff')).toBeLessThan(names.indexOf('assist'));
        expect(names.indexOf('offFocus')).toBe(names.indexOf('assist') + 1);
    });

    test('offFocus can be left out', () => {
        expect(enchanter({ offFocus: false }).fight!.map(b => b.name)).toEqual(['assist']);
    });
});
