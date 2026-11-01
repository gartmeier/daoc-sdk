// Publishes a group run to the gateway, so the viewer's group page can draw it
// (/viewer/group/<group>): about once a second a full snapshot of the board, the
// coordinator's camp and plan, the observer's score so far and the logged events
// the gateway hasn't acknowledged yet, POST /groups/<group>/publish (wire.ts). The
// answer may carry a wind-down someone asked for on the page.
//
// It must never disturb the run. It reads only the board, the observer and plain
// data captured at the start (never a member's SDK: under MCP its methods stall
// after an abort), runs on its own unref'd timer outside any execution, keeps one
// request in flight with a timeout, catches everything, and gives up for the run
// on an answer it can't use (an old gateway, a refusal).

import { executionContext } from '../execution-context';
import type { BasePlan } from './baseplan';
import type { Blackboard } from './blackboard';
import type { GroupObserver } from './observer';
import type { Capabilities, Contact, GroupEvent, GroupPicture, MemberReport, Point, Point3 } from './types';
import { isLoggedEvent, WIRE_VERSION, type ControlRequest, type CoordinatorView, type GroupPublish, type LiveReport, type PlanView, type RunMeta, type RunPhase, type RunResultView, type WireEvent } from './wire';

export interface GroupPublishOptions {
    /** Gateway HTTP base (default: the leader's, from its connection). */
    url?: string;
    /** Between publishes (default 1000; stretched when building one is slow). */
    intervalMs?: number;
    /** Apply a wind-down requested from the viewer (default true). */
    control?: boolean;
    /** Tests. */
    fetch?: typeof fetch;
}

export interface PublisherDeps {
    /** Group folder name: the id in the URL. */
    group: string;
    /** The principal the gateway checks: group.json leader (else the first member), its bot.env login. */
    leader: { bot: string; username: string; password: string };
    /** Gateway HTTP base of the leader's connection. */
    url: string;
    /** Every member as bot folder and gateway username, in group.json order. */
    roster: { bot: string; username: string }[];
    meta: RunMeta;
    board: Pick<Blackboard, 'picture' | 'onEvent'>;
    observer: Pick<GroupObserver, 'snapshot'>;
    /** The run's clock until running() hands over the live one. */
    timing: () => GroupPublish['timing'];
    /** A wind-down for this run, once per request id. false refuses it. */
    onControl: (req: ControlRequest) => boolean | void;
    log: (line: string) => void;
    /** Tests: the clock backoff and the report/plan intervals use. */
    now?: () => number;
}

/** Group ids the gateway routes (gateway/groups.ts). */
const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OUTBOX = 1000;
const MAX_EVENTS = 300;
const MAX_CONTACTS = 200;
const MAX_APPLIED = 16;
const REPORT_MS = 5000;
const PLAN_MS = 30_000;
const TIMEOUT_MS = 3000;
const ENDING_TIMEOUT_MS = 2000;
/** After a network error or a 5xx. */
const BACKOFF_MS = [2000, 4000, 8000, 16_000, 30_000];
/** BasePlan.margin is Infinity with no aggressive spawn near; JSON has no Infinity. */
const UNBOUNDED_MARGIN = 1_000_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const cut = (s: string, max: number) => s.length > max ? `${s.slice(0, max - 1)}…` : s;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** "timed out", or the error's message. */
function describe(e: unknown): string {
    if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') return 'timed out';
    return cut(errorText(e), 160);
}

/** Finish the current fight, then end: the deadline moves to now, the hard stop to now + grace. Only ever earlier. */
export function windDownClock(clock: { deadline: number; hardStop: number }, now: number, graceMs: number): { deadline: number; hardStop: number } {
    return { deadline: Math.min(clock.deadline, now), hardStop: Math.min(clock.hardStop, now + graceMs) };
}

class TooBig extends Error {}

/**
 * A JSON-safe copy of `value`: RegExp → its source text, Set → array, Map → object,
 * Date → ISO text, functions and symbols dropped, cycles and nesting deeper than 6
 * cut. Bigger than maxBytes of JSON: { truncated: true }. Never throws (null when
 * something can't be read).
 */
