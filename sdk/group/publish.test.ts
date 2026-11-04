import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Blackboard } from './blackboard';
import { obs, report, sighting } from './fixtures';
import { GroupObserver } from './observer';
import { PVE_SETTINGS } from './pve';
import { EventOutbox, GroupPublisher, jsonSafe, memoryView, planView, windDownClock, type GroupPublishOptions, type PublisherDeps } from './publish';
import type { GroupEvent } from './types';
import type { ControlRequest, GroupPublish, RunMeta } from './wire';

const pause = (ms: number) => Bun.sleep(ms);
async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(5);
    }
}

const META: RunMeta = {
    strategy: 'test-pve', description: null, startedAt: 1_800_000_000_000, stamp: null, seconds: 60, graceMs: 60_000,
    members: [{ bot: 'tank', username: 'tank', name: 'Tank', role: 'tank', className: 'Armsman', level: 10, behaviors: ['tank'] }],
    settings: {}, pid: 1, control: true,
};
const ack = (ackSeq = 0, control: unknown[] = []) => Response.json({ ok: true, v: 1, ackSeq, control });
const ackAll = (b: GroupPublish) => ack(b.events.at(-1)?.seq ?? 0);

type Handler = (body: GroupPublish, n: number) => Response | Promise<Response>;
const made: GroupPublisher[] = [];
afterEach(() => { for (const p of made.splice(0)) p.ending('test over'); });

/** A publisher on a real board and observer, POSTing to a fake gateway every 20 ms. */
function harness(handler: Handler = ackAll, options: GroupPublishOptions | false = {}, over: Partial<PublisherDeps> = {}) {
    const board = new Blackboard();
    const observer = new GroupObserver(board, { group: 'alpha', strategy: 'test-pve' });
    const calls: { url: string; init: RequestInit; body: GroupPublish }[] = [];
    const lines: string[] = [];
    const controls: ControlRequest[] = [];
    const fake = (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as GroupPublish;
        calls.push({ url, init, body });
        return handler(body, calls.length);
    }) as unknown as typeof fetch;
    const deps: PublisherDeps = {
        group: 'alpha', leader: { bot: 'tank', username: 'tank', password: 'pw-tank' }, url: 'http://gw.test/', roster: [{ bot: 'tank', username: 'tank' }],
        meta: META, board, observer, timing: () => ({ windingDown: false, deadline: 1, hardStop: 2 }),
        onControl: r => { controls.push(r); }, log: l => lines.push(l), ...over,
    };
    const pub = new GroupPublisher(deps, options === false ? false : { intervalMs: 20, fetch: fake, ...options });
    made.push(pub);
    return { board, observer, pub, calls, lines, controls };
}

const note = (i: number): GroupEvent => ({ at: i, kind: 'note', text: `note ${i}` });

