// Run a group: connect the members, form the in-game group, start the shared
// blackboard, one agent per member, the coordinator and the observer, and stop
// after `seconds` once the current fight is over. Saves the observer's report
// under groups/<name>/runs/ and returns its summary.
//
// The run publishes itself to the gateway for the viewer's group page
// (publish.ts), which can also ask it to wind down early: the timed end, sooner.

import { basename } from 'path';
import { abortable, executionContext } from '../execution-context';
import type { BotActions } from '../actions';
import { gatewayHttpBase, type BotSDK } from '../index';
import { BotDisconnectedError, BotPreemptedError, runScript, type ScriptContext } from '../runner';
import { Blackboard } from './blackboard';
import { MemberAgent, type Behavior, type Member } from './member';
import { formatReport, GroupObserver, saveReport, stampOf, type Finding, type RunReport } from './observer';
import { GroupPublisher, jsonSafe, windDownClock, type GroupPublishOptions, type PublisherDeps } from './publish';
import { connectBot, connectGroup, formGroup, loadGroup } from './roster';
import { Coordinator, mergeSettings, type GroupStrategy } from './strategy';
import type { GroupDefinition } from './types';
import { isLoggedEvent, type ControlRequest, type RunMeta, type RunResultView } from './wire';

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
    /**
     * Publish the run to the gateway for its group page (/viewer/group/<name>), which
     * can also wind it down (default on; false or DAOC_GROUP_PUBLISH=0 turns it off).
     */
    publish?: false | GroupPublishOptions;
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
    /** 'viewer': wound down from the group page before its time. */
    stoppedBy: 'time' | 'viewer';
}

const stamp = () => new Date().toISOString().slice(11, 19);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

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
    const board = new Blackboard(strategy.board);
    const agents: MemberAgent<S>[] = [];
    const startedAt = Date.now();
    // The strategy's own rules join the observer's, in the live score and the saved report.
    const strategyFindings = strategy.findings && ((r: RunReport) => strategy.findings!(r, settings));
    const observer = new GroupObserver(board, { group: def.name, strategy: strategy.name, startedAt, findings: strategyFindings });
    const graceMs = opts.graceMs ?? 60_000;
    // Planned until the main loop starts; a wind-down from the viewer only moves them earlier.
    let deadline = startedAt + opts.seconds * 1000;
    let hardStop = deadline + graceMs;
    // Set from the publisher's answer handler (a cast: TS would narrow a plain `= null` to null for good).
    let windDown = null as ControlRequest | null;
    let stoppedBy: 'time' | 'viewer' = 'time';
    const behaviorsOf = (m: Member) => strategy.memberBehaviors?.[m.bot] ?? strategy.behaviors[m.role] ?? strategy.behaviors.melee;
    let publisher: GroupPublisher | null = null;
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
    // Set just before the normal end's own abort, so the abort below can tell it from a failure.
    let finished = false;
    try {
        // In here, so the finally always ends it (its timer would publish 'starting' for as long as the process lives).
        publisher = groupPublisher(opts, def, members, { settings, startedAt, graceMs, behaviorsOf }, {
            board, observer, log,
            timing: () => ({ windingDown: false, deadline, hardStop }),
            // Applied once the coordinator exists, before it first decides, and then by the main loop.
            onControl: req => { windDown ??= req; return true; },
        });
        // The finally is not enough: under MCP a cancelled call's invite in formGroup never settles, so
        // runGroup never gets there. End the publish at the abort itself (the finally's ending() is then a no-op).
        run.signal.addEventListener('abort', () => { if (!finished) publisher?.ending(errorText(run.signal.reason)); }, { once: true });
        const players = members.map(m => m.sdk.getPlayer()!);
        const realms = new Set(players.map(p => p.realm));
        if (realms.size > 1) throw new Error(`members are in different realms: ${players.map(p => `${p.name} ${p.realm}`).join(', ')}`);
        const regions = new Set(players.map(p => p.regionId));
        if (regions.size > 1) throw new Error(`members are in different regions: ${players.map(p => `${p.name} ${p.regionId}`).join(', ')}; bring them together first (teleporters)`);
        log(`${def.name}: ${members.map(m => `${m.sdk.getPlayer()!.name} (${m.sdk.getPlayer()!.className} L${m.sdk.getPlayer()!.level}, ${m.role})`).join(', ')}; strategy ${strategy.name}`);
        if (opts.form !== false) for (const line of await formGroup(members, def.leader)) log(`group: ${line}`);

        board.onEvent(e => {
            if (isLoggedEvent(e)) log(`${e.member ? `${e.member}: ` : ''}${e.kind === 'orders' ? '» ' : ''}${e.text}`);
        });
        for (const m of members) agents.push(new MemberAgent(m, board, behaviorsOf(m), settings, strategy.agent));
        observer.start();
        started = true;
        const coordinator = new Coordinator(board, strategy, settings);
        // A wind-down from the viewer is the timed end, sooner.
        const applyWindDown = (now: number) => {
            if (!windDown) return;
            if (!coordinator.windingDown) {
                coordinator.windingDown = true;
                ({ deadline, hardStop } = windDownClock({ deadline, hardStop }, now, graceMs));
                stoppedBy = 'viewer';
                log(`wind-down requested from the viewer${windDown.reason ? ` (${windDown.reason})` : ''}: finishing the current fight`);
            }
            windDown = null;
        };
        deadline = Date.now() + opts.seconds * 1000;
        hardStop = deadline + graceMs;
        // One asked for while starting (the page allows it): before the first tick, which could start a pull.
        applyWindDown(Date.now());
        publisher?.running(() => coordinator.memory, () => ({ windingDown: coordinator.windingDown, deadline, hardStop }));
        const loops = [coordinator.run(run.signal), ...agents.map(a => a.run(run.signal))].map(p => p.catch(e => { if (!run.signal.aborted) run.abort(e); }));

        while (!run.signal.aborted) {
            await abortable(Bun.sleep(500), run.signal).catch(() => {});
            const now = Date.now();
            applyWindDown(now);
            if (now >= deadline && !coordinator.windingDown) { coordinator.windingDown = true; log('time is up: finishing the current fight'); }
            const phase = board.getOrders().phase;
            if (coordinator.windingDown && (now >= hardStop || !['engage', 'retreat', 'pull'].includes(phase))) break;
        }
        if (run.signal.aborted) failure = run.signal.reason;
        else { finished = true; run.abort(new Error('group run finished')); }
        await Promise.allSettled(loops);
    } catch (e) {
        failure = e;
        run.abort(e);
    } finally {
        // First: under MCP the cleanup below can stall on an aborted call's SDK, and the viewer should still hear the run is ending.
        // An error only for a failure; a normal end says how in result.stoppedBy.
        publisher?.ending(failure ? errorText(failure) : null);
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
    if (!started) {
        await publisher?.finish({ error: failure });
        throw failure;
    }
    let made: { report: RunReport; path: string | null };
    try {
        const report = observer.stop();
        out.flush();
        made = { report, path: opts.save === false ? null : saveReport(opts.dir, report, out.lines) };
    } catch (e) {
        // No report (runs/ not writable, a full disk): the viewer must not show a clean end.
        await publisher?.finish({ error: failure ?? e });
        throw e;
    }
    const { report, path } = made;
    if (path) log(`report: ${path}`);
    const findings = report.findings.map(f => `${f.severity} ${f.topic}: ${f.issue}`);
    const result: RunResultView = { totals: report.totals, findings, stamp: path ? stampOf(report.startedAt) : null, stoppedBy: failure ? 'error' : stoppedBy };
    await publisher?.finish(failure ? { error: failure, result } : { result });
    if (failure) throw failure;
    return {
        group: def.name, strategy: strategy.name, seconds: Math.round(report.durationMs / 1000), totals: report.totals,
        members: Object.fromEntries(Object.entries(report.members).map(([n, m]) => [n, `${m.className} L${m.level}, ${m.xpPerHour} xp/h${m.realmPoints !== undefined ? `, ${m.realmPoints} rp` : ''}, ${m.deaths} deaths, idle ${m.idleInFights}% in fights`])),
        findings, report: path, previous: report.previous, stoppedBy,
    };
}

