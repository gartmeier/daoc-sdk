// Browser page for one group: every member on one map, with what the group's
// run decided while one publishes. Bundled by routes.ts with Bun.build.
//
// It polls GET /groups/<id>/live about once a second (gateway/groups.ts builds
// the frame from the members' own states plus the run's latest publish) and
// GET /groups/<id>/runs every 30 s. It only reads: the one request that changes
// anything is a wind-down (POST /groups/<id>/control), which the run applies
// itself after its current fight. Taking control of a member would pre-empt the
// run's connection and abort the run for everyone, so the page offers no member
// actions at all; member names link to their own pages.

import { CON_HEX, conColor } from './con-level';
import {
    appendBySeq, canWindDown, ccSeen, conReference, CURRENT_STATES, deathContext, enemyTags, eventVisible, gatewayRestarted, isGroupFrame, isThreat,
    listedContacts, logLineKind, mapRegion, mergeEvents, npcShown, phaseClass, retryRuns, roleLetter, runFailed, runPill, runRegion, timeLeft,
    type FeedFilters, type FeedLine,
} from './group-logic';
import { authHeaders, shouldLoadRegion } from './logic';
import { headingVec, MapView, type Pt, type RegionData } from './map-view';
import { ago, arr, clamp, clock, drawPass, dur, esc, miniBar, mmss, num, REALM_HEX, safely, sections, toast as showToast } from './ui-kit';
import type { ControlAnswer, ControlView, GroupFrame, GroupMemberView, GroupRuns, PassiveEvent, RunView, WorldContact } from '../group-types';
import type { LiveReport, PlanView, RunMeta, WireEvent } from '../../sdk/group/wire';
import type { Orders } from '../../sdk/group/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const GROUP = document.body.dataset.group ?? '';
const GID = encodeURIComponent(GROUP);

const POLL_MS = 1000;
const HIDDEN_POLL_MS = 5000;
const RETRY_MS = 3000;
const MISSING_MS = 5000;
const OLD_GATEWAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5000;
const RUNS_EVERY_MS = 30_000;
/** Run events and passive events the page keeps (each). */
const MAX_FEED = 1000;
/** Death markers stay on the map this long. */
const DEATHS_FOR_MS = 2 * 3600_000;
/** Lines of a run log drawn at once. */
const MAX_LOG_LINES = 3000;
const STAMP = /^\d{8}-\d{6}$/;

const short = (id: string) => String(id).slice(0, 8);
const lower = (s: unknown) => String(s ?? '').toLowerCase();
const fmtInt = (n: unknown) => Math.round(num(n)).toLocaleString('en-US');
const memberName = (m: GroupMemberView) => m.player?.name || m.run?.name || m.charName || m.bot;
/** Every name a member goes by in events: bot folder, bot.env CHAR_NAME, live character name. */
const memberNames = (m: GroupMemberView) => [m.bot, m.charName, m.player?.name, m.run?.name].filter((n): n is string => typeof n === 'string' && n !== '');

function readStored(key: string): string {
    try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; }
}
function store(key: string, value: string) {
    try { sessionStorage.setItem(key, value); } catch {}
}

// ── State ───────────────────────────────────────────────────────────────────

let frame: GroupFrame | null = null;
/** Date.now() when the frame arrived; frame.now is the gateway's clock at that moment. */
let frameAt = 0;
// What the page holds of the current run; a new runId starts over.
let runId: string | null = null;
let meta: RunMeta | null = null;
let plan: PlanView | null = null;
let report: LiveReport | null = null;
let planRev: number | null = null;
let reportRev: number | null = null;
let eventSeq = 0;
let runEvents: WireEvent[] = [];
let passiveSeq = 0;
let passiveEvents: PassiveEvent[] = [];
/** GroupFrame.boot of the last frame: the gateway store's start; a new one means every cursor above starts over. */
let lastBoot: number | null = null;
let runs: GroupRuns | null = null;

let regionData: RegionData | null = null;
let regionLoading: number | null = null;
let regionFailure: { regionId: number; at: number } | null = null;

/** Map item key (m:<bot>, c:<region:objectId>, d:<seq>, ...) of the selection. */
let selected: string | null = null;
/** 'group', 'off' or 'm:<bot>'. */
let followMode = 'group';
let fitted = false;
let problem: string | null = null;

let password = readStored(`viewer-group-pw-${GROUP}`);
let savedPassword = password;
let triedBotPageKey = false;

/** The gateway's clock now, from the last frame. */
const gwNow = () => (frame ? frame.now + (Date.now() - frameAt) : Date.now());

// ── Polling ─────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
/** A 401: nothing more until the password is typed. */
let stopped = false;
let failures = 0;
let quickPolls = 0;
let pollFailed = false;

function schedule(ms: number) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, ms);
}

/** One request at a time: a setTimeout chain, never an interval, so slow answers never stack. */
async function poll() {
    if (polling || stopped) return;
    polling = true;
    let next: number | null = null;
    try {
        next = await pollOnce();
    } catch (error) {
        // A bug handling an answer: say it once and keep polling.
        if (!pollFailed) { pollFailed = true; console.error('viewer: poll failed', error); }
        next = RETRY_MS;
    } finally {
        polling = false;
    }
    if (stopped) return;
    if (next === 0 && ++quickPolls > 10) next = null;
    if (next !== 0) quickPolls = 0;
    schedule(next ?? (document.hidden ? HIDDEN_POLL_MS : POLL_MS));
}

async function getJson(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; body: any; json: boolean }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(path, { cache: 'no-store', headers: authHeaders(password), signal: ctl.signal });
        const text = await res.text();
        // An old gateway answers unknown paths with its plain-text help page.
        if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) return { status: res.status, body: null, json: false };
        try { return { status: res.status, body: JSON.parse(text), json: true }; } catch { return { status: res.status, body: null, json: false }; }
    } finally {
        clearTimeout(timer);
    }
}

/** Returns the delay before the next poll: 0 for at once, null for the normal interval. */
async function pollOnce(): Promise<number | null> {
    const q = new URLSearchParams();
    if (runId) { q.set('run', runId); q.set('events', String(eventSeq)); }
    q.set('passive', String(passiveSeq));
    if (planRev !== null) q.set('planRev', String(planRev));
    if (reportRev !== null) q.set('reportRev', String(reportRev));
    let r: Awaited<ReturnType<typeof getJson>>;
    try {
        r = await getJson(`/groups/${GID}/live?${q}`);
    } catch {
        failures++;
        if (failures >= 2) setProblem('Gateway unreachable, retrying…');
        return RETRY_MS;
    }
    failures = 0;
    if (!r.json) {
        setProblem('This gateway predates group views. Restart it from a checkout that has gateway/groups.ts.');
        return OLD_GATEWAY_MS;
    }
    if (r.status === 401) return needPassword(r.body);
    if (r.status === 404) {
        setProblem(`No such group: the gateway has no groups/${GROUP}/group.json on its disk.`);
        return MISSING_MS;
    }
    if (r.status !== 200 || !isGroupFrame(r.body)) {
        setProblem(`Unexpected answer from the gateway (HTTP ${r.status})${typeof r.body?.error === 'string' ? `: ${r.body.error}` : ''}`);
        return RETRY_MS;
    }
    setProblem(null);
    if (password && password !== savedPassword) { store(`viewer-group-pw-${GROUP}`, password); savedPassword = password; }
    // The runs list went out with the password /live refused (the bot page's key came after): ask again with this one.
    if (retryRuns(runs !== null, runsBusy, runsFailedWith, password)) void loadRuns();
    return applyFrame(r.body) ? 0 : null;
}

function needPassword(body: any): number | null {
    const auth = body?.auth && typeof body.auth === 'object' ? body.auth : null;
    const leaderBot = typeof auth?.bot === 'string' ? auth.bot : frame?.leader.bot ?? 'leader';
    const leaderUser = typeof auth?.username === 'string' ? auth.username : frame?.leader.username ?? null;
    // The bot page keeps the leader's password under its own key: try that once before asking.
    const botPage = leaderUser ? readStored(`viewer-pw-${leaderUser}`) : '';
    if (!triedBotPageKey && botPage && botPage !== password) {
        triedBotPageKey = true;
        password = botPage;
        return 0;
    }
    triedBotPageKey = true;
    stopped = true;
    showPassword(leaderBot);
    setProblem(`${password ? 'Wrong password' : 'Password required'}: this gateway checks the bot.env password of ${leaderBot}, the group's leader.`);
    return null;
}

/** Take a frame in; returns true when the page should ask again at once. */
function applyFrame(f: GroupFrame): boolean {
    const restarted = gatewayRestarted(lastBoot, f);
    if (typeof f.boot === 'number' && Number.isFinite(f.boot)) lastBoot = f.boot;
    let again = false;
    if (restarted) {
        // The gateway restarted: its seqs and revisions start over, so the events
        // and slow fields in this answer were cut against cursors that name other
        // things there. Drop everything held and ask again at once, like a page
        // that just loaded.
        resetRun(null);
        passiveSeq = 0;
        passiveEvents = [];
        again = true;
    } else {
        again = takeRunCursors(f.run);
        const p = f.passive;
        if (p.seq < passiveSeq) {
            // The passive seq went down: a gateway that sends no boot restarted.
            passiveSeq = 0;
            passiveEvents = [];
            again = true;
        } else {
            passiveEvents = appendBySeq(passiveEvents, arr(p.events), MAX_FEED);
            const got = arr(p.events).reduce((m, e) => Math.max(m, num(e?.seq)), 0);
            passiveSeq = Math.max(passiveSeq, got || p.seq);
            // One answer carries at most 300: fetch the rest at once.
            if (got && got < p.seq) again = true;
        }
    }
    frame = f;
    frameAt = Date.now();
    afterFrame();
    return again;
}

/** The run part of a frame from the same gateway; true when the page should ask again at once. */
function takeRunCursors(run: RunView | null): boolean {
    if ((run?.runId ?? null) !== runId) {
        // Another run (or none): what we hold belongs to the old one. Its events
        // and slow fields in this answer were cut against the old run's cursors.
        const stale = runId !== null;
        resetRun(run?.runId ?? null);
        if (run?.meta) meta = run.meta;
        if (!run) return false;
        return stale ? true : takeRun(run);
    }
    if (!run) return false;
    if (num(run.eventSeq) < eventSeq) {
        // The gateway lost this run's events (a restart without a boot): start the feed over.
        eventSeq = 0;
        runEvents = [];
        return true;
    }
    if (run.meta) meta = run.meta;
    return takeRun(run);
}

