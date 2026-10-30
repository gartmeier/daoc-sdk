import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTerrainArgs, parseZoneGeometry, readPcx, zoneTerrain } from './build-terrain';

/** An 8-bit, 1-plane PCX of `w` x `h` with the given RLE-encoded scanlines. */
function pcx(w: number, h: number, body: number[]): Buffer {
    const header = Buffer.alloc(128);
    header[0] = 0x0a;
    header.writeUInt16LE(w - 1, 8);
    header.writeUInt16LE(h - 1, 10);
    header[65] = 1;
    header.writeUInt16LE(w, 66);
    return Buffer.concat([header, Buffer.from(body)]);
}

describe('build-terrain', () => {
    test('parseZoneGeometry places enabled zones in region units of 8192', () => {
        const text = ['[region010]', 'frontiers=1', '[zone000]', 'enabled=1', 'region=1', 'region_offset_x=67', 'region_offset_y=59', 'width=8', 'height=8', 'type=0',
            '[zone026]', 'enabled=1', 'region=10', 'region_offset_x=4', 'region_offset_y=4', 'width=4', 'height=4', 'type=1',
            '[zone031]', 'enabled=0', 'region=2'].join('\r\n');
        expect(parseZoneGeometry(text)).toEqual([
            { id: 0, regionId: 1, type: 0, xoff: 67 * 8192, yoff: 59 * 8192, width: 65536, height: 65536, addon: '' },
            { id: 26, regionId: 10, type: 1, xoff: 4 * 8192, yoff: 4 * 8192, width: 32768, height: 32768, addon: 'frontiers' },
        ]);
    });

    test('readPcx decodes RLE runs and literal bytes per scanline', () => {
        // Row 0: run of 3 x 7, literal 9. Row 1: literal 1, 2, run of 2 x 0xC5 (needs the run form).
        const img = readPcx(pcx(4, 2, [0xc3, 7, 9, 1, 2, 0xc2, 0xc5]));
        expect(img).toEqual({ w: 4, h: 2, px: Uint8Array.of(7, 7, 7, 9, 1, 2, 0xc5, 0xc5) });
        expect(() => readPcx(Buffer.alloc(10))).toThrow('not a PCX');
    });

    test('parseTerrainArgs', () => {
        expect(parseTerrainArgs([], {})).toEqual({ daoc: 'C:\\Program Files (x86)\\OpenDAoC', zones: null });
        expect(parseTerrainArgs(['--zones=0, 7', '--daoc=D:\\DAoC'], { DAOC_DIR: 'E:\\x' })).toEqual({ daoc: 'D:\\DAoC', zones: [0, 7] });
        expect(() => parseTerrainArgs(['--zones=a'], {})).toThrow('zone ids');
        expect(() => parseTerrainArgs(['--all'], {})).toThrow('unknown argument');
    });

    const daoc = process.env.DAOC_DIR || 'C:\\Program Files (x86)\\OpenDAoC';
    test.skipIf(!existsSync(join(daoc, 'zones', 'zone000', 'dat000.mpk')))('zoneTerrain reads Camelot Hills from the client', () => {
        const g = zoneTerrain(daoc, { id: 0, regionId: 1, type: 0, xoff: 67 * 8192, yoff: 59 * 8192, width: 65536, height: 65536, addon: '' })!;
        expect(g.size).toBe(256);
        expect(g.heights.length).toBe(256 * 256);
        expect(Math.max(...g.heights)).toBeGreaterThan(0);
        expect(zoneTerrain(daoc, { id: 26, regionId: 10, type: 1, xoff: 0, yoff: 0, width: 32768, height: 32768, addon: '' })).toBeNull();
    });
});
