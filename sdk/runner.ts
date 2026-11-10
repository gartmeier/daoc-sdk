// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// Script runner: zero-boilerplate script execution (port of rs-sdk sdk/runner.ts).
// Finds bot.env next to the script, or bots/<arg>/bot.env, or uses --env-file.

import { BotSDK, deriveGatewayUrl, parseEnvFile } from './index';
import { BotActions } from './actions';
import { executionContext, abortable } from './execution-context';
import { formatWorldStateSummary, type SummaryBaseline } from './formatter';
import type { BotWorldState } from './types';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/** How long an aborted script may take to run its cleanup before the runner moves on. */
const SCRIPT_SETTLE_MS = 2000;

/** Thrown when the gateway connection drops during a script. */
export class BotDisconnectedError extends Error {
    constructor(message: string = 'Bot client disconnected') {
        super(message);
        this.name = 'BotDisconnectedError';
    }
}

/**
 * Thrown when another control connection took the bot over during a script (newest
 * control connection wins). The game client is still in game; only this script lost control.
 */
export class BotPreemptedError extends BotDisconnectedError {
    constructor(message: string = 'Pre-empted by another controller (newest control connection wins); the game client is still running') {
        super(message);
        this.name = 'BotPreemptedError';
    }
}

export interface ScriptContext {
    bot: BotActions;
    sdk: BotSDK;
    /** JSON from MCP execute_code `args` (or RunOptions.args); otherwise undefined. */
    args?: any;
}

export type ScriptFunction = (ctx: ScriptContext) => Promise<any>;

export interface RunOptions {
    /** Overall timeout in ms (default: none). */
    timeout?: number;
    /** Existing connection to use instead of connecting from process.env. */
    connection?: { bot: BotActions; sdk: BotSDK };
    /** Connect if not connected (default: true). */
    autoConnect?: boolean;
    /** Disconnect when the script finishes (default: true when the runner opened the connection). */
    disconnectAfter?: boolean;
    /** Print a short state summary afterwards (default: true). */
    printState?: boolean;
    /** 'error' (default) aborts on disconnect, 'wait' waits for reconnect, 'ignore' lets actions fail. */
    onDisconnect?: 'error' | 'wait' | 'ignore';
    /** Reconnect budget for onDisconnect 'wait' (default 60000). */
    reconnectTimeout?: number;
    /** Passed to the script as ctx.args. */
    args?: any;
}

export interface RunResult {
    success: boolean;
    result?: any;
    error?: Error;
    duration: number;
    finalState: BotWorldState | null;
}

interface BotConnection {
    sdk: BotSDK;
    bot: BotActions;
    username: string;
}

const connections = new Map<string, BotConnection>();

function loadEnvFile(envPath: string): void {
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(envPath, 'utf-8')))) {
        process.env[key] = value;
    }
}

/**
 * Load bot credentials. Priority:
 * 1. Already in process.env (bun --env-file)
 * 2. bot.env next to the script file
 * 3. First non-flag arg: bun script.ts <botname> → bots/<botname>/bot.env
 */
function loadEnvFromArgs(): void {
    if (process.env.BOT_USERNAME && process.env.PASSWORD) return;
    const scriptPath = process.argv[1];
    if (scriptPath) {
        const siblingEnv = join(dirname(resolve(scriptPath)), 'bot.env');
        if (existsSync(siblingEnv)) {
            loadEnvFile(siblingEnv);
            return;
        }
    }
    const botName = process.argv.slice(2).find(arg => !arg.startsWith('-'));
    if (!botName) return;
    const envPath = join(process.cwd(), 'bots', botName, 'bot.env');
    if (!existsSync(envPath)) throw new Error(`Bot "${botName}" not found at ${envPath}`);
    loadEnvFile(envPath);
}

/** Folder name of the bot (bots/<name>/), for the client hint. */
function botFolderName(username: string): string {
    const scriptPath = process.argv[1];
    if (scriptPath) {
        const dir = dirname(resolve(scriptPath));
        if (existsSync(join(dir, 'bot.env'))) return dir.split(/[\\/]/).pop() || username;
    }
    return username;
}

