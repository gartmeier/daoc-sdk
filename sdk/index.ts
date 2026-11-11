// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// BotSDK: low-level client for a DAoC bot behind the gateway.
//
// Port of rs-sdk sdk/index.ts plumbing (connection, reconnect, handshake
// deadline, action dispatch, state cache, waits, chat history) on the DAoC
// contract in ./types. The SDK never speaks the DAoC protocol: it sends
// BotAction JSON and receives BotWorldState snapshots.
//
// A successful send* result means the client DISPATCHED the action; it does
// not prove the server applied it. Use BotActions (bot.*) for observed effects.

import type {
    Ability,
    ActionResult,
    BotAction,
    BotStatus,
    BotWorldState,
    ChatType,
    ConnectionMode,
    ConnectionState,
    DialogBox,
    ResurrectionOffer,
    Effect,
    GameMessage,
    GroupMember,
    InventoryItem,
    MerchantState,
    MovementState,
    NearbyNpc,
    NearbyObject,
    NearbyPlayer,
    NpcDialog,
    PetCommand,
    PetState,
    PlayerState,
    Position,
    SDKConfig,
    SkillsState,
    Specialization,
    Spell,
    Style,
    TextWindow,
    TradeWindow,
    TrainerState,
    Vec3,
} from './types';
import { ChatHistory, PLAYER_CHAT_TYPES, isOtherPlayersChat, isOwnMessage, isPlayerChat } from './chat-history';
import { chunkMessage, DEFAULT_MAX_MESSAGE_LENGTH } from './chunking';
import { executionContext, executionWait, throwIfExecutionAborted } from './execution-context';
import { specDisplayName, specKey } from '../data/spec-names';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export { chunkMessage } from './chunking';
export { ChatHistory, PLAYER_CHAT_TYPES, isPlayerChat, isOwnMessage, isOtherPlayersChat } from './chat-history';

/** Repository root (sdk/..). */
export const REPO_ROOT = resolve(import.meta.dir, '..');

export const DEFAULT_GATEWAY_URL = 'ws://localhost:7780';

/**
 * Resolve the gateway WebSocket URL.
 * - process.env.GATEWAY_URL always wins
 * - ws:// or wss:// → as-is
 * - "host" / "host:port" → ws://host:port (port 7780 by default)
 * - empty → ws://localhost:7780
 *
 * Unlike rs-sdk, bot.env SERVER is the DAoC game server (host:10300), not the
 * gateway, so pass GATEWAY_URL here, never SERVER.
 */
