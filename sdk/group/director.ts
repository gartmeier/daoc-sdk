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
import type { Point, Point3 } from './types';

export const DIRECTOR_DIR = process.env.DAOC_DIRECTOR_DIR ?? join(import.meta.dir, '..', '..', 'groups', 'director');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── the interface

export type CallKind = 'help' | 'muster';
export type CallWhy = 'outnumbered' | 'caught' | 'camped' | 'raid';
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
}

/** Raid members' places are rounded to this. */
export const RAID_ROUND = 50;

/** <dir>/<realm>.json */
export interface CallsFile {
    v: 1;
    realm: PlayerRealm;
    at: number;
    enabled: boolean;
    calls: RealmCall[];
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
    /** In 'go', the raid broke once its living fell below this share of those it went with. */
    raidBreak: number;
    /** Raids on a rhythm: a new muster this long after the last one ended (or the director started). 0 = only startMuster. */
    raidEveryMs: number;
}

export const DIRECTOR_SETTINGS: DirectorSettings = {
    enabled: true, help: true, muster: true,
    nearFoe: 2500, nearFriend: 2000, lossShare: 1 / 3, lossMs: 30_000,
    reach: 7000, helperHp: 60, helperAlive: 0.5, arrive: 1500,
    clearMs: 15_000, maxMs: 180_000,
    campRadius: 5000, campFoes: 2, campMs: 15_000,
    quorum: 0.7, rallyMaxMs: 240_000, goMaxMs: 900_000, raidBreak: 0.3, raidEveryMs: 0,
};

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────── the events

