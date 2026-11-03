import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions, castFailureReason, tradeSlotWait } from '../actions';
import { ChatHistory } from '../chat-history';
import { setDefaultPathProvider, StraightLinePathProvider, type PathProvider } from '../pathfinding';
import { executionContext, throwIfExecutionAborted } from '../execution-context';
import type { ActionResult, BotAction, BotWorldState, GameMessage, InventoryItem, NearbyNpc, NearbyPlayer } from '../types';
import { makeMessage, makeNpc, makeObject, makePlayer, makePlayerObj, makeState } from './fixtures';

// Fixed straight-line paths: a locally built server/navmesh/zone000.nav would otherwise route every walk here.
beforeAll(() => setDefaultPathProvider(new StraightLinePathProvider()));
afterAll(() => setDefaultPathProvider(null));

// ── A tiny simulated world behind a stubbed BotSDK ─────────────────────────

type Handler = (action: BotAction, world: FakeWorld) => ActionResult | void;

class FakeWorld {
    state: BotWorldState;
    sent: BotAction[] = [];
    handlers: Partial<Record<BotAction['type'], Handler>> = {};
    /** Units per tick the mover advances. */
    stepSize = 200;
    /** Called every tick before publishing. */
    onTick: ((world: FakeWorld) => void) | null = null;
    private nextMsgId = 100;
    private nextCombatId = 1;
    private timer: ReturnType<typeof setInterval>;
    readonly sdk: BotSDK;

    constructor(overrides: Partial<BotWorldState> = {}) {
        this.state = makeState({ gameMessages: [], ...overrides });
        const sdk = Object.create(BotSDK.prototype) as BotSDK;
        (sdk as any).config = { actionTimeout: 5000, botUsername: 'tester', connectionMode: 'control', showChat: true };
        (sdk as any).connectionState = 'connected';
        (sdk as any).pendingActions = new Map();
        (sdk as any).stateListeners = new Set();
        (sdk as any).chatHistory = new ChatHistory();
        (sdk as any).chatReadCursor = 0;
        (sdk as any).serverMaxMessageLength = 200;
        (sdk as any).ws = { readyState: WebSocket.OPEN };
        sdk.sendAction = async (action: BotAction) => {
            throwIfExecutionAborted(); // like BotSDK.sendAction: an aborted execution cannot dispatch
            this.sent.push(action);
            const handler = this.handlers[action.type] ?? defaultHandlers[action.type];
            const r = handler?.(action, this);
            return r ?? { success: true, message: 'ok', phase: 'dispatch' };
        };
        this.sdk = sdk;
        this.publish();
        this.timer = setInterval(() => this.tick(), 10);
    }

    get player() { return this.state.player!; }

    sentOf<T extends BotAction['type']>(type: T): Extract<BotAction, { type: T }>[] {
        return this.sent.filter(a => a.type === type) as Extract<BotAction, { type: T }>[];
    }

    message(text: string, overrides: Partial<GameMessage> = {}): void {
        this.state.gameMessages = [...this.state.gameMessages, makeMessage(this.nextMsgId++, text, { receivedAt: Date.now(), ...overrides })].slice(-100);
    }

    combat(e: Omit<BotWorldState['combatEvents'][number], 'id' | 'receivedAt'>): void {
        this.state.combatEvents = [...this.state.combatEvents, { ...e, id: this.nextCombatId++, receivedAt: Date.now() }];
    }

    npc(id: number): NearbyNpc | undefined {
        return this.state.nearbyNpcs.find(n => n.objectId === id);
    }

    removeNpc(id: number): void {
        this.state.nearbyNpcs = this.state.nearbyNpcs.filter(n => n.objectId !== id);
    }

    tick(): void {
        const mv = this.state.movement;
        if (mv.moving && mv.destination) {
            const wp = mv.waypoints[0] ?? mv.destination;
            const p = this.player;
            const d = Math.hypot(wp.x - p.x, wp.y - p.y);
            const tol = mv.waypoints.length <= 1 ? (this.tolerance ?? 16) : 1;
            if (d <= Math.max(tol, this.stepSize)) {
                p.x = Math.round(wp.x); p.y = Math.round(wp.y); p.z = wp.z;
                mv.waypoints = mv.waypoints.slice(1);
                if (mv.waypoints.length === 0) this.state.movement = { ...mv, moving: false, destination: null, waypoints: [], lastStopReason: 'arrived' };
            } else {
                p.x = Math.round(p.x + (wp.x - p.x) * this.stepSize / d);
                p.y = Math.round(p.y + (wp.y - p.y) * this.stepSize / d);
            }
        }
        this.onTick?.(this);
        this.publish();
    }

