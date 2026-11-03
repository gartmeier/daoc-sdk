import { describe, expect, test } from 'bun:test';
import { classSheet, classSpecs, classSpellLines } from './class-sheet';
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

    test('its points come from the rule, half levels counted at 50', () => {
        expect(classSheet(mentalist)).toContain('Spec points x1: 54 at 10, 209 at 20, 464 at 30, 819 at 40, 1494 at 50');
        expect(classSheet(getClass('Hero')!)).toContain('Spec points x2: 94 at 10, 404 at 20, 914 at 30, 1624 at 40, 2979 at 50');
    });

    test('a class with styles lists them', () => {
        expect(classSheet(getClass('Hero')!)).toContain('## Styles');
    });

    test('every class gets a sheet', () => {
        for (const c of getClasses()) expect(classSheet(c)).toStartWith(`# ${c.name}`);
    });
});
