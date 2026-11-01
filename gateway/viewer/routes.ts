// Browser viewer routes, mounted by gateway.ts.
//
//   GET  /viewer                 bot and group index (HTML)
//   GET  /viewer/<bot>           single-page viewer for one bot (HTML)
//   GET  /viewer/group/<id>      group page: every member on one map, the run's orders (HTML)
//   GET  /viewer/region/<id>     region page: every bot in one region, each group's run, the keeps (HTML)
//   GET  /viewer/assets/<file>   app.js, group.js and region.js (app.ts, group.ts, region.ts bundled with Bun.build on request), viewer.css
//   GET  /bots                   JSON list of the gateway's bot sessions, each with its group
//   GET  /zones/<regionId>       JSON zone rects, zone points and bind points for a region
//   GET  /regions                JSON list of regions with an in-game bot (gateway/regions.ts)
//   GET  /regions/<id>/live      RegionFrame: the region's bots, runs, enemy players and keeps (per-bot auth)
//   POST /bots/<bot>/auth        {"password"} → checks it before the page enables control mode
//
// The bot page talks to the gateway WebSocket as an observe-mode SDK and, only
// when control is ticked, opens a second control-mode socket. The group page
// opens no socket: it polls /groups/<id>/live (gateway/groups.ts). Nor does the
// region page: it polls /regions/<id>/live and offers no actions at all.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BotWorldState, GatewayAuthHook } from '../types';
import type { GroupBadge } from '../group-types';
import type { ActiveRun } from '../groups';
import { listRegions, regionFrame, regionLayout } from '../regions';
import { checkControlPassword, isJsonRequest } from '../security';

const DIR = import.meta.dir;

export interface ViewerBotSession {
    ws: unknown;
    clientId: string;
    lastState: BotWorldState | null;
    lastStateReceivedAt: number;
}

export interface ViewerSdkSession {
    targetUsername: string;
    mode: 'control' | 'observe';
}

export interface ViewerContext {
    botSessions: ReadonlyMap<string, ViewerBotSession>;
    sdkSessions: ReadonlyMap<string, ViewerSdkSession>;
    sessionStatus(session: any): string;
    auth?: GatewayAuthHook;
    /** Where bots/<name>/bot.env live; default the repo root. */
    repoRoot?: string;
    /** The group a username plays in (gateway/groups.ts badge). */
    groupOf?(username: string): GroupBadge | null;
    /** Every group's current run (gateway/groups.ts activeRuns), for the region page. */
    activeRuns?(): readonly ActiveRun[];
}

export interface BotListEntry {
    username: string;
    status: string;
    inGame: boolean;
    clientId: string;
    tick: number;
    stateAge: number | null;
    phase: string | null;
    player: { name: string; level: number; className: string; realm: string; regionId: number; zoneName: string } | null;
    controllers: number;
    observers: number;
    group: GroupBadge | null;
}

// Same-origin page: the gateway adds CORS headers for loopback origins itself (security.ts).
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export function listBots(ctx: ViewerContext): BotListEntry[] {
    const sdks = [...ctx.sdkSessions.values()];
    const out: BotListEntry[] = [];
    for (const [username, session] of ctx.botSessions) {
        const connected = session.ws !== null && session.ws !== undefined;
        const state = session.lastState;
        const p = connected ? state?.player : null;
        out.push({
            username,
            status: ctx.sessionStatus(session),
            inGame: connected ? (state?.inGame ?? false) : false,
            clientId: session.clientId,
            tick: state?.tick ?? 0,
            stateAge: session.lastStateReceivedAt ? Date.now() - session.lastStateReceivedAt : null,
            phase: state?.connection?.phase ?? null,
            player: p ? {
                name: p.name, level: p.level, className: p.className, realm: p.realm,
                regionId: p.regionId, zoneName: p.zoneName,
            } : null,
            controllers: sdks.filter(s => s.targetUsername === username && s.mode === 'control').length,
            observers: sdks.filter(s => s.targetUsername === username && s.mode === 'observe').length,
            group: ctx.groupOf?.(username) ?? null,
        });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
}

export async function regionData(regionId: number) {
    const data = await import('../../data/index');
    const region = data.getRegion(regionId) ?? null;
    const zones = data.getZonesInRegion(regionId).map(z => ({
        id: z.id, name: z.name, xOffset: z.xOffset, yOffset: z.yOffset, width: z.width, height: z.height,
    }));
    let zonePoints: { id: number; x: number; y: number; targetRegion: number }[] = [];
    let bindpoints: { x: number; y: number; radius: number }[] = [];
    try {
        zonePoints = data.getZonePointsFrom(regionId).map(zp => ({ id: zp.id, x: zp.sourceX, y: zp.sourceY, targetRegion: zp.targetRegion }));
        bindpoints = data.getBindpoints().filter(b => b.regionId === regionId).map(b => ({ x: b.x, y: b.y, radius: b.radius }));
    } catch {}
    return { regionId, region: region ? { id: region.id, name: region.name, description: region.description } : null, zones, zonePoints, bindpoints };
}

/** Built bundles by source folder and entry, keyed by every module's size and mtime. */
const bundles = new Map<string, { key: string; text: string }>();

/** The browser-side modules of a folder (app.ts imports con-level.ts, logic.ts, ...) as "name:size:mtime" lines. */
export function sourceKey(dir: string): string {
    let files: string[] = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'routes.ts').sort(); } catch {}
    return files.map(file => {
        try {
            const st = statSync(join(dir, file));
            return `${file}:${st.size}:${st.mtimeMs}`;
        } catch {
            return `${file}:missing`;
        }
    }).join('\n');
}

/**
 * A page's entry module bundled for the browser, rebuilt when any module in
 * `dir` changes. Any change to the key counts, so one future-dated file cannot
 * hide edits to the others. `dir` is for tests, which build a copy.
 */
