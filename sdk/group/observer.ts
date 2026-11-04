// The observer watches a group run and says how well it went: per-fight and
// per-member metrics, rule-based findings about coordination problems, and a
// report (JSON + Markdown) an agent reads to decide what to change next.
//
// It only reads: board pictures (sampled once a second) and board events. It
// works the same for a coordinated run and for a passive watch over observe-mode
// connections (no orders: the phase is inferred from the picture).
//
// A run that met enemy players (RvR) also gets player kills, deaths to players,
// realm points and engagements, and leaves out the findings that only fit PvE.
//
// A member with a pet also gets its share of the fight and the pet-* findings. One
// with none gets nothing new: not a key in the report, not a line or column in the text.

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { findBotEnv } from '../index';
import { isAlive, type Blackboard } from './blackboard';
import type { GroupEvent, GroupPicture, MemberCombat, MemberReport, Phase } from './types';
import type { LiveReport } from './wire';

export interface Finding {
    severity: 'high' | 'medium' | 'low';
    /**
     * 'aggro', 'deaths', 'interrupts', 'idle', 'downtime', 'adds', 'positioning', 'duplicates', 'pace', 'retreats', 'no-kills',
     * 'pet-mezz', 'pet-aggro', 'pet-idle', 'pet-down';
     * a strategy's findings() adds its own ('no-tank' from pveLeveling's; 'strategy' when it threw).
     */
    topic: string;
    member?: string;
    issue: string;
    evidence: string;
    /** What to change, naming the strategy settings or behaviours involved. */
    suggestion: string;
}

export interface FightSummary {
    /** Seconds since the run started. */
    start: number;
    durationMs: number;
    focus: string[];
    kills: string[];
    /** Distinct attackers beyond the first. */
    adds: number;
    maxAttackers: number;
    /**
     * % of samples (with a living tank and a known focus) in which the focus targeted the tank.
     * The board keeps a mob's last target while it runs or is out of reach (the server then
     * reports none), so those samples count too.
     */
    tankHold: number | null;
    /**
     * Ms from the fight's first engage sample to each member's first nuke (0 when it came
     * before that sample); null for a nuker that stood through the engage without one.
     * Coordinated fights only: a passive watch knows no activities.
     */
    openerMs: Record<string, number | null>;
    deaths: string[];
    retreated: boolean;
    outcome: 'won' | 'retreated' | 'wiped' | 'lost' | 'unfinished';
    /** RvR: distinct enemy players among the fight's focus and attackers, and their realms. */
    enemyPlayers?: number;
    enemyRealms?: string[];
}

/** A member's pet in the run. */
export interface PetStats {
    /** What the group keeps up for it (Capabilities.pet); null for one it has from elsewhere, an earlier script's charm say. */
    kind: 'main' | 'fnf' | null;
    /** What its window pet last went by; '' for pets with no window. */
    name: string;
    /** % of samples with the owner alive that its window pet was up; null for pets with no window. */
    up: number | null;
    /** % of engaged samples (pet up, focus alive and not crowd-controlled, its hold over: GroupObserver's petHoldMs) with the focus as its target; null with no such sample. */
    onFocus: number | null;
    /** How many samples that is, for what onFocus is worth. */
    focusSamples: number;
    /** % of the samples behind the tank hold that the focus was on it; null with no such sample. A blow it took for its owner isn't one: `intercepted`. */
    drewFocus: number | null;
    /**
     * % of those samples that read on it through its own interception, and for as long as that read so: the blow was at its owner, and the swing's 0xBC names who took it (AttackComponent.cs:1900). Absent with none,
     * and from an older client. They count as not held all the same.
     */
    intercepted?: number;
    /** % of the samples behind `up` that it was down after its owner's death took it (GamePlayer.cs:5988-5989), until the next pet. Absent with none. */
    lostToOwner?: number;
    /** Times it died: a release or a region change is no death, and a dead owner's pet isn't counted. */
    deaths: number;
    /** Summons that landed. A fire-and-forget pet's are its new object ids, as those casts count as nukes. */
    summons: number;
    /** Crowd control its attacks broke. */
    brokeCc: number;
}

export interface MemberStats {
    role: string;
    className: string;
    level: string;
    xp: number;
    xpPerHour: number;
    deaths: number;
    /** Successful actions by kind (heal, nuke, cc, pull, kill, buff). */
    actions: Record<string, number>;
    /** Failed actions by reason (interrupted, out_of_range, no_power, ...). */
    failures: Record<string, number>;
    /** % of engaged time (alive) spent idle, and why. */
    idleInFights: number;
    idleReasons: Record<string, number>;
    /** % of fight samples a monster targeted this member. */
    targeted: number;
    /** % of fight samples a non-tank stood within 250 of an attacker. */
    inMelee: number;
    /** % of engaged time (alive) spent walking (activity 'move': position(), closing in, ...); null for the tank. */
    movingInFights: number | null;
    /** Median of the fights' openerMs for this member; null when it never nuked. */
    openerMs: number | null;
    /** Fights in which this nuker was engaged and alive but never started a nuke. */
    fightsWithoutNuke: number;
    minHp: number;
    /** % of run time the group waited for this member, by reason (health, power, dead, away). */
    waitedFor: Record<string, number>;
    /** RvR: realm points gained in the run. */
    realmPoints?: number;
    /** Deaths by killer: 'player:<realm>', 'pet:<realm>' (an NPC of another player realm with the pet flag), 'guard:<realm>' (one without: a keep guard), 'npc:<name>' or 'unknown'. */
    killedBy?: Record<string, number>;
    /** Bot folder under bots/. */
    bot?: string;
    /** The behaviours it ran, in order, and whose list that was. */
    routine?: string[];
    routineFrom?: 'character' | 'role' | 'strategy';
    /** Damage dealt, and styles landed and missed, from its own client's messages. */
    dealt?: number;
    styles?: Record<string, number>;
    missedStyles?: number;
    /** Damage its pets dealt, from the same messages. Only with `pet`. */
    petDealt?: number;
    /** Absent for a member that had no pet and can't summon one. */
    pet?: PetStats;
}

export interface RunReport {
    group: string;
    strategy: string;
    startedAt: string;
    durationMs: number;
    totals: {
        kills: number; deaths: number; wipes: number; retreats: number; fights: number;
        killsPerHour: number; xpPerHour: number; avgFightMs: number;
        /** % of time not fighting or pulling. */
        downtime: number;
        tankHold: number | null;
        /**
         * RvR: enemy players killed, members killed by players (their pets and keep guards too),
         * realm points gained (group total) and per hour.
         */
        playerKills?: number;
        deathsToPlayers?: number;
        realmPoints?: number;
        rpPerHour?: number;
        /** RvR: distinct enemy players the group saw, and fights with at least one enemy player. */
        enemiesSeen?: number;
        engagements?: number;
    };
    /** % of run time per phase. */
    phases: Partial<Record<Phase, number>>;
    members: Record<string, MemberStats>;
    fights: FightSummary[];
    findings: Finding[];
    /** Key events, "mm:ss text". */
    timeline: string[];
    /** Change against the previous run in the same history file. */
    previous?: Record<string, string>;
}