async function getOrCreateConnection(): Promise<BotConnection> {
    loadEnvFromArgs();
    const username = process.env.BOT_USERNAME;
    const password = process.env.PASSWORD;
    const showChat = process.env.SHOW_CHAT?.toLowerCase() !== 'false';
    const usage = 'Run with: bun --env-file=bots/{name}/bot.env script.ts\nOr: bun script.ts {botname}';
    if (!username) throw new Error(`BOT_USERNAME not set. ${usage}`);
    if (!password) throw new Error(`PASSWORD not set. ${usage}`);

    const existing = connections.get(username);
    if (existing && existing.sdk.isConnected()) return existing;

    console.error(`[Runner] Connecting to bot "${username}"...`);
    const sdk = new BotSDK({
        botUsername: username,
        password,
        gatewayUrl: deriveGatewayUrl(),
        connectionMode: 'control',
        autoReconnect: true,
        // Scripts attach to an already-running client; they never start one.
        autoLaunchClient: false,
        showChat,
    });
    const bot = new BotActions(sdk);

    const CONNECT_TIMEOUT_MS = 60_000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS);
    });
    try {
        await Promise.race([sdk.connect(), timeoutPromise]);
        await requireLiveClient(sdk, username);
    } catch (error) {
        // Never registered, so nothing else would tear down its reconnect timers.
        await sdk.disconnect().catch(() => {});
        throw error;
    } finally {
        clearTimeout(timeoutHandle);
    }

    console.error(`[Runner] Connected to bot "${username}"`);
    const connection: BotConnection = { sdk, bot, username };
    connections.set(username, connection);
    return connection;
}

/** How long to wait for a fresh state frame before deciding no client is attached. */
const LIVE_CLIENT_WAIT_MS = 10_000;

/**
 * Throw unless a client is publishing state for this bot right now. connect()
 * succeeds against the gateway alone, and the gateway replays its cached
 * lastState, so wait for `tick` to advance rather than trusting any state.
 */
async function requireLiveClient(sdk: BotSDK, username: string): Promise<void> {
    const cached = sdk.getState();
    try {
        await sdk.waitForCondition(s => !cached || s.tick !== cached.tick, LIVE_CLIENT_WAIT_MS);
        return;
    } catch {}
    const why = cached
        ? `its last state is ${Math.round(sdk.getStateAge() / 1000)}s old and no new tick arrived in ${LIVE_CLIENT_WAIT_MS / 1000}s`
        : 'no game state was received';
    throw new Error(
        `No game client is attached to "${username}" (${why}).\n` +
        `Scripts drive a running client; they don't start one. Start the headless client, leave it running, then rerun:\n` +
        `  bun client/runner.ts ${botFolderName(username)}\n` +
        `MCP execute_code starts it automatically.`,
    );
}

function baselineOf(state: BotWorldState | null): SummaryBaseline | undefined {
    const p = state?.player;
    if (!p) return undefined;
    return { level: p.level, experience: p.experience, realmPoints: p.realmPoints, totalCopper: p.money.totalCopper };
}

/**
 * Run a script with zero boilerplate.
 *
 * @example
 * // bun bots/mybot/script.ts   (finds bots/mybot/bot.env)
 * import { runScript } from '../../sdk/runner';
 * await runScript(async ({ bot, sdk }) => {
 *     return sdk.getPosition();
 * }, { timeout: 60_000 });
 */
