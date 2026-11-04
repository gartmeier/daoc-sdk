import { describe, expect, test } from 'bun:test';
import { assembleWindow, compactWindow, decodeWindowPacket, formatFixture } from './trainer-window-decode';

/** Literal bytes: a pascal string as PacketOut.WritePascalString writes it. */
const ps = (s: string): number[] => [s.length, ...[...s].map(c => c.charCodeAt(0))];
const buf = (...parts: Array<number | number[]>): Uint8Array => Uint8Array.from(parts.flat());

const FF49 = new Array<number>(49).fill(0xFF);

describe('decodeWindowPacket, hand-built buffers', () => {
    test('code 0: spec list', () => {
        const p = buf(2, 7, 0, 0, 0, 1, 2, ps('Slash'), 1, 12, 13, ps('Light Magic'));
        expect(decodeWindowPacket(p)).toEqual({
            code: 0, count: 2, specPoints: 7,
            specs: [{ index: 0, level: 1, nextLevel: 2, name: 'Slash' }, { index: 1, level: 12, nextLevel: 13, name: 'Light Magic' }],
        });
    });

    test('code 4: names with a start index, including an empty spec', () => {
        expect(decodeWindowPacket(buf(2, 7, 4, 0, 5, ps('Blast'), ps('Evade I Ability')))).toEqual({
            code: 4, count: 2, specPoints: 7, startIndex: 5, names: ['Blast', 'Evade I Ability'],
        });
        expect(decodeWindowPacket(buf(0, 7, 4, 0, 7))).toEqual({ code: 4, count: 0, specPoints: 7, startIndex: 7, names: [] });
    });

    test('code 3: one record of each kind, in the writer byte order', () => {
        const p = buf(
            2, 7, 3, 0, 0, FF49,
            0, 3, 2, // spec 0: 3 records, autotrain 2
            8, 0x01, 0x02, 5, 0, 0xFD, 0x03, 0x04, // ability
            10, 0x05, 0x06, 3, 0, 0xFE, 0x07, 0x08, // spell
            12, 0x09, 0x0A, 4, 0, 0xFF, 0x0B, 0x0C, // song
            1, 1, 0, // spec 1: 1 record
            15, 0x0D, 0x0E, 2, 2, 1, 0x0F, 0x10, // positional style, side
        );
        const d = decodeWindowPacket(p);
        expect(d).toMatchObject({ code: 3, count: 2, specPoints: 7, reserved: 0, minLevelTable: FF49, missingBlocks: 0 });
        if (!('blocks' in d)) throw new Error('not code 3');
        expect(d.blocks.map(b => [b.specIndex, b.declaredCount, b.autotrain, b.missing])).toEqual([[0, 3, 2, 0], [1, 1, 0, 0]]);
        expect(d.blocks[0]!.skills).toEqual([
            { kind: 'ability', specLevel: 8, icon: 0x0102, page: 5, raw: [0, 0xFD], id: 0x0304 },
            { kind: 'spell', specLevel: 10, icon: 0x0506, page: 3, raw: [0, 0xFE], id: 0x0708 },
            { kind: 'song', specLevel: 12, icon: 0x090A, page: 4, raw: [0, 0xFF], id: 0x0B0C },
        ]);
        expect(d.blocks[1]!.skills).toEqual([
            { kind: 'style', specLevel: 15, icon: 0x0D0E, page: 2, raw: [2, 1], id: 0x0F10, opening: 'positional', openingValue: 1, position: 'side' },
        ]);
    });

    test('code 3: an offensive opener keeps only the low byte of the opener id', () => {
        const d = decodeWindowPacket(buf(1, 0, 3, 0, 0, FF49, 0, 1, 0, 4, 0, 1, 2, 0, 0x2C, 0, 9));
        if (!('blocks' in d)) throw new Error('not code 3');
        expect(d.blocks[0]!.skills[0]).toMatchObject({ kind: 'style', opening: 'offensive', openingValue: 0x2C, position: null, id: 9 });
    });

    test('realm abilities and an unknown code keep their bytes; a short packet throws', () => {
        expect(decodeWindowPacket(buf(1, 2, 9, 0, 0xAA))).toEqual({ code: 9, count: 1, points: 2, raw: Uint8Array.of(0xAA) });
        expect(decodeWindowPacket(buf(1, 2, 1, 0, 0xAA))).toEqual({ code: 1, count: 1, points: 2, raw: Uint8Array.of(0xAA) });
        expect(decodeWindowPacket(buf(1, 2, 5, 0, 0xAA))).toEqual({ code: 5, count: 1, points: 2, raw: Uint8Array.of(0xAA) });
        expect(() => decodeWindowPacket(buf(1, 7, 0, 0, 0, 1))).toThrow(RangeError);
    });

    test('names are Windows-1252', () => {
        const d = decodeWindowPacket(buf(1, 0, 4, 0, 0, 2, 0x80, 0xE9));
        expect(d).toMatchObject({ names: ['€é'] });
    });
});

