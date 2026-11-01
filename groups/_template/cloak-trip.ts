// Get the {{GROUP}} group cloaks from inside a battleground (default Thidranki, region 252), which
// has no merchants: the realm's zone point out, the free city medallion to the capital, a cloak for
// each member lacking one, then the capital's town teleporter and back in through the portal keep
// (sdk/group/cloak-trip.ts). A member holding a cloak skips what it doesn't need, and each step
// looks at where each member stands now, so it can simply run again after a stop.
//
//   bun groups/{{GROUP}}/cloak-trip.ts [--stay] [--region=252] [--no-bind]
//   MCP: execute_code({ bot_name: '<any member>', script: 'groups/{{GROUP}}/cloak-trip.ts', args: { stay: true }, timeout: 30 })
//
// --stay stops in the capital, and takes everyone there, cloak or not.

import { cloakTrip, connectGroup, formGroup, groupArgs, loadGroup, runGroupScript, type ScriptContext } from '../../sdk/group';

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const main = async ({ bot, sdk, args = {} }: ScriptContext) => {
    const def = loadGroup(import.meta.dir);
    const { members, opened } = await connectGroup(def, { bot, sdk });
    try {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        for (const line of await formGroup(members, def.leader)) log(`group: ${line}`);
        return await cloakTrip(members, { regionId: Number(args.region ?? 252), stay: !!args.stay, bind: args.bind !== false, log });
    } finally {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        await Promise.all(opened.map(s => s.disconnect().catch(() => null)));
    }
};

export default main;
if (import.meta.main) {
    const { flags } = groupArgs();
    await runGroupScript(main, { dir: import.meta.dir, args: { region: flags.region, stay: !!flags.stay, bind: flags['no-bind'] ? false : undefined }, timeout: 30 * 60_000 });
}
