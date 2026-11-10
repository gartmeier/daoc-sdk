// The side tick: a behaviour marked `side` runs on its own clock beside the turns, on a real MemberAgent.
import { describe, expect, test } from 'bun:test';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { makeNpc, makePlayerObj, makeState } from '../test/fixtures';
import type { PetCommand, PetState } from '../types';
import { Blackboard } from './blackboard';
import { MemberAgent, type Behavior, type MemberContext } from './member';
import { withPets } from './pets';

function harness(behaviors: Behavior[], pet: PetState | null = null, noPlayer = false) {
    const state = makeState({ gameMessages: [], pet });
    const sent: PetCommand[] = [];
    const flags = { noPlayer };
    const sdk = {
        getState: () => state, getPlayer: () => (flags.noPlayer ? null : state.player), getSkills: () => ({}), getGameMessages: () => state.gameMessages, onStateUpdate: () => () => {},
        isConnected: () => true, getPetState: () => state.pet ?? null, getNearbyNpc: () => null, getNearbyPlayer: () => null,
        sendPetCommand: async (c: PetCommand) => { sent.push(c); return { success: true, message: '' }; },
    } as unknown as BotSDK;
    const bot = { getSpellInfo: () => null, isDead: () => false } as unknown as BotActions;
    const board = new Blackboard();
    const agent = new MemberAgent({ bot: 'testbot', role: 'tank', sdk, actions: bot }, board, behaviors, {}, { minTurnMs: 10, idleMs: 10, failedTurnMs: 150, sideTickMs: 20 });
    const stop = new AbortController();
    const running = agent.run(stop.signal);
    const end = async () => { stop.abort(new Error('test over')); await running.catch(() => {}); agent.dispose(); };
    return { agent, board, state, sent, flags, end, running };
}

describe('MemberContext.settings: Orders.settings on top', () => {
    test('a decide switches a setting mid-run for the next behaviour, and null gives the member its own back', async () => {
        const seen: unknown[] = [];
        const h = harness([{ name: 'look', run(ctx) { seen.push((ctx.settings as { formation?: unknown }).formation ?? 'own'); return false; } }]);
        await Bun.sleep(40);
        h.board.setOrders({ settings: { formation: 'wide' }, reason: 'enemy is caster-heavy' });
        await Bun.sleep(40);
        h.board.setOrders({ settings: null, reason: 'enemy left' });
        await Bun.sleep(40);
        await h.end();
        expect(seen[0]).toBe('own');
        expect(seen).toContain('wide');
        expect(seen.at(-1)).toBe('own');
        // Not material: no orders event for a settings change alone.
        expect(h.board.events().filter(e => e.kind === 'orders')).toEqual([]);
    });
});

describe('MemberAgent: out of the world', () => {
    // Run 161132 after the kick: "petenc: healer threw: null is not an object (evaluating 'me.constitutionLost')".
    test('no turn while there is no player: a relog takes a while, and every behaviour reads `me` as there', async () => {
        let turns = 0;
        const h = harness([{ name: 'healer', run(ctx) { turns++; return (ctx.me().constitutionLost ?? 0) > 0; } }], null, true);
        await Bun.sleep(60);
        expect(turns).toBe(0);
        h.flags.noPlayer = false;
        await Bun.sleep(60);
        await h.end();
        expect(turns).toBeGreaterThan(0);
        expect(h.board.events().filter(e => e.kind === 'note')).toEqual([]);
    });

    test('nor for the rest of a list when it goes in the middle of one', async () => {
        let after = 0;
        const h = harness([
            { name: 'first', run() { h.flags.noPlayer = true; return false; } },
            { name: 'second', run() { after++; return false; } },
        ]);
        await Bun.sleep(60);
        await h.end();
        expect(after).toBe(0);
    });
});

