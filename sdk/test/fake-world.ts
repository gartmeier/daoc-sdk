// A tiny simulated world behind a real BotSDK: its snapshots go in through handleMessage and its actions end in `handlers`, so BotActions and all
// that reads the state run as they do live. For sdk/test/actions.test.ts and for what runs a whole member on it (sdk/group/member-turns.test.ts).
import { BotSDK } from '../index';
import { ChatHistory } from '../chat-history';
import { throwIfExecutionAborted } from '../execution-context';
import type { ActionResult, BotAction, BotWorldState, GameMessage, NearbyNpc } from '../types';
import { makeMessage, makeState } from './fixtures';

export type Handler = (action: BotAction, world: FakeWorld) => ActionResult | void;

export class FakeWorld {
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

export const defaultHandlers: Partial<Record<BotAction['type'], Handler>> = {
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