/** What the samples say about a member's pet. */
interface PetTrack {
    kind: PetStats['kind'];
    name: string;
    /** Samples with the owner alive and a report that says (MemberReport.pet absent: an older runner), and those with the pet up. */
    samples: number; up: number;
    focusSamples: number; onFocus: number;
    /** Hold samples with the focus on it. */
    drewFocus: number;
    /** petIntercepts so far and when it last grew, the focus that put on the pet while that reads so, and the hold samples that were. */
    intercepts: number; interceptAt: number; steppedIn: number | null; intercepted: number;
    /** Its owner's death took it and no new one has come yet, and the samples that went so. */
    ownerGone: boolean; afterOwner: number;
    deaths: number; brokeCc: number;
    /** Pets with no window (MemberReport.summons): any seen, those in the last sample, and new ones for a fire-and-forget caster. */
    hadSummons: boolean; summons: number[]; fnfSummons: number;
}

interface Track {
    role: string; className: string; level0: number; level1: number; xp0: number; xp1: number;
    deaths: number; actions: Record<string, number>; failures: Record<string, number>;
    fightSamples: number; engageSamples: number; idle: number; idleReasons: Record<string, number>; targeted: number; inMelee: number; moving: number; minHp: number;
    waitMs: Record<string, number>;
    /** Realm points at the first report that carried them (null until one did), and the highest since. */
    rp0: number | null; rp1: number;
    killedBy: Record<string, number>;
    bot?: string;
    combat?: MemberCombat;
    pet: PetTrack;
}

interface OpenFight extends Omit<FightSummary, 'durationMs' | 'tankHold' | 'outcome' | 'adds' | 'openerMs' | 'enemyPlayers' | 'enemyRealms'> {
    at: number; attackers: Set<number>; holdSamples: number; heldSamples: number;
    /** The first sample under the coordinator's engage order; members alive in such samples; each member's first nuke. */
    engageAt: number | null; engaged: Set<string>; firstNuke: Map<string, number>;
    /** Enemy players among the focus and attackers: realm by region:objectId. */
    enemies: Map<string, string>;
}

const pct = (a: number, b: number) => b > 0 ? Math.round(100 * a / b) : 0;
const inc = (r: Record<string, number>, k: string, by = 1) => { r[k] = (r[k] ?? 0) + by; };
const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
    return s.length % 2 ? s[h]! : Math.round((s[h - 1]! + s[h]!) / 2);
};
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** Realms of players: an NPC of one (a pet, a keep guard) that kills a member is an RvR death. Monsters are 'none'. */
const PLAYER_REALMS = new Set(['albion', 'midgard', 'hibernia']);
/** A retreat ordered again this soon after the last one ended goes on with it. */
const RETREAT_RESUME_MS = 5000;
/** What a member's track counts: an event before its first sample waits for that. */
const CREDITED: ReadonlySet<GroupEvent['kind']> = new Set(['death', 'note', 'result']);
/** A mob reading on a pet this soon after the pet took a blow for its owner reads so through that: a mob's next swing comes in this. */
const INTERCEPT_READS_MS = 4000;
/** pet-aggro wants this much fight time behind its share: "on Pethun's pet 100%" of a 2 s fight says nothing (20261103-164244). */
const PET_AGGRO_FIGHT_MS = 10_000;

/** One sample of a member's pet. A dead owner's pet went with it (GamePlayer.cs:5988-5989), which is the deaths finding's and not pet up's. */
function samplePet(t: PetTrack, m: MemberReport, at: number): void {
    t.kind = m.capabilities.pet ?? null;
    if (m.pet?.name) t.name = m.pet.name;
    if (m.isDead) t.ownerGone = true;
    else if (m.pet) t.ownerGone = false;
    if (m.pet !== undefined && !m.isDead) {
        t.samples++;
        if (m.pet) t.up++;
        else if (t.ownerGone) t.afterOwner++;
    }
    const intercepts = m.combat?.petIntercepts ?? 0;
    if (intercepts > t.intercepts) { t.intercepts = intercepts; t.interceptAt = at; }
    const out = m.summons ?? [];
    if (out.length) t.hadSummons = true;
    if (t.kind === 'fnf') t.fnfSummons += out.filter(id => !t.summons.includes(id)).length;
    t.summons = out;
}

/**
 * One hold sample for a pet, with the focus reading on it (`on`, its id) or not. A pet that steps in front of its owner reads as the mob on it, and what that starts reads the same until the mob is seen
 * elsewhere: a blow at the owner isn't a focus it drew.
 */
function holdSample(t: PetTrack, on: number | null, at: number): void {
    if (on === null) { t.steppedIn = null; return; }
    if (at - t.interceptAt <= INTERCEPT_READS_MS) t.steppedIn = on;
    if (t.steppedIn === on) t.intercepted++;
    else t.drewFocus++;
}

/** A member's pet stats; undefined for one with no pet, up or possible. `holdSamples`: the group's, behind the tank hold. */
function petStats(t: Track, holdSamples: number): PetStats | undefined {
    const p = t.pet;
    if (!p.kind && !p.up && !p.hadSummons) return undefined;
    return {
        kind: p.kind, name: p.name,
        // A client from before pets reports none either way: no samples.
        up: p.samples && (p.kind === 'main' || p.up) ? pct(p.up, p.samples) : null,
        onFocus: p.focusSamples ? pct(p.onFocus, p.focusSamples) : null, focusSamples: p.focusSamples,
        drewFocus: holdSamples ? pct(p.drewFocus, holdSamples) : null, deaths: p.deaths,
        summons: (t.actions.summon ?? 0) + p.fnfSummons, brokeCc: p.brokeCc,
        ...(p.intercepted ? { intercepted: pct(p.intercepted, holdSamples) } : {}),
        ...(p.afterOwner ? { lostToOwner: pct(p.afterOwner, p.samples) } : {}),
    };
}

/** Who a death event's `killer` names, as MemberStats.killedBy has it, and whether it is a death to another realm. */
function deathBy(e: GroupEvent): { by: string; enemyRealm: boolean } {
    const k = e.data?.killer;
    const killer = k && typeof k === 'object' ? k as { name?: unknown; kind?: unknown; realm?: unknown; isPet?: unknown } : null;
    // The server names a pet's owner in the death (GameLiving.cs:1299-1300), and killerOf in the board takes the pet back from the hits before it (blackboard.ts).
    // A keep guard is an NPC of its realm too: a death to another realm all the same (killingBlowByEnemyRealm, GamePlayer.cs:5741).
    const realmNpc = killer?.kind === 'npc' && PLAYER_REALMS.has(String(killer.realm));
    const by = !killer ? 'unknown' : killer.kind === 'player' ? `player:${String(killer.realm)}` : realmNpc ? `${killer.isPet ? 'pet' : 'guard'}:${String(killer.realm)}` : `npc:${String(killer.name)}`;
    return { by, enemyRealm: killer?.kind === 'player' || realmNpc };
}

/** Note a member's nuke in the open fight, keeping the earliest. */
function nuked(f: OpenFight, name: string, at: number): void {
    const first = f.firstNuke.get(name);
    if (first === undefined || at < first) f.firstNuke.set(name, at);
}

/** Phase for a picture without a coordinator: fighting when anything attacks the group. */
export function inferPhase(p: GroupPicture): Phase {
    if (p.orders.seq > 0) return p.orders.phase;
    if (p.contacts.some(c => c.threat)) return 'engage';
    return p.members.some(m => m.isSitting) ? 'recover' : 'idle';
}