describe('publish helpers', () => {
    test('memoryView projects decidePve memory: Set to array, capped, junk ignored, null without its keys', () => {
        const route = Array.from({ length: 300 }, (_, i) => ({ x: i, y: i }));
        const avoidCamps = Array.from({ length: 60 }, (_, i) => ({ x: i, y: -i }));
        const v = memoryView({
            camp: { x: 1, y: 2, z: 3, zone: 'Lough Derg', count: 17, names: 'bear 13' }, campLevel: 13, base: { x: 10, y: 20, z: 30 }, facing: { x: 5, y: 6 },
            route: [...route, 'junk'], leg: { x: 7, y: 8 }, avoidCamps, exclude: new Set(Array.from({ length: 70 }, (_, i) => i)), pullStart: 123, legFacing: { x: 1, y: 1 },
        })!;
        expect(v.camp).toEqual({ x: 1, y: 2, z: 3, zone: 'Lough Derg', count: 17, names: 'bear 13' });
        expect(v.campLevel).toBe(13);
        expect(v.base).toEqual({ x: 10, y: 20, z: 30 });
        expect(v.facing).toEqual({ x: 5, y: 6 });
        // The waypoints still ahead, the newest camps given up on, the newest failed pulls.
        expect(v.route.length).toBe(200);
        expect(v.route[0]).toEqual({ x: 0, y: 0 });
        expect(v.leg).toEqual({ x: 7, y: 8, z: 0 });
        expect(v.avoidCamps.length).toBe(50);
        expect(v.avoidCamps[0]).toEqual({ x: 10, y: -10 });
        expect(v.excluded).toEqual(Array.from({ length: 50 }, (_, i) => i + 20));
        expect(JSON.parse(JSON.stringify(v))).toEqual(v);

        expect(memoryView({ camp: 'nope', base: { x: 'a', y: 1 }, route: 'r', exclude: 7, campLevel: NaN, facing: { x: Infinity, y: 0 } }))
            .toEqual({ camp: null, campLevel: null, base: null, facing: null, route: [], leg: null, avoidCamps: [], excluded: [] });
        expect(memoryView({ camp: null, exclude: [3, 'x', 4] })).toMatchObject({ camp: null, excluded: [3, 4] });
        expect(memoryView({})).toBeNull();
        expect(memoryView(null)).toBeNull();
        expect(memoryView('memory')).toBeNull();
        expect(memoryView({ roamAt: 5, idleSince: 6 })).toBeNull();
        expect(memoryView({ get camp(): unknown { throw new Error('boom'); } })).toBeNull();
    });

    test('planView keeps names, positions and reasons, caps targets and unsafe spawns at 64', () => {
        const spawn = (i: number) => ({ name: `bear ${i}`, x: i, y: i * 2, z: 9, level: 13, aggroLevel: 0, aggroRange: 500, flags: 0 });
        const plan = {
            base: { x: 1, y: 2, z: 3 }, facing: { x: 4, y: 5 }, score: 812, margin: Infinity,
            targets: Array.from({ length: 100 }, (_, i) => ({ ...spawn(i), d: i * 10 })),
            unsafe: Array.from({ length: 70 }, (_, i) => ({ ...spawn(i), why: `stand: wolf ${i}` })),
        };
        const v = planView(plan)!;
        expect(v.base).toEqual({ x: 1, y: 2, z: 3 });
        expect(v.facing).toEqual({ x: 4, y: 5 });
        expect(v.score).toBe(812);
        // No aggressive spawn near: unbounded, but JSON has no Infinity.
        expect(Number.isFinite(v.margin)).toBe(true);
        expect(v.targets.length).toBe(64);
        expect(v.unsafe.length).toBe(64);
        expect(v.targets[3]).toEqual({ name: 'bear 3', level: 13, x: 3, y: 6, d: 30 });
        expect(v.unsafe[1]).toEqual({ name: 'bear 1', level: 13, x: 1, y: 2, why: 'stand: wolf 1' });
        expect(planView(null)).toBeNull();
        expect(planView({ base: null, facing: { x: 1, y: 1 } })).toBeNull();
        expect(planView({ ...plan, targets: 'none', unsafe: [{ name: 'no position' }] })).toMatchObject({ targets: [], unsafe: [] });
    });

    test('jsonSafe handles RegExp, Set, Map, functions, cycles and depth within a byte cap', () => {
        const cyclic: any = { name: 'a' };
        cyclic.self = cyclic;
        const deep: any = {};
        let at = deep;
        for (let i = 0; i < 10; i++) at = at.next = {};
        const out = jsonSafe({
            keepItems: /potion|gem/i, set: new Set([1, 2]), map: new Map<string, unknown>([['a', 1], ['b', { c: 2 }]]), fn: () => 1, n: NaN,
            when: new Date(0), list: [1, undefined, () => 2], nested: { ok: true }, cyclic, deep,
        }, 4096) as any;
        expect(out.keepItems).toBe('/potion|gem/i');
        expect(out.set).toEqual([1, 2]);
        expect(out.map).toEqual({ a: 1, b: { c: 2 } });
        expect('fn' in out).toBe(false);
        expect(out.n).toBeNull();
        expect(out.when).toBe('1970-01-01T00:00:00.000Z');
        expect(out.list).toEqual([1, null, null]);
        expect(out.nested).toEqual({ ok: true });
        expect(out.cyclic).toEqual({ name: 'a', self: '[cycle]' });
        expect(out.deep.next.next.next.next.next).toBe('[too deep]');
        // A shared object that is not an ancestor is no cycle.
        const shared = { x: 1 };
        expect(jsonSafe({ a: shared, b: shared }, 100)).toEqual({ a: { x: 1 }, b: { x: 1 } });
        expect(jsonSafe({ text: 'x'.repeat(2000) }, 1000)).toEqual({ truncated: true });
        expect(jsonSafe(Array.from({ length: 100_000 }, () => 1), 1000)).toEqual({ truncated: true });
        expect(jsonSafe(() => 1, 100)).toBeNull();
        // The real settings survive, the RegExp as text.
        const settings = jsonSafe(PVE_SETTINGS, 16 * 1024) as any;
        expect(settings.holdMs).toBe(PVE_SETTINGS.holdMs);
        expect(typeof settings.keepItems).toBe('string');
        expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
    });

    test('windDownClock only ever moves the deadline and the hard stop earlier', () => {
        expect(windDownClock({ deadline: 100_000, hardStop: 160_000 }, 40_000, 60_000)).toEqual({ deadline: 40_000, hardStop: 100_000 });
        // Already past the deadline (winding down on time): nothing moves later.
        expect(windDownClock({ deadline: 10_000, hardStop: 70_000 }, 40_000, 60_000)).toEqual({ deadline: 10_000, hardStop: 70_000 });
        // A hard stop sooner than now + grace stays.
        expect(windDownClock({ deadline: 100_000, hardStop: 90_000 }, 40_000, 60_000)).toEqual({ deadline: 40_000, hardStop: 90_000 });
    });

    test('the outbox numbers events from 1, keeps them until acknowledged and counts what it drops over 1000', () => {
        const box = new EventOutbox(1000);
        for (let i = 0; i < 1100; i++) box.push(note(i));
        expect(box.size).toBe(1000);
        expect(box.dropped).toBe(100);
        expect(box.peek(3).map(x => x.seq)).toEqual([101, 102, 103]);
        expect(box.peek(1)[0]!.event.text).toBe('note 100');
        box.ack(400);
        expect(box.size).toBe(700);
        expect(box.peek(1)[0]!.seq).toBe(401);
        box.ack(300);
        expect(box.size).toBe(700);
        box.ack(5000);
        expect(box.size).toBe(0);
        expect(box.push(note(0))).toBe(1101);
    });
});

