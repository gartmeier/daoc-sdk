import { afterEach, describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions, castFailureReason } from '../actions';
import { ChatHistory } from '../chat-history';
import { executionContext, throwIfExecutionAborted } from '../execution-context';
import type { ActionResult, BotAction, BotWorldState, GameMessage, NearbyNpc } from '../types';
import { makeMessage, makeNpc, makeObject, makePlayer, makeState } from './fixtures';

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

describe('merchants', () => {
    const merchant = makeNpc({ objectId: 203, name: 'Lady Grynoch', role: 'merchant', realm: 'albion', isPeaceful: true, x: 560100, y: 511000 });
    const items = [
        { page: 0, slot: 0, name: 'arrows', level: 1, price: 50, model: 1, usable: true },
        { page: 0, slot: 1, name: 'heavy sword', level: 5, price: 999_999, model: 2, usable: true },
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
                world.state.skills = { ...world.state.skills, specializations: [{ name: 'Slash', level: 2 + (a.levels ?? 1), internalId: 1 }] };
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
