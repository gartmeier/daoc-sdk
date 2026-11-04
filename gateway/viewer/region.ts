// Browser page for one region: every in-game bot there on one map, coloured by
// realm, with each group's run (phase, reason, focus, score so far, its orders
// anchor and travel leg), the enemy players that are none of our bots, and the
// battleground's keeps. Watching three groups of three realms fight in
// Thidranki is what it is for. Bundled by routes.ts with Bun.build.
//
// It polls GET /regions/<id>/live about once a second (gateway/regions.ts) and
// loads GET /zones/<id> for the zone outlines. It only reads: no socket, no
// control request, nothing that could pre-empt a bot's controller or a run.
// Bot and group names link to their own pages.

import { phaseClass } from './group-logic';
import { authHeaders, enemyAims, enemyHeading, enemyWord, shouldLoadRegion } from './logic';
import { headingVec, MapView, type Pt, type RegionData } from './map-view';
import { arr, clamp, drawPass, dur, esc, miniBar, num, REALM_HEX, safely, sections } from './ui-kit';
import type { RegionBot, RegionEnemy, RegionFrame, RegionKeep, RegionRun } from '../regions';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const REGION = Number(document.body.dataset.region ?? NaN);

const POLL_MS = 1000;
const HIDDEN_POLL_MS = 5000;
const RETRY_MS = 3000;
const OLD_GATEWAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5000;
const PW_KEY = 'viewer-region-pw';

const fmtInt = (n: unknown) => Math.round(num(n)).toLocaleString('en-US');
const realmHex = (realm: unknown) => REALM_HEX[String(realm)] ?? REALM_HEX.none!;
const finite = (p: unknown): p is Pt => !!p && typeof p === 'object' && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y);

function readStored(key: string): string {
    try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; }
}
function store(key: string, value: string) {
    try { sessionStorage.setItem(key, value); } catch {}
}

/** The frame fields the page reads, checked before it replaces the last one. */
function isRegionFrame(x: any): x is RegionFrame {
    return !!x && typeof x === 'object' && x.v === 1 && typeof x.now === 'number' && Array.isArray(x.bots) && Array.isArray(x.runs)
        && Array.isArray(x.enemies) && Array.isArray(x.keeps) && !!x.hidden && typeof x.hidden === 'object';
}

// ── State ───────────────────────────────────────────────────────────────────

let frame: RegionFrame | null = null;
/** Date.now() when the frame arrived. */
let frameAt = 0;
let regionData: RegionData | null = null;
let regionLoading: number | null = null;
let regionFailure: { regionId: number; at: number } | null = null;
/** Map item key (b:<username>, e:<objectId>, k:<keep>, r:<group>) of the selection. */
let selected: string | null = null;
/** 'all', 'off' or 'g:<group id>'. */
let followMode = 'all';
let fitted = false;
let problem: string | null = null;
// One password for the page: it shows the bots (and the runs' leaders) whose bot.env has it.
let password = readStored(PW_KEY);
let savedPassword = password;

// ── Polling ─────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let failures = 0;
let pollFailed = false;

function schedule(ms: number) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, ms);
}

/** One request at a time: a setTimeout chain, never an interval, so slow answers never stack. */
async function poll() {
    if (polling) return;
    polling = true;
    let next: number | null = null;
    try {
        next = await pollOnce();
    } catch (error) {
        if (!pollFailed) { pollFailed = true; console.error('viewer: poll failed', error); }
        next = RETRY_MS;
    } finally {
        polling = false;
    }
    schedule(next ?? (document.hidden ? HIDDEN_POLL_MS : POLL_MS));
}

async function getJson(path: string): Promise<{ status: number; body: any; json: boolean }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
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

/** Returns the delay before the next poll, null for the normal interval. */
async function pollOnce(): Promise<number | null> {
    if (!Number.isInteger(REGION)) {
        setProblem('No region id in the address: open /viewer/region/<regionId>.');
        return null;
    }
    let r: Awaited<ReturnType<typeof getJson>>;
    try {
        r = await getJson(`/regions/${REGION}/live`);
    } catch {
        failures++;
        if (failures >= 2) setProblem('Gateway unreachable, retrying…');
        return RETRY_MS;
    }
    failures = 0;
    if (!r.json) {
        setProblem('This gateway predates region views. Restart it from a checkout that has gateway/regions.ts.');
        return OLD_GATEWAY_MS;
    }
    if (r.status !== 200 || !isRegionFrame(r.body)) {
        setProblem(`Unexpected answer from the gateway (HTTP ${r.status})${typeof r.body?.error === 'string' ? `: ${r.body.error}` : ''}`);
        return RETRY_MS;
    }
    setProblem(null);
    frame = r.body;
    frameAt = Date.now();
    // Keep a password only once it opened something.
    if (password && password !== savedPassword && (frame.bots.length || frame.runs.length)) { store(PW_KEY, password); savedPassword = password; }
    afterFrame();
    return null;
}