export class GroupObserver {
    private readonly started: number;
    private last: number;
    private readonly phaseMs: Partial<Record<Phase, number>> = {};
    private readonly members = new Map<string, Track>();
    private readonly fights: FightSummary[] = [];
    private fight: OpenFight | null = null;
    private readonly timelineEvents: string[] = [];
    private readonly recent: GroupEvent[] = [];
    private latest: GroupPicture | null = null;
    private calm = 0;
    private kills = 0;
    private retreats = 0;
    /** The last orders event's phase, and when a retreat last ended: each retreat counts once (handle). */
    private ordersPhase: unknown = null;
    private retreatEndedAt = -Infinity;
    private wipes = 0;
    private playerKills = 0;
    private deathsToPlayers = 0;
    /** Enemy player contacts ever seen, by region:objectId. */
    private readonly enemies = new Set<string>();
    /** The samples behind every fight's tank hold. */
    private holdSamples = 0;
    /** Events for a member with no track yet: one starts with its first sample, up to a second into the run, and an instant summon or a death can be quicker (credit). */
    private early: GroupEvent[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private unsubscribe: (() => void) | null = null;

    /**
     * `findings`: the strategy's own rules (GroupStrategy.findings), added to every report's. `petHoldMs`: what a pet waits out on a focus before it is ordered in (petHoldOf), which onFocus doesn't hold against it; none: from the engage.
     */
    constructor(private readonly board: Blackboard | null, private readonly meta: { group: string; strategy: string; sampleMs?: number; startedAt?: number; routines?: Record<string, { from: 'character' | 'role' | 'strategy'; behaviors: string[] }>; findings?: (r: RunReport) => Finding[]; petHoldMs?: number }) {
        this.started = meta.startedAt ?? Date.now();
        this.last = this.started;
    }

    start(): this {
        if (!this.board) return this;
        this.unsubscribe = this.board.onEvent(e => this.handle(e));
        this.timer = setInterval(() => this.sample(this.board!.picture()), this.meta.sampleMs ?? 1000);
        return this;
    }

    stop(): RunReport {
        if (this.timer) clearInterval(this.timer);
        this.unsubscribe?.();
        this.timer = null;
        this.unsubscribe = null;
        if (this.board) this.sample(this.board.picture());
        return this.report();
    }

    private stamp(at: number): string {
        const s = Math.max(0, Math.round((at - this.started) / 1000));
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }

    /** Feed one picture (the board does this every sampleMs). */
    sample(p: GroupPicture): void {
        const dt = Math.max(0, p.at - this.last);
        this.last = p.at;
        this.latest = p;
        const phase = inferPhase(p);
        inc(this.phaseMs, phase, dt);
        const threats = p.contacts.filter(c => c.threat);
        for (const m of p.members) {
            let t = this.members.get(m.name);
            if (!t) {
                t = { role: m.role, className: m.className, level0: m.level, level1: m.level, xp0: m.experience, xp1: m.experience, deaths: 0, actions: {}, failures: {}, fightSamples: 0, engageSamples: 0, idle: 0, idleReasons: {}, targeted: 0, inMelee: 0, moving: 0, minHp: m.hp, waitMs: {}, rp0: null, rp1: 0, killedBy: {}, pet: { kind: null, name: '', samples: 0, up: 0, focusSamples: 0, onFocus: 0, drewFocus: 0, intercepts: 0, interceptAt: -Infinity, steppedIn: null, intercepted: 0, ownerGone: false, afterOwner: 0, deaths: 0, brokeCc: 0, hadSummons: false, summons: [], fnfSummons: 0 } };
                this.members.set(m.name, t);
            }
            t.className = m.className;
            t.level1 = m.level;
            t.bot = m.bot;
            if (m.combat) t.combat = m.combat;
            if (m.experience >= t.xp1) t.xp1 = m.experience;
            if (typeof m.realmPoints === 'number') {
                t.rp0 ??= m.realmPoints;
                t.rp1 = Math.max(t.rp1, m.realmPoints);
            }
            t.minHp = Math.min(t.minHp, m.hp);
            samplePet(t.pet, m, p.at);
        }
        for (const c of p.contacts) if (c.kind === 'player') this.enemies.add(`${c.regionId}:${c.objectId}`);
        for (const w of p.orders.waiting ?? []) {
            const t = this.members.get(w.name);
            if (t) inc(t.waitMs, w.why, dt);
        }
        const fighting = phase === 'engage' || phase === 'retreat' || threats.length > 0;
        // Close a fight after 3 calm samples: a mob's target field flickers during a body pull.
        this.calm = fighting ? 0 : this.calm + 1;
        if (fighting && !this.fight) {
            this.fight = {
                start: Math.round((p.at - this.started) / 1000), at: p.at, focus: [], kills: [], maxAttackers: 0, deaths: [], retreated: false, attackers: new Set(), holdSamples: 0, heldSamples: 0,
                engageAt: null, engaged: new Set(), firstNuke: new Map(), enemies: new Map(),
            };
        }
        if (this.early.length) this.settleEarly();
        if (this.calm >= 3 && this.fight) this.closeFight(p.at, p);
        if (!this.fight || !fighting) return;
        const f = this.fight;
        // Openers count from the coordinator's engage order; a passive watch has no orders.
        const ordered = phase === 'engage' && p.orders.seq > 0;
        if (ordered && f.engageAt === null) {
            // The engage order itself (the board stamps the focus), not this sample: up to a sample earlier.
            const fc = p.contacts.find(c => c.objectId === p.orders.focus);
            f.engageAt = Math.min(p.at, fc?.engagedAt || p.orders.issuedAt || p.at);
        }
        for (const t of threats) f.attackers.add(t.objectId);
        f.maxAttackers = Math.max(f.maxAttackers, threats.length);
        const tank = p.members.find(m => m.role === 'tank' && !m.isDead);
        const focus = p.contacts.find(c => c.objectId === p.orders.focus) ?? (tank ? p.contacts.find(c => c.objectId === tank.targetId) : undefined);
        if (focus && !f.focus.includes(focus.name)) f.focus.push(focus.name);
        for (const c of focus ? [focus, ...threats] : threats) if (c.kind === 'player') f.enemies.set(`${c.regionId}:${c.objectId}`, c.realm);
        // Only samples where the mob's target is known. The board keeps the last one while the mob
        // runs or is out of reach (the server sends none then), so those count; a reset clears it.
        // On a member's pet its target is known too, and it isn't the tank.
        if (phase === 'engage' && tank && focus && isAlive(focus) && !focus.cc && (focus.target !== null || focus.targetPet)) {
            f.holdSamples++;
            this.holdSamples++;
            if (focus.target === tank.name) f.heldSamples++;
            for (const [name, t] of this.members) holdSample(t.pet, name === focus.targetPet ? focus.objectId : null, p.at);
        }
        // A pet isn't asked to be on a monster before its hold is over: that wait is no idleness. An enemy player has none (assist, prey).
        const petsFrom = focus && focus.kind !== 'player' ? Math.max(f.engageAt ?? 0, focus.engagedAt) + (this.meta.petHoldMs ?? 0) : 0;
        for (const m of p.members) {
            if (m.isDead) continue;
            const t = this.members.get(m.name)!;
            t.fightSamples++;
            // Idle and moving count while engaged only: during a pull, waiting at the base is the job.
            if (phase === 'engage') t.engageSamples++;
            if (phase === 'engage' && m.activity.kind === 'idle') { t.idle++; inc(t.idleReasons, m.activity.detail || 'nothing to do'); }
            if (phase === 'engage' && m.activity.kind === 'move') t.moving++;
            if (ordered) f.engaged.add(m.name);
            // The activity's start is exact; a nuke begun before this fight is a leftover.
            if (m.activity.kind === 'nuke') {
                const at = m.activity.since > 0 ? Math.min(m.activity.since, p.at) : p.at;
                if (at >= f.at) nuked(f, m.name, at);
            }
            if (threats.some(c => c.target === m.name)) t.targeted++;
            if (m.role !== 'tank' && threats.some(c => !c.cc && Math.hypot(c.x - m.x, c.y - m.y) < 250)) t.inMelee++;
            // What a pet may go for: petControl takes no crowd-controlled focus.
            if (phase === 'engage' && m.pet && focus && isAlive(focus) && !focus.cc && p.at >= petsFrom) {
                t.pet.focusSamples++;
                if (m.pet.targetId === focus.objectId) t.pet.onFocus++;
            }
        }
    }

    private closeFight(at: number, p: GroupPicture | null): void {
        const f = this.fight;
        if (!f) return;
        this.fight = null;
        const alive = p ? p.members.filter(m => !m.isDead).length : 1;
        const outcome = p && alive === 0 ? 'wiped' : f.retreated ? 'retreated' : f.kills.length ? 'won' : at === Infinity ? 'unfinished' : 'lost';
        // The sampler trails the engage order by up to a sample, so a nuke can come first: 0.
        const openerMs: Record<string, number | null> = {};
        if (f.engageAt !== null) {
            for (const name of f.engaged) {
                const first = f.firstNuke.get(name);
                if (first !== undefined) openerMs[name] = Math.max(0, first - f.engageAt);
                else if (this.members.get(name)?.role === 'nuker') openerMs[name] = null;
            }
        }
        const fight: FightSummary = {
            start: f.start, durationMs: (at === Infinity ? this.last : at) - f.at, focus: f.focus, kills: f.kills,
            adds: Math.max(0, f.attackers.size - 1), maxAttackers: f.maxAttackers,
            tankHold: f.holdSamples ? pct(f.heldSamples, f.holdSamples) : null, openerMs,
            deaths: f.deaths, retreated: f.retreated, outcome,
        };
        if (f.enemies.size) {
            fight.enemyPlayers = f.enemies.size;
            fight.enemyRealms = [...new Set(f.enemies.values())].sort();
        }
        this.fights.push(fight);
    }

    /** What an event adds to its member's track. */
    private credit(t: Track, e: GroupEvent): void {
        if (e.kind === 'death') {
            t.deaths++;
            inc(t.killedBy, deathBy(e).by);
            t.pet.ownerGone = true;
        }
        if (e.kind === 'note') {
            if (e.data?.pet === 'lost' && e.data.cause === 'died') t.pet.deaths++;
            if (e.data?.petBrokeCc) t.pet.brokeCc++;
        }
        if (e.kind === 'result') {
            const action = String(e.data?.action ?? 'action');
            if (e.data?.success) inc(t.actions, action);
            else inc(t.failures, `${action}:${String(e.data?.reason ?? 'failed')}`);
        }
    }

    /** Credit what came before a member's first sample, now that it has a track. */
    private settleEarly(): void {
        this.early = this.early.filter(e => {
            const t = this.members.get(e.member!);
            if (!t) return true;
            this.credit(t, e);
            if (e.kind === 'death') this.fight?.deaths.push(e.member!);
            return false;
        });
    }

    /** Feed one board event. */
    handle(e: GroupEvent): void {
        this.recent.push(e);
        if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);
        const t = e.member ? this.members.get(e.member) : undefined;
        if (t) this.credit(t, e);
        else if (e.member && CREDITED.has(e.kind)) this.early.push(e);
        if (e.kind === 'kill') {
            // An enemy pet is worth nothing (GameNPC.cs:2731-2732): no kill in the totals, though its death can end a fight.
            if (!e.data?.pet) this.kills++;
            if (e.data?.kind === 'player') this.playerKills++;
            this.fight?.kills.push(String(e.data?.name ?? e.text));
        }
        if (e.kind === 'death') {
            if (deathBy(e).enemyRealm) this.deathsToPlayers++;
            if (t) this.fight?.deaths.push(e.member!);
            const p = this.latest;
            if (p && p.members.length && p.members.every(m => m.isDead || m.name === e.member)) this.wipes++;
        }
        if (e.kind === 'orders') {
            // One retreat however many orders it takes: every leg's new retreatTo is a material change,
            // and a retreat that paused a moment (following dropped for a tick) and went on is the same one.
            const phase = e.data?.phase;
            if (phase === 'retreat') {
                if (this.ordersPhase !== 'retreat' && e.at - this.retreatEndedAt > RETREAT_RESUME_MS) this.retreats++;
                if (this.fight) this.fight.retreated = true;
            } else if (this.ordersPhase === 'retreat') this.retreatEndedAt = e.at;
            this.ordersPhase = phase;
        }
        if (e.kind === 'activity') {
            const kind = String(e.data?.activity);
            // Exact where a sample could miss a short cast.
            if (kind === 'nuke' && e.member && this.fight) nuked(this.fight, e.member, e.at);
            // Two members starting the same heal/cc on one target within a moment: wasted effort.
            if ((kind === 'cc' || kind === 'heal') && e.targetId !== null && e.targetId !== undefined) {
                const window = kind === 'cc' ? 3000 : 1500;
                const dup = this.recent.some(o => o !== e && o.kind === 'activity' && o.data?.activity === kind && o.targetId === e.targetId && o.member !== e.member && e.at - o.at < window);
                if (dup && t) inc(t.failures, `${kind}:duplicate`);
            }
            return;
        }
        if (e.kind === 'result' && e.data?.success) return;
        this.timelineEvents.push(`${this.stamp(e.at)} ${e.kind === 'orders' ? '[orders] ' : e.member ? `${e.member}: ` : ''}${e.text}`);
        if (this.timelineEvents.length > 120) this.timelineEvents.splice(0, this.timelineEvents.length - 120);
    }

