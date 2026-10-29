// Browser viewer routes, mounted by gateway.ts.
//
//   GET  /viewer                 bot index (HTML)
//   GET  /viewer/<bot>           single-page viewer for one bot (HTML)
//   GET  /viewer/assets/<file>   app.js (app.ts bundled with Bun.build on request), viewer.css
//   GET  /bots                   JSON list of the gateway's bot sessions
//   GET  /zones/<regionId>       JSON zone rects, zone points and bind points for a region
//   POST /bots/<bot>/auth        {"password"} → checks it before the page enables control mode
//
// The page itself talks to the gateway WebSocket as an observe-mode SDK and,
// only when control is ticked, opens a second control-mode socket.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BotWorldState, GatewayAuthHook } from '../types';
import { findBotPassword, isJsonRequest } from '../security';

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

/** Built bundles by source folder, keyed by every module's size and mtime. */
const bundles = new Map<string, { key: string; text: string }>();

/** The browser-side modules of a folder (app.ts imports con.ts, logic.ts, ...) as "name:size:mtime" lines. */
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
 * app.ts bundled for the browser, rebuilt when any module in `dir` changes.
 * Any change to the key counts, so one future-dated file cannot hide edits to
 * the others. `dir` is for tests, which build a copy.
 */
export async function buildAppBundle(dir: string = DIR): Promise<string> {
    const key = sourceKey(dir);
    const cached = bundles.get(dir);
    if (cached && cached.key === key) return cached.text;
    const result = await Bun.build({ entrypoints: [join(dir, 'app.ts')], target: 'browser', format: 'esm', minify: false });
    if (!result.success || !result.outputs[0]) {
        throw new Error(`viewer bundle failed: ${result.logs.map(l => String(l)).join('\n')}`);
    }
    const text = await result.outputs[0].text();
    bundles.set(dir, { key, text });
    return text;
}

function htmlPage(file: string, bot?: string): Response {
    let html = readFileSync(join(DIR, file), 'utf8');
    if (bot !== undefined) html = html.replaceAll('{{BOT}}', escapeHtml(bot));
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function checkPassword(ctx: ViewerContext, bot: string, password: string): Promise<{ ok: boolean; error?: string; botEnv: boolean }> {
    if (!password) return { ok: false, error: 'Password required', botEnv: false };
    const expected = findBotPassword(bot, [process.cwd(), ctx.repoRoot ?? join(DIR, '..', '..')]);
    if (expected !== null && expected !== password) return { ok: false, error: 'Password does not match bots/' + bot + '/bot.env', botEnv: true };
    if (ctx.auth) {
        const result = await ctx.auth({ kind: 'sdk', username: bot, password });
        if (!result.success) return { ok: false, error: result.error ?? 'Authentication failed', botEnv: expected !== null };
    }
    return { ok: true, botEnv: expected !== null };
}

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Handles viewer routes; returns null for anything else so the gateway carries on. */
export async function handleViewerRequest(req: Request, url: URL, ctx: ViewerContext): Promise<Response | null> {
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/bots' || path === '/bots/')) return json({ bots: listBots(ctx) });

    const authMatch = path.match(/^\/bots\/([^/]+)\/auth$/);
    if (authMatch && req.method === 'POST') {
        if (!isJsonRequest(req)) return json({ ok: false, error: 'Content-Type must be application/json', botEnv: false }, 415);
        let body: any = null;
        try { body = await req.json(); } catch {}
        const result = await checkPassword(ctx, decode(authMatch[1]!), typeof body?.password === 'string' ? body.password : '');
        return json(result, result.ok ? 200 : 401);
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

    if (path === '/viewer/assets/app.js') {
        try {
            return new Response(await buildAppBundle(), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
        } catch (error) {
            return new Response(`console.error(${JSON.stringify(String(error))});`, { status: 500, headers: { 'Content-Type': 'text/javascript' } });
        }
    }
    if (path === '/viewer/assets/viewer.css') {
        return new Response(readFileSync(join(DIR, 'viewer.css'), 'utf8'), { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    const botMatch = path.match(/^\/viewer\/([^/]+)\/?$/);
    if (botMatch) return htmlPage('bot.html', decode(botMatch[1]!));
    return new Response('Not found', { status: 404 });
}
