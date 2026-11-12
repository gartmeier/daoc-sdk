// Who owns Thidranki's keeps, read live from what our clients see: the capture broadcast every client gets, and the
// realm of the keep's guards and lord in what a bot sees. Observes only: GET /status and GET /state/<bot>, the same
// reads as `bun sdk/cli.ts`; it never takes control.
//
//   bun sdk/group/siege-watch.ts                   # one sweep: each keep's owner and what it was read from
//   bun sdk/group/siege-watch.ts --watch=600       # keep reading for 600 s, a line on every change
//   bun sdk/group/siege-watch.ts --state=<file.json> --gateway=http://localhost:7780 --listen=3 --every=5 --sweep=300
//
// Load: a bot's state is ~80 KB and a client keeps its last 100 chat lines. So a full sweep (every bot in
// Thidranki: guards in view, the broadcast in chat) runs at start and every --sweep seconds, and between sweeps
// only --listen bots (one per realm first) are read every --every seconds for the broadcast. A fight fills 100
// lines in well over 5 s.
//
// In a process of its own (the director, field.ts): `const w = watchOwners(); ... w.read.owner('Thidranki Faste'); w.stop()`.
//
// --state keeps the reading across runs (KeepOwnerRead.toJSON): the server keeps the owner across restarts, and a
// reader that starts later learns it only by seeing a guard.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BotWorldState } from '../types';
import { BATTLEGROUND_LAYOUTS, KeepOwnerRead, THIDRANKI, type OwnerReading } from './keeps';

export interface WatchOptions {
    gateway: string;
    /** Seconds between reads of the listening bots. */
    everyS: number;
    /** Seconds between full sweeps. */
    sweepS: number;
    /** Bots read between sweeps (one per realm first). */
    listen: number;
    /** Seconds to run in the CLI; 0 = one sweep. */
    watchS: number;
    /** File the reading is kept in across runs, or null. */
    stateFile: string | null;
    regionId: number;
}

export const WATCH_DEFAULTS: WatchOptions = {
    gateway: 'http://localhost:7780', everyS: 5, sweepS: 300, listen: 3, watchS: 0, stateFile: null, regionId: THIDRANKI,
};

export function parseArgs(argv: readonly string[]): WatchOptions {
    const flag = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const num = (name: string, d: number) => (flag(name) !== undefined ? Number(flag(name)) : d);
    return {
        ...WATCH_DEFAULTS,
        gateway: (flag('gateway') ?? process.env.GATEWAY_HTTP ?? WATCH_DEFAULTS.gateway).replace(/\/$/, ''),
        everyS: Math.max(2, num('every', WATCH_DEFAULTS.everyS)),
        sweepS: Math.max(30, num('sweep', WATCH_DEFAULTS.sweepS)),
        listen: Math.max(1, num('listen', WATCH_DEFAULTS.listen)),
        watchS: num('watch', 0),
        stateFile: flag('state') ?? null,
    };
}

async function getJson(url: string): Promise<any> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return res.ok ? await res.json().catch(() => null) : null;
    } catch {
        return null;
    }
}

/** The bots the gateway has in game. */
export async function botsInGame(gateway: string): Promise<string[]> {
    const status = await getJson(`${gateway}/status`);
    return Object.entries<any>(status?.bots ?? {}).filter(([, b]) => b?.inGame).map(([name]) => name);
}

/** Feed one read of `names` into `read`: the bots in the region (with their realm), and the keeps whose owner changed. */
export async function readBots(read: KeepOwnerRead, gateway: string, names: readonly string[]): Promise<{ bots: { name: string; realm: string }[]; changed: string[] }> {
    const bots: { name: string; realm: string }[] = [], changed = new Set<string>();
    for (const name of names) {
        const body = await getJson(`${gateway}/state/${encodeURIComponent(name)}`);
        const state = body?.state as BotWorldState | undefined;
        if (!state?.player || state.player.regionId !== read.regionId) continue;
        bots.push({ name, realm: state.player.realm });
        const now = Date.now();
        for (const k of read.seeMessages(state.gameMessages ?? [], now, name)) changed.add(k);
        for (const k of read.seeNpcs((state.nearbyNpcs ?? []).map(n => ({ ...n, regionId: state.player!.regionId })), now)) changed.add(k);
    }
    return { bots, changed: [...changed] };
}

/** Up to `n` of `bots`, one per realm first. */
export function pickListeners(bots: readonly { name: string; realm: string }[], n: number): string[] {
    const out: string[] = [];
    for (const realm of ['albion', 'midgard', 'hibernia']) {
        const b = bots.find(x => x.realm === realm && !out.includes(x.name));
        if (b && out.length < n) out.push(b.name);
    }
    for (const b of bots) if (out.length < n && !out.includes(b.name)) out.push(b.name);
    return out;
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

export interface OwnerWatch {
    read: KeepOwnerRead;
    /** Resolves after the first full sweep. */
    ready: Promise<void>;
    stop(): void;
}

/**
 * Keep `read` current in the background: a full sweep now and every sweepS, the listeners every everyS.
 * `onChange(keep, read)` on every change. Errors (gateway down) are skipped; the next read tries again.
 */
export function watchOwners(opts: Partial<WatchOptions> = {}, onChange?: (keep: string, read: KeepOwnerRead, bots: number) => void): OwnerWatch {
    const o = { ...WATCH_DEFAULTS, ...opts };
    const read = new KeepOwnerRead(o.regionId, load(o.stateFile));
    let stopped = false, listeners: string[] = [], lastSweep = 0;
    let markReady!: () => void;
    const ready = new Promise<void>(r => { markReady = r; });
    const loop = async () => {
        while (!stopped) {
            const now = Date.now();
            let r;
            if (!listeners.length || now - lastSweep >= o.sweepS * 1000) {
                r = await readBots(read, o.gateway, await botsInGame(o.gateway));
                listeners = pickListeners(r.bots, o.listen);
                lastSweep = now;
                markReady();
            } else {
                r = await readBots(read, o.gateway, listeners);
                if (r.bots.length < listeners.length) lastSweep = 0;   // one left: sweep again next time
            }
            for (const k of r.changed) onChange?.(k, read, r.bots.length);
            if (r.changed.length) save(o.stateFile, read);
            await Bun.sleep(o.everyS * 1000);
        }
    };
    void loop();
    return { read, ready, stop: () => { stopped = true; save(o.stateFile, read); } };
}

if (import.meta.main) {
    const o = parseArgs(process.argv.slice(2));
    if (!o.watchS) {
        const read = new KeepOwnerRead(o.regionId, load(o.stateFile));
        const { bots } = await readBots(read, o.gateway, await botsInGame(o.gateway));
        console.log(`${new Date().toLocaleTimeString()} read ${bots.length} bots in Thidranki`);
        for (const line of describe(read)) console.log(`  ${line}`);
        save(o.stateFile, read);
        process.exit(0);
    }
    const w = watchOwners(o, (k, read, n) => console.log(`${new Date().toLocaleTimeString()} ${k}: now ${read.owner(k)} (by ${read.reading(k)?.how}), from ${n} bots`));
    await w.ready;
    console.log(`${new Date().toLocaleTimeString()} first sweep done; listening every ${o.everyS} s, sweeping every ${o.sweepS} s`);
    for (const line of describe(w.read)) console.log(`  ${line}`);
    await Bun.sleep(o.watchS * 1000);
    w.stop();
    for (const line of describe(w.read)) console.log(`  ${line}`);
    process.exit(0);
}
