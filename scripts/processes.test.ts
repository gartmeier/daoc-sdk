import { describe, expect, test } from 'bun:test';
import { guardians, orphans, type Proc } from './processes';

const P = (pid: number, ppid: number, name: string, created = 1000): Proc => ({ pid, ppid, name, created });
const HOUR = 3_600_000;

describe('guardians', () => {
    test('a watcher in a Monitor: the inner and outer bash, and the Claude process above them', () => {
        const list = [P(1, 0, 'claude.exe', 0), P(10, 1, 'bash.exe'), P(11, 10, 'bash.exe'), P(12, 11, 'bun.exe'), P(13, 12, 'bun.exe')];
        expect(guardians(list, 13).map(p => p.pid)).toEqual([12, 11, 10, 1]);
    });
    test('started straight from a program: that program alone', () => {
        expect(guardians([P(1, 0, 'claude.exe', 0), P(5, 1, 'bun.exe')], 5).map(p => p.pid)).toEqual([1]);
    });
    test('the chain stops at a dead shell or a reused id', () => {
        expect(guardians([P(11, 10, 'bash.exe'), P(12, 11, 'bun.exe')], 12).map(p => p.pid)).toEqual([11]);
        expect(guardians([P(10, 9, 'bash.exe', 50_000), P(11, 10, 'bash.exe'), P(12, 11, 'bun.exe')], 12).map(p => p.pid)).toEqual([11]);
    });
});

describe('orphans', () => {
    const now = 10 * HOUR;
    test('a grep whose shell is gone, past the age limit; never a bun, a shell or a game client', () => {
        const list = [
            P(1, 0, 'claude.exe', 0),
            P(20, 99, 'tail.exe', now - 2 * HOUR),       // shell gone
            P(21, 99, 'grep.exe', now - 2 * HOUR),
            P(22, 99, 'grep.exe', now - 60_000),          // too young
            P(23, 1, 'grep.exe', now - 2 * HOUR),         // parent alive
            P(24, 99, 'bun.exe', now - 2 * HOUR),         // a bun is never ours to end
            P(25, 99, 'bash.exe', now - 2 * HOUR),
        ];
        expect(orphans(list, now, 1_800_000).map(p => p.pid)).toEqual([20, 21]);
    });
    test('a parent id now held by a newer process counts as gone', () => {
        const list = [P(30, 0, 'explorer.exe', now - 1000), P(31, 30, 'awk.exe', now - 2 * HOUR)];
        expect(orphans(list, now, 1_800_000).map(p => p.pid)).toEqual([31]);
    });
});
