// BotManager against a real in-process gateway, spawning a stand-in
// client/runner.ts (the fake client) from a temporary repo root.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createGateway } from '../gateway/gateway';
import { BotManager, ClientNotLiveError } from './api/index';
import { ensureGateway, isGatewayReachable } from '../sdk/index';

const fakeClientPath = join(import.meta.dir, '..', 'sdk', 'test', 'fake-client.ts').replace(/\\/g, '/');
const gateway = createGateway({ port: 0, hostname: '127.0.0.1', quiet: true });
const gatewayUrl = `ws://127.0.0.1:${gateway.port}`;
const pids: number[] = [];
// Like client/runner.ts: a quit action makes the runner exit 0.
const QUIT_EXITS_SRC = `const QUIT_EXITS = (a: any) => { if (a.type === 'quit') setTimeout(() => process.exit(0), 50); return null; };`;
const spawned: ChildProcess[] = [];
/** Temp roots to remove once the processes that log into them have exited. */
const tmpRoots: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
}

function fakeRoot(withRunner: boolean): string {
    const root = tempDir('daoc-mgr-');
    mkdirSync(join(root, 'bots', 'fakebot'), { recursive: true });
    writeFileSync(join(root, 'bots', 'fakebot', 'bot.env'), `BOT_USERNAME=fakebot\nPASSWORD=pw\nGATEWAY_URL=${gatewayUrl}\n`);
    if (withRunner) {
        mkdirSync(join(root, 'client'), { recursive: true });
        writeFileSync(join(root, 'client', 'runner.ts'), [
            `import { FakeClient } from '${fakeClientPath}';`,
            QUIT_EXITS_SRC,
            `const name = process.argv[2]!;`,
            `console.log('fake runner for', name, 'gateway', process.env.GATEWAY_URL);`,
            `await new FakeClient(process.env.GATEWAY_URL!, name, { publishMs: 100, onAction: QUIT_EXITS }).start();`,
            `setInterval(() => {}, 1000);`,
        ].join('\n'));
    }
    return root;
}