    report(): RunReport {
        if (this.fight) this.closeFight(Infinity, this.latest);
        const durationMs = Math.max(1, this.last - this.started);
        const hours = durationMs / 3_600_000;
        const members: Record<string, MemberStats> = {};
        let xpTotal = 0, deaths = 0;
        const rpOf = (t: Track) => t.rp0 === null ? 0 : Math.max(0, t.rp1 - t.rp0);
        const rpTotal = [...this.members.values()].reduce((a, t) => a + rpOf(t), 0);
        // RvR fields only where there was RvR: a PvE report stays as it was (killedBy is for any death).
        const rvr = this.enemies.size > 0 || this.playerKills > 0 || this.deathsToPlayers > 0 || rpTotal > 0;
        for (const [name, t] of this.members) {
            const xp = Math.max(0, t.xp1 - t.xp0);
            xpTotal += xp;
            deaths += t.deaths;
            const openers = this.fights.map(f => f.openerMs[name]).filter(v => v !== undefined);
            const pet = petStats(t, this.holdSamples);
            const stats: MemberStats = {
                role: t.role, className: t.className, level: t.level0 === t.level1 ? `${t.level1}` : `${t.level0}→${t.level1}`,
                bot: t.bot, routine: t.bot ? this.meta.routines?.[t.bot]?.behaviors : undefined, routineFrom: t.bot ? this.meta.routines?.[t.bot]?.from : undefined,
                // With no pet to credit, "Your X hits" from outside its spell list is a proc's DoT: its own.
                dealt: t.combat && t.combat.dealt + (pet ? 0 : t.combat.petDealt ?? 0), styles: t.combat && { ...t.combat.styles }, missedStyles: t.combat?.missedStyles,
                xp, xpPerHour: Math.round(xp / hours), deaths: t.deaths, actions: t.actions, failures: t.failures,
                idleInFights: pct(t.idle, t.engageSamples), idleReasons: t.idleReasons,
                targeted: pct(t.targeted, t.fightSamples), inMelee: pct(t.inMelee, t.fightSamples),
                movingInFights: t.role === 'tank' ? null : pct(t.moving, t.engageSamples),
                openerMs: median(openers.filter((v): v is number => v !== null)), fightsWithoutNuke: openers.filter(v => v === null).length,
                minHp: t.minHp,
                waitedFor: Object.fromEntries(Object.entries(t.waitMs).map(([k, v]) => [k, pct(v, durationMs)]).filter(([, v]) => (v as number) > 0)),
            };
            if (rvr) stats.realmPoints = rpOf(t);
            if (t.deaths) stats.killedBy = { ...t.killedBy };
            if (pet) {
                stats.pet = pet;
                if (t.combat?.petDealt !== undefined) stats.petDealt = t.combat.petDealt;
            }
            members[name] = stats;
        }
        const phases: Partial<Record<Phase, number>> = {};
        for (const [k, v] of Object.entries(this.phaseMs)) phases[k as Phase] = pct(v!, durationMs);
        const busy = (this.phaseMs.engage ?? 0) + (this.phaseMs.pull ?? 0) + (this.phaseMs.retreat ?? 0);
        const held = this.fights.filter(f => f.tankHold !== null);
        const report: RunReport = {
            group: this.meta.group, strategy: this.meta.strategy, startedAt: new Date(this.started).toISOString(), durationMs,
            totals: {
                kills: this.kills, deaths, wipes: this.wipes, retreats: this.retreats, fights: this.fights.length,
                killsPerHour: Math.round(this.kills / hours), xpPerHour: Math.round(xpTotal / hours),
                avgFightMs: this.fights.length ? Math.round(this.fights.reduce((a, f) => a + f.durationMs, 0) / this.fights.length) : 0,
                downtime: pct(durationMs - busy, durationMs),
                tankHold: held.length ? Math.round(held.reduce((a, f) => a + f.tankHold!, 0) / held.length) : null,
            },
            phases, members, fights: this.fights, findings: [], timeline: this.timelineEvents.slice(-60),
        };
        if (rvr) {
            Object.assign(report.totals, {
                playerKills: this.playerKills, deathsToPlayers: this.deathsToPlayers, realmPoints: rpTotal, rpPerHour: Math.round(rpTotal / hours),
                enemiesSeen: this.enemies.size, engagements: this.fights.filter(f => f.enemyPlayers).length,
            });
        }
        report.findings = findingsFor(report);
        if (this.meta.findings) {
            try {
                report.findings.push(...this.meta.findings(report));
            } catch (e) {
                report.findings.push({ severity: 'low', topic: 'strategy', issue: `The strategy's findings() threw: ${e instanceof Error ? e.message : String(e)}`, evidence: '', suggestion: 'Fix findings() in strategy.ts; the observer\'s own findings are complete.' });
            }
        }
        return report;
    }

