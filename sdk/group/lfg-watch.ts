#!/usr/bin/env bun
// "lfg" live (lfg.ts is the pure part): a human whispers a bot of their realm, a unit takes them in, a bot steps out.
//
//   bun sdk/group/lfg-watch.ts [--groups=hibernia,camelot,midgard] [--units=hibernia] [--root=<dir>] [--control=<dir>] [--dry]
//
// --units: only those units take a human (the user's hour: --units=hibernia). --dry: answers and edits logged, not made.
//
// Every few seconds it reads, over the gateway (read only, no control), the recent chat of each online bot of the
// realms' units: whispers to it and /region lines. For a human's ask it places them (placeHuman), then:
//   1. group.json of the unit names them under "observed" (under the unit's .editing lock, so no line-up write races it);
//   2. the bot stepping out logs off through the swarm's control files (client/swarm-control.ts, S1's log-out);
//   3. the whispered bot answers (gateway /dm), and the unit's run winds down: its next sortie invites the human
//      (formGroup), with one bot fewer (field.ts counts observed members in the unit's size);
//   4. the unit leader's group window (gateway /state) says when they joined and when they left; once gone (or never
//      come within INVITE_MS), "observed" goes and the bot logs back in.
// State: <root>/groups/lfg/state.json (held bots for the life cycle to leave alone), log: <root>/groups/lfg/log.jsonl.
// The watcher never takes control of a bot and never quits a client.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestControl, DEFAULT_CONTROL_DIR } from '../../client/swarm-control';
import { findBotEnv, parseEnvFile } from '../index';
import type { GameMessage } from '../types';
import { LFG_SAY, placeHuman, readLfg, type LfgUnit } from './lfg';
import { roleForClass } from './strategy';
import type { GroupDefinition, Role } from './types';

export const ASK_CLASS_MS = 120_000;
/** Invited, not in the group by then: given up. */
export const INVITE_MS = 8 * 60_000;
/** Joined, then out of the leader's group window this long: left. */
export const LEFT_MS = 45_000;

const REALM_OF: Record<string, string> = { camelot: 'albion', midgard: 'midgard', hibernia: 'hibernia' };

export interface LfgRecord {
    name: string;
    realm: string;
    /** The bot they asked (it answers). */
    via: string;
    stage: 'class' | 'invited' | 'joined' | 'done';
    className?: string;
    unit?: string;
    stepOut?: string | null;
    asked: number;
    placedAt?: number;
    joinedAt?: number;
    lastInGroup?: number;
    end?: string;
}

/** Who said what in a whisper (`Niamh sends, "lfg"`) or a /region line (`[Region] Niamh: lfg`); null for our own. */
export function heardLine(m: Pick<GameMessage, 'type' | 'text' | 'sender'>): { from: string; text: string } | null {
    if (m.type === 'broadcast') {
        const r = /^\[Region\] (\S+): (.*)$/.exec(m.text);
        return r ? { from: r[1]!, text: r[2]! } : null;
    }
    const w = /^(\S+) sends, "(.*)"\s*$/.exec(m.text);
    if (!w || w[1] === 'You') return null;
    return { from: m.sender ?? w[1]!, text: w[2]! };
}

export interface LfgState { v: 1; records: LfgRecord[]; held: string[] }

interface Options {
    groups: string[];
    /** Only these units take a human (e.g. ['hibernia'] for the user's hour); all main groups when absent. */
    only?: string[];
    root: string;
    gateway: string;
    control: string;
    dry: boolean;
    everyMs: number;
    log: (s: string) => void;
}

