// Gear wear: the condition of every bot's worn gear, read from the gateway's last state (GET /state/<user>: observe only,
// never takes control, so it is safe while field mode runs).
//
//   bun groups/gear-wear.ts [--groups=camelot,midgard,hibernia] [--label=opening]
//
// Appends one JSON line per reading to groups/lifecycle/gear-wear.jsonl ({ at, label, bots: { <bot>: { min, mean, worn } } })
// and prints a summary, with the change against the first reading of the file when there is one. Condition is the
// client's percent (the server's Condition / MaxCondition); an item loses it by use (a weapon by its swings, armour by the
// hits it takes), and below 100 % its AF or DPS falls with it. Thidranki has no smith: only a capital repairs.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBotEnv, parseEnvFile } from '../sdk/index';
import { wearOf, type GearWear } from '../sdk/group/lifecycle';

const GATEWAY = process.env.GATEWAY_HTTP ?? 'http://127.0.0.1:7780';
const OUT_DIR = join(import.meta.dir, 'lifecycle');
const OUT = join(OUT_DIR, 'gear-wear.jsonl');

const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const realms = (flag('groups') ?? 'camelot,midgard,hibernia').split(',');
const label = flag('label') ?? '';

/** Every bot of the realms' main group.json (members and bench). */
function botsOf(realm: string): string[] {
    const j = JSON.parse(readFileSync(join(import.meta.dir, realm, 'group.json'), 'utf8'));
    return [...j.members, ...(j.bench ?? [])].map((e: { bot: string }) => e.bot);
}

async function read(bot: string): Promise<GearWear | null> {
    const env = findBotEnv(bot);
    const user = env ? parseEnvFile(readFileSync(env, 'utf8')).BOT_USERNAME || bot : bot;
    try {
        const res = await fetch(`${GATEWAY}/state/${encodeURIComponent(user)}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const j = await res.json() as { state?: { inGame?: boolean; equipment?: { slot: number; name: string; condition: number }[] } };
        if (!j.state?.inGame || !j.state.equipment?.length) return null;
        return wearOf(j.state.equipment);
    } catch {
        return null;
    }
}

if (import.meta.main) {
    mkdirSync(OUT_DIR, { recursive: true });
    const bots = realms.flatMap(botsOf);
    const out: Record<string, GearWear> = {};
    const missing: string[] = [];
    await Promise.all(bots.map(async b => { const w = await read(b); if (w) out[b] = w; else missing.push(b); }));
    const first = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8').split('\n').find(Boolean) ?? 'null') as { at: string; bots: Record<string, GearWear> } | null : null;
    const line = { at: new Date().toISOString(), label, bots: out, missing };
    appendFileSync(OUT, JSON.stringify(line) + '\n');
    const rows = Object.entries(out).sort((a, b) => a[1].min - b[1].min);
    const mean = rows.reduce((s, [, w]) => s + w.mean, 0) / (rows.length || 1);
    console.log(`${line.at} ${label}: ${rows.length} bots read, ${missing.length} not (${missing.join(', ') || '-'}); mean condition ${mean.toFixed(1)} %`);
    for (const [b, w] of rows.slice(0, 12)) {
        const was = first?.bots[b];
        console.log(`  ${b.padEnd(11)} min ${w.min} % mean ${w.mean.toFixed(1)} %${was ? ` (first ${was.min} / ${was.mean.toFixed(1)})` : ''}  ${w.worn.slice(0, 3).map(i => `${i.name} ${i.condition}`).join(', ')}`);
    }
}