function afterFrame() {
    if (shouldLoadRegion(REGION, regionData?.regionId ?? null, regionLoading, regionFailure, Date.now())) void loadRegion(REGION);
    const f = frame!;
    if (f.hidden.bots || f.hidden.runs) showPassword();
    safely('follow options', () => updateFollowOptions(f));
    if (!fitted && f.bots.length) { view.fit(f.bots); fitted = true; }
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
    regionLoading = null;
    if (loaded && Array.isArray(loaded.zones)) {
        regionData = loaded;
        regionFailure = null;
    } else {
        regionFailure = { regionId, at: Date.now() };
    }
    view.invalidate();
    schedulePanel();
}

// ── Password ────────────────────────────────────────────────────────────────

const passwordInput = $<HTMLInputElement>('password');
const unlockBtn = $<HTMLButtonElement>('unlock');
passwordInput.value = password;

function showPassword() {
    passwordInput.hidden = false;
    unlockBtn.hidden = false;
}

function unlock() {
    password = passwordInput.value;
    failures = 0;
    setProblem(null);
    schedule(0);
}
unlockBtn.addEventListener('click', unlock);
passwordInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') unlock(); });

function setProblem(text: string | null) {
    if (problem === text) return;
    problem = text;
    schedulePanel();
}

// ── Map ─────────────────────────────────────────────────────────────────────

type MapItem =
    | { key: string; kind: 'bot'; b: RegionBot }
    | { key: string; kind: 'enemy'; e: RegionEnemy }
    | { key: string; kind: 'keep'; k: RegionKeep }
    | { key: string; kind: 'run'; r: RegionRun; what: 'anchor' | 'retreat' | 'camp' };

const tooltip = $('tooltip');
const view = new MapView<MapItem>($<HTMLCanvasElement>('map'), {
    scaleKey: 'viewer-region-scale',
    draw: v => draw(v),
    onClick: hit => select(hit?.key ?? null),
    onDblClick: hit => {
        if (hit?.kind === 'bot') window.open(`/viewer/${encodeURIComponent(hit.b.username)}`, '_blank', 'noopener');
        else if (hit?.kind === 'run') window.open(`/viewer/group/${encodeURIComponent(hit.r.group)}`, '_blank', 'noopener');
    },
    onHover: (hit, sx, sy) => safely('tooltip', () => showTooltip(hit, sx, sy)),
    onPan: () => setFollow('off'),
});
view.following = true;

const layer = { orders: true, targets: true, keeps: true, enemies: true, zones: true };
const labelsBox = $<HTMLInputElement>('labels');
const followSel = $<HTMLSelectElement>('follow');

/** The bots the camera follows: all of them, one group's, or none. */
function followed(): RegionBot[] {
    if (!frame || followMode === 'off') return [];
    if (followMode === 'all') return frame.bots;
    const id = followMode.slice(2);
    return frame.bots.filter(b => b.group?.id === id);
}

function setFollow(mode: string) {
    followMode = mode;
    if (followSel.value !== mode) followSel.value = mode;
    view.following = mode !== 'off';
    followCamera();
    view.invalidate();
}

function followCamera() {
    const pts = followed();
    if (!pts.length) return;
    view.centre(pts.reduce((s, p) => s + p.x, 0) / pts.length, pts.reduce((s, p) => s + p.y, 0) / pts.length);
}

let followSig = '';
function updateFollowOptions(f: RegionFrame) {
    const groups = new Map<string, string>();
    for (const b of f.bots) if (b.group) groups.set(b.group.id, b.group.name);
    const opts: [string, string][] = [['all', 'all bots'], ...[...groups].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => [`g:${id}`, name] as [string, string]), ['off', 'off']];
    const sig = JSON.stringify(opts);
    if (sig === followSig) return;
    followSig = sig;
    followSel.innerHTML = opts.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join('');
    if (!opts.some(o => o[0] === followMode)) followMode = 'all';
    followSel.value = followMode;
}

/** Where an object id stands on the map: one of our bots, else an enemy player. */
function positionOf(f: RegionFrame, id: number | null): Pt | null {
    if (id === null) return null;
    return f.bots.find(b => b.objectId === id) ?? f.enemies.find(e => e.objectId === id) ?? null;
}

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

