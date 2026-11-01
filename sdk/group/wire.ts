// The group run channel: what a group run (runner.ts, through publish.ts) sends
// to the gateway, POST /groups/<id>/publish about once a second, and what the
// gateway answers. Plain JSON. Every publish is a full, idempotent snapshot plus
// the events the gateway has not acknowledged yet, so a lost or repeated POST
// costs nothing. The gateway keeps only the fields it checks
// (gateway/groups.ts sanitizePublish) and serves them to the viewer
// (gateway/group-types.ts).

import type { RunReport } from './observer';
import type { GroupEvent, GroupPicture, Point, Point3, Role } from './types';

export const WIRE_VERSION = 1;

/**
 * What the runner says about its run. 'starting': members connected, the group
 * not running yet (forming, checks); 'running'; 'ending': the run is stopping
 * (sent the moment it aborts, else first thing in its finally, so an MCP cancel
 * that parks the rest still says so); 'ended': the last publish, with the result
 * or the error.
 */
export type RunPhase = 'starting' | 'running' | 'ending' | 'ended';

export interface RunMember {
    /** Bot folder under bots/ (MemberReport.bot). */
    bot: string;
    /** Gateway username (bot.env BOT_USERNAME, else the folder). */
    username: string;
    /** Character name (MemberReport.name). */
    name: string;
    role: Role;
    className: string;
    level: number;
    /** Behaviour names in the order the member tries them. */
    behaviors: string[];
}

export interface RunMeta {
    strategy: string;
    description: string | null;
    /** Runner clock (ms epoch); also the observer's start. */
    startedAt: number;
    /** runs/<stamp>.{json,md,log} the run saves at its end; null when it saves nothing. */
    stamp: string | null;
    seconds: number;
    graceMs: number;
    members: RunMember[];
    /** The merged settings at run start, JSON-safe and at most 16 KB (strategy wrappers may still override per tick). */
    settings: unknown;
    pid: number;
    /** The run applies a wind-down requested from the viewer. */
    control: boolean;
}

/** The parts of the pve coordinator's memory worth drawing (pve.ts decidePve). Strategies without them send nulls. */
export interface CoordinatorView {
    camp: { x: number; y: number; z: number; zone: string; count: number; names: string } | null;
    campLevel: number | null;
    base: Point3 | null;
    facing: Point | null;
    /** safePath waypoints still ahead while travelling (at most 200). */
    route: Point[];
    /** The current travel leg. */
    leg: Point3 | null;
    /** Camps given up on (at most 50). */
    avoidCamps: Point[];
    /** Object ids of failed pulls (at most 50). */
    excluded: number[];
}

/** A base plan (baseplan.ts BasePlan), capped at 64 targets and 64 unsafe spawns. */
export interface PlanView {
    base: Point3;
    facing: Point;
    score: number;
    margin: number;
    targets: { name: string; level: number; x: number; y: number; d: number }[];
    unsafe: { name: string; level: number; x: number; y: number; why: string }[];
}

/** The observer's report so far (GroupObserver.snapshot): the open fight counts as unfinished. */
export type LiveReport = RunReport & { openFight: boolean };

/** A board event the run log prints (isLoggedEvent), numbered per run from 1. text at most 300 chars, data at most 512 B of JSON. */
export interface WireEvent extends GroupEvent { seq: number }

export interface RunResultView {
    totals: RunReport['totals'];
    /** "severity topic: issue" lines. */
    findings: string[];
    /** runs/<stamp> of the saved report, null when nothing was saved. */
    stamp: string | null;
    stoppedBy: 'time' | 'viewer' | 'error';
}

export interface GroupPublish {
    v: typeof WIRE_VERSION;
    /** Random per run (crypto.randomUUID()). */
    runId: string;
    /** 1, 2, ... per run: the gateway ignores a snapshot older than the one it has. */
    publishSeq: number;
    /** Runner clock (ms epoch). */
    sentAt: number;
    /** Group folder name; must equal the id in the URL and a groups/<id>/group.json on the gateway's disk. */
    group: string;
    /** Leader bot folder (group.json leader, else the first member). */
    leader: string;
    /** Every member as bot folder and gateway username, in group.json order. */
    roster: { bot: string; username: string }[];
    state: RunPhase;
    /** Why the run failed (state 'ending' / 'ended'); null when it ends normally (result.stoppedBy says how). */
    error: string | null;
    meta: RunMeta;
    /** The board's picture (Blackboard.picture), members without capabilities.buffSpells, at most 200 contacts nearest the members. */
    picture: GroupPicture;
    /** Runner clock. deadline: when pulling stops; hardStop: when the run stops even mid-fight. */
    timing: { windingDown: boolean; deadline: number; hardStop: number };
    coordinator: CoordinatorView | null;
    /** Sent when it changed (planRev bumped) and every 30 s; absent = unchanged. null = no plan. */
    plan?: PlanView | null;
    planRev: number;
    /** Sent every 5 s; absent = unchanged. */
    report?: LiveReport | null;
    reportRev: number;
    /** Unacknowledged events, oldest first, at most 300 per publish. */
    events: WireEvent[];
    /** Events the runner dropped before the gateway acknowledged them (its outbox keeps 1000). */
    dropped: number;
    /** Ids of control requests this run applied (at most 16, newest last). */
    applied: string[];
    /** Only with state 'ended' after a run that started. */
    result?: RunResultView;
}

/** A viewer request for a run, handed to the runner in the publish answer. */
export interface ControlRequest {
    id: string;
    runId: string;
    /** Finish the current fight, then end the run (the timed end, earlier). */
    kind: 'windDown';
    reason: string;
    /** Gateway clock (ms epoch). */
    requestedAt: number;
}

export type PublishAck =
    | { ok: true; v: typeof WIRE_VERSION; ackSeq: number; control: ControlRequest[] }
    | { ok: false; v: typeof WIRE_VERSION; error: string };

/**
 * Events the run log prints and the viewer's feed shows: orders, deaths, kills,
 * levels, notes, and failed results other than an interrupted cast. Activities
 * travel in picture.members[].activity instead.
 */
export function isLoggedEvent(e: GroupEvent): boolean {
    if (e.kind === 'orders' || e.kind === 'death' || e.kind === 'kill' || e.kind === 'level' || e.kind === 'note') return true;
    return e.kind === 'result' && !e.data?.success && e.data?.reason !== 'interrupted';
}