describe('MemberAgent: the side tick', () => {
    test('it runs during a turn: a tank\'s killNpc is one turn to the mob\'s death, and "petControl gets no turn while the tank\'s killNpc runs"', async () => {
        let inTurn = false, during = 0;
        const h = harness([
            { name: 'petControl', side: true, run() { if (inTurn) during++; return false; } },
            { name: 'tank', async run() { inTurn = true; await Bun.sleep(150); inTurn = false; return true; } },
        ]);
        await Bun.sleep(170);
        await h.end();
        expect(during).toBeGreaterThanOrEqual(3);
    });

    test('the turn never waits for it, and it runs one at a time', async () => {
        let turns = 0, running = 0, most = 0;
        const h = harness([
            { name: 'slow', side: true, async run() { most = Math.max(most, ++running); await Bun.sleep(120); running--; return false; } },
            { name: 'quick', run() { turns++; return true; } },
        ]);
        await Bun.sleep(300);
        await h.end();
        expect(turns).toBeGreaterThanOrEqual(5);
        expect(most).toBe(1);
    });

    test('a turn behaviour that throws: a note, it sits out a while, and the turn goes on down the list', async () => {
        // Arena round 9: a cure above heal threw every time and spent each turn plus a second; the healer healed 5 times.
        let tries = 0, heals = 0;
        const h = harness([
            { name: 'cure', run() { tries++; throw new Error('RANGE_MARGIN_3D is not defined'); } },
            { name: 'heal', run() { heals++; return true; } },
        ]);
        await Bun.sleep(300);
        await h.end();
        expect(tries).toBe(1);
        expect(heals).toBeGreaterThanOrEqual(3);
        expect(h.board.events().filter(e => e.kind === 'note').map(e => e.text)).toEqual(['cure threw: RANGE_MARGIN_3D is not defined']);
    });

    test('an error is caught as a turn\'s is: a note, a pause, and the turns go on', async () => {
        let tries = 0, turns = 0;
        const h = harness([
            { name: 'broken', side: true, run() { tries++; throw new Error('boom'); } },
            { name: 'quick', run() { turns++; return true; } },
        ]);
        await Bun.sleep(200);
        await h.end();
        expect(tries).toBe(1);
        expect(turns).toBeGreaterThanOrEqual(3);
        expect(h.board.events().filter(e => e.kind === 'note').map(e => e.text)).toEqual(['broken threw: boom']);
    });

    test('it leaves the turn alone: no activity, no idle reason, and a failure it records doesn\'t pace the turn; the memory is the member\'s', async () => {
        let turns = 0, memory: unknown = null;
        const h = harness([
            { name: 'side', side: true, run(ctx) { memory = ctx.memory; ctx.doing('nuke', 5, 'on the side'); ctx.result('petAttack', { success: false, reason: 'immune' }, 5); return ctx.skip('side reason'); } },
            { name: 'quick', run() { turns++; return true; } },
        ]);
        await Bun.sleep(200);
        const member = h.board.picture().members[0]!;
        await h.end();
        expect(member.activity.kind).toBe('idle');
        expect(h.agent.lastSkip).not.toBe('side reason');
        // failedTurnMs would allow two in this time.
        expect(turns).toBeGreaterThanOrEqual(5);
        expect(memory).toBe(h.agent.ctx.memory);
        expect(h.board.events().some(e => e.kind === 'result' && e.text.startsWith('petAttack: immune'))).toBe(true);
    });

    test('it isn\'t in the list\'s turn: with nothing else on the list the member is idle, and the reason is its own', async () => {
        let ticks = 0;
        const h = harness([{ name: 'side', side: true, run() { ticks++; return true; } }, { name: 'wait', run(ctx) { return ctx.skip('nothing to do'); } }]);
        await Bun.sleep(100);
        const member = h.board.picture().members[0]!;
        await h.end();
        expect(ticks).toBeGreaterThanOrEqual(2);
        expect(member.activity).toMatchObject({ kind: 'idle', detail: 'nothing to do' });
    });

    test('no player, no tick', async () => {
        let ticks = 0;
        const h = harness([{ name: 'side', side: true, run() { ticks++; return false; } }]);
        h.flags.noPlayer = true;
        await Bun.sleep(60);
        const before = ticks;
        await Bun.sleep(100);
        expect(ticks).toBe(before);
        h.flags.noPlayer = false;
        await Bun.sleep(100);
        await h.end();
        expect(ticks).toBeGreaterThan(before);
    });

    test('the run\'s stop ends it before run() settles, so nothing goes out after: the runner sends petAfterRun then', async () => {
        let ticks = 0;
        const h = harness([{ name: 'side', side: true, async run() { ticks++; await Bun.sleep(5); return false; } }, { name: 'long', async run() { await Bun.sleep(5000); return true; } }]);
        await Bun.sleep(60);
        await h.end();
        const at = ticks;
        await Bun.sleep(80);
        expect(ticks).toBe(at);
    });

    test('a turn that throws with the connection gone doesn\'t leave run() hanging on the side tick', async () => {
        const state = makeState({ gameMessages: [] });
        const sdk = { getState: () => state, getPlayer: () => state.player, getSkills: () => ({}), getGameMessages: () => [], onStateUpdate: () => () => {}, isConnected: () => false } as unknown as BotSDK;
        const agent = new MemberAgent({ bot: 'testbot', role: 'tank', sdk, actions: { getSpellInfo: () => null } as unknown as BotActions }, new Blackboard(), [
            { name: 'side', side: true, run() { return false; } },
            { name: 'lost', run() { throw new Error('gone'); } },
        ], {}, { sideTickMs: 20 });
        const stop = new AbortController();
        const ended = await Promise.race([agent.run(stop.signal).then(() => 'resolved', () => 'rejected'), Bun.sleep(3000).then(() => 'hung')]);
        stop.abort(new Error('test over'));
        agent.dispose();
        expect(ended).toBe('rejected');
    });

    test('chained casts on another target leave it a slot: the end of a cast is none when the next follows in one macrotask', async () => {
        // A Druid healing a tank below heal.tank: each heal outlasts minTurnMs, so nothing sleeps, and its pet got no attack order until the chain stopped (selectFree reads the turn). In the list petControl had the start of every turn.
        const seen: unknown[] = [];
        let casts = 0;
        const h = harness([
            { name: 'side', side: true, run(ctx: MemberContext) { seen.push(ctx.turn()); return false; } },
            { name: 'sprint', run() { return false; } },
            { name: 'heal', interruptible: false, async run(ctx) { ctx.doing('heal', 3, 'Minor Rejuvenation'); casts++; await Bun.sleep(60); return true; } },
        ], null);
        await Bun.sleep(400);
        await h.end();
        expect(casts).toBeGreaterThan(3);
        // The first tick can come before the first turn.
        expect(seen.slice(1).filter(t => t === null).length).toBeGreaterThanOrEqual(casts - 2);
    });

    test('a tick in that slot runs one at a time with the clock\'s', async () => {
        let running = 0, most = 0;
        const h = harness([
            { name: 'side', side: true, async run() { most = Math.max(most, ++running); await Bun.sleep(30); running--; return false; } },
            { name: 'heal', async run() { await Bun.sleep(25); return true; } },
        ], null);
        await Bun.sleep(300);
        await h.end();
        expect(most).toBe(1);
    });

    test('with nothing marked side the turn has no slot to wait for, and a failing side behaviour costs the turn nothing there', async () => {
        let turns = 0;
        const h = harness([
            { name: 'side', side: true, run() { throw new Error('boom'); } },
            { name: 'turn', async run() { turns++; await Bun.sleep(20); return true; } },
        ], null);
        await Bun.sleep(200);
        await h.end();
        expect(turns).toBeGreaterThanOrEqual(3);
    });

    test('ctx.turn(): what the behaviour running now has announced, null between behaviours', async () => {
        const seen: unknown[] = [];
        const h = harness([
            { name: 'side', side: true, run(ctx: MemberContext) { seen.push(ctx.turn()); return false; } },
            { name: 'nuke', async run(ctx) { ctx.doing('nuke', 51, 'Lesser Bones to Dust'); await Bun.sleep(60); return true; } },
        ], null);
        await Bun.sleep(150);
        await h.end();
        expect(seen).toContainEqual({ kind: 'nuke', targetId: 51 });
        expect(h.agent.ctx.turn()).toBeNull();
    });
});

