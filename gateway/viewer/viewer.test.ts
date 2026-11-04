import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type Gateway, type GatewayOptions } from '../gateway';
import { makeNpc, makeState } from '../../sdk/test/fixtures';
import { conColor, conLevel } from './con-level';
import {
    appendBySeq, canWindDown, ccSeen, conReference, contactAim, contactListed, deathContext, enemyTags, eventVisible, gatewayRestarted, isGroupFrame, isThreat,
    contactLine, listedContacts, logLineKind, mapLabel, mapRegion, memberPetRow, memberRealms, mergeEvents, npcShown, petLine, petSide, petTitle, phaseClass, retryRuns, roleLetter, runFailed, runPill, runRegion, timeLeft,
    type FeedFilters,
} from './group-logic';
import { authHeaders, enemyAims, enemyHeading, enemyWord, isOwnPet, petPanel, REGION_RETRY_MS, shouldLoadRegion, unseenTarget } from './logic';
import { buildAppBundle, buildBundle } from './routes';
import { drawPass } from './ui-kit';
import type { GroupMemberView, MemberPlayer, PassiveEvent, RunView, WorldContact } from '../group-types';
import type { RunMeta, WireEvent } from '../../sdk/group/wire';
import type { PetReport } from '../../sdk/group/types';
import type { PetState } from '../../sdk/types';

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
        const indexHtml = await index.text();
        expect(indexHtml).toContain('/bots');
        expect(indexHtml).toContain('/groups');

        const page = await http('/viewer/vbot');
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain('data-bot="vbot"');
        expect(html).toContain('/viewer/assets/app.js');

        const evil = await (await http(`/viewer/${encodeURIComponent('<x>"')}`)).text();
        expect(evil).not.toContain('<x>');
        expect(evil).toContain('&lt;x&gt;&quot;');
    });

    test('GET /viewer/group/<id> serves the group page; /viewer/group alone stays a bot page', async () => {
        start();
        const page = await http('/viewer/group/alpha_1-B');
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toContain('text/html');
        const html = await page.text();
        expect(html).toContain('data-group="alpha_1-B"');
        expect(html).toContain('/viewer/assets/group.js');
        expect(html).not.toContain('{{GROUP}}');
        expect((await http('/viewer/group/alpha/')).status).toBe(200);
        // Group ids are letters, digits, _ and -, so nothing that needs escaping reaches the page.
        for (const bad of [encodeURIComponent('<x>"'), 'a%22b', 'a'.repeat(65), 'a/b']) {
            const res = await http(`/viewer/group/${bad}`);
            expect(res.status).toBe(404);
            expect(await res.text()).not.toContain('<x>');
        }
        const bot = await (await http('/viewer/group')).text();
        expect(bot).toContain('data-bot="group"');
        expect(bot).toContain('/viewer/assets/app.js');
        expect(bot).toContain('id="grouplink"');
    });

    test('GET /viewer/assets/group.js bundles the group page with no imports and no sockets', async () => {
        start();
        const js = await http('/viewer/assets/group.js');
        expect(js.status).toBe(200);
        expect(js.headers.get('content-type')).toContain('javascript');
        const text = await js.text();
        expect(text).toContain('/groups/');
        expect(text).not.toContain('import ');
        // Observe-only by construction: the page opens no socket, so it can never pre-empt a member's controller.
        expect(text).not.toContain('WebSocket');
        expect(text).not.toContain('sdk_connect');
    }, 20_000);

    test('GET /viewer/region/<id> serves the region page; /viewer/region alone stays a bot page', async () => {
        start();
        const page = await http('/viewer/region/252');
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toContain('text/html');
        const html = await page.text();
        expect(html).toContain('data-region="252"');
        expect(html).toContain('/viewer/assets/region.js');
        expect(html).not.toContain('{{REGION}}');
        expect(await (await http('/viewer/region/0252/')).text()).toContain('data-region="252"');
        // Region ids are digits only, so nothing that needs escaping reaches the page.
        for (const bad of ['abc', encodeURIComponent('<x>"'), '1'.repeat(10), '252/x']) {
            const res = await http(`/viewer/region/${bad}`);
            expect(res.status).toBe(404);
            expect(await res.text()).not.toContain('<x>');
        }
        expect(await (await http('/viewer/region')).text()).toContain('data-bot="region"');
    });

    test('GET /viewer/assets/region.js bundles the region page with no imports and no sockets', async () => {
        start();
        const js = await http('/viewer/assets/region.js');
        expect(js.status).toBe(200);
        expect(js.headers.get('content-type')).toContain('javascript');
        const text = await js.text();
        expect(text).toContain('/regions/');
        expect(text).not.toContain('import ');
        // Observe-only by construction, like the group page: no socket, so it can never pre-empt a controller.
        expect(text).not.toContain('WebSocket');
        expect(text).not.toContain('sdk_connect');
        // Bun's bundle prints strings in double quotes: match either quote style.
        expect(text).not.toMatch(/method:\s*["']POST["']/);
    }, 20_000);

    test('GET /regions and /regions/<id>/live: the region\'s in-game bots; an auth hook shows only those the bearer password opens', async () => {
        start({ auth: ({ kind, password }) => (kind === 'bot' || password === 'pw' ? { success: true } : { success: false, error: 'bad password' }) });
        expect(await (await http('/regions')).json()).toEqual({ regions: [] });
        await attachBot('vbot');
        // No more than /bots says, so no password.
        expect(await (await http('/regions')).json()).toEqual({ regions: [{ regionId: 1, zones: ['Camelot Hills'], bots: 1, realms: { albion: 1 }, groups: [] }] });
        const hidden = await http('/regions/1/live');
        expect(hidden.status).toBe(200);
        expect(hidden.headers.get('content-type')).toContain('application/json');
        expect(await hidden.json()).toMatchObject({ v: 1, regionId: 1, layout: null, bots: [], runs: [], enemies: [], keeps: [], hidden: { bots: 1, runs: 0 } });
        // Never a password from the query string.
        expect((await (await http('/regions/1/live?password=pw')).json() as any).hidden.bots).toBe(1);
        const shown = await (await http('/regions/1/live', { headers: authHeaders('pw') })).json() as any;
        expect(shown.hidden).toEqual({ bots: 0, runs: 0 });
        expect(shown.bots).toHaveLength(1);
        expect(shown.bots[0]).toMatchObject({ username: 'vbot', name: 'Testbot', realm: 'albion', status: 'active', x: 560000, y: 511000 });
        // makeState's nearby player is an Albion stranger: same realm, so no enemy marker.
        expect(shown.enemies).toEqual([]);
        const bg = await (await http('/regions/252/live')).json() as any;
        expect(bg.layout).toEqual({ name: 'Thidranki', levels: [20, 24] });
        expect(bg.keeps.map((k: any) => k.name)).toEqual(['Thidranki Faste', 'Hibernia Portal Keep', 'Midgard Portal Keep', 'Albion Portal Keep']);
        expect(bg.keeps[0].clearance).toBe(3000);
        expect(bg.bots).toEqual([]);
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
    test('the Target line for an id nothing in view has: our own id is self', () => {
        expect(unseenTarget(11, 11)).toBe('self');
        expect(unseenTarget(21, 11)).toBe('#21 (not in view)');
        expect(unseenTarget(21, undefined)).toBe('#21 (not in view)');
    });

    test('isOwnPet: the window\'s whatever its entry says, one with no window only with the pet flag (those ids linger and get reused)', () => {
        const pet: PetState = { objectId: 600, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null };
        const npc = (objectId: number, isPet: boolean) => ({ objectId, isPet });
        expect(isOwnPet({ pet }, npc(600, false))).toBe(true);
        expect(isOwnPet({ pet }, npc(601, true))).toBe(false);
        expect(isOwnPet({ pet: null, summons: [601] }, npc(601, true))).toBe(true);
        expect(isOwnPet({ pet: null, summons: [601] }, npc(601, false))).toBe(false);
        expect(isOwnPet({}, npc(600, true))).toBe(false);
        expect(isOwnPet(null, npc(600, true))).toBe(false);
    });

    test('the bot page\'s pet block: window pet, pets with no window, how the last one went; nothing for a bot that never had one', () => {
        const nameOf = (id: number) => (id === 500 ? 'wolf' : `#${id}`);
        const entry = makeNpc({ objectId: 600, name: 'spirit warrior', level: 17, healthPercent: 84, inCombat: true, isPet: true });
        const pet: PetState = { objectId: 600, name: 'old name', aggression: 'aggressive', walk: 'comeHere', icons: [5, 6], targetObjectId: 500 };
        const lastPetLoss = { objectId: 590, name: 'spirit mage', cause: 'owner_died', at: 1000 } as const;

        expect(petPanel(makeState({}), nameOf)).toBeNull();
        expect(petPanel(null, nameOf)).toBeNull();
        expect(petPanel(makeState({ pet: null, summons: [], lastPetLoss: null }), nameOf)).toBeNull();

        expect(petPanel(makeState({ pet, nearbyNpcs: [entry], lastPetLoss }), nameOf)).toEqual({
            pet: { objectId: 600, name: 'spirit warrior', level: 17, hp: 84, inCombat: true, orders: 'aggressive · come here', target: 'wolf', icons: 2 },
            summons: [], lost: null,
        });
        // Out of view: the window's name, nothing of its entry. Its target is the window's too.
        expect(petPanel(makeState({ pet: { ...pet, targetObjectId: null } }), nameOf)!.pet).toEqual({
            objectId: 600, name: 'old name', level: null, hp: null, inCombat: false, orders: 'aggressive · come here', target: null, icons: 2,
        });
        expect(petPanel(makeState({ pet: { ...pet, name: undefined } }), nameOf)!.pet!.name).toBe('#600');

        // No window: entries in view by name, the rest by id.
        expect(petPanel(makeState({ pet: null, summons: [700, 701], nearbyNpcs: [makeNpc({ objectId: 700, name: 'ice being', isPet: true })] }), nameOf)).toEqual({
            pet: null, summons: ['ice being', '#701'], lost: null,
        });
        expect(petPanel(makeState({ pet: null, lastPetLoss }), nameOf)).toEqual({ pet: null, summons: [], lost: { name: 'spirit mage', cause: 'owner died', at: 1000 } });
        expect(petPanel(makeState({ pet: null, lastPetLoss: { ...lastPetLoss, name: null } }), nameOf)!.lost!.name).toBe('#590');
    });

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

    test('the app and group bundles are rebuilt when any viewer module changes, cached per entry', async () => {
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
                // The group page is a second entry in the same folder, with its own cache slot.
                const group = await buildBundle('group.ts', dir);
                expect(build).toHaveBeenCalledTimes(3);
                expect(group).toContain('/groups/');
                expect(group).not.toContain('sdk_connect');
                await buildBundle('group.ts', dir);
                expect(await buildAppBundle(dir)).toContain('sdk_connect');
                expect(build).toHaveBeenCalledTimes(3);
                // Every module in the folder is in both keys: a change to one rebuilds both pages.
                utimesSync(join(dir, 'ui-kit.ts'), new Date(), new Date(Date.now() + 120_000));
                await buildBundle('group.ts', dir);
                await buildAppBundle(dir);
                expect(build).toHaveBeenCalledTimes(5);
            } finally {
                build.mockRestore();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});

// ── Group page logic (group-logic.ts) ───────────────────────────────────────

function player(overrides: Partial<MemberPlayer> = {}): MemberPlayer {
    return {
        name: 'Galahad', objectId: 1, level: 10, levelPermill: 0, className: 'Paladin', realm: 'albion', regionId: 1, zoneId: 1, zoneName: 'Camelot Hills',
        x: 0, y: 0, z: 0, heading: 0, speed: 0, hp: 100, mana: 100, endurance: 100, concentration: 0, maxConcentration: 0,
        isDead: false, isSitting: false, inCombat: false, attacking: false, targetObjectId: null, load: null, deathCount: 0, constitutionLost: 0,
        ...overrides,
    };
}

function member(bot: string, p: Partial<MemberPlayer> | null, overrides: Partial<GroupMemberView> = {}): GroupMemberView {
    return {
        bot, username: bot, charName: null, role: null, leader: false,
        client: { status: 'active', stateAge: 100, phase: 'playing', lastError: null, controllers: 1, observers: 0 },
        player: p ? player({ name: bot[0]!.toUpperCase() + bot.slice(1), ...p }) : null,
        movement: null, inGameGroup: [], run: null, ...overrides,
    };
}

const inRun = (role: 'tank' | 'healer' | 'nuker'): Partial<GroupMemberView> => ({
    run: { name: '', role, activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, effects: [], can: { heal: false, cc: false, nuke: false }, at: 0 },
});

function contact(overrides: Partial<WorldContact> = {}): WorldContact {
    return {
        key: '1:500', objectId: 500, regionId: 1, kind: 'npc', name: 'wolf', level: 9, realm: 'none', x: 0, y: 0, z: 0, heading: 0, speed: 0,
        hp: 100, inCombat: false, isDead: false, targetObjectId: null, target: null,
        npc: { isPeaceful: false, isTargetable: true, isPet: false, role: null }, enemy: false, seenBy: [], nearest: 100, board: null,
        ...overrides,
    };
}

const board = (overrides: Partial<NonNullable<WorldContact['board']>> = {}): WorldContact['board'] => ({
    threat: false, stale: false, cc: null, engagedAt: 0, hostileSince: 0, seenBy: [], lastSeen: 0, ...overrides,
});

function runView(overrides: Partial<RunView> = {}): RunView {
    return {
        runId: 'run-0001-aaaa', state: 'live', error: null, current: true, firstAt: 1000, lastAt: 10_000, skewMs: 0, strategy: 'pve',
        orders: { seq: 3, phase: 'engage', objective: '', anchor: null, facing: null, focus: null, puller: null, cc: [], retreatTo: null, waiting: [], reason: 'wolf attacks', issuedAt: 0 },
        pictureAt: 0, timing: { windingDown: false, deadline: 0, hardStop: 0 }, coordinator: null, planRev: 0, reportRev: 0,
        events: [], eventSeq: 0, eventsFrom: 1, lostEvents: 0, moreEvents: false, control: [], result: null,
        ...overrides,
    };
}

const wire = (seq: number, at: number, kind: WireEvent['kind'], text: string, memberName?: string): WireEvent =>
    ({ seq, at, kind, text, ...(memberName ? { member: memberName } : {}) });
const passive = (seq: number, at: number, kind: PassiveEvent['kind'], runId: string | null, name = 'Niamh'): PassiveEvent => ({
    seq, at, kind, bot: name.toLowerCase(), name, text: `${name} ${kind}`, by: null, pos: null, track: null, runId,
});

describe('group page logic', () => {
    test('isGroupFrame accepts a frame and refuses what the page could not read', () => {
        const frame = {
            v: 1, id: 'alpha', name: 'Alpha', leader: { bot: 'galahad', username: 'galahad' }, now: 5, boot: 1, members: [member('galahad', {})], world: [],
            grouping: { inLeaderGroup: [], missing: [], strangers: [] }, run: null, others: [], passive: { events: [], seq: 0 }, notes: [],
        };
        expect(isGroupFrame(frame)).toBe(true);
        expect(isGroupFrame({ ...frame, run: runView() })).toBe(true);
        expect(isGroupFrame(null)).toBe(false);
        expect(isGroupFrame('Gateway help: ...')).toBe(false);
        expect(isGroupFrame({ ...frame, v: 2 })).toBe(false);
        expect(isGroupFrame({ ...frame, members: undefined })).toBe(false);
        expect(isGroupFrame({ ...frame, members: [null] })).toBe(false);
        expect(isGroupFrame({ ...frame, world: [null] })).toBe(false);
        expect(isGroupFrame({ ...frame, passive: { events: null, seq: 0 } })).toBe(false);
        expect(isGroupFrame({ ...frame, run: { state: 'live' } })).toBe(false);
        expect(isGroupFrame({ ...frame, now: NaN })).toBe(false);
    });

    test('mapRegion follows the followed member, else the region most members are in', () => {
        const members = [member('a', { regionId: 1 }), member('b', { regionId: 2 }), member('c', { regionId: 2 }), member('d', null)];
        expect(mapRegion(members, null)).toBe(2);
        expect(mapRegion(members, 'a')).toBe(1);
        // A followed member without a player falls back to the majority.
        expect(mapRegion(members, 'd')).toBe(2);
        expect(mapRegion(members, 'nobody')).toBe(2);
        // Ties go to the earlier member in group.json order.
        expect(mapRegion([member('a', { regionId: 7 }), member('b', { regionId: 3 })], null)).toBe(7);
        expect(mapRegion([member('d', null)], null)).toBeNull();
        expect(mapRegion([], 'a')).toBeNull();
    });

    test('runRegion is where the living tank is, as the coordinator picks it', () => {
        const tank = member('tank', { regionId: 5 }, inRun('tank'));
        const healer = member('healer', { regionId: 6 }, inRun('healer'));
        expect(runRegion([healer, tank])).toBe(5);
        expect(runRegion([healer, member('tank', { regionId: 5, isDead: true }, inRun('tank'))])).toBe(6);
        // Members the run does not report don't count.
        expect(runRegion([member('x', { regionId: 9 }), tank])).toBe(5);
        expect(runRegion([member('x', { regionId: 9 })])).toBeNull();
    });

    test('conReference is the lowest living member level in the region', () => {
        const members = [
            member('a', { level: 14 }), member('b', { level: 12 }), member('c', { level: 9, isDead: true }),
            member('d', { level: 5, regionId: 2 }), member('e', null),
        ];
        expect(conReference(members, 1)).toBe(12);
        expect(conReference(members, 2)).toBe(5);
        // Everyone there dead: still colour by them rather than by nothing.
        expect(conReference([member('c', { level: 9, isDead: true }), member('f', { level: 11, isDead: true })], 1)).toBe(9);
        expect(conReference(members, 3)).toBeNull();
        expect(conReference(members, null)).toBeNull();
    });

    test('runPill names the run state, the phase and how late it is', () => {
        expect(runPill(null, 0)).toEqual({ text: 'no run', cls: '' });
        expect(runPill(runView(), 10_000)).toEqual({ text: 'live · engage', cls: 'active' });
        expect(runPill(runView({ timing: { windingDown: true, deadline: 0, hardStop: 0 } }), 10_000).text).toBe('live · engage · winding down');
        expect(runPill(runView({ state: 'starting' }), 10_000).cls).toBe('stale');
        expect(runPill(runView({ state: 'stale' }), 22_000)).toEqual({ text: 'stale · 12 s · engage', cls: 'stale' });
        expect(runPill(runView({ state: 'ending' }), 10_000)).toEqual({ text: 'ending', cls: 'stale' });
        expect(runPill(runView({ state: 'lost' }), 130_000)).toEqual({ text: 'lost · no publish for 2 m', cls: 'dead' });
        expect(runPill(runView({ state: 'ended' }), 10_000)).toEqual({ text: 'ended', cls: '' });
        expect(runPill(runView({ state: 'ended', error: 'boom' }), 10_000)).toEqual({ text: 'ended · error', cls: 'dead' });
        expect(phaseClass('engage')).toBe('phase-engage');
        expect(phaseClass('retreat')).toBe('phase-retreat');
        expect(phaseClass('<b>')).toBe('phase-idle');
        expect(phaseClass(undefined)).toBe('phase-idle');
    });

    test('runFailed: the result decides, the error only without one', () => {
        const result = (stoppedBy: 'time' | 'viewer' | 'error') => ({ totals: {} as never, findings: [], stamp: null, stoppedBy });
        // A run that ran out its time, or was wound down, ended well even with its reason in error (older runners send it).
        for (const stoppedBy of ['time', 'viewer'] as const) {
            const run = runView({ state: 'ended', error: stoppedBy === 'time' ? 'time is up' : 'wound down from the viewer', result: result(stoppedBy) });
            expect(runFailed(run)).toBe(false);
            expect(runPill(run, 10_000)).toEqual({ text: 'ended', cls: '' });
        }
        expect(runFailed(runView({ state: 'ended', error: 'BotPreemptedError: pre-empted', result: result('error') }))).toBe(true);
        expect(runFailed(runView({ state: 'ended', error: null, result: result('error') }))).toBe(true);
        // Failed before it started: an error and no result.
        const early = runView({ state: 'ended', error: 'galahad: not in game', result: null });
        expect(runFailed(early)).toBe(true);
        expect(runPill(early, 10_000)).toEqual({ text: 'ended · error', cls: 'dead' });
        expect(runFailed(runView({ state: 'ended', error: null, result: null }))).toBe(false);
        expect(runFailed(null)).toBe(false);
    });

    test('gatewayRestarted: a new boot drops every cursor, a missing one never does', () => {
        expect(gatewayRestarted(null, { boot: 1000 })).toBe(false);
        expect(gatewayRestarted(1000, { boot: 1000 })).toBe(false);
        expect(gatewayRestarted(1000, { boot: 2000 })).toBe(true);
        // Even when the new gateway's seqs already passed the page's: the boot says it, not the seq.
        expect(gatewayRestarted(2000, { boot: 1000 })).toBe(true);
        expect(gatewayRestarted(1000, {})).toBe(false);
        expect(gatewayRestarted(1000, { boot: NaN })).toBe(false);
        expect(gatewayRestarted(1000, { boot: '2000' })).toBe(false);
    });

    test('canWindDown needs a starting, live or stale run that accepts viewer control', () => {
        expect(canWindDown(runView(), null)).toBe(true);
        expect(canWindDown(runView({ state: 'stale' }), { control: true } as RunMeta)).toBe(true);
        expect(canWindDown(runView(), { control: false } as RunMeta)).toBe(false);
        for (const state of ['ending', 'ended', 'lost'] as const) expect(canWindDown(runView({ state }), null)).toBe(false);
        expect(canWindDown(null, null)).toBe(false);
    });

    test('mergeEvents puts skew-corrected run events and passive events in gateway-clock order', () => {
        // The runner's clock is 5 s behind the gateway's: the run event at 1000 happened at 6000.
        const run = [wire(2, 3000, 'kill', 'wolf (L9) died', 'Galahad'), wire(1, 1000, 'orders', 'engage on wolf: wolf attacks')];
        const pass = [passive(7, 7000, 'death', 'r1'), passive(6, 6000, 'client', 'r1'), passive(5, 2000, 'level', null)];
        const lines = mergeEvents(run, 5000, pass);
        // At equal times run events come first.
        expect(lines.map(l => l.key)).toEqual(['p5', 'r1', 'p6', 'p7', 'r2']);
        expect(lines.map(l => l.at)).toEqual([2000, 6000, 6000, 7000, 8000]);
        expect(lines.find(l => l.key === 'r2')).toMatchObject({ source: 'run', kind: 'kill', member: 'Galahad', who: ['Galahad'], runId: null });
        expect(lines.find(l => l.key === 'r1')!.member).toBeNull();
        expect(lines.find(l => l.key === 'p7')).toMatchObject({ source: 'passive', member: 'Niamh', who: ['Niamh', 'niamh'], runId: 'r1' });
        // Junk entries are skipped, not thrown on.
        expect(mergeEvents([null as unknown as WireEvent], 0, [undefined as unknown as PassiveEvent])).toEqual([]);
    });

    test('appendBySeq keeps only newer events and the newest cap', () => {
        const held = [{ seq: 1 }, { seq: 2 }];
        expect(appendBySeq(held, [{ seq: 2 }, { seq: 4 }, { seq: 3 }], 10).map(e => e.seq)).toEqual([1, 2, 3, 4]);
        expect(held).toHaveLength(2);
        expect(appendBySeq(held, [{ seq: 3 }, { seq: 4 }, { seq: 5 }], 3).map(e => e.seq)).toEqual([3, 4, 5]);
        expect(appendBySeq<{ seq: number }>([], [{ seq: 1 }, { seq: 1 }, null as unknown as { seq: number }], 5).map(e => e.seq)).toEqual([1]);
    });

    test('eventVisible applies the chips and the member filter', () => {
        const all: FeedFilters = { orders: true, fights: true, failures: true, notes: true, between: true, member: null };
        const [orders, kill, fail, note] = mergeEvents([
            wire(1, 1, 'orders', 'pull on wolf'), wire(2, 2, 'kill', 'wolf died', 'Galahad'),
            wire(3, 3, 'result', 'nuke: no_power', 'Merlin'), wire(4, 4, 'note', 'opener', 'Galahad'),
        ], 0, []);
        const [between, during, client] = mergeEvents([], 0, [passive(1, 10, 'death', null), passive(2, 11, 'death', 'r1'), passive(3, 12, 'client', 'r1')]);
        for (const l of [orders, kill, fail, note, between, during, client]) expect(eventVisible(l!, all)).toBe(true);
        expect(eventVisible(orders!, { ...all, orders: false })).toBe(false);
        expect(eventVisible(kill!, { ...all, fights: false })).toBe(false);
        expect(eventVisible(fail!, { ...all, failures: false })).toBe(false);
        expect(eventVisible(note!, { ...all, notes: false })).toBe(false);
        // Passive events between runs follow only "between runs"; during a run their deaths count as fights.
        expect(eventVisible(between!, { ...all, between: false })).toBe(false);
        expect(eventVisible(between!, { ...all, fights: false })).toBe(true);
        expect(eventVisible(during!, { ...all, fights: false })).toBe(false);
        expect(eventVisible(during!, { ...all, between: false })).toBe(true);
        expect(eventVisible(client!, { ...all, fights: false, between: false })).toBe(true);
        // The member filter matches the character name or, for passive events, the bot folder.
        const galahad = { ...all, member: ['galahad', 'Galahad'] };
        expect(eventVisible(kill!, galahad)).toBe(true);
        expect(eventVisible(fail!, galahad)).toBe(false);
        expect(eventVisible(orders!, galahad)).toBe(false);
        expect(eventVisible(between!, { ...all, member: ['niamh'] })).toBe(true);
    });

    test('ccSeen: does the assigned caster see the mob, by its own state or the board', () => {
        expect(ccSeen(contact({ seenBy: ['Brigid', 'Oisin'] }), 'Oisin')).toBe(true);
        expect(ccSeen(contact({ seenBy: ['Brigid'] }), 'oisin')).toBe(false);
        expect(ccSeen(contact({ seenBy: ['Brigid'], board: board({ seenBy: ['Oisin'] }) }), 'OISIN')).toBe(true);
        expect(ccSeen(null, 'Oisin')).toBe(false);
        expect(ccSeen(contact({ seenBy: ['Oisin'] }), '')).toBe(false);
    });

    test('isThreat keeps board threats, mobs on a member and enemy players', () => {
        expect(isThreat(contact())).toBe(false);
        expect(isThreat(contact({ target: 'Galahad' }))).toBe(true);
        expect(isThreat(contact({ target: 'Galahad', isDead: true }))).toBe(false);
        expect(isThreat(contact({ board: board({ threat: true }) }))).toBe(true);
        expect(isThreat(contact({ kind: 'player', enemy: true, npc: null }))).toBe(true);
    });

    test('an enemy pet, as /live has it: a threat with the chip for a pet, of the enemy side for its stroke, and on the map under "threats only"', () => {
        const realms = new Set(['albion']);
        const pet = contact({ realm: 'midgard', enemy: true, npc: { isPeaceful: false, isTargetable: true, isPet: true, role: null } });
        expect(isThreat(pet)).toBe(true);
        expect(npcShown(pet, 'threats')).toBe(true);
        expect(enemyTags(pet)).toEqual(['pet']);
        expect(petSide(pet, realms)).toBe('enemy');
        expect(contactListed(pet, realms)).toBe(true);
        // Dead, the panel drops it as it does a player.
        expect(contactListed({ ...pet, isDead: true }, realms)).toBe(false);
    });

    test('npcShown: the NPCs layer hides NPCs, never players', () => {
        const wolf = contact();
        const onMember = contact({ target: 'Galahad' });
        const enemy = contact({ kind: 'player', enemy: true, npc: null });
        const friend = contact({ kind: 'player', npc: null });
        expect([wolf, onMember, enemy, friend].map(c => npcShown(c, 'all'))).toEqual([true, true, true, true]);
        expect([wolf, onMember, enemy, friend].map(c => npcShown(c, 'threats'))).toEqual([false, true, true, true]);
        expect([wolf, onMember, enemy, friend].map(c => npcShown(c, 'off'))).toEqual([false, false, true, true]);
    });

    test('the contacts panel lists threats, then what the group could fight, nearest first', () => {
        const albion = new Set(['albion']);
        const npc = (o: Partial<NonNullable<WorldContact['npc']>>) => ({ isPeaceful: false, isTargetable: true, isPet: false, role: null, ...o });
        expect(contactListed(contact(), albion)).toBe(true);
        // A town: merchants and trainers (peaceful), untargetable NPCs, pets, our realm's guards.
        expect(contactListed(contact({ name: 'Kalli', level: 43, npc: npc({ isPeaceful: true, role: 'merchant' }) }), albion)).toBe(false);
        expect(contactListed(contact({ npc: npc({ isTargetable: false }) }), albion)).toBe(false);
        expect(contactListed(contact({ npc: npc({ isPet: true }) }), albion)).toBe(false);
        expect(contactListed(contact({ realm: 'albion', npc: npc({ isPet: true }) }), albion)).toBe(false);
        expect(contactListed(contact({ name: 'Merarka', level: 50, realm: 'albion' }), albion)).toBe(false);
        // Another realm's guards can be fought; so can a mob the gateway knows nothing more of.
        expect(contactListed(contact({ realm: 'midgard' }), albion)).toBe(true);
        // So can their pets, as sdk isAttackable says.
        expect(contactListed(contact({ realm: 'midgard', npc: npc({ isPet: true }) }), albion)).toBe(true);
        expect(contactListed(contact({ npc: null }), albion)).toBe(true);
        // Dead ones never; a threat always, even a pet on a member.
        expect(contactListed(contact({ isDead: true }), albion)).toBe(false);
        expect(contactListed(contact({ hp: 0 }), albion)).toBe(false);
        expect(contactListed(contact({ target: 'Galahad', npc: npc({ isPet: true }) }), albion)).toBe(true);
        expect(contactListed(contact({ board: board({ threat: true }), npc: npc({ isPeaceful: true }) }), albion)).toBe(true);
        // Players: enemies only.
        expect(contactListed(contact({ kind: 'player', npc: null, realm: 'albion' }), albion)).toBe(false);
        expect(contactListed(contact({ kind: 'player', npc: null, realm: 'midgard', enemy: true }), albion)).toBe(true);
        expect(contactListed(contact({ kind: 'player', npc: null, realm: 'midgard', enemy: true, isDead: true }), albion)).toBe(false);

        const members = [member('galahad', { realm: 'albion' }), member('nimue', null)];
        const world = [
            contact({ key: '1:1', objectId: 1, name: 'merchant', nearest: 10, npc: npc({ isPeaceful: true }) }),
            contact({ key: '1:2', objectId: 2, name: 'guard', nearest: 20, realm: 'albion' }),
            contact({ key: '1:3', objectId: 3, name: 'cat', nearest: 300 }),
            contact({ key: '1:4', objectId: 4, name: 'rat', nearest: 200 }),
            contact({ key: '1:5', objectId: 5, name: 'wolf', nearest: 900, target: 'Galahad' }),
            contact({ key: '1:6', objectId: 6, name: 'Enemy', nearest: 500, kind: 'player', npc: null, realm: 'midgard', enemy: true }),
            contact({ key: '1:7', objectId: 7, name: 'corpse', nearest: 5, isDead: true }),
        ];
        expect(listedContacts(world, members).map(c => c.name)).toEqual(['Enemy', 'wolf', 'rat', 'cat']);
        expect(listedContacts([], members)).toEqual([]);
    });

    test('enemyTags: a shade, whatever the board has of it: "Briton L24 100%, seen 3, 1166 away" for model 822, never picked, no tag to say why', () => {
        const shade = contact({ kind: 'player', npc: null, realm: 'midgard', enemy: true, name: 'Briton', level: 24, isShade: true });
        expect(enemyTags(shade)).toEqual(['shade']);
        expect(enemyTags({ ...shade, board: board({ caster: true }) })).toEqual(['shade', 'caster']);
        expect(contactLine(shade, null)).toContain('[shade]');
    });

    test('enemyTags: what the board saw an enemy player do; nothing for monsters or without a run', () => {
        const enemy = (b: Partial<NonNullable<WorldContact['board']>>) => contact({ kind: 'player', npc: null, realm: 'midgard', enemy: true, board: board(b) });
        expect(enemyTags(enemy({ healer: true, caster: true, casting: false }))).toEqual(['healer', 'caster']);
        expect(enemyTags(enemy({ caster: true }))).toEqual(['caster']);
        expect(enemyTags(enemy({}))).toEqual([]);
        expect(enemyTags(contact({ kind: 'player', npc: null, realm: 'midgard', enemy: true }))).toEqual([]);
        expect(enemyTags(contact({ board: board({ healer: true }) }))).toEqual([]);
    });

    test('retryRuns: a runs list refused before the stored password unlocked /live is asked for again, once', () => {
        // The bot page's key unlocked /live after the first runs request went out without it.
        expect(retryRuns(false, false, '', 'leader-pw')).toBe(true);
        expect(retryRuns(false, true, '', 'leader-pw')).toBe(false);
        expect(retryRuns(true, false, '', 'leader-pw')).toBe(false);
        // Already failed with this password, or never failed: the 30 s refresh does it.
        expect(retryRuns(false, false, 'leader-pw', 'leader-pw')).toBe(false);
        expect(retryRuns(false, false, null, 'leader-pw')).toBe(false);
    });

    test('drawPass restores the canvas state after every pass, also after a throw', () => {
        const calls: string[] = [];
        const ctx = { globalAlpha: 1, save: () => { calls.push('save'); }, restore: () => { calls.push('restore'); ctx.globalAlpha = 1; } };
        // drawPlan used to return early with the stale-run alpha still set.
        drawPass(ctx, 'plan', () => { ctx.globalAlpha = 0.45; });
        expect(ctx.globalAlpha).toBe(1);
        const error = spyOn(console, 'error').mockImplementation(() => {});
        try {
            // safely() logs once per label per process: a fresh label keeps the test repeatable.
            drawPass(ctx, `test pass that throws ${crypto.randomUUID()}`, () => { ctx.globalAlpha = 0.45; calls.push('draw'); throw new Error('odd data'); });
            expect(error).toHaveBeenCalledTimes(1);
        } finally {
            error.mockRestore();
        }
        expect(ctx.globalAlpha).toBe(1);
        expect(calls).toEqual(['save', 'restore', 'save', 'draw', 'restore']);
    });

    test('timeLeft counts down to the deadline, then to the hard stop while winding down', () => {
        const timing = { windingDown: false, deadline: 100_000, hardStop: 160_000 };
        // Runner clock + 2 s skew = gateway clock.
        expect(timeLeft(timing, 2000, 42_000)).toEqual({ text: '1:00 left', ms: 60_000, windingDown: false });
        expect(timeLeft({ ...timing, windingDown: true }, 2000, 42_000)).toEqual({ text: 'winding down · stops within 2:00', ms: 120_000, windingDown: true });
        expect(timeLeft(timing, 0, 500_000)!.ms).toBe(0);
        expect(timeLeft({ ...timing, deadline: 4 * 3600_000 }, 0, 0)!.text).toBe('4:00:00 left');
        expect(timeLeft(null, 0, 0)).toBeNull();
        expect(timeLeft({ windingDown: false, deadline: NaN, hardStop: 0 }, 0, 0)).toBeNull();
    });

    test('run log lines: kinds, and the context around a death', () => {
        expect(logLineKind('14:41:22 » engage on large bloated spider: fighting large bloated spider (94%)')).toBe('orders');
        expect(logLineKind('14:41:30 Galahad: Galahad died')).toBe('death');
        expect(logLineKind('14:41:31 Galahad: kill: died (Died fighting forest cat)')).toBe('death');
        expect(logLineKind('14:41:27 Galahad: large bloated spider (L14) died')).toBe('kill');
        expect(logLineKind('14:41:28 Merlin: nuke: no_target (You must select a target for this spell!)')).toBe('failure');
        expect(logLineKind('14:41:15 Nimue: buff: no_response')).toBe('failure');
        expect(logLineKind('14:41:22 Galahad: opener Uppercut on large bloated spider')).toBe('other');
        expect(logLineKind('14:42:28 time is up: finishing the current fight')).toBe('other');
        expect(logLineKind('camelot: Galahad (Paladin L17, tank); strategy camelot-pve')).toBe('other');
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
        expect(deathContext(lines, 20)).toEqual({ start: 8, lines: lines.slice(8, 24) });
        expect(deathContext(lines, 3)).toEqual({ start: 0, lines: lines.slice(0, 7) });
        expect(deathContext(lines, 29)).toEqual({ start: 17, lines: lines.slice(17) });
        expect(deathContext(lines, 30)).toEqual({ start: 0, lines: [] });
        expect(deathContext(lines, -1).lines).toEqual([]);
    });

    describe('pets', () => {
        const albion = new Set(['albion']);
        const npc = (o: Partial<NonNullable<WorldContact['npc']>>) => ({ isPeaceful: false, isTargetable: true, isPet: true, role: null, ...o });
        const owned = contact({ name: 'spirit warrior', realm: 'albion', npc: npc({ owner: 'Hrafna' }) });
        const enemy = contact({ name: 'spirit warrior', realm: 'midgard', npc: npc({}) });
        const friend = contact({ name: 'spirit warrior', realm: 'albion', npc: npc({}) });
        const monsters = contact({ name: 'skeleton', realm: 'none', npc: npc({}) });
        const wolf = contact();

        test('a member\'s pet always shows on the map: with NPCs off too, it belongs with its owner', () => {
            for (const layer of ['all', 'threats', 'off']) expect(npcShown(owned, layer)).toBe(true);
            expect(npcShown(enemy, 'off')).toBe(false);
            expect(npcShown(enemy, 'threats')).toBe(false);
            expect(npcShown(enemy, 'all')).toBe(true);
        });

        test('the contacts panel keeps members\' and friends\' pets off, lists enemy pets; a monster\'s only on us', () => {
            expect(contactListed(owned, albion)).toBe(false);
            expect(contactListed(friend, albion)).toBe(false);
            expect(contactListed(monsters, albion)).toBe(false);
            expect(contactListed(enemy, albion)).toBe(true);
            expect(contactListed({ ...monsters, target: 'Hrafna' }, albion)).toBe(true);
            // Never a member's own, whatever its entry or a stale board says.
            expect(contactListed({ ...owned, target: 'Hrafna' }, albion)).toBe(false);
            expect(contactListed({ ...owned, board: board({ threat: true }) }, albion)).toBe(false);
        });

        test('a mob on a member\'s pet is a threat, by the members\' states or by the run\'s board; a member\'s pet never is', () => {
            expect(isThreat(contact({ targetPet: 'Hrafna' }))).toBe(true);
            expect(isThreat(contact({ targetPet: 'Hrafna', isDead: true }))).toBe(false);
            expect(isThreat(contact({ board: board({ threat: true, targetPet: 'Hrafna' }) }))).toBe(true);
            expect(npcShown(contact({ targetPet: 'Hrafna' }), 'threats')).toBe(true);
            expect(contactListed(contact({ targetPet: 'Hrafna', realm: 'albion' }), albion)).toBe(true);
            expect(isThreat({ ...owned, target: 'Hrafna' })).toBe(false);
            expect(isThreat({ ...owned, inCombat: true, board: board({ threat: true }) })).toBe(false);
            expect(isThreat(enemy)).toBe(false);
        });

        test('who a contact is on, for the panel and the tooltip', () => {
            expect(contactAim(contact({ target: 'Hrafna' }))).toBe('Hrafna');
            expect(contactAim(contact({ targetPet: 'Hrafna' }))).toBe('Hrafna\'s pet');
            expect(contactAim(contact({ board: board({ targetPet: 'Hrafna' }) }))).toBe('Hrafna\'s pet');
            // The member it is on now over the pet the board last saw.
            expect(contactAim(contact({ target: 'Galahad', board: board({ targetPet: 'Hrafna' }) }))).toBe('Galahad');
            expect(contactAim(contact())).toBeNull();
            expect(contactAim({ ...owned, target: 'Hrafna' })).toBeNull();
        });

        test('petSide and its tooltip text, by the owner and the realm', () => {
            expect([owned, enemy, friend, monsters, wolf].map(c => petSide(c, albion))).toEqual(['member', 'enemy', 'friend', 'monster', null]);
            expect([owned, enemy, friend, monsters, wolf].map(c => petTitle(c, albion))).toEqual(['pet of Hrafna', 'enemy pet', 'friendly pet', 'a monster\'s pet', null]);
            expect(petSide(contact({ kind: 'player', npc: null, realm: 'midgard', enemy: true }), albion)).toBeNull();
            expect([...memberRealms([member('galahad', { realm: 'albion' }), member('nimue', null), member('mob', { realm: 'none' })])]).toEqual(['albion']);
        });

        test('map labels: a member\'s pet by its owner, anything else by its level', () => {
            expect(mapLabel(owned)).toBe('spirit warrior (Hrafna)');
            expect(mapLabel(enemy)).toBe('spirit warrior 9');
            expect(mapLabel(wolf)).toBe('wolf 9');
            expect(mapLabel(contact({ name: '' }))).toBe('(unnamed) 9');
            expect(mapLabel(contact({ name: '', npc: npc({ owner: 'Hrafna' }) }))).toBe('(unnamed) (Hrafna)');
        });

        test('a pet chip on any pet the panel lists; players keep their tags', () => {
            expect(enemyTags(enemy)).toEqual(['pet']);
            expect(enemyTags(wolf)).toEqual([]);
            expect(enemyTags(contact({ kind: 'player', npc: null, board: board({ healer: true }) }))).toEqual(['healer']);
        });

        const report = (over: Partial<PetReport> = {}): PetReport => ({
            objectId: 600, name: 'spirit warrior', level: 17, x: 1, y: 2, z: 3, hp: 84, targetId: 500, inCombat: true, aggression: 'defensive', walk: 'follow', icons: [], ...over,
        });
        const nameOf = (id: number) => (id === 500 ? 'wolf' : `#${id}`);

        test('petLine, shared with the CLI', () => {
            expect(petLine(report(), nameOf)).toBe('spirit warrior L17 84% · defensive · follow → wolf');
            expect(petLine(report({ targetId: null, walk: 'stay', hp: 83.6 }), nameOf)).toBe('spirit warrior L17 84% · defensive · stay');
            expect(petLine(report({ targetId: null, aggression: 'passive', walk: 'comeHere' }), nameOf)).toBe('spirit warrior L17 84% · passive · come here');
            expect(petLine(report({ targetId: null, aggression: 'aggressive', walk: 'goTarget' }), nameOf)).toBe('spirit warrior L17 84% · aggressive · go to target');
            expect(petLine(report({ level: null, hp: null, targetId: 7 }), nameOf)).toBe('spirit warrior out of view · defensive · follow → #7');
            expect(petLine(report({ name: '', level: null, hp: null, targetId: null }), nameOf)).toBe('#600 out of view · defensive · follow');
        });

        test('a member\'s card: its pet, those with no window, "no pet" when the run keeps a main one up, nothing otherwise', () => {
            const can = (pet: 'main' | 'fnf' | null | undefined): Partial<GroupMemberView> => ({ run: { ...inRun('nuker').run!, can: { heal: false, cc: false, nuke: true, ...(pet !== undefined ? { pet } : {}) } } });
            expect(memberPetRow(member('a', {}, { pet: report() }), nameOf)).toEqual({ text: 'Pet: spirit warrior L17 84% · defensive · follow → wolf', hp: 84 });
            expect(memberPetRow(member('a', {}, { pet: report({ hp: null, level: null }) }), nameOf)!.hp).toBeNull();
            expect(memberPetRow(member('a', {}, { pet: report({ targetId: null }), summons: [1, 2] }), nameOf)!.text).toBe('Pet: spirit warrior L17 84% · defensive · follow · 2 more');
            expect(memberPetRow(member('a', {}, { pet: null, summons: [1, 2] }), nameOf)).toEqual({ text: 'Pets: 2 with no window', hp: null });
            expect(memberPetRow(member('a', {}, { pet: null, ...can('main') }), nameOf)).toEqual({ text: 'no pet', hp: null });
            // A Theurgist with no spirits up: "Petthe nuker L10 Theurgist ... no pet" read while the watcher had "petthe SUMMONS [23124:earth spirit,23122:earth spirit]". They come and go with its target.
            expect(memberPetRow(member('a', {}, { ...can('fnf') }), nameOf)).toBeNull();
            expect(memberPetRow(member('a', {}, { summons: [1, 2], ...can('fnf') }), nameOf)).toEqual({ text: 'Pets: 2 with no window', hp: null });
            expect(memberPetRow(member('a', {}, { pet: null, ...can(null) }), nameOf)).toBeNull();
            expect(memberPetRow(member('a', {}, { pet: null, ...can(undefined) }), nameOf)).toBeNull();
            expect(memberPetRow(member('a', {}, { pet: null }), nameOf)).toBeNull();
            expect(memberPetRow(member('a', {}), nameOf)).toBeNull();
        });
    });

    test('contactLine: a contact in --live as the page\'s panel has it ("--live prints no enemies")', () => {
        const pet = { isPeaceful: false, isTargetable: true, isPet: true, role: null };
        const seen = { seenBy: ['Petbon', 'Pethun'], nearest: 812.4 };
        expect(contactLine(contact({ objectId: 9, name: 'wolf', level: 8, hp: 73.4, target: 'Pettan', ...seen }), null)).toBe('wolf L8 73% → Pettan, seen 2, 812 away');
        expect(contactLine(contact({ objectId: 9, name: 'wolf', level: 8, hp: 73, target: 'Pettan', ...seen }), 9)).toBe('* wolf L8 73% → Pettan, seen 2, 812 away');
        expect(contactLine(contact({ name: 'earthen spirit', level: 20, hp: 100, target: null, targetPet: 'Petbon', npc: pet, ...seen }), null)).toBe('earthen spirit L20 100% → Petbon\'s pet [pet], seen 2, 812 away');
        expect(contactLine(contact({ kind: 'player', name: 'Saracen', level: 24, hp: 50, target: null, enemy: true, board: { threat: true, stale: true, healer: true, cc: { by: 'Petspi', kind: 'mezz', until: 0 } } as never, ...seen }), null)).toBe('Saracen L24 50% [healer, mezz, stale], seen 2, 812 away');
        // A frame from an older gateway can lack all of it.
        expect(contactLine(contact({ name: 'rat', level: 1, hp: undefined as never, target: null, seenBy: undefined as never, nearest: undefined as never }), null)).toBe('rat L1 100%, seen 0, 0 away');
    });

    test('roleLetter labels members on the map', () => {
        expect(['tank', 'healer', 'support', 'nuker', 'melee'].map(roleLetter).join('')).toBe('THSNM');
        expect(roleLetter(null)).toBe('?');
        expect(roleLetter('toString')).toBe('?');
    });
});

describe('enemy pets on the region page', () => {
    type Enemy = { objectId: number; name: string; x: number; y: number; isPet?: true; targetId?: number | null };
    const player: Enemy = { objectId: 21, name: 'Troll', x: 100, y: 200 };
    const pet: Enemy = { objectId: 600, name: 'spirit warrior', x: 300, y: 400, isPet: true, targetId: 11 };

    test('each says what it is', () => {
        expect(enemyWord(player)).toBe('Enemy player');
        expect(enemyWord(pet)).toBe('Enemy pet');
    });

    test('the panel\'s count tells them apart, and reads as it did with no pet', () => {
        expect(enemyHeading([player, { ...player, objectId: 22 }])).toBe('2 enemy players');
        expect(enemyHeading([player, pet])).toBe('1 enemy player, 1 enemy pet');
        expect(enemyHeading([pet])).toBe('0 enemy players, 1 enemy pet');
    });

    test('a line from a pet to what it aims at, wherever that stands on the map; none with nothing known', () => {
        const at = (id: number) => (id === 11 ? { x: 1, y: 2 } : null);
        expect(enemyAims([player, pet, { ...pet, objectId: 601, targetId: 99 }, { ...pet, objectId: 602, targetId: null }], at)).toEqual([{ from: pet, to: { x: 1, y: 2 } }]);
    });
});
