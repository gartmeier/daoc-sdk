#!/usr/bin/env bun
// Keeps a long run alive with nobody watching: starts its processes in order, starts each again when it ends,
// and checks the gameserver container.
//
//   bun scripts/supervisor.ts <config.json>
//
// The config (JSON):
//   { "log": "groups/supervisor.log",
//     "stopFile": "groups/supervisor.stop",           // present: start nothing again, and stop (see below)
//     "gameserver": { "compose": "server/docker/docker-compose.yml", "service": "gameserver", "port": 10300 },
//     "processes": [
//       { "name": "gateway", "cmd": ["bun", "gateway/gateway.ts"], "log": "groups/x-gateway.log",
//         "health": "http://localhost:7780/status", "killable": true },
//       { "name": "swarm", "cmd": ["bun", "client/swarm.ts", "...", "--control=groups/swarm-control"], "log": "...",
//         "after": "gateway", "controlDir": "groups/swarm-control" },
//       { "name": "field", "cmd": ["bun", "groups/field.ts", "..."], "log": "...", "after": "swarm",
//         "startDelayS": 90, "stopFile": "groups/field.stop" } ] }
//
// - A process that exits is started again after 10 s, doubling up to 5 min while it keeps ending within a minute.
//   One with a `stopFile` that exists when it ends stays down (field mode's own stop).
// - `after`: wait for that process to be up first (a `health` URL answering, or simply running), plus `startDelayS`.
// - `health` (http): three failed checks in a row while it runs, and a `killable` process is ended and started
//   again. Only the gateway is killable: a game client is never killed (a link-dead character is locked out 60 s).
// - The gameserver: its port is checked every 30 s; a container that isn't running is started (`compose up -d`).
//   The swarm logs its bots in again by itself after the server comes back.
// - The supervisor's stopFile: field mode is stopped (its stopFile), the swarm's online bots quit cleanly through
//   its control folder, then the swarm and the gateway end, and the supervisor exits.
// Every action is a line in the log.

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

interface ProcConfig {
    name: string;
    cmd: string[];
    log: string;
    after?: string;
    startDelayS?: number;
    health?: string;
    killable?: boolean;
    stopFile?: string;
    controlDir?: string;
}

interface Config {
    log: string;
    stopFile: string;
    gameserver?: { compose: string; service: string; port: number };
    processes: ProcConfig[];
}

interface Proc {
    c: ProcConfig;
    p: Subprocess | null;
    startedAt: number;
    backoffMs: number;
    nextStart: number;
    healthFails: number;
    down: boolean;
    starts: number;
}

