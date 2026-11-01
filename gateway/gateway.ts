#!/usr/bin/env bun
// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// Gateway: WebSocket router between headless DAoC clients and SDKs.
//
// Port of rs-sdk server/gateway/gateway.ts with the same envelope and
// semantics (connected/state/actionResult ↔ action, sdk_connect/sdk_action ↔
// sdk_state/sdk_action_result/sdk_error, lastState replay, control/observe,
// last-controller-wins, takeover via save_and_disconnect, 8 s staleness, HTTP
// /status /state /chat /say /dm). No engine coupling, traffic metering, direct
// port, outdated-client lookup or login server: auth is a pluggable hook that
// allows everything by default. Beyond rs-sdk: the browser viewer
// (gateway/viewer/routes.ts) and group views over HTTP (gateway/groups.ts).
//
// Exposure: it listens on 127.0.0.1 unless GATEWAY_HOSTNAME says otherwise,
// refuses browser requests from foreign origins (and, on a loopback bind,
// foreign Host names: DNS rebinding), and sends CORS headers only to loopback
// origins (gateway/security.ts). The CLI entrypoint checks bots/<name>/bot.env
// passwords when GATEWAY_AUTH=botenv, which is the default once
// GATEWAY_HOSTNAME is not a loopback address.

import type {
    BotClientMessage,
    BotStatus,
    BotWorldState,
    GatewayAuthHook,
    SDKConnectionMode,
    SDKMessage,
    SyncToBotMessage,
    SyncToSDKMessage,
    ActionResult,
    BotAction,
} from './types';
import { OBSERVER_ACTIONS } from './types';
import { ChatHistory, isPlayerChat } from '../sdk/chat-history';
import { chunkMessage, DEFAULT_MAX_MESSAGE_LENGTH } from '../sdk/chunking';
import { repeatsLastFanout } from './state-fanout';
import { handleViewerRequest } from './viewer/routes';
import { createGroupStore, type GroupLimits, type GroupStore } from './groups';
import type { GroupBadge } from './group-types';
import { botEnvAuth, checkRequestSource, corsHeadersFor, isJsonRequest, isLoopbackHostname, resolveAuthMode } from './security';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';

/** No state for this long = 'stale' (clients publish several times a second). */
export const STALE_THRESHOLD_MS = 8000;
/**
 * How long a superseded client gets to '&quit' before the gateway force-closes
 * it. DAoC's quit timer is ≥20 s and up to 60 s after combat
 * (GamePlayer.QuitTimer, gameobjects/GamePlayer.cs:685-800), so this is much
 * longer than rs-sdk's 5 s.
 */
export const DEFAULT_TAKEOVER_GRACE_MS = 70_000;
/** Pause between the old client closing and the new one being registered. */
export const DEFAULT_TAKEOVER_SETTLE_MS = 1000;
/** Pacing between HTTP chat chunks; '&say' rejects faster than 500 ms (commands/playercommands/say.cs:47). */
const HTTP_CHUNK_DELAY_MS = 700;
/** A dead session (no client, no SDK, no takeover) is forgotten after this long, with its chat history. */
export const DEFAULT_DEAD_SESSION_RETENTION_MS = 30 * 60_000;
/** Most distinct bot usernames kept; the longest-dead ones go first. */
export const DEFAULT_MAX_BOT_SESSIONS = 500;
/** An action the client never answered (its socket still open) is forgotten after this long. */
const IN_FLIGHT_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_HOSTNAME = '127.0.0.1';

type WS = ServerWebSocket<unknown>;

/** Who is waiting for an action's result. */
type InFlight = { kind: 'sdk'; sessionId: string; at: number } | { kind: 'http'; at: number };

interface BotSession {
    ws: WS | null;
    clientId: string;
    username: string;
    lastState: BotWorldState | null;
    lastStateReceivedAt: number;
    /**
     * Every action sent to this client and not yet answered. The client queues
     * several at once (client/action-queue.ts), so one slot is not enough.
     */
    inFlight: Map<string, InFlight>;
    connectedAt: number;
    /** When ws went null (0 while connected). */
    disconnectedAt: number;
    lastHeartbeat: number;
    maxMessageLength?: number;
    lastFanoutState?: BotWorldState;
}

interface SDKSession {
    ws: WS;
    /** Server-generated; the only lookup key. */
    sessionId: string;
    /** Client-supplied label, logs only. */
    sdkClientId: string;
    targetUsername: string;
    mode: SDKConnectionMode;
}

interface PendingTakeover {
    ws: WS;
    clientId: string;
    username: string;
    timeout: ReturnType<typeof setTimeout>;
    maxMessageLength?: number;
    /**
     * The old client has closed and this one is in the settle pause. The entry
     * stays reserved meanwhile, so a third client arriving now is handled as a
     * takeover instead of registering beside it.
     */
    settling?: boolean;
}

