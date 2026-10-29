// GatewayBridge against a fake gateway (Bun.serve on port 0) and a fake DaocClient.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { ActionResult, BotAction, BotWorldState, ClientPhase } from '../sdk/types';
import { makeState } from '../sdk/test/fixtures';
import { GatewayBridge, type BridgeClient, type BridgeOptions } from './bridge';
import { botConfigFromEnv, BotConfigError, parseServer } from './bridge-config';
import { SessionError, type SessionEndReason } from './session';

type WS = ServerWebSocket<unknown>;

class FakeGateway {
    frames: any[] = [];
    sockets: WS[] = [];
    autoStatus = true;
    private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('no')),
        websocket: {
            open: ws => { this.sockets.push(ws); },
            message: (ws, data) => {
                const msg = JSON.parse(String(data));
                this.frames.push(msg);
                if (msg.type === 'connected' && this.autoStatus) ws.send(JSON.stringify({ type: 'status', status: 'Connected to gateway' }));
                for (const w of [...this.waiters]) {
                    if (w.pred(msg)) {
                        this.waiters = this.waiters.filter(x => x !== w);
                        w.resolve(msg);
                    }
                }
            },
            close: ws => { this.sockets = this.sockets.filter(s => s !== ws); },
        },
    });
    get url(): string {
        return `ws://127.0.0.1:${this.server.port}`;
    }
    get last(): WS {
        return this.sockets[this.sockets.length - 1]!;
    }
    send(msg: unknown, ws: WS = this.last): void {
        ws.send(JSON.stringify(msg));
    }
    of(type: string): any[] {
        return this.frames.filter(f => f.type === type);
    }
    next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
            this.waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
        });
    }
}

class FakeClient implements BridgeClient {
    phase: ClientPhase = 'disconnected';
    connectCalls = 0;
    quitCalls = 0;
    executed: BotAction[] = [];
    connectImpl: (n: number) => Promise<void> = async () => {};
    executeImpl: (a: BotAction) => Promise<ActionResult> = async a => ({ success: true, message: `ok ${a.type}`, phase: 'dispatch' });
    private tick = 0;
    private stateFns: Array<(s: BotWorldState) => void> = [];
    private endFns: Array<(reason: string, message: string) => void> = [];
    get inGame(): boolean {
        return this.phase === 'playing';
    }
    async connect(): Promise<void> {
        this.connectCalls++;
        this.phase = 'login';
        try {
            await this.connectImpl(this.connectCalls);
            this.phase = 'playing';
        } catch (e) {
            this.phase = 'disconnected';
            throw e;
        }
    }
    collectState(): BotWorldState {
        const s = makeState({ tick: ++this.tick, inGame: this.inGame });
        return { ...s, connection: { ...s.connection, phase: this.phase }, player: this.inGame ? s.player : null };
    }
    onStateChange(fn: (s: BotWorldState) => void): () => void {
        this.stateFns.push(fn);
        return () => { this.stateFns = this.stateFns.filter(f => f !== fn); };
    }
    onDisconnect(fn: (reason: string, message: string) => void): void {
        this.endFns.push(fn);
    }
    execute(a: BotAction): Promise<ActionResult> {
        this.executed.push(a);
        if (a.type === 'quit') setTimeout(() => this.end('quit'), 10);
        return this.executeImpl(a);
    }
    async quit(): Promise<void> {
        this.quitCalls++;
        this.phase = 'quitting';
        await Bun.sleep(50);
        this.end('quit');
    }
    disconnect(): void {
        this.end('clientClosed');
    }
    publish(): void {
        const s = this.collectState();
        for (const fn of this.stateFns) fn(s);
    }
    end(reason: SessionEndReason): void {
        this.phase = 'disconnected';
        for (const fn of this.endFns) fn(reason, reason);
    }
}

const gateways: FakeGateway[] = [];
const bridges: GatewayBridge[] = [];
afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop('test cleanup');
    for (const g of gateways.splice(0)) g.server.stop(true);
});

