import { describe, expect, test } from 'bun:test';
import { parseArgs } from './build-navmesh';

describe('navmesh:build args', () => {
    test('defaults to the three home regions, the OpenDAoC client dir and 8 jobs', () => {
        expect(parseArgs([], {})).toEqual({ daoc: 'C:\\Program Files (x86)\\OpenDAoC', regions: [1, 100, 200], zones: [], all: false, skipExisting: false, jobs: 8 });
    });

    test('explicit zones replace the default regions; DAOC_DIR and flags apply', () => {
        expect(parseArgs(['--zones=0, 27', '--skip-existing', '--jobs=2'], { DAOC_DIR: 'D:\\DAoC' }))
            .toEqual({ daoc: 'D:\\DAoC', regions: [], zones: [0, 27], all: false, skipExisting: true, jobs: 2 });
        expect(parseArgs(['--all', '--daoc=E:\\x'], { DAOC_DIR: 'D:\\DAoC' })).toMatchObject({ daoc: 'E:\\x', regions: [], all: true });
    });

    test('rejects non-numeric ids', () => {
        expect(() => parseArgs(['--regions=1,abc'], {})).toThrow('bad id');
    });
});