function draw(v: MapView<MapItem>) {
    const { ctx } = v;
    ctx.fillStyle = '#0f1216';
    ctx.fillRect(0, 0, v.width, v.height);
    const step = v.drawGrid();
    const f = frame;
    if (f) {
        // Each pass between save and restore: a dimmed or dashed pass never leaks into the next.
        const pass = (label: string, fn: () => void) => drawPass(ctx, label, fn);
        const zone = f.bots.find(b => `b:${b.username}` === selected)?.zoneId ?? f.bots[0]?.zoneId ?? null;
        if (layer.zones) pass('zones', () => v.drawZones(regionData?.regionId === REGION ? regionData : null, zone));
        if (layer.keeps) pass('keeps', () => drawKeeps(v, f));
        if (layer.orders) pass('orders', () => drawOrders(v, f));
        if (layer.targets) pass('targets', () => drawTargets(v, f));
        if (layer.enemies) pass('enemies', () => drawEnemies(v, f));
        pass('bots', () => drawBots(v, f));
    }
    v.flushLabels();
    safely('hud', () => drawHud(v, f, step));
}

function drawKeeps(v: MapView<MapItem>, f: RegionFrame) {
    const { ctx } = v;
    for (const k of f.keeps) {
        if (!finite(k)) continue;
        const s = v.toScreen(k.x, k.y);
        const color = realmHex(k.owner);
        const radius = num(k.clearance) * v.cam.scale;
        if (radius > 2) {
            ctx.beginPath(); ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
            ctx.globalAlpha = 0.05;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.setLineDash([8, 6]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }
        if (!v.onScreen(s)) continue;
        const r = k.portal ? 8 : 6;
        ctx.fillStyle = color;
        ctx.fillRect(s.x - r, s.y - r, 2 * r, 2 * r);
        ctx.strokeStyle = '#0f1216';
        ctx.lineWidth = 2;
        ctx.strokeRect(s.x - r, s.y - r, 2 * r, 2 * r);
        const key = `k:${k.name}`;
        v.label(k.name, s.x, s.y - r - 5, color, selected === key || v.hoverKey === key, 2);
        v.hit(s.x, s.y, r, { key, kind: 'keep', k });
    }
}

function drawOrders(v: MapView<MapItem>, f: RegionFrame) {
    const { ctx } = v;
    f.runs.forEach((r, i) => {
        const color = realmHex(r.realm);
        ctx.globalAlpha = r.state === 'stale' ? 0.45 : 1;
        const anchor = finite(r.anchor) ? r.anchor : null;
        const a = anchor ? v.toScreen(anchor.x, anchor.y) : null;
        // The travel leg and what follows it, from the anchor on.
        const route = [anchor, r.leg, ...arr(r.route)].filter(finite);
        if (route.length > 1) {
            ctx.strokeStyle = color;
            ctx.globalAlpha *= 0.55;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 6]);
            polyline(v, route);
            ctx.setLineDash([]);
            ctx.globalAlpha = r.state === 'stale' ? 0.45 : 1;
        }
        if (r.camp && finite(r.camp)) {
            const c = v.toScreen(r.camp.x, r.camp.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x + 7, c.y); ctx.lineTo(c.x, c.y + 7); ctx.lineTo(c.x - 7, c.y);
            ctx.closePath();
            ctx.stroke();
            v.hit(c.x, c.y, 7, { key: `r:${r.group}:camp`, kind: 'run', r, what: 'camp' });
        }
        if (finite(r.retreatTo)) {
            const t = v.toScreen(r.retreatTo.x, r.retreatTo.y);
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 1.5;
            if (a) {
                ctx.setLineDash([6, 4]);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(t.x, t.y); ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(t.x, t.y - 16); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(t.x, t.y - 16); ctx.lineTo(t.x + 10, t.y - 12); ctx.lineTo(t.x, t.y - 8); ctx.closePath(); ctx.fill();
            v.hit(t.x, t.y - 8, 9, { key: `r:${r.group}:retreat`, kind: 'run', r, what: 'retreat' });
        }
        // The focus: a ring in the group's colour (one size per group, so two groups on one target both show).
        const target = positionOf(f, r.focus?.objectId ?? null);
        if (target) {
            const tp = v.toScreen(target.x, target.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.arc(tp.x, tp.y, 13 + 4 * i, 0, Math.PI * 2); ctx.stroke();
            if (a) {
                ctx.globalAlpha *= 0.5;
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.globalAlpha = r.state === 'stale' ? 0.45 : 1;
        }
        if (a) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(a.x, a.y, 8, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(a.x - 12, a.y); ctx.lineTo(a.x + 12, a.y);
            ctx.moveTo(a.x, a.y - 12); ctx.lineTo(a.x, a.y + 12);
            ctx.stroke();
            const key = `r:${r.group}`;
            v.label(`${r.name} · ${r.phase}`, a.x, a.y + 26, color, selected === key || v.hoverKey === key, 1);
            v.hit(a.x, a.y, 9, { key, kind: 'run', r, what: 'anchor' });
        }
    });
    ctx.globalAlpha = 1;
}

function drawTargets(v: MapView<MapItem>, f: RegionFrame) {
    const { ctx } = v;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.globalAlpha = 0.6;
    for (const b of f.bots) {
        if (b.isDead || b.targetObjectId === null) continue;
        const t = positionOf(f, b.targetObjectId);
        if (!t || t === b) continue;
        const from = v.toScreen(b.x, b.y);
        const to = v.toScreen(t.x, t.y);
        ctx.strokeStyle = realmHex(b.realm);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    }
    for (const { from: e, to: t } of enemyAims(f.enemies, id => positionOf(f, id))) {
        const from = v.toScreen(e.x, e.y);
        const to = v.toScreen(t.x, t.y);
        ctx.strokeStyle = realmHex(e.realm);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    }
}

function drawEnemies(v: MapView<MapItem>, f: RegionFrame) {
    const { ctx } = v;
    for (const e of f.enemies) {
        const s = v.toScreen(e.x, e.y);
        if (!v.onScreen(s)) continue;
        const key = `e:${e.objectId}`;
        const sel = selected === key, hov = v.hoverKey === key;
        const r = e.isPet ? 3.5 : 5;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
        ctx.fillStyle = e.isDead ? '#444' : '#9aa4ae';
        ctx.fill();
        ctx.strokeStyle = realmHex(e.realm);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (sel || hov) {
            ctx.strokeStyle = sel ? 'rgba(90,169,255,0.9)' : 'rgba(255,255,255,0.6)';
            ctx.beginPath(); ctx.arc(s.x, s.y, r + 6, 0, Math.PI * 2); ctx.stroke();
        }
        if ((labelsBox.checked && v.cam.scale >= 0.1) || sel || hov) v.label(`${e.name} ${e.level}`, s.x, s.y - r - 4, '#9aa4ae', sel || hov, 3);
        v.hit(s.x, s.y, r, { key, kind: 'enemy', e });
    }
}

function drawBots(v: MapView<MapItem>, f: RegionFrame) {
    const { ctx } = v;
    for (const b of f.bots) {
        const sp = v.toScreen(b.x, b.y);
        if (!v.onScreen(sp)) continue;
        const key = `b:${b.username}`;
        const active = b.status === 'active';
        const sel = selected === key, hov = v.hoverKey === key;
        const color = realmHex(b.realm);
        // Its window pet, a small dot under it; none while its entry is out of view.
        if (b.pet && b.pet.x !== null && b.pet.y !== null) {
            const ps = v.toScreen(b.pet.x, b.pet.y);
            ctx.beginPath(); ctx.arc(ps.x, ps.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        if (sel || hov) {
            ctx.strokeStyle = sel ? 'rgba(90,169,255,0.9)' : 'rgba(255,255,255,0.6)';
            ctx.lineWidth = sel ? 3 : 1.5;
            ctx.beginPath(); ctx.arc(sp.x, sp.y, 17, 0, Math.PI * 2); ctx.stroke();
        }
        const hv = headingVec(b.heading);
        const n = { x: -hv.y, y: hv.x };
        const len = 12;
        ctx.beginPath();
        ctx.moveTo(sp.x + hv.x * len, sp.y + hv.y * len);
        ctx.lineTo(sp.x - hv.x * 7 + n.x * 7, sp.y - hv.y * 7 + n.y * 7);
        ctx.lineTo(sp.x - hv.x * 3, sp.y - hv.y * 3);
        ctx.lineTo(sp.x - hv.x * 7 - n.x * 7, sp.y - hv.y * 7 - n.y * 7);
        ctx.closePath();
        ctx.globalAlpha = active ? 1 : 0.6;
        ctx.fillStyle = b.isDead ? '#555' : color;
        ctx.fill();
        ctx.globalAlpha = 1;
        // White when fighting; a bot whose client went quiet is drawn where it was last seen, dashed.
        ctx.strokeStyle = !active ? '#8593a3' : b.inCombat ? '#ffffff' : '#0f1216';
        ctx.lineWidth = b.inCombat && active ? 2 : 1.5;
        if (!active) ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (b.isDead) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            cross(ctx, sp, 6);
        }
        if (labelsBox.checked || sel || hov) {
            const age = active ? '' : b.stateAge !== null ? ` (${dur(b.stateAge)} ago)` : '';
            v.label(`${b.isDead ? '† ' : ''}${b.name}${age}`, sp.x, sp.y - 17, active ? color : '#8593a3', sel || hov, 1);
        }
        v.hit(sp.x, sp.y, 10, { key, kind: 'bot', b });
    }
}

function drawHud(v: MapView<MapItem>, f: RegionFrame | null, step: number) {
    const parts: string[] = [];
    if (v.mouse) {
        const w = v.toWorld(v.mouse.x, v.mouse.y);
        parts.push(`cursor ${Math.round(w.x)}, ${Math.round(w.y)}`);
        const b = f?.bots.find(x => `b:${x.username}` === selected);
        if (b) parts.push(`${Math.round(Math.hypot(w.x - b.x, w.y - b.y))} u to ${b.name}`);
    }
    parts.push(`grid ${step} u`);
    if (f) parts.push(`${f.bots.length} bots · ${enemyHeading(f.enemies)} · region ${f.regionId}`);
    $('hud').textContent = parts.join(' · ');
}

function showTooltip(hit: MapItem | null, sx: number, sy: number) {
    if (!hit || !Number.isFinite(sx)) { tooltip.style.display = 'none'; return; }
    const rows: string[] = [];
    if (hit.kind === 'bot') {
        const b = hit.b;
        rows.push(`<div class="tname" style="color:${realmHex(b.realm)}">${esc(b.name)}</div>`);
        rows.push(`<div>L${esc(b.level)} ${esc(b.className)} · ${esc(b.realm)}${b.group ? ` · ${esc(b.group.name)}` : ''}</div>`);
        rows.push(`<div>HP ${esc(Math.round(b.hp))}% · power ${esc(Math.round(b.mana))}% · endurance ${esc(Math.round(b.endurance))}%${b.isDead ? ' · <span class="bad">dead</span>' : ''}${b.inCombat ? ' · <span class="bad">in combat</span>' : ''}${b.isSitting ? ' · sitting' : ''}</div>`);
        if (b.targetObjectId !== null) rows.push(`<div>target ${esc(nameOf(b.targetObjectId))}</div>`);
        if (b.pet) rows.push(`<div>pet ${esc(b.pet.name || `#${b.pet.objectId}`)}${b.pet.hp !== null ? ` · HP ${esc(Math.round(b.pet.hp))}%` : ' · out of view'}</div>`);
        rows.push(`<div class="muted">${esc(b.username)} · client ${esc(b.status)}${b.stateAge !== null ? ` · state ${esc(dur(b.stateAge))} old` : ''}${b.realmPoints ? ` · ${fmtInt(b.realmPoints)} RP` : ''}</div>`);
        rows.push(`<div class="muted">${esc(b.zoneName)} · ${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.z)} · #${esc(b.objectId)} · double-click: bot page</div>`);
    } else if (hit.kind === 'enemy') {
        const e = hit.e;
        rows.push(`<div class="tname">${esc(e.name)}</div>`);
        rows.push(`<div>${enemyWord(e)}, ${e.isPet ? 'of none of our bots' : 'none of our bots'} · level ${esc(e.level)} · ${esc(e.realm)}${e.targetId != null ? ` · on ${esc(nameOf(e.targetId))}` : ''}</div>`);
        rows.push(`<div>HP ${esc(Math.round(e.hp))}%${e.inCombat ? ' · <span class="bad">in combat</span>' : ''}${e.isDead ? ' · dead' : ''}</div>`);
        rows.push(`<div class="muted">seen by ${esc(e.seenBy.join(', '))} · #${esc(e.objectId)} · ${Math.round(e.x)}, ${Math.round(e.y)}</div>`);
    } else if (hit.kind === 'keep') {
        const k = hit.k;
        rows.push(`<div class="tname" style="color:${realmHex(k.owner)}">${esc(k.name)}</div>`);
        rows.push(`<div>${esc(k.owner)}${k.portal ? ' portal keep' : ' keep'} · guards level ${esc(k.guardLevel)}</div>`);
        if (k.clearance) rows.push(`<div class="muted">RvR groups of other realms stay ${fmtInt(k.clearance)} away</div>`);
    } else {
        const r = hit.r;
        rows.push(`<div class="tname" style="color:${realmHex(r.realm)}">${esc(r.name)}: ${hit.what === 'anchor' ? 'anchor' : hit.what === 'retreat' ? 'retreat point' : 'heading for'}</div>`);
        if (hit.what === 'camp') rows.push(`<div>${esc(r.camp?.label ?? '')}</div>`);
        else rows.push(`<div>${esc(r.phase)} · ${esc(r.reason)}</div>`);
        if (r.objective) rows.push(`<div class="muted">${esc(r.objective)}</div>`);
        if (hit.what === 'anchor') rows.push('<div class="muted">double-click: group page</div>');
    }
    tooltip.innerHTML = rows.join('');
    tooltip.style.display = 'block';
    const wrap = $('mapwrap').getBoundingClientRect();
    tooltip.style.left = `${clamp(sx + 14, 4, wrap.width - tooltip.offsetWidth - 4)}px`;
    tooltip.style.top = `${clamp(sy + 14, 4, wrap.height - tooltip.offsetHeight - 4)}px`;
}

/** A name for an object id: our bot's character name, else the enemy player's, else the id. */
function nameOf(id: number): string {
    const f = frame;
    return f?.bots.find(b => b.objectId === id)?.name ?? f?.enemies.find(e => e.objectId === id)?.name ?? `#${id}`;
}

/** Where a map item stands, for bringing it into view from the side panel. */
function itemPosition(key: string): Pt | null {
    const f = frame;
    if (!f) return null;
    if (key.startsWith('b:')) return f.bots.find(b => `b:${b.username}` === key) ?? null;
    if (key.startsWith('e:')) return f.enemies.find(e => `e:${e.objectId}` === key) ?? null;
    if (key.startsWith('k:')) return f.keeps.find(k => `k:${k.name}` === key) ?? null;
    if (key.startsWith('r:')) {
        const r = f.runs.find(x => `r:${x.group}` === key);
        const pts = f.bots.filter(b => r?.members.includes(b.username));
        if (finite(r?.anchor)) return r!.anchor;
        return pts.length ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length } : null;
    }
    return null;
}

function select(key: string | null, fromPanel = false) {
    selected = key;
    if (fromPanel && key) {
        const pos = itemPosition(key);
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
$('center').addEventListener('click', () => setFollow('all'));
$('fit').addEventListener('click', () => {
    const f = frame;
    if (!f) return;
    const pts: Pt[] = [...f.bots, ...f.runs.flatMap(r => (finite(r.anchor) ? [r.anchor] : []))];
    view.fit(pts.length ? pts : f.keeps);
});
followSel.addEventListener('change', () => setFollow(followSel.value));
labelsBox.addEventListener('change', () => view.invalidate());
window.addEventListener('keydown', ev => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLTextAreaElement) return;
    if (ev.key === '+' || ev.key === '=') view.zoom(1.5);
    else if (ev.key === '-') view.zoom(1 / 1.5);
    else if (ev.key === 'c' || ev.key === 'f') setFollow(followMode === 'off' ? 'all' : followMode);
    else if (ev.key === 'Escape') select(null);
});

// Layer switches, remembered per browser.
const LAYERS_KEY = 'viewer-region-layers';
try {
    const saved = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}');
    for (const k of Object.keys(layer) as (keyof typeof layer)[]) {
        if (saved && typeof saved[k] === 'boolean') layer[k] = saved[k];
    }
} catch {}
for (const name of Object.keys(layer) as (keyof typeof layer)[]) {
    const box = $<HTMLInputElement>(`l-${name}`);
    box.checked = layer[name];
    box.addEventListener('change', () => {
        layer[name] = box.checked;
        try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layer)); } catch {}
        view.invalidate();
    });
}

