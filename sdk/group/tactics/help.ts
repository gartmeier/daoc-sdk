// Realm calls for a main group (the night of 2026-11-12/13, R3): a unit of ours under attack asks the realm's other units
// for help, and the realm's director musters everyone for a raid. The director (sdk/group/director.ts, R2) posts the
// calls from what our realm's units saw; each unit decides for itself whether to come. These are the pure parts: which
// call a group answers, how far it goes for one, when it has arrived and when it gives up. decideRvr (rvr.ts) calls
// helpStep in its quiet branch (no fight, nobody in sight, nobody dead or away), so a group answers only when it is free.
// rvr.ts realmCalls() feeds the calls in (memory.realmCalls) and sends the answers out (memory.helpOut).

import type { Point, Point3 } from '../types';

/** A call as the director publishes it (director.ts RealmCall): only the fields read here. */
export interface RealmCall {
    id: string;
    /** defend: our keep is attacked and the director asks us in (tactics/defend.ts). */
    kind: 'help' | 'muster' | 'defend';
    /** The calling unit (help), 'director' (muster). */
    from: string;
    why: string;
    /** Where to go: the fight's centre (help), the rally point (muster). */
    at: Point3;
    /** Muster only: gather at `at` ('rally'), then go for `target` ('go'). */
    stage?: 'rally' | 'go';
    target?: Point3;
    /**
     * Muster only, when the director writes it: every member of every unit it asked that is running, by unit. The raid's stage
     * waits for the whole raid with it (siege.ts RaidView.raid, tactics/raid.ts raidMembers). Absent: each unit counts its own.
     */
    raid?: readonly RaidCallMember[];
    /** As our realm saw it: enemy players near `at`, and ours alive there. */
    foes: number;
    ours: number;
    /** Bodies still needed to even it; 0 = covered. */
    want: number;
    /** Units the director picked (free, nearest, way short). */
    asked: readonly string[];
    coming?: readonly string[];
    /** Help only, on the caller's own call (director.ts): where the units coming stand now, nearest to `at` first. */
    helpers?: readonly UnitSpot[];
    since?: number;
    updatedAt?: number;
}

/** A raid member as the muster call carries it (director.ts RaidMember). */
export interface RaidCallMember {
    unit: string;
    x: number;
    y: number;
    z: number;
    alive: boolean;
    name?: string;
    id?: number;
    level?: number;
    /** Knows a rez. */
    rez?: boolean;
    /** Alive, its unit still closing on the target: the stage waits for it at any distance. */
    onWay?: boolean;
}

/** A running unit of the realm as the director's calls file carries it (director.ts UnitSpot). */
export interface UnitSpot {
    unit: string;
    x: number;
    y: number;
    z: number;
    alive: number;
    size: number;
    fight: boolean;
    phase: string | null;
}

export type CallAnswer = 'coming' | 'declined' | 'arrived' | 'left';

export interface CallSettings {
    /** Off: no call is answered (the director still counts the group as a unit). */
    enabled: boolean;
    /** Go for a help call that names us (asked) at most this far ... */
    maxWay: number;
    /** ... and for one that doesn't, still wanting bodies, at most this far. 191 units/s at full run, legs wait for everyone. */
    maxWayOpen: number;
    /** Answer the muster (rally, then the raid). */
    muster: boolean;
    /** Within this of where the call points: arrived. */
    arrive: number;
    /** Arrived, and this long with nobody in sight: the fight there is over for us; leave the call. */
    idleMs: number;
}

export const CALL_SETTINGS: CallSettings = { enabled: true, maxWay: 9000, maxWayOpen: 6000, muster: true, arrive: 1500, idleMs: 20_000 };

