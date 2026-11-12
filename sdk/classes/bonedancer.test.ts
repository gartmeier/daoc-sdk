import { describe, expect, test } from 'bun:test';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { withPets } from '../group/pets';
import { rvrBehaviors } from '../group/rvr';
import { pickNuke } from '../group/spells';
import { bonedancer, minionPick, minionRole, minionRoom } from './bonedancer';
import { knownPicks } from './summoner-fixtures';

describe('bonedancer kit', () => {
    test('a nuker: the minion below the fight, quickcast above flee, the commander from withPets', () => {
        expect(bonedancer().role).toBe('nuker');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withPets(withCharacter(lists.nuker as Behavior<any>[], bonedancer()), { main: true }).map(b => b.name);
            expect(list.filter(n => n === 'assist')).toHaveLength(1);
            expect(list.indexOf('summonMinion')).toBeGreaterThan(list.indexOf('assist'));
            expect(list).toContain('summonPet');
            expect(list).toContain('petControl');
            if (list.includes('flee')) expect(list.indexOf('quickcast')).toBe(list.indexOf('flee') - 1);
        }
        expect(withCharacter(rvrBehaviors().nuker, bonedancer({ minion: false })).map(b => b.name)).not.toContain('summonMinion');
    });

    test('minions by what they do, the damage kinds first unless heal is asked for', () => {
        expect(minionRole('Summon Bonemage')).toBe('caster');
        expect(minionRole('Summon Bone Dart')).toBe('archer');
        expect(minionRole('Summon Bonesmasher')).toBe('melee');
        expect(minionRole('Summon Bonepatcher')).toBe('healer');
        const split = knownPicks('Bonedancer', 'Split Darkness and Suppression', 24);
        expect(minionPick(split, 'damage')?.spell.name).toBe('Summon Bonemage');
        expect(minionPick(split, 'heal')?.spell.name).toBe('Summon Bonepatcher');
        const army = knownPicks('Bonedancer', 'Bone Army', 24);
        expect(minionPick(army, 'damage')?.spell.name).toBe('Summon Bone Arrow');
    });

    test('a Chieftan holds one minion at 15 to 29, two from 30', () => {
        expect(minionRoom(14)).toBe(0);
        expect(minionRoom(24)).toBe(1);
        expect(minionRoom(30)).toBe(2);
    });

    test('every build has an instant lifedrain for under fire, so it gives ground only while that recasts', () => {
        expect(pickNuke(knownPicks('Bonedancer', 'Suppression lifetap', 24), { instant: true })?.spell.name).toBe('Crunch Skeleton');
        expect(pickNuke(knownPicks('Bonedancer', 'Bone Army', 24), { instant: true })?.spell.name).toBe('Crush Skeleton');
        expect(pickNuke(knownPicks('Bonedancer', 'Split Darkness and Suppression', 24), { instant: true })?.spell.name).toBe('Crumple Skeleton');
    });
});