export interface GatewayOptions {
    /** Listen port; 0 picks a free one. Default AGENT_PORT or 7780. */
    port?: number;
    /** Listen address. Default GATEWAY_HOSTNAME or 127.0.0.1; '0.0.0.0' exposes it to the network. */
    hostname?: string;
    auth?: GatewayAuthHook;
    staleThresholdMs?: number;
    takeoverGraceMs?: number;
    takeoverSettleMs?: number;
    /** How long a dead, unwatched session is kept. Default DEFAULT_DEAD_SESSION_RETENTION_MS. */
    deadSessionRetentionMs?: number;
    /** Cap on distinct bot usernames. Default DEFAULT_MAX_BOT_SESSIONS. */
    maxBotSessions?: number;
    /** Silence console logging (tests). */
    quiet?: boolean;
    /**
     * Group views (gateway/groups.ts), on by default: groups/<id>/group.json and
     * bots/<name>/bot.env under each root (default the working directory, then
     * this repo), groupsDir first (default DAOC_GROUPS_DIR). false turns them off.
     */
    groups?: false | { roots?: string[]; groupsDir?: string; now?: () => number; limits?: Partial<GroupLimits> };
}

export interface Gateway {
    server: Server<unknown>;
    port: number;
    /** ws://host:port */
    url: string;
    stop(): Promise<void>;
}

const allowAll: GatewayAuthHook = () => ({ success: true });

