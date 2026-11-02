// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
import { afterEach, describe, expect, test } from 'bun:test';
import { createGateway, type Gateway, type GatewayOptions } from './gateway';
import { repeatsLastFanout } from './state-fanout';
import { makeMessage, makeState } from '../sdk/test/fixtures';
import type { BotWorldState } from './types';
import { botEnvAuth, checkRequestSource, findBotPassword, isAllowedOrigin, resolveAuthMode } from './security';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what = 'condition', timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await pause(10);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

interface Peer { ws: WebSocket; messages: any[]; send(msg: object): void; closed: Promise<void> }

let gateway: Gateway | null = null;
const peers: Peer[] = [];

function start(options: GatewayOptions = {}): Gateway {
    gateway = createGateway({ port: 0, hostname: '127.0.0.1', quiet: true, ...options });
    return gateway;
}

afterEach(async () => {
    for (const p of peers.splice(0)) try { p.ws.close(); } catch {}
    await gateway?.stop();
    gateway = null;
});

async function peer(): Promise<Peer> {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway!.port}`);
    const messages: any[] = [];
    ws.onmessage = event => messages.push(JSON.parse(String(event.data)));
    const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve()));
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    const p: Peer = { ws, messages, send: msg => ws.send(JSON.stringify(msg)), closed };
    peers.push(p);
    return p;
}

async function bot(username = 'tbot', clientId = `${username}-client`, maxMessageLength?: number): Promise<Peer> {
    const p = await peer();
    p.send({ type: 'connected', username, password: 'pw', clientId, maxMessageLength });
    await until(() => p.messages.some(m => m.type === 'status'), 'bot registration');
    return p;
}

async function sdk(username = 'tbot', mode: 'control' | 'observe' = 'control'): Promise<Peer> {
    const p = await peer();
    p.send({ type: 'sdk_connect', username, password: 'pw', clientId: `sdk-${mode}`, mode });
    await until(() => p.messages.some(m => m.type === 'sdk_connected' || m.type === 'sdk_error'), 'sdk handshake');
    return p;
}

const http = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${gateway!.port}${path}`, init);
const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('gateway routing', () => {
    test('state fans out to SDKs and lastState replays on connect', async () => {
        start();
        const b = await bot();
        b.send({ type: 'state', state: makeState({ tick: 7 }) });
        await until(async () => (await (await http('/status/tbot')).json()).status === 'active', 'active status');
        const s = await sdk();
        await until(() => s.messages.some(m => m.type === 'sdk_state'), 'replayed state');
        expect(s.messages.find(m => m.type === 'sdk_state').state.tick).toBe(7);
        b.send({ type: 'state', state: makeState({ tick: 8 }) });
        await until(() => s.messages.filter(m => m.type === 'sdk_state').length === 2, 'live state');
    });

    test('actions route to the bot and results back to the SDK', async () => {
        start();
        const b = await bot();
        const s = await sdk();
        s.send({ type: 'sdk_action', username: 'someone-else', actionId: 'a1', action: { type: 'sit', sit: true }, actionTimeoutMs: 1000 });
        await until(() => b.messages.some(m => m.type === 'action'), 'action at bot');
        const action = b.messages.find(m => m.type === 'action');
        expect(action).toMatchObject({ actionId: 'a1', action: { type: 'sit', sit: true }, actionTimeoutMs: 1000 });
        b.send({ type: 'actionResult', actionId: 'a1', result: { success: true, message: 'sat' } });
        await until(() => s.messages.some(m => m.type === 'sdk_action_result'), 'result at sdk');
        expect(s.messages.find(m => m.type === 'sdk_action_result')).toMatchObject({ actionId: 'a1', result: { success: true } });
    });

    test('an action with no bot gets "Bot not connected"', async () => {
        start();
        const s = await sdk('ghost');
        s.send({ type: 'sdk_action', username: 'ghost', actionId: 'x', action: { type: 'stop' } });
        await until(() => s.messages.some(m => m.type === 'sdk_error'), 'error');
        expect(s.messages.find(m => m.type === 'sdk_error')).toMatchObject({ actionId: 'x', error: 'Bot not connected' });
    });

    test('last controller wins; observers coexist', async () => {
        start();
        await bot();
        const c1 = await sdk('tbot', 'control');
        const o1 = await sdk('tbot', 'observe');
        const c2 = await sdk('tbot', 'control');
        await c1.closed;
        expect(c1.messages.some(m => m.type === 'sdk_error' && m.error === 'Disconnected: another controller connected')).toBe(true);
        expect(o1.ws.readyState).toBe(WebSocket.OPEN);
        expect(c2.ws.readyState).toBe(WebSocket.OPEN);
        const status = await (await http('/status/tbot')).json();
        expect(status.controllers).toHaveLength(1);
        expect(status.observers).toHaveLength(1);
    });

    test('taking control closes the trade window the old controller can no longer reach', async () => {
        start();
        const b = await bot();
        const closes = () => b.messages.filter(m => m.type === 'action' && m.action.type === 'tradeCancel');
        b.send({ type: 'state', state: makeState({ tick: 1 }) });
        const c1 = await sdk();
        await until(() => c1.messages.some(m => m.type === 'sdk_state'), 'state');
        const c2 = await sdk();
        await c1.closed;
        expect(closes()).toEqual([]); // no window, nothing to close

        b.send({ type: 'state', state: makeState({ tick: 2, trade: { id: 1, revision: 1, partnerName: 'Aine', mySlots: [40], myMoney: 0, partnerItems: [], partnerMoney: 0 } }) });
        await until(() => c2.messages.some(m => m.type === 'sdk_state' && m.state.tick === 2), 'window');
        const c3 = await sdk();
        await c2.closed;
        await until(() => closes().length === 1, 'the close');
        expect(closes()[0].actionId).toBeUndefined();
        expect(c3.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('observers may only send say/send', async () => {
        start();
        const b = await bot();
        const o = await sdk('tbot', 'observe');
        o.send({ type: 'sdk_action', username: 'tbot', actionId: 'bad', action: { type: 'attack', on: true } });
        await until(() => o.messages.some(m => m.type === 'sdk_error'), 'observer reject');
        expect(o.messages.find(m => m.type === 'sdk_error').error).toContain("Observe mode can only send 'say' or 'send'");
        o.send({ type: 'sdk_action', username: 'tbot', actionId: 's1', action: { type: 'say', text: 'hi' } });
        o.send({ type: 'sdk_action', username: 'tbot', actionId: 's2', action: { type: 'send', to: 'Ann', text: 'hi' } });
        await until(() => b.messages.filter(m => m.type === 'action').length === 2, 'chat actions at bot');
        expect(b.messages.filter(m => m.type === 'action').map(m => m.action.type)).toEqual(['say', 'send']);
    });

    test('malformed frames close the socket', async () => {
        start();
        for (const frame of ['not json', 'null', '[]', '{"type":5}']) {
            const p = await peer();
            p.ws.send(frame);
            await p.closed;
            expect(p.messages[0]?.type).toBe('error');
        }
    });

    test('a bot disconnect is reported to SDKs and state survives', async () => {
        start();
        const b = await bot();
        b.send({ type: 'state', state: makeState({ tick: 3 }) });
        const s = await sdk();
        await until(() => s.messages.some(m => m.type === 'sdk_state'), 'state');
        b.ws.close();
        await until(() => s.messages.some(m => m.type === 'sdk_error' && m.error === 'Bot disconnected'), 'disconnect notice');
        const status = await (await http('/status/tbot')).json();
        expect(status.status).toBe('dead');
        const state = await http('/state/tbot');
        expect(state.status).toBe(200);
        expect((await state.json()).state.tick).toBe(3);
    });

    test('auth hook rejects', async () => {
        start({ auth: ({ password }) => password === 'good' ? { success: true } : { success: false, error: 'bad password' } });
        const p = await peer();
        p.send({ type: 'sdk_connect', username: 'tbot', password: 'nope' });
        await p.closed;
        expect(p.messages[0]).toMatchObject({ type: 'sdk_error', error: 'Authentication failed: bad password' });
        expect((await http('/state/tbot?password=nope')).status).toBe(401);
    });

    test('a socket closed during auth never registers', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        start({ auth: async () => { await gate; return { success: true }; } });
        const p = await peer();
        p.send({ type: 'sdk_connect', username: 'tbot', mode: 'control' });
        await pause(30);
        p.ws.close();
        await p.closed;
        await pause(30);
        release();
        await pause(50);
        expect(Object.keys((await (await http('/status')).json()).sdks)).toHaveLength(0);
    });
});

describe('gateway takeover', () => {
    test('a second client triggers save_and_disconnect and waits for the old one', async () => {
        start({ takeoverGraceMs: 5000, takeoverSettleMs: 20 });
        const oldBot = await bot('tbot', 'old');
        oldBot.send({ type: 'state', state: makeState({ tick: 9 }) });
        const s = await sdk();
        const newBot = await peer();
        newBot.send({ type: 'connected', username: 'tbot', clientId: 'new' });
        await until(() => oldBot.messages.some(m => m.type === 'save_and_disconnect'), 'save_and_disconnect');
        expect(newBot.messages.some(m => m.type === 'status')).toBe(false);
        // The old client quits, then closes.
        oldBot.ws.close();
        await until(() => newBot.messages.some(m => m.type === 'status'), 'new bot registered');
        // SDKs are told the bot is back, not that it died, and lastState is preserved.
        await until(() => s.messages.filter(m => m.type === 'sdk_connected').length === 2, 'sdk re-notified');
        expect(s.messages.some(m => m.error === 'Bot disconnected')).toBe(false);
        const all = await (await http('/status')).json();
        expect(all.bots.tbot.clientId).toBe('new');
        expect(all.bots.tbot.tick).toBe(9);
        // Actions now reach the new client.
        s.send({ type: 'sdk_action', username: 'tbot', actionId: 'n1', action: { type: 'stop' } });
        await until(() => newBot.messages.some(m => m.type === 'action'), 'action at new bot');
    });

    test('a waiting client that re-sends connected is not closed by its own supersede', async () => {
        start({ takeoverGraceMs: 5000, takeoverSettleMs: 20 });
        const oldBot = await bot('tbot', 'old');
        const newBot = await peer();
        newBot.send({ type: 'connected', username: 'tbot', clientId: 'new' });
        await until(() => oldBot.messages.some(m => m.type === 'save_and_disconnect'), 'save_and_disconnect');
        newBot.send({ type: 'connected', username: 'tbot', clientId: 'new' });
        await pause(50);
        expect(newBot.ws.readyState).toBe(WebSocket.OPEN);
        oldBot.ws.close();
        await until(() => newBot.messages.some(m => m.type === 'status'), 'new bot registered');
        expect((await (await http('/status')).json()).bots.tbot.clientId).toBe('new');
    });

    test('an action in flight when the client goes away fails at once', async () => {
        start({ takeoverGraceMs: 5000, takeoverSettleMs: 20 });
        const oldBot = await bot('tbot', 'old');
        const s = await sdk();
        // Takeover: no 'Bot disconnected' goes out, but the lost action is failed.
        s.send({ type: 'sdk_action', username: 'tbot', actionId: 'lost1', action: { type: 'stop' } });
        await until(() => oldBot.messages.some(m => m.type === 'action'), 'action at old bot');
        const newBot = await peer();
        newBot.send({ type: 'connected', username: 'tbot', clientId: 'new' });
        await until(() => oldBot.messages.some(m => m.type === 'save_and_disconnect'), 'save_and_disconnect');
        oldBot.ws.close();
        await until(() => s.messages.some(m => m.type === 'sdk_error' && m.actionId === 'lost1'), 'lost action failed');
        expect(s.messages.find(m => m.actionId === 'lost1').error).toContain('disconnected before answering');
        expect(s.messages.some(m => m.error === 'Bot disconnected')).toBe(false);

        // Plain disconnect: the lost action fails, then 'Bot disconnected'.
        await until(() => newBot.messages.some(m => m.type === 'status'), 'new bot registered');
        s.send({ type: 'sdk_action', username: 'tbot', actionId: 'lost2', action: { type: 'stop' } });
        await until(() => newBot.messages.some(m => m.type === 'action'), 'action at new bot');
        newBot.ws.close();
        await until(() => s.messages.some(m => m.error === 'Bot disconnected'), 'disconnect notice');
        expect(s.messages.some(m => m.type === 'sdk_error' && m.actionId === 'lost2')).toBe(true);
    });

    test('an HTTP chat in flight when the client goes away resolves as failed', async () => {
        start();
        const b = await bot();
        const say = http('/say/tbot', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: 'hi', timeoutMs: 20_000 }) });
        await until(() => b.messages.some(m => m.type === 'action'), 'chat at bot');
        const started = Date.now();
        b.ws.close();
        const res = await say;
        expect(Date.now() - started).toBeLessThan(5000);
        expect(res.status).toBe(502);
        expect((await res.json()).results[0]).toMatchObject({ success: false, reason: 'disconnected' });
    }, 10_000);

    test('the grace period force-closes a client that never quits', async () => {
        start({ takeoverGraceMs: 100, takeoverSettleMs: 10 });
        const oldBot = await bot('tbot', 'old');
        const newBot = await peer();
        newBot.send({ type: 'connected', username: 'tbot', clientId: 'new' });
        await oldBot.closed;
        await until(() => newBot.messages.some(m => m.type === 'status'), 'new bot registered');
    });
});