    /**
     * The report so far, for a live view: report() closes the open fight (it would
     * count twice and split), so put it back afterwards. A copy, safe to keep.
     */
    snapshot(): LiveReport {
        const fight = this.fight, closed = this.fights.length;
        try {
            return structuredClone({ ...this.report(), openFight: fight !== null });
        } finally {
            this.fights.length = closed;
            this.fight = fight;
        }
    }
}

const top = (r: Record<string, number>, n = 2) => Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ');

/**
 * Why the focus was on this pet, for pet-aggro: a note for its evidence (none for the plain case) and what to do. pet.holdMs is the advice only for a pet it reached: one ordered in by petControl, or cast by fnfPet.
 * A blow it took for its owner is no part of this (holdSample).
 */
function drewCause(name: string, m: MemberStats, r: RunReport): { note: string; advice: string } {
    const p = m.pet!;
    if (p.brokeCc) return { note: r.timeline.filter(l => l.includes(`${name}'s pet broke`)).at(-1) ?? `it broke crowd control ${p.brokeCc}×`, advice: 'What it broke turned on it: see pet-mezz.' };
    if (m.role === 'tank') return { note: 'the tank\'s own', advice: 'A defensive pet answers the first hit on its owner in ~33 ms, unordered (ControlledMobBrain.cs:614-638), so a hold reaches the tank\'s own only as passive: petControl keeps it passive until its hold is done, so have that on the list (pet.enabled), or set the stance yourself. A mob already on it stays on it.' };
    const list = m.routine ?? [];
    const ordered = (list.includes('petControl') && (m.actions.petAttack ?? 0) > 0) || (list.includes('fnfPet') && p.summons > 0);
    if (!ordered) return { note: 'no order', advice: 'It went in with no order, so no hold reaches it: a defensive pet goes for whoever hits its owner (ControlledMobBrain.cs:614-638). Keep the mob off its owner (combatRange, flee, crowd control), or set the pet passive.' };
    return { note: '', advice: 'Raise pet.holdMs, so the tank has built up its lead before a pet goes in.' };
}

