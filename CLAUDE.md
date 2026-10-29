# DAoC Bot Agent Guide

You play Dark Age of Camelot on a local OpenDAoC server by writing bot scripts. Start small, make one step toward the goal, then learn and grow the script as you go. Characters are **persistent**: every session continues where the last one ended.

Before writing logic for a topic (walking, combat, spells, merchants, looting, death, classes, zones, grouping/chat), read its file in [learnings/](learnings/README.md). Exact signatures are in [sdk/API.md](sdk/API.md).

## First-time setup

1. **Server.** The server source and DB dump are git submodules: if `server/core/GameServer` or `server/db/opendaoc-db-core` is empty, run `git submodule update --init server/core server/db` first (`bun bots/create-bot.ts` and `data/` need them too). Check `docker compose -f server/docker/docker-compose.yml ps`. If the gameserver is not up: `bun run server:up`, then `bun run server:setup`. Done when TCP 10300 answers (setup waits for it).
2. **Bot.** Ask the user for a name: up to 12 letters and digits. If they skip it, omit the name and a random one is used. Choose a realm and class from `bun bots/create-bot.ts --list` (default: Albion Fighter). Then run:
   ```bash
   bun bots/create-bot.ts <name> [--realm=midgard] [--class=Mage] [--race=..] [--gender=..]
   ```
   This writes `bots/<name>/bot.env` (credentials plus character), `script.ts` and `lab_log.md`. The account and character are created on first login.
3. **Gateway.** `curl -s localhost:7780/status` must answer; otherwise start `bun gateway/gateway.ts` in the background. It listens on 127.0.0.1 only and checks no passwords there; see README "Gateway access" for `GATEWAY_HOSTNAME` / `GATEWAY_AUTH`.
4. **Client.** Start `bun client/runner.ts <name>` in the background and leave it running, one process per bot. It is ready when its log shows `in game (phase playing)`.
5. **State.** `bun sdk/cli.ts <name>` shows position, health, inventory, skills and nearby NPCs. Done when it prints `In Game: true`.

MCP `execute_code` does steps 3–4 itself. Scripts and the CLIs never start a client.

## Session loop

1. **Look** before acting: `bun sdk/cli.ts <name>`. If the character is dead, the first action is `bot.releaseAndRespawn()`.
2. **Write** one focused script per task in `bots/<name>/` (copy from `bots/examples/`). Import `runScript` from `../../sdk/runner`. Keep the examples' shape so the file also runs through MCP `script` mode:
   ```typescript
   import { runScript, type ScriptContext } from '../../sdk/runner';
   import { scriptArgs } from '../examples/script-args';

   const main = async ({ bot, sdk, args }: ScriptContext) => { /* ... */ };
   export default main;
   if (import.meta.main) await runScript(main, { args: { seconds: Number(scriptArgs()[0] ?? 60) }, timeout: 120_000 });
   ```
   `scriptArgs()` (from `../examples/script-args`) drops the bot name only when it came from argv, so a copy takes `bun bots/<name>/grinder.ts 60` while the original takes `bun bots/examples/grinder.ts <name> 60`.
3. **Run** it: `bun bots/<name>/<script>.ts`. Use a short `timeout` first:

   | Duration | When |
   |---|---|
   | 10–30 s | new script, untested logic, debugging |
   | 1–3 min | the approach worked once |
   | 5+ min | proven grind; rarely |

   A failed 5-minute run costs more than five 30-second diagnostic runs.
4. **Check** the result's `success`/`reason`/`message`, the printed state summary, and `bun sdk/cli.ts <name>` again.
5. **Record** what you learned in `bots/<name>/lab_log.md`, then improve the script.

## MCP tools

| Tool | Use |
|---|---|
| `execute_code({ bot_name, code })` | Run TypeScript on a bot. Globals: `bot`, `sdk`, `args`, `EquipmentSlot`. `return` a JSON value. Starts the gateway and the client if needed (first login can take a minute). |
| `execute_code({ bot_name, script: 'bots/<name>/x.ts', args })` | Run a module whose default export is `async ({ bot, sdk, args }) => result`. A `runScript` file is accepted only in the guarded form above (`export default main; if (import.meta.main) runScript(main)`); the template and every example are written that way. |
| `list_bots()` / `disconnect_bot(name)` | Connected bots / disconnect; a client that execute_code started quits cleanly. |

```typescript
execute_code({
  bot_name: "mybot",
  code: `
    const mob = bot.findKillableNpc();
    if (!mob) return sdk.getNearbyNpcs().slice(0, 10).map(n => [n.name, n.level, n.role]);
    const kill = await bot.killNpc(mob);
    return { kill: kill.message, hp: sdk.getPlayer().healthPercent };
  `,
  timeout: 2,   // minutes
});
```

