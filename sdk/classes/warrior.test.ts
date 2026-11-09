import { describe, expect, test } from 'bun:test';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { warrior } from './warrior';

describe('warrior kit', () => {
    test('its fight is the tank\'s, once in every list', () => {
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.tank as Behavior<any>[], warrior()).map(b => b.name);
            expect(list.filter(n => n === 'tank')).toHaveLength(1);
        }
    });
});
