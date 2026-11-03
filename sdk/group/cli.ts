#!/usr/bin/env bun
// Group CLI: the group's shared picture, without taking control of anyone.
//
//   bun sdk/group/cli.ts <group>              members, the enemies they see, group membership
//   bun sdk/group/cli.ts <group> --watch=60   observe 60 s, then print (and save) the observer's report
//   bun sdk/group/cli.ts <group> --live       the gateway's group page as text: the run, members, events, deaths
//   bun sdk/group/cli.ts <group> --wind-down [--reason=...]
//                                             ask the live run to finish its fight and end (report saved)
//
// Uses observe-mode connections, so running scripts, MCP calls and group runs
// keep control. A watch scores whatever drives the bots, coordinated or not;
// without a coordinator it infers the phase (fighting when something attacks).
// --live and --wind-down open no connection at all: they ask the gateway over
// HTTP (the leader's bot.env GATEWAY_URL and PASSWORD), which hears from the run.

import { readFileSync } from 'fs';
import { join } from 'path';
import type { ControlAnswer, GroupFrame } from '../../gateway/group-types';
import { BotActions } from '../actions';
import { deriveGatewayUrl, findBotEnv, gatewayHttpBase, parseEnvFile, REPO_ROOT } from '../index';
import { Blackboard, observeState } from './blackboard';
import { formatReport, GroupObserver, saveReport } from './observer';
import { connectBot, loadGroup } from './roster';
import { Spellbook } from './spells';
import { roleForClass } from './strategy';
import { loadCharacter } from './character';
import { groupArgs } from './runner';
import type { Activity } from './types';

const { positional, flags } = groupArgs();
const name = positional[0];
if (!name) {
    console.error('Usage: bun sdk/group/cli.ts <group> [--watch=<seconds> | --live | --wind-down [--reason=<text>]]');
    process.exit(2);
}
const dir = join(REPO_ROOT, 'groups', name);
const def = loadGroup(dir);

if (flags.live || flags['wind-down']) process.exit(await viaGateway(flags['wind-down'] ? 'wind-down' : 'live'));

const board = new Blackboard();
const conns: Awaited<ReturnType<typeof connectBot>>[] = [];
for (const m of def.members) {
    try {
        const c = await connectBot(m.bot, 'observe');
        conns.push(c);
        const caps = new Spellbook(c.sdk, new BotActions(c.sdk)).capabilities();
        const role = m.role ?? (await loadCharacter(m.bot).catch(() => null))?.role ?? roleForClass(c.sdk.getPlayer()?.className ?? '');
        const publish = () => {
            const s = c.sdk.getState();
            if (!s?.player) return;
            const activity: Activity = { kind: s.player.isSitting ? 'rest' : s.player.attacking ? 'melee' : 'unknown', targetId: s.player.targetObjectId, detail: '', since: 0 };
            const obs = observeState(s, { bot: m.bot, role, activity, capabilities: caps });
            if (obs) board.publish(obs);
        };
        c.sdk.onStateUpdate(publish);
        publish();
    } catch (e) {
        console.error(`${m.bot}: ${(e as Error).message}`);
    }
}

const watch = Number(flags.watch ?? 0);
if (watch > 0) {
    const observer = new GroupObserver(board, { group: def.name, strategy: 'observed' }).start();
    console.error(`observing ${def.name} for ${watch} s...`);
    await Bun.sleep(watch * 1000);
    const report = observer.stop();
    console.log(formatReport(report));
    console.log(`saved: ${saveReport(dir, report)}`);
} else {
    await Bun.sleep(600);
    const p = board.picture();
    const leader = p.members[0];
    console.log(`Group ${def.name} (${p.members.length}/${def.members.length} members reporting)`);
    for (const m of p.members) {
        const d = leader ? Math.round(Math.hypot(m.x - leader.x, m.y - leader.y)) : 0;
        const grouped = conns.find(c => c.sdk.getPlayer()?.name === m.name)?.sdk.getGroup().map(g => g.name) ?? [];
        console.log(`  ${m.name.padEnd(12)} ${m.className.padEnd(10)} L${String(m.level).padEnd(3)} ${m.role.padEnd(7)} hp ${String(m.hp).padStart(3)}% mana ${String(m.mana).padStart(3)}% load ${String(m.load).padStart(3)}%`
            + `${m.isDead ? ' DEAD' : ''}${m.isSitting ? ' sitting' : ''}${m.inCombat ? ' in combat' : ''}  region ${m.regionId} (${m.x}, ${m.y}) ${d ? `${d} from ${leader!.name}` : ''}`
            + `  group: ${grouped.length ? grouped.join(',') : 'none'}  can: ${['heal', 'cc', 'nuke', 'rez'].filter(k => (m.capabilities as any)[k]).join('/') || '-'}`);
    }
    console.log(`Enemies the group knows (${p.contacts.length}):`);
    for (const c of p.contacts.sort((a, b) => (b.target ? 1 : 0) - (a.target ? 1 : 0) || a.level - b.level).slice(0, 25)) {
        console.log(`  ${c.name.padEnd(22)} L${String(c.level).padEnd(3)} hp ${String(c.hp).padStart(3)}% (${c.x}, ${c.y})${c.target ? ` attacking ${c.target}` : ''}${c.stale ? ' stale' : ''}  seen by ${c.seenBy.join(', ') || 'nobody now'}`);
    }
}
for (const c of conns) await c.sdk.disconnect();
process.exit(0);