describe('gateway staleness and HTTP', () => {
    test('status goes stale without state', async () => {
        start({ staleThresholdMs: 50 });
        const b = await bot();
        b.send({ type: 'state', state: makeState() });
        await until(async () => (await (await http('/status/tbot')).json()).status === 'active', 'active');
        await pause(80);
        const status = await (await http('/status/tbot')).json();
        expect(status.status).toBe('stale');
        expect(status.player).toMatchObject({ name: 'Testbot', regionId: 1, x: 560000, y: 511000, z: 2500 });
        expect((await (await http('/status/nobody')).json()).status).toBe('dead');
        expect((await http('/state/nobody')).status).toBe(404);
    });

    test('GET /chat merges history; POST /say chunks; POST /dm sends', async () => {
        start();
        const b = await bot('tbot', 'c', 10);
        b.ws.onmessage = event => {
            const msg = JSON.parse(String(event.data));
            b.messages.push(msg);
            if (msg.type === 'action') b.send({ type: 'actionResult', actionId: msg.actionId, result: { success: true, message: 'ok' } });
        };
        b.send({ type: 'state', state: makeState({ gameMessages: [makeMessage(1, 'sys'), makeMessage(2, 'Ann says, "a"', { type: 'say', sender: 'Ann' })] }) });
        b.send({ type: 'state', state: makeState({ tick: 2, gameMessages: [makeMessage(2, 'Ann says, "a"', { type: 'say', sender: 'Ann' }), makeMessage(3, 'Ann says, "b"', { type: 'say', sender: 'Ann' })] }) });
        await until(async () => (await (await http('/chat/tbot')).json()).messages.length === 2, 'chat');
        expect((await (await http('/chat/tbot?system=1')).json()).messages.map((m: any) => m.id)).toEqual([1, 2, 3]);

        const say = await http('/say/tbot', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: 'hello there friend' }) });
        const sayBody = await say.json();
        expect(say.status).toBe(200);
        expect(sayBody.results.map((r: any) => r.chunk)).toEqual(['hello', 'there', 'friend']);
        expect(b.messages.filter(m => m.type === 'action').map(m => m.action)).toEqual([
            { type: 'say', text: 'hello', reason: 'HTTP chat' },
            { type: 'say', text: 'there', reason: 'HTTP chat' },
            { type: 'say', text: 'friend', reason: 'HTTP chat' },
        ]);
        const dm = await http('/dm/tbot', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ to: 'Ann', text: 'psst' }) });
        expect((await dm.json())).toMatchObject({ ok: true, to: 'Ann' });
        expect(b.messages.filter(m => m.type === 'action').at(-1).action).toMatchObject({ type: 'send', to: 'Ann', text: 'psst' });

        expect((await http('/say/nobody', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: 'x' }) })).status).toBe(409);
        expect((await http('/say/tbot', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(400);
        expect((await http('/dm/tbot', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: 'x' }) })).status).toBe(400);
    }, 10_000);

    test('POST /say times out when the client never answers', async () => {
        start();
        await bot();
        const res = await http('/say/tbot', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: 'hi', timeoutMs: 2000 }) });
        expect(res.status).toBe(502);
        expect((await res.json()).results[0]).toMatchObject({ success: false, reason: 'timeout' });
    }, 10_000);
});

