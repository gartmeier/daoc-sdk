// The realm director: one per realm. It reads the realm board (realm-board.ts), posts calls, and its units answer.
//
//   help    A unit in a fight is outnumbered (more enemy players near it than ours there), caught (its orders say
//           'caught:' or 'flee:' with enemies near, or it lost a third of its members in 30 s), or enemies camp our
//           portal keep. The director asks the free units nearest the fight, while the way is short, until the odds
//           are even. A unit decides itself whether it comes (its own odds, its own state) and answers.
//   muster  A raid (the Faste): every unit of the realm goes to a rally point; once most are there, or the rally has
//           waited long enough, the call turns to 'go' and points at the target. Started and ended by the caller
//           (startMuster / endMuster), with the rally and target from the raid plan.
//
// Only our realm's sight: the board takes enemies from the units' run boards (human vision), never server truth.
//
// Transport: the director writes <dir>/<realm>.json (the open calls) after each update; a unit reads it with
// callWatch(unit, realm).calls() and answers with answer(id, state), which writes <dir>/answers/<unit>.json. Units run
// in their own processes, so a file is the whole interface. <dir> is groups/director (DAOC_DIRECTOR_DIR overrides it).
//
// Off (setEnabled(false), the A/B's other half): the board and the calls go on in shadow, logged with shadow: true,
// and the file says off with no calls, so the units see none. Log: <dir>/<realm>-log.jsonl, one JSON line per event
// (open, ask, answer, arrive, stage, close with the outcome).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GroupFrame } from '../../gateway/group-types';
import type { FoeRole } from './class-read';
import { BATTLEGROUND_LAYOUTS, homeOf, THIDRANKI, type PlayerRealm } from './keeps';
import { dist2, foesNear, RealmBoard, roleCount, type RealmBoardView, type SeenFoe, type SeenRole, type UnitView } from './realm-board';
import { isDry } from './water';

/** Where raiders stage at a region's keep (siege.ts's Faste stage): the picket keeps away from it. */
const PICKET_STAGE: Record<number, Point> = { [THIDRANKI]: { x: 36300, y: 38300 } };
import type { Point, Point3 } from './types';

export const DIRECTOR_DIR = process.env.DAOC_DIRECTOR_DIR ?? join(import.meta.dir, '..', '..', 'groups', 'director');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── the interface

/** defend: our keep is attacked; the units nearest it are asked in (not all of them, so a feint doesn't empty the field). */
export type CallKind = 'help' | 'muster' | 'defend';
/**
 * sighted: a bigger group seen coming (within sightRadius, more of one realm than ours there), before any fight: help is
 * asked on first sight, not once we are losing (stint 2026-11-13, S3: help was 6000-9000 away and most fights ended first).
 */
export type CallWhy = 'sighted' | 'outnumbered' | 'caught' | 'camped' | 'raid' | 'keep';
export type AnswerState = 'coming' | 'declined' | 'arrived' | 'left';

export interface RealmCall {
    /** `${realm}-${n}`, unique for the director's life (with its start time in `since`). */
    id: string;
    kind: CallKind;
    /** The calling unit (help), 'director' (muster). */
    from: string;
    why: CallWhy;
    /** Where to go: the fight's centre (help), the rally point, then the target (muster). */
    at: Point3;
    /** Muster only: gather at `at` ('rally'), then go for `target` ('go': `at` is then the target too). */
    stage?: 'rally' | 'go';
    target?: Point3;
    /** Enemy players near `at` as our realm sees them, and ours alive there. */
    foes: number;
    ours: number;
    foeRoles: Partial<Record<SeenRole, number>>;
    /** Bodies still needed to even it (foes + 1 - ours - those coming); 0 when covered. */
    want: number;
    /** Units the director picked: free, nearest, the way short. Others may still come. */
    asked: string[];
    /** Units that answered 'coming' (and not left since). */
    coming: string[];
    /**
     * Muster only: every member of each running unit in `asked`, refreshed each update, places rounded to RAID_ROUND so
     * the file changes only on real moves. Lets a unit see where the rest of the raid stands (R5's RaidView.raid).
     */
    raid?: RaidMember[];
    /** Muster only: enemy players our realm saw near the target in the last defenceMemoryMs. */
    defenders?: number;
    /**
     * Muster only: what holds it now. 'defenders': the go waits for few defenders (or their realm busy elsewhere);
     * 'winner': a third realm fights the owners at the target, at least as many: we wait to take it from the winner;
     * 'lord': the clock waits.
     */
    hold?: MusterHold;
    /**
     * Help only: where the units coming (answered 'coming', or asked) stand now, not yet arrived, nearest to `at` first. The
     * caller falls back toward the nearest (rvr.ts) and turns once they are with it (they count as ours there).
     */
    helpers?: UnitSpot[];
    /** ms epoch. */
    since: number;
    updatedAt: number;
}

/** A raid member as the muster call carries it. */
export interface RaidMember {
    unit: string;
    x: number;
    y: number;
    z: number;
    alive: boolean;
    /** The character, its object id and level, and whether it knows a rez: rez in the raid across its units (tactics/raid.ts). */
    name?: string;
    id?: number;
    level?: number;
    rez?: boolean;
    /**
     * Alive, and its unit still closing on the target (or just set out): the stage waits for it at any distance, not only
     * within siege.ts RAID_COMING (the whole-raid wait counts units on their way). A unit that stopped closing for
     * onWayMs (forming up at home, in a fight elsewhere) drops out of it, so it can't hold the raid forever.
     */
    onWay?: boolean;
}

/** Raid members' places are rounded to this. */
export const RAID_ROUND = 50;

export type MusterHold = 'defenders' | 'winner' | 'lord' | 'progress';

/** How far a raid unit got, from its orders' reason (tactics/raid.ts `raid <phase>: rank N: ...`): phase × 10 + rank; 0 for none. */
export function raidProgress(reason: string): number {
    const m = /\braid (approach|stage|assault|lord|taken)\b/.exec(reason);
    if (!m) return 0;
    const phase = ['approach', 'stage', 'assault', 'lord', 'taken'].indexOf(m[1]!) + 1;
    const rank = Number(/\brank (\d+)/.exec(reason)?.[1] ?? 0);
    return phase * 10 + rank;
}

/** A running unit of the realm as the calls file carries it: its living's centre (rounded to RAID_ROUND), how many live. */
export interface UnitSpot {
    unit: string;
    x: number;
    y: number;
    z: number;
    alive: number;
    size: number;
    /** In a fight of its own. */
    fight: boolean;
    phase: string | null;
}

/** <dir>/<realm>.json */
export interface CallsFile {
    v: 1;
    realm: PlayerRealm;
    at: number;
    enabled: boolean;
    calls: RealmCall[];
    /** Every running unit with a living member in the region (while on): where the realm's friends are, to roam near them. */
    units?: UnitSpot[];
    /** While we hold the keep: the unit that stands within sight of it (the picket), and where. */
    picket?: Picket;
    /** Where our realm saw enemy players lately (2000-cells, the last SIGHTING_MS): the units roam toward them (tactics/roam.ts). */
    seen?: Sighting[];
}

/** Enemy players our realm saw in one 2000-cell: their mean place, the most seen at once, when last. */
export interface Sighting {
    x: number;
    y: number;
    n: number;
    at: number;
}

/** A sighting is kept this long. */
export const SIGHTING_MS = 300_000;
const SIGHTING_CELL = 2000;

/**
 * The picket (S3, S2's finding 16:11): while we hold the keep, one free unit stands within sight of it, so the realm sees an
 * attack. The server tells the owner nothing (the "under attack" broadcast is for relic gates only), so a defence is only as
 * good as our eyes on the keep.
 */
export interface Picket {
    unit: string;
    at: Point3;
    keep: Point3;
}

