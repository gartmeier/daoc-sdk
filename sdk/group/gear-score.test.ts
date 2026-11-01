// What bonuses are worth per class, from the real classes.json. Weights are judgement, so these pin
// their orderings and the server's caps rather than every number.
import { describe, expect, test } from 'bun:test';
import { getClass, type ClassInfo } from '../../data/index';
import { parseDelve } from '../delve';
import type { ItemBonus } from '../types';
import { ARMOR_STAT_RATE, armorGain, armorSwing, armorValue, bonusCap, BONUS_WEIGHTS, SIDE_STAT_WEIGHT, STAT_WEIGHTS, statScore, statWeight } from './gear-score';

const cls = (name: string, realm?: string): ClassInfo => getClass(name, realm as never)!;
const bonuses = (...lines: string[]): ItemBonus[] => parseDelve(['Magical Bonuses:', ...lines, ' ']).bonuses;
const score = (name: string, line: string | string[], level = 20) => statScore(bonuses(...[line].flat()), cls(name), level);

describe('statWeight', () => {
    test('the class data decides, the Paladin as the example: CON, PIE, STR, mana PIE', () => {
        const paladin = cls('Paladin');
        expect(statWeight('CON', paladin, 20)).toBe(STAT_WEIGHTS.primary);
        expect(statWeight('PIE', paladin, 20)).toBe(STAT_WEIGHTS.mana);
        expect(statWeight('STR', paladin, 20)).toBe(STAT_WEIGHTS.tertiary);
        expect(statWeight('INT', paladin, 20)).toBe(0);
    });

    test('a caster has no use for strength, and a tank none for intelligence', () => {
        expect(statWeight('STR', cls('Sorcerer'), 20)).toBe(0);
        expect(statWeight('INT', cls('Armsman'), 20)).toBe(0);
        expect(statWeight('INT', cls('Sorcerer'), 20)).toBe(1);
    });

    test('constitution always gives hits: BaseHP * level / 10000 of them, at the hits weight', () => {
        // Sorcerer: BaseHP 560, level 20: 1.12 hits per point.
        expect(statWeight('CON', cls('Sorcerer'), 20)).toBeCloseTo(1.12 * BONUS_WEIGHTS.hits);
        // Armsman: BaseHP 880: its secondary 0.6 until the hits overtake it, 4.4 hits per point at level 50.
        expect(statWeight('CON', cls('Armsman'), 20)).toBe(STAT_WEIGHTS.secondary);
        expect(statWeight('CON', cls('Armsman'), 50)).toBeCloseTo(4.4 * BONUS_WEIGHTS.hits);
        expect(statWeight('CON', cls('Sorcerer'), 1)).toBeLessThan(statWeight('CON', cls('Sorcerer'), 20));
    });

    test('dex shortens casts, qui shortens swings', () => {
        expect(statWeight('DEX', cls('Cleric'), 20)).toBe(SIDE_STAT_WEIGHT);
        expect(statWeight('QUI', cls('Armsman'), 20)).toBe(SIDE_STAT_WEIGHT);
        expect(statWeight('DEX', cls('Sorcerer'), 20)).toBe(STAT_WEIGHTS.secondary);
        expect(statWeight('QUI', cls('Sorcerer'), 20)).toBe(STAT_WEIGHTS.tertiary);
    });

    test('acuity is the mana stat, not for the classes it does not raise (StatCalculator.cs:188-194)', () => {
        expect(statWeight('ACU', cls('Sorcerer'), 20)).toBe(1);
        expect(statWeight('ACU', cls('Paladin'), 20)).toBe(STAT_WEIGHTS.mana);
        expect(statWeight('ACU', cls('Armsman'), 20)).toBe(0);
        expect(statWeight('ACU', cls('Scout'), 20)).toBe(0);
    });

    test('a base class goes by its advanced classes', () => {
        expect(cls('Mage').primaryStat).toBeNull();
        expect(statWeight('INT', cls('Mage'), 3)).toBe(1);
        expect(cls('Fighter').primaryStat).toBeNull();
        expect(statWeight('STR', cls('Fighter'), 3)).toBeGreaterThan(statWeight('INT', cls('Fighter'), 3));
    });

    test('but only by its own mana stat: ClassFighter.cs sets none, so a subclass\'s does nothing before promotion', () => {
        expect(statWeight('PIE', cls('Fighter'), 4)).toBe(0);
        expect(statWeight('ACU', cls('Fighter'), 4)).toBe(0);
        expect(statWeight('PIE', cls('Viking'), 4)).toBe(0);
        expect(statWeight('INT', cls('Guardian'), 4)).toBe(0);
        expect(statWeight('ACU', cls('Rogue', 'albion'), 4)).toBe(0);
        expect(statWeight('ACU', cls('Stalker'), 4)).toBe(0);
        expect(statWeight('DEX', cls('Viking'), 4)).toBe(0);
        // A base caster has one (ClassAcolyte.cs:33).
        expect(statWeight('PIE', cls('Acolyte'), 4)).toBe(1);
        expect(statWeight('ACU', cls('Acolyte'), 4)).toBe(1);
        expect(statWeight('INT', cls('Mystic'), 4)).toBe(STAT_WEIGHTS.mana);
    });

    test('qui shortens a valewalker\'s swings, though the server calls it a list caster (ClassForester.cs:41-44)', () => {
        expect(cls('Valewalker').classType).toBe('ListCaster');
        expect(statWeight('QUI', cls('Valewalker'), 20)).toBe(SIDE_STAT_WEIGHT);
        expect(statWeight('QUI', cls('Animist'), 20)).toBe(0);
    });
});