function setup(opts: Partial<BridgeOptions> = {}, client = new FakeClient()) {
    const gw = new FakeGateway();
    gateways.push(gw);
    const bridge = new GatewayBridge(client, {
        gatewayUrl: gw.url, username: 'tbot', password: 'pw', log: () => {},
        reconnectMinMs: 50, reconnectMaxMs: 200, lockoutBackoffMs: 150, loginRetryMs: 50, heartbeatMs: 100,
        ...opts,
    });
    bridges.push(bridge);
    return { gw, client, bridge };
}

const until = async (cond: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('condition not met');
        await Bun.sleep(10);
    }
};

describe('GatewayBridge', () => {
    test('registers, waits for status before logging in, then publishes state', async () => {
        const { gw, client, bridge } = setup();
        gw.autoStatus = false;
        void bridge.run();
        const connected = await gw.next(m => m.type === 'connected');
        expect(connected).toMatchObject({ username: 'tbot', password: 'pw', maxMessageLength: 200 });
        await Bun.sleep(150);
        expect(client.connectCalls).toBe(0);
        expect(gw.of('state')).toHaveLength(0); // not registered yet: nothing published
        gw.send({ type: 'status', status: 'Connected to gateway' });
        await gw.next(m => m.type === 'state' && m.state.inGame);
        expect(client.connectCalls).toBe(1);
        client.publish();
        await gw.next(m => m.type === 'state');
    });

    test('action → execute → actionResult, then a fresh state', async () => {
        const { gw, client, bridge } = setup();
        void bridge.run();
        await gw.next(m => m.type === 'state' && m.state.inGame);
        gw.send({ type: 'action', action: { type: 'say', text: 'hi' }, actionId: 'a1', actionTimeoutMs: 30_000 });
        const result = await gw.next(m => m.type === 'actionResult');
        expect(result).toMatchObject({ actionId: 'a1', result: { success: true, message: 'ok say' } });
        const i = gw.frames.indexOf(result);
        await until(() => gw.frames.slice(i + 1).some(f => f.type === 'state'));
        expect(client.executed).toEqual([{ type: 'say', text: 'hi' }]);
    });

    test('actions run one at a time; a queued one past its deadline expires', async () => {
        const { gw, client, bridge } = setup();
        let release!: () => void;
        client.executeImpl = async a => {
            if (a.type === 'wait') await new Promise<void>(r => { release = r; });
            return { success: true, message: a.type, phase: 'completion' };
        };
        void bridge.run();
        await gw.next(m => m.type === 'state' && m.state.inGame);
        gw.send({ type: 'action', action: { type: 'wait', ms: 1 }, actionId: 'slow', actionTimeoutMs: 30_000 });
        gw.send({ type: 'action', action: { type: 'stop' }, actionId: 'late', actionTimeoutMs: 1200 });
        const expired = await gw.next(m => m.type === 'actionResult' && m.actionId === 'late');
        expect(expired.result).toMatchObject({ success: false, reason: 'queue_expired' });
        release();
        const slow = await gw.next(m => m.type === 'actionResult' && m.actionId === 'slow');
        expect(slow.result.success).toBe(true);
        expect(client.executed.map(a => a.type)).toEqual(['wait']);
    });

    test('heartbeat keeps publishing while not in game', async () => {
        const { gw, client, bridge } = setup({ stopLoginWaitMs: 50 });
        client.connectImpl = () => new Promise(() => {}); // login never finishes
        void bridge.run();
        await gw.next(m => m.type === 'state');
        await until(() => gw.of('state').length >= 3, 2000);
        expect(gw.of('state').every(f => f.state.inGame === false)).toBe(true);
        expect(gw.of('state').at(-1).state.connection.phase).toBe('login');
    });

    test('gateway drop: reconnects with backoff and keeps the DAoC session', async () => {
        const { gw, client, bridge } = setup();
        void bridge.run();
        await gw.next(m => m.type === 'state' && m.state.inGame);
        gw.last.close();
        await gw.next(m => m.type === 'connected');
        await gw.next(m => m.type === 'state');
        expect(gw.of('connected')).toHaveLength(2);
        expect(client.connectCalls).toBe(1);
        expect(client.quitCalls).toBe(0);
    });

    test('save_and_disconnect: clean quit, gateway closed after the quit, exit 0, no reconnect', async () => {
        const { gw, client, bridge } = setup();
        const exited = bridge.run();
        await gw.next(m => m.type === 'state' && m.state.inGame);
        const ws = gw.last;
        gw.send({ type: 'save_and_disconnect', reason: 'New session connecting' }, ws);
        await Bun.sleep(20);
        expect(gw.sockets).toContain(ws); // still open while quitting
        const exit = await exited;
        expect(exit).toEqual({ code: 0, reason: 'save_and_disconnect' });
        expect(client.quitCalls).toBe(1);
        await Bun.sleep(150);
        expect(gw.sockets).toHaveLength(0);
        expect(gw.of('connected')).toHaveLength(1);
    });

    test('0x2C code 0x11: backs off, reports it in state, then logs in', async () => {
        const { gw, client, bridge } = setup();
        client.connectImpl = async n => {
            if (n === 1) throw new SessionError('accountInLogout', 'login denied: AccountIsInLogoutProcedure', 0x11);
        };
        void bridge.run();
        const backoff = await gw.next(m => m.type === 'state' && /retrying login/.test(m.state.connection.lastError ?? ''));
        expect(backoff.state.connection.lastError).toContain('AccountIsInLogoutProcedure');
        expect(client.connectCalls).toBe(1);
        await gw.next(m => m.type === 'state' && m.state.inGame);
        expect(client.connectCalls).toBe(2);
    });

    test('fatal login errors exit 2; transient ones give up after maxLoginAttempts with 1', async () => {
        const a = setup();
        a.client.connectImpl = async () => { throw new SessionError('loginDenied', 'login denied: WrongPassword', 0x01); };
        expect((await a.bridge.run()).code).toBe(2);
        expect(a.client.connectCalls).toBe(1);

        const b = setup({ maxLoginAttempts: 3 });
        b.client.connectImpl = async () => { throw new SessionError('connectFailed', 'connect refused'); };
        expect(await b.bridge.run()).toMatchObject({ code: 1 });
        expect(b.client.connectCalls).toBe(3);
    });

    test('AccountAlreadyLoggedIn (0x0B, another client still quitting) is retried, not fatal', async () => {
        const { gw, client, bridge } = setup();
        client.connectImpl = async n => {
            if (n === 1) throw new SessionError('loginDenied', 'login denied: AccountAlreadyLoggedIn', 0x0b);
        };
        void bridge.run();
        await gw.next(m => m.type === 'state' && m.state.inGame);
        expect(client.connectCalls).toBe(2);
        expect(bridge.lastExit).toBeNull();
    });

    test('unexpected session end exits 1; with relogin it logs in again', async () => {
        const a = setup();
        const exited = a.bridge.run();
        await a.gw.next(m => m.type === 'state' && m.state.inGame);
        a.client.end('serverClosed');
        expect(await exited).toMatchObject({ code: 1 });

        const b = setup({ relogin: true });
        void b.bridge.run();
        await b.gw.next(m => m.type === 'state' && m.state.inGame);
        b.client.end('serverClosed');
        await until(() => b.client.connectCalls === 2 && b.client.inGame);
        expect(b.bridge.logins).toBe(2);
    });

    test('a quit action ends the bridge with 0', async () => {
        const { gw, client, bridge } = setup();
        const exited = bridge.run();
        await gw.next(m => m.type === 'state' && m.state.inGame);
        gw.send({ type: 'action', action: { type: 'quit' }, actionId: 'q', actionTimeoutMs: 10_000 });
        expect(await exited).toEqual({ code: 0, reason: 'quit' });
        expect(gw.of('actionResult')[0]).toMatchObject({ actionId: 'q', result: { success: true } });
        expect(client.quitCalls).toBe(1);
    });

    test('a quit action during the lockout back-off also ends the bridge', async () => {
        const { gw, client, bridge } = setup({ lockoutBackoffMs: 60_000 });
        client.connectImpl = async () => { throw new SessionError('accountInLogout', 'login denied: AccountIsInLogoutProcedure', 0x11); };
        const exited = bridge.run();
        await gw.next(m => m.type === 'state' && /retrying/.test(m.state.connection.lastError ?? ''));
        gw.send({ type: 'action', action: { type: 'quit' }, actionId: 'q', actionTimeoutMs: 10_000 });
        expect(await exited).toEqual({ code: 0, reason: 'quit' });
        expect(client.connectCalls).toBe(1);
    });

    test('the character logging out some other way (a &quit command) ends the bridge with 0', async () => {
        const { gw, client, bridge } = setup();
        const exited = bridge.run();
        await gw.next(m => m.type === 'state' && m.state.inGame);
        client.end('quit');
        expect(await exited).toEqual({ code: 0, reason: 'quit' });
    });

    test('a server kick to the character screen (unrequested 0xA4) is not a quit: relogin logs in again', async () => {
        const a = setup();
        const exited = a.bridge.run();
        await a.gw.next(m => m.type === 'state' && m.state.inGame);
        a.client.end('kicked');
        expect(await exited).toMatchObject({ code: 1, reason: expect.stringContaining('kicked') });

        const b = setup({ relogin: true });
        void b.bridge.run();
        await b.gw.next(m => m.type === 'state' && m.state.inGame);
        b.client.end('kicked');
        await until(() => b.client.connectCalls === 2 && b.client.inGame);
        expect(b.bridge.logins).toBe(2);
    });

    test('stop() during the lockout back-off does not log in again', async () => {
        const { gw, client, bridge } = setup({ lockoutBackoffMs: 60_000 });
        client.connectImpl = async () => { throw new SessionError('accountInLogout', 'login denied: AccountIsInLogoutProcedure', 0x11); };
        const exited = bridge.run();
        await gw.next(m => m.type === 'state' && /retrying/.test(m.state.connection.lastError ?? ''));
        const exit = await bridge.stop('SIGINT');
        expect(exit).toEqual({ code: 0, reason: 'SIGINT' });
        expect(await exited).toBe(exit);
        expect(client.connectCalls).toBe(1);
        expect(client.quitCalls).toBe(0);
    });

    test('stop() during a region change or an under-way quit quits cleanly instead of dropping the socket', async () => {
        for (const phase of ['regionChange', 'quitting'] as const) {
            const { gw, client, bridge } = setup();
            let disconnects = 0;
            client.disconnect = () => { disconnects++; client.end('clientClosed'); };
            void bridge.run();
            await gw.next(m => m.type === 'state' && m.state.inGame);
            client.phase = phase; // inGame is false in both
            const exit = await bridge.stop('SIGINT');
            expect(exit.code).toBe(0);
            expect(client.quitCalls).toBe(1);
            expect(disconnects).toBe(0);
        }
    });

    test('stop() mid-login waits for the login, then quits', async () => {
        const { gw, client, bridge } = setup();
        client.connectImpl = () => Bun.sleep(200);
        void bridge.run();
        await gw.next(m => m.type === 'state');
        await until(() => client.phase === 'login');
        const exit = await bridge.stop('SIGTERM');
        expect(exit.code).toBe(0);
        expect(client.quitCalls).toBe(1);
    });
});

