import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotExecutions, executeCode, type ExecuteCodeResult, type Manager } from './execute-code';
import { ClientNotLiveError, type BotConnection } from './api/index';
import { ConsoleCapture } from './console-capture';
import { executionWait } from '../sdk/execution-context';
import { makeMessage, makeState } from '../sdk/test/fixtures';

function fakeConnection(state = makeState()): BotConnection {
    const sdk = {
        getState: () => state,
        getStateAge: () => 0,
        waitForStateChange: async () => state,
        waitForReady: async () => state,
        /** Abortable sleep, like any SDK wait. */
        sleep: (ms: number) => executionWait<string>(resolve => { const t = setTimeout(() => resolve('slept'), ms); return () => clearTimeout(t); }),
        getSecret: () => ({ password: 'hunter2', url: 'ws://x?password=abc' }),
    };
    return { name: 'tbot', sdk: sdk as any, bot: { hello: () => 'hi' } as any, username: 'tbot', connected: true, lastShownMessageId: -1 };
}

function manager(connection: BotConnection | Error): Manager {
    return {
        get: () => (connection instanceof Error ? undefined : connection),
        connect: async () => { if (connection instanceof Error) throw connection; return connection; },
    };
}

const structured = (r: any) => r.structuredContent as ExecuteCodeResult;