/**
 * The run's publisher, or null when publishing is off or can't be set up (that
 * never fails the run). Everything it needs from the members is read here, as
 * plain data: under MCP a member's SDK methods stall once its call aborts, and
 * `config` is a plain property the MCP proxy passes through.
 */
function groupPublisher<S>(opts: GroupRunOptions<S>, def: GroupDefinition, members: Member[],
    run: { settings: S; startedAt: number; graceMs: number; behaviorsOf: (m: Member) => Behavior<S>[] | undefined },
    deps: Pick<PublisherDeps, 'board' | 'observer' | 'timing' | 'onControl' | 'log'>): GroupPublisher | null {
    if (opts.publish === false) return null;
    try {
        const leaderBot = def.leader ?? def.members[0]!.bot;
        const leader = members.find(m => m.bot === leaderBot) ?? members[0]!;
        const meta: RunMeta = {
            strategy: opts.strategy.name, description: opts.strategy.description ?? null, startedAt: run.startedAt,
            stamp: opts.save === false ? null : stampOf(run.startedAt), seconds: opts.seconds, graceMs: run.graceMs,
            members: members.map(m => {
                const p = m.sdk.getPlayer();
                return { bot: m.bot, username: m.sdk.config.botUsername, name: p?.name ?? m.bot, role: m.role, className: p?.className ?? '', level: p?.level ?? 0, behaviors: (run.behaviorsOf(m) ?? []).map(b => b.name) };
            }),
            settings: jsonSafe(run.settings, 16 * 1024), pid: process.pid, control: opts.publish?.control !== false,
        };
        // Its answers come in on its own timer, outside any execution, where MCP's console capture sends
        // a line to the server's stderr: print them in the run's execution, so the call shows the viewer link.
        const store = executionContext.getStore();
        const log = store ? (line: string) => executionContext.run(store, () => deps.log(line)) : deps.log;
        return new GroupPublisher({
            ...deps, log, meta, group: basename(opts.dir),
            leader: { bot: leader.bot, username: leader.sdk.config.botUsername, password: leader.sdk.config.password },
            url: gatewayHttpBase(leader.sdk.config.gatewayUrl),
            roster: members.map(m => ({ bot: m.bot, username: m.sdk.config.botUsername })),
        }, opts.publish ?? {});
    } catch (e) {
        deps.log(`group publish off: ${errorText(e)}`);
        return null;
    }
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
