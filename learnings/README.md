# Learnings: rules of the API

Notes from live runs against the local OpenDAoC server. Each topic file says what was **verified live** and what is **unverified**. Treat the unverified parts as hypotheses to test with a 10-second script.

| File | Topic |
|---|---|
| [walking.md](walking.md) | walkTo, waypoints, z estimation, stuck/corrections |
| [combat.md](combat.md) | finding targets, con colours, killNpc, grind, styles |
| [spells.md](spells.md) | castSpell, buffs, interrupts, caster tactics |
| [npc-dialog.md](npc-dialog.md) | talkTo, [keywords], whisper, trainers, promotion, teleporters |
| [merchants.md](merchants.md) | open, buy, sell, merchant data offline |
| [looting.md](looting.md) | autoloot, lootNearby, inventory deltas, cloaks and jewellery, delve and gear scoring per class |
| [gear-care.md](gear-care.md) | what wears and how fast by level, repairs at a smith, the vault, the level limit on gear |
| [trading.md](trading.md) | trade, offerTrade, acceptTrade: range, stacks, 10 per side, who accepts, what resets an accept, failure reasons (not yet verified live) |
| [death-and-rest.md](death-and-rest.md) | rest, death, release, quitting |
| [grouping-and-chat.md](grouping-and-chat.md) | invite/accept, shared XP, follow, chat helpers, chat CLI, untrusted chat |
| [group-coordination.md](group-coordination.md) | groups of bots: shared picture, coordinator, role behaviours, strategies, observer reports |
| [rvr.md](rvr.md) | battlegrounds: getting in and out, PvP rules, killPlayer, the rvr-roam strategy, three groups fighting each other |
| [classes-and-races.md](classes-and-races.md) | what can be created, start points per class |
| [regions-and-zones.md](regions-and-zones.md) | coordinates, regions, zones, teleporters, zone points, static data |

## Two environments

Snippets here are written for MCP `execute_code`, where `bot`, `sdk`, `args` and `EquipmentSlot` are globals and top-level `await` works:

```typescript
const mob = bot.findKillableNpc();
const kill = mob ? await bot.killNpc(mob) : null;
return { kill, player: sdk.getPlayer() };
```

Standalone files under `bots/<name>/` destructure the same names in a `main` that `runScript` runs. Export it too, so MCP `execute_code({ bot_name, script: 'bots/<name>/x.ts', args })` can run the same file (it refuses a file that calls `runScript` without the `import.meta.main` guard):

```typescript
import { runScript, type ScriptContext } from '../../sdk/runner';
import { scriptArgs } from '../examples/script-args';

const main = async ({ bot, sdk, args = {} }: ScriptContext) => {
    const mob = bot.findKillableNpc({ pattern: args.pattern ? new RegExp(args.pattern, 'i') : undefined });
    return mob ? await bot.killNpc(mob) : null;
};

export default main;
if (import.meta.main) await runScript(main, { args: { pattern: scriptArgs()[0] }, timeout: 60_000 });
```

`runScript` owns connecting, the timeout, Ctrl+C and the final state summary. It does **not** start the game client: keep `bun client/runner.ts <name>` running.

- **Which bot:** a script next to a `bot.env` drives that bot. Anywhere else, the first argument names it: `bun bots/examples/grinder.ts <name> 60`.
- **Arguments:** `scriptArgs()` returns the positional arguments without that bot name, so a copy of an example in `bots/<name>/` is run as `bun bots/<name>/grinder.ts 60`. It drops everything starting with `-`, so `--flags` and negative numbers vanish silently: read those from `process.argv`. Never read `process.argv[2]` by a fixed index.

## Rules

1. **`bot.*` observes, `sdk.send*` dispatches.**
   - A `bot.*` result has `success`, `message` and a machine-readable `reason`. Branch on `reason`; never assume success.
   - `sdk.send*` returns once the packet is written. The server may ignore it silently (out of range, wrong target, dead), so check the effect yourself.
2. **Game failures don't throw.** Only a cancel, a script timeout or a lost gateway connection throws.
   - **One controller per bot:** the newest control connection wins. When another script, MCP call or `swarm-check` takes the bot, a `runScript` script aborts at once with `BotPreemptedError` (a `BotDisconnectedError`); the game client keeps running. `sdk/cli.ts` and `sdk/chat.ts` only observe.
3. **State is a snapshot,** refreshed about every 250 ms. `sdk.getState()` and the `find*` helpers read the last snapshot synchronously. To wait, use `sdk.waitForCondition(pred, ms)` (it throws on timeout), `sdk.waitForStateChange()`, or `Bun.sleep`. Never busy-wait: it starves the client, which must send a position heartbeat every second or the server marks it link-dead.
4. **Targets** can be an object from state, a name pattern (case-insensitive substring or RegExp; the shortest match wins, then the nearest), or an object id. Object ids are per region and are the same for every client in that region, so two bots can agree on a target by id.
5. **Messages are the server's voice.** Refusals, XP, loot, sales and dialog all arrive as `GameMessage`s.
   - `sdk.getGameMessages()` holds the last 100.
   - `sdk.getChat()` holds a 500-deep history of player chat.
   - The `bot.*` methods already parse the English texts. If something "did nothing", read the last messages.
6. **Inventory:** backpack slots 40–79, equipment 10–37 (`EquipmentSlot`). `getInventory()` lists occupied slots only; use `item.slot`.
7. **Money:** `player.money.totalCopper`. 100 copper = 1 silver, 100 silver = 1 gold.
8. **Use PrivLevel-1 accounts only.** Monsters never attack GMs, and GMs skip range and loot rules, so nothing learned with them carries over.
9. **Quit cleanly.** Stop a client with a quit action: `await sdk.sendQuit()`, MCP `disconnect_bot`, or `bun client/dev/swarm-check.ts <bot> --seconds=0 --quit`. Ctrl+C is clean only when typed in the client's own console; on Windows a SIGINT/SIGTERM sent from another process (`process.kill`, `child.kill`, `Stop-Process`) kills it outright. A dropped socket leaves the character link-dead, and logins are refused for 60 s (0x2C code 0x11). See [death-and-rest.md](death-and-rest.md).

## Where to look things up

- [sdk/API.md](../sdk/API.md): every method, option and result type.
- `data/index.ts` (import from `../../data/index` in scripts): static world data parsed from the DB dump.
  - Spawns: `findNpcSpawns({ name, guild, classType, regionId, near, radius, levelRange, realm })`.
  - Items and merchants: `getMerchantItems(listId)`, `findItemTemplates`.
  - Skills: `getSpell`, `getStylesFor(classId, spec?)`, `getSpecialization(spec)`, `specKey(name)`, `specDisplayName(name)` (a line's names: [npc-dialog.md](npc-dialog.md)).
  - Places: `getZoneAt(region, x, y)`, `nearestBindpoint`, `getZonePointsFrom(region)`.
  - Height: `estimateZ(region, x, y)`.
  - Characters: `validateCharacter`, `getStartingClasses`, `getPlayableRacesForClass`, `getStarterArmour` (what a new character really gets).
  - The data says where things spawn; `sdk.getNearbyNpcs()` says what is actually there now.
- `bots/examples/` holds working scripts for grinding, selling, casting, exploring and grouping.