/** <dir>/answers/<unit>.json */
export interface AnswersFile {
    v: 1;
    unit: string;
    answers: Record<string, { state: AnswerState; why: string; at: number }>;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────── settings

export interface DirectorSettings {
    /** Publish calls. Off: shadow only (logged, not published). */
    enabled: boolean;
    /** Help calls at all; the muster at all. */
    help: boolean;
    muster: boolean;
    /** An enemy within this of a unit's centre is in its fight. */
    nearFoe: number;
    /** Ours of other units within this of a fight's centre stand in it. */
    nearFriend: number;
    /** Lost this share of its size within lossMs, with enemies near: caught. */
    lossShare: number;
    lossMs: number;
    /** A helper's centre at most this far from the fight: the way is short (~37 s at full run). */
    reach: number;
    /**
     * First sight: a unit with at least sightMin enemy players of one realm within sightRadius, more than ours there (its
     * living and other units' within nearFriend of its centre), calls 'sighted', in a fight or not. Its helpers may come from
     * sightReach: the call comes earlier, so there is time for a longer way. sight: false turns it off.
     */
    sight: boolean;
    sightRadius: number;
    sightMin: number;
    sightReach: number;
    /** Help is not asked of a unit whose living are below this mean health, or fewer than this share of its size. */
    helperHp: number;
    helperAlive: number;
    /** Arrived: a unit's centre within this of the call's point. */
    arrive: number;
    /** A call closes after its condition was false this long, or after maxMs open. */
    clearMs: number;
    maxMs: number;
    /** Enemies within campRadius of our portal keep, at least campFoes of them, for campMs: camped. */
    campRadius: number;
    campFoes: number;
    campMs: number;
    /** Muster: go once this share of the realm's living units' members stand at the rally, or after rallyMaxMs with half. */
    quorum: number;
    rallyMaxMs: number;
    /** The muster ends by itself after this long in 'go'. */
    goMaxMs: number;
    /**
     * The lord hold: past goMaxMs the clock waits while a raid unit read `raid lord` (siege.ts's lord phase) within
     * lordGraceMs, for up to lordMaxMs more.
     */
    lordGraceMs: number;
    lordMaxMs: number;
    /** The progress hold: past goMaxMs the clock waits while the raid got further (a rank, a phase) within progressGraceMs, up to progressMaxMs in all. */
    progressGraceMs: number;
    progressMaxMs: number;
    /**
     * The defence hold: the rally doesn't go while more enemy players than defenceShare × the raid's living were seen
     * within defenceRadius of the target in the last defenceMemoryMs. Held that long without a break: the muster ends
     * 'defended'. Our realm sees only what its units see, so defenders nobody looked at don't count.
     */
    defenceRadius: number;
    defenceShare: number;
    defenceMemoryMs: number;
    defenceMaxMs: number;
    /**
     * The moment to raid (stint 2026-11-13, S3): the go waits for few defenders seen at the target, at most fewShare of
     * the raid's living (at least fewMin), unless the owners are seen busy elsewhere: ownersAwayMin of the owner's realm
     * in a fight more than ownersAwayFrom from the target with the third realm within ownersAwayPair of them, seen within
     * defenceMemoryMs. With the third realm at the target too, we join the weaker side: they are fewer than the
     * defenders, we go (counting the defenders less them); as many or more, we wait for the winner ('winner').
     */
    fewShare: number;
    fewMin: number;
    ownersAwayMin: number;
    ownersAwayFrom: number;
    ownersAwayPair: number;
    /** A raid unit counts as on its way while it came onWayMin closer to the target in the last onWayMs (or set out within it). */
    onWayMs: number;
    onWayMin: number;
    /**
     * The defence call: while our realm holds the raid plan's keep (targetOwner), defendMin or more enemy players seen
     * within defendRadius of it (in the last defendMemoryMs) open a 'defend' call. The nearest free units within
     * defendReach are asked in until our bodies there outnumber them, at most defendShare of the running units (at
     * least one). It closes defendClearMs after the last attacker was seen ('quiet'), when the keep is lost ('lost'), or
     * after defendMaxMs. Help calls elsewhere go on with the units not asked.
     */
    defend: boolean;
    defendRadius: number;
    defendMin: number;
    defendMemoryMs: number;
    defendReach: number;
    defendShare: number;
    defendClearMs: number;
    defendMaxMs: number;
    /** After a big wave (defendBigFoes or more seen at once) the call stays open defendClearBigMs (S2, 15:22: the defenders walked out between two waves of one raid). */
    defendBigFoes: number;
    defendClearBigMs: number;
    /**
     * The picket: while we hold the keep, one free unit (squads first, then the nearest) stands picketFrom out from the keep
     * toward our portal keep, for picketMs at most, then another takes over when one is free.
     */
    picket: boolean;
    picketFrom: number;
    picketMs: number;
    /** Only units this big are asked in (main groups: squads don't answer a defence yet). */
    defendMinSize: number;
    /** In 'go', the raid broke once its living fell below this share of those it went with. */
    raidBreak: number;
    /** Raids on a rhythm: a new muster this long after the last one ended (or the director started). 0 = only startMuster. */
    raidEveryMs: number;
}

export const DIRECTOR_SETTINGS: DirectorSettings = {
    enabled: true, help: true, muster: true,
    nearFoe: 2500, nearFriend: 2000, lossShare: 1 / 3, lossMs: 30_000,
    reach: 7000, helperHp: 60, helperAlive: 0.5, arrive: 1500,
    sight: true, sightRadius: 5000, sightMin: 3, sightReach: 9000,
    clearMs: 15_000, maxMs: 180_000,
    campRadius: 5000, campFoes: 2, campMs: 15_000,
    quorum: 0.7, rallyMaxMs: 240_000, goMaxMs: 900_000, raidBreak: 0.3, raidEveryMs: 0,
    lordGraceMs: 30_000, lordMaxMs: 600_000, progressGraceMs: 180_000, progressMaxMs: 1_800_000,
    defenceRadius: 4500, defenceShare: 1, defenceMemoryMs: 60_000, defenceMaxMs: 600_000,
    fewShare: 0.5, fewMin: 2, ownersAwayMin: 3, ownersAwayFrom: 8000, ownersAwayPair: 2500,
    onWayMs: 120_000, onWayMin: 1000,
    defend: true, defendRadius: 4500, defendMin: 2, defendMemoryMs: 30_000, defendReach: 14_000, defendShare: 0.5, defendClearMs: 45_000, defendMaxMs: 900_000, defendMinSize: 4, defendBigFoes: 6, defendClearBigMs: 180_000,
    picket: true, picketFrom: 3200, picketMs: 1_200_000,
};

/** A unit's orders reason in siege.ts's lord phase (tactics/raid.ts writes `raid <phase>: ...`). */
const LORD_PHASE = /\braid lord\b/;

/** A call that still wants bodies logs why each unit was passed over at most this often. */
const REFUSED_EVERY_MS = 30_000;

/** How bad a help call's reason is: an open call takes a worse one, never a milder. */
const WHY_RANK: Record<CallWhy, number> = { sighted: 0, outnumbered: 1, caught: 2, camped: 2, raid: 3, keep: 3 };

/** The foes of the realm with most of them here (all of them when one realm). */
export function biggestRealm(foes: readonly SeenFoe[]): SeenFoe[] {
    const by = new Map<string, SeenFoe[]>();
    for (const f of foes) by.set(f.realm, [...(by.get(f.realm) ?? []), f]);
    return [...by.values()].sort((a, b) => b.length - a.length)[0] ?? [];
}

/** A unit's spot for the calls file (its living's centre, rounded). */
export function spotOf(u: UnitView): UnitSpot {
    const round = (n: number) => Math.round(n / RAID_ROUND) * RAID_ROUND;
    const c = u.centre ?? { x: 0, y: 0, z: 0 };
    return { unit: u.unit, x: round(c.x), y: round(c.y), z: round(c.z), alive: u.alive, size: u.size, fight: u.inFight, phase: u.phase };
}

export interface RaidPlan {
    rally: Point3;
    target: Point3;
    /** Units in the raid; all the director's units by default. */
    units?: string[];
}

/** A raid on the Faste when no plan is given: rally 5500 from its centre toward our portal keep. */
export function defaultRaid(realm: PlayerRealm, regionId = THIDRANKI): RaidPlan | null {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    const faste = bg?.keeps.find(k => !k.portal);
    const home = homeOf(regionId, realm);
    if (!faste || !home) return null;
    const d = dist2(faste, home.keep) || 1;
    const k = 5500 / d;
    const rally = { x: Math.round(faste.x + (home.keep.x - faste.x) * k), y: Math.round(faste.y + (home.keep.y - faste.y) * k), z: faste.z };
    return { rally, target: { x: faste.x, y: faste.y, z: faste.z } };
}

/**
 * What holds a muster's go, or null (the moment to raid, stint 2026-11-13, S3). Defenders are the owner's realm seen at
 * the target; third the other realm seen there; ownersAway those of the owner's realm seen fighting the third realm far off.
 * - Both at the target: as many of the third or more, wait for the winner; fewer, join them on the weaker side (go while
 *   the defenders less them don't outnumber us).
 * - Otherwise: go on few defenders (fewShare of our living, at least fewMin), or with the owners busy elsewhere while the
 *   defenders don't outnumber us (defenceShare, the hold of 59b44a0).
 */
export function musterHold(n: { defenders: number; third: number; ownersAway: number; living: number }, s: Pick<DirectorSettings, 'defenceShare' | 'fewShare' | 'fewMin' | 'ownersAwayMin'>): MusterHold | null {
    const { defenders, third, living } = n;
    if (third > 0 && defenders > 0) {
        if (third >= defenders) return 'winner';
        return defenders - third > s.defenceShare * living ? 'defenders' : null;
    }
    if (defenders > s.defenceShare * living) return 'defenders';
    const few = defenders <= Math.max(s.fewMin, s.fewShare * living);
    return few || n.ownersAway >= s.ownersAwayMin ? null : 'defenders';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────── the events

export type DirectorEvent =
    /** nearest: the nearest other running unit's centre from `at` when it opened (help), null with none; for "distance at the call". */
    | { kind: 'open'; call: string; from: string; why: CallWhy; at: Point3; foes: number; ours: number; foeRoles: Partial<Record<SeenRole, number>>; nearest?: number | null; fight?: boolean }
    /** Bodies still wanted and nobody (more) to ask: why each unit was passed over (at most every REFUSED_EVERY_MS per call). */
    | { kind: 'refused'; call: string; want: number; units: { unit: string; why: string }[] }
    /** The picket changed: `unit` now stands within sight of our keep (null: none). */
    | { kind: 'picket'; unit: string | null; was: string | null; why: string }
    /** A help call's reason got worse (sighted → outnumbered → caught). */
    | { kind: 'why'; call: string; why: CallWhy; was: CallWhy }
    | { kind: 'ask'; call: string; unit: string; dist: number }
    | { kind: 'answer'; call: string; unit: string; state: AnswerState; why: string }
    | { kind: 'arrive'; call: string; unit: string; ms: number; answered: boolean }
    /** At the go: defenders and the third realm seen at the target, owners seen busy elsewhere (the moment to raid). */
    | { kind: 'stage'; call: string; stage: 'rally' | 'go'; atRally: number; of: number; defenders?: number; third?: number; ownersAway?: number; owner?: string | null; lookedAgo?: number | null }
    /** A muster's hold began (on) or ended: the go waits for the defenders or the winner, or the clock for the lord. */
    | { kind: 'hold'; call: string; why: MusterHold; on: boolean; defenders: number; living: number; third?: number; ownersAway?: number }
    | { kind: 'close'; call: string; from: string; why: CallWhy | 'raid'; ms: number; end: string; lost: number; wiped: boolean; asked: string[]; coming: string[]; arrived: string[]; kills: number | null; foesMax: number; oursMax: number };

export type LoggedEvent = DirectorEvent & { t: number; realm: PlayerRealm; shadow: boolean };

// ───────────────────────────────────────────────────────────────────────────────────────────────────────── the director

interface Open {
    call: RealmCall;
    /** Last time its condition held. */
    heldAt: number;
    arrived: Map<string, number>;
    /** The caller's losses already seen when it opened (by `${name}@${at}`), so only new ones count. */
    lossesBefore: Set<string>;
    lost: number;
    killsAtOpen: Map<string, number>;
    foesMax: number;
    oursMax: number;
    /** Last 'refused' event (throttle). */
    refusedAt?: number;
    raid?: RaidPlan & {
        stagedAt: number;
        livingAtGo?: number;
        /** Last time a raid unit read the lord phase. */
        lordAt?: number;
        /** The furthest the raid got (raidProgress) and when it last got further. */
        furthest?: number;
        furthestAt?: number;
        /** Since when the defenders hold the rally. */
        heldSince?: number;
        /** Enemy players seen near the target, by key: last seen and realm. */
        seen: Map<string, { at: number; realm: string }>;
        /** Owner-realm players seen in a fight with the third realm far from the target, by key: last seen. */
        away?: Map<string, number>;
        /** Each raid unit's distance to the target over time (onWay). */
        progress?: Map<string, { t: number; d: number }[]>;
    };
}

export interface DirectorOptions {
    realm: PlayerRealm;
    /** Group folders of this realm's units (groups/<unit>). */
    units: readonly string[];
    regionId?: number;
    /** Where the calls and answers live; DIRECTOR_DIR by default. */
    dir?: string;
    /** Write files and the log (default true); tests turn it off and read `events`. */
    write?: boolean;
    settings?: Partial<DirectorSettings>;
    /** Shorthand for settings.enabled. */
    enabled?: boolean;
    /** The raid plan (siege.ts) for a muster started without one; defaultRaid otherwise. */
    raidPlan?: () => RaidPlan | null;
    /** Who holds the raid's target now, as read live (siege.ts / keeps): the muster ends 'captured' once it is us. */
    targetOwner?: () => string | null;
}

export interface DirectorUpdate {
    board: RealmBoardView;
    /** The open calls (also while off: the shadow ones). */
    calls: RealmCall[];
    /** What happened in this update. */
    events: LoggedEvent[];
}

export class RealmDirector {
    readonly realm: PlayerRealm;
    readonly units: readonly string[];
    readonly regionId: number;
    readonly dir: string;
    settings: DirectorSettings;
    private board: RealmBoard;
    private open = new Map<string, Open>();
    private seq = 0;
    private write: boolean;
    private campSince: number | null = null;
    private answersSeen = new Map<string, number>();
    private pendingRaid: RaidPlan | null = null;
    private raidEnd: string | null = null;
    private last: RealmBoardView | null = null;
    private raidPlan?: () => RaidPlan | null;
    private targetOwner?: () => string | null;
    /** When the last muster ended (or the director started): the rhythm counts from it. */
    private raidEndedAt = Date.now();
    /** Enemy players seen near our keep, by key: last seen (the defence call). */
    private keepSeen = new Map<string, number>();
    /**
     * Enemy players seen near the raid target, by key: last seen and realm, kept from the director's start, not only while a
     * muster is open (live 13:37-14:00: every go read 0 defenders, since nobody saw the keep from the rally). lookedAt: the
     * last time one of our living stood within defenceRadius of it, so 0 defenders can tell "none" from "nobody looked".
     */
    private targetSeen = new Map<string, { at: number; realm: string }>();
    private lookedAt: number | null = null;
    private picketNow: (Picket & { since: number }) | null = null;
    private sightings = new Map<string, Sighting>();

    constructor(opts: DirectorOptions) {
        this.realm = opts.realm;
        this.units = [...opts.units];
        this.regionId = opts.regionId ?? THIDRANKI;
        this.dir = opts.dir ?? DIRECTOR_DIR;
        this.write = opts.write ?? true;
        this.settings = { ...DIRECTOR_SETTINGS, ...opts.settings, ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}) };
        this.board = new RealmBoard(this.realm, { regionId: this.regionId });
        this.raidPlan = opts.raidPlan;
        this.targetOwner = opts.targetOwner;
        if (this.write) mkdirSync(join(this.dir, 'answers'), { recursive: true });
    }