describe('a pet in a tank\'s long turn (run 20261103-155156)', () => {
    // 21.74 s hunter's pet tgt=3598 (black mauler), orders 23.15 s cc=[{"targetId":3598,"by":"Petbon"}], focus 17709,
    // and "No 'You command the hunter's pet to follow' at all in 21-28 s": 'Pethun's pet broke the root on black mauler'.
    test('it comes off the add with a mezz ordered on it, inside the turn', async () => {
        const list = withPets<any>([{ name: 'tank', async run() { await Bun.sleep(400); return true; } }], { window: true });
        expect(list.find(b => b.name === 'petControl')?.side).toBe(true);
        const pet: PetState = { objectId: 900, name: "hunter's pet", aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: 3598 };
        const h = harness(list, pet);
        const at = { x: h.state.player!.x, y: h.state.player!.y };
        const mob = (objectId: number, name: string) => makeNpc({ objectId, name, level: 6, x: at.x + 100, y: at.y, targetObjectId: h.state.player!.objectId, inCombat: true, distance: 100, distance2d: 100 });
        h.state.nearbyNpcs = [mob(3598, 'black mauler'), mob(17709, 'large sveawolf')];
        h.state.timestamp = Date.now();
        h.agent.publish();
        h.board.setOrders({ phase: 'engage', focus: 17709, cc: [{ targetId: 3598, by: 'Petbon' }], reason: 'test' });
        await Bun.sleep(150);
        const sent = [...h.sent];
        await h.end();
        expect(sent).toContain('follow');
    });
});