describe('gateway exposure (security.ts)', () => {
    test('listens on 127.0.0.1 unless told otherwise', () => {
        const saved = process.env.GATEWAY_HOSTNAME;
        delete process.env.GATEWAY_HOSTNAME;
        try {
            gateway = createGateway({ port: 0, quiet: true });
            expect(gateway.server.hostname).toBe('127.0.0.1');
        } finally {
            if (saved !== undefined) process.env.GATEWAY_HOSTNAME = saved;
        }
    });

    test('a WebSocket from a foreign origin is refused before the upgrade', async () => {
        start();
        const b = await bot('victim');
        const evil = new WebSocket(`ws://127.0.0.1:${gateway!.port}`, { headers: { Origin: 'https://evil.example' } } as any);
        const outcome = await new Promise<string>(resolve => {
            evil.onopen = () => resolve('open');
            evil.onerror = () => resolve('error');
            evil.onclose = () => resolve('closed');
        });
        expect(outcome).not.toBe('open');
        // A page on another localhost port (a local dev tool) may connect.
        const local = new WebSocket(`ws://127.0.0.1:${gateway!.port}`, { headers: { Origin: 'http://localhost:5173' } } as any);
        await new Promise<void>((resolve, reject) => { local.onopen = () => resolve(); local.onerror = reject; });
        local.close();
        expect(b.messages.some(m => m.type === 'save_and_disconnect' || m.type === 'action')).toBe(false);
    });

    test('cross-origin and non-JSON POSTs never reach the bot', async () => {
        start();
        const b = await bot('victim');
        const text = await http('/say/victim', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ text: 'hi from evil' }) });
        expect(text.status).toBe(415);
        const foreign = await http('/say/victim', { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'https://evil.example' }, body: JSON.stringify({ text: 'hi from evil' }) });
        expect(foreign.status).toBe(403);
        const auth = await http('/bots/victim/auth', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ password: 'x' }) });
        expect(auth.status).toBe(415);
        await pause(50);
        expect(b.messages.some(m => m.type === 'action')).toBe(false);
    });

    test('CORS headers only for loopback origins; reads from foreign origins are refused', async () => {
        start();
        await bot('victim');
        const plain = await http('/status');
        expect(plain.headers.get('access-control-allow-origin')).toBeNull();
        const local = await http('/status', { headers: { Origin: 'http://localhost:5173' } });
        expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
        for (const path of ['/state/victim', '/status', '/bots']) {
            const res = await http(path, { headers: { Origin: 'https://evil.example' } });
            expect(res.status).toBe(403);
            expect(res.headers.get('access-control-allow-origin')).toBeNull();
        }
        const preflight = await http('/say/victim', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
        expect(preflight.status).toBe(403);
    });

    test('a foreign Host (DNS rebinding) is refused on a loopback bind', async () => {
        start();
        const res = await http('/status', { headers: { Host: `evil.example:${gateway!.port}` } });
        expect(res.status).toBe(403);
        expect((await http('/status', { headers: { Host: `localhost:${gateway!.port}` } })).status).toBe(200);
    });

    test('checkRequestSource / isAllowedOrigin rules', () => {
        const req = (headers: Record<string, string>) => new Request('http://x/', { headers });
        const loop = { loopbackBind: true };
        const lan = { loopbackBind: false };
        expect(checkRequestSource(req({ host: 'localhost:7780' }), loop)).toBeNull();
        expect(checkRequestSource(req({ host: '127.0.0.1:7780', origin: 'http://127.0.0.1:7780' }), loop)).toBeNull();
        expect(checkRequestSource(req({ host: '[::1]:7780', origin: 'http://[::1]:7780' }), loop)).toBeNull();
        expect(checkRequestSource(req({ host: 'evil.example:7780', origin: 'http://evil.example:7780' }), loop)).toContain('Host');
        // Beyond loopback the gateway's own origin (the viewer) is fine, others are not.
        expect(checkRequestSource(req({ host: '192.168.1.5:7780', origin: 'http://192.168.1.5:7780' }), lan)).toBeNull();
        expect(checkRequestSource(req({ host: '192.168.1.5:7780', origin: 'http://evil.example' }), lan)).toContain('Origin');
        expect(isAllowedOrigin('null', 'localhost:7780')).toBe(false);
        expect(isAllowedOrigin('file://', 'localhost:7780')).toBe(false);
        expect(isAllowedOrigin('http://app.localhost:3000', 'localhost:7780')).toBe(true);
        expect(isAllowedOrigin('http://localhost.evil.example', 'localhost:7780')).toBe(false);
    });

    test('botEnvAuth checks bots/<name>/bot.env (by folder or BOT_USERNAME); resolveAuthMode', () => {
        const root = mkdtempSync(join(tmpdir(), 'daoc-gwauth-'));
        try {
            mkdirSync(join(root, 'bots', 'alpha'), { recursive: true });
            writeFileSync(join(root, 'bots', 'alpha', 'bot.env'), 'BOT_USERNAME=alpha\nPASSWORD=s3cret # note\n');
            mkdirSync(join(root, 'bots', 'folder'), { recursive: true });
            writeFileSync(join(root, 'bots', 'folder', 'bot.env'), 'BOT_USERNAME=beta\r\nPASSWORD=other\r\n');
            expect(findBotPassword('alpha', [root])).toBe('s3cret');
            expect(findBotPassword('beta', [root])).toBe('other');
            expect(findBotPassword('../alpha', [root])).toBeNull();
            const auth = botEnvAuth([root]);
            expect(auth({ kind: 'sdk', username: 'alpha', password: 's3cret' })).toEqual({ success: true });
            expect(auth({ kind: 'bot', username: 'alpha', password: 'wrong' })).toMatchObject({ success: false });
            expect(auth({ kind: 'http', username: 'alpha', password: '' })).toMatchObject({ success: false });
            expect(auth({ kind: 'bot', username: 'beta', password: 'other' })).toEqual({ success: true });
            expect(auth({ kind: 'bot', username: 'nobody', password: 'x' })).toMatchObject({ success: false });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
        expect(resolveAuthMode({}, '127.0.0.1')).toBe('none');
        expect(resolveAuthMode({}, '0.0.0.0')).toBe('botenv');
        expect(resolveAuthMode({ GATEWAY_AUTH: 'botenv' }, '127.0.0.1')).toBe('botenv');
        expect(resolveAuthMode({ GATEWAY_AUTH: 'none' }, '0.0.0.0')).toBe('none');
    });

    test('with an auth hook, an impostor "connected" cannot kick the real client', async () => {
        start({ auth: ({ password }) => (password === 'pw' ? { success: true } : { success: false, error: 'bad password' }) });
        const real = await bot('victim');
        const impostor = await peer();
        impostor.send({ type: 'connected', username: 'victim', password: 'guess', clientId: 'evil' });
        await impostor.closed;
        expect(impostor.messages[0]).toMatchObject({ type: 'error' });
        expect(real.messages.some(m => m.type === 'save_and_disconnect')).toBe(false);
        expect((await (await http('/status')).json()).bots.victim.clientId).toBe('victim-client');
    });
});

