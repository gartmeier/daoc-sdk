// Browser viewer for one bot. Bundled by routes.ts with Bun.build on request.
//
// Watches the bot as an observe-mode SDK over the gateway WebSocket (falls back
// to polling GET /state/<bot>), renders a top-down map in world units and a side
// panel. Control mode opens a second, control-mode socket only when ticked.

import { CON_HEX, conColor } from './con-level';
import { authHeaders, shouldLoadRegion } from './logic';
import type {
    ActionResult, BotAction, BotWorldState, CombatEvent, GameMessage, InventoryItem,
    NearbyNpc, NearbyObject, NearbyPlayer, PlayerState, Vec3,
} from '../../sdk/types';

type State = Partial<BotWorldState>;
type Entity = (NearbyNpc | NearbyPlayer | NearbyObject) & Record<string, any>;

interface ZoneRect { id: number; name: string; xOffset: number; yOffset: number; width: number; height: number }
interface RegionData {
    regionId: number;
    region: { id: number; name: string; description: string } | null;
    zones: ZoneRect[];
    zonePoints: { id: number; x: number; y: number; targetRegion: number }[];
    bindpoints: { x: number; y: number; radius: number }[];
}
interface Hit { sx: number; sy: number; r: number; entity: Entity }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BOT = document.body.dataset.bot ?? '';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const REALM_HEX: Record<string, string> = { albion: '#ff5a5a', midgard: '#5a9bff', hibernia: '#59d46b', none: '#cccccc' };

// ── State ───────────────────────────────────────────────────────────────────

let state: State | null = null;
let stateReceivedAt = 0;
let botStatus: { status?: string; controllers?: string[]; observers?: string[] } | null = null;
let regionData: RegionData | null = null;
let regionLoading: number | null = null;
let regionFailure: { regionId: number; at: number } | null = null;
let selectedId: number | null = null;

function player(): PlayerState | null {
    const p = state?.player;
    return p && typeof p === 'object' ? p : null;
}

function entities(): Entity[] {
    if (!state) return [];
    return [
        ...arr(state.nearbyObjects as Entity[]),
        ...arr(state.nearbyNpcs as Entity[]),
        ...arr(state.nearbyPlayers as Entity[]),
    ].filter(e => e && Number.isFinite(e.x) && Number.isFinite(e.y));
}

function findEntity(objectId: number | null | undefined): Entity | null {
    if (objectId === null || objectId === undefined) return null;
    return entities().find(e => e.objectId === objectId) ?? null;
}

function entityName(objectId: number | null | undefined): string {
    if (objectId === null || objectId === undefined) return '?';
    const p = player();
    if (p && p.objectId === objectId) return p.name || 'you';
    const g = arr(state?.group).find(m => m.objectId === objectId);
    return findEntity(objectId)?.name ?? g?.name ?? `#${objectId}`;
}

function distanceTo(e: { x: number; y: number; z?: number; distance?: number }): number | null {
    if (typeof e.distance === 'number' && Number.isFinite(e.distance)) return e.distance;
    const p = player();
    if (!p) return null;
    return Math.hypot(e.x - p.x, e.y - p.y, (num(e.z, p.z) - p.z));
}

function applyState(next: unknown) {
    if (!next || typeof next !== 'object') return;
    state = next as State;
    stateReceivedAt = Date.now();
    const p = player();
    if (p && Number.isFinite(p.regionId) && shouldLoadRegion(p.regionId, regionData?.regionId ?? null, regionLoading, regionFailure, Date.now())) {
        loadRegion(p.regionId);
    }
    if (follow && p) { cam.x = p.x; cam.y = p.y; }
    if (!initialised && p) { cam.x = p.x; cam.y = p.y; initialised = true; }
    dirty = true;
    schedulePanel();
}

async function loadRegion(regionId: number) {
    regionLoading = regionId;
    let loaded: RegionData | null = null;
    try {
        const res = await fetch(`/zones/${regionId}`, { cache: 'no-store' });
        if (res.ok) loaded = await res.json() as RegionData;
    } catch {}
    // A slower response for a region we already left must not replace the current one.
    if (regionLoading !== regionId) return;
    regionLoading = null;
    if (loaded) {
        regionData = loaded;
        regionFailure = null;
    } else {
        regionFailure = { regionId, at: Date.now() };
    }
    dirty = true;
    schedulePanel();
}

// ── Observe connection ──────────────────────────────────────────────────────

let obsConnected = false;
let obsError: string | null = null;

