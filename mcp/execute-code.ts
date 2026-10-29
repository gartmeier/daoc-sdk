// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// execute_code: run agent TypeScript against one bot (port of rs-sdk mcp/execute-code.ts).
//
// One execution per bot (a new call supersedes the running one), a tracked
// proxy around bot/sdk that records in-flight calls and parks them once
// cancelled, Bun.Transpiler for inline code, per-execution console capture,
// and a structured ExecuteCodeResult.

import { resolve } from 'path';
import type { BotConnection } from './api/index';
import { ClientNotLiveError } from './api/index';
import { ConsoleCapture, formatLogArgument, installExecutionConsoleCapture } from './console-capture';
import { executionContext, abortable, throwIfExecutionAborted } from '../sdk/execution-context';
import { formatWorldState, summarizeWorldState, type WorldDetail, type WorldSummary } from '../sdk/formatter';
import { redactCredentials } from '../sdk/redact';
import { EquipmentSlot } from '../sdk/types';

export type ExecutionErrorKind = 'exception' | 'timeout' | 'superseded' | 'cancelled' | 'not_connected' | 'invalid_input' | 'unserializable_result';
export const EXECUTION_ERROR_KINDS: ExecutionErrorKind[] = ['exception', 'timeout', 'superseded', 'cancelled', 'not_connected', 'invalid_input', 'unserializable_result'];

/** Why an execution stopped early; carried as the abort reason so the result can say so. */
export class ExecutionStopped extends Error {
    constructor(readonly kind: ExecutionErrorKind, message: string) { super(message); }
}

/** execute_code's structuredContent. Every key is always present. */
export interface ExecuteCodeResult {
    ok: boolean;
    /** The code's return value as JSON (credentials redacted), or null. */
    result: unknown;
    logs: string[];
    error: { kind: ExecutionErrorKind; message: string; activeActions: string[] } | null;
    elapsedMs: number;
    world: WorldSummary | null;
}

export type WorldOption = 'none' | WorldDetail;
export interface ExecuteOptions {
    /** JSON exposed to the code as `args` (ctx.args for a script). */
    args?: unknown;
    world?: WorldOption;
    /** How long a stopped run's own cleanup (BotActions finally blocks) may take before the result is returned. Default EXECUTION_SETTLE_MS. */
    settleMs?: number;
}

const REPO_ROOT = resolve(import.meta.dir, '..');
/**
 * A stopped execution's code keeps running its finally blocks after the abort:
 * killNpc awaits sendAttack(false) and then sends a stop (sdk/actions.ts
 * killNpc finally). Wait this long for that before the result is built and
 * before the next call for the bot starts, as sdk/runner.ts does (SCRIPT_SETTLE_MS).
 */
export const EXECUTION_SETTLE_MS = 2000;

/** One execution per bot: a new call cancels the running one and starts once it has unwound. */
export class BotExecutions {
    private current = new Map<string, { controller: AbortController; done: Promise<unknown> }>();

    async run<T>(name: string, signal: AbortSignal | undefined, task: (controller: AbortController) => Promise<T>): Promise<T> {
        const key = name.toLowerCase();
        const previous = this.current.get(key);
        previous?.controller.abort(new ExecutionStopped('superseded', 'Superseded by a newer call for this bot'));
        const controller = new AbortController();
        const onClientAbort = () => controller.abort(new ExecutionStopped('cancelled', signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? 'Cancelled by client')));
        signal?.addEventListener('abort', onClientAbort, { once: true });
        if (signal?.aborted) onClientAbort();
        const done = (async () => {
            // The old run releases the bot before the new one touches it: its task
            // resolves only after the stopped code's cleanup settled (EXECUTION_SETTLE_MS).
            await previous?.done;
            controller.signal.throwIfAborted();
            return task(controller);
        })();
        const entry = { controller, done: done.catch(() => {}) };
        this.current.set(key, entry);
        try {
            return await done;
        } finally {
            signal?.removeEventListener('abort', onClientAbort);
            if (this.current.get(key) === entry) this.current.delete(key);
        }
    }
}

export const botExecutions = new BotExecutions();
export type Manager = { get(name: string): BotConnection | undefined; connect(name: string): Promise<BotConnection> };

