import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, GENERATED_FILES, writeGenerated, type GeneratedFile } from './build';
import { loadGenerated } from './index';

const fsError = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });

// Each test gets a generated file of its own: loadGenerated caches by name, and live
// processes may be reading the real ones.
let nextId = 0;
let file: string;
let target: string;
let entry: GeneratedFile;
let builds: number;
let sleeps: ReturnType<typeof spyOn<typeof Bun, 'sleepSync'>>;
let warns: ReturnType<typeof spyOn<typeof console, 'warn'>>;
const restores: (() => void)[] = [];

function stub<K extends 'renameSync' | 'rmSync' | 'writeFileSync'>(name: K) {
    const spy = spyOn(fs, name);
    restores.push(() => spy.mockRestore());
    return spy;
}

const temps = () => fs.readdirSync(GENERATED_DIR).filter(n => n.startsWith(`.${file}.`));

beforeEach(() => {
    file = `write-test-${process.pid}-${++nextId}.json`;
    target = join(GENERATED_DIR, file);
    builds = 0;
    entry = { file, tables: [], build: () => ({ builds: ++builds }), count: () => 1 };
    GENERATED_FILES.push(entry);
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    sleeps = spyOn(Bun, 'sleepSync').mockImplementation(() => {});
    warns = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    sleeps.mockRestore();
    warns.mockRestore();
    GENERATED_FILES.splice(GENERATED_FILES.indexOf(entry), 1);
    fs.rmSync(target, { recursive: true, force: true });
    for (const t of temps()) fs.rmSync(join(GENERATED_DIR, t), { force: true });
});

describe('loading when the generated file cannot be replaced', () => {
    test('returns the built data, caches it, warns and leaves no temp file', () => {
        // A real failure on every platform: a rename can't replace a non-empty directory.
        fs.mkdirSync(join(target, 'occupied'), { recursive: true });

        const first = loadGenerated<{ builds: number }>(file);

        expect(first).toEqual({ builds: 1 });
        expect(loadGenerated(file)).toBe(first);
        expect(builds).toBe(1);
        expect(temps()).toEqual([]);
        expect(warns).toHaveBeenCalledTimes(1);
        expect(warns.mock.calls[0]![0]).toContain(file);
    });

    test('returns the built data when the temp file cannot be written either', () => {
        stub('writeFileSync').mockImplementation(() => { throw fsError('ENOSPC'); });

        expect(loadGenerated(file)).toEqual({ builds: 1 });
        expect(warns.mock.calls[0]![0]).toContain('ENOSPC');
    });
});

describe('writeGenerated', () => {
    test.each(['EPERM', 'EBUSY'])('retries %s until the holder is gone', code => {
        stub('renameSync')
            .mockImplementationOnce(() => { throw fsError(code); })
            .mockImplementationOnce(() => { throw fsError(code); });

        writeGenerated(file, { v: 1 });

        expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ v: 1 });
        expect(fs.renameSync).toHaveBeenCalledTimes(3);
        expect(sleeps).toHaveBeenCalledTimes(2);
        expect(temps()).toEqual([]);
    });

    test('throws once the retries run out, so data:build fails loudly, and removes the temp file', () => {
        stub('renameSync').mockImplementation(() => { throw fsError('EPERM'); });

        expect(() => writeGenerated(file, { v: 1 })).toThrow('EPERM');

        expect(fs.existsSync(target)).toBe(false);
        expect(temps()).toEqual([]);
        // The load blocks the event loop, and a client goes link-dead after ~5 s without updates.
        const waited = sleeps.mock.calls.reduce((sum, [ms]) => sum + Number(ms), 0);
        expect(waited).toBeGreaterThan(0);
        expect(waited).toBeLessThan(500);
    });

    test('does not retry other errors', () => {
        stub('renameSync').mockImplementation(() => { throw fsError('EXDEV'); });

        expect(() => writeGenerated(file, { v: 1 })).toThrow('EXDEV');

        expect(fs.renameSync).toHaveBeenCalledTimes(1);
        expect(sleeps).not.toHaveBeenCalled();
        expect(temps()).toEqual([]);
    });

    test('a temp file that cannot be removed does not hide the rename error', () => {
        stub('renameSync').mockImplementation(() => { throw fsError('EXDEV'); });
        stub('rmSync').mockImplementationOnce(() => { throw fsError('EPERM'); });

        expect(() => writeGenerated(file, { v: 1 })).toThrow('EXDEV');
    });
});
