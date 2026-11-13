# DAoC Bot Agent Guide

You play Dark Age of Camelot on a local OpenDAoC server by writing bot scripts. Start small, make one step toward the goal, then learn and grow the script as you go. Characters are **persistent**: every session continues where the last one ended.

Before writing logic for a topic (walking, combat, spells, pets, merchants, looting, gear care, trading, trainers, builds, death, classes, zones, grouping/chat, group coordination, RvR), read its file in [learnings/](learnings/README.md). Exact signatures are in [sdk/API.md](sdk/API.md).

## First-time setup

1. **Server.** The server source and DB dump are git submodules: if `server/core/GameServer` or `server/db/opendaoc-db-core` is empty, run `git submodule update --init server/core server/db` first (`bun bots/create-bot.ts` and `data/` need them too). Check `docker compose -f server/docker/docker-compose.yml ps`. If the gameserver is not up: `bun run server:up`, then `bun run server:setup`. Done when TCP 10300 answers (setup waits for it).
2. **Bot.** Ask the user for a name: up to 12 letters and digits. If they skip it, omit the name and a random one is used. Choose a realm and class from `bun bots/create-bot.ts --list` (default: Albion Fighter), and for an advanced class its build from `bun bots/create-bot.ts --builds=<class>`. Then run:
   ```bash
   bun bots/create-bot.ts <name> [--realm=hibernia] [--class=Enchanter --build="Mana nuker"] [--race=..] [--gender=..]
   ```
   This writes `bots/<name>/bot.env` (credentials plus character), `script.ts`, `lab_log.md` and, with a build, `build.ts`. An advanced class needs `--build`, or `--no-build` for a test character. A base class chooses before it promotes: `bun bots/choose-build.ts <name> "<build>" --class=<advanced class>`. The account and character are created on first login.
3. **Gateway.** `curl -s localhost:7780/status` must answer; otherwise start `bun gateway/gateway.ts` in the background. It listens on 127.0.0.1 only and checks no passwords there; see README "Gateway access" for `GATEWAY_HOSTNAME` / `GATEWAY_AUTH`.
4. **Client.** Start `bun client/runner.ts <name>` in the background and leave it running, one process per bot. It is ready when its log shows `in game (phase playing)`.
5. **State.** `bun sdk/cli.ts <name>` shows position, health, inventory, skills and nearby NPCs. Done when it prints `In Game: true`.

MCP `execute_code` does steps 3–4 itself. Scripts and the CLIs never start a client.

**Disposable server:** for a live check that must leave the shared stack alone, `bun run server:throwaway up` exits 0 once logins work and prints the port for `SERVER=` in bot.env; `down` removes it (docs/SERVER.md "Throwaway stacks").

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
   `scriptArgs()` (from `../examples/script-args`) drops the bot name only when it came from argv, so a copy takes `bun bots/<name>/grinder.ts 60` while the original takes `bun bots/examples/grinder.ts <name> 60`. It also drops anything starting with `-`, so a script with flags reads them from `process.argv`.
3. **Run** it: `bun bots/<name>/<script>.ts`. Use a short `timeout` first:

   | Duration | When |
   |---|---|
   | 10–30 s | new script, untested logic, debugging |
   | 1–3 min | the approach worked once |
   | 5+ min | proven grind; rarely |

   A failed 5-minute run costs more than five 30-second diagnostic runs.
4. **Check** the result's `success`/`reason`/`message`, the printed state summary, and `bun sdk/cli.ts <name>` again.
5. **Record** what you learned in `bots/<name>/lab_log.md`, then improve the script.

## Groups

