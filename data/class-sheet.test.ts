import { describe, expect, test } from 'bun:test';
import { classSheet, classSpecs, classSpellLines, specCost, specLevelsAt, specPointsAt } from './class-sheet';
import { getClass, getClasses } from './index';

const mentalist = getClass('Mentalist')!;

describe('class sheet', () => {
    test('a class has its trainable lines, not its careers', () => {
        expect(classSpecs(mentalist)).toEqual(['Light', 'Mana', 'Mentalism']);
    });

    test('its spell lines are its own or shared, never another class\'s', () => {
        const names = classSpellLines(mentalist).map(l => l.keyName);
        expect(names).toEqual(['Way of the Sun', 'Illusions', 'Way of the Moon', 'Holism', 'Mentalism', 'Mind Mastery']);
        expect(names).not.toContain('Shadow Control');   // the Eldritch's Light line
    });

    test('the sheet names spells with what they do', () => {
        const sheet = classSheet(mentalist);
        expect(sheet).toContain('| 4 | Empowering Unity | PowerRegenBuff | Realm | value 1 |');
        expect(sheet).toContain('## Holism (Mana Magic, specialist)');
    });

    test('a class with styles lists them', () => {
        expect(classSheet(getClass('Hero')!)).toContain('## Styles');
    });

    test('every class gets a sheet', () => {
        for (const c of getClasses()) expect(classSheet(c)).toStartWith(`# ${c.name}`);
    });
});

describe('spec points', () => {
    test.each([
        // Real characters' points (Hero and list caster at 22, Blademaster at 24).
        [22, 20, 490], [22, 10, 252], [24, 20, 584],
    ])('level %i at x%i has %i', (level, mult, points) => {
        expect(specPointsAt(level, mult)).toBe(points);
    });

    test('a list caster at 50 can pay for the usual 46/28/4', () => {
        expect(specCost(46) + specCost(28) + specCost(4)).toBe(specPointsAt(50, 10));
    });

    test('a plan spends what it may, within the level', () => {
        const levels = specLevelsAt({ Mana: 1, Mentalism: 0.3 }, 20, 10);
        expect(specCost(levels.Mana!) + specCost(levels.Mentalism!)).toBeLessThanOrEqual(209);
        expect(levels).toEqual({ Mana: 19, Mentalism: 6 });
        expect(specLevelsAt({ Mana: 1 }, 5, 100).Mana).toBe(5);
    });
});
