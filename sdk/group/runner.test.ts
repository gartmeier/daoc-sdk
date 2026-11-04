// runGroup end to end against a test gateway (port 0): fake clients, a control
// connection handed in as the caller's own (runScript and MCP do that), a stub
// strategy, and the run's publishes as the gateway takes them (publish.ts).
// groups/ and bots/ live in a temp root: loadGroup finds bot.env through
// findBotEnv, cwd first, so process.cwd answers that root for each test (no
// chdir of the shared test process, nothing in the repo's bots/).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSpells } from '../../data/index';
import { createGateway, type Gateway } from '../../gateway/gateway';
import type { GroupFrame, RunView } from '../../gateway/group-types';
import { BotActions } from '../actions';
import { executionContext, type ExecutionContext } from '../execution-context';
import { BotSDK } from '../index';
import { FakeClient } from '../test/fake-client';
import type { PlayerState, Spell } from '../types';
import type { Behavior } from './member';
import { runGroup, type GroupRunOptions, type GroupRunResult } from './runner';
import type { GroupStrategy } from './strategy';
import type { Contact } from './types';
import type { GroupPublish } from './wire';

const PASSWORD = 'pw-runner-test';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SUPERSEDED = 'Superseded by a newer call for this bot';

let root = '';
let gateway: Gateway | null = null;
let url = '';
const clients: FakeClient[] = [];
const sdks: BotSDK[] = [];
const runs: { abort: AbortController; done: Promise<unknown>; parked?: boolean }[] = [];
const restores: (() => void)[] = [];
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

function write(path: string, body: string) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
}

function setEnv(key: string, value: string | undefined) {
    const saved = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    restores.push(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'daoc-rungroup-'));
    write('bots/rgtank/bot.env', `BOT_USERNAME=rguser\nPASSWORD=${PASSWORD}\n`);
    // A second member folder on the same account: the pair needs one connection only.
    write('bots/rgalt/bot.env', `BOT_USERNAME=rguser\nPASSWORD=${PASSWORD}\n`);
    write('bots/rgmid/bot.env', `BOT_USERNAME=rgmid\nPASSWORD=${PASSWORD}\n`);
    write('groups/rg/group.json', JSON.stringify({ name: 'Runner Group', leader: 'rgtank', members: [{ bot: 'rgtank', role: 'tank' }] }));
    write('groups/rgpair/group.json', JSON.stringify({ leader: 'rgtank', members: [{ bot: 'rgtank', role: 'tank' }, { bot: 'rgalt', role: 'healer' }] }));
    write('groups/rgrealms/group.json', JSON.stringify({ leader: 'rgtank', members: [{ bot: 'rgtank', role: 'tank' }, { bot: 'rgmid', role: 'healer' }] }));
    gateway = createGateway({ port: 0, hostname: '127.0.0.1', quiet: true, groups: { roots: [root], groupsDir: join(root, 'groups') } });
    url = `ws://127.0.0.1:${gateway.port}`;
    // deriveGatewayUrl lets GATEWAY_URL win: every connection the run opens comes here, never to a real gateway.
    setEnv('GATEWAY_URL', url);
    setEnv('DAOC_GROUP_PUBLISH', undefined);
    const cwd = spyOn(process, 'cwd').mockImplementation(() => root);
    restores.push(() => cwd.mockRestore());
    // Passes every request through; the run's publishes are read back from its calls.
    fetchSpy = spyOn(globalThis, 'fetch');
    restores.push(() => fetchSpy.mockRestore());
});

afterEach(async () => {
    for (const r of runs) r.abort.abort(new Error('test over'));
    // A run cleans up within its abort; a parked one never settles.
    await Promise.race([Promise.allSettled(runs.filter(r => !r.parked).map(r => r.done)), Bun.sleep(2000)]);
    runs.length = 0;
    for (const s of sdks.splice(0)) await s.disconnect().catch(() => {});
    for (const c of clients.splice(0)) c.stop();
    await gateway?.stop();
    gateway = null;
    for (const restore of restores.splice(0).reverse()) restore();
    rmSync(root, { recursive: true, force: true });
});

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 3000): Promise<NonNullable<T>> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value) return value as NonNullable<T>;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
    }
}

