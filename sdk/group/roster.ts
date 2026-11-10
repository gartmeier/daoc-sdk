// The group's members: groups/<name>/group.json, one control connection per
// bot, and the in-game group (invites).

import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { BotActions } from '../actions';
import { BotSDK, deriveGatewayUrl, findBotEnv, parseEnvFile } from '../index';
import type { ConnectionMode } from '../types';
import { loadCharacter } from './character';
import type { Member } from './member';
import { roleForClass } from './strategy';
import type { GroupDefinition, Role } from './types';

const ROLES: readonly Role[] = ['tank', 'healer', 'support', 'nuker', 'melee'];

/** The bots a `--lineup=a,b,c` argument names, or undefined without one. */
export function lineupArg(argv: readonly string[] = process.argv): string[] | undefined {
    const arg = argv.find(a => a.startsWith('--lineup='));
    return arg ? arg.slice('--lineup='.length).split(',').map(s => s.trim()).filter(Boolean) : undefined;
}

/**
 * Read and check groups/<name>/group.json. `members` play, `bench` sits out.
 *
 * `lineup` (when not given: a `--lineup=a,b,c` in process.argv) picks those bots out of members and bench as the members, the
 * rest go to the bench, and the leader stays if it plays, else the first of the line-up leads. That is for the group
 * scripts that only act on bots (gear-template, train, battleground, ...): a run that publishes to the gateway (hunt, rvr)
 * is checked against the group.json on disk, so its line-up must be written there first (lineup.ts writeLineup).
 */
export function loadGroup(dir: string, opts: { lineup?: readonly string[] } = {}): GroupDefinition {
    const path = join(dir, 'group.json');
    if (!existsSync(path)) throw new Error(`no group.json in ${dir}; create one with: bun groups/create-group.ts <group> <bot> <bot> ...`);
    const def = JSON.parse(readFileSync(path, 'utf-8')) as GroupDefinition;
    if (!Array.isArray(def.members) || !def.members.length) throw new Error(`${path}: "members" must list at least one { "bot": "<name>" }`);
    if (def.bench !== undefined && !Array.isArray(def.bench)) throw new Error(`${path}: "bench" must be a list of { "bot": "<name>" }`);
    const seen = new Set<string>();
    for (const m of [...def.members, ...(def.bench ?? [])]) {
        if (!m.bot || !findBotEnv(m.bot)) throw new Error(`${path}: no bots/${m.bot}/bot.env`);
        if (m.role && !ROLES.includes(m.role)) throw new Error(`${path}: ${m.bot} has role "${m.role}"; use one of ${ROLES.join(', ')}`);
        if (seen.has(m.bot)) throw new Error(`${path}: ${m.bot} is listed twice (members and bench hold each bot once)`);
        seen.add(m.bot);
    }
    if (def.leader && !def.members.some(m => m.bot === def.leader)) throw new Error(`${path}: leader ${def.leader} is not a member`);
    const out: GroupDefinition = { ...def, name: def.name || basename(dir) };
    // `{ lineup: undefined }` reads group.json as it is, whatever the command line says.
    const lineup = 'lineup' in opts ? opts.lineup : lineupArg();
    if (!lineup) return out;
    return applyLineup(out, lineup, path);
}

/** The group with `lineup` as its members, in that order, and everyone else on the bench. */
export function applyLineup(def: GroupDefinition, lineup: readonly string[], where = def.name): GroupDefinition {
    const all = [...def.members, ...(def.bench ?? [])];
    const unknown = lineup.filter(b => !all.some(m => m.bot === b));
    if (unknown.length) throw new Error(`${where}: line-up ${unknown.join(', ')} not in members or bench`);
    if (!lineup.length) throw new Error(`${where}: an empty line-up`);
    const members = lineup.map(b => all.find(m => m.bot === b)!);
    const bench = all.filter(m => !lineup.includes(m.bot));
    const leader = def.leader && lineup.includes(def.leader) ? def.leader : lineup[0]!;
    return { ...def, leader, members, bench };
}

