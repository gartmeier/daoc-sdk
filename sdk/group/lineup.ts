// Who plays: a group.json's `members` play and its `bench` sits out. pickLineup chooses the next line-up from both, and
// writeLineup moves the bots between the two lists, so the gateway, the viewer and every group script read the line-up
// from group.json as they always did.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { classSpellLines } from '../../data/class-sheet';
import { getClass, getSpell } from '../../data/index';
import { specKey } from '../../data/spec-names';
import type { Build } from '../../data/builds/types';
import { loadBuild } from '../build';
import { findBotEnv, parseEnvFile } from '../index';
import { applyLineup } from './roster';
import { roleForClass } from './strategy';
import type { GroupDefinition, GroupEntry, Role } from './types';

/** What a bot brings to a line-up. */
export interface LineupCandidate {
    bot: string;
    className: string;
    role: Role;
    /** It heals the group: role healer. */
    healer: boolean;
    /** It stands in front: role tank or melee. */
    front: boolean;
    /** It has a mesmerize at its level by its build. */
    cc: boolean;
}

/** The spec levels a build reaches by `level`: its last target at or below it, by DB key. */
function specsAt(build: Build | null, level: number): Map<string, number> {
    const target = build?.targets.filter(t => t.level <= level).at(-1);
    return new Map(Object.entries(target?.specs ?? {}).map(([name, n]) => [specKey(name), n]));
}

/**
 * Whether the class has a mesmerize at `level`: on a base line by the character's level, on a spec line by the build's
 * spec at that level (no build: base lines only).
 */
export function hasMezz(className: string, build: Build | null, level = 24): boolean {
    const cls = getClass(className);
    if (!cls) return false;
    const specs = specsAt(build, level);
    return classSpellLines(cls).some(line => {
        const reach = line.isBaseLine ? level : (specs.get(specKey(line.spec)) ?? 0);
        return line.spells.some(s => s.level <= reach && getSpell(s.spellId)?.type === 'Mesmerize');
    });
}

/** A candidate from what is known without the game: its class (bot.env CLASS), its role, its build. */
export function candidate(entry: GroupEntry, className: string, build: Build | null, level = 24): LineupCandidate {
    const role = entry.role ?? roleForClass(className);
    return { bot: entry.bot, className, role, healer: role === 'healer', front: role === 'tank' || role === 'melee', cc: hasMezz(className, build, level) };
}

/** Every member and bench bot of the group as a candidate, from bots/<bot>/bot.env and build.ts. */
export async function lineupPool(def: GroupDefinition, level = 24): Promise<LineupCandidate[]> {
    const out: LineupCandidate[] = [];
    for (const entry of [...def.members, ...(def.bench ?? [])]) {
        const env = findBotEnv(entry.bot);
        const className = env ? parseEnvFile(readFileSync(env, 'utf-8')).CLASS ?? '' : '';
        const build = await loadBuild(entry.bot).catch(() => null);
        out.push(candidate(entry, className, build, level));
    }
    return out;
}

export interface LineupChoice {
    /** The bots that play, in the order of the pool. */
    lineup: string[];
    /** Who leads: the current leader if it plays, else the first front-liner, else the first. */
    leader: string;
    /** One line on why, for a log. */
    why: string;
}

/**
 * The next line-up of `size` from the pool. First what a group needs, each by the candidate that has played fewest:
 * a healer, a front-liner, a crowd controller (a need nobody available meets is skipped). Then whoever has played fewest
 * rounds; on a tie a current member stays, then the pool's order. `available` (default: all) leaves out bots that can't
 * play now, such as one not in game.
 */
export function pickLineup(o: {
    pool: readonly LineupCandidate[];
    current: readonly string[];
    leader?: string;
    size?: number;
    played?: Readonly<Record<string, number>>;
    available?: ReadonlySet<string>;
}): LineupChoice {
    const size = o.size ?? 5;
    const played = (bot: string) => o.played?.[bot] ?? 0;
    const pool = o.pool.filter(c => !o.available || o.available.has(c.bot));
    const order = [...pool].sort((a, b) =>
        played(a.bot) - played(b.bot)
        || Number(!o.current.includes(a.bot)) - Number(!o.current.includes(b.bot))
        || o.pool.indexOf(a) - o.pool.indexOf(b));
    const picked: LineupCandidate[] = [];
    const notes: string[] = [];
    for (const need of ['healer', 'front', 'cc'] as const) {
        if (picked.length >= size || picked.some(c => c[need])) continue;
        const c = order.find(x => x[need] && !picked.includes(x));
        if (c) { picked.push(c); notes.push(`${need} ${c.bot}`); }
        else notes.push(`no ${need} available`);
    }
    for (const c of order) {
        if (picked.length >= size) break;
        if (!picked.includes(c)) picked.push(c);
    }
    const lineup = o.pool.filter(c => picked.includes(c)).map(c => c.bot);
    const leader = o.leader && lineup.includes(o.leader) ? o.leader : (picked.find(c => c.front)?.bot ?? lineup[0]!);
    const out = o.pool.filter(c => !lineup.includes(c.bot)).map(c => c.bot);
    return { lineup, leader, why: `${notes.join(', ')}; sitting out ${out.join(', ') || 'nobody'}` };
}

/**
 * Write `lineup` into dir/group.json: those bots as members (in that order), everyone else on the bench, each entry with
 * its other fields kept. Through a temporary file and a rename, so a reader never sees half a file.
 */
export function writeLineup(dir: string, lineup: readonly string[], leader?: string): GroupDefinition {
    const path = join(dir, 'group.json');
    if (!existsSync(path)) throw new Error(`no group.json in ${dir}`);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as GroupDefinition;
    const next = applyLineup(raw, lineup, path);
    if (leader) {
        if (!lineup.includes(leader)) throw new Error(`${path}: leader ${leader} is not in the line-up`);
        next.leader = leader;
    }
    // Only the fields group.json had, plus bench, in their usual order.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = k === 'members' ? next.members : k === 'bench' ? next.bench : k === 'leader' ? next.leader : v;
    if (!('leader' in out) && next.leader !== next.members[0]!.bot) out.leader = next.leader;
    if (!('bench' in out)) out.bench = next.bench;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    renameSync(tmp, path);
    return next;
}
