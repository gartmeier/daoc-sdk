// GatewayBridge: one DaocClient wired to the SDK gateway (port of rs-sdk's
// lite runner, reference/rs-sdk/server/webclient/src/lite/runner.ts, and
// bot/GatewayConnection.ts).
//
//   register ('connected') → wait for the gateway's 'status' → log into DAoC
//   state frames from the client (also while logging in / backing off)
//   'action' → BotActionQueue (TTL from actionTimeoutMs) → execute → actionResult + state
//   gateway reconnects with backoff without touching the DAoC session
//   save_and_disconnect / stop(): clean '&quit', then close and don't reconnect
//
// The 'status' wait matters for takeover: the gateway parks a second client
// for the same bot until the first has quit, and only then sends it 'status'.

import type { ActionResult, BotAction, BotWorldState, ClientPhase } from '../sdk/types';
import { isPlayerChat } from '../sdk/chat-history';
import { DEFAULT_MAX_MESSAGE_LENGTH } from '../sdk/chunking';
import { BotActionQueue, type QueuedBotAction } from './action-queue';
import { SessionError } from './session';

/** What the bridge needs from DaocClient (a fake in tests). */
export interface BridgeClient {
    readonly inGame: boolean;
    readonly phase: ClientPhase;
    connect(): Promise<void>;
    collectState(): BotWorldState;
    onStateChange(fn: (state: BotWorldState) => void): () => void;
    onDisconnect(fn: (reason: string, message: string) => void): void;
    execute(action: BotAction): Promise<ActionResult>;
    quit(): Promise<void>;
    disconnect(): void;
}

export interface BridgeOptions {
    gatewayUrl: string;
    username: string;
    password: string;
    clientId?: string;
    maxMessageLength?: number;
    log?: (msg: string) => void;
    /** Print player chat as it arrives. */
    showChat?: boolean;
    /** Log in again after an unexpected session end instead of finishing with code 1 (swarm). */
    relogin?: boolean;
    reconnectMinMs?: number;
    reconnectMaxMs?: number;
    /** Wait after 0x2C code 0x11 (account still in the 60 s logout procedure). Default 65 s. */
    lockoutBackoffMs?: number;
    /** First retry delay after a transient login failure; doubles up to loginRetryMaxMs. */
    loginRetryMs?: number;
    loginRetryMaxMs?: number;
    /** Transient login failures in a row before giving up (ignored with relogin). Default 5. */
    maxLoginAttempts?: number;
    /** State is re-sent at least this often (the gateway marks a bot stale after 8 s). */
    heartbeatMs?: number;
    /** Bound on waiting for an in-flight login before quitting on stop(). Default 45 s. */
    stopLoginWaitMs?: number;
}

export interface BridgeExit {
    /** 0 clean (stop, save_and_disconnect, quit action), 1 unexpected session end, 2 fatal login/config error. */
    code: number;
    reason: string;
}

/** Login failures that retrying cannot fix. */
const FATAL_LOGIN = new Set(['loginDenied', 'characterNotFound', 'creationFailed', 'realmLocked']);
/** 0x2C AccountAlreadyLoggedIn: another client of this account is still in (or quitting): transient. */
const ALREADY_LOGGED_IN = 0x0b;

/** Phases in which the character is (or is about to be) in the world, so stop() must quit, not close. */
const QUIT_PHASES = new Set<ClientPhase>(['playing', 'enteringWorld', 'regionChange', 'quitting']);

export class GatewayBridge {
    readonly queue = new BotActionQueue();
    private ws: WebSocket | null = null;
    private registered = false;
    private preventReconnect = false;
    private reconnectDelay: number;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private lastSentAt = 0;
    private loginStarted = false;
    private loginPromise: Promise<void> | null = null;
    private inWorld = false;
    private stopping = false;
    private finished = false;
    private backoff = new AbortController();
    private backoffNote: string | null = null;
    private lastShownMessageId = 0;
    private unsubscribeState: (() => void) | null = null;
    private resolveExit!: (exit: BridgeExit) => void;
    readonly exited: Promise<BridgeExit>;
    /** Successful logins (the first one included). */
    logins = 0;
    lastExit: BridgeExit | null = null;

