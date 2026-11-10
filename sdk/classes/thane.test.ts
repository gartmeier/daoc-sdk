import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { reachOfBuild } from './reach';
import { thane } from './thane';

describe('thane kit', () => {
    test('a tank whose fight is named tank, once, with interrupt above flee, in every list', () => {
        expect(thane().role).toBe('tank');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.tank as Behavior<any>[], thane()).map(b => b.name);
            expect(list.filter(n => n === 'tank')).toHaveLength(1);
            expect(list.filter(n => n === 'interrupt')).toHaveLength(1);
            expect(list.indexOf('interrupt')).toBeLessThan(list.indexOf('tank'));
            // Guard on the healer stays: it is the tank list's.
            expect(list).toContain('guard');
        }
    });

    test('at 24 the Horn is his only instant damage: the interrupt, range 1500', () => {
        const r = reachOfBuild(getBuild('Thane', 'Even hybrid with Parry')!, 24);
        const instants = r.nukes.filter(s => s.castTime === 0 && s.radius === 0);
        expect(instants.map(s => s.spell.name)).toEqual(["Toothgrinder's Horn"]);
        expect(instants[0]!.range).toBe(1500);
        expect(instants[0]!.type).toBe('DirectDamage');
    });

    test('the shield stuns the Hero kit swings are his at Shields 18', () => {
        const r = reachOfBuild(getBuild('Thane', 'Even hybrid with Parry')!, 24);
        const names = r.styles.map(s => s.name);
        for (const n of ['Numb', 'Stun', 'Disable', 'Incapacitate']) expect(names).toContain(n);
    });
});