    get enabled(): boolean { return this.settings.enabled; }

    /** The A/B switch. Open calls stay open and go on in the other mode (published or shadow). */
    setEnabled(on: boolean): void {
        this.settings.enabled = on;
        this.publish(Date.now());
    }

    /** Start a raid: rally, then go. Without a plan, the Faste by defaultRaid. Replaces a muster already open. */
    startMuster(plan?: RaidPlan | null): RaidPlan | null {
        const p = plan ?? this.raidPlan?.() ?? defaultRaid(this.realm, this.regionId);
        if (p) { this.pendingRaid = p; this.raidEnd = null; }
        return p;
    }

    /** End the raid at the next update (captured, given up, ...). */
    endMuster(why = 'ended'): void {
        this.pendingRaid = null;
        this.raidEnd = why;
    }

    /** The raid's state: null without one. */
    muster(): RealmCall | null {
        for (const o of this.open.values()) if (o.call.kind === 'muster') return { ...o.call };
        return null;
    }

    /** The open calls now. */
    calls(): RealmCall[] {
        return [...this.open.values()].map(o => ({ ...o.call, asked: [...o.call.asked], coming: [...o.call.coming], ...(o.call.raid ? { raid: o.call.raid.map(m => ({ ...m })) } : {}) }));
    }

    /** The last board read. */
    lastBoard(): RealmBoardView | null { return this.last; }