describe('gateway in-flight actions and session lifetime', () => {
    test('every action in flight is failed on takeover, not only the last one', async () => {
        start({ takeoverGraceMs: 5000, takeoverSettleMs: 20 });
        const oldBot = await bot('tbot', 'old');
        const s = await sdk();
        s.send({ type: 'sdk_action', username: 'tbot', actionId: 'walk', action: { type: 'stop' } });
        s.send({ type: 'sdk_action', username: 'tbot', actionId: 'say', action: { type: 'say', text: 'hi' } });
        await until(() => oldBot.messages.filter(m => m.type === 'action').length === 2, 'both actions at bot');
        const newBot = await peer();
        newBot.send({ type: 'connected', username: 'tbot', clientId: 'new' });
        await until(() => oldBot.messages.some(m => m.type === 'save_and_disconnect'), 'save_and_disconnect');
        oldBot.ws.close();
        await until(() => ['walk', 'say'].every(id => s.messages.some(m => m.type === 'sdk_error' && m.actionId === id)), 'both failed');
    });

    test("an observer's answered action does not hide the controller's pending one; results go to their sender", async () => {
        start({ takeoverGraceMs: 5000, takeoverSettleMs: 20 });
        const oldBot = await bot('tbot', 'old');
        const c = await sdk('tbot', 'control');
        const o = await sdk('tbot', 'observe');
        c.send({ type: 'sdk_action', username: 'tbot', actionId: 'walk', action: { type: 'stop' } });
        o.send({ type: 'sdk_action', username: 'tbot', actionId: 'obs-say', action: { type: 'say', text: 'hi' } });
        await until(() => oldBot.messages.filter(m => m.type === 'action').length === 2, 'both actions at bot');
        oldBot.send({ type: 'actionResult', actionId: 'obs-say', result: { success: true, message: 'said' } });
        await until(() => o.messages.some(m => m.type === 'sdk_action_result' && m.actionId === 'obs-say'), 'observer result');
        expect(c.messages.some(m => m.type === 'sdk_action_result')).toBe(false);
        const newBot = await peer();
        newBot.send({ type: 'connected', username: 'tbot', clientId: 'new' });
        await until(() => oldBot.messages.some(m => m.type === 'save_and_disconnect'), 'save_and_disconnect');
        oldBot.ws.close();
        await until(() => c.messages.some(m => m.type === 'sdk_error' && m.actionId === 'walk'), 'controller action failed');
        expect(o.messages.some(m => m.type === 'sdk_error' && m.actionId === 'walk')).toBe(false);
    });

    test('a client arriving in the takeover settle pause takes over instead of logging in beside the waiting one', async () => {
        start({ takeoverGraceMs: 5000, takeoverSettleMs: 300 });
        const a = await bot('tbot', 'A');
        const b = await peer();
        b.send({ type: 'connected', username: 'tbot', clientId: 'B' });
        await until(() => a.messages.some(m => m.type === 'save_and_disconnect'), 'A told to quit');
        a.ws.close();
        await a.closed;
        await pause(50);
        const c = await peer();
        c.send({ type: 'connected', username: 'tbot', clientId: 'C' });
        // B lost its place: told to quit (no reconnect) and closed, never told to log in.
        await b.closed;
        expect(b.messages.some(m => m.type === 'save_and_disconnect')).toBe(true);
        expect(b.messages.some(m => m.type === 'status')).toBe(false);
        expect(c.messages.some(m => m.type === 'status')).toBe(false);
        await until(() => c.messages.some(m => m.type === 'status'), 'C registered after the pause');
        expect((await (await http('/status')).json()).bots.tbot.clientId).toBe('C');
        c.send({ type: 'state', state: makeState({ tick: 42 }) });
        await until(async () => (await (await http('/state/tbot')).json()).state?.tick === 42, "C's state accepted");
    });

    test('dead sessions nobody watches are forgotten after the retention, with their chat', async () => {
        start({ deadSessionRetentionMs: 100 });
        const gone = await bot('gone');
        gone.send({ type: 'state', state: makeState({ gameMessages: [makeMessage(1, 'Ann says, "a"', { type: 'say', sender: 'Ann' })] }) });
        const kept = await bot('kept');
        const watcher = await sdk('kept', 'observe');
        await until(async () => (await (await http('/chat/gone')).json()).messages.length === 1, 'chat recorded');
        gone.ws.close();
        kept.ws.close();
        await until(async () => !('gone' in (await (await http('/status')).json()).bots), 'gone forgotten', 3000);
        expect((await (await http('/chat/gone')).json()).messages).toEqual([]);
        // Still watched by an SDK: kept.
        expect('kept' in (await (await http('/status')).json()).bots).toBe(true);
        watcher.ws.close();
        await until(async () => !('kept' in (await (await http('/status')).json()).bots), 'kept forgotten once unwatched', 3000);
    });

    test('distinct usernames are capped by evicting the longest-dead sessions', async () => {
        start({ maxBotSessions: 2 });
        const first = await bot('first');
        first.ws.close();
        await until(async () => (await (await http('/status/first')).json()).status === 'dead', 'first dead');
        await bot('second');
        await bot('third');
        const bots = Object.keys((await (await http('/status')).json()).bots).sort();
        expect(bots).toEqual(['second', 'third']);
    });
});

describe('repeatsLastFanout', () => {
    const state = (tick: number, revision: number, extra: Partial<BotWorldState> = {}) => makeState({ tick, revision, timestamp: revision * 1000, ...extra });
    test('a same-tick frame differing only in revision/timestamp is a repeat', () => {
        expect(repeatsLastFanout(state(10, 5), state(10, 6))).toBe(true);
    });
    test('content differences and new ticks go out', () => {
        expect(repeatsLastFanout(state(10, 5), state(10, 6, { inventory: [] }))).toBe(false);
        expect(repeatsLastFanout(state(10, 5), state(11, 6))).toBe(false);
        expect(repeatsLastFanout(null, state(10, 5))).toBe(false);
    });
    test('comparison leaves fields intact', () => {
        const a = state(10, 5);
        const b = state(10, 6);
        repeatsLastFanout(a, b);
        expect([a.revision, a.timestamp, b.revision, b.timestamp]).toEqual([5, 5000, 6, 6000]);
    });
});