A new call for the same bot cancels the one still running. Every result includes a world summary (`world: 'brief' | 'full' | 'none'`). Pass values through `args`, not by string interpolation. Snippets in `learnings/` use these globals; standalone files destructure `{ bot, sdk }` from `runScript` instead.

## Action semantics

- **`sdk.send*` = dispatched.** Success means the headless client wrote the packets. It does **not** prove the server applied them. After a raw send, observe the effect yourself (`sdk.waitForCondition`, chat messages, inventory).
- **`bot.*` = observed.** Each method watches for evidence (position, health, inventory, purse, server messages) and returns `{ success, message, reason, ... }`.
  - Game failures never throw. Check `success` and branch on `reason`: `stuck`, `died`, `refused`, `no_power`, `interrupted`, `out_of_range`, `insufficient_funds`, ...
  - Only a cancel, a script timeout or, in `runScript`, a lost gateway connection throws (`BotDisconnectedError`, or its subclass `BotPreemptedError` when another controller took over).
- **State reads** (`get*`, `find*`) are synchronous reads of the last snapshot, which is refreshed about every 250 ms. Await every `Promise`.
- **One controller per bot.** The newest control connection (a `runScript` file, MCP `execute_code`, `swarm-check`) wins, and the older one is cut off. `bun sdk/cli.ts` and `bun sdk/chat.ts <name> "text"` (`--to <player>`, `--watch`) only observe and never take over.
- **Coordinates:** `x`/`y` are the ground plane in region coordinates and `z` is height. Headings run 0..4095. Full run speed is ~191 units/s.
- **Slots:** backpack 40–79, equipment 10–37. Pass `item.slot`, never an array index.

### bot.* quick reference

| Method | What it does |
|---|---|
| `walkTo(x, y, {z, tolerance})` / `followPath(points)` / `travelTo(name \| point)` | Walk in straight lines; re-issues after server corrections |
| `findKillableNpc({pattern, minCon, maxCon, radius})` | Best monster nearby (default con green..yellow) |
| `killNpc(npc, {styles})` | Approach, attack, chase, wait for death; reports xp/money/items |
| `castSpell(spell, target?)` | Approach to range, cast, observe completion/damage |
| `grind({durationMs, pattern, respawn, onKill})` | Hunt/kill/loot/rest loop around an anchor |
| `rest({healthPercent, manaPercent})` / `releaseAndRespawn()` | Sit to regenerate / respawn at the bind point |
| `lootNearby()` | Pick up ground loot (autoloot usually already did) |
| `talkTo(npc)` / `whisper(npc, keyword)` / `navigateDialog(npc, [kw])` | NPC dialog and its [keywords] |
| `openMerchant` / `buyItem` / `sellItem` / `sellItems(m, filter)` | Shops (sell price is 50 % of value) |
| `trainSpec(trainer, spec, levels)` | Spend specialization points |
| `equipItem` / `unequipItem` / `useItem` / `dropItem` / `destroyItem` | Items |
| `invite` / `acceptGroupInvite` / `groupSay` / `follow` / `say` / `send` | Social |

From `sdk.*`, the common calls are `getState`, `getPlayer`, `getInventory`, `findNearbyNpc(s)`, `getNearbyLoot`, `getSkills`, `findSpell`, `getMerchant`, `getGroup`, `getChat`, `waitForChat`, `waitForCondition`. The full list is in sdk/API.md.

## Troubleshooting

- **"No game client is attached"** means nothing is publishing state for the bot. Start `bun client/runner.ts <name>` and wait for `in game`. Its log is in your shell, or in `bots/<name>/client.log` when MCP started it.
- **Login refused with 0x2C code 0x11 / `AccountIsInLogoutProcedure`:** the character is still in the world, link-dead. This happens when a client dropped without quitting. Wait 60 s and retry; the runner backs off on its own.
  - To stop a client cleanly, use a quit action: `await sdk.sendQuit()`, MCP `disconnect_bot`, or `bun client/dev/swarm-check.ts <bot> [<bot> ...] --seconds=0 --quit` (the runner logs out, then exits 0). Ctrl+C is clean only when typed in the client's own console. Never kill it outright.
  - On Windows, a SIGINT/SIGTERM sent from another process (`process.kill`, `child.kill`, `Stop-Process`, `taskkill`) terminates bun abruptly and causes the 60 s lockout. `kill -INT` from Git Bash does not reach bun at all. A client in a background shell is stopped with a quit action.
  - After combat, quitting can take up to 60 s ("You will quit after sitting for N seconds").