/** Events, plan and report of the current run's answer; true when more events wait. */
function takeRun(run: RunView): boolean {
    const events = arr(run.events);
    runEvents = appendBySeq(runEvents, events, MAX_FEED);
    eventSeq = events.reduce((m, e) => Math.max(m, num(e?.seq)), eventSeq);
    if ('plan' in run) plan = run.plan ?? null;
    if ('report' in run) report = run.report ?? null;
    planRev = num(run.planRev);
    reportRev = num(run.reportRev);
    return !!run.moreEvents;
}

function resetRun(next: string | null) {
    runId = next;
    meta = null;
    plan = null;
    report = null;
    planRev = null;
    reportRev = null;
    eventSeq = 0;
    runEvents = [];
}

function afterFrame() {
    const f = frame!;
    safely('follow options', () => updateFollowOptions(f));
    const region = currentRegion();
    if (region !== null && shouldLoadRegion(region, regionData?.regionId ?? null, regionLoading, regionFailure, Date.now())) void loadRegion(region);
    if (!fitted) {
        const pts = membersIn(region).map(m => m.player!);
        if (pts.length) { view.fit(pts); fitted = true; }
    }
    followCamera();
    view.invalidate();
    schedulePanel();
}

async function loadRegion(regionId: number) {
    regionLoading = regionId;
    let loaded: RegionData | null = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
        const res = await fetch(`/zones/${regionId}`, { cache: 'no-store', signal: ctl.signal });
        if (res.ok) loaded = await res.json() as RegionData;
    } catch {} finally {
        clearTimeout(timer);
    }
    // A slower answer for a region the map already left must not replace the current one.
    if (regionLoading !== regionId) return;
    regionLoading = null;
    if (loaded && Array.isArray(loaded.zones)) {
        regionData = loaded;
        regionFailure = null;
    } else {
        regionFailure = { regionId, at: Date.now() };
    }
    view.invalidate();
}

let runsBusy = false;
/** The password of the last runs request that brought no list, null after one that did. */
let runsFailedWith: string | null = null;
async function loadRuns() {
    if (runsBusy || stopped) return;
    runsBusy = true;
    const pw = password;
    let ok = false;
    try {
        const r = await getJson(`/groups/${GID}/runs?limit=20`);
        if (r.json && r.status === 200 && r.body && typeof r.body === 'object') {
            runs = r.body as GroupRuns;
            ok = true;
            schedulePanel();
        }
    } catch {} finally {
        runsFailedWith = ok ? null : pw;
        runsBusy = false;
    }
}

// ── Password and wind-down ──────────────────────────────────────────────────

const passwordInput = $<HTMLInputElement>('password');
const unlockBtn = $<HTMLButtonElement>('unlock');
passwordInput.value = password;

function showPassword(leaderBot?: string) {
    passwordInput.hidden = false;
    unlockBtn.hidden = false;
    if (leaderBot) passwordInput.placeholder = `${leaderBot} bot.env password`;
}

function unlock() {
    password = passwordInput.value;
    triedBotPageKey = true;
    stopped = false;
    failures = 0;
    setProblem(null);
    schedule(0);
    void loadRuns();
}
unlockBtn.addEventListener('click', unlock);
passwordInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') unlock(); });

let windBusy = false;
const windBtn = $<HTMLButtonElement>('winddown');

async function windDown() {
    const f = frame;
    const run = f?.run;
    if (!f || !run || !canWindDown(run, meta) || windBusy) return;
    // The gateway checks the leader's bot.env password for this even when reading needs none.
    const pw = passwordInput.value || password;
    if (!pw) {
        showPassword(f.leader.bot);
        passwordInput.focus();
        toast(`Type the bot.env password of ${f.leader.bot} (the group's leader), then press Wind down again`, true);
        return;
    }
    if (!confirm(`Finish the current fight, then end the ${f.name} run (report saved). A campaign, if any, continues with its next step.`)) return;
    windBusy = true;
    renderControl();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`/groups/${GID}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(pw) },
            body: JSON.stringify({ kind: 'windDown', runId: run.runId, reason: 'wind-down from the group page', password: pw }),
            signal: ctl.signal,
        });
        const body = await res.json().catch(() => null) as ControlAnswer | null;
        if (res.ok && body?.ok) {
            toast('Wind-down requested: the run ends after its current fight');
            if (pw !== savedPassword) { store(`viewer-group-pw-${GROUP}`, pw); savedPassword = pw; }
            password = pw;
        } else {
            if (res.status === 401) showPassword(f.leader.bot);
            toast(`Wind-down refused: ${body && !body.ok && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`}`, true);
        }
    } catch (error) {
        toast(`Wind-down failed: ${error instanceof Error ? error.message : error}`, true);
    } finally {
        clearTimeout(timer);
        windBusy = false;
        renderControl();
        if (!polling && !stopped) schedule(0);
    }
}
windBtn.addEventListener('click', () => void windDown());

const toastEl = $('toast');
const toast = (text: string, bad = false) => showToast(toastEl, text, bad);

function setProblem(text: string | null) {
    if (problem === text) return;
    problem = text;
    schedulePanel();
}

// ── Map ─────────────────────────────────────────────────────────────────────

type MapItem =
    | { key: string; kind: 'member'; m: GroupMemberView }
    | { key: string; kind: 'contact'; c: WorldContact }
    | { key: string; kind: 'death'; e: PassiveEvent }
    | { key: string; kind: 'spot'; title: string; lines: string[] };

const spot = (key: string, title: string, lines: string[]): MapItem => ({ key, kind: 'spot', title, lines: lines.filter(Boolean) });

const tooltip = $('tooltip');
const view = new MapView<MapItem>($<HTMLCanvasElement>('map'), {
    scaleKey: 'viewer-group-scale',
    draw: v => draw(v),
    onClick: hit => select(hit?.key ?? null),
    onDblClick: hit => { if (hit?.kind === 'member') window.open(`/viewer/${encodeURIComponent(hit.m.username)}`, '_blank', 'noopener'); },
    onHover: (hit, sx, sy) => safely('tooltip', () => showTooltip(hit, sx, sy)),
    onPan: () => setFollow('off'),
});
view.following = true;

const layer = { orders: true, plan: true, npcs: 'all', paths: true, deaths: true, zones: true };
const labelsBox = $<HTMLInputElement>('labels');
const followSel = $<HTMLSelectElement>('follow');

function followedBot(): string | null {
    return followMode.startsWith('m:') ? followMode.slice(2) : null;
}

function currentRegion(): number | null {
    return frame ? mapRegion(frame.members, followedBot()) : null;
}

function membersIn(region: number | null): GroupMemberView[] {
    if (!frame || region === null) return [];
    return frame.members.filter(m => m.player && m.player.regionId === region && Number.isFinite(m.player.x) && Number.isFinite(m.player.y));
}

function setFollow(mode: string) {
    followMode = mode;
    if (followSel.value !== mode) followSel.value = mode;
    view.following = mode !== 'off';
    followCamera();
    view.invalidate();
    schedulePanel();
}

function followCamera() {
    if (followMode === 'off' || !frame) return;
    const here = membersIn(currentRegion());
    const bot = followedBot();
    const pts = (bot ? here.filter(m => m.bot === bot) : here).map(m => m.player!);
    if (!pts.length) return;
    view.centre(pts.reduce((s, p) => s + p.x, 0) / pts.length, pts.reduce((s, p) => s + p.y, 0) / pts.length);
}

let followSig = '';
function updateFollowOptions(f: GroupFrame) {
    const opts: [string, string][] = [['group', 'group'], ...f.members.map(m => [`m:${m.bot}`, memberName(m)] as [string, string]), ['off', 'off']];
    const sig = JSON.stringify(opts);
    if (sig === followSig) return;
    followSig = sig;
    followSel.innerHTML = opts.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join('');
    if (!opts.some(o => o[0] === followMode)) followMode = 'group';
    followSel.value = followMode;
}

/** Everything one map frame needs, filtered to the region on the map. */
interface Scene {
    f: GroupFrame;
    region: number;
    run: RunView | null;
    /** The run is current and its orders and plan are about this region. */
    runHere: boolean;
    orders: Orders | null;
    members: GroupMemberView[];
    /** Lower-cased character names → member, in this region. */
    byName: Map<string, GroupMemberView>;
    byObject: Map<number, GroupMemberView>;
    contacts: WorldContact[];
    contactById: Map<number, WorldContact>;
    conRef: number | null;
    settings: Record<string, unknown>;
    /** Gateway clock and the run's skew onto it. */
    now: number;
    skew: number;
}

function scene(): Scene | null {
    const f = frame;
    const region = currentRegion();
    if (!f || region === null) return null;
    const run = f.run;
    const members = membersIn(region);
    const byName = new Map<string, GroupMemberView>();
    const byObject = new Map<number, GroupMemberView>();
    for (const m of members) {
        for (const n of memberNames(m)) byName.set(n.toLowerCase(), m);
        byObject.set(m.player!.objectId, m);
    }
    const contacts = arr(f.world).filter(c => c && c.regionId === region && Number.isFinite(c.x) && Number.isFinite(c.y));
    const runHere = !!run && CURRENT_STATES.has(run.state) && runRegion(f.members) === region;
    const settings = meta?.settings && typeof meta.settings === 'object' ? meta.settings as Record<string, unknown> : {};
    return {
        f, region, run, runHere, orders: runHere ? run!.orders ?? null : null, members, byName, byObject,
        contacts, contactById: new Map(contacts.map(c => [c.objectId, c])), conRef: conReference(f.members, region),
        settings, now: gwNow(), skew: num(run?.skewMs),
    };
}

function currentZoneId(s: Scene): number | null {
    const bot = followedBot();
    const pick = (bot && s.members.find(m => m.bot === bot))
        || (selected?.startsWith('m:') && s.members.find(m => `m:${m.bot}` === selected))
        || s.members.find(m => m.leader) || s.members[0];
    return pick ? pick.player!.zoneId : null;
}