export function createGateway(options: GatewayOptions = {}): Gateway {
    const auth = options.auth ?? allowAll;
    const staleThresholdMs = options.staleThresholdMs ?? STALE_THRESHOLD_MS;
    const takeoverGraceMs = options.takeoverGraceMs ?? DEFAULT_TAKEOVER_GRACE_MS;
    const takeoverSettleMs = options.takeoverSettleMs ?? DEFAULT_TAKEOVER_SETTLE_MS;
    const deadSessionRetentionMs = options.deadSessionRetentionMs ?? DEFAULT_DEAD_SESSION_RETENTION_MS;
    const maxBotSessions = options.maxBotSessions ?? DEFAULT_MAX_BOT_SESSIONS;
    const hostname = options.hostname || process.env.GATEWAY_HOSTNAME || DEFAULT_HOSTNAME;
    const requestPolicy = { loopbackBind: isLoopbackHostname(hostname) };
    const log =options.quiet ? (..._args: unknown[]) => {} : (...args: unknown[]) => console.log('[Gateway]', ...args);

    const botSessions = new Map<string, BotSession>();
    const sdkSessions = new Map<string, SDKSession>();
    const wsToType = new Map<WS, { type: 'bot' | 'sdk'; id: string }>();
    const pendingTakeovers = new Map<string, PendingTakeover>();
    const sdkConnecting = new Set<WS>();
    const chatHistories = new Map<string, ChatHistory>();
    const pendingHttpActions = new Map<string, { resolve: (result: ActionResult) => void; timeout: ReturnType<typeof setTimeout> }>();
    const httpSayQueues = new Map<string, Promise<unknown>>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let sdkSessionSeq = 0;
    let httpActionSeq = 0;

    const later = (ms: number, fn: () => void) => {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        timers.add(t);
        return t;
    };

    function chatHistoryFor(username: string): ChatHistory {
        let history = chatHistories.get(username);
        if (!history) {
            history = new ChatHistory();
            chatHistories.set(username, history);
        }
        return history;
    }

    function sessionStatus(session: BotSession | undefined): BotStatus['status'] {
        if (!session || !session.ws) return 'dead';
        if (Date.now() - session.lastStateReceivedAt > staleThresholdMs) return 'stale';
        return 'active';
    }

    function sendToBot(session: BotSession, message: SyncToBotMessage) {
        if (!session.ws) return;
        try {
            session.ws.send(JSON.stringify(message));
        } catch (error) {
            log(`[${session.username}] Failed to send to bot:`, error);
        }
    }

    function sendToSDK(session: SDKSession, message: SyncToSDKMessage) {
        try {
            session.ws.send(JSON.stringify(message));
        } catch (error) {
            log(`[${session.sdkClientId}] Failed to send to SDK:`, error);
        }
    }

    function sessionForSocket(ws: WS): SDKSession | null {
        const info = wsToType.get(ws);
        if (!info || info.type !== 'sdk') return null;
        const session = sdkSessions.get(info.id);
        return session && session.ws === ws ? session : null;
    }

    function sdksForBot(username: string): SDKSession[] {
        return [...sdkSessions.values()].filter(s => s.targetUsername === username);
    }

    /** The SDK sessions a result or error for this action goes to: its sender if still here, else every SDK on the bot. */
    function recipientsFor(username: string, owner: InFlight | undefined): SDKSession[] {
        if (owner?.kind === 'sdk') {
            const sender = sdkSessions.get(owner.sessionId);
            if (sender) return [sender];
        }
        return sdksForBot(username);
    }

    /** A waiting client lost its place to a newer one: it quits without reconnecting (client/bridge.ts save_and_disconnect). */
    function supersedeWaiting(pending: PendingTakeover) {
        try { pending.ws.send(JSON.stringify({ type: 'save_and_disconnect', reason: 'A newer client registered as this bot' } satisfies SyncToBotMessage)); } catch {}
        try { pending.ws.close(); } catch {}
    }

    /** Fail every action this client still owed, at once instead of at each caller's timeout. */
    function failInFlight(session: BotSession, message: string) {
        const lost = [...session.inFlight];
        session.inFlight.clear();
        for (const [actionId, owner] of lost) {
            if (owner.kind === 'http') {
                const pendingHttp = pendingHttpActions.get(actionId);
                if (!pendingHttp) continue;
                pendingHttpActions.delete(actionId);
                clearTimeout(pendingHttp.timeout);
                pendingHttp.resolve({ success: false, message, reason: 'disconnected', phase: 'dispatch' });
                continue;
            }
            for (const sdk of recipientsFor(session.username, owner)) {
                sendToSDK(sdk, { type: 'sdk_error', actionId, error: message });
            }
        }
    }

    function forgetSession(username: string) {
        botSessions.delete(username);
        chatHistories.delete(username);
    }

    /** A session nobody uses: no client, no takeover under way, no SDK attached. */
    function isIdleDead(session: BotSession): boolean {
        return !session.ws && !pendingTakeovers.has(session.username) && sdksForBot(session.username).length === 0;
    }

    /** Drop the longest-dead idle sessions until at most `limit` usernames remain. */
    function evictDeadSessions(limit: number) {
        if (botSessions.size <= limit) return;
        const idle = [...botSessions.values()].filter(isIdleDead).sort((a, b) => a.disconnectedAt - b.disconnectedAt);
        for (const session of idle) {
            if (botSessions.size <= limit) break;
            forgetSession(session.username);
        }
    }

    function sweep() {
        const now = Date.now();
        for (const session of [...botSessions.values()]) {
            if (isIdleDead(session) && now - session.disconnectedAt > deadSessionRetentionMs) {
                log(`Forgetting dead session ${session.username} (disconnected ${Math.round((now - session.disconnectedAt) / 1000)}s ago)`);
                forgetSession(session.username);
                continue;
            }
            for (const [actionId, owner] of session.inFlight) {
                if (now - owner.at > IN_FLIGHT_MAX_AGE_MS) session.inFlight.delete(actionId);
            }
        }
    }
    const sweepTimer = setInterval(sweep, Math.max(10, Math.min(60_000, deadSessionRetentionMs)));
    sweepTimer.unref?.(); // the server keeps the process alive, not the sweep

    // Reads the session maps only; it never sends on a socket (gateway/groups.ts).
    let groups: GroupStore | null = null;
    if (options.groups !== false) {
        const opts = options.groups ?? {};
        try {
            groups = createGroupStore({
                roots: opts.roots ?? [...new Set([process.cwd(), join(import.meta.dir, '..')])],
                groupsDir: opts.groupsDir ?? process.env.DAOC_GROUPS_DIR,
                sessions: botSessions,
                sdkSessions,
                sessionStatus,
                auth,
                log,
                now: opts.now,
                limits: opts.limits,
            });
        } catch (error) {
            log('Group views are off:', error);
        }
    }

    function completeBotConnection(ws: WS, clientId: string, username: string, preserved?: BotSession | null, maxMessageLength?: number) {
        const now = Date.now();
        const session: BotSession = {
            ws,
            clientId,
            username,
            lastState: preserved?.lastState ?? null,
            lastStateReceivedAt: preserved?.lastStateReceivedAt ?? 0,
            // The same socket re-sending 'connected' keeps what it still owes.
            inFlight: preserved && preserved.ws === ws ? preserved.inFlight : new Map(),
            connectedAt: now,
            disconnectedAt: 0,
            lastHeartbeat: now,
            maxMessageLength: maxMessageLength ?? preserved?.maxMessageLength,
        };
        const isNew = !botSessions.has(username);
        botSessions.set(username, session);
        if (isNew) evictDeadSessions(maxBotSessions);
        wsToType.set(ws, { type: 'bot', id: username });
        log(`Bot connected: ${clientId} (${username})`);
        sendToBot(session, { type: 'status', status: 'Connected to gateway' });
        for (const sdk of sdksForBot(username)) {
            sendToSDK(sdk, { type: 'sdk_connected', success: true, mode: sdk.mode, otherControllers: 0, maxMessageLength: session.maxMessageLength });
        }
    }

    async function handleBotMessage(ws: WS, message: BotClientMessage) {
        if (message.type === 'connected') {
            const username = message.username || 'default';
            const clientId = (message.clientId || `bot-${Date.now()}`).slice(0, 64);
            const authResult = await auth({ kind: 'bot', username, password: message.password || '' });
            if (ws.readyState !== 1) return;
            if (!authResult.success) {
                log(`Bot auth failed: ${clientId} -> ${username} (${authResult.error})`);
                try {
                    ws.send(JSON.stringify({ type: 'error', error: `Authentication failed: ${authResult.error}` }));
                    ws.close();
                } catch {}
                return;
            }
            const maxMessageLength = typeof message.maxMessageLength === 'number' && message.maxMessageLength > 0
                ? message.maxMessageLength : undefined;

            const existing = botSessions.get(username);
            const previous = pendingTakeovers.get(username);
            if (previous?.settling) {
                // The old client has gone and `previous` is in the settle pause.
                // Registering this one now would leave two clients logging into
                // one account once the pause ends; the newer one takes the slot.
                if (previous.ws !== ws) {
                    log(`Takeover for ${username}: ${clientId} supersedes ${previous.clientId}, which was about to register`);
                    supersedeWaiting(previous);
                }
                pendingTakeovers.set(username, { ...previous, ws, clientId, maxMessageLength });
                return;
            }
            if (existing && existing.ws && existing.ws !== ws) {
                // Graceful takeover: the old client quits; the new one waits.
                log(`Takeover for ${username}: asking ${existing.clientId} to save_and_disconnect; ${clientId} waits`);
                sendToBot(existing, { type: 'save_and_disconnect', reason: 'New session connecting' });
                if (previous) {
                    // A newer client supersedes an older waiting one. The same
                    // socket re-sending 'connected' must not close itself.
                    clearTimeout(previous.timeout);
                    timers.delete(previous.timeout);
                    if (previous.ws !== ws) supersedeWaiting(previous);
                }
                const oldWs = existing.ws;
                const timeout = later(takeoverGraceMs, () => {
                    log(`Takeover grace (${takeoverGraceMs}ms) expired for ${username}, force closing old client`);
                    try { oldWs.close(); } catch {}
                });
                pendingTakeovers.set(username, { ws, clientId, username, timeout, maxMessageLength });
                return;
            }
            completeBotConnection(ws, clientId, username, existing, maxMessageLength);
            return;
        }

        const info = wsToType.get(ws);
        if (!info || info.type !== 'bot') return;
        const session = botSessions.get(info.id);
        if (!session || session.ws !== ws) return;
        session.lastHeartbeat = Date.now();

        if (message.type === 'actionResult' && message.result) {
            // A result without an id can only be matched when exactly one action is outstanding.
            const actionId = message.actionId
                || (session.inFlight.size === 1 ? [...session.inFlight.keys()][0] : undefined);
            const owner = actionId ? session.inFlight.get(actionId) : undefined;
            if (actionId) session.inFlight.delete(actionId);
            if (actionId) {
                const pendingHttp = pendingHttpActions.get(actionId);
                if (pendingHttp) {
                    pendingHttpActions.delete(actionId);
                    clearTimeout(pendingHttp.timeout);
                    pendingHttp.resolve(message.result);
                    return;
                }
            }
            if (owner?.kind === 'http') return; // the HTTP caller already timed out
            for (const sdk of recipientsFor(session.username, owner)) {
                sendToSDK(sdk, { type: 'sdk_action_result', actionId, result: message.result });
            }
            return;
        }

        if (message.type === 'state' && message.state && typeof message.state === 'object') {
            const state = message.state;
            session.lastState = state;
            session.lastStateReceivedAt = Date.now();
            try { groups?.onState(session.username, state); } catch {}
            if (Array.isArray(state.gameMessages) && state.gameMessages.length) {
                chatHistoryFor(session.username).record(state.gameMessages);
            }
            const subscribers = sdksForBot(session.username);
            if (subscribers.length > 0 && !repeatsLastFanout(session.lastFanoutState ?? null, state)) {
                session.lastFanoutState = state;
                for (const sdk of subscribers) {
                    sendToSDK(sdk, { type: 'sdk_state', state, stateReceivedAt: session.lastStateReceivedAt });
                }
            }
        }
    }

    async function handleSDKMessage(ws: WS, message: SDKMessage) {
        if (message.type === 'sdk_connect') {
            const sdkClientId = String(message.clientId || 'sdk').slice(0, 64);
            const targetUsername = typeof message.username === 'string' ? message.username : '';
            const mode: SDKConnectionMode = message.mode === 'observe' ? 'observe' : 'control';

            if (wsToType.has(ws) || sdkConnecting.has(ws)) {
                ws.send(JSON.stringify({ type: 'sdk_error', error: 'Already connected on this socket' }));
                return;
            }
            if (!targetUsername) {
                ws.send(JSON.stringify({ type: 'sdk_error', error: 'sdk_connect requires a username' }));
                ws.close();
                return;
            }

            sdkConnecting.add(ws);
            let authResult: { success: boolean; error?: string };
            try {
                authResult = await auth({ kind: 'sdk', username: targetUsername, password: message.password || '' });
            } finally {
                sdkConnecting.delete(ws);
            }
            // The socket may have closed while auth was in flight; registering it
            // now would leak a session and could pre-empt a live controller.
            if (ws.readyState !== 1) return;
            if (!authResult.success) {
                ws.send(JSON.stringify({ type: 'sdk_error', error: `Authentication failed: ${authResult.error}` }));
                ws.close();
                return;
            }

            const sessionId = `sdks-${++sdkSessionSeq}-${Math.random().toString(36).slice(2, 8)}`;
            const session: SDKSession = { ws, sessionId, sdkClientId, targetUsername, mode };
            sdkSessions.set(sessionId, session);
            wsToType.set(ws, { type: 'sdk', id: sessionId });

            if (mode === 'control') {
                for (const old of sdksForBot(targetUsername)) {
                    if (old.mode !== 'control' || old.sessionId === sessionId) continue;
                    log(`Pre-empting controller ${old.sdkClientId} for ${targetUsername} (replaced by ${sdkClientId})`);
                    sendToSDK(old, { type: 'sdk_error', error: 'Disconnected: another controller connected' });
                    sdkSessions.delete(old.sessionId);
                    wsToType.delete(old.ws);
                    try { old.ws.close(); } catch {}
                }
            }

            log(`SDK connected: ${sdkClientId} -> ${targetUsername} (mode: ${mode})`);
            const bot = botSessions.get(targetUsername);
            sendToSDK(session, { type: 'sdk_connected', success: true, mode, otherControllers: 0, maxMessageLength: bot?.maxMessageLength });
            if (bot?.lastState) {
                sendToSDK(session, { type: 'sdk_state', state: bot.lastState, stateReceivedAt: bot.lastStateReceivedAt });
            }
            return;
        }

        if (message.type === 'sdk_action') {
            const session = sessionForSocket(ws);
            if (!session) return;
            const actionType = message.action && typeof message.action === 'object' ? message.action.type : undefined;
            if (session.mode === 'observe' && !OBSERVER_ACTIONS.has(String(actionType))) {
                sendToSDK(session, {
                    type: 'sdk_error',
                    actionId: message.actionId,
                    error: `Observe mode can only send 'say' or 'send' actions (got '${actionType}')`,
                });
                return;
            }
            if (message.username && message.username !== session.targetUsername) {
                log(`IDOR blocked: SDK ${session.sdkClientId} for "${session.targetUsername}" tried to target "${message.username}"`);
            }
            const bot = botSessions.get(session.targetUsername);
            if (!bot || !bot.ws) {
                sendToSDK(session, { type: 'sdk_error', actionId: message.actionId, error: 'Bot not connected' });
                return;
            }
            if (message.actionId) bot.inFlight.set(message.actionId, { kind: 'sdk', sessionId: session.sessionId, at: Date.now() });
            sendToBot(bot,{ type: 'action', action: message.action, actionId: message.actionId, actionTimeoutMs: message.actionTimeoutMs });
        }
    }

    function handleClose(ws: WS) {
        sdkConnecting.delete(ws);
        const info = wsToType.get(ws);
        if (!info) {
            // A client waiting on a takeover that gave up.
            for (const [username, pending] of pendingTakeovers) {
                if (pending.ws === ws) {
                    clearTimeout(pending.timeout);
                    timers.delete(pending.timeout);
                    pendingTakeovers.delete(username);
                    // The old client is already gone, so SDKs were told nothing yet.
                    if (pending.settling && !botSessions.get(username)?.ws) {
                        for (const sdk of sdksForBot(username)) sendToSDK(sdk, { type: 'sdk_error', error: 'Bot disconnected' });
                    }
                }
            }
            return;
        }
        wsToType.delete(ws);

        if (info.type === 'bot') {
            const session = botSessions.get(info.id);
            if (!session || session.ws !== ws) return;
            log(`Bot disconnected: ${session.clientId} (${session.username})`);
            session.ws = null;
            session.disconnectedAt = Date.now();

            // Nothing in flight can be answered any more (also on takeover,
            // where no 'Bot disconnected' goes out): fail all of it now instead
            // of at each caller's timeout.
            failInFlight(session, 'Bot client disconnected before answering');

            const username = session.username;
            const pending = pendingTakeovers.get(username);
            if (pending && !pending.settling) {
                clearTimeout(pending.timeout);
                timers.delete(pending.timeout);
                // Stay reserved through the pause: see PendingTakeover.settling.
                pending.settling = true;
                later(takeoverSettleMs, () => {
                    const current = pendingTakeovers.get(username);
                    if (!current?.settling) return;
                    pendingTakeovers.delete(username);
                    if (current.ws.readyState === 1) {
                        completeBotConnection(current.ws, current.clientId, username, botSessions.get(username) ?? session, current.maxMessageLength);
                    }
                });
                return;
            }
            for (const sdk of sdksForBot(session.username)) {
                sendToSDK(sdk, { type: 'sdk_error', error: 'Bot disconnected' });
            }
        } else {
            const session = sdkSessions.get(info.id);
            if (session && session.ws === ws) {
                log(`SDK disconnected: ${session.sessionId} (${session.sdkClientId})`);
                sdkSessions.delete(info.id);
            }
        }
    }

    function rejectFrame(ws: WS, reason: string) {
        log(`Rejecting frame: ${reason}`);
        try { ws.send(JSON.stringify({ type: 'error', error: `Invalid message: ${reason}` })); } catch {}
        try { ws.close(); } catch {}
    }

    async function handleMessage(ws: WS, data: string) {
        let parsed: any;
        try {
            parsed = JSON.parse(data);
        } catch {
            rejectFrame(ws, 'malformed JSON');
            return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            rejectFrame(ws, 'expected a JSON object');
            return;
        }
        if (typeof parsed.type !== 'string') {
            rejectFrame(ws, 'missing or non-string "type"');
            return;
        }
        const info = wsToType.get(ws);
        if (info) {
            if (info.type === 'bot') await handleBotMessage(ws, parsed);
            else await handleSDKMessage(ws, parsed);
            return;
        }
        if (parsed.type.startsWith('sdk_')) {
            await handleSDKMessage(ws, parsed);
        } else if (parsed.type === 'connected' || parsed.type === 'state' || parsed.type === 'actionResult') {
            await handleBotMessage(ws, parsed);
        }
    }

    // ── HTTP helpers ────────────────────────────────────────────────────────

    async function authenticateHttp(req: Request, url: URL, username: string, bodyPassword?: unknown) {
        const header = req.headers.get('authorization');
        const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        const password = typeof bodyPassword === 'string' && bodyPassword !== ''
            ? bodyPassword
            : (bearer ?? url.searchParams.get('password') ?? '');
        return auth({ kind: 'http', username, password });
    }

    /** Dispatch one chat chunk and wait (bounded) for its result. Never rejects. */
    function dispatchHttpChatNow(bot: BotSession, action: BotAction, timeoutMs: number): Promise<ActionResult> {
        const actionId = `http-${++httpActionSeq}-${Math.random().toString(36).slice(2, 8)}`;
        if (!bot.ws) return Promise.resolve({ success: false, message: 'Bot client disconnected before answering', reason: 'disconnected', phase: 'dispatch' });
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                pendingHttpActions.delete(actionId);
                bot.inFlight.delete(actionId);
                resolve({ success: false, message: `Chat timed out after ${timeoutMs}ms (client did not answer)`, reason: 'timeout', phase: 'dispatch' });
            }, timeoutMs);
            pendingHttpActions.set(actionId, { resolve, timeout });
            bot.inFlight.set(actionId, { kind: 'http', at: Date.now() });
            sendToBot(bot,{ type: 'action', action, actionId, actionTimeoutMs: timeoutMs });
        });
    }

    /** One outstanding HTTP chat per bot, so un-echoed results can't be misattributed. */
    function dispatchHttpChat(bot: BotSession, action: BotAction, timeoutMs: number): Promise<ActionResult> {
        const key = bot.username;
        const prev = httpSayQueues.get(key) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(() => dispatchHttpChatNow(bot, action, timeoutMs));
        httpSayQueues.set(key, next);
        next.finally(() => { if (httpSayQueues.get(key) === next) httpSayQueues.delete(key); });
        return next;
    }

    async function relayChat(username: string, text: string, timeoutMs: number, to?: string) {
        const bot = botSessions.get(username)!;
        const chunks = chunkMessage(text, bot.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH);
        const results: (ActionResult & { chunk: string })[] = [];
        let ok = true;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const action: BotAction = to
                ? { type: 'send', to, text: chunk, reason: 'HTTP chat' }
                : { type: 'say', text: chunk, reason: 'HTTP chat' };
            const result = await dispatchHttpChat(bot, action, timeoutMs);
            results.push({ chunk, ...result });
            if (!result.success) {
                ok = false;
                for (let j = i + 1; j < chunks.length; j++) {
                    results.push({ chunk: chunks[j]!, success: false, message: 'Skipped: previous chunk failed' });
                }
                break;
            }
            if (i < chunks.length - 1) await new Promise(resolve => setTimeout(resolve, HTTP_CHUNK_DELAY_MS));
        }
        return { ok, results };
    }

    // CORS headers are added per request in fetch(), for loopback origins only (security.ts).
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
    const routeUser = (pathname: string, route: string): string | null => {
        const match = pathname.match(new RegExp(`^/${route}/(.+)$`));
        if (!match?.[1]) return null;
        try { return decodeURIComponent(match[1]); } catch { return match[1]; }
    };

    function botStatusBody(username: string): BotStatus & { maxMessageLength: number | null; group: GroupBadge | null } {
        const bot = botSessions.get(username);
        const connected = !!bot?.ws;
        const p = connected ? bot?.lastState?.player : null;
        return {
            status: sessionStatus(bot),
            inGame: connected ? (bot?.lastState?.inGame ?? false) : false,
            stateAge: bot?.lastStateReceivedAt ? Date.now() - bot.lastStateReceivedAt : null,
            maxMessageLength: bot?.maxMessageLength ?? null,
            controllers: sdksForBot(username).filter(s => s.mode === 'control').map(s => s.sessionId),
            observers: sdksForBot(username).filter(s => s.mode === 'observe').map(s => s.sessionId),
            player: p ? { name: p.name, regionId: p.regionId, x: p.x, y: p.y, z: p.z } : null,
            group: groups?.badge(username) ?? null,
        };
    }

    async function chatRequest(req: Request, url: URL, username: string, dm: boolean): Promise<Response> {
        // text/plain would be a CORS "simple" request that a browser sends with no preflight.
        if (!isJsonRequest(req)) return json({ error: 'Content-Type must be application/json' }, 415);
        let body: any;
        try {
            body = await req.json();
        } catch {
            return json({ error: dm ? 'Body must be JSON: {"to": "...", "text": "..."}' : 'Body must be JSON: {"text": "..."}' }, 400);
        }
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        const to = typeof body?.to === 'string' ? body.to.trim() : '';
        if (!text) return json({ error: 'Missing "text"' }, 400);
        if (dm && (!to || to.length > 24 || /\s/.test(to))) {
            return json({ error: 'Missing or invalid "to" (target player name)' }, 400);
        }
        const authResult = await authenticateHttp(req, url, username, body?.password);
        if (!authResult.success) return json({ error: `Authentication failed: ${authResult.error}` }, 401);
        const bot = botSessions.get(username);
        if (!bot || !bot.ws) {
            return json({ error: `Bot not connected - no client is logged in as '${username}', so there is nothing to relay chat through` }, 409);
        }
        const timeoutRaw = Number(body?.timeoutMs);
        const perChunkTimeout = Math.min(Math.max(Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 10000, 2000), 30000);
        const { ok, results } = await relayChat(username, text, perChunkTimeout, dm ? to : undefined);
        return json(dm ? { ok, to, results } : { ok, results }, ok ? 200 : 502);
    }

    async function route(req: Request, url: URL, srv: Server<unknown>): Promise<Response> {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

        const viewer = await handleViewerRequest(req, url, { botSessions, sdkSessions, sessionStatus, auth, groupOf: u => groups?.badge(u) ?? null });
        if (viewer) return viewer;
        const group = await groups?.handle(req, url);
        if (group) return group;

        const statusUser = routeUser(url.pathname, 'status');
        if (statusUser !== null) return json(botStatusBody(statusUser));

        const chatUser = routeUser(url.pathname, 'chat');
        if (chatUser !== null && req.method === 'GET') {
            const authResult = await authenticateHttp(req, url, chatUser);
            if (!authResult.success) return json({ error: `Authentication failed: ${authResult.error}` }, 401);
            const limitRaw = parseInt(url.searchParams.get('limit') || '20', 10);
            const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
            const system = url.searchParams.get('system');
            const includeSystem = system === '1' || system === 'true';
            const all = (chatHistories.get(chatUser)?.all() ?? []).filter(m => includeSystem || isPlayerChat(m.type));
            return json({ messages: limit > 0 ? all.slice(-limit) : all, botStatus: sessionStatus(botSessions.get(chatUser)) });
        }

        const stateUser = routeUser(url.pathname, 'state');
        if (stateUser !== null && req.method === 'GET') {
            const authResult = await authenticateHttp(req, url, stateUser);
            if (!authResult.success) return json({ error: `Authentication failed: ${authResult.error}` }, 401);
            const bot = botSessions.get(stateUser);
            if (!bot || !bot.lastState) {
                return json({
                    error: `No game state for '${stateUser}' - no client has published state as that bot`,
                    botStatus: sessionStatus(bot),
                    state: null,
                }, 404);
            }
            return json({ state: bot.lastState, stateAge: Date.now() - bot.lastStateReceivedAt, botStatus: sessionStatus(bot) });
        }

        const dmUser = routeUser(url.pathname, 'dm');
        if (dmUser !== null && req.method === 'POST') return chatRequest(req, url, dmUser, true);
        const sayUser = routeUser(url.pathname, 'say');
        if (sayUser !== null && req.method === 'POST') return chatRequest(req, url, sayUser, false);

        if (url.pathname === '/' || url.pathname === '/status') {
            const bots: Record<string, unknown> = {};
            for (const [username, session] of botSessions) {
                const connected = session.ws !== null;
                bots[username] = {
                    status: sessionStatus(session),
                    inGame: connected ? (session.lastState?.inGame ?? false) : false,
                    clientId: session.clientId,
                    tick: session.lastState?.tick ?? 0,
                    player: connected ? (session.lastState?.player?.name ?? null) : null,
                };
            }
            const sdks: Record<string, unknown> = {};
            for (const [id, session] of sdkSessions) {
                sdks[id] = { clientId: session.sdkClientId, targetUsername: session.targetUsername, mode: session.mode };
            }
            return json({ status: 'running', service: 'daoc-sdk gateway', bots, sdks, pendingTakeovers: [...pendingTakeovers.keys()] });
        }

        return new Response([
            `daoc-sdk gateway (port ${srv.port})`,
            '',
            'GET  /status              all sessions',
            'GET  /status/:username    per-bot status',
            'GET  /state/:username     last world state',
            'GET  /chat/:username      recent chat (?limit=20&system=1)',
            'POST /say/:username       {"text": "..."}',
            'POST /dm/:username        {"to": "...", "text": "..."}',
            'GET  /viewer              browser viewer (GET /bots, /zones/:regionId)',
            'GET  /groups              groups/<id>/group.json groups, their members and runs',
            'GET  /groups/:id/live     one group: members, what they see, the run (leader password)',
            'POST /groups/:id/publish  a group run\'s snapshot (sdk/group/publish.ts)',
            'POST /groups/:id/control  {"kind": "windDown", "runId": "..."} (leader bot.env password)',
            'GET  /groups/:id/runs     run history, report files, campaign log (/runs/:stamp?part=json|md|log)',
            'GET  /viewer/group/:id    browser group view',
            '',
        ].join('\n'), { headers: { 'Content-Type': 'text/plain' } });
    }

    const server = Bun.serve({
        port: options.port ?? parseInt(process.env.AGENT_PORT || '7780'),
        hostname,
        async fetch(req, srv) {
            const url = new URL(req.url);
            // Before anything else, the upgrade included: browsers let any page
            // open a WebSocket or send a simple POST to localhost (security.ts).
            const refused = checkRequestSource(req, requestPolicy);
            if (refused) {
                log(`Refused ${req.method} ${url.pathname}: ${refused}`);
                return new Response(`Forbidden: ${refused}\n`, { status: 403, headers: { 'Content-Type': 'text/plain' } });
            }
            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                if (srv.upgrade(req, { data: undefined })) return undefined;
                return new Response('WebSocket upgrade failed', { status: 400 });
            }
            const response = await route(req, url, srv);
            for (const [name, value] of Object.entries(corsHeadersFor(req))) response.headers.set(name, value);
            return response;
        },
        websocket: {
            backpressureLimit: 4 * 1024 * 1024,
            closeOnBackpressureLimit: true,
            maxPayloadLength: 16 * 1024 * 1024,
            message(ws, message) {
                handleMessage(ws, typeof message === 'string' ? message : message.toString()).catch(error => {
                    log('Unhandled error while handling message:', error);
                    try { ws.close(); } catch {}
                });
            },
            close(ws) {
                try {
                    handleClose(ws);
                } catch (error) {
                    log('Unhandled error while closing socket:', error);
                }
            },
        },
    });

    const port = server.port ?? 0;
    return {
        server,
        port,
        url: `ws://localhost:${port}`,
        async stop() {
            clearInterval(sweepTimer);
            groups?.stop();
            for (const t of timers) clearTimeout(t);
            timers.clear();
            for (const pending of pendingHttpActions.values()) clearTimeout(pending.timeout);
            await server.stop(true);
        },
    };
}

