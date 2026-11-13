#!/usr/bin/env bun
// The "alive" measures of a field run (plan doc "Living Thidranki", stint brief milestone 3), hour by hour, from
// groups/alive.jsonl (field.ts: one line per unit a minute) and groups/lifecycle/samples.jsonl.
//
//   bun scripts/alive.ts [--from=HH:MM] [--to=HH:MM] [--file=groups/alive.jsonl]
//
//   fight near   per portal keep, the distance to the nearest unit (any realm) in a fight, minute by minute:
//                median, and the share of minutes with a fight within 15000 (about 80 s at a run)
//   sizes        the share of 10-minute windows with solos (1), small-man (2-3) and groups (4+) all fighting in it
//   even         minutes where one realm's living in the zone outnumber another's by more than 1.5 to 1, and the
//                longest such stretch
//   online       the life cycle's playing count per realm (its samples), mean per hour

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BATTLEGROUND_LAYOUTS } from '../sdk/group/keeps';

export interface AliveRow { t: number; unit: string; realm: string; size: number; inZone: number; living: number; fighting: boolean; x: number | null; y: number | null }

export const NEAR = 15_000;
const sizeClass = (n: number) => (n <= 1 ? 'solo' : n <= 3 ? 'small' : 'group');

/** Per minute: the last row of each unit seen within the 90 s before it. */
export function minutes(rows: AliveRow[]): { t: number; units: AliveRow[] }[] {
    if (!rows.length) return [];
    const sorted = [...rows].sort((a, b) => a.t - b.t);
    const start = Math.floor(sorted[0]!.t / 60_000) * 60_000;
    const end = sorted[sorted.length - 1]!.t;
    const out: { t: number; units: AliveRow[] }[] = [];
    let i = 0;
    const last = new Map<string, AliveRow>();
    for (let t = start + 60_000; t <= end + 60_000; t += 60_000) {
        while (i < sorted.length && sorted[i]!.t <= t) { last.set(sorted[i]!.unit, sorted[i]!); i++; }
        out.push({ t, units: [...last.values()].filter(r => t - r.t <= 90_000) });
    }
    return out;
}

export interface HourMeasures {
    hour: string;
    minutes: number;
    nearMedian: Record<string, number | null>;
    nearShare: Record<string, number>;
    sizesAll: number;
    windows: number;
    unevenMin: number;
    longestUneven: number;
    living: Record<string, number>;
}

export function measure(rows: AliveRow[], portals: { realm: string; x: number; y: number }[]): HourMeasures[] {
    const byHour = new Map<string, { t: number; units: AliveRow[] }[]>();
    for (const m of minutes(rows)) {
        const h = new Date(m.t - 1).toTimeString().slice(0, 2);
        byHour.set(h, [...(byHour.get(h) ?? []), m]);
    }
    const out: HourMeasures[] = [];
    for (const [hour, ms] of byHour) {
        const nearMedian: Record<string, number | null> = {}, nearShare: Record<string, number> = {};
        for (const p of portals) {
            const d = ms.map(m => {
                const f = m.units.filter(u => u.fighting && u.x !== null && u.y !== null);
                return f.length ? Math.min(...f.map(u => Math.hypot(u.x! - p.x, u.y! - p.y))) : Infinity;
            });
            const finite = d.filter(Number.isFinite).sort((a, b) => a - b);
            nearMedian[p.realm] = finite.length ? Math.round(finite[Math.floor(finite.length / 2)]!) : null;
            nearShare[p.realm] = d.length ? d.filter(x => x <= NEAR).length / d.length : 0;
        }
        // 10-minute windows: did solos, small-man and groups all fight in it?
        const windows = new Map<number, Set<string>>();
        for (const m of ms) {
            const w = Math.floor(m.t / 600_000);
            const set = windows.get(w) ?? new Set<string>();
            for (const u of m.units) if (u.fighting) set.add(sizeClass(u.size));
            windows.set(w, set);
        }
        const sizesAll = [...windows.values()].filter(s => s.size === 3).length;
        // Even: living in the zone per realm, minute by minute.
        let uneven = 0, run = 0, longest = 0;
        const livingSum: Record<string, number> = {};
        for (const m of ms) {
            const per: Record<string, number> = {};
            for (const u of m.units) per[u.realm] = (per[u.realm] ?? 0) + u.living;
            for (const [r, n] of Object.entries(per)) livingSum[r] = (livingSum[r] ?? 0) + n;
            const vals = Object.values(per);
            const bad = vals.length >= 2 && Math.max(...vals) > 1.5 * Math.max(1, Math.min(...vals));
            if (bad) { uneven++; run++; longest = Math.max(longest, run); } else run = 0;
        }
        const living = Object.fromEntries(Object.entries(livingSum).map(([r, n]) => [r, Math.round((n / ms.length) * 10) / 10]));
        out.push({ hour, minutes: ms.length, nearMedian, nearShare, sizesAll, windows: windows.size, unevenMin: uneven, longestUneven: longest, living });
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..');
    const flag = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1];
    const file = join(root, flag('file') ?? 'groups/alive.jsonl');
    if (!existsSync(file)) {
        console.error(`no ${file}: field.ts writes it once a minute per unit`);
        process.exit(1);
    }
    const day = new Date().toDateString();
    const clock = (s?: string) => (s ? new Date(`${day} ${s}`).getTime() : undefined);
    const from = clock(flag('from')), to = clock(flag('to'));
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as AliveRow)
        .filter(r => (from === undefined || r.t >= from) && (to === undefined || r.t <= to));
    const portals = (BATTLEGROUND_LAYOUTS[252]?.keeps ?? []).filter(k => k.portal).map(k => ({ realm: k.owner, x: k.x, y: k.y }));
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    console.log(`| Hour | Min | Fight near PK: median (share within ${NEAR / 1000}k) | All sizes fighting (10-min windows) | Uneven > 1.5:1 (min, longest) | Living in zone per realm |`);
    console.log('|---|---|---|---|---|---|');
    for (const h of measure(rows, portals)) {
        const near = portals.map(p => `${p.realm.slice(0, 3)} ${h.nearMedian[p.realm] ?? '-'} (${pct(h.nearShare[p.realm] ?? 0)})`).join(', ');
        const liv = Object.entries(h.living).map(([r, n]) => `${r.slice(0, 3)} ${n}`).join(', ');
        console.log(`| ${h.hour}:00 | ${h.minutes} | ${near} | ${h.sizesAll} of ${h.windows} | ${h.unevenMin}, ${h.longestUneven} | ${liv} |`);
    }
    const samples = join(root, 'groups/lifecycle/samples.jsonl');
    if (existsSync(samples)) {
        const per = new Map<string, Record<string, number[]>>();
        for (const l of readFileSync(samples, 'utf8').split('\n').filter(Boolean)) {
            const s = JSON.parse(l) as { at: string; shadow: boolean; realms: Record<string, { playing: number; target: number }> };
            const t = Date.parse(s.at);
            if ((from !== undefined && t < from) || (to !== undefined && t > to)) continue;
            const h = new Date(t).toTimeString().slice(0, 2) + (s.shadow ? ' (shadow)' : '');
            const rec = per.get(h) ?? {};
            for (const [r, v] of Object.entries(s.realms)) (rec[r] ??= []).push(v.playing);
            per.set(h, rec);
        }
        console.log('\nLife cycle, playing per realm (mean of its samples):');
        for (const [h, rec] of per) console.log(`  ${h}: ${Object.entries(rec).map(([r, v]) => `${r} ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}`).join(', ')}`);
    }
}