describe('GroupPublisher', () => {
    test('publishes only logged events, numbered from 1, until the gateway acknowledges them', async () => {
        const h = harness(() => ack(0));
        const emit = (e: Partial<GroupEvent>) => h.board.emit({ at: Date.now(), kind: 'note', text: 'x', ...e });
        emit({ kind: 'activity', member: 'Menta', text: 'nuke Moon Blast', data: { activity: 'nuke', detail: 'Moon Blast' } });
        emit({ kind: 'result', member: 'Menta', text: 'nuke: ok', data: { action: 'nuke', success: true, reason: null } });
        emit({ kind: 'result', member: 'Menta', text: 'nuke: interrupted', data: { action: 'nuke', success: false, reason: 'interrupted' } });
        emit({ kind: 'orders', targetId: 7, text: 'engage on wolf: wolf L5 attacks Tank', data: { phase: 'engage', focus: 7, puller: null, seq: 3 } });
        emit({ kind: 'result', member: 'Menta', text: 'cc: not_found (Target not found: #23159)', data: { action: 'cc', success: false, reason: 'not_found' } });
        emit({ kind: 'death', member: 'Tank', text: 'Tank died' });
        emit({ kind: 'note', text: 'coordinator: ' + 'y'.repeat(1000), data: { stack: 'z'.repeat(1000) } });
        await until(() => h.calls.length >= 2, 'two publishes');
        const [a, b] = h.calls.map(c => c.body);
        expect(a!.events.map(e => [e.seq, e.kind])).toEqual([[1, 'orders'], [2, 'result'], [3, 'death'], [4, 'note']]);
        expect(a!.events[0]).toMatchObject({ targetId: 7, data: { phase: 'engage', focus: 7 } });
        expect(a!.events[3]!.text.length).toBe(300);
        expect(a!.events[3]!.data).toEqual({ truncated: true });
        // Not acknowledged: sent again.
        expect(b!.events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
        expect(a).toMatchObject({ v: 1, runId: h.pub.runId, publishSeq: 1, group: 'alpha', leader: 'tank', state: 'starting', error: null, dropped: 0, applied: [], roster: [{ bot: 'tank', username: 'tank' }] });
        expect(b!.publishSeq).toBe(2);
        expect(h.calls[0]!.url).toBe('http://gw.test/groups/alpha/publish');
        expect(h.calls[0]!.init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer pw-tank' });
        expect(h.lines).toEqual(['viewer: http://gw.test/viewer/group/alpha']);
    });

    test('sends 300 events at a time oldest first and lets go of them only once acknowledged', async () => {
        const h = harness((_, n) => ack(n === 1 ? 0 : 400));
        for (let i = 0; i < 1100; i++) h.board.emit(note(i));
        await until(() => h.calls.length >= 3, 'three publishes');
        const [first, second, third] = h.calls.map(c => c.body);
        expect(first!.events.length).toBe(300);
        expect(first!.events[0]!.seq).toBe(101);
        expect(first!.dropped).toBe(100);
        expect(second!.events[0]!.seq).toBe(101);
        expect(third!.events[0]!.seq).toBe(401);
        expect(third!.events.at(-1)!.seq).toBe(700);
    });

    test('the picture leaves out buffSpells and keeps the 200 contacts nearest the members', async () => {
        const h = harness();
        const capabilities = { heal: false, cc: false, nuke: true, buffs: ['Shield'], buffSpells: [{ name: 'Shield', slot: 'af' as const, target: 'Self', concentration: 0 }] };
        const sightings = Array.from({ length: 250 }, (_, i) => sighting(1000 + i, { x: 1000 + (i + 1) * 10, y: 1000 }));
        h.board.publish(obs(report('Tank', { capabilities, x: 1000, y: 1000 }), sightings));
        await until(() => h.calls.length >= 1, 'a publish');
        const p = h.calls[0]!.body.picture;
        // GroupPublish types the picture as a GroupPicture; on the wire its members carry no buffSpells.
        expect(p.members[0]!.capabilities as unknown).toEqual({ heal: false, cc: false, nuke: true, buffs: ['Shield'] });
        expect(p.contacts.length).toBe(200);
        expect(Math.max(...p.contacts.map(c => c.objectId))).toBe(1199);
        // The board's own picture is untouched.
        expect(h.board.picture().members[0]!.capabilities.buffSpells.length).toBe(1);
        expect(h.board.picture().contacts.length).toBe(250);
    });

    test('RvR on the wire: an enemy player\'s flags, a member\'s realm points and its killer', async () => {
        const h = harness();
        const troll = sighting(301, { kind: 'player', name: 'Troll', realm: 'midgard', targetId: 100, helped: true, casting: true });
        h.board.publish(obs(report('Tank', { objectId: 100, realmPoints: 25 }), [troll]));
        h.board.publish({ ...obs(report('Tank', { objectId: 100, realmPoints: 25, isDead: true }), [troll]), killer: { name: 'Troll', kind: 'player', realm: 'midgard' } });
        await until(() => h.calls.length >= 1, 'a publish');
        const body = h.calls[0]!.body;
        expect(body.picture.members[0]!.realmPoints).toBe(25);
        expect(body.picture.contacts[0]).toMatchObject({ kind: 'player', target: 'Tank', casting: true, helped: true, healer: true, caster: true });
        expect(body.events.find(e => e.kind === 'death')!.data).toEqual({ killer: { name: 'Troll', kind: 'player', realm: 'midgard' } });
    });

    test('pets on the wire: a member\'s pet, summons and capability, and a contact\'s isPet and targetPet; none of it for a group without', async () => {
        const h = harness();
        const capabilities = { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], pet: 'main' as const };
        const pet = { objectId: 600, name: 'spirit warrior', level: 17, x: 1010, y: 990, z: 0, hp: 84, targetId: null, inCombat: false, aggression: 'defensive' as const, walk: 'follow' as const, icons: [5] };
        h.board.publish(obs(report('Tank', { objectId: 100, capabilities, pet, summons: [601] }), [
            sighting(301, { targetId: 600 }),
            sighting(302, { name: 'spirit warrior', realm: 'midgard', isPet: true }),
        ]));
        await until(() => h.calls.length >= 1, 'a publish');
        const p = h.calls[0]!.body.picture;
        expect(p.members[0]).toMatchObject({ pet, summons: [601], capabilities: { pet: 'main' } });
        expect(p.contacts.find(c => c.objectId === 301)).toMatchObject({ target: null, targetPet: 'Tank' });
        expect(p.contacts.find(c => c.objectId === 302)!.isPet).toBe(true);

        const g = harness();
        g.board.publish(obs(report('Tank', { objectId: 100 }), [sighting(301)]));
        await until(() => g.calls.length >= 1, 'a publish');
        const plain = g.calls[0]!.body.picture;
        expect('pet' in plain.members[0]! || 'summons' in plain.members[0]! || 'pet' in plain.members[0]!.capabilities).toBe(false);
        expect('isPet' in plain.contacts[0]!).toBe(false);
    });

    test('a hanging gateway: one request in flight, ticks skipped, nothing thrown, finish() within its cap', async () => {
        const h = harness(() => new Promise<Response>(() => {}));
        await until(() => h.calls.length >= 1, 'a publish');
        await pause(150);
        expect(h.calls.length).toBe(1);
        expect(h.pub.stats()).toMatchObject({ inFlight: true, publishes: 1 });
        expect(h.pub.stats().skipped).toBeGreaterThan(2);
        // The end goes out anyway, beside the stuck request.
        h.pub.ending(null);
        const t0 = Date.now();
        await h.pub.finish({}, 100);
        expect(Date.now() - t0).toBeLessThan(400);
        expect(h.calls.map(c => c.body.state)).toEqual(['starting', 'ending', 'ended']);
        expect(h.lines).toEqual([]);
    });

    test('a failing gateway backs off 2, 4, 8 s, logs when the streak starts and when it answers again', async () => {
        let clock = 1_800_000_000_000;
        const h = harness((b, n) => {
            if (n === 2 || n === 4) throw new Error('Unable to connect');
            if (n === 3) return Response.json({ ok: false, v: 1, error: 'run store full' }, { status: 503 });
            return ackAll(b);
        }, {}, { now: () => clock });
        await until(() => h.calls.length >= 2, 'the first failure');
        await pause(100);
        expect(h.calls.length).toBe(2);
        clock += 1999;
        await pause(60);
        expect(h.calls.length).toBe(2);
        clock += 1;
        await until(() => h.calls.length >= 3, 'a retry after 2 s');
        clock += 3999;
        await pause(60);
        expect(h.calls.length).toBe(3);
        clock += 1;
        await until(() => h.calls.length >= 4, 'a retry after 4 s');
        clock += 8000;
        await until(() => h.calls.length >= 6, 'recovery and the next publish without delay');
        expect(h.lines).toEqual([
            'viewer: http://gw.test/viewer/group/alpha',
            'group publish to http://gw.test failed (Unable to connect); retrying with backoff',
            'group publish: the gateway answers again',
        ]);
        expect(h.pub.stats()).toMatchObject({ failed: 3, stopped: false });
    });

    test('an old gateway (its 200 text/plain help page) gets one log line and no further requests', async () => {
        const h = harness(() => new Response('daoc-sdk gateway\n\nGET /status  ...\n', { headers: { 'Content-Type': 'text/plain' } }));
        await until(() => h.calls.length >= 1, 'a publish');
        await pause(150);
        h.pub.ending(null);
        await h.pub.finish({});
        expect(h.calls.length).toBe(1);
        expect(h.lines).toEqual(['group publish stopped for this run: http://gw.test answered HTTP 200 without JSON: the gateway predates the group channel']);
        expect(h.pub.stats().stopped).toBe(true);
    });

    test('a refusal (401, 404, 409, or JSON without ok) stops it for the run', async () => {
        for (const [status, error] of [[401, 'unauthorized'], [404, 'no group alpha'], [409, 'roster does not match groups/alpha/group.json'], [200, 'unsupported version']] as const) {
            const h = harness(() => Response.json({ ok: false, v: 1, error }, { status }));
            await until(() => h.calls.length >= 1, 'a publish');
            await pause(100);
            expect(h.calls.length).toBe(1);
            expect(h.lines).toEqual([`group publish stopped for this run: the gateway refused it (HTTP ${status}: ${error})`]);
        }
    });

    test('a wind-down in an ack reaches onControl once per id, and the next publishes list it as applied', async () => {
        const h = harness(b => ack(0, [
            { id: 'w1', runId: b.runId, kind: 'windDown', reason: '  finish\nup ', requestedAt: 5 },
            { id: 'w2', runId: 'another-run-0001', kind: 'windDown', reason: '', requestedAt: 5 },
            { id: 'w3', runId: b.runId, kind: 'stopCampaign', reason: '', requestedAt: 5 },
            'junk', null,
        ]));
        await until(() => h.calls.length >= 3, 'three publishes');
        expect(h.controls).toEqual([{ id: 'w1', runId: h.pub.runId, kind: 'windDown', reason: 'finish up', requestedAt: 5 }]);
        expect(h.calls.map(c => c.body.applied).slice(0, 3)).toEqual([[], ['w1'], ['w1']]);

        // A run that refuses viewer control never applies one (the gateway shows the button disabled).
        const off = harness(b => ack(0, [{ id: 'w1', runId: b.runId, kind: 'windDown', reason: '', requestedAt: 5 }]), { control: false }, { meta: { ...META, control: false } });
        await until(() => off.calls.length >= 3, 'three publishes');
        expect(off.controls).toEqual([]);
        expect(off.calls[2]!.body.applied).toEqual([]);
        expect(off.calls[0]!.body.meta.control).toBe(false);
    });

    test('publish: false, DAOC_GROUP_PUBLISH=0 and a group id the gateway cannot route send nothing', async () => {
        const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('no')) as any);
        const saved = process.env.DAOC_GROUP_PUBLISH;
        try {
            const off = harness(ackAll, false);
            process.env.DAOC_GROUP_PUBLISH = '0';
            const env = harness();
            delete process.env.DAOC_GROUP_PUBLISH;
            const bad = harness(ackAll, {}, { group: 'two words' });
            for (const h of [off, env, bad]) h.board.emit({ at: 1, kind: 'death', member: 'Tank', text: 'Tank died' });
            await pause(120);
            for (const h of [off, env, bad]) {
                h.pub.ending(null);
                await h.pub.finish({ error: new Error('x') });
                expect(h.calls).toEqual([]);
                expect(h.pub.stats()).toMatchObject({ disabled: true, publishes: 0, pending: 0 });
            }
            expect(spy).not.toHaveBeenCalled();
            expect(off.lines).toEqual([]);
            expect(env.lines).toEqual([]);
            expect(bad.lines).toEqual(['group publish off: "two words" is not a group id the gateway serves (letters, digits, _ and -)']);
        } finally {
            spy.mockRestore();
            if (saved === undefined) delete process.env.DAOC_GROUP_PUBLISH;
            else process.env.DAOC_GROUP_PUBLISH = saved;
        }
    });

    test('running, ending and finish: the phases, the plan on a change and every 30 s, the report every 5 s, the result', async () => {
        let clock = 1_800_000_000_000;
        const h = harness(ackAll, {}, { now: () => clock });
        await until(() => h.calls.length >= 1, 'a starting publish');
        const starting = h.calls[0]!.body;
        expect(starting).toMatchObject({ state: 'starting', coordinator: null, planRev: 0, reportRev: 0, timing: { windingDown: false, deadline: 1, hardStop: 2 } });
        expect('plan' in starting || 'report' in starting).toBe(false);

        const plan = { base: { x: 1, y: 2, z: 3 }, facing: { x: 4, y: 5 }, score: 800, margin: 300, targets: [{ name: 'bear', level: 13, x: 9, y: 9, z: 0, d: 400 }], unsafe: [] };
        const memory: Record<string, any> = { camp: { x: 1, y: 2, z: 3, zone: 'z', count: 4, names: 'bear 13' }, base: plan.base, exclude: new Set([7]), plan };
        h.pub.running(() => memory, () => ({ windingDown: true, deadline: 10, hardStop: 20 }));
        const n = h.calls.length;
        await until(() => h.calls.length >= n + 2, 'two running publishes');
        const [first, second] = [h.calls[n]!.body, h.calls[n + 1]!.body];
        expect(first).toMatchObject({ state: 'running', planRev: 1, reportRev: 1, timing: { windingDown: true, deadline: 10, hardStop: 20 }, coordinator: { excluded: [7], camp: { names: 'bear 13' } } });
        expect(first.plan).toEqual({ base: plan.base, facing: plan.facing, score: 800, margin: 300, targets: [{ name: 'bear', level: 13, x: 9, y: 9, d: 400 }], unsafe: [] });
        expect(first.report).toMatchObject({ group: 'alpha', strategy: 'test-pve', openFight: false });
        // Unchanged within 5 s / 30 s: left out (the gateway keeps the last ones).
        expect('plan' in second || 'report' in second).toBe(false);
        expect(second).toMatchObject({ planRev: 1, reportRev: 1 });

        memory.plan = { ...plan, score: 700 };
        await until(() => h.calls.some(c => c.body.planRev === 2), 'the changed plan');
        expect(h.calls.find(c => c.body.planRev === 2)!.body.plan!.score).toBe(700);
        clock += 30_000;
        const m = h.calls.length;
        await until(() => h.calls.length >= m + 1, 'a publish 30 s later');
        expect(h.calls[m]!.body).toMatchObject({ planRev: 2, reportRev: 2, plan: { score: 700 } });

        h.board.emit({ at: clock, kind: 'kill', member: 'Tank', text: 'bear (L13) died', data: { name: 'bear', level: 13 } });
        // A timed end is no failure: no error on either, result.stoppedBy says how it ended.
        h.pub.ending(null);
        const result = { totals: first.report!.totals, findings: ['medium idle: Menta was idle 50% of fight time'], stamp: '20261031-120000', stoppedBy: 'time' as const };
        await h.pub.finish({ result });
        const [ending, ended] = h.calls.slice(-2).map(c => c.body);
        expect(ending).toMatchObject({ state: 'ending', error: null });
        expect(ending!.result).toBeUndefined();
        expect(ending!.events.map(e => e.kind)).toEqual(['kill']);
        expect(ended).toMatchObject({ state: 'ended', error: null, result, report: { openFight: false } });
        expect(ended!.result!.stoppedBy).toBe('time');
        const count = h.calls.length;
        await pause(80);
        expect(h.calls.length).toBe(count);
    });

    test('finish() with an error before the run started says why', async () => {
        const h = harness();
        h.pub.ending('members are in different realms: Tank albion, Bard hibernia');
        await h.pub.finish({ error: new Error('members are in different realms: Tank albion, Bard hibernia') });
        expect(h.calls.map(c => [c.body.state, c.body.error])).toEqual([
            ['ending', 'members are in different realms: Tank albion, Bard hibernia'],
            ['ended', 'members are in different realms: Tank albion, Bard hibernia'],
        ]);
        // Nothing ran: no result, no (empty) score.
        expect(h.calls[1]!.body.result).toBeUndefined();
        expect(h.calls[1]!.body.report).toBeUndefined();
    });

    test('only a failure carries an error: ending() takes the first word, the ended publish agrees with its result', async () => {
        const result = (stoppedBy: 'time' | 'viewer' | 'error') => ({ totals: new GroupObserver(null, { group: 'alpha', strategy: 'test-pve' }).report().totals, findings: [], stamp: null, stoppedBy });
        // A failure after the start: the abort ends it, the finally's ending() changes nothing, the result says 'error'.
        const failed = harness();
        failed.pub.ending('alpha: gateway connection lost');
        failed.pub.ending(null);
        await failed.pub.finish({ error: new Error('alpha: gateway connection lost'), result: result('error') });
        expect(failed.calls.map(c => [c.body.state, c.body.error])).toEqual([['ending', 'alpha: gateway connection lost'], ['ended', 'alpha: gateway connection lost']]);
        expect(failed.calls[1]!.body.result!.stoppedBy).toBe('error');
        // A wound-down run: no error anywhere, even after an 'ending' that named one.
        const wound = harness();
        wound.pub.ending('stale reason');
        await wound.pub.finish({ result: result('viewer') });
        expect(wound.calls.map(c => [c.body.state, c.body.error])).toEqual([['ending', 'stale reason'], ['ended', null]]);
        expect(wound.calls[1]!.body.result!.stoppedBy).toBe('viewer');
    });
});