if (import.meta.main) {
    process.on('unhandledRejection', reason => {
        console.error('[Gateway] Unhandled rejection (ignored, gateway stays up):', reason);
    });
    process.on('uncaughtException', error => {
        console.error('[Gateway] Uncaught exception (ignored, gateway stays up):', error);
    });
    const grace = parseInt(process.env.GATEWAY_TAKEOVER_GRACE_MS || '', 10);
    const hostname = process.env.GATEWAY_HOSTNAME || DEFAULT_HOSTNAME;
    const authMode = resolveAuthMode(process.env, hostname);
    // bots/<name>/bot.env under the working directory first, then this repo (like the viewer and BotManager).
    const repoRoot = join(import.meta.dir, '..');
    const gateway = createGateway({
        hostname,
        takeoverGraceMs: Number.isFinite(grace) ? grace : undefined,
        auth: authMode === 'botenv' ? botEnvAuth([...new Set([process.cwd(), repoRoot])]) : undefined,
    });
    console.log(`[Gateway] Running at http://localhost:${gateway.port} (ws://localhost:${gateway.port}), listening on ${hostname}`);
    if (!isLoopbackHostname(hostname)) console.log(`[Gateway] GATEWAY_HOSTNAME=${hostname}: reachable from other hosts`);
    console.log(authMode === 'botenv'
        ? '[Gateway] Authentication: bots/<name>/bot.env PASSWORD (GATEWAY_AUTH=botenv)'
        : '[Gateway] Authentication: none, loopback only (GATEWAY_AUTH=botenv to require bot.env passwords)');
}
