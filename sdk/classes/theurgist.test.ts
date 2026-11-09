import { describe, expect, test } from 'bun:test';
import { dist } from '../group/battleground';
import { withCharacter } from '../group/character';
import { withPets } from '../group/pets';
import { rvrBehaviors } from '../group/rvr';
import type { Contact } from '../group/types';
import { giveGroundStep, havenOf, HAVEN_ORBIT, meleeOn, theurgist } from './theurgist';

const at = (name: string, role: string, x: number, y: number, isDead = false) => ({ name, role: role as any, isDead, regionId: 238, x, y });
const foe = (over: Partial<Contact>): Contact => ({ objectId: 9, name: 'Celt', kind: 'player', regionId: 238, x: 0, y: 0, hp: 100, target: null, stale: false, cc: null, ...over } as Contact);

describe('the theurgist kit', () => {
    test('gives ground toward the tank, else the healer', () => {
        const me = at('Taliesin', 'nuker', 0, 0);
        const galahad = at('Galahad', 'tank', 100, 0), nimue = at('Nimue', 'healer', -600, 0);
        expect(havenOf(me, [me, galahad, nimue])?.name).toBe('Galahad');
        expect(havenOf(me, [me, { ...galahad, isDead: true }, nimue])?.name).toBe('Nimue');
        expect(havenOf(me, [me, { ...galahad, isDead: true }])).toBeNull();
    });

    test('steps to the far side of the haven from the attacker, and round it when already there', () => {
        const haven = { x: 0, y: 0 };
        const first = giveGroundStep({ x: 50, y: 0 }, [{ x: 150, y: 0 }], haven);
        expect(first.x).toBeCloseTo(-HAVEN_ORBIT);
        expect(first.y).toBeCloseTo(0);
        const round = giveGroundStep(first, [{ x: 150, y: 0 }], haven);
        expect(dist(round, haven)).toBeCloseTo(HAVEN_ORBIT);
        expect(dist(round, first)).toBeGreaterThan(100);
    });

    test('a melee on him counts, a caster nuking him from range does not', () => {
        const me = { name: 'Taliesin', x: 0, y: 0 };
        expect(meleeOn(me, [foe({ x: 100, target: 'Taliesin' })])).toHaveLength(1);
        expect(meleeOn(me, [foe({ x: 1400, target: 'Taliesin', targetBySpell: true })])).toHaveLength(0);
        expect(meleeOn(me, [foe({ x: 100, target: 'Taliesin', cc: { by: 'Merlin', kind: 'mezz', until: Date.now() + 9000 } })])).toHaveLength(0);
    });

    test('in the RvR nuker list giveGround goes after flee and before his pets and his nuke', () => {
        const list = withPets(withCharacter(rvrBehaviors().nuker.filter(b => b.name !== 'crowdControl'), theurgist({ saveBelow: 0 })), { fnf: true, fnfFloor: 0 }).map(b => b.name);
        expect(list.indexOf('giveGround')).toBeGreaterThan(list.indexOf('flee'));
        expect(list.indexOf('giveGround')).toBeLessThan(list.indexOf('fnfPet'));
        expect(list.indexOf('fnfPet')).toBeLessThan(list.indexOf('assist'));
        expect(withCharacter(rvrBehaviors().nuker, theurgist({ giveGround: false })).map(b => b.name)).not.toContain('giveGround');
    });
});