export type DirectorEvent =
    | { kind: 'open'; call: string; from: string; why: CallWhy; at: Point3; foes: number; ours: number; foeRoles: Partial<Record<SeenRole, number>> }
    | { kind: 'ask'; call: string; unit: string; dist: number }
    | { kind: 'answer'; call: string; unit: string; state: AnswerState; why: string }
    | { kind: 'arrive'; call: string; unit: string; ms: number; answered: boolean }
    | { kind: 'stage'; call: string; stage: 'rally' | 'go'; atRally: number; of: number }
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
    raid?: RaidPlan & { stagedAt: number; livingAtGo?: number };
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
                if (!o || (this.answersSeen.get(k) ?? 0) >= a.at) continue;
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
                events.push({ kind: 'open', call: o.call.id, from, why: c.why, at: c.at, foes: c.foes.length, ours: c.ours, foeRoles: o.call.foeRoles });
            } else {
                // A worse reason wins: caught and camped over outnumbered.
                if (o.call.why === 'outnumbered') o.call.why = c.why;
                o.call.at = c.at;
                o.call.foes = c.foes.length;
                o.call.ours = c.ours;
                o.call.foeRoles = roleCount(c.foes);
                o.heldAt = now;
            }
            o.foesMax = Math.max(o.foesMax, o.call.foes);
            o.oursMax = Math.max(o.oursMax, o.call.ours);
        }

        // Muster.
        this.stepMuster(board, now, events);

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

    /** Is unit `u` in trouble now: outnumbered or caught, in a fight of its own. */
    private helpCondition(u: UnitView, board: RealmBoardView, now: number): { why: CallWhy; at: Point3; foes: SeenFoe[]; ours: number } | null {
        const s = this.settings;
        if (!u.running || !u.centre || !u.inFight || u.alive === 0) return null;
        const near = foesNear(board.foes, u.centre, s.nearFoe);
        if (!near.length) return null;
        const ours = this.oursNear(board, u.centre, u.unit) + u.alive;
        const recent = u.losses.filter(l => now - l.at <= s.lossMs).length;
        const caught = u.caught || u.fleeing || recent >= Math.max(1, Math.ceil(u.size * s.lossShare));
        const why: CallWhy | null = caught ? 'caught' : near.length > ours ? 'outnumbered' : null;
        return why ? { why, at: { x: Math.round(u.centre.x), y: Math.round(u.centre.y), z: Math.round(u.centre.z) }, foes: near, ours } : null;
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
            if (x === o || x.call.kind !== 'help') continue;
            busy.add(x.call.from);
            for (const a of x.call.asked) busy.add(a);
            for (const c of x.call.coming) busy.add(c);
        }
        return board.units
            .filter(u => u.unit !== o.call.from && u.running && u.centre && !u.inFight && !busy.has(u.unit)
                && u.alive >= Math.max(1, Math.ceil(u.size * s.helperAlive)) && u.hp >= s.helperHp)
            .map(u => ({ u, d: dist2(u.centre!, o.call.at) }))
            .filter(x => x.d <= s.reach)
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
            for (const { u, d } of this.candidates(o, board)) {
                if (want <= 0) break;
                if (counted.has(u.unit)) continue;
                call.asked.push(u.unit);
                want -= u.alive;
                events.push({ kind: 'ask', call: call.id, unit: u.unit, dist: Math.round(d) });
            }
        }
        call.want = Math.max(0, want);
    }

    private close(o: Open, end: string, board: RealmBoardView, now: number): DirectorEvent {
        this.open.delete(o.call.id);
        const involved = [o.call.from, ...o.arrived.keys()];
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
                heldAt: now, arrived: new Map(), lossesBefore: new Set(), lost: 0, killsAtOpen: new Map(), foesMax: 0, oursMax: 0,
                raid: { ...p, stagedAt: now },
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
        call.raid = raid.flatMap(u => u.members.map(m => ({ unit: u.unit, x: round(m.x), y: round(m.y), z: round(m.z), alive: !m.isDead })));
        const point = call.stage === 'rally' ? o.raid.rally : o.raid.target;
        const there = raid.reduce((t, u) => t + u.members.filter(m => !m.isDead && dist2(m, point) <= s.arrive * 1.5).length, 0);
        const near = foesNear(board.foes, point, s.nearFoe);
        call.foes = near.length;
        call.foeRoles = roleCount(near);
        call.ours = there;
        o.foesMax = Math.max(o.foesMax, call.foes);
        o.oursMax = Math.max(o.oursMax, there);
        if (call.stage === 'rally') {
            const waited = now - o.raid.stagedAt;
            if (living > 0 && (there >= s.quorum * living || (waited >= s.rallyMaxMs && there >= 0.5 * living))) {
                call.stage = 'go';
                call.at = { ...o.raid.target };
                o.raid.stagedAt = now;
                o.raid.livingAtGo = living;
                o.arrived.clear();
                events.push({ kind: 'stage', call: call.id, stage: 'go', atRally: there, of: living });
            }
        } else {
            let owner: string | null = null;
            try { owner = this.targetOwner?.() ?? null; } catch { /* unknown */ }
            const end = owner === this.realm ? 'captured'
                : living < s.raidBreak * (o.raid.livingAtGo ?? living) ? 'broken'
                : now - o.raid.stagedAt > s.goMaxMs ? 'timeout' : null;
            if (end) {
                events.push(this.close(o, end, board, now));
                this.raidEndedAt = now;
            }
        }
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

    /** Write <dir>/<realm>.json: the calls while on, none while off. */
    private publish(now: number): void {
        if (!this.write) return;
        const file: CallsFile = { v: 1, realm: this.realm, at: now, enabled: this.settings.enabled, calls: this.settings.enabled ? this.calls() : [] };
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

/** The calls that name `unit` (asked, or a muster it is in), nearest first when `centre` is given. */
export function askedOf(calls: readonly RealmCall[], unit: string, centre?: Point | null): RealmCall[] {
    const mine = calls.filter(c => c.asked.includes(unit));
    return centre ? mine.sort((a, b) => dist2(a.at, centre) - dist2(b.at, centre)) : mine;
}

export interface CallWatch {
    calls: () => RealmCall[];
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
        stop: () => {
            stopped = true;
            clearInterval(timer);
            if (opts.write ?? true) {
                const file: CallsFile = { v: 1, realm: director.realm, at: Date.now(), enabled: false, calls: [] };
                try { writeAtomic(join(director.dir, `${director.realm}.json`), JSON.stringify(file)); } catch { /* gone */ }
            }
        },
    };
}

export type { FoeRole, SeenFoe, SeenRole, UnitView };
