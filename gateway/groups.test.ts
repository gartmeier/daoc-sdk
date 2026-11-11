// Group views in the gateway (gateway/groups.ts): discovery, the passive
// picture from the members' states, a run's publishes, wind-down, the tracker
// and the runs files. Gateways on port 0 with fake clients; nothing real.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type Gateway, type GatewayOptions } from './gateway';
import { composePassive, createGroupStore, discoverGroups, groupPath, runStateOf, sanitizePublish, type GroupLimits, type GroupStore } from './groups';
import { botEnvAuth, botIdentity, checkControlPassword } from './security';
import { makeNpc, makePlayer, makePlayerObj, makeState } from '../sdk/test/fixtures';
import { contact, picture, report } from '../sdk/group/fixtures';
import type { BotWorldState, CombatEvent, NearbyNpc, PlayerState } from './types';
import type { GroupPublish } from '../sdk/group/wire';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what = 'condition', timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await pause(10);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

const PASSWORDS = ['tank-secret-1', 'heal-secret-2', 'nuke-secret-3', 'solo-secret-4'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const RUN = 'run-aaaa-0001';

let root = '';
let clock = 0;
let seq = 0;
let gateway: Gateway | null = null;
const sockets: WebSocket[] = [];
const stores: GroupStore[] = [];
/** Every answer a test read: none may contain a fixture password. */
const answers: string[] = [];

function write(path: string, body: string) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'daoc-groups-'));
    clock = Date.now();
    seq = 0;
    write('groups/alpha/group.json', JSON.stringify({ name: 'Alpha Team', leader: 'tank1', members: [{ bot: 'tank1', role: 'tank' }, { bot: 'heal1' }, { bot: 'nuke1' }] }));
    write('groups/beta/group.json', JSON.stringify({ members: [{ bot: 'solo1' }, { bot: 'ghost' }] }));
    write('groups/_template/group.json', JSON.stringify({ members: [{ bot: 'tank1' }] }));
    write('groups/.hidden/group.json', JSON.stringify({ members: [{ bot: 'tank1' }] }));
    write('groups/broken/group.json', '{ not json');
    write('groups/badrole/group.json', JSON.stringify({ members: [{ bot: 'tank1', role: 'wizard' }] }));
    mkdirSync(join(root, 'groups', 'empty'), { recursive: true });
    write('bots/tank1/bot.env', 'BOT_USERNAME=tankuser\nPASSWORD=tank-secret-1\nCHAR_NAME=Tanky\n');
    write('bots/heal1/bot.env', 'BOT_USERNAME=healuser\nPASSWORD=heal-secret-2\nCHAR_NAME=Healy\n');
    write('bots/nuke1/bot.env', 'PASSWORD=nuke-secret-3\nCHAR_NAME=Nuky\n');
    write('bots/solo1/bot.env', 'BOT_USERNAME=solouser\nPASSWORD=solo-secret-4\nCHAR_NAME=Solo\n');
});

afterEach(async () => {
    for (const ws of sockets.splice(0)) try { ws.close(); } catch {}
    for (const s of stores.splice(0)) s.stop();
    await gateway?.stop();
    gateway = null;
    rmSync(root, { recursive: true, force: true });
    for (const text of answers.splice(0)) for (const pw of PASSWORDS) expect(text).not.toContain(pw);
});

function start(options: GatewayOptions = {}, limits: Partial<GroupLimits> = {}): Gateway {
    gateway = createGateway({
        port: 0, hostname: '127.0.0.1', quiet: true,
        groups: { roots: [root], groupsDir: join(root, 'groups'), now: () => clock, limits },
        ...options,
    });
    return gateway;
}

async function http(path: string, init?: RequestInit): Promise<{ status: number; body: any; text: string; headers: Headers }> {
    const res = await fetch(`http://127.0.0.1:${gateway!.port}${path}`, init);
    const text = await res.text();
    answers.push(text);
    let body: any = null;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, text, headers: res.headers };
}

const live = (query = '', headers: Record<string, string> = {}, id = 'alpha') => http(`/groups/${id}/live${query}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    http(path, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const publish = (body: unknown, headers: Record<string, string> = {}, id = 'alpha') => post(`/groups/${id}/publish`, body, headers);
const windDown = (body: Record<string, unknown>, headers: Record<string, string> = {}) => post('/groups/alpha/control', { kind: 'windDown', ...body }, headers);
const bearer = (pw: string) => ({ Authorization: `Bearer ${pw}` });

const ROSTER = [{ bot: 'tank1', username: 'tankuser' }, { bot: 'heal1', username: 'healuser' }, { bot: 'nuke1', username: 'nuke1' }];

function makePublish(over: Partial<GroupPublish> = {}): GroupPublish {
    return {
        v: 1, runId: RUN, publishSeq: ++seq, sentAt: clock - 20, group: 'alpha', leader: 'tank1', roster: ROSTER,
        state: 'running', error: null,
        meta: {
            strategy: 'test-pve', description: 'a test run', startedAt: clock, stamp: '20261031-120000', seconds: 900, graceMs: 60_000,
            members: [
                { bot: 'tank1', username: 'tankuser', name: 'Tanky', role: 'tank', className: 'Armsman', level: 10, behaviors: ['tank'] },
                { bot: 'heal1', username: 'healuser', name: 'Healy', role: 'healer', className: 'Cleric', level: 10, behaviors: ['heal'] },
                { bot: 'nuke1', username: 'nuke1', name: 'Nuky', role: 'support', className: 'Wizard', level: 10, behaviors: ['nuke'] },
            ],
            settings: { huntRadius: 2200 }, pid: 4242, control: true,
        },
        picture: picture(
            [
                report('Tanky', { bot: 'tank1', role: 'tank', objectId: 1001, regionId: 1, activity: { kind: 'melee', targetId: 500, detail: 'tank', since: clock } }),
                report('Healy', { bot: 'heal1', role: 'healer', objectId: 1002, regionId: 1 }),
                report('Nuky', { bot: 'nuke1', role: 'support', objectId: 1003, regionId: 1 }),
            ],
            [contact(500, { regionId: 1, threat: true, seenBy: ['Tanky'], cc: { by: 'Nuky', kind: 'mezz', until: clock + 5000 } })],
            { seq: 3, phase: 'engage', focus: 500, reason: 'rat attacks the group' },
            clock,
        ),
        timing: { windingDown: false, deadline: clock + 900_000, hardStop: clock + 960_000 },
        coordinator: null, planRev: 0, reportRev: 0, events: [], dropped: 0, applied: [],
        ...over,
    };
}

const BETA = { group: 'beta', leader: 'solo1', roster: [{ bot: 'solo1', username: 'solouser' }, { bot: 'ghost', username: 'ghost' }] };

/** The bot.env auth hook for HTTP and SDK callers; fake bot clients log in freely. */
const hook = ({ kind, username, password }: { kind: 'bot' | 'sdk' | 'http'; username: string; password: string }) =>
    kind === 'bot' ? { success: true } : botEnvAuth([root])({ kind, username, password });

/** `n` nested arrays as JSON text: cheap to parse, slow to JSON.stringify past ~10k. */
const nested = (n: number) => '['.repeat(n) + ']'.repeat(n);

function playerState(player: Partial<PlayerState>, extra: Partial<BotWorldState> = {}): BotWorldState {
    return makeState({ player: makePlayer(player), nearbyNpcs: [], nearbyPlayers: [], ...extra });
}

const tankState = (extra: Partial<BotWorldState> = {}, player: Partial<PlayerState> = {}) =>
    playerState({ name: 'Tanky', objectId: 1001, className: 'Armsman', level: 10, x: 1000, y: 1000, ...player }, extra);
const healState = (extra: Partial<BotWorldState> = {}, player: Partial<PlayerState> = {}) =>
    playerState({ name: 'Healy', objectId: 1002, className: 'Cleric', level: 10, x: 1200, y: 1000, ...player }, extra);
const nukeState = (extra: Partial<BotWorldState> = {}, player: Partial<PlayerState> = {}) =>
    playerState({ name: 'Nuky', objectId: 1003, className: 'Wizard', level: 10, x: 900, y: 900, ...player }, extra);

interface Peer { ws: WebSocket; messages: any[]; send(msg: object): void }

async function peer(): Promise<Peer> {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway!.port}`);
    sockets.push(ws);
    const messages: any[] = [];
    ws.onmessage = ev => messages.push(JSON.parse(String(ev.data)));
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    return { ws, messages, send: msg => ws.send(JSON.stringify(msg)) };
}

async function attachBot(username: string, state: BotWorldState): Promise<Peer> {
    const p = await peer();
    p.send({ type: 'connected', username, clientId: `${username}-client` });
    await until(() => p.messages.some(m => m.type === 'status'), 'bot registration');
    p.send({ type: 'state', state });
    await until(async () => (await (await fetch(`http://127.0.0.1:${gateway!.port}/status/${username}`)).json() as any).inGame, `${username} in game`);
    return p;
}

async function sdk(username: string, mode: 'control' | 'observe'): Promise<Peer> {
    const p = await peer();
    p.send({ type: 'sdk_connect', username, password: 'x', clientId: `test-${mode}`, mode });
    await until(() => p.messages.some(m => m.type === 'sdk_connected' || m.type === 'sdk_error'), 'sdk handshake');
    return p;
}

// ── a store with fake session maps (the tracker, isolation) ────────────────

function fakeStore(limits: Partial<GroupLimits> = {}) {
    const sessions = new Map<string, any>();
    const sdkSessions = new Map<string, any>();
    let t = Date.now();
    const store = createGroupStore({
        roots: [root], groupsDir: join(root, 'groups'), sessions, sdkSessions,
        sessionStatus: s => (s.ws ? 'active' : 'dead'), auth: () => ({ success: true }), log: () => {}, now: () => t, limits,
    });
    stores.push(store);
    const call = async (path: string, init?: RequestInit) => {
        const res = await store.handle(new Request(`http://127.0.0.1${path}`, init), new URL(`http://127.0.0.1${path}`));
        const text = await res!.text();
        answers.push(text);
        return { status: res!.status, body: JSON.parse(text) };
    };
    return {
        store, sessions, sdkSessions,
        now: () => t,
        advance(ms: number) { t += ms; return t; },
        attach(username: string, state: BotWorldState | null = null) {
            const session: { ws: object | null; clientId: string; lastState: BotWorldState | null; lastStateReceivedAt: number } = { ws: {}, clientId: `${username}-client`, lastState: state, lastStateReceivedAt: state ? t : 0 };
            sessions.set(username, session);
            return session;
        },
        frame: async (query = '') => (await call(`/groups/alpha/live${query}`)).body,
        publish: (body: unknown) => call('/groups/alpha/publish', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }),
    };
}

