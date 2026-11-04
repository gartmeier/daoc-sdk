// Look after a bot's gear in town: take out of the vault what it has grown into, put on better
// jewellery, put what's too high to wear in the vault, and repair what's worn at the nearest smith.
// Armour and weapons that come out stay in the backpack for the bot's own gear pass: this has none,
// and merchant-run sells what's in the bag and fits. Run it between hunts, standing in a town: it
// walks only as far as CARE_RADIUS (sdk/group/gear-care.ts), and says so for what has to wait.
//
//   bun bots/examples/gear-care.ts <bot> [repair-below]
//   bun bots/<bot>/gear-care.ts [repair-below]                (a copy next to bot.env)
//   MCP: execute_code({ bot_name, script: 'bots/examples/gear-care.ts', args: { repairBelow: 100 } })
//
// A group does the same with bun groups/<group>/gear-care.ts, or through its town script. See learnings/gear-care.md.

import { wearAccessories } from '../../sdk/group/gear';
import { needsRepair, repairGear, stashInVault, takeFromVault } from '../../sdk/group/gear-care';
import { runScript, type ScriptContext } from '../../sdk/runner';
import { scriptArgs } from '../examples/script-args';

interface Args { repairBelow?: number }

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const me = { sdk, bot };
    const opts = { repairBelow: args.repairBelow };
    const due = needsRepair(me, opts).map(i => `${i.name} ${i.condition}%`);
    const lines = [...await takeFromVault(me), ...await wearAccessories(me), ...await stashInVault(me), ...await repairGear(me, opts)];
    for (const line of lines) console.log(line);
    return {
        due,
        lines,
        worn: sdk.getEquipment().map(i => `${i.name} L${i.level} ${i.condition}%`),
        vault: sdk.getVault().map(i => `${i.name} L${i.level}`),
    };
};

export default main;

if (import.meta.main) {
    const [below] = scriptArgs();
    await runScript(main, { args: { repairBelow: below ? Number(below) : undefined }, timeout: 180_000 });
}
