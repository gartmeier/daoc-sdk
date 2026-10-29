// Walk a loop around the current spot and report the NPCs seen, by role.
//
//   bun bots/examples/explorer.ts <bot> [radius=800] [points=6]
//   bun bots/<bot>/explorer.ts [radius=800] [points=6]           (a copy next to bot.env)
//   MCP: execute_code({ bot_name, script: 'bots/examples/explorer.ts', args: { radius: 600, points: 6 } })
//
// Also lists static spawns (DB) and zone exits for the region, so you can
// compare what the data says with what the client sees. Straight-line walking:
// there is no navmesh, so a loop through a building or a cliff can get stuck.

import { runScript, type ScriptContext } from '../../sdk/runner';
import { findNpcSpawns, getZoneAt, getZonePointsFrom } from '../../data/index';
import type { NearbyNpc } from '../../sdk/types';
import { scriptArgs } from '../examples/script-args';

interface Args { radius?: number; points?: number }

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const radius = Number(args.radius ?? 800);
    const points = Math.max(3, Number(args.points ?? 6));
    const me = sdk.getPlayer()!;
    const home = { x: me.x, y: me.y, z: me.z };
    console.log(`${me.name} in ${me.zoneName} (region ${me.regionId}), exploring a ${radius}-unit loop of ${points} points`);

    const seen = new Map<number, NearbyNpc>();
    const record = () => { for (const n of sdk.getNearbyNpcs()) if (n.name) seen.set(n.objectId, n); };
    record();

    const legs: string[] = [];
    for (let i = 0; i < points; i++) {
        const a = (2 * Math.PI * i) / points;
        const x = Math.round(home.x + radius * Math.cos(a));
        const y = Math.round(home.y + radius * Math.sin(a));
        const walk = await bot.walkTo(x, y, { stuckMs: 5000 });
        legs.push(`${i + 1}: ${walk.success ? 'ok' : walk.reason} (${Math.round(walk.distance)} left)`);
        record();
        if (bot.isDead()) break;
        if (bot.getAttackers().length) {
            const k = await bot.killNpc(bot.getAttackers()[0]!);
            legs.push(`  fought back: ${k.message}`);
        }
    }
    await bot.walkTo(home.x, home.y, { z: home.z });

    const counts: Record<string, Map<string, number>> = {};
    for (const n of seen.values()) {
        const role = n.role ?? (n.realm === 'none' ? 'monster' : 'other');
        const label = `${n.name}${n.guildName ? ` <${n.guildName}>` : ''} L${n.level}`;
        const m = (counts[role] ??= new Map());
        m.set(label, (m.get(label) ?? 0) + 1);
    }
    const byRole = Object.fromEntries(Object.entries(counts).map(([role, m]) =>
        [role, [...m].sort().map(([label, n]) => n > 1 ? `${label} x${n}` : label)]));

    const spawns = findNpcSpawns({ regionId: me.regionId, near: home, radius: radius + 1500 });
    const exits = getZonePointsFrom(me.regionId)
        .filter(z => z.sourceX || z.sourceY)
        .map(z => ({ to: z.targetRegion, x: z.sourceX, y: z.sourceY, distance: Math.round(Math.hypot(z.sourceX - home.x, z.sourceY - home.y)) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);

    return {
        zone: getZoneAt(me.regionId, home.x, home.y)?.name ?? me.zoneName,
        legs,
        npcsSeen: seen.size,
        byRole,
        staticSpawnsNearby: spawns.length,
        exits,
    };
};

export default main;

if (import.meta.main) {
    const [radius = '800', points = '6'] = scriptArgs();
    await runScript(main, { args: { radius: Number(radius), points: Number(points) }, timeout: 300_000 });
}