afterAll(async () => {
    for (const pid of pids) try { process.kill(pid); } catch {}
    for (const child of spawned) try { child.kill(); } catch {}
    await gateway.stop();
    // Windows keeps a running process's log open, so wait for exits before removing the roots.
    const deadline = Date.now() + 5000;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (Date.now() < deadline && (pids.some(alive) || spawned.some(c => c.exitCode === null && c.signalCode === null))) {
        await new Promise(r => setTimeout(r, 100));
    }
    for (const dir of tmpRoots) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('BotManager', () => {
    test('spawns client/runner.ts when no client is attached, then reuses it', async () => {
        const saved = process.env.GATEWAY_URL;
        delete process.env.GATEWAY_URL;
        try {
            const root = fakeRoot(true);
            const manager = new BotManager({ repoRoot: root, clientStartTimeoutMs: 20_000 });
            const conn = await manager.connect('fakebot');
            const listed = manager.list();
            expect(listed).toHaveLength(1);
            expect(listed[0]!.clientPid).toBeNumber();
            pids.push(listed[0]!.clientPid!);
            expect(conn.sdk.getState()?.inGame).toBe(true);
            expect(conn.sdk.getPlayer()?.name).toBe('Fakebot');
            expect(readFileSync(join(root, 'bots', 'fakebot', 'client.log'), 'utf-8')).toContain('fake runner for fakebot');
            expect((await conn.sdk.sendSit(true)).success).toBe(true);

            // Already live: no second process.
            const again = await manager.connect('FAKEBOT');
            expect(again).toBe(conn);
            expect(manager.list()[0]!.clientPid).toBe(listed[0]!.clientPid);
            const pid = listed[0]!.clientPid!;
            const stopped = await manager.disconnect('fakebot');
            expect(stopped).toEqual({ stoppedClient: true, killed: false });
            expect(manager.list()).toHaveLength(0);
            expect(() => process.kill(pid, 0)).toThrow(); // the spawned client exited
        } finally {
            if (saved !== undefined) process.env.GATEWAY_URL = saved;
        }
    }, 30_000);

    test('no runner: connection kept, ClientNotLiveError explains', async () => {
        const saved = process.env.GATEWAY_URL;
        delete process.env.GATEWAY_URL;
        try {
            const root = fakeRoot(false);
            const manager = new BotManager({ repoRoot: root, clientStartTimeoutMs: 1000 });
            // Make the earlier test's bot look gone by using a fresh name.
            writeFileSync(join(root, 'bots', 'fakebot', 'bot.env'), `BOT_USERNAME=nobodyhere\nPASSWORD=pw\nGATEWAY_URL=${gatewayUrl}\n`);
            const error = await manager.connect('fakebot').catch(e => e);
            expect(error).toBeInstanceOf(ClientNotLiveError);
            expect(error.message).toContain('client/runner.ts does not exist');
            expect(error.connection.sdk.isAuthenticated()).toBe(true);
            await manager.disconnect('fakebot');
        } finally {
            if (saved !== undefined) process.env.GATEWAY_URL = saved;
        }
    });

    test('a spawned client is waited for until it is in game, not just publishing', async () => {
        const saved = process.env.GATEWAY_URL;
        delete process.env.GATEWAY_URL;
        try {
            const root = fakeRoot(false);
            writeFileSync(join(root, 'bots', 'fakebot', 'bot.env'), `BOT_USERNAME=slowbot\nPASSWORD=pw\nGATEWAY_URL=${gatewayUrl}\n`);
            mkdirSync(join(root, 'client'), { recursive: true });
            // Publishes 'login' frames (inGame false) for 1.5 s, like a client backing off a linkdead lockout.
            writeFileSync(join(root, 'client', 'runner.ts'), [
                `import { FakeClient } from '${fakeClientPath}';`,
            QUIT_EXITS_SRC,
                `const client = new FakeClient(process.env.GATEWAY_URL!, 'slowbot', { publishMs: 100, onAction: QUIT_EXITS });`,
                `const inGame = client.state;`,
                `client.state = { ...inGame, inGame: false, player: null, connection: { ...inGame.connection, phase: 'login', lastError: 'AccountIsInLogoutProcedure' } };`,
                `await client.start();`,
                `setTimeout(() => { client.state = { ...inGame, tick: client.state.tick }; }, 1500);`,
                `setInterval(() => {}, 1000);`,
            ].join('\n'));
            const manager = new BotManager({ repoRoot: root, clientStartTimeoutMs: 20_000 });
            const started = Date.now();
            const conn = await manager.connect('fakebot');
            pids.push(manager.list()[0]!.clientPid!);
            expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
            expect(conn.sdk.getState()?.inGame).toBe(true);
            await manager.disconnect('fakebot');
        } finally {
            if (saved !== undefined) process.env.GATEWAY_URL = saved;
        }
    }, 30_000);

    test('a spawned client that never gets in game reports its phase and last error', async () => {
        const saved = process.env.GATEWAY_URL;
        delete process.env.GATEWAY_URL;
        try {
            const root = fakeRoot(false);
            writeFileSync(join(root, 'bots', 'fakebot', 'bot.env'), `BOT_USERNAME=stuckbot\nPASSWORD=pw\nGATEWAY_URL=${gatewayUrl}\n`);
            mkdirSync(join(root, 'client'), { recursive: true });
            writeFileSync(join(root, 'client', 'runner.ts'), [
                `import { FakeClient } from '${fakeClientPath}';`,
            QUIT_EXITS_SRC,
                `const client = new FakeClient(process.env.GATEWAY_URL!, 'stuckbot', { publishMs: 100, onAction: QUIT_EXITS });`,
                `client.state = { ...client.state, inGame: false, player: null, connection: { ...client.state.connection, phase: 'charScreen', lastError: 'NameInvalid' } };`,
                `await client.start();`,
                `setInterval(() => {}, 1000);`,
            ].join('\n'));
            const manager = new BotManager({ repoRoot: root, clientStartTimeoutMs: 1500 });
            const error = await manager.connect('fakebot').catch(e => e);
            const pid = manager.list()[0]?.clientPid;
            if (pid) pids.push(pid);
            expect(error).toBeInstanceOf(ClientNotLiveError);
            expect(error.message).toContain('phase charScreen');
            expect(error.message).toContain('NameInvalid');
            await manager.disconnect('fakebot');
        } finally {
            if (saved !== undefined) process.env.GATEWAY_URL = saved;
        }
    }, 30_000);

    test('disconnect retries a refused quit instead of killing the client (no link-death)', async () => {
        const saved = process.env.GATEWAY_URL;
        delete process.env.GATEWAY_URL;
        try {
            const root = fakeRoot(false);
            writeFileSync(join(root, 'bots', 'fakebot', 'bot.env'), `BOT_USERNAME=retrybot\nPASSWORD=pw\nGATEWAY_URL=${gatewayUrl}\n`);
            mkdirSync(join(root, 'client'), { recursive: true });
            // The first quit fails (e.g. the runner was between gateway connections); the second one exits 0.
            writeFileSync(join(root, 'client', 'runner.ts'), [
                `import { FakeClient } from '${fakeClientPath}';`,
                `let quits = 0;`,
                `const onAction = (a: any) => {`,
                `    if (a.type !== 'quit') return null;`,
                `    if (++quits === 1) return { success: false, message: 'not now', phase: 'dispatch' };`,
                `    setTimeout(() => process.exit(0), 50);`,
                `    return null;`,
                `};`,
                `await new FakeClient(process.env.GATEWAY_URL!, 'retrybot', { publishMs: 100, onAction }).start();`,
                `setInterval(() => {}, 1000);`,
            ].join('\n'));
            const manager = new BotManager({ repoRoot: root, clientStartTimeoutMs: 20_000, clientStopTimeoutMs: 20_000 });
            await manager.connect('fakebot');
            const pid = manager.list()[0]!.clientPid!;
            pids.push(pid);
            expect(await manager.disconnect('fakebot')).toEqual({ stoppedClient: true, killed: false });
            expect(() => process.kill(pid, 0)).toThrow();
        } finally {
            if (saved !== undefined) process.env.GATEWAY_URL = saved;
        }
    }, 40_000);

    test('unknown bot folder', async () => {
        const manager = new BotManager({ repoRoot: fakeRoot(false) });
        await expect(manager.connect('doesnotexist')).rejects.toThrow(/not found/);
    });
});

describe('ensureGateway', () => {
    test('is a no-op when reachable and starts a local gateway when not', async () => {
        expect(await ensureGateway(gatewayUrl)).toBeNull();
        const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
        const port = probe.port;
        await probe.stop(true);
        const url = `ws://127.0.0.1:${port}`;
        const logPath = join(tempDir('daoc-gw-'), 'gateway.log');
        const child = await ensureGateway(url, { logPath, timeoutMs: 15_000 });
        expect(child).not.toBeNull();
        spawned.push(child!);
        expect(await isGatewayReachable(url)).toBe(true);
        child!.kill();
        await expect(ensureGateway('ws://example.invalid:7780', { timeoutMs: 100 })).rejects.toThrow(/not local/);
    }, 30_000);
});