$('legend').innerHTML = [
    ...(['albion', 'midgard', 'hibernia'] as const).map(r => `<span><i class="swatch" style="background:${REALM_HEX[r]}"></i>${r}</span>`),
    '<span><i class="swatch" style="background:#9aa4ae;border-radius:0;transform:rotate(45deg)"></i>enemy player, smaller its pet</span>',
    '<span><i class="swatch" style="background:#8593a3;border-radius:0"></i>keep</span>',
    '<span><i class="swatch" style="border:2px dashed #d6dde6;background:none"></i>focus</span>',
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
    safely('notes panel', renderNotes);
    safely('runs panel', renderRuns);
    safely('bots panel', renderBots);
    safely('enemies panel', renderEnemies);
    safely('keeps panel', renderKeeps);
}

function regionName(): string {
    return frame?.layout?.name || regionData?.region?.description || `region ${REGION}`;
}

function renderTopbar() {
    const name = regionName();
    $('title').textContent = name === `region ${REGION}` ? name : `${name} (region ${REGION})`;
    document.title = `${name} · region · daoc-sdk viewer`;
    const f = frame;
    if (!f) { $('counts').textContent = ''; return; }
    const per = (['albion', 'midgard', 'hibernia'] as const).map(r => [r, f.bots.filter(b => b.realm === r)] as const).filter(([, bs]) => bs.length);
    $('counts').innerHTML = per.map(([r, bs]) => `<span style="color:${REALM_HEX[r]}" title="${esc(r)}: alive / in the region">${bs.filter(b => !b.isDead).length}/${bs.length} ${esc(r)}</span>`).join(' · ');
}