    private readonly log: (msg: string) => void;
    private readonly o: Required<Omit<BridgeOptions, 'log' | 'clientId'>> & { clientId?: string };

    constructor(readonly client: BridgeClient, options: BridgeOptions) {
        this.log = options.log ?? (msg => console.log(`[runner:${options.username}] ${msg}`));
        this.o = {
            maxMessageLength: DEFAULT_MAX_MESSAGE_LENGTH, showChat: false, relogin: false,
            reconnectMinMs: 500, reconnectMaxMs: 10_000, lockoutBackoffMs: 65_000,
            loginRetryMs: 5000, loginRetryMaxMs: 60_000, maxLoginAttempts: 5, heartbeatMs: 1000, stopLoginWaitMs: 45_000,
            ...options,
        };
        this.reconnectDelay = this.o.reconnectMinMs;
        this.exited = new Promise(resolve => { this.resolveExit = resolve; });
        client.onDisconnect((reason, message) => this.onSessionEnd(reason, message));
    }

    /** Connect to the gateway; resolves when the bridge is finished. */
    run(): Promise<BridgeExit> {
        this.unsubscribeState = this.client.onStateChange(state => this.sendState(state));
        this.heartbeatTimer = setInterval(() => this.heartbeat(), Math.max(50, Math.min(this.o.heartbeatMs, 1000)));
        this.openGateway();
        return this.exited;
    }

    get isRegistered(): boolean {
        return this.registered;
    }

    get isStopping(): boolean {
        return this.stopping;
    }

    // ── gateway ───────────────────────────────────────────────────────────

