#!/usr/bin/env bun
// Log single bots of a running swarm out and in (client/swarm.ts --control=<dir>).
//
//   bun client/swarm-control.ts login <bot> [<bot> ...]  [--dir=groups/swarm-control] [--wait=120]
//   bun client/swarm-control.ts logout <bot> [<bot> ...] [--dir=...] [--wait=120]
//   bun client/swarm-control.ts status [--dir=...]
//
// login/logout write a request file per bot; the swarm acts on it within a few seconds. With --wait=<s> this
// waits until state.json shows each bot online (login) or offline (logout), and exits 1 if one isn't by then.
// A logout is a clean quit: after combat it can take up to 60 s ("You will quit after sitting for N seconds").

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlState } from './swarm';

export const DEFAULT_CONTROL_DIR = join(import.meta.dir, '..', 'groups', 'swarm-control');

export interface ControlSnapshot {
    at: string;
    pid: number;
    bots: Record<string, ControlState>;
}

/** The swarm's last state.json, or null without one. */
export function readControlState(dir = DEFAULT_CONTROL_DIR): ControlSnapshot | null {
    try {
        return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as ControlSnapshot;
    } catch {
        return null;
    }
}

/** Ask the swarm to log a bot in or out (it acts within its poll interval). */
export function requestControl(kind: 'login' | 'logout', bot: string, dir = DEFAULT_CONTROL_DIR): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${bot.toLowerCase()}.${kind}`), new Date().toISOString());
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
    const [cmd, ...rest] = args.filter(a => !a.startsWith('--'));
    const dir = flag('dir') ?? DEFAULT_CONTROL_DIR;
    if (cmd === 'status') {
        const st = readControlState(dir);
        if (!st) {
            console.log(`no state.json in ${dir}: is a swarm running with --control?`);
            process.exit(1);
        }
        const by = new Map<string, string[]>();
        for (const [bot, state] of Object.entries(st.bots)) by.set(state, [...(by.get(state) ?? []), bot]);
        console.log(`swarm pid ${st.pid}, state at ${st.at}`);
        for (const [state, bots] of by) console.log(`  ${state} (${bots.length}): ${bots.join(' ')}`);
        process.exit(0);
    }
    if ((cmd !== 'login' && cmd !== 'logout') || rest.length === 0) {
        console.error('Usage: bun client/swarm-control.ts login|logout <bot> [...] [--dir=<dir>] [--wait=<s>] | status');
        process.exit(2);
    }
    const bots = rest.map(b => b.toLowerCase());
    for (const b of bots) requestControl(cmd, b, dir);
    console.log(`${cmd} requested: ${bots.join(' ')}`);
    const waitS = Number(flag('wait') ?? 0);
    if (waitS > 0) {
        const want: ControlState = cmd === 'login' ? 'online' : 'offline';
        const until = Date.now() + waitS * 1000;
        let left = bots;
        while (Date.now() < until) {
            const st = readControlState(dir);
            left = bots.filter(b => st?.bots[b] !== want);
            if (left.length === 0) break;
            await Bun.sleep(2000);
        }
        if (left.length) {
            console.log(`not ${want} after ${waitS} s: ${left.join(' ')}`);
            process.exit(1);
        }
        console.log(`all ${want}`);
    }
}