describe('bot.env config', () => {
    test('defaults, validation and gender resolution', () => {
        const c = botConfigFromEnv('run9', { BOT_USERNAME: 'run9', PASSWORD: 'x' });
        expect(c).toMatchObject({ username: 'run9', charName: 'Runj', realm: 'albion', className: 'Fighter', raceName: 'Briton', gender: 0, host: '127.0.0.1', port: 10300, showChat: true });
        expect(botConfigFromEnv('v', { PASSWORD: 'x', REALM: 'midgard', CLASS: 'Viking', RACE: 'Kobold', GENDER: 'female', SERVER: 'localhost:10301' }))
            .toMatchObject({ realm: 'midgard', gender: 1, host: 'localhost', port: 10301 });
        expect(() => botConfigFromEnv('b', { PASSWORD: 'x', REALM: 'hibernia', CLASS: 'Bainshee', RACE: 'Elf' })).toThrow(BotConfigError);
        expect(() => botConfigFromEnv('b', { PASSWORD: 'x', CHAR_NAME: 'bad1' })).toThrow(/CHAR_NAME/);
        expect(() => botConfigFromEnv('b', {})).toThrow(/PASSWORD/);
        expect(parseServer('[::1]:10300')).toEqual({ host: '::1', port: 10300 });
    });
});
