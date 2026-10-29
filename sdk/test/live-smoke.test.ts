// In-process smoke: real gateway on a random port, a fake client publishing
// fabricated BotWorldState, and real BotSDKs over WebSocket.

import { afterEach, describe, expect, test } from 'bun:test';
import { createGateway, type Gateway } from '../../gateway/gateway';
import { BotSDK } from '../index';
import { FakeClient } from './fake-client';

let gateway: Gateway | null = null;
const clients: FakeClient[] = [];
const sdks: BotSDK[] = [];

afterEach(async () => {
    for (const s of sdks.splice(0)) await s.disconnect().catch(() => {});
    for (const c of clients.splice(0)) c.stop();
    await gateway?.stop();
    gateway = null;
});

function setup(opts: { maxMessageLength?: number; takeoverGraceMs?: number } = {}) {
    gateway = createGateway({ port: 0, hostname: '127.0.0.1', quiet: true, takeoverGraceMs: opts.takeoverGraceMs ?? 5000, takeoverSettleMs: 20 });
    const url = `ws://127.0.0.1:${gateway.port}`;
    const client = new FakeClient(url, 'smokebot', { publishMs: 50, maxMessageLength: opts.maxMessageLength });
    clients.push(client);
    const makeSdk = (mode: 'control' | 'observe' = 'control') => {
        const sdk = new BotSDK({ botUsername: 'smokebot', password: 'pw', gatewayUrl: url, connectionMode: mode, readyTimeout: 3000, actionTimeout: 2000, autoReconnect: false });
        sdks.push(sdk);
        return sdk;
    };
    return { url, client, makeSdk };
}

