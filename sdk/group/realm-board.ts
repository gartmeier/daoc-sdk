// The realm board: what one realm's units see, gathered for its director (director.ts).
//
// A unit is a group or a small squad that field mode runs (groups/<unit>/). Each one's picture comes from the
// gateway's group frame (GET /groups/<unit>/live, gateway/groups.ts): its members' own states and, while a run is
// live, the run's board. Enemies come only from that board (WorldContact.board): what the members saw with the
// run's vision (human vision in field mode). The raw client sightings in the frame's `world` are server truth about
// enemies in range, so the board leaves every contact out that the run's board doesn't hold. Never a roster, never a
// name: an enemy is read by its role (classGuess when the gateway carries it, else the healer and caster signs).
//
// Pure apart from the clock passed in: update() takes the frames (null for a unit whose frame could not be read)
// and keeps only what it needs between calls (deaths, the last good frame for a short while).

import type { GroupFrame, GroupMemberView, WorldContact } from '../../gateway/group-types';
import type { FoeRole } from './class-read';
import { THIDRANKI, type PlayerRealm } from './keeps';
import type { Phase, Point3 } from './types';

/** Phases in which a unit is in a fight of its own. */
export const FIGHT_PHASES: ReadonlySet<string> = new Set(['engage', 'pull', 'retreat']);
/** A unit's frame that could not be read is used as last read for this long, then the unit counts as gone. */
const FRAME_KEEP_MS = 10_000;
/** Deaths are remembered this long. */
const LOSS_KEEP_MS = 180_000;
/** Run states in which a run speaks for its unit. */
const RUNNING = new Set(['starting', 'live', 'stale']);

export type SeenRole = FoeRole | 'unknown';

/** An enemy player some unit of ours sees on its run's board. */
export interface SeenFoe {
    /** `${regionId}:${objectId}` */
    key: string;
    objectId: number;
    x: number;
    y: number;
    z: number;
    hp: number;
    level: number;
    realm: string;
    role: SeenRole;
    /** It fights one of our units (the board's threat). */
    threat: boolean;
    /** Character names that see it, over every unit. */
    seenBy: string[];
    /** The units whose boards hold it. */
    units: string[];
    /** In combat as our client saw it (a fight with someone, us or another realm). */
    inCombat?: boolean;
}

export interface BoardMember {
    name: string;
    bot: string;
    /** Its object id and level (0 when unknown), and whether it knows a rez (the run's capabilities). */
    objectId?: number;
    level?: number;
    rez?: boolean;
    x: number;
    y: number;
    z: number;
    hp: number;
    isDead: boolean;
    inCombat: boolean;
}

/** One unit as its realm's board sees it. */
export interface UnitView {
    unit: string;
    /** Gateway clock of the frame it was read from. */
    at: number;
    /** A run of it is starting, live or stale: only then does it play and see. */
    running: boolean;
    phase: Phase | null;
    reason: string;
    /** In a fight of its own: a fight phase, or a living member in combat. */
    inFight: boolean;
    /** Its orders say it was caught (reason 'caught:'), or it flees (reason 'flee:'). */
    caught: boolean;
    fleeing: boolean;
    /** The run's members (all members while no run is live), in the region. */
    members: BoardMember[];
    size: number;
    alive: number;
    /** Centre of its living members in the region; null with none. */
    centre: Point3 | null;
    /** Mean health of its living members, 0..100. */
    hp: number;
    /** Enemy players its run's board holds, fresh and alive. */
    foes: SeenFoe[];
    /** Deaths of its members seen in the last LOSS_KEEP_MS, oldest first (gateway clock). */
    losses: { name: string; at: number }[];
    /** The run's report totals so far, when the frame carried them. */
    totals: { playerKills: number; deathsToPlayers: number } | null;
}

export interface RealmBoardView {
    realm: PlayerRealm;
    at: number;
    units: UnitView[];
    /** Every enemy player any unit sees, merged by key. */
    foes: SeenFoe[];
}

export interface RealmBoardOptions {
    regionId?: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** What the board knows of an enemy's role: its class read (when the gateway carries it), else its signs. */
export function roleOf(board: NonNullable<WorldContact['board']>): SeenRole {
    const guess = (board as { classGuess?: { role?: FoeRole } }).classGuess;
    if (guess?.role) return guess.role;
    if (board.healer) return 'healer';
    if (board.caster) return 'caster';
    return 'unknown';
}

/** The enemy players in a frame that the unit's run board holds: fresh, alive, in the region, another realm. */
export function foesIn(frame: Pick<GroupFrame, 'id' | 'world'>, realm: PlayerRealm, regionId = THIDRANKI): SeenFoe[] {
    const out: SeenFoe[] = [];
    for (const w of frame.world ?? []) {
        const b = w.board;
        if (!b || b.stale || w.kind !== 'player' || !w.enemy || w.isDead || w.realm === realm || w.regionId !== regionId) continue;
        if (!finite(w.x) || !finite(w.y)) continue;
        out.push({
            key: w.key, objectId: w.objectId, x: w.x, y: w.y, z: finite(w.z) ? w.z : 0, hp: finite(w.hp) ? w.hp : 100, level: finite(w.level) ? w.level : 0,
            realm: w.realm, role: roleOf(b), threat: !!b.threat, seenBy: [...(b.seenBy ?? [])], units: [frame.id], inCombat: !!w.inCombat,
        });
    }
    return out;
}

const runMembers = (frame: GroupFrame): GroupMemberView[] => {
    const running = !!frame.run && RUNNING.has(frame.run.state);
    const inRun = running ? frame.members.filter(m => m.run) : [];
    return inRun.length ? inRun : frame.members;
};

/** Merge foes by key: the freshest place, everyone who sees it. */
export function mergeFoes(lists: readonly (readonly SeenFoe[])[]): SeenFoe[] {
    const by = new Map<string, SeenFoe>();
    for (const list of lists) {
        for (const f of list) {
            const had = by.get(f.key);
            if (!had) { by.set(f.key, { ...f, seenBy: [...f.seenBy], units: [...f.units] }); continue; }
            for (const n of f.seenBy) if (!had.seenBy.includes(n)) had.seenBy.push(n);
            for (const u of f.units) if (!had.units.includes(u)) had.units.push(u);
            had.threat ||= f.threat;
            had.inCombat ||= f.inCombat;
            if (had.role === 'unknown') had.role = f.role;
        }
    }
    return [...by.values()];
}

export class RealmBoard {
    readonly realm: PlayerRealm;
    readonly regionId: number;
    private last = new Map<string, { frame: GroupFrame; readAt: number }>();
    private wasDead = new Map<string, boolean>();
    private losses = new Map<string, { name: string; at: number }[]>();
    /** The last totals by unit and run: a frame carries the report only when it changed. */
    private totals = new Map<string, { runId: string; totals: UnitView['totals'] }>();

