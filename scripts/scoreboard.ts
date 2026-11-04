// A scoreboard for the RvR groups, from the reports their runs leave in groups/<group>/runs/*.json.
// It reads files and connects to nothing, so it can run beside live rounds and restarts on its own.
//
//   bun run scoreboard            http://127.0.0.1:7795 (SCOREBOARD_PORT for another port)

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface Run {
    group: string;
    strategy: string;
    startedAt: string;
    seconds: number;
    kills: number;
    deaths: number;
    realmPoints: number;
    alivePct: number | null;
    members: { name: string; className: string; dealt: number; deaths: number }[];
}

export interface Standing {
    group: string;
    rounds: number;
    kills: number;
    deaths: number;
    /** Kills per death, with no deaths counting as one: a round with 5 kills and none lost reads 5. */
    kd: number;
    realmPoints: number;
    rpPerHour: number;
    alivePct: number | null;
}

export interface Fighter {
    name: string;
    className: string;
    group: string;
    dealt: number;
    deaths: number;
}

/** Shorter than this, a run was cut off or only a probe. */
const MIN_SECONDS = 120;
/** Everyone at level 24: the rounds before this are at other levels and gear. */
const SINCE = '2026-11-03T20:38:00Z';
const RVR_STRATEGY = /rvr|pack/i;

/** One report as a Run, or null if it isn't a full RvR round at level 24. */
export function toRun(report: any): Run | null {
    if (!report?.group || !RVR_STRATEGY.test(report.strategy ?? '') || !report.totals) return null;
    if (!(report.startedAt >= SINCE)) return null;
    const seconds = (report.durationMs ?? 0) / 1000;
    if (seconds < MIN_SECONDS) return null;
    const t = report.totals;
    return {
        group: report.group,
        strategy: report.strategy,
        startedAt: report.startedAt,
        seconds,
        kills: t.playerKills ?? t.kills ?? 0,
        deaths: t.deaths ?? 0,
        realmPoints: t.realmPoints ?? 0,
        alivePct: t.alivePct ?? null,
        members: Object.entries(report.members ?? {}).map(([name, m]: [string, any]) => ({
            name, className: m.className ?? '', dealt: m.dealt ?? 0, deaths: m.deaths ?? 0,
        })),
    };
}

/** Each group's totals over its last `last` rounds, best kills per death first. */
export function standings(runs: Run[], last: number): Standing[] {
    const groups = [...new Set(runs.map(r => r.group))];
    return groups.map(group => {
        const mine = runs.filter(r => r.group === group).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-last);
        const kills = mine.reduce((n, r) => n + r.kills, 0);
        const deaths = mine.reduce((n, r) => n + r.deaths, 0);
        const realmPoints = mine.reduce((n, r) => n + r.realmPoints, 0);
        const seconds = mine.reduce((n, r) => n + r.seconds, 0);
        const alive = mine.filter(r => r.alivePct !== null);
        return {
            group, rounds: mine.length, kills, deaths, kd: kills / Math.max(1, deaths), realmPoints,
            rpPerHour: seconds ? realmPoints / (seconds / 3600) : 0,
            alivePct: alive.length ? alive.reduce((n, r) => n + r.alivePct!, 0) / alive.length : null,
        };
    }).sort((a, b) => b.kd - a.kd || b.realmPoints - a.realmPoints);
}

/** Damage and deaths per character over each group's last `last` rounds, most damage first. */
export function fighters(runs: Run[], last: number): Fighter[] {
    const out = new Map<string, Fighter>();
    for (const group of new Set(runs.map(r => r.group))) {
        const mine = runs.filter(r => r.group === group).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-last);
        for (const r of mine) for (const m of r.members) {
            const f = out.get(m.name) ?? { name: m.name, className: m.className, group, dealt: 0, deaths: 0 };
            f.dealt += m.dealt;
            f.deaths += m.deaths;
            out.set(m.name, f);
        }
    }
    return [...out.values()].sort((a, b) => b.dealt - a.dealt);
}