const tmpDirs: string[] = [];
afterAll(() => { for (const dir of tmpDirs) try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('executeCode', () => {
    test('returns the value, captured logs and a world summary', async () => {
        const conn = fakeConnection();
        const r = await executeCode(manager(conn), 'tbot', 'const x: number = 2; console.log("hello", { a: 1 }); return { x, b: bot.hello(), slot: EquipmentSlot.RightHand, args };', 10_000, undefined, new BotExecutions(), { args: { n: 1 } });
        const s = structured(r);
        expect(s.ok).toBe(true);
        expect(s.result).toEqual({ x: 2, b: 'hi', slot: 10, args: { n: 1 } });
        expect(s.logs[0]).toContain('hello');
        expect(s.world?.player?.name).toBe('Testbot');
        expect(s.world?.messages.system).toEqual(['Welcome to OpenDAoC']);
        expect(r.content[0]!.text).toContain('── Result ──');
        expect(r.content[0]!.text).toContain('── World State ──');
        expect(conn.lastShownMessageId).toBe(3);
        // A second call doesn't re-show the same messages.
        const again = structured(await executeCode(manager(conn), 'tbot', 'return 1', 10_000, undefined, new BotExecutions()));
        expect(again.world?.messages.system).toEqual([]);
        expect(again.world?.messages.chat).toEqual([]);
    });

    test('world none omits the summary', async () => {
        const s = structured(await executeCode(manager(fakeConnection()), 'tbot', 'return 1', 10_000, undefined, new BotExecutions(), { world: 'none' }));
        expect(s.world).toBeNull();
    });

    test('exceptions, unserializable results and redaction', async () => {
        const conn = fakeConnection();
        const ex = structured(await executeCode(manager(conn), 'tbot', 'throw new Error("boom")', 10_000, undefined, new BotExecutions()));
        expect(ex.error).toMatchObject({ kind: 'exception', message: 'boom' });
        const big = structured(await executeCode(manager(conn), 'tbot', 'return 1n', 10_000, undefined, new BotExecutions()));
        expect(big.error?.kind).toBe('unserializable_result');
        const secret = structured(await executeCode(manager(conn), 'tbot', 'return sdk.getSecret()', 10_000, undefined, new BotExecutions()));
        expect(secret.result).toEqual({ password: '[REDACTED]', url: 'ws://x?password=[REDACTED]' });
    });

    test('timeout aborts SDK waits and reports the active action', async () => {
        const s = structured(await executeCode(manager(fakeConnection()), 'tbot', 'await sdk.sleep(10_000); return "late"', 100, undefined, new BotExecutions()));
        expect(s.error?.kind).toBe('timeout');
        expect(s.error?.activeActions).toEqual(['sdk.sleep']);
        expect(s.elapsedMs).toBeLessThan(2000);
    });

    test('a newer call for the same bot supersedes the running one', async () => {
        const executions = new BotExecutions();
        const conn = fakeConnection();
        const first = executeCode(manager(conn), 'tbot', 'await sdk.sleep(10_000); return "first"', 10_000, undefined, executions);
        await new Promise(r => setTimeout(r, 50));
        const second = executeCode(manager(conn), 'TBOT', 'return "second"', 10_000, undefined, executions);
        expect(structured(await first).error?.kind).toBe('superseded');
        expect(structured(await second)).toMatchObject({ ok: true, result: 'second' });
    });

    test("a superseded run's cleanup finishes before the newer call's first action", async () => {
        const executions = new BotExecutions();
        const events: string[] = [];
        const conn = fakeConnection();
        // Like killNpc: wait (abortable), then in finally take a while before dispatching a stop.
        (conn.bot as any).kill = async () => {
            try {
                await executionWait<void>(() => () => {});
            } finally {
                await new Promise(r => setTimeout(r, 200));
                events.push('A cleanup stop');
            }
        };
        (conn.sdk as any).move = () => { events.push('B move'); return true; };
        const first = executeCode(manager(conn), 'tbot', 'await bot.kill(); return "first"', 10_000, undefined, executions);
        await new Promise(r => setTimeout(r, 50));
        const second = executeCode(manager(conn), 'tbot', 'sdk.move(); return "second"', 10_000, undefined, executions);
        const a = structured(await first);
        expect(a.error?.kind).toBe('superseded');
        expect(a.elapsedMs).toBeGreaterThanOrEqual(200); // reported only after its cleanup
        expect(structured(await second)).toMatchObject({ ok: true, result: 'second' });
        expect(events).toEqual(['A cleanup stop', 'B move']);
    });

    test('the cleanup wait is bounded when stopped code never settles', async () => {
        const started = Date.now();
        const s = structured(await executeCode(manager(fakeConnection()), 'tbot',
            'try { await sdk.sleep(10_000); } finally { await sdk.sleep(1); }', 100, undefined, new BotExecutions(), { settleMs: 300 }));
        expect(s.error?.kind).toBe('timeout');
        expect(Date.now() - started).toBeGreaterThanOrEqual(350);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    test('different bots run concurrently', async () => {
        const executions = new BotExecutions();
        const a = executeCode(manager(fakeConnection()), 'a', 'await sdk.sleep(100); return "a"', 10_000, undefined, executions);
        const b = executeCode(manager(fakeConnection()), 'b', 'await sdk.sleep(100); return "b"', 10_000, undefined, executions);
        expect([(structured(await a)).result, structured(await b).result]).toEqual(['a', 'b']);
    });

    test('client cancellation maps to cancelled', async () => {
        const controller = new AbortController();
        const run = executeCode(manager(fakeConnection()), 'tbot', 'await sdk.sleep(10_000)', 10_000, controller.signal, new BotExecutions());
        setTimeout(() => controller.abort(new Error('user hit stop')), 50);
        expect(structured(await run).error).toMatchObject({ kind: 'cancelled', message: 'user hit stop' });
    });

    test('cancelled code that swallows errors parks instead of spinning', async () => {
        const s = structured(await executeCode(manager(fakeConnection()), 'tbot',
            'while (true) { try { await sdk.sleep(10_000); } catch {} }', 100, undefined, new BotExecutions()));
        expect(s.error?.kind).toBe('timeout');
    });

    test('connect failures are not_connected; a non-live client still runs with a warning', async () => {
        const nc = structured(await executeCode(manager(new Error('gateway down')), 'tbot', 'return 1', 10_000, undefined, new BotExecutions()));
        expect(nc.error).toMatchObject({ kind: 'not_connected', message: 'gateway down' });
        const conn = fakeConnection();
        const warned = structured(await executeCode(manager(new ClientNotLiveError('client exited', conn)), 'tbot', 'return 2', 10_000, undefined, new BotExecutions()));
        expect(warned.ok).toBe(true);
        expect(warned.result).toBe(2);
        expect(warned.logs[0]).toContain('No live client: client exited');
    });

    test('script modules load and runScript-on-import is rejected', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'daoc-exec-'));
        tmpDirs.push(dir);
        const good = join(dir, 'good.ts');
        writeFileSync(good, 'export default async ({ bot, args }: any) => ({ hi: bot.hello(), n: args.n });\n');
        const ok = structured(await executeCode(manager(fakeConnection()), 'tbot', { script: good }, 10_000, undefined, new BotExecutions(), { args: { n: 3 } }));
        expect(ok.result).toEqual({ hi: 'hi', n: 3 });
        const bad = join(dir, 'bad.ts');
        writeFileSync(bad, 'import { runScript } from "x";\nrunScript(async () => 1);\n');
        const rejected = structured(await executeCode(manager(fakeConnection()), 'tbot', { script: bad }, 10_000, undefined, new BotExecutions()));
        expect(rejected.error?.kind).toBe('invalid_input');
        const missing = structured(await executeCode(manager(fakeConnection()), 'tbot', { script: join(dir, 'nope.ts') }, 10_000, undefined, new BotExecutions()));
        expect(missing.error?.kind).toBe('invalid_input');
    });

    test('a client restart (ids went backwards) shows messages again', async () => {
        const conn = fakeConnection(makeState({ gameMessages: [makeMessage(1, 'again')] }));
        conn.lastShownMessageId = 50;
        const s = structured(await executeCode(manager(conn), 'tbot', 'return 1', 10_000, undefined, new BotExecutions()));
        expect(s.world?.messages.system).toEqual(['again']);
    });
});

describe('ConsoleCapture', () => {
    test('keeps head and tail, clips long lines, counts omissions', () => {
        const c = new ConsoleCapture(2, 2, 10);
        for (let i = 0; i < 7; i++) c.push(`line ${i}`);
        c.push('x'.repeat(30));
        const lines = c.lines();
        expect(lines[0]).toBe('line 0');
        expect(lines[1]).toBe('line 1');
        expect(lines[2]).toContain('4 line(s) omitted');
        expect(lines[3]).toBe('line 6');
        expect(lines[4]).toContain('more chars');
        expect(c.total).toBe(8);
    });
});
