#!/usr/bin/env bun
// Many bots in one process, each with its own DAoC session and gateway connection.
//
//   bun client/swarm.ts bot1 bot2 ... [--stagger=1000] [--report=30]
//
// Every bot is supervised: an unexpected session end logs it in again with
// backoff (65 s after a 0x11 logout lockout), keeping its gateway connection.
// A bot that is replaced (save_and_disconnect), quits by action or is refused
// by the server (bad password, invalid character) is not restarted. SIGINT /
// SIGTERM quit every bot cleanly, then exit.
//
// --control=<dir>: log single bots out and in while the swarm runs (the life cycle, lfg). Every few seconds the
// swarm reads <dir>: a file `<bot>.logout` quits that bot cleanly, a file `<bot>.login` logs it in (again), also a
// bot not named at start. Each file is removed once acted on; a login for a bot still quitting waits for the quit.
// <dir>/state.json says who is online, logging in, leaving or offline. With --control the swarm keeps running
// when every bot is offline, until SIGINT/SIGTERM. `bun client/swarm-control.ts` writes the files.

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotConfigError, createBotBridge, loadBotConfig, type BotBridge } from './bridge-config';
import type { BridgeExit } from './bridge';
import { logStamp } from './log-stamp';
import { loopLagLine, startLoopLag, type LoopLag } from '../sdk/loop-lag';

export interface SwarmOptions {
    /** Delay between bot logins (ms). Default 1000. */
    staggerMs?: number;
    /** Status line interval (ms); 0 disables. Default 30 s. */
    reportMs?: number;
    log?: (msg: string) => void;
    /** A folder of `<bot>.login` / `<bot>.logout` requests and the swarm's state.json (see the head of this file). */
    controlDir?: string;
    /** How often the control folder is read (ms). Default 3 s. */
    controlPollMs?: number;
}

export type ControlState = 'online' | 'logging-in' | 'leaving' | 'offline';

/** The requests among a control folder's file names: `<bot>.login` and `<bot>.logout`, bot names lower-cased. */
export function controlRequests(files: string[]): { login: string[]; logout: string[] } {
    const login: string[] = [];
    const logout: string[] = [];
    for (const f of files) {
        const m = /^([a-z0-9]+)\.(login|logout)$/i.exec(f);
        if (!m) continue;
        (m[2]!.toLowerCase() === 'login' ? login : logout).push(m[1]!.toLowerCase());
    }
    return { login, logout };
}

export interface SwarmBot extends BotBridge {
    exit: BridgeExit | null;
}

export class Swarm {
    readonly bots: SwarmBot[] = [];
    private reportTimer: ReturnType<typeof setInterval> | null = null;
    private lag: LoopLag | null = null;
    private stopped = false;
    private readonly log: (msg: string) => void;
    private readonly runs = new Set<Promise<BridgeExit>>();
    private readonly leaving = new Set<string>();
    private controlTimer: ReturnType<typeof setInterval> | null = null;
    private stopSignal: () => void = () => {};
    private readonly stopped$ = new Promise<void>(r => { this.stopSignal = r; });

    constructor(names: string[], private readonly opts: SwarmOptions = {}) {
        this.log = opts.log ?? (msg => console.log(msg));
        for (const name of names) this.bots.push(this.makeBot(name));
    }

    private makeBot(name: string): SwarmBot {
        const config = loadBotConfig(name);
        const prefix = `[${name}]`;
        const b = createBotBridge(config, { relogin: true, log: msg => this.log(`${stamp()} ${prefix} ${msg}`) });
        return { ...b, exit: null };
    }

    private start(b: SwarmBot): Promise<BridgeExit> {
        const run = b.bridge.run().then(exit => {
            b.exit = exit;
            this.leaving.delete(b.config.botName.toLowerCase());
            this.log(`${stamp()} [${b.config.botName}] finished (${exit.code}): ${exit.reason}`);
            return exit;
        });
        this.runs.add(run);
        return run;
    }

    private find(name: string): SwarmBot | undefined {
        return this.bots.find(b => b.config.botName.toLowerCase() === name);
    }

    stateOf(b: SwarmBot): ControlState {
        if (b.exit) return 'offline';
        if (this.leaving.has(b.config.botName.toLowerCase())) return 'leaving';
        return b.client.inGame ? 'online' : 'logging-in';
    }