Several bots play as one group through `sdk/group` (read [learnings/group-coordination.md](learnings/group-coordination.md) first): members share what they see on a blackboard, a coordinator runs the strategy's `decide()` (pull, focus, crowd control, retreat), each member runs its role's behaviour list with its own routine from `bots/<bot>/character.ts` in it, and an observer scores every run. Between fights, members who know a rez bring back the dead (in RvR also mid-fight, if they have the power and the group isn't under pressure), and a corpse with such a member near waits for it (`rez.holdMs`) before it releases.

```bash
bun groups/create-group.ts <group> <bot> <bot> ...    # groups/<group>/: group.json, strategy.ts, hunt.ts, lab_log.md
bun client/swarm.ts <bot> <bot> ...                   # one process with every member's client
bun sdk/group/cli.ts <group>                          # shared picture, observe only (--watch=60 scores whatever runs)
bun groups/<group>/hunt.ts 180                        # coordinated hunt; report in groups/<group>/runs/<stamp>.md
bun sdk/group/cli.ts <group> --live                   # the running hunt as the gateway sees it: phase, orders, members, contacts, events
bun sdk/group/cli.ts <group> --wind-down              # end the hunt after the current fight (report saved)
bun groups/<group>/battleground.ts [--via=x,y,z]      # into Thidranki (levels 20-24): portal keep, bind, medallion, port
bun groups/<group>/rvr.ts 300                         # roam the battleground and fight the other realms (learnings/rvr.md)
bun groups/<group>/cloak-trip.ts [--stay]              # out of the battleground, capital, a cloak each, back in; --stay stops in the capital
bun groups/<group>/gear-care.ts                        # in a town: vault what's too high to wear, take out what fits, repair (learnings/gear-care.md); a group older than the script copies it from groups/_template/
bun groups/<group>/gear-template.ts                    # every member in custom gear at its level's caps, by a GM (learnings/gear-template.md); a group older than the script copies it from groups/_template/
bun groups/<group>/train.ts [--respec] [--radius=<n>]  # anywhere: each member spends its points by bots/<bot>/build.ts; --respec walks to its trainer (learnings/builds.md); a group older than the script copies it from groups/_template/
```

The loop is the session loop at group scale: run, read the report (findings name the setting to change), change one thing in `strategy.ts`, run again and compare, note it in the group's `lab_log.md`. A group run controls every member, so don't drive a member separately meanwhile: taking control of one member aborts the whole run. To stop a hunt early, wind it down (`--wind-down`, or the button on the group page). The browser view is `http://localhost:7780/viewer/group/<group>`: every member on one map, orders, base plan, enemies, events, deaths and recent runs.

## MCP tools

| Tool | Use |
|---|---|
| `execute_code({ bot_name, code })` | Run TypeScript on a bot. Globals: `bot`, `sdk`, `args`, `EquipmentSlot`, `ObjectType`, `ItemHand`. `return` a JSON value. Starts the gateway and the client if needed (first login can take a minute). |
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
- **Slots:** backpack 40–79, equipment 10–37 (`EquipmentSlot`). Pass `item.slot`, never an array index.
- **Item types:** `ObjectType` names `objectType` (`ObjectType.Blades`, `isWeapon`, `isArmor`), and `ItemHand` names a merchant item's `hand`. Use them, not raw numbers.

### bot.* quick reference

| Method | What it does |
|---|---|
| `walkTo(x, y, {z, tolerance})` / `followPath(points)` / `travelTo(name \| point)` | Walk in straight lines; re-issues after server corrections |
| `useZonePoint(idOrZonePoint, {tolerance, timeout})` | Walk to a zone point and take it; reason `wrong_region`, `wrong_realm`, `refused`, `timeout`, ... |
| `findKillableNpc({pattern, minCon, maxCon, radius})` | Best monster nearby (default con green..yellow) |
| `killNpc(npc, {styles})` | Approach, attack, chase, wait for death; reports xp/money/items |
| `killPlayer(objectId, {useStyle})` | The same against an enemy-realm player (named by race: pass the id); reason `immune` during PvP immunity |
| `castSpell(spell, target?)` | Approach to range, cast, observe completion/damage |
| `grind({durationMs, pattern, respawn, pet, onKill})` | Hunt/kill/loot/rest loop around an anchor; `pet: true` fights with a window pet |
| `summonPet(spell?, {replace, groundTarget})` / `charmPet(mob)` / `releasePet` / `findSummonSpell(kind)` | Bring up or let go a pet, seen in its window or its line; reason `pet_exists`, `no_ground_target`, `resisted`, ... (learnings/pets.md) |
| `petKill` / `petAttack` / `petFollow` / `petStay` / `petComeHere` / `petGoTo` / `setPetAggression(mode)` | Order a window pet, seen in the server's answer. `petAttack`, `petKill` and `petGoTo` move our own target too. `killNpc` orders it as well (`usePet`), unless it is passive. State: `sdk.getPetState()`, `sdk.getPet()`, `sdk.getSummons()` |
| `rest({healthPercent, manaPercent})` / `releaseAndRespawn()` | Sit to regenerate / respawn at the bind point |
| `resurrect(target, {spell, answerMs})` / `acceptResurrection({timeout})` / `resurrectSpell()` | Rez a dead player of our realm, success meaning it is back; say yes as the corpse (no script running, no answer). Reasons `no_power`, `not_dead`, `already_considering`, `no_answer`, `expired`, ... (learnings/death-and-rest.md) |
| `lootNearby()` | Pick up ground loot (autoloot usually already did) |
| `talkTo(npc)` / `whisper(npc, keyword)` / `navigateDialog(npc, [kw])` | NPC dialog and its [keywords] |
| `openMerchant` / `buyItem` / `sellItem` / `sellItems(m, filter)` / `delveMerchantItem(m, item)` | Shops (sell price is 50 % of value); `shop.items` carry type, hand, DPS and speed |
| `repairItem(smith, item, {maxCost})` / `repairAll(smith, {maxCost})` | A smith repairs one item, or everything for 20 % more; reports `cost`; reason `no_need`, `not_repairable`, `too_expensive`, `insufficient_funds`, ... (learnings/gear-care.md) |
| `openVault(keeper)` / `depositItem(keeper, item)` / `withdrawItem(keeper, item)` | The character's vault at a vault keeper; `sdk.getVault()` is empty until opened; reason `vault_full`, `inventory_full`, ... |
| `trainBuild(trainer, build?)` | Spend the points by the bot's `bots/<name>/build.ts`, in its listed order, at a trainer or with `null` where it stands, as `bun bots/examples/train-build.ts <bot>` does; reports `trained`, `waiting`, `done`, `over`; reason `no_build`, `wrong_class`, ...; a broken file throws (learnings/builds.md) |
| `respec(trainer, line?)` | Take the points back from every line or one, free at any level; reports `regained`, `specs`; reason `no_need`, `refused`, ...; ends the character's own buffs and kills its pet |
| `trainSpec(trainer, spec, levels)` | Raise one line by hand; `spec` is any name of the line (Shield or Shields). Read a line's level with `sdk.findSpecialization(name)` (learnings/npc-dialog.md) |
| `equipItem` / `unequipItem` / `useItem` / `dropItem` / `destroyItem` | Items |
| `takeMeleeSlot({styles, weapon, keepOnTie})` | The best melee weapon in hand: `attack`, `killNpc` and `killPlayer` do this for themselves on a bow's refusal, `killNpc` and `killPlayer` also on a style's "requires a X weapon" |
| `delveItem(item \| name \| slot)` | An item's real bonuses: `lines`, `bonuses`, `unknown`; reason `empty_slot`, `not_found`, `no_response` (learnings/looting.md) |
| `trade(player, {give, money, accept})` / `offerTrade` / `acceptTrade` / `cancelTrade` | Trade with a player: both sides call, in any order, within 128 units, between hunts; reports `gave`, `received`, `moneyGiven`, `moneyReceived`; reason `cancelled`, `busy`, `inventory_full`, `partner_no_accept`, ...; an add that opens a window waits for its slot on the clock, up to 750 ms (learnings/trading.md) |
| `invite` / `acceptGroupInvite` / `groupSay` / `follow` / `say` / `send` | Social |

From `sdk.*`, the common calls are `getState`, `getPlayer`, `getInventory`, `findNearbyNpc(s)`, `getNearbyLoot`, `getSkills`, `findSpell`, `getMerchant`, `getGroup`, `getChat`, `waitForChat`, `waitForCondition`. The full list is in sdk/API.md.

## Troubleshooting

- **Tests fail on missing `server/` or `data/generated` files:** the server isn't cloned in this checkout, which is normal in a new git worktree, so those failures don't come from your change. To run them: `git submodule update --init server/core server/db`, `bun install`, then `bun run data:build`. Build the data rather than copying it from another checkout: a copy can predate this commit's `server/db` pin.
- **"No game client is attached"** means nothing is publishing state for the bot. Start `bun client/runner.ts <name>` and wait for `in game`. Its log is in your shell, or in `bots/<name>/client.log` when MCP started it.
- **Login refused with 0x2C code 0x11 / `AccountIsInLogoutProcedure`:** the character is still in the world, link-dead. This happens when a client dropped without quitting. Wait 60 s and retry; the runner backs off on its own.
  - To stop a client cleanly, use a quit action: `await sdk.sendQuit()`, MCP `disconnect_bot`, or `bun client/dev/swarm-check.ts <bot> [<bot> ...] --seconds=0 --quit` (the runner logs out, then exits 0). Ctrl+C is clean only when typed in the client's own console. Never kill it outright.
  - On Windows, a SIGINT/SIGTERM sent from another process (`process.kill`, `child.kill`, `Stop-Process`, `taskkill`) terminates bun abruptly and causes the 60 s lockout. `kill -INT` from Git Bash does not reach bun at all. A client in a background shell is stopped with a quit action.
  - After combat, quitting can take up to 60 s ("You will quit after sitting for N seconds"). With a mob on you it doesn't finish: the client closes at 75 s, exit 0, and the character stays link-dead about 60 s more (learnings/death-and-rest.md).
- **`BotPreemptedError` ("Pre-empted by another controller"):** a second script, MCP call or `swarm-check` took control of the same bot, so this script was aborted at once. The game client is fine and keeps running; run one controller per bot, or run the script again. Under MCP the cut-off call's remaining actions fail, and the next `execute_code` takes control back.
- **The client goes link-dead or the bot freezes** after more than ~5 s without position updates; the server then misreads the next packets. Keep the event loop free: waits must `await` (`sdk.waitForCondition`, `Bun.sleep`), never busy-loop.
- **Monsters ignore the bot, and the PvE results look wrong:** the account is a GM (PrivLevel > 1). Mobs never attack GMs, and GMs skip range and loot checks. Use fresh PrivLevel-1 accounts for gameplay.
- **Wrong height, "too far away" at close range, or melee that never lands:** without navmeshes there is no terrain data, so z is estimated from nearby spawn heights (`estimateZ`, typical error 25 units, worst cases hundreds). `bun run navmesh:build` generates `server/navmesh/zoneNNN.nav` from the local client. With those, walks route around walls, and the client stands the bot on the exact terrain from the client heightmaps (`server/navmesh/zoneNNN.terrain`, also `bun run terrain:build`), swimming in deep water (learnings/walking.md "Ground height"). The gameserver loads the same meshes, so there an off-mesh z (more than ~128 units, e.g. with `DAOC_NAVMESH=off`) also makes a chasing mob teleport or turn damage-immune and regenerate, and a ground target more than 16 units off the mesh is dropped (docs/SERVER.md).
  - Pass `z` when you know it, for example from an NPC's position.
  - `killNpc`/`walkToObject` adopt the target's z (with navmeshes: the layer nearest it at the target's spot; a target on a ledge with no layer under us stays out of 3D range and returns `out_of_reach`).
