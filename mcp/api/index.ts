// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// Bot connection manager for the MCP server (port of rs-sdk mcp/api/index.ts).
//
// DAoC has no browser client to auto-launch, so the manager owns the client
// lifecycle: when no client publishes fresh state for a bot it spawns
// `bun client/runner.ts <name>` (detached, log at bots/<name>/client.log) and
// waits for it. It also starts a local gateway when none answers.

import { BotSDK, REPO_ROOT, deriveGatewayUrl, ensureGateway, findBotEnv, gatewayHttpBase, launchClientProcess, parseEnvFile } from '../../sdk/index';
import { BotActions } from '../../sdk/actions';
import type { ActionResult, BotStatus } from '../../sdk/types';
import { withExecutionDeadline, throwIfExecutionAborted, executionWait } from '../../sdk/execution-context';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BotConnection {
    /** Folder name as supplied at first connection; lookup is case-insensitive. */
    name?: string;
    sdk: BotSDK;
    bot: BotActions;
    username: string;
    connected: boolean;
    unsubscribeConnectionState?: () => void;
    /**
     * Highest GameMessage.id already shown to the agent, so repeated
     * execute_code calls only render new chat and system messages.
     */
    lastShownMessageId: number;
}

export interface BotManagerOptions {
    repoRoot?: string;
    /** Max wait for a (spawned) client to publish fresh state. Default 120 s (covers a 60 s linkdead back-off). */
    clientStartTimeoutMs?: number;
    /** State younger than this counts as a live client. Default 3 s. */
    freshStateMs?: number;
    /** Start a local gateway when none answers (default true). */
    autoStartGateway?: boolean;
    /** Spawn client/runner.ts when no client is attached (default true). */
    autoLaunchClient?: boolean;
    /** disconnect(): how long a spawned client gets to quit and exit before it is killed. Default 90 s. */
    clientStopTimeoutMs?: number;
}

/** The gateway connection is up but no client publishes live state; `connection` is still usable. */
export class ClientNotLiveError extends Error {
    constructor(message: string, readonly connection: BotConnection) {
        super(message);
        this.name = 'ClientNotLiveError';
    }
}

/** Diagnostics straight to stderr, outside any execution's captured console. */
function log(message: string): void {
    process.stderr.write(`${message}
`);
}

function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