    tolerance: number | null = null;

    publish(): void {
        const p = this.state.player;
        const fix = <T extends { x: number; y: number; z: number; distance: number; distance2d: number }>(o: T): T => {
            if (!p) return o;
            return { ...o, distance: Math.round(Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z)), distance2d: Math.round(Math.hypot(o.x - p.x, o.y - p.y)) };
        };
        this.state = {
            ...this.state,
            tick: this.state.tick + 1,
            nearbyNpcs: this.state.nearbyNpcs.map(fix),
            nearbyPlayers: this.state.nearbyPlayers.map(fix),
            nearbyObjects: this.state.nearbyObjects.map(fix),
            player: p ? { ...p, money: { ...p.money } } : null,
        };
        (this.sdk as any).handleMessage(JSON.stringify({ type: 'sdk_state', state: this.state, stateReceivedAt: Date.now() }));
    }

    dispose(): void {
        clearInterval(this.timer);
    }
}

const defaultHandlers: Partial<Record<BotAction['type'], Handler>> = {
    moveTo: (a, w) => {
        if (a.type !== 'moveTo') return;
        const dest = { x: a.x, y: a.y, z: a.z ?? w.player.z };
        w.tolerance = a.tolerance ?? 16;
        w.state.movement = { ...w.state.movement, moving: true, destination: dest, waypoints: [...(a.waypoints ?? []), dest], lastStopReason: null };
    },
    stop: (_a, w) => {
        if (w.state.movement.moving) w.state.movement = { ...w.state.movement, moving: false, destination: null, waypoints: [], lastStopReason: 'stopped' };
    },
    setTarget: (a, w) => { if (a.type === 'setTarget') w.player.targetObjectId = a.objectId; },
    face: (a, w) => { if (a.type === 'face') w.player.heading = a.heading; },
    faceObject: (a, w) => {
        if (a.type !== 'faceObject') return;
        const o = w.sdk.getObject(a.objectId);
        if (o) w.player.heading = headingTo(w.player, o);
    },
    sit: (a, w) => {
        if (a.type !== 'sit') return;
        w.player.isSitting = a.sit;
        w.message(a.sit ? "You sit down.  Type '/stand' or move to stand up." : 'You stand up.');
    },
    attack: (a, w) => { if (a.type === 'attack') w.player.attacking = a.on; },
};

function headingTo(from: { x: number; y: number }, to: { x: number; y: number }): number {
    let h = Math.atan2(-(to.x - from.x), to.y - from.y) * (2048 / Math.PI);
    if (h < 0) h += 4096;
    return Math.floor(h) % 4096;
}

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
        // 9000 units at 0.9 × 191: 1.5 × 52 s + 15 s ≈ 93 s (the straight 1000 units would give ≈ 24 s).
        expect(Math.max(...delays)).toBeGreaterThan(90_000);
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
        const r = await bot.castSpell(spell, 'rat');
        expect(r).toMatchObject({ success: false, reason: 'no_target', castTimeMs: 1000 });
        expect(r.message).toEndWith(' (target gone, not retried)');
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
        expect(await bot.castSpell(spell, 'rat')).toMatchObject({ reason: 'no_target', castTimeMs: null, message: 'You must select a target for this spell! (target gone, not retried)' });
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
});

// ── Items / merchants / trainers ────────────────────────────────────────────

describe('items', () => {
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
    const worn: InventoryItem = { slot: 10, name: 'long sword', level: 5, count: 1, model: 3, objectType: 3, condition: 88, durability: 100, quality: 90, weight: 30, value1: 27, value2: 30 };
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
    const axe: InventoryItem = { slot: 40, name: 'Dragonmight', level: 51, count: 1, model: 3, objectType: 17, condition: 100, durability: 100, quality: 100, weight: 30, value1: 165, value2: 37 };

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
            world.state.trainer = { isOpen: true, specPoints: 3, specs: [{ index: 0, name: 'Slash', level: 2, nextLevelCost: 3 }] };
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