/** --live / --wind-down over the gateway's group routes, as the group's leader. Returns the exit code. */
async function viaGateway(mode: 'live' | 'wind-down'): Promise<number> {
    const fail = (text: string) => { console.error(text); return 1; };
    const id = name!;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(`"${id}" is not a group id the gateway serves (letters, digits, _ and -)`);
    const leader = def.leader ?? def.members[0]!.bot;
    const envPath = findBotEnv(leader);
    const env = envPath ? parseEnvFile(readFileSync(envPath, 'utf-8')) : {};
    const base = gatewayHttpBase(deriveGatewayUrl(env.GATEWAY_URL));
    // The leader's credential reads the whole group (the gateway checks it against bots/<leader>/bot.env).
    const auth: Record<string, string> = env.PASSWORD ? { Authorization: `Bearer ${env.PASSWORD}` } : {};
    const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any } | string> => {
        let res: Response;
        try {
            res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
        } catch (e) {
            return `the gateway at ${base} is not reachable (${(e as Error).message}); start it with: bun gateway/gateway.ts`;
        }
        const text = await res.text();
        // An old gateway answers unknown paths with its 200 text/plain help page.
        if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) return `the gateway at ${base} answered HTTP ${res.status} without JSON: it predates the group channel (restart it from this checkout)`;
        try { return { status: res.status, body: JSON.parse(text) }; } catch { return `the gateway at ${base} answered invalid JSON (HTTP ${res.status})`; }
    };
    const refused = (r: { status: number; body: any }) =>
        r.status === 404 ? `the gateway at ${base} has no group ${id} (it reads groups/<id>/group.json from its own disk)`
        : r.status === 401 ? `the gateway refused ${leader}'s password (bots/${leader}/bot.env PASSWORD): ${r.body?.error ?? 'unauthorized'}`
        : `HTTP ${r.status}: ${r.body?.error ?? 'unexpected answer'}`;

    const live = await call(`/groups/${id}/live`, { headers: auth });
    if (typeof live === 'string') return fail(live);
    if (live.status !== 200) return fail(refused(live));
    const frame = live.body as GroupFrame;
    if (frame?.v !== 1) return fail(`the gateway at ${base} speaks another group frame version (${frame?.v})`);
    const run = frame.run;
    const short = (runId: string) => runId.slice(0, 8);

    if (mode === 'wind-down') {
        if (!run || !['starting', 'live', 'stale'].includes(run.state)) return fail(`no live run of ${id} to wind down${run ? ` (the last one, ${short(run.runId)}, is ${run.state})` : ''}`);
        const reason = flags.reason && flags.reason !== 'true' ? flags.reason.slice(0, 120) : undefined;
        const answer = await call(`/groups/${id}/control`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'windDown', runId: run.runId, ...(reason ? { reason } : {}), ...(env.PASSWORD ? { password: env.PASSWORD } : {}) }),
        });
        if (typeof answer === 'string') return fail(answer);
        const a = answer.body as ControlAnswer;
        if (answer.status !== 200 || !a?.ok) return fail(`wind-down refused: ${refused(answer)}`);
        const r = a.request;
        console.log(`wind-down of run ${short(run.runId)} (${run.state}, ${run.orders.phase}): ${r.appliedAt ? 'applied by the run' : r.deliveredAt ? 'delivered to the run' : 'pending: the run picks it up with its next publish (about a second)'}`);
        console.log('It finishes the current fight, saves its report and ends; a campaign, if any, continues with its next step.');
        return 0;
    }

    try {
        const now = frame.now;
        const ago = (ms: number) => ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
        const span = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
        // UTC, like the run log (runs/<stamp>.log).
        const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);
        const contact = (objectId: number) => frame.world.filter(w => w.objectId === objectId).sort((a, b) => (b.board ? 1 : 0) - (a.board ? 1 : 0))[0];
        console.log(`Group ${frame.name} (${id}), leader ${frame.leader.bot}, gateway ${base}`);
        if (!run) {
            console.log('No run has published since the gateway started; members below are from their own clients.');
        } else {
            const o = run.orders;
            console.log(`Run ${short(run.runId)} ${run.state}${run.current ? '' : ' (not current)'}: ${run.strategy}, phase ${o.phase}, last publish ${ago(now - run.lastAt)} ago${run.error ? `; ${run.error}` : ''}`);
            if (o.objective) console.log(`  objective: ${o.objective}`);
            console.log(`  reason:    ${o.reason}`);
            if (o.focus !== null) {
                const f = contact(o.focus);
                console.log(`  focus:     ${f ? `${f.name} L${f.level}, hp ${f.hp}%${f.target ? `, on ${f.target}` : ''}` : `#${o.focus}`}`);
            }
            if (o.puller) console.log(`  puller:    ${o.puller}`);
            if (o.cc.length) console.log(`  cc:        ${o.cc.map(c => `${c.by} → ${contact(c.targetId)?.name ?? `#${c.targetId}`}`).join(', ')}`);
            if (o.waiting.length) console.log(`  waiting:   ${o.waiting.map(w => `${w.name} (${w.why})`).join(', ')}`);
            if (run.state === 'starting' || run.state === 'live' || run.state === 'stale') {
                const t = run.timing;
                console.log(`  time:      ${t.windingDown ? `winding down, hard stop in ${span(t.hardStop + run.skewMs - now)}` : `${span(t.deadline + run.skewMs - now)} left, then the current fight`}`);
            }
            const pending = run.control.find(c => !c.appliedAt);
            if (pending) console.log(`  wind-down: ${pending.deliveredAt ? 'delivered' : 'pending'}${pending.reason ? ` (${pending.reason})` : ''}`);
            if (run.result) {
                const t = run.result.totals;
                console.log(`  result:    stopped by ${run.result.stoppedBy}; kills ${t.kills}, deaths ${t.deaths}, ${t.xpPerHour} xp/h${run.result.stamp ? `; report groups/${id}/runs/${run.result.stamp}.md` : ''}`);
            }
            for (const other of frame.others ?? []) console.log(`  also kept: run ${short(other.runId)} ${other.state} (${other.strategy})`);
        }
        console.log(`Members (${frame.members.filter(m => m.player && m.client.status === 'active').length}/${frame.members.length} active in game):`);
        for (const m of frame.members) {
            const p = m.player;
            const a = m.run?.activity;
            const doing = a ? `${a.kind}${a.detail ? ` ${a.detail}` : ''}` : p ? `passive${p.isDead ? '' : p.isSitting ? ': resting' : p.inCombat ? ': fighting' : ''}` : '';
            const stats = p ? `L${String(p.level).padEnd(3)} ${p.className.padEnd(12)} hp ${String(p.hp).padStart(3)}% mana ${String(p.mana).padStart(3)}%${p.isDead ? ' DEAD' : ''}` : 'not in game';
            const client = `client ${m.client.status}${m.client.stateAge !== null ? ` (${ago(m.client.stateAge)})` : ''}, ctl ${m.client.controllers}`;
            console.log(`  ${(p?.name ?? m.charName ?? m.bot).padEnd(12)} ${(m.role ?? '-').padEnd(7)} ${stats}  ${doing}${doing ? '  ' : ''}${client}`);
        }
        if (run && run.eventSeq > 0) {
            // A frame carries the run's oldest events first: ask again for the newest 15.
            let events = run.events;
            if (!events.length || events.at(-1)!.seq < run.eventSeq) {
                const recent = await call(`/groups/${id}/live?run=${encodeURIComponent(run.runId)}&events=${Math.max(0, run.eventSeq - 15)}`, { headers: auth });
                if (typeof recent !== 'string' && recent.status === 200 && (recent.body as GroupFrame).run?.runId === run.runId) events = (recent.body as GroupFrame).run!.events;
            }
            events = events.slice(-15);
            console.log(`Run events (last ${events.length} of ${run.eventSeq}${run.lostEvents ? `, ${run.lostEvents} lost` : ''}):`);
            for (const e of events) console.log(`  ${time(e.at + run.skewMs)} ${e.member ? `${e.member}: ` : ''}${e.kind === 'orders' ? '» ' : ''}${e.text}`);
        }
        const deaths = frame.passive.events.filter(e => e.kind === 'death').slice(-5);
        if (deaths.length) {
            console.log('Recent deaths (seen by the gateway, with or without a run):');
            for (const d of deaths) console.log(`  ${time(d.at)} ${d.name}${d.by ? ` killed by ${d.by}` : ''}${d.pos ? ` at (${Math.round(d.pos.x)}, ${Math.round(d.pos.y)}) region ${d.pos.regionId}` : ''}`);
        }
        for (const n of frame.notes ?? []) console.log(`note: ${n}`);
        return 0;
    } catch (e) {
        return fail(`unexpected group frame from ${base}: ${(e as Error).message}`);
    }
}