function tailFile(path: string, lines = 15): string {
    try {
        return readFileSync(path, 'utf-8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
    } catch {
        return '';
    }
}

export class BotManager {
    private connections = new Map<string, BotConnection>();
    private clients = new Map<string, ChildProcess>();
    private readonly repoRoot: string;
    private readonly clientStartTimeoutMs: number;
    private readonly freshStateMs: number;
    private readonly autoStartGateway: boolean;
    private readonly autoLaunchClient: boolean;
    private readonly clientStopTimeoutMs: number;

    constructor(options: BotManagerOptions = {}) {
        this.repoRoot = options.repoRoot ?? REPO_ROOT;
        this.clientStartTimeoutMs = options.clientStartTimeoutMs ?? 120_000;
        this.freshStateMs = options.freshStateMs ?? 3000;
        this.autoStartGateway = options.autoStartGateway ?? true;
        this.autoLaunchClient = options.autoLaunchClient ?? true;
        this.clientStopTimeoutMs = options.clientStopTimeoutMs ?? 90_000;
    }

    /** Connect to a bot by folder name, reading bots/<name>/bot.env, launching gateway/client as needed. */
    async connect(name: string): Promise<BotConnection> {
        const key = name.toLowerCase();
        const existing = this.connections.get(key);
        if (existing) {
            if (!existing.connected) {
                // The gateway may be what went away (e.g. a gateway this manager spawned died).
                if (this.autoStartGateway) await ensureGateway(existing.sdk.config.gatewayUrl, { repoRoot: this.repoRoot }).catch(() => {});
                await this.connectWithRetry(existing.sdk);
                existing.connected = true;
            }
            await this.ensureLiveClientOrThrow(name, existing);
            return existing;
        }

        const envPath = findBotEnv(name, this.repoRoot);
        if (!envPath) throw new Error(`Bot "${name}" not found (no bots/${name}/bot.env). Create it first with: bun bots/create-bot.ts ${name}`);
        const env = parseEnvFile(await readFile(envPath, 'utf-8'));
        const username = env.BOT_USERNAME || name;
        const password = env.PASSWORD;
        if (!password) throw new Error(`No PASSWORD in ${envPath}`);
        const gatewayUrl = process.env.GATEWAY_URL || deriveGatewayUrl(env.GATEWAY_URL);
        const showChat = env.SHOW_CHAT?.toLowerCase() !== 'false';

        log(`[MCP] Connecting bot "${name}" (username ${username}, gateway ${gatewayUrl})`);
        if (this.autoStartGateway && await ensureGateway(gatewayUrl, { repoRoot: this.repoRoot })) {
            log(`[MCP] Started a local gateway for ${gatewayUrl} (log: ${join(this.repoRoot, 'gateway.log')})`);
        }

        const sdk = new BotSDK({
            botUsername: username,
            password,
            gatewayUrl,
            connectionMode: 'control',
            autoReconnect: true,
            autoLaunchClient: false, // this manager spawns clients by folder name
            readyTimeout: 0,
            showChat,
        });
        const bot = new BotActions(sdk);
        await this.connectWithRetry(sdk);

        const connection: BotConnection = { name, sdk, bot, username, connected: true, lastShownMessageId: -1 };
        connection.unsubscribeConnectionState = sdk.onConnectionStateChange(state => {
            const was = connection.connected;
            connection.connected = state === 'connected';
            if (was && !connection.connected) log(`[MCP] Bot "${name}" connection lost (${state}), will auto-reconnect...`);
            else if (!was && connection.connected) log(`[MCP] Bot "${name}" reconnected`);
        });
        this.connections.set(key, connection);

        await this.ensureLiveClientOrThrow(name, connection);
        return connection;
    }

    private async ensureLiveClientOrThrow(name: string, connection: BotConnection): Promise<void> {
        try {
            await this.ensureLiveClient(name, connection.sdk);
        } catch (error) {
            throwIfExecutionAborted();
            // The connection stays registered: callers may still run against
            // stale state to diagnose.
            throw new ClientNotLiveError(error instanceof Error ? error.message : String(error), connection);
        }
    }

    /**
     * Make sure a client is publishing fresh state for this bot, spawning
     * client/runner.ts if not, then wait for an in-game state frame newer
     * than the gateway's cached one.
     */
    private async ensureLiveClient(name: string, sdk: BotSDK): Promise<void> {
        const status = await this.status(sdk);
        const fresh = status.status === 'active' && status.stateAge !== null && status.stateAge < this.freshStateMs;
        const key = name.toLowerCase();
        let child = this.clients.get(key);
        if (child && hasExited(child)) child = undefined;
        if (fresh && status.inGame) return;
        const logPath = join(this.repoRoot, 'bots', name, 'client.log');
        // A live client that is still logging in (ours or not) gets waited for; only a missing one is spawned.
        if (!child && !fresh) {
            if (!this.autoLaunchClient) throw new Error(`No client is attached to "${name}" (status ${status.status}). Start one: bun client/runner.ts ${name}`);
            if (!existsSync(join(this.repoRoot, 'client', 'runner.ts'))) {
                throw new Error(`No client is attached to "${name}" and client/runner.ts does not exist yet, so none can be started.`);
            }
            console.log(`[MCP] No live client for "${name}" (status ${status.status}); spawning bun client/runner.ts ${name} (log: ${logPath})`);
            child = launchClientProcess(name, { repoRoot: this.repoRoot, logPath, env: { GATEWAY_URL: sdk.config.gatewayUrl } });
            this.clients.set(key, child);
            child.once('exit', () => { if (this.clients.get(key) === child) this.clients.delete(key); });
        }

        const baselineTick = sdk.getState()?.tick;
        const baselineAt = sdk.getStateReceivedAt();
        const spawned = child;
        try {
            // A starting client publishes not-in-game frames while it logs in,
            // creates the character or backs off a 60 s linkdead lockout
            // (critic.md 2.9), so wait for a fresh frame that is in game.
            await executionWait<void>((resolve, reject) => {
                const check = () => {
                    const s = sdk.getState();
                    const fresh = s && (baselineTick === undefined || s.tick !== baselineTick || sdk.getStateReceivedAt() > baselineAt);
                    if (fresh && s.inGame && s.player) resolve();
                };
                const unsubscribe = sdk.onStateUpdate(check);
                const timer = setTimeout(() => {
                    const s = sdk.getState();
                    const last = s && sdk.getStateReceivedAt() > baselineAt
                        ? ` (last state: phase ${s.connection?.phase ?? 'unknown'}${s.connection?.lastError ? `, lastError ${s.connection.lastError}` : ''})`
                        : ' (no state frame arrived)';
                    reject(new Error(`not in game after ${this.clientStartTimeoutMs / 1000}s${last}`));
                }, this.clientStartTimeoutMs);
                const onExit = (code: number | null) => reject(new Error(`client exited with code ${code}`));
                spawned?.once('exit', onExit);
                check();
                return () => { unsubscribe(); clearTimeout(timer); spawned?.off('exit', onExit); };
            });
        } catch (error) {
            throwIfExecutionAborted();
            const tail = tailFile(logPath);
            throw new Error(`Client for "${name}" did not publish state (${error instanceof Error ? error.message : error}). Log ${logPath}:\n${tail || '(empty)'}`);
        }
    }

    private async status(sdk: BotSDK): Promise<BotStatus> {
        try {
            const res = await fetch(`${gatewayHttpBase(sdk.config.gatewayUrl)}/status/${encodeURIComponent(sdk.config.botUsername)}`, { signal: AbortSignal.timeout(3000) });
            return await res.json() as BotStatus;
        } catch {
            return { status: 'unknown', inGame: false, stateAge: null, controllers: [], observers: [], player: null };
        }
    }

    private async connectWithRetry(sdk: BotSDK, maxAttempts = 3, timeoutMs = 30000): Promise<void> {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await withExecutionDeadline(timeoutMs, () => sdk.connect(), () => { throw new Error(`Connection timed out after ${timeoutMs / 1000}s`); });
                return;
            } catch (err) {
                await sdk.disconnect().catch(() => {});
                throwIfExecutionAborted();
                const msg = err instanceof Error ? err.message : String(err);
                if (attempt >= maxAttempts) throw new Error(`Failed to connect after ${maxAttempts} attempts. Last error: ${msg}`);
                const delay = attempt * 2000;
                log(`[MCP] Connection attempt ${attempt}/${maxAttempts} failed: ${msg}. Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Disconnect the SDK from the gateway. A client this manager spawned is
     * stopped cleanly: it gets a quit action (the runner quits the character
     * and exits 0), re-sent (restarting a local gateway if needed) until it
     * gets through, and the process is only killed if it has not exited after
     * clientStopTimeoutMs. Other clients keep running.
     */
    async disconnect(name: string, opts: { stopClient?: boolean } = {}): Promise<{ stoppedClient: boolean; killed: boolean }> {
        const key = name.toLowerCase();
        const connection = this.connections.get(key);
        const child = this.clients.get(key);
        if (!connection && !child) throw new Error(`Bot "${name}" is not connected`);
        let stoppedClient = false;
        let killed = false;
        if (child && !hasExited(child) && opts.stopClient !== false) {
            log(`[MCP] Stopping the client for "${name}" (pid ${child.pid}): quit, then wait for it to exit`);
            let exitedYet = false;
            const exited = new Promise<void>(resolve => {
                if (hasExited(child)) resolve();
                else child.once('exit', () => resolve());
            }).then(() => { exitedYet = true; });
            const deadline = Date.now() + this.clientStopTimeoutMs;
            let quitSent = false;
            let lastError = 'no gateway connection to ask it';
            // Killing an in-game client link-deaths the character (60 s re-login lockout), so keep trying to get
            // the quit action through: the gateway may have restarted, or the runner may not be registered yet.
            while (!exitedYet && Date.now() < deadline) {
                if (!quitSent && connection) {
                    if (!connection.connected) {
                        try {
                            if (this.autoStartGateway) await ensureGateway(connection.sdk.config.gatewayUrl, { repoRoot: this.repoRoot });
                            await this.connectWithRetry(connection.sdk, 1, 10_000);
                            connection.connected = true;
                        } catch (error) {
                            lastError = `gateway unreachable: ${error instanceof Error ? error.message : error}`;
                        }
                    }
                    if (connection.connected) {
                        const quit = await Promise.race([
                            connection.sdk.sendQuit().catch((e: unknown): ActionResult => ({ success: false, message: String(e), phase: 'dispatch' })),
                            Bun.sleep(10_000).then(() => null),
                        ]);
                        quitSent = !!quit?.success;
                        if (!quitSent) lastError = `quit action failed: ${quit?.message ?? 'no answer within 10 s'}`;
                    }
                    if (!connection.connected || !quitSent) log(`[MCP] Could not ask the client for "${name}" to quit yet (${lastError}); retrying`);
                } else if (!connection) {
                    break; // nothing to send the quit through
                }
                const wait = Math.max(0, Math.min(quitSent ? deadline - Date.now() : 3000, deadline - Date.now()));
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, wait); })]);
                clearTimeout(timer);
            }
            if (!exitedYet) {
                log(`[MCP] Client for "${name}" did not exit${quitSent ? ` within ${this.clientStopTimeoutMs / 1000}s` : ` (${lastError})`}; killing it`);
                killed = true;
                try { child.kill(); } catch {}
                await Promise.race([exited, Bun.sleep(5000)]);
            }
            stoppedClient = true;
            if (this.clients.get(key) === child) this.clients.delete(key);
        }
        if (connection) {
            connection.unsubscribeConnectionState?.();
            await connection.sdk.disconnect();
            connection.connected = false;
            this.connections.delete(key);
        }
        return { stoppedClient, killed };
    }

    get(name: string): BotConnection | undefined {
        return this.connections.get(name.toLowerCase());
    }

    list(): Array<{ name: string; username: string; connected: boolean; clientPid: number | null }> {
        return [...this.connections.entries()].map(([key, conn]) => {
            const child = this.clients.get(key);
            return {
                name: conn.name ?? key,
                username: conn.username,
                connected: conn.connected,
                clientPid: child && !hasExited(child) ? child.pid ?? null : null,
            };
        });
    }

    has(name: string): boolean {
        return this.connections.has(name.toLowerCase());
    }
}

export const botManager = new BotManager();
