// Two bots group up and fight together: the leader picks a target, the
// follower assists on the same NPC, then follows the leader to the next one.
//
//   bun bots/examples/duo.ts <leader> <follower> [kills=3]
//   bun bots/<leader>/duo.ts <follower> [kills=3]                (a copy next to the leader's bot.env)
//   MCP: execute_code({ bot_name: '<leader>', script: 'bots/examples/duo.ts', args: { follower: '<follower>', kills: 3 } })
//
// Both clients must be running (bun client/runner.ts <name>, one per bot) and
// both characters must be in the same realm.

import { readFileSync } from 'fs';
import { runScript, type ScriptContext } from '../../sdk/runner';
import { BotSDK, deriveGatewayUrl, findBotEnv, parseEnvFile } from '../../sdk/index';
import { BotActions } from '../../sdk/actions';
import { scriptArgs } from '../examples/script-args';

interface Args { follower?: string; kills?: number }

/** A second control connection, for a bot runScript did not open. */
async function connectBot(name: string): Promise<{ sdk: BotSDK; bot: BotActions }> {
    const path = findBotEnv(name);
    if (!path) throw new Error(`no bots/${name}/bot.env`);
    const env = parseEnvFile(readFileSync(path, 'utf-8'));
    const sdk = new BotSDK({
        botUsername: env.BOT_USERNAME || name,
        password: env.PASSWORD,
        gatewayUrl: deriveGatewayUrl(env.GATEWAY_URL),
        connectionMode: 'control',
        autoLaunchClient: false,
        showChat: false,
    });
    try {
        await sdk.connect();
        // The gateway replays a dead client's last state, so require a fresh tick.
        const cached = sdk.getState();
        await sdk.waitForCondition(s => s.inGame && s.player !== null && (!cached || s.tick !== cached.tick), 15_000)
            .catch(() => { throw new Error(`no live client for ${name}; start it with: bun client/runner.ts ${name}`); });
    } catch (e) {
        // An open socket with auto-reconnect would keep this process alive.
        await sdk.disconnect();
        throw e;
    }
    return { sdk, bot: new BotActions(sdk) };
}

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const followerName = args.follower;
    if (!followerName) return { why: 'no follower: pass args.follower (MCP) or the follower bot name (CLI)' };
    const buddy = await connectBot(followerName);
    try {
        for (const b of [bot, buddy.bot]) if (b.isDead()) await b.releaseAndRespawn();
        const leader = sdk.getPlayer()!;
        const follower = buddy.sdk.getPlayer()!;
        if (leader.realm !== follower.realm) return { why: `different realms: ${leader.realm} vs ${follower.realm}` };

        // Meet up. A standing player is only announced when it enters view, so both take a step.
        if (Math.hypot(follower.x - leader.x, follower.y - leader.y) > 300 || follower.regionId !== leader.regionId) {
            if (follower.regionId !== leader.regionId) return { why: 'the bots are in different regions' };
            console.log(`${follower.name} walks to ${leader.name}`);
            await buddy.bot.walkTo(leader.x + 60, leader.y, { z: leader.z });
        }
        await Promise.all([bot.walkTo(leader.x + 30, leader.y), buddy.bot.walkTo(leader.x + 90, leader.y)]);
        await sdk.waitForCondition(s => s.nearbyPlayers.some(p => p.name === follower.name), 10_000).catch(() => null);

        // Group.
        if (!sdk.getGroup().some(g => g.name === follower.name)) {
            const accepted = buddy.bot.acceptGroupInvite({ timeout: 15_000 });
            const invite = await bot.invite(follower.name);
            const joined = await accepted;
            console.log(`invite: ${invite.message} / accept: ${joined.message}`);
            if (!joined.success) return { why: `grouping failed: ${joined.message}` };
        }
        await bot.groupSay(`${follower.name}, assist me`);

        const wanted = Number(args.kills ?? 3);
        const log: string[] = [];
        for (let i = 0; i < wanted; i++) {
            if (bot.isDead() || buddy.bot.isDead()) break;
            const mob = bot.getAttackers()[0] ?? bot.findKillableNpc({ radius: 3000 });
            if (!mob) { log.push('no target in range'); break; }
            // Same object id on both clients: the server assigns it per region.
            const [lead, assist] = await Promise.all([
                bot.killNpc(mob.objectId),
                Bun.sleep(1500).then(() => buddy.bot.killNpc(mob.objectId, { force: true })),
            ]);
            log.push(`${mob.name} L${mob.level}: ${lead.killed || assist.killed ? 'killed' : lead.reason} (xp ${lead.xpGained} + ${assist.xpGained})`);
            await buddy.bot.walkTo(sdk.getPlayer()!.x + 60, sdk.getPlayer()!.y);
            for (const b of [bot, buddy.bot]) {
                if (!b.isDead() && b.sdk.getPlayer()!.healthPercent < 50 && !b.getAttackers().length) await b.rest();
            }
        }
        return { leader: leader.name, follower: follower.name, group: sdk.getGroup().map(g => g.name), fights: log };
    } finally {
        await buddy.sdk.disconnect();
    }
};

export default main;

if (import.meta.main) {
    const [follower, kills = '3'] = scriptArgs();
    if (!follower) {
        console.error('Usage: bun bots/examples/duo.ts <leader> <follower> [kills]   (or bun bots/<leader>/duo.ts <follower> [kills])');
        process.exit(2);
    }
    await runScript(main, { args: { follower, kills: Number(kills) }, timeout: 300_000 });
}
