import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type Gateway, type GatewayOptions } from '../gateway';
import { makeState } from '../../sdk/test/fixtures';
import { conColor, conLevel } from './con-level';
import { authHeaders, REGION_RETRY_MS, shouldLoadRegion } from './logic';
import { buildAppBundle } from './routes';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let gateway: Gateway | null = null;
const sockets: WebSocket[] = [];

function start(options: GatewayOptions = {}): Gateway {
    gateway = createGateway({ port: 0, hostname: '127.0.0.1', quiet: true, ...options });
    return gateway;
}

afterEach(async () => {
    for (const ws of sockets.splice(0)) try { ws.close(); } catch {}
    await gateway?.stop();
    gateway = null;
});

const http = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${gateway!.port}${path}`, init);

async function attachBot(username: string, state = makeState()) {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway!.port}`);
    sockets.push(ws);
    const messages: any[] = [];
    ws.onmessage = ev => messages.push(JSON.parse(String(ev.data)));
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    ws.send(JSON.stringify({ type: 'connected', username, clientId: `${username}-client` }));
    for (let i = 0; i < 100 && !messages.some(m => m.type === 'status'); i++) await pause(10);
    ws.send(JSON.stringify({ type: 'state', state }));
    await pause(50);
    return ws;
}

describe('viewer routes', () => {
    test('GET /bots lists bot sessions with player summary', async () => {
        start();
        expect(await (await http('/bots')).json()).toEqual({ bots: [] });
        await attachBot('vbot');
        const { bots } = await (await http('/bots')).json() as { bots: any[] };
        expect(bots).toHaveLength(1);
        expect(bots[0]).toMatchObject({
            username: 'vbot', status: 'active', inGame: true, clientId: 'vbot-client', tick: 1, phase: 'playing',
            player: { name: 'Testbot', level: 5, className: 'Fighter', realm: 'albion', regionId: 1 },
            controllers: 0, observers: 0,
        });
        expect(typeof bots[0].stateAge).toBe('number');
    });

    test('GET /viewer and /viewer/<bot> serve HTML, bot name escaped', async () => {
        start();
        const index = await http('/viewer');
        expect(index.status).toBe(200);
        expect(index.headers.get('content-type')).toContain('text/html');
        expect(await index.text()).toContain('/bots');

        const page = await http('/viewer/vbot');
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain('data-bot="vbot"');
        expect(html).toContain('/viewer/assets/app.js');

        const evil = await (await http(`/viewer/${encodeURIComponent('<x>"')}`)).text();
        expect(evil).not.toContain('<x>');
        expect(evil).toContain('&lt;x&gt;&quot;');
    });

    test('GET /viewer/assets serves the bundled app and css', async () => {
        start();
        const js = await http('/viewer/assets/app.js');
        expect(js.status).toBe(200);
        expect(js.headers.get('content-type')).toContain('javascript');
        const text = await js.text();
        expect(text).toContain('sdk_connect');
        expect(text).not.toContain('import ');
        const css = await http('/viewer/assets/viewer.css');
        expect(css.status).toBe(200);
        expect(css.headers.get('content-type')).toContain('text/css');
        expect((await http('/viewer/assets/nope.js')).status).toBe(404);
    }, 20_000);

    test('GET /zones/<regionId> returns zone rects for the region', async () => {
        start();
        const body = await (await http('/zones/1')).json() as any;
        expect(body.regionId).toBe(1);
        expect(body.zones.length).toBeGreaterThan(0);
        const hills = body.zones.find((z: any) => /Camelot Hills/i.test(z.name));
        expect(hills).toBeDefined();
        expect(hills.width).toBeGreaterThan(0);
        expect(hills.width % 8192).toBe(0);
        expect(Array.isArray(body.zonePoints)).toBe(true);
        expect(Array.isArray(body.bindpoints)).toBe(true);
        expect((await (await http('/zones/99999')).json() as any).zones).toEqual([]);
    }, 30_000);

    test('POST /bots/<bot>/auth requires a password and honours the auth hook', async () => {
        start({ auth: ({ password }) => (password === 'right' ? { success: true } : { success: false, error: 'bad password' }) });
        const post = (password?: string) => http('/bots/nobotenv/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
        const none = await post('');
        expect(none.status).toBe(401);
        expect((await none.json() as any).error).toMatch(/required/i);
        const wrong = await post('wrong');
        expect(wrong.status).toBe(401);
        expect((await wrong.json() as any).error).toBe('bad password');
        expect((await post('right')).status).toBe(200);
    });

    test('non-viewer routes still reach the gateway', async () => {
        start();
        expect((await (await http('/status')).json() as any).service).toBe('daoc-sdk gateway');
        expect((await http('/state/nobody')).status).toBe(404);
    });

    test('an observe-mode viewer socket receives state', async () => {
        start();
        await attachBot('vbot');
        const ws = new WebSocket(`ws://127.0.0.1:${gateway!.port}`);
        sockets.push(ws);
        const messages: any[] = [];
        ws.onmessage = ev => messages.push(JSON.parse(String(ev.data)));
        await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
        ws.send(JSON.stringify({ type: 'sdk_connect', username: 'vbot', clientId: 'viewer-observe', mode: 'observe' }));
        for (let i = 0; i < 100 && !messages.some(m => m.type === 'sdk_state'); i++) await pause(10);
        expect(messages.find(m => m.type === 'sdk_state')?.state.player.name).toBe('Testbot');
        const { bots } = await (await http('/bots')).json() as { bots: any[] };
        expect(bots[0].observers).toBe(1);
    });
});

describe('con colours (ConLevelGrid.cs)', () => {
    test('matches the server grid', () => {
        // Level 1 has no grey: L0 is green.
        expect(conLevel(1, 0)).toBe(-1);
        expect(conLevel(1, 1)).toBe(0);
        expect(conLevel(1, 2)).toBe(1);
        expect(conLevel(1, 3)).toBe(2);
        expect(conLevel(1, 4)).toBe(3);
        // Level 10: grey 0-6, green 7, blue 8-9, yellow 10, orange 11, red 12-13, purple 14+.
        expect([6, 7, 8, 9, 10, 11, 12, 13, 14].map(l => conLevel(10, l))).toEqual([-3, -2, -1, -1, 0, 1, 2, 2, 3]);
        // Level 50: grey 0-35, green 36-40, blue 41-45, yellow 46-50, orange 51-55, red 56-60, purple 61+.
        expect([35, 36, 41, 46, 50, 51, 56, 60, 61].map(l => conLevel(50, l))).toEqual([-3, -2, -1, 0, 0, 1, 2, 2, 3]);
        // Past 50 the grey span grows by one per level.
        expect(conLevel(51, 36)).toBe(-3);
        expect(conLevel(51, 37)).toBe(-2);
        expect(conColor(5, 5)).toBe('yellow');
        expect(conColor(5, 1)).toBe('grey');
        expect(conColor(5, 20)).toBe('purple');
        expect(conColor(NaN, 3)).toBe('yellow');
    });
});

describe('viewer page logic', () => {
    test('region zone data: no refetch storm after a failure, retry after the backoff', () => {
        expect(shouldLoadRegion(1, null, null, null, 0)).toBe(true);
        expect(shouldLoadRegion(1, 1, null, null, 0)).toBe(false);
        expect(shouldLoadRegion(1, null, 1, null, 0)).toBe(false);
        const failure = { regionId: 1, at: 1000 };
        expect(shouldLoadRegion(1, null, null, failure, 1000 + 200)).toBe(false);
        expect(shouldLoadRegion(1, null, null, failure, 1000 + REGION_RETRY_MS)).toBe(true);
        // A failure for another region does not hold back a region change.
        expect(shouldLoadRegion(2, 1, null, failure, 1200)).toBe(true);
        expect(shouldLoadRegion(2, 1, 1, null, 1200)).toBe(true);
    });

    test('polling fallback passes the typed password to an auth-hooked /state', async () => {
        start({ auth: ({ kind, password }) => (kind === 'bot' || password === 'pw' ? { success: true } : { success: false, error: 'bad password' }) });
        await attachBot('vbot');
        expect((await http('/state/vbot')).status).toBe(401);
        expect(authHeaders('')).toEqual({});
        const res = await http('/state/vbot', { headers: authHeaders('pw') });
        expect(res.status).toBe(200);
        expect((await res.json() as any).state.player.name).toBe('Testbot');
    });

    test('the app bundle is rebuilt when any imported viewer module changes', async () => {
        // A private copy: touching the real sources would race other test runs in this checkout.
        const dir = mkdtempSync(join(tmpdir(), 'daoc-viewer-'));
        try {
            for (const file of readdirSync(import.meta.dir)) {
                if (file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'routes.ts') copyFileSync(join(import.meta.dir, file), join(dir, file));
            }
            const logic = join(dir, 'logic.ts');
            const app = join(dir, 'app.ts');
            await buildAppBundle(dir);
            const build = spyOn(Bun, 'build');
            try {
                expect(await buildAppBundle(dir)).toContain('REGION_RETRY_MS');
                expect(build).toHaveBeenCalledTimes(0);
                // A future-dated module...
                utimesSync(logic, new Date(), new Date(Date.now() + 60_000));
                await buildAppBundle(dir);
                expect(build).toHaveBeenCalledTimes(1);
                // ...does not hide a later edit to another one.
                utimesSync(app, new Date(), new Date(Date.now() - 60_000));
                await buildAppBundle(dir);
                expect(build).toHaveBeenCalledTimes(2);
            } finally {
                build.mockRestore();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