- **Walks cut through walls and cliffs:** without navmeshes, walking is in straight lines and the server doesn't check collisions. A route that looks fine on the map can still fail with `stuck` (no progress for 8 s). Build navmeshes (`bun run navmesh:build`, see above) or add waypoints with `followPath`. In a zone without a `.nav`, `walkTo` still falls back to straight lines.
- **Walking onto a zone exit does nothing:** the server uses a zone point only when the client sends 0x90 PlayerRegionChangeRequest. Use `bot.useZonePoint(idOrZonePoint)` (`getZonePointsFrom(regionId)` lists them), which walks there, asks and observes the jump. Teleporters (`bot.whisper('Master Visur', 'Camelot')`) also change regions. Zone boundaries inside a region work by walking. See learnings/regions-and-zones.md.
- **A teleporter answered and no jump came:** `bot.whisper` reads success on the NPC's answer, and the port can still refuse for combat (`You can't use this item in combat!`). The server's `InCombat` counts the pet and lasts 2 s longer than `player.inCombat`: wait 10 s after the fight, whisper again and watch the position.
- **"You can't see your target from here!":** the client answers the server's LoS checks from the terrain heightmap and the zone fixtures' collision meshes (`sdk/vision.ts` `lineOfSight`, `sdk/occluders.ts`), so a hill, a keep wall or a building between caster and target refuses the cast (reason `not_visible`; `castSpell` steps toward the target until it sees it, up to 800, or 300 with `approach: false`, and tries once more), and a mob behind one doesn't aggro. Trees don't block. The walls come from `server/navmesh/*.occluders` (`bun run occluders:build`, also part of `navmesh:build`); without them only the terrain blocks. `DAOC_LOS=terrain` leaves the walls out; without terrain (`server/navmesh/*.terrain`) or with `DAOC_LOS=clear`, every check is answered clear as before. The client logs which at start.
- **Casters get interrupted:** a swing at you, a miss too, starts a timer of about 3 s, and a cast that reaches its half way with one running ends ("your spell is interrupted"). Past half way a swing changes nothing, and a mob below your level skips the timer 5 % of the time per level. So in melee a cast almost never lands: pull from range and fall back to melee (`bots/examples/caster.ts`, learnings/spells.md). There is no kiting helper yet.
- **A pet doesn't move:** summoned with the owner's z off the mesh it lands on the owner and stays there, though `summonPet` succeeded and `walk` reads `follow`. The cause is a client without navmesh and terrain: fix that (in a worktree `DAOC_NAVMESH_DIR` at main's `server/navmesh`, `DETOUR_LIB` at its `lib/Detour.dll`), walk a step and summon with `{ replace: true }`. A mob it can't reach leaves it standing too: `petKill` says `out_of_reach`, and `petFollow` frees it.
- **Dead soon after the pet:** the mob it hit comes for the owner, 9-10 s from 1500. Solo it is in `getAttackers` for its whole run; in a group, or beside another pet of ours, it reads on nobody until its next swing. Keep about 900 clear to cast a 6 s summon, or leave, and don't end a script there (learnings/pets.md).
- **An NPC "did not answer" a whisper:** NPCs silently ignore a whisper within 1.5 s of the last one they accepted from you, and the server refuses whispers < 500 ms apart ("Slow down! ..."). `bot.whisper` spaces its own whispers and retries; after a raw `sdk.sendWhisper`, wait 1.6 s yourself.
- **The bot keeps walking after a script ended:** a timeout, Ctrl+C or MCP cancel stops the mover, but a script that ends while a raw `sdk.sendMoveTo` is still running leaves it going. Run `await sdk.sendStop()`.
- **A character name is taken or invalid:** names are unique server-wide, letters only, at least 3. Set `CHAR_NAME=` in bot.env.
- **Character creation fails for some classes:** Valkyrie, Bainshee, Heretic, Warlock, Vampiir and the Maulers can't be created. With `start_as_base_class` on, advanced classes start as their base class; promote at the advanced-class trainer at level 5 (learnings/npc-dialog.md). Base classes have no styles.
- **A Guardian (or Blademaster, Hero, Champion) dies to level-1 mobs:** it has no armour, because the DB was seeded before our fork's fix or the character was made before it. docs/SERVER.md has the UPDATE for such a DB; a character made earlier keeps its inventory. Hibernia's default stays Naturalist for such DBs (learnings/classes-and-races.md).
- **Gateway answers 403, 401 or 415:** 403 is a browser `Origin` that is neither loopback nor the gateway's own, or a non-loopback `Host` on the default 127.0.0.1 bind. 401 means `GATEWAY_AUTH=botenv` is on and the password doesn't match `bots/<name>/bot.env`. 415 means a POST to `/say`, `/dm`, `/bots/<bot>/auth` or `/groups/<group>/...` lacked `Content-Type: application/json`.
- **The whole server stops answering after a trade (chat and moves do nothing, a quit gets no answer, the gameserver sits near 0 % CPU):** two adds that open a trade window in one server tick can deadlock it. Our fork fixes it from the `server/core` pin ac64bb207, so this needs a gameserver image built before that. `docker compose -f server/docker/docker-compose.yml restart gameserver`, then start the clients again. Restart it after a single 9 s stall too, because its watchdog only cures one. `bot.trade` and `bot.offerTrade` keep those adds apart; don't call raw `sdk.sendTradeOffer*` from both sides at once, and don't retry a failed trade in a tight loop (learnings/trading.md).
- **A trade ends in `cancelled`, `busy` or `unknown_action`:** `cancelled` means the window closed without "Trade Completed": the partner cancelled or the two were more than 128 units apart in 3D, and the server doesn't say which. `busy` means one side is still in a window with someone else; `bot.cancelTrade()` on that side clears it. `unknown_action` means the client runs older code: restart it with a quit action. A partner on older code shows up as `partner_no_accept` on the newer side. A trade from a second script aborts a group run, so trade between hunts (learnings/trading.md).
- **Everything succeeds and nothing happens:** you used a raw `send*` that the server silently ignored (out of range, wrong target, dead). Use the `bot.*` method, or check `sdk.getGameMessages()` for the server's answer.

The game server is the source of truth and is well tested. When something fails, question your assumptions (range, target, z, state) before blaming the game. If the SDK really is wrong, find a workaround, then note it under "Possible SDK Bugs" in the bot's `lab_log.md`.

## Project layout

```
bots/             create-bot.ts, choose-build.ts (a catalogue build to bots/<name>/build.ts)
bots/<name>/      bot.env (credentials + character), build.ts (its spec points), script.ts, lab_log.md, character.ts (its routine in a group), runs/history.jsonl
bots/examples/    grinder.ts, merchant-run.ts, gear-care.ts, train-build.ts, caster.ts, pet.ts, explorer.ts, duo.ts (bun bots/examples/<x>.ts <bot>); script-args.ts
groups/<group>/   group.json (members, roles), strategy.ts, hunt.ts, lab_log.md, runs/ (observer reports); create-group.ts, _template/
learnings/        topic notes from live runs; classes/<class>.md: builds, how to play it, what has been tested
sdk/              BotSDK (index.ts), BotActions (actions.ts), runner.ts, cli.ts, chat.ts, API.md
sdk/classes/      standard class kits (role) a bot imports into its character.ts and tunes
sdk/group/        group coordination: blackboard, member agents + behaviours, pets, coordinator, pve strategy, observer, runner, cli
client/           headless DAoC client (runner.ts, swarm.ts for many bots in one process)
data/             static world data: findNpcSpawns, getMerchantItems, estimateZ, validateCharacter, getClassSkills, ...; bun data/class-sheet.ts <class> prints a class's spells and spec points
data/builds/      researched builds per class, the buying rule (rule.ts)
docs/SERVER.md    server properties, GM commands, SQL access
```