function draw(v: MapView<MapItem>) {
    const { ctx } = v;
    ctx.fillStyle = '#0f1216';
    ctx.fillRect(0, 0, v.width, v.height);
    const step = v.drawGrid();
    const s = safely('scene', scene) ?? null;
    if (s) {
        // Each pass between save and restore: a dimmed or dashed pass never leaks into the next.
        const pass = (label: string, fn: () => void) => drawPass(ctx, label, fn);
        if (layer.zones) pass('zones', () => v.drawZones(regionData?.regionId === s.region ? regionData : null, currentZoneId(s)));
        if (layer.plan && s.runHere) pass('plan', () => drawPlan(v, s));
        if (layer.orders && s.orders) pass('orders', () => drawOrders(v, s, s.orders!));
        pass('world', () => drawWorld(v, s));
        pass('lines', () => drawLines(v, s));
        if (layer.paths) pass('paths', () => drawPaths(v, s));
        pass('members', () => drawMembers(v, s));
        if (layer.deaths) pass('deaths', () => drawDeaths(v, s));
    }
    v.flushLabels();
    safely('hud', () => drawHud(v, s, step));
}

/** Dim everything about the run while its publishes are late. */
const runAlpha = (s: Scene) => (s.run?.state === 'stale' ? 0.45 : 1);
/** The NPCs layer draws this contact; nothing else about a hidden one is drawn either. */
const onMap = (c: WorldContact) => npcShown(c, layer.npcs);

function cross(ctx: CanvasRenderingContext2D, p: Pt, r: number) {
    ctx.beginPath();
    ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y + r);
    ctx.moveTo(p.x + r, p.y - r); ctx.lineTo(p.x - r, p.y + r);
    ctx.stroke();
}

function polyline(v: MapView<MapItem>, pts: Pt[]) {
    const { ctx } = v;
    ctx.beginPath();
    pts.forEach((p, i) => { const sp = v.toScreen(p.x, p.y); if (i) ctx.lineTo(sp.x, sp.y); else ctx.moveTo(sp.x, sp.y); });
    ctx.stroke();
}

const finite = (p: unknown): p is Pt => !!p && typeof p === 'object' && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y);

function drawPlan(v: MapView<MapItem>, s: Scene) {
    const { ctx } = v;
    const coord = s.run?.coordinator ?? null;
    const p = plan;
    ctx.globalAlpha = runAlpha(s);
    for (const a of arr(coord?.avoidCamps).filter(finite)) {
        const sp = v.toScreen(a.x, a.y);
        if (!v.onScreen(sp)) continue;
        ctx.strokeStyle = '#8593a3';
        ctx.lineWidth = 1.5;
        cross(ctx, sp, 5);
        v.hit(sp.x, sp.y, 6, spot(`plan:avoid:${a.x},${a.y}`, 'camp given up on', [`${Math.round(a.x)}, ${Math.round(a.y)}`]));
    }
    const route = [coord?.leg, ...arr(coord?.route)].filter(finite);
    if (route.length > 1) {
        ctx.strokeStyle = 'rgba(90,169,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 6]);
        polyline(v, route);
        ctx.setLineDash([]);
    }
    if (finite(coord?.leg)) {
        const sp = v.toScreen(coord!.leg!.x, coord!.leg!.y);
        ctx.fillStyle = '#5aa9ff';
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2); ctx.fill();
    }
    const base = coord?.base ?? p?.base ?? null;
    if (finite(base)) {
        const b = v.toScreen(base.x, base.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 6]);
        ctx.beginPath(); ctx.arc(b.x, b.y, num(s.settings.huntRadius, 2200) * v.cam.scale, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#5aa9ff';
        ctx.fillRect(b.x - 5, b.y - 5, 10, 10);
        v.hit(b.x, b.y, 6, spot('plan:base', 'base', [`${Math.round(base.x)}, ${Math.round(base.y)}`, p ? `plan score ${num(p.score).toFixed(1)} · margin ${num(p.margin).toFixed(1)}` : '']));
    }
    const camp = coord?.camp;
    if (camp && finite(camp)) {
        const c = v.toScreen(camp.x, camp.y);
        ctx.strokeStyle = '#d6dde6';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - 9); ctx.lineTo(c.x + 9, c.y); ctx.lineTo(c.x, c.y + 9); ctx.lineTo(c.x - 9, c.y);
        ctx.closePath();
        ctx.stroke();
        v.label(String(camp.names ?? 'camp'), c.x, c.y - 13, '#d6dde6', false, 2);
        v.hit(c.x, c.y, 9, spot('plan:camp', `camp: ${camp.names}`, [`${num(camp.count)} spawns · ${camp.zone}`, coord?.campLevel != null ? `camp level ${coord.campLevel}` : '']));
    }
    for (const t of arr(p?.targets).filter(finite)) {
        const sp = v.toScreen(t.x, t.y);
        if (!v.onScreen(sp)) continue;
        ctx.strokeStyle = '#59d46b';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2); ctx.stroke();
        if (v.cam.scale > 0.1) v.label(String(Math.round(num(t.d))), sp.x, sp.y + 16, '#59d46b', false, 4);
        v.hit(sp.x, sp.y, 6, spot(`plan:t:${t.x},${t.y}`, `${t.name} L${t.level}`, ['safe target', `${Math.round(num(t.d))} from the base`]));
    }
    for (const u of arr(p?.unsafe).filter(finite)) {
        const sp = v.toScreen(u.x, u.y);
        if (!v.onScreen(sp)) continue;
        ctx.strokeStyle = '#ff5a5a';
        ctx.lineWidth = 1.5;
        cross(ctx, sp, 4);
        v.hit(sp.x, sp.y, 6, spot(`plan:u:${u.x},${u.y}`, `${u.name} L${u.level}`, [`unsafe: ${u.why}`]));
    }
    ctx.globalAlpha = 1;
}