describe('statScore', () => {
    test('nothing, and what a class cannot use, is 0', () => {
        expect(score('Sorcerer', [])).toBe(0);
        expect(score('Sorcerer', '4.67 | Strength: 7 pts')).toBe(0);
        expect(score('Armsman', '0.00 | Power: 3 pts')).toBe(0);
        expect(score('Armsman', '0.00 | Bonus to casting speed: 2 pts')).toBe(0);
        expect(score('Armsman', '0.00 | Power Pool: 3 % of power pool.')).toBe(0);
        expect(score('Sorcerer', '0.00 | Fatigue: 8 pts')).toBe(0);
        expect(score('Sorcerer', '10.00 | Slash: 2 pts')).toBe(0);
        expect(score('Armsman', '10.00 | Body Magic: 2 pts')).toBe(0);
    });

    test('the same item ranks differently per class', () => {
        const might = '4.67 | Strength: 7 pts', arcane = '4.67 | Intelligence: 7 pts';
        expect(score('Armsman', might)).toBeGreaterThan(score('Armsman', arcane));
        expect(score('Sorcerer', arcane)).toBeGreaterThan(score('Sorcerer', might));
    });

    test('hits and resists count for everyone', () => {
        for (const c of ['Sorcerer', 'Armsman', 'Paladin']) {
            expect(score(c, '5.00 | Hits: 20 pts')).toBe(5);
            expect(score(c, '6.00 | Heat: 3 %')).toBe(6);
        }
    });

    test('on one generated roll at level 20, the main stat beats a resist beats hits', () => {
        const main = score('Sorcerer', '4.67 | Intelligence: 7 pts');
        expect(main).toBeGreaterThan(score('Sorcerer', '6.00 | Heat: 3 %'));
        expect(score('Sorcerer', '6.00 | Heat: 3 %')).toBeGreaterThan(score('Sorcerer', '5.00 | Hits: 20 pts'));
    });

    test('a skill counts for a spec the class has, under the name classes.json uses', () => {
        expect(score('Sorcerer', '10.00 | Body Magic: 2 pts')).toBe(10);
        expect(score('Armsman', '10.00 | Slash: 2 pts')).toBe(10);
        expect(score('Armsman', '10.00 | Crossbow: 2 pts')).toBe(10); // spec "Crossbows"
        expect(score('Cleric', '10.00 | Smiting: 2 pts')).toBe(10);   // spec "Smite"
        expect(score('Enchanter', '10.00 | Enchantment: 2 pts')).toBe(10); // spec "Enchantments"
        expect(score('Armsman', '10.00 | Thrust: 2 pts')).toBe(10);
        expect(score('Sorcerer', '6.00 | Thrust: 3 %')).toBe(6); // the resist of that name
    });

    test('a skill counts from the level the class gets the spec (GamePlayer.cs:9932-9941)', () => {
        expect(score('Paladin', '10.00 | Parry: 2 pts', 14)).toBe(0);
        expect(score('Paladin', '10.00 | Parry: 2 pts', 15)).toBe(10);
        expect(score('Armsman', '10.00 | Crossbow: 2 pts', 14)).toBe(0);
        expect(score('Armsman', '10.00 | Crossbow: 2 pts', 15)).toBe(10);
        expect(score('Paladin', '5.00 | Constitution: 5 pts', 12)).toBeGreaterThan(score('Paladin', '10.00 | Parry: 2 pts', 12));
    });

    test('an all-skills bonus counts from the level the class gets one of its kind', () => {
        expect(score('Ranger', '5.00 | ALL Dual Wielding Skills: 1 pts', 9)).toBe(0);
        expect(score('Ranger', '5.00 | ALL Dual Wielding Skills: 1 pts', 10)).toBe(5);
    });

    test('a level 4 Fighter: hits and constitution count, a stat and power without a mana stat do not', () => {
        expect(score('Fighter', '0.67 | Piety: 1 pts', 4)).toBe(0);
        expect(score('Fighter', '0.50 | Hits: 2 pts', 4)).toBe(0.5);
        expect(score('Fighter', '0.67 | Constitution: 1 pts', 4)).toBeGreaterThan(0);
        expect(score('Fighter', '0.00 | Power: 2 pts', 4)).toBe(0);
        expect(score('Fighter', '0.00 | Power Pool: 2 % of power pool.', 4)).toBe(0);
        expect(score('Fighter', '0.00 | Bonus to casting speed: 2 pts', 4)).toBe(0);
        expect(score('Acolyte', '0.00 | Power: 2 pts', 4)).toBe(4);
    });

    test('a valewalker uses fatigue, an animist does not', () => {
        expect(score('Valewalker', '0.00 | Fatigue: 5 pts')).toBe(2.5);
        expect(score('Animist', '0.00 | Fatigue: 5 pts')).toBe(0);
    });

    test('an all-skills bonus needs a skill of its kind', () => {
        expect(score('Sorcerer', '5.00 | ALL Magic Skills: 1 pts')).toBe(5);
        expect(score('Armsman', '5.00 | ALL Magic Skills: 1 pts')).toBe(0);
        expect(score('Armsman', '5.00 | ALL Melee Weapon Skills: 1 pts')).toBe(5);
        expect(score('Sorcerer', '5.00 | ALL Melee Weapon Skills: 1 pts')).toBe(0);
        expect(score('Sorcerer', '5.00 | All Skills: 1 pts')).toBe(5);
        expect(score('Armsman', '5.00 | All Skills: 1 pts')).toBe(5);
    });

    test('power and casting speed count for a mana stat, AF for all', () => {
        expect(score('Sorcerer', '6.00 | Power: 3 pts')).toBe(6);
        expect(score('Paladin', '0.00 | Bonus to casting speed: 2 pts')).toBe(4);
        expect(score('Sorcerer', '0.00 | Bonus to armor factor (AF): 5 pts')).toBe(5);
        expect(score('Armsman', '0.00 | Bonus to armor factor (AF): 5 pts')).toBe(5);
    });

    test('a focus counts for its own line only', () => {
        expect(score('Sorcerer', '- Body Magic Focus: 4 lvls')).toBe(1);
        expect(score('Sorcerer', '- Fire Magic Focus: 4 lvls')).toBe(0);
        expect(score('Sorcerer', '- ALL Spell Lines: 4 lvls')).toBe(1);
        expect(score('Armsman', '- ALL Spell Lines: 4 lvls')).toBe(0);
    });

    test('a focus counts for focus casters only (FocusLevelCalculator.cs:28, SpellHandler.cs:1204)', () => {
        expect(score('Cleric', '- ALL Spell Lines: 4 lvls')).toBe(0);
        expect(score('Cleric', '- Rejuvenation Focus: 4 lvls')).toBe(0);
        expect(score('Valewalker', '- Arboreal Focus: 5 lvls')).toBe(0);
        expect(score('Valewalker', '- ALL Spell Lines: 4 lvls')).toBe(0);
        // Animist shares Forester's flag; Necromancer, Theurgist, Runemaster and Mentalist their base class's.
        expect(score('Animist', '- ALL Spell Lines: 4 lvls')).toBe(1);
        expect(score('Animist', '- Arboreal Focus: 4 lvls')).toBe(1);
        for (const c of ['Necromancer', 'Theurgist', 'Runemaster', 'Mentalist', 'Mage']) expect(score(c, '- ALL Spell Lines: 4 lvls')).toBe(1);
    });

    test('a penalty is a net negative, but only on what the class uses', () => {
        expect(score('Sorcerer', '-3.33 | Intelligence: -5 pts')).toBe(-5);
        expect(score('Sorcerer', '-3.33 | Strength: -5 pts')).toBe(0);
        expect(score('Sorcerer', ['4.67 | Intelligence: 7 pts', '-2.00 | Heat: -1 %'])).toBe(5);
    });

    test('other, PvE-only and unknown lines weigh nothing', () => {
        expect(score('Armsman', ['0.00 | Evade chance: 5 pts', '- Defensive Bonus: 5% (PvE Only)', '0.00 | Property123: 5 pts'])).toBe(0);
    });

    test('caps: what is over the level\'s item cap counts as the cap', () => {
        expect(bonusCap({ category: 'stat' }, 20)).toBe(30);
        expect(bonusCap({ category: 'hits' }, 20)).toBe(80);
        expect(bonusCap({ category: 'resist' }, 20)).toBe(11);
        expect(bonusCap({ category: 'skill' }, 20)).toBe(5);
        expect(bonusCap({ category: 'power' }, 20)).toBe(11);
        expect(bonusCap({ category: 'powerPool' }, 20)).toBe(10);
        expect(bonusCap({ category: 'armorFactor' }, 20)).toBe(20);
        expect(score('Sorcerer', '10.00 | Intelligence: 15 pts', 5)).toBe(7);
        expect(score('Sorcerer', '10.00 | Intelligence: 15 pts', 20)).toBe(15);
        expect(score('Sorcerer', '30.00 | Heat: 15 %', 20)).toBe(22);
        expect(score('Sorcerer', '30.00 | Body Magic: 6 pts', 20)).toBe(25);
    });
});

