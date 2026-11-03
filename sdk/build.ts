// A character's own build: bots/<bot>/build.ts, default-exporting a Build (data/builds/types.ts) with
// `satisfies Build`. A typo in it fails here, loudly, before a point is spent.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { buildProblems } from '../data/builds/rule';
import type { Build } from '../data/builds/types';
import { realmId } from '../data/index';
import { findBotEnv, parseEnvFile, REPO_ROOT } from './index';

const loaded = new Map<string, { path: string; mtimeMs: number; build: Build }>();

/** What is wrong with the shape, before buildProblems can read it. */
function shapeProblem(build: unknown): string | null {
    if (!build || typeof build !== 'object') return 'needs a default export: export default { className, name, targets } satisfies Build';
    const { className, name, targets } = build as Partial<Build>;
    if (typeof className !== 'string') return 'className must be a string';
    if (typeof name !== 'string') return 'name must be a string';
    if (!Array.isArray(targets)) return 'targets must be a list of { level, specs }';
    if (!targets.every(t => typeof t?.level === 'number' && t.specs && typeof t.specs === 'object')) return 'each target needs a level and specs: { level, specs: { KeyName: level } }';
    return null;
}

const readEnv = (path: string) => parseEnvFile(readFileSync(path, 'utf-8'));

/**
 * The bot.env of a bot by folder or by BOT_USERNAME, since the two can differ (roster.ts): the folder of that name
 * unless it plays another account, else the folder that names it, as findBotPassword does in the gateway. When two
 * folders name one account, the folder of that name wins, and only a caller that has the folder can tell them apart.
 */
function botEnvOf(bot: string): string | null {
    const plays = (path: string) => readEnv(path).BOT_USERNAME?.toLowerCase() === bot.toLowerCase();
    const direct = findBotEnv(bot);
    if (direct && (!readEnv(direct).BOT_USERNAME || plays(direct))) return direct;
    for (const base of [process.cwd(), REPO_ROOT]) {
        const bots = join(base, 'bots');
        if (!existsSync(bots)) continue;
        for (const folder of readdirSync(bots)) {
            const path = join(bots, folder, 'bot.env');
            if (existsSync(path) && plays(path)) return path;
        }
    }
    return direct;
}

/** The folder under bots/ of a bot named by folder or by BOT_USERNAME, or the name itself when there is none. */
export function botFolder(bot: string): string {
    const env = botEnvOf(bot);
    return env ? basename(dirname(env)) : bot;
}

/**
 * The build.ts of a bot named by folder or by BOT_USERNAME, or null when it has none. A file that fails to load, has
 * the wrong shape or has buildProblems is an error naming the file and what is wrong, not a bot that quietly trains
 * nothing. Its problems go by the REALM of its bot.env, because two realms share "Rogue". Memoized per bot until the
 * file changes.
 */
export async function loadBuild(bot: string): Promise<Build | null> {
    const env = botEnvOf(bot);
    if (!env) return null;
    const path = join(dirname(env), 'build.ts');
    if (!existsSync(path)) return null;
    const { mtimeMs } = statSync(path);
    const known = loaded.get(bot);
    if (known?.path === path && known.mtimeMs === mtimeMs) return known.build;
    // By modification time, like loadCharacter: MCP's process outlives an edit.
    const mod = await import(`${path}?v=${mtimeMs}`).catch((e: unknown) => {
        throw new Error(`${path}: failed to load: ${e instanceof Error ? e.message : String(e)}`);
    });
    const build = mod.default as Build;
    const shape = shapeProblem(build);
    if (shape) throw new Error(`${path}: ${shape}`);
    const { REALM } = readEnv(env);
    const problems = buildProblems(build, REALM ? realmId(REALM) : undefined);
    if (problems.length) throw new Error(`${path}: ${problems.join(' ')}`);
    loaded.set(bot, { path, mtimeMs, build });
    return build;
}