function wsUrl() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`;
}

function connectObserve() {
    let ws: WebSocket;
    try {
        ws = new WebSocket(wsUrl());
    } catch {
        setTimeout(connectObserve, 3000);
        return;
    }
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'sdk_connect', username: BOT, password: passwordInput.value || '', clientId: 'viewer-observe', mode: 'observe' }));
    };
    ws.onmessage = ev => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.type === 'sdk_connected') {
            obsConnected = true;
            obsError = null;
        } else if (msg.type === 'sdk_state') {
            applyState(msg.state);
        } else if (msg.type === 'sdk_error' && typeof msg.error === 'string') {
            if (!msg.actionId) obsError = msg.error;
        }
        updateConn();
    };
    ws.onclose = () => {
        obsConnected = false;
        updateConn();
        setTimeout(connectObserve, 2000);
    };
}

async function pollFallback() {
    try {
        const status = await fetch(`/status/${encodeURIComponent(BOT)}`, { cache: 'no-store' });
        if (status.ok) botStatus = await status.json();
    } catch {
        botStatus = null;
    }
    if (!obsConnected) {
        try {
            const res = await fetch(`/state/${encodeURIComponent(BOT)}`, { cache: 'no-store', headers: authHeaders(passwordInput.value) });
            const body = await res.json();
            // The observe socket may have (re)connected meanwhile; its state is newer.
            if (body?.state && !obsConnected) applyState(body.state);
        } catch {}
    }
    updateConn();
}

function updateConn() {
    const el = $('conn');
    const status = botStatus?.status ?? 'unknown';
    let text: string;
    let cls: string;
    if (obsConnected) {
        text = status === 'active' ? 'live' : `ws · bot ${status}`;
        cls = status === 'active' ? 'active' : status === 'stale' ? 'stale' : 'dead';
    } else {
        text = botStatus ? `polling · bot ${status}` : 'gateway unreachable';
        cls = botStatus ? 'stale' : 'dead';
    }
    if (ctlReady) text += ' · control';
    el.textContent = text;
    el.className = `pill ${cls}`;
    el.title = obsError ?? '';
}

// ── Control connection ──────────────────────────────────────────────────────

const passwordInput = $<HTMLInputElement>('password');
const controlBox = $<HTMLInputElement>('control');
let ctlWs: WebSocket | null = null;
let ctlReady = false;
let actionSeq = 0;
const pending = new Map<string, { resolve: (r: ActionResult) => void; timer: ReturnType<typeof setTimeout> }>();

try {
    const saved = sessionStorage.getItem(`viewer-pw-${BOT}`);
    if (saved) passwordInput.value = saved;
} catch {}

// Bumped by every enable/disable, so an enable still waiting on /auth or the
// confirm() after the box was unticked (or ticked again) gives up.
let controlGen = 0;

async function enableControl() {
    const gen = ++controlGen;
    const stillWanted = () => gen === controlGen && controlBox.checked;
    const password = passwordInput.value;
    if (!password) {
        toast('Type the bot password (bots/<bot>/bot.env PASSWORD) first');
        controlBox.checked = false;
        return;
    }
    try {
        const res = await fetch(`/bots/${encodeURIComponent(BOT)}/auth`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!stillWanted()) return;
        if (!res.ok || !body.ok) {
            toast(`Control refused: ${body.error ?? res.status}`);
            controlBox.checked = false;
            return;
        }
    } catch (error) {
        if (!stillWanted()) return;
        toast(`Control refused: ${error}`);
        controlBox.checked = false;
        return;
    }
    const others = arr(botStatus?.controllers).length;
    if (others > 0 && !confirm(`${BOT} already has ${others} controlling SDK (a running script?). Taking control disconnects it. Continue?`)) {
        controlBox.checked = false;
        return;
    }
    if (!stillWanted()) return;
    try { sessionStorage.setItem(`viewer-pw-${BOT}`, password); } catch {}
    const ws = new WebSocket(wsUrl());
    ctlWs = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'sdk_connect', username: BOT, password, clientId: 'viewer-control', mode: 'control' }));
    ws.onmessage = ev => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.type === 'sdk_connected') {
            ctlReady = true;
            $('s-control').hidden = false;
            toast('Control enabled');
            schedulePanel();
            updateConn();
        } else if (msg.type === 'sdk_action_result' && msg.actionId) {
            settle(msg.actionId, msg.result ?? { success: false, message: 'empty result' });
        } else if (msg.type === 'sdk_error') {
            if (msg.actionId) settle(msg.actionId, { success: false, message: String(msg.error), reason: 'error' });
            else if (/another controller|Authentication failed/i.test(String(msg.error))) disableControl(String(msg.error));
            else toast(String(msg.error));
        }
    };
    ws.onclose = () => { if (ctlWs === ws) disableControl(ctlReady ? 'Control connection closed' : 'Control connection failed'); };
}

function disableControl(reason?: string) {
    controlGen++;
    const ws = ctlWs;
    ctlWs = null;
    ctlReady = false;
    controlBox.checked = false;
    $('s-control').hidden = true;
    try { ws?.close(); } catch {}
    for (const id of [...pending.keys()]) settle(id, { success: false, message: 'control disabled', reason: 'disconnected' });
    if (reason) toast(reason);
    schedulePanel();
    updateConn();
}

function settle(actionId: string, result: ActionResult) {
    const p = pending.get(actionId);
    if (!p) return;
    pending.delete(actionId);
    clearTimeout(p.timer);
    p.resolve(result);
}

function act(action: BotAction): Promise<ActionResult> {
    if (!ctlReady || !ctlWs) {
        toast('Enable control mode first');
        return Promise.resolve({ success: false, message: 'not in control mode' });
    }
    const actionId = `viewer-${Date.now()}-${++actionSeq}`;
    const promise = new Promise<ActionResult>(resolve => {
        const timer = setTimeout(() => settle(actionId, { success: false, message: 'timed out', reason: 'timeout' }), 20_000);
        pending.set(actionId, { resolve, timer });
    });
    ctlWs.send(JSON.stringify({ type: 'sdk_action', username: BOT, actionId, action: { ...action, reason: action.reason ?? 'viewer' }, actionTimeoutMs: 15_000 }));
    // A 'dispatch' result only means the packet went out (a buy without money
    // still says "buying ..."); the server's verdict arrives in the chat log.
    promise.then(r => toast(`${action.type}${r.success && r.phase === 'dispatch' ? ' (sent)' : ''}: ${r.success ? '' : 'FAILED '}${r.message ?? ''}`, !r.success));
    return promise;
}

controlBox.addEventListener('change', () => { if (controlBox.checked) enableControl(); else disableControl('Control disabled'); });

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string, bad = false) {
    const el = $('toast');
    el.textContent = text;
    el.style.display = 'block';
    el.style.color = bad ? 'var(--bad)' : '';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ── Map ─────────────────────────────────────────────────────────────────────

const canvas = $<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;
const tooltip = $('tooltip');
const followBox = $<HTMLInputElement>('follow');
const labelsBox = $<HTMLInputElement>('labels');
const cam = { x: 0, y: 0, scale: 0.2 };
let follow = true;
let initialised = false;
let dirty = true;
let width = 0;
let height = 0;
let hits: Hit[] = [];
let hoverId: number | null = null;
let mouse: { x: number; y: number } | null = null;

try {
    const savedScale = parseFloat(localStorage.getItem('viewer-scale') ?? '');
    if (Number.isFinite(savedScale) && savedScale > 0) cam.scale = savedScale;
} catch {}

const toScreen = (x: number, y: number) => ({ x: (x - cam.x) * cam.scale + width / 2, y: (y - cam.y) * cam.scale + height / 2 });
const toWorld = (sx: number, sy: number) => ({ x: (sx - width / 2) / cam.scale + cam.x, y: (sy - height / 2) / cam.scale + cam.y });
/** DAoC heading (0 = +Y, clockwise, 4096 per turn) → unit vector in world/screen space. */
const headingVec = (h: number) => {
    const a = (num(h) * 2 * Math.PI) / 4096;
    return { x: -Math.sin(a), y: Math.cos(a) };
};

function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
}
new ResizeObserver(resize).observe(canvas);

function setScale(next: number, anchor?: { x: number; y: number }) {
    const scale = clamp(next, 0.004, 4);
    if (anchor && !follow) {
        const w = toWorld(anchor.x, anchor.y);
        cam.scale = scale;
        cam.x = w.x - (anchor.x - width / 2) / scale;
        cam.y = w.y - (anchor.y - height / 2) / scale;
    } else {
        cam.scale = scale;
    }
    try { localStorage.setItem('viewer-scale', String(cam.scale)); } catch {}
    dirty = true;
}

function setFollow(on: boolean) {
    follow = on;
    followBox.checked = on;
    const p = player();
    if (on && p) { cam.x = p.x; cam.y = p.y; }
    dirty = true;
}

function niceStep(minWorld: number): number {
    const steps = [10, 25, 50, 100, 250, 500, 1000, 2000, 4096, 8192, 16384, 32768, 65536];
    return steps.find(s => s >= minWorld) ?? 65536;
}

function drawGrid() {
    const step = niceStep(70 / cam.scale);
    const tl = toWorld(0, 0);
    const br = toWorld(width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = Math.round(toScreen(x, 0).x) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, height);
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
        const sy = Math.round(toScreen(0, y).y) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(width, sy);
    }
    ctx.stroke();
    return step;
}

function drawZones() {
    if (!regionData) return;
    const p = player();
    ctx.font = '12px system-ui, sans-serif';
    for (const z of arr(regionData.zones)) {
        const a = toScreen(z.xOffset, z.yOffset);
        const w = z.width * cam.scale;
        const h = z.height * cam.scale;
        if (a.x > width || a.y > height || a.x + w < 0 || a.y + h < 0) continue;
        const current = p && p.zoneId === z.id;
        ctx.fillStyle = current ? 'rgba(90,169,255,0.035)' : 'rgba(255,255,255,0.012)';
        ctx.fillRect(a.x, a.y, w, h);
        ctx.strokeStyle = current ? 'rgba(90,169,255,0.55)' : 'rgba(180,190,200,0.28)';
        ctx.lineWidth = current ? 2 : 1;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(a.x, a.y, w, h);
        ctx.setLineDash([]);
        const lx = clamp(a.x + 6, 6, Math.max(6, a.x + w - 120));
        // Keep the label clear of the legend in the top-left corner.
        const ly = clamp(a.y + 16, 56, Math.max(56, a.y + h - 6));
        ctx.fillStyle = current ? 'rgba(140,195,255,0.85)' : 'rgba(180,190,200,0.5)';
        ctx.fillText(`${z.name} (${z.id})`, lx, ly);
    }
    for (const zp of arr(regionData.zonePoints)) {
        const s = toScreen(zp.x, zp.y);
        if (s.x < -20 || s.y < -20 || s.x > width + 20 || s.y > height + 20) continue;
        ctx.fillStyle = '#d96cff';
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x + 6, s.y); ctx.lineTo(s.x, s.y + 6); ctx.lineTo(s.x - 6, s.y);
        ctx.closePath();
        ctx.fill();
        if (cam.scale > 0.05) {
            ctx.font = '11px system-ui, sans-serif';
            ctx.fillText(`→ region ${zp.targetRegion}`, s.x + 8, s.y + 4);
        }
    }
    for (const b of arr(regionData.bindpoints)) {
        const s = toScreen(b.x, b.y);
        if (s.x < -50 || s.y < -50 || s.x > width + 50 || s.y > height + 50) continue;
        ctx.strokeStyle = 'rgba(89,212,107,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(4, num(b.radius) * cam.scale), 0, Math.PI * 2);
        ctx.stroke();
        if (cam.scale > 0.05) {
            ctx.fillStyle = 'rgba(89,212,107,0.8)';
            ctx.font = '11px system-ui, sans-serif';
            ctx.fillText('bind', s.x + 6, s.y - 6);
        }
    }
}

// Labels are queued while drawing shapes and placed afterwards, most important
// first (forced, then players, loot, NPCs nearest first), skipping overlaps.
interface PendingLabel { text: string; x: number; y: number; color: string; force: boolean; prio: number }
const pendingLabels: PendingLabel[] = [];
function label(text: string, x: number, y: number, color: string, force = false, prio = 3) {
    pendingLabels.push({ text, x, y, color, force, prio: force ? -1 : prio });
}

function flushLabels() {
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    pendingLabels.sort((a, b) => a.prio - b.prio);
    ctx.textAlign = 'center';
    for (const l of pendingLabels) {
        ctx.font = l.force ? 'bold 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
        const w = ctx.measureText(l.text).width;
        const box = { x: l.x - w / 2 - 2, y: l.y - 11, w: w + 4, h: 13 };
        if (!l.force && boxes.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
        boxes.push(box);
        ctx.fillStyle = 'rgba(10,12,15,0.65)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x, l.y);
    }
    ctx.textAlign = 'start';
    pendingLabels.length = 0;
}

function drawEntity(e: Entity, p: PlayerState | null) {
    const s = toScreen(e.x, e.y);
    if (s.x < -30 || s.y < -30 || s.x > width + 30 || s.y > height + 30) return;
    const targeted = p?.targetObjectId != null && p.targetObjectId === e.objectId;
    const hovered = hoverId === e.objectId;
    const selected = selectedId === e.objectId;
    let r = 5;
    let color = '#ccc';
    let showLabel = labelsBox.checked && cam.scale >= 0.1;

    if (e.kind === 'npc') {
        const npc = e as NearbyNpc;
        color = p ? CON_HEX[conColor(p.level, num(npc.level))] : CON_HEX.yellow;
        r = npc.isPet ? 4 : 5.5;
        const dead = num(npc.healthPercent, 100) <= 0;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        if (npc.isPeaceful || npc.isTargetable === false) {
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
            ctx.beginPath();
            ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r);
            ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r);
            ctx.stroke();
        }
        if (npc.inCombat) {
            ctx.strokeStyle = '#ff3b3b';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
            ctx.stroke();
        }
        if (p && npc.targetObjectId != null && npc.targetObjectId === p.objectId && !dead) {
            const ps = toScreen(p.x, p.y);
            ctx.strokeStyle = 'rgba(255,70,70,0.6)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ps.x, ps.y); ctx.stroke();
            ctx.setLineDash([]);
        }
        if (cam.scale > 0.15 && num(npc.speed) > 0) {
            const v = headingVec(npc.heading);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + v.x * (r + 6), s.y + v.y * (r + 6)); ctx.stroke();
        }
        if (showLabel || targeted || hovered || selected) label(`${npc.name || '(unnamed)'} ${npc.level ?? ''}`, s.x, s.y - r - 4, color, targeted || hovered || selected, 3 + num(npc.distance2d, 1e5) / 1e6);
    } else if (e.kind === 'player') {
        const pl = e as NearbyPlayer;
        color = REALM_HEX[pl.realm] ?? REALM_HEX.none!;
        r = 6;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
        ctx.fillStyle = pl.isDead ? '#444' : color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (labelsBox.checked || targeted || hovered || selected) label(pl.name, s.x, s.y - r - 4, '#fff', targeted || hovered || selected, 1);
    } else {
        const o = e as NearbyObject;
        if (o.isLoot) {
            color = o.ownedByUs ? '#ffd84a' : '#c9a23a';
            r = 4.5;
            ctx.fillStyle = color;
            ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
            if (labelsBox.checked || hovered || selected || targeted) label(o.name, s.x, s.y - r - 4, color, hovered || selected || targeted, 2);
        } else {
            color = o.doorId !== null && o.doorId !== undefined ? '#a0703c' : '#6f7a86';
            r = 3;
            ctx.fillStyle = color;
            ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
            if (hovered || selected || targeted) label(o.name, s.x, s.y - r - 4, '#cbd3dc', true);
        }
    }

    if (targeted) {
        ctx.strokeStyle = '#ffe14a';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
    } else if (selected || hovered) {
        ctx.strokeStyle = selected ? 'rgba(90,169,255,0.9)' : 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
    }
    hits.push({ sx: s.x, sy: s.y, r, entity: e });
}

function drawMovement(p: PlayerState) {
    const m = state?.movement;
    const points: Vec3[] = arr(m?.waypoints).filter(w => w && Number.isFinite(w.x) && Number.isFinite(w.y));
    const dest = m?.destination && Number.isFinite(m.destination.x) ? m.destination : null;
    if (dest && !points.some(w => w.x === dest.x && w.y === dest.y)) points.push(dest);
    if (points.length > 0) {
        const start = toScreen(p.x, p.y);
        ctx.strokeStyle = 'rgba(90,169,255,0.85)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        for (const w of points) { const s = toScreen(w.x, w.y); ctx.lineTo(s.x, s.y); }
        ctx.stroke();
        ctx.setLineDash([]);
        for (const w of points.slice(0, -1)) {
            const s = toScreen(w.x, w.y);
            ctx.fillStyle = 'rgba(90,169,255,0.85)';
            ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill();
        }
        const last = points[points.length - 1]!;
        const s = toScreen(last.x, last.y);
        ctx.strokeStyle = '#5aa9ff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(s.x - 6, s.y - 6); ctx.lineTo(s.x + 6, s.y + 6);
        ctx.moveTo(s.x + 6, s.y - 6); ctx.lineTo(s.x - 6, s.y + 6);
        ctx.stroke();
    }
    const gt = state?.groundTarget;
    if (gt && Number.isFinite(gt.x)) {
        const s = toScreen(gt.x, gt.y);
        ctx.strokeStyle = '#d96cff';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI * 2); ctx.stroke();
    }
}

function drawSelf(p: PlayerState) {
    const s = toScreen(p.x, p.y);
    const interact = 192 * cam.scale;
    if (interact > 8) {
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(s.x, s.y, interact, 0, Math.PI * 2); ctx.stroke();
    }
    const v = headingVec(p.heading);
    const n = { x: -v.y, y: v.x };
    const len = 13;
    ctx.beginPath();
    ctx.moveTo(s.x + v.x * len, s.y + v.y * len);
    ctx.lineTo(s.x - v.x * 7 + n.x * 7, s.y - v.y * 7 + n.y * 7);
    ctx.lineTo(s.x - v.x * 3, s.y - v.y * 3);
    ctx.lineTo(s.x - v.x * 7 - n.x * 7, s.y - v.y * 7 - n.y * 7);
    ctx.closePath();
    ctx.fillStyle = p.isDead ? '#666' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = p.inCombat ? '#ff4a4a' : '#5aa9ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    const target = findEntity(p.targetObjectId);
    if (target) {
        const t = toScreen(target.x, target.y);
        ctx.strokeStyle = 'rgba(255,225,74,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    }
    label(p.name || BOT, s.x, s.y - 18, '#ffffff', true);
}

function draw() {
    dirty = false;
    hits = [];
    pendingLabels.length = 0;
    ctx.fillStyle = '#0f1216';
    ctx.fillRect(0, 0, width, height);
    const step = drawGrid();
    drawZones();
    const p = player();
    const list = entities().sort((a, b) => kindOrder(a) - kindOrder(b));
    for (const e of list) drawEntity(e, p);
    if (p) {
        drawMovement(p);
        drawSelf(p);
    }
    flushLabels();
    drawHud(step);
}

function kindOrder(e: Entity) {
    return e.kind === 'object' ? 0 : e.kind === 'npc' ? 1 : 2;
}

function drawHud(step: number) {
    const parts: string[] = [];
    if (mouse) {
        const w = toWorld(mouse.x, mouse.y);
        parts.push(`cursor ${Math.round(w.x)}, ${Math.round(w.y)}`);
        const p = player();
        if (p) parts.push(`${Math.round(Math.hypot(w.x - p.x, w.y - p.y))} u`);
    }
    parts.push(`grid ${step} u`);
    parts.push(`${arr(state?.nearbyNpcs).length} npc · ${arr(state?.nearbyPlayers).length} pl · ${arr(state?.nearbyObjects).length} obj`);
    $('hud').textContent = parts.join(' · ');
}

function frame() {
    if (dirty) draw();
    requestAnimationFrame(frame);
}

function hitTest(sx: number, sy: number): Entity | null {
    let best: Hit | null = null;
    let bestD = Infinity;
    for (const h of hits) {
        const d = Math.hypot(h.sx - sx, h.sy - sy);
        if (d <= Math.max(9, h.r + 4) && d < bestD) { best = h; bestD = d; }
    }
    return best?.entity ?? null;
}

function showTooltip(e: Entity | null, sx: number, sy: number) {
    if (!e) { tooltip.style.display = 'none'; return; }
    const p = player();
    const dist = distanceTo(e);
    const rows: string[] = [`<div class="tname">${esc(e.name || '(unnamed)')}</div>`];
    if (e.kind === 'npc') {
        const npc = e as NearbyNpc;
        const con = p ? conColor(p.level, num(npc.level)) : null;
        rows.push(`<div>NPC · level ${esc(npc.level)}${con ? ` · <span style="color:${CON_HEX[con]}">${con}</span>` : ''}</div>`);
        if (npc.guildName) rows.push(`<div class="muted">&lt;${esc(npc.guildName)}&gt;${npc.role ? ` · ${esc(npc.role)}` : ''}</div>`);
        else if (npc.role) rows.push(`<div class="muted">${esc(npc.role)}</div>`);
        rows.push(`<div>HP ${esc(num(npc.healthPercent, 100))}%${npc.inCombat ? ' · <span class="bad">in combat</span>' : ''}${npc.isPeaceful ? ' · peaceful' : ''}${npc.hasQuest ? ' · quest' : ''}${npc.isPet ? ' · pet' : ''}</div>`);
        if (npc.targetObjectId) rows.push(`<div class="muted">targeting ${esc(entityName(npc.targetObjectId))}</div>`);
    } else if (e.kind === 'player') {
        const pl = e as NearbyPlayer;
        rows.push(`<div>Player · level ${esc(pl.level)} · ${esc(pl.realm)}</div>`);
        if (pl.guildName) rows.push(`<div class="muted">&lt;${esc(pl.guildName)}&gt;</div>`);
        rows.push(`<div>HP ${esc(num(pl.healthPercent, 100))}%${pl.isDead ? ' · dead' : ''}${pl.isSitting ? ' · sitting' : ''}</div>`);
    } else {
        const o = e as NearbyObject;
        rows.push(`<div>${o.isLoot ? `Loot${o.ownedByUs ? ' (ours)' : ''}` : o.doorId !== null && o.doorId !== undefined ? `Door ${esc(o.doorId)}` : 'Object'} · model ${esc(o.model)}</div>`);
    }
    rows.push(`<div class="muted">${dist !== null ? `${Math.round(dist)} units · ` : ''}#${esc(e.objectId)} · ${Math.round(e.x)}, ${Math.round(e.y)}, ${Math.round(num(e.z))}</div>`);
    tooltip.innerHTML = rows.join('');
    tooltip.style.display = 'block';
    const wrap = $('mapwrap').getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    tooltip.style.left = `${clamp(sx + 14, 4, wrap.width - tw - 4)}px`;
    tooltip.style.top = `${clamp(sy + 14, 4, wrap.height - th - 4)}px`;
}