export async function runScript(script: ScriptFunction, options: RunOptions = {}): Promise<RunResult> {
    const { timeout, connection, autoConnect = true, printState = true, onDisconnect = 'error', reconnectTimeout = 60000 } = options;
    const disconnectAfter = options.disconnectAfter ?? !connection;
    const startTime = Date.now();

    let bot: BotActions;
    let sdk: BotSDK;
    let managedConnection = false;

    if (connection) {
        bot = connection.bot;
        sdk = connection.sdk;
    } else {
        try {
            if (autoConnect) {
                const conn = await getOrCreateConnection();
                bot = conn.bot;
                sdk = conn.sdk;
            } else {
                loadEnvFromArgs();
                const username = process.env.BOT_USERNAME;
                if (!username) throw new Error('BOT_USERNAME not set. Run with: bun --env-file=bots/{name}/bot.env script.ts\nOr: bun script.ts {botname}');
                const existing = connections.get(username);
                if (!existing || !existing.sdk.isConnected()) throw new Error(`Bot "${username}" is not connected and autoConnect is false`);
                bot = existing.bot;
                sdk = existing.sdk;
            }
            managedConnection = true;
        } catch (error: any) {
            console.error(`[Runner] Failed to connect: ${error?.message ?? error}`);
            process.exitCode = 1;
            return { success: false, error, duration: Date.now() - startTime, finalState: null };
        }
    }

    const ctx: ScriptContext = { bot, sdk, args: options.args };
    const baseline = baselineOf(sdk.getState());

    const executionController = new AbortController();
    // The script itself (not the abortable wrapper): after an abort, its
    // cleanup (e.g. walkTo's stop) must reach the client before we disconnect.
    let rawScript: Promise<unknown> = Promise.resolve();
    const settleScript = () => Promise.race([rawScript.catch(() => {}), Bun.sleep(SCRIPT_SETTLE_MS)]);
    let signalReceived = false;
    const signalCleanup = (signal: string, exitCode: number) => {
        if (signalReceived) process.exit(exitCode);
        signalReceived = true;
        executionController.abort(new Error(`Script interrupted by ${signal}`));
        console.error(`[Runner] Received ${signal} - disconnecting and exiting...`);
        setTimeout(() => process.exit(exitCode), 5000);
        settleScript().then(() => sdk.disconnect()).finally(() => process.exit(exitCode));
    };
    const onSigterm = () => signalCleanup('SIGTERM', 143);
    const onSigint = () => signalCleanup('SIGINT', 130);
    const onSighup = () => signalCleanup('SIGHUP', 129);
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
    process.on('SIGHUP', onSighup);

    let result: any;
    let error: Error | undefined;
    let unsubscribeConnection: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
        const disconnectReject = (err: Error) => executionController.abort(err);
        const scriptPromise = executionContext.run({ signal: executionController.signal }, () => {
            rawScript = script(ctx);
            return abortable(rawScript);
        });
        if (timeout && Number.isFinite(timeout)) timeoutId = setTimeout(() => executionController.abort(new Error(`Script timeout after ${timeout}ms`)), timeout);

        if (onDisconnect !== 'ignore') {
            unsubscribeConnection = sdk.onConnectionStateChange(async state => {
                if (state !== 'disconnected' && state !== 'reconnecting') return;
                // Reconnect is off after a takeover, so 'wait' would only wait out its budget.
                if (sdk.wasPreempted?.()) {
                    console.error('[Runner] Another controller took over - aborting script');
                    disconnectReject(new BotPreemptedError());
                    return;
                }
                if (onDisconnect === 'error') {
                    console.error('[Runner] Gateway connection lost - aborting script');
                    disconnectReject(new BotDisconnectedError('Bot client disconnected during script execution'));
                } else {
                    console.error(`[Runner] Gateway connection lost - waiting for reconnection (timeout: ${reconnectTimeout}ms)...`);
                    try {
                        await sdk.waitForConnection(reconnectTimeout);
                        console.error('[Runner] Reconnected - resuming script');
                    } catch {
                        disconnectReject(new BotDisconnectedError('Bot client failed to reconnect within timeout'));
                    }
                }
            });
        }
        result = await scriptPromise;
    } catch (e: any) {
        error = e;
    } finally {
        if (!executionController.signal.aborted) executionController.abort(error ?? new Error('Script finished'));
        if (timeoutId) clearTimeout(timeoutId);
        unsubscribeConnection?.();
        process.off('SIGTERM', onSigterm);
        process.off('SIGINT', onSigint);
        process.off('SIGHUP', onSighup);
    }

    if (error) await settleScript();

    const finalState = sdk.getState();
    const duration = Date.now() - startTime;

    if (result !== undefined && !error) {
        console.log('');
        console.log('── Result ──');
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result));
    }
    if (error) {
        console.log('');
        console.log(`── Error ── ${error.name}: ${error.message}`);
        for (const frame of (error.stack ?? '').split('\n').slice(1, 5)) console.log(frame);
        if (managedConnection) process.exitCode = 1;
    }
    if (printState && finalState) {
        console.log('');
        console.log('── State ──');
        console.log(formatWorldStateSummary(finalState, sdk.getStateAge(), { baseline }));
    }

    if (disconnectAfter && managedConnection) {
        const username = sdk.config.botUsername;
        console.error(`[Runner] Disconnecting bot "${username}"...`);
        let disconnectTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([sdk.disconnect(), new Promise(resolve => { disconnectTimeout = setTimeout(resolve, 10000); })]);
        } finally {
            clearTimeout(disconnectTimeout);
            connections.delete(username);
        }
    }

    return { success: !error, result: error ? undefined : result, error, duration, finalState };
}