async function http(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${gateway!.port}${path}`, init);
    return { status: res.status, body: await res.json() };
}

const frame = async (group: string) => (await http(`/groups/${group}/live`)).body as GroupFrame;
const runIn = (group: string, state: RunView['state']) => until(async () => { const r = (await frame(group)).run; return r?.state === state ? r : null; }, `the gateway's run of ${group} ${state}`);
const windDown = (group: string, runId: string, reason: string) =>
    http(`/groups/${group}/control`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ kind: 'windDown', runId, reason, password: PASSWORD }) });

/** The run's publishes as sent, oldest first. */
const publishes = (): GroupPublish[] => fetchSpy.mock.calls
    .filter(([target]) => String(target).endsWith('/publish'))
    .map(([, init]) => JSON.parse(String(init!.body)) as GroupPublish);

/** A logged-in character: its fake client, publishing a state every 50 ms. */
async function client(username: string, player: Partial<PlayerState> = {}): Promise<FakeClient> {
    const c = new FakeClient(url, username, { publishMs: 50 });
    c.state = { ...c.state, player: { ...c.state.player!, ...player } };
    clients.push(c);
    await c.start();
    return c;
}

/** A control connection to a logged-in character, as runScript or MCP hands one to the run. */
async function connect(username: string): Promise<{ sdk: BotSDK; bot: BotActions }> {
    await client(username);
    const sdk = new BotSDK({ botUsername: username, password: PASSWORD, gatewayUrl: url, connectionMode: 'control', autoLaunchClient: false, showChat: false });
    sdks.push(sdk);
    await sdk.connect();
    await sdk.waitForCondition(s => s.inGame && s.player !== null, 3000);
    return { sdk, bot: new BotActions(sdk) };
}

