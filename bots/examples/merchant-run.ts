// Walk to the nearest merchant and sell junk from the backpack.
//
//   bun bots/examples/merchant-run.ts <bot> [sell-pattern]
//   bun bots/<bot>/merchant-run.ts [sell-pattern]                (a copy next to bot.env)
//   MCP: execute_code({ bot_name, script: 'bots/examples/merchant-run.ts', args: { pattern: 'staff' } })
//
// Junk = every backpack item except KEEP below and gear too high to wear yet, which belongs in the
// vault (bots/examples/gear-care.ts), or only items matching sell-pattern. Merchants pay half the
// shop price; zero-value items are refused.

import { keepForLater } from '../../sdk/group/gear-care';
import { runScript, type ScriptContext } from '../../sdk/runner';
import type { NearbyNpc } from '../../sdk/types';
import { scriptArgs } from '../examples/script-args';

const KEEP = /recall|ticket|potion|arrow|bolt|quiver/i;

interface Args { pattern?: string }

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const pattern = args.pattern;
    const me = sdk.getPlayer()!;
    const junk = sdk.getInventory().filter(i => pattern ? new RegExp(pattern, 'i').test(i.name) : !KEEP.test(i.name) && !keepForLater(i, me));
    if (!junk.length) return { sold: 0, why: 'nothing to sell', backpack: sdk.getInventory().map(i => i.name) };
    console.log(`junk: ${junk.map(i => `${i.count > 1 ? `${i.count}× ` : ''}${i.name}`).join(', ')}`);

    // Nearest merchant in view; otherwise walk toward the nearest merchant spawn from static data.
    let merchant: NearbyNpc | null = sdk.findNearbyNpcs(/./).find(n => n.role === 'merchant') ?? null;
    if (!merchant) {
        const spawn = bot.findNpcSpawn(/./, { guild: /merchant/i });
        if (!spawn) return { sold: 0, why: 'no merchant in view or in static data for this region' };
        console.log(`walking ${Math.round(spawn.distance ?? 0)} units to ${spawn.name} <${spawn.guild}>`);
        const walk = await bot.travelTo(spawn.name);
        if (!walk.success) return { sold: 0, why: walk.message };
        merchant = sdk.findNearbyNpc(spawn.name);
        if (!merchant) return { sold: 0, why: `${spawn.name} is not in view at its spawn point` };
    }
    console.log(`selling to ${merchant.name} <${merchant.guildName}>, ${Math.round(merchant.distance)} units away`);

    const money0 = sdk.getPlayer()!.money.totalCopper;
    const result = await bot.sellItems(merchant, item => junk.some(j => j.slot === item.slot));
    await bot.closeMerchant();
    // The close is client-side; wait for a snapshot that shows it.
    await sdk.waitForCondition(s => !s.merchant?.isOpen, 2000).catch(() => {});
    console.log(result.message);
    for (const f of result.failed) console.log(`  kept ${f.item.name}: ${f.reason}`);
    return {
        sold: result.sold.map(i => i.name),
        refused: result.failed.map(f => f.item.name),
        earned: result.earned,
        purse: `${money0}c -> ${sdk.getPlayer()!.money.totalCopper}c`,
    };
};

export default main;

if (import.meta.main) {
    const [pattern] = scriptArgs();
    await runScript(main, { args: { pattern }, timeout: 120_000 });
}