const ROOT = join(import.meta.dir, '..');
const at = (p: string) => (/^[a-zA-Z]:|^\//.test(p) ? p : join(ROOT, p));

export function nextBackoff(prevMs: number, ranMs: number): number {
    if (ranMs >= 60_000) return 10_000;
    return Math.min(300_000, Math.max(10_000, prevMs * 2));
}

if (import.meta.main) {
    const cfgPath = process.argv[2];
    if (!cfgPath) {
        console.error('Usage: bun scripts/supervisor.ts <config.json>');
        process.exit(2);
    }
    const cfg = JSON.parse(readFileSync(at(cfgPath), 'utf8')) as Config;
    const logFile = at(cfg.log);
    const log = (msg: string) => {
        const line = `${new Date().toISOString()} ${msg}`;
        console.log(line);
        try {
            appendFileSync(logFile, line + '\n');
        } catch {
            // the console has it
        }
    };
    const procs: Proc[] = cfg.processes.map(c => ({ c, p: null, startedAt: 0, backoffMs: 10_000, nextStart: 0, healthFails: 0, down: false, starts: 0 }));
    const byName = (n: string) => procs.find(x => x.c.name === n);
    const running = (x: Proc) => x.p !== null && x.p.exitCode === null && !x.p.killed;
    const healthy = async (x: Proc): Promise<boolean> => {
        if (!running(x)) return false;
        if (!x.c.health) return true;
        try {
            const r = await fetch(x.c.health, { signal: AbortSignal.timeout(5000) });
            return r.ok;
        } catch {
            return false;
        }
    };
    const start = (x: Proc) => {
        x.starts++;
        x.startedAt = Date.now();
        x.healthFails = 0;
        appendFileSync(at(x.c.log), `\n===== ${new Date().toISOString()} supervisor start #${x.starts}: ${x.c.cmd.join(' ')}\n`);
        x.p = Bun.spawn(x.c.cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
        const sink = (stream: ReadableStream<Uint8Array> | null) => {
            if (!stream) return;
            void (async () => {
                const reader = stream.getReader();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    try {
                        appendFileSync(at(x.c.log), value);
                    } catch {
                        // log file busy: drop the chunk
                    }
                }
            })();
        };
        sink(x.p.stdout as ReadableStream<Uint8Array>);
        sink(x.p.stderr as ReadableStream<Uint8Array>);
        log(`[${x.c.name}] started (pid ${x.p.pid}, start #${x.starts})`);
        const proc = x.p;
        void proc.exited.then(code => {
            if (x.p !== proc) return;
            const ran = Date.now() - x.startedAt;
            x.p = null;
            if (x.c.stopFile && existsSync(at(x.c.stopFile))) {
                x.down = true;
                log(`[${x.c.name}] ended (code ${code}) after ${Math.round(ran / 1000)} s with ${x.c.stopFile} present: stays down`);
                return;
            }
            x.backoffMs = nextBackoff(x.backoffMs, ran);
            x.nextStart = Date.now() + x.backoffMs;
            log(`[${x.c.name}] ended (code ${code}) after ${Math.round(ran / 1000)} s: starting again in ${x.backoffMs / 1000} s`);
        });
    };

    let stopping = false;
    let gsDown = false;
    let lastGsCheck = 0;
    let lastSizes = 0;
    const portOpen = (port: number) => new Promise<boolean>(resolve => {
        const s = connect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => {
            s.destroy();
            resolve(ok);
        };
        s.setTimeout(3000, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
    const compose = async (args: string[]) => {
        const p = Bun.spawn(['docker', 'compose', '-f', at(cfg.gameserver!.compose), ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
        const text = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
        await p.exited;
        return text.trim();
    };

    const stopAll = async () => {
        stopping = true;
        log('stop file found: stopping field mode, quitting the swarm cleanly, ending the gateway');
        const field = procs.find(x => x.c.stopFile && x.c.name !== 'swarm' && x.c.name !== 'gateway');
        if (field?.c.stopFile) writeFileSync(at(field.c.stopFile), 'supervisor stop');
        const deadline = (ms: number) => Date.now() + ms;
        if (field) {
            const until = deadline(15 * 60_000);
            while (running(field) && Date.now() < until) await Bun.sleep(5000);
            log(`[${field.c.name}] ${running(field) ? 'still running after 15 min' : 'ended'}`);
        }
        const swarm = byName('swarm');
        if (swarm?.c.controlDir && running(swarm)) {
            const dir = at(swarm.c.controlDir);
            let st: { bots: Record<string, string> } | null = null;
            try {
                st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
            } catch {
                st = null;
            }
            const online = Object.entries(st?.bots ?? {}).filter(([, s]) => s !== 'offline').map(([b]) => b);
            for (const b of online) writeFileSync(join(dir, `${b}.logout`), 'supervisor stop');
            log(`[swarm] logout asked for ${online.length} bots`);
            const until = deadline(5 * 60_000);
            for (;;) {
                await Bun.sleep(5000);
                try {
                    st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
                } catch {
                    // keep the last
                }
                const left = Object.values(st?.bots ?? {}).filter(s => s !== 'offline').length;
                if (left === 0 || Date.now() > until) {
                    log(`[swarm] ${left} bots still online`);
                    break;
                }
            }
            if (Object.values(st?.bots ?? {}).every(s => s === 'offline')) swarm.p?.kill();
            else log('[swarm] left running: bots are still in game, and a client is never killed');
        }
        const gw = byName('gateway');
        if (gw && running(gw)) gw.p?.kill();
        log('supervisor stopped');
        process.exit(0);
    };

    log(`supervisor up (pid ${process.pid}): ${procs.map(x => x.c.name).join(', ')}`);
    for (;;) {
        if (!stopping && existsSync(at(cfg.stopFile))) await stopAll();
        const now = Date.now();
        for (const x of procs) {
            if (x.down || running(x) || now < x.nextStart) continue;
            if (x.c.after) {
                const dep = byName(x.c.after);
                if (dep && !(await healthy(dep))) continue;
                if (dep && x.starts === 0 && now - dep.startedAt < (x.c.startDelayS ?? 0) * 1000) continue;
            }
            start(x);
        }
        for (const x of procs) {
            if (!x.c.health || !running(x)) continue;
            if (await healthy(x)) {
                x.healthFails = 0;
                continue;
            }
            x.healthFails++;
            if (x.healthFails >= 3 && x.c.killable) {
                log(`[${x.c.name}] ${x.c.health} failed 3 checks: ending it to start again`);
                x.p?.kill();
                x.healthFails = 0;
            }
        }
        if (cfg.gameserver && now - lastGsCheck > 30_000) {
            lastGsCheck = now;
            const up = await portOpen(cfg.gameserver.port);
            if (up !== !gsDown) log(`[gameserver] port ${cfg.gameserver.port} ${up ? 'answers again' : 'does not answer'}`);
            gsDown = !up;
            if (!up) {
                const ps = await compose(['ps', '--format', '{{.Service}} {{.State}}', cfg.gameserver.service]);
                if (!/running/.test(ps)) {
                    log(`[gameserver] container: "${ps}": compose up -d`);
                    log(await compose(['up', '-d', cfg.gameserver.service]));
                }
            }
        }
        if (now - lastSizes > 3600_000) {
            lastSizes = now;
            const sizes = procs.map(x => {
                try {
                    return `${x.c.name} ${(statSync(at(x.c.log)).size / 1e6).toFixed(1)} MB`;
                } catch {
                    return `${x.c.name} -`;
                }
            });
            log(`log sizes: ${sizes.join(', ')}; starts: ${procs.map(x => `${x.c.name} ${x.starts}`).join(', ')}`);
        }
        await Bun.sleep(5000);
    }
}
