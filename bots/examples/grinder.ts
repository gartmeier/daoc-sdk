// Grind monsters around the current spot, resting and looting between kills.
//
//   bun bots/examples/grinder.ts <bot> [seconds=120] [name-pattern]
//   bun bots/<bot>/grinder.ts [seconds=120] [name-pattern]      (a copy next to bot.env)
//   MCP: execute_code({ bot_name, script: 'bots/examples/grinder.ts', args: { seconds: 60, pattern: 'frog' } })
//
// Needs a running client (bun client/runner.ts <bot>). Respawns at the bind
// point and walks back after a death.

import { runScript, type ScriptContext } from '../../sdk/runner';
import { scriptArgs } from '../examples/script-args';

interface Args { seconds?: number; pattern?: string }

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const seconds = Number(args.seconds ?? 120);
    const durationMs = seconds * 1000;
    const pattern = args.pattern;
    if (bot.isDead()) await bot.releaseAndRespawn();
    const me = sdk.getPlayer()!;
    console.log(`${me.name} (level ${me.level} ${me.className}) grinding for ${seconds}s around ${me.x}, ${me.y}`);

    const result = await bot.grind({
        durationMs,
        pattern: pattern ? new RegExp(pattern, 'i') : undefined,
        radius: 3000,
        restBelowHealth: 50,
        restToHealth: 95,
        restBelowMana: me.maxMana > 0 ? 30 : undefined,
        respawn: true,
        onKill: (kill, stats) => {
            const p = sdk.getPlayer();
            console.log(`  #${stats.kills} ${kill.npc?.name}: +${kill.xpGained} xp${kill.moneyGained ? `, +${kill.moneyGained}c` : ''}${kill.itemsGained.length ? `, ${kill.itemsGained.map(i => i.name).join(', ')}` : ''} (${Math.round(kill.durationMs / 1000)}s, hp ${p?.healthPercent}%)`);
        },
    });
    console.log(result.message);
    // grind releases deaths itself with respawn: true; a failed release ("Could not
    // respawn", stopReason 'error') can still leave us dead. Try once more and report it.
    let respawn: string | undefined;
    if (bot.isDead()) {
        const rel = await bot.releaseAndRespawn();
        respawn = rel.message;
        console.log(`dead after grinding; release: ${rel.message}`);
    }
    return {
        kills: result.kills, failures: result.failures, deaths: result.deaths,
        xp: result.xpGained, money: result.moneyGained, levels: result.levelsGained, stopReason: result.stopReason,
        message: result.message, isDead: bot.isDead(), respawn,
    };
};

export default main;

if (import.meta.main) {
    const [seconds = '120', pattern] = scriptArgs();
    await runScript(main, { args: { seconds: Number(seconds), pattern }, timeout: Number(seconds) * 1000 + 120_000 });
}
