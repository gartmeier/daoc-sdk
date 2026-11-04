import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changes, classPlans, parseOptions } from './capture-trainer-windows';

describe('classPlans', () => {
    const plans = classPlans();

    test('one character per creatable class, with names and accounts of its own', () => {
        expect(plans.length).toBe(54);
        for (const field of ['classKey', 'account', 'charName'] as const) expect(new Set(plans.map(p => p[field])).size).toBe(54);
    });

    test('the server would take the names (CharacterCreateRequestHandler.cs:42)', () => {
        for (const p of plans) expect(p.charName).toMatch(/^[A-Z][a-zA-Z]{2,}$/);
    });

    test('no name holds a segment of the invalid name list', () => {
        const file = join(import.meta.dir, '..', 'server', 'core', 'GameServer', 'config', 'invalidnames.txt');
        if (!existsSync(file)) return;
        const segments = readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#'));
        for (const p of plans) {
            const name = p.charName.toLowerCase();
            const hits = segments.filter(s => (s.startsWith('/') ? new RegExp(s.slice(1, -1)).test(name) : name.includes(s)));
            expect(hits).toEqual([]);
        }
    });
});

describe('parseOptions', () => {
    test('a stack of its own by default, nothing kept', () => {
        expect(parseOptions([], 'here-capture')).toEqual({ name: 'here-capture', keep: false });
    });

    test('another stack, and --keep', () => {
        expect(parseOptions(['--name=x', '--keep'], 'here-capture')).toEqual({ name: 'x', keep: true });
    });

    test('an unknown option says what is known', () => {
        expect(() => parseOptions(['--fast'])).toThrow('--keep');
    });
});

describe('changes', () => {
    const line = (skill: string) => [{ name: 'Fire', autotrain: false, skills: [skill] }];
    const fixture = { level: 50, serverCore: 'aaaaaaaaaa', serverDb: 'bbbbbbbbbb', classes: { Wizard: line('spell|1|Blast|2'), Cleric: line('spell|1|Heal|3') } };

    test('nothing when nothing differs', () => {
        expect(changes(fixture, fixture)).toEqual([]);
    });

    test('names the moved pins and the classes that differ, one that went away too', () => {
        expect(changes(fixture, { ...fixture, serverCore: 'cccccccccc', classes: { Wizard: line('spell|2|Blast|2') } })).toEqual([
            'server/core aaaaaaa -> ccccccc',
            'windows differ for Cleric, Wizard',
        ]);
    });

    test('a first capture', () => {
        expect(changes(null, fixture)).toEqual(['no fixture before this']);
    });
});
