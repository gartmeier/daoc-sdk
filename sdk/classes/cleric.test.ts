import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { rvrBehaviors } from '../group/rvr';
import { withCharacter } from '../group/character';
import type { Contact } from '../group/types';
import { camelotMezzer, cleric, stunTarget } from './cleric';
import { reachOfBuild } from './reach';

const NOW = 1_000_000;
const me = { name: 'Nimue', role: 'healer' as const, isDead: false, regionId: 238, x: 0, y: 0 };
const members = [
    { name: 'Galahad', role: 'tank' as const, isDead: false, regionId: 238, x: 0, y: 900 },
    me,
    { name: 'Merlin', role: 'nuker' as const, isDead: false, regionId: 238, x: 600, y: 0 },
    { name: 'Taliesin', role: 'nuker' as const, isDead: false, regionId: 238, x: -600, y: 0 },
];
const foe = (id: number, over: Partial<Contact> = {}): Contact => ({
    objectId: id, name: `Celt${id}`, kind: 'player', regionId: 238, x: 0, y: 1000, hp: 100, target: null, stale: false, cc: null, ...over,
} as Contact);

describe('the cleric kit', () => {
    test('stuns an enemy player in melee on a caster, a healer first', () => {
        const onMerlin = foe(1, { x: 650, y: 0, target: 'Merlin' });
        const onMe = foe(2, { x: 50, y: 0, target: 'Nimue' });
        expect(stunTarget(me, members, [onMerlin], undefined, 1500, 60, NOW)).toEqual({ target: onMerlin, why: 'peel' });
        expect(stunTarget(me, members, [onMerlin, onMe], undefined, 1500, 60, NOW)?.target).toBe(onMe);
    });

    test('an enemy pet in melee on a caster too, but never a pet as the healer or focus pick', () => {
        const warrior = foe(7, { kind: 'npc', isPet: true, name: 'spirit warrior', x: 650, y: 0, target: 'Merlin' } as Partial<Contact>);
        expect(stunTarget(me, members, [warrior], undefined, 1500, 60, NOW)).toEqual({ target: warrior, why: 'peel' });
        const monster = foe(8, { kind: 'npc', name: 'wolf', x: 650, y: 0, target: 'Merlin' } as Partial<Contact>);
        expect(stunTarget(me, members, [monster], undefined, 1500, 60, NOW)).toBeNull();
        const focus = foe(1, { hp: 40 });
        expect(stunTarget(me, members, [focus, { ...warrior, x: 0, y: 1400, target: 'Galahad' }], focus, 1500, 60, NOW)?.target).toBe(focus);
    });

    test('not one on the tank, nor one nuking from afar, mezzed, stun-immune, or out of reach', () => {
        expect(stunTarget(me, members, [foe(1, { x: 0, y: 950, target: 'Galahad' })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [foe(1, { x: 600, y: 1400, target: 'Merlin', targetBySpell: true })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [foe(1, { x: 650, y: 0, target: 'Merlin', cc: { by: 'Merlin', kind: 'mezz', until: NOW + 5000 } })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [foe(1, { x: 650, y: 0, target: 'Merlin', ccImmune: { stun: NOW + 30_000 } })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget({ ...me, x: -2000 }, members, [foe(1, { x: 650, y: 0, target: 'Merlin' })], undefined, 1500, 60, NOW)).toBeNull();
    });

    test('the marked mezzer at any health, after a peel and before the enemy healer', () => {
        const bard = foe(5, { hp: 100, y: 1300 });
        const healer = foe(2, { healer: true, y: 1400 });
        const focus = foe(1, { hp: 40 });
        expect(stunTarget(me, members, [focus, healer, bard], focus, 1500, 60, NOW, 5)).toEqual({ target: bard, why: 'mezzer' });
        const onMerlin = foe(3, { x: 650, y: 0, target: 'Merlin' });
        expect(stunTarget(me, members, [onMerlin, bard], undefined, 1500, 60, NOW, 5)?.why).toBe('peel');
        expect(stunTarget(me, members, [{ ...bard, ccImmune: { stun: NOW + 9000 } }], undefined, 1500, 60, NOW, 5)).toBeNull();
        expect(camelotMezzer({ phase: 'engage', camMezzer: 5 })).toBe(5);
        expect(camelotMezzer({ phase: 'engage' })).toBeNull();
    });

    test('the enemy healer once our focus is low, else the focus itself, and not before', () => {
        const focus = foe(1, { hp: 40 });
        const healer = foe(2, { healer: true, y: 1400 });
        expect(stunTarget(me, members, [focus, healer], focus, 1500, 60, NOW)).toEqual({ target: healer, why: 'healer' });
        expect(stunTarget(me, members, [focus, healer], { ...focus, hp: 80 }, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [focus], focus, 1500, 60, NOW)).toEqual({ target: focus, why: 'focus' });
        expect(stunTarget(me, members, [focus], { ...focus, hp: 80 }, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [{ ...focus, ccImmune: { stun: NOW + 9000 } }], { ...focus, ccImmune: { stun: NOW + 9000 } }, 1500, 60, NOW)).toBeNull();
    });

    test('Nimue reaches Stunning Flare at 24: baseline, 1500, 5 s, 9 power', () => {
        const flare = reachOfBuild(getBuild('Cleric', 'Healer')!, 24).known.find(k => k.name === 'Stunning Flare')!;
        expect([flare.info.type, flare.info.range, flare.info.duration, flare.info.power]).toEqual(['Stun', 1500, 5, 9]);
    });

    test('in the RvR healer list the stun goes below heal, and before her Smite', () => {
        const list = withCharacter(rvrBehaviors().healer, cleric()).map(b => b.name);
        expect(list.indexOf('stunPeel')).toBeGreaterThan(list.indexOf('heal'));
        expect(list.indexOf('stunPeel')).toBe(list.indexOf('assist') - 1);
        expect(withCharacter(rvrBehaviors().healer, cleric({ stun: false })).map(b => b.name)).not.toContain('stunPeel');
    });
});
