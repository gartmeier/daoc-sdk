#!/usr/bin/env bun
// Follow log files and print the lines that match, as one process that always ends on its own: for a Monitor or a
// background shell, in place of `tail -F file | grep ... | awk ...`. On Windows (Git Bash) such a pipeline's processes
// outlive the shell that started them: 1,579 of them piled up over the 2026-11-13/14 stint, filled 71 of 74 GB and dropped
// the user's game client (memory note "monitor-pipelines-leak-on-windows").
//
//   bun scripts/watch.ts <file or glob>... [--match=<regex>] [--skip=<regex>] [--until=<regex>] [--timeout=<s>]
//                        [--from=end|start] [--every=<ms>]
//
// - Files: paths or globs relative to the working directory (`groups/*/runs/field-*.log`). A file that appears later
//   and matches a glob is read from its start; files there at the start are read from their end (`--from=start`: all).
//   A file that shrinks (rotated, rewritten) is read again from its start.
// - `--match`: print only the lines that match (all lines without it); `--skip`: never those. Regexes are JavaScript's.
// - `--until`: exit 0 after printing the first line that matches it (it is printed even without `--match`).
// - `--timeout`: seconds until it exits on its own (default 3600, at most 86400); it says so in its last line.
// - It also exits within 5 s once whoever started it is gone: any shell or wrapper between it and the first other process
//   above (a Claude session, a terminal), or that process itself (scripts/processes.ts guardians). Watching the parent alone
//   isn't enough: Git's bash.exe starts an inner bash, which lives on as an orphan when the outer one is killed.
// Each printed line is prefixed with its file's name when more than one file is followed.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { alive, guardians, listProcesses } from './processes';

export interface WatchOptions {
    patterns: string[];
    match: RegExp | null;
    skip: RegExp | null;
    until: RegExp | null;
    timeoutMs: number;
    fromStart: boolean;
    everyMs: number;
}

export function parseArgs(argv: string[]): WatchOptions {
    const flag = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const re = (name: string) => {
        const v = flag(name);
        return v === undefined || v === '' ? null : new RegExp(v);
    };
    const patterns = argv.filter(a => !a.startsWith('--'));
    if (patterns.length === 0) throw new Error('no file or glob to watch');
    const timeoutS = Number(flag('timeout') ?? 3600);
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error(`--timeout must be a number of seconds above 0, not ${flag('timeout')}`);
    const from = flag('from') ?? 'end';
    if (from !== 'end' && from !== 'start') throw new Error(`--from=end|start, not ${from}`);
    const everyMs = Number(flag('every') ?? 1000);
    if (!Number.isFinite(everyMs) || everyMs < 100) throw new Error(`--every must be at least 100 ms, not ${flag('every')}`);
    return {
        patterns,
        match: re('match'),
        skip: re('skip'),
        until: re('until'),
        timeoutMs: Math.min(timeoutS, 86_400) * 1000,
        fromStart: from === 'start',
        everyMs,
    };
}

/** What a chunk of new text gives: the lines to print, whether one of them ends the watch, and the unfinished tail. */
export function takeLines(text: string, o: Pick<WatchOptions, 'match' | 'skip' | 'until'>): { print: string[]; done: boolean; rest: string } {
    const parts = text.split('\n');
    const rest = parts.pop()!;
    const print: string[] = [];
    for (const raw of parts) {
        const line = raw.replace(/\r$/, '');
        if (o.skip?.test(line)) continue;
        const ends = !!o.until?.test(line);
        if (ends || !o.match || o.match.test(line)) print.push(line);
        if (ends) return { print, done: true, rest: '' };
    }
    return { print, done: false, rest };
}

interface Followed { offset: number; partial: string }

/** The files the patterns name now: plain paths that exist, and every match of a glob. */
export function filesFor(patterns: string[], cwd = process.cwd()): string[] {
    const out = new Set<string>();
    for (const p of patterns) {
        if (!/[*?[{]/.test(p)) {
            if (existsSync(p)) out.add(p);
            continue;
        }
        for (const f of new Bun.Glob(p).scanSync({ cwd, onlyFiles: true })) out.add(f);
    }
    return [...out].sort();
}

function readFrom(file: string, offset: number, size: number): string {
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(size - offset);
        const n = readSync(fd, buf, 0, buf.length, offset);
        return buf.subarray(0, n).toString('utf8');
    } finally {
        closeSync(fd);
    }
}

/** `wanted` is asked every 5 s; false ends the watch ('parent'). */
export async function watch(o: WatchOptions, out: (line: string) => void = console.log, wanted: () => boolean = () => true): Promise<'until' | 'timeout' | 'parent'> {
    const followed = new Map<string, Followed>();
    for (const f of filesFor(o.patterns)) followed.set(f, { offset: o.fromStart ? 0 : statSync(f).size, partial: '' });
    const end = Date.now() + o.timeoutMs;
    let parentCheck = 0;
    for (;;) {
        for (const f of filesFor(o.patterns)) if (!followed.has(f)) followed.set(f, { offset: 0, partial: '' });
        const many = followed.size > 1;
        for (const [f, s] of followed) {
            let size: number;
            try {
                size = statSync(f).size;
            } catch {
                continue;   // gone for now (rotated): read again from the start when it is back
            }
            if (size < s.offset) { s.offset = 0; s.partial = ''; }
            if (size === s.offset) continue;
            const text = s.partial + readFrom(f, s.offset, size);
            s.offset = size;
            const t = takeLines(text, o);
            s.partial = t.rest;
            const name = relative(process.cwd(), f) || f;
            for (const line of t.print) out(many ? `${name}: ${line}` : line);
            if (t.done) return 'until';
        }
        const now = Date.now();
        if (now >= end) {
            out(`watch: timeout after ${Math.round(o.timeoutMs / 1000)} s`);
            return 'timeout';
        }
        if (now - parentCheck >= 5000) {
            parentCheck = now;
            if (!wanted()) return 'parent';
        }
        await Bun.sleep(Math.min(o.everyMs, end - now));
    }
}

if (import.meta.main) {
    let o: WatchOptions;
    try {
        o = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`watch: ${(e as Error).message}`);
        console.error('usage: bun scripts/watch.ts <file or glob>... [--match=<re>] [--skip=<re>] [--until=<re>] [--timeout=<s>] [--from=end|start] [--every=<ms>]');
        process.exit(2);
    }
    // Whoever started us, read once: the shells up to the first other process (scripts/processes.ts guardians).
    let keepers: number[] = [process.ppid];
    try {
        const g = guardians(await listProcesses(), process.pid);
        if (g.length) keepers = g.map(p => p.pid);
    } catch {
        // no process list: the parent alone, and the timeout
    }
    await watch(o, console.log, () => keepers.every(alive));
    process.exit(0);
}