function drawOrders(v: MapView<MapItem>, s: Scene, o: Orders) {
    const { ctx } = v;
    ctx.globalAlpha = runAlpha(s);
    const anchor = finite(o.anchor) ? o.anchor : null;
    const a = anchor ? v.toScreen(anchor.x, anchor.y) : null;
    if (anchor && a) {
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(90,169,255,0.35)';
        ctx.beginPath(); ctx.arc(a.x, a.y, num(s.settings.engageRadius, 700) * v.cam.scale, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(90,169,255,0.18)';
        ctx.beginPath(); ctx.arc(a.x, a.y, num(s.settings.gatherRadius, 1200) * v.cam.scale, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = '#5aa9ff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(a.x, a.y, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(a.x - 12, a.y); ctx.lineTo(a.x + 12, a.y);
        ctx.moveTo(a.x, a.y - 12); ctx.lineTo(a.x, a.y + 12);
        ctx.stroke();
        if (finite(o.facing)) {
            const len = Math.hypot(o.facing.x - anchor.x, o.facing.y - anchor.y);
            if (len > 0) {
                const d = { x: (o.facing.x - anchor.x) / len, y: (o.facing.y - anchor.y) / len };
                const tip = { x: a.x + d.x * 40, y: a.y + d.y * 40 };
                ctx.beginPath();
                ctx.moveTo(a.x + d.x * 12, a.y + d.y * 12); ctx.lineTo(tip.x, tip.y);
                ctx.moveTo(tip.x, tip.y); ctx.lineTo(tip.x - d.x * 8 - d.y * 5, tip.y - d.y * 8 + d.x * 5);
                ctx.moveTo(tip.x, tip.y); ctx.lineTo(tip.x - d.x * 8 + d.y * 5, tip.y - d.y * 8 - d.x * 5);
                ctx.stroke();
            }
        }
        v.hit(a.x, a.y, 9, spot('orders:anchor', `anchor (${o.phase})`, [String(o.objective ?? ''), String(o.reason ?? '')]));
    }
    if (finite(o.retreatTo)) {
        const t = v.toScreen(o.retreatTo.x, o.retreatTo.y);
        ctx.strokeStyle = '#ffb347';
        ctx.fillStyle = '#ffb347';
        ctx.lineWidth = 1.5;
        if (a) {
            ctx.setLineDash([6, 4]);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(t.x, t.y); ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(t.x, t.y - 16); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(t.x, t.y - 16); ctx.lineTo(t.x + 10, t.y - 12); ctx.lineTo(t.x, t.y - 8); ctx.closePath(); ctx.fill();
        v.hit(t.x, t.y - 8, 9, spot('orders:retreat', 'retreat point', [`${Math.round(o.retreatTo.x)}, ${Math.round(o.retreatTo.y)}`]));
    }
    ctx.globalAlpha = 1;
}

function drawWorld(v: MapView<MapItem>, s: Scene) {
    const { ctx } = v;
    const showLabels = labelsBox.checked && v.cam.scale >= 0.1;
    // NPCs under players, so a player standing in a pack stays visible.
    const list = [...s.contacts].sort((a, b) => (a.kind === 'npc' ? 0 : 1) - (b.kind === 'npc' ? 0 : 1));
    for (const c of list) {
        const sp = v.toScreen(c.x, c.y);
        if (!v.onScreen(sp)) continue;
        const key = `c:${c.key}`;
        const sel = selected === key;
        const hov = v.hoverKey === key;
        let r: number;
        if (!onMap(c)) continue;
        if (c.kind === 'npc') {
            const color = s.conRef !== null ? CON_HEX[conColor(s.conRef, num(c.level))] : CON_HEX.yellow;
            r = c.npc?.isPet ? 4 : 5.5;
            const dead = c.isDead || num(c.hp, 100) <= 0;
            ctx.globalAlpha = c.board?.stale ? 0.5 : 1;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
            if (c.npc?.isPeaceful || c.npc?.isTargetable === false) {
                ctx.fillStyle = 'rgba(15,18,22,0.9)';
                ctx.fill();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.stroke();
            } else {
                ctx.fillStyle = dead ? '#444' : color;
                ctx.fill();
            }
            if (dead) {
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                cross(ctx, sp, r);
            }
            if (!dead && (c.inCombat || c.board?.threat)) {
                ctx.strokeStyle = '#ff3b3b';
                ctx.lineWidth = c.board?.threat ? 3 : 1.5;
                ctx.beginPath(); ctx.arc(sp.x, sp.y, r + 3, 0, Math.PI * 2); ctx.stroke();
            }
            if (v.cam.scale > 0.15 && num(c.speed) > 0) {
                const hv = headingVec(c.heading);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(sp.x + hv.x * (r + 6), sp.y + hv.y * (r + 6)); ctx.stroke();
            }
            if (showLabels || sel || hov) v.label(`${c.name || '(unnamed)'} ${c.level ?? ''}`, sp.x, sp.y - r - 4, color, sel || hov, 3 + num(c.nearest, 1e5) / 1e6);
        } else {
            const color = REALM_HEX[c.realm] ?? REALM_HEX.none!;
            r = 6;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.moveTo(sp.x, sp.y - r); ctx.lineTo(sp.x + r, sp.y); ctx.lineTo(sp.x, sp.y + r); ctx.lineTo(sp.x - r, sp.y);
            ctx.closePath();
            ctx.fillStyle = c.isDead ? '#444' : color;
            ctx.fill();
            ctx.strokeStyle = c.enemy ? '#ff3b3b' : '#fff';
            ctx.lineWidth = c.enemy ? 2 : 1;
            ctx.stroke();
            if (labelsBox.checked || sel || hov) v.label(c.name, sp.x, sp.y - r - 4, '#fff', sel || hov, 1);
        }
        ctx.globalAlpha = 1;
        if (sel || hov) {
            ctx.strokeStyle = sel ? 'rgba(90,169,255,0.9)' : 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(sp.x, sp.y, r + 6, 0, Math.PI * 2); ctx.stroke();
        }
        v.hit(sp.x, sp.y, r, { key, kind: 'contact', c });
    }
}

function drawLines(v: MapView<MapItem>, s: Scene) {
    const { ctx } = v;
    const line = (a: Pt, b: Pt) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
    // Who attacks whom, from the members' own states.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,70,70,0.6)';
    ctx.setLineDash([3, 3]);
    for (const c of s.contacts) {
        if (c.isDead || !c.target || !onMap(c)) continue;
        const m = s.byName.get(c.target.toLowerCase());
        if (m) line(v.toScreen(c.x, c.y), v.toScreen(m.player!.x, m.player!.y));
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,225,74,0.5)';
    for (const m of s.members) {
        const id = m.player!.targetObjectId;
        if (id === null || id === undefined) continue;
        const c = s.contactById.get(id);
        if (c && !onMap(c)) continue;
        const t = c ?? s.byObject.get(id)?.player;
        if (t && t !== m.player) line(v.toScreen(m.player!.x, m.player!.y), v.toScreen(t.x, t.y));
    }
    // Focus, puller and cc assignments belong to the orders layer.
    const o = layer.orders ? s.orders : null;
    if (o) {
        ctx.globalAlpha = runAlpha(s);
        const target = o.focus !== null && o.focus !== undefined ? s.contactById.get(o.focus) : undefined;
        const focus = target && onMap(target) ? target : undefined;
        if (focus) {
            const fp = v.toScreen(focus.x, focus.y);
            ctx.strokeStyle = '#ffe14a';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.arc(fp.x, fp.y, 12, 0, Math.PI * 2); ctx.stroke();
            const puller = o.puller ? s.byName.get(o.puller.toLowerCase()) : undefined;
            if (puller) {
                ctx.strokeStyle = 'rgba(90,169,255,0.8)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);
                line(v.toScreen(puller.player!.x, puller.player!.y), fp);
            }
            ctx.setLineDash([]);
            v.label('FOCUS', fp.x, fp.y + 26, '#ffe14a', true);
        }
        for (const a of arr(o.cc)) {
            const caster = s.byName.get(lower(a?.by));
            const mob = s.contactById.get(num(a?.targetId, NaN));
            if (!caster || !mob || !onMap(mob)) continue;
            const seen = ccSeen(mob, String(a.by));
            const from = v.toScreen(caster.player!.x, caster.player!.y);
            const to = v.toScreen(mob.x, mob.y);
            ctx.strokeStyle = seen ? '#9a5fd9' : '#ffb347';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            line(from, to);
            ctx.setLineDash([]);
            if (!seen) v.label('!', (from.x + to.x) / 2, (from.y + to.y) / 2, '#ffb347', true);
        }
        ctx.globalAlpha = 1;
    }
    // Crowd control that landed (the run's board).
    for (const c of s.contacts) {
        const cc = c.board?.cc;
        if (!cc || !onMap(c)) continue;
        const sp = v.toScreen(c.x, c.y);
        if (!v.onScreen(sp)) continue;
        ctx.strokeStyle = '#9a5fd9';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 12, 0, Math.PI * 2); ctx.stroke();
        const left = Math.max(0, Math.round((num(cc.until) + s.skew - s.now) / 1000));
        v.label(`${cc.kind} ${left}s`, sp.x, sp.y + 24, '#9a5fd9', false, 2);
    }
}

function drawPaths(v: MapView<MapItem>, s: Scene) {
    const { ctx } = v;
    for (const m of s.members) {
        const mv = m.movement;
        if (!mv) continue;
        const pts: Pt[] = arr(mv.waypoints).filter(finite);
        const dest = finite(mv.destination) ? mv.destination : null;
        if (dest && !pts.some(w => w.x === dest.x && w.y === dest.y)) pts.push(dest);
        if (!pts.length) continue;
        ctx.strokeStyle = 'rgba(90,169,255,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        polyline(v, [m.player!, ...pts]);
        ctx.setLineDash([]);
        const last = v.toScreen(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
        cross(ctx, last, 4);
    }
}

function drawMembers(v: MapView<MapItem>, s: Scene) {
    const { ctx } = v;
    for (const m of s.members) {
        const p = m.player!;
        const sp = v.toScreen(p.x, p.y);
        if (!v.onScreen(sp)) continue;
        const key = `m:${m.bot}`;
        const active = m.client.status === 'active';
        const sel = selected === key;
        if (sel || v.hoverKey === key) {
            ctx.strokeStyle = sel ? 'rgba(90,169,255,0.9)' : 'rgba(255,255,255,0.6)';
            ctx.lineWidth = sel ? 3 : 1.5;
            ctx.beginPath(); ctx.arc(sp.x, sp.y, 18, 0, Math.PI * 2); ctx.stroke();
        }
        const hv = headingVec(p.heading);
        const n = { x: -hv.y, y: hv.x };
        const len = 13;
        ctx.beginPath();
        ctx.moveTo(sp.x + hv.x * len, sp.y + hv.y * len);
        ctx.lineTo(sp.x - hv.x * 7 + n.x * 7, sp.y - hv.y * 7 + n.y * 7);
        ctx.lineTo(sp.x - hv.x * 3, sp.y - hv.y * 3);
        ctx.lineTo(sp.x - hv.x * 7 - n.x * 7, sp.y - hv.y * 7 - n.y * 7);
        ctx.closePath();
        ctx.fillStyle = p.isDead ? '#666' : '#ffffff';
        ctx.globalAlpha = active ? 1 : 0.6;
        ctx.fill();
        ctx.globalAlpha = 1;
        // A member whose client went quiet is drawn where it was last seen, dashed.
        ctx.strokeStyle = !active ? '#8593a3' : p.inCombat ? '#ff4a4a' : '#5aa9ff';
        ctx.lineWidth = 2;
        if (!active) ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
        const age = active ? '' : m.client.stateAge !== null ? ` (${dur(m.client.stateAge)} ago)` : ' (no client)';
        v.label(`${memberName(m)}·${roleLetter(m.role ?? m.run?.role)}${age}`, sp.x, sp.y - 18, active ? '#ffffff' : '#8593a3', true);
        v.hit(sp.x, sp.y, 10, { key, kind: 'member', m });
    }
}

function drawDeaths(v: MapView<MapItem>, s: Scene) {
    const { ctx } = v;
    const since = s.now - DEATHS_FOR_MS;
    for (const e of passiveEvents) {
        if (e.kind !== 'death' || !e.pos || e.pos.regionId !== s.region || num(e.at) < since || !finite(e.pos)) continue;
        const key = `d:${e.seq}`;
        const sel = selected === key;
        const sp = v.toScreen(e.pos.x, e.pos.y);
        if (sel) {
            const track = arr(e.track).filter(finite);
            if (track.length) {
                ctx.strokeStyle = 'rgba(255,90,90,0.45)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([1, 4]);
                polyline(v, [...track, e.pos]);
                ctx.setLineDash([]);
            }
        }
        if (!v.onScreen(sp)) continue;
        ctx.strokeStyle = '#ff5a5a';
        ctx.lineWidth = sel ? 3 : 2.5;
        cross(ctx, sp, 6);
        v.label(`† ${clock(e.at).slice(0, 5)}`, sp.x, sp.y - 10, '#ff5a5a', sel || v.hoverKey === key, 2);
        v.hit(sp.x, sp.y, 7, { key, kind: 'death', e });
    }
}

function drawHud(v: MapView<MapItem>, s: Scene | null, step: number) {
    const parts: string[] = [];
    if (v.mouse) {
        const w = v.toWorld(v.mouse.x, v.mouse.y);
        parts.push(`cursor ${Math.round(w.x)}, ${Math.round(w.y)}`);
        const m = s?.members.find(x => `m:${x.bot}` === selected);
        const ref = m ? { name: memberName(m), x: m.player!.x, y: m.player!.y } : finite(s?.orders?.anchor) ? { name: 'anchor', ...s!.orders!.anchor! } : null;
        if (ref) parts.push(`${Math.round(Math.hypot(w.x - ref.x, w.y - ref.y))} u to ${ref.name}`);
    }
    parts.push(`grid ${step} u`);
    if (s) {
        const npcs = s.contacts.filter(c => c.kind === 'npc').length;
        parts.push(`${s.members.length}/${s.f.members.length} members here · ${npcs} npc · ${s.contacts.length - npcs} pl · region ${s.region}`);
    } else if (frame) {
        parts.push('no member in game');
    }
    $('hud').textContent = parts.join(' · ');
}

function entityName(id: number | null | undefined, region: number | null): string {
    if (id === null || id === undefined) return '?';
    const f = frame;
    const c = arr(f?.world).find(x => x.objectId === id && (region === null || x.regionId === region));
    if (c) return c.name;
    const m = arr(f?.members).find(x => x.player?.objectId === id && (region === null || x.player.regionId === region));
    return m ? memberName(m) : `#${id}`;
}

function showTooltip(hit: MapItem | null, sx: number, sy: number) {
    if (!hit || !Number.isFinite(sx)) { tooltip.style.display = 'none'; return; }
    const rows: string[] = [];
    const now = gwNow();
    if (hit.kind === 'member') {
        const m = hit.m, p = m.player!;
        rows.push(`<div class="tname">${esc(memberName(m))}${m.leader ? ' <span class="muted">(leader)</span>' : ''}</div>`);
        rows.push(`<div>L${esc(p.level)} ${esc(p.className)} · ${esc(m.role ?? m.run?.role ?? '?')} · HP ${esc(Math.round(p.hp))}% · power ${esc(Math.round(p.mana))}%</div>`);
        rows.push(`<div class="muted">client ${esc(m.client.status)}${m.client.stateAge !== null ? ` · state ${esc(dur(m.client.stateAge))} old` : ''} · ${esc(m.client.controllers)} ctl</div>`);
        if (m.run) rows.push(`<div>${esc(activityText(m.run.activity, p.regionId))}</div>`);
        rows.push(`<div class="muted">${esc(p.zoneName)} · ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} · double-click: member page</div>`);
    } else if (hit.kind === 'contact') {
        const c = hit.c;
        const ref = conReference(arr(frame?.members), c.regionId);
        const con = c.kind === 'npc' && ref !== null ? conColor(ref, num(c.level)) : null;
        rows.push(`<div class="tname">${esc(c.name || '(unnamed)')}</div>`);
        rows.push(`<div>${c.kind === 'npc' ? 'NPC' : c.enemy ? 'Enemy player' : 'Player'} · level ${esc(c.level)}${con ? ` · <span style="color:${CON_HEX[con]}">${con}</span>` : ''} · ${esc(c.realm)}</div>`);
        rows.push(`<div>HP ${esc(Math.round(num(c.hp, 100)))}%${c.inCombat ? ' · <span class="bad">in combat</span>' : ''}${c.isDead ? ' · dead' : ''}${c.npc?.isPeaceful ? ' · peaceful' : ''}${c.npc?.role ? ` · ${esc(c.npc.role)}` : ''}</div>`);
        if (c.target) rows.push(`<div class="bad">targeting ${esc(c.target)}</div>`);
        rows.push(`<div class="muted">seen by ${esc(arr(c.seenBy).join(', ') || 'nobody')}</div>`);
        if (c.board) {
            const cc = c.board.cc ? ` · ${esc(c.board.cc.kind)} by ${esc(c.board.cc.by)}` : '';
            rows.push(`<div class="muted">board: ${c.board.threat ? '<span class="bad">threat</span>' : 'calm'}${c.board.stale ? ' · stale' : ''}${cc}${enemyTags(c).map(t => ` · ${esc(t)}`).join('')}</div>`);
        }
        rows.push(`<div class="muted">${Math.round(num(c.nearest))} from the nearest member · #${esc(c.objectId)} · ${Math.round(c.x)}, ${Math.round(c.y)}</div>`);
    } else if (hit.kind === 'death') {
        const e = hit.e;
        rows.push(`<div class="tname bad">† ${esc(e.name)} died</div>`);
        rows.push(`<div>${esc(clock(e.at))} · ${esc(ago(e.at, now))}</div>`);
        rows.push(`<div>${e.by ? `killed by ${esc(e.by)}` : '<span class="muted">killer unknown</span>'}</div>`);
        if (e.pos) rows.push(`<div class="muted">${Math.round(e.pos.x)}, ${Math.round(e.pos.y)}${e.runId ? ` · run ${esc(short(e.runId))}` : ' · between runs'} · click: show its last minute</div>`);
    } else {
        rows.push(`<div class="tname">${esc(hit.title)}</div>`);
        for (const l of hit.lines) rows.push(`<div class="muted">${esc(l)}</div>`);
    }
    tooltip.innerHTML = rows.join('');
    tooltip.style.display = 'block';
    const wrap = $('mapwrap').getBoundingClientRect();
    tooltip.style.left = `${clamp(sx + 14, 4, wrap.width - tooltip.offsetWidth - 4)}px`;
    tooltip.style.top = `${clamp(sy + 14, 4, wrap.height - tooltip.offsetHeight - 4)}px`;
}

function select(key: string | null, fromPanel = false) {
    selected = key;
    if (fromPanel && key) {
        // Bring a member or contact picked in the side panel into view.
        const s = scene();
        const pos = key.startsWith('m:') ? s?.members.find(m => `m:${m.bot}` === key)?.player
            : key.startsWith('c:') ? s?.contacts.find(c => `c:${c.key}` === key) : null;
        if (pos && !view.onScreen(view.toScreen(pos.x, pos.y), -40)) {
            setFollow('off');
            view.centre(pos.x, pos.y);
        }
    }
    view.invalidate();
    schedulePanel();
}

$('zoomin').addEventListener('click', () => view.zoom(1.5));
$('zoomout').addEventListener('click', () => view.zoom(1 / 1.5));
$('center').addEventListener('click', () => setFollow('group'));
$('fit').addEventListener('click', () => {
    const s = scene();
    if (!s) return;
    const pts: Pt[] = s.members.map(m => m.player!);
    if (finite(s.orders?.anchor)) pts.push(s.orders!.anchor!);
    view.fit(pts);
});
followSel.addEventListener('change', () => setFollow(followSel.value));
labelsBox.addEventListener('change', () => view.invalidate());
window.addEventListener('keydown', ev => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLTextAreaElement) return;
    if (ev.key === '+' || ev.key === '=') view.zoom(1.5);
    else if (ev.key === '-') view.zoom(1 / 1.5);
    else if (ev.key === 'c' || ev.key === 'f') setFollow(followMode === 'off' ? 'group' : followMode);
    else if (ev.key === 'Escape') select(null);
});

// Layer switches, remembered per browser.
const LAYERS_KEY = 'viewer-group-layers';
try {
    const saved = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}');
    for (const k of Object.keys(layer) as (keyof typeof layer)[]) {
        if (saved && typeof saved[k] === typeof layer[k]) (layer as Record<string, unknown>)[k] = saved[k];
    }
} catch {}
for (const name of ['orders', 'plan', 'paths', 'deaths', 'zones'] as const) {
    const box = $<HTMLInputElement>(`l-${name}`);
    box.checked = !!layer[name];
    box.addEventListener('change', () => { layer[name] = box.checked; saveLayers(); });
}
const npcSel = $<HTMLSelectElement>('l-npcs');
if (!['all', 'threats', 'off'].includes(layer.npcs)) layer.npcs = 'all';
npcSel.value = layer.npcs;
npcSel.addEventListener('change', () => { layer.npcs = npcSel.value; saveLayers(); });
function saveLayers() {
    try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layer)); } catch {}
    view.invalidate();
}