let drag: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;

canvas.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    drag = { x: ev.offsetX, y: ev.offsetY, camX: cam.x, camY: cam.y, moved: false };
});
canvas.addEventListener('pointermove', ev => {
    mouse = { x: ev.offsetX, y: ev.offsetY };
    if (drag) {
        const dx = ev.offsetX - drag.x;
        const dy = ev.offsetY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
            drag.moved = true;
            setFollow(false);
            canvas.classList.add('panning');
        }
        if (drag.moved) {
            cam.x = drag.camX - dx / cam.scale;
            cam.y = drag.camY - dy / cam.scale;
            tooltip.style.display = 'none';
            dirty = true;
            return;
        }
    }
    const e = hitTest(ev.offsetX, ev.offsetY);
    const id = e?.objectId ?? null;
    if (id !== hoverId) { hoverId = id; dirty = true; }
    showTooltip(e, ev.offsetX, ev.offsetY);
    dirty = true;
});
canvas.addEventListener('pointerup', ev => {
    const d = drag;
    drag = null;
    canvas.classList.remove('panning');
    if (!d || d.moved) return;
    onMapClick(ev.offsetX, ev.offsetY);
});
canvas.addEventListener('pointerleave', () => {
    mouse = null;
    hoverId = null;
    tooltip.style.display = 'none';
    dirty = true;
});
canvas.addEventListener('dblclick', ev => {
    const e = hitTest(ev.offsetX, ev.offsetY);
    if (e && ctlReady && (e.kind === 'npc' || e.kind === 'object')) {
        act(e.kind === 'object' && (e as NearbyObject).isLoot ? { type: 'pickup', objectId: e.objectId } : { type: 'interact', objectId: e.objectId });
    }
});
canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    setScale(cam.scale * Math.pow(1.0015, -ev.deltaY), { x: ev.offsetX, y: ev.offsetY });
}, { passive: false });