    /**
     * One step: read the frames (by unit; null when one couldn't be read), the units' answers, then open, update and
     * close calls, write the calls file and the log. `answers` overrides reading <dir>/answers (tests).
     */
    update(frames: Readonly<Record<string, GroupFrame | null | undefined>>, now = Date.now(), answers?: readonly AnswersFile[]): DirectorUpdate {
        const mine: Record<string, GroupFrame | null | undefined> = {};
        for (const u of this.units) mine[u] = frames[u] ?? null;
        const board = this.board.update(mine, now);
        this.last = board;
        const events: DirectorEvent[] = [];
        const s = this.settings;
        const units = new Map(board.units.map(u => [u.unit, u]));

        // Answers first: who is coming.
        for (const file of answers ?? this.readAnswers()) {
            if (!this.units.includes(file.unit)) continue;
            for (const [id, a] of Object.entries(file.answers ?? {})) {
                const o = this.open.get(id);
                const k = `${file.unit}/${id}`;
                // Not an answer older than the call (ids start over with each director: a 'coming' written for the last
                // director's call of that id, live 13:40), nor the caller answering its own call.
                if (!o || (this.answersSeen.get(k) ?? 0) >= a.at || a.at < o.call.since || file.unit === o.call.from) continue;
                this.answersSeen.set(k, a.at);
                const coming = o.call.coming;
                if (a.state === 'coming' || a.state === 'arrived') { if (!coming.includes(file.unit)) coming.push(file.unit); }
                else if (coming.includes(file.unit)) coming.splice(coming.indexOf(file.unit), 1);
                events.push({ kind: 'answer', call: id, unit: file.unit, state: a.state, why: String(a.why ?? '').slice(0, 200) });
            }
        }

        // Help: each unit's condition now.
        const helpNow = new Map<string, { why: CallWhy; at: Point3; foes: SeenFoe[]; ours: number }>();
        if (s.help) {
            for (const u of board.units) {
                const c = this.helpCondition(u, board, now);
                if (c) helpNow.set(u.unit, c);
            }
            const camp = this.campCondition(board, now);
            if (camp) helpNow.set(camp.from, camp);
        }

        // Update or open help calls.
        for (const [from, c] of helpNow) {
            let o = [...this.open.values()].find(x => x.call.kind === 'help' && x.call.from === from);
            if (!o) {
                const caller = units.get(from);
                o = {
                    call: {
                        id: `${this.realm}-${++this.seq}`, kind: 'help', from, why: c.why, at: c.at, foes: c.foes.length, ours: c.ours,
                        foeRoles: roleCount(c.foes), want: 0, asked: [], coming: [], since: now, updatedAt: now,
                    },
                    heldAt: now, arrived: new Map(), lossesBefore: new Set((caller?.losses ?? []).map(l => `${l.name}@${l.at}`)), lost: 0,
                    killsAtOpen: new Map(), foesMax: c.foes.length, oursMax: c.ours,
                };
                for (const u of board.units) if (u.totals) o.killsAtOpen.set(u.unit, u.totals.playerKills);
                this.open.set(o.call.id, o);
                const others = board.units.filter(u => u.unit !== from && u.running && u.centre && u.alive > 0).map(u => dist2(u.centre!, c.at));
                events.push({ kind: 'open', call: o.call.id, from, why: c.why, at: c.at, foes: c.foes.length, ours: c.ours, foeRoles: o.call.foeRoles, nearest: others.length ? Math.round(Math.min(...others)) : null, fight: !!caller?.inFight });
            } else {
                // A worse reason wins: caught and camped over outnumbered over sighted.
                if (WHY_RANK[c.why] > WHY_RANK[o.call.why]) {
                    events.push({ kind: 'why', call: o.call.id, why: c.why, was: o.call.why });
                    o.call.why = c.why;
                }
                o.call.at = c.at;
                o.call.foes = c.foes.length;
                o.call.ours = c.ours;
                o.call.foeRoles = roleCount(c.foes);
                o.heldAt = now;
            }
            o.foesMax = Math.max(o.foesMax, o.call.foes);
            o.oursMax = Math.max(o.oursMax, o.call.ours);
        }

        // What our realm sees at the raid target, all the time; then the muster and our keep's defence.
        this.watchTarget(board, now);
        this.noteSightings(board, now);
        this.stepMuster(board, now, events);
        this.stepDefend(board, now, events);
        this.stepPicket(board, now, events);

        // Every open call: losses, arrivals, asks, close.
        for (const o of [...this.open.values()]) {
            const call = o.call;
            const caller = units.get(call.from);
            if (caller) {
                for (const l of caller.losses) {
                    const k = `${l.name}@${l.at}`;
                    if (!o.lossesBefore.has(k)) { o.lossesBefore.add(k); o.lost++; }
                }
            }
            // A muster's losses: every unit in the raid (a defence's: every unit asked in).
            if (call.kind !== 'help') {
                for (const a of call.asked) {
                    for (const l of units.get(a)?.losses ?? []) {
                        const k = `${a}/${l.name}@${l.at}`;
                        if (!o.lossesBefore.has(k)) { o.lossesBefore.add(k); o.lost++; }
                    }
                }
            }
            for (const u of board.units) {
                if (u.unit === call.from || o.arrived.has(u.unit) || !u.centre) continue;
                const there = call.kind === 'muster' && call.stage === 'rally' ? o.raid!.rally : call.at;
                if (dist2(u.centre, there) <= s.arrive && (call.coming.includes(u.unit) || call.asked.includes(u.unit))) {
                    o.arrived.set(u.unit, now);
                    events.push({ kind: 'arrive', call: call.id, unit: u.unit, ms: now - (call.kind === 'muster' && o.raid ? o.raid.stagedAt : call.since), answered: call.coming.includes(u.unit) });
                }
            }
            if (call.kind === 'help') {
                const end = caller && caller.running && caller.alive === 0 ? 'wiped'
                    : !caller || !caller.running ? 'gone'
                    : now - o.heldAt > s.clearMs ? 'quiet'
                    : now - call.since > s.maxMs ? 'timeout' : null;
                if (end) { events.push(this.close(o, end, board, now)); continue; }
                this.ask(o, board, events);
            }
            call.updatedAt = now;
        }

        const logged = events.map(e => ({ ...e, t: now, realm: this.realm, shadow: !s.enabled }) as LoggedEvent);
        if (this.write) {
            for (const e of logged) appendFileSync(join(this.dir, `${this.realm}-log.jsonl`), `${JSON.stringify(e)}\n`);
            this.publish(now);
        }
        return { board, calls: this.calls(), events: logged };
    }

    /** Is unit `u` in trouble now: outnumbered or caught, in a fight of its own; or a bigger group in sight (sighted). */
    private helpCondition(u: UnitView, board: RealmBoardView, now: number): { why: CallWhy; at: Point3; foes: SeenFoe[]; ours: number } | null {
        const s = this.settings;
        if (!u.running || !u.centre || u.alive === 0) return null;
        const at = { x: Math.round(u.centre.x), y: Math.round(u.centre.y), z: Math.round(u.centre.z) };
        const ours = this.oursNear(board, u.centre, u.unit) + u.alive;
        if (u.inFight) {
            const near = foesNear(board.foes, u.centre, s.nearFoe);
            if (near.length) {
                const recent = u.losses.filter(l => now - l.at <= s.lossMs).length;
                const caught = u.caught || u.fleeing || recent >= Math.max(1, Math.ceil(u.size * s.lossShare));
                const why: CallWhy | null = caught ? 'caught' : near.length > ours ? 'outnumbered' : null;
                if (why) return { why, at, foes: near, ours };
            }
        }
        if (!s.sight) return null;
        // By the raid's target the enemies are its defenders, counted by the muster (the defence hold), not a group coming.
        const raid = this.pendingRaid ?? [...this.open.values()].find(x => x.call.kind === 'muster')?.raid;
        if (raid && dist2(u.centre, raid.target) <= s.defenceRadius + 1000) return null;
        // First sight: the biggest realm in view, so two other realms fighting each other aren't one group.
        const big = biggestRealm(foesNear(board.foes, u.centre, s.sightRadius));
        return big.length >= s.sightMin && big.length > ours ? { why: 'sighted', at, foes: big, ours } : null;
    }

    /** Living members of other units within nearFriend of `p`. */
    private oursNear(board: RealmBoardView, p: Point, except?: string): number {
        let n = 0;
        for (const u of board.units) {
            if (u.unit === except || !u.running) continue;
            for (const m of u.members) if (!m.isDead && dist2(m, p) <= this.settings.nearFriend) n++;
        }
        return n;
    }

    /** Enemies near our portal keep for campMs: the unit that sees most of them calls. */
    private campCondition(board: RealmBoardView, now: number): { from: string; why: CallWhy; at: Point3; foes: SeenFoe[]; ours: number } | null {
        const home = homeOf(this.regionId, this.realm);
        if (!home) return null;
        const s = this.settings;
        const near = foesNear(board.foes, home.keep, s.campRadius);
        if (near.length < s.campFoes) { this.campSince = null; return null; }
        this.campSince ??= now;
        if (now - this.campSince < s.campMs) return null;
        const counts = new Map<string, number>();
        for (const f of near) for (const u of f.units) counts.set(u, (counts.get(u) ?? 0) + 1);
        const from = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (!from) return null;
        // A unit in a fight there calls for itself (outnumbered or caught) first.
        const x = near.reduce((t, f) => t + f.x, 0) / near.length;
        const y = near.reduce((t, f) => t + f.y, 0) / near.length;
        const z = near.reduce((t, f) => t + f.z, 0) / near.length;
        const at = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
        return { from, why: 'camped', at, foes: near, ours: this.oursNear(board, at) };
    }