    /** Act on the control folder's requests once, and write its state.json. */
    pollControl(): void {
        const dir = this.opts.controlDir;
        if (!dir || this.stopped) return;
        let files: string[];
        try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            files = readdirSync(dir);
        } catch (e) {
            this.log(`${stamp()} [swarm] control ${dir}: ${(e as Error).message}`);
            return;
        }
        const { login, logout } = controlRequests(files);
        const done = (name: string, kind: 'login' | 'logout') => {
            const file = files.find(f => f.toLowerCase() === `${name}.${kind}`);
            try {
                if (file) unlinkSync(join(dir, file));
            } catch {
                // removed meanwhile
            }
        };
        for (const name of logout) {
            const b = this.find(name);
            if (b && !b.exit && !this.leaving.has(name)) {
                this.leaving.add(name);
                this.log(`${stamp()} [swarm] control: ${b.config.botName} logs out`);
                void b.bridge.stop('logout (control)');
            }
            done(name, 'logout');
        }
        for (const name of login) {
            if (logout.includes(name)) continue; // both at once: the logout first, the login on a later poll
            const b = this.find(name);
            if (b && !b.exit) {
                if (this.leaving.has(name)) continue; // still quitting: the request waits for a later poll
                done(name, 'login');
                continue;
            }
            let fresh: SwarmBot;
            try {
                fresh = this.makeBot(name);
            } catch (e) {
                this.log(`${stamp()} [swarm] control: ${name} can't log in: ${(e as Error).message}`);
                done(name, 'login');
                continue;
            }
            if (b) this.bots[this.bots.indexOf(b)] = fresh;
            else this.bots.push(fresh);
            this.log(`${stamp()} [swarm] control: ${fresh.config.botName} logs in`);
            void this.start(fresh);
            done(name, 'login');
        }
        const state = Object.fromEntries(this.bots.map(b => [b.config.botName.toLowerCase(), this.stateOf(b)]));
        try {
            const tmp = join(dir, 'state.json.tmp');
            writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, bots: state }, null, 1));
            renameSync(tmp, join(dir, 'state.json'));
        } catch (e) {
            this.log(`${stamp()} [swarm] control state: ${(e as Error).message}`);
        }
    }

    /** Start every bot (staggered); resolves when all have finished. */
    async run(): Promise<BridgeExit[]> {
        const reportMs = this.opts.reportMs ?? 30_000;
        // Each status line also says how late this process's event loop ran since the last one (sdk/loop-lag.ts).
        this.lag = startLoopLag();
        if (reportMs > 0) this.reportTimer = setInterval(() => this.log(`${stamp()} [swarm] ${loopLagLine(this.lag!.take())} | ${this.statusLine()}`), reportMs);
        const initial = [...this.bots];
        for (const [i, b] of initial.entries()) {
            if (i > 0) await Bun.sleep(this.opts.staggerMs ?? 1000);
            if (this.stopped) {
                b.exit = { code: 0, reason: 'stopped before start' };
                continue;
            }
            void this.start(b);
        }
        if (this.opts.controlDir) {
            this.pollControl();
            this.controlTimer = setInterval(() => this.pollControl(), this.opts.controlPollMs ?? 3000);
            await this.stopped$;
        }
        // Every run, those a login started meanwhile too.
        let seen = -1;
        while (seen !== this.runs.size) {
            seen = this.runs.size;
            await Promise.all(this.runs);
        }
        const exits = this.bots.map(b => b.exit ?? { code: 0, reason: 'never started' });
        if (this.reportTimer) clearInterval(this.reportTimer);
        if (this.controlTimer) clearInterval(this.controlTimer);
        this.lag?.stop();
        return exits;
    }

    statusLine(): string {
        return this.bots.map(b => {
            const state = b.exit ? `exit ${b.exit.code}` : b.client.inGame ? 'in game' : b.client.phase;
            // Server LoS checks this session answered, and how many of them the terrain blocked (session.losClear).
            const s = b.client.session;
            const los = s && s.losReplies > 0 ? `, LoS ${s.losBlocked}/${s.losReplies} blocked` : '';
            return `${b.config.botName}: ${state}, logins ${b.bridge.logins}${los}`;
        }).join(' | ');
    }

    stop(reason = 'stopped'): Promise<BridgeExit[]> {
        this.stopped = true;
        this.stopSignal();
        return Promise.all(this.bots.map(b => b.exit ? Promise.resolve(b.exit) : b.bridge.stop(reason)));
    }
}

const stamp = logStamp; // local time, like the viewer (it was UTC, an hour off in CET)

if (import.meta.main) {
    const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
    if (names.length === 0) {
        console.error('Usage: bun client/swarm.ts <bot1> <bot2> ... [--stagger=ms] [--report=seconds] [--control=<dir>]');
        process.exit(2);
    }
    let swarm: Swarm;
    try {
        swarm = new Swarm(names, {
            staggerMs: flag('stagger') ? Number(flag('stagger')) : undefined,
            reportMs: flag('report') ? Number(flag('report')) * 1000 : undefined,
            controlDir: flag('control'),
        });
    } catch (e) {
        console.error(`[swarm] ${(e as Error).message}`);
        process.exit(e instanceof BotConfigError ? 2 : 1);
    }
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
        try {
            process.on(signal, () => {
                if (stopping) return;
                stopping = true;
                console.log(`${stamp()} [swarm] ${signal}: quitting ${names.length} bot(s) cleanly`);
                void swarm.stop(signal);
            });
        } catch {
            // signal not supported on this platform
        }
    }
    process.on('unhandledRejection', reason => console.error(`${stamp()} [swarm] unhandled rejection:`, reason));
    const exits = await swarm.run();
    console.log(`${stamp()} [swarm] all bots finished: ${swarm.statusLine()}`);
    await Bun.sleep(100);
    process.exit(Math.max(0, ...exits.map(e => e.code)));
}