function onMapClick(sx: number, sy: number) {
    const e = hitTest(sx, sy);
    if (e) {
        selectedId = e.objectId;
        if (ctlReady) act({ type: 'setTarget', objectId: e.objectId });
        dirty = true;
        schedulePanel();
        return;
    }
    if (ctlReady) {
        const w = toWorld(sx, sy);
        act({ type: 'moveTo', x: Math.round(w.x), y: Math.round(w.y) });
    } else if (selectedId !== null) {
        selectedId = null;
        dirty = true;
        schedulePanel();
    }
}

$('zoomin').addEventListener('click', () => setScale(cam.scale * 1.5));
$('zoomout').addEventListener('click', () => setScale(cam.scale / 1.5));
$('center').addEventListener('click', () => setFollow(true));
followBox.addEventListener('change', () => setFollow(followBox.checked));
labelsBox.addEventListener('change', () => { dirty = true; });
window.addEventListener('keydown', ev => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.key === '+' || ev.key === '=') setScale(cam.scale * 1.5);
    else if (ev.key === '-') setScale(cam.scale / 1.5);
    else if (ev.key === 'c' || ev.key === 'f') setFollow(true);
    else if (ev.key === 'Escape') { selectedId = null; dirty = true; schedulePanel(); }
});

$('legend').innerHTML = [
    ...(['grey', 'green', 'blue', 'yellow', 'orange', 'red', 'purple'] as const).map(c => `<span><i class="swatch" style="background:${CON_HEX[c]}"></i>${c}</span>`),
    '<span><i class="swatch" style="border:2px solid #aaa;background:none"></i>peaceful</span>',
    '<span><i class="swatch" style="background:#ff5a5a;border-radius:0;transform:rotate(45deg)"></i>player</span>',
    '<span><i class="swatch" style="background:#ffd84a;border-radius:0"></i>loot</span>',
    '<span><i class="swatch" style="background:#d96cff;border-radius:0;transform:rotate(45deg)"></i>zone exit</span>',
].join('');

