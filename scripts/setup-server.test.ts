import { describe, expect, test } from 'bun:test';
import {
    botProperties, checksum, cryptKeyRequest, literalType, loadPropertyDefs, normaliseValue, parseArgs, parseServerProperties, sqlString,
} from './setup-server';

describe('server property metadata', () => {
    test('parses [ServerProperty] attributes', () => {
        const src = `
        [ServerProperty("rates", "xp_rate", "The \\"XP\\" rate", 1.0)]
        public static double XP_RATE;
        [ServerProperty("server", "player idle kick", "Enable auto kick", false)]
        public static bool KICK_IDLE_PLAYER_STATUS;
        [ServerProperty("server", "motd", "Message", "Welcome, (friend)")]
        public static string MOTD;`;
        const defs = parseServerProperties(src);
        expect(defs.map(d => [d.key, d.type, d.defaultValue])).toEqual([
            ['xp_rate', 'double', '1'], ['player idle kick', 'bool', 'False'], ['motd', 'string', 'Welcome, (friend)'],
        ]);
        expect(defs[0]!.description).toBe('The "XP" rate');
    });

    test('every bot property exists in the C# source with a compatible type', () => {
        const defs = loadPropertyDefs();
        expect(defs.size).toBeGreaterThan(440);
        for (const p of botProperties(3)) {
            const def = defs.get(p.key);
            expect(def, p.key).toBeDefined();
            expect(normaliseValue(def!, p.value)).toBe(p.value);
        }
        expect(defs.get('time_between_account_creation_sameip')).toMatchObject({ type: 'int', defaultValue: '15' });
        expect(defs.get('allow_all_realms')).toMatchObject({ type: 'bool', defaultValue: 'False' });
        expect(defs.get('start_as_base_class')?.file).toContain('StartAsBaseClass.cs');
    });

    test('values are checked against the default literal type that ServerProperties.Load converts to', () => {
        expect(literalType('1.0', 'double')).toBe('double');
        expect(literalType('0', 'double')).toBe('int');
        expect(literalType('(ushort)30000', 'ushort')).toBe('ushort');
        expect(literalType('(uint) 5', 'uint')).toBe('uint');
        expect(literalType('100L * 100L * 100L', 'long')).toBe('long');
        expect(literalType('(long)(1.5 * 100 * 100 * 100)', 'long')).toBe('long');
        expect(literalType('1.0f', 'float')).toBe('float');
        expect(literalType('"x"', 'string')).toBe('string');
        expect(literalType('false', 'bool')).toBe('bool');
        const defs = loadPropertyDefs();
        // `public static double LORD_AUTOSET_CON_MULTIPLIER` with default `0`: Convert.ChangeType("1.5", int) throws.
        const lord = defs.get('lord_autoset_con_multiplier')!;
        expect(lord).toMatchObject({ type: 'double', loadType: 'int' });
        expect(() => normaliseValue(lord, '1.5')).toThrow();
        expect(normaliseValue(lord, '2')).toBe('2');
        expect(defs.get('xp_rate')).toMatchObject({ type: 'double', loadType: 'double' });
        expect(() => normaliseValue({ key: 'b', type: 'byte' }, '256')).toThrow();
        expect(() => normaliseValue({ key: 'i', type: 'int' }, '3000000000')).toThrow();
        for (const d of defs.values()) expect(normaliseValue(d, d.defaultValue), d.key).toBe(d.type === 'string' ? d.defaultValue : d.defaultValue.trim());
    });

    test('normaliseValue', () => {
        expect(normaliseValue({ key: 'b', type: 'bool' }, 'true')).toBe('True');
        expect(normaliseValue({ key: 'b', type: 'bool' }, '0')).toBe('False');
        expect(normaliseValue({ key: 'd', type: 'double' }, '2.50')).toBe('2.5');
        expect(() => normaliseValue({ key: 'i', type: 'int' }, '1.5')).toThrow();
        expect(() => normaliseValue({ key: 'b', type: 'bool' }, 'maybe')).toThrow();
    });
});

describe('handshake probe', () => {
    test('0xF4 frame matches the golden bytes in docs/research/critic.md', () => {
        const hex = [...cryptKeyRequest()].map(b => b.toString(16).padStart(2, '0')).join(' ');
        expect(hex).toBe('00 07 00 00 00 00 00 00 00 f4 06 01 01 1b 61 00 00 53 b0');
        const fc = new Uint8Array([0x00, 0x01, 0x00, 0x02, 0, 0, 0, 0, 0x00, 0xfc, 0x01]);
        expect(checksum(fc, 0, fc.length)).toBe(0x87fb);
    });
});

describe('cli', () => {
    test('parseArgs', () => {
        const o = parseArgs(['--dry-run', '--xp=5', '--set', 'starting_money=100', '--gm=admin1', '--ungm', 'bot2', '--no-restart']);
        expect(o).toMatchObject({ dryRun: true, xp: 5, restart: 'never' });
        expect(o.sets).toEqual([{ key: 'starting_money', value: '100' }]);
        expect(o.privLevels).toEqual([{ account: 'admin1', level: 3 }, { account: 'bot2', level: 1 }]);
        expect(() => parseArgs(['--gm=bad;name'])).toThrow();
        expect(sqlString(String.raw`a'b\c`)).toBe(String.raw`'a\'b\\c'`);
    });
});
