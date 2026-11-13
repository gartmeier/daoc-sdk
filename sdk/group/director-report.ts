// The director's numbers from its logs (groups/director/<realm>-log.jsonl, director.ts): help calls and musters.
//
//   bun sdk/group/director-report.ts [--since=HH:MM|ISO] [--until=HH:MM|ISO] [--dir=groups/director] [--realm=albion,...]
//
// Help calls, director on and off (shadow) apart, as the night's table (stint-realm-calls.md "Help calls"): calls, someone
// coming, arrived, wiped, our dead per call; plus the stint 2026-11-13 measures (S3): time from the call to the first
// arrival, the distance at the call (the nearest other unit when it opened, and each ask), fights with help against
// without, and how many were called on first sight. Musters: one line each (stage, holds, end, lost, kills).
// Observe only: it reads the logs and prints.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggedEvent } from './director';
import { DIRECTOR_DIR } from './director';

export interface CallRow {
    id: string;
    realm: string;
    shadow: boolean;
    from: string;
    why: string;
    /** The reason it opened with (sighted, outnumbered, ...). */
    firstWhy: string;
    openedAt: number;
    /** Nearest other unit at the open; null when unknown or none. */
    nearest: number | null;
    /** In a fight when it opened (old logs: unknown). */
    fight: boolean | null;
    asks: number[];
    coming: Set<string>;
    arrivals: { unit: string; ms: number }[];
    close?: Extract<LoggedEvent, { kind: 'close' }>;
}

/** Calls (help and muster) from log events, in order. */
export function callRows(events: readonly LoggedEvent[]): CallRow[] {
    // Ids start over with each director: the latest open of an id is the one later events mean.
    const rows = new Map<string, CallRow>();
    const out: CallRow[] = [];
    for (const e of events) {
        if (!('call' in e)) continue;
        const key = `${e.realm}/${e.call}`;
        if (e.kind === 'open') {
            if (rows.has(key)) out.push(rows.get(key)!);
            rows.set(key, { id: e.call, realm: e.realm, shadow: e.shadow, from: e.from, why: e.why, firstWhy: e.why, openedAt: e.t, nearest: e.nearest ?? null, fight: e.fight ?? null, asks: [], coming: new Set(), arrivals: [] });
            continue;
        }
        const r = rows.get(key);
        if (!r) continue;
        if (e.kind === 'ask') r.asks.push(e.dist);
        else if (e.kind === 'answer' && (e.state === 'coming' || e.state === 'arrived')) r.coming.add(e.unit);
        else if (e.kind === 'arrive') r.arrivals.push({ unit: e.unit, ms: e.ms });
        else if (e.kind === 'why') r.why = e.why;
        else if (e.kind === 'close') r.close = e;
    }
    return [...out, ...rows.values()].sort((a, b) => a.openedAt - b.openedAt);
}