    /** Who could come: running, not in a fight, enough alive and healthy, the way short. Nearest first. */
    private candidates(o: Open, board: RealmBoardView): { u: UnitView; d: number }[] {
        const s = this.settings;
        const busy = new Set<string>();
        for (const x of this.open.values()) {
            // A defence ask doesn't keep a unit from help (until the units answer defence calls: S2's defence path in rvr.ts).
            if (x === o || x.call.kind !== 'help') continue;
            busy.add(x.call.from);
            for (const a of x.call.asked) busy.add(a);
            for (const c of x.call.coming) busy.add(c);
        }
        return board.units
            .filter(u => u.unit !== o.call.from && u.running && u.centre && !u.inFight && !busy.has(u.unit)
                && u.alive >= Math.max(1, Math.ceil(u.size * s.helperAlive)) && u.hp >= s.helperHp)
            .map(u => ({ u, d: dist2(u.centre!, o.call.at) }))
            .filter(x => x.d <= (o.call.why === 'sighted' ? Math.max(s.reach, s.sightReach) : s.reach))
            .sort((a, b) => a.d - b.d);
    }

    /** Ask the nearest free units until the odds are even (sticky: one asked stays asked while it can still come). */
    private ask(o: Open, board: RealmBoardView, events: DirectorEvent[]): void {
        const call = o.call;
        const units = new Map(board.units.map(u => [u.unit, u]));
        const alive = (name: string) => units.get(name)?.alive ?? 0;
        // Drop asks of units now in a fight of their own, or gone.
        call.asked = call.asked.filter(a => { const u = units.get(a); return !!u && u.running && !u.inFight && u.alive > 0; });
        const counted = new Set([...call.asked, ...call.coming]);
        const bodies = [...counted].reduce((t, a) => t + (o.arrived.has(a) ? 0 : alive(a)), 0);
        // Caught or camped: at least one more, even at even odds.
        let want = Math.max(call.why === 'outnumbered' || counted.size ? 0 : 1, call.foes + 1 - call.ours - bodies);
        if (want > 0) {
            let asked = 0;
            for (const { u, d } of this.candidates(o, board)) {
                if (want <= 0) break;
                if (counted.has(u.unit)) continue;
                call.asked.push(u.unit);
                want -= u.alive;
                asked++;
                events.push({ kind: 'ask', call: call.id, unit: u.unit, dist: Math.round(d) });
            }
            if (!asked && want > 0) this.logRefused(o, board, Math.max(0, want), this.helpBusy(o), call.why === 'sighted' ? Math.max(this.settings.reach, this.settings.sightReach) : this.settings.reach, 1, false, events);
        }
        call.want = Math.max(0, want);
        // Where the helpers stand now (not yet arrived), nearest first: the caller falls back toward them.
        const helpers = [...new Set([...call.coming, ...call.asked])].filter(a => !o.arrived.has(a)).map(a => units.get(a)).filter((u): u is UnitView => !!u && u.running && !!u.centre && u.alive > 0);
        const spots = helpers.map(spotOf).sort((a, b) => dist2(a, call.at) - dist2(b, call.at));
        if (spots.length) call.helpers = spots; else delete call.helpers;
    }

    private close(o: Open, end: string, board: RealmBoardView, now: number): DirectorEvent {
        this.open.delete(o.call.id);
        // A muster counts the whole raid; a help call the caller and those who arrived.
        const involved = o.call.kind !== 'help' ? [...o.call.asked] : [o.call.from, ...o.arrived.keys()];
        let kills: number | null = null;
        for (const u of board.units) {
            if (!involved.includes(u.unit) || !u.totals) continue;
            const was = o.killsAtOpen.get(u.unit);
            if (was === undefined) continue;
            kills = (kills ?? 0) + Math.max(0, u.totals.playerKills - was);
        }
        const caller = board.units.find(u => u.unit === o.call.from);
        return {
            kind: 'close', call: o.call.id, from: o.call.from, why: o.call.why, ms: now - o.call.since, end, lost: o.lost,
            wiped: end === 'wiped' || (!!caller && caller.running && caller.alive === 0),
            asked: [...o.call.asked], coming: [...o.call.coming], arrived: [...o.arrived.keys()], kills, foesMax: o.foesMax, oursMax: o.oursMax,
        };
    }

    private stepMuster(board: RealmBoardView, now: number, events: DirectorEvent[]): void {
        const s = this.settings;
        let o = [...this.open.values()].find(x => x.call.kind === 'muster');
        if (o && (this.raidEnd || !s.muster)) {
            events.push(this.close(o, this.raidEnd ?? 'off', board, now));
            this.raidEndedAt = now;
            this.raidEnd = null;
            o = undefined;
        }
        this.raidEnd = null;
        if (!o && !this.pendingRaid && s.muster && s.raidEveryMs > 0 && now - this.raidEndedAt >= s.raidEveryMs) {
            this.startMuster();
            if (!this.pendingRaid) this.raidEndedAt = now;
        }
        if (this.pendingRaid && s.muster) {
            if (o) this.open.delete(o.call.id);
            const p = this.pendingRaid;
            this.pendingRaid = null;
            o = {
                call: {
                    id: `${this.realm}-${++this.seq}`, kind: 'muster', from: 'director', why: 'raid', at: { ...p.rally }, stage: 'rally', target: { ...p.target },
                    foes: 0, ours: 0, foeRoles: {}, want: 0, asked: [...(p.units ?? this.units)], coming: [], since: now, updatedAt: now,
                },
                heldAt: now, arrived: new Map(), lost: 0, killsAtOpen: new Map(), foesMax: 0, oursMax: 0,
                lossesBefore: new Set(board.units.flatMap(u => u.losses.map(l => `${u.unit}/${l.name}@${l.at}`))),
                raid: { ...p, stagedAt: now, seen: new Map() },
            };
            for (const u of board.units) if (u.totals) o.killsAtOpen.set(u.unit, u.totals.playerKills);
            this.open.set(o.call.id, o);
            events.push({ kind: 'open', call: o.call.id, from: 'director', why: 'raid', at: o.call.at, foes: 0, ours: 0, foeRoles: {} });
        }
        if (!o || !o.raid) return;
        const call = o.call;
        const raid = board.units.filter(u => call.asked.includes(u.unit) && u.running);
        const living = raid.reduce((t, u) => t + u.alive, 0);
        const round = (n: number) => Math.round(n / RAID_ROUND) * RAID_ROUND;
        // On its way: each unit's distance to the target over onWayMs (a unit forming up at home or fighting elsewhere stops counting).
        const progress = o.raid.progress ??= new Map();
        const onWay = new Set<string>();
        for (const u of raid) {
            if (!u.centre) continue;
            const d = dist2(u.centre, o.raid.target);
            const list = progress.get(u.unit) ?? [];
            const first = list[0];
            list.push({ t: now, d });
            while (list.length > 2 && now - list[1]!.t >= s.onWayMs) list.shift();
            progress.set(u.unit, list);
            if (!first || now - first.t < s.onWayMs || list[0]!.d - d >= s.onWayMin) onWay.add(u.unit);
        }
        call.raid = raid.flatMap(u => u.members.map(m => ({
            unit: u.unit, x: round(m.x), y: round(m.y), z: round(m.z), alive: !m.isDead, name: m.name,
            ...(m.objectId ? { id: m.objectId } : {}), ...(m.level ? { level: m.level } : {}), ...(m.rez ? { rez: true } : {}),
            ...(!m.isDead && onWay.has(u.unit) ? { onWay: true } : {}),
        })));
        const point = call.stage === 'rally' ? o.raid.rally : o.raid.target;
        const there = raid.reduce((t, u) => t + u.members.filter(m => !m.isDead && dist2(m, point) <= s.arrive * 1.5).length, 0);
        const near = foesNear(board.foes, point, s.nearFoe);
        call.foes = near.length;
        call.foeRoles = roleCount(near);
        call.ours = there;
        o.foesMax = Math.max(o.foesMax, call.foes);
        o.oursMax = Math.max(o.oursMax, there);
        // Who holds the target now (live read), and the realms seen near it lately (the board holds only those in view now).
        let owner: string | null = null;
        try { owner = this.targetOwner?.() ?? null; } catch { /* unknown */ }
        const seen = this.targetSeen;
        // Defenders: the owner's realm (all of them while the owner is unknown); the third realm: the others there.
        const knownOwner = owner && owner !== this.realm && owner !== 'none' ? owner : null;
        let defenders = 0, third = 0;
        for (const v of seen.values()) { if (!knownOwner || v.realm === knownOwner) defenders++; else third++; }
        // The owners busy elsewhere: of their realm, in a fight far from the target, the third realm by them.
        const away = o.raid.away ??= new Map();
        if (knownOwner) {
            const far = board.foes.filter(f => f.realm === knownOwner && f.inCombat && dist2(f, o.raid!.target) > s.ownersAwayFrom);
            const others = board.foes.filter(f => f.realm !== knownOwner);
            for (const f of far) if (others.some(x => dist2(x, f) <= s.ownersAwayPair)) away.set(f.key, now);
        }
        for (const [k, at] of away) if (now - at > s.defenceMemoryMs) away.delete(k);
        const ownersAway = away.size;
        call.defenders = defenders;
        const hold = (why: MusterHold, on: boolean) => {
            if ((call.hold === why) === on) return;
            if (on) { if (call.hold && call.hold !== why) hold(call.hold, false); call.hold = why; } else delete call.hold;
            events.push({ kind: 'hold', call: call.id, why, on, defenders, living, third, ownersAway });
        };
        if (call.stage === 'rally') {
            const waited = now - o.raid.stagedAt;
            const ready = living > 0 && (there >= s.quorum * living || (waited >= s.rallyMaxMs && there >= 0.5 * living));
            const why = living > 0 ? musterHold({ defenders, third, ownersAway, living }, s) : null;
            if (why) o.raid.heldSince ??= now;
            else delete o.raid.heldSince;
            if (why) hold(why, true); else if (call.hold) hold(call.hold, false);
            if (o.raid.heldSince !== undefined && now - o.raid.heldSince >= s.defenceMaxMs) {
                if (call.hold) hold(call.hold, false);
                events.push(this.close(o, 'defended', board, now));
                this.raidEndedAt = now;
            } else if (ready && !why) {
                call.stage = 'go';
                call.at = { ...o.raid.target };
                o.raid.stagedAt = now;
                o.raid.livingAtGo = living;
                o.arrived.clear();
                events.push({ kind: 'stage', call: call.id, stage: 'go', atRally: there, of: living, defenders, third, ownersAway, owner, lookedAgo: this.lookedAt === null ? null : now - this.lookedAt });
            }
        } else {
            if (raid.some(u => LORD_PHASE.test(u.reason))) o.raid.lordAt = now;
            // Progress: the furthest any raid unit got (phase, then rank, from tactics/raid.ts's `raid <phase>: rank N: ...`).
            const best = Math.max(0, ...raid.map(u => raidProgress(u.reason)));
            if (best > (o.raid.furthest ?? 0)) { o.raid.furthest = best; o.raid.furthestAt = now; }
            const gone = now - o.raid.stagedAt;
            const onLord = o.raid.lordAt !== undefined && now - o.raid.lordAt <= s.lordGraceMs;
            const late = gone > s.goMaxMs;
            hold('lord', late && onLord && gone <= s.goMaxMs + s.lordMaxMs);
            // The progress hold (S2, 18:51: hibernia-4 timed out at 941 s just as it had taken the wall casters): past goMaxMs the clock
            // waits while the raid got further within progressGraceMs, up to progressMaxMs in all.
            const progressing = o.raid.furthestAt !== undefined && now - o.raid.furthestAt <= s.progressGraceMs && gone <= s.progressMaxMs;
            if (call.hold !== 'lord') hold('progress', late && progressing);
            const end = owner === this.realm ? 'captured'
                : living < s.raidBreak * (o.raid.livingAtGo ?? living) ? 'broken'
                : late && call.hold !== 'lord' && call.hold !== 'progress' ? 'timeout' : null;
            if (end) {
                if (call.hold) hold(call.hold, false);
                events.push(this.close(o, end, board, now));
                this.raidEndedAt = now;
            }
        }
    }

