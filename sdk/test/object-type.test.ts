import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isArmor, isWeapon, ObjectType } from '../types';

const SOURCE = join(import.meta.dir, '..', '..', 'server', 'core', 'GameServer', 'Enums', 'eObjectType.cs');

/** The enum's `Name = 12,` lines; the `_First`/`_Last` markers repeat a real value and stay out of ObjectType. */
function serverEnum(): Record<string, number> {
    const source = readFileSync(SOURCE, 'utf8');
    return Object.fromEntries([...source.matchAll(/^\s*(\w+)\s*=\s*(\d+),/gm)].map(m => [m[1]!, Number(m[2])]));
}

describe('ObjectType', () => {
    test('is eObjectType.cs, value for value', () => {
        const server = serverEnum();
        const named = Object.fromEntries(Object.entries(server).filter(([name]) => !name.startsWith('_')));
        expect({ ...ObjectType }).toEqual(named as never);
    });

    test('isWeapon and isArmor use the same ranges as the server', () => {
        const server = serverEnum();
        const values = Object.values(ObjectType);
        expect(values.filter(isWeapon)).toEqual(values.filter(v => v >= server._FirstWeapon! && v <= server._LastWeapon!));
        expect(values.filter(isArmor)).toEqual(values.filter(v => v >= server._FirstArmor! && v <= server._LastArmor!));
        expect(isWeapon(ObjectType.Blades)).toBe(true);
        expect(isWeapon(ObjectType.Shield)).toBe(false);
        expect(isArmor(ObjectType.Plate)).toBe(true);
        expect(isArmor(ObjectType.Magical)).toBe(false);
    });
});
