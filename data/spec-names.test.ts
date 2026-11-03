import { describe, expect, test } from 'bun:test';
import { getClasses, getSpecialization, getSpecializations, getStylesFor, specDisplayName, specKey } from './index';

describe('spec names', () => {
    test.each([
        ['Shields', 'Shields', 'Shield'],
        ['Shield', 'Shields', 'Shield'],
        ['shield', 'Shields', 'Shield'],
        ['shields', 'Shields', 'Shield'],
        ['Light', 'Light', 'Light Magic'],
        ['Light Magic', 'Light', 'Light Magic'],
        ['Mana', 'Mana', 'Mana Magic'],
        ['Mana Magic', 'Mana', 'Mana Magic'],
        ['Void', 'Void', 'Void Magic'],
        ['void magic', 'Void', 'Void Magic'],
        // What an item's bonus calls the line.
        ['Cave Magic', 'Subterranean', 'Subterranean'],
        ['Smiting', 'Smite', 'Smite'],
        ['Throwing', 'Thrown Weapons', 'Thrown Weapons'],
        ['Recurved Bow', 'Recurve Bow', 'Recurve Bow'],
        ['Enchantment', 'Enchantments', 'Enchantments'],
        ['Crossbow', 'Crossbows', 'Crossbows'],
        ['Longbow', 'Longbows', 'Longbows'],
        ['Arboreal', 'Arboreal Path', 'Arboreal Path'],
        ['Verdant', 'Verdant Path', 'Verdant Path'],
        // One name for both, or not a line at all: as given.
        ['Slash', 'Slash', 'Slash'],
        ['Runecarving', 'Runecarving', 'Runecarving'],
        ['Runes of Darkness', 'Runes of Darkness', 'Runes of Darkness'],
        ['constructor', 'constructor', 'constructor'],
        ['__proto__', '__proto__', '__proto__'],
    ])('%s is the key %s, shown as %s', (name, key, display) => {
        expect(specKey(name)).toBe(key);
        expect(specDisplayName(name)).toBe(display);
    });

    // The table is by hand so that the SDK can read it without the generated data. Here the DB checks it.
    test('every line a class trains agrees with the DB, both ways', () => {
        const trained = new Set(getClasses().flatMap(c => c.specializations.map(s => s.spec)));
        const lines = getSpecializations().filter(s => trained.has(s.keyName) && !s.implementation.includes('Career'));
        expect(lines.length).toBeGreaterThan(50);
        expect(lines.filter(s => s.keyName !== s.name).map(s => s.keyName).sort()).toEqual(['Light', 'Mana', 'Shields', 'Void']);
        for (const s of lines) {
            expect([s.keyName, specDisplayName(s.keyName)]).toEqual([s.keyName, s.name]);
            expect([s.name, specKey(s.name)]).toEqual([s.name, s.keyName]);
        }
    });

    test('the static lookups take any name of the line', () => {
        expect(getSpecialization('Shield')?.keyName).toBe('Shields');
        expect(getSpecialization('Shields')?.name).toBe('Shield');
        expect(getSpecialization('Cave Magic')?.keyName).toBe('Subterranean');
        const paladin = getStylesFor(1, 'Shields');
        expect(paladin.length).toBeGreaterThan(0);
        expect(getStylesFor(1, 'Shield')).toEqual(paladin);
    });
});