    /** Our keep (the raid plan's target keep) while our realm holds it: the defence call. */
    private ourKeep(): Point3 | null {
        let owner: string | null = null;
        try { owner = this.targetOwner?.() ?? null; } catch { /* unknown */ }
        if (owner !== this.realm) return null;
        const faste = BATTLEGROUND_LAYOUTS[this.regionId]?.keeps.find(k => !k.portal);
        return faste ? { x: faste.x, y: faste.y, z: faste.z } : null;
    }

    /** The picket while we hold the keep: kept while it is free, replaced after picketMs when another is. */
    private stepPicket(board: RealmBoardView, now: number, events: DirectorEvent[]): void {
        const s = this.settings;
        const keep = s.picket ? this.ourKeep() : null;
        const was = this.picketNow?.unit ?? null;
        const set = (p: (Picket & { since: number }) | null, why: string) => {
            this.picketNow = p;
            if ((p?.unit ?? null) !== was) events.push({ kind: 'picket', unit: p?.unit ?? null, was, why });
        };
        if (!keep) { if (this.picketNow) set(null, 'the keep is not ours'); return; }
        const home = homeOf(this.regionId, this.realm);
        const dx = (home?.keep.x ?? keep.x) - keep.x, dy = (home?.keep.y ?? keep.y) - keep.y, l = Math.hypot(dx, dy) || 1;
        // Toward home, turned up to 60° to keep as far as it can from where raiders stage (live 18:17: Midgard's spot stood 2263 from the
        // gate, beside the stage, and its picket met Albion's raid there). Dry ground only.
        const stage = PICKET_STAGE[this.regionId] ?? null;
        let at = { x: Math.round(keep.x + dx / l * s.picketFrom), y: Math.round(keep.y + dy / l * s.picketFrom), z: keep.z };
        if (stage) {
            const a0 = Math.atan2(dy, dx);
            const spots = [-60, -45, -30, -15, 0, 15, 30, 45, 60].map(t => a0 + t * Math.PI / 180)
                .map(a => ({ x: Math.round(keep.x + Math.cos(a) * s.picketFrom), y: Math.round(keep.y + Math.sin(a) * s.picketFrom), z: keep.z }))
                .filter(p => isDry(this.regionId, p));
            if (spots.length) at = spots.reduce((b, p) => (dist2(p, stage) > dist2(b, stage) ? p : b));
        }
        const busy = new Set<string>();
        for (const x of this.open.values()) { if (x.call.kind === 'help') busy.add(x.call.from); for (const a of x.call.asked) busy.add(a); for (const c of x.call.coming) busy.add(c); }
        const ok = (u: UnitView) => u.running && !!u.centre && u.alive > 0 && !busy.has(u.unit) && u.hp >= s.helperHp;
        const cur = this.picketNow ? board.units.find(u => u.unit === this.picketNow!.unit) : undefined;
        // Squads first (a main group is worth more in the field), then the nearest to the spot; the last picket only if nobody else.
        const free = board.units.filter(u => ok(u) && !u.inFight)
            .sort((a, b) => Number(a.size > 3) - Number(b.size > 3) || Number(a.unit === was) - Number(b.unit === was) || dist2(a.centre!, at) - dist2(b.centre!, at));
        // Kept while it can, for picketMs, unless it is a main group and a squad is free now (live 18:11: midgard stood picket because
        // no squad was out yet at the start).
        const keepIt = cur && cur.running && cur.alive > 0 && now - this.picketNow!.since < s.picketMs && !(cur.size > 3 && free.some(u => u.size <= 3));
        if (keepIt) { this.picketNow = { ...this.picketNow!, at, keep }; return; }
        const pick = free[0];
        if (pick) set({ unit: pick.unit, at, keep, since: now }, `free${pick.size <= 3 ? ', a squad' : ''}, ${Math.round(dist2(pick.centre!, at))} from the spot`);
        else if (cur && cur.running && cur.alive > 0) this.picketNow = { ...this.picketNow!, at, keep, since: now };
        else if (this.picketNow) set(null, 'nobody free');
    }

    /** Where our realm sees enemy players now, by 2000-cell; kept SIGHTING_MS. */
    private noteSightings(board: RealmBoardView, now: number): void {
        const cells = new Map<string, SeenFoe[]>();
        for (const f of board.foes) {
            const k = `${Math.round(f.x / SIGHTING_CELL)}:${Math.round(f.y / SIGHTING_CELL)}`;
            cells.set(k, [...(cells.get(k) ?? []), f]);
        }
        for (const [k, fs] of cells) {
            const had = this.sightings.get(k);
            const x = Math.round(fs.reduce((t, f) => t + f.x, 0) / fs.length), y = Math.round(fs.reduce((t, f) => t + f.y, 0) / fs.length);
            this.sightings.set(k, { x, y, n: Math.max(fs.length, had && now - had.at < 60_000 ? had.n : 0), at: now });
        }
        for (const [k, v] of this.sightings) if (now - v.at > SIGHTING_MS) this.sightings.delete(k);
    }

    /** Keep targetSeen and lookedAt (the raid plan's target) up to date from this board. */
    private watchTarget(board: RealmBoardView, now: number): void {
        const s = this.settings;
        let plan: RaidPlan | null = null;
        try { plan = this.raidPlan?.() ?? defaultRaid(this.realm, this.regionId); } catch { plan = null; }
        if (!plan) return;
        for (const f of foesNear(board.foes, plan.target, s.defenceRadius)) this.targetSeen.set(f.key, { at: now, realm: f.realm });
        for (const [k, v] of this.targetSeen) if (now - v.at > s.defenceMemoryMs) this.targetSeen.delete(k);
        if (board.units.some(u => u.running && u.members.some(m => !m.isDead && dist2(m, plan!.target) <= s.defenceRadius))) this.lookedAt = now;
    }