/** `target` with some members replaced and the rest bound to it, the way MCP's proxy passes calls through. */
function overriding<T extends object>(target: T, over: Record<string, unknown>): T {
    return new Proxy(target, {
        get(t, key) {
            if (typeof key === 'string' && key in over) return over[key];
            const v = Reflect.get(t, key);
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}

/** Never pulls; notes whether each decision was made winding down. */
function stub(decisions: boolean[] = []): GroupStrategy<{ huntRadius: number }> {
    return {
        name: 'stub', description: 'does nothing', settings: { huntRadius: 2200 },
        behaviors: { tank: [], healer: [], support: [], nuker: [], melee: [] },
        decide: ({ windingDown }) => { decisions.push(windingDown); return { phase: 'idle', reason: 'stub: nothing to do' }; },
    };
}

/**
 * runGroup inside an execution, as runScript and MCP execute_code call it. Each
 * log line keeps the execution it was printed in (MCP shows a call only its own).
 */
function start(group: string, opts: Partial<GroupRunOptions<any>>, abort = new AbortController()) {
    const store: ExecutionContext = { signal: abort.signal };
    const lines: { text: string; store: ExecutionContext | undefined }[] = [];
    let settled = false;
    const done: Promise<GroupRunResult> = executionContext.run(store, () => runGroup({
        dir: join(root, 'groups', group), strategy: stub(), seconds: 120, graceMs: 5000, form: false, save: false,
        publish: { intervalMs: 50 }, log: line => lines.push({ text: line.replace(/^\d\d:\d\d:\d\d /, ''), store: executionContext.getStore() }),
        ...opts,
    }));
    done.then(() => { settled = true; }, () => { settled = true; });
    const entry: (typeof runs)[number] = { abort, done };
    runs.push(entry);
    return { done, store, lines, text: () => lines.map(l => l.text), settled: () => settled, leaveParked: () => { entry.parked = true; } };
}

describe('runGroup and the gateway', () => {
    test('a wind-down from the viewer ends a 120 s run early: stopped by the viewer, the control applied, ended without an error', async () => {
        const run = start('rg', { have: await connect('rguser') });
        const live = await runIn('rg', 'live');
        const asked = Date.now();
        expect((await windDown('rg', live.runId, 'test over')).status).toBe(200);
        const result = await run.done;
        expect(Date.now() - asked).toBeLessThan(3000);
        expect(result.stoppedBy).toBe('viewer');
        expect(run.text()).toContain('wind-down requested from the viewer (test over): finishing the current fight');

        const end = (await frame('rg')).run!;
        expect(end).toMatchObject({ runId: live.runId, state: 'ended', error: null, result: { stoppedBy: 'viewer', stamp: null } });
        expect(end.control.length).toBe(1);
        expect(end.control[0]).toMatchObject({ reason: 'test over' });
        expect(end.control[0]!.appliedAt).not.toBeNull();
        // A normal end: no error on the way out either.
        expect(publishes().slice(-2).map(b => [b.state, b.error])).toEqual([['ending', null], ['ended', null]]);
        // The publisher answers on its own timer; its lines still print in the run's execution.
        const link = run.lines.find(l => l.text.startsWith('viewer: '));
        expect(link?.text).toBe(`viewer: http://127.0.0.1:${gateway!.port}/viewer/group/rg`);
        expect(link?.store).toBe(run.store);
    });

    test('a timed end publishes ending, then ended with the result and no error; the saved report has the announced stamp', async () => {
        const run = start('rg', { have: await connect('rguser'), seconds: 0.3, save: true });
        const result = await run.done;
        expect(result.stoppedBy).toBe('time');
        expect(run.text()).toContain('time is up: finishing the current fight');
        const sent = publishes();
        expect(sent.slice(-2).map(b => b.state)).toEqual(['ending', 'ended']);
        expect(sent.slice(0, -2).every(b => b.state === 'starting' || b.state === 'running')).toBe(true);
        const [ending, ended] = sent.slice(-2);
        expect(ending).toMatchObject({ state: 'ending', error: null });
        expect(ending!.result).toBeUndefined();
        expect(ended!.meta.stamp).not.toBeNull();
        expect(ended).toMatchObject({ state: 'ended', error: null, result: { stoppedBy: 'time', stamp: ended!.meta.stamp } });
        expect(result.report).toBe(join(root, 'groups', 'rg', 'runs', `${ended!.meta.stamp}.md`));
        expect((await frame('rg')).run).toMatchObject({ state: 'ended', error: null, result: { stoppedBy: 'time', stamp: ended!.meta.stamp } });
    });

    test('a run whose report cannot be saved ends with the error, not as a clean end', async () => {
        write(join('groups', 'rg', 'runs'), 'a file where runs/ should be');
        const run = start('rg', { have: await connect('rguser'), seconds: 0.3, save: true });
        await expect(run.done).rejects.toThrow();
        const ended = publishes().at(-1)!;
        expect(ended.state).toBe('ended');
        expect(ended.error).toBeTruthy();
        expect(ended.result).toBeUndefined();
        expect((await frame('rg')).run).toMatchObject({ state: 'ended', error: ended.error, result: null });
    });

    test('a run that fails before it starts tells the gateway it ended, with the error, before it rethrows', async () => {
        await client('rgmid', { realm: 'midgard' });
        const run = start('rgrealms', { have: await connect('rguser') });
        await expect(run.done).rejects.toThrow('members are in different realms');
        // Read at once: the 'ended' publish went out before the throw.
        const end = (await frame('rgrealms')).run!;
        expect(end).toMatchObject({ state: 'ended', result: null });
        expect(end.error).toContain('members are in different realms: Rguser albion, Rgmid midgard');
        const last = publishes().at(-1)!;
        expect(last.state).toBe('ended');
        expect(last.error).toBe(end.error);
        expect(last.result).toBeUndefined();
    });

    test('the strategy\'s findings get its settings and land in the result, the saved json and md, and the ended publish', async () => {
        const seenSettings: unknown[] = [];
        const strategy: GroupStrategy<{ huntRadius: number }> = {
            ...stub(),
            findings: (r, settings) => {
                seenSettings.push(settings);
                return [{ severity: 'medium', topic: 'roam', issue: `Roamed with huntRadius ${settings.huntRadius}`, evidence: `${r.fights.length} fights`, suggestion: 'Roam farther.' }];
            },
        };
        const run = start('rg', { have: await connect('rguser'), seconds: 0.3, save: true, strategy, settings: { huntRadius: 999 } });
        const result = await run.done;
        expect(result.findings).toContain('medium roam: Roamed with huntRadius 999');
        expect(seenSettings.at(-1)).toEqual({ huntRadius: 999 });
        expect(readFileSync(result.report!, 'utf-8')).toContain('[roam] Roamed with huntRadius 999. Evidence: 0 fights. Try: Roam farther.');
        const json = JSON.parse(readFileSync(result.report!.replace(/\.md$/, '.json'), 'utf-8'));
        expect(json.findings.map((f: { topic: string }) => f.topic)).toContain('roam');
        expect(publishes().at(-1)!.result!.findings).toContain('medium roam: Roamed with huntRadius 999');
    });

    test('the strategy\'s board and agent options reach the Blackboard and every MemberAgent', async () => {
        let contacts: Contact[] | null = null;
        const look: Behavior = { name: 'look', run: ctx => { contacts ??= ctx.picture().contacts; return false; } };
        const base = stub();
        // staleAfterMs -1: every contact is stale at once. sightRadius 200: of the fake client's rats at 100 and 300, only the first.
        const strategy: GroupStrategy<{ huntRadius: number }> = { ...base, behaviors: { ...base.behaviors, tank: [look] }, board: { staleAfterMs: -1 }, agent: { sightRadius: 200 } };
        const have = await connect('rguser');
        await start('rg', { have, seconds: 0.3, strategy, publish: false }).done;
        expect(contacts!.map(c => [c.objectId, c.stale])).toEqual([[200, true]]);
        // The defaults see both, fresh.
        contacts = null;
        await start('rg', { have, seconds: 0.3, strategy: { ...strategy, board: undefined, agent: undefined }, publish: false }).done;
        expect(contacts!.map(c => [c.objectId, c.stale])).toEqual([[200, false], [201, false]]);
    });

    test('publish: false sends nothing', async () => {
        const run = start('rg', { have: await connect('rguser'), seconds: 0.3, publish: false });
        expect((await run.done).stoppedBy).toBe('time');
        expect(publishes()).toEqual([]);
        expect((await frame('rg')).run).toBeNull();
        expect(run.text().some(l => l.startsWith('viewer: '))).toBe(false);
    });

    test('a wind-down asked for while the run is starting applies before the coordinator first decides', async () => {
        const conn = await connect('rguser');
        let disband!: (ok: boolean) => void;
        const disbanded = new Promise<boolean>(resolve => { disband = resolve; });
        // formGroup finds the second member in another group and disbands it first: held there until the wind-down is in.
        const have = {
            sdk: overriding(conn.sdk, { getGroup: () => [{ name: 'Stranger' }], sendCommand: () => disbanded }),
            bot: overriding(conn.bot, { acceptGroupInvite: async () => ({ success: true, message: 'joined' }), invite: async () => ({ success: true, message: 'invited' }) }),
        };
        const decisions: boolean[] = [];
        const run = start('rgpair', { have, form: true, strategy: stub(decisions) });
        const starting = await runIn('rgpair', 'starting');
        expect((await windDown('rgpair', starting.runId, 'not now')).status).toBe(200);
        await until(async () => (await frame('rgpair')).run?.control[0]?.appliedAt, 'the wind-down applied');
        expect((await frame('rgpair')).run!.state).toBe('starting');
        expect(decisions).toEqual([]);
        disband(true);
        const result = await run.done;
        expect(result.stoppedBy).toBe('viewer');
        // Every decision, the first included, was made winding down: no new pull after the request.
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.every(Boolean)).toBe(true);
        expect(run.text()).toContain('wind-down requested from the viewer (not now): finishing the current fight');
    });

    test('a cancel while formGroup is parked still ends the publish: ending with the error, then nothing more', async () => {
        const conn = await connect('rguser');
        // The disband never answers, as an MCP call's proxy never settles a call once the call is cancelled:
        // runGroup never reaches its catch or finally.
        const have = { bot: conn.bot, sdk: overriding(conn.sdk, { getGroup: () => [{ name: 'Stranger' }], sendCommand: () => new Promise(() => {}) }) };
        const mcp = new AbortController();
        const run = start('rgpair', { have, form: true }, mcp);
        await runIn('rgpair', 'starting');
        mcp.abort(new Error(SUPERSEDED));
        const ending = await until(async () => { const r = (await frame('rgpair')).run; return r?.state === 'ending' ? r : null; }, "the gateway's run ending", 1000);
        expect(ending.error).toBe(SUPERSEDED);
        const count = publishes().length;
        // Six publish intervals: the timer is gone.
        await Bun.sleep(300);
        expect(publishes().length).toBe(count);
        expect(publishes().at(-1)).toMatchObject({ state: 'ending', error: SUPERSEDED });
        // Still parked: the end came from the abort, not from the finally.
        expect(run.settled()).toBe(false);
        run.leaveParked();
    });
});

describe('runGroup with a pet', () => {
    const summonSpell = (name: string) => { const s = getSpells().find(x => x.name === name)!; return { name: s.name, level: 20, internalId: s.id, lineName: '', lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 } as Spell; };
    const listsOf = () => publishes().find(b => b.meta)!.meta!.members.map(m => m.behaviors);
    const roleList = () => { const b = (name: string): Behavior<{ huntRadius: number }> => ({ name, run: () => false }); return { ...stub(), behaviors: { tank: [b('release'), b('sprint'), b('retreat'), b('tank'), b('holdFormation'), b('buff'), b('rest')], healer: [], support: [], nuker: [], melee: [] } } as GroupStrategy<{ huntRadius: number }>; };

    test('a member with a summon gets the pet behaviours; one without has its list untouched', async () => {
        const have = await connect('rguser');
        clients.at(-1)!.state.skills = { ...clients.at(-1)!.state.skills, spells: [summonSpell('Summon Spirit Fighter')] };
        await until(() => have.sdk.getSkills().spells.length > 0, 'the spell list');
        const run = start('rg', { have, strategy: roleList(), seconds: 0.2 });
        await run.done;
        expect(listsOf()).toEqual([['release', 'sprint', 'petControl', 'retreat', 'petHeal', 'summonPet', 'tank', 'holdFormation', 'petBuff', 'buff', 'rest']]);
    });

    test('a member without one: the list as the strategy gave it', async () => {
        const run = start('rg', { have: await connect('rguser'), strategy: roleList(), seconds: 0.2 });
        await run.done;
        expect(listsOf()).toEqual([['release', 'sprint', 'retreat', 'tank', 'holdFormation', 'buff', 'rest']]);
    });

    test('a run\'s end tells a pet to follow, beside the attack off and the stop; with no pet nothing goes', async () => {
        const have = await connect('rguser');
        const c = clients.at(-1)!;
        c.state = { ...c.state, pet: { objectId: 900, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null } };
        await until(() => have.sdk.getPetState(), 'the pet window');
        await start('rg', { have, seconds: 0.2 }).done;
        expect(c.actions.filter(a => a.type === 'petCommand')).toMatchObject([{ type: 'petCommand', command: 'follow' }]);
    });

    test('a run that ends in a retreat doesn\'t leave the pet passive: nothing else lifts that, and a solo killNpc orders no passive pet', async () => {
        const have = await connect('rguser');
        const c = clients.at(-1)!;
        c.state = { ...c.state, pet: { objectId: 900, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null } };
        await until(() => have.sdk.getPetState(), 'the pet window');
        const retreating: GroupStrategy<{ huntRadius: number }> = { ...roleList(), decide: () => ({ phase: 'retreat', focus: null, retreatTo: { x: 0, y: 0, z: 0 }, reason: 'stub: running' }) };
        await start('rg', { have, strategy: retreating, seconds: 0.2, graceMs: 300 }).done;
        expect(c.actions.filter(a => a.type === 'petCommand').map(a => (a as { command?: string }).command)).toEqual(['passive', 'defensive', 'follow']);
    });

    test('a member who dies before the observer\'s first sample counts: "15:46:02 Pettan: Pettan died", and the report said deaths 0 (20261103-154557)', async () => {
        const have = await connect('rguser');
        const c = clients.at(-1)!;
        // Long enough to see the death under a loaded test run; the observer's first sample comes at 1 s.
        const run = start('rg', { have, seconds: 1.5, graceMs: 300 });
        await runIn('rg', 'live');
        c.state = { ...c.state, player: { ...c.state.player!, isDead: true } };
        const result = await run.done;
        expect(result.totals.deaths).toBe(1);
        expect(run.text().join('\n')).toContain(`${have.sdk.getPlayer()?.name ?? 'Rguser'} died`);
    });

    describe('a hard stop by pre-emption can\'t lift a passive', () => {
        // Pethun taken during a retreat (20261103-164643): "16:46:53.434 pethun pet now hunter's pet passive/follow tgt=null". The run's finally skips a member whose SDK is no longer connected.
        const takeOver = async () => {
            const other = new BotSDK({ botUsername: 'rguser', password: PASSWORD, gatewayUrl: url, connectionMode: 'control', autoLaunchClient: false, showChat: false });
            sdks.push(other);
            await other.connect();
        };
        const withPet = async () => {
            const have = await connect('rguser');
            const c = clients.at(-1)!;
            c.state = { ...c.state, pet: { objectId: 900, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null } };
            await until(() => have.sdk.getPetState(), 'the pet window');
            return { have, c, name: have.sdk.getPlayer()!.name };
        };
        const retreating = (): GroupStrategy<{ huntRadius: number }> => ({ ...roleList(), decide: () => ({ phase: 'retreat', focus: null, retreatTo: { x: 0, y: 0, z: 0 }, reason: 'stub: running' }) });

        test('the run\'s log says so: it can\'t be sent from the cut connection', async () => {
            const { have, c, name } = await withPet();
            const run = start('rg', { have, strategy: retreating(), seconds: 60 });
            await until(() => c.actions.some(a => a.type === 'petCommand' && (a as { command?: string }).command === 'passive'), 'the passive');
            await takeOver();
            await expect(run.done).rejects.toThrow('pre-empted');
            expect(run.text().join('\n')).toContain(`${name}'s pet left passive`);
            // Nothing went after the cut: no defensive, no follow.
            expect(c.actions.filter(a => a.type === 'petCommand').map(a => (a as { command?: string }).command)).toEqual(['passive']);
        });

        test('with no passive of ours there is nothing to say', async () => {
            const { have, name } = await withPet();
            const run = start('rg', { have, seconds: 60 });
            await runIn('rg', 'live');
            await takeOver();
            await expect(run.done).rejects.toThrow('pre-empted');
            expect(run.text().join('\n')).not.toContain(`${name}'s pet left`);
        });

        test('nor at a normal end: that one lifts it', async () => {
            const { have, name } = await withPet();
            const run = start('rg', { have, strategy: retreating(), seconds: 0.2, graceMs: 300 });
            await run.done;
            expect(run.text().join('\n')).not.toContain(`${name}'s pet left`);
        });
    });

    test('pet.enabled false: the same member\'s list stays as the strategy gave it, and the end of the run leaves its pet alone', async () => {
        const have = await connect('rguser');
        const c = clients.at(-1)!;
        c.state = { ...c.state, skills: { ...c.state.skills, spells: [summonSpell('Summon Spirit Fighter')] }, pet: { objectId: 900, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null } };
        await until(() => have.sdk.getSkills().spells.length > 0 && have.sdk.getPetState(), 'the spell list and the pet window');
        await start('rg', { have, strategy: roleList(), seconds: 0.2, settings: { 'pet.enabled': 'false' } }).done;
        expect(listsOf()).toEqual([['release', 'sprint', 'retreat', 'tank', 'holdFormation', 'buff', 'rest']]);
        expect(c.actions.some(a => a.type === 'stop')).toBe(true);
        expect(c.actions.filter(a => a.type === 'petCommand')).toEqual([]);
    });

    test('no pet: no pet command at the end', async () => {
        const have = await connect('rguser');
        const c = clients.at(-1)!;
        await start('rg', { have, seconds: 0.2 }).done;
        expect(c.actions.some(a => a.type === 'stop')).toBe(true);
        expect(c.actions.filter(a => a.type === 'petCommand')).toEqual([]);
    });
});
