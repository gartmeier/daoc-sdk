import { describe, expect, test } from 'bun:test';
import { dist } from '../group/battleground';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { necromancer, servantBuffPicks, servantHealPick, servantNuke, servantNukes, stepAway } from './necromancer';
import { knownThrough } from './summoner-fixtures';

const nukesOf = (build: string) => servantNukes(knownThrough('Necromancer', build, 24, 'PetSpell'));
const names = (list: { pick: { spell: { name: string } } }[]) => list.map(k => k.pick.spell.name);

describe('necromancer kit', () => {
    test('a nuker: tether and servant above position, its servant fight in place of assist, its buffs below', () => {
        expect(necromancer().role).toBe('nuker');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.nuker as Behavior<any>[], necromancer()).map(b => b.name);
            expect(list).not.toContain('assist');
            expect(list.indexOf('servantHeal')).toBeLessThan(list.indexOf('servantFight'));
            expect(list.indexOf('servantBuffs')).toBeGreaterThan(list.indexOf('servantFight'));
            if (list.includes('position')) expect(list.indexOf('keepTether')).toBeLessThan(list.indexOf('position'));
            expect(list.indexOf('raiseServant')).toBeLessThan(list.indexOf('servantFight'));
        }
    });

    test('Deathsight: the hardest hit, the instant-servant one under a melee, the next when it is not ready', () => {
        const nukes = nukesOf('Deathsight');
        expect(names(nukes)).toEqual(expect.arrayContaining(['Vitality Theft', 'Energy Vacuum', 'Pain of the Dead']));
        expect(servantNuke(nukes, { underMelee: false, servantHp: 100 })?.pick.spell.name).toBe('Vitality Theft');
        expect(servantNuke(nukes, { underMelee: true, servantHp: 100 })?.pick.spell.name).toBe('Pain of the Dead');
        expect(servantNuke(nukes, { underMelee: false, servantHp: 100, ready: n => n.pick.spell.name !== 'Vitality Theft' })?.pick.spell.name).toBe('Energy Vacuum');
        expect(nukes.find(n => n.pick.spell.name === 'Pain of the Dead')!.ownerCast).toBe(true);
        expect(nukes.find(n => n.pick.spell.name === 'Vitality Theft')!.ownerCast).toBe(false);
    });

    test("Sight and servant split (Morgause's): Vitality Theft, and under a melee a Cackle, whose servant half is instant", () => {
        const nukes = nukesOf('Sight and servant split');
        expect(servantNuke(nukes, { underMelee: false, servantHp: 100 })?.pick.spell.name).toBe('Vitality Theft');
        const under = servantNuke(nukes, { underMelee: true, servantHp: 100 })!;
        expect(under.ownerCast).toBe(true);
        expect(under.pick.spell.name).toMatch(/Cackle/);
    });

    test('no area spell unless asked: Channeled Savagery hits 108 around the servant', () => {
        const nukes = nukesOf('Servant with a healer');
        expect(servantNuke(nukes, { underMelee: false, servantHp: 100 })?.area).toBe(false);
        expect(servantNuke(nukes, { underMelee: false, servantHp: 100, aoe: true })?.pick.spell.name).toBe('Channeled Savagery');
    });

    test('its heal is Regenerate Muscle at 24, its buffs the top rank of each kind', () => {
        const all = knownThrough('Necromancer', 'Deathsight', 24, 'PetSpell');
        expect(servantHealPick(all)?.pick.spell.name).toBe('Regenerate Muscle');
        const buffs = names(servantBuffPicks(all));
        expect(buffs).toContain('Vigor of the Dead');
        expect(buffs).toContain('Servant of the Grave');
        expect(buffs).not.toContain('Strength of the Dead');
    });

    test('a step straight away from the nearest enemy', () => {
        const to = stepAway({ x: 0, y: 0 }, { x: 1000, y: 0 });
        expect(to.x).toBeCloseTo(-1500);
        expect(dist(to, { x: 0, y: 0 })).toBeCloseTo(1500);
    });
});