    private stepDefend(board: RealmBoardView, now: number, events: DirectorEvent[]): void {
        const s = this.settings;
        let o = [...this.open.values()].find(x => x.call.kind === 'defend');
        const keep = s.defend ? this.ourKeep() : null;
        if (!keep) {
            this.keepSeen.clear();
            if (o) events.push(this.close(o, s.defend ? 'lost' : 'off', board, now));
            return;
        }
        const near = foesNear(board.foes, keep, s.defendRadius);
        for (const f of near) this.keepSeen.set(f.key, now);
        for (const [k, at] of this.keepSeen) if (now - at > s.defendMemoryMs) this.keepSeen.delete(k);
        const attackers = this.keepSeen.size;
        const units = new Map(board.units.map(u => [u.unit, u]));
        const ours = board.units.reduce((t, u) => t + (u.running ? u.members.filter(m => !m.isDead && dist2(m, keep) <= s.defendRadius).length : 0), 0);
        if (!o) {
            if (attackers < s.defendMin) return;
            o = {
                call: {
                    id: `${this.realm}-${++this.seq}`, kind: 'defend', from: 'director', why: 'keep', at: { ...keep }, target: { ...keep },
                    foes: attackers, ours, foeRoles: roleCount(near), want: 0, asked: [], coming: [], since: now, updatedAt: now,
                },
                heldAt: now, arrived: new Map(), lost: 0, killsAtOpen: new Map(), foesMax: attackers, oursMax: ours,
                lossesBefore: new Set(board.units.flatMap(u => u.losses.map(l => `${u.unit}/${l.name}@${l.at}`))),
            };
            for (const u of board.units) if (u.totals) o.killsAtOpen.set(u.unit, u.totals.playerKills);
            this.open.set(o.call.id, o);
            events.push({ kind: 'open', call: o.call.id, from: 'director', why: 'keep', at: o.call.at, foes: attackers, ours, foeRoles: o.call.foeRoles });
        }
        const call = o.call;
        call.foes = attackers;
        call.ours = ours;
        if (near.length) call.foeRoles = roleCount(near);
        if (near.length) o.heldAt = now;
        o.foesMax = Math.max(o.foesMax, attackers);
        o.oursMax = Math.max(o.oursMax, ours);
        const clearMs = o.foesMax >= s.defendBigFoes ? Math.max(s.defendClearMs, s.defendClearBigMs) : s.defendClearMs;
        const end = now - o.heldAt > clearMs ? 'quiet' : now - call.since > s.defendMaxMs ? 'timeout' : null;
        if (end) { events.push(this.close(o, end, board, now)); this.keepSeen.clear(); return; }
        // Ask in the nearest free units until ours there (and those on the way) outnumber the attackers: at most defendShare of
        // the running units, so a feint doesn't empty the field. A unit already there counts without being asked.
        call.asked = call.asked.filter(a => { const u = units.get(a); return !!u && u.running && u.alive > 0; });
        const running = board.units.filter(u => u.running && u.alive > 0).length;
        const cap = Math.max(1, Math.ceil(running * s.defendShare));
        const coming = [...new Set([...call.asked, ...call.coming])].reduce((t, a) => {
            const u = units.get(a);
            return t + (!u || !u.centre || dist2(u.centre, keep) <= s.defendRadius ? 0 : u.alive);
        }, 0);
        let want = attackers + 1 - ours - coming;
        if (want > 0 && call.asked.length < cap) {
            const busy = new Set<string>();
            for (const x of this.open.values()) if (x !== o && x.call.kind === 'help') { busy.add(x.call.from); for (const c of x.call.coming) busy.add(c); }
            const free = board.units
                .filter(u => !call.asked.includes(u.unit) && !this.refusal(u, keep, { busy, reach: s.defendReach, minSize: s.defendMinSize, fightWithin: s.defendRadius }))
                .map(u => ({ u, d: dist2(u.centre!, keep) }))
                .sort((a, b) => a.d - b.d);
            const before = call.asked.length;
            // Only a defence that can win (as the raid's go): ours there and those we could send must outnumber the attackers. A lone
            // group sent at an equal raid at the gate dies (live 18:17, midgard-4: midgard went in alone, 6 against 6, lost 5 of 6, no
            // kill). Two attackers or fewer are always answered.
            const could = ours + coming + free.slice(0, Math.max(0, cap - call.asked.length)).reduce((t, x) => t + (dist2(x.u.centre!, keep) > s.defendRadius ? x.u.alive : 0), 0);
            if (attackers > 2 && could < attackers + 1 && !call.asked.length) {
                this.logRefused(o, board, want, busy, s.defendReach, s.defendMinSize, true, events, `too few to win: ${could} against ${attackers}`);
                call.want = Math.max(0, want);
                return;
            }
            for (const { u, d } of free) {
                if (want <= 0 || call.asked.length >= cap) break;
                call.asked.push(u.unit);
                if (d > s.defendRadius) want -= u.alive;
                events.push({ kind: 'ask', call: call.id, unit: u.unit, dist: Math.round(d) });
            }
            if (call.asked.length === before && want > 0) this.logRefused(o, board, want, busy, s.defendReach, s.defendMinSize, true, events);
        }
        call.want = Math.max(0, want);
    }

    /** Units busy with another help call (calling, asked or coming): not asked for this one. */
    private helpBusy(o: Open): Set<string> {
        const busy = new Set<string>();
        for (const x of this.open.values()) {
            if (x === o || x.call.kind !== 'help') continue;
            busy.add(x.call.from);
            for (const a of x.call.asked) busy.add(a);
            for (const c of x.call.coming) busy.add(c);
        }
        return busy;
    }

    /** Why `u` can't be asked to `at`, or null when it can. fightWithin: a unit in a fight that near `at` still can (a defence). */
    private refusal(u: UnitView, at: Point, o: { busy: ReadonlySet<string>; reach: number; minSize: number; fightWithin?: number }): string | null {
        const s = this.settings;
        if (!u.running) return 'not running';
        if (!u.centre) return 'none alive in the region';
        if (u.size < o.minSize) return `a squad of ${u.size}`;
        if (u.alive < Math.max(1, Math.ceil(u.size * s.helperAlive))) return `${u.alive} of ${u.size} alive`;
        if (u.hp < s.helperHp) return `health ${Math.round(u.hp)}`;
        const d = dist2(u.centre, at);
        if (u.inFight && !(o.fightWithin !== undefined && d <= o.fightWithin)) return `in a fight ${Math.round(d)} away`;
        if (o.busy.has(u.unit)) return 'on another help call';
        if (d > o.reach) return `${Math.round(d)} away`;
        return null;
    }

    /** Log why every other unit was passed over (R2's carry-over 2; S2 at 14:05: two defend calls asked nobody), throttled per call. */
    private logRefused(o: Open, board: RealmBoardView, want: number, busy: ReadonlySet<string>, reach: number, minSize: number, defence: boolean, events: DirectorEvent[], all?: string): void {
        const now = board.at;
        if (o.refusedAt !== undefined && now - o.refusedAt < REFUSED_EVERY_MS) return;
        const at = o.call.at;
        const units = board.units
            .filter(u => u.unit !== o.call.from && !o.call.asked.includes(u.unit) && !o.call.coming.includes(u.unit))
            .map(u => ({ unit: u.unit, why: this.refusal(u, at, { busy, reach, minSize, ...(defence ? { fightWithin: this.settings.defendRadius } : {}) }) ?? all ?? 'free' }));
        if (!units.length) return;
        o.refusedAt = now;
        events.push({ kind: 'refused', call: o.call.id, want, units });
    }

    private readAnswers(): AnswersFile[] {
        if (!this.write) return [];
        const out: AnswersFile[] = [];
        const dir = join(this.dir, 'answers');
        let names: string[] = [];
        try { names = readdirSync(dir); } catch { return out; }
        for (const n of names) {
            if (!n.endsWith('.json')) continue;
            try {
                const f = JSON.parse(readFileSync(join(dir, n), 'utf8')) as AnswersFile;
                if (f && typeof f.unit === 'string' && f.answers && typeof f.answers === 'object') out.push(f);
            } catch { /* half written or broken: next time */ }
        }
        return out;
    }

    /**
     * Close every open call as `why` ('stopped' when field.ts stops), log it, and write the file off. A restart then
     * doesn't read as a broken raid or a wiped call. Returns the close events (for the caller's ledger).
     */
    closeAll(why = 'stopped', now = Date.now()): LoggedEvent[] {
        const board = this.last ?? { realm: this.realm, at: now, units: [], foes: [] };
        const events: DirectorEvent[] = [];
        for (const o of [...this.open.values()]) {
            const e = this.close(o, why, board, now);
            if (e.kind === 'close') e.wiped = false;
            events.push(e);
        }
        this.pendingRaid = null;
        const logged = events.map(e => ({ ...e, t: now, realm: this.realm, shadow: !this.settings.enabled }) as LoggedEvent);
        if (this.write) {
            for (const e of logged) { try { appendFileSync(join(this.dir, `${this.realm}-log.jsonl`), `${JSON.stringify(e)}\n`); } catch { /* gone */ } }
            const file: CallsFile = { v: 1, realm: this.realm, at: now, enabled: false, calls: [] };
            try { writeAtomic(join(this.dir, `${this.realm}.json`), JSON.stringify(file)); } catch { /* gone */ }
        }
        return logged;
    }