/** A control (or observe) connection to a bot by name, requiring a live client. */
export async function connectBot(name: string, mode: ConnectionMode = 'control'): Promise<{ sdk: BotSDK; bot: BotActions }> {
    const path = findBotEnv(name);
    if (!path) throw new Error(`no bots/${name}/bot.env`);
    const env = parseEnvFile(readFileSync(path, 'utf-8'));
    const sdk = new BotSDK({
        botUsername: env.BOT_USERNAME || name,
        password: env.PASSWORD,
        gatewayUrl: deriveGatewayUrl(env.GATEWAY_URL),
        connectionMode: mode,
        autoLaunchClient: false,
        showChat: env.SHOW_CHAT?.toLowerCase() !== 'false',
    });
    try {
        await sdk.connect();
        // The gateway replays a dead client's last state, so require a fresh tick.
        const cached = sdk.getState();
        await sdk.waitForCondition(s => s.inGame && s.player !== null && (!cached || s.tick !== cached.tick), 15_000)
            .catch(() => { throw new Error(`no live client for ${name}; start it with: bun client/runner.ts ${name} (or bun client/swarm.ts <bots...>)`); });
    } catch (e) {
        await sdk.disconnect();
        throw e;
    }
    return { sdk, bot: new BotActions(sdk) };
}

export interface ConnectedGroup {
    def: GroupDefinition;
    members: Member[];
    /** Connections this call opened (the caller's own connection is not in here). */
    opened: BotSDK[];
}

/**
 * Connect every member. `have` is a connection the caller already holds (runScript
 * or MCP gave it): it is used for its bot instead of opening a second one. `character` says whose
 * bots/<bot>/character.ts to load, for a run that will use them: its role then goes ahead of the
 * class's. Travel and shopping scripts don't ask, so a broken routine can't stop them.
 */
export async function connectGroup(def: GroupDefinition, have?: { bot: BotActions; sdk: BotSDK }, roleOf: (className: string) => Role = roleForClass, character?: (bot: string) => boolean): Promise<ConnectedGroup> {
    const members: Member[] = [];
    const opened: BotSDK[] = [];
    try {
        for (const m of def.members) {
            const own = have && sameBot(have.sdk, m.bot) ? have : null;
            const c = own ?? await connectBot(m.bot);
            if (!own) opened.push(c.sdk);
            const className = c.sdk.getPlayer()?.className ?? '';
            const loaded = character?.(m.bot) ? await loadCharacter(m.bot) : null;
            members.push({ bot: m.bot, role: m.role ?? loaded?.role ?? roleOf(className), sdk: c.sdk, actions: c.bot, character: loaded });
        }
    } catch (e) {
        await Promise.all(opened.map(s => s.disconnect().catch(() => {})));
        throw e;
    }
    return { def, members, opened };
}

function sameBot(sdk: BotSDK, bot: string): boolean {
    const path = findBotEnv(bot);
    const user = path ? parseEnvFile(readFileSync(path, 'utf-8')).BOT_USERNAME || bot : bot;
    return sdk.config.botUsername.toLowerCase() === user.toLowerCase();
}

/**
 * Put everyone in one in-game group led by `leader` (default: the group's leader).
 * Starts each member's accept before the invite, retries twice. Returns one line per member.
 */
export async function formGroup(members: Member[], leaderBot?: string): Promise<string[]> {
    const leader = members.find(m => m.bot === leaderBot) ?? members[0]!;
    const name = (m: Member) => m.sdk.getPlayer()?.name ?? m.bot;
    const out: string[] = [];
    // In a group someone else leads (the line-up's leader changed, or the old one left and the server passed it on):
    // every invite is refused with "You are not the leader of your group". Leave it; the members follow below.
    // The server lists the leader first in the group window (Group.MakeLeader keeps it at index 0).
    const own = leader.sdk.getGroup();
    if (own.length > 1 && own[0]!.name !== name(leader)) {
        await leader.sdk.sendCommand('/disband');
        await leader.sdk.waitForCondition(s => s.group.length === 0, 3000).catch(() => null);
        out.push(`${name(leader)}: left ${own[0]!.name}'s group to lead`);
    }
    for (const m of members) {
        if (m === leader) continue;
        if (leader.sdk.getGroup().some(g => g.name === name(m))) continue;
        // Already in another group: leave it first, or the invite is refused.
        if (m.sdk.getGroup().length) {
            await m.sdk.sendCommand('/disband');
            await m.sdk.waitForCondition(s => s.group.length === 0, 3000).catch(() => null);
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            // Invites right after the previous member joined go unanswered: pause first.
            await Bun.sleep(1500);
            const accepted = m.actions.acceptGroupInvite({ timeout: 10_000 });
            const inv = await leader.actions.invite(name(m));
            const joined = await accepted;
            out.push(`${name(m)}: ${inv.success ? 'invited' : inv.message} / ${joined.success ? 'joined' : joined.message}`);
            if (joined.success) break;
        }
    }
    return out;
}