/** Records which bot/sdk calls are in flight; once cancelled, calls park instead of throwing. */
function tracked<T extends object>(object: T, label: string, active: Map<symbol, string>, signal: AbortSignal): T {
    return new Proxy(object, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
                // A throw here would let a catch-all loop in cancelled code spin and starve the server.
                if (signal.aborted) return new Promise(() => {});
                const token = Symbol();
                active.set(token, `${label}.${String(prop)}`);
                try {
                    const result = value.apply(target, args);
                    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => active.delete(token));
                    active.delete(token);
                    return result;
                } catch (error) { active.delete(token); throw error; }
            };
        },
    });
}

export function redactValue(value: unknown): unknown {
    if (typeof value === 'string') return redactCredentials(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) =>
            [key, /^(password|token|secret|api[_-]?key)$/i.test(key) ? '[REDACTED]' : redactValue(item)]));
    }
    return value;
}

/** Load a script module: `export default async ({ bot, sdk, args }) => ...`. Reloaded when the file changes. */
async function loadScript(path: string): Promise<(ctx: { bot: unknown; sdk: unknown; args: unknown }) => unknown> {
    const absolute = resolve(REPO_ROOT, path);
    const file = Bun.file(absolute);
    if (!(await file.exists())) throw new ExecutionStopped('invalid_input', `Script not found: ${absolute}`);
    const source = await file.text();
    // Importing a plain runScript() file would open a second controller connection for the bot.
    if (/\brunScript\s*\(/.test(source) && !/import\.meta\.main/.test(source)) {
        throw new ExecutionStopped('invalid_input', `${path} calls runScript() on import. Export the function instead: \`export default main; if (import.meta.main) runScript(main);\``);
    }
    const module = await import(`${absolute}?v=${file.lastModified}-${file.size}`);
    if (typeof module.default !== 'function') {
        throw new ExecutionStopped('invalid_input', `${path} has no default-exported function. Use \`export default async ({ bot, sdk, args }) => { ... }\`.`);
    }
    return module.default;
}

/** Compile an inline code body into `async (bot, sdk, args, EquipmentSlot) => ...`. */
export function compileInline(source: string): (bot: unknown, sdk: unknown, args: unknown, equipmentSlot: unknown) => Promise<unknown> {
    // The inner block lets code redeclare `args` (or bot/sdk) without a parameter clash.
    const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(
        `const __daocExec = async (bot, sdk, args, EquipmentSlot) => {{\n${source}\n}};`,
    );
    return new Function(`${compiled}\nreturn __daocExec;`)();
}

export async function executeCode(
    manager: Manager,
    botName: string,
    source: string | { script: string },
    timeoutMs: number,
    clientSignal?: AbortSignal,
    executions = botExecutions,
    options: ExecuteOptions = {},
) {
    installExecutionConsoleCapture();
    const started = Date.now();
    const world = options.world ?? 'brief';
    try {
        return await executions.run(botName, clientSignal, async controller => {
            const logs = new ConsoleCapture();
            const active = new Map<symbol, string>();
            const record = (level: 'log' | 'warn' | 'error', args: unknown[]) => {
                logs.push((level === 'log' ? '' : `[${level}] `) + args.map(formatLogArgument).join(' '));
            };
            let connection: BotConnection | undefined;
            let connected = false;
            let result: unknown;
            let failure: unknown;
            let failed = false;
            let interruptedActions: string[] = [];
            const rememberActions = () => { interruptedActions = [...active.values()]; };
            controller.signal.addEventListener('abort', rememberActions, { once: true });
            // The user timeout starts once the bot is ready: spawning a client and logging it in (up to
            // BotManager's clientStartTimeoutMs, 120 s by default) does not count against it.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const startTimer = () => {
                timer = setTimeout(() => controller.abort(new ExecutionStopped('timeout', `Code execution timed out after ${timeoutMs / 60_000} minute(s)`)), timeoutMs);
            };

            const work = async () => {
                const connecting = Symbol();
                active.set(connecting, 'Connecting / waiting for a live client');
                try {
                    try {
                        connection = await manager.connect(botName);
                    } catch (error) {
                        if (!(error instanceof ClientNotLiveError)) throw error;
                        throwIfExecutionAborted();
                        connection = error.connection;
                        // Still run: diagnosing a dead client is exactly when you need execute_code.
                        record('warn', [`No live client: ${error.message}\nRunning anyway; actions will fail or not take effect.`]);
                    }
                    connected = true;
                    const sdk = connection.sdk;
                    try {
                        if (sdk.getStateAge() > 10_000) await sdk.waitForStateChange(15_000);
                        if (!sdk.getState()?.inGame) await sdk.waitForReady(15_000);
                    } catch (error) {
                        throwIfExecutionAborted();
                        record('warn', [`No fresh in-game state (${error instanceof Error ? error.message : error}); running anyway, actions may not take effect.`]);
                    }
                } finally { active.delete(connecting); }
                throwIfExecutionAborted();
                startTimer();

                const bot = tracked(connection.bot, 'bot', active, controller.signal);
                const sdk = tracked(connection.sdk, 'sdk', active, controller.signal);
                if (typeof source !== 'string') return (await loadScript(source.script))({ bot, sdk, args: options.args });
                return compileInline(source)(bot, sdk, options.args, EquipmentSlot);
            };

            // The raw promise outlives the abort: abortable() rejects at once while
            // the code's finally blocks (BotActions cleanup) still dispatch.
            let raw: Promise<unknown> | undefined;
            try {
                result = await executionContext.run({ signal: controller.signal, log: record }, () => abortable(raw = work()));
            } catch (error) {
                failure = error;
                failed = true;
                if (interruptedActions.length === 0) interruptedActions = [...active.values()];
            } finally {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', rememberActions);
            }
            const reason = controller.signal.aborted ? controller.signal.reason : undefined;
            if (reason !== undefined && raw) {
                // Bounded: cancelled code that calls bot/sdk again parks forever (tracked()).
                let settleTimer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    raw.then(() => {}, () => {}),
                    new Promise<void>(resolve => { settleTimer = setTimeout(resolve, options.settleMs ?? EXECUTION_SETTLE_MS); }),
                ]);
                clearTimeout(settleTimer);
            }
            // Detached continuations inherit this scope and must not dispatch after it ends.
            if (!controller.signal.aborted) controller.abort(new Error('Execution finished'));

            let error: ExecuteCodeResult['error'] = null;
            if (failed) {
                const kind = reason instanceof ExecutionStopped ? reason.kind
                    : failure instanceof ExecutionStopped ? failure.kind
                        : connected ? 'exception' : 'not_connected';
                error = { kind, message: redactCredentials(failure instanceof Error ? failure.message : formatLogArgument(failure)), activeActions: interruptedActions };
            }

            let value: unknown = null;
            if (!failed && result !== undefined) {
                try { value = redactValue(JSON.parse(JSON.stringify(result) ?? 'null')); }
                catch (serializeError) {
                    failed = true;
                    failure = serializeError;
                    error = { kind: 'unserializable_result', message: formatLogArgument(serializeError), activeActions: [] };
                }
            }

            const parts: string[] = [];
            if (logs.length) parts.push('── Console ──', ...logs.lines());
            if (failed && error?.kind === 'unserializable_result') {
                parts.push('', '── Error ──', error.message);
            } else if (failed) {
                const errorText = failure instanceof Error
                    ? formatLogArgument(failure).split('\n').slice(0, 7).join('\n')
                    : formatLogArgument(failure);
                parts.push('', '── Error ──', errorText,
                    `Elapsed: ${Date.now() - started}ms`,
                    `Active action: ${interruptedActions.join(', ') || 'User code'}`);
            } else if (result !== undefined) {
                parts.push('', '── Result ──', JSON.stringify(value, null, 2));
            }

            let worldSummary: WorldSummary | null = null;
            const state = connection?.sdk.getState();
            if (connection && state && world !== 'none') {
                const ids = state.gameMessages?.map(m => m.id) ?? [];
                // Client restarted (ids began again): show everything once more.
                if (ids.length && ids.every(id => id < connection!.lastShownMessageId)) connection.lastShownMessageId = -1;
                const sinceMessageId = connection.lastShownMessageId;
                const stateAge = connection.sdk.getStateAge();
                worldSummary = redactValue(summarizeWorldState(state, stateAge, { sinceMessageId, detail: world })) as WorldSummary;
                parts.push('', '── World State ──', redactCredentials(formatWorldState(state, stateAge, { sinceMessageId, brief: world === 'brief' })));
                if (ids.length) connection.lastShownMessageId = Math.max(connection.lastShownMessageId, ...ids);
            }
            if (typeof source === 'string' && source.length > 2000) {
                parts.push('', '── Tip ──', `For long or reused code, save it as a module under bots/${botName}/ (\`export default async ({ bot, sdk, args }) => ...\`) and pass it as \`script\`.`);
            }

            const structured: ExecuteCodeResult = { ok: !failed, result: value, logs: logs.lines(), error, elapsedMs: Date.now() - started, world: worldSummary };
            return response(parts.join('\n').trim() || '(no output)', structured);
        });
    } catch (error) {
        // Superseded or cancelled before it started.
        if (error instanceof ExecutionStopped) return executionError(error.kind, error.message, started);
        return executionError('exception', formatLogArgument(error), started);
    }
}