/** The writer's loop, PacketLib1105.cs:144-247, with pak.Length counted exactly: 3 header bytes first. */
function writeCode3(specCounts: number[]): Uint8Array {
    const out: number[] = [0, 0, 0x7B]; // GSTCPPacketOut.Init
    out.push(specCounts.length, 0, 3, 0, 0, ...FF49);
    specCounts.forEach((n, s) => {
        if (out.length >= 2045) return;
        out.push(s, n, 0);
        for (let i = 0; i < n; i++) {
            if (out.length >= 2040) break;
            out.push(1, 0, 0, 3, 0, 0xFE, s, i);
        }
    });
    return Uint8Array.from(out.slice(3));
}

describe('code 3 size limits', () => {
    test('fits exactly: nothing is reported cut', () => {
        const d = decodeWindowPacket(writeCode3([50, 50, 50]));
        if (!('blocks' in d)) throw new Error('not code 3');
        expect(d.blocks.map(b => b.missing)).toEqual([0, 0, 0]);
        expect(d.missingBlocks).toBe(0);
    });

    test('one huge spec is cut at the 2040 limit and the following blocks stay aligned', () => {
        // 3 + 54 + 3 = 60 before the first record; (2040 - 60) / 8 = 247.5, so 248 records end at 2044.
        const d = decodeWindowPacket(writeCode3([250, 4, 4, 4]));
        if (!('blocks' in d)) throw new Error('not code 3');
        expect(d.blocks[0]).toMatchObject({ specIndex: 0, declaredCount: 250, missing: 2 });
        expect(d.blocks[0]!.skills.length).toBe(248);
        // Length 2044 < 2045: the writer still emits the next header, then no record (2047 >= 2040) and stops at the third.
        expect(d.blocks.length).toBe(2);
        expect(d.blocks[1]).toMatchObject({ specIndex: 1, declaredCount: 4, missing: 4, skills: [] });
        expect(d.missingBlocks).toBe(2);
    });

    test('a cut that lands on 2045 or more writes no further header', () => {
        // Spec 0 with 0 records and spec 1 with 248 records: 3 + 54 + 3 + 3 = 63, then records until >= 2040: 63 + 248*8 = 2047.
        const d = decodeWindowPacket(writeCode3([0, 250, 4]));
        if (!('blocks' in d)) throw new Error('not code 3');
        expect(d.blocks.map(b => [b.specIndex, b.skills.length, b.missing])).toEqual([[0, 0, 0], [1, 248, 2]]);
        expect(d.missingBlocks).toBe(1);
    });

    test('every split of two specs round-trips with the record ids intact', () => {
        for (let a = 0; a <= 255; a += 5) {
            const b = 255 - a;
            const bytes = writeCode3([a, b]);
            const d = decodeWindowPacket(bytes);
            if (!('blocks' in d)) throw new Error('not code 3');
            for (const block of d.blocks) {
                block.skills.forEach((sk, i) => expect(sk.id).toBe((block.specIndex << 8) | i));
                expect(block.skills.length + block.missing).toBe(block.specIndex === 0 ? a : b);
            }
            const expectedLength = bytes.length;
            const consumed = 54 + d.blocks.reduce((n, bl) => n + 3 + bl.skills.length * 8, 0);
            expect(consumed).toBe(expectedLength);
        }
    });
});

