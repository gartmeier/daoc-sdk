// Running a small squad (squad.ts) from its folder: groups/<squad>/rvr.ts is a few lines that call squadScript, so field
// mode starts it as any group (`bun groups/<squad>/rvr.ts Infinity [--flags]`). group.json lists the 1 to 3 members; a
// line-up is written there before the run (lineup.ts writeLineup), as for the groups.
//
// Friends to run to: every few seconds the gateway's region frame (/regions/<id>/live) gives where our realm's other bots
// stand, as a guild's chat would. Only our own realm's bots are read from it, never an enemy.

import { readFileSync } from 'fs';
import { basename } from 'path';
import type { Realm } from '../types';
import { findBotEnv, parseEnvFile } from '../index';
import type { ScriptContext } from '../runner';
import { THIDRANKI } from './keeps';
import { loadGroup } from './roster';
import { groupArgs, runGroup, runGroupScript } from './runner';
import { squadStrategy, type Friend } from './squad';

const GATEWAY = process.env.GATEWAY_HTTP ?? 'http://127.0.0.1:7780';
const FRIENDS_EVERY_MS = 5000;

/** The lane a squad starts on (SquadRules.variant): the number its folder name ends in, else 0. */
export function squadVariant(name: string): number {
    const m = name.match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
}

/** From a region frame's bots: where our realm's bots outside this squad stand, alive, with their class, level and health. Our realm is that of our own bots in it. */
export function friendsIn(bots: readonly { realm: Realm; x: number; y: number; isDead: boolean; group: { id: string } | null; name: string; hp?: number; level?: number; className?: string }[], squad: string, ownNames: ReadonlySet<string> = new Set()): Friend[] {
    const mine = bots.filter(b => b.group?.id === squad || ownNames.has(b.name));
    const realm = mine[0]?.realm;
    if (!realm || realm === 'none') return [];
    return bots.filter(b => b.realm === realm && !b.isDead && !mine.includes(b)).map(b => ({ x: b.x, y: b.y, hp: b.hp, level: b.level, className: b.className }));
}

/** Polls the region frame for friends until stopped; `friends()` is the latest answer (none until the first). */
export function friendWatch(squad: string, password: string | undefined, regionId = THIDRANKI): { friends: () => Friend[]; stop: () => void } {
    let latest: Friend[] = [];
    let stopped = false;
    const headers: Record<string, string> = password ? { Authorization: `Bearer ${password}` } : {};
    const tick = async () => {
        try {
            const res = await fetch(`${GATEWAY}/regions/${regionId}/live`, { headers, signal: AbortSignal.timeout(4000) });
            if (res.ok) latest = friendsIn(((await res.json()) as { bots?: any[] }).bots ?? [], squad);
        } catch { /* the gateway is busy or gone: keep the last answer */ }
    };
    const timer = setInterval(() => { if (!stopped) void tick(); }, FRIENDS_EVERY_MS);
    void tick();
    return { friends: () => latest, stop: () => { stopped = true; clearInterval(timer); } };
}

/** The script's main for the squad in `dir`: squadStrategy with friends from the gateway, flags as settings. */
export function squadMain(dir: string) {
    return async ({ bot, sdk, args = {} }: ScriptContext) => {
        const { seconds = 120, ...settings } = args as Record<string, unknown>;
        const def = loadGroup(dir, { lineup: undefined });
        const env = findBotEnv(def.leader ?? def.members[0]!.bot);
        const password = env ? parseEnvFile(readFileSync(env, 'utf-8')).PASSWORD : undefined;
        const watch = friendWatch(def.name, password);
        try {
            const strategy = squadStrategy({ name: `${def.name}-squad`, friends: watch.friends });
            const variant = (settings as any)['squad.variant'] ?? squadVariant(basename(dir));
            return await runGroup({ dir, strategy, seconds: Number(seconds), have: { bot, sdk }, settings: { 'squad.variant': variant, ...settings } });
        } finally {
            watch.stop();
        }
    };
}

/** groups/<squad>/rvr.ts: `export default squadMain(import.meta.dir); if (import.meta.main) await squadScript(import.meta.dir);` */
export async function squadScript(dir: string): Promise<void> {
    const { positional, flags } = groupArgs();
    const seconds = Number(positional[0] ?? 120);
    const settings = Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
    await runGroupScript(squadMain(dir), { dir, args: { seconds, ...settings }, timeout: (seconds + 180) * 1000 });
}
