// Run a group: connect the members, form the in-game group, start the shared
// blackboard, one agent per member, the coordinator and the observer, and stop
// after `seconds` once the current fight is over. Saves the observer's report
// under groups/<name>/runs/ and returns its summary.

import { abortable, executionContext } from '../execution-context';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { BotDisconnectedError, BotPreemptedError, runScript, type ScriptContext } from '../runner';
import { Blackboard } from './blackboard';
import { MemberAgent } from './member';
import { formatReport, GroupObserver, saveReport, type Finding, type RunReport } from './observer';
import { connectBot, connectGroup, formGroup, loadGroup } from './roster';
import { Coordinator, mergeSettings, type GroupStrategy } from './strategy';
import type { GroupEvent } from './types';

export interface GroupRunOptions<S> {
    /** The group folder: groups/<name>/ with group.json (runs/ is written there). */
    dir: string;
    strategy: GroupStrategy<S>;
    /** Keep pulling this long; then finish the current fight (up to graceMs) and stop. */
    seconds: number;
    graceMs?: number;
    /** A member connection the caller already holds (runScript or MCP execute_code). */
    have?: { bot: BotActions; sdk: BotSDK };
    /** Settings overrides for this run only. */
    settings?: Record<string, unknown>;
    /** Invite everyone into one group first (default true). */
    form?: boolean;
    /** Write runs/<stamp>.json/.md (default true). */
    save?: boolean;
    log?: (line: string) => void;
}