/** The call a group answers, in memory.help. */
export interface Answering {
    id: string;
    kind: RealmCall['kind'];
    state: 'coming' | 'arrived';
    since: number;
    /** The muster's stage we arrived at (rally or go): a new stage is a new walk. */
    stage?: string;
    arrivedAt?: number;
    /** The last quiet tick (helpStep runs only then), and since when it has been quiet without a gap. */
    lastQuiet?: number;
    quietSince?: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Where a call sends us now: the fight (help), the rally point, or the raid's target once the muster says go. */
export function callGoal(c: RealmCall): Point3 {
    return c.kind === 'muster' && c.stage === 'go' && c.target ? c.target : c.at;
}

/**
 * The call to answer: the one we answer while it is open; else a help call that names us within maxWay, nearest first;
 * then the muster; then a help call that still wants bodies within maxWayOpen. Never one we left (`left`), nor our own.
 */
export function chooseCall(calls: readonly RealmCall[], unit: string, centre: Point, s: CallSettings, current?: Answering, left: Readonly<Record<string, number>> = {}): RealmCall | null {
    if (!s.enabled) return null;
    const open = calls.filter(c => c.from !== unit && !(c.id in left));
    const held = current && open.find(c => c.id === current.id);
    if (held) return held;
    const near = (a: RealmCall, b: RealmCall) => dist(callGoal(a), centre) - dist(callGoal(b), centre);
    // Our keep's defence first, when it asks us (any distance: the director asked the nearest).
    const defend = open.find(c => c.kind === 'defend' && c.asked.includes(unit));
    if (defend) return defend;
    const help = open.filter(c => c.kind === 'help').sort(near);
    const asked = help.find(c => c.asked.includes(unit) && dist(c.at, centre) <= s.maxWay);
    if (asked) return asked;
    const muster = s.muster ? open.find(c => c.kind === 'muster') : undefined;
    if (muster) return muster;
    return help.find(c => c.want > 0 && dist(c.at, centre) <= s.maxWayOpen) ?? null;
}

/** The open call we answer, if any (memory.help, read against memory.realmCalls). */
export function answering(mem: Record<string, any>): RealmCall | null {
    const a: Answering | undefined = mem.help;
    if (!a) return null;
    return ((mem.realmCalls ?? []) as RealmCall[]).find(c => c.id === a.id) ?? null;
}

const send = (mem: Record<string, any>, id: string, answer: CallAnswer, why?: string) => {
    (mem.helpOut ??= []).push({ id, answer, ...(why ? { why } : {}) });
};

/** Arrived at the call we answer (within s.arrive of its goal): note it once, and tell the director. Runs every tick, fight or not. */
export function noteArrival(mem: Record<string, any>, centre: Point, now: number, s: CallSettings): void {
    const a: Answering | undefined = mem.help;
    const c = answering(mem);
    if (!a || !c) return;
    const stage = c.kind === 'muster' ? c.stage ?? 'rally' : undefined;
    if (a.state === 'arrived' && a.stage === stage) return;
    if (dist(centre, callGoal(c)) > s.arrive) {
        // A new muster stage: walking again.
        if (a.state === 'arrived') { a.state = 'coming'; a.stage = stage; a.arrivedAt = undefined; }
        return;
    }
    a.state = 'arrived';
    a.stage = stage;
    a.arrivedAt = now;
    send(mem, a.id, 'arrived');
}

/** The director counts in a help call's `ours` every unit's living within this of `at` (R2, director.ts): an arrived helper too. */
export const OURS_RADIUS = 2000;

/**
 * Friends to count on our side near the call we answer (help calls only): the call's `ours` while our centre is within
 * `radius` of where it points, less our own living members within OURS_RADIUS of it (the director counts them there).
 * They fight there too, so their enemies are no reason for us to fall back from them.
 */
export function alliesNear(mem: Record<string, any>, centre: Point, radius: number, ourLiving: readonly Point[] = []): number {
    const c = answering(mem);
    if (!c || c.kind !== 'help' || dist(centre, c.at) > radius) return 0;
    return Math.max(0, c.ours - ourLiving.filter(m => dist(m, c.at) <= OURS_RADIUS).length);
}

export type HelpStep =
    | { kind: 'go'; call: RealmCall; goal: Point3; objective: string; reason: string }
    | { kind: 'hold'; call: RealmCall; at: Point3; objective: string; reason: string };

const where = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
const callText = (c: RealmCall) => c.kind === 'muster'
    ? `the muster${c.stage === 'go' ? ', going in' : ', at the rally point'}`
    : c.kind === 'defend' ? `the defence of our keep (${c.foes} attackers, ${c.ours} of ours there)`
    : `${c.from} (${c.why}, ${c.foes} vs ${c.ours})`;

/**
 * The quiet branch's step for realm calls (free: no fight of our own, nobody in sight, nobody dead or away, at most one
 * short of ready). Picks the call (chooseCall), answers 'coming' once, walks to it, holds there once arrived: at a help
 * call until s.idleMs passes with nobody in sight ('left'), at the rally point until the muster says go, at the target
 * for the raid's plan. A call that closed is dropped without an answer. Null: no call, the group goes on as it would.
 */
export function helpStep(mem: Record<string, any>, o: { unit: string; centre: Point; now: number; settings: CallSettings; free: boolean }): HelpStep | null {
    const { now, settings: s, centre } = o;
    const calls: RealmCall[] = mem.realmCalls ?? [];
    const left: Record<string, number> = (mem.helpLeft ??= {});
    for (const [id, until] of Object.entries(left)) if (until <= now) delete left[id];
    let a: Answering | undefined = mem.help;
    if (a && !calls.some(c => c.id === a!.id)) { mem.help = a = undefined; }
    if (!o.free || !s.enabled) return null;
    const call = chooseCall(calls, o.unit, centre, s, a, left);
    if (!call) return null;
    if (!a || a.id !== call.id) {
        if (a) send(mem, a.id, 'left', `for ${call.id}`);
        mem.help = a = { id: call.id, kind: call.kind, state: 'coming', since: now };
        send(mem, call.id, 'coming');
    }
    noteArrival(mem, centre, now, s);
    const goal = callGoal(call);
    const d = Math.round(dist(centre, goal));
    // The defence: each member walks to its stand itself (tactics/defend.ts, holdDefenceStand), never the group to `at`.
    if (call.kind === 'defend') return { kind: 'hold', call, at: goal, objective: `answer ${callText(call)}`, reason: `call ${call.id}: ${callText(call)}${mem.defenceInside ? '' : `, ${d} away`}${mem.defenceWhy ? `; ${mem.defenceWhy}` : ''}` };
    if (a.state !== 'arrived') {
        return { kind: 'go', call, goal, objective: `answer ${callText(call)} at ${where(goal)}`, reason: `call ${call.id}: ${callText(call)}, ${d} away` };
    }
    // Quiet since: a tick that wasn't quiet (we fought or hunted there) starts the count again.
    if (!a.lastQuiet || now - a.lastQuiet > 3000) a.quietSince = now;
    a.lastQuiet = now;
    if (call.kind === 'help' && now - (a.quietSince ?? now) >= s.idleMs) {
        send(mem, call.id, 'left', 'nobody in sight');
        left[call.id] = now + 10 * 60_000;
        mem.help = undefined;
        return null;
    }
    const wait = call.kind === 'help' ? `, nobody in sight, ${Math.ceil((s.idleMs - (now - (a.quietSince ?? now))) / 1000)} s more` : call.stage === 'go' ? ', at the target' : ', waiting for the go';
    return { kind: 'hold', call, at: goal, objective: `answer ${callText(call)} at ${where(goal)}`, reason: `call ${call.id}: there${wait}` };
}

/** Where the answers go (director.ts callWatch): the calls of our realm, and our answers to them. */
export interface CallSource {
    calls(): readonly RealmCall[];
    answer(id: string, answer: CallAnswer, why?: string): void;
    stop?(): void;
    /** The unit's own open help calls (with their helpers). */
    mine?(): readonly RealmCall[];
    /** The realm's other running units. */
    units?(): readonly UnitSpot[];
    /** Our picket duty while the realm holds its keep (director.ts Picket), or null. */
    picket?(): PicketDuty | null;
    /** Where the realm saw enemies lately (director.ts Sighting): the roam's places (tactics/roam.ts). */
    seen?(): readonly { x: number; y: number; n: number; at: number }[];
}

/** director.ts Picket: stand at `at`, within sight of our keep at `keep`. */
export interface PicketDuty {
    unit: string;
    at: Point3;
    keep: Point3;
}

// ── The caller's side (stint 2026-11-13, S3): fall back toward the helpers, turn when they are with us ──

/** Helpers within this of our centre (2D) stand with us: they count on our side. */
export const WITH_US = 2500;

/** The nearest helper coming to our own open help call (memory.ownCalls, rvr.ts realmCalls), where it stands now; null with none. */
export function helperPoint(mem: Record<string, any>, centre: Point): (UnitSpot & { call: string }) | null {
    let best: (UnitSpot & { call: string }) | null = null;
    for (const c of (mem.ownCalls ?? []) as RealmCall[]) {
        for (const h of c.helpers ?? []) {
            if (h.alive <= 0) continue;
            if (!best || dist(h, centre) < dist(best, centre)) best = { ...h, call: c.id };
        }
    }
    return best;
}

/**
 * Ours on our side at our own call: those the director counts there (its `ours`, our own living taken out), and helpers
 * within WITH_US of our centre not yet counted there. Once they are with us, the odds turn and so do we.
 */
export function callerAllies(mem: Record<string, any>, centre: Point, ourLiving: number): number {
    let n = 0;
    for (const c of (mem.ownCalls ?? []) as RealmCall[]) {
        if (dist(c.at, centre) > WITH_US) continue;
        const there = Math.max(0, c.ours - ourLiving);
        const coming = (c.helpers ?? []).filter(h => dist(h, centre) <= WITH_US).reduce((t, h) => t + h.alive, 0);
        n = Math.max(n, there + coming);
    }
    return n;
}

// ── Roaming within reach of a friend (stint 2026-11-13, S3) ──

export interface RoamSettings {
    /** Close up on the nearest friendly unit once it is farther than this ... */
    far: number;
    /** ... until within this of it. */
    near: number;
    /** Friends of at least this many living (a group or a trio, not a stealther alone). */
    minAlive: number;
    /** A friend this near our own portal keep is resting at home: not one to roam by. */
    homeClear: number;
}

/** A unit this big is a main group (a squad is 1-3). */
const MAIN_SIZE = 4;

export const ROAM_SETTINGS: RoamSettings = { far: 4500, near: 3000, minAlive: 3, homeClear: 7000 };

/**
 * Where to walk to stay within reach of the nearest friendly unit (memory.realmUnits), or null while it is near enough or
 * there is none. Once farther than `far` we close up to `near` of it, then patrol on (memory.roamClose holds the state).
 */
export function roamGoal(mem: Record<string, any>, centre: Point, home: Point | null, s: RoamSettings = ROAM_SETTINGS): { goal: Point; friend: UnitSpot; d: number } | null {
    const out = ((mem.realmUnits ?? []) as UnitSpot[]).filter(u => u.alive >= s.minAlive && (!home || dist(u, home) > s.homeClear));
    // A main group first: a squad roams the edges and runs off (live 13:24, a group closed on midgard-s1 and lost it every few
    // seconds); a trio only when no main group is out.
    const mains = out.filter(u => u.size >= MAIN_SIZE);
    const friends = mains.length ? mains : out;
    if (!friends.length) { mem.roamClose = undefined; return null; }
    const friend = friends.reduce((a, b) => (dist(a, centre) <= dist(b, centre) ? a : b));
    const d = dist(friend, centre);
    if (d <= s.near || (!mem.roamClose && d <= s.far)) { mem.roamClose = undefined; return null; }
    mem.roamClose = friend.unit;
    const k = (d - s.near) / d;
    return { goal: { x: Math.round(centre.x + (friend.x - centre.x) * k), y: Math.round(centre.y + (friend.y - centre.y) * k) }, friend, d };
}

/** Sends the answers helpStep and noteArrival queued (memory.helpOut), in order. */
export function flushAnswers(mem: Record<string, any>, source: CallSource | null | undefined): void {
    const q: { id: string; answer: CallAnswer; why?: string }[] = mem.helpOut ?? [];
    if (!q.length) return;
    mem.helpOut = [];
    if (!source) return;
    for (const x of q) {
        try { source.answer(x.id, x.answer, x.why); } catch { /* a failed write loses one answer; the director measures arrival itself */ }
    }
}