- **`BotPreemptedError` ("Pre-empted by another controller"):** a second script, MCP call or `swarm-check` took control of the same bot, so this script was aborted at once. The game client is fine and keeps running; run one controller per bot, or run the script again. Under MCP the cut-off call's remaining actions fail, and the next `execute_code` takes control back.
- **The client goes link-dead or the bot freezes** after more than ~5 s without position updates; the server then misreads the next packets. Keep the event loop free: waits must `await` (`sdk.waitForCondition`, `Bun.sleep`), never busy-loop.
- **Monsters ignore the bot, and the PvE results look wrong:** the account is a GM (PrivLevel > 1). Mobs never attack GMs, and GMs skip range and loot checks. Use fresh PrivLevel-1 accounts for gameplay.
- **Wrong height, "too far away" at close range, or melee that never lands:** there is no terrain data or navmesh. z is estimated from nearby spawn heights (`estimateZ`, typical error 25 units, worst cases hundreds).
  - Pass `z` when you know it, for example from an NPC's position.
  - `killNpc`/`walkToObject` adopt the target's z.
- **Walks cut through walls and cliffs:** walking is in straight lines and the server doesn't check collisions. A route that looks fine on the map can still fail with `stuck` (no progress for 8 s). Add waypoints with `followPath`.
- **Walking onto a zone exit does nothing:** the server uses a zone point only when the client sends 0x90 PlayerRegionChangeRequest, which the SDK can't send yet. Change regions with teleporters (`bot.whisper('Master Visur', 'Camelot')`). Zone boundaries inside a region work by walking. See learnings/regions-and-zones.md.
- **Line of sight is not real:** the client answers every server LoS check with "clear", so spells and aggro behave as if nothing blocks the view.
- **Casters get interrupted:** every melee hit interrupts casting ("your spell is interrupted"). Pull from range and fall back to melee (`bots/examples/caster.ts`). There is no kiting helper yet.
- **An NPC "did not answer" a whisper:** NPCs silently ignore a whisper within 1.5 s of the last one they accepted from you, and the server refuses whispers < 500 ms apart ("Slow down! ..."). `bot.whisper` spaces its own whispers and retries; after a raw `sdk.sendWhisper`, wait 1.6 s yourself.
- **The bot keeps walking after a script ended:** a timeout, Ctrl+C or MCP cancel stops the mover, but a script that ends while a raw `sdk.sendMoveTo` is still running leaves it going. Run `await sdk.sendStop()`.
- **A character name is taken or invalid:** names are unique server-wide, letters only, at least 3. Set `CHAR_NAME=` in bot.env.
- **Character creation fails for some classes:** Valkyrie, Bainshee, Heretic, Warlock, Vampiir and the Maulers can't be created. With `start_as_base_class` on, advanced classes start as their base class; promote at the advanced-class trainer at level 5 (learnings/npc-dialog.md). Base classes have no styles.
- **A Guardian (or Blademaster, Hero, Champion) dies to level-1 mobs:** it starts without armour, because its starter armour templates are missing from the DB. Hibernia's default is Naturalist for that reason (learnings/classes-and-races.md).
- **Gateway answers 403, 401 or 415:** 403 is a browser `Origin` that is neither loopback nor the gateway's own, or a non-loopback `Host` on the default 127.0.0.1 bind. 401 means `GATEWAY_AUTH=botenv` is on and the password doesn't match `bots/<name>/bot.env`. 415 means a POST to `/say`, `/dm` or `/bots/<bot>/auth` lacked `Content-Type: application/json`.
- **Everything succeeds and nothing happens:** you used a raw `send*` that the server silently ignored (out of range, wrong target, dead). Use the `bot.*` method, or check `sdk.getGameMessages()` for the server's answer.

The game server is the source of truth and is well tested. When something fails, question your assumptions (range, target, z, state) before blaming the game. If the SDK really is wrong, find a workaround, then note it under "Possible SDK Bugs" in the bot's `lab_log.md`.

## Project layout

```
bots/<name>/      bot.env (credentials + character), script.ts, lab_log.md
bots/examples/    grinder.ts, merchant-run.ts, caster.ts, explorer.ts, duo.ts (bun bots/examples/<x>.ts <bot>); script-args.ts
learnings/        topic notes from live runs
sdk/              BotSDK (index.ts), BotActions (actions.ts), runner.ts, cli.ts, chat.ts, API.md
client/           headless DAoC client (runner.ts, swarm.ts for many bots in one process)
data/             static world data: findNpcSpawns, getMerchantItems, estimateZ, validateCharacter, ...
docs/SERVER.md    server properties, GM commands, SQL access
```