export interface GroupRunResult {
    group: string;
    strategy: string;
    seconds: number;
    totals: RunReport['totals'];
    members: Record<string, string>;
    findings: string[];
    /** Markdown report path (null when not saved). */
    report: string | null;
    previous?: Record<string, string>;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const LOGGED: ReadonlySet<GroupEvent['kind']> = new Set(['orders', 'death', 'kill', 'level', 'note']);

/** Print lines with a time stamp, folding repeats into one "(×N)" line; keep them all for runs/<stamp>.log. */
function lineLog(print: (line: string) => void) {
    const lines: string[] = [];
    let last = '', repeats = 0;
    const flush = () => { if (repeats) print(`${stamp()} (×${repeats} more) ${last}`); repeats = 0; };
    const log = (line: string) => {
        lines.push(`${stamp()} ${line}`);
        if (line === last) { repeats++; return; }
        flush();
        last = line;
        print(`${stamp()} ${line}`);
    };
    return { log, lines, flush };
}

export async function runGroup<S>(opts: GroupRunOptions<S>): Promise<GroupRunResult> {
    const out = lineLog(opts.log ?? (line => console.log(line)));
    const log = out.log;
    const def = loadGroup(opts.dir);
    const strategy = opts.strategy;
    const settings = mergeSettings(strategy.settings, unflatten(opts.settings ?? {}) as any) as S;
    const { members, opened } = await connectGroup(def, opts.have, strategy.roleOf);
    const board = new Blackboard();
    const agents: MemberAgent<S>[] = [];
    const observer = new GroupObserver(board, { group: def.name, strategy: strategy.name });
    const parent = executionContext.getStore()?.signal;
    const run = new AbortController();
    const onParent = () => run.abort(parent!.reason);
    parent?.addEventListener('abort', onParent, { once: true });
    const offConn = members.map(m => m.sdk.onConnectionStateChange(st => {
        if (st !== 'disconnected' && st !== 'reconnecting') return;
        run.abort(m.sdk.wasPreempted() ? new BotPreemptedError(`${m.bot}: pre-empted by another controller`) : new BotDisconnectedError(`${m.bot}: gateway connection lost`));
    }));
    let failure: unknown = null;
    let started = false;
    try {
        const players = members.map(m => m.sdk.getPlayer()!);
        const realms = new Set(players.map(p => p.realm));
        if (realms.size > 1) throw new Error(`members are in different realms: ${players.map(p => `${p.name} ${p.realm}`).join(', ')}`);
        const regions = new Set(players.map(p => p.regionId));
        if (regions.size > 1) throw new Error(`members are in different regions: ${players.map(p => `${p.name} ${p.regionId}`).join(', ')}; bring them together first (teleporters)`);
        log(`${def.name}: ${members.map(m => `${m.sdk.getPlayer()!.name} (${m.sdk.getPlayer()!.className} L${m.sdk.getPlayer()!.level}, ${m.role})`).join(', ')}; strategy ${strategy.name}`);
        if (opts.form !== false) for (const line of await formGroup(members, def.leader)) log(`group: ${line}`);

        board.onEvent(e => {
            if (LOGGED.has(e.kind) || (e.kind === 'result' && !e.data?.success && e.data?.reason !== 'interrupted')) log(`${e.member ? `${e.member}: ` : ''}${e.kind === 'orders' ? '» ' : ''}${e.text}`);
        });
        for (const m of members) agents.push(new MemberAgent(m, board, strategy.memberBehaviors?.[m.bot] ?? strategy.behaviors[m.role] ?? strategy.behaviors.melee, settings));
        observer.start();
        started = true;
        const coordinator = new Coordinator(board, strategy, settings);
        const loops = [coordinator.run(run.signal), ...agents.map(a => a.run(run.signal))].map(p => p.catch(e => { if (!run.signal.aborted) run.abort(e); }));

        const deadline = Date.now() + opts.seconds * 1000;
        const hardStop = deadline + (opts.graceMs ?? 60_000);
        while (!run.signal.aborted) {
            await abortable(Bun.sleep(500), run.signal).catch(() => {});
            const now = Date.now();
            if (now >= deadline && !coordinator.windingDown) { coordinator.windingDown = true; log('time is up: finishing the current fight'); }
            const phase = board.getOrders().phase;
            if (coordinator.windingDown && (now >= hardStop || !['engage', 'retreat', 'pull'].includes(phase))) break;
        }
        if (run.signal.aborted) failure = run.signal.reason;
        else run.abort(new Error('group run finished'));
        await Promise.allSettled(loops);
    } catch (e) {
        failure = e;
        run.abort(e);
    } finally {
        parent?.removeEventListener('abort', onParent);
        for (const off of offConn) off();
        for (const a of agents) a.dispose();
        // Outside any aborted execution: leave nobody running or swinging.
        await executionContext.exit(() => Promise.allSettled(members.map(async m => {
            if (!m.sdk.isConnected()) return;
            if (m.sdk.getPlayer()?.attacking) await m.sdk.sendAttack(false);
            await m.sdk.sendStop();
        })));
    }
    await Promise.allSettled(opened.map(s => s.disconnect()));
    if (!started) throw failure;
    const report = observer.stop();
    out.flush();
    const path = opts.save === false ? null : saveReport(opts.dir, report, out.lines);
    if (path) log(`report: ${path}`);
    if (failure) throw failure;
    return {
        group: def.name, strategy: strategy.name, seconds: Math.round(report.durationMs / 1000), totals: report.totals,
        members: Object.fromEntries(Object.entries(report.members).map(([n, m]) => [n, `${m.className} L${m.level}, ${m.xpPerHour} xp/h, ${m.deaths} deaths, idle ${m.idleInFights}% in fights`])),
        findings: report.findings.map(f => `${f.severity} ${f.topic}: ${f.issue}`),
        report: path, previous: report.previous,
    };
}

/** { 'ready.hp': 70 } → { ready: { hp: 70 } }, so flags can reach nested settings. */
export function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(flat)) {
        const parts = key.split('.');
        let at = out;
        for (const p of parts.slice(0, -1)) at = at[p] ??= {};
        at[parts.at(-1)!] = value;
    }
    return out;
}

/** Positional arguments and --key=value flags of a group script (negative numbers survive). */
export function groupArgs(argv = process.argv): { positional: string[]; flags: Record<string, string> } {
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        if (m) flags[m[1]!] = m[2] ?? 'true';
        else positional.push(a);
    }
    return { positional, flags };
}

/**
 * The CLI entry point of a group script: connect the group's leader, then run
 * `main` through runScript (timeout, Ctrl+C, result printing). MCP execute_code
 * imports the same default export and passes its own bot instead.
 */
export async function runGroupScript(main: (ctx: ScriptContext) => Promise<unknown>, opts: { dir: string; args?: any; timeout?: number }): Promise<void> {
    const def = loadGroup(opts.dir);
    const leader = def.leader ?? def.members[0]!.bot;
    let conn: Awaited<ReturnType<typeof connectBot>>;
    try {
        conn = await connectBot(leader);
    } catch (e) {
        console.error(`[Group] ${(e as Error).message}`);
        process.exitCode = 1;
        return;
    }
    try {
        await runScript(main, { connection: conn, args: opts.args, timeout: opts.timeout, printState: false });
    } finally {
        await conn.sdk.disconnect();
    }
}

export { formatReport };
export type { Finding };
