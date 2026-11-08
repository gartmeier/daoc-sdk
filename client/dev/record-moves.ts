// Record how other players' movement reaches a viewer, to compare a real client with a bot.
//
//   bun client/dev/record-moves.ts <observerBot> <Name> [<Name> ...] [--seconds=300] [--out=file.jsonl]
//   bun client/dev/record-moves.ts --analyze <file.jsonl> [--from=<s>] [--to=<s>]
//
// The observer logs in with its own client (its runner must not be running) and writes every 0xA9
// the server relays for the named players: what a watching real client gets, fall speed included
// (PlayerPositionUpdateHandler.cs CreateOutPak1127). Each line carries the terrain height under the
// reported x/y, so a hill doesn't count as jitter. Ctrl+C in this console, --seconds, or creating <out>.stop
// logs it out cleanly.
//
// --analyze prints per player, over the packets with speed > 0: send interval, speed and how long the
// speed-up takes, heading change, then by terrain (downhill, flat, uphill): how often and how high it
// is in the air, fall speed, and the bob (how much z - terrain changes from one packet to the next).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBotConfig } from '../bridge-config';
import { DaocClient } from '../client';
import { moverGround } from '../../sdk/ground';
import { getTerrainStore, sampleTerrain } from '../../sdk/terrain';
import { decodePlayerPosition } from '../protocol/incoming/objects';
import { ServerOp } from '../protocol/opcodes';

interface Row {
    t: number;
    name: string;
    x: number;
    y: number;
    z: number;
    speed: number;
    fallSpeed: number;
    heading: number;
    state: number;
    zoneId: number;
    terrainZ: number | null;
    /** The heading word as relayed, flag bits included (the server passes on what the client sent: GameObject.RawHeading). */
    rawHeading: number;
    /** Bytes 20.. of the payload in hex (ids, zone, flags, steed seat, heading, action, RP, health, mana, endurance). */
    tail: string;
}

const argv = process.argv.slice(2);
const flag = (k: string) => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const positional = argv.filter(a => !a.startsWith('--'));

async function record(): Promise<void> {
    const [observer, ...names] = positional;
    if (!observer || names.length === 0) {
        console.error('Usage: bun client/dev/record-moves.ts <observerBot> <Name> [<Name> ...] [--seconds=300] [--out=file.jsonl]');
        process.exit(2);
    }
    const seconds = Number(flag('seconds') ?? 300);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = flag('out') ?? join('bots', observer, 'runs', `moves-${stamp}.jsonl`);
    mkdirSync(dirname(out), { recursive: true });
    const wanted = new Set(names.map(n => n.toLowerCase()));
    const terrain = getTerrainStore();

    const c = loadBotConfig(observer);
    const client = new DaocClient({
        host: c.host, port: c.port, username: c.username, password: c.password, charName: c.charName,
        realm: c.realm, className: c.className, raceName: c.raceName, gender: c.gender,
        createIfMissing: true, log: m => console.log(`  [client] ${m}`), ground: moverGround(),
    });
    let quitting = false;
    const quit = async (why: string) => {
        if (quitting) return;
        quitting = true;
        console.log(`${why}: quitting`);
        await client.quit().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', () => void quit('SIGINT'));

    await client.connect();
    const s = client.session!;
    const t0 = Date.now();
    const counts = new Map<string, number>();
    s.onPacket(p => {
        if (p.code !== ServerOp.PlayerPosition) return;
        const d = decodePlayerPosition(p.payload);
        const oid = s.model.sessionToOid.get(d.sessionId);
        const name = oid !== undefined ? s.model.players.get(oid)?.name : undefined;
        if (!name || !wanted.has(name.toLowerCase())) return;
        const grid = terrain.forZone(d.zoneId);
        const ts = grid ? sampleTerrain(grid, d.x, d.y) : null;
        const row: Row = {
            t: Date.now() - t0, name, x: d.x, y: d.y, z: d.z, speed: d.speed, fallSpeed: d.fallSpeed,
            heading: d.heading, state: d.stateFlags, zoneId: d.zoneId, terrainZ: ts ? Math.round(ts.z * 10) / 10 : null,
            rawHeading: (p.payload[30]! << 8) | p.payload[31]!, tail: Buffer.from(p.payload.subarray(20)).toString('hex'),
        };
        appendFileSync(out, JSON.stringify(row) + '\n');
        counts.set(name, (counts.get(name) ?? 0) + 1);
    });
    console.log(`observing as ${c.charName}; recording ${names.join(', ')} for ${seconds}s into ${out}`);
    const tick = setInterval(() => {
        const seen = [...s.model.players.values()].filter(p => wanted.has(p.name.toLowerCase())).map(p => p.name);
        console.log(`[${Math.round((Date.now() - t0) / 1000)}s] in view: ${seen.join(', ') || 'none'}; packets ${[...counts].map(([n, k]) => `${n}=${k}`).join(' ') || '0'}`);
    }, 10_000);
    // A recorder in a background shell can't be sent a Ctrl+C on Windows (a kill leaves the character
    // link-dead for a minute): creating <out>.stop makes it log out cleanly instead.
    const stopFile = `${out}.stop`;
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end && !existsSync(stopFile)) await Bun.sleep(1000);
    clearInterval(tick);
    if (existsSync(stopFile)) rmSync(stopFile);
    await quit(Date.now() < end ? 'stop file' : 'time up');
}