export function jsonSafe(value: unknown, maxBytes: number): unknown {
    const ancestors: object[] = [];
    let nodes = 0;
    const walk = (v: unknown, depth: number): unknown => {
        // Every value costs at least a byte of JSON: stop early on a huge structure.
        if (++nodes > maxBytes) throw new TooBig();
        if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v === 'bigint') return v.toString();
        if (typeof v !== 'object') return undefined;
        if (v instanceof RegExp) return String(v);
        if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
        if (ancestors.includes(v)) return '[cycle]';
        if (depth >= 6) return '[too deep]';
        ancestors.push(v);
        try {
            if (Array.isArray(v) || v instanceof Set) {
                const out: unknown[] = [];
                for (const x of v) out.push(walk(x, depth + 1) ?? null);
                return out;
            }
            const out: Record<string, unknown> = {};
            const entries: Iterable<[unknown, unknown]> = v instanceof Map ? v : Object.entries(v);
            for (const [k, x] of entries) {
                const w = walk(x, depth + 1);
                if (w !== undefined) out[String(k)] = w;
            }
            return out;
        } finally {
            ancestors.pop();
        }
    };
    try {
        const out = walk(value, 0) ?? null;
        return Buffer.byteLength(JSON.stringify(out)) > maxBytes ? { truncated: true } : out;
    } catch (e) {
        return e instanceof TooBig ? { truncated: true } : null;
    }
}

function point(v: unknown): Point | null {
    const p = v as Record<string, unknown> | null;
    return p && typeof p === 'object' && finite(p.x) && finite(p.y) ? { x: p.x, y: p.y } : null;
}

function point3(v: unknown): Point3 | null {
    const p = point(v);
    const z = (v as Record<string, unknown> | null)?.z;
    return p ? { ...p, z: finite(z) ? z : 0 } : null;
}

/** Valid points of an array: the first `max`, or the last `max` (newest). */
function points(v: unknown, max: number, newest = false): Point[] {
    if (!Array.isArray(v)) return [];
    const window = newest ? v.slice(-4 * max) : v.slice(0, 4 * max);
    const out = window.map(point).filter((p): p is Point => p !== null);
    return newest ? out.slice(-max) : out.slice(0, max);
}

const MEMORY_KEYS = ['camp', 'campLevel', 'base', 'facing', 'route', 'leg', 'avoidCamps', 'exclude'];

/** The parts of decidePve's memory worth drawing (CoordinatorView); null for a strategy that keeps none of them. Never throws. */
export function memoryView(mem: unknown): CoordinatorView | null {
    try {
        if (!mem || typeof mem !== 'object') return null;
        const m = mem as Record<string, any>;
        if (!MEMORY_KEYS.some(k => k in m)) return null;
        const c = m.camp;
        const camp = point(c) ? {
            x: c.x, y: c.y, z: finite(c.z) ? c.z : 0, zone: typeof c.zone === 'string' ? cut(c.zone, 80) : '',
            count: finite(c.count) ? c.count : 0, names: typeof c.names === 'string' ? cut(c.names, 300) : '',
        } : null;
        // exclude is a Set of failed pulls; Set iteration is insertion order, so the last ones are the newest.
        const ex = m.exclude instanceof Set ? [...m.exclude] : Array.isArray(m.exclude) ? m.exclude : [];
        return {
            camp, campLevel: finite(m.campLevel) ? m.campLevel : null, base: point3(m.base), facing: point(m.facing),
            route: points(m.route, 200), leg: point3(m.leg), avoidCamps: points(m.avoidCamps, 50, true),
            excluded: ex.filter(finite).slice(-50),
        };
    } catch {
        return null;
    }
}

/** A BasePlan as PlanView: at most 64 targets and 64 unsafe spawns, names and reasons only. Never throws. */
export function planView(plan: unknown): PlanView | null {
    try {
        const p = plan as BasePlan | null;
        if (!p || typeof p !== 'object') return null;
        const base = point3(p.base), facing = point(p.facing);
        if (!base || !facing) return null;
        const spawn = (s: any) => point(s) ? { name: typeof s.name === 'string' ? cut(s.name, 80) : '?', level: finite(s.level) ? s.level : 0, x: s.x as number, y: s.y as number } : null;
        const targets: PlanView['targets'] = [];
        for (const s of Array.isArray(p.targets) ? p.targets.slice(0, 64) : []) {
            const v = spawn(s);
            if (v) targets.push({ ...v, d: finite(s.d) ? s.d : 0 });
        }
        const unsafe: PlanView['unsafe'] = [];
        for (const s of Array.isArray(p.unsafe) ? p.unsafe.slice(0, 64) : []) {
            const v = spawn(s);
            if (v) unsafe.push({ ...v, why: typeof s.why === 'string' ? cut(s.why, 120) : '' });
        }
        return { base, facing, score: finite(p.score) ? p.score : 0, margin: finite(p.margin) ? p.margin : UNBOUNDED_MARGIN, targets, unsafe };
    } catch {
        return null;
    }
}