describe('armorValue', () => {
    const piece = (objectType: number, value1: number, value2: number, quality = 100) => ({ objectType, value1, value2, quality });

    test('absorb counts on the whole armour factor: Galahad L4, studded arms beat cloth sleeves', () => {
        expect(armorValue(piece(34, 4, 19, 85), 4)).toBeGreaterThan(armorValue(piece(32, 5, 0, 95), 4));
    });

    test('AF caps: cloth at the level, the rest at twice the level, before quality', () => {
        expect(armorValue(piece(32, 40, 0), 20)).toBe(30);
        expect(armorValue(piece(36, 60, 0), 20)).toBe(50);
        expect(armorValue(piece(36, 60, 0, 50), 20)).toBe(30);
    });
});

describe('armorGain', () => {
    const cloth = (af: number) => armorValue({ objectType: 32, value1: af, value2: 0, quality: 100 }, 20);
    const plate = (af: number) => armorValue({ objectType: 36, value1: af, value2: 34, quality: 90 }, 20);

    test('no delve leaves AF and absorb alone', () => {
        expect(armorGain(30, 25, null, 10)).toBe(5);
        expect(armorGain(30, 25, 10, null)).toBe(5);
    });

    test('stat score converts at the rate', () => {
        expect(armorGain(30, 30, 10, 2)).toBe(8 * ARMOR_STAT_RATE);
    });

    test('a caster can give up at most 3 cloth AF for bonuses, however good', () => {
        expect(armorGain(cloth(16.9), cloth(20), 1000, 0)).toBeLessThan(0);
        expect(armorGain(cloth(17.5), cloth(20), 1000, 0)).toBeGreaterThan(0);
    });

    test('a tank gives up under 5 AF of plate', () => {
        expect(armorGain(plate(40 - 6), plate(40), 1000, 0)).toBeLessThan(0);
        expect(armorGain(plate(40 - 4), plate(40), 1000, 0)).toBeGreaterThan(0);
    });

    test('bad bonuses cost as much at most, on the piece with AF to spare', () => {
        const swing = armorSwing(cloth(20), cloth(10));
        expect(armorGain(cloth(20), cloth(10), -1000, 0)).toBeCloseTo(cloth(20) - cloth(10) - swing);
        expect(armorGain(cloth(20), cloth(10), -1000, 0)).toBeGreaterThan(0);
    });

    test('an empty slot takes any armour, whatever its bonuses', () => {
        expect(armorGain(cloth(20), 0, -1000, 0)).toBeGreaterThan(0);
    });
});
