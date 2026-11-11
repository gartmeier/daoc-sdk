import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BotSDK, headingBetween } from '../index';
import { BotActions, castFailureReason, tradeSlotWait, getNavmeshStore, type KillResult, type NavMesh, type NavmeshStore, type PetCommandResult } from '../actions';
import { ActionHelpers, PVP_IMMUNE_RETRY_MS, resurrectCost } from '../actions-helpers';
import { setDefaultPathProvider, StraightLinePathProvider, type PathProvider } from '../pathfinding';
import { executionContext } from '../execution-context';
import { ObjectType } from '../types';
import type { Build } from '../../data/builds/types';
import { getSpells, getZoneAt } from '../../data/index';
import { specKey } from '../../data/spec-names';
import type { ActionResult, BotAction, BotWorldState, GameMessage, InventoryItem, NearbyNpc, NearbyPlayer, PetCommand, PetState, PlayerState, Spell } from '../types';
import { makeNpc, makeObject, makePlayer, makePlayerObj, makeState } from './fixtures';
import { defaultHandlers, FakeWorld, type Handler } from './fake-world';

// Fixed straight-line paths: a locally built server/navmesh/zone000.nav would otherwise route every walk here.
// No mesh under these worlds, built on this machine or not: a test that wants one says what it answers.
let navmeshAt: Mock<NavmeshStore['at']>;
beforeAll(() => {
    setDefaultPathProvider(new StraightLinePathProvider());
    navmeshAt = spyOn(getNavmeshStore(), 'at').mockReturnValue(null);
});
afterAll(() => {
    setDefaultPathProvider(null);
    navmeshAt.mockRestore();
});

let worlds: FakeWorld[] = [];
function world(overrides: Partial<BotWorldState> = {}): { w: FakeWorld; bot: BotActions; sdk: BotSDK } {
    const w = new FakeWorld(overrides);
    worlds.push(w);
    return { w, bot: new BotActions(w.sdk), sdk: w.sdk };
}
afterEach(() => {
    for (const w of worlds) w.dispose();
    worlds = [];
});

const at = (x: number, y: number, z = 2500) => ({ x, y, z });

// ── Movement ────────────────────────────────────────────────────────────────

describe('walkTo', () => {
    test('arrives and reports the position', async () => {
        const { w, bot } = world();
        const r = await bot.walkTo(560800, 511300, { z: 2500, tolerance: 20 });
        expect(r).toMatchObject({ success: true, message: 'Arrived', reissues: 0 });
        expect(Math.hypot(w.player.x - 560800, w.player.y - 511300)).toBeLessThanOrEqual(20);
        const move = w.sentOf('moveTo')[0]!;
        expect(move).toMatchObject({ x: 560800, y: 511300, z: 2500 });
    });

    test('splits long walks into waypoints with estimated z', async () => {
        const { w, bot } = world();
        w.stepSize = 1500;
        const { StraightLinePathProvider } = await import('../pathfinding');
        const r = await bot.walkTo(565000, 511000, { pathProvider: new StraightLinePathProvider({ maxSegment: 1000, estimateZ: () => 2600 }) });
        expect(r.success).toBeTrue();
        const move = w.sentOf('moveTo')[0]!;
        expect(move.waypoints!.length).toBe(4);
        expect(move.waypoints!.every(p => p.z === 2600)).toBeTrue();
        expect(move.z).toBe(2600);
    });

    test('re-issues after a server correction', async () => {
        const { w, bot } = world();
        let corrected = false;
        w.handlers.moveTo = (a, world) => {
            defaultHandlers.moveTo!(a, world);
            if (!corrected) {
                corrected = true;
                // The speed monitor snaps us back: the move ends where it started.
                setTimeout(() => {
                    world.state.movement = { ...world.state.movement, moving: false, destination: null, waypoints: [], lastStopReason: 'teleported', correctionCount: 1 };
                }, 15);
                world.stepSize = 0;
                setTimeout(() => { world.stepSize = 200; }, 30);
            }
        };
        const r = await bot.walkTo(561000, 511000);
        expect(r.success).toBeTrue();
        expect(r.reissues).toBe(1);
        expect(w.sentOf('moveTo').length).toBe(2);
    });

    test('a walk the move guard holds at the bank ends with reason water at once, not 8 re-issues and stuck', async () => {
        // Hibernia, rounds 139 and 172: the real mover stops up to its tolerance short of the bank spot, and each
        // re-issue, cut to that spot again, "arrived" at once until the walk gave up as stuck.
        const { w, bot, sdk } = world();
        const bankX = w.player.x + 1000;
        sdk.setMoveGuard((_from, to) => (to.x > bankX ? { to: { x: bankX, y: to.y }, waypoints: [] } : null));
        w.handlers.moveTo = (a, world) => {
            if (a.type !== 'moveTo') return;
            const p = world.player, d = Math.hypot(a.x - p.x, a.y - p.y), short = Math.max(0, (a.tolerance ?? 16) - 5);
            const k = d > short ? (d - short) / d : 0;
            defaultHandlers.moveTo!({ ...a, x: Math.round(p.x + (a.x - p.x) * k), y: Math.round(p.y + (a.y - p.y) * k), tolerance: 1 }, world);
        };
        const t0 = Date.now();
        const r = await bot.walkTo(w.player.x + 3000, w.player.y, { tolerance: 80 });
        expect(r).toMatchObject({ success: false, reason: 'water' });
        expect(w.sentOf('moveTo')).toHaveLength(1);
        expect(bankX - w.player.x).toBeGreaterThan(48);
        expect(Date.now() - t0).toBeLessThan(2000);
        // The next walk there, the bank spot within its tolerance, is refused without a move.
        expect(await bot.walkTo(w.player.x + 3000, w.player.y, { tolerance: 80 })).toMatchObject({ success: false, reason: 'water' });
        expect(w.sentOf('moveTo')).toHaveLength(1);
    });

    test('fails when the player dies en route', async () => {
        const { w, bot } = world();
        w.stepSize = 20;
        setTimeout(() => { w.player.isDead = true; w.player.deathCount = 1; }, 60);
        const r = await bot.walkTo(570000, 511000);
        expect(r).toMatchObject({ success: false, reason: 'died' });
    });

    test('detects no progress', async () => {
        const { w, bot } = world();
        w.stepSize = 0;
        const r = await bot.walkTo(561000, 511000, { stuckMs: 150 });
        expect(r).toMatchObject({ success: false, reason: 'stuck' });
        expect(w.sentOf('stop').length).toBe(1);
    });

    test('validates arguments and honours the timeout', async () => {
        const { w, bot } = world();
        expect(await bot.walkTo(NaN, 1)).toMatchObject({ success: false, reason: 'bad_args' });
        w.stepSize = 1;
        const r = await bot.walkTo(570000, 511000, { timeout: 100, stuckMs: 10_000 });
        expect(r).toMatchObject({ success: false, reason: 'timeout' });
    });

    test('already there succeeds without moving', async () => {
        const { w, bot } = world();
        expect(await bot.walkTo(w.player.x + 10, w.player.y)).toMatchObject({ success: true, message: 'Already at destination' });
        expect(w.sentOf('moveTo')).toHaveLength(0);
        // Already there while an earlier move is carrying us away: stop instead of drifting off.
        w.state.movement = { ...w.state.movement, moving: true, destination: at(570000, 511000), waypoints: [at(570000, 511000)] };
        w.stepSize = 1;
        w.publish();
        expect(await bot.walkTo(w.player.x + 10, w.player.y)).toMatchObject({ success: true });
        expect(w.sentOf('stop')).toHaveLength(1);
        expect(w.state.movement.moving).toBeFalse();
    });

    test('aborts with the execution context', async () => {
        const { w, bot } = world();
        w.stepSize = 1;
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('cancelled')), 50);
        await expect(executionContext.run({ signal: controller.signal }, () => bot.walkTo(570000, 511000, { stuckMs: 10_000 }))).rejects.toThrow('cancelled');
    });

    test('a detour that leads away from the destination is progress, not stuck', async () => {
        const { w, bot } = world();
        w.stepSize = 20; // ~14 ticks per 300-unit leg: the walk out takes far longer than stuckMs
        const start = { x: w.player.x, y: w.player.y };
        const r = await bot.followPath([{ x: start.x + 300, y: start.y }, { x: start.x + 300, y: start.y + 300 }, { x: start.x, y: start.y + 20 }], { tolerance: 10, stuckMs: 150 });
        expect(r).toMatchObject({ success: true, message: 'Arrived' });
    });

    test('an abort stops the mover instead of leaving it running', async () => {
        const { w, bot } = world();
        w.stepSize = 1;
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('cancelled')), 50);
        await expect(executionContext.run({ signal: controller.signal }, () => bot.walkTo(570000, 511000, { stuckMs: 10_000 }))).rejects.toThrow('cancelled');
        expect(w.sentOf('stop')).toHaveLength(1);
        expect(w.state.movement.moving).toBeFalse();
    });

    test('stopOnAbort: false leaves the mover running for the next move, read when the abort comes', async () => {
        const { w, bot } = world();
        w.stepSize = 1;
        let keep = true;
        const run = async () => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(new Error('cancelled')), 50);
            await expect(executionContext.run({ signal: controller.signal }, () => bot.walkTo(570000, 511000, { stuckMs: 10_000, stopOnAbort: () => !keep }))).rejects.toThrow('cancelled');
        };
        await run();
        expect(w.sentOf('stop')).toHaveLength(0);
        expect(w.state.movement.moving).toBeTrue();
        keep = false;
        await run();
        expect(w.sentOf('stop')).toHaveLength(1);
    });

    test('walkToObject adopts the target z and stops in range', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'sewer rat', x: 560600, y: 511000, z: 2300 })] });
        const r = await bot.walkToObject('sewer rat', { range: 100 });
        expect(r.success).toBeTrue();
        const rat = w.npc(201)!;
        expect(Math.hypot(rat.x - w.player.x, rat.y - w.player.y, rat.z - w.player.z)).toBeLessThanOrEqual(100);
        expect(w.sentOf('moveTo')[0]!.z).toBe(rat.z);
        expect((await bot.walkToObject('nobody')).reason).toBe('not_found');
    });

    test('walkToObject adopts the target z when already close on the ground', async () => {
        // 30 units away in 2D, 200 in height: route() alone would report 'Already at destination'.
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'hill mob', x: 560030, y: 511000, z: 2700 })] });
        w.publish();
        const r = await bot.walkToObject('hill mob', { range: 90 });
        expect(r).toMatchObject({ success: true });
        expect(w.sentOf('moveTo')).toHaveLength(1);
        expect(w.sentOf('moveTo')[0]).toMatchObject({ x: 560030, y: 511000, z: 2700 });
        expect(w.player.z).toBe(2700);
    });

    test('a timeout stops a move that no snapshot shows yet', async () => {
        const { w, bot } = world();
        // The client accepts the move, but the mover only reports moving much later.
        w.handlers.moveTo = (a, world) => { setTimeout(() => defaultHandlers.moveTo!(a, world), 400); };
        const r = await bot.walkTo(570000, 511000, { timeout: 100, stuckMs: 10_000 });
        expect(r.reason).toBe('timeout');
        expect(w.sentOf('stop')).toHaveLength(1);
    });

    // A 1000-unit walk east that the planner routes 4000 units north first: 9000 units in all.
    const detour = (from: { x: number; y: number }, z = 2500) => [at(from.x, from.y + 4000, z), at(from.x + 1000, from.y + 4000, z), at(from.x + 1000, from.y, z)];
    // Deadlines run as setTimeouts (withExecutionDeadline); the walk itself is fast in the fake world.
    const deadlinesDuring = async <T>(run: () => Promise<T>): Promise<{ result: T; delays: number[] }> => {
        const spy = spyOn(globalThis, 'setTimeout');
        try {
            const result = await run();
            return { result, delays: spy.mock.calls.map(c => Number(c[1] ?? 0)) };
        } finally {
            spy.mockRestore();
        }
    };

    test('the default timeout covers the planned detour, not the straight distance', async () => {
        const { w, bot } = world();
        w.stepSize = 1000;
        const start = { x: w.player.x, y: w.player.y };
        const pathProvider: PathProvider = { name: 'detour', findPath: () => ({ success: true, waypoints: detour(start) }) };
        const { result, delays } = await deadlinesDuring(() => bot.walkTo(start.x + 1000, start.y, { pathProvider }));
        expect(result).toMatchObject({ success: true, message: 'Arrived' });
        // 9000 units at 191: 1.5 × 47 s + 15 s ≈ 86 s (the straight 1000 units would give ≈ 23 s).
        expect(Math.max(...delays)).toBeGreaterThan(80_000);
        expect(w.sentOf('moveTo')[0]!.waypoints).toHaveLength(2);
    });

    test('a re-plan after a correction extends the default timeout', async () => {
        const { w, bot } = world();
        w.stepSize = 1000;
        const start = { x: w.player.x, y: w.player.y };
        let plans = 0;
        // Straight first; after the snap back the planner only finds the long way round.
        const pathProvider: PathProvider = {
            name: 'detour-after-correction',
            findPath: ({ to }) => ({ success: true, waypoints: ++plans === 1 ? [at(to.x, to.y)] : detour(start) }),
        };
        let corrected = false;
        w.handlers.moveTo = (a, world) => {
            defaultHandlers.moveTo!(a, world);
            if (!corrected) {
                corrected = true;
                world.stepSize = 0;
                setTimeout(() => {
                    world.state.movement = { ...world.state.movement, moving: false, destination: null, waypoints: [], lastStopReason: 'teleported', correctionCount: 1 };
                    world.stepSize = 1000;
                }, 15);
            }
        };
        const { result, delays } = await deadlinesDuring(() => bot.walkTo(start.x + 1000, start.y, { pathProvider }));
        expect(result).toMatchObject({ success: true, reissues: 1 });
        expect(plans).toBe(2);
        expect(Math.max(...delays)).toBeGreaterThan(90_000);
    });

    test('an explicit timeout covers planning', async () => {
        const { bot } = world();
        const pathProvider: PathProvider = { name: 'slow', findPath: () => new Promise(() => {}) };
        const r = await bot.walkTo(561000, 511000, { pathProvider, timeout: 100 });
        expect(r).toMatchObject({ success: false, reason: 'timeout', message: 'Walk timed out after 100ms' });
    });

    test('followPath passes waypoints through one move', async () => {
        const { w, bot } = world();
        const r = await bot.followPath([{ x: 560300, y: 511000 }, { x: 560300, y: 511300 }, { x: 560000, y: 511300 }], { tolerance: 10 });
        expect(r.success).toBeTrue();
        expect(w.player).toMatchObject({ x: 560000, y: 511300 });
    });
});

describe('face / target / stop', () => {
    test('face a heading, a point and an object', async () => {
        const { w, bot } = world();
        expect((await bot.face(1024)).heading).toBe(1024);
        const r = await bot.face({ x: w.player.x, y: w.player.y + 100 });
        expect(r.success).toBeTrue();
        expect(r.heading).toBe(0);
        expect((await bot.face('sewer rat')).success).toBeTrue();
        expect(w.sentOf('faceObject')[0]!.objectId).toBe(201);
    });

    test('a bare number is always a heading, even when it matches an object id', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 1024, name: 'town crier', x: 560100, y: 511000 })] });
        w.publish();
        const r = await bot.face(1024);
        expect(r).toMatchObject({ success: true, heading: 1024 });
        expect(w.sentOf('face')[0]!.heading).toBe(1024);
        expect(w.sentOf('faceObject')).toHaveLength(0);
        expect((await bot.face({ objectId: 1024 })).success).toBeTrue();
        expect(w.sentOf('faceObject')[0]!.objectId).toBe(1024);
    });

    test('target observes targetObjectId', async () => {
        const { w, bot } = world();
        const r = await bot.target('rat');
        expect(r).toMatchObject({ success: true });
        expect(r.target?.objectId).toBe(200);
        expect(w.player.targetObjectId).toBe(200);
        expect((await bot.target(w.player.objectId)).success).toBeTrue();
        expect((await bot.target('ghost')).reason).toBe('not_found');
    });

    test('stop observes the mover going idle', async () => {
        const { w, bot } = world();
        w.state.movement = { ...w.state.movement, moving: true, destination: at(570000, 511000), waypoints: [at(570000, 511000)] };
        w.stepSize = 1;
        expect(await bot.stop()).toMatchObject({ success: true });
    });
});

// ── Dialog ──────────────────────────────────────────────────────────────────

describe('talkTo / whisper / navigateDialog', () => {
    test('an NPC with no name reads by its id', async () => {
        const { bot } = world({ nearbyNpcs: [makeNpc({ objectId: 15905, name: '', x: 560080, y: 511000 })] });
        expect(await bot.talkTo(15905, { timeout: 30 })).toMatchObject({ success: false, reason: 'no_response', message: 'No response from #15905' });
    });

    const trainerNpc = makeNpc({ objectId: 210, name: 'Master Graent', guildName: 'Fighter Trainer', realm: 'albion', role: 'trainer', level: 25, x: 560080, y: 511000 });

    function withTrainer() {
        const ctx = world({ nearbyNpcs: [trainerNpc] });
        ctx.w.handlers.interact = (_a, world) => {
            setTimeout(() => {
                world.message('Master Graent says, "Would you like to do some training?"', { type: 'say', sender: 'Master Graent' });
                world.message('Master Graent says, "Do you require a [practice weapon]?"', { type: 'say', popup: true, sender: 'Master Graent' });
                world.message('Master Graent says, "Do you require a [training shield]?"', { type: 'say', popup: true, sender: 'Master Graent' });
                world.state.npcDialog = { npcObjectId: 210, npcName: 'Master Graent', text: 'Do you require a [training shield]?', keywords: ['training shield'], receivedAt: Date.now() };
            }, 15);
        };
        ctx.w.handlers.whisper = (a, world) => {
            if (a.type !== 'whisper') return;
            setTimeout(() => world.message(`You receive the ${a.text} from Master Graent!`, { type: 'items' }), 15);
        };
        return ctx;
    }

    test('talkTo merges keywords from every line', async () => {
        const { bot } = withTrainer();
        const r = await bot.talkTo('Graent');
        expect(r.success).toBeTrue();
        expect(r.keywords).toEqual(['practice weapon', 'training shield']);
        expect(r.text).toContain('Would you like to do some training?');
    });

    test('talkTo does not report an older dialog as the answer', async () => {
        const { w, bot } = world({
            nearbyNpcs: [trainerNpc],
            npcDialog: { npcObjectId: 210, npcName: 'Master Graent', text: 'Old [stale keyword]', keywords: ['stale keyword'], receivedAt: 1 },
        });
        w.handlers.interact = (_a, world) => { setTimeout(() => { world.state.trainer = { isOpen: true, specPoints: 1, specs: [] }; }, 15); };
        const r = await bot.talkTo('Graent');
        expect(r).toMatchObject({ success: true, keywords: [], dialog: null });
    });

    test('whisper strips brackets and observes the reply', async () => {
        const { w, bot } = withTrainer();
        const r = await bot.whisper('Graent', '[practice weapon]');
        expect(r.success).toBeTrue();
        expect(w.sentOf('whisper')[0]!.text).toBe('practice weapon');
        expect(r.text).toContain('You receive the practice weapon');
    });

    test('whisper resends once after the server rate-limits it', async () => {
        const { w, bot } = withTrainer();
        let calls = 0;
        w.handlers.whisper = (a, world) => {
            if (a.type !== 'whisper') return;
            const first = ++calls === 1;
            setTimeout(() => world.message(first ? 'Slow down! Think before you say each word!' : `You receive the ${a.text} from Master Graent!`, first ? undefined : { type: 'items' }), 15);
        };
        const r = await bot.whisper('Graent', 'practice weapon');
        expect(r.success).toBeTrue();
        expect(w.sentOf('whisper')).toHaveLength(2);
        expect(r.text).toContain('You receive the practice weapon');

        w.handlers.whisper = (a, world) => { if (a.type === 'whisper') setTimeout(() => world.message('Slow down! Think before you say each word!'), 15); };
        expect(await bot.whisper('Graent', 'practice weapon')).toMatchObject({ success: false, reason: 'rate_limited' });
    });

    test('back-to-back whispers are spaced past the NPC whisper delay', async () => {
        const { w, bot } = withTrainer();
        const times: number[] = [];
        const reply = w.handlers.whisper!;
        w.handlers.whisper = (a, world) => { times.push(Date.now()); reply(a, world); };
        expect((await bot.whisper('Graent', 'practice weapon')).success).toBeTrue();
        expect((await bot.whisper('Graent', 'training shield')).success).toBeTrue();
        expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1500);
    });

    test('navigateDialog picks keywords by RegExp', async () => {
        const { w, bot } = withTrainer();
        const r = await bot.navigateDialog('Graent', [/shield/]);
        expect(r.success).toBeTrue();
        expect(w.sentOf('whisper')[0]!.text).toBe('training shield');
        expect((await bot.navigateDialog('Graent', [/nothing/])).reason).toBe('keyword_not_found');
    });

    test('interact refusal and silence', async () => {
        const { w, bot } = world();
        w.handlers.interact = (_a, world) => { setTimeout(() => world.message('You are too far away to interact with the rat.'), 10); };
        expect(await bot.interactWith('rat')).toMatchObject({ success: false, reason: 'refused' });
        w.handlers.interact = () => {};
        expect(await bot.interactWith('rat', { timeout: 100 })).toMatchObject({ success: false, reason: 'no_response' });
    });

    test('respondToDialog answers the open box', async () => {
        const { w, bot } = world({ dialog: { isOpen: true, code: 5, data: [1, 0, 0, 0], type: 1, text: 'Bob has invited you to join\nhis group. Do you wish to join?', receivedAt: 1 } });
        w.handlers.respondDialog = (_a, world) => { world.state.dialog = { ...world.state.dialog!, isOpen: false }; };
        expect(await bot.respondToDialog(true)).toMatchObject({ success: true });
        expect((await bot.respondToDialog(true, { timeout: 50 })).reason).toBe('no_dialog');
    });
});

// ── Combat ──────────────────────────────────────────────────────────────────

/** Fight simulation: while attacking in range, the target loses `dmg`% per tick. */
function fightSim(w: FakeWorld, opts: { dmg?: number; xp?: number; drops?: boolean } = {}) {
    w.onTick = world => {
        const p = world.player;
        const id = p.targetObjectId;
        if (!p.attacking || id === null) return;
        const npc = world.npc(id);
        if (!npc) return;
        if (Math.hypot(npc.x - p.x, npc.y - p.y, npc.z - p.z) > 128) return;
        npc.healthPercent = Math.max(0, npc.healthPercent - (opts.dmg ?? 25));
        world.combat({ kind: 'melee', attackerObjectId: p.objectId, targetObjectId: id, result: 'hit', targetHealthPercent: npc.healthPercent });
        if (npc.healthPercent === 0) {
            world.removeNpc(id);
            world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: id, targetHealthPercent: 0 });
            world.message(`The ${npc.name} dies!`, { type: 'otherDeath' });
            setTimeout(() => {
                world.message(`You get ${opts.xp ?? 17} experience points. (2 camp bonus)`, { type: 'important' });
                world.player.experience += opts.xp ?? 17;
                world.player.money = { ...world.player.money, copper: world.player.money.copper + 3, totalCopper: world.player.money.totalCopper + 3 };
                world.message('You pick up 3 copper.');
            }, 20);
        }
    };
}

describe('killNpc', () => {
    test('approaches with the target z, fights and reports XP/money', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'spirit hound', level: 4, x: 560600, y: 511000, z: 2200 })] });
        fightSim(w);
        const r = await bot.killNpc('spirit hound');
        expect(r).toMatchObject({ success: true, killed: true, xpGained: 17, moneyGained: 3 });
        expect(w.sentOf('moveTo')[0]!.z).toBe(2200);
        expect(w.sentOf('setTarget').at(-1)!.objectId).toBe(201);
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
    });

    test('chases a target that moves away', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        fightSim(w, { dmg: 10 });
        let fled = false;
        const inner = w.onTick!;
        w.onTick = world => {
            const rat = world.npc(201);
            if (rat && !fled && rat.healthPercent <= 70) { fled = true; rat.x += 600; }
            inner(world);
        };
        const r = await bot.killNpc(201);
        expect(r.killed).toBeTrue();
        expect(w.sentOf('moveTo').length).toBeGreaterThanOrEqual(1);
    });

    test('surfaces refusals and death', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        w.handlers.attack = (a, world) => {
            if (a.type === 'attack' && a.on) setTimeout(() => world.message("You can't attack a friendly NPC!"), 10);
        };
        expect(await bot.killNpc('rat', { timeout: 2000 })).toMatchObject({ success: false, reason: 'refused' });

        const second = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        setTimeout(() => { second.w.player.isDead = true; second.w.player.deathCount = 1; }, 50);
        expect(await second.bot.killNpc('rat', { timeout: 2000 })).toMatchObject({ success: false, reason: 'died' });
    });

    test('rejects guards and townsfolk unless forced, and times out', async () => {
        const { w, bot } = world();
        expect((await bot.killNpc('Guard Edric')).reason).toBe('not_attackable');
        expect((await bot.killNpc('nobody')).reason).toBe('not_found');
        w.handlers.attack = () => {}; // attack never engages
        const r = await bot.killNpc('rat', { timeout: 150 });
        expect(r).toMatchObject({ success: false, reason: 'timeout', killed: false });
    });

    // "killNpc -> false not_attackable necroservant is not something we can kill (realm albion, role null, peaceful false)", while nukes and the pet hit it.
    test('an enemy realm\'s pet can be killed without force; our own realm\'s not; and it is no monster to go looking for', async () => {
        const pet = (realm: 'midgard' | 'albion') => makeNpc({ objectId: 700, name: 'necroservant', level: 5, isPet: true, realm, x: 560050, y: 511000, distance: 50, distance2d: 50 });
        const enemy = world({ nearbyNpcs: [pet('midgard')] });
        enemy.w.handlers.attack = () => {};
        expect((await enemy.bot.killNpc(700, { timeout: 150 })).reason).toBe('timeout');
        expect(enemy.bot.findKillableNpc()).toBeNull();
        const ours = world({ nearbyNpcs: [pet('albion')] });
        expect((await ours.bot.killNpc(700, { timeout: 150 })).reason).toBe('not_attackable');
    });

    test('an abort switches attack off and stops the chase', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        w.handlers.attack = (a, world) => {
            if (a.type !== 'attack') return;
            world.player.attacking = a.on;
            if (a.on) { const rat = world.npc(201)!; rat.x += 1000; world.stepSize = 5; } // flees: we keep chasing
        };
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('cancelled')), 150);
        await expect(executionContext.run({ signal: controller.signal }, () => bot.killNpc('rat'))).rejects.toThrow('cancelled');
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
        expect(w.player.attacking).toBeFalse();
        expect(w.state.movement.moving).toBeFalse();
    });

    test('a timeout before the AttackMode echo still switches attack off', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        // The server's AttackMode packet (the only source of player.attacking) trails the request.
        w.handlers.attack = (a, world) => { if (a.type === 'attack') setTimeout(() => { world.player.attacking = a.on; }, 150); };
        const r = await bot.killNpc('rat', { timeout: 80 });
        expect(r.reason).toBe('timeout');
        await Bun.sleep(400);
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
        expect(w.player.attacking).toBeFalse();
    });

    test('selects the target once per fight even when the model already shows it', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        w.player.targetObjectId = 201; // stale: the server dropped it on our death
        fightSim(w, { dmg: 50 });
        expect((await bot.killNpc('rat')).killed).toBeTrue();
        expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([201]);
    });

    test('uses styles while attacking', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000, healthPercent: 100 })] });
        fightSim(w, { dmg: 2 });
        const r = await bot.killNpc('rat', { styles: ['Backslash'], timeout: 5000 });
        expect(r.killed).toBeTrue();
        expect(r.stylesUsed).toBeGreaterThanOrEqual(1);
        expect(w.sentOf('useSkill')[0]!.skillIndex).toBe(7);
    });
});

describe('attack / findKillableNpc / con', () => {
    test('attack observes attack mode', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        const r = await bot.attack('rat');
        expect(r.success).toBeTrue();
        expect(w.player.attacking).toBeTrue();
    });

    test('attack with a bow in hand reads refused at once, not a timeout: the server only answers with a line (PlayerAttackRequestHandler.cs:12-18)', async () => {
        const line = "You can't enter melee combat mode with a ranged weapon!";
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
        w.handlers.attack = (_a, world) => { setTimeout(() => world.message(line, { type: 'youHit' }), 5); };
        const t0 = Date.now();
        expect(await bot.attack('rat', { timeout: 3000 })).toMatchObject({ success: false, reason: 'refused', message: line, npc: { objectId: 201 } });
        expect(Date.now() - t0).toBeLessThan(1500);
    });

    test('attack with no weapon, or a shield alone, is refused before any walk: the server says so only at the first swing (AttackComponent.cs:548)', async () => {
        const shield = { slot: 11, name: 'small shield', level: 1, count: 1, model: 3, objectType: 42, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 };
        for (const equipment of [[], [shield]]) {
            const { w, bot } = world({ equipment, nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 561300, y: 511000 })] });
            const r = await bot.attack(201);
            expect(r).toMatchObject({ success: false, reason: 'refused', npc: { objectId: 201 }, target: { objectId: 201 } });
            expect(r.message).toContain('no weapon');
            expect(w.sent).toEqual([]);
        }
    });

    test('findKillableNpc applies con, roles and engagement', async () => {
        const { w, bot } = world({
            player: makePlayer({ level: 5 }),
            nearbyNpcs: [
                makeNpc({ objectId: 1, name: 'grey rat', level: 1, distance: 50 }),
                makeNpc({ objectId: 2, name: 'green rat', level: 3, x: 560200 }),
                makeNpc({ objectId: 3, name: 'yellow rat', level: 5, x: 560100 }),
                makeNpc({ objectId: 4, name: 'red rat', level: 7, x: 560050 }),
                makeNpc({ objectId: 5, name: 'busy rat', level: 5, x: 560060, targetObjectId: 999, healthPercent: 80 }),
                makeNpc({ objectId: 6, name: 'Guard Edric', level: 5, realm: 'albion', role: 'guard', x: 560010 }),
            ],
        });
        w.publish();
        expect(bot.findKillableNpcs().map(n => n.name)).toEqual(['yellow rat', 'green rat']);
        expect(bot.findKillableNpc({ maxCon: -2 })?.name).toBe('green rat');
        expect(bot.findKillableNpc({ maxLevelDiff: 2, minLevelDiff: 2 })?.name).toBe('red rat');
        expect(bot.findKillableNpc({ pattern: /green/ })?.name).toBe('green rat');
        expect(bot.findKillableNpc({ exclude: [3] })?.name).toBe('green rat');
        expect(bot.findKillableNpcs({ includeEngaged: true }).map(n => n.name)).toContain('busy rat');
    });

    test('isInCombat and getAttackers', async () => {
        const { w, bot } = world();
        expect(bot.isInCombat()).toBeFalse();
        w.state.nearbyNpcs[0]!.targetObjectId = w.player.objectId;
        w.publish();
        expect(bot.isInCombat()).toBeTrue();
        expect(bot.getAttackers().map(n => n.objectId)).toEqual([200]);
    });

    describe('a mob that reports no target', () => {
        const mob = (objectId: number, over: Partial<NearbyNpc> = {}) => makeNpc({ objectId, name: 'dergan enchanter', level: 5, x: 561000, y: 511000, distance: 900, targetObjectId: null, inCombat: false, ...over });

        test('a caster whose spell landed on us counts, and so does a runner whose swing did', async () => {
            const { w, bot } = world({ nearbyNpcs: [mob(501), mob(502, { x: 560100, inCombat: true })] });
            const me = w.player.objectId;
            w.combat({ kind: 'spellEffect', attackerObjectId: 501, targetObjectId: me, effectId: 5208 });
            w.combat({ kind: 'melee', attackerObjectId: 502, targetObjectId: me, result: 'miss' });
            w.publish();
            expect(bot.getAttackers().map(n => n.objectId)).toEqual([502, 501]);
            expect(bot.isInCombat()).toBeTrue();
        });

        test('a hit too old, or on someone else, does not', async () => {
            const { w, bot } = world({ nearbyNpcs: [mob(501), mob(502)] });
            w.state.combatEvents.push({ id: 90, kind: 'spellEffect', attackerObjectId: 501, targetObjectId: w.player.objectId, receivedAt: w.state.timestamp - 7000 });
            w.combat({ kind: 'spellEffect', attackerObjectId: 502, targetObjectId: 999, effectId: 5208 });
            w.publish();
            expect(bot.getAttackers()).toEqual([]);
        });

        test('one that reads on our pet isn\'t on us for its DoT ticking on us: a tick has no 0x1B, and says where the spell landed some time ago (DoTSpellHandler.cs:169)', async () => {
            const PET = 600, SUMMON = 610;
            const { w, bot } = world({ nearbyNpcs: [mob(501, { targetObjectId: PET }), mob(502, { targetObjectId: SUMMON }), mob(503)], pet: { objectId: PET, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: 501 }, summons: [SUMMON] });
            const me = w.player.objectId;
            for (const id of [501, 502, 503]) w.combat({ kind: 'melee', attackerObjectId: id, targetObjectId: me, result: 'other', targetHealthPercent: 90 });
            w.publish();
            // The one with no reading at all is main's caster at range, and still counts.
            expect(bot.getAttackers().map(n => n.objectId)).toEqual([503]);
            expect(bot.getPetAttackers().map(n => n.objectId).sort()).toEqual([501, 502]);
        });

        test('hits from before a mob died are not from the next one with its id', async () => {
            const { w, bot } = world({ nearbyNpcs: [mob(501)] });
            const me = w.player.objectId;
            w.combat({ kind: 'spellEffect', attackerObjectId: 501, targetObjectId: me, effectId: 5208 });
            w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 501, targetHealthPercent: 0 });
            w.publish();
            expect(bot.getAttackers()).toEqual([]);
            w.combat({ kind: 'spellEffect', attackerObjectId: 501, targetObjectId: me, effectId: 5208 });
            w.publish();
            expect(bot.getAttackers().map(n => n.objectId)).toEqual([501]);
        });

        test('nor a cast that has not landed yet: its target is unknown', async () => {
            const { w, bot } = world({ nearbyNpcs: [mob(501)] });
            w.combat({ kind: 'spellCast', attackerObjectId: 501, targetObjectId: null, castTimeMs: 2000 });
            w.publish();
            expect(bot.getAttackers()).toEqual([]);
        });

        test('nobody we could not fight anyway: a realm NPC or a peaceful one casting on us, a pet, the dead', async () => {
            const { w, bot } = world({
                nearbyNpcs: [mob(501, { realm: 'albion' }), mob(502, { isPeaceful: true }), mob(503, { isPet: true }), mob(504, { isTargetable: false }), mob(505, { healthPercent: 0 })],
            });
            for (const id of [501, 502, 503, 504, 505]) w.combat({ kind: 'spellEffect', attackerObjectId: id, targetObjectId: w.player.objectId, effectId: 5208 });
            w.state.nearbyNpcs[4]!.targetObjectId = w.player.objectId;
            w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 505, targetHealthPercent: 0 });
            w.publish();
            expect(bot.getAttackers()).toEqual([]);
        });

        test('one at 0 % with no death seen is alive: a mob under 1 % reads that (GameLiving.cs:2621)', async () => {
            const { w, bot } = world({ nearbyNpcs: [mob(501, { healthPercent: 0 })] });
            w.combat({ kind: 'spellEffect', attackerObjectId: 501, targetObjectId: w.player.objectId, effectId: 5208 });
            w.publish();
            expect(bot.getAttackers().map(n => n.objectId)).toEqual([501]);
        });

        test('rest refuses while one hits us, and names one that hits us sitting', async () => {
            const { w, bot } = world({ player: makePlayer({ health: 50, healthPercent: 50 }), nearbyNpcs: [mob(501)] });
            setTimeout(() => w.combat({ kind: 'spellEffect', attackerObjectId: 501, targetObjectId: w.player.objectId, effectId: 5208 }), 60);
            const sitting = await bot.rest();
            expect(sitting.reason).toBe('attacked');
            expect(sitting.message).toContain('dergan enchanter');
            expect((await bot.rest()).reason).toBe('in_combat');
        });

        test('findKillableNpc still takes a hurt one that is hitting us, not one hurt by someone else', async () => {
            const { w, bot } = world({ nearbyNpcs: [mob(501, { healthPercent: 60, distance: 900 }), mob(502, { healthPercent: 60, distance: 100 })] });
            w.combat({ kind: 'spellEffect', attackerObjectId: 501, targetObjectId: w.player.objectId, effectId: 5208 });
            w.publish();
            expect(bot.findKillableNpcs().map(n => n.objectId)).toEqual([501]);
        });
    });
});

describe('castSpell', () => {
    const spell = { name: 'Minor Vitality Drain', level: 1, internalId: 651, lineName: 'Path of Ice', lineIndex: 1, spellIndex: 0, cooldownRemaining: 0 };
    const buff = { name: 'Ward Blow', level: 1, internalId: 501, lineName: 'Path of Earth', lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 };
    const skills = { specializations: [], abilities: [], styles: [], spells: [spell, buff] };

    test('observes start, completion and damage', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => {
                world.message('You begin casting a Minor Vitality Drain spell!', { type: 'spell' });
                world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 50 });
            }, 10);
            setTimeout(() => {
                world.message('You cast a Minor Vitality Drain spell!', { type: 'spell' });
                world.message('You hit the rat for 4 damage!', { type: 'youHit' });
            }, 70);
        };
        const r = await bot.castSpell('Vitality Drain', 'rat');
        expect(r).toMatchObject({ success: true, completed: true, damage: 4, castTimeMs: 50 });
        expect(w.sentOf('castSpell')[0]).toMatchObject({ lineIndex: 1, spellIndex: 0 });
        expect(w.player.targetObjectId).toBe(200);
    });

    test('maps refusals to reasons', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 10); };
        expect((await bot.castSpell(spell, 'rat')).reason).toBe('no_power');
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must wait 2 seconds to cast a spell!', { type: 'resisted' }), 10); };
        const wait = await bot.castSpell(spell, 'rat');
        expect(wait).toMatchObject({ reason: 'must_wait', retryAfterMs: 2000 });
        expect((await bot.castSpell('Fireball')).reason).toBe('spell_not_found');
        expect((await bot.castSpell({ ...spell, cooldownRemaining: 5 })).reason).toBe('cooldown');
    });

    test('selects the target even when the model already shows it (server cleared it on death)', async () => {
        const { w, bot } = world({ skills });
        // After a death and a same-region release the model still holds the old target; the server does not
        // (GamePlayer.cs:5743 sets TargetObject = null without a ChangeTarget).
        w.player.targetObjectId = 200;
        let serverTarget: number | null = null;
        w.handlers.setTarget = (a, world) => { if (a.type === 'setTarget') { serverTarget = a.objectId; world.player.targetObjectId = a.objectId; } };
        w.handlers.castSpell = (_a, world) => {
            if (serverTarget === null) { setTimeout(() => world.message('You must select a target for this spell!', { type: 'system' }), 10); return; }
            setTimeout(() => world.message('You cast a Minor Vitality Drain spell!', { type: 'spell' }), 10);
        };
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ success: true, completed: true });
        expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([200]);
        // Without an explicit target, the current target is re-selected too.
        serverTarget = null;
        expect((await bot.castSpell(spell)).success).toBeTrue();
        expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([200, 200]);
    });

    test('re-selects the target and retries once on "You must select a target"', async () => {
        const { w, bot } = world({ skills });
        let casts = 0;
        w.handlers.castSpell = (_a, world) => {
            casts++;
            const text = casts === 1 ? 'You must select a target for this spell!' : 'You cast a Minor Vitality Drain spell!';
            setTimeout(() => world.message(text, { type: 'spell' }), 10);
        };
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ success: true });
        expect(casts).toBe(2);
        expect(w.sentOf('setTarget')).toHaveLength(2);
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must select a target for this spell!', { type: 'spell' }), 10); };
        expect((await bot.castSpell(spell, 'rat')).reason).toBe('no_target');
    });

    test('does not retry "You must select a target" once the cast began and the target died', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => {
                world.message('You begin casting a Minor Vitality Drain spell!', { type: 'spell' });
                world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 1000 });
            }, 10);
            setTimeout(() => {
                world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 200, targetHealthPercent: 0 });
                world.message('You must select a target for this spell!', { type: 'spell' });
            }, 60);
        };
        // Their one snapshot reads as the death, which is no failure in a group (S8).
        const r = await bot.castSpell(spell, 'rat');
        expect(r).toMatchObject({ success: false, reason: 'already_dead', targetDied: true, castTimeMs: 1000 });
        expect(w.sentOf('castSpell')).toHaveLength(1);
        expect(w.sentOf('setTarget')).toHaveLength(1);
    });

    test('does not retry a refusal before the cast when the ID died or holds another object', async () => {
        const { w, bot } = world({ skills });
        const refuse = (world: FakeWorld, change: (world: FakeWorld) => void): void => {
            setTimeout(() => {
                change(world);
                world.message('You must select a target for this spell!', { type: 'spell' });
            }, 10);
        };
        // The rat died after we selected it.
        w.handlers.castSpell = (_a, world) => refuse(world, wd => wd.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 200, targetHealthPercent: 0 }));
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ reason: 'already_dead', targetDied: true, castTimeMs: null });
        expect(w.sentOf('castSpell')).toHaveLength(1);
        // Its ID went to a new spawn (the death event was missed).
        w.handlers.castSpell = (_a, world) => refuse(world, wd => { wd.state.nearbyNpcs = wd.state.nearbyNpcs.map(n => n.objectId === 200 ? { ...n, name: 'wolf' } : n); });
        expect((await bot.castSpell(spell, 'rat')).reason).toBe('no_target');
        expect(w.sentOf('castSpell')).toHaveLength(2);
        // The ID is gone from the world.
        w.state.nearbyNpcs = [makeNpc({ objectId: 201, name: 'rat' })];
        w.publish();
        w.handlers.castSpell = (_a, world) => refuse(world, wd => wd.removeNpc(201));
        expect((await bot.castSpell(spell, 'rat')).message).toEndWith(' (target gone, not retried)');
        expect(w.sentOf('castSpell')).toHaveLength(3);
        expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([200, 200, 201]);
    });

    test('retryNoTarget false never retries', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must select a target for this spell!', { type: 'spell' }), 10); };
        const r = await bot.castSpell(spell, 'rat', { retryNoTarget: false });
        expect(r).toMatchObject({ success: false, reason: 'no_target', message: 'You must select a target for this spell!' });
        expect(w.sentOf('castSpell')).toHaveLength(1);
        expect(w.sentOf('setTarget')).toHaveLength(1);
    });

    test('a foreign DoT tick or damage-shield hit mid-cast is not completion', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => {
                world.message('You begin casting a Minor Vitality Drain spell!', { type: 'spell' });
                world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 1000 });
            }, 10);
            // A running DoT ticks (DoTSpellHandler.cs:87) and a damage shield answers a melee hit (Spells.txt:93).
            setTimeout(() => world.message('Your Poison Cloud hits the rat for 12 damage!', { type: 'spell' }), 200);
            setTimeout(() => world.message('You hit the rat for 3 damage!', { type: 'youHit' }), 250);
            setTimeout(() => world.message('The rat attacks you and your spell is interrupted!', { type: 'spell' }), 500);
        };
        const r = await bot.castSpell(spell, 'rat');
        expect(r).toMatchObject({ success: false, reason: 'interrupted', completed: false, damage: 0 });

        // The same noise before a cast that lands: only the spell's own damage counts.
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 400 }), 10);
            setTimeout(() => world.message('Your Poison Cloud hits the rat for 12 damage!', { type: 'spell' }), 100);
            setTimeout(() => {
                world.message('You cast a Minor Vitality Drain spell!', { type: 'spell' });
                world.message('You hit the rat for 4 damage!', { type: 'youHit' });
                world.message('Your Poison Cloud hits the rat for 12 damage!', { type: 'spell' });
            }, 420);
        };
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ success: true, completed: true, damage: 4 });
    });

    test('dying mid-cast reports died', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 2000 }), 10);
            setTimeout(() => { world.player.isDead = true; world.player.deathCount++; world.player.healthPercent = 0; }, 100);
        };
        const r = await bot.castSpell(spell, 'rat');
        expect(r).toMatchObject({ success: false, reason: 'died' });
        expect(r.retryAfterMs).toBeUndefined();
        expect(castFailureReason("You are dead and can't cast!")).toBe('died');
    });

    test('self buffs do not walk to the target', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Ward Blow spell!', { type: 'spell' }), 10); };
        const r = await bot.castSpell('Ward Blow', 'sewer rat');
        expect(r.success).toBeTrue();
        expect(w.sentOf('moveTo')).toHaveLength(0);
    });

    describe('an Enemy spell at what it can never hit: refused before any walk, send or selection', () => {
        const heal = { name: 'Minor Rejuvenation', level: 1, internalId: 1301, lineName: 'Rejuvenation', lineIndex: 2, spellIndex: 0, cooldownRemaining: 0 };
        const healer = { specializations: [], abilities: [], styles: [], spells: [spell, heal] };
        const npc = (o: Partial<NearbyNpc> = {}) => makeNpc({ objectId: 300, name: 'Sister Gwendolyn', x: 563000, ...o });
        const friend = (o: Partial<NearbyPlayer> = {}) => makePlayerObj({ objectId: 400, name: 'Pettan', x: 563000, ...o });

        test('our own id reads no_target, in the same words given or selected', async () => {
            const message = 'Minor Vitality Drain needs an enemy, and that is us';
            const { w, bot } = world({ skills });
            const r = await bot.castSpell(spell, 100);
            expect(r).toMatchObject({ success: false, reason: 'no_target', message, spell: { name: spell.name } });
            expect(w.sent).toEqual([]);
            expect(await bot.castSpell(spell, makePlayerObj({ objectId: 100 }))).toMatchObject({ reason: 'no_target', message });
            expect(w.sent).toEqual([]);
            const selected = world({ skills, player: makePlayer({ targetObjectId: 100 }) });
            expect(await selected.bot.castSpell(spell)).toMatchObject({ success: false, reason: 'no_target', message });
            expect(selected.w.sent).toEqual([]);
        });

        test('a heal on our own id still lands on us', async () => {
            const { w, bot } = world({ skills: healer });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${heal.name} spell!`, { type: 'spell' }), 5); };
            expect(await bot.castSpell(heal, 100)).toMatchObject({ success: true });
        });

        test.each([['a peace flag', { isPeaceful: true }, 'peaceful'], ['no target flag', { isTargetable: false }, 'not targetable']])('%s: not_attackable at once, our target unmoved, the words petAttack has (AbstractServerRules.cs:383-384)', async (_what, flags, why) => {
            const { w, bot } = world({ skills, nearbyNpcs: [npc(flags as Partial<NearbyNpc>)], player: makePlayer({ targetObjectId: 200 }) });
            const t0 = Date.now();
            const r = await bot.castSpell(spell, 300);
            expect(r).toMatchObject({ success: false, reason: 'not_attackable', message: `Sister Gwendolyn can't be attacked (${why})`, target: { objectId: 300 } });
            expect(Date.now() - t0).toBeLessThan(1000); // the server's silence would take 3 s
            expect(w.sent).toEqual([]);
            expect(w.player.targetObjectId).toBe(200);
        });

        test('the selection counts too', async () => {
            const peace = world({ skills, nearbyNpcs: [npc({ isPeaceful: true })], player: makePlayer({ targetObjectId: 300 }) });
            expect(await peace.bot.castSpell(spell)).toMatchObject({ success: false, reason: 'not_attackable' });
            expect(peace.w.sent).toEqual([]);
            const mate = world({ skills, nearbyPlayers: [friend()], player: makePlayer({ targetObjectId: 400 }) });
            expect(await mate.bot.castSpell(spell)).toMatchObject({ success: false, reason: 'invalid_target', target: { objectId: 400 } });
            expect(mate.w.sent).toEqual([]);
        });

        test('an NPC or a player of our realm, however far: invalid_target, no walk, the mirror of a heal on an enemy', async () => {
            const { w, bot } = world({ skills, nearbyNpcs: [npc({ realm: 'albion' })], nearbyPlayers: [friend()] });
            expect(await bot.castSpell(spell, 300)).toMatchObject({ success: false, reason: 'invalid_target', target: { objectId: 300 } });
            expect(await bot.castSpell(spell, 400)).toMatchObject({ success: false, reason: 'invalid_target', target: { objectId: 400 } });
            expect(w.sent).toEqual([]);
        });

        test('our own pet reads our realm', async () => {
            const { w, bot } = world({ skills, pet: { objectId: 300, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null }, nearbyNpcs: [npc({ realm: 'albion', isPet: true, x: 560100 })] });
            expect(await bot.castSpell(spell, 300)).toMatchObject({ success: false, reason: 'invalid_target' });
            expect(w.sent).toEqual([]);
        });

        describe('range 0: it goes off around us, and the server looks at no selection (SpellHandler.cs:682-686, :918, :1591)', () => {
            const wave = { name: 'Gloom Wave', level: 1, internalId: 2611, lineName: 'Spirit Dimming', lineIndex: 2, spellIndex: 0, cooldownRemaining: 0 };
            const caster = { specializations: [], abilities: [], styles: [], spells: [wave] };
            const goesOff = (w: FakeWorld) => { w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${wave.name} spell!`, { type: 'spell' }), 5); }; };
            const ownPet = { objectId: 300, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null } as PetState;

            test.each<[string, number, Partial<BotWorldState>]>([
                ['ourselves', 100, {}],
                ['our own pet', 300, { pet: ownPet, nearbyNpcs: [npc({ realm: 'albion', isPet: true })] }],
                ['a groupmate', 400, { nearbyPlayers: [friend()] }],
                ['a peace-flag NPC', 300, { nearbyNpcs: [npc({ isPeaceful: true })] }],
                ['an untargetable NPC', 300, { nearbyNpcs: [npc({ isTargetable: false })] }],
                ['an NPC of our realm', 300, { nearbyNpcs: [npc({ realm: 'albion' })] }],
                ['a dead enemy, who leaves no 0xA2', 401, { nearbyPlayers: [makePlayerObj({ objectId: 401, realm: 'midgard', isDead: true, x: 563000 })] }],
            ])('no target given, with %s selected: cast, with no walk and the selection unmoved', async (_what, selected, o) => {
                const { w, bot } = world({ skills: caster, player: makePlayer({ targetObjectId: selected }), ...o });
                goesOff(w);
                expect(await bot.castSpell(wave)).toMatchObject({ success: true, target: null });
                expect(w.sentOf('castSpell')).toHaveLength(1);
                expect(w.sentOf('setTarget')).toEqual([]);
                expect(w.sentOf('moveTo')).toEqual([]);
                expect(w.player.targetObjectId).toBe(selected);
            });

            test('with a mob selected it reads as a cast at that mob, as ever', async () => {
                const { w, bot } = world({ skills: caster, nearbyNpcs: [npc({ x: 560100 })], player: makePlayer({ targetObjectId: 300 }) });
                goesOff(w);
                expect(await bot.castSpell(wave)).toMatchObject({ success: true, target: { objectId: 300 } });
            });

            test('a target given is still judged: the caller meant that one', async () => {
                const { w, bot } = world({ skills: caster, nearbyPlayers: [friend()], nearbyNpcs: [npc({ isPeaceful: true })] });
                expect(await bot.castSpell(wave, 100)).toMatchObject({ success: false, reason: 'no_target' });
                expect(await bot.castSpell(wave, 400)).toMatchObject({ success: false, reason: 'invalid_target' });
                expect(await bot.castSpell(wave, 300)).toMatchObject({ success: false, reason: 'not_attackable' });
                expect(w.sent).toEqual([]);
            });
        });

        test('what can be hit still goes: a mob, an NPC of another realm, a player of another realm', async () => {
            for (const made of [
                world({ skills, nearbyNpcs: [npc({ x: 560100 })] }),
                world({ skills, nearbyNpcs: [npc({ x: 560100, realm: 'midgard' })] }),
                world({ skills, nearbyPlayers: [makePlayerObj({ objectId: 300, realm: 'midgard', x: 560100 })] }),
            ]) {
                made.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${spell.name} spell!`, { type: 'spell' }), 5); };
                expect(await made.bot.castSpell(spell, 300)).toMatchObject({ success: true });
                expect(made.w.sentOf('setTarget').map(a => a.objectId)).toEqual([300]);
            }
        });

        test('a heal on a friend is none of this', async () => {
            const { w, bot } = world({ skills: healer, nearbyNpcs: [], nearbyPlayers: [friend({ x: 560100 })] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${heal.name} spell!`, { type: 'spell' }), 5); };
            expect(await bot.castSpell(heal, 400)).toMatchObject({ success: true });
        });
    });

    describe('a dead target (SpellHandler.cs:783)', () => {
        const heal = { name: 'Minor Rejuvenation', level: 1, internalId: 1301, lineName: 'Rejuvenation', lineIndex: 2, spellIndex: 0, cooldownRemaining: 0 };
        const revive = { name: 'Revive', level: 1, internalId: 1041, lineName: 'Rejuvenation', lineIndex: 2, spellIndex: 1, cooldownRemaining: 0 };
        const healer = { specializations: [], abilities: [], styles: [], spells: [spell, heal, revive] };
        const corpse = (o: Partial<NearbyPlayer> = {}) => makePlayerObj({ objectId: 400, name: 'Pettan', x: 560100, ...o });

        test('the server\'s line ends the cast at once with already_dead', async () => {
            const { w, bot } = world({ skills: healer, nearbyPlayers: [corpse()] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('Pettan is dead!', { type: 'resisted' }), 5); };
            const t0 = Date.now();
            expect(await bot.castSpell(heal, 400)).toMatchObject({ success: false, reason: 'already_dead', message: 'Pettan is dead!', target: { objectId: 400 } });
            expect(Date.now() - t0).toBeLessThan(1000); // 3 s of no_response before
        });

        test('at a mob, with its article, whatever it is called', async () => {
            const { w, bot } = world({ skills, nearbyNpcs: [makeNpc({ objectId: 300, name: 'power wraith', x: 560100 })] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The power wraith is dead!', { type: 'resisted' }), 5); };
            expect(await bot.castSpell(spell, 300)).toMatchObject({ success: false, reason: 'already_dead' });
            expect(castFailureReason('The power wraith is dead!')).toBe('already_dead');
        });

        test('a line about another, a pet\'s cast relayed to us (SpellHandler.cs:2450-2455), doesn\'t end ours', async () => {
            const { w, bot } = world({ skills, nearbyNpcs: [makeNpc({ objectId: 300, name: 'young wolf', x: 560100 })] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.message('The rat is dead!', { type: 'resisted' }), 5);
                setTimeout(() => world.message(`You cast a ${spell.name} spell!`, { type: 'spell' }), 30);
            };
            expect(await bot.castSpell(spell, 300)).toMatchObject({ success: true });
        });

        test('a player the model knows is dead: at once, nothing sent', async () => {
            const { w, bot } = world({ skills: healer, nearbyPlayers: [corpse({ isDead: true, x: 563000 })] });
            expect(await bot.castSpell(heal, 400)).toMatchObject({ success: false, reason: 'already_dead', target: { objectId: 400 } });
            expect(w.sent).toEqual([]);
        });

        describe('a Corpse spell works only on the dead of our realm (SpellHandler.cs:759-766)', () => {
            const LINE = 'This spell only works on dead members of your realm!';
            const raises = (w: FakeWorld) => { w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${revive.name} spell!`, { type: 'spell' }), 5); }; };
            const refused = { success: false, reason: 'invalid_target', message: LINE, spell: { name: revive.name } };
            const far = { x: 563000 };

            test('a living player the model holds: at once, no walk, whether given or selected', async () => {
                const given = world({ skills: healer, nearbyPlayers: [corpse(far)] });
                expect(await given.bot.castSpell(revive, 400)).toMatchObject({ ...refused, target: { objectId: 400 } });
                expect(given.w.sent).toEqual([]);
                const selected = world({ skills: healer, nearbyPlayers: [corpse(far)], player: makePlayer({ targetObjectId: 400 }) });
                expect(await selected.bot.castSpell(revive)).toMatchObject({ ...refused, target: { objectId: 400 } });
                expect(selected.w.sent).toEqual([]);
            });

            test('any NPC: at once, no walk, whether given or selected', async () => {
                const rat = makeNpc({ objectId: 300, name: 'rat', ...far });
                const given = world({ skills: healer, nearbyNpcs: [rat] });
                expect(await given.bot.castSpell(revive, 300)).toMatchObject({ ...refused, target: { objectId: 300 } });
                expect(given.w.sent).toEqual([]);
                const selected = world({ skills: healer, nearbyNpcs: [rat], player: makePlayer({ targetObjectId: 300 }) });
                expect(await selected.bot.castSpell(revive)).toMatchObject({ ...refused, target: { objectId: 300 } });
                expect(selected.w.sent).toEqual([]);
            });

            test('our own id: we are alive, or castSpell had said so; given or selected', async () => {
                const given = world({ skills: healer });
                expect(await given.bot.castSpell(revive, 100)).toMatchObject(refused);
                expect(await given.bot.castSpell(revive, makePlayerObj({ objectId: 100 }))).toMatchObject(refused);
                expect(given.w.sent).toEqual([]);
                const selected = world({ skills: healer, player: makePlayer({ targetObjectId: 100 }) });
                expect(await selected.bot.castSpell(revive)).toMatchObject(refused);
                expect(selected.w.sent).toEqual([]);
            });

            test('a corpse the model knows goes, walk and all', async () => {
                const { w, bot } = world({ skills: healer, nearbyPlayers: [corpse({ isDead: true, healthPercent: 0, x: 562000 })] });
                raises(w);
                expect(await bot.castSpell(revive, 400)).toMatchObject({ success: true, target: { objectId: 400 } });
                expect(w.sentOf('moveTo').length).toBeGreaterThanOrEqual(1);
            });

            test('a snapshot is judged by the entry the model holds now: a stale one neither refuses a corpse nor passes the living', async () => {
                const dead = world({ skills: healer, nearbyPlayers: [corpse({ isDead: true, healthPercent: 0 })] });
                raises(dead.w);
                expect(await dead.bot.castSpell(revive, corpse({ isDead: false, healthPercent: 90 }))).toMatchObject({ success: true });
                const alive = world({ skills: healer, nearbyPlayers: [corpse()] });
                expect(await alive.bot.castSpell(revive, corpse({ isDead: true, healthPercent: 0 }))).toMatchObject(refused);
                expect(alive.w.sent).toEqual([]);
            });

            test('a player at 0 % with no word of a death isn\'t known to be alive: the server decides', async () => {
                const { w, bot } = world({ skills: healer, nearbyPlayers: [corpse({ isDead: false, healthPercent: 0 })] });
                raises(w);
                expect(await bot.castSpell(revive, 400)).toMatchObject({ success: true });
            });

            test('what the model hasn\'t seen, a rez that beat ours say: the server\'s line ends the cast at once, with the same reason', async () => {
                const { w, bot } = world({ skills: healer, nearbyPlayers: [corpse({ isDead: true, healthPercent: 0 })] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(LINE, { type: 'resisted' }), 5); };
                const t0 = Date.now();
                expect(await bot.castSpell(revive, 400)).toMatchObject(refused);
                expect(Date.now() - t0).toBeLessThan(1000); // 3 s of no_response before
                expect(castFailureReason(LINE)).toBe('invalid_target');
            });

            test('an enemy-realm corpse isn\'t among the checks: the server answers for it', async () => {
                const { w, bot } = world({ skills: healer, nearbyPlayers: [corpse({ realm: 'midgard', isDead: true, healthPercent: 0 })] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(LINE, { type: 'resisted' }), 5); };
                expect(await bot.castSpell(revive, 400)).toMatchObject({ success: false, reason: 'invalid_target', message: LINE });
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });
        });

        describe('a Group spell has no dead check: it lands on the living, with the corpse named or not (SpellHandler.cs:640-686, HealSpellHandler.cs:76-78)', () => {
            const group = { name: 'Angelic Commendation', level: 1, internalId: 1321, lineName: 'Rejuvenation', lineIndex: 2, spellIndex: 2, cooldownRemaining: 0 };
            const groupHealer = { specializations: [], abilities: [], styles: [], spells: [group] };

            test('its message names nobody: what is selected isn\'t where it lands (the caster and the group, SpellHandler.cs:1747-1761). `target` is only that selection', async () => {
                const { w, bot } = world({ skills: groupHealer, nearbyPlayers: [corpse({ isDead: true })] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${group.name} spell!`, { type: 'spell' }), 5); };
                expect(await bot.castSpell(group, 400)).toMatchObject({ success: true, message: `Cast ${group.name}`, target: { objectId: 400 } });
            });

            test('a player the model knows is dead: cast', async () => {
                const { w, bot } = world({ skills: groupHealer, nearbyPlayers: [corpse({ isDead: true })] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${group.name} spell!`, { type: 'spell' }), 5); };
                expect(await bot.castSpell(group, 400)).toMatchObject({ success: true, target: { objectId: 400 } });
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });

            test('the line about that member ends nothing: it goes per member, as the cast lands', async () => {
                const { w, bot } = world({ skills: groupHealer, nearbyPlayers: [corpse()] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => world.message('Pettan is dead!', { type: 'resisted' }), 5);
                    setTimeout(() => world.message(`You cast a ${group.name} spell!`, { type: 'spell' }), 20);
                };
                expect(await bot.castSpell(group, 400)).toMatchObject({ success: true });
            });

            test('nor beside the "You cast" in one snapshot', async () => {
                const { w, bot } = world({ skills: groupHealer, nearbyPlayers: [corpse()] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => {
                        world.message(`You cast a ${group.name} spell!`, { type: 'spell' });
                        world.message('Pettan is dead!', { type: 'resisted' });
                    }, 5);
                };
                expect(await bot.castSpell(group, 400)).toMatchObject({ success: true });
            });
        });

        test('a spell for the dead goes on', async () => {
            const { w, bot } = world({ skills: healer, nearbyPlayers: [corpse({ isDead: true })] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${revive.name} spell!`, { type: 'spell' }), 5); };
            expect(await bot.castSpell(revive, 400)).toMatchObject({ success: true });
        });

        test('an NPC at 0 % is not dead: the percent is truncated (GameLiving.cs:2621)', async () => {
            const { w, bot } = world({ skills, nearbyNpcs: [makeNpc({ objectId: 300, name: 'young wolf', healthPercent: 0, x: 560100 })] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${spell.name} spell!`, { type: 'spell' }), 5); };
            expect(await bot.castSpell(spell, 300)).toMatchObject({ success: true });
        });
    });

    test('castTimeMs is read again as the cast ends: the 0x72 can come after the line that told us it began', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => world.message('You begin casting a Minor Vitality Drain spell!', { type: 'spell' }), 5);
            setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 2500 }), 60);
            setTimeout(() => world.message('You cast a Minor Vitality Drain spell!', { type: 'spell' }), 120);
        };
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ success: true, castTimeMs: 2500 });
    });

    test('castTimeMs is read again after a completion seen at once', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => world.message('You cast a Minor Vitality Drain spell!', { type: 'spell' }), 5);
            setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 2500 }), 60);
        };
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ success: true, castTimeMs: 2500 });
    });

    test('castTimeMs is read again for a refusal at the end of the cast too', async () => {
        const { w, bot } = world({ skills });
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => world.message('You begin casting a Minor Vitality Drain spell!', { type: 'spell' }), 5);
            setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 2500 }), 60);
            setTimeout(() => world.message('That target is too far away!', { type: 'resisted' }), 120);
        };
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ success: false, reason: 'out_of_range', castTimeMs: 2500 });
    });
});

// ── Resurrection ────────────────────────────────────────────────────────────

describe('resurrection', () => {
    // Revive 1315: a baseline Cleric rez in the spell data.
    const makeSpell = (s: Pick<Spell, 'name' | 'level' | 'internalId' | 'spellIndex'>): Spell => ({ lineName: 'Rejuvenation', lineIndex: 0, cooldownRemaining: 0, ...s });
    const revive = makeSpell({ name: 'Revive', level: 10, internalId: 1315, spellIndex: 3 });
    const skills = () => ({ ...makeState().skills, spells: [revive] });
    const corpse = (over: Partial<NearbyPlayer> = {}) => makePlayerObj({ objectId: 301, name: 'Tank', level: 20, isDead: true, healthPercent: 0, distance: 300, distance2d: 300, ...over });
    const scene = (over: Partial<NearbyPlayer> = {}, player: Partial<PlayerState> = {}) =>
        world({ skills: skills(), nearbyPlayers: [corpse(over)], player: makePlayer({ level: 20, mana: 1000, maxMana: 1000, ...player }) });
    const finishes = (w: FakeWorld) => {
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Revive spell!', { type: 'spell' }), 10); };
    };

    test('resurrectCost: half at equal level, by the level gap, never under a tenth (ResurrectSpellHandler.cs:68)', () => {
        expect(resurrectCost(1000, 20, 20)).toBe(500);
        expect(resurrectCost(1000, 20, 25)).toBe(750);
        expect(resurrectCost(1000, 20, 5)).toBe(100);
        expect(resurrectCost(1000, 20, 1)).toBe(100);
    });

    test('resurrectSpell knows a rez by its type, and takes the strongest', () => {
        const { bot } = world({ skills: skills() });
        expect(bot.resurrectSpell()?.name).toBe('Revive');
        const raise = makeSpell({ name: 'Raise Fallen', level: 15, internalId: 1361, spellIndex: 4 });
        const both = world({ skills: { ...skills(), spells: [revive, raise] } });
        expect(both.bot.resurrectSpell()?.name).toBe('Raise Fallen');
        expect(world().bot.resurrectSpell()).toBeNull();
    });

    test('success: the target shows health again', async () => {
        const { w, bot } = scene();
        finishes(w);
        w.onTick = world => {
            if (world.sentOf('castSpell').length) { const c = world.state.nearbyPlayers[0]!; c.isDead = false; c.healthPercent = 10; c.x = world.player.x; c.y = world.player.y; }
        };
        const r = await bot.resurrect(301);
        expect(r).toMatchObject({ success: true, cast: { success: true } });
        expect(w.sentOf('setTarget')[0]).toMatchObject({ objectId: 301 });
    });

    test('a release in view is no success: alive, but at its bind point', async () => {
        const { w, bot } = scene();
        finishes(w);
        w.onTick = world => {
            if (world.sentOf('castSpell').length) { const c = world.state.nearbyPlayers[0]!; c.isDead = false; c.healthPercent = 100; c.x = world.player.x + 4000; }
        };
        expect(await bot.resurrect(301, { answerMs: 80 })).toMatchObject({ success: false, reason: 'not_dead' });
    });

    test('another corpse\'s yes tells nothing about this one: the realm points name nobody (:201)', async () => {
        const { w, bot } = scene();
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => world.message('You cast a Revive spell!', { type: 'spell' }), 10);
            setTimeout(() => world.message('The player you resurrected was not worth realm points on death.'), 30);
        };
        expect(await bot.resurrect(301, { answerMs: 80 })).toMatchObject({ success: false, reason: 'no_answer' });
    });

    test('a finished cast with no answer is no success', async () => {
        const { w, bot } = scene();
        finishes(w);
        expect(await bot.resurrect(301, { answerMs: 50 })).toMatchObject({ success: false, reason: 'no_answer', cast: { success: true } });
    });

    test('refuses without casting: not dead, another realm, no spell, unknown target, too little power', async () => {
        const check = async (made: ReturnType<typeof scene>, reason: string, target: number = 301) => {
            expect(await made.bot.resurrect(target)).toMatchObject({ success: false, reason });
            expect(made.w.sentOf('castSpell')).toHaveLength(0);
        };
        await check(scene({ isDead: false, healthPercent: 50 }), 'not_dead');
        await check(scene({ realm: 'midgard' }), 'invalid_target');
        await check(world({ nearbyPlayers: [corpse()] }), 'spell_not_found');
        await check(scene(), 'not_found', 999);
        await check(scene({}, { mana: 400 }), 'no_power');
        await check(scene({}, { isDead: true }), 'dead');
    });

    test('the cost follows the target\'s level', async () => {
        const low = scene({ level: 5 }, { mana: 400 });
        finishes(low.w);
        expect(await low.bot.resurrect(301, { answerMs: 20 })).toMatchObject({ reason: 'no_answer' });
    });

    test.each([
        ['This spell only works on dead members of your realm!', 'not_dead'],
        ['Your target is already considering a resurrection!', 'already_considering'],
    ])('the server\'s refusal: %s', async (text, reason) => {
        const { w, bot } = scene();
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(text), 10); };
        expect(await bot.resurrect(301)).toMatchObject({ success: false, reason });
    });

    const offered = { isOpen: true, code: 6, data: [7, 1, 0, 0] as [number, number, number, number], type: 1, text: 'Do you allow Nimue to resurrected you\n with 30 percent hits/power?', receivedAt: 1, resurrection: { caster: 'Nimue', healthPercent: 30 } };
    const dead = () => makePlayer({ isDead: true, healthPercent: 0 });

    test('getResurrectionOffer reads the open box only', () => {
        expect(world({ dialog: offered }).sdk.getResurrectionOffer()).toEqual({ caster: 'Nimue', healthPercent: 30 });
        expect(world({ dialog: { ...offered, isOpen: false } }).sdk.getResurrectionOffer()).toBeNull();
        expect(world({ dialog: { ...offered, resurrection: undefined } }).sdk.getResurrectionOffer()).toBeNull();
    });

    test('acceptResurrection says yes and sees the revive', async () => {
        const { w, bot } = world({ dialog: offered, player: dead() });
        w.handlers.respondDialog = (_a, world) => {
            world.state.dialog = { ...world.state.dialog!, isOpen: false };
            setTimeout(() => { world.player.isDead = false; world.player.x += 400; }, 10);
        };
        expect(await bot.acceptResurrection()).toMatchObject({ success: true, offer: { caster: 'Nimue' } });
        expect(w.sentOf('respondDialog')[0]).toMatchObject({ accept: true });
    });

    test('acceptResurrection waits for an offer, and gives up', async () => {
        const later = world({ player: dead() });
        later.w.handlers.respondDialog = (_a, world) => { setTimeout(() => { world.player.isDead = false; }, 10); };
        setTimeout(() => { later.w.state.dialog = offered; }, 30);
        expect(await later.bot.acceptResurrection({ timeout: 2000 })).toMatchObject({ success: true });
        const none = world({ player: dead() });
        expect(await none.bot.acceptResurrection({ timeout: 20 })).toMatchObject({ success: false, reason: 'timeout' });
    });

    test('acceptResurrection: alive, or the offer gone', async () => {
        expect(await world({ dialog: offered }).bot.acceptResurrection()).toMatchObject({ success: false, reason: 'not_dead' });
        const { w, bot } = world({ dialog: offered, player: dead() });
        w.handlers.respondDialog = (_a, world) => { setTimeout(() => world.message('No one is currently trying to resurrect you.'), 10); };
        expect(await bot.acceptResurrection()).toMatchObject({ success: false, reason: 'expired' });
    });

    test('another box is not taken for an offer', async () => {
        const { w, bot } = world({ dialog: { ...offered, resurrection: undefined, text: 'Do you accept?' }, player: dead() });
        expect(await bot.acceptResurrection({ timeout: 20 })).toMatchObject({ success: false, reason: 'timeout' });
        expect(w.sentOf('respondDialog')).toHaveLength(0);
    });
});

// ── Enemy players ───────────────────────────────────────────────────────────

/** An enemy (Midgard) player next to us; we are Albion. */
const enemy = (overrides: Partial<NearbyPlayer> = {}) =>
    makePlayerObj({ objectId: 301, name: 'Norseman', realm: 'midgard', x: 560050, y: 511000, distance: 50, distance2d: 50, ...overrides });

/**
 * Our swings take `dmg` % off the targeted player in melee range. At 0 the server's 0xAE marks it
 * dead and sends the death to everyone in view; its body stays (GamePlayer.cs:5901-5905).
 */
function playerFightSim(w: FakeWorld, opts: { dmg?: number; rp?: number } = {}) {
    w.onTick = world => {
        const p = world.player;
        const id = p.targetObjectId;
        if (!p.attacking || id === null) return;
        const pl = world.state.nearbyPlayers.find(o => o.objectId === id);
        if (!pl || pl.isDead || Math.hypot(pl.x - p.x, pl.y - p.y, pl.z - p.z) > 128) return;
        pl.healthPercent = Math.max(0, pl.healthPercent - (opts.dmg ?? 25));
        world.combat({ kind: 'melee', attackerObjectId: p.objectId, targetObjectId: id, result: 'hit', targetHealthPercent: pl.healthPercent });
        if (pl.healthPercent === 0) {
            pl.isDead = true;
            p.realmPoints += opts.rp ?? 0;
            world.combat({ kind: 'death', attackerObjectId: p.objectId, targetObjectId: id });
        }
    };
}

const IMMUNE_OURS = "You can't attack players until your PvP invulnerability timer wears off!";

describe('killPlayer', () => {
    test('approaches with its z, fights to the death and reports realm points', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy({ x: 560600, z: 2200 })] });
        playerFightSim(w, { rp: 120 });
        const r = await bot.killPlayer(301);
        expect(r).toMatchObject({ success: true, killed: true, rpGained: 120, player: { objectId: 301, name: 'Norseman' } });
        expect(r.message).toContain('+120 rp');
        expect(w.sentOf('moveTo')[0]!.z).toBe(2200);
        expect(w.sentOf('setTarget').at(-1)!.objectId).toBe(301);
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
    });

    test('a death event or isDead counts as the kill (someone else landed the blow)', async () => {
        const first = world({ nearbyPlayers: [enemy()] });
        setTimeout(() => first.w.combat({ kind: 'death', attackerObjectId: 999, targetObjectId: 301 }), 50);
        expect(await first.bot.killPlayer(enemy())).toMatchObject({ success: true, killed: true });

        const second = world({ nearbyPlayers: [enemy()] });
        setTimeout(() => { const pl = second.w.state.nearbyPlayers[0]!; pl.isDead = true; pl.healthPercent = 0; }, 50);
        expect(await second.bot.killPlayer(301)).toMatchObject({ success: true, killed: true });
    });

    test('refuses our own realm, the dead and the unknown', async () => {
        const { bot } = world({ nearbyPlayers: [makePlayerObj(), enemy({ objectId: 302, isDead: true, healthPercent: 0 })] });
        expect(await bot.killPlayer(300)).toMatchObject({ success: false, reason: 'not_attackable', player: { objectId: 300 } });
        expect((await bot.killPlayer(302)).reason).toBe('already_dead');
        expect(await bot.killPlayer(999)).toMatchObject({ success: false, reason: 'not_found', player: null });
    });

    test('PvP immunity ends the fight with reason immune and switches attack off', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        w.handlers.attack = (a, world) => {
            if (a.type !== 'attack') return;
            world.player.attacking = a.on;
            if (a.on) setTimeout(() => world.message(IMMUNE_OURS, { type: 'youHit' }), 10);
        };
        const r = await bot.killPlayer(301, { timeout: 2000 });
        expect(r).toMatchObject({ success: false, reason: 'immune', retryAfterMs: 2000, killed: false });
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
    });

    test('target_lost when it leaves view alive (stealth, out of range)', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        playerFightSim(w, { dmg: 10 });
        const inner = w.onTick!;
        w.onTick = world => {
            inner(world);
            if ((world.state.nearbyPlayers[0]?.healthPercent ?? 100) <= 80) world.state.nearbyPlayers = [];
        };
        const r = await bot.killPlayer(301, { timeout: 2000 });
        expect(r).toMatchObject({ success: false, reason: 'target_lost', killed: false });
    });

    test('out_of_reach when it runs beyond maxChaseDistance; the style chooser sees the player', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        playerFightSim(w, { dmg: 5 });
        const seen: number[] = [];
        const inner = w.onTick!;
        w.onTick = world => {
            inner(world);
            const pl = world.state.nearbyPlayers[0]!;
            if (pl.healthPercent <= 80) pl.x += 150; // runs as fast as we do
        };
        const r = await bot.killPlayer(301, { maxChaseDistance: 1500, timeout: 5000, useStyle: ({ target }) => { seen.push(target.objectId); return 'Backslash'; } });
        expect(r).toMatchObject({ success: false, reason: 'out_of_reach' });
        expect(seen).toContain(301);
        expect(w.sentOf('moveTo').length).toBeGreaterThanOrEqual(1);
    });
});

describe('attack / castSpell / attackers against players', () => {
    test('attack takes an enemy player by objectId: npc null, target the player', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        playerFightSim(w, { dmg: 1 });
        const r = await bot.attack(301);
        expect(r).toMatchObject({ success: true, npc: null, target: { kind: 'player', objectId: 301 } });
        expect(w.player.targetObjectId).toBe(301);
        const npc = await bot.attack('rat');
        expect(npc).toMatchObject({ success: true, npc: { objectId: 200 }, target: { objectId: 200 } });
    });

    test('attack reports immune when the refusal follows attack mode', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        w.handlers.attack = (a, world) => {
            if (a.type !== 'attack') return;
            world.player.attacking = a.on;
            if (a.on) setTimeout(() => world.message('Norseman is temporarily immune to PvP attacks!', { type: 'youHit' }), 50);
        };
        expect(await bot.attack(301)).toMatchObject({ success: false, reason: 'immune', retryAfterMs: 2000, target: { objectId: 301 } });
        w.state.nearbyPlayers[0]!.isDead = true;
        w.publish();
        expect((await bot.attack(301)).reason).toBe('already_dead');
    });

    test('after attack mode a range or view refusal is retryable and still attacking; a fatal one is refused', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        let refusal = 'Norseman is too far away to attack!';
        w.handlers.attack = (a, world) => {
            if (a.type !== 'attack') return;
            world.player.attacking = a.on;
            if (a.on) setTimeout(() => world.message(refusal, { type: 'system' }), 50);
        };
        expect(await bot.attack(301)).toMatchObject({ success: true, target: { objectId: 301 } });
        refusal = 'Norseman is not in view!';
        expect((await bot.attack(301)).success).toBeTrue();
        refusal = 'You must have a target to attack!';
        expect(await bot.attack(301)).toMatchObject({ success: false, reason: 'refused', message: refusal });
        // A mezz or stun on us wears off: its own reason, with when to try again.
        refusal = "You can't attack when you are stunned!";
        expect(await bot.attack(301)).toMatchObject({ success: false, reason: 'crowd_controlled', retryAfterMs: 2000, message: refusal });
    });

    test('attack refused at once while mezzed (no attack mode: AttackComponent.cs:501-505) is crowd_controlled', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        w.handlers.attack = (a, world) => {
            if (a.type === 'attack' && a.on) setTimeout(() => world.message("You can't attack when you are mesmerized!", { type: 'youHit' }), 10);
        };
        expect(await bot.attack(301)).toMatchObject({ success: false, reason: 'crowd_controlled', retryAfterMs: 2000, target: { objectId: 301 } });
        expect(await bot.attack('rat')).toMatchObject({ success: false, reason: 'crowd_controlled', npc: { objectId: 200 } });
    });

    test('killNpc and killPlayer end with crowd_controlled when a mezz or stun refuses the swing, attack off', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        w.handlers.attack = (a, world) => {
            if (a.type === 'attack' && a.on) setTimeout(() => world.message("You can't attack when you are stunned!", { type: 'youHit' }), 10);
        };
        const pl = await bot.killPlayer(301, { timeout: 3000 });
        expect(pl).toMatchObject({ success: false, reason: 'crowd_controlled', retryAfterMs: 2000, killed: false });
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
        const npc = await bot.killNpc('rat', { timeout: 3000 });
        expect(npc).toMatchObject({ success: false, reason: 'crowd_controlled', retryAfterMs: 2000, killed: false });
    });

    test('a living player at 0 % (health is rounded down, GameLiving.cs:2621) is fought on until isDead or its death event', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy({ healthPercent: 0 })] });
        let swings = 0;
        w.onTick = world => {
            const p = world.player;
            if (!p.attacking || p.targetObjectId !== 301) return;
            if (++swings === 20) world.combat({ kind: 'death', attackerObjectId: p.objectId, targetObjectId: 301 });
        };
        const r = await bot.killPlayer(301, { timeout: 3000 });
        expect(r).toMatchObject({ success: true, killed: true });
        expect(swings).toBeGreaterThanOrEqual(20);
        // attack() takes it too; only isDead makes it already dead.
        const second = world({ nearbyPlayers: [enemy({ healthPercent: 0 })] });
        expect((await second.bot.attack(301)).success).toBeTrue();
        second.w.state.nearbyPlayers[0]!.isDead = true;
        second.w.publish();
        expect((await second.bot.killPlayer(301)).reason).toBe('already_dead');
    });

    test("the notice that our immunity ended is no refusal: the fight goes on (AbstractServerRules.cs:301)", async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        playerFightSim(w, { dmg: 10 });
        setTimeout(() => w.message('Your temporary PvP invulnerability timer has expired.', { type: 'system' }), 50);
        expect(await bot.killPlayer(301, { timeout: 5000 })).toMatchObject({ success: true, killed: true });
    });

    const drain = { name: 'Minor Vitality Drain', level: 1, internalId: 651, lineName: 'Path of Ice', lineIndex: 1, spellIndex: 0, cooldownRemaining: 0 };
    /** Target 'Realm' in the static spell data. */
    const realmBuff = { name: 'Minor Earthen Power', level: 1, internalId: 11, lineName: 'Path of Earth', lineIndex: 0, spellIndex: 1, cooldownRemaining: 0 };
    const skills = { specializations: [], abilities: [], styles: [], spells: [drain, realmBuff] };

    test('castSpell reports immune, and refuses a realm spell on an enemy player', async () => {
        const { w, bot } = world({ skills, nearbyPlayers: [makePlayerObj(), enemy()] });
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('Norseman is entering the game and cannot be attacked!', { type: 'system' }), 10); };
        expect(await bot.castSpell(drain, 301)).toMatchObject({ success: false, reason: 'immune', retryAfterMs: 2000 });
        expect(await bot.castSpell(realmBuff, 301)).toMatchObject({ success: false, reason: 'invalid_target', target: { objectId: 301 } });
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Minor Earthen Power spell!', { type: 'spell' }), 10); };
        expect(await bot.castSpell(realmBuff, 300)).toMatchObject({ success: true, target: { objectId: 300 } });
    });

    test('castSpell: "You can\'t cast while mesmerized/stunned!" is crowd_controlled at once, not a 3 s no_response', async () => {
        const { w, bot } = world({ skills, nearbyPlayers: [enemy()] });
        for (const text of ["You can't cast while mesmerized!", "You can't cast while stunned!"]) {
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(text, { type: 'resisted' }), 10); };
            const started = Date.now();
            expect(await bot.castSpell(drain, 301)).toMatchObject({ success: false, reason: 'crowd_controlled', retryAfterMs: 2000, message: text });
            expect(Date.now() - started).toBeLessThan(1500);
        }
    });

    test('castSpell: a spell with its own line says whether it landed, and on whom: an enemy player by its real name', async () => {
        const row = getSpells().find(x => x.name === 'Diversion')!;
        const mezz = { name: 'Diversion', level: 10, internalId: row.id, lineName: 'Pacification', lineIndex: 2, spellIndex: 0, cooldownRemaining: 0 };
        const { w, bot } = world({ skills: { ...skills, spells: [mezz] }, nearbyPlayers: [enemy()] });
        const answer = (...lines: [string, GameMessage['type']][]) => {
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 50 }), 10);
                setTimeout(() => {
                    world.message('You cast a Diversion spell!', { type: 'spell' });
                    for (const [text, type] of lines) world.message(text, { type });
                }, 70);
            };
        };
        expect(row.effectStarts).toBe('{0} is entranced!');
        answer(['Oisin is entranced!', 'spell']);
        expect(await bot.castSpell(mezz, 301)).toMatchObject({ success: true, effectLanded: true, landedOn: 'Oisin', effectImmune: false, alreadyOn: false });
        answer(['Oisin already has that effect. Wait until it expires. Spell failed.', 'spell']);
        const again = await bot.castSpell(mezz, 301);
        expect(again).toMatchObject({ success: true, alreadyOn: true, effectLanded: false });
        expect(again.message).toBe('Cast Diversion on Norseman (already has it)');
        // Nothing about it from the server: the cast went off, and no more than that.
        answer();
        expect(await bot.castSpell(mezz, 301)).toMatchObject({ success: true, effectLanded: false });
    });

    test('castSpell: "Your target is immune to this effect!" after "You cast" is a cast with effectImmune, not resisted', async () => {
        const { w, bot } = world({ skills, nearbyPlayers: [enemy()] });
        // CCSpellHandler.CheckSpellResist answers right behind FinishSpellCast's "You cast a" (SpellHandler.cs:1337).
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 50 }), 10);
            setTimeout(() => {
                world.message('You cast a Minor Vitality Drain spell!', { type: 'spell' });
                world.message('Your target is immune to this effect!', { type: 'resisted' });
            }, 70);
        };
        const r = await bot.castSpell(drain, 301);
        expect(r).toMatchObject({ success: true, completed: true, resisted: false, effectImmune: true, damage: 0 });
        expect(r.message).toBe('Cast Minor Vitality Drain on Norseman (target immune)');
        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Minor Vitality Drain spell!', { type: 'spell' }), 10); };
        expect(await bot.castSpell(drain, 301)).toMatchObject({ success: true, resisted: false, effectImmune: false });
    });

    test('getPlayerAttackers keeps a slow weapon\'s attacker between two swings (6 s window)', async () => {
        const { w, bot } = world({ nearbyPlayers: [enemy()] });
        // A two-handed swing 5 s ago: the next one is still to come.
        w.state.combatEvents.push({ id: 98, kind: 'melee', attackerObjectId: 301, targetObjectId: w.player.objectId, result: 'hit', receivedAt: w.state.timestamp - 5000 });
        w.publish();
        expect(bot.getPlayerAttackers().map(p => p.objectId)).toEqual([301]);
        expect(bot.getPlayerAttackers(4000)).toEqual([]);
    });

    test('getPlayerAttackers: enemy swings and spell effects on us within the window', async () => {
        const { w, bot, sdk } = world({
            nearbyPlayers: [
                makePlayerObj(), // our realm
                enemy({ objectId: 301, x: 560400, distance: 400 }),
                enemy({ objectId: 302, realm: 'hibernia', name: 'Celt', x: 560100, distance: 100 }),
                enemy({ objectId: 303, isDead: true, healthPercent: 0 }),
                enemy({ objectId: 304, x: 560200 }),
            ],
        });
        const me = w.player.objectId;
        expect(bot.isInCombat()).toBeFalse();
        w.combat({ kind: 'melee', attackerObjectId: 301, targetObjectId: me, result: 'miss' });
        w.combat({ kind: 'spellEffect', attackerObjectId: 302, targetObjectId: me, effectId: 5208 });
        w.combat({ kind: 'melee', attackerObjectId: 300, targetObjectId: me, result: 'hit' });
        w.combat({ kind: 'melee', attackerObjectId: 303, targetObjectId: me, result: 'hit' });
        w.combat({ kind: 'melee', attackerObjectId: 304, targetObjectId: 999, result: 'hit' });
        w.state.combatEvents.push({ id: 99, kind: 'melee', attackerObjectId: 304, targetObjectId: me, result: 'hit', receivedAt: w.state.timestamp - 10_000 });
        w.publish();
        expect(bot.getPlayerAttackers().map(p => p.objectId)).toEqual([302, 301]);
        expect(bot.getPlayerAttackers(60_000).map(p => p.objectId)).toEqual([302, 304, 301]);
        expect(bot.isInCombat()).toBeTrue();
        expect(bot.getAttackers()).toEqual([]);
        expect(sdk.getNearbyPlayer(302)?.name).toBe('Celt');
        expect(sdk.getNearbyPlayer(200)).toBeNull();
    });
});

describe('useStyle / useAbility', () => {
    test('style prepared vs refused', async () => {
        const { w, bot } = world();
        w.handlers.useSkill = (_a, world) => { setTimeout(() => world.message('You prepare to perform a Backslash!'), 10); };
        expect((await bot.useStyle('Backslash')).success).toBeTrue();
        w.handlers.useSkill = (_a, world) => { setTimeout(() => world.message('You are too fatigued to use this style!'), 10); };
        expect((await bot.useStyle('Backslash')).reason).toBe('refused');
        expect((await bot.useStyle('Nope')).reason).toBe('not_found');
    });

    test('ability answered', async () => {
        const { w, bot } = world();
        w.handlers.useSkill = (_a, world) => { setTimeout(() => world.message('You prepare to sprint!'), 10); };
        expect(await bot.useAbility('Sprint')).toMatchObject({ success: true, message: 'You prepare to sprint!' });
    });

    test('combat spam is not an answer to an ability', async () => {
        const { w, bot } = world();
        w.handlers.useSkill = (_a, world) => {
            setTimeout(() => {
                world.message('You hit the rat for 5 damage!', { type: 'youHit' });
                world.message('The rat hits you for 2 damage!', { type: 'damaged' });
            }, 10);
        };
        expect((await bot.useAbility('Sprint')).reason).toBe('no_response');
        // A refusal right behind the first answer still wins.
        w.handlers.useSkill = (_a, world) => {
            setTimeout(() => world.message('You prepare to sprint!'), 10);
            setTimeout(() => world.message('You cannot sprint while rooted!'), 150);
        };
        expect((await bot.useAbility('Sprint')).reason).toBe('refused');
    });
});

// ── Loot / recovery ─────────────────────────────────────────────────────────

describe('lootNearby', () => {
    test('picks up loot and reports the delta', async () => {
        const { w, bot } = world({ nearbyObjects: [makeObject({ objectId: 400, name: 'bag of coins', x: 560400, y: 511000 })] });
        w.handlers.pickup = (a, world) => {
            if (a.type !== 'pickup') return;
            setTimeout(() => {
                world.state.nearbyObjects = world.state.nearbyObjects.filter(o => o.objectId !== a.objectId);
                world.player.money = { ...world.player.money, totalCopper: world.player.money.totalCopper + 12 };
                world.message('You pick up 12 copper.');
            }, 10);
        };
        const r = await bot.lootNearby({ settleMs: 0 });
        expect(r).toMatchObject({ success: true, picked: ['bag of coins'], moneyGained: 12 });
        expect(w.sentOf('moveTo')).toHaveLength(1);
    });

    test('reports refusals and an empty ground', async () => {
        const { w, bot } = world();
        w.handlers.pickup = (_a, world) => { setTimeout(() => world.message("That loot doesn't belong to you - you can't pick it up."), 10); };
        const r = await bot.lootNearby({ settleMs: 0 });
        expect(r).toMatchObject({ success: false, reason: 'refused' });
        expect(r.skipped[0]!.reason).toContain("doesn't belong");
        w.state.nearbyObjects = [];
        w.publish();
        expect((await bot.lootNearby({ settleMs: 0 })).message).toBe('Nothing to loot');
    });
});

describe('rest / respawn', () => {
    test('sits until healed and stands up', async () => {
        const { w, bot } = world({ player: makePlayer({ healthPercent: 50, health: 50 }) });
        w.onTick = world => {
            if (world.player.isSitting) { world.player.health = Math.min(100, world.player.health + 5); world.player.healthPercent = world.player.health; }
        };
        const r = await bot.rest({ healthPercent: 90 });
        expect(r).toMatchObject({ success: true });
        expect(r.healthPercent).toBeGreaterThanOrEqual(90);
        expect(w.sentOf('sit').map(a => a.sit)).toEqual([true, false]);
        expect(w.player.isSitting).toBeFalse();
    });

    test('stops when attacked and refuses in combat', async () => {
        const { w, bot } = world({ player: makePlayer({ healthPercent: 50, health: 50 }) });
        setTimeout(() => { w.state.nearbyNpcs[0]!.targetObjectId = w.player.objectId; }, 60);
        expect((await bot.rest()).reason).toBe('attacked');
        expect((await bot.rest()).reason).toBe('in_combat');
    });

    test('a refused sit is a failure even though the client marks us sitting', async () => {
        const { w, bot } = world({ player: makePlayer({ healthPercent: 50, health: 50 }) });
        w.handlers.sit = (a, world) => {
            if (a.type !== 'sit') return;
            world.player.isSitting = a.sit; // DaocClient sets isSitting before the server answers
            if (a.sit) setTimeout(() => world.message("You can't rest when you are stunned!"), 30);
        };
        const r = await bot.rest();
        expect(r).toMatchObject({ success: false, reason: 'refused' });
        expect(r.message).toContain('stunned');
        expect(w.player.isSitting).toBeFalse();
    });

    test('an abort stands us back up', async () => {
        const { w, bot } = world({ player: makePlayer({ healthPercent: 50, health: 50 }) });
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('cancelled')), 100);
        await expect(executionContext.run({ signal: controller.signal }, () => bot.rest())).rejects.toThrow('cancelled');
        expect(w.sentOf('sit').map(a => a.sit)).toEqual([true, false]);
        expect(w.player.isSitting).toBeFalse();
    });

    test('releaseAndRespawn waits for life and the position snap', async () => {
        const { w, bot } = world();
        expect((await bot.releaseAndRespawn()).reason).toBe('not_dead');
        w.player.isDead = true;
        w.handlers.release = (_a, world) => {
            setTimeout(() => { world.message('You release your corpse unto death.'); world.player.isDead = false; world.player.x += 5000; }, 20);
        };
        w.publish();
        const r = await bot.releaseAndRespawn();
        expect(r.success).toBeTrue();
        expect(r.position!.x).toBe(565000);
        expect(bot.isDead()).toBeFalse();
    });

    describe('releaseAndRespawn inside the server\'s 10 s wait', () => {
        /** Every timer of the code under test runs at 1/20 of its length. The world's own tick is an interval, and keeps its pace. */
        const quick = async <T>(run: () => Promise<T>): Promise<T> => {
            const real = globalThis.setTimeout;
            globalThis.setTimeout = ((fn: () => void, ms?: number) => real(fn, (ms ?? 0) / 20)) as typeof setTimeout;
            try {
                return await run();
            } finally {
                globalThis.setTimeout = real;
            }
        };
        /** GamePlayer.Release (GamePlayer.cs:1438-1449): a /release in the wait arms the automatic one, the next disarms it, and past the wait one releases at once. */
        const releases = (w: FakeWorld, line: string, seconds: number, opts: { fires?: boolean; armed?: boolean } = {}) => {
            let armed = opts.armed ?? false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let passed = false;
            const alive = (world: FakeWorld) => {
                world.message('You release your corpse unto death.');
                world.player.isDead = false;
                world.player.health = 100;
                world.player.healthPercent = 100;
                world.player.x += 5000;
            };
            setTimeout(() => { passed = true; }, seconds * 1000);
            w.handlers.release = (_a, world) => {
                if (passed) return alive(world);
                armed = !armed;
                world.message(armed ? line : `You will no longer release automatically. (${seconds} more seconds)`);
                if (timer) clearTimeout(timer);
                if (armed && opts.fires !== false) timer = setTimeout(() => alive(world), seconds * 1000);
            };
        };
        const dead = () => world({ player: makePlayer({ isDead: true, health: 0, healthPercent: 0 }) });

        const lines = [
            'You will now release automatically in 8 more seconds!',
            'You will now release automatically to your home city in 8 more seconds!',
            'You will now release to the nearest border or portal keep in 8 more seconds!',
            'You will now release to your house in 8 more seconds!',
        ];
        for (const line of lines) {
            test(`"${line}": no second /release, which would cancel it`, async () => {
                const { w, bot } = dead();
                const r = await quick(async () => {
                    releases(w, line, 8);
                    return bot.releaseAndRespawn();
                });
                expect(r).toMatchObject({ success: true });
                expect(w.sentOf('release')).toHaveLength(1);
                expect(w.state.gameMessages.map(m => m.text)).not.toContain('You will no longer release automatically. (8 more seconds)');
            });
        }

        test('no release by N + 2 s: it asks again, and past the wait that one goes', async () => {
            const { w, bot } = dead();
            const r = await quick(async () => {
                releases(w, 'You will now release automatically in 8 more seconds!', 8, { fires: false });
                return bot.releaseAndRespawn();
            });
            expect(r).toMatchObject({ success: true });
            expect(w.sentOf('release')).toHaveLength(2);
        });

        test('armed by someone earlier, our /release disarms it: one more goes at once, which arms it again with the right N', async () => {
            const { w, bot } = dead();
            const sends: number[] = [];
            const r = await quick(async () => {
                releases(w, 'You will now release automatically in 8 more seconds!', 8, { armed: true });
                const inner = w.handlers.release!;
                w.handlers.release = (a, world) => { sends.push(Date.now()); return inner(a, world); };
                return bot.releaseAndRespawn();
            });
            expect(r).toMatchObject({ success: true });
            expect(w.state.gameMessages.map(m => m.text)).toEqual(expect.arrayContaining(['You will no longer release automatically. (8 more seconds)', 'You will now release automatically in 8 more seconds!']));
            expect(sends).toHaveLength(2);
            // Without the line it waits out 5 s and then 2 s: 350 ms at this pace.
            expect(sends[1]! - sends[0]!).toBeLessThan(150);
        });

        test('a refusal is still retried, as ever', async () => {
            const { w, bot } = dead();
            let asked = 0;
            w.handlers.release = (_a, world) => {
                if (++asked === 1) return void world.message('You must wait 1 seconds to release.');
                world.player.isDead = false;
                world.player.health = 100;
                world.player.healthPercent = 100;
                world.player.x += 5000;
            };
            expect(await quick(() => bot.releaseAndRespawn())).toMatchObject({ success: true });
            expect(asked).toBe(2);
        });
    });

    describe('rest\'s messages name what was asked for', () => {
        test('a timeout on mana says so: health alone read as a contradiction', async () => {
            const { bot } = world({ player: makePlayer({ health: 100, healthPercent: 100, mana: 31, maxMana: 100, manaPercent: 31 }) });
            const r = await bot.rest({ healthPercent: 90, manaPercent: 60, timeout: 60 });
            expect(r).toMatchObject({ success: false, reason: 'timeout', message: 'Rest timed out at 100% health, 31% mana' });
        });

        test('endurance too, and only what was asked', async () => {
            const asked = world({ player: makePlayer({ health: 100, healthPercent: 100, mana: 31, maxMana: 100, manaPercent: 31, endurance: 40, endurancePercent: 40 }) });
            expect((await asked.bot.rest({ endurancePercent: 80, timeout: 60 })).message).toBe('Rest timed out at 100% health, 40% endurance');
            expect((await asked.bot.rest({ manaPercent: 80, endurancePercent: 80, timeout: 60 })).message).toBe('Rest timed out at 100% health, 31% mana, 40% endurance');
            const low = world({ player: makePlayer({ health: 50, healthPercent: 50, mana: 31, maxMana: 100, manaPercent: 31 }) });
            expect((await low.bot.rest({ timeout: 60 })).message).toBe('Rest timed out at 50% health');
        });

        test('no mana to wait for reads no mana', async () => {
            const { bot } = world({ player: makePlayer({ health: 50, healthPercent: 50 }) });
            expect((await bot.rest({ manaPercent: 60, timeout: 60 })).message).toBe('Rest timed out at 50% health');
        });

        test('a rest that ends well says the same', async () => {
            const { w, bot } = world({ player: makePlayer({ health: 100, healthPercent: 100, mana: 50, maxMana: 100, manaPercent: 50 }) });
            w.onTick = world => { if (world.player.isSitting) { world.player.mana = Math.min(100, world.player.mana + 10); world.player.manaPercent = world.player.mana; } };
            const r = await bot.rest({ manaPercent: 100 });
            expect(r).toMatchObject({ success: true, message: 'Rested to 100% health, 100% mana' });
        });
    });
});

// ── Items / merchants / trainers ────────────────────────────────────────────

describe('items', () => {
    test('useItem: in combat, a stone refuses after naming itself (GatewayPersonalBind.cs:105)', async () => {
        const { w, bot } = world({ inventory: [{ slot: 40, name: 'Personal Bind Recall Stone', count: 1 } as InventoryItem] });
        w.handlers.useItem = (_a, world) => {
            setTimeout(() => world.message('You attempt to use the Personal Bind Recall Stone.'), 5);
            setTimeout(() => world.message('You use the Personal Bind Recall Stone.'), 10);
            setTimeout(() => world.message('You have been in combat recently and cannot use this item!'), 60);
        };
        expect(await bot.useItem(40)).toMatchObject({ success: false, reason: 'in_combat', message: 'You have been in combat recently and cannot use this item!', item: { slot: 40 } });
    });

    test.each([
        ['the check at the start of the cast (GatewayPersonalBind.cs:32, :110)', 'You must be standing still to use this item!'],
        ['the cast it starts, cut by our next step: spell 5998 is a focus spell (PlayerCastingComponent.cs:70)', 'You move and interrupt your focus!'],
    ])('useItem: a stone used on the move, %s', async (_what, line) => {
        const { w, bot } = world({ inventory: [{ slot: 40, name: 'Personal Bind Recall Stone', count: 1 } as InventoryItem] });
        w.handlers.useItem = (_a, world) => {
            setTimeout(() => world.message('You attempt to use the Personal Bind Recall Stone.'), 5);
            setTimeout(() => world.message('You use the Personal Bind Recall Stone.'), 10);
            setTimeout(() => world.message(line), 60);
        };
        expect(await bot.useItem(40)).toMatchObject({ success: false, reason: 'refused', message: line, item: { slot: 40 } });
    });

    test('useItem during a cast: the attempt line is no success when "You are already casting a spell." follows (GamePlayer.cs:7169-7173)', async () => {
        const { w, bot } = world({ inventory: [{ slot: 40, name: 'Personal Bind Recall Stone', count: 1 } as InventoryItem] });
        w.handlers.useItem = (_a, world) => {
            setTimeout(() => world.message('You attempt to use the Personal Bind Recall Stone.'), 5);
            setTimeout(() => world.message('You are already casting a spell.'), 60);
        };
        expect(await bot.useItem(40)).toMatchObject({ success: false, reason: 'refused', message: 'You are already casting a spell.', item: { slot: 40 } });
    });

    describe('useItem on the ranged slot: its lines name no item (GamePlayer.cs:6564, :6640-6705)', () => {
        const bow = { slot: 13, name: 'rowan bow', level: 1, count: 1, model: 3, objectType: 9, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 };
        const answers = (w: FakeWorld, line: string) => { w.handlers.useItem = (_a, world) => { setTimeout(() => world.message(line, { type: 'youHit' }), 5); }; };

        test.each([
            ['the draw', 'You prepare your shot (3.9s to fire, target is in range)'],
            ['the throw\'s', 'You prepare your throw (3.9s to fire)'],
            ['the draw done', 'You are ready to fire!'],
            ['the shot', 'You shoot the young grendelorm with your bow and hit for 18 damage!'],
            ['a shot that misses', 'You miss! (12%)'],
            ['the switch to auto-release', 'You will now automatically release your shot.'],
            ['a shot it evades, in place of the "You shoot"', 'The young grendelorm evades your attack!'],
            ['a shot it blocks', 'The young grendelorm blocks your attack!'],
        ])('%s is evidence', async (_what, line) => {
            const { w, bot } = world({ equipment: [bow] });
            answers(w, line);
            const t0 = Date.now();
            expect(await bot.useItem(13)).toMatchObject({ success: true, message: line, item: { slot: 13 } });
            expect(Date.now() - t0).toBeLessThan(1500);
        });

        test('a line naming the bow still counts: the first use takes it in hand (GamePlayer.cs:6649-6654)', async () => {
            const { w, bot } = world({ equipment: [bow] });
            answers(w, 'You wield the rowan bow in both hands.');
            expect(await bot.useItem(13)).toMatchObject({ success: true, message: 'You wield the rowan bow in both hands.' });
        });

        test('on any other slot those lines say nothing of it', async () => {
            const { w, bot } = world();
            answers(w, 'You are ready to fire!');
            expect(await bot.useItem(10)).toMatchObject({ success: false, reason: 'no_response' });
            answers(w, 'The young grendelorm evades your attack!');
            expect(await bot.useItem(10)).toMatchObject({ success: false, reason: 'no_response' });
        }, 8000);
    });

    test('useItem: the other "cannot use this item" is no matter of combat (GamePlayerInventory.cs:731)', async () => {
        const { w, bot } = world({ inventory: [{ slot: 40, name: 'plate helm', count: 1 } as InventoryItem] });
        w.handlers.useItem = (_a, world) => { setTimeout(() => world.message('Your class cannot use this item!'), 5); };
        expect(await bot.useItem(40)).toMatchObject({ success: false, reason: 'refused' });
    });

    test('equip and unequip through the paper doll slot', async () => {
        const { w, bot } = world();
        w.handlers.moveItem = (a, world) => {
            if (a.type !== 'moveItem') return;
            const s = world.state;
            if (a.fromSlot >= 40) {
                const item = s.inventory.find(i => i.slot === a.fromSlot)!;
                s.inventory = s.inventory.filter(i => i !== item);
                s.equipment = [...s.equipment, { ...item, slot: 11 }];
            } else {
                const item = s.equipment.find(i => i.slot === a.fromSlot)!;
                s.equipment = s.equipment.filter(i => i !== item);
                s.inventory = [...s.inventory, { ...item, slot: 43 }];
            }
        };
        const eq = await bot.equipItem('healing potion');
        expect(eq.success).toBeTrue();
        expect(w.sentOf('moveItem')[0]).toMatchObject({ fromSlot: 40, toSlot: 100 });
        const un = await bot.unequipItem(10);
        expect(un.success).toBeTrue();
        expect(w.sentOf('moveItem')[1]).toMatchObject({ fromSlot: 10, toSlot: 100 });
        expect((await bot.equipItem('nothing')).reason).toBe('not_found');
    });

    test('equip into a named slot swaps what is there and watches that slot', async () => {
        const { w, bot } = world();
        const ring = { ...w.state.inventory[0]!, slot: 45, name: 'Empowering Ring', level: 15 };
        const worn = { ...ring, name: 'Empowering Ring', level: 10, slot: 35 };
        w.state.inventory = [...w.state.inventory, ring];
        w.state.equipment = [...w.state.equipment, worn];
        w.publish();
        w.handlers.moveItem = (a, world) => {
            if (a.type !== 'moveItem') return;
            const s = world.state;
            s.inventory = [...s.inventory.filter(i => i.slot !== a.fromSlot), { ...worn, slot: a.fromSlot }];
            s.equipment = [...s.equipment.filter(e => e.slot !== a.toSlot), { ...ring, slot: a.toSlot }];
        };
        const r = await bot.equipItem(ring, { slot: 35 });
        expect(r.success).toBeTrue();
        expect(w.sentOf('moveItem').at(-1)).toMatchObject({ fromSlot: 45, toSlot: 35 });
        expect(w.state.equipment.find(e => e.slot === 35)?.level).toBe(15);
    });

    test('an equal-named item worn elsewhere is no success for a named slot', async () => {
        const { w, bot } = world();
        const ring = { ...w.state.inventory[0]!, slot: 45, name: 'Empowering Ring', level: 15 };
        w.state.inventory = [...w.state.inventory, ring];
        w.state.equipment = [...w.state.equipment, { ...ring, slot: 35 }];
        w.publish();
        // The server moves nothing (a refusal without a message we match).
        const r = await bot.equipItem(ring, { slot: 36 });
        expect(r.success).toBeFalse();
        expect(r.reason).toBe('timeout');
    });

    describe('a swap with an equal-named item', () => {
        // As the wire has them: condition and durability in whole percents.
        const helm = { slot: 50, name: 'Speedy Reinforced Helm', level: 14, condition: 97, durability: 100, quality: 98, value1: 28, value2: 19, model: 1234, weight: 24 };
        const swaps = (w: FakeWorld, worn: InventoryItem, target: number, says?: string) => {
            w.handlers.moveItem = (a, world) => {
                if (a.type !== 'moveItem') return;
                const s = world.state;
                const item = s.inventory.find(i => i.slot === a.fromSlot)!;
                s.inventory = [...s.inventory.filter(i => i !== item), { ...worn, slot: a.fromSlot }];
                s.equipment = [...s.equipment.filter(e => e.slot !== target), { ...item, slot: target }];
                if (says) world.message(says);
            };
        };
        const setup = (differ: Partial<InventoryItem>) => {
            const { w, bot } = world();
            const pack = { ...w.state.inventory[0]!, ...helm };
            const worn = { ...pack, ...differ, slot: 21 };
            w.state.inventory = [...w.state.inventory, pack];
            w.state.equipment = [...w.state.equipment, worn];
            w.publish();
            return { w, bot, pack, worn };
        };
        const FLOWS = 'The magic of the Speedy Reinforced Helm flows through you.';

        test.each([
            ['another level', { level: 15 }],
            ['another condition', { condition: 90 }],
            ['another durability', { durability: 97 }],
            ['another quality', { quality: 95 }],
            ['another armour factor', { value1: 30 }],
            ['another absorption', { value2: 27 }],
            ['another model', { model: 822 }],
            ['another weight', { weight: 30 }],
        ])('is a success, with %s, through the paper doll and into a named slot', async (_what, differ) => {
            for (const options of [{}, { slot: 21 }]) {
                const { w, bot, pack, worn } = setup(differ);
                swaps(w, worn, 21);
                expect((await bot.equipItem(pack, options)).success).toBeTrue();
                expect(w.state.equipment.find(e => e.slot === 21)).toMatchObject({ level: 14, condition: 97, durability: 100, quality: 98, value1: 28, value2: 19, model: 1234, weight: 24 });
                expect(w.state.inventory.find(i => i.slot === 50)).toMatchObject(differ);
            }
        });

        test.each([
            ['another level, through the paper doll', { level: 15 }, {}],
            ['another level, into a named slot', { level: 15 }, { slot: 21 }],
            ['the same level, through the paper doll', { condition: 90 }, {}],
            ['the same level, into a named slot', { condition: 90 }, { slot: 21 }],
        ])('that the server refuses without a word is no success, with %s', async (_what, differ, options) => {
            const { bot, pack } = setup(differ);
            const r = await bot.equipItem(pack, options);
            expect(r.success).toBeFalse();
            expect(r.reason).toBe('timeout');
        });

        test('with one that reads the same, a magical piece is a success on what the server says as it goes on', async () => {
            const { w, bot, pack, worn } = setup({});
            swaps(w, worn, 21, FLOWS);
            const started = Date.now();
            const r = await bot.equipItem(pack);
            expect(r.success).toBeTrue();
            expect(Date.now() - started).toBeLessThan(2500);
            expect(r.messages?.map(m => m.text)).toContain(FLOWS);
        });

        test('with one that reads the same, a message about another piece says nothing about this one', async () => {
            const { w, bot, pack, worn } = setup({});
            swaps(w, worn, 21, 'The magic of the Adroit Ring flows through you.');
            expect((await bot.equipItem(pack)).reason).toBe('timeout');
        });

        test('with one that reads the same, a plain piece has nothing to go by', async () => {
            const { w, bot, pack, worn } = setup({});
            swaps(w, worn, 21);
            expect((await bot.equipItem(pack)).reason).toBe('timeout');
        });

        test('with another piece worn the slots decide, whatever the server says', async () => {
            const { w, bot, pack } = setup({ level: 15 });
            w.handlers.moveItem = (_a, world) => { world.message(FLOWS); };
            expect((await bot.equipItem(pack)).reason).toBe('timeout');
        });

        test('its twin going to an empty slot, a second ring, is a success', async () => {
            const { w, bot } = world();
            const ring = { ...w.state.inventory[0]!, ...helm, name: 'Adroit Ring', slot: 45 };
            w.state.inventory = [...w.state.inventory, ring];
            w.state.equipment = [...w.state.equipment, { ...ring, slot: 35 }];
            w.publish();
            w.handlers.moveItem = (a, world) => {
                if (a.type !== 'moveItem') return;
                const s = world.state;
                s.inventory = s.inventory.filter(i => i.slot !== a.fromSlot);
                s.equipment = [...s.equipment, { ...ring, slot: 36 }];
            };
            expect((await bot.equipItem(ring)).success).toBeTrue();
            expect(w.state.equipment.filter(e => e.name === 'Adroit Ring').map(e => e.slot)).toEqual([35, 36]);
        });
    });

    test.each([
        ['You have no skill in using this weapon type!'],
        ['You have no skill in wearing this armor type!'],
        ["The great axe can't go there!"],
    ])('a slot refusal comes back at once: %s', async text => {
        const { w, bot } = world();
        const axe = { ...w.state.inventory[0]!, slot: 45, name: 'great axe' };
        w.state.inventory = [...w.state.inventory, axe];
        w.publish();
        w.handlers.moveItem = (_a, world) => { world.message(text); };
        const started = Date.now();
        const r = await bot.equipItem(axe, { slot: 10 });
        expect(r.reason).toBe('refused');
        expect(r.message).toBe(text);
        expect(Date.now() - started).toBeLessThan(2500);
    });

    test('drop, destroy and use', async () => {
        const { w, bot } = world();
        const remove = (a: BotAction, world: FakeWorld) => {
            const slot = (a as { slot: number }).slot;
            world.state.inventory = world.state.inventory.filter(i => i.slot !== slot);
        };
        w.handlers.dropItem = remove;
        w.handlers.destroyItem = remove;
        w.handlers.useItem = (_a, world) => { setTimeout(() => world.message('You must wait 10 more second before using another potion!'), 10); };
        expect((await bot.dropItem(41)).success).toBeTrue();
        expect((await bot.destroyItem('rat tail')).success).toBeTrue();
        expect((await bot.useItem('potion')).reason).toBe('refused');
        expect(bot.freeBackpackSlots()).toBe(39);
        expect(bot.findInventoryItem('potion')?.slot).toBe(40);
        // Equipped items (charged weapons, jewellery) resolve by name or RegExp.
        w.handlers.useItem = (a, world) => {
            if (a.type !== 'useItem') return;
            const item = [...world.state.inventory, ...world.state.equipment].find(i => i.slot === a.slot);
            setTimeout(() => world.message(`You attempt to use ${item?.name}.`), 10); // GamePlayer.cs:6564
        };
        const regex = await bot.useItem(/training sw/);
        expect(regex).toMatchObject({ success: true, message: 'You attempt to use training sword.' });
        expect(regex.item?.slot).toBe(10);
    });

    test('useItem on an equipped item needs evidence about that item', async () => {
        const { w, bot } = world();
        // The server ignores the use: no message, no change. Equipment lives outside state.inventory.
        w.handlers.useItem = () => {};
        const ignored = await bot.useItem(/training sw/);
        expect(ignored).toMatchObject({ success: false, reason: 'no_response' });
        expect(ignored.item?.slot).toBe(10);
        // Combat spam is not an answer.
        w.handlers.useItem = (_a, world) => { setTimeout(() => world.message('You hit the rat for 5 damage!', { type: 'youHit' }), 10); };
        expect((await bot.useItem(/training sw/)).reason).toBe('no_response');
        // An equipment slot number resolves the equipped item; a refusal trailing the attempt wins.
        w.handlers.useItem = (_a, world) => {
            setTimeout(() => world.message('You attempt to use training sword.'), 10);
            setTimeout(() => world.message('The training sword is out of charges.'), 300);
        };
        const refused = await bot.useItem(10);
        expect(refused).toMatchObject({ success: false, reason: 'refused', message: 'The training sword is out of charges.' });
        expect(w.sentOf('useItem').at(-1)!.slot).toBe(10);
    }, 15_000);

    test('useItem on a backpack item: combat lines are not evidence, a stack change is', async () => {
        const { w, bot } = world();
        w.handlers.useItem = (_a, world) => { setTimeout(() => world.message('The rat hits you for 3 damage!', { type: 'damaged' }), 10); };
        expect((await bot.useItem('healing potion')).reason).toBe('no_response');
        w.handlers.useItem = (a, world) => {
            if (a.type !== 'useItem') return;
            setTimeout(() => { world.state.inventory = world.state.inventory.filter(i => i.slot !== a.slot); }, 10);
        };
        expect(await bot.useItem('healing potion')).toMatchObject({ success: true });
    }, 15_000);
});

describe('delveMerchantItem', () => {
    const eira = makeNpc({ objectId: 500, name: 'Eira', role: 'merchant', realm: 'albion', isPeaceful: true, x: 560100, y: 511000 });
    const sword = { page: 0, slot: 3, name: 'long sword', level: 4, price: 375, model: 1, usable: true, objectType: 19, hand: 0, damageType: 'slash' as const, value1: 24, spdAbs: 35 };
    function shop() {
        const ctx = world({ nearbyNpcs: [eira] });
        ctx.w.handlers.interact = (_a, world) => {
            world.state.merchant = { isOpen: true, merchantObjectId: 500, windowType: 0, items: [sword] };
        };
        return ctx;
    }

    test('sends the page and slot and returns the parsed answer', async () => {
        const { w, bot } = shop();
        w.handlers.delveMerchantItem = (_a, world) => {
            setTimeout(() => { world.state.textWindow = { caption: 'long sword', lines: ['Magical Bonuses:', '4.67 | Strength: 7 pts'], receivedAt: Date.now() }; }, 15);
        };
        const r = await bot.delveMerchantItem('Eira', /long sword/);
        expect(r).toMatchObject({ success: true, item: { page: 0, slot: 3, value1: 24 } });
        expect(r.bonuses.map(b => [b.category, b.value])).toEqual([['stat', 7]]);
        expect(w.sentOf('delveMerchantItem')).toMatchObject([{ page: 0, slot: 3 }]);
    });

    test('names what it could not do', async () => {
        const { bot } = shop();
        expect(await bot.delveMerchantItem('Eira', /pike/)).toMatchObject({ success: false, reason: 'item_not_sold', item: null });
        expect(await bot.delveMerchantItem('Nobody', /long sword/)).toMatchObject({ success: false, item: null });
        expect(await bot.delveMerchantItem('Eira', /long sword/, { timeout: 50 })).toMatchObject({ success: false, reason: 'no_response', item: { slot: 3 } });
    });
});

describe('delveItem', () => {
    const answer = (world: FakeWorld, caption: string, lines: string[]) => setTimeout(() => {
        world.state.textWindow = { caption, lines, receivedAt: Date.now() };
    }, 15);
    const delved = ['Usable by:', '- Paladin', ' ', 'Magical Bonuses:', '4.67 | Strength: 7 pts', '6.00 | Heat: 3 %', ' ', 'Total utility: 10.67', ' ', ' ', 'Bonus Level: 12'];

    test('sends the slot and returns the parsed answer', async () => {
        const { w, bot } = world();
        w.handlers.delve = (_a, world) => { answer(world, 'minor healing potion', delved); };
        const r = await bot.delveItem('potion');
        expect(r).toMatchObject({ success: true, item: { slot: 40 }, lines: delved, bonusLevel: 12, unknown: [] });
        expect(r.bonuses.map(b => [b.category, b.value])).toEqual([['stat', 7], ['resist', 3]]);
        expect(w.sentOf('delve').map(a => a.slot)).toEqual([40]);
    });

    test('takes an item, a slot or a name, in the backpack or worn', async () => {
        const { w, bot } = world();
        w.handlers.delve = (a, world) => {
            if (a.type !== 'delve') return;
            answer(world, [...world.state.inventory, ...world.state.equipment].find(i => i.slot === a.slot)!.name, ['Total utility: 0.00']);
        };
        expect((await bot.delveItem(w.state.inventory[0]!)).item?.slot).toBe(40);
        expect((await bot.delveItem(10)).item?.slot).toBe(10);
        expect((await bot.delveItem(/training sw/)).item?.slot).toBe(10);
    });

    test('an empty slot and a name nothing matches have their own reasons and send nothing', async () => {
        const { w, bot } = world();
        expect(await bot.delveItem(79)).toMatchObject({ success: false, reason: 'empty_slot', item: null, bonuses: [], lines: [] });
        expect(await bot.delveItem(30)).toMatchObject({ success: false, reason: 'empty_slot' });
        expect(await bot.delveItem('no such thing')).toMatchObject({ success: false, reason: 'not_found' });
        expect(w.sentOf('delve')).toEqual([]);
    });

    test('no answer is a reason, not a hang', async () => {
        const { w, bot } = world();
        w.handlers.delve = () => {};
        expect(await bot.delveItem('potion', { timeout: 60 })).toMatchObject({ success: false, reason: 'no_response', item: { slot: 40 }, lines: [] });
    });

    test('a window about something else is not the answer: an NPC text, or the last delve of another item', async () => {
        const { w, bot } = world();
        w.handlers.delve = (_a, world) => { answer(world, 'Player Statistics', ['4.67 | Strength: 7 pts']); };
        expect((await bot.delveItem('potion', { timeout: 60 })).reason).toBe('no_response');
    });

    test('a window from before the request is not the answer, even of the same name', async () => {
        const { w, bot } = world({ textWindow: { caption: 'minor healing potion', lines: delved, receivedAt: Date.now() - 1000 } });
        w.handlers.delve = () => {};
        expect((await bot.delveItem('potion', { timeout: 60 })).reason).toBe('no_response');
        w.handlers.delve = (_a, world) => { answer(world, 'minor healing potion', ['Total utility: 0.00']); };
        expect(await bot.delveItem('potion')).toMatchObject({ success: true, bonuses: [] });
    });

    test('another window before the answer is waited out', async () => {
        const { w, bot } = world();
        w.handlers.delve = (_a, world) => {
            answer(world, 'Some NPC', ['text']);
            setTimeout(() => { world.state.textWindow = { caption: 'minor healing potion', lines: delved, receivedAt: Date.now() + 1 }; }, 60);
        };
        expect((await bot.delveItem('potion')).lines).toEqual(delved);
    });

    test('a client refusal passes through: one too old to know delve answers unknown_action', async () => {
        const { w, bot } = world();
        w.handlers.delve = () => ({ success: false, message: "unknown action type 'delve'", reason: 'unknown_action', phase: 'validation' });
        expect(await bot.delveItem('potion')).toMatchObject({ success: false, reason: 'unknown_action', item: { slot: 40 }, bonuses: [] });
    });
});

describe('merchants', () => {
    const merchant = makeNpc({ objectId: 203, name: 'Lady Grynoch', role: 'merchant', realm: 'albion', isPeaceful: true, x: 560100, y: 511000 });
    const items = [
        { page: 0, slot: 0, name: 'arrows', level: 1, price: 50, model: 1, usable: true, objectType: 0, hand: 0, damageType: null, value1: 0, spdAbs: 0 },
        { page: 0, slot: 1, name: 'heavy sword', level: 5, price: 999_999, model: 2, usable: true, objectType: 0, hand: 0, damageType: null, value1: 0, spdAbs: 0 },
    ];
    function shop() {
        const ctx = world({ nearbyNpcs: [merchant] });
        ctx.w.handlers.interact = (_a, world) => {
            world.state.merchant = { isOpen: true, merchantObjectId: 203, windowType: 0, items };
        };
        return ctx;
    }

    test('buy observes inventory and money', async () => {
        const { w, bot } = shop();
        w.handlers.buy = (a, world) => {
            if (a.type !== 'buy') return;
            setTimeout(() => {
                world.state.inventory = [...world.state.inventory, { ...world.state.inventory[0]!, slot: 45, name: 'arrows', count: a.count }];
                world.player.money = { ...world.player.money, totalCopper: world.player.money.totalCopper - 50 * a.count };
                world.message(`You just bought ${a.count} pieces of arrows for 1 silver.`, { type: 'merchant' });
            }, 10);
        };
        const r = await bot.buyItem('Grynoch', 'arrows', 2);
        expect(r).toMatchObject({ success: true, count: 2, spent: 100 });
        expect((await bot.buyItem('Grynoch', 'heavy sword')).reason).toBe('insufficient_funds');
        expect((await bot.buyItem('Grynoch', 'banana')).reason).toBe('item_not_sold');
    });

    test('sell observes money and surfaces refusals', async () => {
        const { w, bot } = shop();
        w.handlers.sell = (a, world) => {
            if (a.type !== 'sell') return;
            const item = world.state.inventory.find(i => i.slot === a.slot)!;
            setTimeout(() => {
                if (item.name === 'minor healing potion') { world.message(`Lady Grynoch isn't interested in the ${item.name}.`, { type: 'merchant' }); return; }
                world.state.inventory = world.state.inventory.filter(i => i.slot !== a.slot);
                world.player.money = { ...world.player.money, totalCopper: world.player.money.totalCopper + 7 };
            }, 10);
        };
        expect(await bot.sellItem('Grynoch', 'rat tail')).toMatchObject({ success: true, earned: 7 });
        expect((await bot.sellItem('Grynoch', 'potion')).reason).toBe('refused');
        const many = await bot.sellItems('Grynoch', /rat tail/);
        expect(many).toMatchObject({ success: true, earned: 7 });
        expect(many.sold).toHaveLength(1);
    });

    test('openMerchant closes another merchant window first', async () => {
        const { w, bot } = shop();
        w.state.merchant = { isOpen: true, merchantObjectId: 999, windowType: 0, items: [] };
        w.publish();
        const r = await bot.openMerchant('Grynoch');
        expect(r.success).toBeTrue();
        expect(w.sent.findIndex(a => a.type === 'closeMerchant')).toBeLessThan(w.sent.findIndex(a => a.type === 'interact'));
    });

    test('openMerchant fails for a non-merchant', async () => {
        const { w, bot } = world();
        w.handlers.interact = (_a, world) => { setTimeout(() => world.message('rat says, "squeak"', { type: 'say' }), 10); };
        expect((await bot.openMerchant('rat')).reason).toBe('not_a_merchant');
    });
});

describe('smiths', () => {
    const smith = makeNpc({ objectId: 210, name: 'Judan Hammerfel', guildName: 'Smith', role: 'smith', realm: 'albion', isPeaceful: true, x: 560050, y: 511000 });
    const worn: InventoryItem = { slot: 10, name: 'long sword', level: 5, count: 1, model: 3, objectType: 3, hand: 0, condition: 88, durability: 100, quality: 90, weight: 30, value1: 27, value2: 30 };
    const box = (text: string) => ({ isOpen: true, code: 6, data: [5, 1, 0, 0] as [number, number, number, number], type: 1, text, receivedAt: Date.now() });

    /** A smith that asks `price` for what it's given, and on a yes takes the money and restores the item. */
    function atSmith(price: string, copper: number, overrides: Partial<BotWorldState> = {}) {
        const r = world({ nearbyNpcs: [smith], equipment: [worn], ...overrides });
        r.w.handlers.moveItem = (a, w) => {
            if (a.type !== 'moveItem') return;
            setTimeout(() => { w.state.dialog = box(`It will cost ${price} to repair the long sword. Do you accept?`); }, 10);
        };
        r.w.handlers.respondDialog = (a, w) => {
            if (a.type !== 'respondDialog') return;
            w.state.dialog = { ...w.state.dialog!, isOpen: false };
            if (!a.accept) { w.message('You decline to have your long sword repaired.'); return; }
            setTimeout(() => {
                w.player.money = { ...w.player.money, totalCopper: w.player.money.totalCopper - copper };
                w.message(`You pay Judan Hammerfel ${price}.`);
                w.message('Judan Hammerfel says, "There, the long sword is ready for combat."', { type: 'say' });
                w.state.equipment = [{ ...worn, condition: 100, durability: 88 }];
            }, 10);
        };
        return r;
    }

    test('repairItem hands a worn item to the smith, says yes and reports the price', async () => {
        const { w, bot } = atSmith('1 gold, 24 silver', 12_400, { player: makePlayer({ money: { copper: 0, silver: 0, gold: 2, mithril: 0, platinum: 0, totalCopper: 20_000 } }) });
        const r = await bot.repairItem(smith, worn);
        expect(r).toMatchObject({ success: true, cost: 12_400, item: { condition: 88 }, repaired: { condition: 100, durability: 88 } });
        expect(w.sentOf('moveItem')).toEqual([{ type: 'moveItem', fromSlot: 10, toSlot: 1210, count: undefined, reason: 'SDK' } as any]);
        expect(w.sentOf('respondDialog').map(a => a.accept)).toEqual([true]);
    });

    test('repairItem walks within reach of the smith first: a hand-over is 128 in 3D', async () => {
        const far = { ...smith, x: 561000 };
        const { w, bot } = atSmith('5 copper', 5, { nearbyNpcs: [far] });
        expect((await bot.repairItem('Judan', 10)).success).toBeTrue();
        expect(Math.hypot(far.x - w.player.x, far.y - w.player.y)).toBeLessThanOrEqual(128);
    });

    test('a price over maxCost or the purse is declined, and nothing is paid', async () => {
        const { w, bot } = atSmith('48 silver', 4800);
        expect(await bot.repairItem(smith, worn, { maxCost: 4799 })).toMatchObject({ success: false, reason: 'too_expensive', cost: 0 });
        expect(w.sentOf('respondDialog').map(a => a.accept)).toEqual([false]);
        w.player.money = { ...w.player.money, totalCopper: 100 };
        w.publish();
        expect((await bot.repairItem(smith, worn)).reason).toBe('insufficient_funds');
        expect(w.player.money.totalCopper).toBe(100);
    });

    test('a free repair is still a yes: starter gear has no price', async () => {
        const { w, bot } = atSmith('0 copper pieces', 0);
        expect(await bot.repairItem(smith, worn)).toMatchObject({ success: true, cost: 0 });
        expect(w.sentOf('respondDialog').map(a => a.accept)).toEqual([true]);
    });

    test.each([
        ['Your long sword is already in perfect condition.', 'no_need'],
        ['Judan Hammerfel says, "I can\'t repair that."', 'not_repairable'],
        ['Judan Hammerfel doesn\'t want stacked items.', 'not_repairable'],
        ['You are too far away to give anything to Judan Hammerfel.', 'out_of_range'],
    ])('no box comes after "%s"', async (line, reason) => {
        const { w, bot } = world({ nearbyNpcs: [smith], equipment: [worn] });
        w.handlers.moveItem = (_a, world) => { setTimeout(() => world.message(line), 10); };
        expect(await bot.repairItem(smith, worn)).toMatchObject({ success: false, reason, message: line });
        expect(w.sentOf('respondDialog')).toEqual([]);
    });

    test('a box already open is not the smith\'s answer: it stays unanswered', async () => {
        const { w, bot } = world({ nearbyNpcs: [smith], equipment: [worn], dialog: box('Otherguy has invited you to join his group.') });
        w.handlers.moveItem = () => undefined;
        expect((await bot.repairItem(smith, worn)).reason).toBe('no_response');
        expect(w.sentOf('respondDialog')).toEqual([]);
    });

    test('a repair box left open by a cut-off run gets a no first: answered late, it would make the smith forget the new item', async () => {
        const { w, bot } = atSmith('5 copper', 5);
        w.state.dialog = box('It will cost 9 gold to repair the old axe. Do you accept?');
        w.publish();
        expect(await bot.repairItem(smith, worn)).toMatchObject({ success: true, cost: 5 });
        expect(w.sentOf('respondDialog').map(a => a.accept)).toEqual([false, true]);
    });

    test('a yes the smith can no longer honour is his answer, not silence', async () => {
        const { w, bot } = atSmith('5 copper', 5);
        w.handlers.respondDialog = (_a, world) => {
            world.state.dialog = { ...world.state.dialog!, isOpen: false };
            setTimeout(() => world.message('Judan Hammerfel says, "I can\'t repair that."', { type: 'say' }), 10);
        };
        expect(await bot.repairItem(smith, worn)).toMatchObject({ success: false, reason: 'not_repairable', cost: 0 });
    });

    test('an NPC that takes nothing, or an unknown target, is a failure', async () => {
        const { w, bot } = world({ nearbyNpcs: [smith], equipment: [worn] });
        w.handlers.moveItem = () => undefined;
        expect((await bot.repairItem(smith, worn)).reason).toBe('no_response');
        expect((await bot.repairItem('nobody', worn)).reason).toBe('not_found');
        expect((await bot.repairItem(smith, 'no such item')).reason).toBe('not_found');
    });

    test('repairAll takes the box from a whisper and says when nothing needs it', async () => {
        const { w, bot } = world({ nearbyNpcs: [smith], equipment: [worn] });
        w.handlers.whisper = (_a, world) => { setTimeout(() => { world.state.dialog = box('It will cost 1 silver, 44 copper to repair everything. Do you accept?'); }, 10); };
        w.handlers.respondDialog = (_a, world) => {
            world.state.dialog = { ...world.state.dialog!, isOpen: false };
            setTimeout(() => {
                world.player.money = { ...world.player.money, totalCopper: world.player.money.totalCopper - 144 };
                world.message('Judan Hammerfel says, "There, the long sword is ready for combat."', { type: 'say' });
            }, 10);
        };
        expect(await bot.repairAll(smith)).toMatchObject({ success: true, cost: 144 });
        w.state.dialog = null;
        expect(await bot.repairAll(smith, { maxCost: 10 })).toMatchObject({ success: false, reason: 'too_expensive', cost: 0 });
        w.handlers.whisper = (_a, world) => { setTimeout(() => world.message('Judan Hammerfel says, "All items are fully repaired already."', { type: 'say' }), 10); };
        expect(await bot.repairAll(smith)).toMatchObject({ success: true, cost: 0 });
    }, 20_000);
});

describe('the vault', () => {
    const keeper = makeNpc({ objectId: 211, name: 'Lord Urqhart', guildName: 'Vault Keeper', role: 'vault', realm: 'albion', isPeaceful: true, x: 560050, y: 511000 });
    const axe: InventoryItem = { slot: 40, name: 'Dragonmight', level: 51, count: 1, model: 3, objectType: 17, hand: 0, condition: 100, durability: 100, quality: 100, weight: 30, value1: 165, value2: 37 };

    /** A keeper that opens the window, and moves that go where the server would put them. */
    function atKeeper(overrides: Partial<BotWorldState> = {}) {
        const r = world({ nearbyNpcs: [keeper], inventory: [axe], vault: [], vaultOpenedAt: null, ...overrides });
        r.w.handlers.interact = (_a, w) => { setTimeout(() => { w.state.vaultOpenedAt = Date.now(); }, 10); };
        r.w.handlers.moveItem = (a, w) => {
            if (a.type !== 'moveItem' || a.toSlot !== 601) return;
            setTimeout(() => {
                const from = [...w.state.inventory, ...w.state.vault].find(i => i.slot === a.fromSlot)!;
                if (a.fromSlot < 110) {
                    w.state.inventory = w.state.inventory.filter(i => i.slot !== a.fromSlot);
                    w.state.vault = [...w.state.vault, { ...from, slot: 110 + w.state.vault.length }];
                } else {
                    w.state.vault = w.state.vault.filter(i => i.slot !== a.fromSlot);
                    w.state.inventory = [...w.state.inventory, { ...from, slot: 40 + w.state.inventory.length }];
                }
            }, 10);
        };
        return r;
    }

    test('openVault succeeds on an empty vault: the window itself is the answer', async () => {
        const { bot, sdk } = atKeeper();
        expect(await bot.openVault(keeper)).toMatchObject({ success: true, items: [], keeper: { name: 'Lord Urqhart' } });
        expect(sdk.getState()?.vaultOpenedAt).toBeGreaterThan(0);
    });

    test('openVault waits past a keeper that speaks first: Jarl Yuliwyf has a line before the window', async () => {
        const jarl = { ...keeper, name: 'Jarl Yuliwyf' };
        const { w, bot } = atKeeper({ nearbyNpcs: [jarl] });
        w.handlers.interact = (_a, world) => {
            setTimeout(() => {
                world.state.npcDialog = { npcObjectId: jarl.objectId, npcName: jarl.name, text: 'As you entrust your precious belongings to me, I shall guard them with my life.', keywords: [], receivedAt: Date.now() };
                world.message('Jarl Yuliwyf says, "As you entrust your precious belongings to me, I shall guard them with my life."', { type: 'say' });
            }, 10);
            setTimeout(() => { world.state.vaultOpenedAt = Date.now(); }, 80);
        };
        expect(await bot.openVault(jarl)).toMatchObject({ success: true, items: [] });
    });

    test('openVault fails for an NPC that doesn\'t open one, and on a client too old to say', async () => {
        const { w, bot } = atKeeper();
        w.handlers.interact = (_a, world) => { setTimeout(() => world.message('Lord Urqhart says, "Hail."', { type: 'say' }), 10); };
        expect((await bot.openVault(keeper)).reason).toBe('not_a_vault_keeper');
        expect((await bot.openVault('nobody')).reason).toBe('not_found');
        const old = world({ nearbyNpcs: [keeper] });
        expect((await old.bot.openVault(keeper)).reason).toBe('unknown_action');
    });

    test('depositItem puts it in through the server-chosen slot, and withdrawItem takes it back', async () => {
        const { w, bot, sdk } = atKeeper();
        expect((await bot.depositItem(keeper, 'Dragonmight')).success).toBeTrue();
        expect(w.sentOf('moveItem').map(a => [a.fromSlot, a.toSlot])).toEqual([[40, 601]]);
        expect(sdk.getInventory().map(i => i.name)).toEqual([]);
        expect(sdk.getVault().map(i => [i.slot, i.name])).toEqual([[110, 'Dragonmight']]);
        expect((await bot.withdrawItem(keeper, /Dragon/)).success).toBeTrue();
        expect(w.sentOf('moveItem').map(a => [a.fromSlot, a.toSlot])[1]).toEqual([110, 601]);
        expect(sdk.getVault()).toEqual([]);
        expect(sdk.getInventory().map(i => i.name)).toEqual(['Dragonmight']);
    });

    test('a full vault, a full backpack and a missing item are refused without moving anything', async () => {
        const full = Array.from({ length: 40 }, (_, i) => ({ ...axe, slot: 110 + i, name: `relic ${i}` }));
        const a = atKeeper({ vault: full });
        expect((await a.bot.depositItem(keeper, axe)).reason).toBe('vault_full');
        expect((await a.bot.depositItem(keeper, 'banana')).reason).toBe('not_found');
        expect((await a.bot.withdrawItem(keeper, 'banana')).reason).toBe('not_found');
        const bags = Array.from({ length: 40 }, (_, i) => ({ ...axe, slot: 40 + i, name: `loot ${i}` }));
        const b = atKeeper({ inventory: bags, vault: [{ ...axe, slot: 110 }] });
        expect((await b.bot.withdrawItem(keeper, 110)).reason).toBe('inventory_full');
        expect([...a.w.sentOf('moveItem'), ...b.w.sentOf('moveItem')]).toEqual([]);
    });

    test('a stack can still merge into a full vault or a full backpack', async () => {
        const arrows = { ...axe, slot: 41, name: 'arrows', count: 10, objectType: 43 };
        const full = Array.from({ length: 39 }, (_, i) => ({ ...axe, slot: 110 + i, name: `relic ${i}` }));
        const a = atKeeper({ inventory: [arrows], vault: [...full, { ...arrows, slot: 149, count: 15 }] });
        a.w.handlers.moveItem = (_m, world) => {
            setTimeout(() => {
                world.state.inventory = [{ ...arrows, count: 5 }];
                world.state.vault = [...full, { ...arrows, slot: 149, count: 20 }];
            }, 10);
        };
        expect((await a.bot.depositItem(keeper, arrows)).success).toBeTrue();
        expect(a.sdk.getInventory().map(i => i.count)).toEqual([5]);
    });

    test('a silent refusal runs out the clock instead of reporting a deposit', async () => {
        const { w, bot } = atKeeper();
        w.handlers.moveItem = () => undefined;
        expect((await bot.depositItem(keeper, axe)).reason).toBe('timeout');
    }, 8000);
});

describe('trainSpec', () => {
    test('trains through the trainer window and observes the level', async () => {
        const trainer = makeNpc({ objectId: 210, name: 'Master Graent', role: 'trainer', realm: 'albion', x: 560080, y: 511000 });
        const { w, bot } = world({ nearbyNpcs: [trainer] });
        w.handlers.openTrainer = (_a, world) => {
            world.state.trainer = { isOpen: true, specPoints: 3, receivedAt: world.state.tick, specs: [{ index: 0, name: 'Slash', level: 2, nextLevelCost: 3 }] };
        };
        w.handlers.trainSpec = (a, world) => {
            if (a.type !== 'trainSpec') return;
            setTimeout(() => {
                world.state.skills = { ...world.state.skills, specializations: [{ name: 'Slash', level: 2 + (a.levels ?? 1), internalId: 1, bonus: 0 }] };
                world.player.specPoints = 0;
            }, 10);
        };
        const r = await bot.trainSpec('Graent', 'slash');
        expect(r).toMatchObject({ success: true, spec: 'Slash', fromLevel: 2, toLevel: 3, specPointsLeft: 0 });
        expect(w.sentOf('setTarget')[0]!.objectId).toBe(210);
        expect((await bot.trainSpec('Graent', 'Polearm')).reason).toBe('spec_not_found');
    });

    const spec = (name: string, internalId: number) => ({ name, level: 1, internalId, bonus: 0 });
    const raise = (world: FakeWorld, name: string, level: number) => {
        world.state.skills = { ...world.state.skills, specializations: world.state.skills.specializations.map(s => (s.name === name ? { ...s, level } : s)) };
    };
    /** A trainer in reach and these lines; `window` is what the trainer window lists (the server sends display names). */
    const atTrainer = (lines: string[], window = lines) => {
        const trainer = makeNpc({ objectId: 210, name: 'Master Graent', role: 'trainer', realm: 'albion', x: 560080, y: 511000 });
        const { w, bot } = world({ nearbyNpcs: [trainer], skills: { ...makeState().skills, specializations: lines.map(spec) } });
        w.handlers.openTrainer = (_a, world) => {
            world.state.trainer = { isOpen: true, specPoints: 90, receivedAt: world.state.tick, specs: window.map((name, index) => ({ index, name, level: 1, nextLevelCost: 2 })) };
        };
        return { w, bot };
    };

    test('a window from before a promotion is not trained by: a new one is asked for and its index used', async () => {
        const lines = ['Mending', 'Subterranean', 'Augmentation'];
        const { w, bot } = atTrainer(lines);
        // What a Seer's window showed at Korgan, still open after the whisper: a promotion sends none.
        w.state.trainer = { isOpen: true, specPoints: 33, receivedAt: 1, trainerObjectId: 210, specs: [{ index: 0, name: 'Mending', level: 1, nextLevelCost: 2 }, { index: 1, name: 'Augmentation', level: 2, nextLevelCost: 3 }] };
        w.handlers.openTrainer = (_a, world) => {
            setTimeout(() => { world.state.trainer = { isOpen: true, specPoints: 33, receivedAt: 2, specs: lines.map((name, index) => ({ index, name, level: name === 'Augmentation' ? 2 : 1, nextLevelCost: 2 })) }; }, 30);
        };
        w.handlers.trainSpec = (a, world) => { if (a.type === 'trainSpec') setTimeout(() => raise(world, lines[a.specIndex]!, 5), 10); };
        raise(w, 'Augmentation', 2);
        w.publish();
        const r = await bot.trainSpec('Graent', 'Augmentation', 3);
        expect(w.sentOf('trainSpec')).toEqual([expect.objectContaining({ specIndex: 2, levels: 3 })]);
        expect(r).toMatchObject({ success: true, spec: 'Augmentation', fromLevel: 2, toLevel: 5 });
        expect(w.state.skills.specializations.find(s => s.name === 'Subterranean')!.level).toBe(1);
    });

    test('no new window: /train, by name, and never the old one\'s index', async () => {
        const { w, bot } = atTrainer(['Mending', 'Augmentation']);
        w.state.trainer = { isOpen: true, specPoints: 33, receivedAt: 1, specs: [{ index: 0, name: 'Augmentation', level: 1, nextLevelCost: 2 }] };
        w.handlers.openTrainer = () => undefined;
        w.handlers.command = (a, world) => { if (a.type === 'command') setTimeout(() => raise(world, 'Augmentation', 2), 10); };
        const r = await bot.trainSpec('Graent', 'Augmentation');
        expect(w.sentOf('trainSpec')).toEqual([]);
        expect(w.sentOf('command').map(a => a.command)).toEqual(['/train Augmentation 2']);
        expect(r).toMatchObject({ success: true, toLevel: 2 });
    }, 8000);

    describe('with no trainer', () => {
        /** Where it stands, with no NPC about, on a server with allow_train_anywhere on (train.cs:143) or off (:150). */
        const standing = (lines: string[], anywhere = true) => {
            const { w, bot } = world({ skills: { ...makeState().skills, specializations: lines.map(spec) } });
            const wanted = 'You must select a valid trainer for your class.';
            w.handlers.openTrainer = (_a, world) => {
                if (!anywhere) { setTimeout(() => world.message(wanted), 10); return; }
                world.state.trainer = { isOpen: true, specPoints: 90, receivedAt: world.state.tick, specs: lines.map((name, index) => ({ index, name, level: 1, nextLevelCost: 2 })) };
            };
            w.handlers.trainSpec = (a, world) => { if (a.type === 'trainSpec') setTimeout(() => raise(world, lines[a.specIndex]!, 1 + (a.levels ?? 1)), 10); };
            return { w, bot };
        };

        test('it trains where it stands, by the window, with no target and no walk', async () => {
            const { w, bot } = standing(['Slash', 'Polearm']);
            const r = await bot.trainSpec(null, 'Polearm', 4);
            expect(r).toMatchObject({ success: true, spec: 'Polearm', fromLevel: 1, toLevel: 5 });
            expect(w.sentOf('trainSpec')).toEqual([expect.objectContaining({ specIndex: 1, levels: 4 })]);
            expect(w.sentOf('setTarget')).toEqual([]);
            expect(w.sentOf('moveTo')).toEqual([]);
        });

        test('a server with allow_train_anywhere off: needs_trainer, at once, and no /train after it', async () => {
            const { w, bot } = standing(['Slash', 'Polearm'], false);
            const started = Date.now();
            const r = await bot.trainSpec(null, 'Polearm');
            expect(r).toMatchObject({ success: false, reason: 'needs_trainer', message: 'You must select a valid trainer for your class.', spec: 'Polearm', toLevel: 1 });
            expect(Date.now() - started).toBeLessThan(2000);
            expect(w.sentOf('trainSpec')).toEqual([]);
            expect(w.sentOf('command')).toEqual([]);
        });

        test('a trainer named and not of the class, the same words, stays refused', async () => {
            const { w, bot } = atTrainer(['Slash']);
            w.handlers.openTrainer = (_a, world) => { setTimeout(() => world.message('You must select a valid trainer for your class.'), 10); };
            expect(await bot.trainSpec('Graent', 'Slash')).toMatchObject({ success: false, reason: 'refused' });
            expect(w.sentOf('command')).toEqual([]);
        });

        test('a name that is no NPC is still not_found: only null means no trainer', async () => {
            const { w, bot } = standing(['Slash']);
            expect(await bot.trainSpec('Nobody', 'Slash')).toMatchObject({ success: false, reason: 'not_found' });
            expect(w.sent).toEqual([]);
        });
    });

    test.each([
        ['Shield', 'Shield', 2], ['Shields', 'Shield', 2], ['shields', 'Shield', 2],
        ['Light', 'Light Magic', 0], ['Light Magic', 'Light Magic', 0], ['Mana', 'Mana Magic', 2],
        ['Cave Magic', 'Subterranean', 1], ['Subterranean', 'Subterranean', 1],
    ])('%s trains %s by its window index', async (asked, shown, index) => {
        const lines = shown === 'Shield' ? ['Slash', 'Thrust', 'Shield', 'Parry'] : shown === 'Subterranean' ? ['Mending', 'Subterranean', 'Augmentation'] : ['Light Magic', 'Mentalism', 'Mana Magic'];
        const { w, bot } = atTrainer(lines);
        w.handlers.trainSpec = (a, world) => { if (a.type === 'trainSpec') setTimeout(() => raise(world, lines[a.specIndex]!, 2), 10); };
        const r = await bot.trainSpec('Graent', asked);
        expect(r).toMatchObject({ success: true, spec: shown, fromLevel: 1, toLevel: 2 });
        expect(w.sentOf('trainSpec')).toEqual([expect.objectContaining({ specIndex: index, levels: 1 })]);
        expect(w.sentOf('command')).toEqual([]);
    });

    // train.cs:57-66: the first KeyName with this prefix, else "could not be found". So 'Light Magic' finds nothing.
    const KEYS = ['Light', 'LightTankCareer', 'Mana', 'Mentalism', 'Shields', 'Void'];
    test.each([
        ['Light Magic', '/train Light 2'], ['Light', '/train Light 2'],
        ['Mana Magic', '/train Mana 2'], ['Void Magic', '/train Void 2'],
        ['Shield', '/train Shields 2'], ['Shields', '/train Shields 2'],
    ])('with the line missing from the window, %s goes to /train under its key', async (asked, command) => {
        const line = asked.startsWith('Shield') ? 'Shield' : asked.startsWith('Light') ? 'Light Magic' : asked.startsWith('Mana') ? 'Mana Magic' : 'Void Magic';
        const { w, bot } = atTrainer([line], ['Slash']);
        w.handlers.command = (a, world) => {
            if (a.type !== 'command') return;
            const [, name, level] = /^\/train (.+) (\d+)$/.exec(a.command)!;
            const key = KEYS.find(k => k.toLowerCase().startsWith(name!.toLowerCase()));
            setTimeout(() => (key ? raise(world, line, Number(level)) : world.message('The provided skill could not be found.')), 10);
        };
        const r = await bot.trainSpec('Graent', asked);
        expect(w.sentOf('command').map(a => a.command)).toEqual([command]);
        expect(r).toMatchObject({ success: true, spec: line, toLevel: 2 });
    });

    test('a name no line answers to says which lines there are, and sends nothing', async () => {
        const { w, bot } = atTrainer(['Darkness', 'Suppression', 'Runecarving']);
        const r = await bot.trainSpec('Graent', 'Runes of Darkness');
        expect(r.reason).toBe('spec_not_found');
        expect(r.message).toContain('Darkness, Suppression, Runecarving');
        expect(w.sentOf('openTrainer')).toEqual([]);
        expect(w.sentOf('command')).toEqual([]);
        expect((await bot.trainSpec('Graent', 'constructor')).reason).toBe('spec_not_found');
    });
});

/** Lines at these levels, as the skill list names them. */
const specLines = (lines: Record<string, number>) => Object.entries(lines).map(([name, level], i) => ({ name, level, internalId: i, bonus: 0 }));
const graent = (x = 560080) => makeNpc({ objectId: 210, name: 'Master Graent', role: 'trainer', realm: 'hibernia', x, y: 511000 });
/** What a server's 0x7B does: the window as things stand, with a stamp a fresh one can be told by. */
let windowStamp = 0;
const openWindow = (world: FakeWorld) => {
    world.state.trainer = {
        isOpen: true, specPoints: world.player.specPoints, receivedAt: ++windowStamp,
        specs: world.state.skills.specializations.map((s, index) => ({ index, name: s.name, level: s.level, nextLevelCost: s.level + 1 })),
    };
};

describe('trainBuild', () => {
    const NUKER: Build = {
        className: 'Enchanter', name: 'Test nuker',
        targets: [{ level: 24, specs: { Mana: 16, Light: 7, Enchantments: 5 } }, { level: 50, specs: { Mana: 44, Light: 20, Enchantments: 5 } }],
    };
    const ENCHANTER_LINES = { 'Light Magic': 1, 'Mana Magic': 12, Enchantments: 1 };
    const enchanter = (points: number, level = 20) => ({ className: 'Enchanter', realm: 'hibernia' as const, level, specPoints: points });

    /** A trainer in reach and a server pricing as train.cs:115 does: a level costs its number, and nothing up to `free` on a line. */
    const atTrainer = (player: Partial<PlayerState>, lines: Record<string, number>, free: Record<string, number> = {}, trainer = graent()) => {
        const { w, bot } = world({ player: makePlayer(player), nearbyNpcs: [trainer], skills: { ...makeState().skills, specializations: specLines(lines) } });
        w.handlers.openTrainer = (_a, world) => openWindow(world);
        w.handlers.trainSpec = (a, world) => {
            if (a.type !== 'trainSpec') return;
            setTimeout(() => {
                const spec = world.state.skills.specializations[a.specIndex]!;
                const to = spec.level + (a.levels ?? 1);
                let cost = 0;
                for (let l = spec.level + 1; l <= to; l++) if (l > (free[spec.name] ?? 0)) cost += l;
                if (cost > world.player.specPoints) return world.message(`That specialization costs ${spec.level + 1} specialization points! You don't have that many specialization points left for this level.`);
                world.player.specPoints -= cost;
                world.state.skills = { ...world.state.skills, specializations: world.state.skills.specializations.map(s => (s === spec ? { ...s, level: to } : s)) };
                openWindow(world);
                world.message('Training complete!');
            }, 10);
        };
        return { w, bot };
    };

    test('raises the lines in the listed order, several levels at once, under the KeyName', async () => {
        const { w, bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
        const r = await bot.trainBuild('Graent', NUKER);
        expect(w.sentOf('trainSpec')).toEqual([
            expect.objectContaining({ specIndex: 1, levels: 4 }),
            expect.objectContaining({ specIndex: 0, levels: 6 }),
            expect.objectContaining({ specIndex: 2, levels: 4 }),
        ]);
        expect(r).toMatchObject({
            success: true, build: 'Test nuker', done: true, waiting: null, over: [], specPointsLeft: 1,
            trained: [{ spec: 'Mana', fromLevel: 12, toLevel: 16 }, { spec: 'Light', fromLevel: 1, toLevel: 7 }, { spec: 'Enchantments', fromLevel: 1, toLevel: 5 }],
            message: 'Mana 12 → 16, Light 1 → 7, Enchantments 1 → 5, on target for level 20',
        });
    });

    test('out of points on a line it waits there, and a cheaper line further down stays as it is', async () => {
        const { w, bot } = atTrainer(enchanter(45), ENCHANTER_LINES);
        const r = await bot.trainBuild('Graent', NUKER);
        expect(w.sentOf('trainSpec')).toEqual([expect.objectContaining({ specIndex: 1, levels: 3 })]);
        expect(r).toMatchObject({ success: true, done: false, waiting: { spec: 'Mana', cost: 16, points: 3 }, specPointsLeft: 3, message: 'Mana 12 → 15, saving for Mana 16: 3/16 points' });
        expect(w.state.skills.specializations.map(s => s.level)).toEqual([1, 15, 1]);
    });

    test('with nothing it can pay for, nothing is sent and no trainer is needed', async () => {
        const { w, bot } = atTrainer(enchanter(3), ENCHANTER_LINES);
        const r = await bot.trainBuild('Nobody', NUKER);
        expect(r).toMatchObject({ success: true, done: false, trained: [], waiting: { spec: 'Mana', cost: 13, points: 3 }, message: 'Saving for Mana 13: 3/13 points' });
        expect(w.sent).toEqual([]);
    });

    test('done: every line at its target, or as high as the level goes', async () => {
        // Levels the server could hold: Mana 10 is all 54 points an Enchanter has at 10 (else specsAddUp asks for a window).
        const build: Build = { className: 'Enchanter', name: 'Mana first', targets: [{ level: 24, specs: { Mana: 16, Light: 1, Enchantments: 1 } }] };
        const { w, bot } = atTrainer(enchanter(0, 10), { 'Light Magic': 1, 'Mana Magic': 10, Enchantments: 1 });
        const r = await bot.trainBuild('Nobody', build);
        expect(r).toMatchObject({ success: true, done: true, waiting: null, trained: [], specPointsLeft: 0, message: 'On target for level 10' });
        expect(w.sent).toEqual([]);
    });

    describe('points the server has not sent yet (a promotion sends none, GameTrainer.cs:335-349)', () => {
        const AT_TARGET = { 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 };
        /** Talking to the trainer sends the real number (GameTrainer.cs:134). */
        const talkBrings = (w: FakeWorld, points: number) => {
            w.handlers.interact = (_a, world) => { setTimeout(() => { world.player.specPoints = points; }, 10); };
        };

        test('a wait on stale points: it talks to the trainer, reads the real number and trains', async () => {
            const { w, bot } = atTrainer(enchanter(0), ENCHANTER_LINES);
            talkBrings(w, 45);
            const r = await bot.trainBuild('Graent', NUKER);
            expect(w.sentOf('interact')).toEqual([expect.objectContaining({ objectId: 210 })]);
            expect(w.sent.findIndex(a => a.type === 'interact')).toBeLessThan(w.sent.findIndex(a => a.type === 'trainSpec'));
            expect(r).toMatchObject({ success: true, trained: [{ spec: 'Mana', fromLevel: 12, toLevel: 15 }], specPointsLeft: 3, message: 'Mana 12 → 15, saving for Mana 16: 3/16 points' });
        });

        test('a real wait: one interact, nothing trained, and no second one on this call', async () => {
            const { w, bot } = atTrainer(enchanter(3), ENCHANTER_LINES);
            const r = await bot.trainBuild('Graent', NUKER);
            expect(w.sent.map(a => a.type)).toEqual(['interact']);
            expect(r).toMatchObject({ success: true, done: false, trained: [], waiting: { spec: 'Mana', cost: 13, points: 3 }, message: 'Saving for Mana 13: 3/13 points' });
        });

        test('a new number that still falls short is what the wait reports, after one interact', async () => {
            const { w, bot } = atTrainer(enchanter(0), ENCHANTER_LINES);
            talkBrings(w, 5);
            const r = await bot.trainBuild('Graent', NUKER);
            expect(w.sent.map(a => a.type)).toEqual(['interact']);
            expect(r).toMatchObject({ trained: [], waiting: { spec: 'Mana', cost: 13, points: 5 }, specPointsLeft: 5 });
        });

        test('a trainer out of reach gets nothing, and the number stands', async () => {
            const { w, bot } = atTrainer(enchanter(3), ENCHANTER_LINES, {}, graent(561500));
            expect(await bot.trainBuild('Graent', NUKER)).toMatchObject({ success: true, trained: [], waiting: { spec: 'Mana', cost: 13, points: 3 } });
            expect(w.sent).toEqual([]);
        });

        test('done sends nothing, with a trainer in reach', async () => {
            const { w, bot } = atTrainer(enchanter(3), AT_TARGET);
            expect(await bot.trainBuild('Graent', NUKER)).toMatchObject({ success: true, done: true, trained: [] });
            expect(w.sent).toEqual([]);
        });

        test('a wait reached after training something needs no interact: the raise brought the number', async () => {
            const { w, bot } = atTrainer(enchanter(45), ENCHANTER_LINES);
            expect(await bot.trainBuild('Graent', NUKER)).toMatchObject({ waiting: { spec: 'Mana', cost: 16, points: 3 }, trained: [{ spec: 'Mana', fromLevel: 12, toLevel: 15 }] });
            expect(w.sentOf('interact')).toEqual([]);
        });
    });

    // After a GM's /player class the server's skill list keeps the old spec objects for the session: its cache swaps an
    // entry only when `!=` says so, and Skill's `!=` compares IDs (GamePlayerUtils.cs:650, Skill.cs:97-118). So 0x16
    // carries the old levels and never a raise of those lines, while the trainer window (PacketLib1105.cs:36-52) reads
    // the live ones. Seen live: a Viking made a Warrior trained Parry 1 → 16 and its skill list still read Parry 1.
    describe('a skill list the server leaves stale, and a window that is right', () => {
        /** The server's real levels apart from the skill list, which never changes. */
        const staleServer = (player: Partial<PlayerState>, shown: Record<string, number>, real: Record<string, number>) => {
            const { w, bot } = world({ player: makePlayer(player), nearbyNpcs: [graent()], skills: { ...makeState().skills, specializations: specLines(shown) } });
            const names = Object.keys(shown);
            const window = (world: FakeWorld) => {
                world.state.trainer = { isOpen: true, specPoints: world.player.specPoints, receivedAt: ++windowStamp, specs: names.map((name, index) => ({ index, name, level: real[name]!, nextLevelCost: real[name]! + 1 })) };
            };
            w.handlers.openTrainer = (_a, world) => window(world);
            w.handlers.trainSpec = (a, world) => {
                if (a.type !== 'trainSpec') return;
                setTimeout(() => {
                    const name = names[a.specIndex]!;
                    const to = real[name]! + (a.levels ?? 1);
                    let cost = 0;
                    for (let l = real[name]! + 1; l <= to; l++) cost += l;
                    if (cost > world.player.specPoints) return world.message(`That specialization costs ${real[name]! + 1} specialization points! You don't have that many specialization points left for this level.`);
                    world.player.specPoints -= cost;
                    real[name] = to;
                    // TrainCommandHandler.SendUpdates (train.cs:169-170): the skill list, here unchanged, then the window.
                    window(world);
                    world.message('Training complete!');
                }, 10);
            };
            return { w, bot };
        };

        test('a raise the window shows counts, though the skill list never moves', async () => {
            const real = { 'Light Magic': 1, 'Mana Magic': 12, Enchantments: 1 };
            const { bot } = staleServer(enchanter(100), ENCHANTER_LINES, real);
            const r = await bot.trainBuild(null, NUKER);
            expect(r).toMatchObject({
                success: true, done: true, specPointsLeft: 1,
                trained: [{ spec: 'Mana', fromLevel: 12, toLevel: 16 }, { spec: 'Light', fromLevel: 1, toLevel: 7 }, { spec: 'Enchantments', fromLevel: 1, toLevel: 5 }],
            });
            expect(real).toEqual({ 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 });
        });

        test('a line the skill list shows on target and the window shows at 1 is trained from 1', async () => {
            const real = { 'Light Magic': 1, 'Mana Magic': 1, Enchantments: 1 };
            const { w, bot } = staleServer(enchanter(200), { 'Light Magic': 1, 'Mana Magic': 16, Enchantments: 1 }, real);
            const r = await bot.trainBuild(null, NUKER);
            expect(r).toMatchObject({ success: true, done: true, specPointsLeft: 24 });
            expect(r.trained).toContainEqual({ spec: 'Mana', fromLevel: 1, toLevel: 16 });
            expect(w.sentOf('trainSpec')).toContainEqual(expect.objectContaining({ specIndex: 1, levels: 15 }));
            expect(real).toEqual({ 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 });
        });

        // Live: a Naturalist made a Druid at 24 read Nurture 20, Regrowth 13 with all 299 points unspent, and was "on target".
        test('every line on target by the list, with the points of none spent: it asks for the window and trains', async () => {
            const real = { 'Light Magic': 1, 'Mana Magic': 1, Enchantments: 1 };
            // An Enchanter's 209 points at level 20 (VerifySpecPoints), and lines that would have cost 176 of them.
            const { w, bot } = staleServer(enchanter(209), { 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 }, real);
            const r = await bot.trainBuild(null, NUKER);
            expect(w.sentOf('openTrainer').length).toBeGreaterThan(0);
            expect(r).toMatchObject({ success: true, done: true, specPointsLeft: 33 });
            expect(real).toEqual({ 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 });
        });

        test('a line the list shows lower than it is: the steps count from the window, not past the target', async () => {
            const real = { 'Light Magic': 1, 'Mana Magic': 14, Enchantments: 1 };
            const { w, bot } = staleServer(enchanter(100), ENCHANTER_LINES, real);
            const r = await bot.trainBuild(null, NUKER);
            expect(w.sentOf('trainSpec')[0]).toEqual(expect.objectContaining({ specIndex: 1, levels: 2 }));
            expect(r.trained[0]).toEqual({ spec: 'Mana', fromLevel: 14, toLevel: 16 });
            expect(real).toEqual({ 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 });
        });

        test('levels the points can pay for are believed: done sends nothing', async () => {
            const { w, bot } = staleServer(enchanter(33), { 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 }, { 'Light Magic': 7, 'Mana Magic': 16, Enchantments: 5 });
            expect(await bot.trainBuild(null, NUKER)).toMatchObject({ success: true, done: true, trained: [] });
            expect(w.sent).toEqual([]);
        });
    });

    test('stops at a failed trainSpec with its reason, and says what it raised first', async () => {
        const { w, bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
        const honest = w.handlers.trainSpec!;
        w.handlers.trainSpec = (a, world) => {
            if (a.type === 'trainSpec' && a.specIndex === 0) setTimeout(() => world.message('You must select a valid trainer for your class.'), 10);
            else return honest(a, world);
        };
        const r = await bot.trainBuild('Graent', NUKER);
        expect(r).toMatchObject({
            success: false, reason: 'refused', done: false, waiting: null, specPointsLeft: 42,
            trained: [{ spec: 'Mana', fromLevel: 12, toLevel: 16 }],
            message: 'Mana 12 → 16, then: You must select a valid trainer for your class.',
        });
        expect(w.sentOf('trainSpec')).toHaveLength(2);
    });

    test('a line the server raised only part of the way still counts as raised', async () => {
        const { w, bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
        // train.cs:107-124 trains what the points allow, then says it can't go on.
        w.handlers.trainSpec = (a, world) => {
            if (a.type !== 'trainSpec') return;
            setTimeout(() => {
                world.state.skills = { ...world.state.skills, specializations: world.state.skills.specializations.map((l, i) => (i === a.specIndex ? { ...l, level: l.level + 2 } : l)) };
                world.message("That specialization costs 15 specialization points! You don't have that many specialization points left for this level.");
            }, 10);
        };
        expect(await bot.trainBuild('Graent', NUKER)).toMatchObject({ success: false, reason: 'refused', trained: [{ spec: 'Mana', fromLevel: 12, toLevel: 14 }] });
    });

    describe('with no trainer, where it stands', () => {
        test('spends as far as the points reach, with no target and no walk', async () => {
            const { w, bot } = atTrainer(enchanter(45), ENCHANTER_LINES, {}, graent(561500));
            const r = await bot.trainBuild(null, NUKER);
            expect(r).toMatchObject({ success: true, trained: [{ spec: 'Mana', fromLevel: 12, toLevel: 15 }], specPointsLeft: 3, waiting: { spec: 'Mana', cost: 16, points: 3 } });
            expect(w.sentOf('setTarget')).toEqual([]);
            expect(w.sentOf('moveTo')).toEqual([]);
        });

        test('a wait sends nothing: there is nobody to talk to', async () => {
            const { w, bot } = atTrainer(enchanter(3), ENCHANTER_LINES);
            expect(await bot.trainBuild(null, NUKER)).toMatchObject({ success: true, trained: [], waiting: { spec: 'Mana', cost: 13, points: 3 } });
            expect(w.sent).toEqual([]);
        });

        test('a server that wants a trainer: needs_trainer, for trainAtClassTrainer to walk on', async () => {
            const { w, bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
            w.handlers.openTrainer = (_a, world) => { setTimeout(() => world.message('You must select a valid trainer for your class.'), 10); };
            expect(await bot.trainBuild(null, NUKER)).toMatchObject({ success: false, reason: 'needs_trainer', trained: [] });
            expect(w.sentOf('trainSpec')).toEqual([]);
        });
    });

    test('a trainer that is not there fails only when there is something to train', async () => {
        const { bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
        expect(await bot.trainBuild('Nobody', NUKER)).toMatchObject({ success: false, reason: 'not_found', trained: [], build: 'Test nuker' });
    });

    test('no_build: no build passed and none in the bot folder', async () => {
        const { w, bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
        expect(await bot.trainBuild('Graent')).toMatchObject({ success: false, reason: 'no_build', build: null, trained: [], done: false, specPointsLeft: 100 });
        expect(w.sent).toEqual([]);
    });

    describe('the bot\'s own file', () => {
        let root = '';
        let cwd: { mockRestore(): void } | null = null;
        const ownBuild = (source: string) => {
            root = mkdtempSync(join(tmpdir(), 'daoc-trainbuild-'));
            mkdirSync(join(root, 'bots', 'tester'), { recursive: true });
            writeFileSync(join(root, 'bots', 'tester', 'bot.env'), '');
            writeFileSync(join(root, 'bots', 'tester', 'build.ts'), source);
            cwd = spyOn(process, 'cwd').mockReturnValue(root);
        };
        afterEach(() => {
            cwd?.mockRestore();
            cwd = null;
            rmSync(root, { recursive: true, force: true });
        });

        test('without a build it trains the one in bots/<bot>/build.ts', async () => {
            ownBuild(`export default { className: 'Enchanter', name: 'Own', targets: [{ level: 24, specs: { Light: 3 } }] };`);
            const { bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
            const r = await bot.trainBuild('Graent');
            expect(r).toMatchObject({ success: true, build: 'Own', done: true, trained: [{ spec: 'Light', fromLevel: 1, toLevel: 3 }] });
            expect(r.over).toEqual([{ spec: 'Mana', level: 12, target: 1 }]);
        });

        test('a broken file throws, naming it and the problem', async () => {
            ownBuild(`export default { className: 'Armsman', name: 'Typo', targets: [{ level: 24, specs: { Shield: 3 } }] };`);
            const { bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
            const failure = await bot.trainBuild('Graent').catch(e => e as Error);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain('build.ts');
            expect((failure as Error).message).toContain('Shield: use the KeyName Shields');
        });
    });

    test('invalid_build: a build passed in is checked as a file would be', async () => {
        const { w, bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
        const typo: Build = { className: 'Armsman', name: 'Typo', targets: [{ level: 24, specs: { Shield: 3 } }] };
        const r = await bot.trainBuild('Graent', typo);
        expect(r).toMatchObject({ success: false, reason: 'invalid_build', build: 'Typo' });
        expect(r.message).toContain('Shield: use the KeyName Shields');
        expect((await bot.trainBuild('Graent', { className: 'Armsman', name: 'Empty', targets: [] })).reason).toBe('invalid_build');
        expect(w.sent).toEqual([]);
    });

    test.each([
        ['another class', { className: 'Armsman', realm: 'albion' as const }, NUKER],
        ['the base class of another', { className: 'Fighter', realm: 'albion' as const }, NUKER],
        ['a name two realms share', { className: 'Rogue', realm: 'midgard' as const }, { className: 'Infiltrator', name: 'Sneak', targets: [{ level: 24, specs: { Stealth: 10 } }] }],
    ])('wrong_class: %s', async (_what, player, build) => {
        const { w, bot } = atTrainer(player, ENCHANTER_LINES);
        const r = await bot.trainBuild('Graent', build);
        expect(r).toMatchObject({ success: false, reason: 'wrong_class', build: build.name, trained: [] });
        expect(r.message).toContain(player.className);
        expect(w.sent).toEqual([]);
    });

    test('a base class trains the lines it has of its advanced class\'s build', async () => {
        const { bot } = atTrainer({ className: 'Magician', realm: 'hibernia', level: 3, specPoints: 12 }, { 'Light Magic': 1, 'Mana Magic': 1 });
        expect(await bot.trainBuild('Graent', NUKER)).toMatchObject({
            success: true, done: true, specPointsLeft: 2,
            trained: [{ spec: 'Mana', fromLevel: 1, toLevel: 3 }, { spec: 'Light', fromLevel: 1, toLevel: 3 }],
        });
    });

    describe('a build named by a class two realms share', () => {
        const SWORD: Build = { className: 'Rogue', name: 'K2', targets: [{ level: 4, specs: { Sword: 4 } }] };
        const STEALTH: Build = { className: 'MidgardRogue', name: 'K3', targets: [{ level: 4, specs: { Stealth: 2 } }] };
        const rogue = (realm: 'albion' | 'midgard') => atTrainer({ className: 'Rogue', realm, level: 4, specPoints: 9 }, { Sword: 1, Stealth: 1 });

        test('a Midgard Rogue\'s own build, named Rogue, goes by Midgard\'s Rogue', async () => {
            expect(await rogue('midgard').bot.trainBuild('Graent', SWORD)).toMatchObject({ success: true, done: true, trained: [{ spec: 'Sword', fromLevel: 1, toLevel: 4 }] });
        });

        test('its key says the same', async () => {
            expect(await rogue('midgard').bot.trainBuild('Graent', STEALTH)).toMatchObject({ success: true, done: true, trained: [{ spec: 'Stealth', fromLevel: 1, toLevel: 2 }] });
        });

        test('an Albion Rogue has no Sword, and no use for Midgard\'s key', async () => {
            expect(await rogue('albion').bot.trainBuild('Graent', SWORD)).toMatchObject({ success: false, reason: 'invalid_build' });
            expect(await rogue('albion').bot.trainBuild('Graent', STEALTH)).toMatchObject({ success: false, reason: 'wrong_class' });
        });
    });

    test('a base class of a realm that shares its name', async () => {
        const { bot } = atTrainer({ className: 'Rogue', realm: 'albion', level: 3, specPoints: 5 }, { Stealth: 1 });
        const build: Build = { className: 'Infiltrator', name: 'Sneak', targets: [{ level: 24, specs: { Stealth: 10 } }] };
        expect(await bot.trainBuild('Graent', build)).toMatchObject({ success: true, done: true, trained: [{ spec: 'Stealth', fromLevel: 1, toLevel: 3 }] });
    });

    test('a female class name is the same class', async () => {
        const { bot } = atTrainer({ ...enchanter(100), className: 'Enchantress' }, ENCHANTER_LINES);
        expect(await bot.trainBuild('Graent', NUKER)).toMatchObject({ success: true, done: true, specPointsLeft: 1 });
    });

    describe('autotrain', () => {
        const SLASHER: Build = { className: 'Armsman', name: 'Slasher', targets: [{ level: 24, specs: { Slash: 6 } }] };

        test.each(['Armsman', 'Armswoman'])('an %s pays only above its free levels', async className => {
            const { bot } = atTrainer({ className, realm: 'albion', level: 20, specPoints: 6 }, { Slash: 1 }, { Slash: 5 });
            expect(await bot.trainBuild('Graent', SLASHER)).toMatchObject({ success: true, done: true, specPointsLeft: 0, trained: [{ spec: 'Slash', fromLevel: 1, toLevel: 6 }] });
        });

        test('its base class has none yet and pays for every level', async () => {
            const { bot } = atTrainer({ className: 'Fighter', realm: 'albion', level: 20, specPoints: 6 }, { Slash: 1 });
            expect(await bot.trainBuild('Graent', SLASHER)).toMatchObject({
                success: true, done: false, specPointsLeft: 1, waiting: { spec: 'Slash', cost: 4, points: 1 }, trained: [{ spec: 'Slash', fromLevel: 1, toLevel: 3 }],
            });
        });
    });

    test('over: what is spent beyond the target, and a line left out has target 1', async () => {
        const build: Build = { className: 'Enchanter', name: 'Mana only', targets: [{ level: 24, specs: { Mana: 16, Light: 7 } }] };
        const { bot } = atTrainer(enchanter(0), { 'Light Magic': 12, 'Mana Magic': 16, Enchantments: 3 });
        const r = await bot.trainBuild('Graent', build);
        expect(r.over).toEqual([{ spec: 'Light', level: 12, target: 7 }, { spec: 'Enchantments', level: 3, target: 1 }]);
        expect(r).toMatchObject({ success: true, done: true });
        expect(r.message).toBe('On target for level 20. Over target: Light 12 (target 7), Enchantments 3 (target 1)');
    });

    test('over leaves free levels alone', async () => {
        const build: Build = { className: 'Armsman', name: 'Polearms', targets: [{ level: 24, specs: { Polearm: 2 } }] };
        const { bot } = atTrainer({ className: 'Armsman', realm: 'albion', level: 20, specPoints: 0 }, { Slash: 5, Polearm: 2 });
        expect((await bot.trainBuild('Graent', build)).over).toEqual([]);
    });

    test('a trainSpec that claims success and raises nothing cannot loop forever', async () => {
        const { bot } = atTrainer(enchanter(100), ENCHANTER_LINES);
        const train = spyOn(bot, 'trainSpec').mockResolvedValue({ success: true, message: 'ok', spec: 'Mana Magic', fromLevel: 12, toLevel: 12, specPointsLeft: 100 });
        const r = await bot.trainBuild('Graent', NUKER);
        expect(r).toMatchObject({ success: false, reason: 'too_many_steps', trained: [] });
        expect(train.mock.calls.length).toBe(32);
    });

    test('not in game', async () => {
        const { bot } = world({ player: null });
        expect(await bot.trainBuild('Graent', NUKER)).toMatchObject({ success: false, reason: 'not_in_game', build: 'Test nuker' });
    });
});

describe('respec', () => {
    const OFFER = 'CAUTION: All respec changes are final with no second chance. Proceed carefully!';
    const ENCHANTER_LINES = { 'Light Magic': 7, 'Mana Magic': 12, Enchantments: 5 };
    const box = (over: Partial<NonNullable<BotWorldState['dialog']>> = {}) => ({ isOpen: true, code: 7, data: [0, 0, 0, 0] as [number, number, number, number], type: 1, text: OFFER, receivedAt: Date.now(), ...over });
    const lineOf = (world: FakeWorld, name: string) => world.state.skills.specializations.find(s => s.name === name)!;

    /**
     * A trainer and a server answering as respec.cs does. /respec <line> takes the KeyName alone (GamePlayer.cs:3102).
     * On a yes the lines fall to `floor` (else 1) and their points come back, and the skills, the points and the window go out in that order.
     */
    const atTrainer = (player: Partial<PlayerState>, lines: Record<string, number>, floor: Record<string, number> = {}, trainer = graent()) => {
        const { w, bot } = world({ player: makePlayer(player), nearbyNpcs: [trainer], skills: { ...makeState().skills, specializations: specLines(lines) } });
        let line: string | null = null;
        w.handlers.command = (a, world) => {
            if (a.type !== 'command') return;
            const asked = /^\/respec (.+)$/.exec(a.command)![1]!;
            line = asked === 'all' ? null : asked;
            if (line && !world.state.skills.specializations.some(s => specKey(s.name).toLowerCase() === line!.toLowerCase())) {
                setTimeout(() => world.message(`No line with name '${line}' found.`), 10);
                return;
            }
            setTimeout(() => { world.state.dialog = box(); }, 10);
        };
        w.handlers.respondDialog = (a, world) => {
            if (a.type !== 'respondDialog') return;
            world.state.dialog = { ...world.state.dialog!, isOpen: false };
            if (!a.accept) return;
            setTimeout(() => {
                let regained = 0;
                const specializations = world.state.skills.specializations.map(s => {
                    if (line && specKey(s.name).toLowerCase() !== line.toLowerCase()) return s;
                    const to = floor[s.name] ?? 1;
                    for (let l = to + 1; l <= s.level; l++) regained += l;
                    return { ...s, level: to };
                });
                world.message(`You regain ${regained} specialization points!`);
                world.state.skills = { ...world.state.skills, specializations };
                world.player.specPoints += regained;
                openWindow(world);
                world.message('Your character has been saved.');
            }, 10);
        };
        return { w, bot };
    };
    const enchanter = { className: 'Enchanter', realm: 'hibernia' as const, level: 22, specPoints: 0 };

    test('all: targets the trainer, says yes and reports what came back', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        const r = await bot.respec('Graent');
        expect(w.sentOf('command').map(a => a.command)).toEqual(['/respec all']);
        expect(w.sentOf('setTarget')[0]!.objectId).toBe(210);
        expect(w.sent.findIndex(a => a.type === 'setTarget')).toBeLessThan(w.sent.findIndex(a => a.type === 'command'));
        expect(w.sentOf('respondDialog')).toEqual([expect.objectContaining({ accept: true })]);
        expect(r).toEqual({
            success: true, message: 'Regained 118 points: Light Magic 7 → 1, Mana Magic 12 → 1, Enchantments 5 → 1',
            regained: 118, specPointsLeft: 118,
            specs: [{ name: 'Light Magic', level: 1 }, { name: 'Mana Magic', level: 1 }, { name: 'Enchantments', level: 1 }],
        });
    });

    test.each([
        ['Mana', 'Mana Magic', '/respec Mana'], ['Mana Magic', 'Mana Magic', '/respec Mana'], ['mana magic', 'Mana Magic', '/respec Mana'], [/^mana/i, 'Mana Magic', '/respec Mana'],
        ['Light', 'Light Magic', '/respec Light'], ['Light Magic', 'Light Magic', '/respec Light'], ['Void Magic', 'Void Magic', '/respec Void'],
        ['Shield', 'Shield', '/respec Shields'], ['Shields', 'Shield', '/respec Shields'],
        ['Cave Magic', 'Subterranean', '/respec Subterranean'], ['Enchantment', 'Enchantments', '/respec Enchantments'],
    ])('one line by %s goes out under its KeyName', async (asked, shown, command) => {
        const { w, bot } = atTrainer(enchanter, { Other: 3, [shown]: 6 });
        const r = await bot.respec('Graent', asked);
        expect(w.sentOf('command').map(a => a.command)).toEqual([command]);
        expect(r).toMatchObject({ success: true, regained: 20, specPointsLeft: 20, specs: [{ name: 'Other', level: 3 }, { name: shown, level: 1 }] });
        expect(r.message).toBe(`Regained 20 points: ${shown} 6 → 1`);
    });

    test('regained is what the points rose by, whatever the server says', async () => {
        const { w, bot } = atTrainer({ ...enchanter, specPoints: 40 }, ENCHANTER_LINES);
        w.handlers.respondDialog = (_a, world) => {
            world.state.dialog = { ...world.state.dialog!, isOpen: false };
            world.message('You regain 999 specialization points!');
            setTimeout(() => {
                world.player.specPoints += 5;
                openWindow(world);
            }, 10);
        };
        expect(await bot.respec('Graent')).toMatchObject({ success: true, regained: 5, specPointsLeft: 45 });
    });

    test.each([
        ['nothing trained', enchanter, { 'Light Magic': 1, 'Mana Magic': 1 }, undefined],
        ['that line untrained', enchanter, { 'Light Magic': 1, 'Mana Magic': 9 }, 'Light Magic'],
        // RespecSingleLine puts an autotrain line at Level / 4 (GamePlayer.cs:3052-3056): nothing comes back from there.
        ['an autotrain line at its free levels', { className: 'Armsman', realm: 'albion' as const, level: 20 }, { Slash: 5, Thrust: 4, Crush: 1 }, undefined],
        ['that autotrain line at its free levels', { className: 'Armsman', realm: 'albion' as const, level: 20 }, { Slash: 5, Crush: 6 }, 'Slash'],
    ])('no_need: %s, and nothing is sent', async (_what, player, lines, line) => {
        const { w, bot } = atTrainer(player, lines);
        const r = await bot.respec('Graent', line);
        expect(r).toMatchObject({ success: false, reason: 'no_need', regained: 0 });
        expect(w.sent).toEqual([]);
    });

    test.each([
        ['an autotrain line above its free levels', { className: 'Armsman', realm: 'albion' as const, level: 20, specPoints: 0 }, { Slash: 6 }, { Slash: 5 }, 6],
        ['a line of a class with no autotrain', { ...enchanter, level: 20 }, { 'Light Magic': 2 }, {}, 2],
        // Level >= 8 at GamePlayer.cs:3052; a Fighter is no Armsman yet.
        ['an autotrain line below level 8', { className: 'Armsman', realm: 'albion' as const, level: 7, specPoints: 0 }, { Slash: 2 }, {}, 2],
        ['a base class line at any level', { className: 'Fighter', realm: 'albion' as const, level: 20, specPoints: 0 }, { Slash: 2 }, {}, 2],
    ])('not no_need: %s', async (_what, player, lines, floor, regained) => {
        const { bot } = atTrainer(player, lines, floor);
        expect(await bot.respec('Graent')).toMatchObject({ success: true, regained });
    });

    test.each([
        'You must be speaking with your trainer to respec.',
        "You don't seem to have any full skill respecs available.",
        "You don't seem to have any single-line respecs available.",
        "No line with name 'Mana' found.",
        'Level of Mana Magic line is less than 2. ',
    ])('refused: %s', async text => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        w.handlers.command = (_a, world) => { setTimeout(() => world.message(text), 10); };
        expect(await bot.respec('Graent')).toMatchObject({ success: false, reason: 'refused', message: text, regained: 0, specPointsLeft: 0 });
        expect(w.sentOf('respondDialog')).toEqual([]);
    });

    test.each([
        ['no box at all', undefined],
        ['the last box, closed', box({ isOpen: false, receivedAt: 1 })],
        ['a box about something else', box({ text: 'Bob has invited you to join\nhis group. Do you wish to join?', receivedAt: 1 })],
    ])('timeout: %s gets no answer', async (_what, dialog) => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        if (dialog) w.state.dialog = dialog;
        w.handlers.command = () => {};
        const r = await bot.respec('Graent');
        expect(r).toMatchObject({ success: false, reason: 'timeout', regained: 0 });
        expect(w.sentOf('respondDialog')).toEqual([]);
    }, 8000);

    test.each([
        ['about something else', { text: 'Bob has invited you to join\nhis group. Do you wish to join?' }],
        ['closed already', { isOpen: false }],
    ])('timeout: a new box %s gets no answer', async (_what, over) => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        w.handlers.command = (_a, world) => { setTimeout(() => { world.state.dialog = box(over); }, 10); };
        expect(await bot.respec('Graent')).toMatchObject({ success: false, reason: 'timeout', regained: 0 });
        expect(w.sentOf('respondDialog')).toEqual([]);
    }, 8000);

    test('a box that opens while another stays open is the one answered', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        w.state.dialog = box({ text: 'Bob has invited you to join\nhis group. Do you wish to join?', receivedAt: 1 });
        expect(await bot.respec('Graent')).toMatchObject({ success: true, regained: 118 });
        expect(w.sentOf('respondDialog')).toHaveLength(1);
    });

    test('a respec box left open by a cut-off run gets a no, then ours a yes', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        w.state.dialog = box({ receivedAt: 1 });
        expect(await bot.respec('Graent')).toMatchObject({ success: true, regained: 118 });
        expect(w.sent.flatMap<string | boolean>(a => (a.type === 'respondDialog' ? [a.accept] : a.type === 'command' ? [a.command] : []))).toEqual([false, '/respec all', true]);
    });

    test('the old box still reads open for a moment after its no: the yes waits for the new one', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        w.state.dialog = box({ receivedAt: 1 });
        const honest = w.handlers.respondDialog!;
        const answered: number[] = [];
        w.handlers.respondDialog = (a, world) => {
            answered.push(world.state.dialog!.receivedAt);
            if (a.type === 'respondDialog' && !a.accept) setTimeout(() => { world.state.dialog = { ...world.state.dialog!, isOpen: false }; }, 60);
            else return honest(a, world);
        };
        const open = w.handlers.command!;
        w.handlers.command = (a, world) => { setTimeout(() => open(a, world), 120); };
        expect(await bot.respec('Graent')).toMatchObject({ success: true, regained: 118 });
        expect(answered).toHaveLength(2);
        expect(answered[0]).toBe(1);
        expect(answered[1]).toBeGreaterThan(1);
    });

    test('timeout: the yes went out and no points came back', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        w.handlers.respondDialog = (_a, world) => { world.state.dialog = { ...world.state.dialog!, isOpen: false }; };
        const r = await bot.respec('Graent');
        expect(r).toMatchObject({ success: false, reason: 'timeout', regained: 0, specPointsLeft: 0 });
        expect(r.message).toContain('no points came back');
    }, 8000);

    test('waits for the window that follows the points: trainSpec counts levels from it', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        openWindow(w);
        w.handlers.respondDialog = (_a, world) => {
            world.state.dialog = { ...world.state.dialog!, isOpen: false };
            setTimeout(() => {
                world.state.skills = { ...world.state.skills, specializations: world.state.skills.specializations.map(l => ({ ...l, level: 1 })) };
                world.player.specPoints += 118;
            }, 10);
            setTimeout(() => openWindow(world), 200);
        };
        await bot.respec('Graent');
        expect(w.sdk.getTrainer()!.specs.map(l => l.level)).toEqual([1, 1, 1]);
    });

    test('walks to a trainer out of reach first', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES, {}, graent(561500));
        expect(await bot.respec('Graent')).toMatchObject({ success: true, regained: 118 });
        expect(w.sent.findIndex(a => a.type === 'moveTo')).toBeLessThan(w.sent.findIndex(a => a.type === 'setTarget'));
    });

    test('not_found and spec_not_found send nothing', async () => {
        const { w, bot } = atTrainer(enchanter, ENCHANTER_LINES);
        expect(await bot.respec('Nobody')).toMatchObject({ success: false, reason: 'not_found', regained: 0 });
        const r = await bot.respec('Graent', 'Runes of Darkness');
        expect(r).toMatchObject({ success: false, reason: 'spec_not_found', regained: 0 });
        expect(r.message).toContain('Light Magic, Mana Magic, Enchantments');
        expect(w.sent).toEqual([]);
    });

    test('not in game', async () => {
        const { bot } = world({ player: null });
        expect(await bot.respec('Graent')).toMatchObject({ success: false, reason: 'not_in_game' });
    });

    test('a respec then a trainBuild: the build goes up again from the floor', async () => {
        const { w, bot } = atTrainer({ ...enchanter, level: 20 }, { 'Light Magic': 12, 'Mana Magic': 3 });
        await bot.respec('Graent');
        expect(lineOf(w, 'Light Magic').level).toBe(1);
        w.handlers.openTrainer = (_a, world) => openWindow(world);
        w.handlers.trainSpec = (a, world) => {
            if (a.type !== 'trainSpec') return;
            setTimeout(() => {
                const spec = world.state.skills.specializations[a.specIndex]!;
                world.state.skills = { ...world.state.skills, specializations: world.state.skills.specializations.map(s => (s === spec ? { ...s, level: spec.level + a.levels! } : s)) };
                world.player.specPoints -= 2;
                openWindow(world);
            }, 10);
        };
        const build: Build = { className: 'Enchanter', name: 'Mana', targets: [{ level: 24, specs: { Mana: 2 } }] };
        expect(await bot.trainBuild('Graent', build)).toMatchObject({ success: true, done: true, over: [], trained: [{ spec: 'Mana', fromLevel: 1, toLevel: 2 }] });
    });
});

// ── Social / group / grind ──────────────────────────────────────────────────

describe('social', () => {
    test('say observes the echo; send surfaces offline players', async () => {
        const { w, bot } = world();
        w.handlers.say = (a, world) => { if (a.type === 'say') setTimeout(() => world.message(`You say, "${a.text}"`, { type: 'say' }), 10); };
        expect(await bot.say('hello')).toMatchObject({ success: true, echoed: true });
        w.handlers.send = (a, world) => { if (a.type === 'send') setTimeout(() => world.message(`${a.to} is not in the game, or is a member of another realm.`), 10); };
        expect((await bot.send('Nobody', 'hi')).reason).toBe('refused');
    });

    test('back-to-back says are spaced past the server limit; a slow-down is rate_limited', async () => {
        const { w, bot } = world();
        let lastAccepted = 0;
        let alwaysSlow = false;
        // SayCommandHandler (say.cs:49-53): < 500 ms after the last accepted say is dropped.
        w.handlers.say = (a, world) => {
            if (a.type !== 'say') return;
            const now = Date.now();
            if (alwaysSlow || now - lastAccepted < 500) { setTimeout(() => world.message('Slow down! Think before you say each word!'), 10); return; }
            lastAccepted = now;
            setTimeout(() => world.message(`You say, "${a.text}"`, { type: 'say' }), 10);
        };
        expect(await bot.say('a')).toMatchObject({ success: true, echoed: true });
        expect(await bot.say('b')).toMatchObject({ success: true, echoed: true });
        expect(w.sentOf('say').map(a => a.text)).toEqual(['a', 'b']);
        alwaysSlow = true;
        expect(await bot.say('c')).toMatchObject({ success: false, reason: 'rate_limited', echoed: false });
        expect(w.sentOf('say').map(a => a.text)).toEqual(['a', 'b', 'c', 'c']);
    });

    test('acceptGroupInvite answers the invite and observes membership', async () => {
        const { w, bot } = world();
        setTimeout(() => { w.state.dialog = { isOpen: true, code: 5, data: [7, 0, 0, 0], type: 1, text: 'Bob has invited you to join\nhis group.', receivedAt: 5 }; }, 20);
        w.handlers.respondDialog = (_a, world) => {
            world.state.dialog = { ...world.state.dialog!, isOpen: false };
            setTimeout(() => { world.state.group = [{ name: 'Bob', className: 'Fighter', level: 3, objectId: 300, healthPercent: 100, manaPercent: 100, endurancePercent: 100, isDead: false, inOtherRegion: false }]; }, 10);
        };
        const r = await bot.acceptGroupInvite({ timeout: 1000 });
        expect(r.success).toBeTrue();
        expect(r.group[0]!.name).toBe('Bob');
    });

    test('groupSay waits for a lagging group list and trusts the server answer', async () => {
        const { w, bot } = world();
        const member = { name: 'Bob', className: 'Fighter', level: 1, objectId: 300, healthPercent: 100, manaPercent: 100, endurancePercent: 100, isDead: false, inOtherRegion: false };
        let grouped = false;
        w.handlers.groupSay = (a, world) => {
            if (a.type !== 'groupSay') return;
            setTimeout(() => world.message(grouped ? `[Party] Tester: "${a.text} "` : 'You are not part of a group', { type: grouped ? 'group' : 'system' }), 10);
        };
        // The invite was just accepted: our group list arrives a moment later.
        setTimeout(() => { grouped = true; w.state.group = [member]; }, 100);
        expect(await bot.groupSay('group check')).toMatchObject({ success: true, echoed: true });
        grouped = false;
        w.state.group = [member]; // stale list: the server's answer wins
        expect(await bot.groupSay('anyone?')).toMatchObject({ success: false, reason: 'not_grouped' });
    });

    test('follow keeps up with a moving player', async () => {
        const { w, bot } = world();
        w.onTick = world => { const o = world.state.nearbyPlayers[0]!; if (o.x < 562000) o.x += 50; };
        const r = await bot.follow('Otherguy', { distance: 150, durationMs: 400 });
        expect(r.success).toBeTrue();
        expect(w.sentOf('moveTo').length).toBeGreaterThanOrEqual(1);
        expect(w.player.x).toBeGreaterThan(560000);
    });
});

describe('grind', () => {
    test('kills, loots and stops at maxKills', async () => {
        const mobs = [
            makeNpc({ objectId: 501, name: 'spirit hound', level: 5, x: 560300, y: 511000 }),
            makeNpc({ objectId: 502, name: 'spirit hound', level: 5, x: 560600, y: 511100 }),
        ];
        const { w, bot } = world({ nearbyNpcs: mobs, nearbyObjects: [] });
        fightSim(w, { dmg: 50, xp: 20 });
        const kills: string[] = [];
        const r = await bot.grind({ maxKills: 2, durationMs: 10_000, onKill: k => { kills.push(k.message); } });
        expect(r).toMatchObject({ success: true, kills: 2, stopReason: 'maxKills', deaths: 0 });
        expect(r.xpGained).toBe(40);
        expect(kills).toHaveLength(2);
    });

    test('stops on death unless respawn is requested', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 501, name: 'wolf', level: 5, x: 560300, y: 511000 })] });
        setTimeout(() => { w.player.isDead = true; w.player.deathCount = 1; }, 40);
        const r = await bot.grind({ durationMs: 3000 });
        expect(r).toMatchObject({ success: false, stopReason: 'died', deaths: 1 });
    });

    test('counts a death the server auto-released while we were busy', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 501, name: 'spirit hound', level: 5, x: 560300, y: 511000 })] });
        fightSim(w, { dmg: 50 });
        const r = await bot.grind({
            durationMs: 5000,
            // Died and auto-released ("release automatically in 8 more seconds") during onKill: never seen dead.
            onKill: () => { w.player.deathCount++; w.player.x += 4000; w.publish(); },
        });
        expect(r).toMatchObject({ success: false, stopReason: 'died', deaths: 1, kills: 1 });
    });

    test('counts a death in the last fight that ran past the deadline, and releases it with respawn', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 501, name: 'wild sow', level: 5, x: 560300, y: 511000 })] });
        w.handlers.release = (_a, world) => {
            setTimeout(() => { world.message('You release your corpse unto death.'); world.player.isDead = false; world.player.health = 100; world.player.healthPercent = 100; world.player.x += 5000; }, 20);
        };
        setTimeout(() => { w.player.isDead = true; w.player.deathCount = 1; w.player.health = 0; w.player.healthPercent = 0; w.publish(); }, 300);
        const r = await bot.grind({ durationMs: 100, respawn: true });
        expect(r).toMatchObject({ stopReason: 'duration', deaths: 1 });
        expect(w.sentOf('release')).toHaveLength(1);
        expect(bot.isDead()).toBeFalse();
    });

    test('without respawn a death in the last fight stops with died and is not released', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 501, name: 'wild sow', level: 5, x: 560300, y: 511000 })] });
        setTimeout(() => { w.player.isDead = true; w.player.deathCount = 1; w.player.health = 0; w.player.healthPercent = 0; w.publish(); }, 300);
        const r = await bot.grind({ durationMs: 100 });
        expect(r).toMatchObject({ stopReason: 'died', deaths: 1 });
        expect(w.sentOf('release')).toHaveLength(0);
    });

    test('does not pull a new target when less than minEngageMs remains', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 501, name: 'spirit hound', level: 5, x: 560300, y: 511000 })] });
        fightSim(w, { dmg: 50 });
        const t0 = Date.now();
        const r = await bot.grind({ durationMs: 2000, minEngageMs: 5000 });
        expect(r).toMatchObject({ stopReason: 'duration', kills: 0 });
        expect(Date.now() - t0).toBeLessThan(500);
        expect(w.sentOf('attack')).toHaveLength(0);
    });

    test('the default engage margin is the average kill time: no pull too close to the deadline', async () => {
        const mobs = [
            makeNpc({ objectId: 501, name: 'spirit hound', level: 5, x: 560300, y: 511000 }),
            makeNpc({ objectId: 502, name: 'spirit hound', level: 5, x: 560400, y: 511000 }),
            makeNpc({ objectId: 503, name: 'spirit hound', level: 5, x: 560500, y: 511000 }),
        ];
        const { w, bot } = world({ nearbyNpcs: mobs });
        fightSim(w, { dmg: 50 });
        // Each kill takes well over a second (walk + XP settle); after the first, too little is left.
        const first = await bot.grind({ maxKills: 1, durationMs: 10_000, loot: false });
        const killMs = first.killLog[0]!.durationMs;
        const t0 = Date.now();
        const r = await bot.grind({ durationMs: killMs * 1.5, loot: false });
        expect(r.kills).toBe(1);
        expect(Date.now() - t0).toBeLessThan(killMs * 1.5 + 500);
    }, 15_000);

    test('a monster already attacking is still fought when time is short', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 501, name: 'spirit hound', level: 5, x: 560300, y: 511000 })] });
        w.state.nearbyNpcs[0]!.targetObjectId = w.player.objectId;
        w.publish();
        fightSim(w, { dmg: 50 });
        const r = await bot.grind({ durationMs: 2000, minEngageMs: 60_000 });
        expect(r).toMatchObject({ kills: 1, stopReason: 'duration' });
    });

    test('stops with no_targets when nothing is in the con window', async () => {
        // Everything around town is grey to us: nothing to fight for the whole duration.
        const { bot } = world({ player: makePlayer({ level: 10 }), nearbyNpcs: [makeNpc({ objectId: 501, name: 'rat', level: 1, x: 560300, y: 511000 })] });
        const t0 = Date.now();
        const r = await bot.grind({ durationMs: 10_000, noTargetTimeoutMs: 200 });
        expect(r).toMatchObject({ success: false, stopReason: 'no_targets', reason: 'no_targets', kills: 0 });
        expect(r.message).toContain('No killable target');
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    test('rests when hurt and nothing attacks', async () => {
        const { w, bot } = world({ player: makePlayer({ health: 30, healthPercent: 30 }), nearbyNpcs: [] });
        w.onTick = world => { if (world.player.isSitting) { world.player.health = Math.min(100, world.player.health + 10); world.player.healthPercent = world.player.health; } };
        const r = await bot.grind({ durationMs: 400 });
        expect(r.stopReason).toBe('duration');
        expect(w.sentOf('sit').length).toBeGreaterThanOrEqual(1);
        expect(w.player.healthPercent).toBeGreaterThanOrEqual(90);
    });

    describe('a melee fight over two passes is one fight', () => {
        const bear = (o: Partial<NearbyNpc> = {}) => makeNpc({ objectId: 501, name: 'bear', level: 5, x: 560050, y: 511000, ...o });

        test('with the mob lower in health: no failure, and killLog has the whole of it', async () => {
            const { w, bot } = world({ nearbyNpcs: [bear(), bear({ objectId: 502, x: 560040 })] });
            fightSim(w, { dmg: 1 });
            const r = await bot.grind({ maxKills: 1, durationMs: 8000, killTimeout: 300, minEngageMs: 0, loot: false });
            expect(r).toMatchObject({ kills: 1, failures: 0 });
            expect(r.killLog[0]!.durationMs).toBeGreaterThan(600);
            // The next passes stay on it, with the other as near.
            expect(new Set(w.sentOf('setTarget').map(a => a.objectId).filter(id => id !== null)).size).toBe(1);
        });

        test('with the mob on us and no harm done to it: the same, and it stays the next target', async () => {
            const { w, bot } = world({ nearbyNpcs: [bear({ targetObjectId: 100 })] });
            // It takes 40 ticks of our swinging, with its health reading 100 % to the end.
            let swinging = 0;
            w.onTick = world => {
                if (!world.npc(501) || !world.player.attacking || ++swinging < 40) return;
                world.removeNpc(501);
                world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 501, targetHealthPercent: 0 });
                world.message('You get 1 experience points.', { type: 'important' });
            };
            const r = await bot.grind({ maxKills: 1, durationMs: 8000, killTimeout: 150, minEngageMs: 0, loot: false });
            expect(r).toMatchObject({ kills: 1, failures: 0 });
            expect(r.killLog[0]!.durationMs).toBeGreaterThan(300);
        });

        test('a mob neither on us nor hurt is still a failure, and left alone', async () => {
            const { w, bot } = world({ nearbyNpcs: [bear()] });
            const r = await bot.grind({ durationMs: 500, killTimeout: 100, minEngageMs: 0, loot: false });
            expect(r).toMatchObject({ kills: 0, failures: 1 });
            expect(w.sentOf('attack').filter(a => a.on).length).toBe(1);
        });
    });

    describe('a rest with nothing to wait for can\'t spin', () => {
        const regen = (world: FakeWorld) => { if (world.player.isSitting) { world.player.health = Math.min(100, world.player.health + 5); world.player.healthPercent = world.player.health; } };

        test('restBelowHealth above restToHealth: it rests to the higher one, a few passes, and timers run', async () => {
            const { w, bot } = world({ player: makePlayer({ health: 95, healthPercent: 95 }), nearbyNpcs: [] });
            w.onTick = regen;
            const rests = spyOn(bot, 'rest');
            let ticks = 0;
            const ticking = setInterval(() => { ticks++; }, 10);
            const r = await bot.grind({ durationMs: 400, minEngageMs: 0, restBelowHealth: 100, restToHealth: 90, loot: false });
            clearInterval(ticking);
            expect(r.stopReason).toBe('duration');
            expect(rests.mock.calls.length).toBeLessThanOrEqual(2);
            expect(rests.mock.calls[0]![0]).toMatchObject({ healthPercent: 100 });
            expect(ticks).toBeGreaterThan(20);
            expect(w.player.healthPercent).toBe(100);
        });

        test('a rest that comes back at once goes on to picking a target, with no second look', async () => {
            const { w, bot } = world({ player: makePlayer({ health: 30, healthPercent: 30 }), nearbyNpcs: [makeNpc({ objectId: 501, name: 'spirit hound', level: 5, x: 560050, y: 511000 })] });
            fightSim(w, { dmg: 50 });
            const rests = spyOn(bot, 'rest').mockImplementation(async () => ({ success: true, message: 'Already rested', healthPercent: 30, manaPercent: 0, endurancePercent: 100, durationMs: 0 }));
            let ticks = 0;
            const ticking = setInterval(() => { ticks++; }, 10);
            const r = await bot.grind({ maxKills: 1, durationMs: 400, minEngageMs: 0, loot: false });
            clearInterval(ticking);
            expect(r).toMatchObject({ kills: 1 });
            expect(rests.mock.calls.length).toBe(1);
            expect(ticks).toBeGreaterThan(5);
        });
    });

    test('a caster hitting us comes before a nearer mob', async () => {
        const mobs = [
            makeNpc({ objectId: 501, name: 'spirit hound', level: 5, x: 560300, y: 511000, distance: 100 }),
            makeNpc({ objectId: 502, name: 'dergan enchanter', level: 5, x: 560600, y: 511000, distance: 400 }),
        ];
        const { w, bot } = world({ nearbyNpcs: mobs, nearbyObjects: [] });
        fightSim(w, { dmg: 50 });
        w.combat({ kind: 'spellEffect', attackerObjectId: 502, targetObjectId: w.player.objectId, effectId: 5208 });
        w.publish();
        const r = await bot.grind({ maxKills: 1, durationMs: 5000, loot: false });
        expect(r.killLog.map(k => k.name)).toEqual(['dergan enchanter']);
    });

    /** A mob on a ledge that goes on casting: every fight with it fails, and each tick its spell lands again. */
    const onALedge = (over: Partial<NearbyNpc>) => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 501, name: 'dergan enchanter', level: 5, x: 560600, y: 511000, ...over })], nearbyObjects: [] });
        w.onTick = world => world.combat({ kind: 'spellEffect', attackerObjectId: 501, targetObjectId: world.player.objectId, effectId: 5208 });
        const tried: number[] = [];
        bot.killNpc = (async (t: NearbyNpc) => {
            tried.push(t.objectId);
            await Bun.sleep(20);
            return { success: false, killed: false, reason: 'out_of_reach', message: 'too high', xpGained: 0 };
        }) as unknown as typeof bot.killNpc;
        return { w, bot, tried };
    };

    test('a caster it cannot reach is tried once, not over and over', async () => {
        const { bot, tried } = onALedge({ targetObjectId: null });
        await bot.grind({ durationMs: 300, loot: false });
        expect(tried).toEqual([501]);
    });

    test('nor when its spells show as its target, as a hit does until the mob\'s next update', async () => {
        const { bot, tried } = onALedge({ targetObjectId: 100 });
        await bot.grind({ durationMs: 300, loot: false });
        expect(tried).toEqual([501]);
    });

    test('a failed fight does not rule out a mob in melee range', async () => {
        const { bot, tried } = onALedge({ x: 560050 });
        // A failure that spent no time waits GRIND_RETRY_MS before the next pass.
        await bot.grind({ durationMs: 1500, loot: false });
        expect(tried.length).toBeGreaterThan(1);
    });

    test('hurt under fire from a mob ruled out, it neither sits nor pulls, and stops at no_targets', async () => {
        const { w, bot, tried } = onALedge({ targetObjectId: null });
        w.state.nearbyNpcs.push(makeNpc({ objectId: 502, name: 'spirit hound', level: 5, x: 560900, y: 511000 }));
        w.player.health = 30;
        w.player.healthPercent = 30;
        const r = await bot.grind({ durationMs: 3000, noTargetTimeoutMs: 200, loot: false });
        expect(r.stopReason).toBe('no_targets');
        expect(tried).toEqual([501]);
        expect(w.sentOf('sit')).toEqual([]);
    });
});

describe('useZonePoint', () => {
    // The region and realm of makePlayer: 500 east of it, out to region 2.
    const ZP = { id: 111, sourceRegion: 1, sourceX: 560500, sourceY: 511000, sourceZ: 2500, targetRegion: 2, targetX: 1000, targetY: 2000, targetZ: 30, targetHeading: 0, realm: 0, classType: '' };
    /** What the server does with 0x90: a jump, seen in the snapshots after a region change. */
    const jumps = (w: { player: { regionId: number; x: number; y: number } }) => (a: BotAction) => {
        if (a.type === 'regionChangeRequest') { w.player.regionId = 2; w.player.x = ZP.targetX; w.player.y = ZP.targetY; }
    };

    test('at the source it asks at once, by id, and reports the new region', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX - 100, y: ZP.sourceY }) });
        w.handlers.regionChangeRequest = jumps(w);
        const r = await bot.useZonePoint(ZP);
        expect(r).toMatchObject({ success: true, regionId: 2, zonePoint: { id: 111 }, position: { x: 1000, y: 2000 } });
        expect(w.sentOf('moveTo')).toEqual([]);
        expect(w.sentOf('regionChangeRequest').map(a => a.zonePointId)).toEqual([111]);
    });

    test('farther than the tolerance it walks to the source first, with its z', async () => {
        const { w, bot } = world();
        const order: string[] = [];
        w.handlers.regionChangeRequest = a => { order.push(`ask at ${Math.round(Math.hypot(w.player.x - ZP.sourceX, w.player.y - ZP.sourceY))}`); jumps(w)(a); };
        const r = await bot.useZonePoint(ZP, { tolerance: 50 });
        expect(r.success).toBe(true);
        expect(w.sentOf('moveTo')[0]).toMatchObject({ x: ZP.sourceX, y: ZP.sourceY, z: ZP.sourceZ });
        expect(order.length).toBe(1);
        expect(Number(order[0]!.split(' ')[2])).toBeLessThanOrEqual(52);
    });

    test('it counts as done only once the client is back in the game', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX, y: ZP.sourceY }) });
        w.handlers.regionChangeRequest = a => {
            jumps(w)(a);
            w.state.inGame = false;
            setTimeout(() => { w.state.inGame = true; }, 60);
        };
        const r = await bot.useZonePoint(ZP);
        expect(r.success).toBe(true);
        expect(w.state.inGame).toBe(true);
    });

    test('a zone point inside its own region shows at the target', async () => {
        const inside = { ...ZP, targetRegion: 1, targetX: 570000, targetY: 511000 };
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX, y: ZP.sourceY }) });
        w.handlers.regionChangeRequest = () => { w.player.x = inside.targetX; };
        expect(await bot.useZonePoint(inside)).toMatchObject({ success: true, regionId: 1 });
    });

    test('an id looks up the static data: not_found, or the real zone point elsewhere', async () => {
        const { w, bot } = world();
        expect(await bot.useZonePoint(999_999)).toMatchObject({ success: false, reason: 'not_found', zonePoint: null });
        // 63 is Thidranki's Albion exit, region 252.
        expect(await bot.useZonePoint(63)).toMatchObject({ success: false, reason: 'wrong_region', zonePoint: { id: 63, sourceRegion: 252 } });
        expect(w.sent).toEqual([]);
    });

    test('an id with a row per realm means ours, as on the server (84: Albion\'s row comes first)', async () => {
        const mid = world({ player: makePlayer({ realm: 'midgard', regionId: 100, x: 760600, y: 700475 }) });
        mid.w.handlers.regionChangeRequest = jumps(mid.w);
        expect(await mid.bot.useZonePoint(84)).toMatchObject({ success: true, zonePoint: { id: 84, realm: 2 } });
        expect(mid.w.sentOf('moveTo')).toEqual([]);

        const hib = world({ player: makePlayer({ realm: 'hibernia', regionId: 100, x: 760606 - 1000, y: 700489 }) });
        hib.w.handlers.regionChangeRequest = jumps(hib.w);
        expect(await hib.bot.useZonePoint(84)).toMatchObject({ success: true, zonePoint: { id: 84, realm: 3 } });
        expect(hib.w.sentOf('moveTo')[0]).toMatchObject({ x: 760606, y: 700489 });
    });

    test('an id whose one row is another realm\'s is still wrong_realm', async () => {
        const { w, bot } = world({ player: makePlayer({ realm: 'midgard', regionId: 252 }) });
        expect(await bot.useZonePoint(63)).toMatchObject({ success: false, reason: 'wrong_realm', zonePoint: { id: 63, realm: 1 } });
        expect(w.sent).toEqual([]);
    });

    test('wrong region and another realm\'s zone point go nowhere: no walk, nothing sent', async () => {
        const { w, bot } = world();
        expect(await bot.useZonePoint({ ...ZP, sourceRegion: 51 })).toMatchObject({ success: false, reason: 'wrong_region' });
        expect(await bot.useZonePoint({ ...ZP, realm: 2 })).toMatchObject({ success: false, reason: 'wrong_realm' });
        expect(w.sent).toEqual([]);
    });

    test('the zone point of our own realm is fine', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX, y: ZP.sourceY }) });
        w.handlers.regionChangeRequest = jumps(w);
        expect((await bot.useZonePoint({ ...ZP, realm: 1 })).success).toBe(true);
    });

    test('dead is its own reason', async () => {
        const { w, bot } = world({ player: makePlayer({ isDead: true }) });
        expect(await bot.useZonePoint(ZP)).toMatchObject({ success: false, reason: 'dead' });
        expect(w.sent).toEqual([]);
    });

    test('a server message saying no is refused, and carries the message', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX, y: ZP.sourceY }) });
        w.handlers.regionChangeRequest = () => w.message('This region has been disabled!');
        const r = await bot.useZonePoint(ZP);
        expect(r).toMatchObject({ success: false, reason: 'refused', message: 'This region has been disabled!', regionId: 1 });
        expect(r.messages).toEqual(['This region has been disabled!']);
    });

    test('no jump and no word is a timeout', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX, y: ZP.sourceY }) });
        const r = await bot.useZonePoint(ZP, { timeout: 60 });
        expect(r).toMatchObject({ success: false, reason: 'timeout', regionId: 1 });
        expect(w.sentOf('regionChangeRequest')).toHaveLength(1);
    });

    test('a request the client could not dispatch says why', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX, y: ZP.sourceY }) });
        w.handlers.regionChangeRequest = () => ({ success: false, message: 'not in game', reason: 'not_in_game' });
        expect(await bot.useZonePoint(ZP)).toMatchObject({ success: false, reason: 'not_in_game' });
    });

    test('a walk that fails far away ends it with the walk\'s reason; within 400 it still asks', async () => {
        const refused: Handler = () => ({ success: false, message: 'no', reason: 'stuck' });
        const far = world();
        far.w.handlers.moveTo = refused;
        expect(await far.bot.useZonePoint(ZP, { tolerance: 50 })).toMatchObject({ success: false, reason: 'stuck' });
        expect(far.w.sentOf('regionChangeRequest')).toEqual([]);

        const near = world({ player: makePlayer({ x: ZP.sourceX - 300, y: ZP.sourceY }) });
        near.w.handlers.moveTo = refused;
        near.w.handlers.regionChangeRequest = jumps(near.w);
        expect((await near.bot.useZonePoint(ZP, { tolerance: 50 })).success).toBe(true);
    });

    test('a session lost on the way ends it with the walk\'s reason, and throws nothing', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX - 300, y: ZP.sourceY }) });
        w.stepSize = 1;
        w.onTick = world => { world.state.player = null; world.state.movement = { ...world.state.movement, moving: false }; };
        expect(await bot.useZonePoint(ZP, { tolerance: 50 })).toMatchObject({ success: false, reason: 'not_in_game', regionId: null });
        expect(w.sentOf('regionChangeRequest')).toEqual([]);
    });

    test('dying on the way ends it, whatever the distance', async () => {
        const { w, bot } = world({ player: makePlayer({ x: ZP.sourceX - 300, y: ZP.sourceY }) });
        w.stepSize = 1;
        w.onTick = world => { world.player.isDead = true; };
        expect(await bot.useZonePoint(ZP, { tolerance: 50 })).toMatchObject({ success: false, reason: 'died' });
        expect(w.sentOf('regionChangeRequest')).toEqual([]);
    });
});

describe('static data', () => {
    test('findNpcSpawn and travelTo use the DB spawns', async () => {
        const { w, bot } = world({ player: makePlayer({ regionId: 1, x: 574797, y: 530161, z: 2896 }) });
        const spawn = bot.findNpcSpawn(/spirit hound/);
        expect(spawn?.regionId).toBe(1);
        expect(spawn?.distance).toBeLessThan(5000);
        w.stepSize = 2000;
        const r = await bot.travelTo(/spirit hound/);
        expect(r.success).toBeTrue();
        expect(r.spawn?.name).toBe('spirit hound');
        expect((await bot.travelTo({ x: 1, y: 2, regionId: 51 })).reason).toBe('other_region');
    });
});

// ── Player trade: two bots and the server between them ──────────────────────

const tradeItem = (slot: number, name: string, count = 1): InventoryItem =>
    ({ slot, name, level: 1, count, model: 99, objectType: 0, condition: 100, durability: 100, quality: 85, weight: 5, value1: 0, value2: 0, hand: 0 });

/**
 * Plays the server over two FakeWorlds: the first add opens both windows, every change is a 0xEA on both
 * sides and clears both accepts, and two accepts commit in the real order (inventory, text, close).
 * The accept handler also holds the client's guards, against the newest window the client has heard of.
 */
function tradeLink(a: FakeWorld, b: FakeWorld) {
    type Side = { w: FakeWorld; other: Side; slots: number[]; money: number; accepted: boolean };
    const A = { w: a, slots: [], money: 0, accepted: false } as unknown as Side;
    const B = { w: b, other: A, slots: [], money: 0, accepted: false } as Side;
    A.other = B;
    let id = 0;
    let nextId = 1000;
    let revision = 0;
    const link = {
        open: false,
        /** Said at the second accept instead of committing; the window then resets. */
        failCommit: null as ((a: FakeWorld, b: FakeWorld) => void) | null,
        /** This side's incoming items get lost: the server only logs that. */
        losesItems: null as FakeWorld | null,
        /** This side's item leaves the offer, as any inventory move does (GamePlayerInventory.cs:542-543). */
        drop(w: FakeWorld, slot: number): void {
            const s = w === a ? A : B;
            s.slots = s.slots.filter(x => x !== slot);
            link.update();
        },
        /** A 0xEA on both sides, not yet published. */
        update(): void {
            revision++;
            for (const s of [A, B]) {
                s.accepted = false;
                s.w.state.trade = {
                    id, revision, partnerName: s.other.w.player.name, mySlots: [...s.slots], myMoney: s.money,
                    partnerItems: s.other.slots.map(slot => s.other.w.state.inventory.find(i => i.slot === slot)!), partnerMoney: s.other.money,
                };
            }
        },
        /** The silent close: a partner's cancel and a range close look alike. */
        close(): void {
            link.open = false;
            for (const s of [A, B]) {
                s.slots = [];
                s.money = 0;
                s.accepted = false;
                s.w.state.trade = null;
            }
        },
    };
    const ensureOpen = () => {
        if (link.open) return;
        link.open = true;
        id = nextId++;
        revision = 0;
    };
    const commit = () => {
        if (link.failCommit) {
            link.failCommit(a, b);
            link.update();
            return;
        }
        const leaving = [A, B].map(s => ({ s, items: s.slots.map(slot => s.w.state.inventory.find(i => i.slot === slot)!), money: s.money }));
        for (const { s } of leaving) s.w.state.inventory = s.w.state.inventory.filter(i => !s.slots.includes(i.slot));
        for (const { s, items, money } of leaving) {
            const to = s.other.w;
            s.w.player.money.totalCopper -= money;
            to.player.money.totalCopper += money;
            if (to === link.losesItems) continue;
            for (const item of items) {
                let slot = 40;
                while (to.state.inventory.some(i => i.slot === slot)) slot++;
                to.state.inventory = [...to.state.inventory, { ...item, slot }];
            }
        }
        a.publish();
        b.publish();
        for (const { s, items } of leaving) s.w.message(`Trade Completed. ${items.length} items for ${s.other.slots.length} items.`);
        a.publish();
        b.publish();
        link.close();
    };
    for (const me of [A, B]) {
        me.w.handlers.tradeOfferItem = (action, w) => {
            if (action.type !== 'tradeOfferItem') return;
            if (!w.state.inventory.some(i => i.slot === action.slot)) return { success: false, message: 'no item', reason: 'empty_slot', phase: 'validation' };
            ensureOpen();
            me.slots.push(action.slot);
            link.update();
        };
        me.w.handlers.tradeOfferMoney = action => {
            if (action.type !== 'tradeOfferMoney') return;
            ensureOpen();
            me.money += action.copper;
            link.update();
        };
        me.w.handlers.tradeAccept = (action, w) => {
            if (action.type !== 'tradeAccept') return;
            const t = w.state.trade;
            if (!t) return { success: false, message: 'no trade window open', reason: 'no_trade', phase: 'validation' };
            if (action.revision !== undefined && action.revision !== t.revision) return { success: false, message: 'the offer changed', reason: 'trade_changed', phase: 'validation' };
            if (action.windowId !== undefined && action.windowId !== t.id) return { success: false, message: 'another window', reason: 'trade_changed', phase: 'validation' };
            me.accepted = true;
            me.other.w.message(`${w.player.name} has accepted the trade.`);
            if (me.other.accepted) commit();
        };
        me.w.handlers.tradeCancel = (_action, w) => {
            if (link.open) link.close();
            else w.state.trade = null; // a window from someone else
        };
    }
    return link;
}

/** Two bots of one realm, 50 units apart, each seeing the other. */
function tradePair(aItems: InventoryItem[] = [tradeItem(40, 'sleeves'), tradeItem(41, 'helm'), tradeItem(42, 'boots')], bItems: InventoryItem[] = []) {
    const a = world({
        player: makePlayer({ name: 'Alda', objectId: 100 }), inventory: aItems,
        nearbyPlayers: [makePlayerObj({ objectId: 300, name: 'Brin', x: 560050 })],
    });
    const b = world({
        player: makePlayer({ name: 'Brin', objectId: 300, x: 560050 }), inventory: bItems,
        nearbyPlayers: [makePlayerObj({ objectId: 100, name: 'Alda', x: 560000 })],
    });
    return { a, b, link: tradeLink(a.w, b.w) };
}

async function until(check: () => unknown, timeout = 2000): Promise<void> {
    const end = Date.now() + timeout;
    while (!check()) {
        if (Date.now() > end) throw new Error(`until: still false after ${timeout} ms: ${check}`);
        await Bun.sleep(5);
    }
}

/** Run `work` so that it aborts after `ms`, as an MCP cancel or a runScript timeout does. */
function abortAfter<T>(ms: number, work: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled')), ms);
    return executionContext.run({ signal: controller.signal }, work);
}

const tradeActions = (w: FakeWorld) => w.sent.filter(s => s.type.startsWith('trade'));

describe('trade', () => {
    test('the giver calling first: the item moves, and both report it', async () => {
        const { a, b } = tradePair();
        const [give, take] = await Promise.all([a.bot.trade('Brin', { give: ['sleeves'] }), b.bot.trade('Alda')]);
        expect(give).toMatchObject({ success: true, partner: 'Brin', received: [], missing: [], moneyGiven: 0, moneyReceived: 0, refused: null, message: 'Trade Completed. 1 items for 0 items.' });
        expect(give.gave.map(i => [i.slot, i.name])).toEqual([[40, 'sleeves']]);
        expect(take).toMatchObject({ success: true, partner: 'Alda', gave: [], missing: [], message: 'Trade Completed. 0 items for 1 items.' });
        expect(take.received.map(i => [i.slot, i.name])).toEqual([[40, 'sleeves']]);
        expect(a.w.state.inventory.map(i => i.name)).toEqual(['helm', 'boots']);
        expect(b.w.state.inventory.map(i => i.name)).toEqual(['sleeves']);
        expect(a.sdk.getTrade()).toBeNull();
        expect(b.sdk.getTrade()).toBeNull();
        expect(a.w.sentOf('tradeCancel')).toEqual([]);
        expect(b.w.sentOf('tradeCancel')).toEqual([]);
    });

    test('the receiver calling first, a long way ahead', async () => {
        const { a, b } = tradePair();
        const taking = b.bot.trade('alda'); // any case
        await Bun.sleep(50);
        const give = await a.bot.trade('brin', { give: [a.sdk.getInventoryItem(41)!] });
        const take = await taking;
        expect(give.success).toBe(true);
        expect(take.received.map(i => i.name)).toEqual(['helm']);
    });

    test('a two-way swap: each gets the other\'s item, in the slot that came free', async () => {
        const { a, b } = tradePair([tradeItem(40, 'sleeves')], [tradeItem(40, 'gloves')]);
        const [ra, rb] = await Promise.all([a.bot.trade('Brin', { give: ['sleeves'] }), b.bot.trade('Alda', { give: ['gloves'] })]);
        expect(ra).toMatchObject({ success: true, message: 'Trade Completed. 1 items for 1 items.' });
        expect(rb.success).toBe(true);
        expect(ra.gave.map(i => i.name)).toEqual(['sleeves']);
        expect(ra.received.map(i => [i.slot, i.name])).toEqual([[40, 'gloves']]);
        expect(rb.received.map(i => [i.slot, i.name])).toEqual([[40, 'sleeves']]);
    });

    describe('only one side opens the window', () => {
        for (const start of [0, 300, 600, 900]) {
            test(`with both giving and the earlier name starting ${start} ms later`, async () => {
                const { a, b, link } = tradePair([tradeItem(40, 'sleeves'), tradeItem(41, 'boots')], [tradeItem(40, 'gloves'), tradeItem(41, 'cap')]);
                const openers: string[] = [];
                for (const [w, name] of [[a.w, 'Alda'], [b.w, 'Brin']] as const) {
                    for (const kind of ['tradeOfferItem', 'tradeOfferMoney'] as const) {
                        const real = w.handlers[kind]!;
                        w.handlers[kind] = (action: BotAction, world: FakeWorld) => { if (!link.open) openers.push(name); return real(action, world); };
                    }
                }
                const later = b.bot.trade('Alda', { give: ['gloves', 'cap'], money: 5 });
                await Bun.sleep(start);
                const earlier = a.bot.trade('Brin', { give: ['sleeves', 'boots'], money: 7 });
                const [ra, rb] = await Promise.all([earlier, later]);
                expect(ra.success).toBe(true);
                expect(rb.success).toBe(true);
                expect(openers).toHaveLength(1);
            });
        }
    });

    test('the two sides\' slots on the clock never come within 250 ms of each other', () => {
        const send = (later: boolean, now: number) => now + tradeSlotWait(now, later);
        for (let now = 0; now < 2000; now += 7) {
            for (const later of [false, true]) {
                const phase = send(later, now) % 1000;
                const inSlot = later ? phase >= 500 && phase < 750 : phase < 250;
                expect(inSlot).toBe(true);
            }
        }
    });

    test('an opening add out of budget for its slot is a timeout, and nothing is sent', async () => {
        const { a, link } = tradePair();
        const now = Date.now();
        const budget = tradeSlotWait(now, false);
        if (budget > 20) {
            const r = await a.bot.offerTrade('Brin', { give: ['sleeves'], timeout: 1 });
            expect(r).toMatchObject({ success: false, reason: 'timeout' });
            expect(link.open).toBe(false);
        }
    });

    test('a window closed between two adds is not reopened', async () => {
        const { a } = tradePair();
        const add = a.w.handlers.tradeOfferItem!;
        let sent = 0;
        a.w.handlers.tradeOfferItem = (action: BotAction, world: FakeWorld) => { sent++; return add(action, world); };
        // The snapshot after the first add's answer shows the window gone: a partner's cancel or a range close.
        const getTrade = a.sdk.getTrade.bind(a.sdk);
        a.sdk.getTrade = () => sent > 0 ? null : getTrade();
        const r = await a.bot.offerTrade('Brin', { give: ['sleeves', 'helm'] });
        expect(r).toMatchObject({ success: false, reason: 'cancelled' });
        expect(sent).toBe(1);
    });

    test('money only: the purses move, and the window shows copper on both sides', async () => {
        const { a, b } = tradePair();
        const [ra, rb] = await Promise.all([a.bot.trade('Brin', { money: 10203 }), b.bot.trade('Alda')]);
        expect(ra).toMatchObject({ success: true, moneyGiven: 10203, moneyReceived: 0, message: 'Trade Completed. 0 items for 0 items.' });
        expect(rb).toMatchObject({ success: true, moneyGiven: 0, moneyReceived: 10203 });
        expect(a.w.player.money.totalCopper).toBe(10250 - 10203);
        expect(b.w.player.money.totalCopper).toBe(10250 + 10203);
        expect(a.w.sentOf('tradeOfferMoney')).toMatchObject([{ partnerObjectId: 300, copper: 10203 }]);
    });

    test('three adds while the receiver accepts early: the commit holds all three', async () => {
        const { a, b } = tradePair();
        const taking = b.bot.trade('Alda');
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        await a.bot.offerTrade('Brin', { give: [40, 41] });
        await until(() => b.w.sentOf('tradeAccept').length === 2);
        expect(a.w.sentOf('tradeOfferItem').map(s => s.slot)).toEqual([40, 41]); // what is in the window goes once
        const give = await a.bot.trade('Brin', { give: [40, 41, 42] });
        const take = await taking;
        expect(give.gave).toHaveLength(3);
        expect(take.received.map(i => i.name)).toEqual(['sleeves', 'helm', 'boots']);
        expect(b.w.sentOf('tradeAccept').map(s => s.revision)).toEqual([1, 2, 3]);
        expect(a.w.sentOf('tradeAccept').map(s => s.revision)).toEqual([3]);
    });

    test('two 0xEA between snapshots still re-accepts', async () => {
        const { a, b, link } = tradePair();
        const taking = b.bot.acceptTrade();
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        link.update();
        link.update(); // one read, one snapshot
        await until(() => b.w.sentOf('tradeAccept').length === 2);
        expect(b.w.sentOf('tradeAccept').map(s => s.revision)).toEqual([1, 3]);
        expect((await a.bot.acceptTrade()).success).toBe(true);
        expect((await taking).received.map(i => i.name)).toEqual(['sleeves']);
    });

    test('accept says no on revision 1 and yes on revision 2', async () => {
        const { a, b } = tradePair();
        const seen: number[] = [];
        const taking = b.bot.trade('Alda', { accept: w => { seen.push(w.revision); return w.partnerItems.length === 2; } });
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => seen.includes(1));
        const give = await a.bot.trade('Brin', { give: [40, 41] });
        expect(give.success).toBe(true);
        expect((await taking).received).toHaveLength(2);
        expect(b.w.sentOf('tradeAccept').map(s => s.revision)).toEqual([2]);
    });

    test('accept saying no throughout is offer_rejected, and the window goes', async () => {
        const { a, b } = tradePair();
        const taking = b.bot.trade('Alda', { accept: () => false, timeout: 100 });
        await a.bot.offerTrade('Brin', { give: [40] });
        expect(await taking).toMatchObject({ success: false, reason: 'offer_rejected', partner: 'Alda', received: [] });
        expect(b.w.sentOf('tradeAccept')).toEqual([]);
        expect(b.w.sentOf('tradeCancel')).toHaveLength(1);
        expect(a.w.state.inventory).toHaveLength(3);
    });

    test('accept saying yes and then no is offer_changed: our accept may still stand, so it closes', async () => {
        const { a, b } = tradePair();
        const taking = b.bot.trade('Alda', { accept: w => w.partnerItems.length < 2 });
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        await a.bot.offerTrade('Brin', { give: [40, 41] });
        expect(await taking).toMatchObject({ success: false, reason: 'offer_changed' });
        expect(b.w.sentOf('tradeAccept')).toHaveLength(1);
        expect(b.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('a first item refused: no window to see, the cancel still goes, and refused says what', async () => {
        const { a } = tradePair();
        a.w.handlers.tradeOfferItem = (_action, w) => { w.message("You can't trade this item!"); };
        const r = await a.bot.trade('Brin', { give: ['sleeves'] });
        expect(r).toMatchObject({ success: false, reason: 'refused', partner: 'Brin', message: "You can't trade this item!", gave: [] });
        expect(r.refused).toMatchObject({ item: { slot: 40 }, message: "You can't trade this item!" });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
        expect(a.w.sentOf('tradeAccept')).toEqual([]);
    });

    test('the refusal tables give their reasons, and speech matches none of them', async () => {
        for (const [line, reason] of [
            ['Invalid trade target.', 'not_found'],
            ["You can't trade with enemy realm!", 'wrong_realm'],
            ['Brin is still trading with Cade.', 'busy'],
            ['Brin is still selfcrafting.', 'busy'],
        ] as const) {
            const { a } = tradePair();
            a.w.handlers.tradeOfferItem = (_action, w) => { w.message(line); };
            expect(await a.bot.offerTrade('Brin', { give: [40] })).toMatchObject({ success: false, reason, refused: { message: line } });
        }
        const { a } = tradePair();
        a.w.handlers.tradeOfferItem = (_action, w) => { w.message(`Cade says, "You can't trade this item!"`, { type: 'say', sender: 'Cade' }); };
        expect(await a.bot.offerTrade('Brin', { give: [40], timeout: 60 })).toMatchObject({ success: false, reason: 'no_response', refused: null });
    });

    test('"too far away" steps closer and retries once', async () => {
        const { a } = tradePair();
        a.w.state.nearbyPlayers = [makePlayerObj({ objectId: 300, name: 'Brin', x: 560090 })];
        a.w.publish();
        const real = a.w.handlers.tradeOfferItem!;
        let calls = 0;
        a.w.handlers.tradeOfferItem = (action, w) => {
            if (++calls === 1) w.message('You are too far away to give anything to Brin.');
            else return real(action, w);
        };
        const r = await a.bot.offerTrade('Brin', { give: [40] });
        expect(r).toMatchObject({ success: true, trade: { mySlots: [40] } });
        expect(calls).toBe(2);
        expect(Math.abs(560090 - a.w.player.x)).toBeLessThanOrEqual(64);
    });

    test('"too far away" twice is out_of_range', async () => {
        const { a } = tradePair();
        a.w.handlers.tradeOfferItem = (_action, w) => { w.message('You are too far away to give anything to Brin.'); };
        const r = await a.bot.offerTrade('Brin', { give: [40] });
        expect(r).toMatchObject({ success: false, reason: 'out_of_range' });
        expect(a.w.sentOf('tradeOfferItem')).toHaveLength(2);
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('a phantom window: "still trading" with none in view closes it and retries once', async () => {
        const { a } = tradePair();
        const real = a.w.handlers.tradeOfferItem!;
        let calls = 0;
        a.w.handlers.tradeOfferItem = (action, w) => {
            if (++calls === 1) w.message('You are still trading with Cade.');
            else return real(action, w);
        };
        const r = await a.bot.offerTrade('Brin', { give: [40] });
        expect(r).toMatchObject({ success: true, trade: { mySlots: [40] } });
        expect(tradeActions(a.w).map(s => s.type)).toEqual(['tradeOfferItem', 'tradeCancel', 'tradeOfferItem']);
    });

    test('still trading after the cure is busy', async () => {
        const { a } = tradePair();
        a.w.handlers.tradeOfferItem = (_action, w) => { w.message('You are still trading with Cade.'); };
        const r = await a.bot.trade('Brin', { give: [40] });
        expect(r).toMatchObject({ success: false, reason: 'busy', refused: { message: 'You are still trading with Cade.' } });
        expect(a.w.sentOf('tradeOfferItem')).toHaveLength(2);
    });

    test('a close without the text is cancelled, with no extra cancel', async () => {
        const { a, b, link } = tradePair();
        const giving = a.bot.trade('Brin', { give: [40], accept: () => false });
        const taking = b.bot.trade('Alda', { accept: () => false });
        await until(() => a.sdk.getTrade() && b.sdk.getTrade());
        await Bun.sleep(30);
        link.close();
        expect(await giving).toMatchObject({ success: false, reason: 'cancelled', partner: 'Brin' });
        expect(await taking).toMatchObject({ success: false, reason: 'cancelled', partner: 'Alda' });
        expect(a.w.sentOf('tradeCancel')).toEqual([]);
        expect(b.w.sentOf('tradeCancel')).toEqual([]);
    });

    test('no room in our backpack: one accept, inventory_full, and the cancel; the partner reads its variant', async () => {
        const { a, b, link } = tradePair();
        link.failCommit = (x, y) => {
            y.message("You don't have enough space in your inventory.");
            x.message("Brin doesn't have enough space in his inventory.");
        };
        const [give, take] = await Promise.all([a.bot.trade('Brin', { give: [40] }), b.bot.trade('Alda')]);
        expect(take).toMatchObject({ success: false, reason: 'inventory_full', received: [] });
        expect(give).toMatchObject({ success: false, reason: 'partner_inventory_full', gave: [] });
        expect(a.w.sentOf('tradeAccept')).toHaveLength(1);
        expect(b.w.sentOf('tradeAccept')).toHaveLength(1);
        expect(a.w.sentOf('tradeCancel').length + b.w.sentOf('tradeCancel').length).toBeGreaterThanOrEqual(1);
        expect(a.w.state.inventory).toHaveLength(3);
        await until(() => !a.sdk.getTrade() && !b.sdk.getTrade());
    });

    test('a failed money check never re-accepts, though the reset 0xEA is a new revision', async () => {
        const { a, b, link } = tradePair();
        link.failCommit = (x, y) => {
            x.message("You don't have enough money.");
            y.message("Alda doesn't have enough money.");
        };
        const [give, take] = await Promise.all([a.bot.trade('Brin', { give: [40], money: 500 }), b.bot.trade('Alda')]);
        expect(give).toMatchObject({ success: false, reason: 'insufficient_funds' });
        expect(take).toMatchObject({ success: false, reason: 'partner_insufficient_funds' });
        expect(a.w.sentOf('tradeAccept')).toHaveLength(1);
        expect(b.w.sentOf('tradeAccept')).toHaveLength(1);
        expect(a.w.state.inventory).toHaveLength(3);
    });

    test('a stranger\'s window is cancelled while waiting, once, and the real one then completes', async () => {
        const { a, b } = tradePair();
        const stranger = { id: 5, revision: 1, partnerName: 'Cade', mySlots: [], myMoney: 0, partnerItems: [tradeItem(50, 'rags')], partnerMoney: 0 };
        const taking = b.bot.trade('Alda');
        b.w.state.trade = stranger;
        const close = b.w.handlers.tradeCancel!;
        b.w.handlers.tradeCancel = (action, w) => { setTimeout(() => close(action, w), 40); }; // the close takes a while
        await until(() => b.w.sentOf('tradeCancel').length === 1 && !b.sdk.getTrade());
        b.w.handlers.tradeCancel = close;
        const give = await a.bot.trade('Brin', { give: [40] });
        const take = await taking;
        expect(give.success).toBe(true);
        expect(take.received.map(i => i.name)).toEqual(['sleeves']);
        expect(b.w.sentOf('tradeCancel')).toHaveLength(1);
        expect(b.w.sentOf('tradeAccept')).toHaveLength(1);
    });

    test('a self-craft window is never accepted', async () => {
        const { b } = tradePair();
        b.w.state.trade = { id: 6, revision: 1, partnerName: null, mySlots: [], myMoney: 0, partnerItems: [], partnerMoney: 0 };
        b.w.publish();
        const r = await b.bot.acceptTrade({ timeout: 60 });
        expect(r).toMatchObject({ success: false, reason: 'timeout' });
        expect(b.w.sentOf('tradeAccept')).toEqual([]);
    });

    test('acceptTrade takes whoever opens one; `from` only that player', async () => {
        const open = tradePair();
        const any = open.b.bot.acceptTrade();
        await open.a.bot.offerTrade('Brin', { give: [40] });
        expect((await open.a.bot.acceptTrade()).success).toBe(true);
        expect((await any).received.map(i => i.name)).toEqual(['sleeves']);

        const narrow = tradePair();
        const r = narrow.b.bot.acceptTrade({ from: /^Cade$/, timeout: 100 });
        await narrow.a.bot.offerTrade('Brin', { give: [40] });
        expect(await r).toMatchObject({ success: false, reason: 'timeout', partner: null });
        expect(narrow.b.w.sentOf('tradeAccept')).toEqual([]);
        expect(narrow.b.w.sentOf('tradeCancel').length).toBeGreaterThanOrEqual(1);
        expect(await narrow.b.bot.acceptTrade({ from: 999 })).toMatchObject({ success: false, reason: 'not_found' });
    });

    test('a stale own item in a window is cancelled before offering', async () => {
        const { a, b } = tradePair();
        await a.bot.offerTrade('Brin', { give: [40] });
        const giving = a.bot.trade('Brin', { give: [41] });
        await until(() => a.sdk.getTrade()?.mySlots.includes(41));
        const take = await b.bot.trade('Alda');
        const give = await giving;
        expect(tradeActions(a.w).map(s => s.type).slice(0, 3)).toEqual(['tradeOfferItem', 'tradeCancel', 'tradeOfferItem']);
        expect(give.gave.map(i => i.name)).toEqual(['helm']);
        expect(take.received.map(i => i.name)).toEqual(['helm']);
        expect(a.w.state.inventory.map(i => i.name)).toEqual(['sleeves', 'boots']);
    });

    test('money is a target: more goes as the difference, less starts over', async () => {
        const { a } = tradePair();
        await a.bot.offerTrade('Brin', { money: 200 });
        const more = await a.bot.offerTrade('Brin', { money: 500 });
        expect(more).toMatchObject({ success: true, trade: { myMoney: 500 } });
        expect(a.w.sentOf('tradeOfferMoney').map(s => s.copper)).toEqual([200, 300]);
        expect(a.w.sentOf('tradeCancel')).toEqual([]);
        const less = await a.bot.offerTrade('Brin', { money: 100 });
        expect(less).toMatchObject({ success: true, trade: { myMoney: 100 } });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('a window the partner opened with its own items is kept', async () => {
        const { a, b } = tradePair([tradeItem(40, 'sleeves')], [tradeItem(40, 'gloves')]);
        await b.bot.offerTrade('Alda', { give: ['gloves'] });
        await until(() => a.sdk.getTrade());
        const r = await a.bot.offerTrade('Brin', { give: ['sleeves'] });
        expect(r).toMatchObject({ success: true, trade: { mySlots: [40], partnerItems: [{ name: 'gloves' }] } });
        expect(a.w.sentOf('tradeCancel')).toEqual([]);
    });

    test('offerTrade leaves the window open for acceptTrade', async () => {
        const { a, b } = tradePair();
        const r = await a.bot.offerTrade('Brin', { give: [40], money: 7 });
        expect(r).toMatchObject({ success: true, partner: { name: 'Brin' }, trade: { mySlots: [40], myMoney: 7, partnerName: 'Brin' } });
        expect(a.w.sentOf('tradeCancel')).toEqual([]);
        const take = b.bot.acceptTrade();
        expect(await a.bot.acceptTrade()).toMatchObject({ success: true, moneyGiven: 7, gave: [{ name: 'sleeves' }] });
        expect(await take).toMatchObject({ success: true, moneyReceived: 7, received: [{ name: 'sleeves' }] });
    });

    test('a close and a reopen in one snapshot is cancelled, by window id, at the same revision', async () => {
        const { a, b, link } = tradePair();
        const taking = b.bot.trade('Alda');
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        link.close();
        a.w.handlers.tradeOfferItem!({ type: 'tradeOfferItem', partnerObjectId: 300, slot: 41 }, a.w);
        expect(b.w.state.trade?.revision).toBe(1);
        expect(await taking).toMatchObject({ success: false, reason: 'cancelled' });
        expect(b.w.sentOf('tradeAccept')).toHaveLength(1);
        expect(b.w.sentOf('tradeCancel')).toHaveLength(1); // the new window isn't ours to hold
    });

    test('a window closed mid-offer and reopened by the next add is cancelled, not half an offer', async () => {
        const { a, link } = tradePair();
        const real = a.w.handlers.tradeOfferItem!;
        a.w.handlers.tradeOfferItem = (action, w) => {
            if (action.type === 'tradeOfferItem' && action.slot === 41) link.close();
            return real(action, w);
        };
        const r = await a.bot.offerTrade('Brin', { give: [40, 41] });
        expect(r).toMatchObject({ success: false, reason: 'cancelled' });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('a window with someone else than asked is wrong_partner', async () => {
        const { a } = tradePair();
        const real = a.w.handlers.tradeOfferItem!;
        a.w.handlers.tradeOfferItem = (action, w) => {
            const r = real(action, w);
            w.state.trade = { ...w.state.trade!, partnerName: 'Brinn' };
            return r;
        };
        expect(await a.bot.offerTrade('Brin', { give: [40] })).toMatchObject({ success: false, reason: 'wrong_partner' });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('an identical swap in a reused slot is no false item_missing', async () => {
        const { a, b } = tradePair([tradeItem(40, 'potion', 3)], [tradeItem(40, 'potion', 3)]);
        const [ra, rb] = await Promise.all([a.bot.trade('Brin', { give: ['potion'] }), b.bot.trade('Alda', { give: ['potion'] })]);
        expect(ra).toMatchObject({ success: true, missing: [] });
        expect(rb).toMatchObject({ success: true, missing: [] });
        expect(ra.received.map(i => i.slot)).toEqual([40]);
    });

    test('a new identical item is told from the one we had', async () => {
        const { a, b } = tradePair([tradeItem(40, 'potion')], [tradeItem(40, 'potion')]);
        const [, take] = await Promise.all([a.bot.trade('Brin', { give: ['potion'] }), b.bot.trade('Alda')]);
        expect(take.received.map(i => i.slot)).toEqual([41]);
    });

    test('completed, but the item never came: item_missing', async () => {
        const { a, b, link } = tradePair();
        link.losesItems = b.w;
        const [give, take] = await Promise.all([a.bot.trade('Brin', { give: [40] }), b.bot.trade('Alda')]);
        expect(give.success).toBe(true);
        expect(take).toMatchObject({ success: false, reason: 'item_missing', received: [], missing: [{ name: 'sleeves' }] });
        expect(b.w.sentOf('tradeCancel')).toEqual([]);
    });

    test('bad offers send nothing', async () => {
        const many = Array.from({ length: 11 }, (_, i) => tradeItem(40 + i, `item ${String.fromCharCode(97 + i)}`));
        const { a } = tradePair(many);
        const offers: [Parameters<BotActions['offerTrade']>[1], string][] = [
            [{ give: many }, 'too_many_items'],
            [{ money: 10251 }, 'insufficient_funds'],
            [{ give: [40, 'item a'] }, 'bad_args'],
            [{ money: -5 }, 'bad_args'],
            [{ money: 1.5 }, 'bad_args'],
            [{}, 'bad_args'],
            [{ give: ['no such thing'] }, 'not_found'],
        ];
        for (const [options, reason] of offers) expect(await a.bot.offerTrade('Brin', options)).toMatchObject({ success: false, reason, partner: null });
        expect(await a.bot.trade('Brin', { money: -5 })).toMatchObject({ success: false, reason: 'bad_args' });
        expect(a.w.sent).toEqual([]);
    });

    test('a substring names nobody: a wrong match would hand items to another player', async () => {
        const { a } = tradePair();
        expect(await a.bot.offerTrade('Bri', { give: [40] })).toMatchObject({ success: false, reason: 'not_found' });
        expect(await a.bot.trade('Bri', { give: [40] })).toMatchObject({ success: false, reason: 'not_found' });
        expect(a.w.sent).toEqual([]);
        // ...and the window of a waiter is held to the same exact name.
        const r = a.bot.trade('Bri', { timeout: 60 });
        a.w.state.trade = { id: 7, revision: 1, partnerName: 'Brin', mySlots: [], myMoney: 0, partnerItems: [], partnerMoney: 0 };
        expect(await r).toMatchObject({ success: false, reason: 'timeout' });
        expect(a.w.sentOf('tradeAccept')).toEqual([]);
    });

    test('a waiter needs no partner in view by name, but an unknown object id names nobody', async () => {
        const { a, b } = tradePair();
        b.w.state.nearbyPlayers = [];
        const taking = b.bot.trade('Alda');
        await a.bot.offerTrade('Brin', { give: [40] });
        await a.bot.acceptTrade();
        expect((await taking).received).toHaveLength(1);
        expect(await b.bot.trade(100)).toMatchObject({ success: false, reason: 'not_found', partner: null });
    });

    test('not in game, and dead', async () => {
        const gone = world({ player: null });
        expect(await gone.bot.offerTrade('Brin', { give: [40] })).toMatchObject({ success: false, reason: 'not_in_game' });
        expect(await gone.bot.trade('Brin')).toMatchObject({ success: false, reason: 'not_in_game' });
        const dead = world({ player: makePlayer({ isDead: true }) });
        expect(await dead.bot.offerTrade('Otherguy', { money: 1 })).toMatchObject({ success: false, reason: 'dead' });
    });

    test('the deadlines: no window, and a partner that never accepts', async () => {
        const { a, b } = tradePair();
        expect(await b.bot.trade('Alda', { timeout: 50 })).toMatchObject({ success: false, reason: 'timeout', partner: null });
        // An add that opens a window waits for its slot on the clock, and 100 ms may not reach it: start in the slot, or this reads 'timeout' most of the time.
        await Bun.sleep(tradeSlotWait(Date.now(), false));
        expect(await a.bot.trade('Brin', { give: [40], timeout: 100 })).toMatchObject({ success: false, reason: 'partner_no_accept', partner: 'Brin' });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
        await until(() => !a.sdk.getTrade());
    });

    test('no answer to an add is no_response, and the phantom it may leave gets a cancel', async () => {
        const { a } = tradePair();
        a.w.handlers.tradeOfferItem = () => {};
        expect(await a.bot.offerTrade('Brin', { give: [40], timeout: 900 })).toMatchObject({ success: false, reason: 'no_response' });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('an add the client refuses says why: the item left the backpack since the snapshot', async () => {
        const { a } = tradePair();
        a.w.handlers.tradeOfferItem = () => ({ success: false, message: 'no item in slot 40', reason: 'empty_slot', phase: 'validation' });
        expect(await a.bot.offerTrade('Brin', { give: [40] })).toMatchObject({ success: false, reason: 'empty_slot' });
    });

    test('an accept that crossed a new offer is sent again; any other dispatch failure ends it', async () => {
        const { a, b } = tradePair();
        const real = b.w.handlers.tradeAccept!;
        let calls = 0;
        b.w.handlers.tradeAccept = (action, w) => ++calls === 1 ? { success: false, message: 'changed', reason: 'trade_changed', phase: 'validation' } : real(action, w);
        const taking = b.bot.acceptTrade();
        await a.bot.offerTrade('Brin', { give: [40] });
        expect((await a.bot.acceptTrade()).success).toBe(true);
        expect((await taking).success).toBe(true);
        expect(calls).toBe(2);

        const down = tradePair();
        down.b.w.handlers.tradeAccept = () => ({ success: false, message: 'not in game', reason: 'not_in_game', phase: 'validation' });
        const lost = down.b.bot.acceptTrade();
        await down.a.bot.offerTrade('Brin', { give: [40] });
        expect(await lost).toMatchObject({ success: false, reason: 'not_in_game' });
    });

    test('a walk that fails ends the offer with its reason, and closes a window already there', async () => {
        const { a, b } = tradePair();
        await b.bot.offerTrade('Alda', { money: 5 });
        await until(() => a.sdk.getTrade());
        a.w.state.nearbyPlayers = [makePlayerObj({ objectId: 300, name: 'Brin', x: 561000 })];
        a.w.publish();
        a.w.handlers.moveTo = () => ({ success: false, message: 'no', reason: 'stuck', phase: 'validation' });
        const r = await a.bot.offerTrade('Brin', { give: [40] });
        expect(r).toMatchObject({ success: false, reason: 'stuck', partner: { name: 'Brin' } });
        expect(a.w.sentOf('tradeOfferItem')).toEqual([]);
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('walks up to a partner across the field, within the range asked for', async () => {
        const { a } = tradePair();
        a.w.state.nearbyPlayers = [makePlayerObj({ objectId: 300, name: 'Brin', x: 561000 })];
        a.w.publish();
        const r = await a.bot.offerTrade('Brin', { give: [40], range: 80 });
        expect(r.success).toBe(true);
        expect(Math.abs(561000 - a.w.player.x)).toBeLessThanOrEqual(80);
    });

    test('an abort in the wait still closes the window', async () => {
        const { a } = tradePair();
        await expect(abortAfter(60, () => a.bot.trade('Brin', { give: [40] }))).rejects.toThrow('cancelled');
        expect(a.w.sentOf('tradeOfferItem')).toHaveLength(1);
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
        await until(() => !a.sdk.getTrade());
    });

    test('an abort mid-offer still closes the window', async () => {
        const { a } = tradePair();
        a.w.handlers.tradeOfferItem = () => {};
        await expect(abortAfter(30, () => a.bot.offerTrade('Brin', { give: [40] }))).rejects.toThrow('cancelled');
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('a commit our last accept makes at the deadline is a completed trade, not partner_no_accept', async () => {
        const { a, b } = tradePair();
        await a.bot.offerTrade('Brin', { give: [40] });
        const taking = b.bot.acceptTrade();
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        expect(await a.bot.acceptTrade({ timeout: 0 })).toMatchObject({ success: true, gave: [{ name: 'sleeves' }], message: 'Trade Completed. 1 items for 0 items.' });
        expect(await taking).toMatchObject({ success: true, received: [{ name: 'sleeves' }] });
    });

    test('a partner\'s accept that gets in before our close at the deadline is a completed trade too', async () => {
        const { a, b, link } = tradePair();
        const cancel = a.w.handlers.tradeCancel!;
        a.w.handlers.tradeCancel = (action, w) => {
            b.w.handlers.tradeAccept!({ type: 'tradeAccept' }, b.w); // it reached the server first
            if (link.open) return cancel(action, w);
        };
        expect(await a.bot.trade('Brin', { give: [40], timeout: 60 })).toMatchObject({ success: true, gave: [{ name: 'sleeves' }] });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
        expect(b.w.state.inventory.map(i => i.name)).toEqual(['sleeves']);
    });

    test('acceptTrade finishes the window of the offer: one that replaced it is closed, not accepted', async () => {
        const { a, b } = tradePair([tradeItem(40, 'sleeves')], [tradeItem(40, 'gloves')]);
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.sdk.getTrade());
        expect(await b.bot.cancelTrade()).toMatchObject({ success: true });
        await b.bot.offerTrade('Alda', { give: ['gloves'] });
        await until(() => a.sdk.getTrade()?.partnerItems.length);
        expect(await a.bot.acceptTrade({ from: 'Brin' })).toMatchObject({ success: false, reason: 'cancelled', gave: [], received: [] });
        expect(a.w.sentOf('tradeAccept')).toEqual([]);
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
        expect(a.sdk.getTrade()).toBeNull();
        expect(a.w.state.inventory.map(i => i.name)).toEqual(['sleeves']);
    });

    test('acceptTrade after an offer whose window has closed is cancelled at once', async () => {
        const { a, b } = tradePair();
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.sdk.getTrade());
        await b.bot.cancelTrade();
        await until(() => !a.sdk.getTrade());
        const started = Date.now();
        expect(await a.bot.acceptTrade()).toMatchObject({ success: false, reason: 'cancelled', partner: 'Brin' });
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test('an acceptTrade with no offer of its own, in a new script, takes the window as it stands', async () => {
        const { a, b } = tradePair();
        await a.bot.offerTrade('Brin', { give: [40] });
        const take = b.bot.acceptTrade();
        expect(await new BotActions(a.sdk).acceptTrade()).toMatchObject({ success: true, gave: [{ name: 'sleeves' }] });
        expect((await take).success).toBe(true);
    });

    test('a failure returns with the window gone, so a retry starts a new one', async () => {
        const { a } = tradePair();
        const close = a.w.handlers.tradeCancel!;
        a.w.handlers.tradeCancel = (action, w) => { setTimeout(() => close(action, w), 40); }; // the 0xEA takes a while
        expect(await a.bot.trade('Brin', { give: [40], timeout: 50 })).toMatchObject({ success: false, reason: 'partner_no_accept' });
        expect(a.sdk.getTrade()).toBeNull();
        expect(await a.bot.offerTrade('Brin', { give: [40] })).toMatchObject({ success: true, trade: { mySlots: [40] } });
        expect(a.w.sentOf('tradeOfferItem')).toHaveLength(2);
    });

    test('a failed offer returns with the window gone too', async () => {
        const { a } = tradePair();
        const close = a.w.handlers.tradeCancel!;
        a.w.handlers.tradeCancel = (action, w) => { setTimeout(() => close(action, w), 40); };
        const real = a.w.handlers.tradeOfferItem!;
        a.w.handlers.tradeOfferItem = (action, w) => {
            if (action.type === 'tradeOfferItem' && action.slot === 41) w.message("You can't trade this item!");
            else return real(action, w);
        };
        expect(await a.bot.offerTrade('Brin', { give: [40, 41] })).toMatchObject({ success: false, reason: 'refused' });
        expect(a.sdk.getTrade()).toBeNull();
    });

    test('the walk in an offer keeps to the budget of the whole call while the partner runs on', async () => {
        const { a } = tradePair();
        a.w.state.nearbyPlayers = [makePlayerObj({ objectId: 300, name: 'Brin', x: 561000 })];
        a.w.stepSize = 40;
        a.w.onTick = w => {
            const brin = w.state.nearbyPlayers[0]!;
            if (Math.abs(brin.x - w.player.x) < 100) brin.x += 1000;
        };
        a.w.publish();
        const started = Date.now();
        expect(await a.bot.trade('Brin', { give: [40], timeout: 350 })).toMatchObject({ success: false, reason: 'timeout' });
        expect(Date.now() - started).toBeLessThan(800); // four legs of about 250 ms before
        expect(a.w.sentOf('tradeOfferItem')).toEqual([]);
    });

    test('no budget left at an add is a timeout, and the add stays home', async () => {
        const { a } = tradePair();
        expect(await a.bot.offerTrade('Brin', { give: [40], timeout: 0 })).toMatchObject({ success: false, reason: 'timeout' });
        expect(a.w.sentOf('tradeOfferItem')).toEqual([]);
    });

    test('an accept judged on one window never lands on the next, at the same revision', async () => {
        const { a, b, link } = tradePair();
        const real = b.w.handlers.tradeAccept!;
        const answers: unknown[] = [];
        b.w.handlers.tradeAccept = (action, w) => {
            link.close();
            a.w.handlers.tradeOfferItem!({ type: 'tradeOfferItem', partnerObjectId: 300, slot: 41 }, a.w); // reopened before the accept got through
            const answer = real(action, w);
            answers.push(answer);
            return answer;
        };
        const taking = b.bot.trade('Alda');
        void a.bot.offerTrade('Brin', { give: [40] });
        expect(await taking).toMatchObject({ success: false, reason: 'cancelled' });
        expect(answers).toMatchObject([{ reason: 'trade_changed' }]);
        expect(a.w.state.inventory).toHaveLength(3);
        await until(() => !b.sdk.getTrade());
    });

    test('a commit and a new window in one snapshot: the trade is done, and the new window is closed', async () => {
        const { a, b } = tradePair();
        const taking = b.bot.trade('Alda');
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        const real = a.w.handlers.tradeAccept!;
        a.w.handlers.tradeAccept = (action, w) => {
            const r = real(action, w);
            a.w.handlers.tradeOfferItem!({ type: 'tradeOfferItem', partnerObjectId: 300, slot: 41 }, a.w);
            b.w.publish();
            return r;
        };
        void a.bot.acceptTrade();
        expect(await taking).toMatchObject({ success: true, received: [{ name: 'sleeves' }] });
        expect(b.w.sentOf('tradeCancel')).toHaveLength(1);
        expect(b.sdk.getTrade()).toBeNull();
        expect(a.w.state.inventory.map(i => i.name)).toEqual(['helm', 'boots']);
    });

    test('an identical item we already held hides no lost item', async () => {
        const { a, b, link } = tradePair([tradeItem(40, 'sleeves')], [tradeItem(45, 'sleeves')]);
        link.losesItems = b.w;
        const [, take] = await Promise.all([a.bot.trade('Brin', { give: [40] }), b.bot.trade('Alda')]);
        expect(take).toMatchObject({ success: false, reason: 'item_missing', received: [], missing: [{ name: 'sleeves' }] });
    });

    test('received names the item that came, not an old twin of it', async () => {
        const mine = [40, 41, 42, 43, 44, 45].map(slot => tradeItem(slot, slot === 42 || slot === 45 ? 'sword' : `filler ${slot}`));
        const { a, b } = tradePair(mine, [tradeItem(40, 'sword')]);
        const [ra] = await Promise.all([a.bot.trade('Brin', { give: [45] }), b.bot.trade('Alda', { give: [40] })]);
        expect(ra.received.map(i => i.slot)).toEqual([45]); // the first slot free, not 42
    });

    test('an item object that has gone names nothing: no longer name wins, and nothing is offered', async () => {
        const { a } = tradePair([tradeItem(45, 'Sleeves'), tradeItem(50, 'Quilted Sleeves of Might')]);
        const sleeves = a.sdk.getInventoryItem(45)!;
        a.w.state.inventory = a.w.state.inventory.filter(i => i.slot !== 45);
        a.w.publish();
        expect(await a.bot.trade('Brin', { give: [sleeves] })).toMatchObject({ success: false, reason: 'not_found' });
        expect(a.w.sent).toEqual([]);
    });

    test('a receive-only trade closes a leftover window of ours instead of accepting it', async () => {
        const { a, b } = tradePair();
        await a.bot.offerTrade('Brin', { give: [40] });
        const take = b.bot.acceptTrade({ timeout: 300 }); // its accept stands: ours would commit
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        expect(await new BotActions(a.sdk).trade('Brin', { timeout: 100 })).toMatchObject({ success: false, reason: 'timeout', gave: [] });
        expect(a.w.sentOf('tradeAccept')).toEqual([]);
        expect(a.w.sentOf('tradeCancel').length).toBeGreaterThanOrEqual(1);
        expect(a.w.state.inventory.map(i => i.name)).toEqual(['sleeves', 'helm', 'boots']);
        expect(await take).toMatchObject({ success: false, reason: 'cancelled' });
    });

    test('a receive-only trade still takes a clean window after closing the leftover', async () => {
        const { a, b } = tradePair();
        await a.bot.offerTrade('Brin', { give: [40] });
        const receiving = a.bot.trade('Brin');
        await until(() => a.w.sentOf('tradeCancel').length === 1 && !a.sdk.getTrade());
        const give = await b.bot.trade('Alda', { money: 5 });
        expect(give.success).toBe(true);
        expect(await receiving).toMatchObject({ success: true, gave: [], moneyReceived: 5 });
        expect(a.w.state.inventory).toHaveLength(3);
    });

    test('every early refusal closes a window already open', async () => {
        const refusals: Array<[string, (bot: BotActions) => Promise<ActionResult>, string]> = [
            ['no such item', bot => bot.trade('Brin', { give: ['no such item'] }), 'not_found'],
            ['over the purse', bot => bot.offerTrade('Brin', { money: 10251 }), 'insufficient_funds'],
            ['bad money', bot => bot.offerTrade('Brin', { money: -5 }), 'bad_args'],
            ['a partner nobody has', bot => bot.trade('Nobody', { give: [40] }), 'not_found'],
            ['a waiter for an unknown id', bot => bot.trade(999), 'not_found'],
            ['an accept from an unknown id', bot => bot.acceptTrade({ from: 999 }), 'not_found'],
        ];
        for (const [, call, reason] of refusals) {
            const { a, b } = tradePair();
            const waiting = b.bot.trade('Alda', { give: [], accept: () => false });
            await a.bot.offerTrade('Brin', { money: 5 });
            await until(() => b.sdk.getTrade());
            expect(await call(a.bot)).toMatchObject({ success: false, reason });
            expect(a.sdk.getTrade()).toBeNull();
            expect(await waiting).toMatchObject({ success: false, reason: 'cancelled' });
        }
    });

    test('a snapshot of a player goes by the name: a newcomer on the freed id gets nothing', async () => {
        const { a } = tradePair();
        const brin = a.sdk.getNearbyPlayers()[0]!;
        a.w.state.nearbyPlayers = [makePlayerObj({ objectId: 300, name: 'Bob', x: 560050 })];
        a.w.publish();
        expect(await a.bot.trade(brin, { give: [40] })).toMatchObject({ success: false, reason: 'not_found' });
        expect(a.w.sent).toEqual([]);
        a.w.state.nearbyPlayers = [makePlayerObj({ objectId: 301, name: 'Brin', x: 560050 })]; // back, under a new id
        a.w.publish();
        expect(await a.bot.offerTrade(brin, { give: [40] })).toMatchObject({ success: true, partner: { objectId: 301 } });
        expect(a.w.sentOf('tradeOfferItem')[0]).toMatchObject({ partnerObjectId: 301 });
    });

    test('a pattern gives nothing: it could match anyone in view', async () => {
        const { a } = tradePair();
        a.w.state.nearbyPlayers = [makePlayerObj({ objectId: 300, name: 'Germaine', x: 560050 })];
        a.w.publish();
        expect(await a.bot.trade(/aine/i, { give: [40] })).toMatchObject({ success: false, reason: 'bad_args' });
        expect(await a.bot.offerTrade(/aine/i, { money: 5 })).toMatchObject({ success: false, reason: 'bad_args' });
        expect(a.w.sent).toEqual([]);
    });

    test('our own item leaving the offer is never accepted: the swap ends, and nothing moves', async () => {
        const { a, b, link } = tradePair([tradeItem(40, 'sword')], [tradeItem(40, 'gloves')]);
        await a.bot.offerTrade('Brin', { give: [40] });
        const swapping = b.bot.trade('Alda', { give: ['gloves'] });
        await until(() => b.w.sentOf('tradeAccept').length === 1);
        link.drop(b.w, 40);
        expect(await swapping).toMatchObject({ success: false, reason: 'offer_changed', gave: [] });
        expect(b.w.sentOf('tradeAccept')).toHaveLength(1);
        expect(b.w.sentOf('tradeCancel')).toHaveLength(1);
        expect(await a.bot.acceptTrade()).toMatchObject({ success: false, reason: 'cancelled' });
        expect(a.w.state.inventory.map(i => i.name)).toEqual(['sword']);
        expect(b.w.state.inventory.map(i => i.name)).toEqual(['gloves']);
    });

    test('a client without the trade code says so at once, also to a waiter', async () => {
        const { b } = tradePair();
        b.w.state.trade = undefined; // an older client's state has no such field
        b.w.publish();
        const started = Date.now();
        expect(await b.bot.trade('Alda')).toMatchObject({ success: false, reason: 'unknown_action' });
        expect(await b.bot.acceptTrade()).toMatchObject({ success: false, reason: 'unknown_action' });
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test('an abort of a waiter sends the cancel too', async () => {
        const { b } = tradePair();
        await expect(abortAfter(30, () => b.bot.acceptTrade())).rejects.toThrow('cancelled');
        expect(b.w.sentOf('tradeCancel')).toHaveLength(1);
    });
});

describe('cancelTrade', () => {
    test('closes a window on both sides, and the partner reads cancelled', async () => {
        const { a, b } = tradePair();
        const taking = b.bot.trade('Alda', { accept: () => false });
        await a.bot.offerTrade('Brin', { give: [40] });
        await until(() => b.sdk.getTrade());
        expect(await a.bot.cancelTrade()).toMatchObject({ success: true });
        expect(a.sdk.getTrade()).toBeNull();
        expect(await taking).toMatchObject({ success: false, reason: 'cancelled' });
    });

    test('no window is a success, and the close still goes: it cures a phantom', async () => {
        const { a } = tradePair();
        expect(await a.bot.cancelTrade()).toMatchObject({ success: true });
        expect(a.w.sentOf('tradeCancel')).toHaveLength(1);
    });

    test('a window that stays open is a timeout', async () => {
        const { a } = tradePair();
        a.w.state.trade = { id: 8, revision: 1, partnerName: 'Brin', mySlots: [], myMoney: 0, partnerItems: [], partnerMoney: 0 };
        a.w.publish();
        a.w.handlers.tradeCancel = () => {};
        expect(await a.bot.cancelTrade()).toMatchObject({ success: false, reason: 'timeout' });
    });

    test('a commit that won the race is already_completed', async () => {
        const { a } = tradePair();
        a.w.state.trade = { id: 9, revision: 1, partnerName: 'Brin', mySlots: [40], myMoney: 0, partnerItems: [], partnerMoney: 0 };
        a.w.publish();
        a.w.handlers.tradeCancel = (_action, w) => {
            w.message('Trade Completed. 1 items for 0 items.');
            w.state.trade = null;
        };
        expect(await a.bot.cancelTrade()).toMatchObject({ success: false, reason: 'already_completed', message: 'Trade Completed. 1 items for 0 items.' });
    });
});

describe('attack: a target that died as we came', () => {
    // 20261104-044005: `You enter combat mode and target [Rethe]`, `Rethe is already dead!` +11.6, +13.4 and on, atk:true, 8 s with the pet's order held behind it.
    const answering = (line: string, afterMs: number | null) => (a: BotAction, w: FakeWorld) => {
        if (a.type !== 'attack') return;
        w.player.attacking = a.on;
        if (!a.on) return;
        if (afterMs === null) w.message(line);
        else setTimeout(() => w.message(line), afterMs);
    };

    test('a player: the line comes with the first swing round: already_dead, and attack mode goes off', async () => {
        const { w, bot } = world({ nearbyNpcs: [], nearbyPlayers: [makePlayerObj({ objectId: 415, name: 'Briton', realm: 'hibernia', x: 560050, y: 511000, distance: 50, distance2d: 50 })] });
        w.handlers.attack = answering('Rethe is already dead!', 15);
        const r = await bot.attack(415);
        expect(r).toMatchObject({ success: false, reason: 'already_dead', message: 'Rethe is already dead!' });
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
        expect(w.player.attacking).toBe(false);
    });

    test('a monster: the same, the line beside attack mode', async () => {
        const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 700, name: 'young wolf', x: 560050, y: 511000, distance: 50, distance2d: 50 })], nearbyPlayers: [] });
        w.handlers.attack = answering('The young wolf is already dead!', null);
        expect(await bot.attack(700)).toMatchObject({ success: false, reason: 'already_dead' });
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
    });

    describe('a swing standing on the last target says it of that one, until the select reaches the server (AttackComponent.cs:1712)', () => {
        const carried = (o: Partial<BotWorldState>) => {
            const made = world(o);
            made.w.player.attacking = true;
            made.w.player.targetObjectId = 900;
            made.w.publish();
            return made;
        };

        test('a living player beside us: no already_dead, and the good swing stays on', async () => {
            const { w, bot } = carried({ nearbyNpcs: [], nearbyPlayers: [makePlayerObj({ objectId: 415, name: 'Briton', realm: 'hibernia', x: 560050, y: 511000, distance: 50, distance2d: 50 })] });
            w.handlers.attack = answering('The young wolf is already dead!', 15);
            expect(await bot.attack(415)).toMatchObject({ success: true });
            expect(w.sentOf('attack').map(a => a.on)).toEqual([true]);
            expect(w.player.attacking).toBe(true);
        });

        test('a living monster of the same name, the line beside attack mode: the same', async () => {
            const { w, bot } = carried({ nearbyNpcs: [makeNpc({ objectId: 700, name: 'young wolf', x: 560050, y: 511000, distance: 50, distance2d: 50 })], nearbyPlayers: [] });
            w.handlers.attack = answering('The young wolf is already dead!', null);
            expect(await bot.attack(700)).toMatchObject({ success: true });
            expect(w.sentOf('attack').map(a => a.on)).toEqual([true]);
        });

        test('this one seen dead in the same moment: its own, and the swing goes off', async () => {
            const target = makePlayerObj({ objectId: 415, name: 'Briton', realm: 'hibernia', x: 560050, y: 511000, distance: 50, distance2d: 50 });
            const { w, bot } = carried({ nearbyNpcs: [], nearbyPlayers: [target] });
            w.handlers.attack = (a, world) => {
                if (a.type !== 'attack') return;
                world.player.attacking = a.on;
                if (a.on) setTimeout(() => { world.state.nearbyPlayers = world.state.nearbyPlayers.map(p => ({ ...p, isDead: true, healthPercent: 0 })); world.message('Rethe is already dead!'); }, 15);
            };
            expect(await bot.attack(415)).toMatchObject({ success: false, reason: 'already_dead' });
            expect(w.player.attacking).toBe(false);
        });
    });

    test('another refusal for good reads refused, and ends the swing too: the server says it again each round', async () => {
        const { w, bot } = world({ nearbyNpcs: [], nearbyPlayers: [makePlayerObj({ objectId: 415, name: 'Briton', realm: 'hibernia', x: 560050, y: 511000, distance: 50, distance2d: 50 })] });
        w.handlers.attack = answering("You can't attack a member of your realm!", 15);
        expect(await bot.attack(415)).toMatchObject({ success: false, reason: 'refused' });
        expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
    });
});

// ── Pets ────────────────────────────────────────────────────────────────────

describe('pets', () => {
    const spellOf = (name: string, internalId: number, level = 1, spellIndex = 0) => ({ name, level, internalId, lineName: 'Line', lineIndex: 0, spellIndex, cooldownRemaining: 0 });
    const simulacrum = spellOf('Amber Simulacrum', 801);
    const earth = spellOf('Call Minor Earth Elemental', 101);
    const bomber = spellOf('Wisp Heat', 11317);
    const charm = spellOf('Persuade Will', 951, 1);
    const turret = spellOf("Grove's Assaillant", 11462);
    const minion = spellOf('Summon Bone Dart', 10151);
    const onPetSpell = spellOf('Reflect Attack', 571);
    const skillsWith = (...spells: ReturnType<typeof spellOf>[]) => ({ specializations: [], abilities: [], styles: [], spells });

    const PET_ID = 600;
    const petNpc = (o: Partial<NearbyNpc> = {}) => makeNpc({ objectId: PET_ID, name: 'amber simulacrum', level: 5, realm: 'albion', isPet: true, x: 560064, y: 511000, ...o });
    const petWindow = (o: Partial<PetState> = {}): PetState => ({ objectId: PET_ID, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null, ...o });
    const mob = (o: Partial<NearbyNpc> = {}) => makeNpc({ objectId: 700, name: 'young wolf', level: 5, x: 560500, y: 511000, ...o });
    const SPIRIT_ID = 610;
    /** A pet with no window: state.summons lists it. */
    const spirit = (o: Partial<NearbyNpc> = {}) => makeNpc({ objectId: SPIRIT_ID, name: 'air spirit', level: 8, realm: 'albion', isPet: true, x: 560064, y: 511000, ...o });

    /** A world with a pet up: its window and its NPC. */
    const petWorld = (o: Partial<BotWorldState> = {}) => {
        const made = world({ pet: petWindow(), nearbyNpcs: [petNpc(), mob()], nearbyObjects: [], ...o });
        orders(made.w);
        return made;
    };

    /** Like client.execute('petCommand'): nothing dispatched without a window, a chosen target selected first. `answer` plays the server. */
    const orders = (w: FakeWorld, answer: (a: Extract<BotAction, { type: 'petCommand' }>, w: FakeWorld) => void = () => {}) => {
        w.handlers.petCommand = (a, world) => {
            if (a.type !== 'petCommand') return;
            if (a.targetObjectId !== undefined) world.player.targetObjectId = a.targetObjectId;
            setTimeout(() => answer(a, world), 5);
        };
    };

    /** Plays a summon: "You cast", then the pet's 0xDA, 0x88 open and the line (SpellHandler.cs:1337, SummonSpellHandler.cs:58-67, :176-178). */
    const summons = (w: FakeWorld, spell: string, name: string, opts: { window?: boolean; id?: number } = {}) => {
        w.handlers.castSpell = (_a, world) => {
            setTimeout(() => {
                world.message(`You cast a ${spell} spell!`, { type: 'spell' });
                world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc({ objectId: opts.id ?? PET_ID, name })];
                if (opts.window !== false) world.state.pet = petWindow({ objectId: opts.id ?? PET_ID });
                world.message(`The ${name} is now under your control.`, { type: 'spell' });
            }, 10);
        };
    };

    /** A target's death as the client sees it: 0xA2 type 0, then the XP line that ends the settling. */
    const dies = (w: FakeWorld, id: number) => {
        w.removeNpc(id);
        w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: id, targetHealthPercent: 0 });
        w.message('You get 1 experience points.', { type: 'important' });
    };

    describe('orders', () => {
        const cases: [string, (bot: BotActions) => Promise<PetCommandResult>, PetCommand, string][] = [
            ['petFollow', bot => bot.petFollow(), 'follow', 'You command the amber simulacrum to follow you!'],
            ['petStay', bot => bot.petStay(), 'stay', 'You command the amber simulacrum to stay in this position!'],
            ['petComeHere', bot => bot.petComeHere(), 'comeHere', 'You command the amber simulacrum to come to you.'],
            ['petGoTo', bot => bot.petGoTo(700), 'goTarget', 'You command the amber simulacrum to go to your target.'],
            ['petAttack', bot => bot.petAttack(700), 'attack', 'You command the amber simulacrum to kill your target!'],
            ['aggressive', bot => bot.setPetAggression('aggressive'), 'aggressive', 'You command the amber simulacrum to attack all enemies!'],
            ['defensive', bot => bot.setPetAggression('defensive'), 'defensive', 'You command the amber simulacrum to defend you!'],
            ['passive', bot => bot.setPetAggression('passive'), 'passive', 'You command the amber simulacrum to disengage from combat!'],
        ];

        for (const [name, order, command, line] of cases) {
            test(`${name} succeeds on the server's line, one order per call`, async () => {
                const { w, bot } = petWorld();
                orders(w, (_a, world) => world.message(line));
                const r = await order(bot);
                expect(r).toMatchObject({ success: true, command, message: line });
                expect(r.pet?.objectId).toBe(PET_ID);
                expect(r.messages.map(m => m.text)).toContain(line);
                expect(w.sentOf('petCommand').map(a => a.command)).toEqual([command]);
            });
        }

        test('the window is the second evidence, and the result reports it after the line', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => { world.state.pet = petWindow({ aggression: 'passive' }); });
            const r = await bot.setPetAggression('passive');
            expect(r).toMatchObject({ success: true, petState: { aggression: 'passive' } });

            // Line first, the 0x88 a tick later (PlayerEffectListComponent.cs:100).
            orders(w, (_a, world) => {
                world.message('You command the amber simulacrum to stay in this position!');
                setTimeout(() => { world.state.pet = petWindow({ aggression: 'passive', walk: 'stay' }); }, 40);
            });
            expect(await bot.petStay()).toMatchObject({ success: true, petState: { walk: 'stay' } });
        });

        test('a repeat changes no window, so the line alone answers it at once', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => world.message('You command the amber simulacrum to follow you!'));
            const t0 = Date.now();
            expect(await bot.petFollow()).toMatchObject({ success: true, petState: { walk: 'follow' } });
            expect(Date.now() - t0).toBeLessThan(300);
        });

        test('no answer is no_response; a window already showing it is no evidence', async () => {
            const { w, bot } = petWorld();
            const r = await bot.setPetAggression('defensive', { timeout: 60 });
            expect(r).toMatchObject({ success: false, reason: 'no_response', command: 'defensive' });
            expect(w.sentOf('petCommand')).toHaveLength(1);
        });

        test('a pet that goes before the answer is no_pet', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => { world.state.pet = null; });
            expect(await bot.petStay()).toMatchObject({ success: false, reason: 'no_pet', petState: null });
        });

        test('speech is no answer: the lines are anchored', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => world.message('Otherguy says, "You command the wolf to follow you!"', { type: 'say' }));
            expect(await bot.petFollow({ timeout: 60 })).toMatchObject({ success: false, reason: 'no_response' });
        });

        test('without a window nothing is dispatched: the server would stay silent', async () => {
            const { w, bot } = world({ pet: null, nearbyNpcs: [mob()] });
            const calls = [
                bot.petFollow(), bot.petStay(), bot.petComeHere(), bot.petGoTo(700), bot.setPetAggression('passive'), bot.releasePet(), bot.petAttack(700),
            ];
            for (const r of await Promise.all(calls)) expect(r).toMatchObject({ success: false, reason: 'no_pet', petState: null, messages: [] });
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'no_pet', killed: false });
            expect(w.sent).toEqual([]);
        });

        test('a client without the field is older code: unknown_action, not no_pet', async () => {
            const { w, bot } = world({ nearbyNpcs: [mob()] });
            expect(await bot.petFollow()).toMatchObject({ success: false, reason: 'unknown_action' });
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'unknown_action' });
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'unknown_action' });
            expect(w.sent).toEqual([]);
        });

        test('petGoTo: its refusals, and a target it can\'t find', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => world.message('Your target is too far away for your pet to reach!'));
            expect(await bot.petGoTo(700)).toMatchObject({ success: false, reason: 'out_of_range', command: 'goTarget' });
            orders(w, (_a, world) => world.message('You must select a destination for your controlled creature.'));
            expect(await bot.petGoTo(700)).toMatchObject({ success: false, reason: 'no_target' });
            w.sent.length = 0;
            expect(await bot.petGoTo('nothing like it')).toMatchObject({ success: false, reason: 'not_found' });
            expect(w.sent).toEqual([]);
        });

        test('getPetAttackers: NPCs aiming at the pet, nearest first', () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560900, targetObjectId: PET_ID }), mob({ objectId: 702, x: 560100, targetObjectId: PET_ID }), mob({ objectId: 703, targetObjectId: 100 })] });
            w.publish();
            expect(bot.getPetAttackers().map(n => n.objectId)).toEqual([702, 701]);
        });

        test('getPetAttackers covers the summons, with or without a window', () => {
            const npcs = [petNpc(), spirit(), mob({ objectId: 701, x: 560900, targetObjectId: PET_ID }), mob({ objectId: 702, x: 560100, targetObjectId: SPIRIT_ID }), mob({ objectId: 703, targetObjectId: 999 })];
            const both = petWorld({ summons: [SPIRIT_ID], nearbyNpcs: npcs });
            expect(both.bot.getPetAttackers().map(n => n.objectId)).toEqual([702, 701]);
            const fnf = world({ pet: null, summons: [SPIRIT_ID], nearbyNpcs: npcs });
            expect(fnf.bot.getPetAttackers().map(n => n.objectId)).toEqual([702]);
            const older = world({ pet: null, nearbyNpcs: npcs });
            expect(older.bot.getPetAttackers()).toEqual([]);
        });
    });

    describe('petAttack', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';

        test('selects the target in the same order, and our target stays moved', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: 200 }) });
            orders(w, (_a, world) => world.message(KILL));
            const r = await bot.petAttack('young wolf');
            expect(r).toMatchObject({ success: true, command: 'attack', target: { objectId: 700 } });
            expect(w.sentOf('petCommand')[0]).toMatchObject({ command: 'attack', targetObjectId: 700 });
            expect(w.player.targetObjectId).toBe(700);
            expect(w.sentOf('setTarget')).toEqual([]);
        });

        test('restoreTarget selects the old target again, after a refusal too', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: 200 }) });
            orders(w, (_a, world) => world.message(KILL));
            expect(await bot.petAttack(700, { restoreTarget: true })).toMatchObject({ success: true });
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([200]);
            expect(w.player.targetObjectId).toBe(200);
            w.publish();

            orders(w, (_a, world) => world.message('Your target is too far away to attack with your pet!'));
            expect(await bot.petAttack(700, { restoreTarget: true })).toMatchObject({ success: false, reason: 'out_of_range' });
            expect(w.player.targetObjectId).toBe(200);
        });

        test('restoreTarget has nothing to do when the target was the old one, or with none before', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: 700 }) });
            orders(w, (_a, world) => world.message(KILL));
            await bot.petAttack(700, { restoreTarget: true });
            expect(w.sentOf('setTarget')).toEqual([]);
            w.player.targetObjectId = null;
            w.publish();
            await bot.petAttack(700, { restoreTarget: true });
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([null]);
        });

        test('refusals: out_of_range, immune with retryAfterMs, not_attackable (AbstractServerRules.cs:350-375, NormalServerRules.cs:38-72)', async () => {
            const { w, bot } = petWorld();
            const says = (line: string) => orders(w, (_a, world) => world.message(line));
            says('Your target is too far away to attack with your pet!');
            expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'out_of_range', target: { objectId: 700 } });
            for (const line of ["You can't attack players until your PvP invulnerability timer wears off!", 'Norseman is temporarily immune to PvP attacks!', 'Norseman is entering the game and cannot be attacked!']) {
                says(line);
                expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'immune', retryAfterMs: PVP_IMMUNE_RETRY_MS, message: line });
            }
            for (const line of ["You can't attack a member of your realm!", "You can't attack yourself!", "You can't attack a shadowed necromancer!"]) {
                says(line);
                expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'not_attackable', message: line });
            }
        });

        test('a target the server says nothing to: dead is ours to see, by its death event; anything else unanswered is no_response', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, healthPercent: 0 })] });
            w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 701, targetHealthPercent: 0 });
            w.publish();
            expect(await bot.petAttack(701)).toMatchObject({ success: false, reason: 'already_dead' });
            expect(await bot.petAttack('no such mob')).toMatchObject({ success: false, reason: 'not_found', target: null });
            expect(w.sentOf('petCommand')).toEqual([]);
            expect(await bot.petAttack(700, { timeout: 60 })).toMatchObject({ success: false, reason: 'no_response' });
        });

        test('a client refusal comes back as it is', async () => {
            const { w, bot } = petWorld();
            w.handlers.petCommand = () => ({ success: false, message: 'no object 700', reason: 'unknown_object', phase: 'validation' });
            expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'unknown_object', target: { objectId: 700 } });
        });

        test('an enemy player can be the target', async () => {
            const enemy = makePlayerObj({ objectId: 800, name: 'Norseman', realm: 'midgard' });
            const { w, bot } = petWorld({ nearbyPlayers: [enemy] });
            orders(w, (_a, world) => world.message(KILL));
            expect(await bot.petAttack(800)).toMatchObject({ success: true, target: { kind: 'player', objectId: 800 } });
        });
    });

    test('an abort with the order in flight still puts our target back: the client selects it regardless', async () => {
        const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: 200 }) });
        w.handlers.petCommand = (a, world) => {
            if (a.type === 'petCommand') world.player.targetObjectId = a.targetObjectId ?? null;
            throw new Error('cancelled');
        };
        await expect(bot.petAttack(700, { restoreTarget: true })).rejects.toThrow('cancelled');
        expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([200]);
    });

    test('replace with the summon on cooldown keeps the pet: nothing goes out (a Hunter\'s recast is 120 s)', async () => {
        const { w, bot } = petWorld({ skills: skillsWith({ ...simulacrum, cooldownRemaining: 90 }) });
        const r = await bot.summonPet(undefined, { replace: true });
        expect(r).toMatchObject({ success: false, reason: 'cooldown', spell: { name: 'Amber Simulacrum' }, pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
        expect(w.sent).toEqual([]);
    });

    describe('summonPet', () => {
        test('a window pet: the window and its entry, and no select or face', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob()], player: makePlayer({ targetObjectId: 700 }) });
            summons(w, 'Amber Simulacrum', 'amber simulacrum');
            const r = await bot.summonPet('Amber Simulacrum');
            expect(r).toMatchObject({ success: true, completed: true, spell: { name: 'Amber Simulacrum' }, pet: { objectId: PET_ID, name: 'amber simulacrum' }, petState: { objectId: PET_ID, aggression: 'defensive' } });
            expect(r.messages.map(m => m.text)).toContain('You cast a Amber Simulacrum spell!');
            expect(w.sentOf('castSpell')).toHaveLength(1);
            expect(w.sentOf('setTarget')).toEqual([]);
            expect(w.sentOf('faceObject')).toEqual([]);
            expect(w.player.targetObjectId).toBe(700);
        });

        test('with no spell, the best main one; an Animist\'s turret when it has none', async () => {
            const ranks = [spellOf('Amber Simulacrum', 801, 1, 0), spellOf('Sapphire Simulacrum', 803, 12, 2), spellOf('Ruby Simulacrum', 802, 7, 1)];
            const { w, bot } = world({ pet: null, skills: skillsWith(...ranks), nearbyNpcs: [] });
            w.handlers.castSpell = (a, world) => {
                if (a.type !== 'castSpell') return;
                setTimeout(() => {
                    world.message('You cast a Sapphire Simulacrum spell!', { type: 'spell' });
                    world.state.nearbyNpcs = [petNpc()];
                    world.state.pet = petWindow();
                }, 10);
            };
            expect(await bot.summonPet()).toMatchObject({ success: true, spell: { name: 'Sapphire Simulacrum' } });
            expect(w.sentOf('castSpell')[0]).toMatchObject({ spellIndex: 2 });

            const animist = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
            expect(animist.bot.findSummonSpell('main')).toBeNull();
            summons(animist.w, "Grove's Assaillant", "grove's assailant");
            expect(await animist.bot.summonPet()).toMatchObject({ success: true, spell: { name: "Grove's Assaillant" } });

            const fighter = world({ pet: null, nearbyNpcs: [] });
            expect(await fighter.bot.summonPet()).toMatchObject({ success: false, reason: 'spell_not_found', spell: null, pet: null });
            expect(await fighter.bot.summonPet('Amber Simulacrum')).toMatchObject({ success: false, reason: 'spell_not_found' });
            expect(fighter.w.sent).toEqual([]);
        });

        test('findSummonSpell goes by the static type, per kind', () => {
            const { bot } = world({ skills: skillsWith(simulacrum, earth, bomber, charm, turret, minion, onPetSpell) });
            expect(bot.findSummonSpell()?.name).toBe('Amber Simulacrum');
            expect(bot.findSummonSpell('main')?.name).toBe('Amber Simulacrum');
            expect(bot.findSummonSpell('turret')?.name).toBe("Grove's Assaillant");
            expect(bot.findSummonSpell('fnf')?.name).toBe('Call Minor Earth Elemental');
            expect(bot.findSummonSpell('bomber')?.name).toBe('Wisp Heat');
            expect(bot.findSummonSpell('minion')?.name).toBe('Summon Bone Dart');
            expect(bot.findSummonSpell('charm')?.name).toBe('Persuade Will');
            expect(world({ skills: skillsWith(onPetSpell) }).bot.findSummonSpell('main')).toBeNull();
        });

        test('a pet with no window: its target, the line, then the NPC by that name, the new one first', async () => {
            const older = petNpc({ objectId: 610, name: 'earth spirit', x: 560030 });
            const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [older, mob()], player: makePlayer({ targetObjectId: null }) });
            summons(w, earth.name, 'earth spirit', { window: false, id: 611 });
            const r = await bot.summonPet(earth, { target: 'young wolf' });
            expect(r).toMatchObject({ success: true, pet: { objectId: 611, name: 'earth spirit' }, petState: null, target: { objectId: 700 } });
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([700]);
        });

        test('a pet with no window beside a window pet: no pet_exists, no release, and petState stays null', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(earth, minion) });
            summons(w, earth.name, 'earth spirit', { window: false, id: 611 });
            expect(await bot.summonPet(earth, { target: 700, replace: true })).toMatchObject({ success: true, pet: { objectId: 611 }, petState: null });
            expect(w.sentOf('petCommand')).toEqual([]);
            summons(w, minion.name, 'bone dart', { window: false, id: 612 });
            expect(await bot.summonPet(minion)).toMatchObject({ success: true, pet: { objectId: 612 }, petState: null });
        });

        test('the line with the NPC not in view yet still succeeds, with no pet', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message('You cast a Call Minor Earth Elemental spell!', { type: 'spell' });
                    world.message('The earth spirit is now under your control.', { type: 'spell' });
                }, 10);
            };
            expect(await bot.summonPet(earth, { target: 700 })).toMatchObject({ success: true, pet: null, petState: null });
        });

        test('a silent bomber succeeds on the cast, without waiting for a line (BomberSpellHandler.cs:13)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(bomber), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Wisp Heat spell!', { type: 'spell' }), 10); };
            const t0 = Date.now();
            expect(await bot.summonPet(bomber, { target: 700 })).toMatchObject({ success: true, completed: true, pet: null, petState: null });
            expect(Date.now() - t0).toBeLessThan(1000);
        });

        test('pet_exists before casting: nothing is dispatched, and the result names the pet', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum) });
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'pet_exists', spell: { name: 'Amber Simulacrum' }, pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
            expect(w.sent).toEqual([]);
        });

        test('replace releases, waits for the close, then casts', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum) });
            let windowAtCast: PetState | null | undefined;
            orders(w, (_a, world) => {
                setTimeout(() => {
                    world.state.pet = null;
                    world.state.nearbyNpcs = [mob()];
                    world.message('You lose control of the amber simulacrum!');
                    world.message('You release control of your controlled target.');
                }, 50);
            });
            summons(w, simulacrum.name, 'ruby simulacrum', { id: 620 });
            const cast = w.handlers.castSpell!;
            w.handlers.castSpell = (a, world) => { windowAtCast = world.state.pet; return cast(a, world); };
            const r = await bot.summonPet(simulacrum, { replace: true });
            expect(r).toMatchObject({ success: true, pet: { objectId: 620 }, petState: { objectId: 620 } });
            expect(windowAtCast).toBeNull();
            expect(w.sentOf('petCommand').map(a => a.command)).toEqual(['release']);
        });

        test('replace with a close that never comes casts nothing', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum) });
            const released = spyOn(bot, 'releasePet').mockImplementation(async () => ({ success: false, message: 'No answer', reason: 'no_response', command: 'release', pet: petNpc(), petState: petWindow(), messages: [] }));
            expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: false, reason: 'no_response', petState: { objectId: PET_ID } });
            expect(released).toHaveBeenCalledTimes(1);
            expect(w.sentOf('castSpell')).toEqual([]);
        });

        test('"already have" at the begin of the cast is pet_exists, not no_response (SummonNecromancerPet.cs:50-54)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You already have a charmed creature, release it first!', { type: 'resisted' }), 10); };
            const t0 = Date.now();
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'pet_exists', pet: null });
            expect(Date.now() - t0).toBeLessThan(1500); // one more try after a second: with no pet here it may be one just dead
        });

        test('"already have" after the whole cast is pet_exists, not timeout or an interrupt (SummonDruidPet.cs:46)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message('You begin casting a Amber Simulacrum spell!', { type: 'spell' });
                    world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 60 });
                }, 10);
                setTimeout(() => world.message('You already have a charmed creature, release it first!', { type: 'resisted' }), 80);
            };
            const t0 = Date.now();
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'pet_exists', castTimeMs: 60 });
            expect(Date.now() - t0).toBeLessThan(1500);
        });

        test('the other refusals after the whole cast keep their reasons too', async () => {
            const lines: [string, string][] = [
                ["You can't do that here!", 'refused'],
                ['You have to set a ground target for this Spell.', 'no_ground_target'],
                ["You can't summon a turret without a ground target !", 'no_ground_target'],
                ['Your ground target is not in view.', 'refused'],
                ['You have to select a closer ground target.', 'out_of_range'],
                ['You must cast this spell on a creature you are controlling.', 'no_pet'],
            ];
            for (const [line, reason] of lines) {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 30 }), 5);
                    setTimeout(() => world.message(line, { type: 'important' }), 40);
                };
                expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason, message: line });
            }
        });

        test('cast, but no pet: timeout after appearTimeout, with the cast reported', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Amber Simulacrum spell!', { type: 'spell' }), 10); };
            expect(await bot.summonPet(simulacrum, { appearTimeout: 60 })).toMatchObject({ success: false, reason: 'timeout', completed: true, pet: null, petState: null });
        });

        test('groundTarget goes out before the cast', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
            summons(w, turret.name, "grove's assailant");
            expect(await bot.summonPet(turret, { groundTarget: at(560100, 511000) })).toMatchObject({ success: true });
            expect(w.sent.map(a => a.type)).toEqual(['setGroundTarget', 'castSpell']);
            expect(w.sentOf('setGroundTarget')[0]).toMatchObject({ x: 560100, y: 511000, z: 2500 });
            const refused = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
            refused.w.handlers.setGroundTarget = () => ({ success: false, message: 'nope', reason: 'bad_args', phase: 'validation' });
            expect(await refused.bot.summonPet(turret, { groundTarget: at(1, 2) })).toMatchObject({ success: false, reason: 'bad_args' });
            expect(refused.w.sentOf('castSpell')).toEqual([]);
        });

        test('not in game, dead, and a death while waiting', async () => {
            const gone = world({ player: null, pet: null });
            expect(await gone.bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'not_in_game' });
            expect(await gone.bot.charmPet(700)).toMatchObject({ success: false, reason: 'not_in_game' });
            const dead = world({ player: makePlayer({ isDead: true }), pet: null, skills: skillsWith(simulacrum) });
            expect(await dead.bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'dead' });
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.message('You cast a Amber Simulacrum spell!', { type: 'spell' }), 10);
                setTimeout(() => { world.player.isDead = true; world.player.deathCount = 1; }, 300);
            };
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'died' });
        });
    });

    describe('charmPet', () => {
        const serpent = () => mob({ name: 'slough serpent' });

        test('walks up, selects, and observes the window; a mob becomes the pet', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [serpent()] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message('You cast a Persuade Will spell!', { type: 'spell' });
                    world.message('The slough serpent is now under your control.', { type: 'spell' });
                    world.state.nearbyNpcs = [mob({ name: 'slough serpent', realm: 'albion', isPet: true })];
                    world.state.pet = petWindow({ objectId: 700 });
                }, 10);
            };
            const r = await bot.charmPet('slough serpent');
            expect(r).toMatchObject({ success: true, target: { objectId: 700 }, pet: { objectId: 700, isPet: true }, petState: { objectId: 700 } });
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([700]);
        });

        test('a resist is reason resisted, as soon as it arrives', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [serpent()] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message('You cast a Persuade Will spell!', { type: 'spell' });
                    world.message('The slough serpent resists the charm! (12.5%)', { type: 'resisted' });
                }, 10);
            };
            const t0 = Date.now();
            expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'resisted', resisted: true, completed: true, pet: null, petState: null, message: 'The slough serpent resists the charm! (12.5%)' });
            expect(Date.now() - t0).toBeLessThan(1000);
        });

        test('a resist that trails the cast by a while is still a resist', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [serpent()] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.message('You cast a Persuade Will spell!', { type: 'spell' }), 10);
                setTimeout(() => world.message('The slough serpent resists the charm! (12.5%)', { type: 'resisted' }), 400);
            };
            expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'resisted', resisted: true });
        });

        test('out of range after the cast', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [serpent()] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message('You cast a Persuade Will spell!', { type: 'spell' });
                    world.message('Your controlled creature is too far away!', { type: 'resisted' });
                }, 10);
            };
            expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'out_of_range', resisted: false });
        });

        test('the end-of-cast refusals are refused, whatever the mob is called (Spells.txt:78-85)', async () => {
            const lines = [
                "You can't charm that target!",
                'This spell does not charm that type of monster!',
                'The power wraith is too strong for you to charm!',
                'The power wraith is currently being controlled.',
                "The power wraith can't be charmed!",
            ];
            for (const line of lines) {
                const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [mob({ name: 'power wraith' })] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 30 }), 5);
                    setTimeout(() => world.message(line, { type: 'resisted' }), 40);
                };
                expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'refused', message: line });
            }
        });

        test('no charm spell, no mob, and a pet already up', async () => {
            const fighter = world({ pet: null, nearbyNpcs: [serpent()] });
            expect(await fighter.bot.charmPet(700)).toMatchObject({ success: false, reason: 'spell_not_found' });
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [] });
            expect(await bot.charmPet('slough serpent')).toMatchObject({ success: false, reason: 'not_found' });
            expect(w.sentOf('castSpell')).toEqual([]);
            const up = petWorld({ skills: skillsWith(charm) });
            expect(await up.bot.charmPet(700)).toMatchObject({ success: false, reason: 'pet_exists' });
        });
    });

    describe('releasePet', () => {
        test('the close is the evidence, not the line', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message('You lose control of the amber simulacrum!');
                setTimeout(() => { world.state.pet = null; world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'released', at: Date.now() }; }, 40);
            });
            const r = await bot.releasePet();
            expect(r).toMatchObject({ success: true, command: 'release', pet: { objectId: PET_ID }, petState: null });
            expect(w.sentOf('petCommand')[0]).toMatchObject({ command: 'release', targetObjectId: PET_ID });
        });

        test('no close is no_response', async () => {
            const { bot } = petWorld();
            expect(await bot.releasePet({ timeout: 60 })).toMatchObject({ success: false, reason: 'no_response', petState: { objectId: PET_ID } });
        });

        test('a targeted minion would go instead, so it names the window pet (CharacterClassBase.cs:332-339)', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: 610 }), nearbyNpcs: [petNpc(), petNpc({ objectId: 610, name: 'bone dart' })] });
            orders(w, (_a, world) => { world.state.pet = null; });
            expect(await bot.releasePet()).toMatchObject({ success: true });
            expect(w.sentOf('petCommand')[0]).toMatchObject({ command: 'release', targetObjectId: PET_ID });
        });
    });

    describe('a pulsing charm', () => {
        // Minstrel ranks with pulse 1 and frequency 50 in spell.sql; the effect's icon is the spell's.
        const melodies = spellOf('Captivating Melodies', 1151, 1, 0);
        const enchanting = spellOf('Enchanting Melodies', 1152, 10, 1);
        const charmedWindow = (icons: number[] = [1151], objectId = 700) => petWindow({ objectId, icons });
        const charmedMob = () => mob({ name: 'slough serpent', realm: 'albion', isPet: true });

        /**
         * Plays the song: a cast with it running only stops it (CastingComponent.cs:349-366), a cast without it charms the
         * target and starts it, and a release closes the window and leaves it: its next pulse charms the mob again.
         */
        const song = (w: FakeWorld, running = true) => {
            const on = { running, mob: 700 };
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    if (on.running) {
                        on.running = false;
                        world.message('You cancel your effect.', { type: 'spell' });
                        return;
                    }
                    on.running = true;
                    on.mob = world.player.targetObjectId!;
                    world.message('You cast a Captivating Melodies spell!', { type: 'spell' });
                    world.state.pet = charmedWindow([1151], on.mob);
                }, 5);
            };
            orders(w, (a, world) => { if (a.command === 'release') world.state.pet = null; });
            w.onTick = world => { if (on.running && !world.state.pet) world.state.pet = charmedWindow([1151], on.mob); };
            return on;
        };
        const sequence = (w: FakeWorld) => w.sent.filter(a => a.type === 'castSpell' || a.type === 'petCommand').map(a => a.type);

        test('a release stops the song first: alone it would charm the mob again on the next pulse', async () => {
            const { w, bot, sdk } = petWorld({ pet: charmedWindow(), skills: skillsWith(melodies), nearbyNpcs: [charmedMob()] });
            const on = song(w);
            expect(await bot.releasePet()).toMatchObject({ success: true, command: 'release', petState: null });
            expect(sequence(w)).toEqual(['castSpell', 'petCommand']);
            expect(on.running).toBe(false);
            await Bun.sleep(60);
            expect(sdk.getPetState()).toBeNull();
        });

        test('the icon in the window names the rank: casting another would start a new charm, not stop this one', async () => {
            const { w, bot } = petWorld({ pet: charmedWindow([1151]), skills: skillsWith(enchanting, melodies), nearbyNpcs: [charmedMob()] });
            song(w);
            await bot.releasePet();
            expect(w.sentOf('castSpell').map(a => a.spellIndex)).toEqual([melodies.spellIndex]);
        });

        test('with no icon yet the best rank is the one', async () => {
            const { w, bot } = petWorld({ pet: charmedWindow([]), skills: skillsWith(melodies, enchanting), nearbyNpcs: [charmedMob()] });
            song(w);
            await bot.releasePet();
            expect(w.sentOf('castSpell').map(a => a.spellIndex)).toEqual([enchanting.spellIndex]);
        });

        test('when the song can\'t be stopped nothing is released: the mob would be back within a pulse', async () => {
            const { w, bot } = petWorld({ pet: charmedWindow(), skills: skillsWith(melodies), nearbyNpcs: [charmedMob()] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't cast while stunned!", { type: 'resisted' }), 5); };
            expect(await bot.releasePet()).toMatchObject({ success: false, reason: 'crowd_controlled', command: 'release', petState: { objectId: 700 } });
            expect(w.sentOf('petCommand')).toEqual([]);

            w.handlers.castSpell = () => {};
            expect(await bot.releasePet({ timeout: 60 })).toMatchObject({ success: false, reason: 'no_response', petState: { objectId: 700 } });
            expect(w.sentOf('petCommand')).toEqual([]);
        });

        test('a charm that doesn\'t pulse has no song: a release is the order alone', async () => {
            const { w, bot } = petWorld({ pet: charmedWindow([951]), skills: skillsWith(charm), nearbyNpcs: [charmedMob()] });
            orders(w, (_a, world) => { world.state.pet = null; });
            expect(await bot.releasePet()).toMatchObject({ success: true });
            expect(w.sentOf('castSpell')).toEqual([]);
        });

        test('charmPet with replace takes the next mob: the recast no longer cancels instead of charming', async () => {
            const next = mob({ objectId: 701, name: 'river spirit', x: 560100 });
            const { w, bot, sdk } = petWorld({ pet: charmedWindow(), skills: skillsWith(melodies), nearbyNpcs: [charmedMob(), next] });
            song(w);
            const r = await bot.charmPet(701, { replace: true });
            expect(r).toMatchObject({ success: true, target: { objectId: 701 }, petState: { objectId: 701 } });
            expect(sequence(w)).toEqual(['castSpell', 'petCommand', 'castSpell']);
            await Bun.sleep(60);
            expect(sdk.getPetState()?.objectId).toBe(701);
        });

        test('a song still rolling with no window, after a resist: the cast that stops it is followed by the one that charms', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(melodies), nearbyNpcs: [mob({ objectId: 701 })] });
            song(w);
            const r = await bot.charmPet(701);
            expect(r).toMatchObject({ success: true, petState: { objectId: 701 } });
            expect(w.sentOf('castSpell')).toHaveLength(2);
        });

        test('castSpell says it at once when a cast only stopped the running pulse', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(melodies), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You stop playing your song.', { type: 'spell' }), 5); };
            const t0 = Date.now();
            expect(await bot.castSpell(melodies, 700)).toMatchObject({ success: false, reason: 'pulse_cancelled' });
            expect(Date.now() - t0).toBeLessThan(1000);
        });
    });

    describe('a servant spell', () => {
        // spell.sql: PetSpell rows. Owner instant, the servant casts 3 s; and the owner casts 3 s, the servant is instant.
        const glimpse = spellOf('Glimpse of Fate', 9001);
        const strength = spellOf('Strength of the Dead', 9421);

        test('instant for us: the servant taking it on is the success, there is no "You cast" (PetSpellHandler.cs:41-70)', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(glimpse) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The zombie servant begins casting a Glimpse of Fate spell!', { type: 'spell' }), 10); };
            const t0 = Date.now();
            const r = await bot.castSpell(glimpse, 700);
            expect(r).toMatchObject({ success: true, completed: true, target: { objectId: 700 } });
            expect(Date.now() - t0).toBeLessThan(1500);
            expect(w.sentOf('castSpell')).toHaveLength(1);
        });

        test('cast time for us, on the pet: it ends in the servant\'s line, not in a timeout', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(strength) });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message('You begin casting a Strength of the Dead spell!', { type: 'spell' });
                    world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 50 });
                }, 5);
                setTimeout(() => world.message('The zombie servant cast a Strength of the Dead spell!', { type: 'spell' }), 60);
            };
            expect(await bot.castSpell(strength)).toMatchObject({ success: true, completed: true, castTimeMs: 50, target: { objectId: PET_ID } });
        });

        test('a busy servant queues it: the server took it (AI.txt:4)', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(glimpse) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The zombie servant will begin casting this spell after its current action is finished.', { type: 'spell' }), 10); };
            expect(await bot.castSpell(glimpse, 700)).toMatchObject({ success: true });
        });

        test('the pet\'s animation is evidence too, when no line comes', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(glimpse) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: PET_ID, targetObjectId: null, castTimeMs: 3000 }), 10); };
            expect(await bot.castSpell(glimpse, 700)).toMatchObject({ success: true });
        });
    });

    describe('lines relayed from a pet during our cast', () => {
        const gust = spellOf('Confusing Gust', 462);
        const heal = spellOf('Minor Rejuvenation', 1301);
        /** Our cast has begun, and is about to end when the lines arrive: past landsAt, so they count as landing. */
        const castThen = (w: FakeWorld, spell: string, lines: string[]) => {
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 30 });
                    world.message(`You cast a ${spell} spell!`, { type: 'spell' });
                    for (const text of lines) world.message(text, { type: 'resisted' });
                }, 10);
            };
        };

        test('a resist by our pet, by the pet\'s target or by us is not our cast resisted', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            castThen(w, gust.name, ['Your amber simulacrum resists the effect!', 'The goblin resists the effect! (12.0%)', 'You resist the effect!']);
            const r = await bot.castSpell(gust, 700);
            expect(r).toMatchObject({ success: true, resisted: false });
            expect(r.message).not.toContain('resisted');
        });

        test('our target\'s resist still is one', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            /** With the 0x1B the server sends with it (SendSpellResistAnimation, SpellHandler.cs:2365-2368). */
            const resists = (line: string) => {
                castThen(w, gust.name, [line]);
                const cast = w.handlers.castSpell!;
                w.handlers.castSpell = (a, world) => {
                    setTimeout(() => world.combat({ kind: 'spellEffect', attackerObjectId: world.player.objectId, targetObjectId: 700, effectId: 1 }), 10);
                    return cast(a, world);
                };
            };
            resists('The young wolf resists the effect! (12.0%)');
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, resisted: true });
        });

        test('"Your target is enraged and resists the spell!" is no resist: a mezz can\'t take an NPC under 75 %, whatever the roll (CCSpellHandler.cs:174-178)', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            castThen(w, gust.name, ['Your target is enraged and resists the spell!']);
            const r = await bot.castSpell(gust, 700);
            expect(r).toMatchObject({ success: true, completed: true, resisted: false, effectImmune: true, damage: 0 });
            expect(r.message).toContain('(target enraged)');
            // By itself it ends the cast as the immune line does: nothing else comes.
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 50 }), 10);
                setTimeout(() => world.message('Your target is enraged and resists the spell!', { type: 'resisted' }), 70);
            };
            const started = Date.now();
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, completed: true, effectImmune: true });
            expect(Date.now() - started).toBeLessThan(1500);
        });

        test('an enemy player\'s resist names the player, whom we only know by race: our 0x1B beside it says it is ours (SpellHandler.cs:2390, NormalServerRules.cs:292-297)', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust), nearbyPlayers: [makePlayerObj({ objectId: 410, name: 'Saracen', realm: 'midgard', x: 560300, y: 511000 })] });
            const LINE = 'Morgana resists the effect! (12.0%)';
            castThen(w, gust.name, [LINE]);
            const cast = w.handlers.castSpell!;
            w.handlers.castSpell = (a, world) => {
                setTimeout(() => world.combat({ kind: 'spellEffect', attackerObjectId: world.player.objectId, targetObjectId: 410, effectId: 1 }), 10);
                return cast(a, world);
            };
            const r = await bot.castSpell(gust, 410);
            expect(r).toMatchObject({ success: true, resisted: true });
            expect(r.message).toContain('resisted');

            // Lines that name nobody else are still nobody's resist of ours.
            castThen(w, gust.name, ['Your amber simulacrum resists the effect!', 'You resist the effect!']);
            const notOurs = w.handlers.castSpell!;
            w.handlers.castSpell = (a, world) => {
                setTimeout(() => world.combat({ kind: 'spellEffect', attackerObjectId: world.player.objectId, targetObjectId: 410, effectId: 1 }), 10);
                return notOurs(a, world);
            };
            expect(await bot.castSpell(gust, 410)).toMatchObject({ success: true, resisted: false });

            // And with no 0x1B of ours at them the line isn't our cast's: a pet's spell gets the same one.
            castThen(w, gust.name, [LINE]);
            expect(await bot.castSpell(gust, 410)).toMatchObject({ success: true, resisted: false });
        });

        test('a pet that lost its target does not end the cast we run on ourselves or on a mob still there', async () => {
            const plays = (w: FakeWorld, spell: string) => {
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => {
                        world.message(`You begin casting a ${spell} spell!`, { type: 'spell' });
                        world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 120 });
                    }, 5);
                    setTimeout(() => world.message('You must select a target for this spell!', { type: 'resisted' }), 40);
                    setTimeout(() => world.message(`You cast a ${spell} spell!`, { type: 'spell' }), 120);
                };
            };
            const self = petWorld({ skills: skillsWith(heal) });
            plays(self.w, heal.name);
            expect(await self.bot.castSpell(heal)).toMatchObject({ success: true, completed: true, castTimeMs: 120 });
            expect(self.w.sentOf('castSpell')).toHaveLength(1);

            const onMob = petWorld({ skills: skillsWith(gust) });
            plays(onMob.w, gust.name);
            expect(await onMob.bot.castSpell(gust, 700)).toMatchObject({ success: true, completed: true });
            expect(onMob.w.sentOf('castSpell')).toHaveLength(1);
        });

        test('with our own target gone the line is ours, and with no completion at all it was ours too', async () => {
            const gone = petWorld({ skills: skillsWith(gust) });
            gone.w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 1000 }), 5);
                setTimeout(() => { world.removeNpc(700); world.message('You must select a target for this spell!', { type: 'resisted' }); }, 40);
            };
            const r = await gone.bot.castSpell(gust, 700);
            expect(r).toMatchObject({ success: false, reason: 'no_target', castTimeMs: 1000 });
            expect(r.message).toEndWith(' (target gone, not retried)');

            const silent = petWorld({ skills: skillsWith(gust) });
            silent.w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 30 }), 5);
                setTimeout(() => world.message('You must select a target for this spell!', { type: 'resisted' }), 20);
            };
            expect(await silent.bot.castSpell(gust, 700, { timeout: 60 })).toMatchObject({ success: false, reason: 'no_target' });
        });

        test('a pet spell\'s crit does not add to our damage: it follows the pet\'s hit, ours follows ours', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            castThen(w, gust.name, [
                'Your ruby simulacrum hits the goblin for 40 damage!',
                'You critically hit for an additional 9 damage! (10%)',
                'You hit the young wolf for 50 damage!',
                'You critically hit for an additional 7 damage! (10%)',
            ]);
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, damage: 57 });
        });
    });

    describe('petKill', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        /** The server: answers each attack order, and the pet fights what it was last ordered onto. */
        const fights = (w: FakeWorld, opts: { dmg?: number; xp?: number } = {}) => {
            let on: number | null = null;
            orders(w, (a, world) => {
                if (a.command !== 'attack') return;
                world.message(KILL);
                on = a.targetObjectId ?? null;
            });
            w.onTick = world => {
                const pet = world.state.pet;
                if (!pet || on === null) return;
                const npc = world.npc(on);
                if (!npc) return;
                npc.healthPercent = Math.max(0, npc.healthPercent - (opts.dmg ?? 25));
                npc.targetObjectId = pet.objectId;
                world.state.pet = { ...pet, targetObjectId: on };
                world.combat({ kind: 'melee', attackerObjectId: pet.objectId, targetObjectId: on, result: 'hit', targetHealthPercent: npc.healthPercent });
                if (npc.healthPercent === 0) {
                    const id = on;
                    on = null;
                    world.removeNpc(id);
                    world.state.pet = { ...pet, targetObjectId: null };
                    world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: id, targetHealthPercent: 0 });
                    setTimeout(() => {
                        world.message(`You get ${opts.xp ?? 17} experience points.`, { type: 'important' });
                        world.player.experience += opts.xp ?? 17;
                        world.player.money = { ...world.player.money, copper: world.player.money.copper + 3, totalCopper: world.player.money.totalCopper + 3 };
                    }, 20);
                }
            };
        };

        test('orders the pet and waits for the death; we neither walk nor swing; XP and money by delta', async () => {
            const { w, bot } = petWorld();
            fights(w);
            const r = await bot.petKill('young wolf');
            expect(r).toMatchObject({ success: true, killed: true, npc: { objectId: 700 }, xpGained: 17, moneyGained: 3, stylesUsed: 0 });
            expect(w.sentOf('petCommand').map(a => [a.command, a.targetObjectId])).toEqual([['attack', 700]]);
            expect(w.sentOf('moveTo')).toEqual([]);
            expect(w.sentOf('attack')).toEqual([]);
        });

        test('pet_died when it goes, with the cause in the message', async () => {
            const { w, bot } = petWorld();
            fights(w, { dmg: 0 });
            setTimeout(() => {
                w.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'died', at: Date.now() };
                w.state.pet = null;
            }, 60);
            const r = await bot.petKill(700);
            expect(r).toMatchObject({ success: false, reason: 'pet_died', killed: false, npc: { objectId: 700 } });
            expect(r.message).toContain('(died)');
        });

        test('another pet in the window means ours is gone', async () => {
            const { w, bot } = petWorld();
            fights(w, { dmg: 0 });
            setTimeout(() => { w.state.pet = petWindow({ objectId: 601 }); }, 60);
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'pet_died' });
        });

        test('died when we do, though the pet goes with us', async () => {
            const { w, bot } = petWorld();
            fights(w, { dmg: 0 });
            setTimeout(() => {
                w.player.isDead = true;
                w.player.deathCount = 1;
                w.state.pet = null;
                w.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'owner_died', at: Date.now() };
            }, 60);
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'died' });
        });

        test('a kill in the same snapshot as the pet\'s loss still counts', async () => {
            const { w, bot } = petWorld();
            fights(w, { dmg: 0 });
            setTimeout(() => {
                dies(w, 700);
                w.state.pet = null;
            }, 60);
            expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
        });

        test('a timeout gives up; the order was given once while the pet is at it', async () => {
            const { w, bot } = petWorld();
            fights(w, { dmg: 0 });
            const r = await bot.petKill(700, { timeout: 200 });
            expect(r).toMatchObject({ success: false, reason: 'timeout', killed: false });
            expect(w.sentOf('petCommand')).toHaveLength(1);
        });

        test('orders again when the pet has lost it (its order dropped), and not before', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => world.message(KILL));
            // Only the clock decides, so it is moved on instead of waited out.
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            try {
                const killing = bot.petKill(700, { timeout: 2000 });
                await Bun.sleep(60);
                expect(w.sentOf('petCommand')).toHaveLength(1);
                skew += 6000;
                await Bun.sleep(60);
                expect(w.sentOf('petCommand')).toHaveLength(2);
                await Bun.sleep(60);
                expect(w.sentOf('petCommand')).toHaveLength(2);
                dies(w, 700);
                expect(await killing).toMatchObject({ success: true, killed: true });
            } finally {
                clock.mockRestore();
            }
        });

        test('seeing the pet at it holds the next order back: the model\'s target, which holds between casts', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc({ speed: 191 }), mob()] }); // on its way: this is about orders, not about standing idle
            orders(w, (_a, world) => world.message(KILL));
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            try {
                const killing = bot.petKill(700, { timeout: 2000 });
                await Bun.sleep(60);
                skew += 4000;
                // The model sets it from the answer line, a swing, a 0x1B at an enemy, and a 0xA1 that names it.
                w.state.pet = petWindow({ targetObjectId: 700 });
                await Bun.sleep(40);
                skew += 4000;
                await Bun.sleep(40);
                skew += 4000;
                await Bun.sleep(40);
                expect(w.sentOf('petCommand')).toHaveLength(1);
                dies(w, 700);
                await killing;
            } finally {
                clock.mockRestore();
            }
        });

        test('a later order that fails for a moment leaves the fight standing; immune and not_attackable end it', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc({ speed: 191 }), mob()] }); // on its way: this is about orders, not about standing idle
            let answer = KILL;
            orders(w, (_a, world) => world.message(answer));
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            try {
                const killing = bot.petKill(700, { timeout: 2000, approach: false });
                await Bun.sleep(40);
                answer = 'Your target is too far away to attack with your pet!';
                skew += 6000;
                await Bun.sleep(40);
                answer = 'Norseman is temporarily immune to PvP attacks!';
                skew += 6000;
                expect(await killing).toMatchObject({ success: false, reason: 'immune', retryAfterMs: PVP_IMMUNE_RETRY_MS });
                expect(w.sentOf('petCommand').length).toBe(3);
            } finally {
                clock.mockRestore();
            }
        });

        test('the first order\'s refusal ends it at once', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => world.message('Your target is too far away to attack with your pet!'));
            expect(await bot.petKill(700, { approach: false })).toMatchObject({ success: false, reason: 'out_of_range', killed: false });
            orders(w, (_a, world) => world.message("You can't attack a member of your realm!"));
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'not_attackable' });
            orders(w);
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'no_response' });
        }, 8000);

        describe('a first order refused at the edge (IsWithinRadius 2000, GamePlayer.cs:12185): our reading lags a mob on the move', () => {
            const TOO_FAR = 'Your target is too far away to attack with your pet!';
            const edge = 560000 + 1990;
            const tooFar = (w: FakeWorld) => orders(w, (a, world) => { if (a.command === 'attack') world.message(TOO_FAR); });

            test('we walk to the order\'s stop and order once more, never into melee', async () => {
                const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: edge })] });
                let distanceAtSecond = 0;
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    if (++attacks === 1) return world.message(TOO_FAR);
                    distanceAtSecond = edge - world.player.x;
                    world.message(KILL);
                    setTimeout(() => dies(world, 700), 20);
                });
                const r = await bot.petKill(700);
                expect(r).toMatchObject({ success: true, killed: true });
                expect(attacks).toBe(2);
                expect(distanceAtSecond).toBeGreaterThanOrEqual(1400);
                expect(distanceAtSecond).toBeLessThanOrEqual(1600);
                expect(w.sentOf('attack')).toEqual([]);
            });

            test('the walk goes by where the mob is by then', async () => {
                const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: edge })] });
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    if (++attacks === 1) {
                        world.npc(700)!.x = edge + 300;
                        return world.message(TOO_FAR);
                    }
                    world.message(KILL);
                    setTimeout(() => dies(world, 700), 20);
                });
                expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
                expect(edge + 300 - w.player.x).toBeLessThanOrEqual(1600);
            });

            test('refused again: out_of_range, with no third order', async () => {
                const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: edge })] });
                tooFar(w);
                expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'out_of_range', killed: false });
                expect(w.sentOf('petCommand')).toHaveLength(2);
                expect(w.sentOf('moveTo').length).toBeGreaterThanOrEqual(1);
            });

            test('no way there: with the reading in range the order goes once more; a walk that ends otherwise ends it', async () => {
                const stuck = petWorld({ nearbyNpcs: [petNpc(), mob({ x: edge })] });
                tooFar(stuck.w);
                spyOn(stuck.bot, 'walkTo').mockResolvedValue({ success: false, message: 'Stuck', reason: 'stuck' } as never);
                expect(await stuck.bot.petKill(700)).toMatchObject({ success: false, reason: 'out_of_range' });
                expect(stuck.w.sentOf('petCommand')).toHaveLength(2);

                const other = petWorld({ nearbyNpcs: [petNpc(), mob({ x: edge })] });
                tooFar(other.w);
                spyOn(other.bot, 'walkTo').mockResolvedValue({ success: false, message: 'Refused the walk', reason: 'wrong_region' } as never);
                expect(await other.bot.petKill(700)).toMatchObject({ success: false, reason: 'wrong_region', message: 'Refused the walk' });
                expect(other.w.sentOf('petCommand')).toHaveLength(1);
            });

            test('with approach off, and for a later order, no walk', async () => {
                const off = petWorld({ nearbyNpcs: [petNpc(), mob({ x: edge })] });
                tooFar(off.w);
                expect(await off.bot.petKill(700, { approach: false })).toMatchObject({ success: false, reason: 'out_of_range' });
                expect(off.w.sentOf('moveTo')).toEqual([]);
                expect(off.w.sentOf('petCommand')).toHaveLength(1);

                const later = petWorld({ nearbyNpcs: [petNpc({ speed: 191 }), mob({ x: edge })] });
                let answer = KILL;
                orders(later.w, (a, world) => { if (a.command === 'attack') world.message(answer); });
                const realNow = Date.now.bind(Date);
                let skew = 0;
                const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
                try {
                    const killing = later.bot.petKill(700, { timeout: 60_000 });
                    await Bun.sleep(40);
                    answer = TOO_FAR;
                    skew += 6000;
                    await Bun.sleep(40);
                    expect(later.w.sentOf('petCommand')).toHaveLength(2);
                    expect(later.w.sentOf('moveTo')).toEqual([]);
                    dies(later.w, 700);
                    expect(await killing).toMatchObject({ success: true, killed: true });
                } finally {
                    clock.mockRestore();
                }
            });
        });

        test('beyond an order\'s range we walk into it, never into melee', async () => {
            const far = 560000 + 3000;
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: far })] });
            fights(w);
            const r = await bot.petKill(700);
            expect(r).toMatchObject({ success: true, killed: true });
            expect(w.sentOf('moveTo').length).toBeGreaterThanOrEqual(1);
            expect(far - w.player.x).toBeGreaterThanOrEqual(1400);
            expect(far - w.player.x).toBeLessThanOrEqual(1600);
            expect(w.sentOf('attack')).toEqual([]);
        });

        test('a target that left view alive, one gone at low health, and bad targets', async () => {
            const { w, bot } = petWorld();
            fights(w, { dmg: 0 });
            setTimeout(() => w.removeNpc(700), 60);
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'target_lost' });

            const low = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 15 })] });
            fights(low.w, { dmg: 0 });
            setTimeout(() => { low.w.removeNpc(700); low.w.message('You get 1 experience points.', { type: 'important' }); }, 60);
            expect(await low.bot.petKill(700)).toMatchObject({ success: true, killed: true });

            const bad = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 0 })] });
            bad.w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
            bad.w.publish();
            expect(await bad.bot.petKill(700)).toMatchObject({ success: false, reason: 'already_dead' });
            expect(await bad.bot.petKill('nothing')).toMatchObject({ success: false, reason: 'not_found', npc: null });
            expect(bad.w.sentOf('petCommand')).toEqual([]);
        });

        test('an enemy player: its death by event, and npc stays null', async () => {
            const enemy = makePlayerObj({ objectId: 800, name: 'Norseman', realm: 'midgard', x: 560300 });
            const { w, bot } = petWorld({ nearbyPlayers: [enemy] });
            orders(w, (_a, world) => world.message(KILL));
            setTimeout(() => {
                w.state.nearbyPlayers = [{ ...w.state.nearbyPlayers[0]!, isDead: true, healthPercent: 0 }];
                w.combat({ kind: 'death', attackerObjectId: PET_ID, targetObjectId: 800 });
            }, 60);
            expect(await bot.petKill(800)).toMatchObject({ success: true, killed: true, npc: null });
        });

        test('an abort still throws, and stops a walk', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 570000 })] });
            w.stepSize = 1;
            const controller = new AbortController();
            setTimeout(() => controller.abort(new Error('cancelled')), 60);
            await expect(executionContext.run({ signal: controller.signal }, () => bot.petKill(700))).rejects.toThrow('cancelled');
            expect(w.state.movement.moving).toBeFalse();
        });
    });

    describe('killNpc with a pet', () => {
        const near = () => [petNpc(), mob({ x: 560050 })];

        test('orders a pet that isn\'t passive once, and fights on as ever', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: near() });
            fightSim(w, { dmg: 50 });
            const r = await bot.killNpc(700);
            expect(r).toMatchObject({ success: true, killed: true });
            expect(w.sentOf('petCommand').map(a => [a.command, a.targetObjectId])).toEqual([['attack', 700]]);
            expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
        });

        test('leaves a passive pet alone: an order would lift it to Defensive (ControlledMobBrain.cs:213-214)', async () => {
            const { w, bot } = petWorld({ pet: petWindow({ aggression: 'passive' }), nearbyNpcs: near() });
            fightSim(w, { dmg: 50 });
            expect(await bot.killNpc(700)).toMatchObject({ success: true });
            expect(w.sentOf('petCommand')).toEqual([]);
        });

        test('usePet false, and no pet at all', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: near() });
            fightSim(w, { dmg: 50 });
            expect(await bot.killNpc(700, { usePet: false })).toMatchObject({ success: true });
            expect(w.sentOf('petCommand')).toEqual([]);
            const alone = world({ pet: null, nearbyNpcs: [mob({ x: 560050 })] });
            fightSim(alone.w, { dmg: 50 });
            expect(await alone.bot.killNpc(700)).toMatchObject({ success: true });
            expect(alone.w.sentOf('petCommand')).toEqual([]);
        });

        test('waits until the mob is within an order\'s range', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 560000 + 2400 })] });
            w.stepSize = 100;
            fightSim(w, { dmg: 50 });
            let distanceAtOrder = 0;
            orders(w);
            const order = w.handlers.petCommand!;
            w.handlers.petCommand = (a, world) => { distanceAtOrder = world.npc(700)!.x - world.player.x; return order(a, world); };
            expect(await bot.killNpc(700)).toMatchObject({ success: true });
            expect(w.sentOf('petCommand')).toHaveLength(1);
            expect(distanceAtOrder).toBeLessThanOrEqual(2000);
            expect(distanceAtOrder).toBeGreaterThan(1000);
        });

        test('a pet already on the mob gets no order: a repeat only earns a line', async () => {
            const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: near() });
            fightSim(w, { dmg: 50 });
            expect(await bot.killNpc(700)).toMatchObject({ success: true, killed: true });
            expect(w.sentOf('petCommand')).toEqual([]);
            expect(w.sentOf('attack').map(a => a.on)).toContain(true);
        });

        test('one on the mob from the start that drops it stays as it is, and one that goes for another is ordered back', async () => {
            const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc(), mob({ x: 560050, level: 50 }), mob({ objectId: 701, x: 560400 })] });
            const killing = bot.killNpc(700, { timeout: 500, force: true });
            await Bun.sleep(60);
            w.state.pet = petWindow();
            await Bun.sleep(60);
            expect(w.sentOf('petCommand')).toEqual([]);
            w.state.pet = petWindow({ targetObjectId: 701 });
            await Bun.sleep(60);
            expect(w.sentOf('petCommand').map(a => [a.command, a.targetObjectId])).toEqual([['attack', 700]]);
            await killing;
        });

        test('orders again if the pet ends up on another mob, and a new pet', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 560050, level: 50 }), mob({ objectId: 701, x: 560400 })] });
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            try {
                const killing = bot.killNpc(700, { timeout: 2000, force: true });
                await Bun.sleep(60);
                expect(w.sentOf('petCommand')).toHaveLength(1);
                w.state.pet = petWindow({ targetObjectId: 700 });
                await Bun.sleep(30);
                skew += 6000;
                await Bun.sleep(30);
                expect(w.sentOf('petCommand')).toHaveLength(1);
                w.state.pet = petWindow({ targetObjectId: 701 });
                await Bun.sleep(30);
                expect(w.sentOf('petCommand')).toHaveLength(2);
                skew += 6000;
                w.state.pet = petWindow({ objectId: 601 });
                await Bun.sleep(30);
                expect(w.sentOf('petCommand')).toHaveLength(3);
                dies(w, 700);
                await killing;
            } finally {
                clock.mockRestore();
            }
        });

        test('the too-far-with-your-pet line stops no melee (GameLiving.txt:36)', async () => {
            const { w, bot } = world({ pet: petWindow(), nearbyNpcs: [petNpc(), mob({ x: 560050 })] });
            orders(w, (_a, world) => world.message('Your target is too far away to attack with your pet!'));
            fightSim(w, { dmg: 25 });
            expect(await bot.killNpc(700)).toMatchObject({ success: true, killed: true });
        });

        test('attack is not refused by it either', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: near() });
            w.handlers.attack = (a, world) => {
                if (a.type !== 'attack') return;
                world.message('Your target is too far away to attack with your pet!');
                setTimeout(() => { world.player.attacking = a.on; }, 40);
            };
            expect(await bot.attack(700)).toMatchObject({ success: true });
        });
    });

    describe('castSpell on a pet', () => {
        const enemyFar = () => mob({ x: 561900 });

        test('a Pet spell with no target lands on the pet: no walk to the enemy, no select, no face', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(onPetSpell), nearbyNpcs: [petNpc(), enemyFar()], player: makePlayer({ targetObjectId: 700 }) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Reflect Attack spell!', { type: 'spell' }), 10); };
            const r = await bot.castSpell(onPetSpell);
            expect(r).toMatchObject({ success: true, target: { objectId: PET_ID } });
            expect(r.message).toContain('amber simulacrum');
            expect(w.sentOf('moveTo')).toEqual([]);
            expect(w.sentOf('setTarget')).toEqual([]);
            expect(w.sentOf('faceObject')).toEqual([]);
            expect(w.player.targetObjectId).toBe(700);
        });

        test('with the pet out of view it still goes: the window stands, and the server judges the range', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(onPetSpell), nearbyNpcs: [enemyFar()], player: makePlayer({ targetObjectId: 700 }) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Reflect Attack spell!', { type: 'spell' }), 10); };
            expect(await bot.castSpell(onPetSpell)).toMatchObject({ success: true, target: null });
            expect(w.sentOf('moveTo')).toEqual([]);
        });

        test('no_pet without one, nothing dispatched', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(onPetSpell), nearbyNpcs: [enemyFar()], player: makePlayer({ targetObjectId: 700 }) });
            expect(await bot.castSpell(onPetSpell)).toMatchObject({ success: false, reason: 'no_pet', spell: { name: 'Reflect Attack' } });
            expect(w.sent).toEqual([]);
        });

        test('with no window, a targeted pet of our realm goes on to the server: it may be our turret or minion (SpellHandler.cs:463-473)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(onPetSpell), nearbyNpcs: [petNpc({ objectId: 610, name: 'spore spewer' })], player: makePlayer({ targetObjectId: 610 }) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must cast this spell on a creature you are controlling.', { type: 'system' }), 10); };
            expect(await bot.castSpell(onPetSpell)).toMatchObject({ success: false, reason: 'no_pet' });
            expect(w.sentOf('castSpell')).toHaveLength(1);
        });

        test('with a target given it goes the usual way', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(onPetSpell), nearbyNpcs: [petNpc({ objectId: 610, name: 'bone dart' }), petNpc()] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You cast a Reflect Attack spell!', { type: 'spell' }), 10); };
            expect(await bot.castSpell(onPetSpell, 610)).toMatchObject({ success: true, target: { objectId: 610 } });
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([610]);
            expect(w.sentOf('faceObject').map(a => a.objectId)).toEqual([610]);
        });

        test('"You must have a pet summoned" is no_pet', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must have a pet summoned to cast this spell!', { type: 'resisted' }), 10); };
            expect(await bot.castSpell(simulacrum)).toMatchObject({ success: false, reason: 'no_pet' });
        });
    });

    describe('finding and resolving', () => {
        describe('a hurt ex-pet is ours for 10 s after the loss: only we can have hurt it', () => {
            const hurt = (o: Partial<NearbyNpc> = {}) => mob({ objectId: PET_ID, name: 'spirit hound', healthPercent: 74, ...o });
            const lost = (ago: number, o: Partial<NonNullable<BotWorldState['lastPetLoss']>> = {}) => ({ objectId: PET_ID, name: 'spirit hound', cause: 'released' as const, at: Date.now() - ago, ...o });

            test('found just after the loss, unlike someone else\'s hurt mob', () => {
                const { bot } = world({ pet: null, nearbyNpcs: [hurt(), mob({ objectId: 705, name: 'hurt by someone', healthPercent: 50 })], lastPetLoss: lost(2000) });
                expect(bot.findKillableNpcs().map(n => n.objectId)).toEqual([PET_ID]);
            });

            test('with a target of its own, on someone else, too', () => {
                const { bot } = world({ pet: null, nearbyNpcs: [hurt({ targetObjectId: 999 })], lastPetLoss: lost(2000) });
                expect(bot.findKillableNpcs().map(n => n.objectId)).toEqual([PET_ID]);
            });

            test('not past the 10 s', () => {
                const { bot } = world({ pet: null, nearbyNpcs: [hurt()], lastPetLoss: lost(10_500) });
                expect(bot.findKillableNpcs()).toEqual([]);
            });

            test('not when its id has gone to something else: the server hands them out again (Region.cs:955)', () => {
                const { bot } = world({ pet: null, nearbyNpcs: [hurt({ name: 'other mob' })], lastPetLoss: lost(2000) });
                expect(bot.findKillableNpcs()).toEqual([]);
            });
        });

        test('findKillableNpcs keeps the pet\'s mobs and still drops someone else\'s', () => {
            const { w, bot } = petWorld({
                pet: petWindow({ targetObjectId: 702 }),
                nearbyNpcs: [
                    petNpc(),
                    mob({ objectId: 701, name: 'on the pet', targetObjectId: PET_ID, healthPercent: 80 }),
                    mob({ objectId: 702, name: 'the pet aims at it', healthPercent: 60, targetObjectId: 999 }),
                    mob({ objectId: 703, name: 'last hit by the pet', healthPercent: 40, targetObjectId: null }),
                    mob({ objectId: 704, name: 'free', x: 560600 }),
                    mob({ objectId: 705, name: 'hurt by someone', healthPercent: 50 }),
                    mob({ objectId: 706, name: 'on someone', targetObjectId: 999 }),
                ],
            });
            w.combat({ kind: 'melee', attackerObjectId: PET_ID, targetObjectId: 703, result: 'hit', targetHealthPercent: 40 });
            // Its heal on us or itself says nothing of what it last hit.
            w.combat({ kind: 'spellEffect', attackerObjectId: PET_ID, targetObjectId: w.player.objectId, effectId: 1 });
            w.combat({ kind: 'spellEffect', attackerObjectId: PET_ID, targetObjectId: PET_ID, effectId: 1 });
            w.publish();
            expect(bot.findKillableNpcs().map(n => n.objectId).sort()).toEqual([701, 702, 703, 704]);
            expect(bot.findKillableNpcs({ includeEngaged: true }).map(n => n.objectId).sort()).toEqual([701, 702, 703, 704, 705, 706]);
        });

        test('findKillableNpcs treats a summon\'s mob as ours: on it, named by it, last swung or cast at by it; with no window too', () => {
            const { w, bot } = world({
                pet: null,
                summons: [SPIRIT_ID, 611],
                nearbyObjects: [],
                nearbyNpcs: [
                    spirit(),
                    spirit({ objectId: 611, name: 'bone dart', targetObjectId: 702 }),
                    mob({ objectId: 701, name: 'on it', targetObjectId: SPIRIT_ID, healthPercent: 80 }),
                    mob({ objectId: 702, name: 'named by it', healthPercent: 60, targetObjectId: 999 }),
                    mob({ objectId: 703, name: 'last hit by it', healthPercent: 40, targetObjectId: null }),
                    mob({ objectId: 704, name: 'free', x: 560600 }),
                    mob({ objectId: 705, name: 'hurt by someone', healthPercent: 50 }),
                    mob({ objectId: 706, name: 'on someone', targetObjectId: 999 }),
                ],
            });
            w.combat({ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 703, effectId: 1 });
            // A heal on us or on another pet of ours says nothing of what it last cast at.
            w.combat({ kind: 'spellEffect', attackerObjectId: 611, targetObjectId: w.player.objectId, effectId: 1 });
            w.combat({ kind: 'spellEffect', attackerObjectId: 611, targetObjectId: SPIRIT_ID, effectId: 1 });
            w.publish();
            expect(bot.findKillableNpcs().map(n => n.objectId).sort()).toEqual([701, 702, 703, 704]);
        });

        test('a summon\'s last swing says nothing of a mob that took a dead one\'s id, or after a long while', () => {
            const died = world({ pet: null, summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob({ healthPercent: 60, targetObjectId: 999 })] });
            died.w.combat({ kind: 'melee', attackerObjectId: SPIRIT_ID, targetObjectId: 700, result: 'hit', targetHealthPercent: 10 });
            died.w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
            died.w.publish();
            expect(died.bot.findKillableNpcs()).toEqual([]);

            const old = world({ pet: null, summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob({ healthPercent: 60, targetObjectId: 999 })] });
            old.w.state.combatEvents.push({ id: 98, kind: 'melee', attackerObjectId: SPIRIT_ID, targetObjectId: 700, result: 'hit', receivedAt: old.w.state.timestamp - 11_000 });
            old.w.publish();
            expect(old.bot.findKillableNpcs()).toEqual([]);
        });

        test('a bow draw of an older client (a melee event with no target) doesn\'t hide the pet\'s last real target', () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 60 })] });
            w.combat({ kind: 'melee', attackerObjectId: PET_ID, targetObjectId: 700, result: 'hit', targetHealthPercent: 60 });
            w.combat({ kind: 'melee', attackerObjectId: PET_ID, targetObjectId: null, result: 'miss', targetHealthPercent: 0 });
            w.publish();
            expect(bot.findKillableNpcs().map(n => n.objectId)).toEqual([700]);
        });

        test('petFoe: the window pet\'s target, else a mob on it or a summon, else a summon\'s aim; only an enemy, alive and in view', () => {
            const foeOf = (o: Partial<BotWorldState>, events: Partial<Parameters<FakeWorld['combat']>[0]>[] = []) => {
                const { w, sdk } = world({ pet: null, nearbyObjects: [], nearbyPlayers: [], ...o });
                for (const e of events) w.combat(e as Parameters<FakeWorld['combat']>[0]);
                w.publish();
                return new ActionHelpers(sdk).petFoe()?.objectId ?? null;
            };
            const npcs = [petNpc(), spirit(), mob()];
            expect(foeOf({ nearbyNpcs: npcs })).toBeNull();
            // The window pet: its hold in the model says it, and stands until an order clears it: its own last swing doesn't count here.
            expect(foeOf({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: npcs })).toBe(700);
            expect(foeOf({ pet: petWindow(), nearbyNpcs: npcs }, [{ kind: 'melee', attackerObjectId: PET_ID, targetObjectId: 700, result: 'hit' }])).toBeNull();
            expect(foeOf({ pet: petWindow({ targetObjectId: 999 }), nearbyNpcs: [petNpc(), mob({ targetObjectId: PET_ID })] })).toBe(700);
            // A summon: a mob on it, what it names, its last swing or cast.
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit(), mob({ targetObjectId: SPIRIT_ID })] })).toBe(700);
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit({ targetObjectId: 700 }), mob()] })).toBe(700);
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit(), mob()] }, [{ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 700 }])).toBe(700);
            // Dead, out of view or a friend is no foe.
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit(), mob()] }, [{ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 700 }, { kind: 'death', attackerObjectId: null, targetObjectId: 700 }])).toBeNull();
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit()] }, [{ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 700 }])).toBeNull();
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit({ targetObjectId: 203 }), mob({ objectId: 203, realm: 'albion' })] })).toBeNull();
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit()], nearbyPlayers: [makePlayerObj({ objectId: 300, realm: 'albion' })] }, [{ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 300 }])).toBeNull();
            expect(foeOf({ summons: [SPIRIT_ID], nearbyNpcs: [spirit()], nearbyPlayers: [makePlayerObj({ objectId: 300, realm: 'midgard' })] }, [{ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 300 }])).toBe(300);
        });

        test('the pet\'s last swing says nothing of a mob that took a dead one\'s id, or after a long while', () => {
            const taken = () => [petNpc(), mob({ healthPercent: 60, targetObjectId: 999 })];
            const died = petWorld({ nearbyNpcs: taken() });
            died.w.combat({ kind: 'melee', attackerObjectId: PET_ID, targetObjectId: 700, result: 'hit', targetHealthPercent: 10 });
            died.w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
            died.w.publish();
            expect(died.bot.findKillableNpcs()).toEqual([]);

            const old = petWorld({ nearbyNpcs: taken() });
            old.w.state.combatEvents = [{ id: 1, receivedAt: Date.now() - 60_000, kind: 'melee', attackerObjectId: PET_ID, targetObjectId: 700, result: 'hit', targetHealthPercent: 60 }];
            old.w.publish();
            expect(old.bot.findKillableNpcs()).toEqual([]);

            const fresh = petWorld({ nearbyNpcs: taken() });
            fresh.w.combat({ kind: 'melee', attackerObjectId: PET_ID, targetObjectId: 700, result: 'hit', targetHealthPercent: 60 });
            fresh.w.publish();
            expect(fresh.bot.findKillableNpcs().map(n => n.objectId)).toEqual([700]);
        });

        test('without a pet nothing changes', () => {
            const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, healthPercent: 80, targetObjectId: 600 }), mob({ objectId: 702 })] });
            w.publish();
            expect(bot.findKillableNpcs().map(n => n.objectId)).toEqual([702]);
        });

        test('a name prefers what isn\'t a pet, however short the pet\'s; only a pet matching still resolves; ids work', async () => {
            const cub = petNpc({ name: 'wolf cub', x: 560010 });
            const { w, bot, sdk } = petWorld({ nearbyNpcs: [cub, mob()] });
            w.publish();
            const helpers = new ActionHelpers(sdk);
            expect(helpers.resolveNpc('wolf')?.objectId).toBe(700);
            expect(helpers.resolveAny('wolf')?.objectId).toBe(700);
            expect(helpers.resolveLiving('wolf')?.objectId).toBe(700);
            expect(helpers.resolveNpc('cub')?.objectId).toBe(PET_ID);
            expect(helpers.resolveAny('cub')?.objectId).toBe(PET_ID);
            expect(helpers.resolveNpc(PET_ID)?.objectId).toBe(PET_ID);
            expect(helpers.resolveAny(PET_ID)?.objectId).toBe(PET_ID);
            expect(helpers.resolveNpc(cub)?.objectId).toBe(PET_ID);
            // Before, the pet won on length: killNpc('wolf') said not_attackable.
            w.stepSize = 1000;
            fightSim(w, { dmg: 50 });
            expect(await bot.killNpc('wolf')).toMatchObject({ success: true, npc: { objectId: 700 } });
        });

        test('killNpc refuses our own, not an enemy realm\'s pet; petAttack takes it too; and it is no monster to go looking for', async () => {
            const hostile = petNpc({ objectId: 610, name: 'spirit fighter', realm: 'midgard', x: 560100 });
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), hostile] });
            w.handlers.attack = () => {};
            expect((await bot.killNpc(610, { timeout: 150, usePet: false })).reason).toBe('timeout');
            expect(await bot.killNpc(PET_ID)).toMatchObject({ success: false, reason: 'not_attackable' });
            orders(w, (_a, world) => world.message('You command the amber simulacrum to kill your target!'));
            expect(await bot.petAttack(610)).toMatchObject({ success: true });
            expect(bot.findKillableNpcs({ maxCon: 3 }).map(n => n.objectId)).not.toContain(610);
        });
    });

    describe('rest with a pet', () => {
        const hurt = () => makePlayer({ healthPercent: 50, health: 50 });
        const fit = () => makePlayer({ healthPercent: 100, health: 100 });

        test('refuses in_combat while a mob is on the pet, and while the pet fights', async () => {
            const onPet = petWorld({ player: hurt(), nearbyNpcs: [petNpc(), mob({ targetObjectId: PET_ID })] });
            const r = await onPet.bot.rest();
            expect(r).toMatchObject({ success: false, reason: 'in_combat' });
            expect(r.message).toContain('young wolf');
            expect(onPet.w.sentOf('sit')).toEqual([]);

            const fighting = petWorld({ player: hurt(), pet: petWindow({ targetObjectId: 700 }) });
            expect(await fighting.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
            expect(fighting.w.sentOf('sit')).toEqual([]);
        });

        test('refuses in_combat while a summon fights, with no window at all', async () => {
            const onIt = world({ pet: null, player: hurt(), summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob({ targetObjectId: SPIRIT_ID })] });
            expect(await onIt.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
            expect(onIt.w.sentOf('sit')).toEqual([]);

            const casting = world({ pet: null, player: hurt(), summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob({ healthPercent: 70 })] });
            casting.w.combat({ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 700, effectId: 1 });
            casting.w.publish();
            const r = await casting.bot.rest();
            expect(r).toMatchObject({ success: false, reason: 'in_combat' });
            expect(r.message).toContain('young wolf');
        });

        test('a target long gone from view blocks nothing, and neither does an idle pet', async () => {
            const { w, bot } = petWorld({ player: hurt(), pet: petWindow({ targetObjectId: 999 }) });
            w.onTick = world => { if (world.player.isSitting) { world.player.health = Math.min(100, world.player.health + 10); world.player.healthPercent = world.player.health; } };
            expect(await bot.rest()).toMatchObject({ success: true });
        });

        test('stops with in_combat when the pet is drawn into a fight meanwhile', async () => {
            const { w, bot } = petWorld({ player: hurt() });
            setTimeout(() => { w.state.nearbyNpcs[1]!.targetObjectId = PET_ID; }, 60);
            const r = await bot.rest();
            expect(r).toMatchObject({ success: false, reason: 'in_combat' });
            expect(r.message).toContain('young wolf');
            expect(w.player.isSitting).toBeFalse();
        });

        test('the pet check comes before "already rested": a healthy owner is refused too', async () => {
            const onPet = petWorld({ player: fit(), nearbyNpcs: [petNpc(), mob({ targetObjectId: PET_ID })] });
            expect(await onPet.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
            const fighting = petWorld({ player: fit(), pet: petWindow({ targetObjectId: 700 }) });
            expect(await fighting.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
            const summon = world({ player: fit(), pet: null, summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob({ targetObjectId: SPIRIT_ID })] });
            expect(await summon.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
            expect(onPet.w.sentOf('sit')).toEqual([]);
        });

        test('a pet running to its mob counts: its 0xA1 reads 0xFFFF and names no one (PacketLib168.cs:820-828)', async () => {
            const { w, bot } = petWorld({ player: fit(), nearbyNpcs: [petNpc({ inCombat: true, speed: 191 }), mob()] });
            for (const options of [{}, { healthPercent: 101 }]) {
                const r = await bot.rest(options);
                expect(r).toMatchObject({ success: false, reason: 'in_combat' });
                expect(r.message).toContain('amber simulacrum');
            }
            expect(w.sentOf('sit')).toEqual([]);

            const summon = world({ player: fit(), pet: null, summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit({ inCombat: true, speed: 191 }), mob()] });
            expect(await summon.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });

            // Anyone else's pet in view is none of ours.
            const other = world({ player: fit(), pet: null, summons: [], nearbyObjects: [], nearbyNpcs: [spirit({ inCombat: true, speed: 191 }), mob()] });
            expect(await other.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });
        });

        test('one reading 0xFFFF at a standstill with our combat clock off is in no fight: a minion after its passive commander\'s kill reads so for as long as nothing changes', async () => {
            const minion = world({ player: fit(), pet: petWindow({ aggression: 'passive' }), summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [petNpc(), spirit({ inCombat: true })] });
            expect(await minion.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });
            const windowPet = petWorld({ player: fit(), nearbyNpcs: [petNpc({ inCombat: true })] });
            expect(await windowPet.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });
            // Our own clock still running, it is.
            const clock = world({ player: makePlayer({ healthPercent: 100, health: 100, inCombat: true }), pet: petWindow({ aggression: 'passive' }), summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [petNpc(), spirit({ inCombat: true })] });
            const r = await clock.bot.rest();
            expect(r).toMatchObject({ success: false, reason: 'in_combat' });
            expect(r.message).toContain('air spirit');
        });

        test('the window pet at a standstill with no target is in no fight, our combat clock or not: a turret after its kill reads 0xFFFF until the next heartbeat (PacketLib168.cs:820-828, ClientService.cs:816-823)', async () => {
            const standing = petWorld({ player: makePlayer({ healthPercent: 100, health: 100, inCombat: true }), nearbyNpcs: [petNpc({ inCombat: true }), mob()] });
            expect(await standing.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });

            const low = petWorld({ player: makePlayer({ healthPercent: 50, health: 50, inCombat: true }), nearbyNpcs: [petNpc({ inCombat: true }), mob()] });
            low.w.onTick = world => { if (world.player.isSitting) { world.player.health = 100; world.player.healthPercent = 100; } };
            expect(await low.bot.rest()).toMatchObject({ success: true });
            expect(low.w.sentOf('sit')[0]).toMatchObject({ sit: true });

            // A target the model holds, out of view: it may well be fighting.
            const aimed = petWorld({ player: makePlayer({ healthPercent: 100, health: 100, inCombat: true }), pet: petWindow({ targetObjectId: 999 }), nearbyNpcs: [petNpc({ inCombat: true }), mob()] });
            const r = await aimed.bot.rest();
            expect(r).toMatchObject({ success: false, reason: 'in_combat' });
            expect(r.message).toContain('amber simulacrum');

            // On its way it counts, and a pet outside the window goes by our combat clock.
            const running = petWorld({ player: fit(), nearbyNpcs: [petNpc({ inCombat: true, speed: 191 }), mob()] });
            expect(await running.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
            const minion = world({ player: makePlayer({ healthPercent: 100, health: 100, inCombat: true }), pet: petWindow(), summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [petNpc(), spirit({ inCombat: true })] });
            const m = await minion.bot.rest();
            expect(m).toMatchObject({ success: false, reason: 'in_combat' });
            expect(m.message).toContain('air spirit');
        });

        test('a summon in its first moments holds up a rest with something to do: a caster in range has nothing to show until its first cast lands (PacketLib168.cs:820)', async () => {
            const fresh = world({ player: hurt(), pet: null, summons: [SPIRIT_ID], freshSummons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob()] });
            const r = await fresh.bot.rest();
            expect(r).toMatchObject({ success: false, reason: 'in_combat' });
            expect(r.message).toBe('Cannot rest: our air spirit has just come');
            expect(fresh.w.sentOf('sit')).toEqual([]);

            // Nothing to do: it says so first.
            const needless = world({ player: fit(), pet: null, summons: [SPIRIT_ID], freshSummons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob()] });
            expect(await needless.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });
            expect(needless.w.sentOf('sit')).toEqual([]);

            // A real fight still comes before that.
            const onIt = world({ player: fit(), pet: null, summons: [SPIRIT_ID], freshSummons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob({ targetObjectId: SPIRIT_ID })] });
            const f = await onIt.bot.rest();
            expect(f).toMatchObject({ success: false, reason: 'in_combat' });
            expect(f.message).toContain('fighting young wolf');

            const later = world({ player: fit(), pet: null, summons: [SPIRIT_ID], freshSummons: [], nearbyObjects: [], nearbyNpcs: [spirit(), mob()] });
            expect(await later.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });
            const older = world({ player: fit(), pet: null, summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob()] });
            expect(await older.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });
        });

        test('one that comes while we sit stops the rest, unless that rest is done', async () => {
            const during = world({ player: hurt(), pet: null, summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob()] });
            setTimeout(() => { during.w.state.freshSummons = [SPIRIT_ID]; }, 60);
            const r = await during.bot.rest();
            expect(r).toMatchObject({ success: false, reason: 'in_combat' });
            expect(r.message).toBe('Stopped resting: our air spirit has just come');

            const done = world({ player: hurt(), pet: null, summons: [SPIRIT_ID], nearbyObjects: [], nearbyNpcs: [spirit(), mob()] });
            setTimeout(() => {
                done.w.state.freshSummons = [SPIRIT_ID];
                done.w.player.health = 100;
                done.w.player.healthPercent = 100;
            }, 60);
            expect(await done.bot.rest()).toMatchObject({ success: true });
        });

        test('the owner-attacked check keeps its order: a rest not needed succeeds', async () => {
            const healthy = world({ player: fit(), pet: null, nearbyNpcs: [mob({ targetObjectId: 100 })] });
            expect(await healthy.bot.rest()).toMatchObject({ success: true, message: 'Already rested' });
            const low = world({ pet: null, player: hurt(), nearbyNpcs: [mob({ targetObjectId: 100 })] });
            expect(await low.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
        });

        test('the loop re-checks: a pet that starts running while we sit, and a fight in the snapshot that also ends the rest', async () => {
            const running = petWorld({ player: hurt() });
            setTimeout(() => {
                running.w.npc(PET_ID)!.inCombat = true;
                running.w.npc(PET_ID)!.speed = 191;
            }, 60);
            expect(await running.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
            expect(running.w.sentOf('sit')[0]).toMatchObject({ sit: true });

            const both = petWorld({ player: hurt() });
            setTimeout(() => {
                both.w.player.health = 100;
                both.w.player.healthPercent = 100;
                both.w.npc(700)!.targetObjectId = PET_ID;
            }, 60);
            expect(await both.bot.rest()).toMatchObject({ success: false, reason: 'in_combat' });
        });

        describe('petHealthPercent', () => {
            const regen = (w: FakeWorld, step = 10) => {
                w.onTick = world => {
                    const pet = world.npc(PET_ID);
                    if (pet && world.player.isSitting) pet.healthPercent = Math.min(100, pet.healthPercent + step);
                };
            };

            test('a healthy owner sits until the pet reaches it, and stands', async () => {
                const { w, bot } = petWorld({ player: fit(), nearbyNpcs: [petNpc({ healthPercent: 30 }), mob()] });
                regen(w);
                const r = await bot.rest({ petHealthPercent: 60 });
                expect(r).toMatchObject({ success: true });
                expect(r.message).toContain('pet');
                expect(w.npc(PET_ID)!.healthPercent).toBeGreaterThanOrEqual(60);
                expect(w.sentOf('sit').map(a => a.sit)).toEqual([true, false]);
            });

            test('a pet already there is already rested', async () => {
                const { w, bot } = petWorld({ player: fit(), nearbyNpcs: [petNpc({ healthPercent: 60 }), mob()] });
                expect(await bot.rest({ petHealthPercent: 60 })).toMatchObject({ success: true, message: 'Already rested' });
                expect(w.sentOf('sit')).toEqual([]);
            });

            test('both have to get there: the owner\'s thresholds still count', async () => {
                const { w, bot } = petWorld({ player: hurt(), nearbyNpcs: [petNpc({ healthPercent: 90 }), mob()] });
                w.onTick = world => { if (world.player.isSitting) { world.player.health += 10; world.player.healthPercent = world.player.health; } };
                await bot.rest({ petHealthPercent: 60 });
                expect(w.player.healthPercent).toBeGreaterThanOrEqual(90);
            });

            test('no pet, or none in view: ignored', async () => {
                const none = world({ player: fit(), pet: null, nearbyNpcs: [mob()] });
                expect(await none.bot.rest({ petHealthPercent: 90 })).toMatchObject({ success: true, message: 'Already rested' });
                const away = petWorld({ player: fit(), nearbyNpcs: [mob()] });
                expect(await away.bot.rest({ petHealthPercent: 90 })).toMatchObject({ success: true, message: 'Already rested' });
            });

            test('a pet lost while we sit ends the wait for it', async () => {
                const { w, bot } = petWorld({ player: fit(), nearbyNpcs: [petNpc({ healthPercent: 30 }), mob()] });
                setTimeout(() => { w.removeNpc(PET_ID); w.state.pet = null; }, 60);
                expect(await bot.rest({ petHealthPercent: 60 })).toMatchObject({ success: true });
            });

            test('a timeout says it was the pet that lacked: our own health can read full', async () => {
                const { bot } = petWorld({ player: fit(), nearbyNpcs: [petNpc({ healthPercent: 30 }), mob()] });
                const r = await bot.rest({ petHealthPercent: 60, timeout: 80 });
                expect(r).toMatchObject({ success: false, reason: 'timeout' });
                expect(r.message).toContain('pet at 30%');
            });
        });
    });

    describe('grind with a pet', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';

        test('a mob on the pet, at 100 and with its DoT ticking on us: the pet goes on, and we don\'t walk in and swing at it', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), pet: petWindow({ targetObjectId: 701 }), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, targetObjectId: PET_ID })] });
            orders(w, (a, world) => { if (a.command === 'attack') world.message(KILL); });
            const killNpc = spyOn(bot, 'killNpc');
            w.combat({ kind: 'melee', attackerObjectId: 701, targetObjectId: w.player.objectId, result: 'other', targetHealthPercent: 90 });
            w.publish();
            setTimeout(() => dies(w, 701), 300);
            await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false });
            expect(killNpc).not.toHaveBeenCalled();
            expect(w.sentOf('attack')).toEqual([]);
            expect(w.sentOf('moveTo')).toEqual([]);
        });

        const summoning = (w: FakeWorld) => {
            let id = PET_ID;
            w.handlers.castSpell = (_a, world) => {
                const pet = id++;
                setTimeout(() => {
                    world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                    world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc({ objectId: pet })];
                    world.state.pet = petWindow({ objectId: pet });
                }, 10);
            };
        };
        /** The pet kills what it is ordered onto, one tick per 25 %. */
        const petFights = (w: FakeWorld) => {
            let on: number | null = null;
            orders(w, (a, world) => {
                if (a.command === 'attack') {
                    world.message(KILL);
                    on = a.targetObjectId ?? null;
                }
            });
            const tick = (world: FakeWorld) => {
                if (on === null || !world.state.pet) return;
                const npc = world.npc(on);
                if (!npc) return;
                npc.healthPercent = Math.max(0, npc.healthPercent - 25);
                if (npc.healthPercent === 0) {
                    world.removeNpc(on);
                    world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: on, targetHealthPercent: 0 });
                    world.player.experience += 10;
                    world.message('You get 10 experience points.', { type: 'important' });
                    on = null;
                }
            };
            return tick;
        };

        test('summons before the first fight, then the pet does the killing with petKill', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701 }), mob({ objectId: 702, x: 560600 })], nearbyObjects: [] });
            summoning(w);
            w.onTick = petFights(w);
            const r = await bot.grind({ pet: true, maxKills: 2, durationMs: 10_000, loot: false });
            expect(r).toMatchObject({ success: true, kills: 2, stopReason: 'maxKills', xpGained: 20 });
            expect(w.sent.findIndex(a => a.type === 'castSpell')).toBeLessThan(w.sent.findIndex(a => a.type === 'petCommand'));
            expect(w.sentOf('castSpell')).toHaveLength(1);
            expect(w.sentOf('petCommand').map(a => a.targetObjectId)).toEqual([701, 702]);
            expect(w.sentOf('attack')).toEqual([]);
        });

        test('a pet already up is used, not summoned over', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum) });
            w.onTick = petFights(w);
            expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 10_000, loot: false })).toMatchObject({ kills: 1 });
            expect(w.sentOf('castSpell')).toEqual([]);
        });

        test('summons again after a loss', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701 }), mob({ objectId: 702, x: 560600 })], nearbyObjects: [] });
            summoning(w);
            w.onTick = petFights(w);
            let lost = false;
            const r = await bot.grind({
                pet: { resummon: true }, maxKills: 2, durationMs: 10_000, loot: false,
                onKill: () => {
                    if (lost) return;
                    lost = true;
                    w.state.pet = null;
                    w.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'died', at: Date.now() };
                    w.publish();
                },
            });
            expect(r).toMatchObject({ success: true, kills: 2 });
            expect(w.sentOf('castSpell')).toHaveLength(2);
        });

        test('resummon false: after the loss it fights on in melee', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701 }), mob({ objectId: 702, x: 560600 })], nearbyObjects: [] });
            summoning(w);
            fightSim(w); // only while we are swinging
            const melee = w.onTick!;
            const petTick = petFights(w);
            w.onTick = world => { petTick(world); melee(world); };
            const r = await bot.grind({
                pet: { resummon: false }, maxKills: 2, durationMs: 10_000, loot: false,
                onKill: () => { w.state.pet = null; w.publish(); },
            });
            expect(r).toMatchObject({ kills: 2 });
            expect(w.sentOf('castSpell')).toHaveLength(1);
            expect(w.sentOf('attack').map(a => a.on)).toContain(true);
        });

        test('summons again after a respawn', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701 })], nearbyObjects: [] });
            summoning(w);
            orders(w, (a, world) => {
                if (a.command !== 'attack') return;
                world.message(KILL);
                if (world.player.deathCount > 0) return;
                world.player.isDead = true;
                world.player.deathCount = 1;
                world.state.pet = null;
            });
            w.handlers.release = (_a, world) => {
                setTimeout(() => { world.message('You release your corpse unto death.'); world.player.isDead = false; world.player.x += 5000; }, 10);
            };
            const r = await bot.grind({ pet: true, respawn: true, durationMs: 1500, minEngageMs: 0, loot: false, killTimeout: 100 });
            expect(r.deaths).toBe(1);
            expect(w.sentOf('castSpell').length).toBeGreaterThanOrEqual(2);
        });

        describe('after a respawn', () => {
            const respawns = (w: FakeWorld) => {
                w.handlers.release = (_a, world) => {
                    setTimeout(() => { world.message('You release your corpse unto death.'); world.player.isDead = false; world.player.health = 100; world.player.healthPercent = 100; world.player.x += 5000; }, 10);
                };
            };
            const deadOnStart = (spell = simulacrum) => world({ pet: null, player: makePlayer({ isDead: true, health: 0, healthPercent: 0 }), skills: skillsWith(spell), nearbyNpcs: [], nearbyObjects: [] });
            const order = (w: FakeWorld) => w.sent.map(a => a.type).filter(t => t === 'release' || t === 'castSpell' || t === 'moveTo');

            test('the summon goes first, and the pet follows on the walk back', async () => {
                const { w, bot } = deadOnStart();
                respawns(w);
                summoning(w);
                const r = await bot.grind({ pet: true, respawn: true, durationMs: 1200, minEngageMs: 0, noTargetTimeoutMs: 0, anchor: { x: 560000, y: 511000, z: 2500 } });
                expect(r.deaths).toBe(0);
                expect(order(w).slice(0, 3)).toEqual(['release', 'castSpell', 'moveTo']);
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });

            test('on cooldown the walk doesn\'t wait for it', async () => {
                const { w, bot } = deadOnStart({ ...simulacrum, cooldownRemaining: 60 });
                respawns(w);
                await bot.grind({ pet: true, respawn: true, durationMs: 800, minEngageMs: 0, noTargetTimeoutMs: 0, anchor: { x: 560000, y: 511000, z: 2500 } });
                expect(order(w).slice(0, 2)).toEqual(['release', 'moveTo']);
                expect(w.sentOf('castSpell')).toEqual([]);
            });

            test('with resummon off, or too little time to walk, there is none', async () => {
                const off = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, targetObjectId: PET_ID })] });
                respawns(off.w);
                summoning(off.w);
                orders(off.w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    world.player.isDead = true;
                    world.player.deathCount = 1;
                    world.state.pet = null;
                });
                await off.bot.grind({ pet: { resummon: false }, respawn: true, durationMs: 400, minEngageMs: 0, noTargetTimeoutMs: 0 });
                expect(off.w.sentOf('release')).toHaveLength(1);
                expect(off.w.sentOf('castSpell')).toEqual([]);

                const short = deadOnStart();
                respawns(short.w);
                summoning(short.w);
                await short.bot.grind({ pet: true, respawn: true, durationMs: 400, minEngageMs: 60_000, noTargetTimeoutMs: 0 });
                expect(short.w.sentOf('castSpell')).toEqual([]);
            });
        });

        test('no pull and no rest while the pet fights: its mob is next, and its kill counts', async () => {
            const { w, bot } = petWorld({
                skills: skillsWith(simulacrum),
                player: makePlayer({ health: 20, healthPercent: 20 }),
                nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, targetObjectId: PET_ID }), mob({ objectId: 702, x: 560050 })],
            });
            w.onTick = petFights(w);
            const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
            expect(r).toMatchObject({ kills: 1 });
            expect(r.killLog[0]!.name).toBe('young wolf');
            expect(w.sentOf('petCommand')[0]).toMatchObject({ targetObjectId: 701 });
            expect(w.sentOf('sit')).toEqual([]);
        });

        test('an enemy player on the pet is waited out, without a pull', async () => {
            const enemy = makePlayerObj({ objectId: 800, name: 'Norseman', realm: 'midgard' });
            const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 800 }), nearbyPlayers: [enemy], skills: skillsWith(simulacrum) });
            const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false });
            expect(r).toMatchObject({ kills: 0 });
            expect(w.sentOf('petCommand')).toEqual([]);
        });

        test("fight 'both' uses killNpc, which orders the pet", async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560100 })], nearbyObjects: [] });
            summoning(w);
            orders(w);
            fightSim(w, { dmg: 50 });
            const r = await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 10_000, loot: false });
            expect(r).toMatchObject({ kills: 1 });
            expect(w.sentOf('petCommand').map(a => a.command)).toEqual(['attack']);
            expect(w.sentOf('attack').map(a => a.on)).toContain(true);
        });

        test('mobs on us with no pet are fought in melee, not left standing', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
            summoning(w);
            fightSim(w, { dmg: 50 });
            const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
            expect(r).toMatchObject({ kills: 1 });
            expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            expect(w.sentOf('castSpell')).toEqual([]);
        });

        test('no summon spell, or a pet no window lists: error at once', async () => {
            const { w, bot } = world({ pet: null, nearbyNpcs: [mob()] });
            expect(await bot.grind({ pet: true, durationMs: 5000 })).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported', kills: 0 });
            expect(w.sentOf('petCommand')).toEqual([]);

            const theurgist = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [mob()], player: makePlayer({ targetObjectId: 700 }) });
            summons(theurgist.w, earth.name, 'earth spirit', { window: false, id: 611 });
            const r = await theurgist.bot.grind({ pet: { spell: 'Call Minor Earth Elemental' }, durationMs: 5000 });
            expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported' });
            expect(r.message).toContain('window');
            expect(r.message).toContain('summonPet(spell, { target })');
            expect(theurgist.w.sentOf('castSpell')).toEqual([]);
        });

        test('an Animist\'s fire-and-forget turret stands on the ground: the hint says so, as summonPet()\'s does (SummonAnimistFnF.cs:17-20)', async () => {
            const tangler = spellOf('Tangler Sapling', 11146);
            const { w, bot } = world({ pet: null, skills: skillsWith(tangler), nearbyNpcs: [mob()] });
            const r = await bot.grind({ pet: { spell: tangler }, durationMs: 5000 });
            expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported' });
            expect(r.message).toContain('summonPet(spell, { groundTarget })');
            expect(r.message).not.toContain('{ target }');
            expect((await bot.summonPet()).message).toContain('summonPet(spell, { groundTarget })');
            expect(w.sentOf('castSpell')).toEqual([]);
        });

        test('a summon that keeps being refused stops the run; one short of power rests first', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob()], player: makePlayer({ mana: 100, maxMana: 100, manaPercent: 100 }) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't do that here!", { type: 'important' }), 5); };
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            const skewing = setInterval(() => { skew += 1000; }, 10);
            try {
                const r = await bot.grind({ pet: true, durationMs: 3_600_000, minEngageMs: 0 });
                expect(r).toMatchObject({ success: false, stopReason: 'error' });
                expect(r.message).toContain("You can't do that here!");
                expect(w.sentOf('castSpell')).toHaveLength(3);
            } finally {
                clearInterval(skewing);
                clock.mockRestore();
            }

            const tired = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [], player: makePlayer({ health: 100, healthPercent: 100, mana: 10, maxMana: 100, manaPercent: 10 }) });
            let casts = 0;
            tired.w.handlers.castSpell = (_a, world) => {
                casts++;
                if (world.player.manaPercent < 25) {
                    setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5);
                    return;
                }
                setTimeout(() => {
                    world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                    world.state.nearbyNpcs = [petNpc()];
                    world.state.pet = petWindow();
                }, 5);
            };
            tired.w.onTick = world => { if (world.player.isSitting) { world.player.mana = Math.min(100, world.player.mana + 10); world.player.manaPercent = world.player.mana; } };
            await tired.bot.grind({ pet: true, durationMs: 800, minEngageMs: 0, noTargetTimeoutMs: 100 });
            expect(casts).toBe(2);
            expect(tired.w.sentOf('sit').map(a => a.sit)).toContain(true);
            expect(tired.sdk.getPetState()).not.toBeNull();
        });

        test('an interrupted summon is tried again and never stops the run', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            let casts = 0;
            w.handlers.castSpell = (_a, world) => {
                casts++;
                setTimeout(() => world.message('The goblin attacks you and your spell is interrupted!', { type: 'spell' }), 5);
            };
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            const skewing = setInterval(() => { skew += 40; }, 10);
            try {
                const r = await bot.grind({ pet: true, durationMs: 12_000, minEngageMs: 0 });
                expect(r.stopReason).toBe('duration');
                expect(casts).toBeGreaterThan(3);
            } finally {
                clearInterval(skewing);
                clock.mockRestore();
            }
        });

        /** The pet fights what it is ordered onto, as `hit` says, until a follow calls it off. A kill gives 10 xp. */
        const fightsLike = (w: FakeWorld, hit: (id: number, attacks: number) => number) => {
            let on: number | null = null;
            let attacks = 0;
            orders(w, (a, world) => {
                if (a.command === 'attack') {
                    world.message(KILL);
                    on = a.targetObjectId ?? null;
                    attacks++;
                    world.state.pet = { ...world.state.pet!, targetObjectId: on };
                } else if (a.command === 'follow') {
                    world.message('You command the amber simulacrum to follow you!');
                    on = null;
                    world.state.pet = { ...world.state.pet!, targetObjectId: null };
                }
            });
            w.onTick = world => {
                const npc = on === null ? undefined : world.npc(on);
                if (!npc) return;
                npc.healthPercent = Math.max(0, npc.healthPercent - hit(npc.objectId, attacks));
                if (npc.healthPercent > 0) return;
                world.removeNpc(npc.objectId);
                world.state.pet = { ...world.state.pet!, targetObjectId: null };
                world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: npc.objectId, targetHealthPercent: 0 });
                world.player.experience += 10;
                world.message('You get 10 experience points.', { type: 'important' });
                on = null;
            };
        };
        const petCommands = (w: FakeWorld) => w.sentOf('petCommand').map(a => [a.command, a.targetObjectId]);

        test('a pet slower than killTimeout is no failure: the fight goes on, and its kill counts', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
            fightsLike(w, () => 3);
            const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 100, loot: false });
            expect(r).toMatchObject({ success: true, kills: 1, failures: 0, xpGained: 10, stopReason: 'maxKills' });
            expect(r.killLog[0]).toMatchObject({ name: 'young wolf', xp: 10 });
            expect(w.sentOf('petCommand').map(a => a.command)).not.toContain('follow');
        });

        test('a mob the pet gets nowhere with is left: the pet is called off, and the run moves on', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560900 })] });
            fightsLike(w, id => id === 702 ? 25 : 0);
            const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 100, loot: false });
            expect(r).toMatchObject({ success: true, kills: 1, failures: 1 });
            expect(petCommands(w)).toEqual([['attack', 701], ['follow', undefined], ['attack', 702]]);
        });

        test('a mob still on the pet after the call-off stays in the fight, and its death counts', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, targetObjectId: PET_ID })] });
            fightsLike(w, (_id, attacks) => attacks < 2 ? 0 : 25);
            const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 100, loot: false });
            expect(r).toMatchObject({ success: true, kills: 1, failures: 1, xpGained: 10 });
            expect(petCommands(w)).toEqual([['attack', 701], ['follow', undefined], ['attack', 701]]);
        });

        test('a plain grind in shade: the mob that outlasts killTimeout stays the fight, with no fresh one ordered on top', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, targetObjectId: PET_ID }), mob({ objectId: 702, x: 560900 })] });
            fightsLike(w, (_id, attacks) => attacks < 2 ? 0 : 25);
            const r = await bot.grind({ maxKills: 1, durationMs: 5000, killTimeout: 100, loot: false });
            expect(r).toMatchObject({ success: true, kills: 1, xpGained: 10 });
            expect(petCommands(w)).toEqual([['attack', 701], ['follow', undefined], ['attack', 701]]);
        });

        test('without the option grind summons nothing and a pet is only ordered by killNpc', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560100 })], nearbyObjects: [] });
            fightSim(w, { dmg: 50 });
            expect(await bot.grind({ maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
            expect(w.sentOf('castSpell')).toEqual([]);
            expect(w.sentOf('petCommand')).toEqual([]);
        });

        /** The pet's end: it leaves the window and the view. */
        const petDies = (world: FakeWorld, id = PET_ID) => {
            world.removeNpc(id);
            world.state.pet = null;
            world.state.lastPetLoss = { objectId: id, name: 'amber simulacrum', cause: 'died', at: Date.now() };
        };
        const orderedOnto = (w: FakeWorld) => w.sentOf('petCommand').filter(a => a.command === 'attack').map(a => a.targetObjectId);
        /** Runs with Date.now going `rate` ms faster per 10 ms. */
        const fast = async (rate: number, run: () => Promise<void>) => {
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            const skewing = setInterval(() => { skew += rate; }, 10);
            try {
                await run();
            } finally {
                clearInterval(skewing);
                clock.mockRestore();
            }
        };

        describe('what comes next', () => {
            test('the mob that killed the pet: the new pet is ordered onto it, not onto a fresh one nearer by', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                summoning(w);
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks > 1) return void setTimeout(() => dies(world, a.targetObjectId!), 20);
                    // Chasing now: its 0xA1 reads 0xFFFF, so it reads as on nobody.
                    petDies(world);
                    world.state.nearbyNpcs = [...world.state.nearbyNpcs, mob({ objectId: 702, x: 560100 })];
                });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 1 });
                expect(r.killLog[0]!.name).toBe('young wolf');
                expect(orderedOnto(w)).toEqual([701, 701]);
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });

            test('a mob on us comes next, and the one the pet had after it: no fresh mob comes between', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 700 }), mob({ objectId: 701, x: 560700 })] });
                const orderedAt: number[] = [];
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    const on = a.targetObjectId!;
                    orderedAt.push(Date.now());
                    world.state.pet = petWindow({ targetObjectId: on });
                    if (orderedAt.length > 1) {
                        setTimeout(() => { dies(world, on); world.state.pet = petWindow(); }, 20);
                        return;
                    }
                    setTimeout(() => {
                        world.npc(701)!.targetObjectId = 100;
                        // Something new and nearer has walked up meanwhile.
                        world.state.nearbyNpcs = [...world.state.nearbyNpcs, mob({ objectId: 702, x: 560100 })];
                    }, 20);
                });
                const r = await bot.grind({ pet: true, maxKills: 2, durationMs: 6000, loot: false });
                expect(r).toMatchObject({ kills: 2, failures: 0 });
                expect(orderedOnto(w)).toEqual([700, 701, 700]);
                // `attacked` straight after the order spent no time, so the next pass waited.
                expect(orderedAt[1]! - orderedAt[0]!).toBeGreaterThanOrEqual(990);
            });

            test('a mob that swung at us and let go still comes before a fresh one, after what the pet is on', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 700 }), mob({ objectId: 701, x: 560700 })] });
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    const on = a.targetObjectId!;
                    world.state.pet = petWindow({ targetObjectId: on });
                    if (++attacks > 1) {
                        setTimeout(() => { dies(world, on); world.state.pet = petWindow(); }, 20);
                        return;
                    }
                    setTimeout(() => { world.npc(701)!.targetObjectId = 100; }, 20);
                    setTimeout(() => {
                        world.npc(701)!.targetObjectId = null;
                        world.state.nearbyNpcs = [...world.state.nearbyNpcs, mob({ objectId: 702, x: 560100 })];
                    }, 200);
                    setTimeout(() => { dies(world, on); world.state.pet = petWindow(); }, 1300);
                });
                const r = await bot.grind({ pet: true, maxKills: 2, durationMs: 6000, loot: false });
                expect(r).toMatchObject({ kills: 2, failures: 0 });
                expect(orderedOnto(w)).toEqual([700, 701]);
            });

            test('a mob that got away is no reason to wait, and neither is one that died', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560700 })] });
                summoning(w);
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks > 1) return void setTimeout(() => dies(world, a.targetObjectId!), 20);
                    petDies(world);
                    // Beyond any chase of ours, still in view.
                    world.npc(701)!.x = 562700;
                });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(orderedOnto(w)).toEqual([701, 702]);

                const dead = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560700 })] });
                summoning(dead.w);
                attacks = 0;
                orders(dead.w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks > 1) return void setTimeout(() => dies(world, a.targetObjectId!), 20);
                    petDies(world);
                    // It dies to something else, and a new mob of the same name has its id at once (Region.cs:955, :779), farther off.
                    world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 701, targetHealthPercent: 0 });
                    world.npc(701)!.x = 560800;
                });
                const again = await dead.bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(again).toMatchObject({ kills: 1 });
                expect(orderedOnto(dead.w)).toEqual([701, 702]);
            });

            test('with no pet and no resummon the mob the pet had is fought in melee, before a fresh one', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050 })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    petDies(world);
                    world.state.nearbyNpcs = [...world.state.nearbyNpcs, mob({ objectId: 702, x: 560040 })];
                });
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 5000, loot: false });
                expect(r.killLog.map(k => k.name)).toEqual(['young wolf']);
                expect(w.npc(701)).toBeUndefined();
                expect(w.npc(702)).toBeDefined();
            });

            test('a plain grind in shade: the servant\'s mob comes before a fresh one nearer by', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300, targetObjectId: PET_ID }), mob({ objectId: 702, x: 560100 })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    setTimeout(() => dies(world, a.targetObjectId!), 20);
                });
                expect(await bot.grind({ maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(orderedOnto(w)).toEqual([701]);
            });

            test('a plain grind in shade: short of time, a mob on the servant isn\'t left standing', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, targetObjectId: PET_ID })] });
                w.onTick = petFights(w);
                expect(await bot.grind({ durationMs: 5000, minEngageMs: 60_000, loot: false })).toMatchObject({ kills: 1, stopReason: 'duration' });
            });

            test('a plain grind in shade: a lost servant is summoned again, and ordered back onto the mob', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                summoning(w);
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks > 1) return void setTimeout(() => dies(world, a.targetObjectId!), 20);
                    petDies(world);
                    world.player.isShade = false;
                });
                expect(await bot.grind({ maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(orderedOnto(w)).toEqual([701, 701]);
                expect(w.sentOf('castSpell')).toHaveLength(1);
                expect(w.sentOf('attack')).toEqual([]);
            });

            test('short of time, a fight the pet is in still comes first: it isn\'t left standing', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, targetObjectId: PET_ID })] });
                w.onTick = petFights(w);
                const r = await bot.grind({ pet: true, durationMs: 5000, minEngageMs: 60_000, loot: false });
                expect(r).toMatchObject({ kills: 1, stopReason: 'duration' });
            });

            test('short of time and with no fight on, no fresh pull and no new pet', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701 })], nearbyObjects: [] });
                summoning(w);
                const t0 = Date.now();
                const r = await bot.grind({ pet: true, durationMs: 5000, minEngageMs: 60_000, loot: false });
                expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                expect(Date.now() - t0).toBeLessThan(500);
                expect(w.sent).toEqual([]);
            });
        });

        describe('restBelowPetHealth', () => {
            /** Orders a kill; the pet regains while we sit, or always with `standing`. */
            const regains = (w: FakeWorld, standing = false) => {
                const seen: number[] = [];
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    seen.push(world.npc(PET_ID)!.healthPercent);
                    world.message(KILL);
                    setTimeout(() => dies(world, a.targetObjectId!), 20);
                });
                w.onTick = world => {
                    const pet = world.npc(PET_ID);
                    if (pet && (standing || world.player.isSitting)) pet.healthPercent = Math.min(100, pet.healthPercent + 2);
                };
                return seen;
            };
            const fit = () => makePlayer({ healthPercent: 100, health: 100 });
            const lowPet = (health = 30) => ({ player: fit(), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc({ healthPercent: health }), mob({ objectId: 701 })] });

            test('by default no pull below 50 %: we sit until it is back, also with our own health full', async () => {
                const { w, bot } = petWorld(lowPet());
                const seen = regains(w);
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 8000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(seen[0]).toBeGreaterThanOrEqual(50);
                expect(w.sent.findIndex(a => a.type === 'sit')).toBeLessThan(w.sent.findIndex(a => a.type === 'petCommand'));
            });

            test('a shade counts on this alone: its own health stays full', async () => {
                const { w, bot } = petWorld({ ...lowPet(), player: makePlayer({ healthPercent: 100, health: 100, isShade: true }) });
                const seen = regains(w);
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 8000, loot: false })).toMatchObject({ kills: 1 });
                expect(seen[0]).toBeGreaterThanOrEqual(50);
            });

            test('a plain grind in shade is a pet grind: nothing else would look at the servant', async () => {
                const { w, bot } = petWorld({ ...lowPet(10), player: makePlayer({ healthPercent: 100, health: 100, isShade: true }) });
                const seen = regains(w);
                expect(await bot.grind({ maxKills: 1, durationMs: 8000, loot: false })).toMatchObject({ kills: 1 });
                expect(seen[0]).toBeGreaterThanOrEqual(50);
                expect(w.sentOf('sit').map(a => a.sit)).toContain(true);
            });

            test('a shade that begins during a plain run counts from then on', async () => {
                const { w, bot } = world({ pet: null, player: makePlayer({ healthPercent: 100, health: 100 }), skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560050 })], nearbyObjects: [] });
                fightSim(w, { dmg: 50 });
                let seen: number[] = [];
                const r = await bot.grind({
                    maxKills: 2, durationMs: 8000, loot: false,
                    onKill: () => {
                        if (w.player.isShade) return;
                        w.player.isShade = true;
                        w.state.pet = petWindow();
                        w.state.nearbyNpcs = [...w.state.nearbyNpcs, petNpc({ healthPercent: 10 }), mob({ objectId: 702, x: 560300 })];
                        orders(w);
                        seen = regains(w);
                    },
                });
                expect(r).toMatchObject({ kills: 2 });
                expect(seen[0]).toBeGreaterThanOrEqual(50);
            });

            test('the option moves it, and 0 turns it off', async () => {
                const high = petWorld(lowPet(60));
                const seenHigh = regains(high.w);
                await high.bot.grind({ pet: { restBelowPetHealth: 80 }, maxKills: 1, durationMs: 8000, loot: false });
                expect(seenHigh[0]).toBeGreaterThanOrEqual(80);

                const off = petWorld(lowPet(5));
                const seenOff = regains(off.w);
                await off.bot.grind({ pet: { restBelowPetHealth: 0 }, maxKills: 1, durationMs: 8000, loot: false });
                expect(seenOff[0]).toBeLessThan(50);
                expect(off.w.sentOf('sit')).toEqual([]);
            });

            test('a rest refused is a wait, and still no pull', async () => {
                const { w, bot } = petWorld(lowPet());
                const seen = regains(w, true);
                w.handlers.sit = (_a, world) => { world.message("You can't sit down now!"); };
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 8000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(seen[0]).toBeGreaterThanOrEqual(50);
                // At most one try a second, each with its wait.
                expect(w.sentOf('sit').filter(a => a.sit).length).toBeLessThanOrEqual(3);
            });

            test('it gates a pull, not a fight: a mob on the pet comes first, however low it is', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc({ healthPercent: 10 }), mob({ objectId: 701, targetObjectId: PET_ID })] });
                w.onTick = petFights(w);
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(w.sentOf('sit')).toEqual([]);
            });

            test('a pet out of view can\'t be read, so it holds nothing up', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701 })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    setTimeout(() => dies(world, a.targetObjectId!), 20);
                });
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(w.sentOf('sit')).toEqual([]);
            });

            describe('a rest that outlasts the call', () => {
                /** A run that ends on its rest: a real one has at least 5 s, whatever the run has left. */
                const shortRest = async (bot: BotActions) => {
                    const rests = spyOn(bot, 'rest').mockImplementation(async () => {
                        await Bun.sleep(250);
                        return { success: false, reason: 'timeout', message: 'Rest timed out', healthPercent: 100, manaPercent: 0, endurancePercent: 100, durationMs: 250 };
                    });
                    const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0, loot: false });
                    rests.mockRestore();
                    return r;
                };

                test('the next call on the same pet takes it up: no pull between the gate and restTo', async () => {
                    const { w, bot } = petWorld(lowPet());
                    await shortRest(bot);
                    w.npc(PET_ID)!.healthPercent = 61;
                    w.publish();
                    const seen = regains(w);
                    expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 8000, loot: false })).toMatchObject({ kills: 1 });
                    expect(seen[0]).toBeGreaterThanOrEqual(90);
                });

                test('another pet starts afresh', async () => {
                    const { w, bot } = petWorld(lowPet());
                    await shortRest(bot);
                    w.removeNpc(PET_ID);
                    w.state.nearbyNpcs = [...w.state.nearbyNpcs, petNpc({ objectId: 601, healthPercent: 61 })];
                    w.state.pet = petWindow({ objectId: 601 });
                    w.publish();
                    orders(w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        setTimeout(() => dies(world, a.targetObjectId!), 20);
                    });
                    expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                    expect(w.npc(601)!.healthPercent).toBe(61);
                    expect(w.sentOf('petCommand').map(a => a.targetObjectId)).toEqual([701]);
                });

                test('a pet that was back in between has nothing to take up', async () => {
                    const { w, bot } = petWorld({ ...lowPet(), nearbyNpcs: [petNpc({ healthPercent: 30 })] });
                    await shortRest(bot);
                    w.npc(PET_ID)!.healthPercent = 95;
                    w.publish();
                    await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false });
                    w.npc(PET_ID)!.healthPercent = 61;
                    w.state.nearbyNpcs = [...w.state.nearbyNpcs, mob({ objectId: 701 })];
                    w.publish();
                    const seen = regains(w);
                    expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                    expect(seen[0]).toBeLessThan(70);
                });

                test('a next call with the gate off doesn\'t wait for it', async () => {
                    const { w, bot } = petWorld(lowPet());
                    await shortRest(bot);
                    regains(w);
                    w.onTick = null;
                    await bot.grind({ pet: { restBelowPetHealth: 0 }, maxKills: 1, durationMs: 5000, loot: false });
                    expect(w.sentOf('sit')).toEqual([]);
                });

                test('a run spent on it says so: the health now, and how far it goes', async () => {
                    const { bot } = petWorld(lowPet(42));
                    const r = await shortRest(bot);
                    expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                    expect(r.message).toEndWith('; resting our pet (42 %, to 90 %)');
                });

                test('with the pet back by the end there is nothing to say', async () => {
                    const { w, bot } = petWorld(lowPet(49));
                    regains(w);
                    const r = await bot.grind({ pet: { restToPetHealth: 51 }, maxKills: 1, durationMs: 8000, loot: false });
                    expect(r.message).not.toContain('resting our pet');
                });
            });

            describe('restToPetHealth', () => {
                test('the gate says when, this how far: by default back to 90 %, or a servant pulls at 50 % and its death takes us along', async () => {
                    const { w, bot } = petWorld({ ...lowPet(), player: makePlayer({ healthPercent: 100, health: 100, isShade: true }) });
                    const seen = regains(w);
                    expect(await bot.grind({ maxKills: 1, durationMs: 8000, loot: false })).toMatchObject({ kills: 1 });
                    expect(seen[0]).toBeGreaterThanOrEqual(90);
                });

                test('the option moves it, and the gate is the least it can be', async () => {
                    const asked = async (pet: { restBelowPetHealth?: number; restToPetHealth?: number }) => {
                        const { w, bot } = petWorld(lowPet(30));
                        regains(w);
                        const rests = spyOn(bot, 'rest');
                        await bot.grind({ pet, maxKills: 1, durationMs: 8000, loot: false });
                        return rests.mock.calls[0]![0]!.petHealthPercent;
                    };
                    expect(await asked({})).toBe(90);
                    expect(await asked({ restToPetHealth: 70 })).toBe(70);
                    expect(await asked({ restBelowPetHealth: 60, restToPetHealth: 40 })).toBe(60);
                });

                test('a rest it ends in a timeout is taken up again: the gate alone would pull at the first look above it', async () => {
                    const { w, bot } = petWorld(lowPet(30));
                    const seen = regains(w);
                    // Our rest stops short each time, as one does at its 120 s with a servant.
                    const rests = spyOn(bot, 'rest').mockImplementation(async () => {
                        w.npc(PET_ID)!.healthPercent += 25;
                        return { success: false, reason: 'timeout', message: 'Rest timed out', healthPercent: 100, manaPercent: 0, endurancePercent: 100, durationMs: 120_000 };
                    });
                    const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 8000, loot: false });
                    expect(r).toMatchObject({ kills: 1 });
                    expect(rests.mock.calls.length).toBe(3);
                    expect(seen[0]).toBeGreaterThanOrEqual(90);
                }, 10_000);

                test('above the gate there is no rest for it', async () => {
                    const { w, bot } = petWorld(lowPet(60));
                    const seen = regains(w);
                    await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                    expect(seen[0]).toBe(60);
                    expect(w.sentOf('sit')).toEqual([]);
                });

                test('with the gate off a rest for our own health doesn\'t wait for the pet', async () => {
                    const { w, bot } = petWorld({ ...lowPet(30), player: makePlayer({ health: 40, healthPercent: 40 }) });
                    regains(w);
                    const rests = spyOn(bot, 'rest').mockImplementation(async () => ({ success: false, reason: 'timeout', message: 'Rest timed out', healthPercent: 40, manaPercent: 0, endurancePercent: 100, durationMs: 5000 }));
                    await bot.grind({ pet: { restBelowPetHealth: 0 }, maxKills: 1, durationMs: 300, minEngageMs: 0, loot: false });
                    expect(rests.mock.calls[0]![0]!.petHealthPercent).toBeUndefined();
                });

                test('a rest for our own health takes the pet up as well, as our own health goes up on a rest for mana', async () => {
                    const { w, bot } = petWorld({ ...lowPet(60), player: makePlayer({ health: 40, healthPercent: 40 }) });
                    regains(w);
                    const rests = spyOn(bot, 'rest').mockImplementation(async () => ({ success: false, reason: 'timeout', message: 'Rest timed out', healthPercent: 40, manaPercent: 0, endurancePercent: 100, durationMs: 5000 }));
                    await bot.grind({ pet: true, maxKills: 1, durationMs: 300, minEngageMs: 0, loot: false });
                    expect(rests.mock.calls[0]![0]!.petHealthPercent).toBe(90);
                });
            });
        });

        describe('a pet lost in the run', () => {
            const onUs = 100;
            /** The first order goes out, and the pet dies under it `after` ms on; `then` plays what the mob does next. */
            const diesUnderOrder = (w: FakeWorld, after: number, then: (world: FakeWorld) => void = () => {}) => {
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks > 1) return void setTimeout(() => dies(world, a.targetObjectId!), 20);
                    setTimeout(() => { petDies(world); then(world); }, after);
                });
            };
            const clocks: { mockRestore: () => void }[] = [];
            afterEach(() => { clocks.splice(0).forEach(c => c.mockRestore()); });
            /** diesUnderOrder with the overrun up at that moment: its mob can't hold the run any longer. */
            const diesAsOverrunEnds = (w: FakeWorld, after: number, then: (world: FakeWorld) => void = () => {}) => {
                const realNow = Date.now.bind(Date);
                let skew = 0;
                clocks.push(spyOn(Date, 'now').mockImplementation(() => realNow() + skew));
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    setTimeout(() => {
                        skew += 31_000;
                        petDies(world);
                        then(world);
                    }, after);
                });
            };

            test('short of time, its mob on us is fought as any other, and with it dead there is nothing to say', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, targetObjectId: PET_ID })] });
                diesUnderOrder(w, 10, world => { world.npc(701)!.targetObjectId = onUs; });
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: { resummon: false }, durationMs: 5000, minEngageMs: 60_000, loot: false });
                expect(r).toMatchObject({ kills: 1, stopReason: 'duration' });
                expect(r.message).not.toContain('our pet died');
                expect(r.lastPetLoss).toMatchObject({ objectId: PET_ID, name: 'amber simulacrum', cause: 'died', mob: null });
            });

            test('short of time, its mob holds the run even when it names nobody: no return ahead of the deadline with it alive', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, targetObjectId: PET_ID })] });
                diesUnderOrder(w, 10, world => { world.npc(701)!.targetObjectId = null; });
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: { resummon: false }, durationMs: 5000, minEngageMs: 60_000, loot: false });
                expect(r).toMatchObject({ kills: 1, stopReason: 'duration' });
                expect(w.npc(701)).toBeUndefined();
            });

            test('short of time, it is also worth a new pet', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300, targetObjectId: PET_ID })] });
                summoning(w);
                diesUnderOrder(w, 10, world => { world.npc(701)!.targetObjectId = null; });
                const r = await bot.grind({ pet: true, durationMs: 5000, minEngageMs: 60_000, loot: false });
                expect(r).toMatchObject({ kills: 1, stopReason: 'duration' });
                expect(w.sentOf('castSpell')).toHaveLength(1);
                expect(orderedOnto(w)).toEqual([701, 701]);
            });

            test('short of time, a mob beyond 2500 is no reason to stay', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, targetObjectId: PET_ID })] });
                diesUnderOrder(w, 10, world => { const m = world.npc(701)!; m.targetObjectId = null; m.x = 563000; });
                const t0 = Date.now();
                const r = await bot.grind({ pet: true, durationMs: 5000, minEngageMs: 60_000, loot: false });
                expect(r.stopReason).toBe('duration');
                expect(Date.now() - t0).toBeLessThan(1000);
                expect(r.message).not.toContain('coming for us');
                expect(r.lastPetLoss).toMatchObject({ cause: 'died', mob: null });
            });

            test('with the overrun up: the message says so, and lastPetLoss carries it', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, healthPercent: 17, targetObjectId: PET_ID })] });
                diesAsOverrunEnds(w, 300);
                const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0, loot: false });
                expect(r).toMatchObject({ kills: 0, failures: 1, stopReason: 'duration' });
                expect(r.message).toContain('; our pet died with young wolf at 17 %, and it is coming for us');
                expect(r.lastPetLoss).toMatchObject({ objectId: PET_ID, name: 'amber simulacrum', cause: 'died', mob: { objectId: 701, name: 'young wolf', healthPercent: 17 } });
            });

            test('in shade it adds what that cost us: the servant\'s death leaves us at 10 %', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true, health: 100, healthPercent: 100 }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, healthPercent: 17, targetObjectId: PET_ID })] });
                diesAsOverrunEnds(w, 300, world => {
                    world.player.isShade = false;
                    world.player.health = 10;
                    world.player.healthPercent = 10;
                });
                const r = await bot.grind({ durationMs: 200, minEngageMs: 0, loot: false });
                expect(r.message).toContain('; our pet died with young wolf at 17 %, and it is coming for us: we are at 10 % health');
            });

            describe('with the overrun up the health in that note comes after the death: the close ends the shade on a later tick, and its 0xAD a tick after that (EffectListComponent.cs:914-921, ClassDisciple.cs:147-150)', () => {
                const shadeWorld = () => petWorld({ player: makePlayer({ isShade: true, health: 100, healthPercent: 100 }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, healthPercent: 17, targetObjectId: PET_ID })] });
                const cutHealth = (world: FakeWorld) => {
                    world.player.health = 10;
                    world.player.healthPercent = 10;
                };

                test('the shade and the cut together, after the death', async () => {
                    const { w, bot } = shadeWorld();
                    diesAsOverrunEnds(w, 300, world => {
                        setTimeout(() => {
                            world.player.isShade = false;
                            cutHealth(world);
                        }, 67);
                    });
                    const r = await bot.grind({ durationMs: 200, minEngageMs: 0, loot: false });
                    expect(r.message).toContain(': we are at 10 % health');
                });

                test('the icon first, and the health later', async () => {
                    const { w, bot } = shadeWorld();
                    diesAsOverrunEnds(w, 300, world => {
                        setTimeout(() => { world.player.isShade = false; }, 33);
                        setTimeout(() => cutHealth(world), 300);
                    });
                    const r = await bot.grind({ durationMs: 200, minEngageMs: 0, loot: false });
                    expect(r.message).toContain(': we are at 10 % health');
                });

                test('the server\'s cut that never comes, as for a tether with the pet near full: it doesn\'t hold up the result', async () => {
                    const { w, bot } = shadeWorld();
                    diesAsOverrunEnds(w, 300, world => {
                        world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'released', at: Date.now() };
                        setTimeout(() => { world.player.isShade = false; }, 33);
                    });
                    const t0 = performance.now();
                    const r = await bot.grind({ durationMs: 200, minEngageMs: 0, loot: false });
                    expect(r.message).toContain(': we are at 100 % health');
                    expect(performance.now() - t0).toBeLessThan(2500);
                });

                test('a death in that wait is the run\'s death', async () => {
                    const { w, bot } = shadeWorld();
                    diesAsOverrunEnds(w, 300, world => {
                        setTimeout(() => {
                            world.player.isShade = false;
                            world.player.health = 0;
                            world.player.healthPercent = 0;
                            world.player.isDead = true;
                            world.player.deathCount += 1;
                        }, 67);
                    });
                    const r = await bot.grind({ durationMs: 200, minEngageMs: 0, loot: false });
                    expect(r).toMatchObject({ stopReason: 'died', deaths: 1 });
                });
            });

            test('a tether reads as a release: it is not called a death', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, healthPercent: 17, targetObjectId: PET_ID })] });
                diesAsOverrunEnds(w, 300, world => { world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'released', at: Date.now() }; });
                const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0, loot: false });
                expect(r.message).toContain('; we lost our pet with young wolf at 17 %, and it is coming for us');
                expect(r.lastPetLoss).toMatchObject({ cause: 'released' });
            });

            test('a stop on maxKills with its mob left says it too', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, healthPercent: 17, targetObjectId: PET_ID })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    petDies(world);
                    world.npc(701)!.targetObjectId = null;
                    world.state.nearbyNpcs = [...world.state.nearbyNpcs, mob({ objectId: 702, name: 'bear', x: 560050, targetObjectId: onUs })];
                });
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, stopReason: 'maxKills' });
                expect(r.killLog[0]!.name).toBe('bear');
                expect(r.message).toContain('; our pet died with young wolf at 17 %, and it is coming for us');
            });

            test('a new pet on the mob the last one died to: no mob is coming for us, though lastPetLoss still tells', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300 })] });
                summoning(w);
                const stances: Partial<Record<PetCommand, string>> = {
                    passive: 'You command the amber simulacrum to disengage from combat!',
                    defensive: 'You command the amber simulacrum to defend you!',
                    follow: 'You command the amber simulacrum to follow you!',
                };
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return void world.message(stances[a.command] ?? '');
                    world.message(KILL);
                    if (++attacks === 1) return void petDies(world);
                    world.state.pet = { ...world.state.pet!, targetObjectId: 701 };
                });
                let r: Awaited<ReturnType<BotActions['grind']>>;
                await fast(200, async () => {
                    r = await bot.grind({ pet: true, durationMs: 30_000, minEngageMs: 0, killTimeout: 40, loot: false });
                });
                expect(orderedOnto(w)).toEqual([701, 701]);
                expect(r!.message).toContain('called off');
                expect(r!.message).not.toContain('coming for us');
                expect(r!.lastPetLoss).toMatchObject({ cause: 'died', mob: { objectId: 701, healthPercent: 100 } });
            });

            test('a loss from before the run isn\'t this run\'s', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })], lastPetLoss: { objectId: 1, name: 'wolf cub', cause: 'died', at: 1 } });
                w.onTick = petFights(w);
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(r.lastPetLoss).toBeUndefined();
            });

            test('a run ended by our death says what the pet did first, with no talk of a mob coming, and lastPetLoss keeps the mob', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, healthPercent: 84, targetObjectId: PET_ID })] });
                diesUnderOrder(w, 10, world => {
                    world.npc(701)!.targetObjectId = onUs;
                    setTimeout(() => { world.player.isDead = true; world.player.deathCount = 1; world.player.health = 0; world.player.healthPercent = 0; }, 30);
                });
                const r = await bot.grind({ pet: { resummon: false }, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ stopReason: 'died' });
                expect(r.message).toContain('; our pet died first, with young wolf at 84 %');
                expect(r.message).not.toContain('coming for us');
                expect(r.lastPetLoss).toMatchObject({ cause: 'died', mob: { objectId: 701, name: 'young wolf', healthPercent: 84 } });
            });

            test('the same for a death past the deadline, in the last fight', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, healthPercent: 84, targetObjectId: PET_ID })] });
                diesUnderOrder(w, 10, world => {
                    world.npc(701)!.targetObjectId = onUs;
                    world.player.isDead = true;
                    world.player.deathCount = 1;
                });
                const r = await bot.grind({ pet: { resummon: false }, durationMs: 5, minEngageMs: 0, loot: false });
                expect(r).toMatchObject({ stopReason: 'died' });
                expect(r.message).toContain('; our pet died first, with young wolf at 84 %');
                expect(r.lastPetLoss).toMatchObject({ mob: { objectId: 701 } });
            });

            test('a pet that went with us didn\'t go first, and lastPetLoss still has the mob', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, healthPercent: 84, targetObjectId: PET_ID })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    setTimeout(() => {
                        world.removeNpc(PET_ID);
                        world.state.pet = null;
                        world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'owner_died', at: Date.now() };
                        world.player.isDead = true;
                        world.player.deathCount = 1;
                    }, 10);
                });
                const r = await bot.grind({ pet: { resummon: false }, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ stopReason: 'died' });
                expect(r.message).not.toContain('first');
                expect(r.lastPetLoss).toMatchObject({ cause: 'owner_died', mob: { objectId: 701 } });
            });

            test('with respawn on that death is behind us: nothing about it at the end', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, healthPercent: 84, targetObjectId: PET_ID })] });
                diesUnderOrder(w, 10, world => {
                    world.npc(701)!.targetObjectId = null;
                    world.player.isDead = true;
                    world.player.deathCount = 1;
                });
                w.handlers.release = (_a, world) => {
                    setTimeout(() => { world.message('You release your corpse unto death.'); world.player.isDead = false; world.player.health = 100; world.player.healthPercent = 100; world.player.x += 5000; }, 10);
                };
                const r = await bot.grind({ pet: { resummon: false }, respawn: true, durationMs: 5, minEngageMs: 0, loot: false });
                expect(r.message).not.toContain('first');
                expect(r.lastPetLoss).toMatchObject({ mob: null });
            });

            describe('whether it is coming', () => {
                /** The order goes out, and the pet goes before it has reached the mob. */
                const lostOnTheWay = (o: Partial<NearbyNpc> = {}) => {
                    const made = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561077, ...o })] });
                    orders(made.w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        petDies(world);
                        world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'released', at: Date.now() };
                    });
                    return made;
                };

                test('a mob that never engaged isn\'t: the pet was lost on its way, and lastPetLoss still has it', async () => {
                    const { bot } = lostOnTheWay();
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 50, minEngageMs: 0, killTimeout: 60, loot: false });
                    expect(r.message).toContain('; we lost our pet on its way to young wolf');
                    expect(r.message).not.toContain('coming for us');
                    expect(r.lastPetLoss).toMatchObject({ cause: 'released', mob: { objectId: 701, name: 'young wolf', healthPercent: 100 } });
                });

                test('in shade the cost goes with it', async () => {
                    const { w, bot } = lostOnTheWay();
                    w.player.isShade = true;
                    w.publish();
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 50, minEngageMs: 0, killTimeout: 60, loot: false });
                    expect(r.message).toContain('; we lost our pet on its way to young wolf: we are at 80 % health');
                });

                test('one on the pet at the loss is, whatever it reads by the end: its hold on us can have run out', async () => {
                    const { w, bot } = lostOnTheWay({ targetObjectId: PET_ID });
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 50, minEngageMs: 0, killTimeout: 60, loot: false });
                    expect(w.npc(701)!.targetObjectId).toBe(PET_ID);
                    expect(r.message).toContain('; we lost our pet with young wolf at 100 %, and it is coming for us');
                });

                test('one that read as on the pet at the loss is, though it reads nothing before or after: the model clears it in a group, and only targetedBy still says', async () => {
                    const { w, bot } = lostOnTheWay();
                    const lose = w.handlers.petCommand!;
                    w.handlers.petCommand = (a, world) => {
                        lose(a, world);
                        setTimeout(() => { world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'died', at: Date.now(), targetedBy: [701] }; }, 5);
                    };
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 50, minEngageMs: 0, killTimeout: 60, loot: false });
                    expect(w.npc(701)!.targetObjectId).toBeNull();
                    expect(r.message).toContain('; our pet died with young wolf at 100 %, and it is coming for us');
                    expect(r.message).not.toContain('on its way');
                });

                test('another mob in targetedBy says nothing of this one', async () => {
                    const { w, bot } = lostOnTheWay();
                    const lose = w.handlers.petCommand!;
                    w.handlers.petCommand = (a, world) => {
                        lose(a, world);
                        setTimeout(() => { world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'released', at: Date.now(), targetedBy: [702] }; }, 5);
                    };
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 50, minEngageMs: 0, killTimeout: 60, loot: false });
                    expect(r.message).toContain('; we lost our pet on its way to young wolf');
                });

                test('one handed over to us at the loss is, however it read before', async () => {
                    const { w, bot } = lostOnTheWay();
                    const lose = w.handlers.petCommand!;
                    w.handlers.petCommand = (a, world) => {
                        lose(a, world);
                        setTimeout(() => { world.npc(701)!.targetObjectId = onUs; }, 5);
                        setTimeout(() => { world.npc(701)!.targetObjectId = null; }, 60);
                    };
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 50, minEngageMs: 0, killTimeout: 60, loot: false });
                    expect(r.message).toContain('and it is coming for us');
                });
            });

            describe('a summon before melee', () => {
                const far = () => world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 561000, targetObjectId: onUs })], nearbyObjects: [] });

                test('a mob on us farther off than it covers by the half way of the cast leaves room for one, and the new pet takes it', async () => {
                    const { w, bot } = far();
                    summoning(w);
                    orders(w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        setTimeout(() => dies(world, a.targetObjectId!), 20);
                    });
                    const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ kills: 1, failures: 0 });
                    expect(w.sentOf('castSpell')).toHaveLength(1);
                    expect(w.sentOf('attack')).toEqual([]);
                    expect(orderedOnto(w)).toEqual([701]);
                });

                test('one try: a summon that fails goes to melee, with no rest for its power, and the timer decides the next', async () => {
                    const { w, bot } = far();
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); };
                    fightSim(w, { dmg: 50 });
                    const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ kills: 1 });
                    expect(w.sentOf('castSpell')).toHaveLength(1);
                    expect(w.sentOf('sit')).toEqual([]);
                    expect(w.sentOf('attack').map(a => a.on)).toContain(true);
                });

                test('after that melee, with no mob left, the timer brings the next try', async () => {
                    const { w, bot } = far();
                    let casts = 0;
                    w.handlers.castSpell = (_a, world) => {
                        if (++casts === 1) return void setTimeout(() => world.message('The young wolf attacks you and your spell is interrupted!', { type: 'spell' }), 5);
                        setTimeout(() => {
                            world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                            world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                            world.state.pet = petWindow();
                        }, 5);
                    };
                    fightSim(w, { dmg: 50 });
                    await bot.grind({ pet: true, durationMs: 3500, minEngageMs: 0, noTargetTimeoutMs: 0, loot: false });
                    expect(casts).toBe(2);
                    expect(w.sentOf('attack').map(a => a.on)).toContain(true);
                }, 8000);

                test('with resummon off a lost pet isn\'t replaced this way either', async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560400, targetObjectId: PET_ID })] });
                    summoning(w);
                    diesUnderOrder(w, 10, world => { world.npc(701)!.targetObjectId = onUs; });
                    fightSim(w, { dmg: 50 });
                    const r = await bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ kills: 1 });
                    expect(w.sentOf('castSpell')).toEqual([]);
                });
            });
        });

        describe('the deadline', () => {
            /** fightsLike, with the stance orders of a call-off answered. */
            const fightsAndStands = (w: FakeWorld, hit: (id: number, attacks: number) => number) => {
                fightsLike(w, hit);
                const fights = w.handlers.petCommand!;
                w.handlers.petCommand = (a, world) => {
                    fights(a, world);
                    if (a.type !== 'petCommand') return;
                    if (a.command === 'passive') setTimeout(() => { world.message('You command the amber simulacrum to disengage from combat!'); world.state.pet = { ...world.state.pet!, aggression: 'passive', targetObjectId: null }; }, 5);
                    if (a.command === 'defensive') setTimeout(() => { world.message('You command the amber simulacrum to defend you!'); world.state.pet = { ...world.state.pet!, aggression: 'defensive' }; }, 5);
                };
            };
            test('a pet fight standing at the deadline runs on, over several passes, and its kill counts', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560800 })] });
                fightsLike(w, () => 3);
                const t0 = Date.now();
                const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, killTimeout: 60, loot: false });
                expect(r).toMatchObject({ success: true, kills: 1, failures: 0, xpGained: 10, stopReason: 'duration' });
                expect(Date.now() - t0).toBeGreaterThan(200);
                // Nothing new past the deadline.
                expect(orderedOnto(w)).toEqual([701]);
            });

            test('an order that stands isn\'t repeated from one pass to the next', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                fightsLike(w, () => 3);
                await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 60, loot: false });
                expect(orderedOnto(w)).toEqual([701]);
            });

            test('killLog\'s duration covers the whole fight across passes', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                fightsLike(w, () => 3);
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 60, loot: false });
                expect(r.killLog[0]!.durationMs).toBeGreaterThan(200);
            });

            test('it also covers a fight broken by a lost pet', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                summoning(w);
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks === 1) setTimeout(() => petDies(world), 150);
                    else setTimeout(() => dies(world, a.targetObjectId!), 20);
                });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r.killLog[0]!.durationMs).toBeGreaterThan(150);
            });

            test('one still standing when the overrun is up is called off, and the message says so', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                fightsAndStands(w, () => 0.1);
                let r: Awaited<ReturnType<BotActions['grind']>>;
                await fast(1000, async () => {
                    r = await bot.grind({ pet: true, durationMs: 1000, minEngageMs: 0, killTimeout: 40, loot: false });
                });
                expect(r!).toMatchObject({ stopReason: 'duration', kills: 0 });
                expect(r!.message).toContain('called off');
                expect(r!.message).toContain('young wolf');
                // No order takes a mob off a pet: a defensive one answers its next swing (ControlledMobBrain.cs:189-204, StandardMobBrain.cs:545-574).
                expect(r!.message).toContain('hits back');
                expect(petCommands(w).slice(-3)).toEqual([['passive', undefined], ['defensive', undefined], ['follow', undefined]]);
                expect(orderedOnto(w)).toEqual([701]);
                expect(r!.durationMs).toBeGreaterThanOrEqual(31_000);
            });

            test('a plain grind in shade overruns and calls off the same way', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                fightsAndStands(w, () => 0.1);
                let r: Awaited<ReturnType<BotActions['grind']>>;
                await fast(1000, async () => {
                    r = await bot.grind({ durationMs: 1000, minEngageMs: 0, killTimeout: 40, loot: false });
                });
                expect(r!).toMatchObject({ stopReason: 'duration', kills: 0 });
                expect(r!.message).toContain('called off');
                expect(petCommands(w).slice(-3)).toEqual([['passive', undefined], ['defensive', undefined], ['follow', undefined]]);
                expect(orderedOnto(w)).toEqual([701]);
            });

            const stops: [string, { maxKills?: number; onKill?: () => boolean }, string][] = [['maxKills', { maxKills: 1 }, 'maxKills'], ['onKill', { onKill: () => false }, 'onKill']];
            for (const [how, stop, stopReason] of stops) {
                test(`a stop on ${how} with another mob on the pet calls it off too, and says so`, async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                    fightsAndStands(w, () => 0);
                    const fights = w.handlers.petCommand!;
                    w.handlers.petCommand = (a, world) => {
                        fights(a, world);
                        if (a.type !== 'petCommand' || a.command !== 'attack') return;
                        setTimeout(() => {
                            world.state.nearbyNpcs = [...world.state.nearbyNpcs, mob({ objectId: 702, x: 560300, targetObjectId: PET_ID })];
                            dies(world, a.targetObjectId!);
                            world.state.pet = petWindow();
                        }, 20);
                    };
                    const r = await bot.grind({ ...stop, pet: true, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ success: true, kills: 1, stopReason });
                    expect(r.message).toContain('called off');
                    expect(r.message).toContain('young wolf');
                    expect(petCommands(w).slice(-3)).toEqual([['passive', undefined], ['defensive', undefined], ['follow', undefined]]);
                });

                test(`a stop on ${how} with nothing on the pet leaves it alone`, async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560800 })] });
                    fightsLike(w, () => 25);
                    const r = await bot.grind({ ...stop, pet: true, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ kills: 1, stopReason });
                    expect(r.message).not.toContain('called off');
                    expect(petCommands(w).map(c => c[0])).toEqual(['attack']);
                });
            }

            test('one that ended in time calls nothing off', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                fightsLike(w, () => 25);
                const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0, loot: false });
                expect(r.message).not.toContain('called off');
                expect(petCommands(w).map(c => c[0])).toEqual(['attack']);
            });

            describe('the numbers of a call-off', () => {
                const standing = (pet: NearbyNpc | null) => petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [...(pet ? [pet] : []), mob({ objectId: 701, healthPercent: 37, targetObjectId: PET_ID })] });

                test('the message and calledOff have the pet\'s health and the mob\'s, as they stood', async () => {
                    const { w, bot } = standing(petNpc({ healthPercent: 17 }));
                    fightsAndStands(w, () => 0);
                    let r: Awaited<ReturnType<BotActions['grind']>>;
                    await fast(1000, async () => {
                        r = await bot.grind({ pet: { restBelowPetHealth: 0 }, durationMs: 1000, minEngageMs: 0, killTimeout: 40, loot: false });
                    });
                    expect(r!.message).toContain('called off at 17 % with young wolf at 37 %');
                    expect(r!.message).toContain('hits back');
                    expect(r!.calledOff).toEqual({ mob: { objectId: 701, name: 'young wolf', healthPercent: 37 }, petHealthPercent: 17 });
                });

                test('a pet out of view has no number to give', async () => {
                    const { w, bot } = standing(null);
                    fightsAndStands(w, () => 0);
                    let r: Awaited<ReturnType<BotActions['grind']>>;
                    await fast(1000, async () => {
                        r = await bot.grind({ pet: true, durationMs: 1000, minEngageMs: 0, killTimeout: 40, loot: false });
                    });
                    expect(r!.message).toContain('called off with young wolf at 37 %');
                    expect(r!.calledOff).toEqual({ mob: { objectId: 701, name: 'young wolf', healthPercent: 37 }, petHealthPercent: null });
                });

                test('no call-off, no field', async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                    fightsLike(w, () => 25);
                    const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0, loot: false });
                    expect(r.calledOff).toBeUndefined();
                });
            });

            describe('a mob all but dead when the overrun is up', () => {
                const run = async (health: number, hit: (t0: number) => number) => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, healthPercent: health, targetObjectId: PET_ID })] });
                    const t0 = Date.now();
                    fightsAndStands(w, () => hit(t0));
                    let r: Awaited<ReturnType<BotActions['grind']>>;
                    await fast(1000, async () => {
                        r = await bot.grind({ pet: true, durationMs: 1000, minEngageMs: 0, killTimeout: 40, loot: false });
                    });
                    return r!;
                };

                test('below 5 % the pet gets a bounded 10 s more, and the kill counts', async () => {
                    const r = await run(3, t0 => Date.now() > t0 + 33_000 ? 25 : 0.02);
                    expect(r).toMatchObject({ success: true, kills: 1, stopReason: 'duration' });
                    expect(r.message).not.toContain('called off');
                });

                test('that is all it gets', async () => {
                    const r = await run(3, () => 0.02);
                    expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                    expect(r.message).toContain('called off');
                    expect(r.durationMs).toBeGreaterThanOrEqual(41_000);
                    expect(r.durationMs).toBeLessThan(50_000);
                });

                test('from 5 % up it gets none', async () => {
                    const r = await run(6, () => 0.02);
                    expect(r.message).toContain('called off');
                    expect(r.durationMs).toBeLessThan(40_000);
                });

                test('a melee fight gets the same', async () => {
                    const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050, healthPercent: 3, targetObjectId: 100 })], nearbyObjects: [] });
                    const t0 = Date.now();
                    w.onTick = world => { if (Date.now() > t0 + 33_000 && world.npc(701)) dies(world, 701); };
                    let r: Awaited<ReturnType<BotActions['grind']>>;
                    await fast(1000, async () => {
                        r = await bot.grind({ durationMs: 1000, minEngageMs: 0, killTimeout: 40, loot: false });
                    });
                    expect(r!).toMatchObject({ kills: 1, stopReason: 'duration' });
                });
            });
        });

        describe("fight 'both' in shade", () => {
            test('reads as the pet fighting: no attack, one order, no pile of failures', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300 })] });
                w.onTick = petFights(w);
                const r = await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(w.sentOf('attack')).toEqual([]);
                expect(w.sentOf('petCommand').map(a => a.command)).toEqual(['attack']);
            });

            for (const [how, pet] of [["fight 'both'", { fight: 'both' as const }], ['no pet option at all', undefined]] as const) {
                test(`two on a shade, ${how}: the pet kills one and the other waits its turn, with no swapping`, async () => {
                    const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ targetObjectId: 100 }), mob({ objectId: 701, x: 560200, targetObjectId: 100 })] });
                    orders(w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        setTimeout(() => dies(world, a.targetObjectId!), 40);
                    });
                    expect(await bot.grind({ pet, maxKills: 1, durationMs: 3000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                    expect(w.sentOf('petCommand')).toHaveLength(1);
                    expect(w.sentOf('attack')).toEqual([]);
                });
            }

            test('out of shade it stays both', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100 })] });
                orders(w);
                fightSim(w, { dmg: 50 });
                expect(await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });
        });

        describe('a refused kill never spins', () => {
            test('melee refused on a mob that stays on us: about one pass a second', async () => {
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
                w.handlers.attack = (_a, world) => { world.message('You cannot enter combat while in shade form!'); };
                const r = await bot.grind({ durationMs: 1500, minEngageMs: 0, loot: false });
                expect(r.failures).toBeGreaterThanOrEqual(1);
                expect(r.failures).toBeLessThanOrEqual(3);
                expect(w.sentOf('attack').filter(a => a.on).length).toBeLessThanOrEqual(3);
            });

            test('an order refused on the pet\'s own mob, which comes straight back as its foe: the same', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, targetObjectId: PET_ID })] });
                const stances: Partial<Record<PetCommand, string>> = {
                    passive: 'You command the amber simulacrum to disengage from combat!',
                    defensive: 'You command the amber simulacrum to defend you!',
                    follow: 'You command the amber simulacrum to follow you!',
                };
                orders(w, (a, world) => world.message(stances[a.command] ?? "You can't attack that!"));
                const t0 = Date.now();
                const r = await bot.grind({ pet: true, durationMs: 1500, minEngageMs: 0, loot: false });
                expect(r.kills).toBe(0);
                const passes = orderedOnto(w).length;
                expect(passes).toBeGreaterThanOrEqual(1);
                expect(passes).toBeLessThanOrEqual(3);
                // A refusal is no fight in progress: it doesn't get the overrun, and what is on the pet is called off at the deadline.
                expect(Date.now() - t0).toBeLessThan(4500);
                expect(r.message).toContain('called off');
            });

            for (const [how, pet] of [['a plain grind', undefined], ['no resummon', { resummon: false }]] as const) {
                test(`in shade with the servant gone, ${how}: no_pet is a wait too, and timers and snapshots get through`, async () => {
                    const { w, bot } = world({ pet: null, player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560100, targetObjectId: 100 })], nearbyObjects: [] });
                    let ticks = 0;
                    const ticking = setInterval(() => { ticks++; }, 10);
                    const r = await bot.grind({ pet, durationMs: 1000, minEngageMs: 0, loot: false });
                    clearInterval(ticking);
                    expect(r.failures).toBe(0);
                    expect(ticks).toBeGreaterThan(20);
                    expect(w.sentOf('petCommand')).toEqual([]);
                });
            }

            test('the servant dies in a fight with the icon going 66 ms later (necromancer N4): that snapshot arrives, and melee comes next', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050 })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    petDies(world);
                    world.npc(701)!.targetObjectId = 100;
                    setTimeout(() => { world.player.isShade = false; }, 66);
                });
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, stopReason: 'maxKills' });
                expect(r.failures).toBeLessThanOrEqual(3);
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test('a plain grind in shade, whose killNpc hands over to petKill: the same', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, targetObjectId: 100 })] });
                orders(w, (a, world) => { if (a.command === 'attack') world.message("You can't attack that!"); });
                await bot.grind({ durationMs: 1500, minEngageMs: 0, loot: false });
                const passes = orderedOnto(w).length;
                expect(passes).toBeGreaterThanOrEqual(1);
                expect(passes).toBeLessThanOrEqual(3);
            });
        });

        describe('what grind can\'t work with', () => {
            const cases: [string, ReturnType<typeof spellOf>, string][] = [
                ['a charm', charm, 'charmPet'],
                ['a fire-and-forget pet', earth, 'summonPet'],
                ['a bomber', bomber, 'summonPet'],
                ['a minion', minion, 'summonPet'],
            ];
            for (const [what, spell, how] of cases) {
                test(`${what} in pet.spell: not_supported at once, unpaid, saying what to do`, async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(spell), nearbyNpcs: [mob({ targetObjectId: 100 })], player: makePlayer({ targetObjectId: 700 }) });
                    const r = await bot.grind({ pet: { spell: spell.name }, durationMs: 5000 });
                    expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported', kills: 0 });
                    expect(r.message).toContain(spell.name);
                    expect(r.message).toContain(how);
                    expect(w.sent).toEqual([]);
                });
            }

            test('a charm in pet.spell is refused with a pet up too: it could never summon again', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(charm) });
                expect(await bot.grind({ pet: { spell: charm.name }, durationMs: 5000 })).toMatchObject({ reason: 'not_supported' });
                expect(w.sent).toEqual([]);
            });

            test('pet: true with no main or turret spell names what is known', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(charm, bomber), nearbyNpcs: [mob({ targetObjectId: 100 })] });
                const r = await bot.grind({ pet: true, durationMs: 5000 });
                expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported' });
                expect(r.message).toContain(charm.name);
                expect(r.message).toContain(bomber.name);
                expect(w.sent).toEqual([]);
            });

            test('a known spell that is no summon: not_supported at once, unpaid, with its type, with or without a pet up', async () => {
                const none = world({ pet: null, skills: skillsWith(onPetSpell), nearbyNpcs: [mob({ targetObjectId: 100 })] });
                const t0 = Date.now();
                const r = await none.bot.grind({ pet: { spell: onPetSpell.name }, durationMs: 60_000 });
                expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported', kills: 0 });
                expect(r.message).toContain(onPetSpell.name);
                expect(r.message).toContain('DamageShield');
                expect(none.w.sent).toEqual([]);
                expect(Date.now() - t0).toBeLessThan(500);

                const up = petWorld({ skills: skillsWith(onPetSpell) });
                expect(await up.bot.grind({ pet: { spell: onPetSpell.name }, durationMs: 60_000 })).toMatchObject({ stopReason: 'error', reason: 'not_supported' });
                expect(up.w.sent).toEqual([]);
            });

            test('bad_args from the summon ends the run at once: it can\'t cure itself', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
                const summon = spyOn(bot, 'summonPet').mockImplementation(async () => ({ success: false, message: 'Amber Simulacrum is no summon spell (its type is Heal)', reason: 'bad_args' }) as any);
                const t0 = Date.now();
                const r = await bot.grind({ pet: true, durationMs: 60_000, minEngageMs: 0 });
                expect(r).toMatchObject({ stopReason: 'error', reason: 'bad_args' });
                expect(summon.mock.calls.length).toBe(1);
                expect(Date.now() - t0).toBeLessThan(500);
                expect(w.sent).toEqual([]);
            });

            test('a run that idled on the summon\'s recast says what it waited on', async () => {
                const { bot } = world({ pet: null, skills: skillsWith({ ...simulacrum, cooldownRemaining: 20 }), nearbyNpcs: [] });
                const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0 });
                expect(r).toMatchObject({ kills: 0, stopReason: 'duration', reason: 'no_kills' });
                expect(r.message).toEndWith('; waiting on Amber Simulacrum (20s)');
            });

            test('so does one the server held back: its line gives the wait', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must wait 12 seconds to recast this type of spell!', { type: 'important' }), 5); };
                const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0 });
                expect(r.message).toMatch(/; waiting on Amber Simulacrum \(1[12]s\)$/);
            });

            test('a recast that is over by the end, or a pet up by then, says nothing of it', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
                let casts = 0;
                w.handlers.castSpell = (_a, world) => {
                    if (++casts === 1) return void setTimeout(() => world.message('You must wait 1 seconds to recast this type of spell!', { type: 'important' }), 5);
                    setTimeout(() => {
                        world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                        world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                        world.state.pet = petWindow();
                    }, 5);
                };
                const r = await bot.grind({ pet: true, durationMs: 1600, minEngageMs: 0 });
                expect(casts).toBe(2);
                expect(r.message).not.toContain('waiting on');
            });

            test('a charmed pet already up is used as it is, until it is lost', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(charm), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560800 })] });
                w.onTick = petFights(w);
                const r = await bot.grind({
                    pet: true, durationMs: 5000, loot: false,
                    onKill: () => { petDies(w); w.publish(); },
                });
                expect(r).toMatchObject({ success: false, kills: 1, stopReason: 'error', reason: 'not_supported' });
                expect(r.message).toContain(charm.name);
                expect(w.sentOf('castSpell')).toEqual([]);
            });

            test('with resummon false a lost charmed pet leaves us in melee, as ever', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(charm), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100 }), mob({ objectId: 702, x: 560150 })] });
                const pets = petFights(w);
                fightSim(w, { dmg: 50 });
                const melee = w.onTick!;
                w.onTick = world => { pets(world); melee(world); };
                const r = await bot.grind({ pet: { resummon: false }, maxKills: 2, durationMs: 5000, loot: false, onKill: () => { petDies(w); w.publish(); } });
                expect(r).toMatchObject({ kills: 2, stopReason: 'maxKills' });
            });

            test('the errors keep their own reason in place of no_kills', async () => {
                const unknown = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob()] });
                expect(await unknown.bot.grind({ pet: { spell: 'No Such Spell' }, durationMs: 5000 })).toMatchObject({ stopReason: 'error', reason: 'spell_not_found' });

                const older = world({ skills: skillsWith(simulacrum), nearbyNpcs: [mob()] });
                expect(await older.bot.grind({ pet: true, durationMs: 5000 })).toMatchObject({ stopReason: 'error', reason: 'unknown_action' });

                const refused = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob()] });
                refused.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't do that here!", { type: 'important' }), 5); };
                const realNow = Date.now.bind(Date);
                let skew = 0;
                const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
                const skewing = setInterval(() => { skew += 1000; }, 10);
                try {
                    const r = await refused.bot.grind({ pet: true, durationMs: 3_600_000, minEngageMs: 0 });
                    expect(r).toMatchObject({ stopReason: 'error', reason: 'refused' });
                } finally {
                    clearInterval(skewing);
                    clock.mockRestore();
                }
            });

            test.each([['a name', 'No Such Spell'], ['a pattern', /Nonexistent/]])('a spell that can\'t be found, by %s: refused up front, with or without a pet up', async (_how, spell) => {
                const up = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                const r = await up.bot.grind({ pet: { spell: spell as string | RegExp }, durationMs: 5000 });
                expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'spell_not_found', kills: 0 });
                expect(r.message).toContain('Spell not found');
                expect(up.w.sent).toEqual([]);

                const none = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob()] });
                expect(await none.bot.grind({ pet: { spell: spell as string | RegExp }, durationMs: 5000 })).toMatchObject({ stopReason: 'error', reason: 'spell_not_found' });
                expect(none.w.sent).toEqual([]);
            });

            describe('a summon that keeps failing', () => {
                test('a run that ends before it can stop on that says what the last try got', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't do that here!", { type: 'important' }), 5); };
                    const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0 });
                    expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                    expect(r.message).toContain("; could not summon: You can't do that here!");
                });

                test('a pet up by the end, or a try since that went, says nothing of it', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
                    let casts = 0;
                    w.handlers.castSpell = (_a, world) => {
                        if (++casts === 1) return void setTimeout(() => world.message("You can't do that here!", { type: 'important' }), 5);
                        setTimeout(() => {
                            world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                            world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                            world.state.pet = petWindow();
                        }, 5);
                    };
                    const r = await bot.grind({ pet: true, durationMs: 3500, minEngageMs: 0, noTargetTimeoutMs: 0 });
                    expect(casts).toBe(2);
                    expect(r.message).not.toContain('could not summon');
                }, 8000);

                test('a recast gets its own note, not this one', async () => {
                    const { bot } = world({ pet: null, skills: skillsWith({ ...simulacrum, cooldownRemaining: 20 }), nearbyNpcs: [] });
                    const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0 });
                    expect(r.message).not.toContain('could not summon');
                    expect(r.message).toEndWith('; waiting on Amber Simulacrum (20s)');
                });

                const noSpot = (o: Partial<BotWorldState> = {}) => {
                    const made = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [], ...o });
                    made.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You have to set a ground target for this Spell.', { type: 'spell' }), 5); };
                    return made;
                };

                test('a turret with no spot set ends at once: trying again can\'t cure that', async () => {
                    const { w, bot } = noSpot();
                    const t0 = Date.now();
                    const r = await bot.grind({ pet: true, durationMs: 60_000, minEngageMs: 0 });
                    expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'no_ground_target', kills: 0 });
                    expect(r.message).toContain('Could not summon a pet: You have to set a ground target');
                    expect(w.sentOf('castSpell')).toHaveLength(1);
                    expect(Date.now() - t0).toBeLessThan(1000);
                });

                test('the same with a mob on us', async () => {
                    const { w, bot } = noSpot({ nearbyNpcs: [mob({ objectId: 701, x: 560600, targetObjectId: 100 })] });
                    expect(await bot.grind({ pet: true, durationMs: 60_000, minEngageMs: 0 })).toMatchObject({ stopReason: 'error', reason: 'no_ground_target' });
                    expect(w.sentOf('attack')).toEqual([]);
                });

                test('with a spot set that line isn\'t final: the model\'s spot may just be out of date', async () => {
                    const { bot } = noSpot({ groundTarget: { x: 560100, y: 511000, z: 2500 } });
                    const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0 });
                    expect(r).toMatchObject({ stopReason: 'duration' });
                    expect(r.message).toContain('; could not summon: You have to set a ground target');
                });

                test('out of range needs the walk first: not that one', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You have to select a closer ground target.', { type: 'spell' }), 5); };
                    const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0 });
                    expect(r).toMatchObject({ stopReason: 'duration' });
                    expect(r.message).toContain('; could not summon: You have to select a closer ground target.');
                });
            });

            test('a run that simply found nothing to kill still says no_kills', async () => {
                const { bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc()] });
                const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0 });
                expect(r).toMatchObject({ stopReason: 'duration', reason: 'no_kills' });
            });
        });

        describe('a charmed pet lost with nothing to summon it back with', () => {
            test.each([['on its way', 560588, 'it is coming for us'], ['beside us', 560100, 'it is on us at 84 %']])('its mob on us, %s: the run ends at once, and we don\'t walk into melee', async (_how, x, note) => {
                const { w, bot } = petWorld({ skills: skillsWith(charm), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: x as number, healthPercent: 84, targetObjectId: PET_ID })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    petDies(world);
                    world.npc(701)!.targetObjectId = 100;
                });
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: true, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported', kills: 0 });
                expect(r.message).toContain('Could not summon a pet');
                expect(r.message).toContain(`; our pet died with young wolf at 84 %, and ${note as string}`);
                expect(r.lastPetLoss).toMatchObject({ cause: 'died', mob: { objectId: 701, name: 'young wolf', healthPercent: 84 } });
                expect(w.sentOf('attack')).toEqual([]);
            });
        });

        describe("fight 'both' with nothing to swing", () => {
            const item = (slot: number, name: string, objectType: number): InventoryItem => ({ slot, name, level: 1, count: 1, model: 3, objectType, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 });
            const sword = item(10, 'training sword', 3);
            const shield = item(11, 'small shield', 42);
            const bow = item(13, 'rowan bow', 9);

            test.each([['no weapon', []], ['a shield alone', [shield]], ['a bow and no melee weapon', [bow]], ['a bow and a shield', [shield, bow]]])('%s reads as \'pet\': one order, the kill counts, and no pile of failures', async (_what, equipment) => {
                const { w, bot } = petWorld({ equipment: equipment as InventoryItem[], skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100 }), mob({ objectId: 702, x: 560300 })] });
                fightsLike(w, () => 25);
                const r = await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ success: true, kills: 1, failures: 0 });
                expect(w.sentOf('attack')).toEqual([]);
                expect(orderedOnto(w)).toEqual([701]);
            });

            test('a bow with a melee weapon beside it stays both', async () => {
                const { w, bot } = petWorld({ equipment: [sword, bow], skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100 })] });
                orders(w);
                fightSim(w, { dmg: 50 });
                expect(await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test('a plain grind with no pet option is left as it was', async () => {
                const { w, bot } = petWorld({ equipment: [], skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100 })] });
                const kills = spyOn(bot, 'petKill');
                await bot.grind({ durationMs: 100, minEngageMs: 0, loot: false });
                expect(kills).not.toHaveBeenCalled();
                expect(w.sentOf('attack')).toEqual([]);
            });

            test('with no pet up and a mob beside us, the summon goes: there is no melee for it to wait behind', async () => {
                const { w, bot } = world({ equipment: [], pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560100, targetObjectId: 100 })], nearbyObjects: [] });
                summoning(w);
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    setTimeout(() => dies(world, a.targetObjectId!), 20);
                });
                expect(await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });
        });

        const timedOut = (durationMs = 100) => ({ success: false, message: 'Timed out', reason: 'timeout', killed: false, npc: null, xpGained: 0, rpGained: 0, moneyGained: 0, itemsGained: [], durationMs, levelsGained: 0, stylesUsed: 0 }) as any;

        describe("fight 'pet' with a mob on us", () => {
            const answered = (w: FakeWorld) => orders(w, (a, world) => { if (a.command === 'attack') world.message(KILL); });

            test('within 250 we swing as well: killNpc, which orders the pet', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, targetObjectId: 100 })] });
                answered(w);
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
                expect(orderedOnto(w)).toEqual([701]);
            });

            describe('a passive pet', () => {
                const passive = () => {
                    const made = petWorld({ pet: petWindow({ aggression: 'passive' }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, targetObjectId: 100 })] });
                    orders(made.w, (a, world) => {
                        if (a.command === 'attack') world.message(KILL);
                        else if (a.command === 'defensive') {
                            world.message('You command the amber simulacrum to defend you!');
                            world.state.pet = { ...world.state.pet!, aggression: 'defensive' };
                        }
                    });
                    fightSim(made.w, { dmg: 25 });
                    return made;
                };

                test('is lifted first: it is the pet\'s fight on this plan, as a petKill\'s order would have made it, and killNpc leaves one out', async () => {
                    const { w, bot } = passive();
                    expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                    expect(w.sentOf('petCommand').map(a => a.command)[0]).toBe('defensive');
                    expect(orderedOnto(w)).toEqual([701]);
                });

                test("stays as it is on 'both': that plan is killNpc's, and killNpc doesn't touch the stance", async () => {
                    const { w, bot } = passive();
                    expect(await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                    expect(w.sentOf('petCommand')).toEqual([]);
                });
            });

            test.each([['in shade', { player: makePlayer({ isShade: true }) }], ['with no weapon', { equipment: [] }]])('%s it stays a stand-off', async (_what, o) => {
                const { w, bot } = petWorld({ ...o, skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, targetObjectId: 100 })] });
                fightsLike(w, () => 25);
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                expect(w.sentOf('attack')).toEqual([]);
            });

            test('beyond 250 the pet has it, for as long as its run-in takes: no failure, no call-off, and the next pass looks again', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300, targetObjectId: 100 })] });
                answered(w);
                fightSim(w, { dmg: 50 });
                const kills = spyOn(bot, 'petKill').mockImplementationOnce(async () => {
                    w.npc(701)!.x = 560050;
                    w.publish();
                    return timedOut(3000);
                });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(kills.mock.calls[0]![1]).toMatchObject({ timeout: 4000, ignoreAttackers: true, endWithin: 250 });
                expect(kills).toHaveBeenCalledTimes(1);
                expect(w.sentOf('petCommand').map(a => a.command)).not.toContain('follow');
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test('such a pass never lasts longer than killTimeout', async () => {
                const { bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300, targetObjectId: 100 })] });
                const kills = spyOn(bot, 'petKill').mockImplementation(async () => timedOut());
                await bot.grind({ pet: true, durationMs: 50, minEngageMs: 0, killTimeout: 40, loot: false });
                expect(kills.mock.calls[0]![1]!.timeout).toBeLessThanOrEqual(40);
            });

            test('while none has arrived the pet stays on the one it has, with a nearer one left to wait', async () => {
                const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 701 }), skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560600, targetObjectId: 100 }), mob({ objectId: 702, x: 560300, targetObjectId: 100 })] });
                setTimeout(() => dies(w, 701), 30);
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                expect(w.npc(701)).toBeUndefined();
                expect(w.npc(702)).toBeDefined();
                expect(orderedOnto(w)).toEqual([]);
            });
        });

        describe('the overrun holds what is unfinished', () => {
            test('a pet\'s death in it: its mob keeps the run in the fight, with a new pet, and the kill counts', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561000, healthPercent: 6, targetObjectId: PET_ID })] });
                summoning(w);
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks > 1) return void setTimeout(() => dies(world, a.targetObjectId!), 20);
                    setTimeout(() => {
                        petDies(world);
                        world.npc(701)!.targetObjectId = 100;
                    }, 150);
                });
                const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false });
                expect(r).toMatchObject({ success: true, kills: 1, stopReason: 'duration' });
                expect(orderedOnto(w)).toEqual([701, 701]);
                expect(r.message).not.toContain('coming for us');
            });

            test('a melee fight with a short killTimeout goes on past the deadline too, and its kill counts', async () => {
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
                fightSim(w, { dmg: 3 });
                const r = await bot.grind({ durationMs: 100, minEngageMs: 0, killTimeout: 40, loot: false });
                expect(r).toMatchObject({ success: true, kills: 1, failures: 0, stopReason: 'duration' });
            });

            describe('a mob the pet never reached is no fight: nothing came of the order (StandardMobBrain.cs:548-575)', () => {
                /** The order goes out, and the pet goes before the mob has done anything; `then` is what the mob reads from there on. */
                const lostOnItsWay = (then: Partial<NearbyNpc> = {}, skills = skillsWith(simulacrum)) => {
                    const made = petWorld({ skills, nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561077 })] });
                    orders(made.w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        setTimeout(() => {
                            petDies(world);
                            world.state.lastPetLoss = { ...world.state.lastPetLoss!, cause: 'released' };
                            Object.assign(world.npc(701)!, then);
                        }, 150);
                    });
                    return made;
                };

                test('short of time it gets no summon and holds nothing: the run ends, and says so', async () => {
                    const { w, bot } = lostOnItsWay();
                    summoning(w);
                    const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false });
                    expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                    expect(r.durationMs).toBeLessThan(1500);
                    expect(w.sentOf('castSpell')).toEqual([]);
                    expect(orderedOnto(w)).toEqual([701]);
                    expect(r.message).toContain('; we lost our pet on its way to young wolf');
                });

                test('with resummon off we don\'t go after it on foot', async () => {
                    const { w, bot } = lostOnItsWay();
                    fightSim(w, { dmg: 50 });
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 100, minEngageMs: 0, loot: false });
                    expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                    expect(r.durationMs).toBeLessThan(1500);
                    expect(w.sentOf('attack')).toEqual([]);
                    expect(w.sentOf('moveTo')).toEqual([]);
                });

                test('with time left it is still the next target: it is only short of time that it doesn\'t count', async () => {
                    const { w, bot } = lostOnItsWay();
                    summoning(w);
                    let order = 0;
                    const lose = w.handlers.petCommand!;
                    w.handlers.petCommand = (a, world) => {
                        if (a.type === 'petCommand' && a.command === 'attack' && ++order > 1) {
                            world.message(KILL);
                            setTimeout(() => dies(world, 701), 20);
                            return;
                        }
                        lose(a, world);
                    };
                    const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, minEngageMs: 0, loot: false });
                    expect(r).toMatchObject({ kills: 1, failures: 1 });
                    expect(orderedOnto(w)).toEqual([701, 701]);
                });

                test.each([
                    ['hurt', { healthPercent: 80 }],
                    ['on us', { targetObjectId: 100 }],
                ])('one %s by then does hold the run', async (_what, then) => {
                    const { w, bot } = lostOnItsWay(then);
                    fightSim(w, { dmg: 0 });
                    const melee = spyOn(bot, 'killNpc').mockImplementation(async () => {
                        dies(w, 701);
                        w.publish();
                        return { ...timedOut(5), success: true, reason: undefined, killed: true };
                    });
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 100, minEngageMs: 0, loot: false });
                    expect(melee).toHaveBeenCalledTimes(1);
                    expect(r).toMatchObject({ kills: 1, stopReason: 'duration' });
                });

                test('and so does one that had the pet as its target at the loss, at full health', async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300, targetObjectId: PET_ID })] });
                    summoning(w);
                    let attacks = 0;
                    orders(w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        if (++attacks > 1) return void setTimeout(() => dies(world, 701), 20);
                        setTimeout(() => {
                            petDies(world);
                            world.npc(701)!.targetObjectId = null;
                        }, 150);
                    });
                    const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false });
                    expect(r).toMatchObject({ success: true, kills: 1, stopReason: 'duration' });
                    expect(orderedOnto(w)).toEqual([701, 701]);
                });

                describe('with a recast between us and a new pet', () => {
                    const hunters = spellOf("Hunter's Pet", 3587);
                    const onRecast = (world: FakeWorld, seconds: number) => { world.state.skills = skillsWith({ ...hunters, cooldownRemaining: seconds }); };

                    test('it isn\'t waited for: the run ends at its time, with the wait in the message', async () => {
                        const { w, bot } = lostOnItsWay({}, skillsWith(hunters));
                        setTimeout(() => onRecast(w, 100), 100);
                        const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false });
                        expect(r).toMatchObject({ kills: 0, failures: 1, stopReason: 'duration' });
                        expect(r.durationMs).toBeLessThan(2000);
                        expect(r.message).toContain('; we lost our pet on its way to young wolf');
                        expect(r.message).toContain("; waiting on Hunter's Pet");
                    });

                    test('nor is a hurt one nothing has aimed at us, when the recast outlasts the overrun', async () => {
                        const { w, bot } = lostOnItsWay({ healthPercent: 80, targetObjectId: 999 }, skillsWith(hunters));
                        setTimeout(() => onRecast(w, 100), 100);
                        const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false });
                        expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                        expect(r.durationMs).toBeLessThan(2000);
                    });

                    test('one that fits in the overrun is: a new pet is worth that', async () => {
                        const { w, bot } = lostOnItsWay({ healthPercent: 80 }, skillsWith(hunters));
                        summons(w, hunters.name, "hunter's pet", { id: 650 });
                        const lose = w.handlers.petCommand!;
                        w.handlers.petCommand = (a, world) => {
                            if (a.type === 'petCommand' && a.command === 'attack' && world.state.pet?.objectId === 650) {
                                world.message(KILL);
                                setTimeout(() => dies(world, 701), 20);
                                return;
                            }
                            lose(a, world);
                        };
                        setTimeout(() => onRecast(w, 1), 100);
                        setTimeout(() => { w.state.skills = skillsWith(hunters); }, 900);
                        const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false });
                        expect(r).toMatchObject({ success: true, kills: 1, stopReason: 'duration' });
                    });

                    test('and one that had the pet as its target stays too: it is coming, and that fight is ours when it reads so', async () => {
                        const { w, bot } = petWorld({ skills: skillsWith(hunters), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300, healthPercent: 80, targetObjectId: PET_ID })] });
                        orders(w, (a, world) => {
                            if (a.command !== 'attack') return;
                            world.message(KILL);
                            setTimeout(() => {
                                petDies(world);
                                onRecast(world, 100);
                                world.npc(701)!.targetObjectId = null;
                            }, 100);
                        });
                        setTimeout(() => { w.npc(701)!.targetObjectId = 100; w.npc(701)!.x = 560050; }, 700);
                        const melee = spyOn(bot, 'killNpc').mockImplementation(async () => {
                            dies(w, 701);
                            w.publish();
                            return { ...timedOut(5), success: true, reason: undefined, killed: true };
                        });
                        const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false });
                        expect(melee).toHaveBeenCalledTimes(1);
                        expect(r).toMatchObject({ success: true, kills: 1, stopReason: 'duration' });
                    });
                });
            });

            describe('a summon that fails near or past the deadline is the end of a run that used up its time, not an error', () => {
                const noPower = (world: FakeWorld) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); };
                /** A kill made (it takes about 450 ms, with the settling), then the pet lost on a mob that it has hurt and that doesn't read as on us, at 10 of 200 mana. */
                const killThenLoss = (lossAfter = 20) => {
                    const made = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 700, x: 560100 }), mob({ objectId: 701, x: 560300 })], player: makePlayer({ health: 100, healthPercent: 100, mana: 10, maxMana: 200, manaPercent: 5 }) });
                    made.w.handlers.castSpell = (_a, world) => noPower(world);
                    let attacks = 0;
                    orders(made.w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        if (++attacks === 1) return void setTimeout(() => dies(world, a.targetObjectId!), 20);
                        setTimeout(() => {
                            petDies(world);
                            world.state.lastPetLoss = { ...world.state.lastPetLoss!, cause: 'released' };
                            world.npc(701)!.healthPercent = 80;
                        }, lossAfter);
                    });
                    return made;
                };
                const resting = { success: false, reason: 'timeout', message: 'Rest timed out', healthPercent: 100, manaPercent: 5, endurancePercent: 100, durationMs: 100 };

                test('past it: the run ends there as a duration, with no more rest, and its note says why', async () => {
                    const { w, bot } = killThenLoss();
                    const rests = spyOn(bot, 'rest').mockImplementation(async () => {
                        await Bun.sleep(400);
                        return resting;
                    });
                    const r = await bot.grind({ pet: true, durationMs: 800, minEngageMs: 0, loot: false });
                    expect(r).toMatchObject({ success: true, kills: 1, stopReason: 'duration' });
                    expect(r.reason).toBeUndefined();
                    expect(r.message).toContain('; no pet: short of power for Amber Simulacrum');
                    expect(w.sentOf('castSpell')).toHaveLength(2);
                    expect(rests).toHaveBeenCalledTimes(1);
                    expect(r.durationMs).toBeLessThan(2000);
                });

                test('short of time, with the attempts used up: the same', async () => {
                    const { bot } = killThenLoss(300);
                    spyOn(bot, 'rest').mockImplementation(async () => {
                        await Bun.sleep(5);
                        return resting;
                    });
                    const r = await bot.grind({ pet: true, durationMs: 2000, minEngageMs: 1300, loot: false });
                    expect(r).toMatchObject({ success: true, kills: 1, stopReason: 'duration' });
                    expect(r.message).toContain('; no pet: short of power');
                });

                test('with time left, three in a row is still the error it was: GrindOptions.pet says so', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [], player: makePlayer({ health: 100, healthPercent: 100, mana: 10, maxMana: 200, manaPercent: 5 }) });
                    w.handlers.castSpell = (_a, world) => noPower(world);
                    spyOn(bot, 'rest').mockImplementation(async () => resting);
                    expect(await bot.grind({ pet: true, durationMs: 5000, minEngageMs: 0 })).toMatchObject({ success: false, stopReason: 'error', reason: 'no_power' });
                });

                test('one that doesn\'t cure itself stays an error in the overrun too', async () => {
                    const { w, bot } = killThenLoss();
                    spyOn(bot, 'rest').mockImplementation(async () => {
                        await Bun.sleep(400);
                        w.state.skills = skillsWith();
                        w.publish();
                        return resting;
                    });
                    const r = await bot.grind({ pet: true, durationMs: 800, minEngageMs: 0, loot: false });
                    expect(r).toMatchObject({ stopReason: 'error', reason: 'not_supported' });
                });
            });

            test('its mob still standing when that time is up: only then the note, and the run is over', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, healthPercent: 17, targetObjectId: PET_ID })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    petDies(world);
                    world.npc(701)!.targetObjectId = 100;
                });
                let r: Awaited<ReturnType<BotActions['grind']>>;
                await fast(1000, async () => {
                    r = await bot.grind({ pet: { resummon: false }, durationMs: 1000, minEngageMs: 0, killTimeout: 40, loot: false });
                });
                expect(r!).toMatchObject({ kills: 0, stopReason: 'duration' });
                expect(r!.durationMs).toBeGreaterThanOrEqual(31_000);
                expect(r!.durationMs).toBeLessThan(45_000);
                expect(r!.message).toContain('; our pet died with young wolf at 17 %, and it is on us at 17 %');
            });
        });

        describe('a pet lost during a melee pass of ours', () => {
            const hunters = spellOf("Hunter's Pet", 3587);
            /** The mob beside us and on us, the pass ours (killNpc), and the pet gone a moment into it. */
            const losesItInMelee = (skills: ReturnType<typeof skillsWith>, dmg = 0) => {
                const made = petWorld({ skills, nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, healthPercent: 84, targetObjectId: 100 })] });
                orders(made.w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (a.targetObjectId === 701 && world.state.pet?.objectId === 650) setTimeout(() => dies(world, 701), 20);
                });
                fightSim(made.w, { dmg });
                setTimeout(() => petDies(made.w), 150);
                return made;
            };

            test.each([["'pet', our swing beside it", true], ["'both'", { fight: 'both' as const }]])('fight %s: a charmer\'s run ends at once, not at the end of the pass', async (_what, pet) => {
                const { w, bot } = losesItInMelee(skillsWith(charm));
                const t0 = Date.now();
                const r = await bot.grind({ pet, durationMs: 8000, killTimeout: 3000, loot: false });
                expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'not_supported', kills: 0 });
                expect(r.message).toContain('Could not summon a pet');
                expect(r.message).toContain('; our pet died with young wolf at 84 %, and it is on us at 84 %');
                expect(Date.now() - t0).toBeLessThan(1500);
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test.each([["'pet', our swing beside it", true], ["'both'", { fight: 'both' as const }]])('fight %s: an instant summon goes as soon as it can, and the new pet joins the fight', async (_what, pet) => {
                const { w, bot } = losesItInMelee(skillsWith(hunters));
                summons(w, hunters.name, "hunter's pet", { id: 650 });
                const melee = spyOn(bot, 'killNpc');
                const t0 = Date.now();
                let castAt = 0;
                const cast = w.handlers.castSpell!;
                w.handlers.castSpell = (a, world) => { castAt ||= Date.now(); return cast(a, world); };
                const r = await bot.grind({ pet, maxKills: 1, durationMs: 8000, killTimeout: 3000, loot: false });
                expect(r).toMatchObject({ kills: 1, stopReason: 'maxKills' });
                expect(castAt - t0).toBeLessThan(1500);
                expect(w.sentOf('castSpell')).toHaveLength(1);
                expect(melee.mock.calls[0]![1]!.endOnPetLoss).toBe(true);
            });

            test('the fight stays one fight: its time in killLog runs from the first pass', async () => {
                const { w, bot } = losesItInMelee(skillsWith(hunters));
                summons(w, hunters.name, "hunter's pet", { id: 650 });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 8000, killTimeout: 3000, loot: false });
                expect(r.killLog[0]!.durationMs).toBeGreaterThan(140);
            });

            test('with resummon off there is nothing to do about it: the pass goes on, and its kill is no failure', async () => {
                const { bot } = losesItInMelee(skillsWith(simulacrum), 5);
                const melee = spyOn(bot, 'killNpc');
                const r = await bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 8000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(melee).toHaveBeenCalledTimes(1);
                expect(melee.mock.calls[0]![1]!.endOnPetLoss).toBeFalsy();
            });

            test('killNpc itself: endOnPetLoss ends the fight with pet_died, the swing off, and by default it fights on', async () => {
                const asked = losesItInMelee(skillsWith(simulacrum));
                const r = await asked.bot.killNpc(701, { endOnPetLoss: true, force: true, timeout: 3000 });
                expect(r).toMatchObject({ success: false, killed: false, reason: 'pet_died', npc: { objectId: 701 } });
                expect(r.message).toBe('Our pet is gone (died) with young wolf at 84% health');
                expect(asked.w.sentOf('attack').map(a => a.on)).toEqual([true, false]);

                const plain = losesItInMelee(skillsWith(simulacrum));
                expect(await plain.bot.killNpc(701, { force: true, timeout: 400 })).toMatchObject({ success: false, reason: 'timeout' });
            });

            test('with no pet up at its start it has nothing to watch', async () => {
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050 })], nearbyObjects: [] });
                fightSim(w, { dmg: 50 });
                expect(await bot.killNpc(701, { endOnPetLoss: true, force: true })).toMatchObject({ success: true, killed: true });
            });
        });

        describe('a summon in melee', () => {
            const hunters = spellOf("Hunter's Pet", 3587);
            const petKills = (w: FakeWorld) => orders(w, (a, world) => {
                if (a.command !== 'attack') return;
                world.message(KILL);
                setTimeout(() => dies(world, a.targetObjectId!), 20);
            });
            const summonsHis = (w: FakeWorld) => summons(w, hunters.name, "hunter's pet");

            test('one with no cast time needs no room: it goes with the mob beside us', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(hunters), nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
                summonsHis(w);
                petKills(w);
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                expect(w.sentOf('castSpell')).toHaveLength(1);
                expect(orderedOnto(w)).toEqual([701]);
            });

            test('with the recast running a pass ends in time for the next try, and the fight goes on with the new pet', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith({ ...hunters, cooldownRemaining: 1 }), nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
                summonsHis(w);
                petKills(w);
                fightSim(w, { dmg: 0 });
                setTimeout(() => { w.state.skills = skillsWith(hunters); }, 500);
                const melee = spyOn(bot, 'killNpc');
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 8000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(w.sentOf('castSpell')).toHaveLength(1);
                expect(melee.mock.calls[0]![1]!.timeout).toBeGreaterThan(2900);
                expect(melee.mock.calls[0]![1]!.timeout).toBeLessThanOrEqual(3000);
                expect(r.killLog[0]!.durationMs).toBeGreaterThan(2900);
            }, 10_000);

            test('the bound is the time to that try, when that is more than the floor', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 561000, targetObjectId: 100 })], nearbyObjects: [] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must wait 12 seconds to recast this type of spell!', { type: 'important' }), 5); };
                fightSim(w, { dmg: 50 });
                const melee = spyOn(bot, 'killNpc');
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 30_000, loot: false })).toMatchObject({ kills: 1 });
                // Less the moment a mob on us with no speed gets to come.
                expect(melee.mock.calls[0]![1]!.timeout).toBeGreaterThan(10_000);
                expect(melee.mock.calls[0]![1]!.timeout).toBeLessThanOrEqual(12_000);
            });

            test('a long recast sets that time too: no pass cut up every few seconds while it runs', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith({ ...hunters, cooldownRemaining: 20 }), nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
                fightSim(w, { dmg: 50 });
                const melee = spyOn(bot, 'killNpc');
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 30_000, loot: false })).toMatchObject({ kills: 1 });
                expect(melee.mock.calls[0]![1]!.timeout).toBeGreaterThan(19_000);
                expect(melee.mock.calls[0]![1]!.timeout).toBeLessThanOrEqual(20_000);
            });

            test('a pass cut short that hasn\'t reached the mob is no failure: no wait, and it isn\'t avoided', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560100, targetObjectId: 100 })], nearbyObjects: [] });
                let casts = 0;
                w.handlers.castSpell = (_a, world) => {
                    if (++casts === 1) return void setTimeout(() => world.message('The goblin attacks you and your spell is interrupted!', { type: 'spell' }), 5);
                    setTimeout(() => {
                        world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                        world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                        world.state.pet = petWindow();
                    }, 5);
                };
                const melee = spyOn(bot, 'killNpc').mockImplementationOnce(async () => {
                    w.npc(701)!.targetObjectId = null;
                    w.publish();
                    return timedOut(3000);
                }).mockImplementationOnce(async () => {
                    dies(w, 701);
                    w.publish();
                    return { ...timedOut(1000), success: true, reason: undefined, killed: true };
                });
                const r = await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, killTimeout: 30_000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(melee).toHaveBeenCalledTimes(2);
            });

            test('with resummon off a melee pass has no such bound', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, targetObjectId: PET_ID })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    petDies(world);
                    world.npc(701)!.targetObjectId = 100;
                });
                fightSim(w, { dmg: 50 });
                const melee = spyOn(bot, 'killNpc');
                await bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 5000, killTimeout: 30_000, loot: false });
                expect(melee.mock.calls.at(-1)![1]!.timeout).toBe(30_000);
            });
        });

        describe('short of power for the summon', () => {
            const tired = (mana: number, maxMana: number) => world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [], player: makePlayer({ health: 100, healthPercent: 100, mana, maxMana, manaPercent: Math.round(mana / maxMana * 100) }) });
            const noPower = (w: FakeWorld) => { w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); }; };
            const resting = { success: false, reason: 'timeout', message: 'Rest timed out', healthPercent: 100, manaPercent: 5, endurancePercent: 100, durationMs: 100 };

            test.each([['what it can cost and 5 points', 200, 28], ['at most 60 %', 10, 60]])('we rest to %s', async (_what, maxMana, percent) => {
                const { w, bot } = tired(0, maxMana as number);
                noPower(w);
                const rests = spyOn(bot, 'rest').mockImplementation(async () => resting);
                await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0 });
                expect(rests.mock.calls[0]![0]!.manaPercent).toBe(percent as number);
            });

            test('under fire from a mob a failed fight ruled out it only waits for the next try: no rest, which would refuse, and no error', async () => {
                const { w, bot } = tired(10, 200);
                noPower(w);
                w.state.nearbyNpcs.push(mob({ objectId: 701, x: 560700 }));
                w.combat({ kind: 'spellEffect', attackerObjectId: 701, targetObjectId: w.player.objectId, effectId: 5208 });
                w.publish();
                w.onTick = world => world.combat({ kind: 'spellEffect', attackerObjectId: 701, targetObjectId: world.player.objectId, effectId: 5208 });
                const rests = spyOn(bot, 'rest');
                bot.killNpc = (async () => ({ success: false, killed: false, reason: 'out_of_reach', message: 'too high', xpGained: 0 })) as unknown as typeof bot.killNpc;
                const r = await bot.grind({ pet: true, durationMs: 4000, minEngageMs: 0, loot: false });
                expect(r.stopReason).toBe('duration');
                expect(rests).not.toHaveBeenCalled();
            });

            test('a run that ends with no pet because of it says so, once', async () => {
                const { w, bot } = tired(10, 200);
                noPower(w);
                spyOn(bot, 'rest').mockImplementation(async () => {
                    await Bun.sleep(150);
                    return resting;
                });
                const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0 });
                expect(r).toMatchObject({ kills: 0, stopReason: 'duration' });
                expect(r.message).toContain('; no pet: short of power for Amber Simulacrum (it can cost 50, and we have 10)');
                expect(r.message).not.toContain('could not summon');
            });

            test('with the pet up by the end there is nothing to say', async () => {
                const { w, bot } = tired(10, 200);
                let casts = 0;
                w.handlers.castSpell = (_a, world) => {
                    if (++casts === 1) return void setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5);
                    setTimeout(() => {
                        world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                        world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                        world.state.pet = petWindow();
                    }, 5);
                };
                spyOn(bot, 'rest').mockImplementation(async () => resting);
                const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0 });
                expect(casts).toBe(2);
                expect(r.message).not.toContain('short of power');
            });
        });

        describe('a kill at the last moment of a pass', () => {
            test('the death event since the fight began is the kill, though killNpc timed out, without XP if the delta has gone', async () => {
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050 })], nearbyObjects: [] });
                spyOn(bot, 'killNpc').mockImplementationOnce(async () => {
                    dies(w, 701);
                    w.publish();
                    return timedOut(2958);
                });
                const seen: KillResult[] = [];
                const r = await bot.grind({ maxKills: 1, durationMs: 5000, loot: false, onKill: k => { seen.push(k); } });
                expect(r).toMatchObject({ success: true, kills: 1, failures: 0, stopReason: 'maxKills' });
                expect(r.killLog[0]).toMatchObject({ name: 'young wolf', xp: 0 });
                expect(seen[0]).toMatchObject({ success: true, killed: true });
                expect(seen[0]!.reason).toBeUndefined();
                expect(seen[0]!.message).toStartWith('Killed young wolf in ');
            });

            test('a record left under an id the server has given another mob is no kill: that is a new fight, with its own time', async () => {
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
                const killed = (ms: number) => ({ ...timedOut(ms), success: true, reason: undefined, killed: true });
                const melee = spyOn(bot, 'killNpc').mockImplementationOnce(async () => {
                    // The first pass runs out with the fight going on, and the next mob on us takes over.
                    w.npc(701)!.healthPercent = 90;
                    w.npc(701)!.targetObjectId = null;
                    w.state.nearbyNpcs = [...w.state.nearbyNpcs, mob({ objectId: 702, x: 560060, targetObjectId: 100 })];
                    w.publish();
                    return timedOut(20);
                }).mockImplementationOnce(async () => {
                    // While we kill that one somebody else kills 701, and a new mob of the same name gets the id, on us.
                    dies(w, 701);
                    w.removeNpc(702);
                    w.state.nearbyNpcs = [...w.state.nearbyNpcs, mob({ objectId: 701, x: 560070, targetObjectId: 100 })];
                    w.publish();
                    return killed(20);
                }).mockImplementationOnce(async () => timedOut(20)).mockImplementationOnce(async () => {
                    dies(w, 701);
                    w.publish();
                    return killed(20);
                });
                const r = await bot.grind({ maxKills: 2, durationMs: 5000, killTimeout: 5000, loot: false });
                expect(melee.mock.calls.map(c => c[0] as NearbyNpc).map(n => n.objectId)).toEqual([701, 702, 701, 701]);
                expect(r).toMatchObject({ kills: 2, stopReason: 'maxKills' });
                expect(w.npc(701)).toBeUndefined();
            });

            test('nor under another mob\'s name, with no death event seen: the id says nothing by itself', async () => {
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: 100 })], nearbyObjects: [] });
                const seen: number[] = [];
                const melee = spyOn(bot, 'killNpc').mockImplementationOnce(async () => {
                    await Bun.sleep(400);
                    w.state.nearbyNpcs = [mob({ objectId: 701, name: 'bandit', x: 560050, targetObjectId: 100 })];
                    w.publish();
                    return timedOut(400);
                }).mockImplementationOnce(async () => {
                    await Bun.sleep(30);
                    dies(w, 701);
                    w.publish();
                    return { ...timedOut(30), success: true, reason: undefined, killed: true };
                });
                const r = await bot.grind({ maxKills: 1, durationMs: 5000, killTimeout: 5000, loot: false, onKill: k => { seen.push(k.durationMs); } });
                expect(melee).toHaveBeenCalledTimes(2);
                expect(r.killLog[0]).toMatchObject({ name: 'bandit' });
                expect(seen[0]).toBeLessThan(300);
            });

            test('with no death event it stays a failure', async () => {
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050 })], nearbyObjects: [] });
                spyOn(bot, 'killNpc').mockImplementationOnce(async () => {
                    w.removeNpc(701);
                    w.publish();
                    return timedOut();
                });
                const r = await bot.grind({ durationMs: 50, minEngageMs: 0, loot: false });
                expect(r).toMatchObject({ kills: 0, failures: 1 });
            });
        });

        test('onKill gets the whole fight: its duration and the seconds in its message, as killLog has them', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
            fightsLike(w, () => 3);
            const seen: KillResult[] = [];
            const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, killTimeout: 60, loot: false, onKill: k => { seen.push(k); } });
            const whole = r.killLog[0]!.durationMs;
            expect(whole).toBeGreaterThan(200);
            expect(seen[0]!.durationMs).toBe(whole);
            expect(seen[0]!.message).toStartWith(`Killed young wolf in ${(whole / 1000).toFixed(1)}s`);
            expect(seen[0]!.xpGained).toBe(10);
        });

        describe('a turret', () => {
            // The turret stands 64 east of 560000, and we have walked off from it.
            const off = () => makePlayer({ x: 561400 });
            const killed = (w: FakeWorld) => orders(w, (a, world) => {
                if (a.command !== 'attack') return;
                world.message(KILL);
                setTimeout(() => dies(world, a.targetObjectId!), 20);
            });

            test('a fresh mob beyond its reach is passed over: no order, no walk, no failure, no wait', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561500 }), mob({ objectId: 702, x: 560500 })] });
                killed(w);
                const t0 = Date.now();
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(orderedOnto(w)).toEqual([702]);
                expect(w.sentOf('moveTo')).toEqual([]);
                expect(w.sentOf('castSpell')).toEqual([]);
                expect(Date.now() - t0).toBeLessThan(1400);
            });

            test('with only such mobs around it stops as no_targets, saying why', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561500 })] });
                const r = await bot.grind({ pet: true, durationMs: 5000, noTargetTimeoutMs: 100, loot: false });
                expect(r).toMatchObject({ stopReason: 'no_targets', failures: 0 });
                expect(r.message).toContain('turret');
                expect(w.sent).toEqual([]);
            });

            test('a mob that walks out of its reach in the fight: no failure and no walk, the next one is taken, and it counts again once back', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560900 }), mob({ objectId: 702, x: 560700 })] });
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    // The turret never reads as on it here, so petKill would order again after 5 s: that is where the reach stops it.
                    if (++attacks === 1) return void (world.npc(701)!.x = 561500);
                    if (attacks === 2) world.npc(701)!.x = 560900;
                    setTimeout(() => dies(world, a.targetObjectId!), 5);
                });
                let r: Awaited<ReturnType<BotActions['grind']>>;
                await fast(1000, async () => {
                    r = await bot.grind({ pet: true, maxKills: 2, durationMs: 3_600_000, loot: false });
                });
                expect(r!).toMatchObject({ kills: 2, failures: 0 });
                expect(orderedOnto(w)).toEqual([701, 702, 701]);
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('a mob that walks out while the model holds the turret\'s aim on it: no failure, and the next one is taken', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560900 }), mob({ objectId: 702, x: 560700 })] });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    world.state.pet = petWindow({ targetObjectId: a.targetObjectId! });
                    if (a.targetObjectId === 701) return void (world.npc(701)!.x = 561500);
                    setTimeout(() => {
                        world.state.pet = petWindow();
                        dies(world, a.targetObjectId!);
                    }, 5);
                });
                let r: Awaited<ReturnType<BotActions['grind']>>;
                await fast(100, async () => {
                    r = await bot.grind({ pet: true, maxKills: 1, durationMs: 3_600_000, loot: false });
                });
                expect(r!).toMatchObject({ kills: 1, failures: 0 });
                expect(orderedOnto(w)).toEqual([701, 702]);
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('such a mob that comes for us is ours to fight: the owner doesn\'t stand under it', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560900 })] });
                fightSim(w, { dmg: 50 });
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    world.state.pet = petWindow({ targetObjectId: a.targetObjectId! });
                    const m = world.npc(701)!;
                    m.x = 561450;
                    m.targetObjectId = 100;
                });
                let r: Awaited<ReturnType<BotActions['grind']>>;
                await fast(100, async () => {
                    r = await bot.grind({ pet: true, maxKills: 1, durationMs: 3_600_000, loot: false });
                });
                expect(r!).toMatchObject({ kills: 1, failures: 0 });
                expect(orderedOnto(w)).toEqual([701]);
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test('a mob on us beyond its reach is ours to fight: an order would only stop what it is doing', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561450, targetObjectId: 100 })] });
                orders(w);
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(w.sentOf('petCommand')).toEqual([]);
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test('so is one hitting us from there that names nobody, as a caster does: no order, and the refusal does not come straight back', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561450 })] });
                orders(w);
                fightSim(w, { dmg: 50 });
                w.combat({ kind: 'spellEffect', attackerObjectId: 701, targetObjectId: w.player.objectId, effectId: 5208 });
                w.publish();
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(w.sentOf('petCommand')).toEqual([]);
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test('a caster on it from beyond its reach is no target, and holds no pull up', async () => {
                const { w, bot } = petWorld({ player: off(), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561500, targetObjectId: PET_ID }), mob({ objectId: 702, x: 560500 })] });
                killed(w);
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                expect(orderedOnto(w)).toEqual([702]);
            });
        });
    });

    describe('an NPC at 0 % is not dead (GameLiving.cs:2621)', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        const deadEntry = () => mob({ healthPercent: 0 });
        const death = (w: FakeWorld) => w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });

        test('killNpc fights on to the death event, and reports what the kill paid', async () => {
            const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ x: 560050 })] });
            let swings = 0;
            w.onTick = world => {
                const npc = world.npc(700);
                if (!world.player.attacking || !npc) return;
                npc.healthPercent = 0;
                world.combat({ kind: 'melee', attackerObjectId: world.player.objectId, targetObjectId: 700, result: 'hit', targetHealthPercent: 0 });
                if (++swings === 20) dies(world, 700);
            };
            expect(await bot.killNpc(700)).toMatchObject({ success: true, killed: true, xpGained: 1 });
            expect(swings).toBe(20);
        });

        test('petKill waits for the death too: a pet\'s next swing can be seconds off', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                world.npc(700)!.healthPercent = 0;
                setTimeout(() => dies(world, 700), 150);
            });
            const t0 = Date.now();
            expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true, xpGained: 1 });
            expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
        });

        test('a mob at 0 % that never dies is bounded by the timeout', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), deadEntry()] });
            orders(w, (_a, world) => world.message(KILL));
            expect(await bot.petKill(700, { timeout: 100 })).toMatchObject({ success: false, reason: 'timeout', killed: false });
        });

        test('the entry going at 0 % is still the kill', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                world.npc(700)!.healthPercent = 0;
                setTimeout(() => world.removeNpc(700), 30);
            });
            expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
        });

        test('at 0 % it stays a target for every order; only a death event makes it already_dead', async () => {
            const live = petWorld({ nearbyNpcs: [petNpc(), deadEntry()] });
            orders(live.w, (_a, world) => world.message(KILL));
            expect(await live.bot.petAttack(700)).toMatchObject({ success: true });
            expect(await live.bot.attack(700)).toMatchObject({ success: true });
            expect(await live.bot.killNpc(700, { timeout: 60 })).toMatchObject({ reason: 'timeout' });
            expect(await live.bot.petKill(700, { timeout: 60 })).toMatchObject({ reason: 'timeout' });

            const gone = petWorld({ nearbyNpcs: [petNpc(), deadEntry()] });
            death(gone.w);
            gone.w.publish();
            for (const r of [await gone.bot.petAttack(700), await gone.bot.attack(700), await gone.bot.killNpc(700), await gone.bot.petKill(700)]) {
                expect(r).toMatchObject({ success: false, reason: 'already_dead' });
            }
            expect(gone.w.sentOf('petCommand')).toEqual([]);
        });

        test('a mob at 0 % on us or the pet is still on us or the pet', () => {
            const onUs = world({ pet: null, nearbyNpcs: [mob({ healthPercent: 0, targetObjectId: 100 })] });
            expect(onUs.bot.getAttackers().map(n => n.objectId)).toEqual([700]);
            const onPet = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 0, targetObjectId: PET_ID })] });
            expect(onPet.bot.getPetAttackers().map(n => n.objectId)).toEqual([700]);
        });
    });

    describe('releasePet names the pet', () => {
        /** The server: the pet goes (0xA2, then the close, PetECSEffect.cs:18-20). */
        const closes = (w: FakeWorld, id = PET_ID) => orders(w, (_a, world) => {
            world.removeNpc(id);
            world.message('You lose control of the amber simulacrum!');
            world.state.lastPetLoss = { objectId: id, name: 'amber simulacrum', cause: 'released', at: Date.now() };
            world.state.pet = null;
        });

        test('with its entry in view it is selected in the same order: the server releases its target, a deleted pet too (CharacterClassBase.cs:336-341)', async () => {
            const { w, bot } = petWorld();
            closes(w);
            const r = await bot.releasePet();
            expect(r).toMatchObject({ success: true, command: 'release', pet: null, petState: null, message: 'Released the amber simulacrum' });
            expect(w.sentOf('petCommand')).toHaveLength(1);
            expect(w.sentOf('petCommand')[0]).toMatchObject({ command: 'release', targetObjectId: PET_ID });
            expect(r.messages.map(m => m.text)).toContain('You lose control of the amber simulacrum!');
        });

        test('a previous target comes back afterwards; none or the pet itself clears ours: the server would keep the deleted pet, and the next Pet spell would land on it (SpellHandler.cs:468-470, :648-658)', async () => {
            const other = petWorld({ player: makePlayer({ targetObjectId: 700 }) });
            closes(other.w);
            await other.bot.releasePet();
            expect(other.w.sentOf('setTarget').map(a => a.objectId)).toEqual([700]);
            expect(other.w.player.targetObjectId).toBe(700);

            const none = petWorld();
            closes(none.w);
            await none.bot.releasePet();
            expect(none.w.sent.map(a => a.type)).toEqual(['petCommand', 'setTarget']);
            expect(none.w.sentOf('setTarget').map(a => a.objectId)).toEqual([null]);

            const itself = petWorld({ player: makePlayer({ targetObjectId: PET_ID }) });
            closes(itself.w);
            await itself.bot.releasePet();
            expect(itself.w.sentOf('setTarget').map(a => a.objectId)).toEqual([null]);
        });

        describe('the model shows our target back before it returns: the next cast with no target reads it (live: about 11 ms after the release)', () => {
            /** The model has a dispatched target only with its next snapshots. */
            const lags = (w: FakeWorld, ms = 40) => {
                w.handlers.setTarget = (a, world) => { if (a.type === 'setTarget') setTimeout(() => { world.player.targetObjectId = a.objectId; }, ms); };
            };

            test('a previous target', async () => {
                const { w, bot, sdk } = petWorld({ player: makePlayer({ targetObjectId: 700 }) });
                closes(w);
                lags(w);
                await bot.releasePet();
                expect(sdk.getPlayer()?.targetObjectId).toBe(700);
            });

            test('none', async () => {
                const { w, bot, sdk } = petWorld();
                closes(w);
                lags(w);
                await bot.releasePet();
                expect(sdk.getPlayer()?.targetObjectId).toBeNull();
            });

            test('the next cast with no target lands on it, not on a charm\'s ex-pet', async () => {
                const jolt = spellOf('Minor Vitality Drain', 0);
                const { w, bot } = petWorld({ skills: skillsWith(jolt), player: makePlayer({ targetObjectId: 700 }) });
                orders(w, (_a, world) => { world.state.pet = null; world.npc(PET_ID)!.realm = 'none'; world.npc(PET_ID)!.isPet = false; });
                lags(w);
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${jolt.name} spell!`, { type: 'spell' }), 5); };
                await bot.releasePet();
                expect(await bot.castSpell(jolt)).toMatchObject({ success: true, target: { objectId: 700 } });
                expect(w.sentOf('setTarget').at(-1)!.objectId).toBe(700);
            });

            test('a selection that doesn\'t come through holds the release up only briefly', async () => {
                const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: 700 }) });
                closes(w);
                w.handlers.setTarget = () => {};
                const t0 = Date.now();
                expect(await bot.releasePet()).toMatchObject({ success: true });
                expect(Date.now() - t0).toBeLessThan(1000);
            });

            test('a summon\'s release too', async () => {
                const { w, bot, sdk } = world({ pet: null, summons: [SPIRIT_ID], nearbyNpcs: [spirit(), mob()], player: makePlayer({ targetObjectId: 700 }) });
                orders(w, (_a, world) => { world.removeNpc(SPIRIT_ID); });
                lags(w);
                expect(await bot.releasePet({ target: SPIRIT_ID })).toMatchObject({ success: true });
                expect(sdk.getPlayer()?.targetObjectId).toBe(700);
            });
        });

        test('a previous target that went meanwhile stays gone', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: 700 }) });
            orders(w, (_a, world) => {
                world.removeNpc(700);
                world.removeNpc(PET_ID);
                world.state.pet = null;
            });
            await bot.releasePet();
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([null]);
        });

        test('with its entry out of view and nothing selected the one clear before the order is all it takes', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [mob()] });
            closes(w);
            await bot.releasePet();
            expect(w.sent.map(a => a.type)).toEqual(['setTarget', 'petCommand']);
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([null]);
        });

        test('with its entry out of view its name comes from the window: the last loss can be an earlier pet\'s', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [mob()], pet: petWindow({ name: 'lynx cub' }), lastPetLoss: { objectId: 1, name: 'wolf cub', cause: 'died', at: 1 } });
            orders(w, (_a, world) => { world.state.pet = null; });
            expect(await bot.releasePet()).toMatchObject({ success: true, message: 'Released the lynx cub' });
        });

        test('with its entry out of view the target is cleared first: the client can\'t select an unknown id', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [mob()], player: makePlayer({ targetObjectId: 700 }) });
            closes(w);
            expect(await bot.releasePet()).toMatchObject({ success: true, pet: null, petState: null });
            expect(w.sent.map(a => a.type)).toEqual(['setTarget', 'petCommand', 'setTarget']);
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([null, 700]);
            expect(w.sentOf('petCommand')[0]!.targetObjectId).toBeUndefined();
        });

        test('a charm\'s ex-pet stays in view: the result reads it again', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.state.pet = null;
                world.state.nearbyNpcs = [petNpc({ isPet: false, realm: 'none' }), mob()];
            });
            expect(await bot.releasePet()).toMatchObject({ success: true, petState: null, pet: { objectId: PET_ID, isPet: false, realm: 'none' }, message: 'Released the amber simulacrum' });
        });

        test('summonPet with replace goes the same way', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), player: makePlayer({ targetObjectId: 700 }) });
            closes(w);
            summons(w, simulacrum.name, 'ruby simulacrum', { id: 620 });
            expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true, pet: { objectId: 620 } });
            expect(w.sentOf('petCommand')[0]).toMatchObject({ command: 'release', targetObjectId: PET_ID });
        });

        describe('one pet with no window, by target', () => {
            test('selects it, orders, and observes the NPC leaving; our target comes back', async () => {
                const { w, bot } = world({ pet: null, summons: [SPIRIT_ID], nearbyNpcs: [spirit(), mob()], player: makePlayer({ targetObjectId: 700 }) });
                orders(w, (_a, world) => { world.removeNpc(SPIRIT_ID); });
                const r = await bot.releasePet({ target: SPIRIT_ID });
                expect(r).toMatchObject({ success: true, command: 'release', pet: null, petState: null, message: 'Released the air spirit' });
                expect(w.sentOf('petCommand')).toHaveLength(1);
                expect(w.sentOf('petCommand')[0]).toMatchObject({ command: 'release', targetObjectId: SPIRIT_ID });
                expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([700]);
            });

            test('a name finds our own, and an entry that stays is no_response', async () => {
                const { w, bot } = world({ pet: null, summons: [SPIRIT_ID], nearbyNpcs: [spirit(), mob({ name: 'air spirit lord' })] });
                orders(w);
                const r = await bot.releasePet({ target: 'air spirit', timeout: 60 });
                expect(r).toMatchObject({ success: false, reason: 'no_response', pet: { objectId: SPIRIT_ID } });
                expect(w.sentOf('petCommand')[0]).toMatchObject({ targetObjectId: SPIRIT_ID });
            });

            test('no target and no window is no_pet, even with a summon selected', async () => {
                const { w, bot } = world({ pet: null, summons: [SPIRIT_ID], nearbyNpcs: [spirit()], player: makePlayer({ targetObjectId: SPIRIT_ID }) });
                expect(await bot.releasePet()).toMatchObject({ success: false, reason: 'no_pet' });
                expect(await bot.releasePet({ target: null })).toMatchObject({ success: false, reason: 'no_pet' });
                expect(w.sent).toEqual([]);
            });

            test('what is no pet of ours goes nowhere: with a window up the server would release that one instead', async () => {
                const { w, bot } = petWorld({ summons: [SPIRIT_ID], nearbyNpcs: [petNpc(), spirit(), mob(), petNpc({ objectId: 611, name: 'other pet' })] });
                // `pet` is the pet we have, never what we named: a peaceful NPC there would read as ours.
                const standing = { success: false, pet: { objectId: PET_ID }, petState: { objectId: PET_ID } };
                expect(await bot.releasePet({ target: 700 })).toMatchObject({ ...standing, reason: 'bad_args' });
                expect(await bot.releasePet({ target: 611 })).toMatchObject({ ...standing, reason: 'refused' });
                expect(await bot.releasePet({ target: 999 })).toMatchObject({ ...standing, reason: 'not_found' });
                expect(w.sent).toEqual([]);
            });

            test('with no window a refusal has no pet to report', async () => {
                const { bot } = world({ pet: null, nearbyNpcs: [mob()] });
                expect(await bot.releasePet({ target: 700 })).toMatchObject({ success: false, reason: 'bad_args', pet: null, petState: null });
            });

            test('a summon goes, with a window pet up, and the window pet stays', async () => {
                const { w, bot } = petWorld({ summons: [SPIRIT_ID], nearbyNpcs: [petNpc(), spirit()] });
                orders(w, (_a, world) => { world.removeNpc(SPIRIT_ID); });
                expect(await bot.releasePet({ target: spirit() })).toMatchObject({ success: true, petState: { objectId: PET_ID } });
            });

            test('naming the window pet is a plain release', async () => {
                const { w, bot } = petWorld();
                closes(w);
                expect(await bot.releasePet({ target: PET_ID })).toMatchObject({ success: true, message: 'Released the amber simulacrum', petState: null });
            });
        });
    });

    describe('replace keeps the pet until the new cast can go', () => {
        const caster = (mana: number) => makePlayer({ mana, maxMana: 200, manaPercent: Math.round(mana / 2) });

        test('a spell that is no summon is bad_args at once, unpaid, with or without a pet', async () => {
            const gust = spellOf('Confusing Gust', 462);
            const none = world({ pet: null, skills: skillsWith(gust), nearbyNpcs: [mob()] });
            expect(await none.bot.summonPet(gust)).toMatchObject({ success: false, reason: 'bad_args', spell: { name: 'Confusing Gust' }, pet: null, petState: null });
            expect(none.w.sent).toEqual([]);
            const up = petWorld({ skills: skillsWith(gust) });
            expect(await up.bot.summonPet(gust, { replace: true })).toMatchObject({ success: false, reason: 'bad_args', petState: { objectId: PET_ID } });
            expect(up.w.sent).toEqual([]);
        });

        test('power below the worst case: no_power, and nothing goes out', async () => {
            // -25 % of the pool: spell.sql. With no stats to read the pool can be as much as maxMana (SpellHandler.cs:1180-1202): 50, for a class with no focus.
            const percent = petWorld({ skills: skillsWith(simulacrum), player: caster(49) });
            expect(await percent.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: false, reason: 'no_power', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
            expect(percent.w.sent).toEqual([]);
            // A flat 5.
            const flat = petWorld({ skills: skillsWith(turret), player: caster(3), groundTarget: at(560100, 511000) });
            expect(await flat.bot.summonPet(turret, { replace: true })).toMatchObject({ success: false, reason: 'no_power', petState: { objectId: PET_ID } });
            expect(flat.w.sent).toEqual([]);
        });

        describe('with the stats without items, power goes by the real pool: level * (stat + 145) / 41 + 5 (SpellHandler.cs:1190-1221, GamePlayer.cs:2478)', () => {
            const NO_ITEMS = { strength: 50, dexterity: 60, constitution: 50, quickness: 50, intelligence: 60, piety: 50, empathy: 50, charisma: 50 };
            const who = (className: string, realm: 'midgard' | 'albion', mana: number, maxMana = 105) => makePlayer({ className, realm, level: 20, mana, maxMana, manaPercent: Math.round(mana * 100 / maxMana), statsWithoutItems: NO_ITEMS });
            const replaced = (player: ReturnType<typeof makePlayer>) => {
                const made = petWorld({ skills: skillsWith(simulacrum), player });
                orders(made.w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                summons(made.w, simulacrum.name, 'ruby simulacrum', { id: 620 });
                return made;
            };

            test('a Hunter pays the percent of it, no focus (live: 26 of 105): the pet stays below that', async () => {
                const low = replaced(who('Hunter', 'midgard', 25));
                expect(await low.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: false, reason: 'no_power', petState: { objectId: PET_ID } });
                expect(low.w.sent).toEqual([]);
                const enough = replaced(who('Hunter', 'midgard', 26));
                expect(await enough.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true });
            });

            test('items in maxMana change nothing: they aren\'t in the pool', async () => {
                const low = replaced(who('Hunter', 'midgard', 25, 300));
                expect(await low.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: false, reason: 'no_power', petState: { objectId: PET_ID } });
                expect(low.w.sent).toEqual([]);
                const enough = replaced(who('Hunter', 'midgard', 26, 300));
                expect(await enough.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true });
            });

            test('a focus caster can pay up to 120 % of it: below that the pet stays, and the message says what a focus item changes', async () => {
                // Live: mana 12 of 57 and a real cost of 17, the release went through and the cast was refused (SpellHandler.cs:1221).
                const low = replaced(who('Necromancer', 'albion', 30));
                const r = await low.bot.summonPet(simulacrum, { replace: true });
                expect(r).toMatchObject({ success: false, reason: 'no_power', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
                for (const part of ['30', '31', 'focus', 'releasePet']) expect(r.message).toContain(part);
                expect(low.w.sent).toEqual([]);
                const enough = replaced(who('Necromancer', 'albion', 31));
                expect(await enough.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true });
            });

            test('with no focus to lower it, the message says nothing of one', async () => {
                const r = await replaced(who('Hunter', 'midgard', 25)).bot.summonPet(simulacrum, { replace: true });
                for (const part of ['25', '26', 'releasePet']) expect(r.message).toContain(part);
                expect(r.message).not.toContain('focus');
            });

            test('plain summonPet with no pet up is untouched: nothing to lose, the server answers', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [], player: who('Necromancer', 'albion', 5) });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); };
                expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'no_power', message: "You don't have enough power to cast that!" });
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });

            test('a release by hand goes on regardless', async () => {
                const low = replaced(who('Necromancer', 'albion', 5));
                expect(await low.bot.releasePet()).toMatchObject({ success: true });
            });
        });

        test('power for the worst case goes on', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), player: caster(50) });
            orders(w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
            summons(w, simulacrum.name, 'ruby simulacrum', { id: 620 });
            expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true });
        });

        describe('melee on us: our swing holds any cast with a cast time back for the weapon\'s interval, and a hit on us can interrupt one at its half way (SpellHandler.cs:356-372, :603-620, AttackComponent.cs:1110-1114, AttackerTracker.cs:154-161)', () => {
            const kept = { success: false, reason: 'in_combat', pet: { objectId: PET_ID }, petState: { objectId: PET_ID }, spell: { name: simulacrum.name } };
            const replacing = (o: Partial<BotWorldState> = {}) => {
                const made = petWorld({ skills: skillsWith(simulacrum), player: caster(200), ...o });
                orders(made.w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                summons(made.w, simulacrum.name, 'ruby simulacrum', { id: 620 });
                return made;
            };
            const swing = (attackerObjectId: number, targetObjectId: number, ago = 0) => ({ id: 1, kind: 'melee' as const, attackerObjectId, targetObjectId, result: 'hit' as const, receivedAt: Date.now() - ago });

            test('a mob on us: the pet stays, nothing goes out, and the message says a release by hand goes on regardless', async () => {
                const { w, bot } = replacing({ nearbyNpcs: [petNpc(), mob({ targetObjectId: 100 })] });
                const r = await bot.summonPet(simulacrum, { replace: true });
                expect(r).toMatchObject(kept);
                expect(r.message).toContain('young wolf');
                expect(r.message).toContain('releasePet by hand goes on regardless');
                expect(w.sent).toEqual([]);
            });

            test('our own swing on', async () => {
                const { w, bot } = replacing({ player: { ...caster(200), attacking: true } });
                expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject(kept);
                expect(w.sent).toEqual([]);
            });

            test.each([['by us', 100, 700], ['on us', 700, 100]])('a swing %s under 3 s old', async (_what, by, on) => {
                const { w, bot } = replacing({ combatEvents: [swing(by as number, on as number, 2500)] });
                expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject(kept);
                expect(w.sent).toEqual([]);
            });

            test.each([['by us, past our weapon\'s 3.7 s', swing(100, 700, 3800)], ['on us, over 3 s old', swing(700, 100, 3200)], ['of our pet, on its mob', swing(PET_ID, 700)], ['on our pet', swing(700, PET_ID)]])('a swing %s stops nothing', async (_what, event) => {
                const { bot } = replacing({ combatEvents: [event] });
                expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true, pet: { objectId: 620 } });
            });

            describe('the clock on our own swing is the weapon\'s: its full interval holds a cast (SPD_ABS, value2 on the wire, PacketLib1124.cs:893-896)', () => {
                const worn = (slot: number, name: string, speed: number, objectType = 3): InventoryItem => ({ slot, name, level: 1, count: 1, model: 3, objectType, condition: 100, durability: 100, quality: 85, weight: 30, value1: 16, value2: speed, hand: 0 });
                const staff = worn(12, 'trimmed staff', 44, 8);

                test('a 4.4 s staff, 3.2 s after its last swing: the pet stays, and the message says how long', async () => {
                    const { w, bot } = replacing({ equipment: [staff], combatEvents: [swing(100, 700, 3200)] });
                    const r = await bot.summonPet(simulacrum, { replace: true });
                    expect(r).toMatchObject(kept);
                    expect(r.message).toContain('our swing');
                    expect(r.message).toContain('4.4 s');
                    expect(w.sent).toEqual([]);
                });

                test('past that it goes', async () => {
                    const { bot } = replacing({ equipment: [staff], combatEvents: [swing(100, 700, 4500)] });
                    expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true, pet: { objectId: 620 } });
                });

                test('a quick weapon holds it no longer than its own interval', async () => {
                    const { bot } = replacing({ equipment: [worn(10, 'dagger', 22)], combatEvents: [swing(100, 700, 2500)] });
                    expect(await bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true, pet: { objectId: 620 } });
                });

                test('the model can\'t tell which one is in hand, so the slowest melee weapon worn goes; a bow\'s shot holds nothing (AttackComponent.cs:1113), and a shield is no weapon', async () => {
                    const both = replacing({ equipment: [worn(10, 'dagger', 22), staff], combatEvents: [swing(100, 700, 3200)] });
                    expect(await both.bot.summonPet(simulacrum, { replace: true })).toMatchObject(kept);

                    const bow = replacing({ equipment: [worn(10, 'dagger', 22), worn(13, 'long bow', 55, 9), worn(11, 'small shield', 40, 42)], combatEvents: [swing(100, 700, 2500)] });
                    expect(await bow.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true, pet: { objectId: 620 } });
                });

                test('with no speed to read it is 3 s', async () => {
                    const none = replacing({ equipment: [], combatEvents: [swing(100, 700, 2900)] });
                    expect(await none.bot.summonPet(simulacrum, { replace: true })).toMatchObject(kept);
                    const past = replacing({ equipment: [], combatEvents: [swing(100, 700, 3100)] });
                    expect(await past.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true });
                });

                test('a hit on us goes by its own 3 s, whatever we hold, and says what it does: it stops a cast at its half way and holds none', async () => {
                    const { bot } = replacing({ equipment: [staff], combatEvents: [swing(700, 100, 2500)] });
                    const r = await bot.summonPet(simulacrum, { replace: true });
                    expect(r).toMatchObject(kept);
                    expect(r.message).toContain('a hit on us');
                    const past = replacing({ equipment: [staff], combatEvents: [swing(700, 100, 3200)] });
                    expect(await past.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true });
                });
            });

            test('a spell with no cast time has no such check: a Hunter\'s pet (spell.sql, SpellHandler.cs:603)', async () => {
                const hunters = spellOf("Hunter's Pet", 3587);
                const { w, bot } = replacing({ skills: skillsWith(hunters), nearbyNpcs: [petNpc(), mob({ targetObjectId: 100 })] });
                summons(w, hunters.name, 'wolf cub', { id: 620 });
                expect(await bot.summonPet(hunters, { replace: true })).toMatchObject({ success: true, pet: { objectId: 620 } });
            });

            test('a charm too, for what is on us rather than for its own mob', async () => {
                const { w, bot } = replacing({ skills: skillsWith(charm), player: makePlayer({ className: 'Sorcerer', level: 20, mana: 200, maxMana: 200, manaPercent: 100, targetObjectId: 700 }), nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, name: 'rat', targetObjectId: 100 })] });
                const r = await bot.charmPet(700, { replace: true });
                expect(r).toMatchObject({ ...kept, spell: { name: charm.name } });
                expect(r.message).toContain('rat');
                expect(w.sent).toEqual([]);
            });

            test('a plain summon is left to the server: nothing to lose', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), player: caster(200), nearbyNpcs: [mob({ targetObjectId: 100 })] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must wait 2 seconds to cast a spell!', { type: 'resisted' }), 5); };
                expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'must_wait' });
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });

            test('a release by hand goes on regardless', async () => {
                const { bot } = replacing({ nearbyNpcs: [petNpc(), mob({ targetObjectId: 100 })] });
                expect(await bot.releasePet()).toMatchObject({ success: true });
            });
        });

        test('a turret with no ground target anywhere: no_ground_target, pet kept', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), groundTarget: null, player: caster(200) });
            expect(await bot.summonPet(turret, { replace: true })).toMatchObject({ success: false, reason: 'no_ground_target', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
            expect(w.sent).toEqual([]);
        });

        test('a turret with its spot out of the spell\'s range: out_of_range, pet kept, the spot unsent (SummonAnimistPet.cs:35)', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
            expect(await bot.summonPet(turret, { replace: true, groundTarget: at(561500, 511000) })).toMatchObject({ success: false, reason: 'out_of_range', petState: { objectId: PET_ID } });
            expect(w.sent).toEqual([]);
            // The one already set counts as well.
            const set = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: at(561500, 511000) });
            expect(await set.bot.summonPet(turret, { replace: true })).toMatchObject({ success: false, reason: 'out_of_range' });
            // With no z only the ground plane can be judged.
            const flat = petWorld({ skills: skillsWith(turret), player: caster(200) });
            expect(await flat.bot.summonPet(turret, { replace: true, groundTarget: { x: 561500, y: 511000 } })).toMatchObject({ success: false, reason: 'out_of_range' });
        });

        test('a spot off the mesh: the ground target goes first, its answer keeps the pet (PlayerGroundTargetHandler.cs:30-33)', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
            w.handlers.setGroundTarget = (_a, world) => { setTimeout(() => world.message('Your ground target is not visible!'), 5); };
            const r = await bot.summonPet(turret, { replace: true, groundTarget: at(560100, 511000) });
            expect(r).toMatchObject({ success: false, reason: 'refused', petState: { objectId: PET_ID }, pet: { objectId: PET_ID } });
            expect(r.message).toContain('walkable');
            expect(r.messages.map(m => m.text)).toEqual(['Your ground target is not visible!']); // the server's line stays with the result
            expect(r.message).toContain('pass no z');
            expect(w.sent.map(a => a.type)).toEqual(['setGroundTarget']);
        });

        test('a spot off the mesh with no z passed: "pass no z" would be no advice', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: null });
            w.handlers.setGroundTarget = (_a, world) => { setTimeout(() => world.message('Your ground target is not visible!'), 5); };
            const r = await bot.summonPet(turret, { replace: true, groundTarget: { x: 560100, y: 511000 } });
            expect(r).toMatchObject({ success: false, reason: 'refused', petState: { objectId: PET_ID } });
            expect(r.message).toContain('walkable');
            expect(r.message).not.toContain('pass no z');
            expect(r.message).toContain("an NPC's coordinates");
        });

        describe('at the edge of the range: the server moves a spot first, then measures in 3D (PlayerGroundTargetHandler.cs:63-85, SummonAnimistPet.cs:35), and the release comes first', () => {
            test('within 16 of the limit: out_of_range, the pet kept, and the message says why', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
                const r = await bot.summonPet(turret, { replace: true, groundTarget: at(560990, 511000) });
                expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
                expect(r.message).toContain('990');
                expect(r.message).toContain('16');
                expect(w.sent).toEqual([]);
            });

            test('with the height the client gave it, after the spot went out', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: null });
                w.handlers.setGroundTarget = (a, world) => { if (a.type === 'setGroundTarget') world.state.groundTarget = { x: a.x, y: a.y, z: 2940 }; }; // 890 away and 440 up: 993 of 1000
                const r = await bot.summonPet(turret, { replace: true, groundTarget: { x: 560890, y: 511000 } });
                expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID } });
                expect(w.sent.map(a => a.type)).toEqual(['setGroundTarget', 'setGroundTarget']);
            });

            describe('a mesh loaded: 16 is the server\'s search box per axis, no limit on the move, and it keeps the closest point it finds (LocalPathfindingMgr.cs:301-306, :341-349)', () => {
                const meshPuts = (to: { x: number; y: number; z: number }) => navmeshAt.mockReturnValue({ closestPoint: () => to } as unknown as NavMesh);
                afterEach(() => navmeshAt.mockReturnValue(null));

                test('a gap that would put it beyond the spell: out_of_range, the pet kept, and the message says where', async () => {
                    meshPuts({ x: 561007, y: 511000, z: 2500 });
                    const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
                    const r = await bot.summonPet(turret, { replace: true, groundTarget: at(560980, 511000) });
                    expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
                    expect(r.message).toContain('1007');
                    expect(w.sent).toEqual([]);
                });

                test('one that keeps it inside goes', async () => {
                    meshPuts({ x: 560982, y: 511000, z: 2503 });
                    const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
                    orders(w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                    summons(w, turret.name, "grove's assailant", { id: 620 });
                    expect(await bot.summonPet(turret, { replace: true, groundTarget: at(560980, 511000) })).toMatchObject({ success: true, pet: { objectId: 620 } });
                });

                test('a spot with no z yet is judged once the client has given it one', async () => {
                    meshPuts({ x: 561007, y: 511000, z: 2500 });
                    const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: null });
                    w.handlers.setGroundTarget = (a, world) => { if (a.type === 'setGroundTarget') world.state.groundTarget = { x: a.x, y: a.y, z: 2500 }; };
                    const r = await bot.summonPet(turret, { replace: true, groundTarget: { x: 560980, y: 511000 } });
                    expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID } });
                    expect(w.sent.map(a => a.type)).toEqual(['setGroundTarget', 'setGroundTarget']);
                });
            });

            test('over 16 inside it goes', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
                orders(w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                summons(w, turret.name, "grove's assailant", { id: 620 });
                expect(await bot.summonPet(turret, { replace: true, groundTarget: at(560980, 511000) })).toMatchObject({ success: true, pet: { objectId: 620 } });
            });

            test('a plain summon is left to the server', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(turret), player: caster(200), nearbyNpcs: [] });
                summons(w, turret.name, "grove's assailant", { id: 620 });
                expect(await bot.summonPet(turret, { groundTarget: at(560990, 511000) })).toMatchObject({ success: true });
            });
        });

        describe('a spot with no z is judged again once the client has its height (SummonAnimistPet.cs:35)', () => {
            /** The client snaps the z as it sends (client.ts): the model has it right away. */
            const snaps = (w: FakeWorld, z: number) => {
                w.handlers.setGroundTarget = (a, world) => { if (a.type === 'setGroundTarget') world.state.groundTarget = { x: a.x, y: a.y, z: a.z ?? z }; };
            };

            test('in range on the plane and out of it on a hill: out_of_range, nothing released', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: null });
                snaps(w, 3400); // 600 away on the plane, 900 up: 1082 of 1000
                const t0 = Date.now();
                const r = await bot.summonPet(turret, { replace: true, groundTarget: { x: 560600, y: 511000 } });
                expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
                expect(r.message).toContain('1082');
                expect(Date.now() - t0).toBeGreaterThanOrEqual(280); // the wait for an off-mesh answer stays
                expect(w.sent.map(a => a.type)).toEqual(['setGroundTarget', 'setGroundTarget']);
            });

            test('in range in 3D as well: released and cast', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: null });
                snaps(w, 2600);
                orders(w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                summons(w, turret.name, "grove's assailant", { id: 620 });
                expect(await bot.summonPet(turret, { replace: true, groundTarget: { x: 560600, y: 511000 } })).toMatchObject({ success: true, pet: { objectId: 620 } });
            });

            test('an old spot still in the snapshot is not what we judge', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: at(590000, 511000) });
                orders(w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                summons(w, turret.name, "grove's assailant", { id: 620 });
                expect(await bot.summonPet(turret, { replace: true, groundTarget: { x: 560600, y: 511000 } })).toMatchObject({ success: true });
            });
        });

        test('spell_not_found says what stands: the pet we have', async () => {
            const { bot } = petWorld({ skills: skillsWith(simulacrum) });
            expect(await bot.summonPet('No such spell', { replace: true })).toMatchObject({ success: false, reason: 'spell_not_found', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
            const none = petWorld({ skills: skillsWith(earth) });
            expect(await none.bot.summonPet()).toMatchObject({ success: false, reason: 'spell_not_found', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
        });

        test('a good spot: ground target, release, cast', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
            orders(w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
            summons(w, turret.name, "grove's assailant", { id: 620 });
            expect(await bot.summonPet(turret, { replace: true, groundTarget: at(560100, 511000) })).toMatchObject({ success: true, pet: { objectId: 620 } });
            expect(w.sent.map(a => a.type)).toEqual(['setGroundTarget', 'petCommand', 'setTarget', 'castSpell']);
        });

        test('without a pet to lose the server answers for itself', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [], groundTarget: null });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You have to set a ground target for this Spell.', { type: 'resisted' }), 5); };
            expect(await bot.summonPet(turret)).toMatchObject({ success: false, reason: 'no_ground_target', message: 'You have to set a ground target for this Spell.' });
            expect(w.sentOf('castSpell')).toHaveLength(1);
        });
    });

    describe('the late pet_exists: the server\'s brain lingers after the 0xA2 (EffectListComponent.cs:914-921)', () => {
        const REFUSED = 'You already have a charmed creature, release it first!';

        test('with no pet here it waits for the close and casts once more', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            let casts = 0;
            w.handlers.castSpell = (_a, world) => {
                if (++casts === 1) {
                    setTimeout(() => world.message(REFUSED, { type: 'resisted' }), 5);
                    setTimeout(() => {
                        world.message('You lose control of the skeletal commander!');
                        world.message('You release control of your controlled target.');
                    }, 60);
                    return;
                }
                setTimeout(() => {
                    world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                    world.state.nearbyNpcs = [petNpc()];
                    world.state.pet = petWindow();
                }, 5);
            };
            const t0 = Date.now();
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: true, petState: { objectId: PET_ID } });
            expect(casts).toBe(2);
            expect(Date.now() - t0).toBeLessThan(900);
        });

        test('a Necromancer\'s comes as the shade\'s line, checked first and gone at the same close (SummonNecromancerPet.cs:45-54): it goes the same way', async () => {
            const { w, bot } = world({ pet: null, player: makePlayer({ isShade: true }), skills: skillsWith(simulacrum), nearbyNpcs: [] });
            let casts = 0;
            w.handlers.castSpell = (_a, world) => {
                if (++casts === 1) {
                    setTimeout(() => world.message('You are already a shade!', { type: 'resisted' }), 5);
                    setTimeout(() => world.message('You lose control of the bone servant!'), 40);
                    return;
                }
                setTimeout(() => {
                    world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                    world.state.nearbyNpcs = [petNpc()];
                    world.state.pet = petWindow();
                }, 5);
            };
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: true, petState: { objectId: PET_ID } });
            expect(casts).toBe(2);
        });

        test('a second refusal is reported, after about a second at most', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(REFUSED, { type: 'resisted' }), 5); };
            const t0 = Date.now();
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'pet_exists', pet: null, petState: null });
            expect(w.sentOf('castSpell')).toHaveLength(2);
            expect(Date.now() - t0).toBeLessThan(1500);
        });
    });

    describe('refusals before anything is sent', () => {
        test('a peace flag or an untargetable NPC: not_attackable at once, no packet, our target unmoved (AbstractServerRules.cs:383-384)', async () => {
            for (const bad of [mob({ isPeaceful: true }), mob({ isTargetable: false })]) {
                const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), bad], player: makePlayer({ targetObjectId: 200 }) });
                const t0 = Date.now();
                expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'not_attackable', target: { objectId: 700 } });
                expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'not_attackable', npc: { objectId: 700 } });
                expect(Date.now() - t0).toBeLessThan(1000); // the server's silence would take 3 s
                expect(w.sent).toEqual([]);
                expect(w.player.targetObjectId).toBe(200);
            }
        });

        test('a peaceful NPC far off: no walk first', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ isPeaceful: true, x: 563000 })] });
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'not_attackable' });
            expect(w.sent).toEqual([]);
        });

        test('our own id: not_attackable for an attack, bad_args naming petComeHere for a walk', async () => {
            const { w, bot } = petWorld();
            expect(await bot.petAttack(100)).toMatchObject({ success: false, reason: 'not_attackable' });
            expect(await bot.petKill(100)).toMatchObject({ success: false, reason: 'not_attackable' });
            const go = await bot.petGoTo(100);
            expect(go).toMatchObject({ success: false, reason: 'bad_args' });
            expect(go.message).toContain('petComeHere');
            expect(w.sent).toEqual([]);
        });

        test('a null target is no_target, never a TypeError (findKillableNpc returns null in normal play)', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(charm), player: makePlayer({ targetObjectId: 700 }) });
            for (const target of [null, undefined]) {
                expect(await bot.petAttack(target)).toMatchObject({ success: false, reason: 'no_target' });
                expect(await bot.petKill(target)).toMatchObject({ success: false, reason: 'no_target' });
                expect(await bot.petGoTo(target)).toMatchObject({ success: false, reason: 'no_target' });
                expect(await bot.charmPet(target)).toMatchObject({ success: false, reason: 'no_target' });
            }
            expect(w.sent).toEqual([]);
        });

        test('the ground target lines keep their own reasons', () => {
            expect(castFailureReason('You have to select a closer ground target.')).toBe('out_of_range');
            expect(castFailureReason('You have to set a ground target for this Spell.')).toBe('no_ground_target');
            expect(castFailureReason("You can't summon a turret without a ground target !")).toBe('no_ground_target');
            expect(castFailureReason('Your ground target is not visible!')).toBe('refused');
            expect(castFailureReason('Your ground target is not in view.')).toBe('refused');
            expect(castFailureReason("You can't summon any more turrets in this area!")).toBe('refused');
        });

        test('a spot dropped as the cast goes out reads as off the surface', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('Your ground target is not visible!'), 5); };
            const r = await bot.summonPet(turret);
            expect(r).toMatchObject({ success: false, reason: 'refused' });
            expect(r.message).toContain('walkable');
        });

        test('groundTarget without z: sent without one, for the client to take the terrain\'s (client.ts)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
            summons(w, turret.name, "grove's assailant");
            expect(await bot.summonPet(turret, { groundTarget: { x: 560100, y: 511000 } })).toMatchObject({ success: true });
            expect(w.sentOf('setGroundTarget')[0]).toMatchObject({ x: 560100, y: 511000 });
            expect(w.sentOf('setGroundTarget')[0]!.z).toBeUndefined();
        });

        test('summonPet() with neither main nor turret spell names what is known, and how to call it', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(earth, bomber, charm, minion), nearbyNpcs: [] });
            const r = await bot.summonPet();
            expect(r).toMatchObject({ success: false, reason: 'spell_not_found' });
            for (const part of [earth.name, bomber.name, charm.name, minion.name, 'charmPet', 'target']) expect(r.message).toContain(part);
            expect(w.sent).toEqual([]);
        });

        test('that message lists every spell of a kind, and speaks of a ground target only for what stands on one', async () => {
            const ice = spellOf('Summon Minor Ice Spirit', 261, 3, 1);
            const theurgist = await world({ pet: null, skills: skillsWith(earth, ice), nearbyNpcs: [] }).bot.summonPet();
            expect(theurgist.message).toContain(earth.name);
            expect(theurgist.message).toContain(ice.name);
            expect(theurgist.message).not.toContain('groundTarget');
            const vent = spellOf('Spore Spewer', 11443);
            const animist = await world({ pet: null, skills: skillsWith(vent), nearbyNpcs: [] }).bot.summonPet();
            expect(animist.message).toContain(vent.name);
            expect(animist.message).toContain('groundTarget');
        });

        describe('an Enemy summon takes castSpell\'s checks', () => {
            test.each([
                ['a peace flag', () => mob({ isPeaceful: true, x: 570000 }), 'not_attackable'],
                ['an NPC of our realm', () => mob({ realm: 'albion', x: 570000 }), 'invalid_target'],
            ])('%s: refused with no walk and no packet', async (_what, npc, reason) => {
                const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [(npc as () => NearbyNpc)()] });
                expect(await bot.summonPet(earth, { target: 700 })).toMatchObject({ success: false, reason: reason as string, spell: { name: earth.name } });
                expect(w.sent).toEqual([]);
            });

            test('our own id', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [] });
                expect(await bot.summonPet(earth, { target: 100 })).toMatchObject({ success: false, reason: 'no_target' });
                expect(w.sent).toEqual([]);
            });
        });

        describe('an off-mesh line during a cast (a 0xEC sent meanwhile; SummonAnimistPet.cs:50-58)', () => {
            const begins = (world: FakeWorld) => {
                world.message(`You begin casting a ${turret.name} spell!`, { type: 'spell' });
                world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 150 });
            };

            test('the server goes on casting, and its end-of-cast line decides', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => begins(world), 5);
                    setTimeout(() => world.message('Your ground target is not visible!'), 40);
                    setTimeout(() => world.message('You have to set a ground target for this Spell.', { type: 'resisted' }), 150);
                };
                const t0 = Date.now();
                const r = await bot.summonPet(turret);
                expect(r).toMatchObject({ success: false, reason: 'no_ground_target', message: 'You have to set a ground target for this Spell.' });
                expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
            });

            test('a good spot set meanwhile: the cast goes through', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => begins(world), 5);
                    setTimeout(() => world.message('Your ground target is not visible!'), 40);
                    setTimeout(() => {
                        world.message(`You cast a ${turret.name} spell!`, { type: 'spell' });
                        world.state.nearbyNpcs = [petNpc({ name: "grove's assailant" })];
                        world.state.pet = petWindow();
                        world.message("The grove's assailant is now under your control.", { type: 'spell' });
                    }, 150);
                };
                expect(await bot.summonPet(turret)).toMatchObject({ success: true, petState: { objectId: PET_ID } });
            });
        });

        describe('an NPC with no name reads #id', () => {
            test('petAttack and petKill, and a target both unnamed and untargetable says both', async () => {
                const { bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ objectId: 701, name: '', isPeaceful: true }), mob({ objectId: 702, name: '', isTargetable: false }), mob({ objectId: 703, name: '', isPeaceful: true, isTargetable: false })] });
                expect(await bot.petAttack(701)).toMatchObject({ reason: 'not_attackable', message: "#701 can't be attacked (peaceful)" });
                expect(await bot.petKill(702)).toMatchObject({ reason: 'not_attackable', message: "#702 can't be attacked (not targetable)" });
                expect(await bot.petAttack(703)).toMatchObject({ reason: 'not_attackable', message: "#703 can't be attacked (peaceful, not targetable)" });
            });

            test('killNpc, castSpell and charmPet', async () => {
                const { bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [mob({ objectId: 701, name: '', isPeaceful: true }), mob({ objectId: 702, name: '', realm: 'midgard' })] });
                expect((await bot.killNpc(701)).message).toStartWith('#701 is not something we can kill');
                expect((await bot.castSpell(charm, 701)).message).toBe("#701 can't be attacked (peaceful)");
                expect((await bot.charmPet(702)).message).toBe("#702 can't be charmed!");
            });
        });
    });

    describe('charmPet picks its way', () => {
        const coerce = spellOf('Coerce Will', 952, 5, 1);
        const WRONG = 'This spell does not charm that type of monster!';
        const charmed = (world: FakeWorld, spell: string) => {
            world.message(`You cast a ${spell} spell!`, { type: 'spell' });
            world.state.nearbyNpcs = [mob({ realm: 'albion', isPet: true })];
            world.state.pet = petWindow({ objectId: 700 });
        };

        test('anything of a realm is refused at once, with no walk (CharmSpellHandler.cs:151)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [mob({ realm: 'albion', x: 570000, name: 'Lundeg' })] });
            const r = await bot.charmPet(700);
            expect(r).toMatchObject({ success: false, reason: 'refused', message: "Lundeg can't be charmed!" });
            expect(w.sent).toEqual([]);
        });

        test('our own id is not_attackable', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [] });
            expect(await bot.charmPet(100)).toMatchObject({ success: false, reason: 'not_attackable' });
            expect(w.sent).toEqual([]);
        });

        test('the wrong type moves on to the next charm, best first: that refusal spends no power', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm, coerce), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (a, world) => {
                if (a.type !== 'castSpell') return;
                if (a.spellIndex === 1) setTimeout(() => world.message(WRONG, { type: 'resisted' }), 5);
                else setTimeout(() => charmed(world, charm.name), 5);
            };
            expect(await bot.charmPet(700)).toMatchObject({ success: true, spell: { name: charm.name }, petState: { objectId: 700 } });
            expect(w.sentOf('castSpell').map(a => a.spellIndex)).toEqual([1, 0]);
        });

        test('every one the wrong type: the last refusal is reported', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm, coerce), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(WRONG, { type: 'resisted' }), 5); };
            expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'refused', message: WRONG });
            expect(w.sentOf('castSpell')).toHaveLength(2);
        });

        test('any other refusal stops there', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm, coerce), nearbyNpcs: [mob({ name: 'power wraith' })] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The power wraith is too strong for you to charm!', { type: 'resisted' }), 5); };
            expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'refused' });
            expect(w.sentOf('castSpell')).toHaveLength(1);
        });

        test('options.spell picks one, and only that one', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm, coerce), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(WRONG, { type: 'resisted' }), 5); };
            expect(await bot.charmPet(700, { spell: 'Persuade Will' })).toMatchObject({ success: false, reason: 'refused', spell: { name: charm.name } });
            expect(w.sentOf('castSpell').map(a => a.spellIndex)).toEqual([0]);
            expect(await bot.charmPet(700, { spell: 'Nothing like it' })).toMatchObject({ success: false, reason: 'spell_not_found' });
            const other = world({ pet: null, skills: skillsWith(charm, simulacrum), nearbyNpcs: [mob()] });
            expect(await other.bot.charmPet(700, { spell: simulacrum.name })).toMatchObject({ success: false, reason: 'bad_args' });
            expect(other.w.sent).toEqual([]);
        });

        test('a mob in combat is in_combat, which a retry can pass (CharmSpellHandler.cs:340-344)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [mob({ name: 'river spriteling' })] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't charm the river spriteling while its is in combat!", { type: 'resisted' }), 5); };
            expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'in_combat' });
            // Whatever the mob is called.
            expect(castFailureReason("You can't charm the power wraith while it is in combat!")).toBe('in_combat');
            expect(castFailureReason("You can't charm that target!")).toBe('refused');
        });

        describe('with replace the pet stays until the charm can go', () => {
            const sorcerer = (level = 20) => makePlayer({ level, targetObjectId: null });
            const replacing = (npc: NearbyNpc, o: Partial<BotWorldState> = {}) => {
                const made = petWorld({ skills: skillsWith(charm), player: sorcerer(), nearbyNpcs: [petNpc(), npc], ...o });
                orders(made.w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                made.w.handlers.castSpell = (_a, world) => { setTimeout(() => charmed(world, charm.name), 5); };
                return made;
            };
            const keptPet = { success: false, pet: { objectId: PET_ID }, petState: { objectId: PET_ID } };

            test.each([
                ['in combat', { inCombat: true }, 'in_combat'],
                ['on our pet', { targetObjectId: PET_ID, x: 560800 }, 'in_combat'],
                ['above the spell\'s value', { level: 11 }, 'refused'], // Persuade Will: 10 (CharmSpellHandler.cs:332)
                ['with a capital name', { name: 'Lady Felin' }, 'refused'], // spell_charm_named_check, default 1 (CharmSpellHandler.cs:212)
            ])('a mob %s: refused before anything is released', async (_what, o, reason) => {
                const { w, bot } = replacing(mob(o as Partial<NearbyNpc>));
                expect(await bot.charmPet(700, { replace: true })).toMatchObject({ ...keptPet, reason: reason as string, target: { objectId: 700 } });
                expect(await bot.summonPet(charm, { replace: true, target: 700 })).toMatchObject({ ...keptPet, reason: reason as string, target: { objectId: 700 } });
                expect(w.sent).toEqual([]);
            });

            describe('in combat to the server while its entry reads none: a fight in the last 10 s, or a mez or a stun on it (GameLiving.cs:31, :227, :444; PacketLib168.cs:820)', () => {
                const FOG_OF_SENILITY = 971; // Mesmerize, 20 s
                const STUNNING_YELL = 1161; // Stun, 3 s
                const PERSUADE_WILL = 951; // Our charm's own effect.
                type Seen = Omit<BotWorldState['combatEvents'][number], 'id' | 'receivedAt'>;
                const saw = (...seen: [number, Seen][]) => ({ combatEvents: seen.map(([ago, e], i) => ({ ...e, id: i + 1, receivedAt: Date.now() - ago })) });
                const mezzed = (effectId = FOG_OF_SENILITY): Seen => ({ kind: 'spellEffect', attackerObjectId: 100, targetObjectId: 700, effectId });
                const hit: Seen = { kind: 'melee', attackerObjectId: 999, targetObjectId: 700 };
                const hits: Seen = { kind: 'melee', attackerObjectId: 700, targetObjectId: 999 };
                const casts: Seen = { kind: 'spellCast', attackerObjectId: 700, targetObjectId: null, effectId: 5208 };
                const nuked: Seen = { kind: 'spellEffect', attackerObjectId: 999, targetObjectId: 700, effectId: 5208 };

                test.each<[string, number, Seen]>([
                    ['a mez of ours just landed', 0, mezzed()],
                    ['a mez with 5 s to run, older than the 10 s of a fight', 15_000, mezzed()],
                    ['a stun', 2000, mezzed(STUNNING_YELL)],
                    ['a stun worn off, and the 10 s it leaves behind (CrowdControlECSEffect.cs:35-46)', 12_000, mezzed(STUNNING_YELL)],
                    ['a blow at it 9 s ago', 9000, hit],
                    ['its own swing 9 s ago', 9000, hits],
                    ['its own cast 9 s ago', 9000, casts],
                    ['a spell of somebody else\'s on it 9 s ago', 9000, nuked],
                ])('%s: in_combat, with nothing released', async (_what, ago, e) => {
                    const { w, bot } = replacing(mob(), saw([ago, e]));
                    expect(await bot.charmPet(700, { replace: true })).toMatchObject({ ...keptPet, reason: 'in_combat', target: { objectId: 700 } });
                    expect(w.sent).toEqual([]);
                });

                test.each<[string, number, Seen]>([
                    ['a blow 11 s ago', 11_000, hit],
                    ['a mez run out and 10 s more', 31_000, mezzed()],
                    ['our charm resisted just now: no harm to the server (Spell.cs:301-306)', 0, mezzed(PERSUADE_WILL)],
                    ['a fight of another mob', 0, { kind: 'melee', attackerObjectId: 999, targetObjectId: 701 }],
                ])('%s: it goes', async (_what, ago, e) => {
                    const { bot } = replacing(mob(), saw([ago, e]));
                    expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true, petState: { objectId: 700 } });
                });

                test('a death since: the id has gone to the next spawn (Region.cs:955)', async () => {
                    const { bot } = replacing(mob(), saw([3000, hit], [2000, { kind: 'death', attackerObjectId: 999, targetObjectId: 700 }]));
                    expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                });

                test('with no pet to lose the server answers, as before', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(charm), nearbyNpcs: [mob()], ...saw([0, hit]) });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => charmed(world, charm.name), 5); };
                    expect(await bot.charmPet(700)).toMatchObject({ success: true });
                });

                test('a pulsing charm has no such limit (CharmSpellHandler.cs:293-309)', async () => {
                    const song = { ...spellOf('Captivating Melodies', 1151), lineName: 'Instruments' };
                    const { w, bot } = replacing(mob(), { skills: { ...skillsWith(song), specializations: [{ name: 'Instruments', level: 20, internalId: 0, bonus: 0 }] }, ...saw([0, hit]) });
                    // A release casts it once to stop the song (stopCharmSong).
                    let casts = 0;
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => (++casts === 1 ? world.message('You cancel your effect.', { type: 'spell' }) : charmed(world, song.name)), 5); };
                    expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                });
            });

            describe('a pulsing charm stops at 110 % of our modified spec, whatever the spell\'s 76 (CharmSpellHandler.cs:293-309; PacketLib1112.cs:65)', () => {
                const song = { ...spellOf('Captivating Melodies', 1151), lineName: 'Instruments' };
                const illusion = { ...spellOf('Illusory Enemy', 4211), lineName: 'Illusions' };
                const skillsAt = (sp: typeof song, name: string, level: number, bonus = 0) => ({ ...skillsWith(sp), specializations: [{ name, level, internalId: 0, bonus }] });
                const singing = (level: number, skills: BotWorldState['skills'], sp = song) => {
                    const made = replacing(mob({ level }), { skills });
                    // A release casts it once to stop the song (stopCharmSong).
                    let casts = 0;
                    made.w.handlers.castSpell = (_a, world) => { setTimeout(() => (++casts === 1 ? world.message('You cancel your effect.', { type: 'spell' }) : charmed(world, sp.name)), 5); };
                    return made;
                };

                test('above it: refused with the numbers, and nothing released: its ex-pet would turn on us (CharmECSEffect.cs:75-83)', async () => {
                    const { w, bot } = singing(12, skillsAt(song, 'Instruments', 8));
                    const r = await bot.charmPet(700, { replace: true });
                    expect(r).toMatchObject({ ...keptPet, reason: 'refused', target: { objectId: 700 } });
                    expect(r.message).toBe('young wolf is too strong for Captivating Melodies: level 12, above 8, which is 110 % of our spec of 8');
                    expect(w.sent).toEqual([]);
                });

                test('at the limit it goes: 8 x 1.1 is 8.8', async () => {
                    const at = singing(8, skillsAt(song, 'Instruments', 8));
                    expect(await at.bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                    const over = singing(9, skillsAt(song, 'Instruments', 8));
                    expect(await over.bot.charmPet(700, { replace: true })).toMatchObject({ ...keptPet, reason: 'refused' });
                });

                test('what items add counts: 8 + 3 is 12.1', async () => {
                    expect(await singing(12, skillsAt(song, 'Instruments', 8, 3)).bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                });

                test('a Mentalist: the line is Illusions, its spec Light, and the wire says Light Magic (spelllines, specialization.sql:77)', async () => {
                    const refused = singing(12, skillsAt(illusion, 'Light Magic', 8), illusion);
                    expect(await refused.bot.charmPet(700, { replace: true })).toMatchObject({ ...keptPet, reason: 'refused' });
                    expect(refused.w.sent).toEqual([]);
                    expect(await singing(8, skillsAt(illusion, 'Light Magic', 8), illusion).bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                });

                test('a spec our list doesn\'t show tells nothing: the server decides', async () => {
                    expect(await singing(12, skillsWith(song)).bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                });

                test('the spell\'s own value stands above it', async () => {
                    const { w, bot } = singing(77, skillsAt(song, 'Instruments', 80));
                    const r = await bot.charmPet(700, { replace: true });
                    expect(r).toMatchObject({ ...keptPet, reason: 'refused' });
                    expect(r.message).toBe('young wolf is too strong for Captivating Melodies: level 77, above 76');
                    expect(w.sent).toEqual([]);
                });
            });

            test('a mob of another realm', async () => {
                const { w, bot } = replacing(mob({ realm: 'midgard' }));
                expect(await bot.summonPet(charm, { replace: true, target: 700 })).toMatchObject({ ...keptPet, reason: 'refused' });
                expect(w.sent).toEqual([]);
            });

            test('a mob above our level, though under the spell\'s value', async () => {
                const { w, bot } = replacing(mob({ level: 9 }), { player: sorcerer(8) });
                expect(await bot.charmPet(700, { replace: true })).toMatchObject({ ...keptPet, reason: 'refused' });
                expect(w.sent).toEqual([]);
            });

            test('a level limit moves on to the next charm: a Hunter\'s go by body type, and its best can have the lower limit', async () => {
                const insect = spellOf('Charm Insect', 0, 9, 1); // value 18
                const animal = spellOf('Call of Gleipnir', 0, 12, 2); // value 16, and the higher level
                const { w, bot } = replacing(mob({ level: 17 }), { skills: skillsWith(insect, animal) });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => charmed(world, insect.name), 5); };
                expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true, spell: { name: insect.name } });
                expect(w.sentOf('castSpell').map(a => a.spellIndex)).toEqual([1]);
                // Too strong for them all: the pet stays.
                const strong = replacing(mob({ level: 19 }), { skills: skillsWith(insect, animal) });
                expect(await strong.bot.charmPet(700, { replace: true })).toMatchObject({ ...keptPet, reason: 'refused' });
                expect(strong.w.sent).toEqual([]);
            });

            test('too strong for them all: it names the highest limit among them, whichever came last', async () => {
                const insect = spellOf('Compel Insect', 0, 9, 1); // value 14
                const animal = spellOf('Lesser Call of Gleipnir', 0, 5, 2); // value 10, and the lower level: tried last
                const { w, bot } = replacing(mob({ level: 16, name: 'wood-eater royal guard' }), { skills: skillsWith(insect, animal) });
                const r = await bot.charmPet(700, { replace: true });
                expect(r).toMatchObject({ ...keptPet, reason: 'refused', spell: { name: insect.name }, message: 'wood-eater royal guard is too strong for Compel Insect: level 16, above 14' });
                expect(w.sent).toEqual([]);
            });

            test('a charm named by hand reports its own limit', async () => {
                const insect = spellOf('Compel Insect', 0, 9, 1);
                const animal = spellOf('Lesser Call of Gleipnir', 0, 5, 2);
                const { bot } = replacing(mob({ level: 16 }), { skills: skillsWith(insect, animal) });
                expect(await bot.charmPet(700, { replace: true, spell: animal.name })).toMatchObject({ reason: 'refused', message: 'young wolf is too strong for Lesser Call of Gleipnir: level 16, above 10' });
            });

            describe('the cast goes where the preflight looked: a release moves our selection, and the model has it back a moment later', () => {
                /** A charm's ex-pet stays in view, of no realm: as a selection nothing refuses it. */
                const released = (world: FakeWorld) => { world.state.pet = null; world.npc(PET_ID)!.realm = 'none'; world.npc(PET_ID)!.isPet = false; };

                test('with no target given: the mob selected, not the ex-pet', async () => {
                    const { w, bot } = replacing(mob(), { player: { ...sorcerer(), targetObjectId: 700 } });
                    orders(w, (_a, world) => released(world));
                    w.handlers.setTarget = (a, world) => { if (a.type === 'setTarget') setTimeout(() => { world.player.targetObjectId = a.objectId; }, 40); };
                    const r = await bot.summonPet(charm, { replace: true, appearTimeout: 200 });
                    expect(r).toMatchObject({ success: true, target: { objectId: 700 } });
                    expect(w.sentOf('setTarget').at(-1)!.objectId).toBe(700);
                });

                test('a selection that moves on the walk there: still the one judged', async () => {
                    const { w, bot } = replacing(mob({ x: 562000 }), { player: { ...sorcerer(), targetObjectId: 700 } });
                    orders(w, (_a, world) => released(world));
                    w.onTick = world => { if (world.state.movement.moving) world.player.targetObjectId = null; };
                    const r = await bot.summonPet(charm, { replace: true, appearTimeout: 200 });
                    expect(r).toMatchObject({ success: true, target: { objectId: 700 } });
                    expect(w.sentOf('setTarget').at(-1)!.objectId).toBe(700);
                });
            });

            test('at the limit it goes', async () => {
                const { w, bot } = replacing(mob({ level: 10 }));
                expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true, petState: { objectId: 700 } });
                expect(w.sent.filter(a => a.type === 'petCommand' || a.type === 'castSpell').map(a => a.type)).toEqual(['petCommand', 'castSpell']);
            });

            test('too far with approach off: out_of_range, nothing released', async () => {
                const { w, bot } = replacing(mob({ x: 562600 }));
                expect(await bot.charmPet(700, { replace: true, approach: false })).toMatchObject({ ...keptPet, reason: 'out_of_range' });
                expect(w.sent).toEqual([]);
            });

            test('too far with approach on: the walk comes first, the release only then', async () => {
                const { w, bot } = replacing(mob({ x: 562000 }));
                expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true, petState: { objectId: 700 } });
                const order = w.sent.map(a => a.type);
                expect(order.indexOf('moveTo')).toBeGreaterThanOrEqual(0);
                expect(order.indexOf('moveTo')).toBeLessThan(order.indexOf('petCommand'));
                expect(order.indexOf('petCommand')).toBeLessThan(order.indexOf('castSpell'));
            });

            test('a walk that fails keeps the pet', async () => {
                const { w, bot } = replacing(mob({ x: 562000 }));
                w.handlers.moveTo = () => ({ success: false, message: 'no way there', reason: 'no_path' });
                const r = await bot.charmPet(700, { replace: true });
                expect(r).toMatchObject({ ...keptPet, reason: 'no_path' });
                expect(w.sentOf('petCommand')).toEqual([]);
                expect(w.sentOf('castSpell')).toEqual([]);
            });

            test('a mob that turns to a fight during the walk keeps the pet', async () => {
                const { w, bot } = replacing(mob({ x: 562000 }));
                w.onTick = world => { if (world.player.x > 560300) world.state.nearbyNpcs = world.state.nearbyNpcs.map(n => n.objectId === 700 ? { ...n, inCombat: true } : n); };
                expect(await bot.charmPet(700, { replace: true })).toMatchObject({ ...keptPet, reason: 'in_combat' });
                expect(w.sentOf('petCommand')).toEqual([]);
            });

            test('without a pet to lose none of this: the server answers at the end of the cast', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(charm), player: sorcerer(), nearbyNpcs: [mob({ inCombat: true })] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't charm the young wolf while it is in combat!", { type: 'resisted' }), 5); };
                expect(await bot.charmPet(700)).toMatchObject({ success: false, reason: 'in_combat', message: "You can't charm the young wolf while it is in combat!" });
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });

            test('a pulsing charm has neither the combat nor our level to mind (CharmSpellHandler.cs:293-309)', async () => {
                const melodies = spellOf('Captivating Melodies', 1151, 1, 0);
                const { w, bot } = replacing(mob({ inCombat: true, level: 6 }), { skills: skillsWith(melodies), player: sorcerer(5), pet: petWindow({ icons: [1151] }) });
                let songOn = true;
                w.handlers.castSpell = (_a, world) => {
                    if (songOn) { songOn = false; setTimeout(() => world.message('You cancel your effect.', { type: 'spell' }), 5); return; }
                    setTimeout(() => charmed(world, melodies.name), 5);
                };
                expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true, petState: { objectId: 700 } });
            });

            test('our own pet: pet_exists, with and without replace', async () => {
                const { w, bot } = replacing(mob());
                for (const options of [{}, { replace: true }]) {
                    const r = await bot.charmPet(PET_ID, options);
                    expect(r).toMatchObject({ ...keptPet, reason: 'pet_exists', target: { objectId: PET_ID } });
                    expect(r.message).toContain('already our pet');
                }
                expect(await bot.summonPet(charm, { replace: true, target: PET_ID })).toMatchObject({ ...keptPet, reason: 'pet_exists' });
                expect(w.sent).toEqual([]);
            });

            test('a summon of ours too', async () => {
                const { w, bot } = world({ pet: null, summons: [SPIRIT_ID], skills: skillsWith(charm), nearbyNpcs: [spirit()] });
                const r = await bot.charmPet(SPIRIT_ID);
                expect(r).toMatchObject({ success: false, reason: 'pet_exists' });
                expect(r.message).toContain('already our pet');
                expect(w.sent).toEqual([]);
            });

            test('summonPet with a charm spell and nothing to charm keeps the pet', async () => {
                const { w, bot } = replacing(mob());
                expect(await bot.summonPet(charm, { replace: true })).toMatchObject({ ...keptPet, reason: 'no_target' });
                expect(await bot.summonPet(charm, { replace: true, target: 'nothing like it' })).toMatchObject({ ...keptPet, reason: 'not_found' });
                expect(await bot.summonPet(charm, { replace: true, target: 100 })).toMatchObject({ ...keptPet, reason: 'no_target' });
                expect(w.sent).toEqual([]);
            });

            test('summonPet with a charm spell takes the selection as castSpell does', async () => {
                const { w, bot } = replacing(mob({ inCombat: true }), { player: makePlayer({ level: 20, targetObjectId: 700 }) });
                expect(await bot.summonPet(charm, { replace: true })).toMatchObject({ ...keptPet, reason: 'in_combat' });
                expect(w.sent).toEqual([]);
            });

            test('castSpell\'s own checks come before the release', async () => {
                const peace = replacing(mob({ isPeaceful: true }));
                expect(await peace.bot.summonPet(charm, { replace: true, target: 700 })).toMatchObject({ ...keptPet, reason: 'not_attackable' });
                const friend = replacing(mob({ realm: 'albion' }));
                expect(await friend.bot.summonPet(charm, { replace: true, target: 700 })).toMatchObject({ ...keptPet, reason: 'invalid_target' });
                expect([...peace.w.sent, ...friend.w.sent]).toEqual([]);
            });

            test('an enemy player can\'t be charmed', async () => {
                const { w, bot } = replacing(mob(), { nearbyPlayers: [makePlayerObj({ objectId: 800, realm: 'midgard', x: 560100 })] });
                expect(await bot.summonPet(charm, { replace: true, target: 800 })).toMatchObject({ ...keptPet, reason: 'refused' });
                expect(w.sent).toEqual([]);
            });
        });

        test('charmPet\'s early refusals say what stands: the pet we have', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(charm), nearbyNpcs: [petNpc(), mob({ realm: 'albion', name: 'Magus Aelle' })] });
            const standing = { success: false, pet: { objectId: PET_ID }, petState: { objectId: PET_ID } };
            expect(await bot.charmPet(null, { replace: true })).toMatchObject({ ...standing, reason: 'no_target' });
            expect(await bot.charmPet(100, { replace: true })).toMatchObject({ ...standing, reason: 'not_attackable' });
            expect(await bot.charmPet('nothing like it', { replace: true })).toMatchObject({ ...standing, reason: 'not_found' });
            expect(await bot.charmPet(700, { replace: true })).toMatchObject({ ...standing, reason: 'refused' });
            expect(await bot.charmPet(700, { replace: true, spell: 'Nothing like it' })).toMatchObject({ ...standing, reason: 'spell_not_found' });
            expect(w.sent).toEqual([]);
            const bad = petWorld({ skills: skillsWith(charm, simulacrum) });
            expect(await bad.bot.charmPet(700, { replace: true, spell: simulacrum.name })).toMatchObject({ ...standing, reason: 'bad_args' });
            const none = petWorld({ skills: skillsWith(simulacrum) });
            expect(await none.bot.charmPet(700, { replace: true })).toMatchObject({ ...standing, reason: 'spell_not_found' });
        });
    });

    describe('findSummonSpell ranks what hurts first, for the kinds with vents and heals in them', () => {
        const vent = spellOf('Vent of Physical Protection', 11550, 17); // sub-spell a buff on us
        const essence = spellOf("Forest's Essence", 11352, 16); // sub-spell a DirectDamage on an enemy
        const blaze = spellOf('Wisp Blaze', 11322, 10); // a damage bomber
        const vines = spellOf('Expanding Vines', 11336, 19); // a snare
        const healer = spellOf('Meliorating Spirit', 11505, 18); // a heal on the pet
        const regen = spellOf('Spirit of Relief', 11511, 16); // a regen on the pet

        test('fnf: damage before a buff of a higher level', () => {
            expect(world({ skills: skillsWith(vent, essence) }).bot.findSummonSpell('fnf')?.name).toBe(essence.name);
        });

        test('bomber: damage before a snare and a heal of a higher level, a snare before a heal', () => {
            expect(world({ skills: skillsWith(vines, healer, regen, blaze) }).bot.findSummonSpell('bomber')?.name).toBe(blaze.name);
            expect(world({ skills: skillsWith(healer, regen, spellOf('Expanding Vines', 11336, 12)) }).bot.findSummonSpell('bomber')?.name).toBe('Expanding Vines');
        });

        test('with nothing harmful known, the highest level still answers', () => {
            expect(world({ skills: skillsWith(healer, regen) }).bot.findSummonSpell('bomber')?.name).toBe(healer.name);
        });

        test('within a rank the level decides, and a Theurgist\'s pets, with no sub-spell, are as they were', () => {
            const ice = spellOf('Summon Minor Ice Spirit', 261, 3, 1);
            expect(world({ skills: skillsWith(earth, ice) }).bot.findSummonSpell('fnf')?.name).toBe(ice.name);
        });
    });

    describe('a refused summon reports the pet that stands, as one kept by a preflight does', () => {
        const standing = { success: false, pet: { objectId: PET_ID }, petState: { objectId: PET_ID } };

        test('the server\'s refusal of a minion, the window pet untouched', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(minion) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('Your general already has as many followers as he can command!', { type: 'resisted' }), 5); };
            expect(await bot.summonPet(minion)).toMatchObject({ ...standing, reason: 'refused' });
        });

        test('no_power, with replace on a minion: it replaces nothing', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(minion) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); };
            expect(await bot.summonPet(minion, { replace: true })).toMatchObject({ ...standing, reason: 'no_power' });
        });

        test('a cast with no pet to show for it', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(minion) });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${minion.name} spell!`, { type: 'spell' }), 5); };
            expect(await bot.summonPet(minion, { appearTimeout: 30 })).toMatchObject({ ...standing, reason: 'timeout' });
        });

        test('with none up there is none to report', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [] });
            w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't do that here!", { type: 'important' }), 5); };
            expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'refused', pet: null, petState: null });
        });
    });

    describe('kinds and what a summon reports', () => {
        const lines = ['You hit the young wolf for 123 damage!', 'The young wolf resists the effect! (6.0%)', 'Your target is immune to this effect!'];

        test('bombers are their own kind: fnf finds a pet that stays', () => {
            const both = world({ skills: skillsWith(bomber, earth) });
            expect(both.bot.findSummonSpell('fnf')?.name).toBe(earth.name);
            expect(both.bot.findSummonSpell('bomber')?.name).toBe(bomber.name);
            expect(world({ skills: skillsWith(bomber) }).bot.findSummonSpell('fnf')).toBeNull();
        });

        test('a bomber: damage 0 and resisted false always, its hit is seen up to 4 s later (BomberBrain.cs:25-30)', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(bomber), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message('You cast a Wisp Heat spell!', { type: 'spell' });
                    world.combat({ kind: 'spellEffect', attackerObjectId: world.player.objectId, targetObjectId: 700, effectId: 1 });
                    for (const text of lines) world.message(text, { type: 'resisted' });
                }, 10);
            };
            const r = await bot.summonPet(bomber, { target: 700 });
            expect(r).toMatchObject({ success: true, damage: 0, resisted: false, effectImmune: false, pet: null, petState: null, message: 'Cast Wisp Heat on young wolf' });
        });

        test('a summon can\'t be resisted: not one on a target, nor one on nobody (SummonSpellHandler.cs:195)', async () => {
            const onMob = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [mob()] });
            onMob.w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message(`You cast a ${earth.name} spell!`, { type: 'spell' });
                    world.combat({ kind: 'spellEffect', attackerObjectId: world.player.objectId, targetObjectId: 700, effectId: 1 });
                    world.message('The young wolf resists the effect! (12.0%)', { type: 'resisted' });
                    world.message('The earth spirit is now under your control.', { type: 'spell' });
                }, 10);
            };
            const r = await onMob.bot.summonPet(earth, { target: 700 });
            expect(r).toMatchObject({ success: true, resisted: false });
            expect(r.message).not.toContain('resisted');

            const onNobody = world({ pet: null, skills: skillsWith(turret), nearbyNpcs: [] });
            onNobody.w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.message(`You cast a ${turret.name} spell!`, { type: 'spell' });
                    world.message('The fishing bear forager resists the effect! (6.0%)', { type: 'resisted' });
                    world.state.nearbyNpcs = [petNpc()];
                    world.state.pet = petWindow();
                }, 10);
            };
            expect(await onNobody.bot.summonPet(turret)).toMatchObject({ success: true, resisted: false });
        });

        test('a resist line by itself is no evidence the summon went off', async () => {
            const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [mob()] });
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 30 }), 5);
                setTimeout(() => world.message('The young wolf resists the effect! (12.0%)', { type: 'resisted' }), 50);
            };
            expect(await bot.summonPet(earth, { target: 700, timeout: 60 })).toMatchObject({ success: false, reason: 'timeout', completed: false });
        });
    });

    describe('whose resist it is, from the 0x1B beside the line', () => {
        const gust = spellOf('Confusing Gust', 462);
        const LINE = 'The young wolf resists the effect! (12.0%)';
        const ours = (world: FakeWorld) => world.combat({ kind: 'spellEffect', attackerObjectId: world.player.objectId, targetObjectId: 700, effectId: 1 });
        const pets = (world: FakeWorld) => world.combat({ kind: 'spellEffect', attackerObjectId: PET_ID, targetObjectId: 700, effectId: 2 });
        /** Our cast ends, `first` at once, the line `gap` ms later. */
        const plays = (w: FakeWorld, first: (world: FakeWorld) => void, gap: number, atLine: (world: FakeWorld) => void = () => {}, spell = gust.name) => {
            w.handlers.castSpell = (_a, world) => {
                setTimeout(() => {
                    world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 30 });
                    world.message(`You cast a ${spell} spell!`, { type: 'spell' });
                    first(world);
                }, 10);
                setTimeout(() => {
                    atLine(world);
                    world.message(LINE, { type: 'resisted' });
                }, 10 + gap);
            };
        };

        test('our own 0x1B beside it: resisted', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            plays(w, ours, 0);
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, resisted: true });
        });

        test('no 0x1B of ours: another caster\'s line', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            plays(w, () => {}, 0);
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, resisted: false });
        });

        test('a pet\'s 0x1B nearer than ours: the pet\'s line', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            plays(w, ours, 150, pets);
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, resisted: false });
        });

        test('ours nearer than a pet\'s: ours', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(gust) });
            plays(w, pets, 150, ours);
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, resisted: true });
        });

        test('with no target: an area spell keeps the line, a spell on ourselves has nothing to resist', async () => {
            const area = spellOf('Earth Eddies', 81);
            const aoe = world({ pet: null, skills: skillsWith(area), nearbyNpcs: [] });
            plays(aoe.w, () => {}, 0, undefined, area.name);
            expect(await aoe.bot.castSpell(area)).toMatchObject({ success: true, resisted: true });

            const heal = spellOf('Minor Rejuvenation', 1301);
            const self = world({ pet: null, skills: skillsWith(heal), nearbyNpcs: [] });
            plays(self.w, () => {}, 0, undefined, heal.name);
            expect(await self.bot.castSpell(heal)).toMatchObject({ success: true, resisted: false });
        });

        test('a summon\'s 0x1B counts as a pet\'s', async () => {
            const { w, bot } = world({ pet: null, summons: [SPIRIT_ID], skills: skillsWith(gust), nearbyNpcs: [spirit(), mob()] });
            plays(w, ours, 150, world => world.combat({ kind: 'spellEffect', attackerObjectId: SPIRIT_ID, targetObjectId: 700, effectId: 2 }));
            expect(await bot.castSpell(gust, 700)).toMatchObject({ success: true, resisted: false });
        });
    });

    describe('petKill with a mob on us', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';

        test('one already on us: reason attacked with the attacker, and no order goes out', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, name: 'water beetle', targetObjectId: 100 })] });
            const r = await bot.petKill(700);
            expect(r).toMatchObject({ success: false, reason: 'attacked', killed: false, npc: { objectId: 700 }, attacker: { objectId: 701, name: 'water beetle' } });
            expect(w.sentOf('petCommand')).toEqual([]);
        });

        test('one turning on us mid-fight ends it; the pet keeps its order', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, name: 'water beetle' })] });
            orders(w, (_a, world) => {
                world.message(KILL);
                world.state.pet = petWindow({ targetObjectId: 700 });
                setTimeout(() => { world.npc(701)!.targetObjectId = 100; }, 40);
            });
            const r = await bot.petKill(700);
            expect(r).toMatchObject({ success: false, reason: 'attacked', attacker: { objectId: 701 } });
            expect(w.sentOf('petCommand').map(a => a.command)).toEqual(['attack']);
        });

        test('the target itself on us is no other mob', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ targetObjectId: 100 })] });
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => dies(world, 700), 40);
            });
            expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
        });

        test('ignoreAttackers fights on', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, targetObjectId: 100 })] });
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => dies(world, 700), 40);
            });
            const r = await bot.petKill(700, { ignoreAttackers: true });
            expect(r).toMatchObject({ success: true, killed: true });
            expect(r.attacker).toBeUndefined();
        });

        test('grind takes the attacker next, and leaves the first mob unavoided', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, x: 560200 })] });
            let hits = 0;
            orders(w, (a, world) => {
                if (a.command !== 'attack') return;
                world.message(KILL);
                const on = a.targetObjectId!;
                // The first mob ordered brings another one onto us; after that the pet kills what it is told to.
                if (++hits === 1) setTimeout(() => { const n = world.npc(on === 700 ? 701 : 700); if (n) n.targetObjectId = 100; }, 20);
                else setTimeout(() => dies(world, on), 40);
            });
            const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false });
            expect(r).toMatchObject({ kills: 1 });
            expect(w.sentOf('petCommand')).toHaveLength(2);
            expect(w.sentOf('petCommand')[0]!.targetObjectId).not.toBe(w.sentOf('petCommand')[1]!.targetObjectId);
        });

        test('grind with two on us kills one, not swapping between them: the rest wait their turn', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ targetObjectId: 100 }), mob({ objectId: 701, x: 560200, targetObjectId: 100 })] });
            orders(w, (a, world) => {
                if (a.command !== 'attack') return;
                world.message(KILL);
                setTimeout(() => dies(world, a.targetObjectId!), 40);
            });
            expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
            expect(w.sentOf('petCommand')).toHaveLength(1);
        });
    });

    describe('petFight and the model\'s target', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        const skewed = async (run: (skew: (ms: number) => void) => Promise<void>) => {
            const realNow = Date.now.bind(Date);
            let by = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + by);
            try {
                await run(ms => { by += ms; });
            } finally {
                clock.mockRestore();
            }
        };

        test('an order standing is never repeated, however long the run-in', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc({ speed: 191 }), mob()] });
            orders(w, (_a, world) => {
                world.message(KILL);
                world.state.pet = petWindow({ targetObjectId: 700 });
            });
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                for (let i = 0; i < 4; i++) {
                    skew(6000);
                    await Bun.sleep(40);
                }
                expect(w.sentOf('petCommand')).toHaveLength(1);
                dies(w, 700);
                await killing;
            });
        });

        test('off it for over PET_REORDER_MS is a dropped mob, and only then', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                world.state.pet = petWindow({ targetObjectId: 700 });
            });
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                w.state.pet = petWindow({ targetObjectId: null });
                await Bun.sleep(40);
                skew(3000);
                await Bun.sleep(40);
                expect(w.sentOf('petCommand')).toHaveLength(1);
                skew(3000);
                await Bun.sleep(40);
                expect(w.sentOf('petCommand')).toHaveLength(2);
                dies(w, 700);
                await killing;
            });
        });
    });

    describe('a turret', () => {
        const KILL = "You command the grove's assailant to kill your target!";
        const messenger = spellOf('Battle Messenger', 11671);
        const turretWorld = (o: Partial<BotWorldState> = {}) => petWorld({ skills: skillsWith(turret), pet: petWindow({ icons: [turret.internalId] }), nearbyNpcs: [petNpc({ name: "grove's assailant" }), mob()], ...o });
        const beyond = () => mob({ x: 561200 }); // 1136 from the turret, 1200 from us

        test('a target beyond its spell: out_of_range at once, naming it, with no order and no walk (TurretBrain.cs:9-18, ControlledMobBrain.cs:216-225)', async () => {
            const { w, bot } = turretWorld({ nearbyNpcs: [petNpc({ name: "grove's assailant" }), beyond()], player: makePlayer({ targetObjectId: 200 }) });
            const t0 = Date.now();
            const attack = await bot.petAttack(700);
            expect(attack).toMatchObject({ success: false, reason: 'out_of_range', target: { objectId: 700 } });
            expect(attack.message).toContain("grove's assailant");
            const kill = await bot.petKill(700);
            expect(kill).toMatchObject({ success: false, reason: 'out_of_range', killed: false });
            expect(kill.message).toContain("grove's assailant");
            expect(Date.now() - t0).toBeLessThan(1000);
            expect(w.sent).toEqual([]);
            expect(w.player.targetObjectId).toBe(200);
        });

        test('its reach is its sub-spell\'s: a Battle Messenger\'s taunt goes 1350', async () => {
            const { w, bot } = turretWorld({ skills: skillsWith(turret, messenger), pet: petWindow({ icons: [messenger.internalId] }), nearbyNpcs: [petNpc(), beyond()] });
            orders(w, (_a, world) => world.message(KILL));
            expect(await bot.petAttack(700)).toMatchObject({ success: true });
        });

        test('no icon to go by: 1000', async () => {
            const { w, bot } = turretWorld({ pet: petWindow({ icons: [] }), nearbyNpcs: [petNpc(), beyond()] });
            expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'out_of_range' });
            expect(w.sent).toEqual([]);
        });

        test('in reach it is ordered as ever', async () => {
            const { w, bot } = turretWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => dies(world, 700), 30);
            });
            expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
            expect(w.sentOf('petCommand')).toHaveLength(1);
        });

        test('out of view it reaches nothing we can tell of', async () => {
            const { w, bot } = turretWorld({ nearbyNpcs: [mob()] });
            expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'out_of_range' });
            expect(w.sent).toEqual([]);
        });

        test('over an order\'s range from us we don\'t walk: it wouldn\'t follow (GamePlayer.cs:12186)', async () => {
            const { w, bot } = turretWorld({ nearbyNpcs: [petNpc({ x: 563000 }), mob({ x: 563300 })] });
            orders(w, (_a, world) => world.message('Your target is too far away to attack with your pet!'));
            expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'out_of_range' });
            expect(w.sentOf('moveTo')).toEqual([]);
            expect(w.sentOf('petCommand')).toHaveLength(1);
        });

        test('a mob that leaves its reach ends the fight at the next order', async () => {
            const { w, bot } = turretWorld();
            orders(w, (_a, world) => world.message(KILL));
            const realNow = Date.now.bind(Date);
            let skew = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
            try {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                w.npc(700)!.x = 561500;
                skew += 6000;
                expect(await killing).toMatchObject({ success: false, reason: 'out_of_range' });
                expect(w.sentOf('petCommand')).toHaveLength(1);
            } finally {
                clock.mockRestore();
            }
        });

        describe('its target leaving the reach while the model holds its aim, for up to about 7 s (TurretBrain.cs:9-18)', () => {
            const holdsAim = (w: FakeWorld) => orders(w, (_a, world) => {
                world.message(KILL);
                world.state.pet = petWindow({ icons: [turret.internalId], targetObjectId: 700 });
            });
            const skewed = async (run: (skew: (ms: number) => void) => Promise<void>) => {
                const realNow = Date.now.bind(Date);
                let skew = 0;
                const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
                try {
                    await run(ms => { skew += ms; });
                } finally {
                    clock.mockRestore();
                }
            };

            test('out_of_range after about 2 s beyond it, saying it left, and its order stands', async () => {
                const { w, bot } = turretWorld();
                holdsAim(w);
                await skewed(async skew => {
                    let ended = false;
                    const killing = bot.petKill(700, { timeout: 60_000 }).finally(() => { ended = true; });
                    await Bun.sleep(40);
                    w.npc(700)!.x = 561500;
                    await Bun.sleep(40);
                    skew(1500);
                    await Bun.sleep(40);
                    expect(ended).toBeFalse();
                    skew(1000);
                    const r = await killing;
                    expect(r).toMatchObject({ success: false, reason: 'out_of_range', killed: false });
                    expect(r.message).toContain('young wolf left the reach');
                    expect(r.message).toContain("grove's assailant");
                    expect(w.sentOf('petCommand')).toHaveLength(1);
                    expect(w.sentOf('moveTo')).toEqual([]);
                });
            });

            test('the mob itself on us changes nothing: the default call doesn\'t count it as an attacker', async () => {
                const { w, bot } = turretWorld();
                holdsAim(w);
                await skewed(async skew => {
                    const killing = bot.petKill(700, { timeout: 60_000 });
                    await Bun.sleep(40);
                    w.npc(700)!.x = 561500;
                    w.npc(700)!.targetObjectId = 100;
                    await Bun.sleep(40);
                    skew(2500);
                    expect(await killing).toMatchObject({ success: false, reason: 'out_of_range' });
                });
            });

            test('back in reach within the grace it fights on, and the grace starts over', async () => {
                const { w, bot } = turretWorld();
                holdsAim(w);
                await skewed(async skew => {
                    let ended = false;
                    const killing = bot.petKill(700, { timeout: 60_000, ignoreAttackers: true }).finally(() => { ended = true; });
                    await Bun.sleep(40);
                    w.npc(700)!.x = 561500;
                    await Bun.sleep(40);
                    skew(1500);
                    await Bun.sleep(40);
                    w.npc(700)!.x = 560500;
                    await Bun.sleep(40);
                    w.npc(700)!.x = 561500;
                    await Bun.sleep(40);
                    skew(1500);
                    await Bun.sleep(40);
                    expect(ended).toBeFalse();
                    w.npc(700)!.x = 560500;
                    await Bun.sleep(40);
                    dies(w, 700);
                    expect(await killing).toMatchObject({ success: true, killed: true });
                    expect(w.sentOf('petCommand')).toHaveLength(1);
                });
            });

            test('a pet that walks goes after it: no such end', async () => {
                const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ speed: 191 }), mob()] });
                await skewed(async skew => {
                    let ended = false;
                    const killing = bot.petKill(700, { timeout: 60_000 }).finally(() => { ended = true; });
                    await Bun.sleep(40);
                    w.npc(700)!.x = 561500;
                    await Bun.sleep(40);
                    skew(4000);
                    await Bun.sleep(40);
                    expect(ended).toBeFalse();
                    dies(w, 700);
                    expect(await killing).toMatchObject({ success: true, killed: true });
                });
            });
        });

        test('walk orders: reason immobile, the line kept, no settle wait; the order still goes out (GamePlayer.cs:12209)', async () => {
            const cases: [(bot: BotActions) => Promise<PetCommandResult>, PetCommand, string][] = [
                [bot => bot.petFollow(), 'follow', "You command the grove's assailant to follow you!"],
                [bot => bot.petStay(), 'stay', "You command the grove's assailant to stay in this position!"],
                [bot => bot.petComeHere(), 'comeHere', "You command the grove's assailant to come to you."],
                [bot => bot.petGoTo(700), 'goTarget', "You command the grove's assailant to go to your target."],
            ];
            for (const [order, command, line] of cases) {
                const { w, bot } = turretWorld();
                orders(w, (_a, world) => world.message(line));
                const t0 = Date.now();
                const r = await order(bot);
                expect(r).toMatchObject({ success: false, reason: 'immobile', command });
                expect(r.messages.map(m => m.text)).toContain(line);
                expect(Date.now() - t0).toBeLessThan(450); // the settle would add 500
                expect(w.sentOf('petCommand').map(a => a.command)).toEqual([command]);
            }
        });

        test('no answer to a walk order stays no_response', async () => {
            const { bot } = turretWorld();
            expect(await bot.petStay({ timeout: 60 })).toMatchObject({ success: false, reason: 'no_response' });
        });

        test('stance orders work as before', async () => {
            const { w, bot } = turretWorld();
            orders(w, (_a, world) => {
                world.message("You command the grove's assailant to disengage from combat!");
                world.state.pet = petWindow({ icons: [turret.internalId], aggression: 'passive' });
            });
            expect(await bot.setPetAggression('passive')).toMatchObject({ success: true, petState: { aggression: 'passive' } });
        });

        test('a pet that walks is no turret, whatever else is known', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum, charm) });
            orders(w, (_a, world) => world.message('You command the amber simulacrum to stay in this position!'));
            expect(await bot.petStay()).toMatchObject({ success: true });
        });
    });

    describe('the immobile message', () => {
        const hunter = (o: Partial<PetState> = {}) => petWindow({ objectId: 620, ...o });
        const loss = { objectId: 601, name: "forest's servant", cause: 'released' as const, at: 1 };

        test('out of view it names the pet by the answer line, not the last pet lost', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), nearbyNpcs: [], pet: hunter(), lastPetLoss: loss });
            orders(w, (_a, world) => world.message("You command the grove's hunter to follow you!"));
            const r = await bot.petFollow();
            expect(r).toMatchObject({ success: false, reason: 'immobile' });
            expect(r.message).toContain("grove's hunter");
            expect(r.message).not.toContain("forest's servant");
        });

        test('with no name to go by it says our turret', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), nearbyNpcs: [], pet: hunter(), lastPetLoss: loss });
            orders(w, (_a, world) => { world.state.pet = hunter({ walk: 'stay' }); });
            const r = await bot.petStay();
            expect(r).toMatchObject({ success: false, reason: 'immobile' });
            expect(r.message).toStartWith('Our turret');
            expect(r.message).not.toContain("forest's servant");
        });

        test('a release still names what it released', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [], pet: hunter(), lastPetLoss: loss });
            orders(w, (_a, world) => { world.state.pet = null; world.state.lastPetLoss = { ...loss, objectId: 620, name: "grove's hunter" }; });
            expect((await bot.releasePet()).message).toBe("Released the grove's hunter");
        });
    });

    describe('what a kill reports', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        const NO_XP = 'You gain no experience from this kill!';

        test('no XP ends the settling at once: it would wait 2.4 s for a line that won\'t come (AbstractServerRules.cs:1019-1022)', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => {
                    world.removeNpc(700);
                    world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                    world.message(NO_XP);
                }, 20);
            });
            const t0 = Date.now();
            expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true, xpGained: 0 });
            expect(Date.now() - t0).toBeLessThan(1000);
        });

        test('nor does a recently charmed mob pay (AbstractServerRules.cs:1082-1085)', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => {
                    world.removeNpc(700);
                    world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                    world.message('This monster has been charmed recently and is worth no experience.');
                }, 20);
            });
            const t0 = Date.now();
            expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true, xpGained: 0 });
            expect(Date.now() - t0).toBeLessThan(1000);
        });

        test('durationMs stops at the death, not at the settling', async () => {
            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => {
                    world.removeNpc(700);
                    world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                }, 20);
                setTimeout(() => world.message('You get 5 experience points.', { type: 'important' }), 300);
            });
            const t0 = Date.now();
            const r = await bot.petKill(700);
            const took = Date.now() - t0;
            expect(r).toMatchObject({ success: true, xpGained: 5 });
            expect(took).toBeGreaterThanOrEqual(600); // the XP at 300, then 400 for the loot
            expect(r.durationMs).toBeLessThan(took - 300);
            expect(r.message).toContain(`in ${(r.durationMs / 1000).toFixed(1)}s`);
        });

        test('a melee fight sends attack off before it settles, and only once', async () => {
            const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ x: 560050 })] });
            let offAtXp: boolean[] = [];
            w.onTick = world => {
                const npc = world.npc(700);
                if (!world.player.attacking || !npc) return;
                world.removeNpc(700);
                world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                setTimeout(() => {
                    offAtXp = world.sentOf('attack').map(a => a.on);
                    world.message('You get 5 experience points.', { type: 'important' });
                }, 200);
            };
            expect(await bot.killNpc(700)).toMatchObject({ success: true, xpGained: 5 });
            expect(offAtXp).toEqual([true, false]);
            expect(w.sentOf('attack').map(a => a.on)).toEqual([true, false]);
        });

        test('useStyle: a pet\'s styled hit reads the same, so the line must name our style (AttackComponent.cs:1785-1789)', async () => {
            const { w, bot } = world();
            w.handlers.useSkill = (_a, world) => { setTimeout(() => world.message('You perform your Havoc perfectly!  (+16, GR: 0.722)', { type: 'youHit' }), 10); };
            expect(await bot.useStyle('Backslash')).toMatchObject({ success: false, reason: 'no_response' });
            w.handlers.useSkill = (_a, world) => { setTimeout(() => world.message('You perform your Backslash perfectly!  (+3, GR: 0.5)', { type: 'youHit' }), 10); };
            expect(await bot.useStyle('Backslash')).toMatchObject({ success: true });
        });

        test('releaseAndRespawn waits for health above 0: it trails the position', async () => {
            const { w, bot, sdk } = world({ player: makePlayer({ isDead: true, healthPercent: 0, health: 0 }) });
            w.handlers.release = (_a, world) => {
                setTimeout(() => { world.player.isDead = false; world.player.x += 5000; }, 10);
                setTimeout(() => { world.player.healthPercent = 20; world.player.health = 20; }, 120);
            };
            expect(await bot.releaseAndRespawn()).toMatchObject({ success: true });
            expect(sdk.getPlayer()!.healthPercent).toBe(20);
        });
    });

    describe('a Necromancer in shade', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        const shade = (o: Partial<BotWorldState> = {}) => petWorld({ player: makePlayer({ isShade: true }), ...o });
        /** The server: answers an attack order, and the mob dies `after` ms on. */
        const ordersKill = (w: FakeWorld, after = 40) => orders(w, (a, world) => {
            if (a.command !== 'attack') return;
            world.message(KILL);
            setTimeout(() => dies(world, a.targetObjectId!), after);
        });
        const DROP_WARNING = 'Your servant is too far from you and will be lost in 10 seconds or immediately if you move further away.';

        describe('it can\'t melee (ClassDisciple.cs:85-94)', () => {
            test('killNpc hands the fight to the pet: no walk into melee, no swing', async () => {
                const { w, bot } = shade();
                ordersKill(w);
                const r = await bot.killNpc('young wolf');
                expect(r).toMatchObject({ success: true, killed: true, npc: { objectId: 700 }, xpGained: 1 });
                expect(w.sentOf('petCommand').map(a => [a.command, a.targetObjectId])).toEqual([['attack', 700]]);
                expect(w.sentOf('attack')).toEqual([]);
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('killNpc keeps petKill\'s failures: the pet going, and no pet', async () => {
                const gone = shade();
                orders(gone.w, (_a, world) => {
                    world.message(KILL);
                    setTimeout(() => {
                        world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'died', at: Date.now() };
                        world.state.pet = null;
                    }, 30);
                });
                expect(await gone.bot.killNpc(700)).toMatchObject({ success: false, reason: 'pet_died', killed: false, npc: { objectId: 700 } });
                expect(gone.w.sentOf('attack')).toEqual([]);

                const none = shade({ pet: null, nearbyNpcs: [mob()] });
                expect(await none.bot.killNpc(700)).toMatchObject({ success: false, reason: 'no_pet', npc: { objectId: 700 } });
                expect(none.w.sentOf('moveTo')).toEqual([]);
            });

            test('killNpc checks the target first: what we can\'t kill gets no order', async () => {
                const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ realm: 'midgard' })] });
                expect(await bot.killNpc(700)).toMatchObject({ success: false, reason: 'not_attackable', npc: { objectId: 700 } });
                expect(w.sentOf('petCommand')).toEqual([]);
            });

            test('usePet: false is refused before any walk, naming the shade', async () => {
                const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ x: 562000 })] });
                const r = await bot.killNpc(700, { usePet: false });
                expect(r).toMatchObject({ success: false, reason: 'refused', killed: false, npc: { objectId: 700 } });
                expect(r.message).toContain('shade');
                expect(w.sent).toEqual([]);
            });

            test('attack is refused before any walk, naming the shade', async () => {
                const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ x: 562000 })] });
                const r = await bot.attack(700);
                expect(r).toMatchObject({ success: false, reason: 'refused', npc: { objectId: 700 }, target: { objectId: 700 } });
                expect(r.message).toContain('shade');
                expect(w.sent).toEqual([]);
            });

            test('killPlayer is refused before any walk, like attack', async () => {
                const { w, bot } = shade({ nearbyPlayers: [makePlayerObj({ objectId: 300, realm: 'midgard', x: 562000 })] });
                const r = await bot.killPlayer(300);
                expect(r).toMatchObject({ success: false, reason: 'refused', killed: false, player: { objectId: 300 } });
                expect(r.message).toContain('shade');
                expect(w.sent).toEqual([]);
            });

            test('out of shade, or on an older client, the melee goes as ever', async () => {
                for (const player of [makePlayer({ isShade: false }), makePlayer()]) {
                    const { w, bot } = world({ pet: null, player, nearbyNpcs: [mob({ x: 560050 })] });
                    expect(await bot.attack(700)).toMatchObject({ success: true });
                    expect(w.sentOf('attack').map(a => a.on)).toEqual([true]);
                }
            });
        });

        describe('the tether (NecromancerPetBrain.cs:300-326)', () => {
            /** Our distance to the mob when each order goes out. */
            const orderDistances = (w: FakeWorld, after = 40): number[] => {
                const seen: number[] = [];
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    seen.push(Math.hypot(world.npc(700)!.x - world.player.x, world.npc(700)!.y - world.player.y));
                    world.message(KILL);
                    setTimeout(() => dies(world, 700), after);
                });
                return seen;
            };

            test('petKill walks within 1000 before it orders, though the order would reach from 2000: the servant fights at the mob', async () => {
                const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ x: 561765 })] });
                const seen = orderDistances(w);
                expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
                expect(w.sentOf('moveTo').length).toBeGreaterThan(0);
                expect(seen).toHaveLength(1);
                expect(seen[0]!).toBeLessThanOrEqual(1100);
                expect(seen[0]!).toBeGreaterThanOrEqual(900);
            });

            test('within 1000 nothing walks', async () => {
                const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ x: 560900 })] });
                orderDistances(w);
                expect(await bot.petKill(700)).toMatchObject({ success: true });
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('out of shade the order range still decides: no walk from 1765', async () => {
                const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 561765 })] });
                orderDistances(w);
                expect(await bot.petKill(700)).toMatchObject({ success: true });
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('approach: false stays put, and the caller has the tether to mind', async () => {
                const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ x: 561765 })] });
                orderDistances(w);
                expect(await bot.petKill(700, { approach: false })).toMatchObject({ success: true });
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('a servant over 1200 away: we step toward it and stay well short of it; the standing order is not repeated', async () => {
                const { w, bot } = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561500 }), mob({ x: 561550 })] });
                setTimeout(() => dies(w, 700), 200);
                expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
                expect(w.sentOf('moveTo').length).toBeGreaterThan(0);
                const away = 561500 - w.player.x;
                expect(away).toBeLessThanOrEqual(1100);
                expect(away).toBeGreaterThanOrEqual(900);
                expect(w.sentOf('petCommand')).toEqual([]);
            });

            test('the warning makes us step from nearer too; without it, nothing below 1200 does', async () => {
                const warned = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561150 }), mob({ x: 561200 })] });
                setTimeout(() => warned.w.message(DROP_WARNING), 40);
                setTimeout(() => dies(warned.w, 700), 200);
                expect(await warned.bot.petKill(700)).toMatchObject({ success: true });
                expect(warned.w.sentOf('moveTo').length).toBeGreaterThan(0);
                expect(561150 - warned.w.player.x).toBeLessThanOrEqual(1100);

                const quiet = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561150 }), mob({ x: 561200 })] });
                setTimeout(() => dies(quiet.w, 700), 200);
                expect(await quiet.bot.petKill(700)).toMatchObject({ success: true });
                expect(quiet.w.sentOf('moveTo')).toEqual([]);
            });

            test('a pet that isn\'t a servant has no tether', async () => {
                const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561500 }), mob({ x: 561550 })] });
                setTimeout(() => dies(w, 700), 120);
                expect(await bot.petKill(700)).toMatchObject({ success: true });
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('approach: false takes no step either', async () => {
                const { w, bot } = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561500 }), mob({ x: 561550 })] });
                setTimeout(() => w.message(DROP_WARNING), 20);
                setTimeout(() => dies(w, 700), 120);
                expect(await bot.petKill(700, { approach: false })).toMatchObject({ success: true });
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('a step that gets nowhere leaves the fight watched: the death ends it soon after', async () => {
                const { w, bot } = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561500 }), mob({ x: 561550 })] });
                w.stepSize = 0;
                setTimeout(() => dies(w, 700), 100);
                const t0 = Date.now();
                expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
                expect(Date.now() - t0).toBeLessThan(3000);
                expect(w.state.movement.moving).toBeFalse();
            });

            describe('with no way for us to walk', () => {
                const noWay: PathProvider = { name: 'no way', findPath: () => ({ success: false, waypoints: [], message: 'no path' }) };
                afterEach(() => setDefaultPathProvider(new StraightLinePathProvider()));

                test('the order still goes from where we stand: it reaches 2000, and the servant has a way of its own', async () => {
                    setDefaultPathProvider(noWay);
                    const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ x: 561765 })] });
                    ordersKill(w);
                    expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
                    expect(w.sentOf('petCommand').map(a => a.command)).toEqual(['attack']);
                });

                test('beyond the order\'s reach that ends it, as for any pet', async () => {
                    setDefaultPathProvider(noWay);
                    const { w, bot } = shade({ nearbyNpcs: [petNpc(), mob({ x: 562500 })] });
                    expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'no_path' });
                    expect(w.sentOf('petCommand')).toEqual([]);
                });

                test('a servant we can\'t step after doesn\'t hold up the order', async () => {
                    setDefaultPathProvider(noWay);
                    const { w, bot } = shade({ nearbyNpcs: [petNpc({ x: 561500 }), mob({ x: 561550 })] });
                    ordersKill(w);
                    expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
                    expect(w.sentOf('petCommand').map(a => a.command)).toEqual(['attack']);
                });
            });

            const lost = (w: FakeWorld, cause: 'released' | 'died', line?: string) => setTimeout(() => {
                if (line) w.message(line);
                w.state.lastPetLoss = { objectId: PET_ID, name: 'necroservant', cause, at: Date.now() };
                w.state.pet = null;
            }, 40);

            test('losing it to the soft limit says tether: the bond line (AI.txt:10)', async () => {
                const { w, bot } = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 560800 }), mob({ x: 560850 })] });
                lost(w, 'released', 'You have lost your bond to your servant.');
                const r = await bot.petKill(700);
                expect(r).toMatchObject({ success: false, reason: 'pet_died', killed: false });
                expect(r.message).toContain('tether');
            });

            test('losing it to the hard limit says tether: no line, and it reads as a release (NecromancerPet.cs CutTether), from far off', async () => {
                const { w, bot } = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561900 }), mob({ x: 561950 })] });
                lost(w, 'released');
                const r = await bot.petKill(700, { approach: false });
                expect(r).toMatchObject({ success: false, reason: 'pet_died' });
                expect(r.message).toContain('tether');
            });

            test('a death, or a release nearby, doesn\'t: the warning that came before says nothing of it', async () => {
                const died = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561900 }), mob({ x: 561950 })] });
                died.w.message(DROP_WARNING);
                lost(died.w, 'died');
                const r = await died.bot.petKill(700, { approach: false });
                expect(r).toMatchObject({ success: false, reason: 'pet_died' });
                expect(r.message).toContain('(died)');
                expect(r.message).not.toContain('tether');

                const near = shade({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 560800 }), mob({ x: 560850 })] });
                lost(near.w, 'released');
                const released = await near.bot.petKill(700);
                expect(released.message).toContain('(released)');
                expect(released.message).not.toContain('tether');
            });
        });

        describe('its servant\'s spells', () => {
            // spell.sql: a PetSpell row, owner instant, the servant casts 3 s.
            const glimpse = spellOf('Glimpse of Fate', 9001);
            const QUEUED = 'The zombie servant will begin casting this spell after its current action is finished.';
            const lines = (w: FakeWorld, ...timed: [number, string][]) => {
                w.handlers.castSpell = (_a, world) => { for (const [ms, text] of timed) setTimeout(() => world.message(text, { type: 'spell' }), ms); };
            };

            test('the queue line alone is no promise: queued, and not completed (NecromancerPetBrain.cs:124, CastingComponent.cs:383-386)', async () => {
                const { w, bot } = shade({ skills: skillsWith(glimpse) });
                lines(w, [10, QUEUED]);
                const r = await bot.castSpell(glimpse, 700);
                expect(r).toMatchObject({ success: true, queued: true, completed: false, damage: 0, resisted: false, target: { objectId: 700 } });
                expect(r.message).toContain('queued');
                expect(r.message).toContain('replaces');
                expect(r.messages.map(m => m.text)).toEqual([QUEUED]);
            });

            test('a hit that came with it was an earlier spell\'s', async () => {
                const { w, bot } = shade({ skills: skillsWith(glimpse) });
                lines(w, [10, QUEUED], [20, 'You hit the young wolf for 116 damage!']);
                expect(await bot.castSpell(glimpse, 700)).toMatchObject({ success: true, queued: true, damage: 0 });
            });

            test('with a sign of the servant casting it, it isn\'t queued', async () => {
                const named = shade({ skills: skillsWith(glimpse) });
                lines(named.w, [10, QUEUED], [40, 'The zombie servant begins casting a Glimpse of Fate spell!']);
                const r = await named.bot.castSpell(glimpse, 700);
                expect(r).toMatchObject({ success: true, completed: true });
                expect(r.queued).toBeUndefined();
                expect(r.message).not.toContain('queued');

                const plain = shade({ skills: skillsWith(glimpse) });
                lines(plain.w, [10, 'The zombie servant begins casting the spell!']);
                expect((await plain.bot.castSpell(glimpse, 700)).queued).toBeUndefined();

                const animated = shade({ skills: skillsWith(glimpse) });
                animated.w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => world.message(QUEUED, { type: 'spell' }), 10);
                    setTimeout(() => world.combat({ kind: 'spellCast', attackerObjectId: PET_ID, targetObjectId: null, castTimeMs: 3000 }), 40);
                };
                expect((await animated.bot.castSpell(glimpse, 700)).queued).toBeUndefined();
            });

            test('another spell\'s line doesn\'t count: it is still queued', async () => {
                const { w, bot } = shade({ skills: skillsWith(glimpse) });
                lines(w, [10, QUEUED], [30, 'The zombie servant cast a Vitality Theft spell!']);
                expect(await bot.castSpell(glimpse, 700)).toMatchObject({ success: true, queued: true });
            });

            test('the line at the servant\'s death or release has no spell behind it (NpcAttackAction.cs:238-239): no_pet', async () => {
                const { w, bot } = shade({ skills: skillsWith(glimpse) });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => { world.state.pet = null; world.message(QUEUED, { type: 'spell' }); }, 10);
                };
                const r = await bot.castSpell(glimpse, 700);
                expect(r).toMatchObject({ success: false, reason: 'no_pet', completed: false });
                expect(r.queued).toBeUndefined();
            });

            test('a refusal right behind an earlier cast\'s line is the answer: no_power, not success', async () => {
                const { w, bot } = shade({ skills: skillsWith(glimpse) });
                lines(w, [10, 'The zombie servant cast a Glimpse of Fate spell!'], [40, "You don't have enough power to cast that!"]);
                const r = await bot.castSpell(glimpse, 700);
                expect(r).toMatchObject({ success: false, reason: 'no_power', completed: false });
                expect(r.messages).toHaveLength(2);
            });

            test('the same for a refusal behind the queue line', async () => {
                const { w, bot } = shade({ skills: skillsWith(glimpse) });
                lines(w, [10, QUEUED], [40, "You don't have enough power to cast that!"]);
                expect(await bot.castSpell(glimpse, 700)).toMatchObject({ success: false, reason: 'no_power' });
            });

            test('the servant\'s refusals answer at once, with their reasons', async () => {
                const cases: [string, string][] = [
                    ['Your servant is too far away from your target to cast that spell!', 'out_of_range'],
                    ['You cannot transfer power to yourself!', 'invalid_target'],
                    ["Your controlled zombie servant can't see its target!", 'out_of_range'],
                ];
                for (const [text, reason] of cases) {
                    const { w, bot } = shade({ skills: skillsWith(glimpse) });
                    lines(w, [10, text]);
                    const t0 = Date.now();
                    expect(await bot.castSpell(glimpse, 700)).toMatchObject({ success: false, reason, message: text });
                    expect(Date.now() - t0).toBeLessThan(1000);
                }
            });
        });

        describe('an Enemy spell with no target given', () => {
            const glimpse = spellOf('Glimpse of Fate', 9001);
            // The servant's new target becomes ours when we have none (NecromancerPet.cs:27-29), and then: "You can't attack yourself!".
            test.each([['our pet', PET_ID], ['ourselves', 100], ['a summon', SPIRIT_ID]])('no_target with %s selected, and nothing cast', async (_who, selected) => {
                const { w, bot } = petWorld({
                    player: makePlayer({ isShade: true, targetObjectId: selected as number }), skills: skillsWith(glimpse),
                    summons: [SPIRIT_ID], nearbyNpcs: [petNpc(), spirit(), mob()],
                });
                const r = await bot.castSpell(glimpse);
                expect(r).toMatchObject({ success: false, reason: 'no_target', spell: { name: glimpse.name } });
                expect(w.sentOf('castSpell')).toEqual([]);
                expect(w.sentOf('setTarget')).toEqual([]);
            });

            test('with a mob selected it goes, as with the pet selected and the mob named', async () => {
                const selected = petWorld({ player: makePlayer({ targetObjectId: 700 }), skills: skillsWith(glimpse) });
                selected.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The zombie servant begins casting a Glimpse of Fate spell!', { type: 'spell' }), 10); };
                expect(await selected.bot.castSpell(glimpse)).toMatchObject({ success: true, target: { objectId: 700 } });

                const named = petWorld({ player: makePlayer({ targetObjectId: PET_ID }), skills: skillsWith(glimpse) });
                named.w.handlers.castSpell = selected.w.handlers.castSpell;
                expect(await named.bot.castSpell(glimpse, 700)).toMatchObject({ success: true, target: { objectId: 700 } });
                expect(named.w.player.targetObjectId).toBe(700);
            });

            test('a spell on a friend or on the pet still takes the pet selected', async () => {
                const heal = spellOf('Minor Rejuvenation', 1301);
                const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: PET_ID }), skills: skillsWith(heal) });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(`You cast a ${heal.name} spell!`, { type: 'spell' }), 5); };
                expect((await bot.castSpell(heal)).reason).not.toBe('no_target');
                expect(w.sentOf('castSpell')).toHaveLength(1);
            });
        });
    });

    describe('a pet that isn\'t getting to its mob', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        const FOLLOW = 'You command the amber simulacrum to follow you!';
        /** The server's answers, and what the model then holds: an attack order sets the pet's target, a follow clears it. */
        const answers = (w: FakeWorld) => orders(w, (a, world) => {
            if (a.command === 'attack') {
                world.message(KILL);
                world.state.pet = petWindow({ targetObjectId: a.targetObjectId ?? null });
            } else if (a.command === 'follow') {
                world.message(FOLLOW);
                world.state.pet = petWindow();
            }
        });
        const skewed = async (run: (skew: (ms: number) => void) => Promise<void>) => {
            const realNow = Date.now.bind(Date);
            let by = 0;
            const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + by);
            try {
                await run(ms => { by += ms; });
            } finally {
                clock.mockRestore();
            }
        };
        const commands = (w: FakeWorld) => w.sentOf('petCommand').map(a => a.command);

        test('speed 0, over 200 from the mob and nothing with it for over 8 s: out_of_reach, and a follow frees it (NpcMovementComponent.cs:594-600)', async () => {
            const { w, bot } = petWorld();
            answers(w);
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                skew(7800);
                await Bun.sleep(40);
                expect(commands(w)).toEqual(['attack']);
                skew(400);
                expect(await killing).toMatchObject({ success: false, killed: false, reason: 'out_of_reach', message: "Our pet isn't getting to young wolf", npc: { objectId: 700 } });
                expect(commands(w)).toEqual(['attack', 'follow']);
            });
            expect(w.state.pet?.targetObjectId).toBeNull();
        });

        test('rest finds no fight after that', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ healthPercent: 100, health: 100 }) });
            answers(w);
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                expect((await bot.rest()).reason).toBe('in_combat');
                skew(8200);
                expect(await killing).toMatchObject({ reason: 'out_of_reach' });
                expect(await bot.rest()).toMatchObject({ success: true });
            });
        });

        const evidence: [string, (w: FakeWorld) => void][] = [
            ['its swing (0xBC)', w => w.combat({ kind: 'melee', attackerObjectId: PET_ID, targetObjectId: 700, result: 'miss' })],
            ['a swing at it (0xBC)', w => w.combat({ kind: 'melee', attackerObjectId: 701, targetObjectId: PET_ID, result: 'hit' })],
            ['its cast (0x1B): a caster stands', w => w.combat({ kind: 'spellEffect', attackerObjectId: PET_ID, targetObjectId: 700, effectId: 1 })],
            ['a spell on it (0x1B): a mezz at its start', w => w.combat({ kind: 'spellEffect', attackerObjectId: 701, targetObjectId: PET_ID, effectId: 1 })],
            ['the mob losing health', w => { w.npc(700)!.healthPercent -= 1; }],
            ['it moving', w => { w.npc(PET_ID)!.speed = 191; }],
            ['a new spot, though it reads speed 0', w => { w.npc(PET_ID)!.x += 40; }],
        ];
        for (const [what, happens] of evidence) {
            test(`${what} starts the clock again`, async () => {
                const { w, bot } = petWorld();
                answers(w);
                await skewed(async skew => {
                    const killing = bot.petKill(700, { timeout: 60_000 });
                    await Bun.sleep(40);
                    skew(7000);
                    await Bun.sleep(40);
                    happens(w);
                    await Bun.sleep(40);
                    w.npc(PET_ID)!.speed = 0;
                    await Bun.sleep(40);
                    skew(7000);
                    await Bun.sleep(40);
                    expect(commands(w)).toEqual(['attack']);
                    // And it runs from there.
                    skew(1200);
                    expect(await killing).toMatchObject({ reason: 'out_of_reach' });
                });
            });
        }

        test('nearer than 200 it is at the mob; so is one out of view, as far as we can tell', async () => {
            for (const o of [{ nearbyNpcs: [petNpc({ x: 560400 }), mob()] }, { nearbyNpcs: [mob()] }]) {
                const { w, bot } = petWorld(o);
                answers(w);
                await skewed(async skew => {
                    const killing = bot.petKill(700, { timeout: 60_000 });
                    await Bun.sleep(40);
                    skew(9000);
                    await Bun.sleep(40);
                    expect(commands(w)).toEqual(['attack']);
                    dies(w, 700);
                    expect(await killing).toMatchObject({ killed: true });
                });
            }
        });

        test('the 200 is in 3D: the water snake stood below, on the same spot of the map', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc({ x: 560450, z: 3300 }), mob()] });
            answers(w);
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                skew(8200);
                expect(await killing).toMatchObject({ reason: 'out_of_reach' });
            });
        });

        test('a mob regaining health is no fight: nothing has hit it', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 60 })] });
            answers(w);
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                skew(7000);
                w.npc(700)!.healthPercent = 65;
                await Bun.sleep(40);
                skew(1200);
                expect(await killing).toMatchObject({ reason: 'out_of_reach' });
            });
        });

        test('an order standing from an earlier pass runs the same clock, with no order of its own', async () => {
            const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 700 }) });
            answers(w);
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                skew(8200);
                expect(await killing).toMatchObject({ reason: 'out_of_reach' });
                expect(commands(w)).toEqual(['follow']);
            });
        });

        test('orders don\'t start the clock again: one every 5 s would keep it from ever running out', async () => {
            const { w, bot } = petWorld();
            answers(w);
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                w.state.pet = petWindow();
                await Bun.sleep(40);
                skew(5100);
                await Bun.sleep(40);
                expect(commands(w)).toEqual(['attack', 'attack']);
                skew(3100);
                expect(await killing).toMatchObject({ reason: 'out_of_reach' });
                expect(commands(w)).toEqual(['attack', 'attack', 'follow']);
            });
        });

        test('not for a turret: it has the reach check, and doesn\'t walk', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(turret), pet: petWindow({ icons: [turret.internalId] }), nearbyNpcs: [petNpc({ name: "grove's assailant" }), mob()] });
            orders(w, (_a, world) => {
                world.message("You command the grove's assailant to kill your target!");
                world.state.pet = petWindow({ icons: [turret.internalId], targetObjectId: 700 });
            });
            await skewed(async skew => {
                const killing = bot.petKill(700, { timeout: 60_000 });
                await Bun.sleep(40);
                skew(9000);
                await Bun.sleep(40);
                expect(commands(w)).toEqual(['attack']);
                dies(w, 700);
                expect(await killing).toMatchObject({ killed: true });
            });
        });

        test('grind takes the failure path: a failure, that mob avoided, and the next one fought', async () => {
            const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, name: 'water beetle', x: 560700 })] });
            orders(w, (a, world) => {
                if (a.command === 'attack') {
                    world.message(KILL);
                    world.state.pet = petWindow({ targetObjectId: a.targetObjectId ?? null });
                    if (a.targetObjectId === 701) setTimeout(() => dies(world, 701), 40);
                } else if (a.command === 'follow') {
                    world.message(FOLLOW);
                    world.state.pet = petWindow();
                }
            });
            await skewed(async skew => {
                const grinding = bot.grind({ pet: true, maxKills: 1, durationMs: 60_000, loot: false });
                await Bun.sleep(80);
                skew(8200);
                expect(await grinding).toMatchObject({ kills: 1, failures: 1 });
            });
            expect(w.sentOf('petCommand').map(a => [a.command, a.targetObjectId])).toEqual([['attack', 700], ['follow', undefined], ['attack', 701]]);
        });
    });

    describe('petKill\'s small print', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';

        test('pet_died gives the mob\'s health from the snapshot that shows the pet gone: the last swing comes in that one', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 70 })] });
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => {
                    world.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: 'died', at: Date.now() };
                    world.state.pet = null;
                    world.npc(700)!.healthPercent = 56;
                }, 30);
            });
            const r = await bot.petKill(700);
            expect(r).toMatchObject({ reason: 'pet_died' });
            expect(r.message).toBe('Our pet is gone (died) with young wolf at 56% health');
        });

        test('a mob on us before any order: the message says the pet got none', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, name: 'water beetle', targetObjectId: 100 })] });
            expect(await bot.petKill(700)).toMatchObject({ reason: 'attacked', message: 'water beetle is on us: our pet got no order' });
            expect(w.sentOf('petCommand')).toEqual([]);
        });

        test('with an order standing from an earlier pass it does fight', async () => {
            const { bot } = petWorld({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, name: 'water beetle', targetObjectId: 100 })] });
            expect(await bot.petKill(700)).toMatchObject({ reason: 'attacked', message: 'water beetle is on us while our pet fights young wolf' });
        });

        test('a second mob on the pet, with its DoT ticking on us, isn\'t on us: the fight goes on', async () => {
            const { w, bot } = petWorld({ pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, x: 560100, targetObjectId: PET_ID })] });
            w.combat({ kind: 'melee', attackerObjectId: 701, targetObjectId: w.player.objectId, result: 'other', targetHealthPercent: 90 });
            w.publish();
            expect((await bot.petKill(700, { timeout: 200 })).reason).not.toBe('attacked');
        });

        test('two mobs with one name read by level and id', async () => {
            const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ objectId: 23155, name: 'bandit', level: 7 }), mob({ objectId: 23108, name: 'bandit', level: 5 })] });
            orders(w, (_a, world) => {
                world.message(KILL);
                world.state.pet = petWindow({ targetObjectId: 23155 });
                setTimeout(() => { world.npc(23108)!.targetObjectId = 100; }, 30);
            });
            expect(await bot.petKill(23155)).toMatchObject({ reason: 'attacked', message: 'bandit L5 #23108 is on us while our pet fights bandit L7 #23155' });
        });

        test('a swing the caller started stays: attack off only for one the fight sent', async () => {
            const onUs = petWorld({ player: makePlayer({ attacking: true, targetObjectId: 701 }), nearbyNpcs: [petNpc(), mob(), mob({ objectId: 701, name: 'water beetle', targetObjectId: 100 })] });
            expect(await onUs.bot.petKill(700)).toMatchObject({ reason: 'attacked' });
            expect(onUs.w.sentOf('attack')).toEqual([]);
            expect(onUs.w.player.attacking).toBeTrue();

            const killed = petWorld({ player: makePlayer({ attacking: true, targetObjectId: 701 }) });
            orders(killed.w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => dies(world, 700), 30);
            });
            expect(await killed.bot.petKill(700)).toMatchObject({ killed: true });
            expect(killed.w.sentOf('attack')).toEqual([]);
        });

        test('our own melee fight still ends with attack off, even one the snapshot alone shows', async () => {
            const { w, bot } = world({ player: makePlayer({ attacking: true, targetObjectId: 201 }), nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
            fightSim(w);
            expect(await bot.killNpc(201)).toMatchObject({ killed: true });
            expect(w.sentOf('attack').at(-1)).toMatchObject({ on: false });
        });

        test('our own pet is no target: not_attackable before anything goes out, our target unmoved', async () => {
            const windowed = petWorld({ player: makePlayer({ targetObjectId: 700 }) });
            for (const r of [await windowed.bot.petAttack(PET_ID), await windowed.bot.petAttack(petNpc()), await windowed.bot.petKill(PET_ID)]) {
                expect(r).toMatchObject({ success: false, reason: 'not_attackable' });
                expect(r.message).toContain('amber simulacrum');
            }
            expect(windowed.w.sent).toEqual([]);
            expect(windowed.w.player.targetObjectId).toBe(700);

            const summon = petWorld({ summons: [SPIRIT_ID], nearbyNpcs: [petNpc(), spirit(), mob()] });
            expect(await summon.bot.petAttack(SPIRIT_ID)).toMatchObject({ success: false, reason: 'not_attackable' });
            expect(summon.w.sent).toEqual([]);
        });

        describe('a release whose entry stays in view', () => {
            /** The close, then the 0xDA with its realm a little later (CharmECSEffect.cs:100-111). */
            const charmed = (w: FakeWorld, after: number | null) => orders(w, (_a, world) => {
                world.state.pet = null;
                world.npc(PET_ID)!.isPet = false;
                if (after !== null) setTimeout(() => { world.npc(PET_ID)!.realm = 'none'; }, after);
            });

            test('waits for its realm to read none: a killable check has to find it so', async () => {
                const { w, bot } = petWorld();
                charmed(w, 60);
                const r = await bot.releasePet();
                expect(r).toMatchObject({ success: true, pet: { objectId: PET_ID, isPet: false, realm: 'none' }, petState: null });
                expect(bot.findKillableNpcs({ radius: 1000 }).map(n => n.objectId)).toContain(PET_ID);
            });

            test('or for the entry to go', async () => {
                const { w, bot } = petWorld();
                orders(w, (_a, world) => {
                    world.state.pet = null;
                    setTimeout(() => world.removeNpc(PET_ID), 60);
                });
                expect(await bot.releasePet()).toMatchObject({ success: true, pet: null, petState: null });
            });

            test('for PET_SETTLE_MS at most', async () => {
                const { w, bot } = petWorld();
                charmed(w, null);
                const t0 = Date.now();
                expect(await bot.releasePet()).toMatchObject({ success: true, pet: { objectId: PET_ID, realm: 'albion' } });
                expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
                expect(Date.now() - t0).toBeLessThan(1000);
            });

            test('with the entry gone already there is no wait', async () => {
                const { w, bot } = petWorld();
                orders(w, (_a, world) => {
                    world.removeNpc(PET_ID);
                    world.state.pet = null;
                });
                const t0 = Date.now();
                expect(await bot.releasePet()).toMatchObject({ success: true });
                expect(Date.now() - t0).toBeLessThan(300);
            });
        });

        test('a release with the pet already our target sends no 0xB0: its answer is an 0xA1 built before the release (PlayerTargetHandler.cs:56, PacketProcessor.cs:273-274)', async () => {
            const { w, bot } = petWorld({ player: makePlayer({ targetObjectId: PET_ID }) });
            orders(w, (_a, world) => {
                world.removeNpc(PET_ID);
                world.state.pet = null;
            });
            expect(await bot.releasePet()).toMatchObject({ success: true });
            expect(w.sentOf('petCommand')[0]!.targetObjectId).toBeUndefined();
            expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([null]);
        });
    });

    describe('killNpc with no weapon', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        const bare: Partial<BotWorldState> = { equipment: [] };
        const armour = { slot: 25, name: 'quilted vest', level: 1, count: 1, model: 3, objectType: 32, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 };

        test('refused at once, with no walk and no swing (the server says so only at the first swing, AttackComponent.cs:548)', async () => {
            const { w, bot } = world({ equipment: [armour], pet: null, nearbyNpcs: [mob({ x: 561300 })] });
            const t0 = Date.now();
            const r = await bot.killNpc(700);
            expect(r).toMatchObject({ success: false, killed: false, reason: 'refused', npc: { objectId: 700 } });
            expect(r.message).toContain('no weapon');
            expect(r.message).not.toContain('pet');
            expect(Date.now() - t0).toBeLessThan(200);
            expect(w.sent).toEqual([]);
        });

        test('a usable pet still gets its order, and the message says it fights on; npc reads as of now', async () => {
            const { w, bot } = petWorld(bare);
            orders(w, (_a, world) => {
                world.npc(700)!.healthPercent = 84;
                world.message(KILL);
            });
            const r = await bot.killNpc(700);
            expect(r).toMatchObject({ success: false, reason: 'refused', npc: { objectId: 700, healthPercent: 84 } });
            expect(r.message).toContain('our pet fights on');
            expect(w.sentOf('petCommand').map(a => [a.command, a.targetObjectId])).toEqual([['attack', 700]]);
            expect(w.sentOf('moveTo')).toEqual([]);
            expect(w.sentOf('attack')).toEqual([]);
        });

        test('one already on that mob gets no second order', async () => {
            const { w, bot } = petWorld({ ...bare, pet: petWindow({ targetObjectId: 700 }) });
            expect((await bot.killNpc(700)).message).toContain('our pet fights on');
            expect(w.sentOf('petCommand')).toEqual([]);
        });

        test('no order, and no such word: usePet false, a passive pet, a mob beyond an order\'s range, an order refused', async () => {
            const cases: [Partial<BotWorldState>, Parameters<BotActions['killNpc']>[1], string | null][] = [
                [{}, { usePet: false }, null],
                [{ pet: petWindow({ aggression: 'passive' }) }, {}, null],
                [{ nearbyNpcs: [petNpc(), mob({ x: 562500 })] }, {}, null],
                [{}, {}, 'Your target is too far away to attack with your pet!'],
            ];
            for (const [o, options, line] of cases) {
                const { w, bot } = petWorld({ ...bare, ...o });
                if (line) orders(w, (_a, world) => world.message(line));
                const r = await bot.killNpc(700, options);
                expect(r).toMatchObject({ success: false, reason: 'refused' });
                expect(r.message).not.toContain('pet');
                expect(w.sentOf('petCommand')).toHaveLength(line ? 1 : 0);
                expect(w.sentOf('moveTo')).toEqual([]);
            }
        });

        test('a weapon in slot 10 or 12 is left to the server: which one is active is its call', async () => {
            for (const slot of [10, 12]) {
                const { w, bot } = world({ equipment: [{ ...armour, slot, objectType: 3 }], nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
                fightSim(w);
                expect(await bot.killNpc(201)).toMatchObject({ killed: true });
            }
        });

        test('one in the left hand alone, or a bow, can\'t swing: refused at once', async () => {
            for (const slot of [11, 13]) {
                const { w, bot } = world({ equipment: [{ ...armour, slot, objectType: 3 }], pet: null, nearbyNpcs: [mob({ x: 561300 })] });
                expect(await bot.killNpc(700)).toMatchObject({ success: false, reason: 'refused' });
                expect(w.sent).toEqual([]);
            }
        });

        test('a shield in slot 11 is no weapon: refused at once, with no walk (AttackComponent.cs:546-550)', async () => {
            const { w, bot } = world({ equipment: [{ ...armour, slot: 11, objectType: 42 }], pet: null, nearbyNpcs: [mob({ x: 561300 })] });
            const r = await bot.killNpc(700);
            expect(r).toMatchObject({ success: false, reason: 'refused' });
            expect(r.message).toContain('no weapon');
            expect(w.sent).toEqual([]);
        });

        test('in shade the pet fights: a shade\'s empty hands say nothing', async () => {
            const { w, bot } = petWorld({ ...bare, player: makePlayer({ isShade: true }) });
            orders(w, (a, world) => {
                if (a.command !== 'attack') return;
                world.message(KILL);
                setTimeout(() => dies(world, 700), 30);
            });
            expect(await bot.killNpc(700)).toMatchObject({ success: true, killed: true });
        });
    });

    describe('killNpc with a bow in hand: the server answers every attack request with a line and nothing else (PlayerAttackRequestHandler.cs:12-18)', () => {
        const RANGED = "You can't enter melee combat mode with a ranged weapon!";
        const item = (slot: number, name: string, objectType: number): InventoryItem => ({ slot, name, level: 1, count: 1, model: 3, objectType, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 });
        const sword = item(10, 'training sword', 3);
        const staff = item(12, 'oak staff', 8);
        const shield = item(11, 'small shield', 42);
        const bow = item(13, 'rowan bow', 9);
        const rat = () => makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 });

        /**
         * The server, with the bow as the active weapon: an attack request gets the line, an off too, since encodeAttack always says userAction, and that one trails the refusal.
         * Using a melee slot with type 0 switches (GamePlayer.cs:6622-6637), after its attempt line, which comes after that trailing line: one TCP stream.
         */
        const bowInHand = (w: FakeWorld, opts: { switches?: boolean; answerMs?: number } = {}) => {
            let ranged = true;
            w.handlers.attack = (a, world) => {
                if (a.type !== 'attack') return;
                if (!ranged) { world.player.attacking = a.on; return; }
                setTimeout(() => world.message(RANGED, { type: 'youHit' }), a.on ? 5 : 25);
            };
            w.handlers.useItem = (a, world) => {
                if (a.type !== 'useItem') return;
                setTimeout(() => {
                    world.message(`You attempt to use ${world.state.equipment.find(i => i.slot === a.slot)?.name}.`);
                    if (opts.switches !== false && !a.useType) ranged = false;
                }, opts.answerMs ?? 40);
            };
        };

        test.each([['a one-handed weapon', [sword, bow], 10], ['a two-handed one', [staff, bow], 12], ['a shield beside the two-handed one', [shield, staff, bow], 12]])('%s: uses its slot once, type 0, and fights', async (_what, equipment, slot) => {
            const { w, bot } = world({ equipment: equipment as InventoryItem[], nearbyNpcs: [rat()] });
            fightSim(w);
            bowInHand(w);
            expect(await bot.killNpc(201)).toMatchObject({ success: true, killed: true, xpGained: 17 });
            expect(w.sentOf('useItem')).toHaveLength(1);
            expect(w.sentOf('useItem')[0]).toMatchObject({ slot: slot as number, useType: 0 });
        });

        test('it says the same after the switch: once, and the server\'s line is the result', async () => {
            const { w, bot } = world({ equipment: [sword, bow], nearbyNpcs: [rat()] });
            bowInHand(w, { switches: false });
            expect(await bot.killNpc(201)).toMatchObject({ success: false, reason: 'refused', message: RANGED });
            expect(w.sentOf('useItem')).toHaveLength(1);
        });

        test.each([['a bow alone', [bow]], ['a bow and a shield', [shield, bow]], ['a bow and an instrument in the right hand', [item(10, 'lute', 45), bow]]])('%s: the no-weapon path, with nothing to switch to', async (_what, equipment) => {
            const { w, bot } = world({ equipment: equipment as InventoryItem[], pet: null, nearbyNpcs: [rat()] });
            bowInHand(w);
            const r = await bot.killNpc(201);
            expect(r).toMatchObject({ success: false, reason: 'refused', npc: { objectId: 201 } });
            expect(r.message).toContain('no weapon');
            expect(w.sentOf('useItem')).toEqual([]);
        });

        test('the same with a pet: it has its order, and the message says it fights on', async () => {
            const { w, bot } = petWorld({ equipment: [bow], nearbyNpcs: [petNpc(), rat()] });
            bowInHand(w);
            orders(w, (_a, world) => world.message('You command the amber simulacrum to kill your target!'));
            const r = await bot.killNpc(201);
            expect(r).toMatchObject({ success: false, reason: 'refused' });
            expect(r.message).toContain('our pet fights on');
            expect(w.sentOf('useItem')).toEqual([]);
        });

        test('a timeout counts the time the refused try took', async () => {
            const { w, bot } = world({ equipment: [sword, bow], nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000, healthPercent: 100 })] });
            fightSim(w, { dmg: 0 });
            bowInHand(w, { answerMs: 300 });
            const t0 = Date.now();
            expect(await bot.killNpc(201, { timeout: 400 })).toMatchObject({ success: false, reason: 'timeout' });
            expect(Date.now() - t0).toBeLessThan(600);
        });
    });

    describe('kill results read fresh', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';

        test('npc is the entry as it ended, for a melee fight and a pet\'s', async () => {
            const melee = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
            fightSim(melee.w, { dmg: 5 });
            const hit = await melee.bot.killNpc(201, { timeout: 100 });
            expect(hit).toMatchObject({ reason: 'timeout', npc: { objectId: 201 } });
            expect(hit.npc!.healthPercent).toBeLessThan(100);

            const pet = petWorld();
            orders(pet.w, (_a, world) => {
                world.message(KILL);
                world.npc(700)!.healthPercent = 40;
            });
            expect(await pet.bot.petKill(700, { timeout: 100 })).toMatchObject({ reason: 'timeout', npc: { objectId: 700, healthPercent: 40 } });
        });

        test('with the entry gone, or its id on something else, the last one we held', async () => {
            const gone = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 })] });
            fightSim(gone.w);
            expect(await gone.bot.killNpc(201)).toMatchObject({ killed: true, npc: { objectId: 201, name: 'rat' } });

            const { w, bot } = petWorld();
            orders(w, (_a, world) => {
                world.message(KILL);
                setTimeout(() => {
                    world.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                    world.state.nearbyNpcs = [petNpc(), mob({ name: 'bag of coins' })];
                }, 30);
            });
            expect(await bot.petKill(700)).toMatchObject({ killed: true, npc: { name: 'young wolf' } });
        });
    });

    describe('killNpc\'s chase check', () => {
        test('a far mob that hasn\'t moved isn\'t running: we go to it', async () => {
            const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'bear', x: 562851, y: 511000 })] });
            fightSim(w);
            expect(await bot.killNpc(201, { timeout: 3000 })).toMatchObject({ killed: true });
            expect(w.sentOf('moveTo').length).toBeGreaterThanOrEqual(1);
        });

        test('one that has run that far from where it stood is out of reach, however near us', async () => {
            const { w, bot } = world({ nearbyNpcs: [makeNpc({ objectId: 201, name: 'bear', x: 560800, y: 511000 })] });
            fightSim(w, { dmg: 1 });
            const inner = w.onTick!;
            w.onTick = world => {
                inner(world);
                world.npc(201)!.x += 150; // runs as fast as we do
            };
            const r = await bot.killNpc(201, { maxChaseDistance: 1000, timeout: 5000 });
            expect(r).toMatchObject({ success: false, reason: 'out_of_reach', message: 'bear ran beyond 1000 units' });
        });
    });

    test('an ability gets no answer from a pet\'s parry line (CT_Action, GameLiving.cs:1625)', async () => {
        const sprint = { name: 'Sprint', level: 1, internalId: 2, skillIndex: 4 };
        const { w, bot } = world({ skills: { specializations: [], abilities: [sprint], styles: [], spells: [] } });
        w.handlers.useSkill = (_a, world) => { setTimeout(() => world.message('The rat attacks your wolf and is parried!', { type: 'action' }), 5); };
        expect(await bot.useAbility('Sprint')).toMatchObject({ success: false, reason: 'no_response' });
    });

    describe('what the first live group test found', () => {
        const KILL = 'You command the amber simulacrum to kill your target!';
        const ME = 100;
        const hunters = spellOf("Hunter's Pet", 3587);
        const orderedOnto = (w: FakeWorld) => w.sentOf('petCommand').filter(a => a.command === 'attack').map(a => a.targetObjectId);
        const caster = (mana: number) => makePlayer({ mana, maxMana: 200, manaPercent: Math.round(mana / 2) });
        const lose = (w: FakeWorld, o: { targetedBy?: number[]; targetObjectId?: number; cause?: 'died' | 'released' } = {}) => {
            w.removeNpc(PET_ID);
            w.state.pet = null;
            w.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: o.cause ?? 'died', at: Date.now(), ...(o.targetedBy && { targetedBy: o.targetedBy }), ...(o.targetObjectId !== undefined && { targetObjectId: o.targetObjectId }) };
        };
        /** The pet kills what it is ordered onto, a moment on. */
        const kills = (w: FakeWorld, ms = 20) => orders(w, (a, world) => {
            if (a.command !== 'attack') return;
            world.message(KILL);
            setTimeout(() => dies(world, a.targetObjectId!), ms);
        });
        const clocks: { mockRestore: () => void }[] = [];
        afterEach(() => { clocks.splice(0).forEach(c => c.mockRestore()); });
        /** Date.now, with a jump to call when the overrun should be up. */
        const skewable = () => {
            const realNow = Date.now.bind(Date);
            let skew = 0;
            clocks.push(spyOn(Date, 'now').mockImplementation(() => realNow() + skew));
            return (ms: number) => { skew += ms; };
        };

        describe('S1: replace with a mob on the pet', () => {
            const replacing = (o: Partial<BotWorldState> = {}) => {
                const made = petWorld({ skills: skillsWith(simulacrum), player: caster(200), ...o });
                orders(made.w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                summons(made.w, simulacrum.name, 'ruby simulacrum', { id: 620 });
                return made;
            };

            test('one within what it covers by the half way of the cast turns on us at the release: in_combat, the pet kept', async () => {
                // '20:26:27.312 losePet(released)', '20:26:27.411 0xA1 MOB id=23168 bandit wire=ME', 'REPLACE mob on the pet beside us {ms:3010,ok:false,reason:died,msg:Died while casting Ruby Simulacrum'.
                const { w, bot } = replacing({ nearbyNpcs: [petNpc(), mob({ x: 560163, name: 'bandit', targetObjectId: PET_ID })] });
                const r = await bot.summonPet(simulacrum, { replace: true });
                expect(r).toMatchObject({ success: false, reason: 'in_combat', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
                expect(r.message).toContain('bandit');
                expect(r.message).toContain('turns on us at the release');
                expect(w.sent).toEqual([]);
            });

            test.each([[909, 'in_combat'], [911, undefined]])('a 6 s cast has room from 220 x 3 + 200 of reach + 50 of a snapshot: at %d', async (d, reason) => {
                const { bot } = replacing({ nearbyNpcs: [petNpc(), mob({ x: 560000 + (d as number), targetObjectId: PET_ID })] });
                const r = await bot.summonPet(simulacrum, { replace: true });
                expect(r.reason).toBe(reason as string | undefined);
            });

            test('a charm of 4 s has less to fear: its own window goes by its own cast', async () => {
                const { bot } = petWorld({ skills: skillsWith(charm), player: caster(200), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560300, targetObjectId: PET_ID }), mob({ objectId: 702, x: 560100 })] });
                const r = await bot.charmPet(702, { replace: true });
                expect(r).toMatchObject({ success: false, reason: 'in_combat' });
                expect(r.message).toContain('turns on us at the release');
            });

            test('an instant one goes whatever is on the pet', async () => {
                const { w, bot } = replacing({ skills: skillsWith(hunters), nearbyNpcs: [petNpc(), mob({ x: 560100, targetObjectId: PET_ID })] });
                summons(w, hunters.name, "hunter's pet", { id: 620 });
                expect(await bot.summonPet(hunters, { replace: true })).toMatchObject({ success: true });
            });

            test('our own spell\'s hit is no swing, and one on us still counts', async () => {
                // t14b1.out: 'dart {Cast Minor Dusk Dart on tingler for 9 damage}', 'reason:in_combat, message:Melee stops Summon Bone Chieftan (our swing holds a cast back for up to 2.7 s), so our pet stays', 'EV melee ME -> tingler {result:other}'.
                const spell = (attackerObjectId: number, targetObjectId: number) => ({ id: 1, kind: 'melee' as const, attackerObjectId, targetObjectId, result: 'other' as const, receivedAt: Date.now() });
                const ours = replacing({ combatEvents: [spell(ME, 700)] });
                expect(await ours.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: true, pet: { objectId: 620 } });
                const theirs = replacing({ combatEvents: [spell(700, ME)] });
                expect(await theirs.bot.summonPet(simulacrum, { replace: true })).toMatchObject({ success: false, reason: 'in_combat' });
            });
        });

        describe('S2: room for a summon in grind goes by the spell', () => {
            const onUsAt = (d: number, spell = simulacrum) => world({ pet: null, skills: skillsWith(spell), nearbyNpcs: [mob({ objectId: 701, x: 560000 + d, targetObjectId: ME })], nearbyObjects: [] });

            test('386 off is no room for a 6 s cast: we go to melee', async () => {
                // 'start ... attackers:[bandit L8 #23120 hp24 d386 onMe=true]', 'CALL summonPet {} attackers=1', 'DONE summonPet 2997ms ok=false reason=interrupted msg=The bandit attacks you and your spell is interrupted!'.
                const { w, bot } = onUsAt(386);
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(w.sentOf('castSpell')).toEqual([]);
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });

            test('at 700 a mob at 190 would be on us by 2.63 s and the half way is 2.95: still melee', async () => {
                const { w, bot } = onUsAt(700);
                fightSim(w, { dmg: 50 });
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(w.sentOf('castSpell')).toEqual([]);
            });

            test('one seen running faster than the room allows for needs more: 335 from 911', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560911, targetObjectId: ME, speed: 335 })], nearbyObjects: [] });
                fightSim(w, { dmg: 50 });
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(w.sentOf('castSpell')).toEqual([]);
            });

            test('from 911 it goes', async () => {
                const { w, bot } = onUsAt(911);
                summons(w, simulacrum.name, 'amber simulacrum');
                kills(w);
                expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                expect(w.sentOf('castSpell')).toHaveLength(1);
                expect(w.sentOf('attack')).toEqual([]);
            });

            test('an instant one needs none', async () => {
                const { w, bot } = onUsAt(60, hunters);
                summons(w, hunters.name, "hunter's pet");
                kills(w);
                await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                const kinds = w.sent.map(a => a.type);
                expect(kinds.indexOf('castSpell')).toBeGreaterThanOrEqual(0);
                expect(kinds.indexOf('attack') === -1 || kinds.indexOf('attack') > kinds.indexOf('castSpell')).toBeTrue();
            });
        });

        describe('S3: a short wait isn\'t a pull', () => {
            const waitsOnce = (line: string) => {
                const made = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560557 })], nearbyObjects: [] });
                let casts = 0;
                made.w.handlers.castSpell = (_a, world) => {
                    if (++casts === 1) return void setTimeout(() => world.message(line, { type: 'resisted' }), 5);
                    setTimeout(() => {
                        world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                        world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                        world.state.pet = petWindow();
                    }, 5);
                };
                return made;
            };

            test("after 'You must wait 1 seconds' with a weapon we wait, then cast with nothing beside us", async () => {
                // out4/must2.log: '<< summonPet 148 ms {"s":false,"r":"must_wait","m":"You must wait 4 seconds to cast a spell!"} hp 70', '>> killNpc 17130 d 557 timeout 3999'.
                const { w, bot } = waitsOnce('You must wait 1 seconds to cast a spell!');
                kills(w);
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                const kinds = w.sent.map(a => a.type);
                expect(kinds.filter(k => k === 'castSpell')).toHaveLength(2);
                expect(kinds.indexOf('moveTo') === -1 || kinds.indexOf('moveTo') > kinds.lastIndexOf('castSpell')).toBeTrue();
                expect(kinds.indexOf('attack') === -1 || kinds.indexOf('attack') > kinds.lastIndexOf('castSpell')).toBeTrue();
            });

            test('anything from must_wait waits: a slow weapon can say 7 s', async () => {
                const { w, bot } = waitsOnce('You must wait 7 seconds to cast a spell!');
                fightSim(w, { dmg: 50 });
                await bot.grind({ pet: { fight: 'both' }, durationMs: 400, minEngageMs: 0, loot: false });
                expect(w.sentOf('attack')).toEqual([]);
                expect(w.sentOf('moveTo')).toEqual([]);
            });

            test('a long recast still pulls: a Hunter\'s 120 s', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith({ ...hunters, cooldownRemaining: 88 }), nearbyNpcs: [mob({ objectId: 701, x: 560100 })], nearbyObjects: [] });
                fightSim(w, { dmg: 50 });
                const r = await bot.grind({ pet: { fight: 'both' }, maxKills: 1, durationMs: 3000, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(w.sentOf('attack').map(a => a.on)).toContain(true);
            });
        });

        describe('S4: the hand-over in grind', () => {
            test('among the mobs on us, on their way, the one hurt comes before the one nearer', async () => {
                // flayer1: "mob hp51 ... tgt=24371" at d=1439, and the order went to "tgt=19661 ... mob hp100 ... d=1493 tgt=null inC=false"; "The vendo flayer hits your leg for 85 (+5) damage!".
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 702, x: 561000, targetObjectId: ME }), mob({ objectId: 701, x: 561100, healthPercent: 51, targetObjectId: ME })] });
                kills(w);
                await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false });
                expect(orderedOnto(w)[0]).toBe(701);
            });

            test('a record of our own fight goes first, and with one arrived that one, not a far one', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 702, x: 560050, targetObjectId: ME }), mob({ objectId: 701, x: 561100, healthPercent: 51, targetObjectId: ME })] });
                kills(w);
                fightSim(w, { dmg: 100 });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false });
                expect(r.killLog[0]).toMatchObject({ name: 'young wolf' });
                expect(w.sentOf('setTarget').at(-1)!.objectId).toBe(702);
            });

            test("a 'pet' pass ends as the mob arrives: no constant speed", async () => {
                // guard1: 'pet dead at 72.03, mob at d=1858, so the bound is 1858/150+1 = 13.4 s', 'It covered 1780 units in 9 s', '81.03 The wood-eater royal guard hits your leg', '85.54 You enter combat mode'.
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561858, healthPercent: 80, targetObjectId: ME })] });
                orders(w, (a, world) => { if (a.command === 'attack') world.message(KILL); });
                fightSim(w, { dmg: 50 });
                let swungAt = 0;
                const swing = defaultHandlers.attack!;
                w.handlers.attack = (a, world) => {
                    if (a.type === 'attack' && a.on) swungAt ||= Date.now();
                    return swing(a, world);
                };
                setTimeout(() => { w.npc(701)!.x = 560080; }, 200);
                const t0 = Date.now();
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0 });
                expect(swungAt - t0).toBeLessThan(1000);
            });

            test('petKill ends with reason arrived by itself only if asked', async () => {
                const asked = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 560800 })], pet: petWindow({ targetObjectId: 700 }) });
                setTimeout(() => { asked.w.npc(700)!.x = 560200; }, 40);
                expect(await asked.bot.petKill(700, { endWithin: 250, timeout: 1000 })).toMatchObject({ success: false, reason: 'arrived' });
                const plain = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 560200 })], pet: petWindow({ targetObjectId: 700 }) });
                expect(await plain.bot.petKill(700, { timeout: 100 })).toMatchObject({ success: false, reason: 'timeout' });
            });
        });

        describe('S6: pet losses in grind', () => {
            test('a pet lost between two passes: the note and lastPetLoss.mob, from targetedBy', async () => {
                // logs4/d1k_melee.log: 'CLOSE +3128 {"objectId":23152,"cause":"died","targetedBy":[23105]} atk [[23105,80,902]]', 'RETURNED {"r":"not_supported",...,"kills":1,"loss":{..."targetedBy":[23105],"mob":null}}'.
                const { w, bot } = petWorld({ skills: skillsWith(charm), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560902, healthPercent: 80 })] });
                kills(w, 10);
                const r = await bot.grind({
                    pet: true, durationMs: 3000, loot: false, onKill: async () => {
                        lose(w, { targetedBy: [702] });
                        w.npc(702)!.targetObjectId = ME;
                        await Bun.sleep(40);
                    },
                });
                expect(r).toMatchObject({ reason: 'not_supported', kills: 1, lastPetLoss: { targetedBy: [702], mob: { objectId: 702, healthPercent: 80 } } });
                expect(r.message).toContain('; our pet died with young wolf at 80 %, and it is coming for us');
            });

            test('with nothing on it, the pet\'s last target if that still stands', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(charm), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560902, healthPercent: 60 })] });
                kills(w, 10);
                const r = await bot.grind({
                    pet: true, durationMs: 3000, loot: false, onKill: async () => {
                        lose(w, { targetObjectId: 702 });
                        await Bun.sleep(40);
                    },
                });
                expect(r.lastPetLoss).toMatchObject({ mob: { objectId: 702, healthPercent: 60 } });
            });

            test('a loss before the run says nothing about this one', async () => {
                const { bot } = world({ pet: null, skills: skillsWith(charm), lastPetLoss: { objectId: PET_ID, name: 'x', cause: 'died', at: Date.now() - 100, targetedBy: [702] }, nearbyNpcs: [mob({ objectId: 702, x: 560902 })] });
                const r = await bot.grind({ durationMs: 150, minEngageMs: 60_000, loot: false });
                expect(r.lastPetLoss).toBeUndefined();
            });

            test('in a fight of ours beside the pet\'s, the note and mob name the one that killed it', async () => {
                // logs4/d1k_melee2.log: 'our pet died with puny skeleton at 35 %, and it is coming for us', loss {"targetedBy":[12647],"mob":{"objectId":9765,"healthPercent":35}}; 'Atk then [[9765,35,74],[12647,80,1370]]'.
                const { w, bot } = petWorld({
                    skills: skillsWith(charm), pet: petWindow({ targetObjectId: 802 }),
                    nearbyNpcs: [petNpc(), mob({ objectId: 801, name: 'puny skeleton', x: 560074, healthPercent: 35, targetObjectId: ME }), mob({ objectId: 802, name: 'skeleton', x: 561370, healthPercent: 80, targetObjectId: PET_ID })],
                });
                fightSim(w, { dmg: 0 });
                setTimeout(() => {
                    lose(w, { targetedBy: [802] });
                    w.npc(802)!.targetObjectId = ME;
                }, 100);
                const r = await bot.grind({ pet: { fight: 'both' }, durationMs: 3000, killTimeout: 2000, loot: false });
                expect(r.lastPetLoss).toMatchObject({ mob: { objectId: 802, name: 'skeleton', healthPercent: 80 } });
                expect(r.message).toContain('our pet died with skeleton at 80 %');
            });

            describe('one loss is one failure', () => {
                const gone = (reason: string) => ({ success: false, message: reason, reason, killed: false, npc: null, xpGained: 0, rpGained: 0, moneyGained: 0, itemsGained: [], durationMs: 5, levelsGained: 0, stylesUsed: 0 });

                test('the owner\'s death is none: logs4/s2-e.log read {"fail":3} from pet_died, no_pet, died', async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                    spyOn(bot, 'petKill').mockImplementationOnce(async () => {
                        w.player.isDead = true;
                        w.player.deathCount = 1;
                        w.publish();
                        return gone('died');
                    });
                    expect(await bot.grind({ pet: true, durationMs: 1000, loot: false })).toMatchObject({ stopReason: 'died', failures: 0 });
                });

                test('nor is no_pet: a wait of one tick', async () => {
                    const { bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                    spyOn(bot, 'petKill').mockImplementationOnce(async () => gone('no_pet')).mockImplementationOnce(async () => ({ ...gone('x'), success: true, reason: undefined, killed: true }));
                    expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 1000, loot: false })).toMatchObject({ kills: 1, failures: 0 });
                });

                test('a pet_died is one', async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050 })] });
                    spyOn(bot, 'petKill').mockImplementationOnce(async () => {
                        lose(w);
                        w.publish();
                        return gone('pet_died');
                    });
                    fightSim(w, { dmg: 100 });
                    const r = await bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 1000, loot: false });
                    expect(r).toMatchObject({ kills: 1, failures: 1 });
                });
            });

            describe('no weapon, no pet and a mob on us: the cast is all there is', () => {
                test('no killNpc between tries, no failure, no avoid, and the fight keeps its record', async () => {
                    // out4/d2c.log: '<< summonPet 3256 ms {"s":false,"r":"interrupted",...}', '<< killNpc 1 ms {"s":false,"r":"refused","m":"We have no weapon to fight black mauler juvenile with"...}' twice; 'killLog durationMs 8476 for a fight of 58 s'.
                    const { w, bot } = world({ equipment: [], pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: ME })], nearbyObjects: [] });
                    let casts = 0;
                    w.handlers.castSpell = (_a, world) => {
                        if (++casts === 1) return void setTimeout(() => world.message('The young wolf attacks you and your spell is interrupted!', { type: 'spell' }), 5);
                        setTimeout(() => {
                            world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                            world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                            world.state.pet = petWindow();
                        }, 5);
                    };
                    kills(w);
                    const melee = spyOn(bot, 'killNpc');
                    const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                    expect(melee).not.toHaveBeenCalled();
                    expect(r).toMatchObject({ kills: 1, failures: 0 });
                    expect(casts).toBe(2);
                    expect(r.killLog[0]!.durationMs).toBeGreaterThan(1900);
                }, 8000);

                test('a bow and the recast running: the same wait', async () => {
                    // d2b: "0 kills, +0 xp, 0 deaths in 31s (duration); waiting on Hunter's Pet (58s)", failures 27, 54 lines of "You can't enter melee combat mode with a ranged weapon!".
                    const bow = { slot: 13, name: 'rowan bow', level: 1, count: 1, model: 3, objectType: 9, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 };
                    const { w, bot } = world({ equipment: [bow], pet: null, skills: skillsWith({ ...hunters, cooldownRemaining: 60 }), nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: ME })], nearbyObjects: [] });
                    const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, killTimeout: 100, loot: false });
                    expect(r.failures).toBe(0);
                    expect(w.sentOf('attack')).toEqual([]);
                    expect(r.message).toContain("waiting on Hunter's Pet");
                });
            });

            test('a kill the pet makes while we fight another mob counts, with onKill, and whole in killLog', async () => {
                // logs4/v4f.log: '2715 MSG You command the grove's assailant to kill your target!' (large frog 413), '4749 You enter combat mode and target [the feccan]', '7915 MSG The large frog dies!', result {"kills":1,"failures":0,...}.
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, name: 'large frog', level: 4, x: 561000 }), mob({ objectId: 702, name: 'feccan', x: 561200 })] });
                let first = true;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (!first) return;
                    first = false;
                    setTimeout(() => {
                        world.npc(702)!.x = 560050;
                        world.npc(702)!.targetObjectId = ME;
                    }, 30);
                    setTimeout(() => dies(world, 701), 150);
                });
                fightSim(w, { dmg: 3 });
                const seen: string[] = [];
                const r = await bot.grind({ pet: true, maxKills: 2, durationMs: 5000, loot: false, onKill: k => { seen.push(k.message); } });
                expect(r).toMatchObject({ kills: 2, failures: 0, stopReason: 'maxKills' });
                expect(r.killLog.map(k => k.name).sort()).toEqual(['feccan', 'large frog']);
                expect(r.killLog.find(k => k.name === 'large frog')).toMatchObject({ level: 4 });
                expect(r.killLog.find(k => k.name === 'large frog')!.durationMs).toBeGreaterThan(100);
                expect(seen.some(m => m.startsWith('Killed large frog in '))).toBeTrue();
            });

            test('so does one in the last pass of the run', async () => {
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560500 }), mob({ objectId: 702, x: 561000 })] });
                const none = { killed: false, npc: null, xpGained: 0, rpGained: 0, moneyGained: 0, itemsGained: [], durationMs: 5, levelsGained: 0, stylesUsed: 0 };
                spyOn(bot, 'petKill').mockImplementationOnce(async () => {
                    w.npc(702)!.x = 560050;
                    w.npc(702)!.targetObjectId = ME;
                    w.publish();
                    return { ...none, success: false, message: 'on us', reason: 'attacked', attacker: w.npc(702) };
                });
                spyOn(bot, 'killNpc').mockImplementationOnce(async () => {
                    await Bun.sleep(150);
                    dies(w, 701);
                    dies(w, 702);
                    w.publish();
                    return { ...none, success: true, message: 'Killed', killed: true };
                });
                const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false });
                expect(r.kills).toBe(2);
            });

            test('since survives a turret\'s reach: the first part of the fight stays in killLog', async () => {
                // logs4/v4.log: order 332 ms, the feccan dies at about 16.2 s, one order in all, log {"name":"feccan","durationMs":7539}.
                const { w, bot } = petWorld({ player: makePlayer({ x: 561400 }), skills: skillsWith(turret), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560900 })] });
                let attacks = 0;
                orders(w, (a, world) => {
                    if (a.command !== 'attack') return;
                    world.message(KILL);
                    if (++attacks === 1) {
                        world.npc(701)!.x = 561500;
                        setTimeout(() => { world.npc(701)!.x = 560900; }, 2400);
                        return;
                    }
                    setTimeout(() => dies(world, 701), 5);
                });
                const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 6000, minEngageMs: 0, noTargetTimeoutMs: 0, loot: false });
                expect(r.kills).toBe(1);
                expect(r.killLog[0]!.durationMs).toBeGreaterThan(2300);
            }, 9000);

            test('a kill in the last snapshot gap of a pass is a kill: the next snapshot gets its say', async () => {
                // '19:50:52.387 0xA2 id=23156 type=0 puny skeleton lastHp=0', 'DONE petKill 3258ms ok=false reason=timeout', "GRIND '1 kills ... failures:1', with 2 mobs dead.
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, x: 560050 })], nearbyObjects: [] });
                spyOn(bot, 'killNpc').mockImplementationOnce(async () => {
                    // In the model, and in no snapshot yet.
                    dies(w, 701);
                    return { success: false, message: 'Timed out', reason: 'timeout', killed: false, npc: null, xpGained: 0, rpGained: 0, moneyGained: 0, itemsGained: [], durationMs: 3000, levelsGained: 0, stylesUsed: 0 };
                });
                const r = await bot.grind({ maxKills: 1, durationMs: 3000, loot: false });
                expect(r).toMatchObject({ kills: 1, failures: 0, stopReason: 'maxKills' });
            });

            describe('a mob at 0 %: only a death since this entry appeared says it is dead (Region.cs:955)', () => {
                // t10b2.out: great tingler #24430 at 0 %, alive and on the pet, '[68.36] CALL petKill 30025 ms {success:false, reason:already_dead, message:great tingler is already dead}'; id 24430 had died as an arachite priest earlier.
                const death = (ago: number) => ({ id: 1, kind: 'death' as const, attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0, receivedAt: Date.now() - ago });

                test('petAttack, attack and killNpc read an older death as somebody else\'s', async () => {
                    const older = { nearbyNpcs: [petNpc(), mob({ x: 560050, healthPercent: 0, firstSeenAt: Date.now() - 1000, targetObjectId: PET_ID })], combatEvents: [death(5000)] };
                    const order = petWorld(older);
                    orders(order.w, (_a, world) => world.message(KILL));
                    expect(await order.bot.petAttack(700)).toMatchObject({ success: true });
                    expect((await petWorld(older).bot.killNpc(700, { timeout: 60, usePet: false })).reason).toBe('timeout');
                    expect((await petWorld(older).bot.attack(700)).reason).not.toBe('already_dead');
                });

                test('one since it appeared is the death', async () => {
                    const { bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 0, firstSeenAt: Date.now() - 5000 })], combatEvents: [death(1000)] });
                    expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'already_dead' });
                });

                test('with no first sight, from an older client, any in the ring still counts', async () => {
                    const { bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ healthPercent: 0 })], combatEvents: [death(5000)] });
                    expect(await bot.petAttack(700)).toMatchObject({ success: false, reason: 'already_dead' });
                });
            });

            test('a mob on us past the deadline gets one pass of the new pet', async () => {
                // t23b.out, durationMs 6000, hog handed over at d557: 'CALL summonPet 6444 ms' success, 'grind 6446 ms {s:false, r:no_kills, stop:duration, m:0 kills, +0 xp, 0 deaths in 6s (duration)}', with 'The wild hog fumbled!' at that moment.
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701, x: 561000, targetObjectId: ME })], nearbyObjects: [] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => {
                        world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                        world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc()];
                        world.state.pet = petWindow();
                    }, 200);
                };
                kills(w);
                const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false });
                expect(r).toMatchObject({ kills: 1 });
                expect(orderedOnto(w)).toEqual([701]);
            });
        });

        describe('S7: end notes say what is true', () => {
            const resting = { success: true, message: 'Rested', healthPercent: 100, manaPercent: 40, endurancePercent: 100, durationMs: 100 };

            test('short of power only while it is so', async () => {
                // 'DONE rest 14587ms ok=true msg=Rested to 100% health, 42% mana mana=24', '0 kills, +0 xp, 0 deaths in 15s (duration); no pet: short of power for Ruby Simulacrum (it can cost 17, and we have 24)'.
                const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [], player: makePlayer({ health: 100, healthPercent: 100, mana: 10, maxMana: 200, manaPercent: 5 }) });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); };
                spyOn(bot, 'rest').mockImplementation(async () => {
                    w.player.mana = 60;
                    await Bun.sleep(150);
                    return resting;
                });
                const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0 });
                expect(r.message).toContain('; no pet: rested for Amber Simulacrum, no time left to cast it');
                expect(r.message).not.toContain('short of power');
            });

            test('a run that stops for lack of time says what its pet is at, below the gate', async () => {
                // logs4/s1-a.log: stop at +48 s of 85: {"ok":true,"msg":"1 kills, +92687 xp, 0 deaths in 48s (duration)"}, pet 18 %.
                const { bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc({ healthPercent: 18 })] });
                const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 60_000, loot: false });
                expect(r.message).toContain('; our pet at 18 %');
            });

            test('at the gate or over, or with the gate off, it doesn\'t', async () => {
                for (const [health, pet] of [[50, true], [18, { restBelowPetHealth: 0 }]] as const) {
                    const { bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc({ healthPercent: health })] });
                    expect((await bot.grind({ pet, durationMs: 100, minEngageMs: 60_000, loot: false })).message).not.toContain('our pet at');
                }
            });

            test('after a long overrun: what the mob was at when the pet died, and what it is at now, on us', async () => {
                // logs4/s2-c.log: {"msg":"0 kills, +0 xp, 0 deaths in 38s (duration); we lost our pet with bandit at 97 %, and it is coming for us: we are at 55 % health"}, 'bandit L5 d75 hp13 t23082' after 26 s of melee.
                const jump = skewable();
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), player: makePlayer({ isShade: true }), nearbyNpcs: [petNpc(), mob({ objectId: 701, name: 'bandit', x: 560075, healthPercent: 97, targetObjectId: PET_ID })] });
                orders(w, (a, world) => { if (a.command === 'attack') world.message(KILL); });
                fightSim(w, { dmg: 0 });
                setTimeout(() => {
                    w.player.isShade = false;
                    lose(w, { targetedBy: [701], cause: 'released' });
                    w.npc(701)!.targetObjectId = ME;
                }, 50);
                setTimeout(() => {
                    w.npc(701)!.healthPercent = 13;
                    jump(31_000);
                }, 250);
                const r = await bot.grind({ pet: { resummon: false }, durationMs: 100, minEngageMs: 0, killTimeout: 120, loot: false });
                expect(r.message).toContain('; we lost our pet with bandit at 97 %, and it is on us at 13 %');
                expect(r.message).not.toContain('coming for us');
                expect(r.message).not.toContain('we are at');
                expect(r.lastPetLoss).toMatchObject({ mob: { objectId: 701, healthPercent: 97 } });
                expect(r.stillFighting).toEqual({ objectId: 701, name: 'bandit', healthPercent: 13 });
                expect(r.message).not.toContain('still fighting');
            });

            test('still on its way the note has its health as it is', async () => {
                const jump = skewable();
                const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 561500, healthPercent: 97, targetObjectId: PET_ID })] });
                w.stepSize = 1;
                orders(w, (a, world) => { if (a.command === 'attack') world.message(KILL); });
                setTimeout(() => {
                    lose(w, { targetedBy: [701] });
                    w.npc(701)!.targetObjectId = ME;
                    w.npc(701)!.healthPercent = 90;
                }, 50);
                setTimeout(() => jump(31_000), 150);
                const r = await bot.grind({ pet: { resummon: false }, durationMs: 100, minEngageMs: 0, killTimeout: 100, loot: false });
                expect(r.message).toContain('; our pet died with young wolf at 90 %, and it is coming for us');
            });

            test('a grind that ends at the overrun with a mob on us says so, in the message and in a field', async () => {
                // "RESULT {reason:no_kills, msg:0 kills, +0 xp, 0 deaths in 35s (duration), failures:0, stop:duration}", with "hp 20 ... attacking true ... attackers [emerald snake@26]".
                const jump = skewable();
                const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ objectId: 701, name: 'emerald snake', x: 560026, healthPercent: 26, targetObjectId: ME })], nearbyObjects: [] });
                fightSim(w, { dmg: 0 });
                setTimeout(() => jump(31_000), 150);
                const r = await bot.grind({ durationMs: 100, minEngageMs: 0, killTimeout: 100, loot: false });
                expect(r.message).toContain('; still fighting emerald snake at 26 %');
                expect(r.stillFighting).toEqual({ objectId: 701, name: 'emerald snake', healthPercent: 26 });
            });

            test('with nothing on us there is no such thing', async () => {
                const { bot } = world({ pet: null, nearbyNpcs: [], nearbyObjects: [] });
                const r = await bot.grind({ durationMs: 50, minEngageMs: 0, noTargetTimeoutMs: 0, loot: false });
                expect(r.stillFighting).toBeUndefined();
                expect(r.message).not.toContain('still fighting');
            });

            describe('a plain grind with no weapon', () => {
                test('the first pass finishes error, reason refused, with the line', async () => {
                    // q19: 'plain grind no weapon (2005 ms), killNpc calls 2 {"success":false,"message":"0 kills, +0 xp, 0 deaths in 2s (duration)","kills":0,"failures":2,...}'.
                    const { w, bot } = world({ equipment: [], pet: null, nearbyNpcs: [mob({ objectId: 701 })], nearbyObjects: [] });
                    const t0 = Date.now();
                    const r = await bot.grind({ durationMs: 4000, loot: false });
                    expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'refused', kills: 0 });
                    expect(r.message).toBe('We have no weapon to fight young wolf with');
                    expect(Date.now() - t0).toBeLessThan(500);
                    expect(w.sent).toEqual([]);
                });

                test('with a pet up it says what to pass, and no order has gone out to leave it in a fight', async () => {
                    // out4/d2p2.log: 'grind 15227 ms {"s":false,"r":"no_kills","m":"0 kills, +0 xp, 0 deaths in 15s (duration)","f":3,...}', 0x8A 2, at the end 'petT ..."targetObjectId":24368'.
                    const { w, bot } = petWorld({ equipment: [], skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                    const r = await bot.grind({ durationMs: 4000, loot: false });
                    expect(r).toMatchObject({ stopReason: 'error', reason: 'refused' });
                    expect(r.message).toContain('pet: true');
                    expect(w.sentOf('petCommand')).toEqual([]);
                });
            });
        });

        describe('the cast the server goes on with after its target\'s death', () => {
            // 20261104-045941: `You begin casting a Murk Blast spell!` +19.7, `Rethe was just killed by Rehun` +21.5, `You are already casting a spell! You prepare this spell as a follow up!` +21.7, `00:24 Rebon: summon: no_response`.
            const FOLLOW_UP = 'You are already casting a spell! You prepare this spell as a follow up!';
            const BLESS = spellOf('Blessed Strength', 1451, 1, 1);
            const NOTE = spellOf('Dischordant Note', 1131, 1, 2);
            const lands = (w: FakeWorld, sp: { name: string }) => { w.message(`You cast a ${sp.name} spell!`, { type: 'spell' }); };
            /** A cast of `castMs` whose target dies 60 ms in, what comes after it landing at once. */
            const diedUnder = async (castMs = 700) => {
                const made = world({ pet: null, skills: skillsWith(earth, BLESS, NOTE), nearbyNpcs: [mob({ x: 560500 }), mob({ objectId: 701, x: 560500 })] });
                made.w.handlers.castSpell = (a, w) => {
                    if (a.type !== 'castSpell') return;
                    if (a.spellIndex === 0) setTimeout(() => { w.message(`You begin casting a ${earth.name} spell!`, { type: 'spell' }); w.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: castMs }); }, 5);
                    else setTimeout(() => lands(w, a.spellIndex === 1 ? BLESS : NOTE), 5);
                };
                setTimeout(() => dies(made.w, 700), 60);
                expect(await made.bot.castSpell(earth, 700)).toMatchObject({ success: false, reason: 'already_dead', targetDied: true });
                return made;
            };

            test('the next cast waits for its end, and then goes', async () => {
                const { w, bot } = await diedUnder();
                const t0 = Date.now();
                const next = bot.castSpell(BLESS);
                await Bun.sleep(150);
                expect(w.sentOf('castSpell').length).toBe(1);
                expect(await next).toMatchObject({ success: true });
                expect(w.sentOf('castSpell').length).toBe(2);
                expect(Date.now() - t0).toBeGreaterThan(450);
                // Its 640 ms and the margin, and castSpell's own 750 after a "You cast" line.
                expect(Date.now() - t0).toBeLessThan(1900);
            });

            test('only that one: the next after it goes at once', async () => {
                const { w, bot } = await diedUnder(1500);
                await bot.castSpell(BLESS);
                const t0 = Date.now();
                await bot.castSpell(BLESS);
                expect(w.sentOf('castSpell').length).toBe(3);
                expect(Date.now() - t0).toBeLessThan(1200);
            });

            test('an instant isn\'t held: the server runs it beside a cast (CastingComponent.cs:376-377)', async () => {
                const { w, bot } = await diedUnder();
                const next = bot.castSpell(NOTE, 701);
                await Bun.sleep(40);
                expect(w.sentOf('castSpell').length).toBe(2);
                await next;
            });

            test('an 0x0B has ended it: a walk or a hit. Nothing to wait for', async () => {
                const { w, bot } = await diedUnder(5000);
                w.combat({ kind: 'interrupt', attackerObjectId: ME, targetObjectId: null });
                const t0 = Date.now();
                await bot.castSpell(BLESS);
                expect(Date.now() - t0).toBeLessThan(1200);
            });

            test('no cast seen begun: nothing to wait for either', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(earth, BLESS), nearbyNpcs: [mob({ x: 560500 })] });
                w.handlers.castSpell = (a, world) => { if (a.type === 'castSpell' && a.spellIndex === 1) setTimeout(() => lands(world, BLESS), 5); };
                setTimeout(() => dies(w, 700), 20);
                expect(await bot.castSpell(earth, 700)).toMatchObject({ reason: 'already_dead', targetDied: true });
                const t0 = Date.now();
                await bot.castSpell(BLESS);
                expect(Date.now() - t0).toBeLessThan(1200);
            });

            test('castHeldLeftMs says what the next cast would wait: none for an instant, none once an 0x0B ended it', async () => {
                const { w, bot } = await diedUnder(1500);
                expect(bot.castHeldLeftMs(BLESS)).toBeGreaterThan(500);
                expect(bot.castHeldLeftMs(BLESS)).toBeLessThanOrEqual(1600);
                expect(bot.castHeldLeftMs()).toBeGreaterThan(500);
                expect(bot.castHeldLeftMs(NOTE)).toBe(0);
                w.combat({ kind: 'interrupt', attackerObjectId: ME, targetObjectId: null });
                await Bun.sleep(30);
                expect(bot.castHeldLeftMs(BLESS)).toBe(0);
            });

            describe('its end line, read behind the next cast\'s send', () => {
                // 20261104-050819: begun 05:09:11.629, 'You must select a target for this spell!' 05:09:14.658, 71 ms before the wait ended. A game line waits for the 250 ms publish (client.ts:163-168), and a Self or Pet spell sends nothing before its watch: 'Petcab: petBuff: no_target', 60 s of buffRetryMs, with the cast running.
                const NO_TARGET = 'You must select a target for this spell!';
                const trailing = async (sp: { name: string }, ago = 50) => {
                    const made = await diedUnder();
                    made.w.handlers.castSpell = (a, world) => {
                        if (a.type !== 'castSpell') return;
                        world.message(NO_TARGET, { type: 'resisted', receivedAt: Date.now() - ago });
                        setTimeout(() => lands(world, sp), 5);
                    };
                    return made;
                };

                test('a Self spell: no answer to this one, and it goes on to land', async () => {
                    const { bot } = await trailing(simulacrum);
                    expect(await bot.castSpell(simulacrum)).toMatchObject({ success: true });
                });

                test('a Realm spell on ourselves: not sent twice, which the server would queue and charge again', async () => {
                    const { w, bot } = await trailing(BLESS);
                    expect(await bot.castSpell(BLESS)).toMatchObject({ success: true });
                    expect(w.sentOf('castSpell').length).toBe(2);
                });

                test('the same line after our send is this one\'s refusal, as ever', async () => {
                    const { bot } = await trailing(simulacrum, 0);
                    expect(await bot.castSpell(simulacrum)).toMatchObject({ success: false, reason: 'no_target' });
                });
            });

            test('a turn with something else to do isn\'t held: a walk goes at once', async () => {
                const { w, bot } = await diedUnder();
                const walk = bot.walkTo(560800, 511000);
                await Bun.sleep(40);
                expect(w.sentOf('moveTo').length).toBe(1);
                await walk;
            });

            describe('already casting, as the answer to a cast', () => {
                // 20261104-050819: '05:09:14.658 You are already casting a spell! You prepare this spell as a follow up!', '05:09:14.658 You must select a target for this spell!', 'Petcab: petBuff: no_target', and '05:09:15.665 You begin casting a Encourage Aggression spell!', and it landed.
                const running = (castMs: number, line: string | string[] = FOLLOW_UP) => {
                    const made = world({ pet: null, skills: skillsWith(earth, BLESS), nearbyNpcs: [mob({ x: 560500 })] });
                    made.w.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: castMs });
                    made.w.handlers.castSpell = (_a, w) => { setTimeout(() => { for (const l of [line].flat()) w.message(l, { type: 'spell' }); }, 5); };
                    return made;
                };

                test('it reads must_wait with what\'s left of the running cast, at once, and never no_response', async () => {
                    const { bot } = running(2000);
                    const t0 = Date.now();
                    const r = await bot.castSpell(BLESS);
                    expect(r).toMatchObject({ success: false, reason: 'must_wait', message: FOLLOW_UP, followUpMs: 3000 });
                    expect(r.retryAfterMs).toBeGreaterThan(1500);
                    expect(r.retryAfterMs).toBeLessThanOrEqual(2000);
                    expect(Date.now() - t0).toBeLessThan(500);
                });

                test('the running cast\'s no-target line beside it is no answer of this one\'s', async () => {
                    const { bot } = running(2000, [FOLLOW_UP, 'You must select a target for this spell!']);
                    expect(await bot.castSpell(BLESS)).toMatchObject({ reason: 'must_wait' });
                });

                test('the next cast waits out what the server holds: it isn\'t queued behind that in turn, for good', async () => {
                    const { w, bot } = running(100);
                    expect(await bot.castSpell(BLESS)).toMatchObject({ reason: 'must_wait' });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => lands(world, BLESS), 5); };
                    const next = bot.castSpell(BLESS);
                    await Bun.sleep(300);
                    expect(w.sentOf('castSpell').length).toBe(1);
                    w.combat({ kind: 'interrupt', attackerObjectId: ME, targetObjectId: null });
                    expect(await next).toMatchObject({ success: true });
                });

                describe('what it holds is dropped if the running cast fails its end check', () => {
                    // CheckEndCast false, Interrupted, ClearSpellHandlers, with no 0x0B as the cast is no longer casting (SpellHandler.cs:1091-1097, CastingComponent.cs:196, :224-228). 20261104-045941: 'no follow-up cast came'.
                    test('with no begin by the time one is due, the next cast goes: nothing runs on the server', async () => {
                        const { w, bot } = running(100);
                        expect(await bot.castSpell(BLESS)).toMatchObject({ reason: 'must_wait', followUpMs: 3000 });
                        const read = Date.now();
                        let sentAt = 0;
                        w.handlers.castSpell = (_a, world) => { sentAt = Date.now(); setTimeout(() => lands(world, BLESS), 5); };
                        expect(await bot.castSpell(BLESS)).toMatchObject({ success: true });
                        expect(sentAt - read).toBeLessThan(1500);
                    });

                    test('one that begins is waited out', async () => {
                        const { w, bot } = running(100);
                        expect(await bot.castSpell(BLESS)).toMatchObject({ reason: 'must_wait' });
                        setTimeout(() => w.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: 3000 }), 120);
                        w.handlers.castSpell = (_a, world) => { setTimeout(() => lands(world, BLESS), 5); };
                        const next = bot.castSpell(BLESS);
                        await Bun.sleep(1200);
                        expect(w.sentOf('castSpell').length).toBe(1);
                        w.combat({ kind: 'interrupt', attackerObjectId: ME, targetObjectId: null });
                        expect(await next).toMatchObject({ success: true });
                    });
                });

                test('held, and going in the same snapshot: its own begin line says so, and it is watched as any cast', async () => {
                    const { w, bot } = running(100);
                    w.handlers.castSpell = (_a, world) => {
                        setTimeout(() => { world.message(FOLLOW_UP, { type: 'spell' }); world.message(`You begin casting a ${BLESS.name} spell!`, { type: 'spell' }); world.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: 100 }); }, 5);
                        setTimeout(() => lands(world, BLESS), 120);
                    };
                    expect(await bot.castSpell(BLESS)).toMatchObject({ success: true });
                });

                test('with the spell queue off the plain line: must_wait, and nothing held', async () => {
                    const { bot } = running(1000, 'You are already casting a spell!');
                    const r = await bot.castSpell(BLESS);
                    expect(r).toMatchObject({ reason: 'must_wait' });
                    expect(r.followUpMs).toBeUndefined();
                    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);
                });

                test('a summon carries it, for its behaviour to read', async () => {
                    const { w, bot } = running(1000);
                    w.state.skills = skillsWith(simulacrum);
                    w.publish();
                    expect(await bot.summonPet(simulacrum)).toMatchObject({ success: false, reason: 'must_wait', followUpMs: 6000 });
                });
            });
        });

        describe('a refused pet order\'s line beside a cast that goes', () => {
            // 20261104-045249: '05:53:02.413 You can't attack a member of your realm!' and '05:53:02.413 You begin casting a Minor Essence Consumption spell!' in one snapshot; '04:53:02 Petcab: nuke: refused', and '05:53:05.034 You cast a Minor Essence Consumption spell!'.
            const NUKE = spellOf('Ice Cloud (Minor)', 151, 1, 3);
            const REFUSED = "You can't attack a member of your realm!";
            const begins = (w: FakeWorld) => { w.message(`You begin casting a ${NUKE.name} spell!`, { type: 'spell' }); w.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: 100 }); };
            const ends = (w: FakeWorld, after = 110) => setTimeout(() => w.message(`You cast a ${NUKE.name} spell!`, { type: 'spell' }), after);
            /** `answer` plays the server's answer to the cast. An order at the mob's id went `orderAgo` ms before it, or none. */
            const casting = async (answer: (w: FakeWorld) => void, orderAgo: number | null = 0, line = REFUSED) => {
                const made = world({ pet: petWindow(), skills: skillsWith(NUKE), nearbyNpcs: [petNpc(), mob({ x: 560500 })] });
                orders(made.w);
                made.w.handlers.castSpell = () => { setTimeout(() => { made.w.message(line); answer(made.w); }, 5); };
                if (orderAgo !== null) {
                    await made.sdk.sendPetCommand('attack', 900);
                    if (orderAgo) await Bun.sleep(orderAgo);
                }
                return { ...made, r: await made.bot.castSpell(NUKE, 700) };
            };

            test('in one snapshot: the order\'s, and the cast goes on to land', async () => {
                const { r } = await casting(w => { begins(w); ends(w); });
                expect(r).toMatchObject({ success: true });
            });

            test('its begin line a tick behind it: the same', async () => {
                const { r } = await casting(w => { setTimeout(() => { begins(w); ends(w); }, 60); });
                expect(r).toMatchObject({ success: true });
            });

            test('PvP immunity reads the same, shades and peace flags with it', async () => {
                for (const line of ['Petani is temporarily immune to PvP attacks!', "You can't attack a shadowed necromancer!"]) {
                    const { r } = await casting(w => { begins(w); ends(w); }, 0, line);
                    expect(r).toMatchObject({ success: true });
                }
            });

            test('no begin line by then: the cast\'s own refusal after all, at the same target', async () => {
                const t0 = Date.now();
                const { r } = await casting(() => {});
                expect(r).toMatchObject({ success: false, reason: 'refused', message: REFUSED });
                expect(Date.now() - t0).toBeLessThan(800);
            });

            test('without an order nearby nothing changes: refused, begin line or no, and at once', async () => {
                const none = await casting(w => { begins(w); ends(w); }, null);
                expect(none.r).toMatchObject({ success: false, reason: 'refused' });
                const old = await casting(w => { begins(w); ends(w); }, 550);
                expect(old.r).toMatchObject({ success: false, reason: 'refused' });
            });

            test('a line that names no attack is the cast\'s, order or none', async () => {
                const { r } = await casting(w => { begins(w); }, 0, 'That target is too far away!');
                expect(r).toMatchObject({ success: false, reason: 'out_of_range' });
            });
        });

        describe('S8: a cast whose target dies', () => {
            const casting = (spell = earth, o: Partial<BotWorldState> = {}) => {
                const made = world({ pet: null, skills: skillsWith(spell), nearbyNpcs: [mob({ x: 560500 })], ...o });
                made.w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => {
                        world.message(`You begin casting a ${spell.name} spell!`, { type: 'spell' });
                        world.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: 3000 });
                    }, 5);
                };
                return made;
            };

            test('the wait ends on its death, not 2.5 s after the cast time: already_dead, with targetDied', async () => {
                // r9: `You begin casting a Murk Blast spell!` at +19.6, `You just killed Petani` at +19.9, then `00:24 Petbon: nuke: timeout (Murk Blast started but no completion was observed)`.
                const { w, bot } = casting();
                setTimeout(() => dies(w, 700), 60);
                const t0 = Date.now();
                const r = await bot.castSpell(earth, 700);
                expect(r).toMatchObject({ success: false, reason: 'already_dead', targetDied: true, completed: false, castTimeMs: 3000 });
                expect(r.message).toContain('young wolf');
                expect(Date.now() - t0).toBeLessThan(800);
            });

            test('with the death in before the cast shows at all too', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [mob({ x: 560500 })] });
                setTimeout(() => dies(w, 700), 20);
                const t0 = Date.now();
                expect(await bot.castSpell(earth, 700)).toMatchObject({ success: false, reason: 'already_dead', targetDied: true });
                expect(Date.now() - t0).toBeLessThan(800);
            });

            test('its own cast that killed it is a cast: the line comes first', async () => {
                const { w, bot } = casting();
                setTimeout(() => {
                    w.message('You cast a Call Minor Earth Elemental spell!', { type: 'spell' });
                    dies(w, 700);
                }, 60);
                expect(await bot.castSpell(earth, 700)).toMatchObject({ success: true, completed: true });
            });

            test('its line in one snapshot with the death: still the death, and no failure for the group', async () => {
                // A cast ending after the reap gets "You must select a target for this spell!" (SpellHandler.cs:923-926), k x 33 ms behind the 0xA2 (GameLoop.cs:152-161).
                // r9: "Each fight also 'nuke: no_target (You must select a target for this spell!)' from the cast that began before the death".
                const { w, bot } = casting();
                setTimeout(() => {
                    dies(w, 700);
                    w.message('You must select a target for this spell!', { type: 'spell' });
                }, 60);
                expect(await bot.castSpell(earth, 700)).toMatchObject({ success: false, reason: 'already_dead', targetDied: true, castTimeMs: 3000 });
            });

            test('the same with the cast not begun: a turn on a stale snapshot, answered in 40 ms', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [mob({ x: 560500 })] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => {
                        dies(world, 700);
                        world.message('You must select a target for this spell!', { type: 'spell' });
                    }, 5);
                };
                const r = await bot.castSpell(earth, 700);
                expect(r).toMatchObject({ success: false, reason: 'already_dead', targetDied: true });
                expect(w.sentOf('castSpell').length).toBe(1);
            });

            test('that line with the target alive is what it was: no_target', async () => {
                const { w, bot } = world({ pet: null, skills: skillsWith(earth), nearbyNpcs: [mob({ x: 560500 })] });
                w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must select a target for this spell!', { type: 'spell' }), 5); };
                expect(await bot.castSpell(earth, 700, { retryNoTarget: false })).toMatchObject({ success: false, reason: 'no_target' });
            });

            describe('a spell that doesn\'t hang on the selected mob: the server goes on, and it lands on what is there', () => {
                // SpellHandler.cs:908-918: a spot for AREA, and no target asked of CONE or of Range 0. HEAD: `You cast a ...` and its damage.
                const landing: [string, ReturnType<typeof spellOf>, number][] = [
                    ['a ground-target area spell', spellOf('Earth Eddies', 81), 3000],
                    ['a point-blank one', spellOf('Burst of Steam', 202), 2500],
                    ['a cone', spellOf('Winters Retribution', 25610), 1500],
                ];
                for (const [what, spell, castTimeMs] of landing) {
                    test(`${what}: the selected mob's death ends nothing`, async () => {
                        const { w, bot } = world({ pet: null, skills: skillsWith(spell), nearbyNpcs: [mob({ x: 560100 })] });
                        w.player.targetObjectId = 700;
                        await Bun.sleep(20);
                        w.handlers.castSpell = (_a, world) => {
                            setTimeout(() => {
                                world.message(`You begin casting a ${spell.name} spell!`, { type: 'spell' });
                                world.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs });
                            }, 5);
                            setTimeout(() => dies(world, 700), 40);
                            setTimeout(() => world.message(`You cast a ${spell.name} spell!`, { type: 'spell' }), 120);
                        };
                        const r = await bot.castSpell(spell);
                        expect(r).toMatchObject({ success: true, completed: true });
                        expect(r.targetDied).toBeUndefined();
                    });
                }
            });

            describe('a line from the pet\'s attack order beside a spell on a friend (the side tick): that spell can\'t earn it', () => {
                // SpellHandler.cs:771-775 reads a Realm spell's target quietly; only ENEMY reaches IsAllowedToAttack (:754, :969). Run 20261103-181417: refused orders on an immune enemy, answered in 184 ms.
                const heal = spellOf('Minor Rejuvenation', 1301);
                const friend = () => makePlayerObj({ objectId: 300, name: 'Tankard', realm: 'albion', x: 560100, y: 511000 });
                const lines = ['Petani is temporarily immune to PvP attacks!', "You can't attack a member of your realm!", "You can't attack a shadowed necromancer!"];
                for (const line of lines) {
                    test(`a heal in progress reads "${line}" as nobody's refusal of it`, async () => {
                        const { w, bot } = world({ pet: null, skills: skillsWith(heal), nearbyPlayers: [friend()] });
                        w.handlers.castSpell = (_a, world) => {
                            setTimeout(() => {
                                world.message(`You begin casting a ${heal.name} spell!`, { type: 'spell' });
                                world.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: 2200 });
                            }, 5);
                            setTimeout(() => world.message(line, { type: 'system' }), 40);
                            setTimeout(() => world.message(`You cast a ${heal.name} spell!`, { type: 'spell' }), 120);
                        };
                        expect(await bot.castSpell(heal, 300)).toMatchObject({ success: true, completed: true });
                    });
                }

                test('an Enemy spell still reads it: that is its own answer too (AbstractServerRules.cs:365, :373)', async () => {
                    const ice = spellOf('Ice Cloud', 152);
                    const { w, bot } = world({ pet: null, skills: skillsWith(ice), nearbyNpcs: [mob({ x: 560100 })] });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You can't attack this target!", { type: 'system' }), 5); };
                    expect((await bot.castSpell(ice, 700)).success).toBe(false);
                });
            });

            test('a death before this cast says nothing, and neither does one of something else', async () => {
                const { w, bot } = casting(earth, { combatEvents: [{ id: 1, kind: 'death', attackerObjectId: null, targetObjectId: 700, receivedAt: Date.now() - 5000 }] });
                setTimeout(() => {
                    w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 701, targetHealthPercent: 0 });
                    w.message('You cast a Call Minor Earth Elemental spell!', { type: 'spell' });
                }, 60);
                expect(await bot.castSpell(earth, 700)).toMatchObject({ success: true });
            });
        });

        describe('S9: small', () => {
            describe('petKill\'s walk into order range', () => {
                test('a death during it reads killed, and ends the walk', async () => {
                    // out4/c2h3.log: 'petKill 6989 ms {"s":false,"r":"not_found","m":"Target not found: #24389","killed":false,"xp":2289,"money":86,"items":1,...}'; "The owner's walk went on 2.6 s past the death".
                    const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 563000 })] });
                    w.stepSize = 20;
                    setTimeout(() => dies(w, 700), 80);
                    const r = await bot.petKill(700);
                    expect(r).toMatchObject({ success: true, killed: true });
                    expect(w.sentOf('stop').length).toBeGreaterThan(0);
                    expect(w.player.x).toBeLessThan(561500);
                    expect(w.sentOf('petCommand')).toEqual([]);
                });

                test('one walk: a mob that stays out of reach gets the refusal, and no second', async () => {
                    const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 563000 })] });
                    w.stepSize = 1000;
                    const moved = defaultHandlers.moveTo!;
                    w.handlers.moveTo = (a, world) => {
                        const r = moved(a, world);
                        setTimeout(() => { if (world.npc(700)) world.npc(700)!.x = world.player.x + 2400; }, 15);
                        return r;
                    };
                    orders(w, (_a, world) => world.message('Your target is too far away to attack with your pet!'));
                    const r = await bot.petKill(700);
                    expect(r).toMatchObject({ success: false, reason: 'out_of_range' });
                    expect(w.sentOf('moveTo').length).toBeLessThanOrEqual(2);
                    expect(w.sentOf('petCommand')).toHaveLength(1);
                });

                test('its range goes by 3D: over 2000 off with under 1500 on the plane still gets a walk', async () => {
                    // out4/c2f.log: mob 3D 2188, plane 1400, dz 1681: 'petKill 103 ms {"r":"out_of_range",...}', 'moved 0'.
                    const { w, bot } = petWorld({ nearbyNpcs: [petNpc(), mob({ x: 561400, z: 2500 + 1681 })] });
                    orders(w, (a, world) => {
                        const npc = world.npc(700)!;
                        if (Math.hypot(npc.x - world.player.x, npc.y - world.player.y, npc.z - world.player.z) > 2000) return void world.message('Your target is too far away to attack with your pet!');
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        setTimeout(() => dies(world, 700), 20);
                    });
                    expect(await bot.petKill(700)).toMatchObject({ success: true, killed: true });
                    expect(w.sentOf('moveTo').length).toBeGreaterThan(0);
                });
            });

            describe('restoreTarget waits for the model to show it (qrt-204108: \'target at return 13902 wanted 10238\', \'+100 target 10238\')', () => {
                const slowSelect = (w: FakeWorld) => { w.handlers.setTarget = (a, world) => { if (a.type === 'setTarget') setTimeout(() => { world.player.targetObjectId = a.objectId; }, 40); }; };
                const before = () => petWorld({ player: makePlayer({ targetObjectId: 201 }), nearbyNpcs: [petNpc(), mob(), makeNpc({ objectId: 201, name: 'rat', x: 560050 })] });

                test('petAttack', async () => {
                    const { w, bot, sdk } = before();
                    orders(w, (_a, world) => world.message(KILL));
                    slowSelect(w);
                    expect(await bot.petAttack(700, { restoreTarget: true })).toMatchObject({ success: true });
                    expect(sdk.getPlayer()!.targetObjectId).toBe(201);
                });

                test('petGoTo', async () => {
                    const { w, bot, sdk } = before();
                    orders(w, (_a, world) => world.message('You command the amber simulacrum to go to your target.'));
                    slowSelect(w);
                    expect(await bot.petGoTo(700, { restoreTarget: true })).toMatchObject({ success: true });
                    expect(sdk.getPlayer()!.targetObjectId).toBe(201);
                });
            });

            test('a pet lost during a shade\'s step is reported at once', async () => {
                // logs4/d3-a.log: 'pet gone at +11420', '{petKill} +12607 = pet_died', summon begins +12609.
                const { w, bot } = petWorld({ player: makePlayer({ isShade: true }), pet: petWindow({ targetObjectId: 700 }), nearbyNpcs: [petNpc({ x: 561300 }), mob({ x: 560900 })] });
                w.stepSize = 1;
                setTimeout(() => lose(w), 100);
                const t0 = Date.now();
                expect(await bot.petKill(700)).toMatchObject({ success: false, reason: 'pet_died' });
                expect(Date.now() - t0).toBeLessThan(700);
            });

            test('after a respawn no window turret goes up where we stand: it can\'t follow on the walk', async () => {
                // logs4/x3.log, started dead: '23:13.755 You begin casting a Grove's Hunter spell!', '23:16.222 The grove's hunter is now under your control.', then the walk; turret 3845 behind and growing.
                const { w, bot } = world({ pet: null, player: makePlayer({ isDead: true, health: 0, healthPercent: 0 }), skills: skillsWith(turret), groundTarget: { x: 560100, y: 511000, z: 2500 }, nearbyNpcs: [], nearbyObjects: [] });
                w.handlers.release = (_a, world) => {
                    setTimeout(() => {
                        world.player.isDead = false;
                        world.player.health = 100;
                        world.player.healthPercent = 100;
                        world.player.x = 563000;
                    }, 10);
                };
                await bot.grind({ pet: true, respawn: true, durationMs: 800, minEngageMs: 0, noTargetTimeoutMs: 0, anchor: { x: 560000, y: 511000, z: 2500 } });
                const kinds = w.sent.map(a => a.type).filter(t => t === 'release' || t === 'castSpell' || t === 'moveTo');
                expect(kinds.slice(0, 2)).toEqual(['release', 'moveTo']);
            });

            test('a refused replace with no z puts the ground target back where it was', async () => {
                // logs4/u7.log: 'replace at C, no z' false: 'gt {"x":341928,"y":592236,"z":5456}'.
                const was = { x: 560100, y: 511000, z: 2500 };
                const { w, bot } = petWorld({ skills: skillsWith(turret), player: caster(200), groundTarget: was });
                w.handlers.setGroundTarget = (a, world) => { if (a.type === 'setGroundTarget') world.state.groundTarget = { x: a.x, y: a.y, z: a.z ?? 3400 }; };
                const r = await bot.summonPet(turret, { replace: true, groundTarget: { x: 560600, y: 511000 } });
                expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID } });
                expect(w.sentOf('setGroundTarget').at(-1)).toMatchObject(was);
                expect(w.state.groundTarget).toEqual(was);
            });

            describe('Release Clump (TurretSpellHandler.cs:20, :35): the server wants a turret of ours selected, unlike the other Pet spells', () => {
                const clump = spellOf('Release Clump', 11680);
                const released = (w: FakeWorld) => {
                    w.handlers.castSpell = (_a, world) => {
                        const on = world.player.targetObjectId;
                        setTimeout(() => world.message(on === PET_ID || on === SPIRIT_ID ? 'You cast a Release Clump spell!' : 'You must cast this spell on a creature you are controlling', { type: 'system' }), 5);
                    };
                };

                test('with none selected it selects the window pet', async () => {
                    // logs4/u10.log: window pet up and 2 FnFs: 'Release Clump 252 ms {"s":false,"r":"no_pet","m":"You must cast this spell on a creature you are controlling"}'.
                    const { w, bot } = petWorld({ skills: skillsWith(clump) });
                    released(w);
                    expect(await bot.castSpell(clump)).toMatchObject({ success: true });
                    expect(w.sentOf('setTarget')[0]).toMatchObject({ objectId: PET_ID });
                });

                test('with no window, a summon', async () => {
                    const { w, bot } = world({ pet: null, summons: [SPIRIT_ID], skills: skillsWith(clump), nearbyNpcs: [spirit()] });
                    released(w);
                    expect(await bot.castSpell(clump)).toMatchObject({ success: true });
                    expect(w.sentOf('setTarget')[0]).toMatchObject({ objectId: SPIRIT_ID });
                });

                test('one of ours selected already stays', async () => {
                    const { w, bot } = petWorld({ skills: skillsWith(clump), player: makePlayer({ targetObjectId: SPIRIT_ID }), summons: [SPIRIT_ID], nearbyNpcs: [petNpc(), spirit()] });
                    released(w);
                    expect(await bot.castSpell(clump)).toMatchObject({ success: true });
                    expect(w.sentOf('setTarget')).toEqual([]);
                });

                test('no pet at all stays no_pet, with nothing sent', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(clump), nearbyNpcs: [] });
                    expect(await bot.castSpell(clump)).toMatchObject({ success: false, reason: 'no_pet' });
                    expect(w.sent).toEqual([]);
                });

                test('its line, with no stop, is invalid_target; the other Pet spells\' with one stays no_pet', () => {
                    expect(castFailureReason('You must cast this spell on a creature you are controlling')).toBe('invalid_target');
                    expect(castFailureReason('You must cast this spell on a creature you are controlling.')).toBe('no_pet');
                });
            });

            test('a spell with a radius reads around its target: the damage went to all of them', async () => {
                // logs4/u11.log: 'Cast Briar Burst on battle messenger for 62 damage': the 62 went to 5 mobs.
                const burst = spellOf('Briar Burst', 11632);
                const { w, bot } = petWorld({ skills: skillsWith(burst), nearbyNpcs: [petNpc(), mob({ name: 'battle messenger', x: 560200 })] });
                w.handlers.castSpell = (_a, world) => {
                    setTimeout(() => {
                        world.message('You begin casting a Briar Burst spell!', { type: 'spell' });
                        world.message('You cast a Briar Burst spell!', { type: 'spell' });
                    }, 5);
                };
                const r = await bot.castSpell(burst, 700);
                expect(r.message).toStartWith('Cast Briar Burst around battle messenger');
            });

            test('beyond the range says a number beyond the range', async () => {
                // logs4/u6.log: 3D 1000.1, 'The ground target is 1000 from us, beyond the 1000 of Battle Messenger'.
                const { bot } = petWorld({ skills: skillsWith(turret), player: caster(200) });
                const r = await bot.summonPet(turret, { replace: true, groundTarget: { x: 561000, y: 511014, z: 2500 } });
                expect(r).toMatchObject({ success: false, reason: 'out_of_range' });
                expect(r.message).toContain('is 1001 from us, beyond the 1000');
            });
        });

        describe('H: hands', () => {
            const RANGED = "You can't enter melee combat mode with a ranged weapon!";
            const item = (slot: number, name: string, objectType: number): InventoryItem => ({ slot, name, level: 1, count: 1, model: 3, objectType, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 });
            const sword = item(10, 'training sword', ObjectType.Sword);
            const spear = item(12, 'training spear', ObjectType.Spear);
            const bow = item(13, 'rowan bow', ObjectType.CompositeBow);
            const shield = item(11, 'small shield', ObjectType.Shield);
            const rat = () => makeNpc({ objectId: 201, name: 'rat', x: 560050, y: 511000 });
            const specs = (sword: number, spear: number) => [{ name: 'Sword', level: sword, internalId: 1, bonus: 0 }, { name: 'Spear', level: spear, internalId: 2, bonus: 0 }];
            const style = (name: string, weapon: string) => ({ name, internalId: 3, specLevel: 2, specName: weapon, skillIndex: 7, prerequisite: 0x100, details: { weapon } as any });
            const bowInHand = (w: FakeWorld, opts: { switches?: boolean } = {}) => {
                let ranged = true;
                w.handlers.attack = (a, world) => {
                    if (a.type !== 'attack') return;
                    if (!ranged) { world.player.attacking = a.on; return; }
                    setTimeout(() => world.message(RANGED, { type: 'youHit' }), a.on ? 5 : 25);
                };
                w.handlers.useItem = (a, world) => {
                    if (a.type !== 'useItem') return;
                    setTimeout(() => {
                        world.message(`You attempt to use ${world.state.equipment.find(i => i.slot === a.slot)?.name}.`);
                        if (opts.switches !== false && !a.useType) ranged = false;
                    }, 40);
                };
            };

            describe('attack', () => {
                test('on the bow\'s line it takes a melee slot and swings, as killNpc does', async () => {
                    // 20261103-161217: '16:12:18 Pethun: pull: refused (You can\'t enter melee combat mode with a ranged weapon!)', '(×28 more)', 'No kills in the whole run'.
                    const { w, bot } = world({ equipment: [sword, bow], nearbyNpcs: [rat()] });
                    bowInHand(w);
                    expect(await bot.attack(201)).toMatchObject({ success: true });
                    expect(w.sentOf('useItem').map(a => [a.slot, a.useType])).toEqual([[10, 0]]);
                    expect(w.player.attacking).toBeTrue();
                });

                test('once: if the line stays that is the answer', async () => {
                    const { w, bot } = world({ equipment: [sword, bow], nearbyNpcs: [rat()] });
                    bowInHand(w, { switches: false });
                    expect(await bot.attack(201)).toMatchObject({ success: false, reason: 'refused', message: RANGED });
                    expect(w.sentOf('useItem')).toHaveLength(1);
                });

                test('with nothing to swing it refuses at the top: no walk', async () => {
                    // b7b: 'attack 2072ms moved=344'; 'killNpc(usePet:false) 2594ms moved=425 "We have no weapon to fight wood-eater worker with"'.
                    for (const equipment of [[bow], [shield, bow], [item(11, 'left blade', ObjectType.Blades)]]) {
                        const { w, bot } = world({ equipment, pet: null, nearbyNpcs: [makeNpc({ objectId: 201, x: 561000 })] });
                        const r = await bot.attack(201);
                        expect(r).toMatchObject({ success: false, reason: 'refused' });
                        expect(r.message).toContain('no weapon');
                        expect(w.sent).toEqual([]);
                    }
                });
            });

            test('killNpc with only a bow refuses at the top too', async () => {
                const { w, bot } = world({ equipment: [bow], pet: null, nearbyNpcs: [makeNpc({ objectId: 201, x: 561000 })] });
                const r = await bot.killNpc(201);
                expect(r).toMatchObject({ success: false, reason: 'refused' });
                expect(r.message).toContain('no weapon');
                expect(w.sent).toEqual([]);
            });

            describe('killPlayer', () => {
                test('on the bow\'s line it takes a melee slot and fights on, as killNpc does', async () => {
                    // midrvr, --role=pethun:tank with a bow in hand: tank() calls killPlayer, fight() returns refused on the line, and the next turn repeats it.
                    const { w, bot } = world({ equipment: [sword, spear, bow], skills: { specializations: specs(1, 10), abilities: [], styles: [], spells: [] }, nearbyPlayers: [enemy()] });
                    playerFightSim(w);
                    bowInHand(w);
                    expect(await bot.killPlayer(301, { timeout: 3000 })).toMatchObject({ success: true, killed: true, player: { objectId: 301 } });
                    expect(w.sentOf('useItem').map(a => [a.slot, a.useType])).toEqual([[12, 0]]);
                });

                test('with the line staying it stops at that, once', async () => {
                    const { w, bot } = world({ equipment: [sword, bow], nearbyPlayers: [enemy()] });
                    bowInHand(w, { switches: false });
                    expect(await bot.killPlayer(301, { timeout: 3000 })).toMatchObject({ success: false, reason: 'refused' });
                    expect(w.sentOf('useItem').length).toBe(1);
                });

                test('with nothing to swing it refuses before any walk', async () => {
                    const { w, bot } = world({ equipment: [bow], nearbyPlayers: [enemy()] });
                    expect(await bot.killPlayer(301)).toMatchObject({ success: false, reason: 'refused', player: { objectId: 301 } });
                    expect(w.sentOf('moveTo')).toEqual([]);
                });
            });

            describe('which slot', () => {
                const fromTheBow = async (o: Partial<BotWorldState>, options: Parameters<BotActions['killNpc']>[1] = {}) => {
                    const made = world({ equipment: [sword, spear, bow], nearbyNpcs: [rat()], ...o });
                    fightSim(made.w);
                    bowInHand(made.w);
                    expect(await made.bot.killNpc(201, options)).toMatchObject({ killed: true });
                    return made;
                };
                const skills = (o: object) => ({ specializations: [], abilities: [], styles: [], spells: [], ...o });

                test('the weapon the first style asks for', async () => {
                    // s5-bow-both-xp, styles ['Dazzling Spear'], sword in 10 (spec 1), spear in 12 (spec 10): "You wield the training sword in your right hand." then "This style requires a Spear weapon!" on each swing.
                    const { w } = await fromTheBow({ skills: skills({ styles: [style('Dazzling Spear', 'Spear')], specializations: specs(10, 1) }) }, { styles: ['Dazzling Spear'] });
                    expect(w.sentOf('useItem')[0]).toMatchObject({ slot: 12, useType: 0 });
                });

                test('with a style for any weapon, or none, the higher spec of the two', async () => {
                    const { w } = await fromTheBow({ skills: skills({ styles: [style('Slam', 'Any')], specializations: specs(1, 10) }) }, { styles: ['Slam'] });
                    expect(w.sentOf('useItem')[0]).toMatchObject({ slot: 12 });
                    const plain = await fromTheBow({ skills: skills({ specializations: specs(10, 1) }) });
                    expect(plain.w.sentOf('useItem')[0]).toMatchObject({ slot: 10 });
                });

                test('with the specs alike, the last one we took in hand', async () => {
                    const { w, bot } = world({ equipment: [sword, spear, bow], skills: skills({ specializations: specs(5, 5) }), nearbyNpcs: [rat()] });
                    fightSim(w);
                    bowInHand(w);
                    expect(await bot.takeMeleeSlot({ weapon: 'Spear' })).toMatchObject({ success: true, slot: 12 });
                    w.sent = [];
                    expect(await bot.takeMeleeSlot()).toMatchObject({ success: true, slot: 12 });
                });

                test('with nothing to go by, the right hand', async () => {
                    const { w } = await fromTheBow({});
                    expect(w.sentOf('useItem')[0]).toMatchObject({ slot: 10 });
                });

                test('a two-hander alone is that', async () => {
                    const { w } = await fromTheBow({ equipment: [spear, bow] });
                    expect(w.sentOf('useItem')[0]).toMatchObject({ slot: 12 });
                });
            });

            describe('in the fight, on "This style requires a X weapon!" (StyleProcessor.cs:175): the state can\'t say what is in hand', () => {
                test('it uses the slot holding X, once', async () => {
                    // r3 (sword in hand after login, Sword 1, Spear 10): 'You attack the lake serpent with your sword and hit for 3 (-1) damage!', 'This style requires a Spear weapon!' 15×, 'opener Engage'.
                    const { w, bot } = world({ equipment: [sword, spear], skills: { specializations: [], abilities: [], styles: [style('Engage', 'Spear')], spells: [] }, nearbyNpcs: [rat()] });
                    fightSim(w, { dmg: 2 });
                    let lines = 0;
                    w.handlers.useSkill = (_a, world) => {
                        if (w.sentOf('useItem').length) return;
                        lines++;
                        world.message('This style requires a Spear weapon!', { type: 'system' });
                    };
                    w.handlers.useItem = (a, world) => {
                        if (a.type === 'useItem') setTimeout(() => world.message(`You attempt to use ${world.state.equipment.find(i => i.slot === a.slot)?.name}.`), 5);
                    };
                    expect(await bot.killNpc(201, { styles: ['Engage'], timeout: 2000 })).toMatchObject({ killed: true });
                    expect(lines).toBeGreaterThanOrEqual(1);
                    expect(w.sentOf('useItem').map(a => [a.slot, a.useType])).toEqual([[12, 0]]);
                });

                test('with no such weapon it fights on with what it has', async () => {
                    const { w, bot } = world({ equipment: [sword], skills: { specializations: [], abilities: [], styles: [style('Engage', 'Spear')], spells: [] }, nearbyNpcs: [rat()] });
                    fightSim(w, { dmg: 25 });
                    w.handlers.useSkill = (_a, world) => { world.message('This style requires a Spear weapon!', { type: 'system' }); };
                    expect(await bot.killNpc(201, { styles: ['Engage'], timeout: 2000 })).toMatchObject({ killed: true });
                    expect(w.sentOf('useItem')).toEqual([]);
                });
            });

            describe('bot.takeMeleeSlot', () => {
                test('reports the slot, and refuses with nothing to swing', async () => {
                    const up = world({ equipment: [sword, bow] });
                    bowInHand(up.w);
                    expect(await up.bot.takeMeleeSlot()).toMatchObject({ success: true, slot: 10 });
                    const none = world({ equipment: [bow] });
                    expect(await none.bot.takeMeleeSlot()).toMatchObject({ success: false, reason: 'refused', slot: null });
                    expect(none.w.sent).toEqual([]);
                });

                describe('keepOnTie: what a run\'s start asks, with the owner\'s hand as good a guide as any', () => {
                    // live4 B8: 'A two-hander (Focus Staff in slot 12 beside the sword): "Killed spriggarn elder in 13.3s"; after unequipping it ... "Killed spriggarn elder in 27.2s"'. groups/midgard: 'Bragi holds 10 training axe, 11 small training shield, 12 Dragon-shadow Great Axe'.
                    const axe = item(10, 'training axe', ObjectType.Axe);
                    const greatAxe = item(12, 'great axe', ObjectType.Axe);
                    const axes = { specializations: [{ name: 'Axe', level: 10, internalId: 1, bonus: 0 }], abilities: [], styles: [style('Plague', 'Axe')], spells: [] };

                    test('two weapons of one line: nothing goes out, and it says so', async () => {
                        const { w, bot } = world({ equipment: [axe, greatAxe], skills: axes });
                        const r = await bot.takeMeleeSlot({ keepOnTie: true });
                        expect(r).toMatchObject({ success: true, slot: null });
                        expect(r.message).toContain('training axe');
                        expect(r.message).toContain('great axe');
                        expect(w.sentOf('useItem')).toEqual([]);
                    });

                    test('a style both fit tells them no more apart', async () => {
                        const { w, bot } = world({ equipment: [axe, greatAxe], skills: axes });
                        expect(await bot.takeMeleeSlot({ styles: ['Plague'], keepOnTie: true })).toMatchObject({ success: true, slot: null });
                        expect(w.sentOf('useItem')).toEqual([]);
                    });

                    test('a higher spec or a style for one of them does: Hunter, Sword 1, Spear 10', async () => {
                        const bySpec = world({ equipment: [sword, spear], skills: { specializations: specs(1, 10), abilities: [], styles: [], spells: [] } });
                        bowInHand(bySpec.w);
                        expect(await bySpec.bot.takeMeleeSlot({ keepOnTie: true })).toMatchObject({ success: true, slot: 12 });
                        const byStyle = world({ equipment: [sword, spear], skills: { specializations: specs(5, 5), abilities: [], styles: [style('Engage', 'Spear')], spells: [] } });
                        bowInHand(byStyle.w);
                        expect(await byStyle.bot.takeMeleeSlot({ styles: ['Engage'], keepOnTie: true })).toMatchObject({ success: true, slot: 12 });
                    });

                    test('claws are a line of their own: a Savage on Hand to Hand 24 keeps them over a two-hander at Sword 1, what a Viking starts with', async () => {
                        const skills = { specializations: [{ name: 'Hand to Hand', level: 24, internalId: 1, bonus: 0 }, { name: 'Sword', level: 1, internalId: 2, bonus: 0 }], abilities: [], styles: [], spells: [] };
                        const { bot } = world({ equipment: [item(10, 'moon claw', ObjectType.HandToHand), item(11, 'moon claw', ObjectType.HandToHand), item(12, 'great sword', ObjectType.Sword)], skills });
                        expect((await bot.takeMeleeSlot({ keepOnTie: true })).slot).toBe(10);
                    });

                    test('one weapon alone is no tie', async () => {
                        const { w, bot } = world({ equipment: [sword, bow] });
                        bowInHand(w);
                        expect(await bot.takeMeleeSlot({ keepOnTie: true })).toMatchObject({ success: true, slot: 10 });
                    });

                    test('without it a tie goes as ever, to the last we took and then the right hand: a script asks for melee in hand, and a bow may be there', async () => {
                        const { w, bot } = world({ equipment: [axe, greatAxe], skills: axes });
                        bowInHand(w);
                        expect(await bot.takeMeleeSlot()).toMatchObject({ success: true, slot: 10 });
                    });
                });

                test('weapon: the slot holding it, in the server\'s words; none of it is not_found', async () => {
                    const { w, bot } = world({ equipment: [sword, spear] });
                    bowInHand(w);
                    expect(await bot.takeMeleeSlot({ weapon: 'Spear' })).toMatchObject({ success: true, slot: 12 });
                    expect(await bot.takeMeleeSlot({ weapon: 'Hammer' })).toMatchObject({ success: false, reason: 'not_found', slot: null });
                });
            });
        });

        describe('what the solo re-check found', () => {
            const nuke = spellOf('Minor Vitality Drain', 651);
            const heal = spellOf('Minor Rejuvenation', 1301);
            const revive = spellOf('Revive', 1315, 10, 3);
            const friend = (o: Partial<NearbyPlayer> = {}) => makePlayerObj({ objectId: 400, name: 'Pettan', x: 563000, ...o });
            const castsOf = (w: FakeWorld) => w.sentOf('castSpell');
            const down = (w: FakeWorld, id: number, o: Partial<NearbyPlayer>) => { w.state.nearbyPlayers = w.state.nearbyPlayers.map(p => p.objectId === id ? { ...p, ...o } : p); };
            const running = (o: Partial<NearbyNpc>, at: { x: number; y: number } = { x: 560000, y: 511000 }) => {
                const n = mob({ speed: 190, ...o });
                return { ...n, heading: o.heading ?? headingBetween(n, at) };
            };

            describe('A1: a walk ends on its target\'s death', () => {
                // out5/h4c1.log: '23.33 S {"atk":false,"myT":null,"e":null,"mv":true}', '23.95 attack 6668 ms {"s":false,"r":"not_found","m":"black mauler juvenile disappeared","npc":[18013,28]}', with 'The black mauler juvenile dies!' on the way.
                const far = (o: Partial<BotWorldState> = {}) => {
                    const made = world({ pet: null, skills: skillsWith(nuke), nearbyNpcs: [mob({ x: 562000 })], nearbyPlayers: [], nearbyObjects: [], ...o });
                    made.w.stepSize = 5;
                    return made;
                };
                const stands = async (w: FakeWorld) => {
                    await Bun.sleep(30);
                    expect(w.state.movement.moving).toBe(false);
                    const { x } = w.player;
                    await Bun.sleep(30);
                    expect(w.player.x).toBe(x);
                };

                test('attack: already_dead as it dies, the mover stopped, no swing', async () => {
                    const { w, bot } = far();
                    setTimeout(() => dies(w, 700), 60);
                    const t0 = Date.now();
                    expect(await bot.attack(700)).toMatchObject({ success: false, reason: 'already_dead', npc: { objectId: 700 }, target: { objectId: 700 } });
                    expect(Date.now() - t0).toBeLessThan(500);
                    await stands(w);
                    expect(w.sentOf('attack')).toEqual([]);
                });

                test('a swing from before goes off with it: the API says so', async () => {
                    const { w, bot } = far();
                    w.player.attacking = true;
                    w.player.targetObjectId = 900;
                    w.publish();
                    setTimeout(() => dies(w, 700), 60);
                    expect(await bot.attack(700)).toMatchObject({ reason: 'already_dead' });
                    expect(w.sentOf('attack').map(a => a.on)).toEqual([false]);
                });

                test('a player goes by its dead flag as well', async () => {
                    const { w, bot } = far({ nearbyNpcs: [], nearbyPlayers: [makePlayerObj({ objectId: 415, name: 'Briton', realm: 'hibernia', x: 562000 })] });
                    setTimeout(() => down(w, 415, { isDead: true, healthPercent: 0 }), 60);
                    const t0 = Date.now();
                    expect(await bot.attack(415)).toMatchObject({ success: false, reason: 'already_dead', target: { objectId: 415 } });
                    expect(Date.now() - t0).toBeLessThan(500);
                    await stands(w);
                });

                test('castSpell: dead before it looked and a silent server read already_dead; with no death it stays no_response', async () => {
                    // rbhib 20261104-154227: Rbenc 'nuke: no_response' at 15:44:47, 3 s behind Rbsor's kill at 44.113 (SpellHandler.cs:923-926 says nothing to a corpse).
                    const near = () => world({ pet: null, skills: skillsWith(nuke), nearbyNpcs: [mob({ x: 560100, firstSeenAt: Date.now() + 1000 })], nearbyPlayers: [], nearbyObjects: [] });
                    const dead = near();
                    dead.w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                    dead.w.publish();
                    expect(await dead.bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'already_dead', targetDied: true });
                    const alive = near();
                    expect(await alive.bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'no_response' });
                }, 10_000);

                test('castSpell: already_dead with targetDied, nothing cast, nothing held', async () => {
                    // cw-nuke: 'RESULT (6194 ms) {"success":false,"message":"spriggarn elder disappeared","reason":"not_found","castTimeMs":null,...} targetDied undefined moved 1050 speed 0'.
                    const { w, bot } = far();
                    setTimeout(() => dies(w, 700), 60);
                    const t0 = Date.now();
                    expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'already_dead', targetDied: true, spell: { name: nuke.name }, target: { objectId: 700 } });
                    expect(Date.now() - t0).toBeLessThan(500);
                    await stands(w);
                    expect(castsOf(w)).toEqual([]);
                    expect(bot.castHeldLeftMs()).toBe(0);
                });

                test('a friend who dies on the way: the healer stops, and doesn\'t walk into what killed it', async () => {
                    // 'heal from 2991 19305 ms {reason:already_dead, msg:Pettan is dead!} he died at 974 her model {d:1032, dead:true, hp:0}', 'The bandit hits your leg for 13'. She died.
                    const { w, bot } = far({ skills: skillsWith(heal), nearbyNpcs: [], nearbyPlayers: [friend()] });
                    setTimeout(() => down(w, 400, { isDead: true, healthPercent: 0 }), 60);
                    const t0 = Date.now();
                    expect(await bot.castSpell(heal, 400)).toMatchObject({ success: false, reason: 'already_dead', message: 'Pettan is dead!', targetDied: true });
                    expect(Date.now() - t0).toBeLessThan(500);
                    await stands(w);
                    expect(w.player.x).toBeLessThan(560300);
                    expect(castsOf(w)).toEqual([]);
                });

                test('a corpse that gets up on the way: the same stop, in a Corpse spell\'s own words', async () => {
                    const scene = () => far({ skills: skillsWith(revive), nearbyNpcs: [], nearbyPlayers: [friend({ isDead: true, healthPercent: 0, level: 20 })], player: makePlayer({ level: 20, mana: 1000, maxMana: 1000 }) });
                    const raw = scene();
                    setTimeout(() => down(raw.w, 400, { isDead: false, healthPercent: 60 }), 60);
                    expect(await raw.bot.castSpell(revive, 400)).toMatchObject({ success: false, reason: 'invalid_target', message: 'This spell only works on dead members of your realm!' });
                    await stands(raw.w);
                    expect(castsOf(raw.w)).toEqual([]);
                    const rez = scene();
                    setTimeout(() => down(rez.w, 400, { isDead: false, healthPercent: 60 }), 60);
                    expect(await rez.bot.resurrect(400)).toMatchObject({ success: false, reason: 'not_dead' });
                    expect(castsOf(rez.w)).toEqual([]);
                });

                test('out of view with no death: not_found, at the end of the walk', async () => {
                    const { w, bot } = far();
                    w.stepSize = 100;
                    setTimeout(() => w.removeNpc(700), 30);
                    expect(await bot.attack(700)).toMatchObject({ success: false, reason: 'not_found', message: 'young wolf disappeared' });
                    expect(w.player.x).toBeGreaterThan(561000);
                });

                test('walkToObject stops too, with targetDied for what reads it; a walk to a corpse goes on', async () => {
                    const { w, bot } = far();
                    setTimeout(() => dies(w, 700), 60);
                    expect(await bot.walkToObject(700, { range: 100 })).toMatchObject({ success: false, reason: 'already_dead', targetDied: true, target: { objectId: 700 } });
                    const corpse = world({ pet: null, nearbyNpcs: [], nearbyPlayers: [friend({ isDead: true, healthPercent: 0 })], nearbyObjects: [] });
                    expect(await corpse.bot.walkToObject(400, { range: 200 })).toMatchObject({ success: true });
                    expect(corpse.w.player.x).toBeGreaterThan(562000);
                });

                describe('unknown_object: the client\'s model has dropped the object, and the snapshot still holds it', () => {
                    // out5/h4a.log: '10.92 attack unknown_object unknown objectId 4683 took 0 atk true entry true', 2 of 54 calls on that mob.
                    const gap = (o: Partial<PlayerState> = {}) => {
                        const made = world({ pet: null, player: makePlayer({ attacking: true, targetObjectId: 700, ...o }), nearbyNpcs: [mob({ x: 560050 })], nearbyPlayers: [], nearbyObjects: [] });
                        made.w.handlers.setTarget = () => ({ success: false, message: 'unknown objectId 700', reason: 'unknown_object' });
                        return made;
                    };

                    test('with its death in the next snapshot: already_dead, the swing off', async () => {
                        const { w, bot } = gap();
                        setTimeout(() => dies(w, 700), 15);
                        expect(await bot.attack(700)).toMatchObject({ success: false, reason: 'already_dead' });
                        expect(w.player.attacking).toBe(false);
                    });

                    test('with none: not_found', async () => {
                        const { w, bot } = gap();
                        setTimeout(() => w.removeNpc(700), 15);
                        expect(await bot.attack(700)).toMatchObject({ success: false, reason: 'not_found', message: 'young wolf disappeared' });
                    });
                });

                describe('an id gone by the time we ask, with its death just behind it: 3 melee:not_found in 5 kills (brief 5 R12)', () => {
                    const gone = async (ago: number | null) => {
                        const made = world({ pet: null, skills: skillsWith(nuke), nearbyNpcs: [mob({ x: 560500 })], nearbyPlayers: [], nearbyObjects: [] });
                        if (ago !== null) dies(made.w, 700);
                        else made.w.removeNpc(700);
                        made.w.state.combatEvents = made.w.state.combatEvents.map(e => ({ ...e, receivedAt: e.receivedAt - (ago ?? 0) }));
                        await Bun.sleep(30);
                        return made;
                    };

                    test('attack, castSpell, killNpc and a walk read already_dead', async () => {
                        const { bot } = await gone(100);
                        expect(await bot.attack(700)).toMatchObject({ success: false, reason: 'already_dead', npc: null });
                        expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'already_dead', targetDied: true });
                        expect(await bot.killNpc(700)).toMatchObject({ success: false, reason: 'already_dead' });
                        expect(await bot.walkToObject(700)).toMatchObject({ success: false, reason: 'already_dead', targetDied: true });
                    });

                    test('a death long past, or none, stays not_found', async () => {
                        for (const ago of [60_000, null]) {
                            const { bot } = await gone(ago);
                            expect(await bot.attack(700)).toMatchObject({ reason: 'not_found' });
                            expect(await bot.castSpell(nuke, 700)).toMatchObject({ reason: 'not_found' });
                            expect(await bot.killNpc(700)).toMatchObject({ reason: 'not_found' });
                            expect(await bot.walkToObject(700)).toMatchObject({ reason: 'not_found' });
                        }
                    });

                    test('by name there is nobody to say it of', async () => {
                        const { bot } = await gone(100);
                        expect(await bot.attack('young wolf')).toMatchObject({ reason: 'not_found' });
                    });
                });
            });

            describe('A2: attack mode left on', () => {
                // out6/vh4b-111613: 'death at 5485 attacking true target null', the same at 1, 2 and 3 s. vh4c-111643, 30 s later: 'now attacking true target null hp 113 inC true'.
                const beside = (o: Partial<BotWorldState> = {}) => petWorld({ nearbyNpcs: [petNpc(), mob({ x: 560050 }), mob({ objectId: 701, x: 560060 })], ...o });
                const onLeft = (w: FakeWorld) => w.sentOf('attack').map(a => a.on);

                test('a swing at a mob the pet kills goes off at its death', async () => {
                    const { w, bot } = beside();
                    expect(await bot.attack(700)).toMatchObject({ success: true });
                    w.player.targetObjectId = null;
                    dies(w, 700);
                    await Bun.sleep(40);
                    expect(onLeft(w)).toEqual([true, false]);
                    expect(w.player.attacking).toBe(false);
                });

                test('with our selection on it still, as well', async () => {
                    const { w, bot } = beside();
                    await bot.attack(700);
                    dies(w, 700);
                    await Bun.sleep(40);
                    expect(onLeft(w)).toEqual([true, false]);
                });

                test('a player\'s goes by its dead flag', async () => {
                    const { w, bot } = beside({ nearbyNpcs: [petNpc()], nearbyPlayers: [makePlayerObj({ objectId: 415, name: 'Briton', realm: 'hibernia', x: 560050 })] });
                    await bot.attack(415);
                    down(w, 415, { isDead: true, healthPercent: 0 });
                    await Bun.sleep(40);
                    expect(onLeft(w)).toEqual([true, false]);
                });

                test('a swing gone on to the next mob stays: what comes of the old one is nothing to it', async () => {
                    const { w, bot } = beside();
                    await bot.attack(700);
                    await bot.attack(701);
                    dies(w, 700);
                    await Bun.sleep(40);
                    expect(onLeft(w)).toEqual([true, true]);
                    expect(w.player.attacking).toBe(true);
                });

                test('one on a mob that merely left view stays, and so does one on the living', async () => {
                    const { w, bot } = beside();
                    await bot.attack(700);
                    w.removeNpc(700);
                    w.publish();
                    await Bun.sleep(40);
                    expect(onLeft(w)).toEqual([true]);
                });

                test('a melee fight takes over from it: its first swing isn\'t cut, with the select not yet shown', async () => {
                    const { w, bot } = beside();
                    await bot.attack(700);
                    w.handlers.setTarget = () => {};
                    const fight = bot.killNpc(701, { timeout: 1000, usePet: false });
                    await Bun.sleep(20);
                    dies(w, 700);
                    await Bun.sleep(40);
                    expect(onLeft(w)).toEqual([true]);
                    dies(w, 701);
                    expect(await fight).toMatchObject({ success: true });
                    expect(onLeft(w)).toEqual([true, false]);
                });

                test('asked at a target just dead, with our swing on it: already_dead, and off; a swing on another stays', async () => {
                    const corpse = mob({ x: 560050, healthPercent: 0 });
                    const on = world({ pet: null, player: makePlayer({ attacking: true, targetObjectId: 700 }), nearbyNpcs: [corpse], nearbyPlayers: [] });
                    on.w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                    on.w.publish();
                    expect(await on.bot.attack(700)).toMatchObject({ success: false, reason: 'already_dead' });
                    expect(onLeft(on.w)).toEqual([false]);
                    const other = world({ pet: null, player: makePlayer({ attacking: true, targetObjectId: 701 }), nearbyNpcs: [corpse, mob({ objectId: 701, x: 560060 })], nearbyPlayers: [] });
                    other.w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: 700, targetHealthPercent: 0 });
                    other.w.publish();
                    expect(await other.bot.attack(700)).toMatchObject({ reason: 'already_dead' });
                    expect(onLeft(other.w)).toEqual([]);
                });

                test('once off, a later death sends nothing more: killNpc has ended its own', async () => {
                    const { w, bot } = beside();
                    await bot.attack(700);
                    await w.sdk.sendAttack(false);
                    await Bun.sleep(30);
                    dies(w, 700);
                    await Bun.sleep(40);
                    expect(onLeft(w)).toEqual([true, false]);
                });

                describe('a same-realm player by id', () => {
                    // Petcle: '#3 1004 ms {s:true, msg:Attacking Pettan} atk=true' with chat '31:You enter combat mode and target [Pettan]', then '1496:You can't attack a member of your realm!' after the call returned.
                    const REFUSED = "You can't attack a member of your realm!";
                    const sword = (speed: number) => ({ slot: 10, name: 'sword', level: 1, count: 1, model: 3, objectType: 3, condition: 100, durability: 100, quality: 85, weight: 30, value1: 12, value2: speed, hand: 0 });
                    const scene = (realm: 'albion' | 'hibernia', after: number, speed = 20) => {
                        const made = world({ pet: null, equipment: [sword(speed)], nearbyNpcs: [], nearbyPlayers: [makePlayerObj({ objectId: 415, name: 'Pettan', realm, x: 560050 })] });
                        made.w.handlers.attack = (a, world) => {
                            if (a.type !== 'attack') return;
                            world.player.attacking = a.on;
                            if (a.on) setTimeout(() => world.message(REFUSED), after);
                        };
                        return made;
                    };

                    test('the refusal with the next round is read, and the swing ends', async () => {
                        const { w, bot } = scene('albion', 1300);
                        expect(await bot.attack(415)).toMatchObject({ success: false, reason: 'refused', message: REFUSED });
                        expect(onLeft(w)).toEqual([true, false]);
                        expect(w.player.attacking).toBe(false);
                    });

                    test('an enemy goes as ever: 1 s and no line reads as a swing on its way', async () => {
                        const { w, bot } = scene('hibernia', 60_000);
                        const t0 = Date.now();
                        expect(await bot.attack(415)).toMatchObject({ success: true });
                        expect(Date.now() - t0).toBeLessThan(1400);
                        expect(onLeft(w)).toEqual([true]);
                    });
                });

                test('a line we can walk or turn out of keeps the swing: the fight goes on from there', async () => {
                    const { w, bot } = world({ pet: null, nearbyNpcs: [mob({ x: 560050 })], nearbyPlayers: [] });
                    w.handlers.attack = (a, world) => {
                        if (a.type !== 'attack') return;
                        world.player.attacking = a.on;
                        if (a.on) world.message('The young wolf is not in view!');
                    };
                    expect(await bot.attack(700)).toMatchObject({ reason: 'refused' });
                    expect(onLeft(w)).toEqual([true]);
                });

                test('a bow in hand has no attack mode to end: the hand switch goes on as ever', async () => {
                    const bow = { slot: 13, name: 'rowan bow', level: 1, count: 1, model: 3, objectType: 9, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 };
                    const sword = { slot: 10, name: 'training sword', level: 1, count: 1, model: 3, objectType: 3, condition: 100, durability: 100, quality: 85, weight: 30, value1: 12, value2: 37, hand: 0 };
                    const { w, bot } = world({ pet: null, equipment: [sword, bow], nearbyNpcs: [mob({ x: 560050 })], nearbyPlayers: [] });
                    let inHand = false;
                    w.handlers.attack = (a, world) => {
                        if (a.type !== 'attack') return;
                        if (inHand) world.player.attacking = a.on;
                        else world.message("You can't enter melee combat mode with a ranged weapon!");
                    };
                    w.handlers.useItem = (_a, world) => { inHand = true; world.message('You attempt to use the training sword.'); };
                    expect(await bot.attack(700)).toMatchObject({ success: true });
                    expect(onLeft(w)).toEqual([true, true]);
                });
            });

            describe('A3: castSpell\'s approach stops inside the range', () => {
                // ov: 'Cast Ice Cloud (Minor) on Weakened demon for 6 damage' (10280 ms) 'd0 1907 range 1500 moved 1133 d now 796'. logs5/z4.log: 'clump approach 12951 ms success ... dF 2063', a 4000 spell.
                const castAt = (o: Partial<NearbyNpc>, stepSize = 10) => {
                    const made = world({ pet: null, skills: skillsWith(nuke), nearbyNpcs: [mob(o)], nearbyPlayers: [], nearbyObjects: [] });
                    made.w.stepSize = stepSize;
                    const seen = { at: Infinity };
                    made.w.handlers.castSpell = (_a, world) => {
                        seen.at = world.npc(700)!.distance;
                        setTimeout(() => world.message(`You cast a ${nuke.name} spell!`, { type: 'spell' }), 5);
                    };
                    return { ...made, seen };
                };

                test('a 1500 spell: at 150 inside it, not at half of it', async () => {
                    const { bot, seen } = castAt({ x: 561907 });
                    expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: true });
                    expect(seen.at).toBeLessThanOrEqual(1350);
                    expect(seen.at).toBeGreaterThan(1250);
                });

                test('a 4000 one: 150 too', async () => {
                    const { bot, seen } = castAt({ x: 564147 }, 25);
                    expect(await bot.castSpell(nuke, 700, { range: 4000 })).toMatchObject({ success: true });
                    expect(seen.at).toBeLessThanOrEqual(3850);
                    expect(seen.at).toBeGreaterThan(3700);
                });

                test('a 500 one: 10 %', async () => {
                    const { bot, seen } = castAt({ x: 560700 }, 5);
                    expect(await bot.castSpell(nuke, 700, { range: 500 })).toMatchObject({ success: true });
                    expect(seen.at).toBeLessThanOrEqual(450);
                    expect(seen.at).toBeGreaterThan(400);
                });

                test('in 3D: a mob above us counts its height', async () => {
                    const { bot, seen } = castAt({ x: 561500, z: 3500 });
                    expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: true });
                    expect(seen.at).toBeLessThanOrEqual(1350);
                    expect(seen.at).toBeGreaterThan(1250);
                });

                test('it looks as it goes: a mob walking off is followed by what it reads now', async () => {
                    const { w, bot, seen } = castAt({ x: 561700 });
                    w.onTick = world => { const m = world.npc(700); if (m) m.x += 3; };
                    expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: true });
                    expect(seen.at).toBeLessThanOrEqual(1400);
                    expect(seen.at).toBeGreaterThan(1250);
                });

                test('the server\'s "too far away" stays out_of_range, for a target that moved on after the walk', async () => {
                    const { w, bot } = castAt({ x: 561700 });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('That target is too far away!', { type: 'resisted' }), 5); };
                    expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'out_of_range' });
                });

                describe('a target that moved on from the margin', () => {
                    const NUKE_CAST_SECONDS = getSpells().find(r => r.id === nuke.internalId)!.castTime;
                    // Probe, 1600 off, a mob walking off at 100 with a 3 s cast and the server measuring at the end: 'try 0 out_of_range reading 1628', 'try 1 ... 1630', 'try 2 ... 1631'. Each walk stopped at the same margin. Where the walk stopped at half the range it landed.
                    const tooFar = (o: Partial<NearbyNpc>, extra: NearbyNpc[] = []) => {
                        const made = world({ pet: null, skills: skillsWith(nuke), nearbyNpcs: [mob(o), ...extra], nearbyPlayers: [], nearbyObjects: [] });
                        made.w.stepSize = 20;
                        const at: number[] = [];
                        made.w.handlers.castSpell = (a, world) => {
                            if (a.type !== 'castSpell') return;
                            at.push(world.state.player!.targetObjectId === 701 ? world.npc(701)!.distance : world.npc(700)!.distance);
                            setTimeout(() => world.message(at.length === 1 ? 'That target is too far away!' : `You cast a ${nuke.name} spell!`, { type: at.length === 1 ? 'resisted' : 'spell' }), 5);
                        };
                        return { ...made, at };
                    };

                    test('after its "too far away" the next walk at it stops short by what it leaves in a cast, by our readings', async () => {
                        const { w, bot, at } = tooFar({ x: 561600 });
                        expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'out_of_range' });
                        expect(at[0]).toBeGreaterThan(1250);
                        // 170 units in a second.
                        await Bun.sleep(1000);
                        w.npc(700)!.x = w.player.x + at[0]! + 170;
                        w.publish();
                        expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: true });
                        const wanted = 1350 - 170 * NUKE_CAST_SECONDS;
                        expect(at[1]).toBeLessThanOrEqual(wanted + 60);
                        expect(at[1]).toBeGreaterThan(wanted - 100);
                    });

                    test('at half the range at most: a target that seems to outrun anything still gets the nearest walk there was', async () => {
                        const { w, bot, at } = tooFar({ x: 561600 });
                        await bot.castSpell(nuke, 700);
                        w.npc(700)!.x = w.player.x + 1628;
                        w.publish();
                        expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: true });
                        expect(at[1]).toBeLessThanOrEqual(750);
                        expect(at[1]).toBeGreaterThan(650);
                    });

                    test('and the walk after a cast that landed is the margin\'s again', async () => {
                        const { w, bot, at } = tooFar({ x: 561600 });
                        await bot.castSpell(nuke, 700);
                        w.npc(700)!.x = w.player.x + 1628;
                        w.publish();
                        await bot.castSpell(nuke, 700);
                        w.npc(700)!.x = w.player.x + 1628;
                        w.publish();
                        expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: true });
                        expect(at[2]).toBeGreaterThan(1250);
                    });

                    test('another target keeps the margin', async () => {
                        const { bot, at } = tooFar({ x: 561600 }, [mob({ objectId: 701, x: 560300, y: 512600 })]);
                        await bot.castSpell(nuke, 700);
                        expect(await bot.castSpell(nuke, 701)).toMatchObject({ success: true });
                        expect(at[1]).toBeGreaterThan(1250);
                    });
                });

                describe('a mob high above us: the walk\'s arrival radius leaves only the climb', () => {
                    // Up a cliff: the plane closes and the height stays.
                    const cliff = (w: FakeWorld) => {
                        w.handlers.moveTo = (a, world) => {
                            if (a.type !== 'moveTo') return;
                            const dest = { x: a.x, y: a.y, z: world.player.z };
                            world.tolerance = a.tolerance ?? 16;
                            world.state.movement = { ...world.state.movement, moving: true, destination: dest, waypoints: [dest], lastStopReason: null };
                        };
                    };

                    // walks-and-casts probe: range 1500, 1500 on the plane and 1100 up: 'out_of_reach | Could not get within 1350 of wolf (at 1366) | reading now 1185 | moving true | casts 0'. The same shape, closer.
                    test('the first reading in range ends it there too, and the mover with it', async () => {
                        const { w, bot, seen } = castAt({ x: 560300, z: 2900 }, 1);
                        expect(await bot.castSpell(nuke, 700, { range: 490 })).toMatchObject({ success: true });
                        expect(seen.at).toBeLessThanOrEqual(441);
                        expect(seen.at).toBeGreaterThan(405);
                        expect(w.state.movement.moving).toBe(false);
                    });

                    test('a height it can\'t climb, in the spell\'s range but short of the margin: the cast goes from there', async () => {
                        const { w, bot, seen } = castAt({ x: 560300, z: 3900 }, 1);
                        cliff(w);
                        expect(await bot.castSpell(nuke, 700, { range: 1420 })).toMatchObject({ success: true });
                        expect(seen.at).toBeLessThanOrEqual(1420);
                        expect(w.state.movement.moving).toBe(false);
                    });

                    test('out of reach all the same: the mover stops with the answer, and the answer reads where it got to', async () => {
                        const { w, bot } = castAt({ x: 560300, z: 3900 }, 1);
                        cliff(w);
                        const r = await bot.walkToObject(700, { range: 500 });
                        expect(r).toMatchObject({ success: false, reason: 'out_of_reach' });
                        expect(w.state.movement.moving).toBe(false);
                        expect(r.target!.distance).toBeLessThan(1431);
                        expect(r.message).toContain(`(at ${r.target!.distance})`);
                    });
                });

                test('a walk of the caller\'s own keeps its arrival radius', async () => {
                    const { w, bot } = castAt({ x: 561907 }, 200);
                    await bot.walkToObject(700, { range: 1275 });
                    expect(w.sentOf('moveTo')[0]!.tolerance).toBe(765);
                });
            });

            describe('A4: a replace at the edge of a charm\'s range', () => {
                // logs5/edge3.log: judged d 994, d2 990, spd 0, 'You lose control of the puny skeleton!' at 82, 'You begin casting' at 149, 'That target is too far away!' at 4082, reason out_of_range, pet null. limit_l10.log: the same at 999. 989 and 997 went.
                const edge = (x: number, z?: number) => {
                    const made = petWorld({ skills: skillsWith(charm), player: makePlayer({ level: 20 }), nearbyNpcs: [petNpc(), mob({ x, ...(z === undefined ? {} : { z }) })] });
                    orders(made.w, (_a, world) => { world.removeNpc(PET_ID); world.state.pet = null; });
                    made.w.stepSize = 10;
                    made.w.handlers.castSpell = (_a, world) => {
                        setTimeout(() => {
                            world.message('You cast a Persuade Will spell!', { type: 'spell' });
                            world.state.pet = petWindow({ objectId: 700 });
                        }, 5);
                    };
                    return made;
                };

                test('within the range but past range minus 60: it walks in first', async () => {
                    const { w, bot } = edge(560994);
                    expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                    const kinds = w.sent.map(a => a.type);
                    expect(kinds.indexOf('moveTo')).toBeGreaterThanOrEqual(0);
                    expect(kinds.indexOf('moveTo')).toBeLessThan(kinds.indexOf('petCommand'));
                    expect(w.npc(700)!.distance).toBeLessThanOrEqual(940);
                });

                describe('where that walk stops: range - 70 x cast - 20, as a mob roams at 70 (StandardMobState.cs:141), up to 280 in the 4 s cast', () => {
                    // sorcerer-charm: 'mobs roam at 70'. Read at 1200, roaming away: the walk stopped at 900, the release went, 1174 at the cast's end: 'That target is too far away!', pet null. HEAD's walk went to about 510.
                    const stopsAt = async (x: number) => {
                        const made = edge(x);
                        const seen = { at: Infinity };
                        const cast = made.w.handlers.castSpell!;
                        made.w.handlers.castSpell = (a, world) => { seen.at = world.npc(700)!.distance; return cast(a, world); };
                        expect(await made.bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                        return seen.at;
                    };

                    test.each([[1200], [995]])('read at %i: about 700 at the cast', async d => {
                        const at = await stopsAt(560000 + d);
                        expect(at).toBeLessThanOrEqual(700);
                        expect(at).toBeGreaterThan(600);
                    });

                    test('with no walk to make it stays at 940: no walk is the gain of a replace within it', async () => {
                        const { w, bot } = edge(560939);
                        expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                        expect(w.sentOf('moveTo')).toEqual([]);
                    });

                    const cliff = (w: FakeWorld) => {
                        w.handlers.moveTo = (a, world) => {
                            if (a.type !== 'moveTo') return;
                            const dest = { x: a.x, y: a.y, z: world.player.z };
                            world.tolerance = a.tolerance ?? 16;
                            world.state.movement = { ...world.state.movement, moving: true, destination: dest, waypoints: [dest], lastStopReason: null };
                        };
                    };

                    test('a height it can\'t climb: inside 940 is enough, the pet goes then and the charm with it', async () => {
                        // walks-and-casts probe: 500 on the plane and 810 up, reading 952: 'charm: 2009 ms false out_of_reach | Could not get within 900 of young wolf (at 952) | reading now 820 | moving true | pet 600 | casts 0'.
                        const { w, bot } = edge(560300, 3410);
                        cliff(w);
                        w.stepSize = 1;
                        expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                        expect(w.sentOf('castSpell').length).toBe(1);
                        expect(w.state.movement.moving).toBe(false);
                    });

                    test('and short of it: out_of_reach with the pet kept, the mover stopped, nothing cast', async () => {
                        const { w, bot } = edge(560300, 3500);
                        cliff(w);
                        w.stepSize = 1;
                        const r = await bot.charmPet(700, { replace: true });
                        expect(r).toMatchObject({ success: false, reason: 'out_of_reach', pet: { objectId: PET_ID } });
                        expect(w.sentOf('castSpell')).toEqual([]);
                        expect(w.sentOf('petCommand')).toEqual([]);
                        expect(w.state.movement.moving).toBe(false);
                    });
                });

                test('with approach off: out_of_range, the pet kept, nothing sent', async () => {
                    const { w, bot } = edge(560994);
                    const r = await bot.charmPet(700, { replace: true, approach: false });
                    expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID }, petState: { objectId: PET_ID } });
                    expect(r.message).toContain('940');
                    expect(w.sent).toEqual([]);
                });

                test('inside that: no walk', async () => {
                    const { w, bot } = edge(560930);
                    expect(await bot.charmPet(700, { replace: true })).toMatchObject({ success: true });
                    expect(w.sentOf('moveTo')).toEqual([]);
                });

                test('with no pet to lose nothing changes: the range is the range', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(charm), player: makePlayer({ level: 20 }), nearbyNpcs: [mob({ x: 560994 })], nearbyPlayers: [], nearbyObjects: [] });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => { world.message('You cast a Persuade Will spell!', { type: 'spell' }); world.state.pet = petWindow({ objectId: 700 }); }, 5); };
                    expect(await bot.charmPet(700)).toMatchObject({ success: true });
                    expect(w.sentOf('moveTo')).toEqual([]);
                });
            });

            describe('a swing on another target that attack can\'t take over', () => {
                // Swinging at A, attack(B), and the client has dropped B: the select fails, so the selection stays on A, alive and on us.
                const A = 701;
                const scene = () => {
                    const made = world({ pet: null, player: makePlayer({ attacking: true, targetObjectId: A }), nearbyNpcs: [makeNpc({ objectId: A, name: 'water beetle', x: 560050, targetObjectId: ME }), mob({ x: 560060 })], nearbyPlayers: [], nearbyObjects: [] });
                    made.w.handlers.setTarget = (a, world) => {
                        if (a.type !== 'setTarget') return;
                        if (a.objectId === A) { world.player.targetObjectId = A; return; }
                        return { success: false, message: `unknown objectId ${a.objectId}`, reason: 'unknown_object' };
                    };
                    return made;
                };

                test('B dead in the gap after its death: already_dead, and A\'s swing stays on: it is A\'s', async () => {
                    const { w, bot } = scene();
                    setTimeout(() => dies(w, 700), 15);
                    expect(await bot.attack(700)).toMatchObject({ success: false, reason: 'already_dead' });
                    expect(w.sentOf('attack')).toEqual([]);
                    expect(w.player.attacking).toBe(true);
                });

                test('that swing ends at A\'s death all the same, as it would have with no such call: "attacking stays true on A\'s corpse"', async () => {
                    const { w, bot } = scene();
                    await bot.attack(A);
                    expect(w.player.attacking).toBe(true);
                    w.sent.length = 0;
                    setTimeout(() => dies(w, 700), 15);
                    await bot.attack(700);
                    expect(w.sentOf('attack')).toEqual([]);
                    dies(w, A);
                    await Bun.sleep(60);
                    expect(w.sentOf('attack').map(a => a.on)).toEqual([false]);
                });
            });

            describe('A5: no weapon, no pet, resummon off', () => {
                // logs5/nowep_noresummon2.log, ms 40000: '0 kills, +0 xp, 0 deaths in 41s (duration); our pet died with puny skeleton at 90 %, and it is on us at 93 %', 'fails':36, moved 0, the mob swinging at us for about 30 s.
                const onThePet = (o: Partial<NearbyNpc> = {}, extra: NearbyNpc[] = []) => {
                    const made = petWorld({ equipment: [], skills: skillsWith(simulacrum), pet: petWindow({ targetObjectId: 701 }), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560100, targetObjectId: PET_ID, healthPercent: 90, ...o }), ...extra] });
                    orders(made.w, (a, world) => { if (a.command === 'attack') world.message(KILL); });
                    return made;
                };

                test('the run ends at once: stop error, reason no_pet, one failure, and the note says the mob is on us', async () => {
                    const { w, bot } = onThePet();
                    setTimeout(() => { lose(w, { targetedBy: [701] }); w.npc(701)!.targetObjectId = ME; }, 30);
                    const melee = spyOn(bot, 'killNpc');
                    const t0 = Date.now();
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ success: false, stopReason: 'error', reason: 'no_pet', kills: 0, failures: 1 });
                    expect(r.message).toContain('no weapon');
                    expect(r.message).toContain('and it is on us at 90 %');
                    expect(melee).not.toHaveBeenCalled();
                    expect(Date.now() - t0).toBeLessThan(2000);
                });

                test('another mob on us is named: the note tells the truth about what stands there', async () => {
                    const { w, bot } = onThePet({}, [mob({ objectId: 702, name: 'black wolf', x: 560090, targetObjectId: ME })]);
                    setTimeout(() => { lose(w, { targetedBy: [701] }); w.npc(701)!.targetObjectId = ME; }, 30);
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ stopReason: 'error', reason: 'no_pet' });
                    expect(r.message).toContain('black wolf is on us');
                    expect(r.message).toContain('our pet died with young wolf at 90 %');
                });

                test('with nothing near as well: there is nothing it can fight with', async () => {
                    const { w, bot } = onThePet();
                    setTimeout(() => { lose(w); w.removeNpc(701); }, 30);
                    const r = await bot.grind({ pet: { resummon: false }, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ stopReason: 'error', reason: 'no_pet', failures: 1 });
                    expect(r.message).not.toContain('on us');
                });

                test('with resummon on it waits for the summon, as ever; with a weapon it goes to melee', async () => {
                    const waits = onThePet();
                    waits.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The young wolf attacks you and your spell is interrupted!', { type: 'spell' }), 5); };
                    setTimeout(() => { lose(waits.w, { targetedBy: [701] }); waits.w.npc(701)!.targetObjectId = ME; }, 30);
                    setTimeout(() => dies(waits.w, 701), 250);
                    expect((await waits.bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false })).reason).not.toBe('no_pet');

                    const armed = petWorld({ skills: skillsWith(simulacrum), pet: petWindow({ targetObjectId: 701 }), nearbyNpcs: [petNpc(), mob({ objectId: 701, x: 560050, targetObjectId: PET_ID })] });
                    orders(armed.w, (a, world) => { if (a.command === 'attack') world.message(KILL); });
                    setTimeout(() => { lose(armed.w, { targetedBy: [701] }); armed.w.npc(701)!.targetObjectId = ME; }, 30);
                    setTimeout(() => dies(armed.w, 701), 200);
                    expect(await armed.bot.grind({ pet: { resummon: false }, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                });
            });

            describe('A6: a mob on us within reach, with a new pet up', () => {
                // guard2: '87.99 PASS< petKill false arrived wood-eater royal guard is 231 from us', '87.99 PASS> petKill 24291 d 231 hp 27 mobTgt 24338 atk [] {timeout:19762, ignoreAttackers:false}', '90.01 attacks you and misses', own swings 0, timeout at 107.75, hp 100 to 32.
                const scene = (o: Partial<NearbyNpc>, more: Partial<BotWorldState> = {}) => {
                    const made = petWorld({ skills: skillsWith(simulacrum), pet: petWindow(), nearbyNpcs: [petNpc(), mob({ objectId: 701, healthPercent: 27, ...o })], ...more });
                    orders(made.w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        world.state.pet = petWindow({ targetObjectId: a.targetObjectId! });
                    });
                    made.w.handlers.attack = (a, world) => {
                        if (a.type !== 'attack') return;
                        world.player.attacking = a.on;
                        if (a.on && world.npc(701)) setTimeout(() => dies(world, 701), 20);
                    };
                    return made;
                };

                test('after \'arrived\': the next pass swings, though the mob read on the new pet in passing', async () => {
                    const { w, bot } = scene({ x: 560900, targetObjectId: ME });
                    w.onTick = world => {
                        const m = world.npc(701);
                        if (!m || m.x <= 560240) return;
                        m.x -= 20;
                        // '84.00 attacks your hunter's pet and misses': the model has it on the pet until its next swing.
                        if (m.x <= 560250) m.targetObjectId = PET_ID;
                    };
                    const pet = spyOn(bot, 'petKill');
                    const melee = spyOn(bot, 'killNpc');
                    const r = await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false });
                    expect(r).toMatchObject({ kills: 1 });
                    expect(pet).toHaveBeenCalledTimes(1);
                    expect(melee).toHaveBeenCalledTimes(1);
                    expect(w.sentOf('attack').map(a => a.on)).toContain(true);
                });

                test('a pass with the mob on the pet ends when it turns on us within reach: melee, not the rest of its timeout', async () => {
                    const { w, bot } = scene({ x: 560200, targetObjectId: PET_ID });
                    setTimeout(() => { w.npc(701)!.targetObjectId = ME; }, 60);
                    const melee = spyOn(bot, 'killNpc');
                    const t0 = Date.now();
                    expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 5000, loot: false })).toMatchObject({ kills: 1 });
                    expect(melee).toHaveBeenCalledTimes(1);
                    expect(Date.now() - t0).toBeLessThan(2500);
                });

                test('beyond that reach it stays the pet\'s: no walk out to it', async () => {
                    const { w, bot } = scene({ x: 560400, targetObjectId: PET_ID });
                    const stop = Date.now() + 200;
                    w.onTick = world => { const m = world.npc(701); if (m && m.targetObjectId === ME && Date.now() > stop) dies(world, 701); };
                    setTimeout(() => { w.npc(701)!.targetObjectId = ME; }, 60);
                    const melee = spyOn(bot, 'killNpc');
                    await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false });
                    expect(melee).not.toHaveBeenCalled();
                });

                test.each([['no weapon', { equipment: [] }], ['a shade', { player: makePlayer({ isShade: true }) }]])('with %s there is no melee to go to: the pass goes on', async (_what, o) => {
                    const { w, bot } = scene({ x: 560200, targetObjectId: PET_ID }, o as Partial<BotWorldState>);
                    setTimeout(() => { w.npc(701)!.targetObjectId = ME; }, 40);
                    setTimeout(() => dies(w, 701), 200);
                    const melee = spyOn(bot, 'killNpc');
                    const pet = spyOn(bot, 'petKill');
                    expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false })).toMatchObject({ kills: 1 });
                    expect(melee).not.toHaveBeenCalled();
                    expect(pet).toHaveBeenCalledTimes(1);
                });

                test('petKill reads it only when asked: a caller with no such option fights on', async () => {
                    const { w, bot } = scene({ x: 560200, targetObjectId: ME });
                    setTimeout(() => dies(w, 701), 100);
                    expect(await bot.petKill(701, { ignoreAttackers: true })).toMatchObject({ success: true, killed: true });
                    const asked = scene({ x: 560200, targetObjectId: ME });
                    expect(await asked.bot.petKill(701, { ignoreAttackers: true, endOnUsWithin: 250, timeout: 1000 })).toMatchObject({ success: false, reason: 'arrived' });
                });
            });

            describe('A7: counting', () => {
                test('a pet lost between two passes counts one', async () => {
                    // s6n 2: 'DONE petKill reason=pet_died ... (released)', then 'TEST release in onKill', 'CALL summonPet', result '2 kills ... failures:1' for 2 losses. logs5/a_between2.log: 'kills':1,'fails':0 with loss {cause:'died', targetedBy:[23019]}.
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 }), mob({ objectId: 702, x: 560600 })] });
                    kills(w);
                    w.handlers.castSpell = (_a, world) => {
                        setTimeout(() => {
                            world.message('You cast a Amber Simulacrum spell!', { type: 'spell' });
                            world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc({ objectId: 620 })];
                            world.state.pet = petWindow({ objectId: 620 });
                        }, 5);
                    };
                    let once = false;
                    const r = await bot.grind({
                        pet: true, maxKills: 2, durationMs: 5000, loot: false,
                        onKill: () => {
                            if (once) return;
                            once = true;
                            lose(w, { cause: 'released' });
                            w.publish();
                        },
                    });
                    expect(r).toMatchObject({ kills: 2, failures: 1 });
                });

                test('heard at the loop head and again by a pass, it is still one', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [mob({ objectId: 701 })], lastPetLoss: undefined });
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); };
                    w.state.pet = petWindow();
                    w.state.nearbyNpcs = [petNpc(), mob({ objectId: 701 })];
                    w.publish();
                    orders(w, (a, world) => {
                        if (a.command !== 'attack') return;
                        world.message(KILL);
                        setTimeout(() => lose(world), 20);
                    });
                    spyOn(bot, 'rest').mockImplementation(async () => { await Bun.sleep(50); return { success: true, message: 'Rested', healthPercent: 100, manaPercent: 40, endurancePercent: 100, durationMs: 50 }; });
                    const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false });
                    expect(r.failures).toBe(1);
                });

                test.each([['the owner\'s death', 'owner_died'], ['a region change', 'region_change']])('%s is no failure of its own', async (_what, cause) => {
                    const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ objectId: 701 })] });
                    kills(w);
                    w.handlers.castSpell = (_a, world) => { setTimeout(() => { world.message('You cast a Amber Simulacrum spell!', { type: 'spell' }); world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc({ objectId: 620 })]; world.state.pet = petWindow({ objectId: 620 }); }, 5); };
                    w.state.nearbyNpcs.push(mob({ objectId: 702, x: 560600 }));
                    let once = false;
                    const r = await bot.grind({
                        pet: true, maxKills: 2, durationMs: 5000, loot: false,
                        onKill: () => {
                            if (once) return;
                            once = true;
                            w.removeNpc(PET_ID);
                            w.state.pet = null;
                            w.state.lastPetLoss = { objectId: PET_ID, name: 'amber simulacrum', cause: cause as 'owner_died', at: Date.now() };
                            w.publish();
                        },
                    });
                    expect(r).toMatchObject({ kills: 2, failures: 0 });
                });

                describe('stylesUsed', () => {
                    // h6c, sword only, styles ['Dazzling Spear']: 'stylesUsed':8 with 8 lines 'This style requires a Spear weapon!' and 0 'You perform'. h6b step 2: stylesUsed 5, performed 4, refused 1.
                    const swinging = () => {
                        const made = world({ pet: null, nearbyNpcs: [mob({ x: 560050 })], nearbyPlayers: [] });
                        return made;
                    };

                    test('a style the server refused is none', async () => {
                        const { w, bot } = swinging();
                        w.handlers.useSkill = (_a, world) => { setTimeout(() => world.message('This style requires a Spear weapon!'), 5); };
                        setTimeout(() => dies(w, 700), 150);
                        expect(await bot.killNpc(700, { styles: ['Backslash'] })).toMatchObject({ success: true, stylesUsed: 0 });
                        expect(w.sentOf('useSkill').length).toBeGreaterThan(0);
                    });

                    test('one it took counts', async () => {
                        const { w, bot } = swinging();
                        setTimeout(() => dies(w, 700), 150);
                        expect(await bot.killNpc(700, { styles: ['Backslash'] })).toMatchObject({ success: true, stylesUsed: 1 });
                    });
                });
            });

            describe('A8: replace and the running cast', () => {
                // s8 summon: 'first {reason:already_dead,left:1327}', then '3284 You lose control of the ruby simulacrum!', '4551 You must select a target for this spell!', '4617 You begin casting a Ruby Simulacrum spell!'. out5/cast6.log, the same, 2633 ms behind.
                const NUKE = spellOf('Minor Vitality Drain', 651, 1, 0);
                const SUMMON = spellOf('Amber Simulacrum', 801, 1, 1);
                const held = async (castMs = 700) => {
                    const made = petWorld({ skills: skillsWith(NUKE, SUMMON), player: caster(200), nearbyNpcs: [petNpc(), mob({ x: 560500 })] });
                    made.w.handlers.castSpell = (a, world) => {
                        if (a.type !== 'castSpell') return;
                        if (a.spellIndex === 0) return void setTimeout(() => { world.message(`You begin casting a ${NUKE.name} spell!`, { type: 'spell' }); world.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: castMs }); }, 5);
                        setTimeout(() => {
                            world.message(`You cast a ${SUMMON.name} spell!`, { type: 'spell' });
                            world.state.nearbyNpcs = [...world.state.nearbyNpcs, petNpc({ objectId: 620 })];
                            world.state.pet = petWindow({ objectId: 620 });
                        }, 5);
                    };
                    const releasedAt = { at: 0 };
                    orders(made.w, (a, world) => {
                        if (a.command !== 'release') return;
                        releasedAt.at = Date.now();
                        world.removeNpc(PET_ID);
                        world.state.pet = null;
                    });
                    setTimeout(() => dies(made.w, 700), 60);
                    expect(await made.bot.castSpell(NUKE, 700)).toMatchObject({ reason: 'already_dead', targetDied: true });
                    return { ...made, releasedAt };
                };

                test('the release comes after the hold: the pet is there for the wait', async () => {
                    const { w, bot, releasedAt } = await held();
                    const left = bot.castHeldLeftMs();
                    expect(left).toBeGreaterThan(300);
                    const t0 = Date.now();
                    expect(await bot.summonPet(SUMMON, { replace: true })).toMatchObject({ success: true });
                    expect(releasedAt.at - t0).toBeGreaterThanOrEqual(left - 60);
                    expect(castsOf(w).length).toBe(2);
                });

                test('what the wait changed is judged: a mob on us by its end keeps the pet', async () => {
                    const { w, bot } = await held();
                    w.state.nearbyNpcs = [...w.state.nearbyNpcs, mob({ objectId: 701, x: 560050 })];
                    setTimeout(() => { w.npc(701)!.targetObjectId = ME; }, 100);
                    expect(await bot.summonPet(SUMMON, { replace: true })).toMatchObject({ success: false, reason: 'in_combat', petState: { objectId: PET_ID } });
                    expect(w.sentOf('petCommand').filter(a => a.command === 'release')).toEqual([]);
                });

                test('with no pet there is no release to hold back, and the wait stays castSpell\'s', async () => {
                    const { w, bot } = world({ pet: null, skills: skillsWith(SUMMON), player: caster(200), nearbyNpcs: [] });
                    summons(w, SUMMON.name, 'amber simulacrum');
                    const t0 = Date.now();
                    expect(await bot.summonPet(SUMMON, { replace: true })).toMatchObject({ success: true });
                    expect(Date.now() - t0).toBeLessThan(600);
                });
            });

            describe('A9: end notes and a corpse', () => {
                const tired = (o: Partial<BotWorldState> = {}) => world({ pet: null, skills: skillsWith(simulacrum), nearbyNpcs: [], nearbyPlayers: [], nearbyObjects: [], player: makePlayer({ health: 100, healthPercent: 100, mana: 10, maxMana: 200, manaPercent: 5 }), ...o });
                const noPower = (w: FakeWorld) => { w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message("You don't have enough power to cast that!", { type: 'resisted' }), 5); }; };

                test('no rest ran: the note says what it was at the time, and no "rested"', async () => {
                    // z21r3.out: 'CALL summonPet 50 ms no_power', no rest call in the run, '... (died); we lost our pet first, with arachite shadowslinker at 86 %; no pet: rested for Summon Bone Chieftan, no time left to cast it'.
                    const { w, bot } = tired({ nearbyNpcs: [mob({ objectId: 701, x: 561500, targetObjectId: ME })] });
                    noPower(w);
                    // Regen in a fight, no rest.
                    setTimeout(() => { w.player.mana = 60; }, 50);
                    setTimeout(() => dies(w, 701), 250);
                    const rest = spyOn(bot, 'rest');
                    const r = await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0, killTimeout: 50, loot: false });
                    expect(rest).not.toHaveBeenCalled();
                    expect(r.message).not.toContain('rested for');
                    expect(r.message).toContain('; no pet: short of power for Amber Simulacrum at the time (it can cost 50, and we had 10)');
                });

                test('a rest ran for it, but the run ended by a death: no "no time left"', async () => {
                    const { w, bot } = tired();
                    noPower(w);
                    spyOn(bot, 'rest').mockImplementation(async () => {
                        w.player.mana = 60;
                        await Bun.sleep(50);
                        w.player.isDead = true;
                        w.player.deathCount = 1;
                        return { success: false, reason: 'died', message: 'Died', healthPercent: 0, manaPercent: 30, endurancePercent: 100, durationMs: 50 };
                    });
                    const r = await bot.grind({ pet: true, durationMs: 2000, loot: false });
                    expect(r.stopReason).toBe('died');
                    expect(r.message).not.toContain('no time left');
                });

                test('a rest that ran for it and a run out of time keeps its wording', async () => {
                    const { w, bot } = tired();
                    noPower(w);
                    spyOn(bot, 'rest').mockImplementation(async () => {
                        w.player.mana = 60;
                        await Bun.sleep(150);
                        return { success: true, message: 'Rested', healthPercent: 100, manaPercent: 40, endurancePercent: 100, durationMs: 150 };
                    });
                    const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0 });
                    expect(r.message).toContain('; no pet: rested for Amber Simulacrum, no time left to cast it');
                });

                test('still short at the end: the wording stays', async () => {
                    const { w, bot } = tired();
                    noPower(w);
                    spyOn(bot, 'rest').mockImplementation(async () => { await Bun.sleep(150); return { success: false, reason: 'timeout', message: 'Rest timed out', healthPercent: 100, manaPercent: 5, endurancePercent: 100, durationMs: 100 }; });
                    const r = await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0 });
                    expect(r.message).toContain('; no pet: short of power for Amber Simulacrum (it can cost 50, and we have 10)');
                });

                describe('started on a corpse', () => {
                    // out6/vcorpse-110734: 'GRIND pet on corpse 9 {"s":false,"m":"0 kills, +0 xp, 1 deaths in 0s (died)","reason":"died","deaths":1}', plain grind the same in 0 ms. Beside it summonPet, castSpell, rest and petKill read 'We are dead', reason dead.
                    const corpse = () => world({ pet: null, player: makePlayer({ isDead: true, health: 0, healthPercent: 0, deathCount: 3 }), skills: skillsWith(simulacrum), nearbyNpcs: [], nearbyObjects: [] });

                    test.each([['a plain run', {}], ['with a pet', { pet: true }]])('%s reads as summonPet, castSpell and rest do, and counts no death', async (_what, o) => {
                        const { w, bot } = corpse();
                        const r = await bot.grind({ durationMs: 1000, ...o });
                        expect(r).toMatchObject({ success: false, message: 'We are dead', reason: 'dead', stopReason: 'error', deaths: 0, kills: 0 });
                        expect(w.sent).toEqual([]);
                    });

                    test('respawn: it releases as asked, says so, and that death isn\'t this run\'s', async () => {
                        const { w, bot } = corpse();
                        w.handlers.release = (_a, world) => { setTimeout(() => { world.player.isDead = false; world.player.health = 100; world.player.healthPercent = 100; world.player.x += 5000; }, 10); };
                        const r = await bot.grind({ respawn: true, durationMs: 200, minEngageMs: 0, noTargetTimeoutMs: 0, anchor: { x: 560000, y: 511000, z: 2500 } });
                        expect(r.deaths).toBe(0);
                        expect(r.message).toContain('we began on a corpse');
                        expect(w.sentOf('release')).toHaveLength(1);
                    });

                    test('a death of this run still counts, after that', async () => {
                        const again = corpse();
                        let released = 0;
                        again.w.handlers.release = (_a, world) => {
                            setTimeout(() => { world.player.isDead = false; world.player.health = 100; world.player.healthPercent = 100; world.player.x += 5000; }, 10);
                            if (++released === 1) setTimeout(() => { world.player.isDead = true; world.player.deathCount = 4; }, 100);
                        };
                        expect((await again.bot.grind({ respawn: true, durationMs: 400, minEngageMs: 0, noTargetTimeoutMs: 0, anchor: { x: 560000, y: 511000, z: 2500 } })).deaths).toBe(1);
                    });
                });
            });

            describe('A10: lines', () => {
                const castWith = (lines: (w: FakeWorld) => void, sp: ReturnType<typeof spellOf> = nuke, o: Partial<BotWorldState> = {}) => {
                    const made = world({ pet: null, skills: skillsWith(sp), nearbyNpcs: [mob({ x: 560500 })], nearbyPlayers: [], nearbyObjects: [], ...o });
                    made.w.handlers.castSpell = (_a, world) => { setTimeout(() => lines(world), 5); };
                    return made;
                };

                test('an interrupt\'s retryAfterMs is the server\'s 2200 (SpellHandler.cs:372, ServerProperties.cs:2221-2222)', async () => {
                    // cr-420: '15043 finish: earth ... false interrupted The spriggarn elder attacks you and your spell is interrupted!' with retryAfterMs 2000, slept exactly that, '17100 finish: earth ... false must_wait You must wait 1 seconds to cast a spell!'.
                    const { bot } = castWith(world => world.message('The young wolf attacks you and your spell is interrupted!', { type: 'spell' }));
                    expect(await bot.castSpell(nuke, 700)).toMatchObject({ reason: 'interrupted', retryAfterMs: 2200 });
                });

                describe('a spell\'s lines match its whole name', () => {
                    // s8c-raw: 'NEXT after raw (2758 ms) {"success":false,"message":"That target is too far away!","reason":"out_of_range",... "msgs":["You begin casting a Ice Cloud (Minor) spell!","You are already casting a spell! You prepare this spell as a follow up!","That target is too far away!"]}'.
                    const ice = spellOf('Ice Cloud', 152);
                    const minor = spellOf('Ice Cloud (Minor)', 151);

                    test('the begin line of a longer name doesn\'t lift the hold', async () => {
                        const { bot } = castWith(world => {
                            world.message('You begin casting a Ice Cloud (Minor) spell!', { type: 'spell' });
                            world.message('You are already casting a spell! You prepare this spell as a follow up!', { type: 'resisted' });
                            world.message('That target is too far away!', { type: 'resisted' });
                        }, ice);
                        expect(await bot.castSpell(ice, 700)).toMatchObject({ success: false, reason: 'must_wait' });
                    });

                    test('nor does its "You cast" land this one', async () => {
                        const { w, bot } = castWith(world => {
                            world.message('You begin casting a Ice Cloud spell!', { type: 'spell' });
                            world.message('You cast a Ice Cloud (Minor) spell!', { type: 'spell' });
                            setTimeout(() => world.message('You cast a Ice Cloud spell!', { type: 'spell' }), 120);
                        }, ice);
                        const t0 = Date.now();
                        expect(await bot.castSpell(ice, 700)).toMatchObject({ success: true });
                        expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
                        expect(w.state.gameMessages.at(-1)!.text).toContain('Ice Cloud spell');
                    });

                    test('a name with a pattern\'s characters in it finds its own lines', async () => {
                        const { bot } = castWith(world => {
                            world.message('You begin casting a Ice Cloud (Minor) spell!', { type: 'spell' });
                            world.message('You cast a Ice Cloud (Minor) spell!', { type: 'spell' });
                        }, minor);
                        expect(await bot.castSpell(minor, 700)).toMatchObject({ success: true });
                    });

                    test('with an "an", as a name may take', async () => {
                        const { bot } = castWith(world => world.message('You cast an Ice Cloud spell!', { type: 'spell' }), ice);
                        expect(await bot.castSpell(ice, 700)).toMatchObject({ success: true });
                    });
                });

                test('an item\'s recast line is no answer to a cast', async () => {
                    // b6s: useItem reason=refused 'You must wait 29 more minutes and 58 seconds to discharge this item!', and castSpell returned at 1045 ms with reason=must_wait and that same line, completed false. Chat went on: 'You cast a Turtle's Shell spell!'.
                    const shell = spellOf("Turtle's Shell", 3570);
                    const { bot } = castWith(world => {
                        world.message("You begin casting a Turtle's Shell spell!", { type: 'spell' });
                        world.message('You must wait 29 more minutes and 58 seconds to discharge this item!', { type: 'system' });
                        setTimeout(() => world.message("You cast a Turtle's Shell spell!", { type: 'spell' }), 60);
                    }, shell);
                    expect(await bot.castSpell(shell)).toMatchObject({ success: true, completed: true });
                });

                test('...and a cast\'s own wait still is', async () => {
                    const { bot } = castWith(world => world.message('You must wait 2 seconds to cast a spell!', { type: 'resisted' }));
                    expect(await bot.castSpell(nuke, 700)).toMatchObject({ reason: 'must_wait', retryAfterMs: 2000 });
                });

                describe('a song with no instrument out', () => {
                    // r1on Rbbar: 'You are not wielding the right type of instrument!' at 04:35:17, :35, :47, 04:36:01, :15, with '00:20 Rbbar: song: no_response (No cast observed for Clear Road)' each time; 20261104-050645: song:no_response (13).
                    const road = spellOf('Clear Road', 5153);
                    const LINE = 'You are not wielding the right type of instrument!';
                    const lute = { slot: 13, name: 'lute of ages', level: 1, count: 1, model: 3, objectType: 45, condition: 100, durability: 100, quality: 85, weight: 30, value1: 0, value2: 0, hand: 0 };

                    test('refused at once, with the song\'s name and what we wear, and a retry that backs off', async () => {
                        const { bot } = castWith(world => world.message(LINE, { type: 'resisted' }), road, { equipment: [lute] });
                        const t0 = Date.now();
                        const r = await bot.castSpell(road);
                        expect(r).toMatchObject({ success: false, reason: 'refused' });
                        expect(r.message).toContain(LINE);
                        expect(r.message).toContain('Clear Road');
                        expect(r.message).toContain('lute of ages');
                        expect(r.retryAfterMs).toBeGreaterThanOrEqual(30_000);
                        expect(Date.now() - t0).toBeLessThan(1000);
                    });

                    test('with none worn it says so', async () => {
                        const { bot } = castWith(world => world.message(LINE, { type: 'resisted' }), road, { equipment: [] });
                        expect((await bot.castSpell(road)).message).toContain('we wear none');
                    });

                    test('castFailureReason reads it so whatever the fallback', () => {
                        expect(castFailureReason(LINE, 'interrupted')).toBe('refused');
                    });
                });

                test('the 20-concentration-effect cap: refused with its words, not no_response (arena round 26: 39 retries a round)', async () => {
                    const LINE = 'You can only cast up to 20 simultaneous concentration spells!';
                    const { bot } = castWith(world => world.message(LINE, { type: 'resisted' }));
                    const t0 = Date.now();
                    const r = await bot.castSpell(nuke, 700);
                    expect(r).toMatchObject({ success: false, reason: 'refused' });
                    expect(r.message).toContain('concentration');
                    expect(Date.now() - t0).toBeLessThan(1000);
                    expect(castFailureReason(LINE, 'interrupted')).toBe('refused');
                });

                describe('a cast that ends with no line of its own', () => {
                    const BLANK = 'Your mind goes blank and you forget what you were doing!';
                    const began = (world: FakeWorld, sp: { name: string }, ms = 3000) => {
                        world.message(`You begin casting a ${sp.name} spell!`, { type: 'spell' });
                        world.combat({ kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: ms });
                    };

                    test('Amnesia clears it with no 0x0B (AmnesiaSpellHandler.cs:50): crowd_controlled, not the end of a long wait', async () => {
                        // r2on: 04:44:59.764 'You begin casting a Summon Aged Ice Spirit spell!', 04:45:00.798 'Your mind goes blank and you forget what you were doing!', then '01:59 Rbthe: nuke: timeout (Cast Summon Aged Ice Spirit, but no pet appeared)'.
                        const { bot } = castWith(world => { began(world, nuke); setTimeout(() => world.message(BLANK, { type: 'spell' }), 40); });
                        const t0 = Date.now();
                        expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'crowd_controlled', message: BLANK, retryAfterMs: 2000 });
                        expect(Date.now() - t0).toBeLessThan(800);
                    });

                    test('a fire-and-forget summon reads it too, with no pet to wait for', async () => {
                        const fnf = spellOf('Call Minor Earth Elemental', 101);
                        const { bot } = castWith(world => { began(world, fnf); setTimeout(() => world.message(BLANK, { type: 'spell' }), 40); }, fnf);
                        const t0 = Date.now();
                        expect(await bot.summonPet(fnf, { target: 700 })).toMatchObject({ success: false, reason: 'crowd_controlled' });
                        expect(Date.now() - t0).toBeLessThan(800);
                    });

                    test('a mezz or a stun sends its 0x0B (CrowdControlECSEffect.cs:26): with its line beside it, crowd_controlled', async () => {
                        for (const line of ['You are entranced!', 'You are mesmerized!', 'You are stunned!']) {
                            const { bot } = castWith(world => {
                                began(world, nuke);
                                setTimeout(() => { world.message(line, { type: 'spell' }); world.combat({ kind: 'interrupt', attackerObjectId: ME, targetObjectId: null }); }, 30);
                            });
                            expect(await bot.castSpell(nuke, 700)).toMatchObject({ success: false, reason: 'crowd_controlled', retryAfterMs: 2000 });
                        }
                    });

                    test('an 0x0B alone stays interrupted', async () => {
                        const { bot } = castWith(world => {
                            began(world, nuke);
                            setTimeout(() => world.combat({ kind: 'interrupt', attackerObjectId: ME, targetObjectId: null }), 30);
                        });
                        expect(await bot.castSpell(nuke, 700)).toMatchObject({ reason: 'interrupted', retryAfterMs: 2200 });
                    });

                    test('that line before our cast has begun, or during a song, ends nothing: Amnesia leaves a song alone (AmnesiaSpellHandler.cs:49)', async () => {
                        const early = castWith(world => {
                            world.message(BLANK, { type: 'spell' });
                            setTimeout(() => { world.message(`You cast a ${nuke.name} spell!`, { type: 'spell' }); }, 30);
                        });
                        expect(await early.bot.castSpell(nuke, 700)).toMatchObject({ success: true });
                        const road = spellOf('Clear Road', 5153);
                        const song = castWith(world => {
                            began(world, road, 100);
                            world.message(BLANK, { type: 'spell' });
                            setTimeout(() => world.message('You cast a Clear Road spell!', { type: 'spell' }), 30);
                        }, road);
                        expect(await song.bot.castSpell(road)).toMatchObject({ success: true });
                    });
                });

                test('a walk\'s message prints a time whole', async () => {
                    // 'walk: timeout (Walk timed out after 3644.32275390625ms)'.
                    const { w, bot } = world();
                    w.stepSize = 1;
                    const r = await bot.walkTo(570000, 511000, { timeout: 44.32275390625, stuckMs: 10_000 });
                    expect(r).toMatchObject({ success: false, reason: 'timeout' });
                    expect(r.message).toMatch(/^Walk timed out after \d+ms$/);
                    const obj = world({ pet: null, nearbyNpcs: [mob({ x: 562000 })], nearbyPlayers: [] });
                    obj.w.stepSize = 1;
                    expect((await obj.bot.walkToObject(700, { timeout: 44.32275390625 })).message).not.toContain('.');
                });
            });

            describe('A11: selection and spots', () => {
                describe('Release Clump with a mob selected', () => {
                    // logs5/z2.log: 'selected 21235', then '5 no target, a mob selected, window turret up 304 ms success', '   selected after null'. Compare logs5/z33.log, releasePet: 'selection before 14486 after 14486'.
                    const clump = spellOf('Release Clump', 11680);
                    const released = (w: FakeWorld) => {
                        w.handlers.castSpell = (_a, world) => {
                            setTimeout(() => {
                                world.message('You cast a Release Clump spell!', { type: 'spell' });
                                world.removeNpc(PET_ID);
                                world.state.pet = null;
                                world.player.targetObjectId = null;
                            }, 5);
                        };
                    };

                    test('the selection comes back', async () => {
                        const { w, bot } = petWorld({ skills: skillsWith(clump), player: makePlayer({ targetObjectId: 700 }) });
                        released(w);
                        expect(await bot.castSpell(clump)).toMatchObject({ success: true });
                        expect(w.sentOf('setTarget').map(a => a.objectId)).toEqual([PET_ID, 700]);
                        expect(w.player.targetObjectId).toBe(700);
                    });

                    test('a mob gone meanwhile: nothing selected, and not the deleted turret', async () => {
                        const { w, bot } = petWorld({ skills: skillsWith(clump), player: makePlayer({ targetObjectId: 700 }) });
                        released(w);
                        const cast = w.handlers.castSpell!;
                        w.handlers.castSpell = (a, world) => { world.removeNpc(700); return cast(a, world); };
                        await bot.castSpell(clump);
                        expect(w.sentOf('setTarget').at(-1)!.objectId).toBeNull();
                    });

                    test('a refused one too', async () => {
                        const { w, bot } = petWorld({ skills: skillsWith(clump), player: makePlayer({ targetObjectId: 700 }) });
                        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You must cast this spell on a creature you are controlling', { type: 'system' }), 5); };
                        expect(await bot.castSpell(clump)).toMatchObject({ success: false, reason: 'invalid_target' });
                        expect(w.player.targetObjectId).toBe(700);
                    });

                    test('one of ours selected stays: no select at all', async () => {
                        const { w, bot } = petWorld({ skills: skillsWith(clump), player: makePlayer({ targetObjectId: PET_ID }) });
                        released(w);
                        await bot.castSpell(clump);
                        expect(w.sentOf('setTarget')).toEqual([]);
                    });
                });

                test('a refused replace with no z and no earlier spot clears the refused one', async () => {
                    // logs5/z6.log: after a drop wiped the spot, 'no previous spot no z d3 1006.5 ... out_of_range ... gt before null at result {"x":336364,...} after 350 {"x":336364,...}'. Then an FnF with no spot: 'You have to select a closer ground target.', where the state before the call would have read no_ground_target.
                    const { w, bot } = petWorld({ skills: skillsWith(turret), player: makePlayer({ mana: 200, maxMana: 200, manaPercent: 100 }), groundTarget: null });
                    // The server's way with a spot in no zone (PlayerGroundTargetHandler.cs:21-33, :72-73): Unset, then the line, and the model goes by the line.
                    w.handlers.setGroundTarget = (a, world) => {
                        if (a.type !== 'setGroundTarget') return;
                        world.state.groundTarget = { x: a.x, y: a.y, z: a.z ?? 3400 };
                        if (getZoneAt(1, a.x, a.y)) return;
                        setTimeout(() => { world.state.groundTarget = null; world.message('Your ground target is not visible!', { type: 'system' }); }, 5);
                    };
                    const r = await bot.summonPet(turret, { replace: true, groundTarget: { x: 560600, y: 511000 } });
                    expect(r).toMatchObject({ success: false, reason: 'out_of_range', pet: { objectId: PET_ID } });
                    expect(w.state.groundTarget).toBeNull();
                    expect(r.message).toContain('beyond');
                });
            });

            describe('A12: reach, small', () => {
                describe('petKill\'s walk for a mob high above us', () => {
                    // out5/cliff.log: 'mob 24355 sveawolf mother d 2080 d2 1288 dz 1633', 'moved 907 me 725021 744231 6687'. z19.out: start d 2099, at '{d:1920,d2:1283,dz:1429}' the order would already reach; the walk went on to '{d:449,d2:383,dz:234}', 1011 units up a slope.
                    const high = (d2: number, dz: number) => {
                        const made = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), mob({ x: 560000 + d2, z: 2500 + dz })] });
                        made.w.stepSize = 10;
                        const at = { d: Infinity, moved: 0 };
                        orders(made.w, (a, world) => {
                            if (a.command !== 'attack') return;
                            at.d = world.npc(700)!.distance;
                            at.moved = world.player.x - 560000;
                            world.message(KILL);
                            setTimeout(() => dies(world, 700), 20);
                        });
                        return { ...made, at };
                    };

                    test('it stops at the order\'s reach, not 300 from under it', async () => {
                        const { bot, at } = high(1288, 1633);
                        expect(await bot.petKill(700)).toMatchObject({ success: true });
                        expect(at.d).toBeLessThanOrEqual(1925);
                        expect(at.d).toBeGreaterThan(1800);
                        expect(at.moved).toBeLessThan(450);
                    });

                    test('on a slope it looks as it goes: as soon as the reading is in reach', async () => {
                        const { w, bot, at } = high(1500, 1480);
                        w.onTick = world => { if (world.state.movement.moving) world.player.z += 8; };
                        expect(await bot.petKill(700)).toMatchObject({ success: true });
                        expect(at.d).toBeLessThanOrEqual(1900);
                        expect(at.moved).toBeLessThan(250);
                    });

                    test('a mob that moves on: the reading ends the walk, not where it stood at the start. "refused@2004 walked 217", grind then avoids it for 60 s', async () => {
                        const { w, bot, at } = high(1700, 1200);
                        w.stepSize = 10;
                        w.onTick = world => { const m = world.npc(700); if (m) m.x += 4; };
                        expect(await bot.petKill(700)).toMatchObject({ success: true });
                        expect(at.d).toBeLessThanOrEqual(1925);
                    });

                    test('a first order refused at a reading under 1900: it walks nearer than that reading, for the one more try. "orders 2, moves 0, moved 0"', async () => {
                        const { w, bot } = high(1100, 1500);
                        const tries: number[] = [];
                        orders(w, (a, world) => {
                            if (a.command !== 'attack') return;
                            tries.push(world.npc(700)!.distance);
                            if (tries.length === 1) return void world.message('Your target is too far away to attack with your pet!');
                            world.message(KILL);
                            setTimeout(() => dies(world, 700), 20);
                        });
                        expect(await bot.petKill(700)).toMatchObject({ success: true });
                        expect(tries.length).toBe(2);
                        expect(tries[1]).toBeLessThanOrEqual(tries[0]! - 100);
                        expect(w.sentOf('moveTo').length).toBeGreaterThan(0);
                    });

                    test('a mob more or less level: 1500 and the walk\'s 100, as ever', async () => {
                        const { bot, at } = high(2300, 300);
                        expect(await bot.petKill(700)).toMatchObject({ success: true });
                        expect(at.d).toBeLessThanOrEqual(1600);
                        expect(at.d).toBeGreaterThan(1500);
                    });

                    test('a true cliff keeps the floor: we can only go so near', async () => {
                        const { bot, w } = high(1000, 2200);
                        const r = await bot.petKill(700, { timeout: 2000 });
                        expect(w.sentOf('moveTo').length).toBeGreaterThan(0);
                        expect(r.reason === 'out_of_range' || r.reason === 'timeout' || r.success).toBeTrue();
                        expect(Math.abs(w.sentOf('moveTo')[0]!.x - (561000 - 300))).toBeLessThan(10);
                    });
                });

                describe('a Necromancer who has lost its servant', () => {
                    // logs5/d3-c.log: tether cut, L14 fellwood at 41 %, d 2137, HP 135: {killNpc} +11808 timeout 3000, again +14811, again +17814 (first swing +17854), '{killNpc} +20659 = died'. Owner moved from (576651,471045) to (577181,471873), 980 units toward the mob.
                    const servant = spellOf('Call Minor Zombie Servant', 9401);
                    const scene = (x: number) => world({ pet: null, skills: skillsWith(servant), player: makePlayer({ className: 'Necromancer', mana: 500, maxMana: 500, manaPercent: 100 }), nearbyNpcs: [mob({ objectId: 701, x, targetObjectId: ME, speed: 190, healthPercent: 41 })], nearbyPlayers: [], nearbyObjects: [] });

                    test('no walk into melee: the summon goes, from inside its room too', async () => {
                        const { w, bot } = scene(562137);
                        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The young wolf attacks you and your spell is interrupted!', { type: 'spell' }), 5); };
                        setTimeout(() => dies(w, 701), 350);
                        const melee = spyOn(bot, 'killNpc');
                        const r = await bot.grind({ pet: true, durationMs: 300, minEngageMs: 0, loot: false });
                        expect(castsOf(w).length).toBeGreaterThan(0);
                        expect(melee).not.toHaveBeenCalled();
                        expect(w.sentOf('moveTo')).toEqual([]);
                        expect(r.failures).toBe(0);
                    });

                    test('and between tries it stands: what it would do with no weapon at all', async () => {
                        const { w, bot } = scene(560100);
                        w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('The young wolf attacks you and your spell is interrupted!', { type: 'spell' }), 5); };
                        setTimeout(() => dies(w, 701), 450);
                        const melee = spyOn(bot, 'killNpc');
                        await bot.grind({ pet: true, durationMs: 400, minEngageMs: 0, loot: false });
                        expect(melee).not.toHaveBeenCalled();
                        expect(w.sentOf('attack')).toEqual([]);
                    });

                    test('another list caster below the room still goes to melee', async () => {
                        const { w, bot } = world({ pet: null, skills: skillsWith(simulacrum), player: makePlayer({ className: 'Cabalist', mana: 500, maxMana: 500, manaPercent: 100 }), nearbyNpcs: [mob({ objectId: 701, x: 560050, targetObjectId: ME })], nearbyPlayers: [], nearbyObjects: [] });
                        setTimeout(() => dies(w, 701), 100);
                        const melee = spyOn(bot, 'killNpc');
                        await bot.grind({ pet: true, maxKills: 1, durationMs: 1000, loot: false });
                        expect(melee).toHaveBeenCalled();
                    });
                });

                describe('grind\'s summon room sees a mob our own nuke pulled', () => {
                    // s2.log: 'pull {msg:Cast Minor Vitality Drain on spirit hound for 13 damage}', 'start {near:true,d:671,sp:131,hp:27,tgt:null,atk:[]}', '4 CALL summonPet {} atk=[]', mob '2002 d440', '3004 d307', '4004 d175'. At 190 from 671 it reaches its 200 reach in about 2.5 s, before the half way at 2.95 s.
                    const pulled = (o: Partial<NearbyNpc>, hit = true) => {
                        const made = world({ pet: null, skills: skillsWith(simulacrum), player: makePlayer({ className: 'Cabalist', mana: 500, maxMana: 500, manaPercent: 100 }), nearbyNpcs: [running({ objectId: 701, x: 560671, inCombat: true, healthPercent: 27, ...o })], nearbyPlayers: [], nearbyObjects: [] });
                        if (hit) made.w.combat({ kind: 'spellEffect', attackerObjectId: ME, targetObjectId: 701, effectId: 1 });
                        made.w.publish();
                        return made;
                    };

                    test('below the room no summon starts into it', async () => {
                        const { w, bot } = pulled({});
                        setTimeout(() => dies(w, 701), 250);
                        await bot.grind({ pet: true, durationMs: 200, minEngageMs: 0, loot: false, killTimeout: 50 });
                        expect(castsOf(w)).toEqual([]);
                        expect(w.sentOf('moveTo')).toEqual([]);
                    });

                    test('with room it goes', async () => {
                        const { w, bot } = pulled({ x: 561500 });
                        summons(w, simulacrum.name, 'amber simulacrum');
                        await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false, killTimeout: 50 });
                        expect(castsOf(w).length).toBeGreaterThan(0);
                    });

                    test('nothing of ours names it: no fight of ours, and the summon goes as ever', async () => {
                        const { w, bot } = pulled({}, false);
                        summons(w, simulacrum.name, 'amber simulacrum');
                        await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false, killTimeout: 50 });
                        expect(castsOf(w).length).toBeGreaterThan(0);
                    });

                    test('one that isn\'t closing: going away, or stood still, is no such mob', async () => {
                        const away = mob({ objectId: 701, x: 560671, speed: 190, inCombat: true });
                        const { w, bot } = pulled({ heading: headingBetween({ x: 560000, y: 511000 }, away) });
                        summons(w, simulacrum.name, 'amber simulacrum');
                        setTimeout(() => dies(w, 701), 200);
                        await bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false, killTimeout: 50 });
                        expect(castsOf(w).length).toBeGreaterThan(0);
                        const still = pulled({ speed: 0 });
                        summons(still.w, simulacrum.name, 'amber simulacrum');
                        setTimeout(() => dies(still.w, 701), 200);
                        await still.bot.grind({ pet: true, durationMs: 100, minEngageMs: 0, loot: false, killTimeout: 50 });
                        expect(castsOf(still.w).length).toBeGreaterThan(0);
                    });

                    test('with a pet up it isn\'t looked for: nothing changes for the pet\'s fight', async () => {
                        const { w, bot } = petWorld({ skills: skillsWith(simulacrum), nearbyNpcs: [petNpc(), running({ objectId: 701, x: 560671, inCombat: true })] });
                        w.combat({ kind: 'spellEffect', attackerObjectId: ME, targetObjectId: 701, effectId: 1 });
                        kills(w);
                        const melee = spyOn(bot, 'killNpc');
                        expect(await bot.grind({ pet: true, maxKills: 1, durationMs: 2000, loot: false })).toMatchObject({ kills: 1 });
                        expect(melee).not.toHaveBeenCalled();
                    });
                });

                describe('below the room with a mob running at us: let it come', () => {
                    // s2h: 'CALL killNpc bandit L6 #1703 hp17 d681 sp0 onMe=true', '1001 mob d463 sp115', '2001 mob d176 sp116': closing 218 and 287 units/s with the mob at 115, so we walk at it. That took a L10 caster into the bandit camp.
                    const coming = (o: Partial<NearbyNpc>) => world({ pet: null, skills: skillsWith(simulacrum), player: makePlayer({ className: 'Cabalist', mana: 500, maxMana: 500, manaPercent: 100 }), nearbyNpcs: [running({ objectId: 701, x: 560681, targetObjectId: ME, healthPercent: 17, ...o })], nearbyPlayers: [], nearbyObjects: [] });

                    test('no walk out to it; melee once it has arrived', async () => {
                        const { w, bot } = coming({});
                        w.onTick = world => { const m = world.npc(701); if (m && m.x > 560100) m.x -= 10; };
                        setTimeout(() => dies(w, 701), 900);
                        const melee = spyOn(bot, 'killNpc');
                        await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false, killTimeout: 2000 });
                        expect(melee).toHaveBeenCalled();
                        const first = melee.mock.calls[0]![0] as NearbyNpc;
                        expect(first.distance).toBeLessThanOrEqual(170);
                        expect(w.player.x).toBeLessThan(560100);
                    });

                    test('one reading no speed yet gets a moment to turn, as a mob just hit does', async () => {
                        const { w, bot } = coming({ speed: 0 });
                        setTimeout(() => { const m = w.npc(701); if (m) m.speed = 190; }, 200);
                        w.onTick = world => { const m = world.npc(701); if (m && m.speed > 0 && m.x > 560100) m.x -= 10; };
                        setTimeout(() => dies(w, 701), 1200);
                        const melee = spyOn(bot, 'killNpc');
                        await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false, killTimeout: 2000 });
                        const first = melee.mock.calls[0]![0] as NearbyNpc;
                        expect(first.distance).toBeLessThanOrEqual(170);
                    });

                    test('one that stands, a caster mob: we go after that moment, as ever', async () => {
                        const { w, bot } = coming({ speed: 0 });
                        setTimeout(() => dies(w, 701), 1800);
                        const melee = spyOn(bot, 'killNpc');
                        const t0 = Date.now();
                        await bot.grind({ pet: true, maxKills: 1, durationMs: 3000, loot: false, killTimeout: 2000 });
                        expect(melee).toHaveBeenCalled();
                        expect(Date.now() - t0).toBeLessThan(2600);
                        expect(w.sentOf('moveTo').length).toBeGreaterThan(0);
                    });

                    test('with no pet plan nothing changes: a plain run walks out as it always has', async () => {
                        const { bot } = coming({});
                        const melee = spyOn(bot, 'killNpc').mockImplementation((async () => ({ success: true, killed: true, npc: null, xpGained: 0, durationMs: 1, message: 'ok', rpGained: 0, moneyGained: 0, itemsGained: [], levelsGained: 0, stylesUsed: 0 })) as unknown as typeof bot.killNpc);
                        const t0 = Date.now();
                        await bot.grind({ maxKills: 1, durationMs: 1000, loot: false });
                        expect(melee).toHaveBeenCalled();
                        expect(Date.now() - t0).toBeLessThan(150);
                    });
                });
            });
        });
    });
});