    /** Write <dir>/<realm>.json: the calls while on, none while off. */
    private publish(now: number): void {
        if (!this.write) return;
        const on = this.settings.enabled;
        const units = on && this.last ? this.last.units.filter(u => u.running && u.centre && u.alive > 0).map(spotOf) : [];
        const picket = on && this.picketNow ? { unit: this.picketNow.unit, at: this.picketNow.at, keep: this.picketNow.keep } : null;
        const seen = on ? [...this.sightings.values()] : [];
        const file: CallsFile = { v: 1, realm: this.realm, at: now, enabled: on, calls: on ? this.calls() : [], ...(on ? { units, seen } : {}), ...(picket ? { picket } : {}) };
        writeAtomic(join(this.dir, `${this.realm}.json`), JSON.stringify(file));
    }
}

function writeAtomic(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── the units' side

/** A calls file older than this is a director that stopped: no calls. */
const CALLS_STALE_MS = 20_000;
const WATCH_EVERY_MS = 2000;

/** The realm's open calls for `unit` from a calls file: none while off or stale, never the unit's own. */
export function callsFor(file: CallsFile | null, unit: string, now = Date.now()): RealmCall[] {
    if (!file || file.v !== 1 || !file.enabled || now - file.at > CALLS_STALE_MS) return [];
    return (file.calls ?? []).filter(c => c.from !== unit);
}

/** The unit's own open help calls (none while off or stale): where its helpers are. */
export function ownCallsFor(file: CallsFile | null, unit: string, now = Date.now()): RealmCall[] {
    if (!file || file.v !== 1 || !file.enabled || now - file.at > CALLS_STALE_MS) return [];
    return (file.calls ?? []).filter(c => c.from === unit && c.kind === 'help');
}

/** The picket the director names this unit for, or null. */
export function picketFor(file: CallsFile | null, unit: string, now = Date.now()): Picket | null {
    if (!file || file.v !== 1 || !file.enabled || now - file.at > CALLS_STALE_MS) return null;
    return file.picket?.unit === unit ? file.picket : null;
}

/** Where the realm saw enemies lately (none while off or stale). */
export function seenFor(file: CallsFile | null, now = Date.now()): Sighting[] {
    if (!file || file.v !== 1 || !file.enabled || now - file.at > CALLS_STALE_MS) return [];
    return file.seen ?? [];
}

/** The realm's other running units (none while off or stale). */
export function unitsFor(file: CallsFile | null, unit: string, now = Date.now()): UnitSpot[] {
    if (!file || file.v !== 1 || !file.enabled || now - file.at > CALLS_STALE_MS) return [];
    return (file.units ?? []).filter(u => u.unit !== unit);
}

/** The calls that name `unit` (asked, or a muster it is in), nearest first when `centre` is given. */
export function askedOf(calls: readonly RealmCall[], unit: string, centre?: Point | null): RealmCall[] {
    const mine = calls.filter(c => c.asked.includes(unit));
    return centre ? mine.sort((a, b) => dist2(a.at, centre) - dist2(b.at, centre)) : mine;
}

export interface CallWatch {
    calls: () => RealmCall[];
    /** The unit's own open help calls (with `helpers`). */
    mine: () => RealmCall[];
    /** The realm's other running units, where they stand. */
    units: () => UnitSpot[];
    /** This unit's picket duty (within sight of our keep), or null. */
    picket: () => Picket | null;
    /** Where the realm saw enemies lately. */
    seen: () => Sighting[];
    answer: (callId: string, state: AnswerState, why?: string) => void;
    stop: () => void;
}

/** Reads the realm's calls file every 2 s until stopped. calls() is the latest answer (none before the first, or on any error). */
export function callWatch(unit: string, realm: PlayerRealm, dir = DIRECTOR_DIR): CallWatch {
    const path = join(dir, `${realm}.json`);
    const answersPath = join(dir, 'answers', `${unit}.json`);
    let file: CallsFile | null = null;
    let mtime = 0;
    let stopped = false;
    const read = () => {
        try {
            const m = statSync(path).mtimeMs;
            if (m === mtime) return;
            file = JSON.parse(readFileSync(path, 'utf8')) as CallsFile;
            mtime = m;
        } catch { /* no director, or a half-read file: keep the last */ }
    };
    read();
    const timer = setInterval(() => { if (!stopped) read(); }, WATCH_EVERY_MS);
    (timer as { unref?: () => void }).unref?.();
    let answers: AnswersFile = { v: 1, unit, answers: {} };
    try { if (existsSync(answersPath)) answers = { ...JSON.parse(readFileSync(answersPath, 'utf8')), unit, v: 1 }; } catch { /* start over */ }
    return {
        calls: () => callsFor(file, unit),
        mine: () => ownCallsFor(file, unit),
        units: () => unitsFor(file, unit),
        picket: () => picketFor(file, unit),
        seen: () => seenFor(file),
        answer: (callId, state, why = '') => {
            answers.answers[callId] = { state, why: why.slice(0, 200), at: Date.now() };
            // Keep the newest 20.
            const keep = Object.entries(answers.answers).sort((a, b) => b[1].at - a[1].at).slice(0, 20);
            answers.answers = Object.fromEntries(keep);
            try {
                mkdirSync(join(dir, 'answers'), { recursive: true });
                writeAtomic(answersPath, JSON.stringify(answers));
            } catch { /* the director misses this answer; it still sees the unit arrive */ }
        },
        stop: () => { stopped = true; clearInterval(timer); },
    };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── running it alone

export interface StartDirectorOptions extends DirectorOptions {
    gateway?: string;
    /** Authorization headers per unit (field.ts leaderAuth); none by default (the gateway's default auth allows all). */
    auth?: (unit: string) => Record<string, string>;
    everyMs?: number;
    /** Called after each update (R1's ledger). */
    onUpdate?: (u: DirectorUpdate) => void;
}

/** Cursors so a frame carries no events, plan or report it already sent. */
interface Cursor { runId: string | null; events: number; planRev: number; reportRev: number; passive: number; boot: number }

/** Read one unit's frame from the gateway, light: no run events, plan or report it already had. */
export async function readFrame(gateway: string, unit: string, cursor: Cursor, headers: Record<string, string> = {}): Promise<GroupFrame | null> {
    const q = new URLSearchParams();
    if (cursor.runId) {
        q.set('run', cursor.runId);
        q.set('events', String(cursor.events));
        q.set('planRev', String(cursor.planRev));
        q.set('reportRev', String(cursor.reportRev));
    }
    q.set('passive', String(cursor.passive));
    try {
        const res = await fetch(`${gateway}/groups/${encodeURIComponent(unit)}/live?${q}`, { headers, signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        const frame = (await res.json()) as GroupFrame;
        if (frame.boot !== cursor.boot) { cursor.boot = frame.boot; cursor.passive = 0; }
        cursor.passive = frame.passive?.seq ?? cursor.passive;
        const run = frame.run;
        if (run) {
            cursor.runId = run.runId;
            cursor.events = run.eventSeq;
            cursor.planRev = run.planRev;
            if (run.report !== undefined) cursor.reportRev = run.reportRev;
        }
        return frame;
    } catch {
        return null;
    }
}

/** A director that polls the gateway itself. stop() ends it; the calls file is written off on the way out. */
export function startDirector(opts: StartDirectorOptions): { director: RealmDirector; stop: () => void } {
    const director = new RealmDirector(opts);
    const gateway = opts.gateway ?? process.env.GATEWAY_HTTP ?? 'http://127.0.0.1:7780';
    const cursors = new Map<string, Cursor>(opts.units.map(u => [u, { runId: null, events: 0, planRev: 0, reportRev: 0, passive: 0, boot: 0 }]));
    let stopped = false;
    let busy = false;
    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const frames: Record<string, GroupFrame | null> = {};
            await Promise.all(opts.units.map(async u => { frames[u] = await readFrame(gateway, u, cursors.get(u)!, opts.auth?.(u) ?? {}); }));
            if (stopped) return;
            const out = director.update(frames, Date.now());
            opts.onUpdate?.(out);
        } catch (error) {
            console.error(`director ${opts.realm}: ${(error as Error).message}`);
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(() => void tick(), opts.everyMs ?? WATCH_EVERY_MS);
    void tick();
    return {
        director,
        // Stop the director before the units (field.ts): its open calls close as 'stopped', not 'broken' or 'gone'.
        stop: () => {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            const now = Date.now();
            const events = director.closeAll('stopped', now);
            if (events.length) {
                try { opts.onUpdate?.({ board: director.lastBoard() ?? { realm: director.realm, at: now, units: [], foes: [] }, calls: [], events }); } catch { /* the ledger is gone */ }
            }
        },
    };
}

export type { FoeRole, SeenFoe, SeenRole, UnitView };
