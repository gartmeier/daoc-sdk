// Hunt as a group with ./strategy.ts, then save the observer's report in runs/.
// Every member needs a running client (bun client/swarm.ts <bots...>).
//
//   bun groups/{{GROUP}}/hunt.ts [seconds=60] [--minCon=-1 --maxCon=1]
//   MCP: execute_code({ bot_name: '<any member>', script: 'groups/{{GROUP}}/hunt.ts', args: { seconds: 60 } })
//
// Flags become settings for this run only (numbers parsed), e.g. --holdMs=2500.

import { groupArgs, runGroup, runGroupScript, type ScriptContext } from '../../sdk/group';
import strategy from './strategy';

const main = async ({ bot, sdk, args = {} }: ScriptContext) => {
    const { seconds = 60, ...settings } = args;
    return runGroup({ dir: import.meta.dir, strategy, seconds: Number(seconds), have: { bot, sdk }, settings });
};

export default main;
if (import.meta.main) {
    const { positional, flags } = groupArgs();
    const seconds = Number(positional[0] ?? 60);
    const settings = Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
    await runGroupScript(main, { dir: import.meta.dir, args: { seconds, ...settings }, timeout: (seconds + 180) * 1000 });
}