// ── Side panel ──────────────────────────────────────────────────────────────

let panelTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePanel() {
    if (panelTimer) return;
    panelTimer = setTimeout(() => { panelTimer = null; renderPanel(); }, 150);
}

const sectionCache = new Map<string, string>();
function setSection(id: string, html: string) {
    if (sectionCache.get(id) === html) return;
    sectionCache.set(id, html);
    const el = $(id);
    const scrolls = new Map<string, { top: number; atBottom: boolean }>();
    el.querySelectorAll<HTMLElement>('[data-scroll]').forEach(s => {
        scrolls.set(s.dataset.scroll!, { top: s.scrollTop, atBottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 4 });
    });
    el.innerHTML = html;
    el.querySelectorAll<HTMLElement>('[data-scroll]').forEach(s => {
        const prev = scrolls.get(s.dataset.scroll!);
        if (s.dataset.stick !== undefined && (!prev || prev.atBottom)) s.scrollTop = s.scrollHeight;
        else if (prev) s.scrollTop = prev.top;
    });
}

function bar(labelText: string, value: number, max: number, color: string, right?: string) {
    const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
    return `<div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>`
        + `<div class="label"><span>${esc(labelText)}</span><span>${esc(right ?? `${Math.round(value)} / ${Math.round(max)}`)}</span></div></div>`;
}

