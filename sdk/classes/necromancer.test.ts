import { describe, expect, test } from 'bun:test';
import { dist } from '../group/battleground';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { leashOrders, necromancer, OWNER_STAND, servantBuffPicks, servantHealPick, servantNuke, servantNukes, stepAway } from './necromancer';
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

    test('the leash: off and following in a retreat, called off a far fight out of an engage, left alone in one', () => {
        const fighting = { aggression: 'defensive', walk: 'follow', targetObjectId: 7 };
        expect(leashOrders('retreat', fighting, 300, 3)).toEqual(['passive', 'follow']);
        expect(leashOrders('retreat', { aggression: 'passive', walk: 'follow', targetObjectId: null }, 300, 3)).toEqual([]);
        expect(leashOrders('travel', fighting, 1400, 2)).toEqual(['follow']);
        expect(leashOrders('travel', fighting, 400, 2)).toEqual([]);
        expect(leashOrders('travel', fighting, 400, 0)).toEqual(['follow']);
        expect(leashOrders('engage', fighting, 1900, 2)).toEqual([]);
        const list = withCharacter(rvrBehaviors().nuker, necromancer());
        expect(list.find(b => b.name === 'servantLeash')?.side).toBe(true);
    });

    test('a step straight away from the nearest enemy', () => {
        const to = stepAway({ x: 0, y: 0 }, { x: 1000, y: 0 });
        expect(to.x).toBeCloseTo(-1500);
        expect(dist(to, { x: 0, y: 0 })).toBeCloseTo(1500);
    });
    test('in a fight the shade stands where an attack order (2000 from the owner) and Vitality Theft (from the owner) both reach', () => {
        const vt = nukesOf('Sight and servant split').find(n => n.pick.spell.name === 'Vitality Theft')!;
        expect(OWNER_STAND + 150).toBeLessThan(2000);
        expect(OWNER_STAND).toBeLessThanOrEqual(vt.range);
    });
});