describe('MemberContext.result: "You can\'t attack a shadowed necromancer!" (AbstractServerRules.cs:449-455)', () => {
    const LINE = "You can't attack a shadowed necromancer!";
    const withBriton = () => {
        const h = harness([]);
        const p = h.state.player!;
        h.state.nearbyPlayers = [makePlayerObj({ objectId: 427, name: 'Briton', realm: p.realm === 'albion' ? 'midgard' : 'albion', x: p.x + 100, y: p.y, distance2d: 100, distance: 100 })];
        h.state.timestamp = Date.now();
        h.agent.publish();
        return h;
    };
    const briton = (h: ReturnType<typeof harness>) => h.board.picture().contacts.find(c => c.objectId === 427)!;

    // Run 20261103-174011: "Petbon: cc: refused (...)", "Pethun: melee: refused (...)", "Petbon: nuke: refused (...)" every second.
    test.each(['cc', 'melee', 'nuke', 'petAttack'])('a refused %s marks the contact for 30 s, for the whole group', kind => {
        const h = withBriton();
        const before = Date.now();
        h.agent.ctx.result(kind, { success: false, reason: 'refused', message: LINE }, 427);
        expect(briton(h).unattackableUntil).toBeGreaterThanOrEqual(before + 30_000);
        h.agent.dispose();
    });

    test('from the side tick too: petControl\'s answer goes through its context', () => {
        const h = withBriton();
        (h.agent as unknown as { sideCtx: MemberContext }).sideCtx.result('petAttack', { success: false, reason: 'not_attackable', message: LINE }, 427);
        expect(briton(h).unattackableUntil).toBeDefined();
        h.agent.dispose();
    });

    test('any other refusal, a success or no target says nothing', () => {
        const h = withBriton();
        h.agent.ctx.result('nuke', { success: false, reason: 'refused', message: "You can't attack a member of your realm!" }, 427);
        h.agent.ctx.result('nuke', { success: true, message: 'Cast' }, 427);
        h.agent.ctx.result('nuke', { success: false, reason: 'refused', message: LINE });
        expect(briton(h)).not.toHaveProperty('unattackableUntil');
        h.agent.dispose();
    });
});