$('legend').innerHTML = [
    ...(['grey', 'green', 'blue', 'yellow', 'orange', 'red', 'purple'] as const).map(c => `<span><i class="swatch" style="background:${CON_HEX[c]}"></i>${c}</span>`),
    '<span><i class="swatch" style="background:#fff;border:2px solid #5aa9ff"></i>member</span>',
    '<span><i class="swatch" style="border:2px dashed #ffe14a;background:none"></i>focus</span>',
    '<span><i class="swatch" style="border:2px solid #9a5fd9;background:none"></i>cc</span>',
    '<span style="color:#ff5a5a">✕</span><span>death</span>',
    '<span><i class="swatch" style="background:#d96cff;border-radius:0;transform:rotate(45deg)"></i>zone exit</span>',
].join('');

// ── Side panel ──────────────────────────────────────────────────────────────

const setSection = sections();
let panelTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePanel() {
    if (panelTimer) return;
    panelTimer = setTimeout(() => { panelTimer = null; renderPanel(); }, 150);
}

function renderPanel() {
    safely('topbar', renderTopbar);
    safely('banner', renderBanner);
    safely('run panel', renderRun);
    safely('wind-down', renderControl);
    safely('members panel', renderMembers);
    safely('contacts panel', renderContacts);
    safely('fight panel', renderFight);
    safely('plan panel', renderPlan);
    safely('events panel', renderEvents);
    safely('runs panel', renderRuns);
    safely('report panel', renderReport);
}

function renderTopbar() {
    const f = frame;
    if (f) {
        $('title').textContent = f.name;
        document.title = `${f.name} · group · daoc-sdk viewer`;
    }
    const pill = runPill(f?.run, gwNow());
    const el = $('run');
    el.textContent = f ? pill.text : 'loading';
    el.className = `pill ${pill.cls}`;
    el.title = f?.run ? `run ${f.run.runId}` : 'no run is publishing';
}

function renderAge() {
    const el = $('age');
    if (!frame) { el.textContent = ''; return; }
    const frameAge = (Date.now() - frameAt) / 1000;
    if (frameAge > 3) {
        el.textContent = `frame ${frameAge.toFixed(0)} s old`;
        el.className = `mono ${frameAge > 8 ? 'bad' : 'warn'}`;
        return;
    }
    const run = frame.run;
    if (!run) { el.textContent = ''; return; }
    const age = (gwNow() - run.lastAt) / 1000;
    el.textContent = `publish ${age.toFixed(1)} s ago`;
    el.className = `mono ${!CURRENT_STATES.has(run.state) ? 'muted' : age > 30 ? 'bad' : age > 5 ? 'warn' : 'muted'}`;
}

function renderBanner() {
    const banner = $('banner');
    let html = '';
    if (problem) html = esc(problem);
    else if (!frame) html = `Loading <b>${esc(GROUP)}</b>…`;
    else if (!frame.members.some(m => m.player)) {
        html = `No member of <b>${esc(frame.name)}</b> is in game.<div class="muted">Start their clients: <span class="mono">bun client/swarm.ts ${esc(frame.members.map(m => m.bot).join(' '))}</span></div>`;
    }
    banner.innerHTML = html;
    banner.style.display = html ? 'block' : 'none';
}

function activityText(a: { kind?: unknown; detail?: unknown; targetId?: unknown } | null | undefined, region: number | null): string {
    if (!a) return '';
    const kind = String(a.kind ?? '');
    const detail = typeof a.detail === 'string' ? a.detail : '';
    const target = typeof a.targetId === 'number' ? ` → ${entityName(a.targetId, region)}` : '';
    if (kind === 'idle') return detail ? `idle: ${detail}` : 'idle';
    return `${kind}${detail ? ` ${detail}` : ''}${target}`;
}

