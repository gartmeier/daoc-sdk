// Roam a battleground as the {{GROUP}} group and fight enemy players (sdk/group/rvr.ts), then
// save the observer's report in runs/. The group must be inside first (./battleground.ts).
// Every member needs a running client (bun client/swarm.ts <bots...>).
//
//   bun groups/{{GROUP}}/rvr.ts [seconds=120] [--engageRadius=2500 --retreat.margin=2]
//   MCP: execute_code({ bot_name: '<any member>', script: 'groups/{{GROUP}}/rvr.ts', args: { seconds: 120 } })
//
// Flags become settings for this run only (numbers parsed). Change the strategy below, one
// setting at a time, and note each run in lab_log.md.

import { defineStrategy, groupArgs, runGroup, runGroupScript, rvrRoaming, type ScriptContext } from '../../sdk/group';

const strategy = defineStrategy(rvrRoaming, {
    name: '{{GROUP}}-rvr',
    settings: {},
});

const main = async ({ bot, sdk, args = {} }: ScriptContext) => {
    const { seconds = 120, ...settings } = args;
    return runGroup({ dir: import.meta.dir, strategy, seconds: Number(seconds), have: { bot, sdk }, settings });
};

export default main;
if (import.meta.main) {
    const { positional, flags } = groupArgs();
    const seconds = Number(positional[0] ?? 120);
    const settings = Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
    await runGroupScript(main, { dir: import.meta.dir, args: { seconds, ...settings }, timeout: (seconds + 180) * 1000 });
}
