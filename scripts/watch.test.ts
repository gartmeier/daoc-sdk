import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, takeLines, watch, type WatchOptions } from './watch';

const opts = (o: Partial<WatchOptions>): WatchOptions => ({ patterns: [], match: null, skip: null, until: null, timeoutMs: 5000, fromStart: false, everyMs: 100, ...o });

describe('takeLines', () => {
    test('whole lines only; the unfinished one waits for the next read', () => {
        expect(takeLines('a\nb\npart', opts({}))).toEqual({ print: ['a', 'b'], done: false, rest: 'part' });
    });
    test('match and skip; CRLF lines lose their CR', () => {
        expect(takeLines('raid close\r\nraid stage\r\nhelp\r\n', opts({ match: /raid/, skip: /stage/ })).print).toEqual(['raid close']);
    });
    test('until ends at its line, printed even when match would leave it out', () => {
        expect(takeLines('x\ncaptured\ny\n', opts({ match: /x|y/, until: /captured/ }))).toEqual({ print: ['x', 'captured'], done: true, rest: '' });
    });
});

describe('parseArgs', () => {
    test('defaults: an hour, from the end, every second', () => {
        const o = parseArgs(['a.log']);
        expect(o).toMatchObject({ patterns: ['a.log'], timeoutMs: 3_600_000, fromStart: false, everyMs: 1000, match: null });
    });
    test('the timeout is capped at a day; nonsense is refused', () => {
        expect(parseArgs(['a', '--timeout=999999']).timeoutMs).toBe(86_400_000);
        expect(() => parseArgs(['a', '--timeout=0'])).toThrow();
        expect(() => parseArgs([])).toThrow();
        expect(() => parseArgs(['a', '--from=middle'])).toThrow();
    });
});

describe('watch', () => {
    const dir = () => mkdtempSync(join(tmpdir(), 'watch-'));

    test('reads only what is written after the start, and ends on until', async () => {
        const d = dir();
        const f = join(d, 'a.log');
        writeFileSync(f, 'old raid line\n');
        const lines: string[] = [];
        const done = watch(opts({ patterns: [f], match: /raid/, until: /captured/ }), l => lines.push(l));
        await Bun.sleep(250);
        appendFileSync(f, 'raid stage\nnoise\n');
        await Bun.sleep(250);
        appendFileSync(f, 'Faste captured\nraid after\n');
        expect(await done).toBe('until');
        expect(lines).toEqual(['raid stage', 'Faste captured']);
    });

    test('a file that appears later under a glob is read from its start, named when there are several', async () => {
        const d = dir();
        writeFileSync(join(d, 'one.log'), '');
        const lines: string[] = [];
        const done = watch(opts({ patterns: [join(d, '*.log').replace(/\\/g, '/')], until: /end/ }), l => lines.push(l));
        await Bun.sleep(250);
        writeFileSync(join(d, 'two.log'), 'first\nend\n');
        expect(await done).toBe('until');
        expect(lines.map(l => l.replace(/\\/g, '/').replace(/^.*\//, ''))).toEqual(['two.log: first', 'two.log: end']);
    });

    test('a file that shrinks is read again from its start', async () => {
        const d = dir();
        const f = join(d, 'a.log');
        writeFileSync(f, 'a long first version of the file\n');
        const lines: string[] = [];
        const done = watch(opts({ patterns: [f], until: /end/ }), l => lines.push(l));
        await Bun.sleep(250);
        writeFileSync(f, 'new\nend\n');
        expect(await done).toBe('until');
        expect(lines).toEqual(['new', 'end']);
    });

    test('it ends on its own: at the timeout, and once it is no longer wanted', async () => {
        const d = dir();
        const f = join(d, 'a.log');
        writeFileSync(f, '');
        const lines: string[] = [];
        expect(await watch(opts({ patterns: [f], timeoutMs: 300 }), l => lines.push(l))).toBe('timeout');
        expect(lines).toEqual(['watch: timeout after 0 s']);
        expect(await watch(opts({ patterns: [f], timeoutMs: 10_000 }), () => {}, () => false)).toBe('parent');
    });
});