/** The board's picture as published: no buffSpells (the gateway draws no buff plans), contacts nearest the members first. */
function pictureView(p: GroupPicture): GroupPicture {
    const members = p.members.map(m => {
        if (!m.capabilities) return m;
        const { buffSpells: _spells, ...caps } = m.capabilities;
        return { ...m, capabilities: caps as Capabilities };
    });
    return { ...p, members, contacts: nearestContacts(p.contacts, p.members, MAX_CONTACTS) };
}

function nearestContacts(contacts: Contact[], members: MemberReport[], max: number): Contact[] {
    if (contacts.length <= max) return contacts;
    const away = (c: Contact) => {
        let best = Infinity;
        for (const m of members) if (m.regionId === c.regionId) best = Math.min(best, Math.hypot(c.x - m.x, c.y - m.y));
        return Number.isNaN(best) ? Infinity : best;
    };
    return contacts.map(c => ({ c, d: away(c) })).sort((a, b) => a.d - b.d).slice(0, max).map(x => x.c);
}

const KINDS: ReadonlySet<string> = new Set(['orders', 'activity', 'result', 'death', 'kill', 'level', 'note']);

/** An outbox entry as sent: text at most 300 chars, data at most 512 B of JSON. */
function wireEvent(seq: number, e: GroupEvent): WireEvent {
    try {
        const w: WireEvent = { seq, at: finite(e.at) ? e.at : 0, kind: e.kind, text: cut(String(e.text ?? ''), 300) };
        if (e.member !== undefined) w.member = cut(String(e.member), 64);
        if (e.targetId !== undefined) w.targetId = finite(e.targetId) ? e.targetId : null;
        if (e.data !== undefined && e.data !== null) {
            const d = jsonSafe(e.data, 512);
            w.data = d && typeof d === 'object' && !Array.isArray(d) ? d as Record<string, unknown> : { truncated: true };
        }
        return w;
    } catch {
        const at = (e as GroupEvent | null)?.at, kind = (e as GroupEvent | null)?.kind;
        return { seq, at: finite(at) ? at : 0, kind: kind && KINDS.has(kind) ? kind : 'note', text: '[unserialisable event]' };
    }
}

/**
 * Logged board events numbered from 1, kept until the gateway acknowledges them
 * (a failed publish loses nothing). At most `max`: overflow drops the oldest.
 */
export class EventOutbox {
    private items: { seq: number; event: GroupEvent }[] = [];
    private head = 0;
    private seq = 0;
    /** Dropped before the gateway acknowledged them. */
    dropped = 0;

    constructor(private readonly max = MAX_OUTBOX) {}

    get size(): number { return this.items.length - this.head; }

    /** O(1): keeps a reference, copies nothing. */
    push(event: GroupEvent): number {
        this.items.push({ seq: ++this.seq, event });
        if (this.size > this.max) { this.head++; this.dropped++; }
        this.compact();
        return this.seq;
    }

    /** The gateway has everything up to `seq`. */
    ack(seq: number): void {
        while (this.head < this.items.length && this.items[this.head]!.seq <= seq) this.head++;
        this.compact();
    }

    /** The oldest `n` unacknowledged entries. */
    peek(n: number): { seq: number; event: GroupEvent }[] {
        return this.items.slice(this.head, this.head + n);
    }

    clear(): void {
        this.items = [];
        this.head = 0;
    }

    private compact(): void {
        if (this.head > 256 && this.head * 2 > this.items.length) {
            this.items.splice(0, this.head);
            this.head = 0;
        }
    }
}

/** What one publish carried, to note once the gateway took it. */
interface Sent { at: number; planRev: number | null; report: boolean }

const NO_PLAN = Symbol('no plan yet');