function passiveActivity(m: GroupMemberView): string {
    const p = m.player;
    if (!p) return '';
    const what = p.isDead ? 'dead' : p.inCombat || p.attacking ? 'fighting' : p.isSitting ? 'resting' : m.movement?.moving ? 'moving' : 'idle';
    return `passive: ${what}`;
}

function latestRequest(run: RunView): ControlView | null {
    const list = arr(run.control).filter(c => c && c.kind === 'windDown');
    return list.length ? list[list.length - 1]! : null;
}

function renderRun() {
    const f = frame;
    if (!f) { setSection('g-run-body', '<h3>Run</h3><div class="muted">Loading…</div>'); return; }
    const run = f.run;
    const notes = arr(f.notes).map(n => `<div class="muted">${esc(n)}</div>`).join('');
    const others = arr(f.others).length
        ? `<div class="muted" style="margin-top:4px">Other runs kept: ${arr(f.others).map(o => `${esc(short(o.runId))} ${esc(o.state)} (${esc(o.strategy)})`).join(', ')}</div>` : '';
    if (!run) {
        setSection('g-run-body', `<h3>Run <span>none</span></h3>
            <div class="muted">No run is publishing: none is running, or its runner predates the group channel. The map shows what the members' own clients see.</div>${notes}${others}`);
        return;
    }
    const now = gwNow();
    const skewMs = num(run.skewMs);
    const head = `<h3>Run <span title="${esc(run.runId)}${meta?.description ? ` · ${esc(meta.description)}` : ''}">${esc(run.strategy)} · ${esc(short(run.runId))}</span></h3>`;
    if (!CURRENT_STATES.has(run.state)) {
        const res = run.result;
        const t = res?.totals;
        const stamp = res?.stamp && STAMP.test(res.stamp) ? res.stamp : null;
        // Only a failure is red: a run that ran out its time or was wound down ended well, whatever reason it gave.
        const failed = runFailed(run);
        const why = run.state === 'lost' ? `no publish for ${dur(now - run.lastAt)} (killed?)` : res ? `stopped by ${res.stoppedBy}` : failed ? 'failed' : 'ended';
        setSection('g-run-body', `${head}
            <div class="run-head"><span class="pill ${run.state === 'lost' || failed ? 'dead' : ''}">${esc(run.state)}</span><span class="reason">${esc(why)}</span></div>
            ${run.error ? `<div class="${failed ? 'bad' : 'muted'}">${esc(run.error)}</div>` : ''}
            ${t ? `<div>Kills ${fmtInt(t.kills)} (${fmtInt(t.killsPerHour)}/h) · XP/h ${fmtInt(t.xpPerHour)} · deaths ${fmtInt(t.deaths)} · fights ${fmtInt(t.fights)} · downtime ${fmtInt(t.downtime)}%</div>` : ''}
            ${arr(res?.findings).length ? `<div class="chips">${arr(res?.findings).slice(0, 12).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
            ${stamp ? `<div style="margin-top:4px">Report <button class="chip" data-act="report" data-stamp="${esc(stamp)}" data-part="md">${esc(stamp)}</button></div>` : ''}
            <div class="muted">${esc(clock(run.firstAt))} to ${esc(clock(run.lastAt))}</div>${notes}${others}`);
        return;
    }
    const o = run.orders;
    const rr = runRegion(f.members);
    const focus = o?.focus !== null && o?.focus !== undefined ? arr(f.world).find(c => c.objectId === o.focus && (rr === null || c.regionId === rr)) : undefined;
    const focusText = o?.focus === null || o?.focus === undefined ? '<span class="muted">none</span>'
        : focus ? `${esc(focus.name)} L${esc(focus.level)} · ${esc(Math.round(num(focus.hp, 100)))}% → ${esc(focus.target ?? 'nobody')}` : `#${esc(o.focus)} <span class="muted">(no member sees it)</span>`;
    const cc = arr(o?.cc).map(a => {
        const mob = arr(f.world).find(c => c.objectId === a.targetId && (rr === null || c.regionId === rr));
        const seen = ccSeen(mob, String(a.by));
        return `<div>${esc(a.by)} → ${esc(mob?.name ?? `#${a.targetId}`)}${seen ? '' : ' <span class="warn" title="its own client does not see the mob, so the cast fails with not_found">can\'t see it</span>'}</div>`;
    }).join('');
    const waiting = arr(o?.waiting).map(w => `<span class="chip">${esc(w.name)}: ${esc(w.why)}</span>`).join('');
    const left = timeLeft(run.timing, skewMs, now);
    const stamp = meta?.stamp ?? null;
    setSection('g-run-body', `${head}
        <div class="run-head"><span class="pill ${phaseClass(o?.phase)}">${esc(o?.phase ?? '?')}</span><span class="reason">${esc(o?.reason ?? '')}</span></div>
        ${o?.objective ? `<div class="muted">${esc(o.objective)}</div>` : ''}
        <div class="kv" style="margin-top:6px">
            <span class="k">Focus</span><span>${focusText}</span>
            <span class="k">Puller</span><span>${esc(o?.puller ?? '-')}</span>
            ${cc ? `<span class="k">CC</span><span>${cc}</span>` : ''}
            ${waiting ? `<span class="k">Waiting</span><span class="chips" style="margin:0">${waiting}</span>` : ''}
            <span class="k">Orders</span><span>#${esc(num(o?.seq))} · ${esc(o?.issuedAt ? ago(o.issuedAt + skewMs, now) : '-')}</span>
            <span class="k">Time</span><span class="${left?.windingDown ? 'warn' : ''}">${esc(left?.text ?? '-')}</span>
            <span class="k">State</span><span>${esc(run.state)} · publish ${esc(ago(run.lastAt, now))}</span>
            ${stamp ? `<span class="k">Report</span><span class="mono">runs/${esc(stamp)}</span>` : ''}
        </div>${notes}${others}`);
}

function renderControl() {
    const ctl = $('g-run-ctl');
    const run = frame?.run;
    if (!run || !CURRENT_STATES.has(run.state)) { ctl.hidden = true; return; }
    ctl.hidden = false;
    const now = gwNow();
    const allowed = canWindDown(run, meta);
    windBtn.disabled = !allowed || windBusy;
    windBtn.title = meta?.control === false ? 'This run does not accept viewer control (publish.control: false)'
        : !allowed ? `The run is ${run.state}` : 'Finish the current fight, then end the run (report saved)';
    const req = latestRequest(run);
    $('g-run-req').textContent = windBusy ? 'sending…'
        : req ? req.appliedAt ? `applied ${ago(req.appliedAt, now)}: finishing the current fight`
            : req.deliveredAt ? `delivered to the run ${ago(req.deliveredAt, now)}`
                : `requested ${ago(req.requestedAt, now)}, waiting for the run's next publish`
            : run.timing?.windingDown ? 'winding down (time is up)' : '';
}

function renderMembers() {
    const f = frame;
    if (!f) { setSection('g-members', ''); return; }
    const majority = mapRegion(f.members, null);
    const runLive = !!f.run && (f.run.state === 'starting' || f.run.state === 'live' || f.run.state === 'stale');
    const grouped = new Set(arr(f.grouping?.inLeaderGroup).map(lower));
    const missing = new Set(arr(f.grouping?.missing).map(lower));
    const inGame = f.members.filter(m => m.player && (m.client.status === 'active' || m.client.status === 'stale')).length;
    const rows = f.members.map(m => {
        const p = m.player;
        const key = `m:${m.bot}`;
        const name = memberName(m);
        const role = m.role ?? m.run?.role ?? null;
        const c = m.client;
        const clientCls = c.status === 'active' ? 'active' : c.status === 'stale' ? 'stale' : 'dead';
        const clientText = c.status === 'active' ? 'live' : c.status === 'none' ? 'no client' : `${c.status}${c.stateAge !== null ? ` · ${dur(c.stateAge)}` : ''}`;
        const clientTitle = [c.phase ? `phase ${c.phase}` : '', c.lastError ?? '', `${c.observers} observers`].filter(Boolean).join(' · ');
        const ctlWarn = (runLive && c.controllers === 0) || c.controllers > 1;
        const ctlTitle = c.controllers > 1 ? 'more than one controller: they pre-empt each other'
            : runLive && c.controllers === 0 ? 'no controller during a run: the run lost this member' : 'controlling SDK connections';
        const lname = lower(name);
        const groupedText = grouped.has(lname) ? '<span class="good" title="in the leader\'s in-game group">✓ grouped</span>'
            : missing.has(lname) ? '<span class="warn" title="not in the leader\'s in-game group">✗ not grouped</span>' : '';
        const region = p ? (p.regionId !== majority
            ? `<span class="warn" title="not in the region most members are in">region ${esc(p.regionId)} · ${esc(p.zoneName)}</span>`
            : `<span class="muted">${esc(p.zoneName)}</span>`) : '';
        const flags = p ? [
            p.isDead ? '<span class="bad">dead</span>' : '',
            p.inCombat ? '<span class="bad">combat</span>' : '',
            p.isSitting ? '<span class="muted">sitting</span>' : '',
            p.load !== null && num(p.load) > 80 ? `<span class="warn" title="carried weight">load ${esc(Math.round(num(p.load)))}%</span>` : '',
        ].filter(Boolean).join(' ') : '';
        const activity = m.run ? activityText(m.run.activity, p?.regionId ?? null) : passiveActivity(m);
        const effects = arr(m.run?.effects).join(', ');
        return `<div class="member-row${selected === key ? ' sel' : ''}" data-act="select" data-key="${esc(key)}">
            <div class="line"><a href="/viewer/${encodeURIComponent(m.username)}" target="_blank" rel="noopener" title="Open ${esc(m.username)}'s page (observe)"><b>${esc(name)}</b></a>${m.leader ? '<span class="muted" title="leader">★</span>' : ''}
                <span class="muted">${p ? `L${esc(p.level)}.${String(Math.min(99, Math.floor(num(p.levelPermill) / 10))).padStart(2, '0')} ${esc(p.className)}` : esc(m.bot)} · ${esc(role ?? '?')}</span>
                <span class="spacer"></span>
                <span class="pill ${clientCls}" title="${esc(clientTitle)}">${esc(clientText)}</span>
                <span class="${ctlWarn ? 'warn' : 'muted'}" title="${esc(ctlTitle)}">ctl ${esc(c.controllers)}</span></div>
            ${p ? `<div class="mini-bars">${miniBar(p.hp, 'var(--hp)', `health ${Math.round(p.hp)}%`)}${miniBar(p.mana, 'var(--mana)', `power ${Math.round(p.mana)}%`)}</div>` : ''}
            <div class="line">${[groupedText, region, flags].filter(Boolean).join(' · ')}</div>
            ${activity ? `<div class="line activity" title="${esc(effects ? `effects: ${effects}` : 'no effects reported')}">${esc(activity)}</div>` : ''}
        </div>`;
    }).join('');
    const strangers = arr(f.grouping?.strangers);
    setSection('g-members', `<h3>Members <span>${inGame}/${f.members.length} in game</span></h3>${rows}
        ${strangers.length ? `<div class="warn" style="margin-top:4px">In the leader's group but not members: ${esc(strangers.join(', '))}</div>` : ''}`);
}

function renderContacts() {
    const f = frame;
    if (!f || !arr(f.world).length) { setSection('g-contacts', ''); return; }
    const run = f.run;
    const focus = run && CURRENT_STATES.has(run.state) ? run.orders?.focus ?? null : null;
    // Threats, then what the group could fight: a town's merchants, trainers and guards stay on the map only.
    const listed = listedContacts(f.world, f.members);
    const items = listed.slice(0, 40).map(c => {
        const key = `c:${c.key}`;
        const cc = c.board?.cc ? `<span class="chip" style="color:var(--conc)">${esc(c.board.cc.kind)}</span> ` : '';
        const tags = enemyTags(c).map(t => `<span class="chip">${esc(t)}</span> `).join('');
        return `<li class="${selected === key ? 'sel' : ''}" data-act="select" data-key="${esc(key)}">
            <span>${focus === c.objectId ? '<span style="color:#ffe14a" title="focus">★</span> ' : ''}<span class="${isThreat(c) ? 'bad' : ''}">${esc(c.name)}</span> <span class="muted">L${esc(c.level)}</span> ${esc(Math.round(num(c.hp, 100)))}%${c.target ? ` → ${esc(c.target)}` : ''}</span>
            <span class="r">${tags}${cc}${c.board?.stale ? 'stale · ' : ''}<span title="${esc(arr(c.seenBy).join(', '))}">seen ${arr(c.seenBy).length}</span> · ${esc(Math.round(num(c.nearest)))}</span></li>`;
    }).join('');
    const why = 'threats, monsters the group could fight and enemy players, of everything the members see; peaceful NPCs, pets, friendly players and the dead are on the map only';
    const count = `<span title="${esc(why)}"><b class="count">${listed.length}</b> of ${arr(f.world).length}</span>`;
    setSection('g-contacts', `<h3>Contacts ${count}</h3>${items
        ? `<ul class="list scroll" data-scroll="contacts">${items}</ul>${listed.length > 40 ? `<div class="muted">40 of ${listed.length} shown</div>` : ''}`
        : '<div class="muted">Nothing to fight nearby.</div>'}`);
}

function renderFight() {
    const r = report;
    if (!r || typeof r !== 'object' || !frame?.run) { setSection('g-fight', ''); return; }
    const t = (r.totals ?? {}) as Partial<LiveReport['totals']>;
    const fights = arr(r.fights);
    const last = fights[fights.length - 1];
    const findings = arr(r.findings).slice(0, 24);
    const members = Object.entries(r.members && typeof r.members === 'object' ? r.members : {}).slice(0, 12);
    const waited = (w: unknown) => Object.entries(w && typeof w === 'object' ? w as Record<string, unknown> : {})
        .filter(([, v]) => num(v) > 0).map(([k, v]) => `${k} ${num(v)}%`).join(', ');
    setSection('g-fight', `<h3>Score so far <span>${r.openFight ? 'fight open · ' : ''}${esc(dur(num(r.durationMs)))}</span></h3>
        <div>Kills ${fmtInt(t.kills)} (${fmtInt(t.killsPerHour)}/h) · XP/h ${fmtInt(t.xpPerHour)} · deaths ${fmtInt(t.deaths)} · wipes ${fmtInt(t.wipes)}</div>
        <div class="muted">fights ${fmtInt(t.fights)} · avg ${(num(t.avgFightMs) / 1000).toFixed(1)} s · downtime ${fmtInt(t.downtime)}% · tank hold ${t.tankHold === null || t.tankHold === undefined ? '-' : `${fmtInt(t.tankHold)}%`}</div>
        ${num(t.enemiesSeen) || num(t.playerKills) ? `<div>RvR: enemies seen ${fmtInt(t.enemiesSeen)} · player kills ${fmtInt(t.playerKills)} · deaths to players ${fmtInt(t.deathsToPlayers)} · RP ${fmtInt(t.realmPoints)} (${fmtInt(t.rpPerHour)}/h)</div>` : ''}
        ${last ? `<div style="margin-top:4px">${r.openFight ? 'Open' : 'Last'} fight: ${esc(arr(last.focus).join(' / ') || '?')} · ${esc(r.openFight ? 'in progress' : last.outcome)} · ${(num(last.durationMs) / 1000).toFixed(0)} s · adds ${esc(num(last.adds))} · max ${esc(num(last.maxAttackers))} attackers${arr(last.deaths).length ? ` · <span class="bad">died: ${esc(arr(last.deaths).join(', '))}</span>` : ''}</div>` : ''}
        ${findings.length ? `<div class="chips">${findings.map(x => `<span class="chip sev-${esc(x?.severity)}" title="${esc(`${x?.issue ?? ''}. Evidence: ${x?.evidence ?? ''}. Try: ${x?.suggestion ?? ''}`)}">${esc(x?.severity)} ${esc(x?.topic)}${x?.member ? ` · ${esc(x.member)}` : ''}</span>`).join('')}</div>` : ''}
        ${members.length ? `<table class="mini"><tr><th>Member</th><th>XP/h</th><th>Idle</th><th>Group waited for</th></tr>${members.map(([name, m]) => `
            <tr><td>${esc(name)}</td><td>${fmtInt(m?.xpPerHour)}</td><td>${fmtInt(m?.idleInFights)}%</td><td>${esc(waited(m?.waitedFor))}</td></tr>`).join('')}</table>` : ''}`);
}

function renderPlan() {
    const run = frame?.run;
    const coord = run && CURRENT_STATES.has(run.state) ? run.coordinator : null;
    const p = run && CURRENT_STATES.has(run.state) ? plan : null;
    if (!coord && !p) { setSection('g-plan', ''); return; }
    const camp = coord?.camp;
    const base = coord?.base ?? p?.base ?? null;
    const route = [coord?.leg, ...arr(coord?.route)].filter(finite);
    let routeLen = 0;
    for (let i = 1; i < route.length; i++) routeLen += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
    const ds = arr(p?.targets).map(t => num(t.d));
    const reasons = new Map<string, number>();
    for (const u of arr(p?.unsafe)) reasons.set(String(u.why), (reasons.get(String(u.why)) ?? 0) + 1);
    setSection('g-plan', `<h3>Camp and base <span>${p ? `score ${esc(num(p.score).toFixed(1))} · margin ${esc(num(p.margin).toFixed(1))}` : ''}</span></h3>
        <div class="kv">
            ${camp ? `<span class="k">Camp</span><span>${esc(camp.names)} <span class="muted">(${esc(camp.count)} · ${esc(camp.zone)}${coord?.campLevel != null ? ` · L${esc(coord.campLevel)}` : ''})</span></span>` : ''}
            ${finite(base) ? `<span class="k">Base</span><span class="mono">${Math.round(base.x)}, ${Math.round(base.y)}</span>` : ''}
            ${p ? `<span class="k">Targets</span><span>${ds.length}${ds.length ? ` <span class="muted">(${Math.round(Math.min(...ds))}-${Math.round(Math.max(...ds))} away)</span>` : ''}</span>` : ''}
            ${p ? `<span class="k">Unsafe</span><span>${arr(p.unsafe).length}${reasons.size ? `<div class="muted">${[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([why, n]) => `${esc(why)}${n > 1 ? ` ×${n}` : ''}`).join('<br>')}</div>` : ''}</span>` : ''}
            ${route.length > 1 ? `<span class="k">Route</span><span>${route.length - 1} legs · ${fmtInt(routeLen)} units</span>` : ''}
            ${arr(coord?.excluded).length ? `<span class="k">Excluded</span><span title="${esc(arr(coord?.excluded).join(', '))}">${arr(coord?.excluded).length} failed pulls</span>` : ''}
            ${arr(coord?.avoidCamps).length ? `<span class="k">Given up</span><span>${arr(coord?.avoidCamps).length} camps</span>` : ''}
        </div>`);
}

// The feed's filters; the member filter is a bot folder.
const feed = { orders: true, fights: true, failures: true, notes: true, between: true, member: null as string | null };
const FEED_CHIPS: [keyof Omit<typeof feed, 'member'>, string][] = [['orders', 'orders'], ['fights', 'fights'], ['failures', 'failures'], ['notes', 'notes'], ['between', 'between runs']];

function renderEvents() {
    const f = frame;
    const options = arr(f?.members).map(m => `<option value="${esc(m.bot)}"${feed.member === m.bot ? ' selected' : ''}>${esc(memberName(m))}</option>`).join('');
    setSection('g-events-filters', `<div class="chips">${FEED_CHIPS.map(([k, text]) => `<button class="chip${feed[k] ? ' on' : ''}" data-act="feed-filter" data-filter="${k}">${text}</button>`).join('')}
        <select data-act="feed-member"><option value="">everyone</option>${options}</select></div>`);
    const run = f?.run ?? null;
    const member = feed.member ? arr(f?.members).find(m => m.bot === feed.member) : undefined;
    const filters: FeedFilters = { ...feed, member: member ? memberNames(member) : null };
    const lines = mergeEvents(runEvents, num(run?.skewMs), passiveEvents).filter(l => eventVisible(l, filters)).slice(-MAX_FEED);
    const start = meta ? num(meta.startedAt) + num(run?.skewMs) : run ? run.firstAt : null;
    const notices = [
        run && num(run.lostEvents) > 0 ? `${fmtInt(run.lostEvents)} events lost` : '',
        run && num(run.eventsFrom) > 1 ? `events before #${fmtInt(run.eventsFrom)} unavailable` : '',
        'passive events: since the gateway started',
    ].filter(Boolean).map(t => `<div class="muted" style="font-size:11px">${esc(t)}</div>`).join('');
    $('g-events-count').textContent = String(lines.length);
    setSection('g-events-feed', `<div class="log" data-scroll="events" data-stick>${lines.map(l => feedLine(l, start)).join('') || '<div class="muted">no events yet</div>'}</div>${notices}`);
}

function feedLine(l: FeedLine, start: number | null): string {
    const t = start !== null && l.at >= start ? mmss(l.at - start) : clock(l.at);
    const prefix = l.source === 'run' && l.member && !l.text.startsWith(l.member) ? `${l.member}: ` : '';
    const text = l.source === 'run' && l.kind === 'orders' ? `» ${l.text}` : l.text;
    const title = `${clock(l.at)}${l.source === 'passive' ? ` · noticed by the gateway${l.runId ? '' : ' between runs'}` : ''}${l.by ? ` · killed by ${l.by}` : ''}`;
    return `<div class="ev-${esc(l.kind)}${l.source === 'passive' ? ' ev-passive' : ''}" title="${esc(title)}"><span class="t">${esc(t)}</span>${esc(prefix + text)}</div>`;
}

function renderRuns() {
    const r = runs;
    if (!r || (!arr(r.history).length && !r.campaign)) { setSection('g-runs', ''); return; }
    const hist = arr(r.history).slice(0, 10);
    const maxXp = Math.max(1, ...hist.map(h => num(h?.xpPerHour)));
    const files = new Map(arr(r.files).map(x => [x.stamp, x]));
    const topics = (list: unknown) => {
        const counts = new Map<string, number>();
        for (const t of arr(list as string[])) counts.set(String(t), (counts.get(String(t)) ?? 0) + 1);
        return [...counts].map(([t, n]) => `<span class="chip">${esc(t)}${n > 1 ? ` ×${n}` : ''}</span>`).join('');
    };
    const rows = hist.map(h => {
        const stamp = typeof h?.stamp === 'string' && STAMP.test(h.stamp) ? h.stamp : null;
        const file = stamp ? files.get(stamp) : undefined;
        const link = stamp && file?.md ? `<button class="chip" data-act="report" data-stamp="${esc(stamp)}" data-part="md">${esc(stamp)}</button>` : `<span class="mono">${esc(h?.stamp)}</span>`;
        return `<tr><td>${link}</td><td>${fmtInt(h.seconds)}</td><td>${fmtInt(h.killsPerHour)}</td>
            <td><div class="xp-bar"><i style="width:${(clamp(num(h.xpPerHour) / maxXp, 0, 1) * 100).toFixed(0)}%"></i></div>${fmtInt(h.xpPerHour)}</td>
            <td class="${num(h.deaths) ? 'bad' : ''}">${fmtInt(h.deaths)}</td><td>${fmtInt(h.downtime)}%</td><td>${h.tankHold == null ? '-' : `${fmtInt(h.tankHold)}%`}</td></tr>
            ${arr(h.findings).length ? `<tr class="topics"><td colspan="7"><div class="chips" style="margin:0">${topics(h.findings)}</div></td></tr>` : ''}`;
    }).join('');
    const c = r.campaign;
    setSection('g-runs', `<h3>Recent runs <span>${arr(r.history).length}</span></h3>
        ${hist.length ? `<table class="mini runs"><tr><th>Run (UTC)</th><th>s</th><th>kills/h</th><th>XP/h</th><th>deaths</th><th>down</th><th>hold</th></tr>${rows}</table>` : ''}
        ${c ? `<h3 style="margin-top:8px">Campaign <span>${c.stopPending ? '<span class="warn">stop file pending</span> · ' : ''}${c.updatedAt ? esc(ago(c.updatedAt)) : ''}</span></h3>
            <div class="log" data-scroll="campaign" data-stick style="max-height:160px">${arr(c.log).map(l => `<div>${esc(l)}</div>`).join('') || '<div class="muted">empty</div>'}</div>` : ''}`);
}

// ── Run reports ─────────────────────────────────────────────────────────────

let reportView: { stamp: string; part: 'md' | 'log'; text: string | null; error: string | null } | null = null;
let reportLines: string[] = [];
let reportKinds: ReturnType<typeof logLineKind>[] = [];
let reportGen = 0;
const logFilter = { orders: false, death: false, failure: false };
const logContext = new Set<number>();
let reportHtml: string | null = null;

async function openReport(stamp: string, part: 'md' | 'log') {
    if (!STAMP.test(stamp)) return;
    const gen = ++reportGen;
    reportView = { stamp, part, text: null, error: null };
    reportLines = [];
    reportKinds = [];
    logContext.clear();
    reportHtml = null;
    schedulePanel();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    let text: string | null = null, error: string | null = null;
    try {
        const res = await fetch(`/groups/${GID}/runs/${stamp}?part=${part}`, { cache: 'no-store', headers: authHeaders(password), signal: ctl.signal });
        if (res.ok) text = (await res.text()).slice(-2 * 1024 * 1024);
        else error = res.status === 404 ? `runs/${stamp}.${part} not found` : `HTTP ${res.status}`;
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    } finally {
        clearTimeout(timer);
    }
    if (gen !== reportGen) return;
    reportView = { stamp, part, text, error };
    if (part === 'log' && text !== null) {
        reportLines = text.split(/\r?\n/).filter(l => l !== '');
        reportKinds = reportLines.map(logLineKind);
    }
    reportHtml = null;
    schedulePanel();
}

function renderReport() {
    const v = reportView;
    if (!v) { setSection('g-report', ''); return; }
    if (reportHtml === null) reportHtml = reportBody(v);
    setSection('g-report', reportHtml);
}

function reportBody(v: NonNullable<typeof reportView>): string {
    const file = arr(runs?.files).find(x => x.stamp === v.stamp);
    const tab = (part: 'md' | 'log', text: string) => `<button class="chip${v.part === part ? ' on' : ''}" data-act="report" data-stamp="${esc(v.stamp)}" data-part="${part}"${file && !file[part] ? ' disabled' : ''}>${text}</button>`;
    const head = `<h3>Report <span class="mono">${esc(v.stamp)}</span></h3>
        <div class="chips">${tab('md', 'report')}${tab('log', 'log')}<button class="chip" data-act="report-close">close</button></div>`;
    if (v.error) return `${head}<div class="bad">${esc(v.error)}</div>`;
    if (v.text === null) return `${head}<div class="muted">Loading…</div>`;
    if (v.part === 'md') return `${head}<pre class="report-md" data-scroll="report">${esc(v.text)}</pre>`;
    const any = logFilter.orders || logFilter.death || logFilter.failure;
    const shown: number[] = [];
    for (let i = 0; i < reportLines.length; i++) {
        const k = reportKinds[i]!;
        if (!any || (logFilter.orders && k === 'orders') || (logFilter.death && k === 'death') || (logFilter.failure && k === 'failure')) shown.push(i);
    }
    const tail = shown.slice(-MAX_LOG_LINES);
    const chip = (k: keyof typeof logFilter, text: string) => `<button class="chip${logFilter[k] ? ' on' : ''}" data-act="log-filter" data-kind="${k}">${text}</button>`;
    const body = tail.map(i => {
        const line = `<div class="lk-${reportKinds[i]}">${esc(reportLines[i])}${reportKinds[i] === 'death' ? ` <button class="chip" data-act="death-context" data-line="${i}">${logContext.has(i) ? 'hide' : 'context'}</button>` : ''}</div>`;
        if (!logContext.has(i)) return line;
        const ctxLines = deathContext(reportLines, i);
        return `${line}<div class="ctx">${ctxLines.lines.map((l, j) => `<div class="${ctxLines.start + j === i ? 'bad' : ''}">${esc(l)}</div>`).join('')}</div>`;
    }).join('');
    return `${head}
        <div class="chips">${chip('orders', 'orders »')}${chip('death', 'deaths')}${chip('failure', 'failures')}<span class="muted">${shown.length} of ${reportLines.length} lines${shown.length > tail.length ? `, the last ${tail.length} shown` : ''}</span></div>
        <div class="log report-log" data-scroll="report-log">${body || '<div class="muted">no lines</div>'}</div>`;
}

// ── Side panel clicks ───────────────────────────────────────────────────────

$('side').addEventListener('click', ev => {
    const target = ev.target as HTMLElement;
    // Member names are links to their own pages: let them open.
    if (target.closest('a')) return;
    const el = target.closest<HTMLElement>('[data-act]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    const act = el.dataset.act;
    if (act === 'select') select(el.dataset.key && el.dataset.key !== selected ? el.dataset.key : null, true);
    else if (act === 'feed-filter') {
        const k = el.dataset.filter as keyof Omit<typeof feed, 'member'>;
        if (k in feed) { feed[k] = !feed[k]; schedulePanel(); }
    } else if (act === 'report') {
        const stamp = el.dataset.stamp ?? reportView?.stamp ?? '';
        void openReport(stamp, el.dataset.part === 'log' ? 'log' : 'md');
    } else if (act === 'report-close') {
        reportGen++;
        reportView = null;
        reportHtml = null;
        schedulePanel();
    } else if (act === 'log-filter') {
        const k = el.dataset.kind as keyof typeof logFilter;
        if (k in logFilter) { logFilter[k] = !logFilter[k]; reportHtml = null; schedulePanel(); }
    } else if (act === 'death-context') {
        const i = Number(el.dataset.line);
        if (logContext.has(i)) logContext.delete(i); else logContext.add(i);
        reportHtml = null;
        schedulePanel();
    }
});
$('side').addEventListener('change', ev => {
    const el = ev.target as HTMLSelectElement;
    if (el.dataset?.act !== 'feed-member') return;
    feed.member = el.value || null;
    schedulePanel();
});

// ── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('visibilitychange', () => {
    // Back on the tab: don't wait out the hidden-tab interval.
    if (!document.hidden && pollTimer && !polling && !stopped) schedule(0);
});
setInterval(renderAge, 250);
setInterval(() => { schedulePanel(); view.invalidate(); }, 1000);
setInterval(() => void loadRuns(), RUNS_EVERY_MS);

view.resize();
view.start();
renderPanel();
void poll();
void loadRuns();
