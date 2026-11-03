// Look after the {{GROUP}} group's gear between hunts, each member at the nearest smith and vault
// keeper: out of the vault what it has grown into, on with better jewellery, what's too high to wear
// into the vault, and repairs (learnings/gear-care.md). Armour and weapons that come out stay in the
// backpack for the group's own gear pass. Run it in a town: it walks only as far as CARE_RADIUS, and
// says so for what has to wait. Many hubs have a smith but no keeper: the table in learnings/gear-care.md says where to go.
//
//   bun groups/{{GROUP}}/gear-care.ts
//   MCP: execute_code({ bot_name: '<any member>', script: 'groups/{{GROUP}}/gear-care.ts', timeout: 10 })
//
// A group with a town script calls these from there, with its own gear pass in place of wearAccessories.

import { connectGroup, formGroup, loadGroup, repairGear, runGroupScript, stashInVault, takeFromVault, wearAccessories, type ScriptContext } from '../../sdk/group';

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const main = async ({ bot, sdk }: ScriptContext) => {
    const def = loadGroup(import.meta.dir);
    const { members, opened } = await connectGroup(def, { bot, sdk });
    try {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        for (const line of await formGroup(members, def.leader)) log(`group: ${line}`);
        const reports = await Promise.all(members.map(async m => {
            const lines = [...await takeFromVault(m), ...await wearAccessories(m), ...await stashInVault(m), ...await repairGear(m)];
            for (const line of lines) log(`${m.bot}: ${line}`);
            return [m.bot, lines] as const;
        }));
        return Object.fromEntries(reports);
    } finally {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        await Promise.all(opened.map(s => s.disconnect().catch(() => null)));
    }
};

export default main;
if (import.meta.main) await runGroupScript(main, { dir: import.meta.dir, timeout: 10 * 60_000 });