describe('assembleWindow', () => {
    const packets = () => [
        buf(2, 7, 0, 0, 0, 1, 2, ps('Slash'), 1, 1, 2, ps('Light Magic')),
        buf(1, 0, 1, 0, 0, 0, 1, ps('Toughness')),
        buf(1, 7, 4, 0, 0, ps('Pierce')),
        buf(2, 7, 4, 0, 1, ps('Blast'), ps('Evade I Ability')),
        buf(2, 7, 3, 0, 0, FF49, 0, 1, 0, 3, 0, 1, 2, 0, 0, 0, 11, 1, 2, 12, 6, 0, 2, 3, 0, 0xFE, 0, 22, 8, 0, 3, 5, 0, 0xFD, 0, 33),
        buf(1, 0, 5, 0, 0, 0, 1, 1, ps('Toughness')),
    ].map(decodeWindowPacket);

    test('links names and records by spec and position, and keeps the name of a cut record', () => {
        const decoded = packets();
        const specs = assembleWindow(decoded);
        expect(specs.map(s => s.name)).toEqual(['Slash', 'Light Magic']);
        expect(specs[0]!.skills).toMatchObject([{ name: 'Pierce', nameIndex: 0, record: { kind: 'style', id: 11, specLevel: 3 } }]);
        expect(specs[1]!.skills).toMatchObject([
            { name: 'Blast', nameIndex: 1, record: { kind: 'spell', id: 22, specLevel: 6 } },
            { name: 'Evade I Ability', nameIndex: 2, record: { kind: 'ability', id: 33, specLevel: 8 } },
        ]);

        const code3 = decoded[4]!;
        if (!('blocks' in code3)) throw new Error('not code 3');
        code3.blocks[1]!.skills.pop();
        expect(assembleWindow(decoded)[1]!.skills[1]).toEqual({ name: 'Evade I Ability', nameIndex: 2, record: null });
    });

    test('compactWindow: wire order, and the autotrain byte as a flag', () => {
        expect(compactWindow(assembleWindow(packets()))).toEqual([
            { name: 'Slash', autotrain: false, skills: ['style|3|Pierce|11'] },
            { name: 'Light Magic', autotrain: true, skills: ['spell|6|Blast|22', 'ability|8|Evade I Ability|33'] },
        ]);
    });

    test('compactWindow: a song keeps its kind', () => {
        const song = decodeWindowPacket(buf(1, 0, 3, 0, 0, FF49, 0, 1, 0, 6, 0, 0, 4, 0, 0xFF, 0x13, 0x6B));
        const names = decodeWindowPacket(buf(1, 0, 4, 0, 0, ps('Chant of Healing')));
        const specs = decodeWindowPacket(buf(1, 0, 0, 0, 0, 1, 2, ps('Regrowth')));
        expect(compactWindow(assembleWindow([specs, names, song]))[0]!.skills).toEqual(['song|6|Chant of Healing|4971']);
    });

    test('compactWindow refuses a window with a cut record', () => {
        const decoded = packets();
        const code3 = decoded[4]!;
        if (!('blocks' in code3)) throw new Error('not code 3');
        code3.blocks[1]!.skills.pop();
        expect(() => compactWindow(assembleWindow(decoded))).toThrow('Light Magic / Evade I Ability');
    });
});

describe('formatFixture', () => {
    const fixture = {
        level: 50, serverCore: 'abc', serverDb: 'def',
        classes: { Wizard: [{ name: 'Fire', autotrain: false, skills: ['spell|1|Blast|2'] }], Armsman: [] },
    };

    test('sorts the classes, whatever order they were captured in', () => {
        const text = formatFixture(fixture);
        expect(Object.keys(JSON.parse(text).classes)).toEqual(['Armsman', 'Wizard']);
        expect(formatFixture({ ...fixture, classes: { Armsman: [], Wizard: fixture.classes.Wizard } })).toBe(text);
        expect(JSON.parse(text)).toEqual(fixture);
    });

    test('one skill per text line, ending in a newline', () => {
        const text = formatFixture(fixture);
        expect(text.split('\n').filter(l => l.includes('spell|1|Blast|2'))).toEqual(['     "spell|1|Blast|2"']);
        expect(text.endsWith('\n')).toBe(true);
    });
});
