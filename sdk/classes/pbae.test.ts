import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { packBehaviors } from '../group/pack';
import { withCharacter } from '../group/character';
import { enchanter } from './enchanter';
import { wizard } from './wizard';
import { reachOfBuild } from './reach';
import { bombVerdict, pbaeSpell } from './pbae';

const pick = (name: string, damage: number, level: number, over: object = {}) =>
    ({ spell: { name, level, cooldownRemaining: 0 }, type: 'DirectDamage', target: 'Enemy', range: 0, radius: 300, power: 12, castTime: 2.5, damage, ...over }) as any;
const at = (id: number, x: number, z = 0) => ({ id, x, y: 0, z });
const me = { x: 0, y: 0, z: 0 };

describe('the point-blank bomb', () => {
    test('the Mana build has Disenchanting Emission at 24, the Light build only a rank under the floor, the Ice Wizard Steaming Blast', () => {
        const known = (c: string, n: string) => reachOfBuild(getBuild(c, n)!, 24).known.map(k => k.name);
        expect(known('Enchanter', 'Mana nuker')).toContain('Disenchanting Emission');
        expect(known('Enchanter', 'Light nuker')).not.toContain('Disenchanting Emission');
        expect(pbaeSpell([pick('Minor Disenchanting Emanation', 52, 1)])).toBeNull();
        expect(pbaeSpell([pick('Disenchanting Emanation', 74, 8), pick('Disenchanting Emission', 133, 20)])?.spell.name).toBe('Disenchanting Emission');
        expect(pbaeSpell([pick('Disenchanting Emission', 133, 20)], 10)).toBeNull();
        expect(pbaeSpell([pick('Ice Blast', 88, 24, { range: 1500, radius: 0 })])).toBeNull();
    });

    test('two enemies inside the radius: a bomb; one, or one at the edge, none', () => {
        expect(bombVerdict(me, [at(1, 100), at(2, 200)], [], 300)).toEqual({ hit: 2 });
        expect(bombVerdict(me, [at(1, 100)], [], 300)).toEqual({ none: 'few' });
        expect(bombVerdict(me, [at(1, 100), at(2, 280)], [], 300)).toEqual({ none: 'few' });
        // On the wall-walk above her: 3D.
        expect(bombVerdict(me, [at(1, 100), at(2, 100, 250)], [], 300)).toEqual({ none: 'few' });
    });

    test('never with our crowd control in or near its radius', () => {
        expect(bombVerdict(me, [at(1, 100), at(2, 150)], [at(3, 350)], 300)).toEqual({ none: 'cc' });
        expect(bombVerdict(me, [at(1, 100), at(2, 150)], [at(3, 500)], 300)).toEqual({ hit: 2 });
    });

    test('in the Enchanter and Wizard kits above the fight', () => {
        for (const c of [enchanter(), wizard()]) {
            const list = withCharacter(packBehaviors().nuker as any[], c).map(b => b.name);
            expect(list.indexOf('pbae')).toBeGreaterThan(-1);
            expect(list.indexOf('pbae')).toBeLessThan(list.indexOf('assist') >= 0 ? list.indexOf('assist') : list.length);
        }
    });
});