const median = (xs: readonly number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)} %` : '-');
const per = (n: number, of: number) => (of ? (n / of).toFixed(2) : '-');
const sec = (ms: number | null) => (ms === null ? '-' : `${Math.round(ms / 1000)} s`);
const num = (n: number | null) => (n === null ? '-' : String(Math.round(n)));

export interface HelpSummary {
    calls: number;
    coming: number;
    arrived: number;
    wiped: number;
    lost: number;
    kills: number;
    sighted: number;
    firstArrivalMs: number | null;
    nearestAtCall: number | null;
    askDist: number | null;
    withHelp: { n: number; lost: number; kills: number; wiped: number };
    without: { n: number; lost: number; kills: number; wiped: number };
}

/** Closed help calls summed (stopped ones left out). */
export function helpSummary(rows: readonly CallRow[]): HelpSummary {
    const closed = rows.filter(r => r.close && r.close.why !== 'raid' && r.close.end !== 'stopped' && r.firstWhy !== 'raid');
    const side = (rs: CallRow[]) => ({ n: rs.length, lost: rs.reduce((t, r) => t + r.close!.lost, 0), kills: rs.reduce((t, r) => t + (r.close!.kills ?? 0), 0), wiped: rs.filter(r => r.close!.wiped).length });
    const helped = closed.filter(r => r.arrivals.length > 0);
    const firsts = helped.map(r => Math.min(...r.arrivals.map(a => a.ms)));
    return {
        calls: closed.length,
        coming: closed.filter(r => r.coming.size > 0).length,
        arrived: helped.length,
        wiped: closed.filter(r => r.close!.wiped).length,
        lost: closed.reduce((t, r) => t + r.close!.lost, 0),
        kills: closed.reduce((t, r) => t + (r.close!.kills ?? 0), 0),
        sighted: closed.filter(r => r.firstWhy === 'sighted').length,
        firstArrivalMs: median(firsts),
        nearestAtCall: median(closed.map(r => r.nearest).filter((n): n is number => n !== null)),
        askDist: median(closed.flatMap(r => r.asks)),
        withHelp: side(helped),
        without: side(closed.filter(r => !r.arrivals.length)),
    };
}

function readLog(path: string): LoggedEvent[] {
    if (!existsSync(path)) return [];
    const out: LoggedEvent[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as LoggedEvent); } catch { /* a half line */ }
    }
    return out;
}

/** HH:MM (today, local) or an ISO time to ms; undefined when absent. */
function when(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (hm) { const d = new Date(); d.setHours(+hm[1]!, +hm[2]!, 0, 0); return d.getTime(); }
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`not a time: ${s}`);
    return t;
}

function table(label: string, h: HelpSummary): string[] {
    const s = (x: { n: number; lost: number; kills: number; wiped: number }) => `${x.n} calls, dead ${per(x.lost, x.n)}/call, kills ${per(x.kills, x.n)}/call, wiped ${pct(x.wiped, x.n)}`;
    return [
        `| ${label} | ${h.calls} | ${h.coming} | ${h.arrived} (${pct(h.arrived, h.calls)}) | ${h.wiped} | ${per(h.lost, h.calls)} | ${h.sighted} (${pct(h.sighted, h.calls)}) | ${sec(h.firstArrivalMs)} | ${num(h.nearestAtCall)} | ${num(h.askDist)} |`,
        `  - with help: ${s(h.withHelp)}; without: ${s(h.without)}`,
    ];
}

if (import.meta.main) {
    const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const dir = flag('dir') ?? DIRECTOR_DIR;
    const since = when(flag('since')) ?? 0;
    const until = when(flag('until')) ?? Infinity;
    const realms = (flag('realm') ?? 'albion,midgard,hibernia').split(',');
    const all: CallRow[] = [];
    for (const realm of realms) {
        const events = readLog(join(dir, `${realm}-log.jsonl`));
        all.push(...callRows(events).filter(r => r.openedAt >= since && r.openedAt <= until));
    }
    const lines = [
        `Director report${since ? ` from ${new Date(since).toLocaleString()}` : ''}${until < Infinity ? ` to ${new Date(until).toLocaleString()}` : ''}`,
        '',
        '| | calls | someone coming | arrived | wiped | our dead per call | first sight | call to first arrival (median) | nearest unit at the call (median) | ask distance (median) |',
        '|---|---|---|---|---|---|---|---|---|---|',
    ];
    const help = all.filter(r => r.firstWhy !== 'raid');
    lines.push(...table('director on', helpSummary(help.filter(r => !r.shadow))));
    lines.push(...table('director off (shadow)', helpSummary(help.filter(r => r.shadow))));
    for (const realm of realms) lines.push(...table(`${realm}, on`, helpSummary(help.filter(r => !r.shadow && r.realm === realm))));
    lines.push('', 'Musters:');
    for (const r of all.filter(r => r.firstWhy === 'raid')) {
        const c = r.close;
        lines.push(`- ${new Date(r.openedAt).toLocaleTimeString()} ${r.realm} ${r.id}: ${c ? `${c.end} after ${sec(c.ms)}, lost ${c.lost}, kills ${c.kills ?? '-'}, units ${c.asked.length}` : 'open'}`);
    }
    console.log(lines.join('\n'));
}
