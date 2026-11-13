// Send a group in a battleground back to its own portal keep's arrival point (sdk/group/battleground.ts goHome): the
// dead release, which lands them there, and the living walk round aggro zones and enemy keeps, each on its own. Between
// pair rounds (groups/pair-rounds.sh), so every round starts from the same place.
//
//   bun groups/go-home.ts <group>
//
// It takes control of every member, like any group script: never while that group runs a hunt.

import { join } from 'node:path';
import { connectGroup, goHome, loadGroup, runGroupScript, type ScriptContext } from '../sdk/group';

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const dirOf = (group: string) => join(import.meta.dir, group);

const main = async ({ bot, sdk, args = {} }: ScriptContext) => {
    const def = loadGroup(dirOf(String(args.group)));
    // A human in the group (observed, sdk/group/observed.ts): the bots stay with them and the next sortie starts where
    // they stand; walking home would leave the human alone across the map (the user, 2026-11-13 21:00). The dead wait
    // there too, for the next sortie's rez or release.
    if (def.observed?.length) {
        log(`${def.name}: ${def.observed.map(o => o.name).join(', ')} in the group: staying where we are`);
        return { success: true, message: `${def.name} stays with ${def.observed.map(o => o.name).join(', ')}` };
    }
    const { members, opened } = await connectGroup(def, { bot, sdk });
    try {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        const problem = await goHome(members, { log });
        return problem ? { success: false, message: problem } : { success: true, message: `${def.name} is home` };
    } finally {
        await Promise.all(members.map(m => m.sdk.sendStop().catch(() => null)));
        await Promise.all(opened.map(s => s.disconnect().catch(() => null)));
    }
};

export default main;
if (import.meta.main) {
    const group = process.argv[2];
    if (!group || group.startsWith('-')) {
        console.error('usage: bun groups/go-home.ts <group>');
        process.exit(2);
    }
    await runGroupScript(main, { dir: dirOf(group), args: { group }, timeout: 300_000 });
}
