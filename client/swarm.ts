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

import { BotConfigError, createBotBridge, loadBotConfig, type BotBridge } from './bridge-config';
import type { BridgeExit } from './bridge';
import { logStamp } from './log-stamp';

export interface SwarmOptions {
    /** Delay between bot logins (ms). Default 1000. */
    staggerMs?: number;
    /** Status line interval (ms); 0 disables. Default 30 s. */
    reportMs?: number;
    log?: (msg: string) => void;
}

export interface SwarmBot extends BotBridge {
    exit: BridgeExit | null;
}

export class Swarm {
    readonly bots: SwarmBot[] = [];
    private reportTimer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private readonly log: (msg: string) => void;

    constructor(names: string[], private readonly opts: SwarmOptions = {}) {
        this.log = opts.log ?? (msg => console.log(msg));
        for (const name of names) {
            const config = loadBotConfig(name);
            const prefix = `[${name}]`;
            const b = createBotBridge(config, { relogin: true, log: msg => this.log(`${stamp()} ${prefix} ${msg}`) });
            this.bots.push({ ...b, exit: null });
        }
    }

    /** Start every bot (staggered); resolves when all have finished. */
    async run(): Promise<BridgeExit[]> {
        const reportMs = this.opts.reportMs ?? 30_000;
        if (reportMs > 0) this.reportTimer = setInterval(() => this.log(`${stamp()} [swarm] ${this.statusLine()}`), reportMs);
        const runs: Promise<BridgeExit>[] = [];
        for (const [i, b] of this.bots.entries()) {
            if (i > 0) await Bun.sleep(this.opts.staggerMs ?? 1000);
            if (this.stopped) {
                b.exit = { code: 0, reason: 'stopped before start' };
                runs.push(Promise.resolve(b.exit));
                continue;
            }
            runs.push(b.bridge.run().then(exit => {
                b.exit = exit;
                this.log(`${stamp()} [${b.config.botName}] finished (${exit.code}): ${exit.reason}`);
                return exit;
            }));
        }
        const exits = await Promise.all(runs);
        if (this.reportTimer) clearInterval(this.reportTimer);
        return exits;
    }

    statusLine(): string {
        return this.bots.map(b => {
            const state = b.exit ? `exit ${b.exit.code}` : b.client.inGame ? 'in game' : b.client.phase;
            return `${b.config.botName}: ${state}, logins ${b.bridge.logins}`;
        }).join(' | ');
    }

    stop(reason = 'stopped'): Promise<BridgeExit[]> {
        this.stopped = true;
        return Promise.all(this.bots.map(b => b.bridge.stop(reason)));
    }
}

const stamp = logStamp; // local time, like the viewer (it was UTC, an hour off in CET)

if (import.meta.main) {
    const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
    if (names.length === 0) {
        console.error('Usage: bun client/swarm.ts <bot1> <bot2> ... [--stagger=ms] [--report=seconds]');
        process.exit(2);
    }
    let swarm: Swarm;
    try {
        swarm = new Swarm(names, {
            staggerMs: flag('stagger') ? Number(flag('stagger')) : undefined,
            reportMs: flag('report') ? Number(flag('report')) * 1000 : undefined,
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