function renderAge() {
    const el = $('age');
    if (!frame) { el.textContent = ''; return; }
    const age = (Date.now() - frameAt) / 1000;
    el.textContent = age > 3 ? `frame ${age.toFixed(0)} s old` : '';
    el.className = `mono ${age > 8 ? 'bad' : 'warn'}`;
}

function renderBanner() {
    const banner = $('banner');
    let html = '';
    if (problem) html = esc(problem);
    else if (!frame) html = `Loading region <b>${esc(REGION)}</b>…`;
    else if (!frame.bots.length && !frame.hidden.bots) html = `No bot is in game in ${esc(regionName())}.<div class="muted">The page shows bots once their clients are in this region.</div>`;
    banner.innerHTML = html;
    banner.style.display = html ? 'block' : 'none';
}

function renderNotes() {
    const f = frame;
    const hidden = f ? f.hidden.bots + f.hidden.runs : 0;
    if (!f || !hidden) { setSection('r-notes', ''); return; }
    const what = [f.hidden.bots ? `${f.hidden.bots} bot${f.hidden.bots === 1 ? '' : 's'}` : '', f.hidden.runs ? `${f.hidden.runs} run${f.hidden.runs === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    setSection('r-notes', `<div class="warn">${esc(what)} hidden${password ? ': the password does not open them' : ''}.</div>
        <div class="muted">This gateway checks bot.env passwords: a bot shows when the password is its own, a run when it is its leader's.</div>`);
}

function totalsText(r: RegionRun): string {
    const t = r.totals;
    if (!t) return '';
    const parts = [
        t.playerKills !== undefined ? `<span title="enemy players killed">PK ${fmtInt(t.playerKills)}</span>` : `<span>kills ${fmtInt(t.kills)}</span>`,
        t.deathsToPlayers !== undefined ? `<span title="members killed by players">deaths ${fmtInt(t.deathsToPlayers)}</span>` : `<span>deaths ${fmtInt(t.deaths)}</span>`,
        t.enemiesSeen !== undefined ? `<span title="distinct enemy players seen">seen ${fmtInt(t.enemiesSeen)}</span>` : '',
        t.engagements !== undefined ? `<span title="fights with at least one enemy player">fights ${fmtInt(t.engagements)}</span>` : '',
        t.realmPoints ? `<span>${fmtInt(t.realmPoints)} RP</span>` : '',
    ];
    return parts.filter(Boolean).join(' · ');
}

function renderRuns() {
    const f = frame;
    if (!f) { setSection('r-runs', ''); return; }
    const running = new Set(f.runs.map(r => r.group));
    const idle = new Map<string, string>();
    for (const b of f.bots) if (b.group && !running.has(b.group.id)) idle.set(b.group.id, b.group.name);
    if (!f.runs.length && !idle.size) { setSection('r-runs', ''); return; }
    const cards = f.runs.map(r => {
        const key = `r:${r.group}`;
        const color = realmHex(r.realm);
        const focus = r.focus
            ? `<span style="color:${realmHex(r.focus.realm)}">${esc(r.focus.name)}</span>${r.focus.hp !== null ? ` ${esc(Math.round(r.focus.hp))}%` : ''}${r.focus.ours ? '' : ' <span class="muted">(not one of ours)</span>'}`
            : '<span class="muted">none</span>';
        const late = r.state === 'stale' ? ` · publish ${esc(dur(r.ageMs))} ago` : '';
        return `<div class="run-card${selected === key ? ' sel' : ''}" style="border-left-color:${color}" data-act="select" data-key="${esc(key)}">
            <div class="line"><a href="/viewer/group/${encodeURIComponent(r.group)}" target="_blank" rel="noopener" title="Open the group page"><b style="color:${color}">${esc(r.name)}</b></a>
                <span class="pill ${phaseClass(r.phase)}">${esc(r.phase)}</span>
                <span class="spacer"></span>
                <span class="muted" title="run members alive in this region / members">${esc(r.alive)}/${esc(r.size)} alive</span>
                <span class="pill ${r.state === 'live' ? 'active' : r.state === 'stale' || r.state === 'starting' ? 'stale' : ''}" title="${esc(r.strategy)} · run ${esc(r.runId)}${late}">${esc(r.state)}${r.windingDown ? ' · winding down' : ''}</span></div>
            <div class="line activity">${esc(r.reason)}</div>
            ${r.objective ? `<div class="line muted">${esc(r.objective)}</div>` : ''}
            <div class="line"><span class="muted">focus</span> ${focus}</div>
            ${r.totals ? `<div class="line muted">${totalsText(r)}</div>` : ''}
        </div>`;
    }).join('');
    const rest = idle.size ? `<div class="muted" style="margin-top:4px">No run: ${[...idle].map(([id, name]) => `<a href="/viewer/group/${encodeURIComponent(id)}" target="_blank" rel="noopener">${esc(name)}</a>`).join(', ')}</div>` : '';
    setSection('r-runs', `<h3>Groups <span>${f.runs.length} running</span></h3>${cards}${rest}`);
}

function renderBots() {
    const f = frame;
    if (!f || !f.bots.length) { setSection('r-bots', ''); return; }
    // By group (running groups first, in the runs' order), then the bots in none.
    const order = new Map(f.runs.map((r, i) => [r.group, i]));
    const groups = new Map<string, { name: string; bots: RegionBot[] }>();
    for (const b of f.bots) {
        const id = b.group?.id ?? '';
        let g = groups.get(id);
        if (!g) groups.set(id, g = { name: b.group?.name ?? 'no group', bots: [] });
        g.bots.push(b);
    }
    const rank = (id: string) => (id === '' ? Infinity : order.get(id) ?? 1000);
    const blocks = [...groups].sort((a, b) => rank(a[0]) - rank(b[0]) || a[1].name.localeCompare(b[1].name)).map(([, g]) => {
        const rows = g.bots.map(b => {
            const key = `b:${b.username}`;
            const status = b.status === 'active' ? '' : `<span class="pill stale" title="the client's last state is ${esc(b.stateAge !== null ? dur(b.stateAge) : '?')} old">${esc(b.status)}</span>`;
            const flags = [b.isDead ? '<span class="bad">dead</span>' : '', b.inCombat ? '<span class="bad">combat</span>' : '', b.isSitting ? '<span class="muted">sitting</span>' : ''].filter(Boolean).join(' ');
            return `<div class="member-row${selected === key ? ' sel' : ''}" data-act="select" data-key="${esc(key)}">
                <div class="line"><a href="/viewer/${encodeURIComponent(b.username)}" target="_blank" rel="noopener" title="Open ${esc(b.username)}'s page (observe)"><b style="color:${realmHex(b.realm)}">${esc(b.name || b.username)}</b></a>
                    <span class="muted">L${esc(b.level)} ${esc(b.className)}</span>
                    <span class="spacer"></span>${flags} ${status}</div>
                <div class="mini-bars">${miniBar(b.hp, 'var(--hp)', `health ${Math.round(b.hp)}%`)}${miniBar(b.mana, 'var(--mana)', `power ${Math.round(b.mana)}%`)}</div>
            </div>`;
        }).join('');
        return `<div class="realm-head">${esc(g.name)} <span class="muted">${g.bots.filter(b => !b.isDead).length}/${g.bots.length} alive</span></div>${rows}`;
    }).join('');
    setSection('r-bots', `<h3>Bots <span>${f.bots.length} in game here</span></h3>${blocks}`);
}

function renderEnemies() {
    const f = frame;
    if (!f || !f.enemies.length) { setSection('r-enemies', ''); return; }
    const items = f.enemies.slice(0, 40).map(e => {
        const key = `e:${e.objectId}`;
        return `<li class="${selected === key ? 'sel' : ''}" data-act="select" data-key="${esc(key)}">
            <span><span style="color:${realmHex(e.realm)}">${esc(e.name)}</span> <span class="muted">L${esc(e.level)} ${esc(e.realm)}</span>${e.isPet ? ' <span class="chip">pet</span>' : ''} ${esc(Math.round(e.hp))}%${e.isDead ? ' <span class="muted">dead</span>' : ''}</span>
            <span class="r" title="${esc(e.seenBy.join(', '))}">seen by ${esc(e.seenBy.length)}</span></li>`;
    }).join('');
    setSection('r-enemies', `<h3>Enemies <span title="${esc(enemyHeading(f.enemies))} of other realms, none of them our bots or their pets">${f.enemies.length}</span></h3>
        <ul class="list scroll" data-scroll="enemies">${items}</ul>${f.enemies.length > 40 ? `<div class="muted">40 of ${f.enemies.length} shown</div>` : ''}`);
}

function renderKeeps() {
    const f = frame;
    if (!f || !f.keeps.length) { setSection('r-keeps', ''); return; }
    const items = f.keeps.map(k => {
        const key = `k:${k.name}`;
        return `<li class="${selected === key ? 'sel' : ''}" data-act="select" data-key="${esc(key)}">
            <span><i class="swatch" style="background:${realmHex(k.owner)};border-radius:0"></i> ${esc(k.name)}</span>
            <span class="r">${esc(k.owner)}${k.portal ? ' · portal' : ''} · guards L${esc(k.guardLevel)}</span></li>`;
    }).join('');
    const levels = f.layout ? ` <span class="muted">levels ${esc(f.layout.levels.join('-'))}</span>` : '';
    setSection('r-keeps', `<h3>Keeps${levels}</h3><ul class="list">${items}</ul>`);
}

$('side').addEventListener('click', ev => {
    const target = ev.target as HTMLElement;
    // Names are links to their own pages: let them open.
    if (target.closest('a')) return;
    const el = target.closest<HTMLElement>('[data-act="select"]');
    if (!el) return;
    select(el.dataset.key && el.dataset.key !== selected ? el.dataset.key : null, true);
});

// ── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('visibilitychange', () => {
    // Back on the tab: don't wait out the hidden-tab interval.
    if (!document.hidden && pollTimer && !polling) schedule(0);
});
setInterval(renderAge, 250);

view.resize();
view.start();
renderPanel();
void poll();
