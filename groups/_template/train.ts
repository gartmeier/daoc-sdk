// Train the {{GROUP}} group between hunts: each member spends its spec points by its own build, bots/<bot>/build.ts
// (learnings/builds.md), where it stands, because this server trains anywhere. A member without a build is reported
// and the others go on; a broken build.ts stops everyone before anyone moves.
//
//   bun groups/{{GROUP}}/train.ts [--respec] [--radius=<units>]
//   MCP: execute_code({ bot_name: '<any member>', script: 'groups/{{GROUP}}/train.ts', args: { respec: true, radius: 12000 }, timeout: 10 })
//
// --respec: a member with lines over its build's current target walks to the nearest trainer of its class, takes
// every point back and spends them again. It's free, and ends that character's own buffs and kills its pet. A respec
// needs that trainer: past TRAINER_RADIUS, or --radius=<units>, the member stops with the distance.

import { loadBuild } from '../../sdk/build';
import { connectGroup, loadGroup, runGroupScript, trainAtClassTrainer, trainFlags, type ScriptContext } from '../../sdk/group';

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const main = async ({ bot, sdk, args = {} }: ScriptContext) => {
    const def = loadGroup(import.meta.dir);
    await Promise.all(def.members.map(m => loadBuild(m.bot)));
    const { members, opened } = await connectGroup(def, { bot, sdk });
    try {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        const reports = await Promise.all(members.map(async m => {
            const trip = await trainAtClassTrainer(m, { respec: !!args.respec, radius: args.radius });
            for (const line of trip.lines) log(`${m.bot}: ${line}`);
            return [m.bot, { success: trip.success, reason: trip.reason, lines: trip.lines }] as const;
        }));
        return Object.fromEntries(reports);
    } finally {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        await Promise.all(opened.map(s => s.disconnect().catch(() => null)));
    }
};

export default main;
if (import.meta.main) {
    const flags = trainFlags(process.argv.slice(2));
    if (!flags) {
        console.error('Usage: bun groups/{{GROUP}}/train.ts [--respec] [--radius=<units>]');
        process.exit(2);
    }
    await runGroupScript(main, { dir: import.meta.dir, args: flags, timeout: 10 * 60_000 });
}
