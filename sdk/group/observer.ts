// The observer watches a group run and says how well it went: per-fight and
// per-member metrics, rule-based findings about coordination problems, and a
// report (JSON + Markdown) an agent reads to decide what to change next.
//
// It only reads: board pictures (sampled once a second) and board events. It
// works the same for a coordinated run and for a passive watch over observe-mode
// connections (no orders: the phase is inferred from the picture).

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Blackboard } from './blackboard';
import type { GroupEvent, GroupPicture, Phase } from './types';

export interface Finding {
    severity: 'high' | 'medium' | 'low';
    /** 'aggro', 'deaths', 'interrupts', 'idle', 'downtime', 'adds', 'positioning', 'duplicates', 'pace', 'retreats', 'no-kills'. */
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

interface Track {
    role: string; className: string; level0: number; level1: number; xp0: number; xp1: number;
    deaths: number; actions: Record<string, number>; failures: Record<string, number>;
    fightSamples: number; engageSamples: number; idle: number; idleReasons: Record<string, number>; targeted: number; inMelee: number; moving: number; minHp: number;
    waitMs: Record<string, number>;
}

interface OpenFight extends Omit<FightSummary, 'durationMs' | 'tankHold' | 'outcome' | 'adds' | 'openerMs'> {
    at: number; attackers: Set<number>; holdSamples: number; heldSamples: number;
    /** The first sample under the coordinator's engage order; members alive in such samples; each member's first nuke. */
    engageAt: number | null; engaged: Set<string>; firstNuke: Map<string, number>;
}

const pct = (a: number, b: number) => b > 0 ? Math.round(100 * a / b) : 0;
const inc = (r: Record<string, number>, k: string, by = 1) => { r[k] = (r[k] ?? 0) + by; };
const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
    return s.length % 2 ? s[h]! : Math.round((s[h - 1]! + s[h]!) / 2);
};
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

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
    private wipes = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private unsubscribe: (() => void) | null = null;

    constructor(private readonly board: Blackboard | null, private readonly meta: { group: string; strategy: string; sampleMs?: number; startedAt?: number }) {
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
                t = { role: m.role, className: m.className, level0: m.level, level1: m.level, xp0: m.experience, xp1: m.experience, deaths: 0, actions: {}, failures: {}, fightSamples: 0, engageSamples: 0, idle: 0, idleReasons: {}, targeted: 0, inMelee: 0, moving: 0, minHp: m.hp, waitMs: {} };
                this.members.set(m.name, t);
            }
            t.className = m.className;
            t.level1 = m.level;
            if (m.experience >= t.xp1) t.xp1 = m.experience;
            t.minHp = Math.min(t.minHp, m.hp);
        }
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
                engageAt: null, engaged: new Set(), firstNuke: new Map(),
            };
        }
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
        // Only samples where the mob's target is known. The board keeps the last one while the mob
        // runs or is out of reach (the server sends none then), so those count; a reset clears it.
        if (phase === 'engage' && tank && focus && focus.hp > 0 && !focus.cc && focus.target !== null) {
            f.holdSamples++;
            if (focus.target === tank.name) f.heldSamples++;
        }
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
        this.fights.push({
            start: f.start, durationMs: (at === Infinity ? this.last : at) - f.at, focus: f.focus, kills: f.kills,
            adds: Math.max(0, f.attackers.size - 1), maxAttackers: f.maxAttackers,
            tankHold: f.holdSamples ? pct(f.heldSamples, f.holdSamples) : null, openerMs,
            deaths: f.deaths, retreated: f.retreated, outcome,
        });
    }

    /** Feed one board event. */
    handle(e: GroupEvent): void {
        this.recent.push(e);
        if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);
        const t = e.member ? this.members.get(e.member) : undefined;
        if (e.kind === 'kill') { this.kills++; this.fight?.kills.push(String(e.data?.name ?? e.text)); }
        if (e.kind === 'death') {
            if (t) t.deaths++;
            if (e.member) this.fight?.deaths.push(e.member);
            const p = this.latest;
            if (p && p.members.length && p.members.every(m => m.isDead || m.name === e.member)) this.wipes++;
        }
        if (e.kind === 'orders' && e.data?.phase === 'retreat') { this.retreats++; if (this.fight) this.fight.retreated = true; }
        if (e.kind === 'result' && t) {
            const action = String(e.data?.action ?? 'action');
            if (e.data?.success) inc(t.actions, action);
            else inc(t.failures, `${action}:${String(e.data?.reason ?? 'failed')}`);
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
        for (const [name, t] of this.members) {
            const xp = Math.max(0, t.xp1 - t.xp0);
            xpTotal += xp;
            deaths += t.deaths;
            const openers = this.fights.map(f => f.openerMs[name]).filter(v => v !== undefined);
            members[name] = {
                role: t.role, className: t.className, level: t.level0 === t.level1 ? `${t.level1}` : `${t.level0}→${t.level1}`,
                xp, xpPerHour: Math.round(xp / hours), deaths: t.deaths, actions: t.actions, failures: t.failures,
                idleInFights: pct(t.idle, t.engageSamples), idleReasons: t.idleReasons,
                targeted: pct(t.targeted, t.fightSamples), inMelee: pct(t.inMelee, t.fightSamples),
                movingInFights: t.role === 'tank' ? null : pct(t.moving, t.engageSamples),
                openerMs: median(openers.filter((v): v is number => v !== null)), fightsWithoutNuke: openers.filter(v => v === null).length,
                minHp: t.minHp,
                waitedFor: Object.fromEntries(Object.entries(t.waitMs).map(([k, v]) => [k, pct(v, durationMs)]).filter(([, v]) => (v as number) > 0)),
            };
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
        report.findings = findingsFor(report);
        return report;
    }
}

