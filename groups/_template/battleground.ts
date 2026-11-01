// Take the {{GROUP}} group into a battleground (default Thidranki, region 252, levels 20-24):
// the town teleporter to the realm's portal keep, bind there, the free medallion, then the
// keep's battleground teleporter (sdk/group/battleground.ts). Members already inside are left
// alone, and steps already done are skipped, so it can simply run again.
//
//   bun groups/{{GROUP}}/battleground.ts [--via=x,y[,z]] [--region=252] [--no-bind]
//   MCP: execute_code({ bot_name: '<any member>', script: 'groups/{{GROUP}}/battleground.ts', args: { via: [x, y, z] }, timeout: 10 })
//
// Every member must stand within 4000 of a town teleporter of its realm, or at the portal keep.
// --via (a point by a town teleporter) first walks the members who stand by neither there,
// together: one region, within 1500 of the first of them, legs around aggressive mobs,
// regrouping at each.
// The others wait, so a run again after a missed port does not walk them back out.

import { connectGroup, enterBattleground, formGroup, groupArgs, loadGroup, runGroupScript, type ScriptContext } from '../../sdk/group';

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const main = async ({ bot, sdk, args = {} }: ScriptContext) => {
    const def = loadGroup(import.meta.dir);
    const { members, opened } = await connectGroup(def, { bot, sdk });
    try {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        for (const line of await formGroup(members, def.leader)) log(`group: ${line}`);
        const regionId = Number(args.region ?? 252);
        let via: { x: number; y: number; z?: number } | undefined;
        if (args.via) {
            const [x, y, z] = (Array.isArray(args.via) ? args.via : String(args.via).split(',')).map(Number);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, message: `--via wants x,y or x,y,z, not ${args.via}` };
            via = Number.isFinite(z) ? { x: x!, y: y!, z } : { x: x!, y: y! };
        }
        return await enterBattleground(members, { regionId, bind: args.bind !== false, via, log });
    } finally {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        await Promise.all(opened.map(s => s.disconnect().catch(() => null)));
    }
};

export default main;
if (import.meta.main) {
    const { flags } = groupArgs();
    await runGroupScript(main, { dir: import.meta.dir, args: { via: flags.via, region: flags.region, bind: flags['no-bind'] ? false : undefined }, timeout: 20 * 60_000 });
}
