// Who owns Thidranki's keeps, read live from what our clients see: every bot in Thidranki the gateway carries, its
// chat (the capture broadcast every client gets) and the NPCs it sees (the keep's guards and lord carry its realm).
// Observes only: GET /status and GET /state/<bot>, the same reads as `bun sdk/cli.ts`; it never takes control.
//
//   bun sdk/group/siege-watch.ts                   # one read: each keep's owner and what it was read from
//   bun sdk/group/siege-watch.ts --watch=600       # keep reading for 600 s, a line on every change
//   bun sdk/group/siege-watch.ts --every=15 --state=<file.json> --gateway=http://localhost:7780
//
// --state keeps the reading across runs (KeepOwnerRead.toJSON): the server keeps the owner across restarts, and a
// client that missed the broadcast learns it only by seeing a guard.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BotWorldState } from '../types';
import { BATTLEGROUND_LAYOUTS, KeepOwnerRead, THIDRANKI, type OwnerReading } from './keeps';

export interface WatchOptions { gateway: string; everyS: number; watchS: number; stateFile: string | null }

export function parseArgs(argv: readonly string[]): WatchOptions {
    const flag = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    return {
        gateway: (flag('gateway') ?? process.env.GATEWAY_HTTP ?? 'http://localhost:7780').replace(/\/$/, ''),
        everyS: Math.max(5, Number(flag('every') ?? 15)),
        watchS: Number(flag('watch') ?? 0),
        stateFile: flag('state') ?? null,
    };
}

async function getJson(url: string): Promise<any> {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return res.json().catch(() => null);
}

/** Feed one read of every bot in the region into `read`; the bots read, and the keeps whose owner changed. */
export async function readOnce(read: KeepOwnerRead, gateway: string): Promise<{ bots: string[]; changed: string[] }> {
    const status = await getJson(`${gateway}/status`);
    const names = Object.entries<any>(status?.bots ?? {}).filter(([, b]) => b?.inGame).map(([name]) => name);
    const bots: string[] = [], changed = new Set<string>();
    for (const name of names) {
        const body = await getJson(`${gateway}/state/${encodeURIComponent(name)}`).catch(() => null);
        const state = body?.state as BotWorldState | undefined;
        if (!state?.player || state.player.regionId !== read.regionId) continue;
        bots.push(name);
        const now = Date.now();
        for (const k of read.seeMessages(state.gameMessages ?? [], now, name)) changed.add(k);
        for (const k of read.seeNpcs((state.nearbyNpcs ?? []).map(n => ({ ...n, regionId: state.player!.regionId })), now)) changed.add(k);
    }
    return { bots, changed: [...changed] };
}

export function describe(read: KeepOwnerRead): string[] {
    const keeps = BATTLEGROUND_LAYOUTS[read.regionId]?.keeps.filter(k => !k.portal) ?? [];
    return keeps.map(k => {
        const r = read.reading(k.name);
        const how = r ? `${r.how === 'capture' ? 'capture broadcast' : 'its guards'} at ${new Date(r.at).toLocaleTimeString()}` : 'the DB (nothing seen yet)';
        return `${k.name}: ${read.owner(k.name)} (by ${how})`;
    });
}

function load(file: string | null): Record<string, OwnerReading> {
    if (!file || !existsSync(file)) return {};
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function save(file: string | null, read: KeepOwnerRead): void {
    if (!file) return;
    writeFileSync(`${file}.tmp`, JSON.stringify(read.toJSON(), null, 2));
    renameSync(`${file}.tmp`, file);
}

if (import.meta.main) {
    const o = parseArgs(process.argv.slice(2));
    const read = new KeepOwnerRead(THIDRANKI, load(o.stateFile));
    const end = Date.now() + o.watchS * 1000;
    let first = true;
    for (;;) {
        const { bots, changed } = await readOnce(read, o.gateway);
        const stamp = new Date().toLocaleTimeString();
        if (first) {
            console.log(`${stamp} read ${bots.length} bots in Thidranki`);
            for (const line of describe(read)) console.log(`  ${line}`);
            first = false;
        } else {
            for (const k of changed) console.log(`${stamp} ${k}: now ${read.owner(k)} (${read.reading(k)?.how}), from ${bots.length} bots`);
        }
        save(o.stateFile, read);
        if (Date.now() + o.everyS * 1000 > end) break;
        await Bun.sleep(o.everyS * 1000);
    }
    process.exit(0);
}