/** The pet-* findings about one member's pet. */
function petFindings(name: string, m: MemberStats, r: RunReport): Finding[] {
    const out: Finding[] = [];
    const p = m.pet;
    if (!p) return out;
    if (p.brokeCc) out.push({ severity: 'medium', topic: 'pet-mezz', member: name, issue: `${name}'s pet broke crowd control ${p.brokeCc}×`, evidence: r.timeline.filter(l => l.includes(`${name}'s pet broke`)).slice(-3).join(' | '), suggestion: 'petControl orders no crowd-controlled target and calls a pet off one, so look for what got round that: a routine ordering the pet itself, a pet defending its owner as the mezz lands. Raise pet.holdMs so the mezzes are on before it goes in.' });
    const refused = Object.entries(m.failures).filter(([k]) => k.startsWith('petAttack:')).map(([k, n]) => `${k.slice('petAttack:'.length)} ${n}×`).join(', ');
    // 10 samples: a pet can stand out a short fight on its run in; its hold doesn't count (GroupObserver's petHoldMs). A list without petControl leaves it alone on purpose: a shade's, a turret. A passive watch knows no list, and no reason to expect one on the focus.
    if (p.onFocus !== null && p.focusSamples >= 10 && p.onFocus < 50 && m.routine?.includes('petControl')) out.push({ severity: 'medium', topic: 'pet-idle', member: name, issue: `${name}'s pet was on the focus only ${p.onFocus}% of engaged time`, evidence: `${p.focusSamples} samples with it up${p.up !== null ? `, up ${p.up}% of the run` : ''}${refused ? `; its orders refused: ${refused}` : ''}`, suggestion: refused ? 'The server refused its orders: that is the reason given, not range or hold.' : 'Check range and hold: petControl orders it only with the focus in view and within 2000 of its owner (combatRange), after the tank held it for pet.holdMs (0 does not wait). A pet parked on stay stays out, and it stays passive while the focus stands beyond the chase leash or under a keep\'s guards.' });
    // A run under a minute is mostly the first summon. A pet it has from elsewhere isn't one it can bring back.
    if (p.kind === 'main' && p.up !== null && p.up < 75 && r.durationMs > 60_000) {
        const failed = top(Object.fromEntries(Object.entries(m.failures).filter(([k]) => k.startsWith('summon:'))), 2);
        // Most of the time it was down came after its owner's death, which took it (GamePlayer.cs:5988-5989): no setting of a pet's brings that back.
        const ownerDeath = (p.lostToOwner ?? 0) * 2 >= 100 - p.up;
        out.push({ severity: 'medium', topic: 'pet-down', member: name, issue: `${name} had no pet ${100 - p.up}% of the run`, evidence: `summoned ${p.summons}×, it died ${p.deaths}×${m.deaths ? `, its owner died ${m.deaths}×` : ''}${failed ? `; ${failed}` : ''}`, suggestion: ownerDeath ? 'It went with its owner, and that is the cause: see the deaths finding. summonPet casts before the walk back, once nothing hostile is within 2500.' : 'Lower pet.summonMana (below it summonPet waits: "pet: saving power"), keep the pet alive (pet.healBelow, a later pet.holdMs), or hold pulls for it (pet.waitForSummon).' });
    }
    return out;
}

/** The group met enemy players: the PvE findings are noise. */
const isRvr = (r: RunReport) => (r.totals.enemiesSeen ?? 0) > 0 || (r.totals.playerKills ?? 0) > 0;
/** The report has the RvR totals, also with no more than a death to a keep's guards or a pet (report: 20261103-181211). A stray death like that in a hunt leaves it its PvE findings. */
const hasRvrTotals = (r: RunReport) => isRvr(r) || (r.totals.deathsToPlayers ?? 0) > 0;