    private openGateway(): void {
        if (this.ws || this.preventReconnect || this.finished) return;
        let ws: WebSocket;
        try {
            ws = new WebSocket(this.o.gatewayUrl);
        } catch (e) {
            this.log(`gateway ${this.o.gatewayUrl}: ${(e as Error).message}`);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            this.log(`gateway connected (${this.o.gatewayUrl}), registering as '${this.o.username}'`);
            this.rawSend({
                type: 'connected',
                username: this.o.username,
                password: this.o.password,
                clientId: this.o.clientId ?? `${this.o.username}-daoc-${Date.now()}`,
                maxMessageLength: this.o.maxMessageLength,
            });
            // Work queued over the old connection has no one waiting for it (BotOverlay.onConnected).
            this.queue.beginGeneration();
        };
        ws.onmessage = event => {
            let msg: any;
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                this.log('bad gateway frame (not JSON)');
                return;
            }
            this.handleMessage(msg);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            const wasRegistered = this.registered;
            this.registered = false;
            if (this.preventReconnect || this.finished) return;
            this.log(`gateway ${wasRegistered ? 'connection lost' : 'unreachable'}; reconnecting in ${this.reconnectDelay} ms`);
            this.scheduleReconnect();
        };
        ws.onerror = () => {
            // onclose follows
        };
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.preventReconnect || this.finished) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.o.reconnectMaxMs, this.reconnectDelay * 2);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openGateway();
        }, delay);
    }

    private rawSend(msg: unknown): boolean {
        if (this.ws?.readyState !== WebSocket.OPEN) return false;
        try {
            this.ws.send(JSON.stringify(msg));
            return true;
        } catch {
            return false;
        }
    }

    private handleMessage(msg: any): void {
        switch (msg?.type) {
            case 'status':
                if (!this.registered) this.log(`gateway: ${msg.status ?? 'registered'}`);
                this.registered = true;
                this.reconnectDelay = this.o.reconnectMinMs;
                this.sendState(this.client.collectState());
                if (!this.loginStarted && !this.stopping) this.startLogin();
                break;
            case 'action':
                this.onAction(msg.action, msg.actionId || null, msg.actionTimeoutMs);
                break;
            case 'save_and_disconnect':
                this.log(`save_and_disconnect: ${msg.reason || 'session replaced'}`);
                this.preventReconnect = true;
                void this.stop('save_and_disconnect');
                break;
            case 'error':
                this.log(`gateway error: ${msg.error}`);
                break;
        }
    }

    // ── state ─────────────────────────────────────────────────────────────

    private sendState(state: BotWorldState): void {
        this.showChat(state);
        if (!this.registered) return;
        if (this.backoffNote && !state.inGame) {
            state.connection = { ...state.connection, lastError: this.backoffNote };
        }
        if (this.rawSend({ type: 'state', state })) this.lastSentAt = Date.now();
    }

    private heartbeat(): void {
        if (Date.now() - this.lastSentAt >= this.o.heartbeatMs && this.registered) this.sendState(this.client.collectState());
        this.expireActions();
    }

    private showChat(state: BotWorldState): void {
        if (!this.o.showChat) return;
        for (const m of state.gameMessages) {
            if (m.id <= this.lastShownMessageId) continue;
            this.lastShownMessageId = m.id;
            if (isPlayerChat(m.type)) this.log(`[${m.type}] ${m.text}`);
        }
    }

    // ── actions ───────────────────────────────────────────────────────────

    private onAction(action: BotAction, actionId: string | null, actionTimeoutMs?: number): void {
        if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
            if (actionId) this.sendActionResult(actionId, { success: false, message: 'malformed action', phase: 'validation', reason: 'bad_args' });
            return;
        }
        const ttl = typeof actionTimeoutMs === 'number' ? Math.max(0, actionTimeoutMs - 1000) : undefined;
        if (!this.queue.enqueue({ action, actionId }, ttl)) {
            if (actionId) this.sendActionResult(actionId, { success: false, message: 'Action queue is full', phase: 'validation', reason: 'busy' });
            return;
        }
        this.pump();
    }

    private expireActions(): void {
        for (const expired of this.queue.expirePending()) {
            if (expired.actionId) {
                this.sendActionResult(expired.actionId, { success: false, message: `Action expired in queue: ${expired.action.type}`, phase: 'validation', reason: 'queue_expired' });
            }
        }
        const activeExpired = this.queue.expireActive();
        if (activeExpired) {
            if (this.queue.isCurrentGeneration(activeExpired) && activeExpired.actionId) {
                this.sendActionResult(activeExpired.actionId, { success: false, message: `Action expired while active: ${activeExpired.action.type}`, phase: 'completion', reason: 'queue_expired' });
            }
            this.pump();
        }
    }

    private pump(): void {
        this.expireActions();
        if (this.queue.active) return;
        const queued = this.queue.startNext();
        if (!queued) return;
        if (queued.action.type === 'quit') {
            // A quit ends this runner in any phase (also mid-login or during a back-off): see stop().
            this.finishAction(queued, { success: true, message: 'quitting: the character logs out and the client exits', phase: 'dispatch' });
            void this.stop('quit');
            return;
        }
        this.client.execute(queued.action)
            .then(result => this.finishAction(queued, result))
            .catch(e => this.finishAction(queued, { success: false, message: `Error: ${e}`, phase: 'completion', reason: 'execution_error' }));
    }

    private finishAction(entry: QueuedBotAction, result: ActionResult): void {
        if (this.queue.active !== entry) return;
        const publish = this.queue.isCurrentGeneration(entry);
        this.queue.complete(entry);
        if (publish && entry.actionId) this.sendActionResult(entry.actionId, result);
        if (publish) this.sendState(this.client.collectState());
        this.pump();
    }

    private sendActionResult(actionId: string, result: ActionResult): void {
        this.rawSend({ type: 'actionResult', actionId, result });
    }

    // ── DAoC session ──────────────────────────────────────────────────────

    private startLogin(delayMs = 0): void {
        this.loginStarted = true;
        const p = this.loginLoop(delayMs);
        this.loginPromise = p;
        void p.finally(() => { if (this.loginPromise === p) this.loginPromise = null; });
    }

    private async loginLoop(initialDelayMs: number): Promise<void> {
        let attempt = 0;
        let delay = this.o.loginRetryMs;
        if (initialDelayMs > 0 && !(await this.sleep(initialDelayMs))) return;
        while (!this.stopping && !this.finished) {
            attempt++;
            this.log(`logging into DAoC${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
            try {
                await this.client.connect();
                this.backoffNote = null;
                if (this.stopping) return; // stop() quits us once this returns
                this.inWorld = true;
                this.logins++;
                this.log(`in game (phase ${this.client.phase})`);
                this.sendState(this.client.collectState());
                return;
            } catch (e) {
                const err = e as Error;
                const reason = e instanceof SessionError ? e.reason : 'error';
                if (this.stopping) return;
                if (FATAL_LOGIN.has(reason) && !(e instanceof SessionError && e.code === ALREADY_LOGGED_IN)) {
                    this.log(`login failed (${reason}): ${err.message}`);
                    this.finish({ code: 2, reason: `${reason}: ${err.message}` });
                    return;
                }
                let wait: number;
                if (e instanceof SessionError && e.mustBackOff) {
                    wait = this.o.lockoutBackoffMs;
                    this.log(`account is still logging out (0x2C code 0x11); retrying in ${Math.round(wait / 1000)} s`);
                } else {
                    if (!this.o.relogin && attempt >= this.o.maxLoginAttempts) {
                        this.log(`login failed ${attempt} times; last (${reason}): ${err.message}`);
                        this.finish({ code: 1, reason: `${reason}: ${err.message}` });
                        return;
                    }
                    wait = delay;
                    delay = Math.min(this.o.loginRetryMaxMs, delay * 2);
                    this.log(`login failed (${reason}): ${err.message}; retrying in ${Math.round(wait / 1000)} s`);
                }
                this.backoffNote = `${err.message}; retrying login in ${Math.round(wait / 1000)} s`;
                this.sendState(this.client.collectState());
                if (!(await this.sleep(wait))) return;
            }
        }
    }

    /** Resolves true after `ms`, false as soon as the bridge stops. */
    private sleep(ms: number): Promise<boolean> {
        const signal = this.backoff.signal;
        if (signal.aborted) return Promise.resolve(false);
        return new Promise(resolve => {
            const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
            const onAbort = () => { clearTimeout(t); resolve(false); };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    private onSessionEnd(reason: string, message: string): void {
        if (!this.inWorld) return; // failed logins are handled by loginLoop
        this.inWorld = false;
        this.sendState(this.client.collectState());
        if (this.stopping || this.finished) return;
        if (reason === 'quit') {
            this.log('quit (the character logged out); exiting');
            this.preventReconnect = true;
            this.finish({ code: 0, reason: 'quit' });
            return;
        }
        this.log(`DAoC session ended unexpectedly: ${reason} (${message})`);
        if (this.o.relogin) {
            this.log(`logging in again in ${Math.round(this.o.loginRetryMs / 1000)} s`);
            this.startLogin(this.o.loginRetryMs);
            return;
        }
        this.finish({ code: 1, reason: `session ended: ${reason} (${message})` });
    }

    // ── shutdown ──────────────────────────────────────────────────────────

    /** Clean quit (if logged in), close the gateway connection, finish with code 0. */
    async stop(reason = 'stopped'): Promise<BridgeExit> {
        if (this.stopping || this.finished) return this.exited;
        this.stopping = true;
        this.backoff.abort();
        if (this.loginPromise) {
            // Closing mid world-entry would leave the character linkdead; let the login settle first.
            const login = this.loginPromise;
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([login.catch(() => {}), new Promise(r => { timer = setTimeout(r, this.o.stopLoginWaitMs); })]);
            clearTimeout(timer);
        }
        // Mid world entry, region change or an under-way quit, a socket drop would link-death the
        // character (60 s re-login lockout): quit() lets the transition settle first.
        if (QUIT_PHASES.has(this.client.phase)) {
            this.log(`quitting (${reason})`);
            try {
                await this.client.quit();
            } catch (e) {
                this.log(`quit failed: ${(e as Error).message}`);
            }
        } else if (this.client.phase !== 'disconnected') {
            this.client.disconnect();
        }
        this.inWorld = false;
        this.sendState(this.client.collectState());
        this.finish({ code: 0, reason });
        return this.exited;
    }

    private finish(exit: BridgeExit): void {
        if (this.finished) return;
        this.finished = true;
        this.lastExit = exit;
        this.preventReconnect = true;
        this.backoff.abort();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.unsubscribeState?.();
        this.unsubscribeState = null;
        const ws = this.ws;
        this.ws = null;
        this.registered = false;
        try { ws?.close(1000, exit.reason.slice(0, 100)); } catch {}
        this.resolveExit(exit);
    }
}