export class GroupPublisher {
    /** Random per run. */
    readonly runId = crypto.randomUUID();
    /** No requests at all: publish: false, DAOC_GROUP_PUBLISH=0|off|false, or a group id the gateway can't route. */
    readonly disabled: boolean;
    private phase: RunPhase = 'starting';
    private error: string | null = null;
    private result: RunResultView | undefined;
    /** Gave up for the rest of the run. */
    private stopped = false;
    private readonly outbox = new EventOutbox();
    private unsubscribe: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private inFlight: Promise<void> | null = null;
    private memory: (() => Record<string, any> | null) | null = null;
    private timing: () => GroupPublish['timing'];
    private publishSeq = 0;
    private planRev = 0;
    private lastPlan: unknown = NO_PLAN;
    /** planRev the gateway last took, and when. */
    private planTaken = -1;
    private planAt = 0;
    private reportRev = 0;
    private reportAt = -Infinity;
    private readonly applied: string[] = [];
    private readonly seenControl = new Set<string>();
    private failures = 0;
    private retryAt = 0;
    private failing = false;
    private succeeded = false;
    private buildMs = 0;
    private buildErrors = 0;
    private readonly counts = { publishes: 0, skipped: 0, failed: 0 };
    private readonly http: (url: string, init: RequestInit) => Promise<Response>;
    private readonly base: string;
    private readonly endpoint: string;
    private readonly intervalMs: number;
    private readonly control: boolean;
    private readonly now: () => number;

    constructor(private readonly deps: PublisherDeps, options: GroupPublishOptions | false = {}) {
        const opts = options || {};
        this.base = String(opts.url ?? deps.url).replace(/\/+$/, '');
        this.endpoint = `${this.base}/groups/${deps.group}/publish`;
        this.intervalMs = finite(opts.intervalMs) ? Math.min(60_000, Math.max(10, opts.intervalMs)) : 1000;
        this.control = opts.control !== false && deps.meta.control !== false;
        const f = opts.fetch;
        this.http = f ? (url, init) => f(url, init) : (url, init) => fetch(url, init);
        this.now = deps.now ?? Date.now;
        this.timing = deps.timing;
        const off = /^(0|off|false)$/i.test(process.env.DAOC_GROUP_PUBLISH?.trim() ?? '');
        const routable = GROUP_ID.test(deps.group);
        this.disabled = options === false || off || !routable;
        if (options !== false && !off && !routable) deps.log(`group publish off: "${deps.group}" is not a group id the gateway serves (letters, digits, _ and -)`);
        if (this.disabled) return;
        // O(1) and guarded: listeners run inside the board's emit, unguarded.
        this.unsubscribe = deps.board.onEvent(e => { try { if (isLoggedEvent(e)) this.outbox.push(e); } catch {} });
        this.schedule(this.intervalMs);
    }

    /** The group is running: publish its coordinator's memory and the live clock from now on. */
    running(memory: () => Record<string, any> | null, timing?: () => GroupPublish['timing']): void {
        if (this.disabled || this.phase !== 'starting') return;
        this.phase = 'running';
        this.memory = memory;
        if (timing) this.timing = timing;
    }

    /**
     * The run is stopping: one 'ending' publish, fire and forget. `error`: why it
     * failed, null when it ends normally (the result says how). The runner calls it
     * at its abort and first thing in its finally, so an MCP abort that stalls the
     * rest still says so (the gateway turns it into 'ended' after 30 s). The first
     * call counts; never throws.
     */
    ending(error: string | null): void {
        try {
            if (this.disabled || this.phase === 'ending' || this.phase === 'ended') return;
            this.phase = 'ending';
            if (error !== null) this.error = cut(String(error), 300);
            this.clearTimer();
            if (!this.stopped) void this.send(ENDING_TIMEOUT_MS, true);
        } catch {}
    }

