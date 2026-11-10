import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { HERO_STUNS } from './hero';
import { reachOfBuild } from './reach';
import { warrior } from './warrior';

describe('warrior kit', () => {
    test('its fight is the tank\'s, once in every list', () => {
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.tank as Behavior<any>[], warrior()).map(b => b.name);
            expect(list.filter(n => n === 'tank')).toHaveLength(1);
        }
    });

    test('at Shields 18 he has the Hero kit\'s stuns by name (heroStyle swings them)', () => {
        const styles = reachOfBuild(getBuild('Warrior', 'Hammer, Shields 42, high Parry')!, 24).styles.map(s => s.name);
        for (const n of ['Numb', 'Stun', 'Disable', 'Incapacitate']) {
            expect(styles).toContain(n);
            expect(HERO_STUNS[n]).toBeGreaterThan(0);
        }
    });
});