const GROUPS = join(import.meta.dir, '..', 'groups');
const seen = new Map<string, { mtimeMs: number; run: Run | null }>();

/** Every round on disk. A report doesn't change once written, so each is parsed once. */
function loadRuns(): Run[] {
    const runs: Run[] = [];
    for (const group of readdirSync(GROUPS)) {
        const dir = join(GROUPS, group, 'runs');
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json')) continue;
            const path = join(dir, file);
            const { mtimeMs } = statSync(path);
            let hit = seen.get(path);
            if (hit?.mtimeMs !== mtimeMs) {
                try { hit = { mtimeMs, run: toRun(JSON.parse(readFileSync(path, 'utf-8'))) }; }
                catch { hit = { mtimeMs, run: null }; } // still being written
                seen.set(path, hit);
            }
            if (hit.run) runs.push(hit.run);
        }
    }
    return runs;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thidranki Scoreboard</title>
<style>
:root { color-scheme: light dark; --bg:#f6f5f1; --panel:#fff; --ink:#1d1c1a; --dim:#6d6a63; --line:#e2dfd8;
  --hibernia:#2f7d4f; --midgard:#2b62b8; --camelot:#b3283a; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1e1d1b; --ink:#ecebe6; --dim:#9a968d; --line:#33312d;
  --hibernia:#55b27c; --midgard:#6b9ae6; --camelot:#e0606f; } }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 system-ui,sans-serif; }
main { max-width:980px; margin:0 auto; padding:24px 16px 48px; }
header { display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; justify-content:space-between; margin-bottom:18px; }
h1 { font-size:22px; margin:0; } h2 { font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); margin:28px 0 10px; }
.seg button { font:inherit; font-size:13px; padding:4px 10px; background:var(--panel); color:var(--ink); border:1px solid var(--line); cursor:pointer; }
.seg button[aria-pressed=true] { background:var(--ink); color:var(--bg); }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
.card { background:var(--panel); border:1px solid var(--line); border-top:4px solid var(--c); border-radius:8px; padding:14px 16px; }
.card b.name { font-size:17px; color:var(--c); } .rank { float:right; color:var(--dim); font-size:13px; }
.big { font-size:34px; font-weight:650; line-height:1.15; margin:6px 0 0; font-variant-numeric:tabular-nums; } .sub { color:var(--dim); font-size:13px; }
.stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:12px; } .stats div b { display:block; font-variant-numeric:tabular-nums; font-size:16px; } .stats div span { color:var(--dim); font-size:12px; }
svg { display:block; width:100%; height:44px; margin-top:12px; }
.wrap { overflow-x:auto; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
table { border-collapse:collapse; width:100%; min-width:520px; font-variant-numeric:tabular-nums; }
th,td { padding:7px 12px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; } tr:last-child td { border-bottom:0 }
th { color:var(--dim); font-weight:500; font-size:12px; } th:first-child,td:first-child,th.l,td.l { text-align:left; }
.dot { display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--c); margin-right:7px; }
footer { color:var(--dim); font-size:13px; margin-top:22px; }
</style></head><body><main>
<header><h1>Thidranki Scoreboard</h1><div class="seg" id="seg"></div></header>
<div class="cards" id="cards"></div>
<h2>Fighters by damage</h2><div class="wrap"><table id="fighters"></table></div>
<h2>Latest rounds</h2><div class="wrap"><table id="rounds"></table></div>
<footer id="foot"></footer>
</main><script>
const NAMES = { hibernia:'Hibernia', midgard:'Midgard', camelot:'Albion' };
const WINDOWS = [[6,'Last 6'],[20,'Last 20'],[100000,'All at 24']];
const save = (k,v) => { try { localStorage.setItem(k,v) } catch {} };
const load = k => { try { return localStorage.getItem(k) } catch { return null } };
let last = Number(load('last')) || 6;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const c = g => 'var(--' + esc(g) + ',var(--dim))';
const name = g => NAMES[g] ?? esc(g);
const n = x => Math.round(x).toLocaleString('en');
function spark(points, color) {
  if (points.length < 2) return '';
  const max = Math.max(1, ...points), w = 200, h = 44;
  const xy = points.map((p,i) => (i*w/(points.length-1)).toFixed(1)+','+(h-3-p/max*(h-6)).toFixed(1)).join(' ');
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" role="img" aria-label="Realm points per round"><polyline points="'+xy+'" fill="none" stroke="'+color+'" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
}
async function draw() {
  const d = await (await fetch('/data?last='+last)).json();
  document.getElementById('seg').innerHTML = WINDOWS.map(([v,l]) => '<button data-v="'+v+'" aria-pressed="'+(v===last)+'">'+l+'</button>').join('');
  document.getElementById('cards').innerHTML = d.standings.map((s,i) => {
    const pts = d.runs.filter(r => r.group===s.group).slice(-Math.min(last,30)).map(r => r.realmPoints);
    return '<div class="card" style="--c:'+c(s.group)+'"><span class="rank">#'+(i+1)+'</span><b class="name">'+name(s.group)+'</b>'
      + '<p class="big">'+n(s.realmPoints)+'</p><div class="sub">realm points, '+s.rounds+' rounds, '+n(s.rpPerHour)+' an hour</div>'
      + '<div class="stats"><div><b>'+s.kills+'</b><span>kills</span></div><div><b>'+s.deaths+'</b><span>deaths</span></div><div><b>'+s.kd.toFixed(1)+'</b><span>kills per death</span></div></div>'
      + spark(pts, c(s.group)) + '</div>';
  }).join('') || '<p>No rounds yet.</p>';
  document.getElementById('fighters').innerHTML = '<tr><th>Fighter</th><th class="l">Class</th><th>Damage</th><th>Deaths</th></tr>'
    + d.fighters.map(f => '<tr><td><span class="dot" style="--c:'+c(f.group)+'"></span>'+esc(f.name)+'</td><td class="l">'+esc(f.className)+'</td><td>'+n(f.dealt)+'</td><td>'+f.deaths+'</td></tr>').join('');
  document.getElementById('rounds').innerHTML = '<tr><th>Started</th><th class="l">Group</th><th class="l">Strategy</th><th>Min</th><th>Kills</th><th>Deaths</th><th>Realm points</th></tr>'
    + d.runs.slice(-24).reverse().map(r => '<tr><td>'+new Date(r.startedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</td><td class="l"><span class="dot" style="--c:'+c(r.group)+'"></span>'+name(r.group)+'</td><td class="l">'+esc(r.strategy)+'</td><td>'+Math.round(r.seconds/60)+'</td><td>'+r.kills+'</td><td>'+r.deaths+'</td><td>'+r.realmPoints+'</td></tr>').join('');
  document.getElementById('foot').textContent = 'Every enemy a group damaged before it died counts as that group\\'s kill, so one death can score for two groups. Rounds shorter than 2 minutes are left out. Updated '+new Date().toLocaleTimeString()+'.';
}
document.getElementById('seg').addEventListener('click', e => { const v = Number(e.target.dataset?.v); if (v) { last = v; save('last', v); draw(); } });
draw(); setInterval(draw, 30000);
</script></body></html>`;

if (import.meta.main) {
    const port = Number(process.env.SCOREBOARD_PORT ?? 7795);
    Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === '/data') {
                const last = Math.max(1, Number(url.searchParams.get('last')) || 6);
                const runs = loadRuns().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
                return Response.json({ standings: standings(runs, last), fighters: fighters(runs, last), runs: runs.map(({ members: _, ...r }) => r) });
            }
            return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        },
    });
    console.log(`scoreboard: http://127.0.0.1:${port}`);
}