describe('live smoke: gateway + fake client + BotSDK', () => {
    test('state arrives, waits work and an action round-trips', async () => {
        const { client, makeSdk } = setup();
        await client.start();
        const sdk = makeSdk();
        await sdk.connect();
        expect(sdk.isAuthenticated()).toBe(true);
        expect(sdk.getState()?.inGame).toBe(true);
        expect(sdk.getPlayer()?.name).toBe('Smokebot');
        const before = sdk.getState()!.tick;
        await sdk.waitForTicks(2);
        expect(sdk.getState()!.tick).toBeGreaterThanOrEqual(before + 2);

        const result = await sdk.sendMoveTo(561000, 512000, 2600);
        expect(result).toMatchObject({ success: true, message: 'Moving to (561000, 512000)' });
        expect(client.actions.at(-1)).toMatchObject({ type: 'moveTo', x: 561000, y: 512000, z: 2600 });
        const moved = await sdk.waitForCondition(s => s.player?.x === 561000, 2000);
        expect(moved.player?.y).toBe(512000);
        expect(sdk.getStateAge()).toBeLessThan(2000);
    });

    test('say() chunks by the client-reported max length and waitForChat sees replies', async () => {
        const { client, makeSdk } = setup({ maxMessageLength: 12 });
        await client.start();
        const sdk = makeSdk();
        await sdk.connect();
        expect(sdk.maxMessageLength).toBe(12);
        const results = await sdk.say('hello there my friend', { delayMs: 10 });
        expect(results.every(r => r.success)).toBe(true);
        expect(client.actions.filter(a => a.type === 'say').map(a => (a as any).text)).toEqual(['hello there', 'my friend']);
        expect(client.actions.some(a => a.type === 'wait')).toBe(true);

        const reply = sdk.waitForChat({ from: 'Ann', timeout: 2000 });
        client.addMessage('Ann says, "hi back"', 'say', 'Ann');
        expect((await reply)?.text).toBe('Ann says, "hi back"');
        expect(sdk.getChat().map(m => m.sender)).toEqual(['Ann']);
        expect(sdk.getChat({ includeSelf: true }).length).toBe(3);
    });

    test('observe mode: chat goes through, everything else is refused', async () => {
        const { client, makeSdk } = setup();
        await client.start();
        const controller = makeSdk('control');
        await controller.connect();
        const observer = makeSdk('observe');
        await observer.connect();
        expect(observer.getState()).not.toBeNull();

        expect(await observer.sendSay('from observer')).toMatchObject({ success: true });
        expect(await observer.sendSend('Ann', 'psst')).toMatchObject({ success: true });
        expect(await observer.sendAttack()).toMatchObject({ success: false, reason: 'observe_mode' });
        // Bypass the SDK's local check: the gateway refuses too.
        (observer.config as any).connectionMode = 'control';
        const raw = await observer.sendStop();
        (observer.config as any).connectionMode = 'observe';
        expect(raw).toMatchObject({ success: false, reason: 'error' });
        expect(raw.message).toContain("Observe mode can only send 'say' or 'send'");
        expect(client.actions.map(a => a.type)).toEqual(['say', 'send']);
        expect(controller.isConnected()).toBe(true);
    });

    test('a second controller pre-empts the first', async () => {
        const { client, makeSdk } = setup();
        await client.start();
        const first = makeSdk();
        await first.connect();
        const second = makeSdk();
        await second.connect();
        await new Promise(r => setTimeout(r, 100));
        expect(first.isConnected()).toBe(false);
        expect(second.isConnected()).toBe(true);
        expect((await second.sendStop()).success).toBe(true);
    });

    test('bot status, takeover and a client that never answers', async () => {
        const { url, client, makeSdk } = setup();
        await client.start();
        const sdk = makeSdk();
        await sdk.connect();
        expect(await sdk.checkBotStatus()).toMatchObject({ status: 'active', inGame: true, controllers: [expect.any(String)] });

        const replacement = new FakeClient(url, 'smokebot', { publishMs: 50, onAction: () => new Promise(() => {}) as never });
        clients.push(replacement);
        await replacement.start();
        await new Promise(r => setTimeout(r, 200));
        expect(client.savedAndDisconnected).toBe(true);
        const status = await sdk.checkBotStatus();
        expect(status.status).toBe('active');
        // The replacement swallows actions: the SDK reports a timeout instead of throwing.
        const result = await sdk.sendStop();
        expect(result).toMatchObject({ success: false, reason: 'timeout', phase: 'dispatch' });
        expect(replacement.actions.map(a => a.type)).toEqual(['stop']);
    });

    test('an action in flight when the client dies fails as disconnected, not at the timeout', async () => {
        const { url, makeSdk } = setup();
        const silent = new FakeClient(url, 'smokebot', { publishMs: 50, onAction: () => new Promise(() => {}) as never });
        clients.push(silent);
        await silent.start();
        const sdk = makeSdk();
        (sdk.config as any).actionTimeout = 30_000;
        await sdk.connect();
        const pending = sdk.sendStop();
        await new Promise(r => setTimeout(r, 100));
        const started = Date.now();
        silent.stop();
        expect(await pending).toMatchObject({ success: false, reason: 'disconnected', phase: 'dispatch' });
        expect(Date.now() - started).toBeLessThan(2000);
    });

    test('connect without any client resolves (readyTimeout) and status is dead', async () => {
        const { makeSdk } = setup();
        const sdk = new BotSDK({ botUsername: 'nobody', gatewayUrl: `ws://127.0.0.1:${gateway!.port}`, readyTimeout: 100, autoReconnect: false });
        sdks.push(sdk);
        await sdk.connect();
        expect(sdk.isAuthenticated()).toBe(true);
        expect(sdk.getState()).toBeNull();
        expect((await sdk.checkBotStatus()).status).toBe('dead');
        expect(await sdk.sendStop()).toMatchObject({ success: false, message: 'Bot not connected' });
        void makeSdk;
    });

    test('an unreachable gateway: status unknown, connect rejects', async () => {
        const sdk = new BotSDK({ botUsername: 'x', gatewayUrl: 'ws://127.0.0.1:1', autoReconnect: false, connectTimeout: 2000 });
        expect((await sdk.checkBotStatus()).status).toBe('unknown');
        await expect(sdk.connect()).rejects.toThrow();
        await sdk.disconnect();
    });
});