/** A failed execute_code result that never ran any code. */
export function executionError(kind: ExecutionErrorKind, message: string, started = Date.now()) {
    return response(`Error: ${message}`, { ok: false, result: null, logs: [], error: { kind, message, activeActions: [] }, elapsedMs: Date.now() - started, world: null });
}

function response(text: string, structured: ExecuteCodeResult) {
    return {
        content: [{ type: 'text' as const, text }],
        structuredContent: structured as unknown as Record<string, unknown>,
        ...(structured.ok ? {} : { isError: true }),
    };
}

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const arr = (items: object) => ({ type: 'array', items });
const obj = (properties: Record<string, object>, description?: string) =>
    ({ type: 'object', properties, required: Object.keys(properties), ...(description ? { description } : {}) });
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const capped = (item: object) => obj({ total: num, items: arr(item) }, '`total` counts everything; `items` is capped by the world option (nearest first).');

/** JSON Schema for ExecuteCodeResult; keep in step with summarizeWorldState (tested). */
export const EXECUTE_CODE_OUTPUT_SCHEMA = obj({
    ok: bool,
    result: { description: 'The JSON value the code returned, or null.' },
    logs: arr(str),
    error: nullable(obj({ kind: { type: 'string', enum: EXECUTION_ERROR_KINDS }, message: str, activeActions: arr(str) })),
    elapsedMs: num,
    world: nullable(obj({
        tick: num,
        inGame: bool,
        phase: str,
        stateAgeMs: nullable(num),
        player: nullable(obj({
            name: str, level: num, realm: str, className: str, raceName: str,
            regionId: num, zoneId: num, zoneName: str, x: num, y: num, z: num, heading: num,
            health: num, maxHealth: num, mana: num, maxMana: num, endurance: num, maxEndurance: num,
            experience: num, levelPermill: num, realmPoints: num, totalCopper: num,
            isDead: bool, isSitting: bool, inCombat: bool, attacking: bool, moving: bool, targetObjectId: nullable(num),
        })),
        target: nullable(obj({ objectId: num, kind: str, name: str, level: nullable(num), healthPercent: nullable(num), distance: num })),
        inventory: obj({ freeSlots: num, items: arr(obj({ slot: num, name: str, count: num, level: num })) }),
        equipment: arr(obj({ slot: num, name: str })),
        effects: arr(obj({ name: str, remainingSeconds: num, isNegative: bool })),
        group: arr(obj({ name: str, level: num, className: str, healthPercent: num, isDead: bool })),
        npcDialog: nullable(obj({ npcObjectId: nullable(num), npcName: nullable(str), text: str, keywords: arr(str) }, 'Answer with sdk.sendWhisper(npcObjectId, keyword).')),
        dialog: nullable(obj({ code: num, type: num, text: str }, 'Answer with sdk.sendRespondDialog(true|false).')),
        merchant: nullable(obj({
            merchantObjectId: nullable(num),
            items: capped(obj({ page: num, slot: num, name: str, level: num, price: num })),
        }, 'Buy with sdk.sendBuy(page, slot, count).')),
        nearby: obj({
            npcs: capped(obj({
                objectId: num, name: str, level: num, realm: str, healthPercent: num, distance: num,
                inCombat: bool, role: nullable(str), x: num, y: num, z: num,
            })),
            players: capped(obj({ objectId: num, name: str, level: num, realm: str, distance: num })),
            objects: capped(obj({ objectId: num, name: str, isLoot: bool, distance: num, x: num, y: num, z: num })),
        }),
        messages: obj({ chat: arr(obj({ from: nullable(str), type: str, text: str })), system: arr(str) }, 'Messages not shown by a previous call.'),
    })),
});