    constructor(realm: PlayerRealm, opts: RealmBoardOptions = {}) {
        this.realm = realm;
        this.regionId = opts.regionId ?? THIDRANKI;
    }

    /** Read the units' frames (null: not read this time) at `now` (ms epoch, the caller's clock). */
    update(frames: Readonly<Record<string, GroupFrame | null | undefined>>, now: number): RealmBoardView {
        const units: UnitView[] = [];
        for (const [unit, got] of Object.entries(frames)) {
            if (got) this.last.set(unit, { frame: got, readAt: now });
            const kept = this.last.get(unit);
            if (!kept || now - kept.readAt > FRAME_KEEP_MS) continue;
            units.push(this.view(unit, kept.frame, now, !!got));
        }
        return { realm: this.realm, at: now, units, foes: mergeFoes(units.map(u => u.foes)) };
    }

    private view(unit: string, frame: GroupFrame, now: number, fresh: boolean): UnitView {
        const run = frame.run && RUNNING.has(frame.run.state) ? frame.run : null;
        const members: BoardMember[] = [];
        for (const m of runMembers(frame)) {
            const p = m.player;
            if (!p || p.regionId !== this.regionId || !finite(p.x) || !finite(p.y)) continue;
            if (p.realm && p.realm !== this.realm) continue;
            members.push({
                name: p.name || m.charName || m.bot, bot: m.bot, x: p.x, y: p.y, z: finite(p.z) ? p.z : 0, hp: finite(p.hp) ? p.hp : 100, isDead: !!p.isDead, inCombat: !!p.inCombat,
                objectId: finite(p.objectId) ? p.objectId : 0, level: finite(p.level) ? p.level : 0, rez: !!m.run?.can?.rez,
            });
        }
        // Deaths: a member seen alive, then dead (only on a frame read now, so a kept frame adds none twice).
        const lost = (this.losses.get(unit) ?? []).filter(l => now - l.at <= LOSS_KEEP_MS);
        if (fresh) {
            for (const m of members) {
                const k = `${unit}/${m.bot}`;
                if (m.isDead && this.wasDead.get(k) === false) lost.push({ name: m.name, at: now });
                this.wasDead.set(k, m.isDead);
            }
        }
        this.losses.set(unit, lost);
        const living = members.filter(m => !m.isDead);
        const centre = living.length
            ? { x: living.reduce((s, m) => s + m.x, 0) / living.length, y: living.reduce((s, m) => s + m.y, 0) / living.length, z: living.reduce((s, m) => s + m.z, 0) / living.length }
            : null;
        const phase = run ? run.orders.phase : null;
        const reason = run ? run.orders.reason ?? '' : '';
        const sent = (run?.report as { totals?: { playerKills?: number; deathsToPlayers?: number } } | null | undefined)?.totals;
        let totals: UnitView['totals'] = sent ? { playerKills: sent.playerKills ?? 0, deathsToPlayers: sent.deathsToPlayers ?? 0 } : null;
        if (run) {
            const had = this.totals.get(unit);
            if (totals) this.totals.set(unit, { runId: run.runId, totals });
            else if (had?.runId === run.runId) totals = had.totals;
        }
        return {
            unit, at: frame.now, running: !!run, phase, reason,
            inFight: !!run && (FIGHT_PHASES.has(phase ?? '') || living.some(m => m.inCombat)),
            caught: reason.startsWith('caught:'), fleeing: phase === 'retreat' && reason.startsWith('flee:'),
            members, size: members.length, alive: living.length, centre,
            hp: living.length ? living.reduce((s, m) => s + m.hp, 0) / living.length : 0,
            foes: run ? foesIn(frame, this.realm, this.regionId) : [],
            losses: lost,
            totals,
        };
    }
}

/** 2D distance. */
export const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** The foes within `r` of `p`. */
export const foesNear = (foes: readonly SeenFoe[], p: { x: number; y: number }, r: number) => foes.filter(f => dist2(f, p) <= r);

/** Count by role. */
export function roleCount(foes: readonly SeenFoe[]): Partial<Record<SeenRole, number>> {
    const out: Partial<Record<SeenRole, number>> = {};
    for (const f of foes) out[f.role] = (out[f.role] ?? 0) + 1;
    return out;
}
