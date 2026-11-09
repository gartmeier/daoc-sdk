import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import { enemy } from '../group/fixtures';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { reachOfBuild } from './reach';
import { diseaseSpell, diseaseWanted, shaman } from './shaman';

describe('shaman kit', () => {
    test('Buffer healer has Infectious Spores at 24, and the kit picks it', () => {
        const r = reachOfBuild(getBuild('Shaman', 'Buffer healer')!, 24);
        const spores = r.known.find(k => k.name === 'Infectious Spores')!;
        expect(spores.info.type).toBe('Disease');
        const pick = (name: string, type: string, level: number, power: number) =>
            ({ spell: { name, level, cooldownRemaining: 0 }, type, target: 'Enemy', range: 1500, radius: 0, power, castTime: 3, duration: 90, recast: 0, concentration: 0, pulse: false }) as any;
        const all = [pick('Fungal Erosion', 'DamageOverTime', 10, 12), pick('Infectious Spores', 'Disease', 9, 10)];
        expect(diseaseSpell(all, 50)?.spell.name).toBe('Infectious Spores');
        expect(diseaseSpell(all, 5)).toBeNull();
    });

    test('disease goes in after heal, ahead of the DoTs, in every list', () => {
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.healer as Behavior<any>[], shaman()).map(b => b.name);
            expect(list.lastIndexOf('heal')).toBeLessThan(list.indexOf('disease'));
            expect(list.indexOf('disease')).toBe(list.indexOf('assist') - 1);
        }
    });

    test('only a free enemy player in range, once per its length', () => {
        const now = 1_000_000;
        const foe = enemy(1, 'hibernia');
        expect(diseaseWanted(foe, 0, 1000, 1500, now)).toBe(true);
        expect(diseaseWanted(foe, now + 5000, 1000, 1500, now)).toBe(false);
        expect(diseaseWanted(foe, 0, 1600, 1500, now)).toBe(false);
        expect(diseaseWanted({ ...foe, cc: { by: 'Sigrid', kind: 'mezz', until: now + 9000 } }, 0, 1000, 1500, now)).toBe(false);
        expect(diseaseWanted({ ...foe, kind: 'npc' }, 0, 1000, 1500, now)).toBe(false);
        expect(diseaseWanted(undefined, 0, 1000, 1500, now)).toBe(false);
    });
});