    /** The last publish ('ended', with the result or the error). Resolves within capMs whatever the gateway does; never throws. */
    async finish(end: { result?: RunResultView; error?: unknown } = {}, capMs = 1500): Promise<void> {
        let cap: ReturnType<typeof setTimeout> | undefined;
        try {
            if (this.disabled || this.phase === 'ended') return;
            this.phase = 'ended';
            this.clearTimer();
            if (end.error !== undefined && end.error !== null) this.error = cut(errorText(end.error), 300);
            // The last word agrees with the result: a run that ended normally failed in nothing.
            else if (end.result && end.result.stoppedBy !== 'error') this.error = null;
            if (end.result) this.result = { ...end.result, findings: end.result.findings.slice(0, 100) };
            if (this.stopped) return;
            const sent = this.send(Math.max(1, capMs), true);
            await Promise.race([sent, new Promise<void>(resolve => { cap = setTimeout(resolve, capMs); })]);
        } catch {
        } finally {
            clearTimeout(cap);
            this.unsubscribe?.();
            this.unsubscribe = null;
            this.outbox.clear();
        }
    }

    /** Counters (tests, diagnostics). */
    stats(): { phase: RunPhase; disabled: boolean; stopped: boolean; inFlight: boolean; publishes: number; skipped: number; failed: number; pending: number; dropped: number } {
        return { phase: this.phase, disabled: this.disabled, stopped: this.stopped, inFlight: this.inFlight !== null, ...this.counts, pending: this.outbox.size, dropped: this.outbox.dropped };
    }

    private schedule(delay: number): void {
        if (this.stopped || this.timer || (this.phase !== 'starting' && this.phase !== 'running')) return;
        // On no execution's clock: an aborted script or MCP call must neither cancel nor wedge it.
        this.timer = executionContext.exit(() => setTimeout(() => this.tick(), delay));
        this.timer.unref?.();
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private tick(): void {
        this.timer = null;
        try {
            if (this.inFlight) this.counts.skipped++;
            else if (this.now() >= this.retryAt) this.inFlight = this.send(TIMEOUT_MS, false).finally(() => { this.inFlight = null; });
        } catch {}
        // Building takes about a millisecond; should it ever take long, publish less often (at most ~5 % of the loop).
        this.schedule(Math.min(10_000, Math.max(this.intervalMs, 20 * this.buildMs)));
    }

    /** Build and POST one publish. `final`: 'ending'/'ended', outside single-flight and backoff. Never rejects. */
    private send(timeoutMs: number, final: boolean): Promise<void> {
        let body: string, sent: Sent;
        const t0 = performance.now();
        try {
            const built = this.build();
            sent = built.sent;
            body = JSON.stringify(built.body);
        } catch (e) {
            // One line per run: a broken build repeats every second.
            if (++this.buildErrors === 1) this.deps.log(`group publish: could not build a publish: ${describe(e)}`);
            return Promise.resolve();
        } finally {
            this.buildMs = performance.now() - t0;
        }
        this.counts.publishes++;
        return this.post(body, timeoutMs, final, sent).catch(() => {});
    }

    private build(): { body: GroupPublish; sent: Sent } {
        const now = this.now();
        const optional = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
        const mem = this.memory ? optional(this.memory, null) : null;
        const body: GroupPublish = {
            v: WIRE_VERSION, runId: this.runId, publishSeq: ++this.publishSeq, sentAt: now,
            group: this.deps.group, leader: this.deps.leader.bot, roster: this.deps.roster,
            state: this.phase, error: this.error, meta: this.deps.meta,
            picture: pictureView(this.deps.board.picture()),
            timing: optional(this.timing, { windingDown: false, deadline: 0, hardStop: 0 }),
            coordinator: memoryView(mem),
            planRev: this.planRev, reportRev: this.reportRev,
            events: this.outbox.peek(MAX_EVENTS).map(i => wireEvent(i.seq, i.event)),
            dropped: this.outbox.dropped, applied: [...this.applied],
        };
        const sent: Sent = { at: now, planRev: null, report: false };
        if (mem) {
            // Plans are big and change rarely: on a change (until the gateway took it), else every 30 s.
            const plan = optional(() => mem.plan ?? null, null);
            if (plan !== this.lastPlan) { this.lastPlan = plan; this.planRev++; }
            if (this.planRev !== this.planTaken || now - this.planAt >= PLAN_MS) {
                body.plan = planView(plan);
                body.planRev = sent.planRev = this.planRev;
            }
        }
        // The score so far every 5 s while running, and the final one at the end of a run that ran.
        if ((this.phase === 'ended' && this.memory) || (this.phase === 'running' && now - this.reportAt >= REPORT_MS)) {
            const report = optional<LiveReport | null>(() => this.deps.observer.snapshot(), null);
            if (report) {
                body.report = report;
                body.reportRev = ++this.reportRev;
                sent.report = true;
            }
        }
        if (this.phase === 'ended' && this.result) body.result = this.result;
        return { body, sent };
    }

    private async post(body: string, timeoutMs: number, final: boolean, sent: Sent): Promise<void> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.deps.leader.password) headers.Authorization = `Bearer ${this.deps.leader.password}`;
        let status: number, json: boolean, answer: any = null;
        try {
            const res = await this.http(this.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
            status = res.status;
            json = /^application\/json\b/i.test(res.headers.get('content-type') ?? '');
            const text = await res.text();
            if (json) { try { answer = JSON.parse(text); } catch {} }
        } catch (e) {
            if (!final) this.failed(describe(e));
            return;
        }
        if (this.stopped) return;
        const reason = typeof answer?.error === 'string' ? cut(answer.error, 200) : '';
        if (status >= 500) {
            if (!final) this.failed(`HTTP ${status}${reason ? `: ${reason}` : ''}`);
            return;
        }
        // An old gateway answers any unknown POST with its 200 text/plain help page.
        if (!json || !answer || typeof answer !== 'object') return this.stop(`${this.base} answered HTTP ${status} without JSON: the gateway predates the group channel`);
        if (answer.ok !== true || status >= 300) return this.stop(`the gateway refused it (HTTP ${status}${reason ? `: ${reason}` : ''})`);
        this.answered(answer, sent);
    }

