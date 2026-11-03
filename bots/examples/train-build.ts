// Spend the character's spec points by its own build, bots/<bot>/build.ts (bun bots/choose-build.ts writes one), where
// it stands, because this server trains anywhere.
//
//   bun bots/examples/train-build.ts <bot> [--respec] [--radius=<units>]
//   bun bots/<bot>/train-build.ts [--respec] [--radius=<units>]     (a copy next to bot.env)
//   MCP: execute_code({ bot_name, script: 'bots/examples/train-build.ts', args: { respec: true, radius: 12000 } })
//
// --respec: when lines are over the build's current target, walk to the nearest trainer of its class in the region,
// take every point back and spend them again. It's free, and ends the character's own buffs and kills its pet. A
// respec needs that trainer: past TRAINER_RADIUS (sdk/group/train.ts), or --radius=<units>, it stops with the distance.
//
// A group does the same with bun groups/<group>/train.ts. See learnings/builds.md.

import { trainAtClassTrainer, trainFlags } from '../../sdk/group/train';
import { runScript, type ScriptContext } from '../../sdk/runner';
import { scriptArgs, scriptFlags } from '../examples/script-args';

interface Args { respec?: boolean; radius?: number }

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const trip = await trainAtClassTrainer({ sdk, bot }, { respec: args.respec, radius: args.radius });
    for (const line of trip.lines) console.log(line);
    return {
        success: trip.success,
        reason: trip.reason,
        lines: trip.lines,
        specs: sdk.getSkills().specializations.map(s => `${s.name} ${s.level}`),
        specPoints: sdk.getPlayer()?.specPoints,
    };
};

export default main;

if (import.meta.main) {
    const flags = trainFlags(scriptFlags());
    // A bare "respec" must not pass for the flag.
    if (!flags || scriptArgs().length) {
        console.error('Usage: bun bots/examples/train-build.ts <bot> [--respec] [--radius=<units>]   (or bun bots/<bot>/train-build.ts [--respec] [--radius=<units>])');
        process.exit(2);
    }
    await runScript(main, { args: flags, timeout: 180_000 });
}