export function deriveGatewayUrl(gatewayUrl?: string): string {
    if (typeof process !== 'undefined' && process.env?.GATEWAY_URL) return process.env.GATEWAY_URL;
    if (!gatewayUrl) return DEFAULT_GATEWAY_URL;
    if (/^wss?:\/\//.test(gatewayUrl)) return gatewayUrl;
    return `ws://${gatewayUrl.includes(':') ? gatewayUrl : `${gatewayUrl}:7780`}`;
}

/** ws://host → http://host, wss://host/path → https://host/path. */
export function gatewayHttpBase(gatewayUrl: string): string {
    return gatewayUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
}

/** True when the gateway answers its JSON /status endpoint. */
export async function isGatewayReachable(gatewayUrl: string, timeoutMs = 1500): Promise<boolean> {
    try {
        const res = await fetch(`${gatewayHttpBase(gatewayUrl)}/status`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok && (res.headers.get('content-type') ?? '').includes('json');
    } catch {
        return false;
    }
}

function isLocalUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch {
        return false;
    }
}

function spawnDetached(args: string[], logPath: string, env: Record<string, string | undefined>, cwd: string): ChildProcess {
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a');
    try {
        const child = spawn(process.execPath, args, {
            cwd,
            detached: true,
            stdio: ['ignore', fd, fd],
            windowsHide: true,
            env: { ...process.env, ...env },
        });
        child.unref();
        return child;
    } finally {
        closeSync(fd);
    }
}

/**
 * Start a local gateway (`bun gateway/gateway.ts`, detached, log gateway.log)
 * when none answers at `gatewayUrl`. Returns the spawned process, or null when
 * one was already running. Throws for remote URLs or when it doesn't come up.
 */
export async function ensureGateway(gatewayUrl: string, opts: { repoRoot?: string; timeoutMs?: number; logPath?: string } = {}): Promise<ChildProcess | null> {
    if (await isGatewayReachable(gatewayUrl)) return null;
    if (!isLocalUrl(gatewayUrl)) throw new Error(`Gateway ${gatewayUrl} is not reachable (and is not local, so it can't be started here)`);
    const root = opts.repoRoot ?? REPO_ROOT;
    const port = new URL(gatewayUrl).port || '7780';
    const logPath = opts.logPath ?? join(root, 'gateway.log');
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const child = spawnDetached([join(root, 'gateway', 'gateway.ts')], logPath, { AGENT_PORT: port }, root);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isGatewayReachable(gatewayUrl, 500)) return child;
        if (child.exitCode !== null) break;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Started a gateway for ${gatewayUrl} but it did not answer within ${timeoutMs}ms (log: ${logPath})`);
}

/**
 * Spawn the headless client for a bot: `bun client/runner.ts <botName>`,
 * detached, stdout/stderr appended to bots/<botName>/client.log. The runner
 * reads bots/<botName>/bot.env, logs into the DAoC server and registers with
 * the gateway (GATEWAY_URL).
 */
export function launchClientProcess(botName: string, opts: { repoRoot?: string; logPath?: string; env?: Record<string, string> } = {}): ChildProcess {
    const root = opts.repoRoot ?? REPO_ROOT;
    const runner = join(root, 'client', 'runner.ts');
    if (!existsSync(runner)) {
        throw new Error(`Headless client not found at ${runner}; it is needed to log "${botName}" into the game.`);
    }
    const logPath = opts.logPath ?? join(root, 'bots', botName, 'client.log');
    return spawnDetached([runner, botName], logPath, opts.env ?? {}, root);
}

/** Parse bot.env KEY=VALUE lines ('#' comments, also inline after whitespace). */
export function parseEnvFile(content: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        let value = trimmed.slice(eq + 1).trim();
        const hash = value.search(/\s#/);
        if (hash >= 0) value = value.slice(0, hash).trim();
        env[trimmed.slice(0, eq).trim()] = value;
    }
    return env;
}

/** Path of bots/<botName>/bot.env (cwd first, then the repo root), or null. */
export function findBotEnv(botName: string, repoRoot: string = REPO_ROOT): string | null {
    for (const base of [process.cwd(), repoRoot]) {
        const path = join(base, 'bots', botName, 'bot.env');
        if (existsSync(path)) return path;
    }
    return null;
}

// ── Matching / geometry helpers ─────────────────────────────────────────────

export type NamePattern = string | RegExp;

/**
 * Cuts a move short before it is sent (BotSDK.setMoveGuard): the destination and waypoints to send instead, or null to send
 * it as asked. `from` is where we stand. A group with stayDry keeps its members out of the river this way (sdk/group/water.ts
 * dryMoveGuard), for every walk, cast approach and chase alike.
 */
export type MoveGuard = (
    from: { regionId: number; x: number; y: number; z: number },
    to: { x: number; y: number; z?: number },
    waypoints: readonly Vec3[],
) => { to: { x: number; y: number; z?: number }; waypoints: Vec3[] } | null;

/** A guarded move whose cut ends this close to us, or within the move's tolerance, is refused (reason 'water'): there is nothing left of it to walk. */
export const MOVE_GUARD_HERE = 48;

/** Case-insensitive substring for strings; RegExp as given (g/y flags ignored). */
export function nameMatcher(pattern: NamePattern): (name: string) => boolean {
    if (typeof pattern === 'string') {
        const needle = pattern.toLowerCase();
        return name => name.toLowerCase().includes(needle);
    }
    const regex = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    return name => regex.test(name);
}

/** Shortest matching name wins (so 'rat' prefers "rat" over "sewer rat"), then nearest. */
export function bestNameMatch<T extends { name: string; distance?: number }>(items: readonly T[], pattern: NamePattern): T | null {
    const matches = nameMatcher(pattern);
    let best: T | null = null;
    for (const item of items) {
        if (!matches(item.name)) continue;
        if (!best || item.name.length < best.name.length ||
            (item.name.length === best.name.length && (item.distance ?? 0) < (best.distance ?? 0))) {
            best = item;
        }
    }
    return best;
}

/**
 * Whether we can plausibly attack this NPC: targetable, not flagged peaceful and not
 * of our own realm (realm 'none' = monster). Its health says nothing: a dead one leaves
 * the list, and one under 1 % reads 0 and fights on (GameLiving.cs:2621). A pet has its owner's
 * realm (GameNPC.cs:303-305): an enemy realm's can be attacked, as its owner can
 * (AbstractServerRules.cs:344-348). Ours, and one with no realm to judge by, can't.
 */
export function isAttackable(npc: NearbyNpc, player: PlayerState | null): boolean {
    if (!npc.isTargetable || npc.isPeaceful) return false;
    if (npc.isPet && (npc.realm === 'none' || !player)) return false;
    if (npc.realm === 'none') return true;
    return !player || npc.realm !== player.realm;
}

/** 3D distance when both sides have z, else ground-plane distance. */
export function distanceBetween(a: { x: number; y: number; z?: number }, b: { x: number; y: number; z?: number }): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = a.z !== undefined && b.z !== undefined ? b.z - a.z : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** DAoC heading (0..4095, 0 = +Y, clockwise) from `from` to `to` (world/Point2D.cs:102-113). */
export function headingBetween(from: { x: number; y: number }, to: { x: number; y: number }): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let heading = Math.atan2(-dx, dy) * (2048 / Math.PI);
    if (heading < 0) heading += 4096;
    return (Math.floor(heading) % 4096) | 0;
}

export interface FindNpcOptions {
    /** Max 3D distance from the player. */
    maxDistance?: number;
    minLevel?: number;
    maxLevel?: number;
    /** Only NPCs {@link isAttackable} says we can fight. */
    attackable?: boolean;
}

export interface FindOptions {
    maxDistance?: number;
}

export interface ChatQuery {
    /** Max messages (default 20; 0 = all retained). */
    limit?: number;
    /** Chat types to include (default player chat), or 'all'. */
    types?: readonly ChatType[] | 'all';
    /** Include our own echoed speech (default false). */
    includeSelf?: boolean;
}

export interface ChatSendOptions {
    /** Max chars per chunk (capped at {@link BotSDK.maxMessageLength}). */
    maxLen?: number;
    /** Pause between chunks (default 700 ms: '&say' rejects faster than 500 ms, commands/playercommands/say.cs:47). */
    delayMs?: number;
}

interface SyncToSDKMessage {
    type: 'sdk_connected' | 'sdk_state' | 'sdk_action_result' | 'sdk_error' | 'sdk_info';
    success?: boolean;
    state?: BotWorldState;
    stateReceivedAt?: number;
    actionId?: string;
    result?: ActionResult;
    error?: string;
    maxMessageLength?: number;
}

interface PendingAction {
    resolve: (result: ActionResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

/** A dispatch that produced no result; sendAction converts it to a failed ActionResult. */
class ActionDispatchError extends Error {
    constructor(message: string, readonly reason: 'timeout' | 'disconnected' | 'error') {
        super(message);
        Object.defineProperty(this, 'name', { value: 'ActionDispatchError', writable: true, configurable: true });
    }
}

type ResolvedConfig = Required<Omit<SDKConfig, 'password' | 'gatewayUrl'>> & { password: string; gatewayUrl: string };

export class BotSDK {
    readonly config: ResolvedConfig;
    private ws: WebSocket | null = null;
    private state: BotWorldState | null = null;
    private stateReceivedAt = 0;
    private serverMaxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH;
    private chatHistory = new ChatHistory();
    private chatReadCursor = 0;
    private pendingActions = new Map<string, PendingAction>();
    private stateListeners = new Set<(state: BotWorldState) => void>();
    private connectionListeners = new Set<(state: ConnectionState, attempt?: number) => void>();
    private connectPromise: Promise<void> | null = null;
    private sdkClientId: string;
    private authenticated = false;
    private connectionState: ConnectionState = 'disconnected';
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalDisconnect = false;
    /** Gateway's error text when another control connection took this bot over, else null. */
    private preemptedReason: string | null = null;
    private petAttackSentAt: number | null = null;
    private moveGuard: MoveGuard | null = null;

    constructor(config: SDKConfig) {
        this.config = {
            botUsername: config.botUsername,
            password: config.password || '',
            gatewayUrl: config.gatewayUrl || deriveGatewayUrl(),
            connectionMode: config.connectionMode || 'control',
            autoLaunchClient: config.autoLaunchClient ?? false,
            readyTimeout: config.readyTimeout ?? 15000,
            connectTimeout: config.connectTimeout ?? 30000,
            actionTimeout: config.actionTimeout || 60000,
            autoReconnect: config.autoReconnect ?? true,
            reconnectMaxRetries: config.reconnectMaxRetries ?? Infinity,
            reconnectBaseDelay: config.reconnectBaseDelay ?? 1000,
            reconnectMaxDelay: config.reconnectMaxDelay ?? 30000,
            showChat: config.showChat ?? true,
        };
        this.sdkClientId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    // ============ Connection ============

    /** Connect to the gateway (and wait up to readyTimeout for in-game state). Idempotent. */
    async connect(): Promise<void> {
        throwIfExecutionAborted();
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) return;
        if (this.connectPromise) return this.connectPromise;

        this.intentionalDisconnect = false;
        this.preemptedReason = null;
        const isReconnect = this.connectionState === 'reconnecting';
        if (!isReconnect) this.setConnectionState('connecting');

        if (this.config.autoLaunchClient && !isReconnect) {
            try {
                const status = await this.checkBotStatus();
                if (this.shouldLaunchClient(status)) {
                    this.launchClient();
                    await this.waitForBotConnection();
                }
            } catch (error) {
                console.error('[BotSDK] Auto-launch failed:', error instanceof Error ? error.message : error);
            }
        }

        const url = this.config.gatewayUrl;
        throwIfExecutionAborted();
        this.connectPromise = new Promise<void>((resolve, reject) => {
            if (this.intentionalDisconnect) {
                reject(new Error('Disconnected while connecting'));
                return;
            }
            const ws = new WebSocket(url);
            this.ws = ws;

            // One deadline for the whole handshake: socket open AND the
            // gateway's sdk_connected/sdk_error answer.
            let handshakeDone = false;
            const deadline = setTimeout(() => {
                reject(new Error(`Gateway handshake timed out after ${this.config.connectTimeout}ms`));
                ws.close();
            }, this.config.connectTimeout);

            ws.onopen = () => {
                this.transmit({
                    type: 'sdk_connect',
                    username: this.config.botUsername,
                    password: this.config.password,
                    clientId: this.sdkClientId,
                    mode: this.config.connectionMode,
                });
            };
            ws.onmessage = event => this.handleMessage(String(event.data));
            ws.onclose = () => {
                if (!handshakeDone) {
                    clearTimeout(deadline);
                    reject(new Error('Connection closed before the gateway handshake completed'));
                }
                if (this.ws !== ws) return;
                this.connectPromise = null;
                this.ws = null;
                this.authenticated = false;
                for (const pending of this.pendingActions.values()) {
                    clearTimeout(pending.timeout);
                    pending.reject(new ActionDispatchError('Connection closed', 'disconnected'));
                }
                this.pendingActions.clear();
                if (this.config.autoReconnect && !this.intentionalDisconnect) this.scheduleReconnect();
                else this.setConnectionState('disconnected');
            };
            ws.onerror = () => {
                clearTimeout(deadline);
                reject(new Error(`WebSocket error connecting to ${url}`));
            };

            const checkConnected = (event: MessageEvent) => {
                let msg: SyncToSDKMessage;
                try { msg = JSON.parse(String(event.data)); } catch { return; }
                if (msg.type === 'sdk_connected') {
                    handshakeDone = true;
                    clearTimeout(deadline);
                    ws.removeEventListener('message', checkConnected);
                    this.reconnectAttempt = 0;
                    this.authenticated = true;
                    this.setConnectionState('connected');
                    const readyTimeout = this.config.readyTimeout;
                    if (readyTimeout <= 0) {
                        resolve();
                        return;
                    }
                    this.waitForReady(readyTimeout).then(() => resolve(), error => {
                        console.warn(`[BotSDK] Connected but game state not ready: ${error.message}`);
                        resolve();
                    });
                } else if (msg.type === 'sdk_error') {
                    handshakeDone = true;
                    clearTimeout(deadline);
                    ws.removeEventListener('message', checkConnected);
                    // Auth failures won't succeed on retry.
                    this.intentionalDisconnect = true;
                    reject(new Error(msg.error || 'Authentication failed'));
                    ws.close();
                }
            };
            ws.addEventListener('message', checkConnected);
        });
        const promise = this.connectPromise;
        promise.catch(() => { if (this.connectPromise === promise) this.connectPromise = null; });
        return promise;
    }

    private setConnectionState(state: ConnectionState, attempt?: number) {
        this.connectionState = state;
        for (const listener of this.connectionListeners) {
            try { listener(state, attempt); } catch (e) { console.error('Connection listener error:', e); }
        }
    }

    private scheduleReconnect() {
        if (this.reconnectAttempt >= this.config.reconnectMaxRetries) {
            this.setConnectionState('disconnected');
            return;
        }
        this.reconnectAttempt++;
        this.setConnectionState('reconnecting', this.reconnectAttempt);
        const delay = Math.min(this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempt - 1), this.config.reconnectMaxDelay);
        // Reconnect belongs to the connection, not to the execution that opened it.
        this.reconnectTimer = executionContext.exit(() => setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
            } catch {
                // onclose schedules the next attempt.
            }
        }, delay));
    }

    /** Disconnect from the gateway; no auto-reconnect. Does not stop the game client. */
    async disconnect(): Promise<void> {
        this.intentionalDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const ws = this.ws;
        if (ws) {
            await new Promise<void>(resolve => {
                if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
                ws.addEventListener('close', () => resolve(), { once: true });
                ws.close();
                setTimeout(resolve, 2000);
            });
        }
        this.ws = null;
        this.authenticated = false;
        this.connectPromise = null;
        this.reconnectAttempt = 0;
        for (const pending of this.pendingActions.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new ActionDispatchError('Disconnected', 'disconnected'));
        }
        this.pendingActions.clear();
        this.setConnectionState('disconnected');
    }

    /** WebSocket to the gateway is open. */
    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /** The gateway accepted us (sdk_connected). If state is still missing, no client is attached. */
    isAuthenticated(): boolean {
        return this.authenticated && this.isConnected();
    }

    /** Connection state machine: disconnected, connecting, connected, reconnecting. */
    getConnectionState(): ConnectionState {
        return this.connectionState;
    }

    /**
     * True when the gateway dropped this connection because another control connection for
     * the same bot took over (newest control connection wins). The game client is still
     * running; only this SDK lost control. Cleared by the next connect().
     */
    wasPreempted(): boolean {
        return !!this.preemptedReason;
    }

    /** The gateway's message for the takeover ("Disconnected: another controller connected"), or null. */
    getPreemptedReason(): string | null {
        return this.preemptedReason ?? null;
    }

    /** Current reconnect attempt (0 when connected). */
    getReconnectAttempt(): number {
        return this.reconnectAttempt;
    }

    /** Subscribe to connection state changes; returns an unsubscribe function. */
    onConnectionStateChange(listener: (state: ConnectionState, attempt?: number) => void): () => void {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
    }

    /** 'control' or 'observe'. */
    getConnectionMode(): ConnectionMode {
        return this.config.connectionMode;
    }

    /** Wait for the WebSocket to (re)connect. */
    async waitForConnection(timeout: number = 60000): Promise<void> {
        if (this.isConnected() && this.authenticated) return;
        return executionWait<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => reject(new Error('waitForConnection timed out')), timeout);
            const unsubscribe = this.onConnectionStateChange(state => {
                if (state === 'connected') resolve();
                else if (state === 'disconnected') reject(new Error('Connection failed'));
            });
            return () => { clearTimeout(timeoutId); unsubscribe(); };
        });
    }

    // ============ Bot status & client launch ============

    /** Bot status from the gateway's HTTP /status/:username. 'unknown' when the gateway can't be reached. */
    async checkBotStatus(): Promise<BotStatus> {
        const url = `${gatewayHttpBase(this.config.gatewayUrl)}/status/${encodeURIComponent(this.config.botUsername)}`;
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json() as BotStatus;
        } catch {
            return { status: 'unknown', inGame: false, stateAge: null, controllers: [], observers: [], player: null };
        }
    }

    /** A client is registered with the gateway for this bot (status not dead/unknown). */
    async isBotConnected(): Promise<boolean> {
        const status = await this.checkBotStatus();
        return status.status === 'active' || status.status === 'stale';
    }

    private shouldLaunchClient(status: BotStatus): boolean {
        const mode = this.config.autoLaunchClient;
        if (!mode) return false;
        if (status.status === 'dead') return true;
        // 'auto' also replaces a stale client (the gateway sends it save_and_disconnect).
        return mode === 'auto' && status.status === 'stale';
    }

    /** Spawn `bun client/runner.ts <botUsername>` detached (log: bots/<botUsername>/client.log). */
    launchClient(): ChildProcess {
        throwIfExecutionAborted();
        console.error(`[BotSDK] Launching headless client for ${this.config.botUsername}...`);
        return launchClientProcess(this.config.botUsername);
    }

    /** Poll /status until a client publishes fresh state for this bot. */
    async waitForBotConnection(timeout: number = 90_000): Promise<void> {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            throwIfExecutionAborted();
            const status = await this.checkBotStatus();
            if (status.status === 'active' && status.stateAge !== null && status.stateAge < 3000) return;
            await new Promise(r => setTimeout(r, 500));
        }
        throw new Error(`No client published state for "${this.config.botUsername}" within ${timeout}ms`);
    }

    // ============ State access (synchronous) ============

    /** Last world state snapshot, or null before the first one. */
    getState(): BotWorldState | null {
        return this.state;
    }

    /** Gateway time (ms epoch) the current state arrived from the client. */
    getStateReceivedAt(): number {
        return this.stateReceivedAt;
    }

    /** Milliseconds since the current state arrived at the gateway (0 before any state). */
    getStateAge(): number {
        if (this.stateReceivedAt === 0) return 0;
        return Date.now() - this.stateReceivedAt;
    }

    /** Subscribe to state snapshots; returns an unsubscribe function. */
    onStateUpdate(listener: (state: BotWorldState) => void): () => void {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }

    /** Our character, or null when not in game. */
    getPlayer(): PlayerState | null {
        return this.state?.player ?? null;
    }

    /** Our region and global coordinates. */
    getPosition(): Position | null {
        const p = this.state?.player;
        return p ? { regionId: p.regionId, x: p.x, y: p.y, z: p.z } : null;
    }

    /** Mover state: moving, destination, waypoints, last stop reason. */
    getMovement(): MovementState | null {
        return this.state?.movement ?? null;
    }

    /** Backpack items (slots 40-79), occupied slots only. Pass `item.slot` to send* calls. */
    getInventory(): InventoryItem[] {
        return this.state?.inventory ?? [];
    }

    /** Backpack item in a slot, or null. */
    getInventoryItem(slot: number): InventoryItem | null {
        return this.state?.inventory.find(i => i.slot === slot) ?? null;
    }

    /** Backpack item by name (case-insensitive substring or RegExp; shortest name wins). */
    findInventoryItem(pattern: NamePattern): InventoryItem | null {
        return bestNameMatch(this.state?.inventory ?? [], pattern);
    }

    /** Total quantity across every backpack slot whose name matches. */
    countInventoryItems(pattern: NamePattern): number {
        const matches = nameMatcher(pattern);
        return (this.state?.inventory ?? []).reduce((total, item) => total + (matches(item.name) ? Math.max(1, item.count) : 0), 0);
    }

    /** Free backpack slots (40 total). */
    getFreeInventorySlots(): number {
        return 40 - (this.state?.inventory.length ?? 0);
    }

    /** Equipped items (slots 10-37). */
    getEquipment(): InventoryItem[] {
        return this.state?.equipment ?? [];
    }

    /** Equipped item in a slot (see EquipmentSlot), or null. */
    getEquipmentItem(slot: number): InventoryItem | null {
        return this.state?.equipment.find(i => i.slot === slot) ?? null;
    }

    /** Equipped item by name (shortest name wins). */
    findEquipmentItem(pattern: NamePattern): InventoryItem | null {
        return bestNameMatch(this.state?.equipment ?? [], pattern);
    }

    /** Vault items (populated after the vault window has been opened). */
    getVault(): InventoryItem[] {
        return this.state?.vault ?? [];
    }

    /** Nearby NPCs and monsters. */
    getNearbyNpcs(): NearbyNpc[] {
        return this.state?.nearbyNpcs ?? [];
    }

    /** Nearby NPC by object id. */
    getNearbyNpc(objectId: number): NearbyNpc | null {
        return this.state?.nearbyNpcs.find(n => n.objectId === objectId) ?? null;
    }

    /** All NPCs matching a name and filters, nearest first. */
    findNearbyNpcs(pattern: NamePattern = /.*/, options: FindNpcOptions = {}): NearbyNpc[] {
        const matches = nameMatcher(pattern);
        return this.filterNpcs(options).filter(n => matches(n.name)).sort((a, b) => a.distance - b.distance);
    }

    /** Best NPC by name (shortest name, then nearest) after filters: maxDistance, minLevel, maxLevel, attackable. */
    findNearbyNpc(pattern: NamePattern, options: FindNpcOptions = {}): NearbyNpc | null {
        return bestNameMatch(this.filterNpcs(options), pattern);
    }

    private filterNpcs(options: FindNpcOptions): NearbyNpc[] {
        const player = this.state?.player ?? null;
        return (this.state?.nearbyNpcs ?? []).filter(n =>
            (options.maxDistance === undefined || n.distance <= options.maxDistance) &&
            (options.minLevel === undefined || n.level >= options.minLevel) &&
            (options.maxLevel === undefined || n.level <= options.maxLevel) &&
            (!options.attackable || isAttackable(n, player)));
    }

    /** Nearby players. */
    getNearbyPlayers(): NearbyPlayer[] {
        return this.state?.nearbyPlayers ?? [];
    }

    /** Nearby player by object id (enemy players are named by race, so their names are not unique). */
    getNearbyPlayer(objectId: number): NearbyPlayer | null {
        return this.state?.nearbyPlayers.find(p => p.objectId === objectId) ?? null;
    }

    /** Nearby player by name (shortest name, then nearest). */
    findNearbyPlayer(pattern: NamePattern, options: FindOptions = {}): NearbyPlayer | null {
        return bestNameMatch((this.state?.nearbyPlayers ?? []).filter(p => options.maxDistance === undefined || p.distance <= options.maxDistance), pattern);
    }

    /** Nearby static objects, doors and loot. */
    getNearbyObjects(): NearbyObject[] {
        return this.state?.nearbyObjects ?? [];
    }

    /** Nearby object by name (shortest name, then nearest). */
    findNearbyObject(pattern: NamePattern, options: FindOptions & { loot?: boolean } = {}): NearbyObject | null {
        return bestNameMatch((this.state?.nearbyObjects ?? []).filter(o =>
            (options.maxDistance === undefined || o.distance <= options.maxDistance) &&
            (options.loot === undefined || o.isLoot === options.loot)), pattern);
    }

    /** Loot on the ground, nearest first. */
    getNearbyLoot(): NearbyObject[] {
        return (this.state?.nearbyObjects ?? []).filter(o => o.isLoot).sort((a, b) => a.distance - b.distance);
    }

    /** Any nearby NPC, player or object by object id. */
    getObject(objectId: number): NearbyNpc | NearbyPlayer | NearbyObject | null {
        const s = this.state;
        if (!s) return null;
        return s.nearbyNpcs.find(o => o.objectId === objectId)
            ?? s.nearbyPlayers.find(o => o.objectId === objectId)
            ?? s.nearbyObjects.find(o => o.objectId === objectId)
            ?? null;
    }

    /** Our current target (player.targetObjectId) when it is nearby. */
    getTarget(): NearbyNpc | NearbyPlayer | NearbyObject | null {
        const id = this.state?.player?.targetObjectId;
        return id === null || id === undefined ? null : this.getObject(id);
    }

    /** Specializations, abilities, styles and spells. */
    getSkills(): SkillsState {
        return this.state?.skills ?? { specializations: [], abilities: [], styles: [], spells: [] };
    }

    /**
     * Specialization by any name of its line: as listed ('Shield'), its DB key ('Shields', from classes.json,
     * Style.specName or ItemBonus.spec) or an item's bonus name ('Cave Magic'). Failing those, by part of
     * the listed name (shortest wins). Look lines up here rather than with === on the list, which only knows the listed name.
     */
    findSpecialization(pattern: NamePattern): Specialization | null {
        if (pattern === '') return null;
        const specs = this.getSkills().specializations;
        if (typeof pattern === 'string') {
            const listed = specDisplayName(pattern).toLowerCase();
            return specs.find(s => s.name.toLowerCase() === listed) ?? bestNameMatch(specs, pattern);
        }
        const matches = nameMatcher(pattern);
        return bestNameMatch(specs, pattern) ?? specs.find(s => matches(specKey(s.name))) ?? null;
    }

    /** Spell by name; pass its lineIndex/spellIndex to sendCastSpell, or for a hybrid's, those being -1, its skillIndex to sendUseSkill. Highest level wins among equal names. */
    findSpell(pattern: NamePattern): Spell | null {
        const matches = nameMatcher(pattern);
        const spells = this.getSkills().spells.filter(s => matches(s.name));
        if (spells.length === 0) return null;
        return spells.reduce((best, s) => (s.name.length < best.name.length || (s.name.length === best.name.length && s.level > best.level) ? s : best));
    }

    /** Combat style by name; pass its skillIndex to sendUseSkill. */
    findStyle(pattern: NamePattern): Style | null {
        return bestNameMatch(this.getSkills().styles, pattern);
    }

    /** Ability by name; pass its skillIndex to sendUseSkill. */
    findAbility(pattern: NamePattern): Ability | null {
        return bestNameMatch(this.getSkills().abilities, pattern);
    }

    /** Active buffs/debuffs. */
    getEffects(): Effect[] {
        return this.state?.effects ?? [];
    }

    /** Active effect by name, or null. A string matches inside a name: Lesser Bark Skin passes for Bark Skin. */
    findEffect(pattern: NamePattern): Effect | null {
        return bestNameMatch(this.getEffects(), pattern);
    }

    /** Open merchant window, or null when none is open. */
    getMerchant(): MerchantState | null {
        return this.state?.merchant?.isOpen ? this.state.merchant : null;
    }

    /** Open trainer window, or null when none is open. */
    getTrainer(): TrainerState | null {
        return this.state?.trainer?.isOpen ? this.state.trainer : null;
    }

    /** Open player trade window, or null when none is open. Its partnerItems carry the partner's slots, never ours. */
    getTrade(): TradeWindow | null {
        return this.state?.trade ?? null;
    }

    /** Our pet's window (0x88), or null without a pet. It holds while the pet is out of view. A pet the window doesn't list (a Theurgist's, a minion) never shows here. */
    getPetState(): PetState | null {
        return this.state?.pet ?? null;
    }

    /** Our window pet's NPC entry, or null: no pet, or it is out of view right now. */
    getPet(): NearbyNpc | null {
        const id = this.state?.pet?.objectId;
        return id === undefined ? null : this.getNearbyNpc(id);
    }

    /**
     * Our own pets with no window, the entries in view, nearest first: a Theurgist's, a fire-and-forget turret, a bomber, a
     * Bonedancer's minion. Known from the 0x1B of their summon (BotWorldState.summons), and never in getPetState. Orders don't reach them.
     */
    getSummons(): NearbyNpc[] {
        const ids = this.state?.summons;
        return ids?.length ? this.state!.nearbyNpcs.filter(n => ids.includes(n.objectId)) : [];
    }

    /** Open 0x81 dialog box (group invite, quest offer, yes/no), or null. Answer with sendRespondDialog. */
    getDialog(): DialogBox | null {
        return this.state?.dialog?.isOpen ? this.state.dialog : null;
    }

    /** The resurrection offer waiting for our answer, or null. Answer with bot.acceptResurrection or bot.respondToDialog. */
    getResurrectionOffer(): ResurrectionOffer | null {
        return this.getDialog()?.resurrection ?? null;
    }

    /** Last NPC dialogue with its [keywords]; answer with sendWhisper(npcObjectId, keyword). */
    getNpcDialog(): NpcDialog | null {
        return this.state?.npcDialog ?? null;
    }

    /** Last custom text window (0xC4), or null. */
    getTextWindow(): TextWindow | null {
        return this.state?.textWindow ?? null;
    }

    /** Group members (empty when not grouped). */
    getGroup(): GroupMember[] {
        return this.state?.group ?? [];
    }

    /** Messages in the latest snapshot (last 100), oldest first. */
    getGameMessages(): GameMessage[] {
        return this.state?.gameMessages ?? [];
    }

    // ============ Geometry ============

    /** Distance from our player to an object or position (3D when both have z). Infinity when not in game. */
    distanceTo(target: { x: number; y: number; z?: number }): number {
        const p = this.state?.player;
        if (!p) return Infinity;
        return distanceBetween(p, target);
    }

    /** DAoC heading (0..4095) from our player to an object or position; pass it to sendFace. */
    headingTo(target: { x: number; y: number }): number {
        const p = this.state?.player;
        if (!p) return 0;
        return headingBetween(p, target);
    }

    // ============ Chat ============

    /** Server/client chat cap per message, learned from the gateway handshake. */
    get maxMessageLength(): number {
        return this.serverMaxMessageLength;
    }

    private chatFilter(opts: { types?: readonly ChatType[] | 'all'; includeSelf?: boolean }): (m: GameMessage) => boolean {
        const types = opts.types ?? PLAYER_CHAT_TYPES;
        const typeSet = types === 'all' ? null : new Set(types);
        const includeSelf = opts.includeSelf ?? false;
        const me = this.state?.player?.name ?? null;
        return m => (!typeSet || typeSet.has(m.type)) && (includeSelf || !isOwnMessage(m, me));
    }

    /** Recent chat from the 500-deep history (player chat by default), oldest first. */
    getChat(opts: ChatQuery = {}): GameMessage[] {
        const limit = opts.limit ?? 20;
        const filtered = this.chatHistory.all().filter(this.chatFilter(opts));
        return limit > 0 ? filtered.slice(-limit) : filtered;
    }

    /** Chat that arrived since the last getNewChat call (cursor-based). */
    getNewChat(opts: Omit<ChatQuery, 'limit'> = {}): GameMessage[] {
        const prev = this.chatReadCursor;
        this.chatReadCursor = this.chatHistory.seen;
        return this.chatHistory.since(prev).filter(this.chatFilter(opts));
    }

    /** Recent chat from one sender (case-insensitive substring). */
    getChatFrom(name: string, opts: { limit?: number } = {}): GameMessage[] {
        const limit = opts.limit ?? 20;
        const needle = name.toLowerCase();
        const filtered = this.chatHistory.all().filter(m => m.sender !== null && m.sender.toLowerCase().includes(needle));
        return limit > 0 ? filtered.slice(-limit) : filtered;
    }

    /**
     * Wait for the next message matching the filters (arriving after this call).
     * Returns null on timeout (default 30 s).
     */
    async waitForChat(opts: { from?: string; matching?: RegExp | string; types?: readonly ChatType[] | 'all'; includeSelf?: boolean; timeout?: number } = {}): Promise<GameMessage | null> {
        const { from, matching, timeout = 30000 } = opts;
        const pattern = typeof matching === 'string' ? new RegExp(matching, 'i') : matching;
        const baseFilter = this.chatFilter(opts);
        const accepts = (m: GameMessage) =>
            baseFilter(m) &&
            (!from || (m.sender !== null && m.sender.toLowerCase().includes(from.toLowerCase()))) &&
            (!pattern || pattern.test(m.text));
        let cursor = this.chatHistory.seen;
        return executionWait<GameMessage | null>(resolve => {
            const timeoutId = setTimeout(() => resolve(null), timeout);
            const unsubscribe = this.onStateUpdate(() => {
                const fresh = this.chatHistory.since(cursor);
                cursor = this.chatHistory.seen;
                const match = fresh.find(accepts);
                if (match) resolve(match);
            });
            return () => { clearTimeout(timeoutId); unsubscribe(); };
        });
    }

    private async chunked(text: string, opts: ChatSendOptions, sendOne: (chunk: string) => Promise<ActionResult>): Promise<ActionResult[]> {
        const maxLen = Math.min(opts.maxLen ?? this.serverMaxMessageLength, this.serverMaxMessageLength);
        const delayMs = opts.delayMs ?? 700;
        const chunks = chunkMessage(text, maxLen);
        const results: ActionResult[] = [];
        for (let i = 0; i < chunks.length; i++) {
            const result = await sendOne(chunks[i]!);
            results.push(result);
            if (!result.success) break;
            if (i < chunks.length - 1 && delayMs > 0) {
                if (this.config.connectionMode === 'observe') {
                    // Observers may only dispatch chat; a 'wait' would also occupy the controller's queue.
                    await executionWait<void>(resolve => { const t = setTimeout(resolve, delayMs); return () => clearTimeout(t); });
                } else {
                    await this.sendWait(delayMs);
                }
            }
        }
        return results;
    }

    /** Say text of any length: split into chunks and paced. One ActionResult per chunk sent. */
    async say(text: string, opts: ChatSendOptions = {}): Promise<ActionResult[]> {
        return this.chunked(text, opts, chunk => this.sendSay(chunk));
    }

    /** Private message ('/send') of any length to a player by name, chunked like say(). */
    async send(to: string, text: string, opts: ChatSendOptions = {}): Promise<ActionResult[]> {
        return this.chunked(text, opts, chunk => this.sendSend(to, chunk));
    }

    // ============ Raw actions ============

    /**
     * Dispatch one BotAction and resolve with the client's ActionResult.
     * Timeouts, disconnects mid-flight and gateway errors come back as a failed
     * result (phase 'dispatch'); only "not connected" throws.
     */
    async sendAction(action: BotAction): Promise<ActionResult> {
        if (this.connectionMode() === 'observe' && action.type !== 'say' && action.type !== 'send') {
            return { success: false, message: `Observe mode can only send 'say' or 'send' actions (got '${action.type}')`, reason: 'observe_mode', phase: 'validation' };
        }
        if (this.connectionState === 'reconnecting') await this.waitForConnection();
        if (!this.isConnected()) throw new Error(`Not connected (state: ${this.connectionState})`);

        const actionId = `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try {
            return await executionWait<ActionResult>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingActions.delete(actionId);
                    reject(new ActionDispatchError(`Action timed out: ${action.type}`, 'timeout'));
                }, this.config.actionTimeout);
                this.pendingActions.set(actionId, { resolve, reject, timeout });
                try {
                    this.transmit({
                        type: 'sdk_action',
                        username: this.config.botUsername,
                        actionId,
                        action,
                        actionTimeoutMs: this.config.actionTimeout,
                    });
                } catch (error) {
                    reject(error);
                }
                return () => {
                    clearTimeout(timeout);
                    this.pendingActions.delete(actionId);
                };
            });
        } catch (err) {
            throwIfExecutionAborted();
            return {
                success: false,
                message: err instanceof Error ? err.message : String(err),
                reason: err instanceof ActionDispatchError ? err.reason : 'error',
                phase: 'dispatch',
            };
        }
    }

    private connectionMode(): ConnectionMode {
        return this.config?.connectionMode ?? 'control';
    }

    /**
     * Walk/run to x,y (z optional) via the client's mover; optional waypoints and speed factor (≤1). A move the move guard
     * cut is sent to the cut and says where in `heldAt`.
     */
    async sendMoveTo(x: number, y: number, z?: number, opts: { tolerance?: number; waypoints?: Vec3[]; speedFactor?: number } = {}): Promise<ActionResult & { heldAt?: { x: number; y: number } }> {
        const guard = this.moveGuard;
        const p = guard ? this.getPlayer() : null;
        const cut = p && guard ? guard(p, { x, y, z }, opts.waypoints ?? []) : null;
        if (p && cut) {
            // Within the move's own tolerance counts as here too: the mover would "arrive" without a step.
            if (!cut.waypoints.length && Math.hypot(cut.to.x - p.x, cut.to.y - p.y) <= Math.max(MOVE_GUARD_HERE, (opts.tolerance ?? 0) + 2)) {
                return { success: false, reason: 'water', message: `(${Math.round(x)}, ${Math.round(y)}) is in deep water: holding at the bank` };
            }
            ({ x, y, z } = cut.to);
            opts = { ...opts, waypoints: cut.waypoints };
            const r = await this.sendAction({ type: 'moveTo', x, y, z, ...opts, reason: 'SDK' });
            return r.success ? { ...r, heldAt: { x: cut.to.x, y: cut.to.y } } : r;
        }
        return this.sendAction({ type: 'moveTo', x, y, z, ...opts, reason: 'SDK' });
    }

    /**
     * Cut every move from here on (sendMoveTo, and so walkTo, walkToObject, castSpell's approach and killNpc's chase) by
     * `guard`, or none with null. A move cut to where we stand is refused with reason 'water'. Returns a function that
     * removes this guard (and no later one).
     */
    setMoveGuard(guard: MoveGuard | null): () => void {
        this.moveGuard = guard;
        return () => { if (this.moveGuard === guard) this.moveGuard = null; };
    }

    /** Stop moving (final position update with speed 0). */
    async sendStop(): Promise<ActionResult> {
        return this.sendAction({ type: 'stop', reason: 'SDK' });
    }

    /** Turn to a heading (0..4095). */
    async sendFace(heading: number): Promise<ActionResult> {
        return this.sendAction({ type: 'face', heading, reason: 'SDK' });
    }

    /** Turn to face an object. */
    async sendFaceObject(objectId: number): Promise<ActionResult> {
        return this.sendAction({ type: 'faceObject', objectId, reason: 'SDK' });
    }

    /** Jump. */
    async sendJump(): Promise<ActionResult> {
        return this.sendAction({ type: 'jump', reason: 'SDK' });
    }

    /** Select a target by object id (null clears it). */
    async sendSetTarget(objectId: number | null): Promise<ActionResult> {
        return this.sendAction({ type: 'setTarget', objectId, reason: 'SDK' });
    }

    /** Right-click interact with an NPC or object (opens merchant/trainer/dialog). */
    async sendInteract(objectId: number): Promise<ActionResult> {
        return this.sendAction({ type: 'interact', objectId, reason: 'SDK' });
    }

    /** Whisper text to an NPC, e.g. a [keyword] from its dialog. */
    async sendWhisper(objectId: number, text: string): Promise<ActionResult> {
        return this.sendAction({ type: 'whisper', objectId, text, reason: 'SDK' });
    }

    /** Pick up loot on the ground. */
    async sendPickup(objectId: number): Promise<ActionResult> {
        return this.sendAction({ type: 'pickup', objectId, reason: 'SDK' });
    }

    /** Toggle melee auto-attack on the current target. */
    async sendAttack(on: boolean = true): Promise<ActionResult> {
        return this.sendAction({ type: 'attack', on, reason: 'SDK' });
    }

    /** Use a style or ability by skillIndex (see findStyle/findAbility). */
    async sendUseSkill(skillIndex: number): Promise<ActionResult> {
        return this.sendAction({ type: 'useSkill', skillIndex, reason: 'SDK' });
    }

    /** Cast a spell by lineIndex/spellIndex (see findSpell) on the current target. */
    async sendCastSpell(lineIndex: number, spellIndex: number): Promise<ActionResult> {
        return this.sendAction({ type: 'castSpell', lineIndex, spellIndex, reason: 'SDK' });
    }

    /**
     * Set the ground target. Without `z` the client snaps it to its terrain, the ground the mover walks on, under a river the
     * mesh's plane 16 below the surface (else our own height); a z passed goes out as given. In a zone where the server has a navmesh loaded it drops a target more than
     * 16 units off the mesh (ground_target_snap_max_distance), and says only "Your ground target is not visible!", and it snaps
     * one it takes to the nearest walkable ground, so its spot can differ from state.groundTarget: usually by a few units, by more beside a gap in the mesh (PlayerGroundTargetHandler.cs:21-33, ground.ts groundTargetSnap). An NPC's coordinates are always a valid spot.
     * Two sets need a pause of about 300 ms: that line names no spot, so the answer to a bad one wipes a good one sent within the round trip from state.groundTarget, and the next cast reads it as not in view.
     */
    async sendSetGroundTarget(x: number, y: number, z?: number): Promise<ActionResult> {
        return this.sendAction({ type: 'setGroundTarget', x, y, z, reason: 'SDK' });
    }

    /** Order our pet; with `targetObjectId`, target that first (our target stays moved). Success means dispatched: bot.* observes the answer. */
    async sendPetCommand(command: PetCommand, targetObjectId?: number): Promise<ActionResult> {
        if (command === 'attack') this.petAttackSentAt = Date.now();
        return this.sendAction({ type: 'petCommand', command, targetObjectId, reason: 'SDK' });
    }

    /** When the last attack order went to our pet (Date.now()), null before any. Its refusal comes on the one line stream with everything else, and castSpell has to tell it from its own. */
    getPetAttackSentAt(): number | null {
        return this.petAttackSentAt ?? null;
    }

    /** Use an item in a slot (potions, charged items). */
    async sendUseItem(slot: number, useType?: number): Promise<ActionResult> {
        return this.sendAction({ type: 'useItem', slot, useType, reason: 'SDK' });
    }

    /** Move an item between slots (equip, unequip, stack split, vault). */
    async sendMoveItem(fromSlot: number, toSlot: number, count?: number): Promise<ActionResult> {
        return this.sendAction({ type: 'moveItem', fromSlot, toSlot, count, reason: 'SDK' });
    }

    /** Drop an item on the ground. */
    async sendDropItem(slot: number): Promise<ActionResult> {
        return this.sendAction({ type: 'dropItem', slot, reason: 'SDK' });
    }

    /**
     * Ask the server to delve the item in a slot; the answer is the next text window (getTextWindow),
     * and an empty slot gets none. bot.delveItem waits for it and parses the bonuses.
     */
    async sendDelve(slot: number): Promise<ActionResult> {
        return this.sendAction({ type: 'delve', slot, reason: 'SDK' });
    }

    /**
     * Ask the server to delve an item in the open merchant window; the answer is the next text
     * window. bot.delveMerchantItem opens the window, waits for the answer and parses it.
     */
    async sendDelveMerchantItem(page: number, slot: number): Promise<ActionResult> {
        return this.sendAction({ type: 'delveMerchantItem', page, slot, reason: 'SDK' });
    }

    /** Destroy an item. */
    async sendDestroyItem(slot: number): Promise<ActionResult> {
        return this.sendAction({ type: 'destroyItem', slot, reason: 'SDK' });
    }

    /** Buy from the open merchant by page/slot (see getMerchant). */
    async sendBuy(page: number, slot: number, count: number = 1): Promise<ActionResult> {
        return this.sendAction({ type: 'buy', page, slot, count, reason: 'SDK' });
    }

    /** Sell a backpack item to the open merchant. */
    async sendSell(slot: number): Promise<ActionResult> {
        return this.sendAction({ type: 'sell', slot, reason: 'SDK' });
    }

    /** Open the trainer window, anywhere while allow_train_anywhere is on (train.cs:143), else with a trainer targeted. */
    async sendOpenTrainer(): Promise<ActionResult> {
        return this.sendAction({ type: 'openTrainer', reason: 'SDK' });
    }

    /** Train a specialization (index from getTrainer().specs). */
    async sendTrainSpec(specIndex: number, levels?: number): Promise<ActionResult> {
        return this.sendAction({ type: 'trainSpec', specIndex, levels, reason: 'SDK' });
    }

    /** Add a backpack item to the trade window with a player, opening it if needed. Evidence is the slot in getState().trade.mySlots. Never from both sides at once: two adds that open a window in one server tick can hang the server (learnings/trading.md). bot.offerTrade keeps them apart. */
    async sendTradeOfferItem(partnerObjectId: number, slot: number): Promise<ActionResult> {
        return this.sendAction({ type: 'tradeOfferItem', partnerObjectId, slot, reason: 'SDK' });
    }

    /** Add copper to the trade window with a player, on top of what is there. It goes out as one drop per coin, and the server holds only that drop against the purse, never the total (PlayerMoveItemRequestHandler.cs:258): an amount above the purse can be refused in part, or shown in full and fail at the commit. bot.offerTrade checks the purse first. */
    async sendTradeOfferMoney(partnerObjectId: number, copper: number): Promise<ActionResult> {
        return this.sendAction({ type: 'tradeOfferMoney', partnerObjectId, copper, reason: 'SDK' });
    }

    /** Accept the open trade; with a revision, only while the window still shows it, and with a window id, only while it is that window, because revisions start over per window (reason trade_changed otherwise). The second accept commits. */
    async sendTradeAccept(revision?: number, windowId?: number): Promise<ActionResult> {
        return this.sendAction({ type: 'tradeAccept', revision, windowId, reason: 'SDK' });
    }

    /** Close the trade window, also one the server holds but never told us about. A no-op on the server without one. */
    async sendTradeCancel(): Promise<ActionResult> {
        return this.sendAction({ type: 'tradeCancel', reason: 'SDK' });
    }

    /** Answer the open dialog box (yes/accept or no/decline). */
    async sendRespondDialog(accept: boolean): Promise<ActionResult> {
        return this.sendAction({ type: 'respondDialog', accept, reason: 'SDK' });
    }

    /** Close the merchant window. */
    async sendCloseMerchant(): Promise<ActionResult> {
        return this.sendAction({ type: 'closeMerchant', reason: 'SDK' });
    }

    /** Say one message (no chunking; see say()). */
    async sendSay(text: string): Promise<ActionResult> {
        return this.sendAction({ type: 'say', text, reason: 'SDK' });
    }

    /** Private message ('/send') one message to a player (no chunking; see send()). */
    async sendSend(to: string, text: string): Promise<ActionResult> {
        return this.sendAction({ type: 'send', to, text, reason: 'SDK' });
    }

    /** Group chat. */
    async sendGroupSay(text: string): Promise<ActionResult> {
        return this.sendAction({ type: 'groupSay', text, reason: 'SDK' });
    }

    /** Slash command sent verbatim, e.g. '&stick', '/bind' ('/' becomes '&'). */
    async sendCommand(command: string): Promise<ActionResult> {
        return this.sendAction({ type: 'command', command, reason: 'SDK' });
    }

    /** Sit (true) or stand (false). */
    async sendSit(sit: boolean = true): Promise<ActionResult> {
        return this.sendAction({ type: 'sit', sit, reason: 'SDK' });
    }

    /**
     * Ask the server to use a zone point, by its id (0x90). Success means dispatched: the server
     * silently ignores a wrong id or another realm's zone point. bot.useZonePoint walks to the
     * zone point and observes the jump.
     */
    async sendRegionChangeRequest(zonePointId: number): Promise<ActionResult> {
        return this.sendAction({ type: 'regionChangeRequest', zonePointId, reason: 'SDK' });
    }

    /**
     * Drop one of our concentration buffs (frees its concentration), by its `index`
     * in `state.concentrationEffects`. Observe the effect leaving that list.
     */
    async sendRemoveConcentrationEffect(index: number): Promise<ActionResult> {
        return this.sendAction({ type: 'removeConcentration', index, reason: 'SDK' });
    }

    /** Release after death (back to bind point). */
    async sendRelease(): Promise<ActionResult> {
        return this.sendAction({ type: 'release', reason: 'SDK' });
    }

    /** Quit to the character screen ('&quit'; the server timer is 20 s+). */
    async sendQuit(): Promise<ActionResult> {
        return this.sendAction({ type: 'quit', reason: 'SDK' });
    }

    /** No-op round trip: succeeds once the client's action queue reaches it. */
    async sendNone(): Promise<ActionResult> {
        return this.sendAction({ type: 'none', reason: 'SDK' });
    }

    /** Occupy the client's action queue for `ms` milliseconds. */
    async sendWait(ms: number = 600): Promise<ActionResult> {
        return this.sendAction({ type: 'wait', ms, reason: 'SDK' });
    }

    // ============ Waits ============

    /** Wait until in game with a player present. Throws on timeout. */
    async waitForReady(timeout: number = 15000): Promise<BotWorldState> {
        try {
            return await this.waitForCondition(s => s.inGame && s.player !== null, timeout);
        } catch (error) {
            throwIfExecutionAborted();
            throw new Error(`Game state not ready within ${timeout}ms`);
        }
    }

    /**
     * Wait until the predicate passes on a state (the current one counts) and
     * return it. THROWS `Error('waitForCondition timed out')` on timeout.
     */
    async waitForCondition(predicate: (state: BotWorldState) => boolean, timeout: number = 30000): Promise<BotWorldState> {
        throwIfExecutionAborted();
        if (this.state && predicate(this.state)) return this.state;
        return this.waitForObservation(predicate, timeout, 'waitForCondition timed out');
    }

    private waitForObservation(predicate: (state: BotWorldState) => boolean, timeout: number, timeoutMessage: string): Promise<BotWorldState> {
        return executionWait<BotWorldState>((resolve, reject) => {
            const timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeout);
            const unsubscribe = this.onStateUpdate(state => {
                try {
                    if (predicate(state)) resolve(state);
                } catch (error) {
                    reject(error);
                }
            });
            return () => { clearTimeout(timeoutId); unsubscribe(); };
        });
    }

    /** Wait for the next state snapshot. */
    async waitForStateChange(timeout: number = 30000): Promise<BotWorldState> {
        return this.waitForObservation(() => true, timeout, 'waitForStateChange timed out');
    }

    /** Wait for `ticks` more published snapshots (state.tick is the client's publish counter). */
    async waitForTicks(ticks: number = 1): Promise<BotWorldState> {
        if (!this.state) throw new Error('waitForTicks: no state available');
        if (ticks <= 0) return this.state;
        const target = this.state.tick + ticks;
        return this.waitForObservation(s => s.tick >= target, ticks * 1000 + 5000, `waitForTicks(${ticks}) safety timeout - no state updates received`);
    }

    // ============ Internal ============

    private transmit(message: object) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    }

    private handleMessage(data: string) {
        let message: SyncToSDKMessage;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }

        if ((message.type === 'sdk_connected' || message.type === 'sdk_info') && typeof message.maxMessageLength === 'number' && message.maxMessageLength > 0) {
            this.serverMaxMessageLength = message.maxMessageLength;
        }

        if (message.type === 'sdk_state' && message.state) {
            const state = message.state;
            if (this.config.showChat === false && Array.isArray(state.gameMessages)) {
                // Only other players' chat: bot.* observes our own echoes and NPC speech (also type 'say').
                const npcNames = (state.nearbyNpcs ?? []).map(n => n.name);
                state.gameMessages = state.gameMessages.filter(m => !isOtherPlayersChat(m, npcNames, state.player?.name));
            }
            // Before listeners fire, so waitForChat sees the new messages.
            if (Array.isArray(state.gameMessages)) this.chatHistory.record(state.gameMessages);
            this.state = state;
            this.stateReceivedAt = message.stateReceivedAt || Date.now();
            for (const listener of this.stateListeners) {
                try { listener(state); } catch (e) { console.error('State listener error:', e); }
            }
        }

        if (message.type === 'sdk_action_result' && message.actionId) {
            const pending = this.pendingActions.get(message.actionId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingActions.delete(message.actionId);
                if (message.result) pending.resolve(message.result);
                else pending.reject(new ActionDispatchError('No result in action response', 'error'));
            }
        }

        if (message.type === 'sdk_error') {
            // gateway/gateway.ts sends this to the old controller, then closes its socket.
            if (message.error?.includes('another controller connected')) {
                console.warn('[BotSDK] Pre-empted by another controller - disabling auto-reconnect');
                this.intentionalDisconnect = true;
                this.preemptedReason = message.error;
            }
            if (message.actionId) {
                const pending = this.pendingActions.get(message.actionId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingActions.delete(message.actionId);
                    const lost = message.error?.startsWith('Bot client disconnected') ?? false;
                    pending.reject(new ActionDispatchError(message.error || 'Unknown error', lost ? 'disconnected' : 'error'));
                }
            } else if (message.error === 'Bot disconnected') {
                // The client is gone, so nothing in flight will ever be answered.
                for (const pending of this.pendingActions.values()) {
                    clearTimeout(pending.timeout);
                    pending.reject(new ActionDispatchError('Bot client disconnected before answering', 'disconnected'));
                }
                this.pendingActions.clear();
            }
        }
    }
}

export * from './types';