/** Rule-based findings: what went wrong and which setting or behaviour to look at. */
export function findingsFor(r: RunReport): Finding[] {
    const out: Finding[] = [];
    const t = r.totals;
    // Against players, the PvE rules about camps, tank hold, adds, downtime and pace are noise:
    // players don't stay on the tank, a roam is not downtime and a skirmish has no pulls.
    const rvr = isRvr(r);
    // Share of the hold samples the focus spent on pets: the tank's lost hold that no member's `targeted` shows.
    const drew = Object.entries(r.members).filter(([, m]) => m.pet?.drewFocus);
    const onPets = drew.reduce((a, [, m]) => a + m.pet!.drewFocus!, 0);
    const steppingIn = Object.values(r.members).reduce((a, m) => a + (m.pet?.intercepted ?? 0), 0);
    if (!rvr && t.kills === 0 && r.durationMs > 60_000) {
        out.push({ severity: 'high', topic: 'no-kills', issue: 'No kills in the whole run', evidence: `phases ${JSON.stringify(r.phases)}; last events: ${r.timeline.slice(-3).join(' | ')}`, suggestion: 'Check the camp (settings.camp, campLevelBand), the con window (minCon/maxCon) and huntRadius; the orders log says why nothing was pulled.' });
    }
    if (!rvr && t.tankHold !== null && t.tankHold < 75) {
        const loose = Object.entries(r.members).filter(([, m]) => m.role !== 'tank').sort((a, b) => b[1].targeted - a[1].targeted)[0];
        out.push({ severity: t.tankHold < 50 ? 'high' : 'medium', topic: 'aggro', issue: `The tank held the focus only ${t.tankHold}% of fight time`, evidence: [loose ? `${loose[0]} was targeted ${loose[1].targeted}% of fight time` : '', onPets ? `on pets ${onPets}%` : '', steppingIn ? `pets stepping in for their owners ${steppingIn}%` : ''].filter(Boolean).join('; '), suggestion: 'Raise holdMs so damage dealers open later, open with DoTs (less burst aggro), or keep healers out of range of adds (combatRange).' });
    }
    if (!rvr && onPets > 25 && r.fights.filter(f => f.tankHold !== null).reduce((a, f) => a + f.durationMs, 0) >= PET_AGGRO_FIGHT_MS) {
        const causes = drew.map(([n, m]) => ({ n, share: m.pet!.drewFocus, ...drewCause(n, m, r) }));
        out.push({ severity: 'medium', topic: 'pet-aggro', ...(drew.length === 1 ? { member: drew[0]![0] } : {}), issue: `The focus was on a pet ${onPets}% of fight time`, evidence: causes.map(c => `on ${c.n}'s pet ${c.share}%${c.note ? ` (${c.note})` : ''}`).join(', '), suggestion: [...new Set(causes.map(c => c.advice))].join(' ') });
    }
    for (const [name, m] of Object.entries(r.members)) {
        out.push(...petFindings(name, m, r));
        if (m.deaths) {
            const lines = r.timeline.filter(l => l.includes(`${name} died`) || l.includes(`${name}:`)).slice(-4).join(' | ');
            const evidence = hasRvrTotals(r) && m.killedBy ? [`killed by ${top(m.killedBy, 3)}`, lines].filter(Boolean).join('; ') : lines;
            const suggestion = rvr ? 'Focus the enemy healers and casters first (Contact.healer, Contact.caster), mezz or peel the enemies on it, or retreat sooner when outnumbered.'
                : m.role === 'tank' ? 'Lower the con window or heal the tank earlier (heal.tank); retreat sooner (retreat.tankHp).' : 'Stand farther back (combatRange), flee to the tank earlier, or mezz adds sooner.';
            out.push({ severity: 'high', topic: 'deaths', member: name, issue: `${name} died ${m.deaths}×`, evidence, suggestion });
        }
        const interrupts = Object.entries(m.failures).filter(([k]) => k.endsWith(':interrupted')).reduce((a, [, v]) => a + v, 0);
        if (interrupts >= 2) out.push({ severity: 'medium', topic: 'interrupts', member: name, issue: `${name} was interrupted ${interrupts}×`, evidence: `targeted ${m.targeted}% of fight time, in melee range ${m.inMelee}%`, suggestion: 'Wait longer for the tank (holdMs), stand farther (combatRange), or let flee() run before casting.' });
        // Healers and supports idle when nobody needs them; that is fine.
        if ((m.role === 'nuker' || m.role === 'melee') && m.idleInFights > 40) out.push({ severity: 'medium', topic: 'idle', member: name, issue: `${name} was idle ${m.idleInFights}% of fight time`, evidence: `idle because: ${top(m.idleReasons, 3) || 'unknown'}`, suggestion: 'Check its behaviour list and spells for the role; "no power" points at mana (ready.mana, rest), "waiting for the tank" at holdMs.' });
        // A melee member belongs in melee range; these two are about casters.
        if (m.role !== 'tank' && m.role !== 'melee' && m.inMelee > 15) out.push({ severity: 'medium', topic: 'positioning', member: name, issue: `${name} stood in melee range of an attacker ${m.inMelee}% of fight time`, evidence: `targeted ${m.targeted}%, min health ${m.minHp}%`, suggestion: 'Widen combatRange for its role, or put position() before its damage behaviour.' });
        // Every step in a fight delays a cast; older reports lack the field.
        if (m.role !== 'melee' && (m.movingInFights ?? 0) > 20) out.push({ severity: m.movingInFights! >= 35 ? 'medium' : 'low', topic: 'positioning', member: name, issue: `${name} was moving ${m.movingInFights}% of engaged time`, evidence: `in melee range ${m.inMelee}%, targeted ${m.targeted}%${m.openerMs != null ? `, first nuke ${secs(m.openerMs)} after the engage (median)` : ''}`, suggestion: 'Widen the combatRange limits for its role (it moves only when closer than the min or farther than the max), or raise slotSlack so it stays where it stands near its slot.' });
        for (const [why, share] of Object.entries(m.waitedFor)) {
            if (share < 15) continue;
            const fix: Record<string, string> = {
                health: m.role === 'tank' ? 'Let healers top the tank up between pulls (heal.outOfCombat above ready.hp), or heal it earlier in fights (heal.tank).' : 'Heal it between pulls (heal.outOfCombat), or keep it out of fights (combatRange, flee).',
                power: 'Lower ready.mana, or have this member spend less (DoTs over nukes, fewer buffs); check its rest() runs.',
                'pet power': 'It rests to what its summon costs, casts, and rests on to ready.mana. Lower pet.summonMana, or ready.mana.',
                dead: 'See the deaths finding.',
                away: 'Check walking (stuck? far after a release?) and formation slots (formation.*, gatherRadius).',
            };
            out.push({ severity: share >= 30 ? 'medium' : 'low', topic: 'waiting', member: name, issue: `The group waited ${share}% of the run for ${name}'s ${why}`, evidence: `phases ${Object.entries(r.phases).map(([k, v]) => `${k} ${v}%`).join(', ')}`, suggestion: fix[why] ?? 'Check why it lags.' });
        }
        const stuck = Object.entries(m.failures).filter(([k]) => k.endsWith(':stuck')).reduce((a, [, v]) => a + v, 0);
        if (stuck >= 3) out.push({ severity: 'medium', topic: 'movement', member: name, issue: `${name}'s walks got stuck ${stuck}×`, evidence: r.timeline.filter(l => l.includes(`${name}: walk`)).slice(-2).join(' | '), suggestion: '"max speed 0" means rooted or overloaded (check encumbrance; shedLoadAt/keepItems, or sell loot); otherwise terrain: build navmeshes or move the base.' });
        const dups = Object.entries(m.failures).filter(([k]) => k.endsWith(':duplicate')).reduce((a, [, v]) => a + v, 0);
        if (dups >= 3) out.push({ severity: 'low', topic: 'duplicates', member: name, issue: `${name} duplicated another member's heal or mezz ${dups}×`, evidence: top(m.failures, 3), suggestion: 'Check the claim windows in heal()/crowdControl(), or assign the work in decide() (orders.cc).' });
    }
    if (!rvr && t.downtime > 60 && t.fights > 0) {
        const waits = Object.entries(r.phases).filter(([k]) => !['engage', 'pull', 'retreat'].includes(k)).map(([k, v]) => `${k} ${v}%`).join(', ');
        out.push({ severity: 'medium', topic: 'downtime', issue: `Downtime ${t.downtime}% (not fighting or pulling)`, evidence: waits, suggestion: 'Lower ready.hp/ready.mana, let healers top up out of combat (heal.outOfCombat), or pull higher cons for more XP per pull.' });
    }
    const adds = r.fights.reduce((a, f) => a + f.adds, 0);
    if (!rvr && r.fights.length && adds / r.fights.length > 0.5) out.push({ severity: 'medium', topic: 'adds', issue: `${adds} adds in ${r.fights.length} fights`, evidence: r.fights.filter(f => f.adds).slice(0, 3).map(f => `${f.focus.join('/')}: +${f.adds}`).join(', '), suggestion: 'Pull targets farther from others (avoidAggressive, huntRadius), a base with more room (chooseBase), or more crowd control.' });
    if (t.retreats) out.push({ severity: 'low', topic: 'retreats', issue: `${t.retreats} retreat(s)`, evidence: r.timeline.filter(l => l.includes('retreat')).slice(-3).join(' | '), suggestion: 'If the retreats saved the group, keep them; if they ran from winnable fights, relax retreat.* thresholds.' });
    if (!rvr && t.avgFightMs > 45_000) out.push({ severity: 'low', topic: 'pace', issue: `Fights take ${Math.round(t.avgFightMs / 1000)} s on average`, evidence: `${t.fights} fights`, suggestion: 'Lower maxCon, or check that every damage dealer actually casts (actions per member).' });
    return out;
}