function pct(xs: number[], p: number): number {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');

/** Terrain slope (rise per unit) between two packets that counts as downhill or uphill rather than flat. */
const SLOPE = 0.15;

function analyze(file: string, from: number, to: number): void {
    const rows: Row[] = readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter((r: Row) => r.t >= from * 1000 && r.t <= to * 1000);
    const byName = new Map<string, Row[]>();
    for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    for (const [name, all] of byName) {
        const intervals: number[] = [];
        const turn: number[] = [];
        type Pair = { a: Row; b: Row; slope: number };
        const pairs: Pair[] = [];
        for (let i = 1; i < all.length; i++) {
            const a = all[i - 1]!;
            const b = all[i]!;
            if (a.speed <= 0 || b.speed <= 0) continue;
            intervals.push(b.t - a.t);
            turn.push(Math.abs((((b.heading - a.heading) % 4096) + 6144) % 4096 - 2048));
            const dxy = Math.hypot(b.x - a.x, b.y - a.y);
            if (dxy > 1 && a.terrainZ !== null && b.terrainZ !== null) pairs.push({ a, b, slope: (b.terrainZ - a.terrainZ) / dxy });
        }
        const moving = all.filter(r => r.speed > 0);
        // Speed-up: from the first packet over 0 to the first at the top speed of that run.
        const ramps: number[] = [];
        const top = pct(moving.map(r => r.speed), 90);
        for (let i = 1; i < all.length; i++) {
            if (all[i - 1]!.speed > 0 || all[i]!.speed <= 0) continue;
            const j = all.findIndex((r, k) => k >= i && (r.speed >= top - 1 || r.speed <= 0));
            if (j >= 0 && all[j]!.speed > 0) ramps.push(all[j]!.t - all[i]!.t);
        }
        console.log(`\n${name}:${all.length} packets, ${moving.length} moving`);
        console.log(`  interval ms   p10 ${pct(intervals, 10)}  p50 ${pct(intervals, 50)}  p90 ${pct(intervals, 90)}`);
        console.log(`  speed         p10 ${f(pct(moving.map(r => r.speed), 10))}  p50 ${f(pct(moving.map(r => r.speed), 50))}  p90 ${f(top)}; speed-up to it ${ramps.map(ms => `${ms} ms`).join(', ') || '-'}`);
        console.log(`  heading/pkt   mean ${f(mean(turn))}  p90 ${f(pct(turn, 90))}`);
        const groups: Array<[string, Pair[]]> = [
            ['downhill', pairs.filter(p => p.slope < -SLOPE)],
            ['flat', pairs.filter(p => Math.abs(p.slope) <= SLOPE)],
            ['uphill', pairs.filter(p => p.slope > SLOPE)],
        ];
        console.log(`  ${'terrain'.padEnd(9)} ${'pkts'.padStart(5)} ${'air%'.padStart(5)} ${'above p50/p95/max'.padStart(19)} ${'fall min'.padStart(8)} ${'fall≠0%'.padStart(7)} ${'bob mean/p90'.padStart(13)}`);
        for (const [label, ps] of groups) {
            const above = ps.map(p => p.b.z - p.b.terrainZ!);
            const falls = ps.map(p => p.b.fallSpeed);
            const bob = ps.map(p => Math.abs((p.b.z - p.b.terrainZ!) - (p.a.z - p.a.terrainZ!)));
            const air = (100 * above.filter(v => v > 3).length) / (above.length || 1);
            console.log(`  ${label.padEnd(9)} ${String(ps.length).padStart(5)} ${f(air, 0).padStart(5)} ${`${f(pct(above, 50))}/${f(pct(above, 95))}/${f(Math.max(...above))}`.padStart(19)} ${f(Math.min(...falls), 0).padStart(8)} ${f((100 * falls.filter(v => v !== 0).length) / (falls.length || 1), 0).padStart(7)} ${`${f(mean(bob))}/${f(pct(bob, 90))}`.padStart(13)}`);
        }
    }
}

if (argv.includes('--analyze')) {
    analyze(positional[0]!, Number(flag('from') ?? 0), Number(flag('to') ?? Infinity));
} else {
    await record();
}