function deepFreeze<T>(x: T): T {
    if (x && typeof x === 'object' && !Object.isFrozen(x)) {
        Object.freeze(x);
        for (const v of Object.values(x)) deepFreeze(v);
    }
    return x;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('group discovery and /groups', () => {
    test('lists group.json folders with BOT_USERNAME and CHAR_NAME, never a password', async () => {
        start();
        const { status, body, headers } = await http('/groups');
        expect(status).toBe(200);
        expect(headers.get('content-type')).toContain('application/json');
        expect(headers.get('cache-control')).toBe('no-store');
        expect(body.groups.map((g: any) => g.id)).toEqual(['alpha', 'badrole', 'beta', 'broken']);
        const alpha = body.groups[0];
        expect(alpha).toMatchObject({ id: 'alpha', name: 'Alpha Team', leader: 'tank1', error: null, hasCampaign: false, run: null });
        expect(alpha.members).toEqual([
            { bot: 'tank1', username: 'tankuser', name: 'Tanky', role: 'tank', status: 'none', inGame: false, isDead: false, level: null, className: null, regionId: null, zoneName: null },
            { bot: 'heal1', username: 'healuser', name: 'Healy', role: null, status: 'none', inGame: false, isDead: false, level: null, className: null, regionId: null, zoneName: null },
            { bot: 'nuke1', username: 'nuke1', name: 'Nuky', role: null, status: 'none', inGame: false, isDead: false, level: null, className: null, regionId: null, zoneName: null },
        ]);
        // No bot.env: the folder name stands in as the username.
        expect(body.groups[2].members[1]).toMatchObject({ bot: 'ghost', username: 'ghost', name: null });
    });

    test('skips _template, dot and json-less folders; an invalid group.json is listed with its error', async () => {
        start();
        const { body } = await http('/groups');
        const broken = body.groups.find((g: any) => g.id === 'broken');
        expect(broken.error).toContain('group.json');
        expect(broken.members).toEqual([]);
        const badrole = body.groups.find((g: any) => g.id === 'badrole');
        expect(badrole.error).toContain('"wizard"');
        expect(badrole.members).toEqual([]);
        // The frame says so too, and a run cannot publish for it.
        expect((await live('', {}, 'broken')).body.notes[0]).toContain('group.json');
        expect((await live('', {}, '_template')).status).toBe(404);
        expect((await live('', {}, 'empty')).status).toBe(404);
        expect((await live('', {}, 'nope%22x')).status).toBe(404);
    });

    test('discovery picks up a new group.json after the TTL', async () => {
        start();
        expect((await http('/groups')).body.groups.some((g: any) => g.id === 'gamma')).toBe(false);
        write('groups/gamma/group.json', JSON.stringify({ members: [{ bot: 'tank1' }] }));
        expect((await http('/groups')).body.groups.some((g: any) => g.id === 'gamma')).toBe(false);
        clock += 5001;
        const gamma = (await http('/groups')).body.groups.find((g: any) => g.id === 'gamma');
        expect(gamma).toMatchObject({ name: 'gamma', leader: 'tank1', members: [{ username: 'tankuser' }] });
    });

    test('a publish or wind-down for a group.json written within the TTL reads the disk again instead of refusing', async () => {
        start();
        await http('/groups');
        // `create-group fresh ... && hunt.ts`: the first publish comes well within the 5 s cache.
        write('groups/fresh/group.json', JSON.stringify({ members: [{ bot: 'solo1' }] }));
        const fresh = { group: 'fresh', leader: 'solo1', roster: [{ bot: 'solo1', username: 'solouser' }] };
        expect((await publish(makePublish({ ...fresh, runId: 'run-fresh-0001' }), {}, 'fresh')).body.ok).toBe(true);
        expect((await http('/groups')).body.groups.find((g: any) => g.id === 'fresh').run).toMatchObject({ runId: 'run-fresh-0001' });

        // At most one forced read a second: a second new group waits for the next one.
        write('groups/fresh2/group.json', JSON.stringify({ members: [{ bot: 'solo1' }] }));
        expect((await publish(makePublish({ ...fresh, group: 'fresh2', runId: 'run-fresh-0002' }), {}, 'fresh2')).status).toBe(404);
        clock += 1000;
        expect((await publish(makePublish({ ...fresh, group: 'fresh2', runId: 'run-fresh-0002' }), {}, 'fresh2')).status).toBe(200);

        // A member added a moment ago: the new roster is accepted, not a 409.
        clock += 1000;
        write('groups/alpha/group.json', JSON.stringify({ leader: 'tank1', members: [{ bot: 'tank1' }, { bot: 'heal1' }, { bot: 'nuke1' }, { bot: 'solo1' }] }));
        const roster = [...ROSTER, { bot: 'solo1', username: 'solouser' }];
        expect((await publish(makePublish({ roster }))).status).toBe(200);

        // A wind-down for a group made a moment ago reaches the run checks, not a 404 (3 s in: still one cache lifetime).
        clock += 1000;
        write('groups/fresh3/group.json', JSON.stringify({ members: [{ bot: 'tank1' }] }));
        expect((await post('/groups/fresh3/control', { kind: 'windDown', runId: RUN, password: 'tank-secret-1' })).body).toEqual({ ok: false, error: 'no live run' });
    });

    test('a leader changed a moment ago is the one whose password a publish needs', async () => {
        start({ auth: hook });
        await http('/groups');
        write('groups/alpha/group.json', JSON.stringify({ leader: 'heal1', members: [{ bot: 'tank1' }, { bot: 'heal1' }, { bot: 'nuke1' }] }));
        expect((await publish(makePublish({ leader: 'heal1' }), bearer('heal-secret-2'))).status).toBe(200);
        expect((await live('', bearer('heal-secret-2'))).body.leader).toEqual({ bot: 'heal1', username: 'healuser' });
    });

    test('discoverGroups: groupsDir first, first folder of an id wins, roots deduped', () => {
        const other = mkdtempSync(join(tmpdir(), 'daoc-groups-dir-'));
        try {
            mkdirSync(join(other, 'alpha'), { recursive: true });
            writeFileSync(join(other, 'alpha', 'group.json'), JSON.stringify({ name: 'From groupsDir', members: [{ bot: 'heal1' }] }));
            const found = discoverGroups([root, root], other);
            expect(found.filter(g => g.id === 'alpha')).toHaveLength(1);
            expect(found.find(g => g.id === 'alpha')).toMatchObject({ name: 'From groupsDir', leader: 'heal1', leaderUsername: 'healuser' });
            expect(discoverGroups([root], undefined, 2).map(g => g.id)).toEqual(['alpha', 'badrole']);
            const beta = found.find(g => g.id === 'beta')!;
            expect(beta.notes[0]).toContain('ghost: no bots/ghost/bot.env');
        } finally {
            rmSync(other, { recursive: true, force: true });
        }
    });

    test('a bench sits out: the group keeps its members, and a bot on both lists or a bad entry breaks it', () => {
        write('groups/alpha/group.json', JSON.stringify({ leader: 'tank1', members: [{ bot: 'tank1' }, { bot: 'heal1' }], bench: [{ bot: 'nuke1' }] }));
        const alpha = discoverGroups([root]).find(g => g.id === 'alpha')!;
        expect(alpha.error).toBeNull();
        expect(alpha.members.map(m => m.bot)).toEqual(['tank1', 'heal1']);
        write('groups/alpha/group.json', JSON.stringify({ members: [{ bot: 'tank1' }], bench: [{ bot: 'tank1' }] }));
        expect(discoverGroups([root]).find(g => g.id === 'alpha')!.error).toContain('both a member and on the bench');
        write('groups/alpha/group.json', JSON.stringify({ members: [{ bot: 'tank1' }], bench: [{ name: 'x' }] }));
        expect(discoverGroups([root]).find(g => g.id === 'alpha')!.error).toContain('bench entry 1');
        write('groups/alpha/group.json', JSON.stringify({ members: [{ bot: 'tank1' }], bench: 'nuke1' }));
        expect(discoverGroups([root]).find(g => g.id === 'alpha')!.error).toContain('"bench" must list');
    });

    test('botIdentity and checkControlPassword (security.ts)', async () => {
        expect(botIdentity('tank1', [root])).toEqual({ username: 'tankuser', charName: 'Tanky' });
        expect(botIdentity('nuke1', [root])).toEqual({ username: 'nuke1', charName: 'Nuky' });
        expect(botIdentity('ghost', [root])).toBeNull();
        expect(botIdentity('../tank1', [root])).toBeNull();
        expect(await checkControlPassword('tankuser', '', [root])).toEqual({ ok: false, error: 'Password required', botEnv: false });
        expect(await checkControlPassword('tankuser', 'tank-secret-x', [root])).toMatchObject({ ok: false, botEnv: true });
        expect(await checkControlPassword('tankuser', 'tank-secret-1', [root])).toEqual({ ok: true, botEnv: true });
        // Without a bot.env any non-empty password passes, unless the hook says no.
        expect(await checkControlPassword('nobody', 'x', [root])).toEqual({ ok: true, botEnv: false });
        expect(await checkControlPassword('nobody', 'x', [root], () => ({ success: false, error: 'no' }))).toEqual({ ok: false, error: 'no', botEnv: false });
    });
});

describe('the passive group frame', () => {
    test('every member on one map: last positions, client status, controllers; a dead client keeps its position', async () => {
        start();
        const rat = makeNpc({ objectId: 500, name: 'rat', level: 3, x: 1500, y: 1000, targetObjectId: 1001, inCombat: true });
        await attachBot('tankuser', tankState({ nearbyNpcs: [rat], nearbyPlayers: [makePlayerObj({ objectId: 1002, name: 'Healy' }), makePlayerObj({ objectId: 900, name: 'Hibby', realm: 'hibernia', x: 3000, y: 1000 })] }));
        await attachBot('healuser', healState({ nearbyNpcs: [{ ...rat, x: 1510 }], nearbyPlayers: [makePlayerObj({ objectId: 1001, name: 'Tanky' })], group: [{ name: 'Tanky' } as any, { name: 'Healy' } as any] }));
        const nuke = await attachBot('nuke1', nukeState({ movement: { moving: true, destination: { x: 1, y: 2, z: 3 }, waypoints: [{ x: 1, y: 2, z: 3 }], lastStopReason: null, correctionCount: 0, swimming: false } }));
        nuke.ws.close();
        await until(async () => (await http('/status/nuke1')).body.status === 'dead', 'nuke1 dead');
        await sdk('tankuser', 'control');
        await sdk('healuser', 'observe');

        const { status, body } = await live();
        expect(status).toBe(200);
        expect(body).toMatchObject({ v: 1, id: 'alpha', name: 'Alpha Team', leader: { bot: 'tank1', username: 'tankuser' }, now: clock, run: null, others: [] });
        expect(body.members.map((m: any) => [m.bot, m.username, m.charName, m.role, m.leader, m.client.status])).toEqual([
            ['tank1', 'tankuser', 'Tanky', 'tank', true, 'active'],
            ['heal1', 'healuser', 'Healy', 'healer', false, 'active'],
            ['nuke1', 'nuke1', 'Nuky', 'nuker', false, 'dead'],
        ]);
        expect(body.members[0].client).toMatchObject({ controllers: 1, observers: 0, phase: 'playing', lastError: null });
        expect(body.members[1].client).toMatchObject({ controllers: 0, observers: 1 });
        expect(body.members[0].player).toMatchObject({ name: 'Tanky', objectId: 1001, regionId: 1, x: 1000, y: 1000, hp: 80, level: 10 });
        expect(body.members[2].player).toMatchObject({ name: 'Nuky', x: 900, y: 900 });
        expect(body.members[2].movement).toBeNull();
        expect(body.members[1].inGameGroup).toEqual(['Tanky', 'Healy']);

        // Members are not contacts; the rat is seen by both; Hibby is an enemy.
        expect(body.world.map((w: any) => w.key).sort()).toEqual(['1:500', '1:900']);
        const ratView = body.world.find((w: any) => w.key === '1:500');
        expect(ratView).toMatchObject({ kind: 'npc', name: 'rat', target: 'Tanky', enemy: false, nearest: 310, board: null });
        expect(ratView.seenBy.sort()).toEqual(['Healy', 'Tanky']);
        expect(body.world.find((w: any) => w.key === '1:900')).toMatchObject({ kind: 'player', enemy: true, seenBy: ['Tanky'], npc: null });
        // The tank's list is empty, so the healer's (the largest) is the reference.
        expect(body.grouping).toEqual({ inLeaderGroup: ['Tanky', 'Healy'], missing: ['Nuky'], strangers: [] });
        expect(body.passive).toEqual({ events: [], seq: 0 });
    });

    test('boot is the store\'s start on every frame, the same across polls; a restarted gateway has a new one', async () => {
        start();
        const first = (await live()).body;
        expect(first.boot).toBe(clock);
        clock += 7000;
        expect((await live('?passive=0')).body).toMatchObject({ boot: first.boot, now: first.boot + 7000 });
        // Every cursor a page holds (events, passive) means nothing to the new store.
        await gateway!.stop();
        clock += 1000;
        start();
        expect((await live()).body.boot).toBe(first.boot + 8000);
    });

    test('world contacts merge by region and object id, freshest data first; other regions stay apart', () => {
        const sessions = new Map<string, any>();
        const npc = (x: number) => makeNpc({ objectId: 500, x, y: 1000, targetObjectId: 1002 });
        sessions.set('tankuser', { ws: {}, clientId: 'a', lastStateReceivedAt: 1000, lastState: tankState({ nearbyNpcs: [npc(1500)] }) });
        sessions.set('healuser', { ws: {}, clientId: 'b', lastStateReceivedAt: 2000, lastState: healState({ nearbyNpcs: [npc(1510)] }) });
        sessions.set('nuke1', { ws: {}, clientId: 'c', lastStateReceivedAt: 1500, lastState: nukeState({ nearbyNpcs: [npc(7000)] }, { regionId: 2 }) });
        const group = discoverGroups([root]).find(g => g.id === 'alpha')!;
        const src = { sessions, sdkSessions: new Map(), sessionStatus: (s: any) => (s.ws ? 'active' : 'dead') };
        const view = composePassive(group, src, 3000);
        expect(view.world.map(w => w.key).sort()).toEqual(['1:500', '2:500']);
        const one = view.world.find(w => w.key === '1:500')!;
        expect(one.x).toBe(1510);
        expect(one.seenBy).toEqual(['Healy', 'Tanky']);
        expect(one.target).toBe('Healy');
        const two = view.world.find(w => w.key === '2:500')!;
        expect(two).toMatchObject({ x: 7000, seenBy: ['Nuky'], target: null, nearest: 6101 });
        expect(view.members[0]!.client.stateAge).toBe(2000);

        // Pure: deep-frozen states give the same picture.
        const frozen = new Map([...sessions].map(([k, v]) => [k, deepFreeze(structuredClone(v))]));
        expect(composePassive(group, { ...src, sessions: frozen }, 3000)).toEqual(view);
    });

    test('an NPC at 0 % is dead only with a fresh death event: under 1 % reads 0 alive (GameLiving.cs:2621)', () => {
        const T = 1_800_000_000_000;
        const npc = makeNpc({ objectId: 500, name: 'wolf', x: 1100, y: 1000, healthPercent: 0, targetObjectId: 1001 });
        const see = (combatEvents: CombatEvent[], over: Partial<NearbyNpc> = {}) => {
            const sessions = new Map<string, any>();
            sessions.set('tankuser', { ws: {}, clientId: 'a', lastStateReceivedAt: T, lastState: tankState({ timestamp: T, nearbyNpcs: [{ ...npc, ...over }], combatEvents }) });
            const group = discoverGroups([root]).find(g => g.id === 'alpha')!;
            return composePassive(group, { sessions, sdkSessions: new Map(), sessionStatus: () => 'active' }, T).world.find(w => w.key === '1:500')!;
        };
        const died = (ago: number): CombatEvent => ({ id: 1, kind: 'death', attackerObjectId: null, targetObjectId: 500, receivedAt: T - ago });
        // Alive at the floor, so the panel keeps listing it and the map doesn't draw it dead.
        expect(see([])).toMatchObject({ hp: 1, isDead: false, target: 'Tanky' });
        expect(see([died(5000)])).toMatchObject({ hp: 1, isDead: false });
        expect(see([{ ...died(100), targetObjectId: 501 }])).toMatchObject({ hp: 1, isDead: false });
        expect(see([died(300)])).toMatchObject({ hp: 0, isDead: true });
        // Above 0 % nothing changes, an event or not.
        expect(see([], { healthPercent: 37 })).toMatchObject({ hp: 37, isDead: false });
        expect(see([died(300)], { healthPercent: 100 })).toMatchObject({ hp: 100, isDead: false });
    });

    describe('pets, with no run', () => {
        const T = 1_800_000_000_000;
        const WINDOW = { objectId: 600, name: 'old name', aggression: 'defensive', walk: 'follow', icons: [5, 6], targetObjectId: 500 } as const;
        const compose = (states: Record<string, BotWorldState>, gone: string[] = []) => {
            const sessions = new Map<string, any>();
            for (const [username, lastState] of Object.entries(states)) sessions.set(username, { ws: gone.includes(username) ? null : {}, clientId: username, lastStateReceivedAt: T, lastState });
            const group = discoverGroups([root]).find(g => g.id === 'alpha')!;
            return composePassive(group, { sessions, sdkSessions: new Map(), sessionStatus: (s: any) => (s.ws ? 'active' : 'dead') }, T);
        };
        const pet = (over: Partial<NearbyNpc> = {}) => makeNpc({ objectId: 600, name: 'spirit warrior', level: 17, x: 1010, y: 990, z: 5, healthPercent: 84, inCombat: true, isPet: true, ...over });

        test('a member\'s window pet: its entry\'s level, place and health, its target from the window (a caster pet\'s entry reads 0 and 65535)', () => {
            const view = compose({ tankuser: tankState({ pet: { ...WINDOW, icons: [5, 6] }, nearbyNpcs: [pet({ targetObjectId: 0 })] }) });
            expect(view.members[0]!.pet).toEqual({
                objectId: 600, name: 'spirit warrior', level: 17, x: 1010, y: 990, z: 5, hp: 84, targetId: 500, inCombat: true, aggression: 'defensive', walk: 'follow', icons: [5, 6],
            });
        });

        test('out of view it keeps its window\'s name and has no place; null without one; absent from an older client or one gone', () => {
            const view = compose({
                tankuser: tankState({ pet: { ...WINDOW, icons: [5, 6] } }),
                healuser: healState({ pet: null }),
                nuke1: nukeState({ pet: { ...WINDOW, objectId: 700, icons: [] } }),
            }, ['nuke1']);
            expect(view.members[0]!.pet).toEqual({ objectId: 600, name: 'old name', level: null, x: null, y: null, z: null, hp: null, targetId: 500, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [5, 6] });
            expect(view.members[1]!.pet).toBeNull();
            expect('pet' in view.members[2]!).toBe(false);
            expect('pet' in compose({ tankuser: tankState() }).members[0]!).toBe(false);
            // A broken one from a client is none of the page's problem.
            expect(compose({ tankuser: tankState({ pet: { objectId: 'x' } as any }) }).members[0]!.pet).toBeNull();
        });

        test('pets with no window: their ids on the member, absent without any', () => {
            const view = compose({ tankuser: tankState({ summons: [601, 'x' as any, 602] }), healuser: healState({ summons: [] }) });
            expect(view.members[0]!.summons).toEqual([601, 602]);
            expect('summons' in view.members[1]!).toBe(false);
        });

        test('npc.owner says whose pet it is, whoever sees it: the window\'s without the flag (a charm), summons only with it (their ids linger and get reused)', () => {
            const rat = makeNpc({ objectId: 500, name: 'rat', x: 1100, y: 1000 });
            const view = compose({
                tankuser: tankState({
                    pet: { ...WINDOW, icons: [] },
                    nearbyNpcs: [pet(), rat, makeNpc({ objectId: 700, name: 'ice being', isPet: true, x: 1100, y: 1100 }), makeNpc({ objectId: 701, name: 'wolf', x: 1100, y: 1200 })],
                }),
                // The healer sees the tank's pet with no flag yet, and owns 700 and, as far as it knows, 701.
                healuser: healState({ summons: [700, 701], nearbyNpcs: [pet({ isPet: false })] }),
            });
            const npc = (id: number) => view.world.find(w => w.objectId === id)!.npc!;
            expect(npc(600)).toMatchObject({ isPet: true, owner: 'Tanky' });
            expect(npc(700)).toMatchObject({ isPet: true, owner: 'Healy' });
            expect('owner' in npc(701)).toBe(false);
            expect(npc(701).isPet).toBe(false);
            expect('owner' in npc(500)).toBe(false);
            // A charm no other client flags yet: the window says it's ours.
            const charm = compose({ tankuser: tankState({ pet: { ...WINDOW, icons: [] }, nearbyNpcs: [pet({ isPet: false })] }) });
            expect(charm.world[0]!.npc).toMatchObject({ isPet: true, owner: 'Tanky' });
        });

        test('no owner from a client gone (the server hands its pet\'s id on), and none across regions', () => {
            const view = compose({
                tankuser: tankState({ nearbyNpcs: [makeNpc({ objectId: 600, name: 'rat', x: 1100, y: 1000 })] }),
                nuke1: nukeState({ pet: { ...WINDOW, icons: [] } }),
                healuser: healState({ pet: { ...WINDOW, icons: [] } }, { regionId: 2 }),
            }, ['nuke1']);
            expect('owner' in view.world[0]!.npc!).toBe(false);
        });

        test('an enemy pet has no owner: the server sends every client the flag and the realm, never who', () => {
            const view = compose({ tankuser: tankState({ nearbyNpcs: [makeNpc({ objectId: 800, name: 'spirit warrior', realm: 'midgard', isPet: true, x: 1100, y: 1000 })] }) });
            expect(view.world[0]).toMatchObject({ realm: 'midgard', enemy: true, npc: { isPet: true } });
            expect('owner' in view.world[0]!.npc!).toBe(false);
        });

        test('a shade says so on its contact, with or without a board: "Briton L24 100%, seen 3, 1166 away" for model 822, no tag to say why', () => {
            const view = compose({ tankuser: tankState({ nearbyPlayers: [makePlayerObj({ objectId: 800, name: 'Briton', realm: 'midgard', isShade: true, x: 1100, y: 1000 }), makePlayerObj({ objectId: 801, name: 'Troll', realm: 'midgard', x: 1200, y: 1000 })] }) });
            expect(view.world.find((w: any) => w.objectId === 800)).toMatchObject({ kind: 'player', isShade: true });
            expect('isShade' in view.world.find((w: any) => w.objectId === 801)!).toBe(false);
        });

        test('enemy is another realm\'s player or pet: not a monster\'s pet, nor one of our realm, nor a member\'s', () => {
            const view = compose({ tankuser: tankState({ pet: { ...WINDOW, icons: [] }, nearbyNpcs: [
                pet({ isPet: true }),
                makeNpc({ objectId: 801, name: 'friend\'s wolf', realm: 'albion', isPet: true, x: 1100, y: 1000 }),
                makeNpc({ objectId: 802, name: 'bone servant', realm: 'none', isPet: true, x: 1100, y: 1000 }),
                makeNpc({ objectId: 803, name: 'guard', realm: 'midgard', x: 1100, y: 1000 }),
                makeNpc({ objectId: 804, name: 'spirit warrior', realm: 'midgard', isPet: true, x: 1100, y: 1000 }),
            ] }) });
            const enemy = (id: number) => view.world.find((w: any) => w.objectId === id)!.enemy;
            expect([enemy(801), enemy(802), enemy(803), enemy(804)]).toEqual([false, false, false, true]);
            expect(view.world.find((w: any) => w.npc?.owner)!.enemy).toBe(false);
        });

        test('a mob on a member\'s pet names its owner, a window pet\'s or one with no window\'s; on the member itself `target` says so', () => {
            const view = compose({
                tankuser: tankState({
                    pet: { ...WINDOW, icons: [] }, summons: [601],
                    nearbyNpcs: [
                        pet(),
                        makeNpc({ objectId: 500, name: 'rat', x: 1100, y: 1000, targetObjectId: 600 }),
                        makeNpc({ objectId: 501, name: 'cat', x: 1100, y: 1000, targetObjectId: 601 }),
                        makeNpc({ objectId: 502, name: 'bat', x: 1100, y: 1000, targetObjectId: 1001 }),
                        makeNpc({ objectId: 503, name: 'owl', x: 1100, y: 1000 }),
                    ],
                }),
            });
            const c = (id: number) => view.world.find(w => w.objectId === id)!;
            expect(c(500)).toMatchObject({ target: null, targetPet: 'Tanky' });
            expect(c(501)).toMatchObject({ target: null, targetPet: 'Tanky' });
            expect(c(502).target).toBe('Tanky');
            expect('targetPet' in c(502)).toBe(false);
            expect('targetPet' in c(503)).toBe(false);
        });
    });

    test('grouping names missing members and strangers', () => {
        const sessions = new Map<string, any>();
        sessions.set('tankuser', { ws: {}, clientId: 'a', lastStateReceivedAt: 1, lastState: tankState({ group: [{ name: 'Tanky' }, { name: 'Healy' }, { name: 'Randomguy' }] as any }) });
        sessions.set('healuser', { ws: {}, clientId: 'b', lastStateReceivedAt: 1, lastState: healState() });
        const group = discoverGroups([root]).find(g => g.id === 'alpha')!;
        const view = composePassive(group, { sessions, sdkSessions: new Map(), sessionStatus: () => 'active' }, 10);
        expect(view.grouping).toEqual({ inLeaderGroup: ['Tanky', 'Healy'], missing: ['Nuky'], strangers: ['Randomguy'] });
    });

    test('a departed member\'s old object id hides nothing; a link-dead member seen by the others is still a member', () => {
        const sessions = new Map<string, any>();
        // The server gave Healy's freed id 1002 to a respawned boar; Nuky's client dropped while Nuky still
        // stands in the world as player #1010 (its last state says #1003).
        const boar = makeNpc({ objectId: 1002, name: 'respawned boar', x: 1100, y: 1000, targetObjectId: 1010 });
        const wolf = makeNpc({ objectId: 600, name: 'wolf', x: 1050, y: 1000, targetObjectId: 1002 });
        sessions.set('tankuser', { ws: {}, clientId: 'a', lastStateReceivedAt: 3000, lastState: tankState({ nearbyNpcs: [boar, wolf], nearbyPlayers: [makePlayerObj({ objectId: 1010, name: 'Nuky', x: 990, y: 1000 })] }) });
        sessions.set('healuser', { ws: null, clientId: 'b', lastStateReceivedAt: 1, lastState: healState({}, { x: 9000, y: 9000 }) });
        sessions.set('nuke1', { ws: null, clientId: 'c', lastStateReceivedAt: 2000, lastState: nukeState() });
        const group = discoverGroups([root]).find(g => g.id === 'alpha')!;
        const view = composePassive(group, { sessions, sdkSessions: new Map(), sessionStatus: (s: any) => (s.ws ? 'active' : 'dead') }, 3000);
        expect(view.world.map(w => [w.key, w.name, w.target])).toEqual([
            ['1:600', 'wolf', null],
            ['1:1002', 'respawned boar', 'Nuky'],
        ]);
        // Their last players stay on the page.
        expect(view.members.map(m => [m.player?.objectId, m.client.status])).toEqual([[1001, 'active'], [1002, 'dead'], [1003, 'dead']]);
    });
});

describe('group auth', () => {
    test('live, runs and publish need the leader\'s credential under an auth hook; the query string never counts', async () => {
        start({ auth: hook });
        expect((await http('/groups')).status).toBe(200);
        const none = await live();
        expect(none.status).toBe(401);
        expect(none.body.auth).toEqual({ bot: 'tank1', username: 'tankuser' });
        expect((await live('', bearer('heal-secret-2'))).status).toBe(401);
        expect((await live('?password=tank-secret-1')).status).toBe(401);
        expect((await live('', bearer('tank-secret-1'))).status).toBe(200);
        expect((await http('/groups/alpha/runs')).status).toBe(401);
        expect((await http('/groups/alpha/runs', { headers: bearer('tank-secret-1') })).status).toBe(200);
        expect((await http('/groups/alpha/runs/20261031-120000', { headers: bearer('nuke-secret-3') })).status).toBe(401);
        const refused = await publish(makePublish());
        expect(refused.status).toBe(401);
        expect(refused.body).toMatchObject({ ok: false, v: 1 });
        expect((await publish(makePublish(), bearer('heal-secret-2'))).status).toBe(401);
        // A roster or leader mismatch is named before the password (both are public on /groups) ...
        expect((await publish(makePublish({ roster: ROSTER.slice(0, 2) }))).status).toBe(409);
        expect((await publish(makePublish({ roster: ROSTER.slice(0, 2) }), bearer('tank-secret-1'))).status).toBe(409);
        // ... but the password comes before any sanitising: a stranger's malformed body is a 401, never a 400.
        expect((await publish({ ...makePublish(), state: 'dancing' })).status).toBe(401);
        expect((await publish({ ...makePublish(), state: 'dancing' }, bearer('tank-secret-1'))).status).toBe(400);
        expect((await publish(makePublish(), bearer('tank-secret-1'))).body.ok).toBe(true);
        expect((await publish({ ...makePublish(), password: 'tank-secret-1' })).body.ok).toBe(true);
    });

    test('a wind-down needs the leader\'s bot.env password even without an auth hook', async () => {
        start();
        expect((await live()).status).toBe(200); // open on loopback, like /state
        const empty = await windDown({ runId: RUN });
        expect(empty.status).toBe(401);
        expect(empty.body).toMatchObject({ ok: false, error: 'Password required', auth: { bot: 'tank1', username: 'tankuser' } });
        expect((await windDown({ runId: RUN, password: 'wrong' })).body.error).toContain('does not match');
        expect((await windDown({ runId: RUN, password: 'heal-secret-2' })).status).toBe(401);
        expect((await windDown({ runId: RUN }, bearer('heal-secret-2'))).status).toBe(401);
        // The right password gets past auth, to the run checks.
        expect((await windDown({ runId: RUN, password: 'tank-secret-1' })).body).toEqual({ ok: false, error: 'no live run' });
        expect((await windDown({ runId: RUN }, bearer('tank-secret-1'))).status).toBe(409);
    });
});

describe('group run publishes', () => {
    test('validation: 415, 413, 400, 404 (nothing stored), 409 on group, leader or roster mismatch', async () => {
        start({}, { maxPublishBytes: 4000 });
        expect((await http('/groups/alpha/publish', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(makePublish()) })).status).toBe(415);
        const big = await publish({ ...makePublish(), padding: 'x'.repeat(5000) });
        expect(big.status).toBe(413);
        expect(big.body).toMatchObject({ ok: false, v: 1 });
        // A chunked body has no Content-Length: reading stops at the cap.
        const chunk = new TextEncoder().encode(JSON.stringify({ ...makePublish(), padding: 'x'.repeat(5000) }));
        const stream = new ReadableStream({ start(c) { c.enqueue(chunk.subarray(0, 2000)); c.enqueue(chunk.subarray(2000)); c.close(); } });
        expect((await http('/groups/alpha/publish', { method: 'POST', headers: JSON_HEADERS, body: stream, duplex: 'half' } as RequestInit)).status).toBe(413);
        expect((await publish('{ nope')).status).toBe(400);
        const v2 = await publish({ ...makePublish(), v: 2 });
        expect(v2.status).toBe(400);
        expect(v2.body.error).toContain('not supported');
        expect((await publish(makePublish({ runId: 'x' }))).status).toBe(400);
        expect((await publish({ ...makePublish(), state: 'dancing' })).status).toBe(400);
        expect((await publish({ ...makePublish(), meta: null })).status).toBe(400);
        expect((await publish(makePublish({ group: 'nosuch' }), {}, 'nosuch')).status).toBe(404);
        expect((await publish(makePublish({ group: 'beta' }))).body.error).toContain('group mismatch');
        expect((await publish(makePublish({ leader: 'heal1' }))).body.error).toContain('leader mismatch');
        const roster = await publish(makePublish({ roster: ROSTER.slice(0, 2) }));
        expect(roster.status).toBe(409);
        expect(roster.body.error).toContain('roster mismatch');
        expect((await publish(makePublish({ roster: [...ROSTER.slice(0, 2), { bot: 'x', username: 'intruder' }] }))).status).toBe(409);
        expect((await publish({ ...makePublish(), group: 'broken', leader: 'tank1' }, {}, 'broken')).status).toBe(409);
        // None of it was stored.
        expect((await http('/groups')).body.groups.every((g: any) => g.run === null)).toBe(true);
        expect((await live('', {}, 'nosuch')).status).toBe(404);
        // Usernames match ignoring case.
        const ok = await publish(makePublish({ roster: ROSTER.map(r => ({ ...r, username: r.username.toUpperCase() })) }));
        expect(ok.body).toEqual({ ok: true, v: 1, ackSeq: 0, control: [] });
    });

    test('the frame merges the run: members\' activities, board contacts, orders, timing', async () => {
        start();
        await attachBot('tankuser', tankState({ nearbyNpcs: [makeNpc({ objectId: 500, x: 1400, y: 1000 })] }));
        await publish(makePublish());
        const { body } = await live();
        expect(body.run).toMatchObject({
            runId: RUN, state: 'live', current: true, error: null, strategy: 'test-pve', skewMs: 20,
            orders: { phase: 'engage', focus: 500, reason: 'rat attacks the group' }, pictureAt: clock,
            timing: { windingDown: false, deadline: clock + 900_000 }, coordinator: null, control: [], result: null,
        });
        expect(body.run.meta).toMatchObject({ strategy: 'test-pve', settings: { huntRadius: 2200 }, control: true });
        expect(body.members[0].run).toMatchObject({ name: 'Tanky', role: 'tank', activity: { kind: 'melee', detail: 'tank' }, can: { heal: false, cc: false, nuke: true } });
        // group.json has no role for nuke1: the run's wins over its class.
        expect(body.members[2].role).toBe('support');
        expect(body.world[0].board).toMatchObject({ threat: true, stale: false, cc: { by: 'Nuky', kind: 'mezz' }, seenBy: ['Tanky'] });
        // A monster's board entry has no player flags, a PvE member no realm points.
        expect('healer' in body.world[0].board || 'realmPoints' in body.members[0].run).toBe(false);
        expect((await http('/groups')).body.groups[0].run).toMatchObject({ runId: RUN, state: 'live', strategy: 'test-pve', phase: 'engage', windingDown: false });
    });

    test('RvR: an enemy player\'s board flags and the members\' realm points reach the frame', async () => {
        start();
        await attachBot('tankuser', tankState({ nearbyPlayers: [makePlayerObj({ objectId: 700, name: 'Troll', realm: 'midgard', x: 1500, y: 1000 })] }));
        const body = makePublish();
        body.picture.members[0]!.realmPoints = 1250;
        body.picture.contacts = [contact(700, { regionId: 1, kind: 'player', name: 'Troll', realm: 'midgard', threat: true, casting: true, helped: false, healer: true, caster: true })];
        await publish(body);
        const frame = (await live()).body;
        expect(frame.members[0].run.realmPoints).toBe(1250);
        expect(frame.world.find((w: any) => w.objectId === 700)).toMatchObject({ enemy: true, board: { threat: true, casting: true, helped: false, healer: true, caster: true } });
    });

    test('pets: a member\'s capability and what a contact is on reach the frame; a group with none has no new fields', async () => {
        start();
        const petEntry = makeNpc({ objectId: 600, name: 'spirit warrior', x: 1010, y: 990, isPet: true });
        await attachBot('tankuser', tankState({
            pet: { objectId: 600, aggression: 'aggressive', walk: 'stay', icons: [], targetObjectId: 500 }, summons: [601],
            nearbyNpcs: [petEntry, makeNpc({ objectId: 500, name: 'rat', x: 1500, y: 1000, targetObjectId: 600 })],
        }));
        await attachBot('healuser', healState({ pet: null }));
        const body = makePublish();
        body.picture.members[0]!.capabilities.pet = 'main';
        body.picture.members[1]!.capabilities.pet = null;
        body.picture.contacts = [contact(500, { regionId: 1, threat: true, targetPet: 'Tanky' })];
        await publish(body);
        const frame = (await live()).body;
        expect(frame.members[0].run.can).toEqual({ heal: false, cc: false, nuke: true, pet: 'main' });
        expect(frame.members[1].run.can.pet).toBeNull();
        expect('pet' in frame.members[2].run.can).toBe(false);
        // The member's own state says what its pet does, run or no run.
        expect(frame.members[0].pet).toMatchObject({ objectId: 600, aggression: 'aggressive', walk: 'stay', targetId: 500 });
        expect(frame.members[0].summons).toEqual([601]);
        const rat = frame.world.find((w: any) => w.objectId === 500);
        expect(rat).toMatchObject({ targetPet: 'Tanky', board: { threat: true, targetPet: 'Tanky' } });
        expect(frame.world.find((w: any) => w.objectId === 600).npc).toMatchObject({ isPet: true, owner: 'Tanky' });

        const plain = makePublish();
        plain.picture.contacts = [contact(500, { regionId: 1 })];
        await publish(plain);
        const after = (await live()).body;
        expect('targetPet' in after.world.find((w: any) => w.objectId === 500).board).toBe(false);
        expect('pet' in after.members[1].run.can).toBe(false);
    });

    test('events: resends are skipped, holes counted, ackSeq follows; ?events= pages', async () => {
        start({}, { maxEventsPerFrame: 4 });
        const ev = (n: number) => ({ seq: n, at: clock, kind: 'note' as const, text: `event ${n}` });
        expect((await publish(makePublish({ events: [1, 2, 3].map(ev) }))).body.ackSeq).toBe(3);
        expect((await publish(makePublish({ events: [2, 3, 4, 5].map(ev) }))).body.ackSeq).toBe(5);
        // The runner's outbox dropped 6 and 7: the hole and `dropped` are the same two events, counted once.
        expect((await publish(makePublish({ events: [ev(8)], dropped: 2 }))).body.ackSeq).toBe(8);
        const first = (await live()).body.run;
        expect(first.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4]);
        expect(first).toMatchObject({ eventSeq: 8, eventsFrom: 1, lostEvents: 2, moreEvents: true });
        const next = (await live(`?run=${RUN}&events=4`)).body.run;
        expect(next.events.map((e: any) => e.seq)).toEqual([5, 8]);
        expect(next.moreEvents).toBe(false);
        // Another run's cursor does not apply to this one.
        expect((await live('?run=run-other-0009&events=4')).body.run.events[0].seq).toBe(1);

        // A run first seen mid-way (a gateway restart) starts at its first stored seq, with no loss counted.
        clock += 1000;
        await publish(makePublish({ runId: 'run-later-0002', publishSeq: 1, events: [ev(40), ev(41)] }));
        expect((await live()).body.run).toMatchObject({ runId: 'run-later-0002', eventsFrom: 40, lostEvents: 0, eventSeq: 41 });
    });

    test('a snapshot older than the last one changes nothing but its events still count', async () => {
        start();
        await publish(makePublish({ publishSeq: 5 }));
        await publish(makePublish({ publishSeq: 4, state: 'ending', events: [{ seq: 1, at: clock, kind: 'note', text: 'late' }] }));
        const { run } = (await live()).body;
        expect(run.state).toBe('live');
        expect(run.eventSeq).toBe(1);
    });

    test('plan and report persist when omitted; meta, plan and report only when the page does not have them', async () => {
        start();
        const plan = { base: { x: 1, y: 2, z: 3 }, facing: { x: 5, y: 5 }, score: 7, margin: 2, targets: [{ name: 'rat', level: 3, x: 10, y: 10, d: 100 }], unsafe: [] };
        const liveReport = { group: 'alpha', strategy: 'test-pve', totals: { kills: 2 }, openFight: true };
        await publish(makePublish({ plan, planRev: 1, report: liveReport as any, reportRev: 1 }));
        await publish(makePublish());
        const full = (await live()).body.run;
        expect(full.plan).toEqual(plan);
        expect(full.report).toEqual(liveReport);
        expect(full).toMatchObject({ planRev: 1, reportRev: 1 });
        expect(full.meta.strategy).toBe('test-pve');
        const same = (await live(`?run=${RUN}&planRev=1&reportRev=1`)).body.run;
        expect('meta' in same || 'plan' in same || 'report' in same).toBe(false);
        const newPlan = (await live(`?run=${RUN}&planRev=0&reportRev=1`)).body.run;
        expect(newPlan.plan).toEqual(plan);
        expect('report' in newPlan).toBe(false);
        expect((await live('?run=run-other-0009&planRev=1&reportRev=1')).body.run.meta).toBeDefined();
        // null clears it.
        await publish(makePublish({ plan: null, planRev: 2 }));
        expect((await live()).body.run).toMatchObject({ plan: null, planRev: 2 });
    });

    test('run states follow the publish age: starting, live, stale, lost, revived, ending, ended', async () => {
        start();
        const state = async () => (await live()).body.run.state;
        await publish(makePublish({ state: 'starting' }));
        expect(await state()).toBe('starting');
        clock += 1000;
        await publish(makePublish());
        expect(await state()).toBe('live');
        clock += 5001;
        expect(await state()).toBe('stale');
        clock += 25_000;
        expect(await state()).toBe('lost');
        expect((await http('/groups')).body.groups[0].run).toMatchObject({ state: 'lost', phase: null, ageMs: 30_001 });
        await publish(makePublish());
        expect(await state()).toBe('live');
        await publish(makePublish({ state: 'ending', error: 'aborted' }));
        expect(await state()).toBe('ending');
        clock += 30_001;
        expect(await state()).toBe('ended');
        expect((await live()).body.run.error).toBe('aborted');

        clock += 1000;
        const result = { totals: { kills: 3, deaths: 0, wipes: 0, retreats: 0, fights: 3, killsPerHour: 12, xpPerHour: 1000, avgFightMs: 9000, downtime: 20, tankHold: 90 }, findings: ['low pace: slow'], stamp: '20261031-130000', stoppedBy: 'viewer' as const };
        await publish(makePublish({ runId: 'run-done-0002', publishSeq: 1, state: 'ended', result }));
        expect((await live()).body.run).toMatchObject({ runId: 'run-done-0002', state: 'ended', result });
    });

    test('runStateOf boundaries', () => {
        const at = (declared: any, age: number) => runStateOf({ declared, lastAt: 0 }, age);
        expect([at('running', 5000), at('running', 5001), at('running', 30_000), at('running', 30_001)]).toEqual(['live', 'stale', 'stale', 'lost']);
        expect([at('starting', 30_000), at('starting', 30_001)]).toEqual(['starting', 'lost']);
        expect([at('ending', 30_000), at('ending', 30_001), at('ended', 0)]).toEqual(['ending', 'ended', 'ended']);
        expect(runStateOf({ declared: 'running', lastAt: 0 }, 101, { staleMs: 100 })).toBe('stale');
    });

    test('a newer run becomes current, the older is listed in others; a lost newer run gives way to a live older one', async () => {
        start();
        await publish(makePublish({ runId: 'run-old-00001' }));
        clock += 1000;
        await publish(makePublish({ runId: 'run-new-00002', publishSeq: 1 }));
        let body = (await live()).body;
        expect(body.run.runId).toBe('run-new-00002');
        expect(body.others).toEqual([{ runId: 'run-old-00001', state: 'live', firstAt: clock - 1000, strategy: 'test-pve' }]);
        clock += 31_000;
        await publish(makePublish({ runId: 'run-old-00001' }));
        body = (await live()).body;
        expect(body.run.runId).toBe('run-old-00001');
        expect(body.others[0]).toMatchObject({ runId: 'run-new-00002', state: 'lost' });
    });

    test('caps: ended runs make room first, 503 when every slot is live, a group keeps two, the event ring is capped', async () => {
        start({}, { maxRuns: 2, maxEventsPerRun: 5 });
        await publish(makePublish({ runId: 'run-a1-000001', state: 'ended' }));
        await publish(makePublish({ ...BETA, runId: 'run-b1-000001' }), {}, 'beta');
        // Full: the ended alpha run goes.
        clock += 1000;
        expect((await publish(makePublish({ runId: 'run-a2-000001', publishSeq: 1 }))).status).toBe(200);
        let alpha = (await live()).body;
        expect(alpha.run.runId).toBe('run-a2-000001');
        expect(alpha.others).toEqual([]);
        // Full of live runs: refused, nothing stored.
        const refused = await publish(makePublish({ ...BETA, runId: 'run-b2-000001', publishSeq: 1 }), {}, 'beta');
        expect(refused.status).toBe(503);
        expect(refused.body.ok).toBe(false);
        expect((await live('', {}, 'beta')).body.run.runId).toBe('run-b1-000001');
        // The ring keeps the newest 5.
        const ev = (n: number) => ({ seq: n, at: clock, kind: 'note' as const, text: `e${n}` });
        await publish(makePublish({ runId: 'run-a2-000001', events: [1, 2, 3, 4, 5, 6, 7, 8].map(ev) }));
        alpha = (await live()).body;
        expect(alpha.run.events.map((e: any) => e.seq)).toEqual([4, 5, 6, 7, 8]);
        expect(alpha.run.eventsFrom).toBe(4);
    });

    test('a group keeps at most two runs: the oldest one that is not current goes', async () => {
        start();
        for (const [i, id] of ['run-one-000001', 'run-two-000001', 'run-three-0001'].entries()) {
            clock += 1000;
            expect((await publish(makePublish({ runId: id, publishSeq: i + 1 }))).status).toBe(200);
        }
        const body = (await live()).body;
        expect(body.run.runId).toBe('run-three-0001');
        expect(body.others.map((o: any) => o.runId)).toEqual(['run-two-000001']);
    });
});