    private answered(answer: Record<string, unknown>, sent: Sent): void {
        const recovered = this.failing;
        this.failing = false;
        this.failures = 0;
        this.retryAt = 0;
        if (!this.succeeded) this.deps.log(`viewer: ${this.base}/viewer/group/${this.deps.group}`);
        else if (recovered) this.deps.log('group publish: the gateway answers again');
        this.succeeded = true;
        if (finite(answer.ackSeq)) this.outbox.ack(answer.ackSeq);
        if (sent.planRev !== null) { this.planTaken = sent.planRev; this.planAt = sent.at; }
        if (sent.report) this.reportAt = sent.at;
        if (Array.isArray(answer.control) && (this.phase === 'starting' || this.phase === 'running')) {
            for (const c of answer.control.slice(0, MAX_APPLIED)) this.apply(c);
        }
    }

    /** A network error or a 5xx: back off 2, 4, 8, 16, 30 s; one line when the streak starts. */
    private failed(why: string): void {
        if (this.stopped || (this.phase !== 'starting' && this.phase !== 'running')) return;
        this.counts.failed++;
        this.retryAt = this.now() + BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
        this.failures++;
        if (!this.failing) this.deps.log(`group publish to ${this.base} failed (${why}); retrying with backoff`);
        this.failing = true;
    }

    /** Give up for the rest of the run (an answer that won't change by retrying). */
    private stop(why: string): void {
        if (this.stopped) return;
        this.stopped = true;
        this.clearTimer();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.outbox.clear();
        this.deps.log(`group publish stopped for this run: ${why}`);
    }

    /** A control request from the answer: a wind-down for this run, applied once per id. */
    private apply(c: unknown): void {
        const r = c as Partial<ControlRequest> | null;
        if (!this.control || !r || typeof r !== 'object' || r.kind !== 'windDown' || r.runId !== this.runId) return;
        if (typeof r.id !== 'string' || !r.id || r.id.length > 128 || this.seenControl.has(r.id)) return;
        this.seenControl.add(r.id);
        if (this.seenControl.size > 64) this.seenControl.delete(this.seenControl.values().next().value!);
        const req: ControlRequest = {
            id: r.id, runId: this.runId, kind: 'windDown',
            reason: typeof r.reason === 'string' ? cut(r.reason.replace(/\s+/g, ' ').trim(), 120) : '',
            requestedAt: finite(r.requestedAt) ? r.requestedAt : this.now(),
        };
        try {
            if (this.deps.onControl(req) === false) return;
        } catch (e) {
            this.deps.log(`group publish: applying a wind-down threw: ${describe(e)}`);
            return;
        }
        this.applied.push(req.id);
        if (this.applied.length > MAX_APPLIED) this.applied.splice(0, this.applied.length - MAX_APPLIED);
    }
}
