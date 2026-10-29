// Copied from mcp/console-capture.ts of rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
/**
  * Bounded console capture for execute_code.
  *
  * Captured output used to be an unbounded array. A script that logs from a
  * tight loop (e.g. a catch block with no await, retrying a call that throws
  * synchronously) never yields, so the execution timeout can't fire and the
  * array grows until the process - and the sandbox with it - runs out of
  * memory. Keep the first `headMax` and last `tailMax` lines, clip long lines,
  * and count everything dropped in between so memory stays constant.
  */

import { executionContext } from '../sdk/execution-context';
import { redactCredentials } from '../sdk/redact';

export function formatLogArgument(value: unknown): string {
    let text: string;
    if (value instanceof Error) text = value.stack ?? `${value.name}: ${value.message}`;
    else if (value instanceof RegExp) text = String(value);
    else if (typeof value === 'object' && value !== null) {
        try {
            text = JSON.stringify(value, (key, item) => /^(password|token|secret|api[_-]?key)$/i.test(key)
                ? '[REDACTED]' : item instanceof RegExp ? String(item) : item, 2) ?? String(value);
        } catch { text = String(value); }
    } else text = String(value);
    return redactCredentials(text);
}

const LEVELS = { log: 'log', info: 'log', debug: 'log', dir: 'log', warn: 'warn', error: 'error' } as const;
let restore: (() => void) | undefined;

/** Route each execution's console (user code and SDK alike) to its own buffer; keep everything else off MCP stdout. Idempotent. */
export function installExecutionConsoleCapture(): () => void {
    if (restore) return restore;
    const original = { ...console };
    for (const [method, level] of Object.entries(LEVELS) as [keyof typeof LEVELS, 'log' | 'warn' | 'error'][]) {
        console[method] = (...args: unknown[]) => {
            const context = executionContext.getStore();
            // A finished execution's leftover timers still carry its scope; nobody reads that buffer.
            if (context?.log && !context.signal.aborted) context.log(level, args);
            else original.error(...args.map(formatLogArgument));
        };
    }
    restore = () => { Object.assign(console, original); restore = undefined; };
    return restore;
}

export const CONSOLE_HEAD_LINES = 300;
export const CONSOLE_TAIL_LINES = 300;
export const CONSOLE_MAX_LINE_CHARS = 2000;

export class ConsoleCapture {
    private readonly head: string[] = [];
    private readonly tail: string[] = []; // ring buffer once full
    private tailStart = 0;
    private omitted = 0;

    constructor(
        private readonly headMax = CONSOLE_HEAD_LINES,
        private readonly tailMax = CONSOLE_TAIL_LINES,
        private readonly maxLineChars = CONSOLE_MAX_LINE_CHARS,
    ) {}

    push(line: string): void {
        if (line.length > this.maxLineChars) {
            line = `${line.slice(0, this.maxLineChars)} … [${line.length - this.maxLineChars} more chars]`;
        }
        if (this.head.length < this.headMax) {
            this.head.push(line);
        } else if (this.tail.length < this.tailMax) {
            this.tail.push(line);
        } else if (this.tailMax === 0) {
            this.omitted++;
        } else {
            this.tail[this.tailStart] = line;
            this.tailStart = (this.tailStart + 1) % this.tailMax;
            this.omitted++;
        }
    }

    /** Number of lines retained (not counting omitted ones). */
    get length(): number {
        return this.head.length + this.tail.length;
    }

    /** Total lines logged, including omitted ones. */
    get total(): number {
        return this.length + this.omitted;
    }

    lines(): string[] {
        const tail = this.tail.slice(this.tailStart).concat(this.tail.slice(0, this.tailStart));
        if (this.omitted === 0) return this.head.concat(tail);
        const marker = `… ${this.omitted} line(s) omitted - console output keeps the first ${this.headMax} and last ${this.tailMax} lines …`;
        return [...this.head, marker, ...tail];
    }
}