describe('wind-down', () => {
    test('lifecycle: 409 without a live run or for another run; pending → delivered → applied; idempotent; 403 when the run refuses', async () => {
        start();
        const pw = { password: 'tank-secret-1' };
        expect((await windDown({ runId: RUN, ...pw })).body).toEqual({ ok: false, error: 'no live run' });
        await publish(makePublish());
        const other = await windDown({ runId: 'run-other-0002', ...pw });
        expect(other.status).toBe(409);
        expect(other.body.error).toBe(`run changed: the live run is ${RUN}`);
        const first = await windDown({ runId: RUN, reason: 'enough for today', ...pw });
        expect(first.status).toBe(200);
        expect(first.body.request).toMatchObject({ runId: RUN, kind: 'windDown', reason: 'enough for today', requestedAt: clock, deliveredAt: null, appliedAt: null });
        const id = first.body.request.id;
        expect((await windDown({ runId: RUN }, bearer('tank-secret-1'))).body.request.id).toBe(id);
        expect((await live()).body.run.control).toEqual([first.body.request]);

        clock += 1000;
        const ack = (await publish(makePublish())).body;
        expect(ack.control).toEqual([{ id, runId: RUN, kind: 'windDown', reason: 'enough for today', requestedAt: clock - 1000 }]);
        expect((await live()).body.run.control[0]).toMatchObject({ deliveredAt: clock, appliedAt: null });
        clock += 1000;
        expect((await publish(makePublish({ applied: [id] }))).body.control).toEqual([]);
        expect((await live()).body.run.control[0]).toMatchObject({ deliveredAt: clock - 1000, appliedAt: clock });
        expect((await windDown({ runId: RUN, ...pw })).body.request).toMatchObject({ id, appliedAt: clock });

        await publish(makePublish({ state: 'ending' }));
        expect((await windDown({ runId: RUN, ...pw })).body.error).toBe('no live run');

        clock += 1000;
        await publish(makePublish({ runId: 'run-locked-001', publishSeq: 1, meta: { ...makePublish().meta, control: false } }));
        const locked = await windDown({ runId: 'run-locked-001', ...pw });
        expect(locked.status).toBe(403);
        expect(locked.body.ok).toBe(false);
        expect((await post('/groups/alpha/control', { kind: 'stop', runId: 'run-locked-001', ...pw })).status).toBe(400);
        expect((await http('/groups/alpha/control', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
        expect((await post('/groups/nosuch/control', { kind: 'windDown', runId: RUN, ...pw })).status).toBe(404);
    });
});

describe('group isolation', () => {
    test('group routes never send anything on bot or SDK sockets', async () => {
        start();
        const bot = await attachBot('tankuser', tankState());
        const ctl = await sdk('tankuser', 'control');
        const before = { bot: bot.messages.length, sdk: ctl.messages.length };
        await http('/groups');
        await live();
        await publish(makePublish());
        await windDown({ runId: RUN, password: 'tank-secret-1' });
        await publish(makePublish());
        await http('/groups/alpha/runs');
        await http('/groups/alpha/runs/20261031-120000');
        await http('/status/tankuser');
        await http('/bots');
        await pause(50);
        expect(bot.messages.slice(before.bot)).toEqual([]);
        expect(ctl.messages.slice(before.sdk)).toEqual([]);
        const all = (await http('/status')).body;
        expect(Object.values(all.sdks)).toEqual([{ clientId: 'test-control', targetUsername: 'tankuser', mode: 'control' }]);
        expect(ctl.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('a throwing store answers 500 and the gateway keeps relaying states', async () => {
        start({ auth: ({ kind }) => { if (kind === 'http') throw new Error('hook exploded'); return { success: true }; } });
        const failed = await live();
        expect(failed.status).toBe(500);
        expect(failed.body.ok).toBe(false);
        expect((await http('/groups')).status).toBe(200);
        const bot = await attachBot('tankuser', tankState());
        const observer = await sdk('tankuser', 'observe');
        bot.send({ type: 'state', state: tankState({ tick: 2 } as any) });
        await until(() => observer.messages.filter(m => m.type === 'sdk_state').length >= 2, 'states relayed');
    });

    test('the store survives broken session maps and states', async () => {
        const broken = new Proxy(new Map(), { get() { throw new Error('boom'); } }) as any;
        const store = createGroupStore({
            roots: [root], groupsDir: join(root, 'groups'), sessions: broken, sdkSessions: broken,
            sessionStatus: () => { throw new Error('boom'); }, auth: () => ({ success: true }), log: () => {},
        });
        stores.push(store);
        const res = await store.handle(new Request('http://x/groups/alpha/live'), new URL('http://x/groups/alpha/live'));
        expect(res!.status).toBe(500);
        expect(await store.handle(new Request('http://x/status'), new URL('http://x/status'))).toBeNull();
        expect(await store.handle(new Request('http://x/groupsx'), new URL('http://x/groupsx'))).toBeNull();
        expect(() => store.tick()).not.toThrow();
        expect(store.badge('tankuser')).toMatchObject({ id: 'alpha', run: null });
        const state = tankState();
        Object.defineProperty(state, 'player', { get() { throw new Error('boom'); } });
        expect(() => store.onState('tankuser', state)).not.toThrow();
        expect(() => store.onState('tankuser', null as any)).not.toThrow();
    });
});

describe('hostile requests', () => {
    /** A publish holding `events` event.data blobs nested 20k deep and settings nested 10k deep (~460 KB). */
    function deepPublish(events = 11): string {
        const body = makePublish({ events: Array.from({ length: events }, (_, i) => ({ seq: i + 1, at: clock, kind: 'note' as const, text: 'x', data: { d: '@DEEP@' } })) });
        body.meta.settings = '@SETTINGS@';
        return JSON.stringify(body).replaceAll('"@DEEP@"', nested(20_000)).replace('"@SETTINGS@"', nested(10_000));
    }

    test('a long run of slashes answers 404 at once; trailing slashes are trimmed in linear time', async () => {
        const f = fakeStore();
        const path = `/groups${'/'.repeat(20_000)}x`;
        const t0 = performance.now();
        const res = await f.store.handle(new Request(`http://127.0.0.1${path}`), new URL(`http://127.0.0.1${path}`));
        expect(performance.now() - t0).toBeLessThan(50);
        expect(res!.status).toBe(404);
        const t1 = performance.now();
        expect(groupPath(`/groups/alpha${'/'.repeat(200_000)}x`)).toHaveLength(200_001);
        expect(performance.now() - t1).toBeLessThan(50);
        expect([groupPath('/groups'), groupPath('/groups/'), groupPath('/groups/alpha/live///'), groupPath('/groups//alpha')])
            .toEqual([[], [], ['alpha', 'live'], ['', 'alpha']]);
        expect((await f.frame('/')).id).toBe('alpha');
        const status = async (p: string) => (await f.store.handle(new Request(`http://127.0.0.1${p}`), new URL(`http://127.0.0.1${p}`)))!.status;
        expect(await status('/groups//alpha/live')).toBe(404);
        // Over 512 characters is refused even when it trims to a valid path.
        expect(await status(`/groups/alpha/live${'/'.repeat(500)}`)).toBe(404);
        expect(await status(`/groups/alpha/live${'/'.repeat(400)}`)).toBe(200);
    });

    test('an unauthenticated publish of deeply nested blobs is refused before any of them is walked', async () => {
        start({ auth: hook });
        await http('/groups');
        const body = deepPublish();
        expect(body.length).toBeGreaterThan(450_000);
        const t0 = performance.now();
        const res = await publish(body);
        expect(performance.now() - t0).toBeLessThan(100);
        expect(res.status).toBe(401);
        expect((await http('/groups')).body.groups[0].run).toBeNull();
    });

    test('the leader\'s own deeply nested blobs are dropped without serialising them', async () => {
        start({ auth: hook });
        await http('/groups');
        const t0 = performance.now();
        const res = await publish(deepPublish(), bearer('tank-secret-1'));
        expect(performance.now() - t0).toBeLessThan(100);
        expect(res.body).toMatchObject({ ok: true, ackSeq: 11 });
        const frame = (await live('', bearer('tank-secret-1'))).body;
        expect(frame.run.meta.settings).toBeNull();
        expect(frame.notes.join(' ')).toContain('settings');
        expect(frame.run.events.map((e: any) => e.data)).toEqual(Array(11).fill({ truncated: true }));
    });
});

describe('the passive tracker', () => {
    const death = (killer: number, at = Date.now()): CombatEvent[] => [
        { id: 1, kind: 'melee', attackerObjectId: 556, targetObjectId: 1001, receivedAt: at },
        { id: 2, kind: 'death', attackerObjectId: killer, targetObjectId: 1001, receivedAt: at },
    ];

    test('deaths with the corpse, the killer and the track; the first look is a baseline; levels and regions', async () => {
        const f = fakeStore();
        f.attach('tankuser');
        const cat = makeNpc({ objectId: 555, name: 'forest cat', level: 12 });
        f.store.onState('tankuser', tankState({}, { x: 1000 }));
        expect((await f.frame()).passive).toEqual({ events: [], seq: 0 });
        f.advance(1000);
        f.store.onState('tankuser', tankState({ nearbyNpcs: [cat] }, { x: 1100 }));
        f.advance(500);
        f.store.onState('tankuser', tankState({ nearbyNpcs: [cat] }, { x: 1150 })); // under 1 s: no sample
        f.advance(500);
        // The cat is gone from the death frame: it is named from the frame before.
        f.store.onState('tankuser', tankState({ combatEvents: death(555) }, { x: 1250, y: 1010, z: 7, isDead: true, deathCount: 1, healthPercent: 0 }));
        f.advance(1000);
        f.store.onState('tankuser', tankState({ combatEvents: death(555) }, { x: 1250, isDead: true, deathCount: 1 }));
        let events = (await f.frame()).passive.events;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            seq: 1, kind: 'death', bot: 'tank1', name: 'Tanky', by: 'forest cat (L12)', text: 'Tanky died, killed by forest cat (L12)',
            pos: { regionId: 1, x: 1250, y: 1010, z: 7 }, runId: null, at: f.now() - 1000,
        });
        expect(events[0].track.map((s: any) => s.x)).toEqual([1000, 1100]);

        f.store.onState('tankuser', tankState({}, { deathCount: 1, level: 11 }));
        f.store.onState('tankuser', tankState({}, { deathCount: 1, level: 11, regionId: 51, zoneName: 'Gothwaite' }));
        events = (await f.frame('?passive=1')).passive.events;
        expect(events.map((e: any) => [e.kind, e.text])).toEqual([
            ['level', 'Tanky reached level 11'],
            ['region', 'Tanky entered region 51 (Gothwaite)'],
        ]);
    });

    test('a death counts once whether isDead or deathCount moves first; the last hitter names an unnamed killer', async () => {
        const f = fakeStore();
        f.attach('tankuser');
        const bandit = makeNpc({ objectId: 556, name: 'bandit', level: 9 });
        f.store.onState('tankuser', tankState());
        // isDead first, the count a frame later: one death.
        f.store.onState('tankuser', tankState({ nearbyNpcs: [bandit], combatEvents: death(999) }, { isDead: true }));
        f.store.onState('tankuser', tankState({}, { isDead: true, deathCount: 1 }));
        f.store.onState('tankuser', tankState({}, { deathCount: 1 }));
        // Died and released between two frames: the count alone.
        f.store.onState('tankuser', tankState({}, { deathCount: 2 }));
        const deaths = (await f.frame()).passive.events.filter((e: any) => e.kind === 'death');
        expect(deaths.map((e: any) => e.by)).toEqual(['bandit (L9)', null]);
    });

    test('without a death event the killer is the newest foe that hit, never a friend\'s heal or buff', async () => {
        const f = fakeStore();
        f.attach('tankuser');
        const at = Date.now();
        const hit = (id: number, attacker: number, kind: CombatEvent['kind'], ago: number): CombatEvent => ({ id, kind, attackerObjectId: attacker, targetObjectId: 1001, receivedAt: at - ago });
        const cat = makeNpc({ objectId: 555, name: 'forest cat', level: 12 });
        const guard = makeNpc({ objectId: 700, name: 'Guard Aldric', level: 50, realm: 'albion' });
        const healy = makePlayerObj({ objectId: 1002, name: 'Healy', level: 10, realm: 'albion' });
        const hibby = makePlayerObj({ objectId: 900, name: 'Hibby', level: 20, realm: 'hibernia' });
        const died = (n: number, extra: Partial<BotWorldState>) => {
            f.store.onState('tankuser', tankState(extra, { isDead: true, deathCount: n, healthPercent: 0 }));
            f.store.onState('tankuser', tankState({}, { deathCount: n }));
        };
        f.store.onState('tankuser', tankState());
        // The health-0 update came before PlayerDeath: the cat swung 2 s ago, the healer's heal landed 300 ms ago.
        died(1, { nearbyNpcs: [cat], nearbyPlayers: [healy], combatEvents: [hit(1, 555, 'melee', 2000), hit(2, 1002, 'spellEffect', 300)] });
        // Only the heal: nobody is named.
        died(2, { nearbyPlayers: [healy], combatEvents: [hit(3, 1002, 'spellEffect', 300)] });
        // A same-realm guard's buff and the healer are skipped; the enemy player's spell counts.
        died(3, { nearbyNpcs: [guard], nearbyPlayers: [healy, hibby], combatEvents: [hit(4, 900, 'spellEffect', 1500), hit(5, 700, 'spellEffect', 800), hit(6, 1002, 'melee', 100)] });
        // The death event still comes before a newer hit: the server named the killer.
        died(4, { nearbyNpcs: [cat], nearbyPlayers: [hibby], combatEvents: [hit(7, 555, 'death', 400), hit(8, 900, 'melee', 50)] });
        const deaths = (await f.frame()).passive.events.filter((e: any) => e.kind === 'death');
        expect(deaths.map((e: any) => e.text)).toEqual([
            'Tanky died, killed by forest cat (L12)',
            'Tanky died',
            'Tanky died, killed by Hibby (L20)',
            'Tanky died, killed by forest cat (L12)',
        ]);
    });

    // "necroservant#432 -> Pethun#429 hit", "death Briton#427 -> Pethun#429", gateway "Pethun killed by Briton (L20)": the server names the pet's owner (GameLiving.cs:1299-1300).
    test('a pet\'s kill names the pet, unless the player the server named has a hit of its own', async () => {
        const f = fakeStore();
        f.attach('tankuser');
        const at = Date.now();
        const hit = (id: number, attacker: number, kind: CombatEvent['kind'], ago: number): CombatEvent => ({ id, kind, attackerObjectId: attacker, targetObjectId: 1001, receivedAt: at - ago });
        const servant = makeNpc({ objectId: 432, name: 'necroservant', level: 17, realm: 'hibernia', isPet: true });
        const guard = makeNpc({ objectId: 433, name: 'Guard Fiach', level: 50, realm: 'hibernia' });
        const stray = makeNpc({ objectId: 434, name: 'spirit soldier', level: 17, realm: 'midgard', isPet: true });
        const owner = makePlayerObj({ objectId: 427, name: 'Celt', level: 20, realm: 'hibernia' });
        const healy = makePlayerObj({ objectId: 1002, name: 'Healy', level: 10, realm: 'albion' });
        const died = (n: number, extra: Partial<BotWorldState>) => {
            f.store.onState('tankuser', tankState({ nearbyPlayers: [owner, healy], ...extra }, { isDead: true, deathCount: n, healthPercent: 0 }));
            f.store.onState('tankuser', tankState({}, { deathCount: n }));
        };
        f.store.onState('tankuser', tankState());
        // All the pet's, a friend's heal after it.
        died(1, { nearbyNpcs: [servant], combatEvents: [hit(1, 432, 'melee', 3000), hit(2, 432, 'melee', 800), hit(3, 1002, 'spellEffect', 300), hit(4, 427, 'death', 100)] });
        // The owner's own nuke in the window.
        died(2, { nearbyNpcs: [servant], combatEvents: [hit(5, 427, 'spellEffect', 8000), hit(6, 432, 'melee', 300), hit(7, 427, 'death', 100)] });
        // Another realm's pet isn't the one named; nor a guard, which has no owner.
        died(3, { nearbyNpcs: [stray], combatEvents: [hit(8, 434, 'melee', 300), hit(9, 427, 'death', 100)] });
        died(4, { nearbyNpcs: [guard], combatEvents: [hit(10, 433, 'melee', 300), hit(11, 427, 'death', 100)] });
        const deaths = (await f.frame()).passive.events.filter((e: any) => e.kind === 'death');
        expect(deaths.map((e: any) => e.by)).toEqual(['necroservant (L17)', 'Celt (L20)', 'Celt (L20)', 'Celt (L20)']);
    });

    test('client drops and returns, controllers attach, change and leave; events carry the live run', async () => {
        const f = fakeStore();
        const session = f.attach('tankuser', tankState());
        f.attach('healuser', healState());
        f.store.tick();
        f.sdkSessions.set('obs', { targetUsername: 'tankuser', mode: 'observe', sdkClientId: 'viewer-observe' });
        f.store.tick();
        expect((await f.frame()).passive.events).toEqual([]);

        session.ws = null;
        f.store.tick();
        session.ws = {};
        f.store.tick();
        f.sdkSessions.set('s1', { targetUsername: 'tankuser', mode: 'control', sdkClientId: 'group-runner' });
        f.store.tick();
        expect((await f.publish(makePublish({ sentAt: f.now() }))).status).toBe(200);
        f.sdkSessions.delete('s1');
        f.sdkSessions.set('s2', { targetUsername: 'tankuser', mode: 'control', sdkClientId: 'viewer-control' });
        f.store.tick();
        f.sdkSessions.delete('s2');
        f.store.tick();
        const events = (await f.frame()).passive.events;
        expect(events.map((e: any) => [e.kind, e.text, e.runId])).toEqual([
            ['client', 'Tanky: client disconnected', null],
            ['client', 'Tanky: client back', null],
            ['control', 'Tanky: controller attached (group-runner)', null],
            ['control', 'Tanky: control taken over (viewer-control)', RUN],
            ['control', 'Tanky: controller left', RUN],
        ]);
        expect(events[0].pos).toBeNull(); // no state seen through onState yet
    });

    test('deaths reach the tracker through the gateway\'s state branch', async () => {
        start();
        const bot = await attachBot('tankuser', tankState());
        bot.send({ type: 'state', state: tankState({}, { isDead: true, deathCount: 1, x: 4242 }) });
        await until(async () => (await live()).body.passive.events.length === 1, 'death event');
        expect((await live()).body.passive.events[0]).toMatchObject({ kind: 'death', name: 'Tanky', pos: { x: 4242 }, by: null });
    });
});

describe('badges on /bots and /status', () => {
    test('/bots and /status/<bot> name the group and its live run', async () => {
        start();
        await attachBot('tankuser', tankState());
        await attachBot('loner', makeState());
        const bots = (await http('/bots')).body.bots;
        expect(bots.find((b: any) => b.username === 'tankuser').group).toEqual({ id: 'alpha', name: 'Alpha Team', run: null });
        expect(bots.find((b: any) => b.username === 'loner').group).toBeNull();
        expect((await http('/status/tankuser')).body.group).toEqual({ id: 'alpha', name: 'Alpha Team', run: null });
        expect((await http('/status/loner')).body.group).toBeNull();
        expect((await http('/status/TANKUSER')).body.group).toMatchObject({ id: 'alpha' });
        await publish(makePublish());
        expect((await http('/status/tankuser')).body.group).toEqual({ id: 'alpha', name: 'Alpha Team', run: { runId: RUN, state: 'live', phase: 'engage' } });
        clock += 31_000;
        expect((await http('/status/tankuser')).body.group.run).toEqual({ runId: RUN, state: 'lost', phase: null });
    });

    test('groups: false turns group views off', async () => {
        start({ groups: false });
        expect((await http('/status/tankuser')).body.group).toBeNull();
        const res = await http('/groups');
        expect(res.headers.get('content-type')).toContain('text/plain');
        // The region page still shows the bots, with no groups and no runs.
        await attachBot('tankuser', tankState());
        expect((await http('/regions/1/live')).body).toMatchObject({ bots: [{ username: 'tankuser', group: null }], runs: [] });
    });
});

describe('runs on the region page', () => {
    test('activeRuns hands the current run to /regions/<id>/live; under a hook a bot needs its own password, a run its leader\'s', async () => {
        start({ auth: hook });
        await attachBot('tankuser', tankState());
        await attachBot('healuser', healState());
        const report = { totals: { kills: 3, deaths: 1, playerKills: 2, deathsToPlayers: 1, engagements: 1 } };
        expect((await publish(makePublish({ reportRev: 1, report: report as any }), bearer('tank-secret-1'))).body.ok).toBe(true);
        expect((await http('/regions/1/live')).body.hidden).toEqual({ bots: 2, runs: 1 });
        const heal = (await http('/regions/1/live', { headers: bearer('heal-secret-2') })).body;
        expect(heal.bots.map((b: any) => b.username)).toEqual(['healuser']);
        expect(heal.hidden).toEqual({ bots: 1, runs: 1 });
        const tank = (await http('/regions/1/live', { headers: bearer('tank-secret-1') })).body;
        expect(tank.bots.map((b: any) => b.username)).toEqual(['tankuser']);
        expect(tank.bots[0].group).toEqual({ id: 'alpha', name: 'Alpha Team' });
        expect(tank.hidden).toEqual({ bots: 1, runs: 0 });
        expect(tank.runs).toEqual([expect.objectContaining({
            group: 'alpha', name: 'Alpha Team', realm: 'albion', runId: RUN, state: 'live', strategy: 'test-pve', phase: 'engage', reason: 'rat attacks the group',
            focus: { objectId: 500, name: 'water beetle', realm: 'none', hp: 100, ours: false },
            totals: { kills: 3, deaths: 1, playerKills: 2, deathsToPlayers: 1, engagements: 1 },
            members: ['healuser', 'tankuser'], alive: 3, size: 3,
        })]);
        // A lost run speaks for nobody.
        clock += 31_000;
        expect((await http('/regions/1/live', { headers: bearer('tank-secret-1') })).body.runs).toEqual([]);
    });
});

describe('runs files', () => {
    function writeRuns() {
        const lines = [
            { startedAt: '2026-10-31T10:00:00.000Z', strategy: 'test-pve', seconds: 900, kills: 10, deaths: 1, wipes: 0, retreats: 0, fights: 10, killsPerHour: 40, xpPerHour: 1000, avgFightMs: 9000, downtime: 30, tankHold: null, findings: ['waiting', 'deaths'] },
            { startedAt: '2026-10-31T11:00:00.000Z', strategy: 'test-pve', seconds: 900, kills: 12, deaths: 0, wipes: 0, retreats: 0, fights: 12, killsPerHour: 48, xpPerHour: 1200, avgFightMs: 8000, downtime: 25, tankHold: 88, findings: [],
                playerKills: 3, deathsToPlayers: 1, rpPerHour: 5000, enemiesSeen: 'many' },
        ];
        write('groups/alpha/runs/history.jsonl', `${JSON.stringify(lines[0])}\nnot json\n${JSON.stringify(lines[1])}\n`);
        write('groups/alpha/runs/20261031-100000.json', JSON.stringify({ group: 'alpha', totals: { kills: 10 } }));
        write('groups/alpha/runs/20261031-100000.md', '# alpha: test-pve run\n');
        write('groups/alpha/runs/20261031-100000.log', Array.from({ length: 40 }, (_, i) => `10:00:${String(i).padStart(2, '0')} line ${i}`).join('\n') + '\n');
        write('groups/alpha/runs/20261031-110000.json', '{ broken');
        write('groups/alpha/runs/notes.txt', 'not a run');
        write('groups/alpha/runs/campaign.log', Array.from({ length: 40 }, (_, i) => `2026-10-31T10:${String(i).padStart(2, '0')}:00 step ${i}`).join('\n') + '\n');
        write('groups/alpha/runs/campaign.stop', '');
    }

    test('history newest first with stamps, the file sets, the campaign tail and stop flag', async () => {
        writeRuns();
        start();
        const { status, body } = await http('/groups/alpha/runs');
        expect(status).toBe(200);
        expect(body.history.map((h: any) => [h.stamp, h.xpPerHour, h.tankHold])).toEqual([['20261031-110000', 1200, 88], ['20261031-100000', 1000, null]]);
        expect(body.history[1].findings).toEqual(['waiting', 'deaths']);
        // An RvR run's numbers when they are numbers; a PvE line has none.
        expect(body.history[0]).toMatchObject({ playerKills: 3, deathsToPlayers: 1, rpPerHour: 5000 });
        expect('enemiesSeen' in body.history[0] || 'playerKills' in body.history[1]).toBe(false);
        expect((await http('/groups/alpha/runs?limit=1')).body.history).toHaveLength(1);
        expect(body.files.map((f: any) => [f.stamp, f.json, f.md, f.log])).toEqual([['20261031-110000', true, false, false], ['20261031-100000', true, true, true]]);
        expect(body.files[1].size).toBeGreaterThan(100);
        expect(body.campaign.log).toHaveLength(30);
        expect(body.campaign.log.at(-1)).toBe('2026-10-31T10:39:00 step 39');
        expect(body.campaign).toMatchObject({ stopPending: true });
        expect(typeof body.campaign.updatedAt).toBe('number');
        // hasCampaign is read at discovery.
        clock += 5001;
        expect((await http('/groups')).body.groups[0].hasCampaign).toBe(true);
        // A group without runs/.
        expect((await http('/groups/beta/runs')).body).toEqual({ history: [], files: [], campaign: null });
    });

    test('runs/<stamp> serves json, md and log; bad stamps 404; size caps', async () => {
        writeRuns();
        start({}, { maxFileBytes: 200 });
        expect((await http('/groups/alpha/runs/20261031-100000')).body).toEqual({ report: { group: 'alpha', totals: { kills: 10 } } });
        const md = await http('/groups/alpha/runs/20261031-100000?part=md');
        expect(md.headers.get('content-type')).toContain('text/plain');
        expect(md.text).toBe('# alpha: test-pve run\n');
        const log = await http('/groups/alpha/runs/20261031-100000?part=log');
        expect(log.text.length).toBeLessThanOrEqual(200);
        expect(log.text.endsWith('line 39\n')).toBe(true);
        expect(log.text.startsWith('10:00:')).toBe(true); // whole lines only
        expect((await http('/groups/alpha/runs/20261031-110000')).status).toBe(500);
        expect((await http('/groups/alpha/runs/20261031-120000')).status).toBe(404);
        expect((await http('/groups/alpha/runs/2026-10-31')).status).toBe(404);
        expect((await http('/groups/alpha/runs/..%2F..%2Fbots')).status).toBe(404);
        expect((await http('/groups/alpha/runs/20261031-100000?part=env')).status).toBe(400);
        expect((await http('/groups/alpha/runs/20261031-100000/x')).status).toBe(404);
        write('groups/alpha/runs/20261031-090000.json', JSON.stringify({ padding: 'x'.repeat(300) }));
        expect((await http('/groups/alpha/runs/20261031-090000')).status).toBe(413);
    });
});

describe('sanitizePublish', () => {
    test('keeps a whitelisted, capped copy and notes what it dropped', () => {
        const raw: any = makePublish({
            events: [
                { seq: 1, at: 1, kind: 'note', text: 'x'.repeat(400), data: { big: 'y'.repeat(600) } },
                { seq: 0, at: 1, kind: 'note', text: 'no seq' } as any,
                { seq: 2, at: 1, kind: 'gossip', text: 'bad kind' } as any,
                { seq: 3, at: 1, kind: 'result', member: 'Tanky', text: 'melee: refused', data: { success: false } },
            ],
        });
        raw.password = 'tank-secret-1';
        raw.picture.members[0].capabilities.buffSpells = [{ name: 'Shield', slot: 'af', target: 'Realm', concentration: 1 }];
        raw.picture.members[0].hp = 'lots';
        raw.picture.contacts.push(contact(501, { regionId: 1 }), contact(502, { regionId: 1 }));
        raw.meta.settings = { blob: 'z'.repeat(400) };
        raw.report = { big: 'r'.repeat(400) };
        raw.extra = { anything: true };
        const clean = sanitizePublish(raw, { maxContacts: 2, maxSettingsBytes: 200, maxReportBytes: 200 });
        if (!clean.ok) throw new Error(clean.error);
        const v = clean.value as any;
        expect('password' in v || 'extra' in v).toBe(false);
        expect(v.events.map((e: any) => e.seq)).toEqual([1, 3]);
        expect(v.events[0].text).toHaveLength(300);
        expect(v.events[0].data).toEqual({ truncated: true });
        expect(v.events[1].data).toEqual({ success: false });
        expect(v.picture.members[0].capabilities.buffSpells).toEqual([]);
        expect(v.picture.members[0].hp).toBe(0);
        expect(v.picture.contacts.map((c: any) => c.objectId)).toEqual([500, 501]);
        expect(v.meta.settings).toBeNull();
        expect('report' in v).toBe(false);
        expect(clean.notes.join(' ')).toContain('settings');
        expect(clean.notes.join(' ')).toContain('report');
        expect(JSON.stringify(v)).not.toContain('tank-secret-1');
    });

    test('pet fields pass when they have the right type; absent ones stay absent; the wire stays version 1', () => {
        const raw: any = makePublish();
        raw.picture.members[0].capabilities.pet = 'main';
        raw.picture.members[0].summons = [601, 'x', 602];
        raw.picture.members[0].pet = {
            objectId: 600, name: 'n'.repeat(100), level: 17, x: 1010, y: 990, z: 5, hp: 84, targetId: 500, inCombat: true,
            aggression: 'passive', walk: 'goTarget', icons: [1, 'x', 2, 3, 4, 5, 6, 7, 8, 9], junk: true,
        };
        raw.picture.members[1].capabilities.pet = 'magic';
        raw.picture.members[1].pet = null;
        raw.picture.members[2].capabilities.pet = null;
        raw.picture.members[2].pet = { objectId: 'x' };
        raw.picture.contacts[0].targetPet = 'Tanky';
        raw.picture.contacts[0].isPet = true;
        raw.picture.contacts.push(contact(501, { regionId: 1, targetPet: null }), contact(502, { regionId: 1 }));
        raw.picture.contacts[1].isPet = 'yes';
        const clean = sanitizePublish(JSON.parse(JSON.stringify(raw)));
        if (!clean.ok) throw new Error(clean.error);
        const [tank, heal, nuke] = clean.value.picture.members;
        expect(tank!.capabilities.pet).toBe('main');
        expect(tank!.summons).toEqual([601, 602]);
        expect(tank!.pet).toEqual({
            objectId: 600, name: 'n'.repeat(64), level: 17, x: 1010, y: 990, z: 5, hp: 84, targetId: 500, inCombat: true,
            aggression: 'passive', walk: 'goTarget', icons: [1, 2, 3, 4, 5, 6, 7, 8],
        });
        expect('pet' in heal!.capabilities).toBe(false);
        expect(heal!.pet).toBeNull();
        expect(nuke!.capabilities.pet).toBeNull();
        expect(nuke!.pet).toBeNull();
        const [rat, b, c] = clean.value.picture.contacts;
        expect(rat).toMatchObject({ isPet: true, targetPet: 'Tanky' });
        expect(b!.targetPet).toBeNull();
        expect('isPet' in b!).toBe(false);
        expect('targetPet' in c! || 'isPet' in c!).toBe(false);
        expect(clean.value.v).toBe(1);

        // From a runner before pets: nothing of it appears.
        const old = sanitizePublish(JSON.parse(JSON.stringify(makePublish())));
        if (!old.ok) throw new Error(old.error);
        for (const m of old.value.picture.members) {
            expect('pet' in m || 'summons' in m || 'pet' in m.capabilities).toBe(false);
        }

        // A value that doesn't parse reads as what a pet starts on, not as garbage for the page.
        raw.picture.members[0].pet = { objectId: 600, aggression: 'angry', walk: 7, hp: 'lots', level: 'high' };
        const odd = sanitizePublish(JSON.parse(JSON.stringify(raw)));
        if (!odd.ok) throw new Error(odd.error);
        expect(odd.value.picture.members[0]!.pet).toEqual({ objectId: 600, name: '', level: null, x: null, y: null, z: null, hp: null, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [] });
    });

    test('RvR fields pass when they have the right type; absent ones stay absent', () => {
        const raw: any = makePublish({ state: 'ended' });
        raw.picture.members[0].realmPoints = 300;
        raw.picture.members[1].realmPoints = 'lots';
        raw.picture.contacts.push(contact(700, { regionId: 1, kind: 'player', realm: 'midgard', casting: true, helped: false, healer: true }));
        raw.picture.contacts[1].caster = 'yes';
        raw.result = {
            totals: { kills: 2, playerKills: 2, deathsToPlayers: 1, realmPoints: 400, rpPerHour: 1600, enemiesSeen: 7, engagements: Infinity, junk: 1 },
            findings: [], stamp: null, stoppedBy: 'time',
        };
        const clean = sanitizePublish(JSON.parse(JSON.stringify(raw)));
        if (!clean.ok) throw new Error(clean.error);
        const [tank, heal] = clean.value.picture.members;
        expect(tank!.realmPoints).toBe(300);
        expect('realmPoints' in heal!).toBe(false);
        const [rat, troll] = clean.value.picture.contacts;
        expect(['casting', 'helped', 'healer', 'caster'].filter(k => k in rat!)).toEqual([]);
        expect(troll).toMatchObject({ kind: 'player', casting: true, helped: false, healer: true });
        expect('caster' in troll!).toBe(false);
        // JSON turns Infinity into null: not a number, so left out.
        expect(clean.value.result!.totals).toEqual({
            kills: 2, deaths: 0, wipes: 0, retreats: 0, fights: 0, killsPerHour: 0, xpPerHour: 0, avgFightMs: 0, downtime: 0, tankHold: null,
            playerKills: 2, deathsToPlayers: 1, realmPoints: 400, rpPerHour: 1600, enemiesSeen: 7,
        });
    });

    test('blobs nested deeper than 32 levels are dropped however small; 32 still fit', () => {
        const raw: any = makePublish({
            events: [
                { seq: 1, at: 1, kind: 'note', text: 'deep', data: { d: JSON.parse(nested(40)) } },
                { seq: 2, at: 1, kind: 'note', text: 'flat', data: { d: JSON.parse(nested(20)) } },
            ],
        });
        raw.meta.settings = JSON.parse(nested(33));
        raw.report = { r: JSON.parse(nested(40)) };
        const clean = sanitizePublish(raw);
        if (!clean.ok) throw new Error(clean.error);
        expect(clean.value.meta.settings).toBeNull();
        expect('report' in clean.value).toBe(false);
        expect(clean.notes.join(' ')).toContain('settings');
        expect(clean.notes.join(' ')).toContain('report');
        expect(clean.value.events.map(e => e.data)).toEqual([{ truncated: true }, { d: JSON.parse(nested(20)) }]);
        raw.meta.settings = JSON.parse(nested(32));
        const fits = sanitizePublish(raw);
        expect(fits.ok && fits.value.meta.settings).toEqual(JSON.parse(nested(32)));
        // An unusable wire version is named without walking it.
        expect(sanitizePublish({ ...raw, v: JSON.parse(nested(50_000)) })).toEqual({ ok: false, error: 'wire version an array is not supported (this gateway speaks v1)' });
    });

    test('refuses what it cannot use', () => {
        const bad = (over: Record<string, unknown>) => sanitizePublish({ ...makePublish(), ...over });
        expect(bad({ v: 2 }).ok).toBe(false);
        expect(bad({ runId: 'short' }).ok).toBe(false);
        expect(bad({ runId: '../../etc/passwd' }).ok).toBe(false);
        expect(bad({ publishSeq: 1.5 }).ok).toBe(false);
        expect(bad({ sentAt: 'now' }).ok).toBe(false);
        expect(bad({ state: 'paused' }).ok).toBe(false);
        expect(bad({ picture: [] }).ok).toBe(false);
        expect(bad({ group: '../alpha' }).ok).toBe(false);
        expect(sanitizePublish(null).ok).toBe(false);
        expect(bad({}).ok).toBe(true);
    });
});

describe('observed members (a human in the group, sdk/group/observed.ts)', () => {
    const withVue = (observed: unknown) => write('groups/alpha/group.json', JSON.stringify({ name: 'Alpha Team', leader: 'tank1', members: [{ bot: 'tank1', role: 'tank' }, { bot: 'heal1' }, { bot: 'nuke1' }], observed }));

    test('group.json may name them: the bots stay the roster, so a run publishes with no 409, and its report keeps the mark', async () => {
        withVue([{ name: 'Vue' }, { name: 'Ana', role: 'healer' }]);
        const alpha = discoverGroups([root]).find(g => g.id === 'alpha')!;
        expect(alpha.error).toBeNull();
        expect(alpha.observed).toEqual(['Vue', 'Ana']);
        expect(alpha.members.map(m => m.bot)).toEqual(['tank1', 'heal1', 'nuke1']);
        start();
        const p = makePublish();
        p.picture.members.push(report('Vue', { bot: '', role: 'melee', objectId: 1077, regionId: 1, observed: true }));
        const r = await publish(p);
        expect(r.body).toMatchObject({ ok: true });
        const clean = sanitizePublish(JSON.parse(JSON.stringify(p)));
        if (!clean.ok) throw new Error(clean.error);
        expect(clean.value.picture.members.map(m => [m.name, m.observed ?? false])).toEqual([['Tanky', false], ['Healy', false], ['Nuky', false], ['Vue', true]]);
    });

    test('a bad entry breaks group.json: a name of letters, never the tank, once each', () => {
        for (const [observed, says] of [[{ name: 'Vue' }, '"observed" must list'], [[{ name: 'V2' }], 'letters only'], [[{ name: 'Vue', role: 'tank' }], 'the tank is a bot'], [[{ name: 'Vue' }, { name: 'VUE' }], 'listed twice']] as const) {
            withVue(observed);
            expect(discoverGroups([root]).find(g => g.id === 'alpha')!.error).toContain(says);
        }
    });

    test('in the in-game group it is one of ours, not a stranger', () => {
        withVue([{ name: 'Vue' }]);
        const sessions = new Map<string, any>();
        sessions.set('tankuser', { ws: {}, clientId: 'a', lastStateReceivedAt: 1, lastState: tankState({ group: [{ name: 'Tanky' }, { name: 'Healy' }, { name: 'Vue' }, { name: 'Randomguy' }] as any }) });
        sessions.set('healuser', { ws: {}, clientId: 'b', lastStateReceivedAt: 1, lastState: healState() });
        const group = discoverGroups([root]).find(g => g.id === 'alpha')!;
        const view = composePassive(group, { sessions, sdkSessions: new Map(), sessionStatus: () => 'active' }, 10);
        expect(view.grouping.strangers).toEqual(['Randomguy']);
    });
});