export async function buildBundle(entry: 'app.ts' | 'group.ts' | 'region.ts', dir: string = DIR): Promise<string> {
    const key = sourceKey(dir);
    const cacheKey = `${dir}|${entry}`;
    const cached = bundles.get(cacheKey);
    if (cached && cached.key === key) return cached.text;
    const result = await Bun.build({ entrypoints: [join(dir, entry)], target: 'browser', format: 'esm', minify: false });
    if (!result.success || !result.outputs[0]) {
        throw new Error(`viewer bundle failed: ${result.logs.map(l => String(l)).join('\n')}`);
    }
    const text = await result.outputs[0].text();
    bundles.set(cacheKey, { key, text });
    return text;
}

/** The bot page's app.ts bundle. */
export function buildAppBundle(dir: string = DIR): Promise<string> {
    return buildBundle('app.ts', dir);
}

/** An HTML page from this folder with each {{KEY}} replaced by its escaped value. */
function htmlPage(file: string, vars: Record<string, string> = {}): Response {
    let html: string;
    try { html = readFileSync(join(DIR, file), 'utf8'); } catch { return new Response('Not found', { status: 404 }); }
    for (const [key, value] of Object.entries(vars)) html = html.replaceAll(`{{${key}}}`, escapeHtml(value));
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function bundleResponse(build: Promise<string>): Promise<Response> {
    return build.then(
        text => new Response(text, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } }),
        error => new Response(`console.error(${JSON.stringify(String(error))});`, { status: 500, headers: { 'Content-Type': 'text/javascript' } }),
    );
}

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** The Authorization bearer password; the region frame never reads one from the query string. */
function bearer(req: Request): string {
    const header = req.headers.get('authorization') ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** GET /regions/<id>/live: the auth hook decides per bot and per run leader (gateway/regions.ts). */
async function regionLive(req: Request, regionId: number, ctx: ViewerContext): Promise<Response> {
    const bg = await regionLayout(regionId);
    let runs: readonly ActiveRun[] = [];
    try { runs = ctx.activeRuns?.() ?? []; } catch {}
    const frame = await regionFrame(regionId, {
        sessions: ctx.botSessions, sessionStatus: ctx.sessionStatus, groupOf: ctx.groupOf, runs,
        layout: bg?.layout ?? null, keepClearance: bg?.keepClearance,
    }, ctx.auth, bearer(req));
    return json(frame);
}

/** Handles viewer routes; returns null for anything else so the gateway carries on. */
export async function handleViewerRequest(req: Request, url: URL, ctx: ViewerContext): Promise<Response | null> {
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/bots' || path === '/bots/')) return json({ bots: listBots(ctx) });

    const authMatch = path.match(/^\/bots\/([^/]+)\/auth$/);
    if (authMatch && req.method === 'POST') {
        if (!isJsonRequest(req)) return json({ ok: false, error: 'Content-Type must be application/json', botEnv: false }, 415);
        let body: any = null;
        try { body = await req.json(); } catch {}
        const roots = [process.cwd(), ctx.repoRoot ?? join(DIR, '..', '..')];
        const result = await checkControlPassword(decode(authMatch[1]!), typeof body?.password === 'string' ? body.password : '', roots, ctx.auth);
        return json(result, result.ok ? 200 : 401);
    }

    if (req.method === 'GET' && (path === '/regions' || path === '/regions/')) return json({ regions: listRegions({ sessions: ctx.botSessions, groupOf: ctx.groupOf }) });
    const regionLiveMatch = path.match(/^\/regions\/(\d{1,9})\/live\/?$/);
    if (regionLiveMatch && req.method === 'GET') {
        try {
            return await regionLive(req, parseInt(regionLiveMatch[1]!, 10), ctx);
        } catch (error) {
            return json({ error: `region view unavailable: ${error instanceof Error ? error.message : error}` }, 500);
        }
    }

    const zoneMatch = path.match(/^\/zones\/(\d+)$/);
    if (zoneMatch && req.method === 'GET') {
        try {
            return json(await regionData(parseInt(zoneMatch[1]!, 10)));
        } catch (error) {
            return json({ error: `zone data unavailable: ${error instanceof Error ? error.message : error}` }, 500);
        }
    }

    if (req.method !== 'GET' || (path !== '/viewer' && !path.startsWith('/viewer/'))) return null;
    if (path === '/viewer' || path === '/viewer/') return htmlPage('index.html');

    if (path === '/viewer/assets/app.js') return bundleResponse(buildBundle('app.ts'));
    if (path === '/viewer/assets/group.js') return bundleResponse(buildBundle('group.ts'));
    if (path === '/viewer/assets/region.js') return bundleResponse(buildBundle('region.ts'));
    if (path === '/viewer/assets/viewer.css') {
        return new Response(readFileSync(join(DIR, 'viewer.css'), 'utf8'), { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // Before the bot page, which would take /viewer/group as a bot named "group"
    // (it still does: only the two-segment form is the group page; /viewer/region likewise).
    const groupMatch = path.match(/^\/viewer\/group\/([A-Za-z0-9_-]{1,64})\/?$/);
    if (groupMatch) return htmlPage('group.html', { GROUP: groupMatch[1]! });
    const regionMatch = path.match(/^\/viewer\/region\/(\d{1,9})\/?$/);
    if (regionMatch) return htmlPage('region.html', { REGION: String(parseInt(regionMatch[1]!, 10)) });
    const botMatch = path.match(/^\/viewer\/([^/]+)\/?$/);
    if (botMatch) return htmlPage('bot.html', { BOT: decode(botMatch[1]!) });
    return new Response('Not found', { status: 404 });
}
