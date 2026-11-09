import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { rvrBehaviors } from '../group/rvr';
import { withCharacter } from '../group/character';
import type { Contact } from '../group/types';
import { cleric, stunTarget } from './cleric';
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

    test('not one on the tank, nor one nuking from afar, mezzed, stun-immune, or out of reach', () => {
        expect(stunTarget(me, members, [foe(1, { x: 0, y: 950, target: 'Galahad' })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [foe(1, { x: 600, y: 1400, target: 'Merlin', targetBySpell: true })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [foe(1, { x: 650, y: 0, target: 'Merlin', cc: { by: 'Merlin', kind: 'mezz', until: NOW + 5000 } })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget(me, members, [foe(1, { x: 650, y: 0, target: 'Merlin', ccImmune: { stun: NOW + 30_000 } })], undefined, 1500, 60, NOW)).toBeNull();
        expect(stunTarget({ ...me, x: -2000 }, members, [foe(1, { x: 650, y: 0, target: 'Merlin' })], undefined, 1500, 60, NOW)).toBeNull();
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