function formatMoney(m: any): string {
    if (!m || typeof m !== 'object') return '-';
    const parts: string[] = [];
    if (num(m.platinum)) parts.push(`${m.platinum}p`);
    if (num(m.mithril)) parts.push(`${m.mithril}m`);
    if (num(m.gold)) parts.push(`${m.gold}g`);
    if (num(m.silver)) parts.push(`${m.silver}s`);
    parts.push(`${num(m.copper)}c`);
    return parts.join(' ');
}

function formatPrice(copper: number): string {
    const c = Math.max(0, Math.round(num(copper)));
    const gold = Math.floor(c / 10000);
    const silver = Math.floor((c % 10000) / 100);
    const rest = c % 100;
    return [gold ? `${gold}g` : '', silver ? `${silver}s` : '', rest || (!gold && !silver) ? `${rest}c` : ''].filter(Boolean).join(' ');
}

const time = (ms: unknown) => {
    const t = num(ms);
    if (!t) return '';
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};
const ago = (ms: unknown) => {
    const t = num(ms);
    return t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} s ago` : '';
};
const disabledUnlessControl = () => (ctlReady ? '' : ' disabled title="enable control mode"');

function renderPanel() {
    const s = state;
    const p = player();
    const banner = $('banner');
    if (!s) {
        banner.innerHTML = `Waiting for <b>${esc(BOT)}</b>…<div class="muted">No state yet. Is a client attached? (<span class="mono">bun client/runner.ts ${esc(BOT)}</span>)</div>`;
        banner.style.display = 'block';
    } else if (!s.inGame || !p) {
        const c = s.connection;
        banner.innerHTML = `Not in game · phase <b>${esc(c?.phase ?? '?')}</b>${c?.lastError ? `<div class="bad">${esc(c.lastError)}</div>` : ''}`;
        banner.style.display = 'block';
    } else {
        banner.style.display = 'none';
    }

    // Who
    if (p) {
        const regionName = regionData?.regionId === p.regionId && regionData.region ? regionData.region.description || regionData.region.name : '';
        setSection('s-who', `
            <div class="big">${esc(p.name)}${p.lastName ? ` <span class="muted">${esc(p.lastName)}</span>` : ''}</div>
            <div>Level ${esc(p.level)} ${esc(p.className)} · ${esc(p.raceName)} · <span style="color:${REALM_HEX[p.realm] ?? '#ccc'}">${esc(p.realm)}</span></div>
            ${p.guildName ? `<div class="muted">&lt;${esc(p.guildName)}&gt;</div>` : ''}
            <div class="kv" style="margin-top:6px">
                <span class="k">Zone</span><span>${esc(p.zoneName || '?')} <span class="muted">(${esc(p.zoneId)})</span></span>
                <span class="k">Region</span><span>${esc(regionName || '?')} <span class="muted">(${esc(p.regionId)})</span></span>
                <span class="k">Position</span><span class="mono">${Math.round(num(p.x))}, ${Math.round(num(p.y))}, ${Math.round(num(p.z))} · h ${esc(p.heading)}</span>
                <span class="k">Speed</span><span>${Math.round(num(p.speed))} / ${Math.round(num(p.maxSpeed))} (${esc(p.maxSpeedPercent)}%)</span>
                <span class="k">Money</span><span>${esc(formatMoney(p.money))}</span>
                <span class="k">Client</span><span>${esc(s?.connection?.phase ?? '?')} · tick ${esc(s?.tick)}</span>
            </div>`);
        const m = s?.movement;
        const flags = [
            p.isDead ? '<span class="pill dead">dead</span>' : '',
            p.inCombat ? '<span class="pill dead">in combat</span>' : '',
            p.attacking ? '<span class="pill stale">attacking</span>' : '',
            p.isSitting ? '<span class="pill">sitting</span>' : '',
            m?.moving ? '<span class="pill active">moving</span>' : '',
            m?.lastStopReason && !m.moving ? `<span class="pill">last stop: ${esc(m.lastStopReason)}</span>` : '',
            num(m?.correctionCount) ? `<span class="pill stale">${esc(m?.correctionCount)} corrections</span>` : '',
            num(p.deathCount) ? `<span class="pill">${esc(p.deathCount)} deaths</span>` : '',
        ].join('');
        const xpRight = `${(num(p.levelPermill) / 10).toFixed(1)}%${p.experienceForNextLevel ? ` · ${num(p.experience)} / ${num(p.experienceForNextLevel)}` : ''}`;
        setSection('s-bars', `
            ${bar('Health', num(p.health), num(p.maxHealth), 'var(--hp)')}
            ${num(p.maxMana) > 0 ? bar('Power', num(p.mana), num(p.maxMana), 'var(--mana)') : ''}
            ${bar('Endurance', num(p.endurance), num(p.maxEndurance), 'var(--endu)')}
            ${num(p.maxConcentration) > 0 ? bar('Concentration', num(p.concentration), num(p.maxConcentration), 'var(--conc)') : ''}
            ${bar(`XP · level ${num(p.level)}`, num(p.levelPermill), 1000, 'var(--xp)', xpRight)}
            <div class="muted" style="font-size:11px">RP ${num(p.realmPoints)} · BP ${num(p.bountyPoints)} · spec pts ${num(p.specPoints)}</div>
            ${flags ? `<div class="flags">${flags}</div>` : ''}`);
    } else {
        setSection('s-who', `<div class="big">${esc(BOT)}</div><div class="muted">${s ? `phase ${esc(s.connection?.phase ?? '?')}` : 'no state'}</div>`);
        setSection('s-bars', '');
    }

    // Target / selection
    const target = p ? findEntity(p.targetObjectId) : null;
    const selected = selectedId !== null && selectedId !== p?.targetObjectId ? findEntity(selectedId) : null;
    const describe = (e: Entity, heading: string) => {
        const lvl = num(e.level, NaN);
        const con = p && e.kind === 'npc' && Number.isFinite(lvl) ? conColor(p.level, lvl) : null;
        const dist = distanceTo(e);
        const hp = e.kind === 'object' ? null : num(e.healthPercent, 100);
        return `<h3>${heading}<span>#${esc(e.objectId)}</span></h3>
            <div><b style="color:${con ? CON_HEX[con] : '#fff'}">${esc(e.name)}</b> ${Number.isFinite(lvl) ? `· L${lvl}` : ''} ${con ? `· ${con}` : ''} · ${esc(e.kind)}${e.guildName ? ` <span class="muted">&lt;${esc(e.guildName)}&gt;</span>` : ''}</div>
            ${hp !== null ? bar('HP', hp, 100, 'var(--hp)', `${hp}%`) : ''}
            <div class="muted">${dist !== null ? `${Math.round(dist)} units` : ''}${e.inCombat ? ' · in combat' : ''}${e.targetObjectId ? ` · targeting ${esc(entityName(e.targetObjectId))}` : ''}</div>`;
    };
    let targetHtml = '';
    if (target) targetHtml += describe(target, 'Target');
    else if (p?.targetObjectId) targetHtml += `<h3>Target</h3><div class="muted">#${esc(p.targetObjectId)} (not in view)</div>`;
    if (selected) targetHtml += `<div style="margin-top:${target ? 8 : 0}px">${describe(selected, 'Selected')}</div>`;
    setSection('s-target', targetHtml);

    // Dialog box
    const dialog = s?.dialog;
    setSection('s-dialog', dialog && dialog.isOpen ? `
        <h3>Dialog <span>${esc(ago(dialog.receivedAt))}</span></h3>
        <div class="dialog-text">${esc(dialog.text)}</div>
        <div class="control-row">
            <button data-act="dialog-yes"${disabledUnlessControl()}>${dialog.type === 1 ? 'Accept' : 'OK'}</button>
            ${dialog.type === 1 ? `<button data-act="dialog-no"${disabledUnlessControl()}>Decline</button>` : ''}
        </div>` : '');

    // NPC dialog
    const nd = s?.npcDialog;
    setSection('s-npcdialog', nd && (nd.text || arr(nd.keywords).length) ? `
        <h3>${esc(nd.npcName ?? 'NPC')} says <span>${esc(ago(nd.receivedAt))}</span></h3>
        <div class="dialog-text" data-scroll="npcdialog">${esc(nd.text)}</div>
        ${arr(nd.keywords).length ? `<div class="keywords">${arr(nd.keywords).map(k => `<button data-act="keyword" data-keyword="${esc(k)}"${disabledUnlessControl()}>${esc(k)}</button>`).join('')}</div>` : ''}` : '');

    // Text window
    const tw = s?.textWindow;
    setSection('s-textwindow', tw && arr(tw.lines).length ? `
        <h3>${esc(tw.caption || 'Text window')} <span>${esc(ago(tw.receivedAt))}</span></h3>
        <div class="dialog-text" data-scroll="textwindow">${arr(tw.lines).map(esc).join('\n')}</div>` : '');

    // Merchant
    const merchant = s?.merchant;
    setSection('s-merchant', merchant && merchant.isOpen ? `
        <h3>Merchant · ${esc(entityName(merchant.merchantObjectId))} <span>${arr(merchant.items).length} items</span></h3>
        <ul class="list scroll" data-scroll="merchant">${arr(merchant.items).map(it => `
            <li><span>${esc(it.name)} <span class="muted">L${esc(it.level)}${it.usable === false ? ' · unusable' : ''}</span></span>
            <span class="r">${esc(formatPrice(it.price))} <button data-act="buy" data-page="${esc(it.page)}" data-slot="${esc(it.slot)}"${disabledUnlessControl()}>buy</button></span></li>`).join('')}
        </ul>
        <div class="control-row"><button data-act="close-merchant"${disabledUnlessControl()}>Close</button></div>` : '');

    // Effects
    const effects = arr(s?.effects);
    const conc = arr(s?.concentrationEffects);
    setSection('s-effects', effects.length || conc.length ? `
        <h3>Effects <span>${effects.length}</span></h3>
        <ul class="list">${effects.map(e => `<li><span class="${e.isNegative ? 'bad' : ''}">${esc(e.name || (e.spellId ? `spell ${e.spellId}` : 'effect'))}</span><span class="r">${num(e.remainingSeconds) > 0 ? `${Math.round(num(e.remainingSeconds))} s` : ''}</span></li>`).join('')}</ul>
        ${conc.length ? `<div class="muted" style="margin-top:4px">Concentration</div><ul class="list">${conc.map(c => `<li><span>${esc(c.name)}</span><span class="r">${esc(c.ownerName)} · ${esc(c.concentration)}</span></li>`).join('')}</ul>` : ''}` : '');

    // Group
    const group = arr(s?.group);
    setSection('s-group', group.length ? `
        <h3>Group <span>${group.length}</span></h3>
        ${group.map(g => `<div><b>${esc(g.name)}</b> <span class="muted">L${esc(g.level)} ${esc(g.className)}${g.isDead ? ' · dead' : ''}${g.inOtherRegion ? ' · away' : ''}</span>
            ${bar('HP', num(g.healthPercent), 100, 'var(--hp)', `${num(g.healthPercent)}%`)}</div>`).join('')}` : '');

    // Inventory
    const inv = arr(s?.inventory) as InventoryItem[];
    const eq = arr(s?.equipment) as InventoryItem[];
    const item = (i: InventoryItem) => `<li><span><span class="muted mono">${esc(i.slot)}</span> ${esc(i.name)}${num(i.count) > 1 ? ` <b>×${esc(i.count)}</b>` : ''}</span><span class="r">${num(i.level) ? `L${esc(i.level)}` : ''}${i.condition !== undefined && num(i.condition, 100) < 100 ? ` · ${esc(i.condition)}%` : ''}</span></li>`;
    setSection('s-inventory', s ? `
        <h3>Inventory <span>${inv.length} / 40 slots</span></h3>
        <ul class="list scroll" data-scroll="inventory">${inv.length ? [...inv].sort((a, b) => a.slot - b.slot).map(item).join('') : '<li class="muted">empty</li>'}</ul>
        ${eq.length ? `<div class="muted" style="margin-top:6px">Equipped</div><ul class="list">${[...eq].sort((a, b) => a.slot - b.slot).map(item).join('')}</ul>` : ''}` : '');

    // Chat / combat log
    const messages = arr(s?.gameMessages) as GameMessage[];
    const combat = arr(s?.combatEvents) as CombatEvent[];
    const combatText = (c: CombatEvent) => {
        const who = entityName(c.attackerObjectId);
        const tgt = entityName(c.targetObjectId);
        if (c.kind === 'melee') return `${who} → ${tgt}: ${c.result ?? 'hit'}${c.targetHealthPercent !== undefined ? ` (${c.targetHealthPercent}%)` : ''}`;
        if (c.kind === 'spellCast') return `${who} casts${c.castTimeMs ? ` (${(c.castTimeMs / 1000).toFixed(1)} s)` : ''}`;
        if (c.kind === 'spellEffect') return `${who} spell → ${tgt}`;
        if (c.kind === 'interrupt') return `${who} interrupted`;
        if (c.kind === 'death') return `${tgt} died${c.attackerObjectId ? ` (killed by ${who})` : ''}`;
        return String(c.kind);
    };
    setSection('s-log', s ? `
        <h3>Messages <span>${messages.length}</span></h3>
        <div class="log" data-scroll="chat" data-stick>${messages.slice(-100).map(m => `<div class="chat-${esc(m.type)}"><span class="t">${time(m.receivedAt)}</span>${esc(m.text)}</div>`).join('') || '<div class="muted">no messages</div>'}</div>
        ${combat.length ? `<h3 style="margin-top:8px">Combat <span>${combat.length}</span></h3>
        <div class="log" data-scroll="combat" data-stick style="max-height:160px">${combat.slice(-50).map(c => `<div><span class="t">${time(c.receivedAt)}</span>${esc(combatText(c))}</div>`).join('')}</div>` : ''}` : '');
}