export function formatReport(r: RunReport): string {
    const t = r.totals;
    const lines = [
        `# ${r.group}: ${r.strategy} run, ${r.startedAt.slice(0, 19).replace('T', ' ')} (${Math.round(r.durationMs / 1000)} s)`,
        '',
        `Kills ${t.kills} (${t.killsPerHour}/h), XP ${t.xpPerHour}/h for the group, deaths ${t.deaths}, wipes ${t.wipes}, retreats ${t.retreats}.`,
        `Fights ${t.fights}, avg ${Math.round(t.avgFightMs / 1000)} s, tank held the focus ${t.tankHold ?? '-'}%. Downtime ${t.downtime}%: ${Object.entries(r.phases).map(([k, v]) => `${k} ${v}%`).join(', ')}.`,
    ];
    const rvr = hasRvrTotals(r);
    if (rvr) lines.push(`RvR: ${t.enemiesSeen ?? 0} enemy players seen, ${t.engagements ?? 0} engagements, ${t.playerKills ?? 0} player kills, ${t.deathsToPlayers ?? 0} deaths to players, ${t.realmPoints ?? 0} realm points (${t.rpPerHour ?? 0}/h).`);
    if (r.previous) lines.push(`Against the previous run: ${Object.entries(r.previous).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    lines.push('', '## Findings', '');
    if (!r.findings.length) lines.push('None.');
    for (const f of r.findings) lines.push(`- **${f.severity}** [${f.topic}] ${f.issue}. ${f.evidence ? `Evidence: ${f.evidence}. ` : ''}Try: ${f.suggestion}`);
    lines.push('', '## Members', '', 'Moving: share of engaged time spent walking. First nuke: median time from the engage to its first nuke, and the fights it never nuked in.', '',
        '| Member | Role | Level | XP/h | Deaths | Actions | Failures | Idle in fights | Moving in fights | First nuke | Targeted | In melee | Min HP | Group waited for it |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [n, m] of Object.entries(r.members)) {
        const waited = Object.entries(m.waitedFor).map(([k, v]) => `${k} ${v}%`).join(', ');
        const opener = [m.openerMs != null ? secs(m.openerMs) : '', m.fightsWithoutNuke ? `${m.fightsWithoutNuke} fights without` : ''].filter(Boolean).join(', ');
        lines.push(`| ${n} | ${m.role} | ${m.level} | ${m.xpPerHour} | ${m.deaths} | ${top(m.actions, 4)} | ${top(m.failures, 3)} | ${m.idleInFights}%${m.idleInFights ? ` (${top(m.idleReasons, 1)})` : ''} | ${m.movingInFights != null ? `${m.movingInFights}%` : '-'} | ${opener || '-'} | ${m.targeted}% | ${m.inMelee}% | ${m.minHp}% | ${waited || '-'} |`);
    }
    if (rvr) {
        lines.push('', 'Realm points, and deaths by killer:', '');
        for (const [n, m] of Object.entries(r.members)) lines.push(`- ${n}: ${m.realmPoints ?? 0} RP${m.killedBy ? `, killed by ${top(m.killedBy, 4)}` : ''}`);
    } else if (Object.values(r.members).some(m => m.killedBy)) {
        lines.push('', 'Deaths by killer:', '');
        for (const [n, m] of Object.entries(r.members)) if (m.killedBy) lines.push(`- ${n}: ${top(m.killedBy, 4)}`);
    }
    const fought = Object.entries(r.members).filter(([, m]) => m.dealt !== undefined);
    if (fought.length) {
        lines.push('', '## What each member did', '', '| Member | Damage dealt | Styles landed | Styles missed | Routine from | Routine |', '|---|---|---|---|---|---|');
        for (const [n, m] of fought) lines.push(`| ${n} | ${m.dealt} | ${top(m.styles ?? {}, 6)} | ${m.missedStyles ?? 0} | ${m.routineFrom ?? ''} | ${(m.routine ?? []).join(', ')} |`);
    }
    const pets = Object.entries(r.members).filter(([, m]) => m.pet);
    if (pets.length) {
        lines.push('', '## Pets', '', 'Up: share of the run its window pet was there, with its owner alive. On focus: share of engaged time, with it up, its hold over and the focus free to hit. Drew the focus: share of the tank-hold samples with the focus on it; a blow it took for its owner is apart.', '',
            '| Member | Pet | Up | On focus | Drew the focus | Damage dealt | Died | Summons | Broke cc |', '|---|---|---|---|---|---|---|---|---|');
        const share = (v: number | null) => v === null ? '-' : `${v}%`;
        for (const [n, m] of pets) {
            const p = m.pet!;
            lines.push(`| ${n} | ${p.name || p.kind || '-'} | ${share(p.up)} | ${share(p.onFocus)} | ${share(p.drewFocus)}${p.intercepted ? ` (${p.intercepted}% more by intercepting)` : ''} | ${m.petDealt ?? 0} | ${p.deaths} | ${p.summons} | ${p.brokeCc} |`);
        }
    }
    lines.push('', '## Fights', '');
    for (const f of r.fights) {
        const openers = Object.entries(f.openerMs ?? {}).map(([n, ms]) => `${n} ${ms === null ? 'none' : secs(ms)}`).join(', ');
        lines.push(`- ${String(Math.floor(f.start / 60)).padStart(2, '0')}:${String(f.start % 60).padStart(2, '0')} ${f.focus.join(' / ') || '?'}: ${f.outcome} in ${Math.round(f.durationMs / 1000)} s, kills ${f.kills.length}, adds ${f.adds}, tank hold ${f.tankHold ?? '-'}%${f.enemyPlayers ? `, ${f.enemyPlayers} enemy players (${(f.enemyRealms ?? []).join(', ')})` : ''}${openers ? `, first nuke: ${openers}` : ''}${f.deaths.length ? `, died: ${f.deaths.join(', ')}` : ''}`);
    }
    lines.push('', '## Timeline (last events)', '', '```', ...r.timeline, '```', '');
    return lines.join('\n');
}

/** The runs/<stamp> of a run started at `startedAt` (ms epoch or ISO): YYYYMMDD-HHMMSS in UTC. */
export function stampOf(startedAt: number | string): string {
    const iso = typeof startedAt === 'number' ? new Date(startedAt).toISOString() : startedAt;
    return iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** One line per member in bots/<bot>/runs/history.jsonl: what it ran and how that went, whichever group it was in. */
function saveBotHistory(r: RunReport): void {
    for (const [name, m] of Object.entries(r.members)) {
        const env = m.bot ? findBotEnv(m.bot) : null;
        if (!env) continue;
        const dir = join(dirname(env), 'runs');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'history.jsonl'), JSON.stringify({
            startedAt: r.startedAt, stamp: stampOf(r.startedAt), group: r.group, strategy: r.strategy, seconds: Math.round(r.durationMs / 1000),
            name, role: m.role, level: m.level, routineFrom: m.routineFrom, xpPerHour: m.xpPerHour, deaths: m.deaths, dealt: m.dealt, petDealt: m.petDealt, styles: m.styles, missedStyles: m.missedStyles, pet: m.pet,
            actions: m.actions, failures: m.failures, idleInFights: m.idleInFights, targeted: m.targeted, minHp: m.minHp, routine: m.routine,
        }) + '\n');
    }
}

/** Write runs/<stamp>.json, .md (and .log with `log`), compare with and append to runs/history.jsonl. Returns the .md path. */
export function saveReport(groupDir: string, r: RunReport, log?: string[], opts: { botHistory?: boolean } = {}): string {
    const dir = join(groupDir, 'runs');
    mkdirSync(dir, { recursive: true });
    const history = join(dir, 'history.jsonl');
    const summary = { startedAt: r.startedAt, strategy: r.strategy, seconds: Math.round(r.durationMs / 1000), ...r.totals, findings: r.findings.map(f => f.topic) };
    if (existsSync(history)) {
        // The previous run of the same strategy: a passive watch is no baseline for a coordinated run.
        const last = readFileSync(history, 'utf-8').trim().split('\n').filter(Boolean).reverse()
            .find(l => { try { return JSON.parse(l).strategy === r.strategy; } catch { return false; } });
        if (last) {
            try {
                const prev = JSON.parse(last);
                const delta = (k: string) => {
                    const a = prev[k], b = (summary as any)[k];
                    return typeof a === 'number' && typeof b === 'number' ? `${a}→${b}` : null;
                };
                // The RvR totals only where both runs have them.
                r.previous = Object.fromEntries(['xpPerHour', 'killsPerHour', 'deaths', 'downtime', 'tankHold', 'avgFightMs', 'playerKills', 'deathsToPlayers', 'rpPerHour'].map(k => [k, delta(k)]).filter(([, v]) => v) as [string, string][]);
            } catch {}
        }
    }
    appendFileSync(history, JSON.stringify(summary) + '\n');
    const stamp = stampOf(r.startedAt);
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(r, null, 2));
    const md = join(dir, `${stamp}.md`);
    writeFileSync(md, formatReport(r));
    if (log) writeFileSync(join(dir, `${stamp}.log`), log.map(l => `${l}\n`).join(''));
    // Last and on its own, so it can't cost the run its report.
    if (opts.botHistory) {
        try { saveBotHistory(r); } catch (e) { console.warn(`bot history not saved: ${(e as Error).message}`); }
    }
    return md;
}
