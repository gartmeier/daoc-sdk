// Request checks for the gateway: which hosts and browser origins may talk to
// it, and an auth hook that checks a bot's bots/<name>/bot.env PASSWORD.
//
// The gateway has no login of its own, so by default it listens on 127.0.0.1
// only. Two more doors stay open on loopback and are closed here:
//   - Any web page the user visits can open a WebSocket to localhost and send
//     CORS "simple" POSTs (text/plain) without a preflight. Browsers always
//     send Origin on those, so a foreign Origin is refused.
//   - DNS rebinding (evil.example resolving to 127.0.0.1) makes such a page
//     same-origin. Its Host header then names the foreign host, so on a
//     loopback bind a non-loopback Host is refused.
// Non-browser clients (the SDK, the headless client, curl) send no Origin.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { GatewayAuthHook } from './types';

/** localhost, *.localhost, 127.0.0.0/8 and ::1 (with or without brackets). */
export function isLoopbackHostname(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    return /^127(\.\d{1,3}){3}$/.test(h);
}

/** The hostname part of a Host header value ("[::1]:7780" → "[::1]", "a:1" → "a"). */
function hostHeaderName(host: string): string {
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end > 0 ? host.slice(0, end + 1) : host;
    }
    const colon = host.indexOf(':');
    return colon >= 0 ? host.slice(0, colon) : host;
}

export interface RequestPolicy {
    /** True when the gateway listens on a loopback address only: then Host must be loopback too. */
    loopbackBind: boolean;
}

/**
 * Null when the request may proceed, else why it is refused. An Origin, when
 * present, must be a loopback origin or the gateway's own (same Host).
 */
export function checkRequestSource(req: Request, policy: RequestPolicy): string | null {
    const host = req.headers.get('host') ?? '';
    if (policy.loopbackBind && host && !isLoopbackHostname(hostHeaderName(host))) {
        return `Host '${host}' is not a loopback name (set GATEWAY_HOSTNAME to listen beyond localhost)`;
    }
    const origin = req.headers.get('origin');
    if (origin === null) return null;
    if (!isAllowedOrigin(origin, host)) return `Origin '${origin}' may not use the gateway`;
    return null;
}

/** http(s) origins on a loopback host (any port), or exactly the gateway's own origin. */
export function isAllowedOrigin(origin: string, host: string): boolean {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return false; } // includes the opaque 'null' origin
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (isLoopbackHostname(parsed.hostname)) return true;
    return host !== '' && parsed.host.toLowerCase() === host.toLowerCase();
}

/** Headers that let an allowed browser origin read the reply; none for anything else. */
export function corsHeadersFor(req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    if (!origin || !isAllowedOrigin(origin, req.headers.get('host') ?? '')) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        Vary: 'Origin',
    };
}

/** A POST body must be declared JSON, so a cross-origin form/text POST always needs a preflight. */
export function isJsonRequest(req: Request): boolean {
    const type = req.headers.get('content-type') ?? '';
    return /^application\/json\b/i.test(type.trim());
}

// ── bot.env passwords ──────────────────────────────────────────────────────

const BOT_NAME = /^[A-Za-z0-9_-]+$/;

/** KEY=VALUE lines, '#' comments (also inline after whitespace); same rules as sdk parseEnvFile. */
function parseEnv(content: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        let value = trimmed.slice(eq + 1).trim();
        const hash = value.search(/\s#/);
        if (hash >= 0) value = value.slice(0, hash).trim();
        env[trimmed.slice(0, eq).trim()] = value;
    }
    return env;
}

function readEnvFile(path: string): Record<string, string> | null {
    try { return parseEnv(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The PASSWORD for a gateway username: bots/<username>/bot.env first, then any
 * bots/<folder>/bot.env whose BOT_USERNAME is that username. Searched under
 * each root in order. Null when no bot.env names it or it has no PASSWORD.
 */
export function findBotPassword(username: string, roots: string[]): string | null {
    if (!BOT_NAME.test(username)) return null;
    for (const root of roots) {
        const direct = readEnvFile(join(root, 'bots', username, 'bot.env'));
        if (direct && (!direct.BOT_USERNAME || direct.BOT_USERNAME.toLowerCase() === username.toLowerCase())) {
            return direct.PASSWORD || null;
        }
    }
    for (const root of roots) {
        let folders: string[] = [];
        try { folders = readdirSync(join(root, 'bots')); } catch { continue; }
        for (const folder of folders) {
            const path = join(root, 'bots', folder, 'bot.env');
            try { if (!statSync(path).isFile()) continue; } catch { continue; }
            const env = readEnvFile(path);
            if (env?.BOT_USERNAME && env.BOT_USERNAME.toLowerCase() === username.toLowerCase()) return env.PASSWORD || null;
        }
    }
    return null;
}

function samePassword(a: string, b: string): boolean {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Auth hook for bots, SDKs and HTTP callers: the password must equal the
 * bot's bot.env PASSWORD. A username with no bot.env is refused.
 */
export function botEnvAuth(roots: string[]): GatewayAuthHook {
    return ({ username, password }) => {
        const expected = findBotPassword(username, roots);
        if (expected === null) return { success: false, error: `no bots/<name>/bot.env with a PASSWORD for '${username}'` };
        if (!password || !samePassword(password, expected)) return { success: false, error: 'password does not match bot.env' };
        return { success: true };
    };
}

/** Which auth the CLI gateway uses: GATEWAY_AUTH=botenv|none, else botenv when it listens beyond loopback. */
export function resolveAuthMode(env: Record<string, string | undefined>, hostname: string): 'botenv' | 'none' {
    const mode = (env.GATEWAY_AUTH ?? '').trim().toLowerCase();
    if (mode === 'botenv' || mode === 'none') return mode;
    return isLoopbackHostname(hostname) ? 'none' : 'botenv';
}