$('side').addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const kind = btn.dataset.act;
    if (kind === 'dialog-yes') act({ type: 'respondDialog', accept: true });
    else if (kind === 'dialog-no') act({ type: 'respondDialog', accept: false });
    else if (kind === 'keyword') {
        const npcId = state?.npcDialog?.npcObjectId ?? player()?.targetObjectId;
        if (npcId === null || npcId === undefined) toast('No NPC to whisper to');
        else act({ type: 'whisper', objectId: npcId, text: btn.dataset.keyword ?? '' });
    } else if (kind === 'buy') act({ type: 'buy', page: Number(btn.dataset.page), slot: Number(btn.dataset.slot), count: 1 });
    else if (kind === 'close-merchant') act({ type: 'closeMerchant' });
});

const sayInput = $<HTMLInputElement>('say');
function sendSay() {
    const text = sayInput.value.trim();
    if (!text) return;
    act({ type: 'say', text }).then(r => { if (r.success) sayInput.value = ''; });
}
$('saybtn').addEventListener('click', sendSay);
sayInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') sendSay(); });
$('stopbtn').addEventListener('click', () => act({ type: 'stop' }));
$('sitbtn').addEventListener('click', () => act({ type: 'sit', sit: !player()?.isSitting }));
$('attackbtn').addEventListener('click', () => act({ type: 'attack', on: !player()?.attacking }));
$('cleartarget').addEventListener('click', () => act({ type: 'setTarget', objectId: null }));

// ── Boot ────────────────────────────────────────────────────────────────────

setInterval(() => {
    const el = $('age');
    if (!stateReceivedAt) { el.textContent = ''; return; }
    const age = (Date.now() - stateReceivedAt) / 1000;
    el.textContent = `state ${age.toFixed(1)} s ago`;
    el.className = `mono ${age > 8 ? 'bad' : age > 3 ? 'warn' : 'muted'}`;
}, 250);
setInterval(pollFallback, 1500);
setInterval(schedulePanel, 1000);

resize();
connectObserve();
pollFallback();
renderPanel();
requestAnimationFrame(frame);