const top = (r: Record<string, number>, n = 2) => Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ');

/** Rule-based findings: what went wrong and which setting or behaviour to look at. */
export function findingsFor(r: RunReport): Finding[] {
    const out: Finding[] = [];
    const t = r.totals;
    if (t.kills === 0 && r.durationMs > 60_000) {
        out.push({ severity: 'high', topic: 'no-kills', issue: 'No kills in the whole run', evidence: `phases ${JSON.stringify(r.phases)}; last events: ${r.timeline.slice(-3).join(' | ')}`, suggestion: 'Check the camp (settings.camp, campLevelBand), the con window (minCon/maxCon) and huntRadius; the orders log says why nothing was pulled.' });
    }
    if (t.tankHold !== null && t.tankHold < 75) {
        const loose = Object.entries(r.members).filter(([, m]) => m.role !== 'tank').sort((a, b) => b[1].targeted - a[1].targeted)[0];
        out.push({ severity: t.tankHold < 50 ? 'high' : 'medium', topic: 'aggro', issue: `The tank held the focus only ${t.tankHold}% of fight time`, evidence: loose ? `${loose[0]} was targeted ${loose[1].targeted}% of fight time` : '', suggestion: 'Raise holdMs so damage dealers open later, open with DoTs (less burst aggro), or keep healers out of range of adds (combatRange).' });
    }
    for (const [name, m] of Object.entries(r.members)) {
        if (m.deaths) out.push({ severity: 'high', topic: 'deaths', member: name, issue: `${name} died ${m.deaths}×`, evidence: r.timeline.filter(l => l.includes(`${name} died`) || l.includes(`${name}:`)).slice(-4).join(' | '), suggestion: m.role === 'tank' ? 'Lower the con window or heal the tank earlier (heal.tank); retreat sooner (retreat.tankHp).' : 'Stand farther back (combatRange), flee to the tank earlier, or mezz adds sooner.' });
        const interrupts = Object.entries(m.failures).filter(([k]) => k.endsWith(':interrupted')).reduce((a, [, v]) => a + v, 0);
        if (interrupts >= 2) out.push({ severity: 'medium', topic: 'interrupts', member: name, issue: `${name} was interrupted ${interrupts}×`, evidence: `targeted ${m.targeted}% of fight time, in melee range ${m.inMelee}%`, suggestion: 'Wait longer for the tank (holdMs), stand farther (combatRange), or let flee() run before casting.' });
        // Healers and supports idle when nobody needs them; that is fine.
        if ((m.role === 'nuker' || m.role === 'melee') && m.idleInFights > 40) out.push({ severity: 'medium', topic: 'idle', member: name, issue: `${name} was idle ${m.idleInFights}% of fight time`, evidence: `idle because: ${top(m.idleReasons, 3) || 'unknown'}`, suggestion: 'Check its behaviour list and spells for the role; "no power" points at mana (ready.mana, rest), "waiting for the tank" at holdMs.' });
        if (m.role !== 'tank' && m.inMelee > 15) out.push({ severity: 'medium', topic: 'positioning', member: name, issue: `${name} stood in melee range of an attacker ${m.inMelee}% of fight time`, evidence: `targeted ${m.targeted}%, min health ${m.minHp}%`, suggestion: 'Widen combatRange for its role, or put position() before its damage behaviour.' });
        // Every step in a fight delays a cast; older reports lack the field.
        if ((m.movingInFights ?? 0) > 20) out.push({ severity: m.movingInFights! >= 35 ? 'medium' : 'low', topic: 'positioning', member: name, issue: `${name} was moving ${m.movingInFights}% of engaged time`, evidence: `in melee range ${m.inMelee}%, targeted ${m.targeted}%${m.openerMs != null ? `, first nuke ${secs(m.openerMs)} after the engage (median)` : ''}`, suggestion: 'Widen the combatRange limits for its role (it moves only when closer than the min or farther than the max), or raise slotSlack so it stays where it stands near its slot.' });
        for (const [why, share] of Object.entries(m.waitedFor)) {
            if (share < 15) continue;
            const fix: Record<string, string> = {
                health: m.role === 'tank' ? 'Let healers top the tank up between pulls (heal.outOfCombat above ready.hp), or heal it earlier in fights (heal.tank).' : 'Heal it between pulls (heal.outOfCombat), or keep it out of fights (combatRange, flee).',
                power: 'Lower ready.mana, or have this member spend less (DoTs over nukes, fewer buffs); check its rest() runs.',
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
    if (t.downtime > 60 && t.fights > 0) {
        const waits = Object.entries(r.phases).filter(([k]) => !['engage', 'pull', 'retreat'].includes(k)).map(([k, v]) => `${k} ${v}%`).join(', ');
        out.push({ severity: 'medium', topic: 'downtime', issue: `Downtime ${t.downtime}% (not fighting or pulling)`, evidence: waits, suggestion: 'Lower ready.hp/ready.mana, let healers top up out of combat (heal.outOfCombat), or pull higher cons for more XP per pull.' });
    }
    const adds = r.fights.reduce((a, f) => a + f.adds, 0);
    if (r.fights.length && adds / r.fights.length > 0.5) out.push({ severity: 'medium', topic: 'adds', issue: `${adds} adds in ${r.fights.length} fights`, evidence: r.fights.filter(f => f.adds).slice(0, 3).map(f => `${f.focus.join('/')}: +${f.adds}`).join(', '), suggestion: 'Pull targets farther from others (avoidAggressive, huntRadius), a base with more room (chooseBase), or more crowd control.' });
    if (t.retreats) out.push({ severity: 'low', topic: 'retreats', issue: `${t.retreats} retreat(s)`, evidence: r.timeline.filter(l => l.includes('retreat')).slice(-3).join(' | '), suggestion: 'If the retreats saved the group, keep them; if they ran from winnable fights, relax retreat.* thresholds.' });
    if (t.avgFightMs > 45_000) out.push({ severity: 'low', topic: 'pace', issue: `Fights take ${Math.round(t.avgFightMs / 1000)} s on average`, evidence: `${t.fights} fights`, suggestion: 'Lower maxCon, or check that every damage dealer actually casts (actions per member).' });
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
    lines.push('', '## Fights', '');
    for (const f of r.fights) {
        const openers = Object.entries(f.openerMs ?? {}).map(([n, ms]) => `${n} ${ms === null ? 'none' : secs(ms)}`).join(', ');
        lines.push(`- ${String(Math.floor(f.start / 60)).padStart(2, '0')}:${String(f.start % 60).padStart(2, '0')} ${f.focus.join(' / ') || '?'}: ${f.outcome} in ${Math.round(f.durationMs / 1000)} s, kills ${f.kills.length}, adds ${f.adds}, tank hold ${f.tankHold ?? '-'}%${openers ? `, first nuke: ${openers}` : ''}${f.deaths.length ? `, died: ${f.deaths.join(', ')}` : ''}`);
    }
    lines.push('', '## Timeline (last events)', '', '```', ...r.timeline, '```', '');
    return lines.join('\n');
}

/** Write runs/<stamp>.json, .md (and .log with `log`), compare with and append to runs/history.jsonl. Returns the .md path. */
export function saveReport(groupDir: string, r: RunReport, log?: string[]): string {
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
                r.previous = Object.fromEntries(['xpPerHour', 'killsPerHour', 'deaths', 'downtime', 'tankHold', 'avgFightMs'].map(k => [k, delta(k)]).filter(([, v]) => v) as [string, string][]);
            } catch {}
        }
    }
    appendFileSync(history, JSON.stringify(summary) + '\n');
    const stamp = r.startedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(r, null, 2));
    const md = join(dir, `${stamp}.md`);
    writeFileSync(md, formatReport(r));
    if (log) writeFileSync(join(dir, `${stamp}.log`), log.map(l => `${l}\n`).join(''));
    return md;
}