export function startLfgWatch(o: Options) {
    const dir = join(o.root, 'groups', 'lfg');
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'state.json');
    let st: LfgState = { v: 1, records: [], held: [] };
    try { st = { ...st, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { /* first start */ }
    const save = () => {
        st.records = st.records.filter(r => r.stage !== 'done' || Date.now() - (r.lastInGroup ?? r.asked) < 3600_000).slice(-50);
        st.held = st.records.filter(r => r.stage === 'invited' || r.stage === 'joined').flatMap(r => (r.stepOut ? [r.stepOut] : []));
        const tmp = `${statePath}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(st, null, 2));
        renameSync(tmp, statePath);
    };
    const note = (event: string, data: Record<string, unknown>) => {
        appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify({ t: Date.now(), at: new Date().toISOString(), event, ...data })}\n`);
        o.log(`lfg ${event}: ${JSON.stringify(data)}`);
    };
    const startedAt = Date.now();
    const seen = new Set<string>();

    const get = async (path: string, headers: Record<string, string> = {}): Promise<any | null> => {
        try {
            const r = await fetch(`${o.gateway}${path}`, { headers, signal: AbortSignal.timeout(4000) });
            return r.ok ? await r.json() : null;
        } catch { return null; }
    };
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<boolean> => {
        if (o.dry) { o.log(`(dry) POST ${path} ${JSON.stringify(body)}`); return true; }
        try {
            const r = await fetch(`${o.gateway}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
            return r.ok;
        } catch { return false; }
    };
    const env = (bot: string) => { const p = findBotEnv(bot, o.root); return p ? parseEnvFile(readFileSync(p, 'utf8')) : {}; };
    const auth = (bot: string): Record<string, string> => { const pw = env(bot).PASSWORD; return pw ? { Authorization: `Bearer ${pw}` } : {}; };
    /** The gateway keys bots by account (BOT_USERNAME), the same as the folder in this repo. */
    const user = (bot: string) => env(bot).BOT_USERNAME ?? bot;
    const groupDir = (unit: string) => join(o.root, 'groups', unit);
    const readDef = (unit: string): GroupDefinition | null => { try { return JSON.parse(readFileSync(join(groupDir(unit), 'group.json'), 'utf8')); } catch { return null; } };
    const unitsOf = (g: string) => {
        const out: string[] = [];
        for (const u of [g, `${g}-2`, `${g}-s1`, `${g}-s2`, `${g}-s3`, `${g}-s4`]) if (existsSync(join(groupDir(u), 'group.json'))) out.push(u);
        return out;
    };
    const dm = (from: string, to: string, text: string) => post(`/dm/${user(from)}`, { to, text }, auth(from));

    /** Edit a unit's group.json under its .editing lock (field.ts waits on it before it picks a line-up). */
    const editGroup = (unit: string, fn: (def: GroupDefinition) => void) => {
        if (o.dry) { o.log(`(dry) edit ${unit}/group.json`); return; }
        const lock = join(groupDir(unit), '.editing');
        const mine = !existsSync(lock);
        if (mine) writeFileSync(lock, `lfg ${process.pid}`);
        try {
            const path = join(groupDir(unit), 'group.json');
            const raw = JSON.parse(readFileSync(path, 'utf8')) as GroupDefinition;
            fn(raw);
            if (raw.observed && !raw.observed.length) delete raw.observed;
            const tmp = `${path}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
            renameSync(tmp, path);
        } finally {
            if (mine) try { unlinkSync(lock); } catch { /* gone */ }
        }
    };
    const windDown = async (unit: string, reason: string) => {
        const def = readDef(unit);
        const leader = def?.leader ?? def?.members[0]?.bot;
        if (!leader) return false;
        const frame = await get(`/groups/${unit}/live`, auth(leader));
        const run = frame?.run;
        if (!run || !['starting', 'live', 'stale'].includes(run.state)) return false;
        return post(`/groups/${unit}/control`, { kind: 'windDown', runId: run.runId, reason, password: env(leader).PASSWORD }, auth(leader));
    };

    const lfgUnits = async (g: string): Promise<LfgUnit[]> => {
        const out: LfgUnit[] = [];
        for (const unit of unitsOf(g)) {
            const def = readDef(unit);
            if (!def) continue;
            const leader = def.leader ?? def.members[0]!.bot;
            const frame = await get(`/groups/${unit}/live`, auth(leader));
            const running = !!frame?.run && frame.run.current !== false && ['starting', 'live', 'stale'].includes(frame.run.state);
            out.push({
                unit, leader, running, squad: unit.includes('-s'), observed: (def.observed ?? []).map(x => x.name), requires: def.requires?.classes,
                members: def.members.map(m => { const className = env(m.bot).CLASS ?? ''; return { bot: m.bot, className, role: (m.role ?? roleForClass(className)) as Role }; }),
            });
        }
        return out;
    };

    const place = async (r: LfgRecord, g: string) => {
        const units = (await lfgUnits(g)).filter(u => !o.only?.length || o.only.includes(u.unit));
        const p = placeHuman(units, r.className!);
        if (!p) {
            note('full', { name: r.name, className: r.className, units: units.map(u => `${u.unit}${u.running ? '' : ' (down)'}${u.observed.length ? ` (has ${u.observed.join(',')})` : ''}`) });
            await dm(r.via, r.name, LFG_SAY.full);
            r.stage = 'done';
            r.end = 'full';
            return;
        }
        const u = units.find(x => x.unit === p.unit)!;
        const leaderName = (await get(`/status/${user(u.leader)}`))?.player?.name ?? u.leader;
        editGroup(p.unit, def => {
            def.observed = [...(def.observed ?? []).filter(x => x.name.toLowerCase() !== r.name.toLowerCase()), { name: r.name }];
            // To the bench: a fixed or bench-less line-up then never names a bot that is logged off.
            const out = def.members.find(m => m.bot === p.stepOut);
            if (out && def.members.length > 1) {
                def.members = def.members.filter(m => m !== out);
                def.bench = [...(def.bench ?? []).filter(m => m.bot !== out.bot), out];
            }
        });
        if (p.stepOut && !o.dry) requestControl('logout', p.stepOut, o.control);
        r.unit = p.unit;
        r.stepOut = p.stepOut;
        r.stage = 'invited';
        r.placedAt = Date.now();
        await dm(r.via, r.name, LFG_SAY.placed(leaderName));
        const wound = await windDown(p.unit, `lfg: ${r.name} joins`);
        note('placed', { name: r.name, className: r.className, unit: p.unit, stepOut: p.stepOut, why: p.why, windDown: wound, ms: r.placedAt - r.asked });
    };

    const release = (r: LfgRecord, end: string) => {
        if (r.unit) editGroup(r.unit, def => { def.observed = (def.observed ?? []).filter(x => x.name.toLowerCase() !== r.name.toLowerCase()); });
        if (r.stepOut && !o.dry) requestControl('login', r.stepOut, o.control);
        r.stage = 'done';
        r.end = end;
        note('released', { name: r.name, unit: r.unit, stepOut: r.stepOut, end, minutes: r.joinedAt ? Math.round((Date.now() - r.joinedAt) / 60_000) : 0 });
    };

    const tick = async () => {
        const now = Date.now();
        const status = await get('/status');
        const online = (bot: string) => !!status?.bots?.[user(bot)]?.inGame;
        for (const g of o.groups) {
            const realm = REALM_OF[g] ?? g;
            const units = unitsOf(g);
            const bots = [...new Set(units.flatMap(u => { const d = readDef(u); return d ? [...d.members, ...(d.bench ?? [])].map(m => m.bot) : []; }))];
            const ours = new Set(bots.map(b => (status?.bots?.[user(b)]?.player ?? '').toLowerCase()).filter(Boolean));
            // What humans said to us.
            const heard: { from: string; text: string; via: string; region: boolean }[] = [];
            for (const bot of bots) {
                if (!online(bot)) continue;
                const chat = await get(`/chat/${user(bot)}?limit=25`, auth(bot));
                for (const m of (chat?.messages ?? []) as GameMessage[]) {
                    if (m.type !== 'send' && m.type !== 'broadcast') continue;
                    if (m.receivedAt < startedAt) continue;
                    const said = heardLine(m);
                    if (!said) continue;
                    const { from, text } = said;
                    if (from.toLowerCase() === 'you' || ours.has(from.toLowerCase())) continue;
                    // /region reaches every bot of the realm: once.
                    const key = m.type === 'broadcast' ? `r:${from}:${text}:${Math.round(m.receivedAt / 5000)}` : `${bot}:${m.id}:${m.receivedAt}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    heard.push({ from, text, via: bot, region: m.type === 'broadcast' });
                }
            }
            for (const h of heard) {
                const said = readLfg(h.text);
                let r = st.records.find(x => x.name.toLowerCase() === h.from.toLowerCase() && x.stage !== 'done');
                if (!r && !said.ask) continue;
                if (h.region && !said.ask) continue;
                if (!r) {
                    r = { name: h.from, realm, via: h.via, stage: 'class', asked: now };
                    st.records.push(r);
                    note('ask', { name: h.from, via: h.via, text: h.text.slice(0, 80), region: h.region });
                }
                if (r.stage !== 'class') continue;
                r.className ??= said.className ?? undefined;
                if (r.className) await place(r, g);
                else if (said.ask) await dm(r.via, r.name, LFG_SAY.whatClass);
            }
            // Those asked for their class, placed, in the group.
            for (const r of st.records) {
                if (r.realm !== realm || r.stage === 'done') continue;
                if (r.stage === 'class') {
                    if (now - r.asked > ASK_CLASS_MS) { r.stage = 'done'; r.end = 'no class'; note('dropped', { name: r.name, why: 'never said a class' }); }
                    continue;
                }
                const def = r.unit ? readDef(r.unit) : null;
                const leader = def?.leader ?? def?.members[0]?.bot;
                const state = leader ? (await get(`/state/${user(leader)}`, auth(leader)))?.state : null;
                const inGroup = !!state?.group?.some((m: { name: string }) => m.name.toLowerCase() === r.name.toLowerCase());
                if (inGroup) {
                    r.lastInGroup = now;
                    if (r.stage === 'invited') { r.stage = 'joined'; r.joinedAt = now; note('joined', { name: r.name, unit: r.unit, ms: now - r.asked }); }
                } else if (r.stage === 'invited' && now - (r.placedAt ?? r.asked) > INVITE_MS) release(r, 'never joined');
                else if (r.stage === 'joined' && state && now - (r.lastInGroup ?? now) > LEFT_MS) release(r, 'left');
            }
        }
        save();
    };

    let busy = false;
    let stopped = false;
    const timer = setInterval(async () => {
        if (busy || stopped) return;
        busy = true;
        try { await tick(); } catch (e) { o.log(`lfg tick: ${(e as Error).message}`); } finally { busy = false; }
    }, o.everyMs);
    return { stop: () => { stopped = true; clearInterval(timer); }, state: () => st };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const flag = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
    const root = flag('root') ?? join(import.meta.dir, '..', '..');
    startLfgWatch({
        groups: (flag('groups') ?? 'hibernia,camelot,midgard').split(','),
        only: flag('units')?.split(','),
        root,
        gateway: flag('gateway') ?? process.env.GATEWAY_HTTP ?? 'http://127.0.0.1:7780',
        control: flag('control') ?? DEFAULT_CONTROL_DIR,
        dry: args.includes('--dry'),
        everyMs: Number(flag('every') ?? 4000),
        log: s => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`),
    });
    console.log('lfg watch: listening for whispers and /region asks');
}
