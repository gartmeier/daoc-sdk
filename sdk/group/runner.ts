// Run a group: connect the members, form the in-game group, start the shared
// blackboard, one agent per member, the coordinator and the observer, and stop
// after `seconds` once the current fight is over. Saves the observer's report
// under groups/<name>/runs/ and returns its summary.
//
// The run publishes itself to the gateway for the viewer's group page
// (publish.ts), which can also ask it to wind down early: the timed end, sooner.
//
// Field mode: `seconds: Infinity` runs with no end time, until it is wound down or aborted. Such a run keeps
// its log and its observer bounded (RunBounds, FIELD_BOUNDS), so it can go for hours.

import { appendFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { abortable, executionContext } from '../execution-context';
import type { BotActions } from '../actions';
import { gatewayHttpBase, type BotSDK } from '../index';
import { BotDisconnectedError, BotPreemptedError, runScript, type ScriptContext } from '../runner';
import { awaitingRez, type TacticsSettings } from './behaviors';
import { Blackboard } from './blackboard';
import { classTruthFromGateway } from './class-score';
import { MemberAgent, type Behavior, type Member, type MemberAgentOptions } from './member';
import { describeVision, resolveVision, type VisionMode, type VisionOptions } from '../vision';
import { withCharacter } from './character';
import { leftPassive, memberPetKit, petAfterRun, petHoldOf, petLeftAlone, petsAllowed, withPets } from './pets';
import { formatReport, GroupObserver, saveReport, stampOf, type Finding, type ObserverBounds, type RunReport } from './observer';
import { GroupPublisher, jsonSafe, windDownClock, type GroupPublishOptions, type PublisherDeps } from './publish';
import { connectBot, connectGroup, formGroup, loadGroup } from './roster';
import { Coordinator, mergeSettings, type GroupStrategy } from './strategy';
import type { GroupDefinition } from './types';
import { assistTarget, BUFF_STOP_ON, buffFree, groupAnswer, GroupVoice, pickupFree, readGroupAsk, whereWeAre } from './voice';
import { homeOf } from './keeps';
import { regionInbox, voiceOn } from './voice-io';
import { isLoggedEvent, type ControlRequest, type RunMeta, type RunResultView } from './wire';

export interface GroupRunOptions<S> {
    /** The group folder: groups/<name>/ with group.json (runs/ is written there). */
    dir: string;
    strategy: GroupStrategy<S>;
    /** Keep pulling this long; then finish the current fight (up to graceMs) and stop. Infinity: no end time (field mode), until wound down or aborted. */
    seconds: number;
    /** What the run keeps in memory (default: everything for a timed run, FIELD_BOUNDS with no end time). */
    bounds?: RunBounds;
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

/** What a run keeps in memory: the observer's (ObserverBounds), and the log lines held for runs/<stamp>.log. */
export interface RunBounds extends ObserverBounds {
    /** Hold at most twice this many log lines: beyond, the oldest this many go to runs/<stamp>.log at once (or nowhere, with save false). */
    logLines?: number;
}

/** A run with no end time keeps the last 200 fights, 500 values per median and 2000-4000 log lines. */
export const FIELD_BOUNDS: Required<RunBounds> = { fights: 200, samples: 500, logLines: 2000 };

/** The bounds a run keeps: the caller's, else FIELD_BOUNDS when it has no end time, else none. */
export function runBounds(seconds: number, bounds?: RunBounds): RunBounds | undefined {
    return bounds ?? (Number.isFinite(seconds) ? undefined : FIELD_BOUNDS);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * Print lines with a time stamp, folding repeats into one "(×N)" line; keep them for runs/<stamp>.log. With `keep`,
 * at most 2 × keep.lines stay in `lines`: the oldest keep.lines go to keep.spill, which writes them out ahead of the rest.
 */
export function lineLog(print: (line: string) => void, keep?: { lines: number; spill: (lines: string[]) => void }) {
    const lines: string[] = [];
    let last = '', repeats = 0;
    const flush = () => { if (repeats) print(`${stamp()} (×${repeats} more) ${last}`); repeats = 0; };
    const log = (line: string) => {
        lines.push(`${stamp()} ${line}`);
        if (keep && lines.length >= 2 * keep.lines) {
            const out = lines.splice(0, keep.lines);
            try { keep.spill(out); } catch { /* a log that can't be written mustn't end the run */ }
        }
        if (line === last) { repeats++; return; }
        flush();
        last = line;
        print(`${stamp()} ${line}`);
    };
    return { log, lines, flush };
}

export async function runGroup<S>(opts: GroupRunOptions<S>): Promise<GroupRunResult> {
    const bounds = runBounds(opts.seconds, opts.bounds);
    // Set below, before the first line can spill: lines held back go to the run's own log file, ahead of what the report adds.
    let spilled = false;
    let logFile: string | null = null;
    const spill = (lines: string[]) => {
        if (!logFile) return;
        mkdirSync(join(opts.dir, 'runs'), { recursive: true });
        appendFileSync(logFile, lines.map(l => `${l}\n`).join(''));
        spilled = true;
    };
    const out = lineLog(opts.log ?? (line => console.log(line)), bounds?.logLines ? { lines: bounds.logLines, spill } : undefined);
    const log = out.log;
    const def = loadGroup(opts.dir);
    const strategy = opts.strategy;
    // `vision` is no strategy setting: a flag for the members' sight (MemberAgentOptions.vision).
    const { vision: visionFlag, ...flagSettings } = unflatten(opts.settings ?? {});
    const settings = mergeSettings(strategy.settings, flagSettings as any) as S;
    const agentOptions: MemberAgentOptions = { ...strategy.agent, vision: runVision(strategy.agent?.vision, visionFlag) };
    const vision = resolveVision(agentOptions.vision);
    const { members, opened } = await connectGroup(def, opts.have, strategy.roleOf, bot => !strategy.memberBehaviors?.[bot]);
    // Observed members (a human, observed.ts) only when group.json names some: else the board as ever.
    const board = new Blackboard(def.observed?.length ? { ...strategy.board, observed: def.observed } : strategy.board);
    const agents: MemberAgent<S>[] = [];
    const startedAt = Date.now();
    if (opts.save !== false) logFile = join(opts.dir, 'runs', `${stampOf(startedAt)}.log`);
    // The strategy's own rules join the observer's, in the live score and the saved report.
    const strategyFindings = strategy.findings && ((r: RunReport) => strategy.findings!(r, settings));
    const petsOn = petsAllowed(settings);
    // Once per member: what it has a use for is decided by its spells and window as the run starts.
    const lists = new Map<string, Behavior<S>[]>();
    const behaviorsOf = (m: Member) => {
        let list = lists.get(m.bot);
        if (!list) lists.set(m.bot, list = withPets(strategy.memberBehaviors?.[m.bot] ?? withCharacter(strategy.behaviors[m.role] ?? strategy.behaviors.melee, m.character), petsOn ? memberPetKit(m.sdk, m.actions, m.character) : null));
        return list;
    };
    const routines = Object.fromEntries(members.map(m => [m.bot, {
        from: strategy.memberBehaviors?.[m.bot] ? 'strategy' as const : m.character ? 'character' as const : 'role' as const,
        behaviors: behaviorsOf(m).map(b => b.name),
    }]));
    // The enemies' real classes, for scoring the board's class reads in the report only: the other bots on this gateway.
    const truth = classTruthFromGateway(gatewayHttpBase(members[0]!.sdk.config.gatewayUrl), new Set(def.members.map(m => m.bot)));
    const observer = new GroupObserver(board, { group: def.name, strategy: vision ? `${strategy.name} [human vision]` : strategy.name, startedAt, findings: strategyFindings, routines, petHoldMs: petHoldOf(settings), classTruth: truth.truth, ...(bounds ? { bounds } : {}) });
    const graceMs = opts.graceMs ?? 60_000;
    // Planned until the main loop starts; a wind-down from the viewer only moves them earlier.
    let deadline = startedAt + opts.seconds * 1000;
    let hardStop = deadline + graceMs;
    // Set from the publisher's answer handler (a cast: TS would narrow a plain `= null` to null for good).
    let windDown = null as ControlRequest | null;
    let stoppedBy: 'time' | 'viewer' = 'time';
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
    let loops: Promise<unknown>[] = [];
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
        log(`routines: ${members.map(m => `${m.bot} from its ${routines[m.bot]!.from}`).join(', ')}`);
        log(`vision: ${describeVision(vision)}`);
        if (def.observed?.length) log(`observed: ${def.observed.map(o => o.name).join(', ')} (no agent: healed, buffed, rezzed and guarded first, left their kills)`);
        if (opts.form !== false) for (const line of await formGroup(members, def.leader, def.observed?.map(o => o.name))) log(`group: ${line}`);

        board.onEvent(e => {
            if (isLoggedEvent(e)) log(`${e.member ? `${e.member}: ` : ''}${e.kind === 'orders' ? '» ' : ''}${e.text}`);
        });
        // The observer first: what an agent's first reports set off counts ("15:46:02 Pettan: Pettan died", and the report said deaths 0).
        observer.start();
        started = true;
        for (const m of members) agents.push(new MemberAgent(m, board, behaviorsOf(m), settings, agentOptions));
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
        loops = [coordinator.run(run.signal), ...agents.map(a => a.run(run.signal))].map(p => p.catch(e => { if (!run.signal.aborted) run.abort(e); }));
        // The voice (voice.ts): the leader says in group chat what the group does, and in /region the director's lines for this unit.
        const speaker = members.find(m => m.bot === (def.leader ?? def.members[0]!.bot)) ?? members[0]!;
        const realm = players[0]!.realm;
        const voice = voiceOn() && realm !== 'none' ? new GroupVoice({ speaker: speaker.sdk.getPlayer()!.name, realm, regionId: players[0]!.regionId }) : null;
        const inbox = voiceOn() && realm !== 'none' ? regionInbox(basename(opts.dir), realm) : null;
        const speak = (text: string, region: boolean) => {
            if (!speaker.sdk.isConnected()) return;
            log(`${region ? 'region' : 'said'}: ${text}`);
            void (region ? speaker.sdk.sendCommand(`/region ${text}`) : speaker.sdk.sendGroupSay(text)).catch(() => {});
        };
        // A human's asks in group chat (voice.ts readGroupAsk): the leader answers where we are; "pick me up", with the
        // group free, reads them at our portal keep for 3 min unless seen (ObservedMembers.pickup), and the regroup walks there.
        const humans = new Set((def.observed ?? []).map(o => o.name.toLowerCase()));
        let heardId = humans.size ? Math.max(0, ...speaker.sdk.getChat({ types: ['group'], limit: 0 }).map(m => m.id)) : 0;
        const answered = new Map<string, number>();
        /** With a human in the group, the speaker (whom they /assist) holds the called focus as its target, at most once in 1.5 s (voice.ts assistTarget). */
        let assistAt = 0;
        const holdAssist = (now: number) => {
            if (!voice || !humans.size || now - assistAt < 1500 || !speaker.sdk.isConnected()) return;
            const pic = board.picture(now);
            const me = speaker.sdk.getPlayer();
            const id = assistTarget(pic.orders, pic.contacts, me, pic.members.find(m => m.name === me?.name)?.activity);
            if (id === null) return;
            assistAt = now;
            void speaker.sdk.sendSetTarget(id).catch(() => {});
        };
        /** Buff asks heard in a fight ("after this fight"): asked of the board once the fight is over, until then at most 5 min. */
        const buffLater = new Map<string, number>();
        const hearHumans = (now: number) => {
            if (!voice || !humans.size) return;
            for (const [name, until] of buffLater) {
                if (until <= now) buffLater.delete(name);
                else if (buffFree(board.picture(now).orders)) {
                    buffLater.delete(name);
                    if (board.askBuff(name, now)) log(`buff stop for ${name}: asked during the fight`);
                }
            }
            for (const m of speaker.sdk.getChat({ types: ['group'], limit: 50 })) {
                if (m.id <= heardId) continue;
                heardId = m.id;
                const from = m.sender ?? '';
                if (!humans.has(from.toLowerCase())) continue;
                const text = /"(.*)"\s*$/.exec(m.text)?.[1]?.trim() ?? m.text;
                const ask = readGroupAsk(text);
                if (!ask || now - (answered.get(`${from}:${ask}`) ?? 0) < 8000) continue;
                answered.set(`${from}:${ask}`, now);
                const pic = board.picture(now);
                const regionId = voice.state.regionId ?? players[0]!.regionId;
                const home = ask === 'pickup' && pickupFree(pic.orders, whereWeAre(pic, voice.state)) ? homeOf(regionId, realm)?.arrival : undefined;
                let picking = !!home && board.askPickup(from, { regionId, x: home.x, y: home.y, z: home.z }, now, now + 180_000, true);
                if (ask === 'buff') {
                    picking = buffFree(pic.orders) && board.askBuff(from, now);
                    if (!picking) buffLater.set(from, now + 300_000);
                }
                const how = ask === 'buff' ? (picking ? ', a buff stop asked' : ', a buff stop after the fight') : picking ? ', picked up at our PK for 3 min unless seen, a buff stop when met' : '';
                log(`heard: ${from}: ${text} (${ask}${how})`);
                // Buffs promised only by a strategy that stops for them (pack.ts's buffAsk trigger): "rvr-pack", "hibernia-pack".
                const answer = groupAnswer(ask, pic, voice.state, picking, BUFF_STOP_ON && /\bpack\b/.test(strategy.name));
                if (answer) speak(answer, false);
                return; // one line a tick (the server drops group lines 500 ms apart)
            }
        };

        while (!run.signal.aborted) {
            await abortable(Bun.sleep(500), run.signal).catch(() => {});
            const now = Date.now();
            applyWindDown(now);
            try {
                const line = voice?.hear(board.picture(now), now);
                if (line) speak(line.text, false);
                else hearHumans(now);
                for (const text of inbox?.take(now) ?? []) speak(text, true);
                holdAssist(now);
            } catch (e) { log(`voice: ${errorText(e)}`); }
            if (now >= deadline && !coordinator.windingDown) { coordinator.windingDown = true; log('time is up: finishing the current fight'); }
            const phase = board.getOrders().phase;
            // A corpse waiting for a rez would otherwise be left dead, and a member's report says so: wait for it too, up to the hard stop.
            const settled = !['engage', 'retreat', 'pull'].includes(phase) && !awaitingRez(board.picture().members, settings as Partial<TacticsSettings>);
            if (coordinator.windingDown && (now >= hardStop || settled)) break;
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
        truth.stop();
        parent?.removeEventListener('abort', onParent);
        for (const off of offConn) off();
        for (const a of agents) a.dispose();
        // An agent's run has ended its side tick by the time it settles: nothing orders a pet after the last orders below.
        await Promise.allSettled(loops);
        // Outside any aborted execution: leave nobody running or swinging.
        await executionContext.exit(() => Promise.allSettled(members.map(async m => {
            const agent = agents.find(a => a.member === m);
            // The connection another controller cut can't send what lifts it. Pre-empted in a retreat: "pethun pet now hunter's pet passive/follow tgt=null".
            if (!m.sdk.isConnected()) {
                if (petsOn && agent && leftPassive(m.sdk, agent.ctx.memory)) log(`${agent.ctx.name}'s pet left passive: the next run lifts it`);
                return;
            }
            if (m.sdk.getPlayer()?.attacking) await m.sdk.sendAttack(false);
            // A character with no pet of its own (pet: false) has had nothing ordered, as with pet.enabled false.
            if (petsOn && m.character?.pet !== false) await petAfterRun(m.sdk, agent?.ctx.memory, petLeftAlone(m.sdk, m.actions));
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
        made = { report, path: opts.save === false ? null : saveReport(opts.dir, report, out.lines, { botHistory: true, appendLog: spilled }) };
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

/**
 * A group run's vision: human unless the strategy (agent.vision) or the run's flag (`--vision=omniscient`) says
 * otherwise. Bots see as a player does, the user's call on 2026-11-12: all-seeing members swung a squad's odds on
 * every enemy that came or went within ~3500, and flipped between fighting and fleeing as no player would.
 */
export const RUN_VISION_DEFAULT: VisionMode = 'human';
export function runVision(strategyVision: MemberAgentOptions['vision'], flag: unknown): MemberAgentOptions['vision'] {
    return withVisionFlag(strategyVision ?? RUN_VISION_DEFAULT, flag);
}

/**
 * The strategy's vision with a run's flag over it: `--vision=human` sets the mode, `--vision.fovDegrees=120`
 * a number (a partial set means human sight). No flag leaves the strategy's.
 */
export function withVisionFlag(base: MemberAgentOptions['vision'], flag: unknown): MemberAgentOptions['vision'] {
    if (flag === undefined) return base;
    const from = typeof base === 'string' ? { mode: base } : base ?? {};
    if (typeof flag === 'string') return { ...from, mode: flag as VisionMode };
    if (flag && typeof flag === 'object') return { ...from, mode: 'human', ...(flag as Partial<VisionOptions>) };
    throw new Error(`--vision: expected human, omniscient or --vision.<option>=<value>, got ${String(flag)}`);
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
