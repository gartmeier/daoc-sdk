// Starter script for {{USERNAME}} ({{CHAR_NAME}}, {{RACE}} {{CLASS}}).
// Needs a running client: bun client/runner.ts {{USERNAME}}
// Run: bun bots/{{USERNAME}}/script.ts
// Or through MCP: execute_code({ bot_name: '{{USERNAME}}', script: 'bots/{{USERNAME}}/script.ts' })
//
// Keep the shape `const main = ...; export default main; if (import.meta.main) runScript(main)`:
// MCP's `script` mode imports the default export and refuses a file that
// calls runScript() on import (it would open a second controller connection).

import { runScript, type ScriptContext } from '../../sdk/runner';
import { findNpcSpawns } from '../../data/index';

const main = async ({ bot, sdk }: ScriptContext) => {
    // Back on our feet if the last session ended dead.
    if (bot.isDead()) console.log((await bot.releaseAndRespawn()).message);

    const me = sdk.getPlayer()!;
    console.log(`${me.name}: level ${me.level} ${me.raceName} ${me.className} in ${me.zoneName} (region ${me.regionId} at ${me.x}, ${me.y}, ${me.z})`);
    console.log(`Health ${me.healthPercent}%, ${me.money.totalCopper}c, ${sdk.getInventory().length} backpack items`);

    // === YOUR SCRIPT LOGIC BELOW ===

    // Walk 300 units along +x and back.
    const start = { x: me.x, y: me.y, z: me.z };
    const out = await bot.walkTo(start.x + 300, start.y);
    console.log(`walk out: ${out.message}`);
    const back = await bot.walkTo(start.x, start.y, { z: start.z });
    console.log(`walk back: ${back.message}`);

    // Kill one easy monster (green..yellow con) near spawn.
    let mob = bot.findKillableNpc({ radius: 3000 });
    if (!mob) {
        // Nothing in view: walk toward the nearest easy spawn point from the DB dump.
        const spawn = findNpcSpawns({ regionId: me.regionId, near: me, radius: 10_000, levelRange: [0, me.level], realm: 0 })
            .find(s => s.classType === 'GameNPC' && !(s.flags & 0x10));
        if (spawn) {
            console.log(`walking ${Math.round(spawn.distance!)} units to a ${spawn.name} spawn`);
            await bot.walkTo(spawn.x, spawn.y, { z: spawn.z, tolerance: 300 });
            mob = bot.findKillableNpc({ radius: 3000 });
        }
    }
    if (!mob) {
        const names = sdk.getNearbyNpcs().slice(0, 10).map(n => `${n.name} (${n.level}${n.role ? `, ${n.role}` : ''})`);
        return { killed: false, why: 'no killable NPC within 3000 units', nearby: names };
    }
    console.log(`fighting ${mob.name} (level ${mob.level}) ${Math.round(mob.distance)} units away`);
    const kill = await bot.killNpc(mob);
    console.log(kill.message);
    if (kill.killed && bot.getAttackers().length === 0) {
        const loot = await bot.lootNearby();
        if (loot.itemsGained.length) console.log(loot.message);
        if (sdk.getPlayer()!.healthPercent < 60) console.log((await bot.rest()).message);
    }
    return { killed: kill.killed, xp: kill.xpGained, money: kill.moneyGained, items: kill.itemsGained.map(i => i.name), reason: kill.reason };

    // === END SCRIPT LOGIC ===
};

export default main;

if (import.meta.main) await runScript(main, { timeout: 120_000 });
