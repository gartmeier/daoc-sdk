# BUILD

The headless 1.127 client works end to end against the live local server. Login, character creation, entering the world, movement, targeting, chat, melee, loot, death/release, region change and a clean quit were all exercised live. There were no decode errors, no unknown opcodes, and no errors or kicks in the gameserver log caused by our packets. 104 unit tests pass (`bun test ./client`) and `bunx tsc --noEmit` is clean.

## Files (all under C:/Users/joshu/Code/daoc-sdk/client/)
- `net/framing.ts`, `net/connection.ts`
- `protocol/buffer.ts`, `protocol/opcodes.ts`, `protocol/outgoing.ts`
- `protocol/incoming/{login,world,objects,player,chat,combat,windows}.ts`
- `model/world-model.ts`, `model/classes.ts` (character-creation tables)
- `movement.ts`, `session.ts`, `client.ts`, `action-queue.ts`
- Tests: `net/framing.test.ts`, `protocol/outgoing.test.ts`, `protocol/incoming/incoming.test.ts`, `movement.test.ts`, `model/model.test.ts`, `action-queue.test.ts` (rs-sdk's tests, ported)
- Live scripts: `dev/smoke.ts`, `dev/actions.ts`, `dev/region.ts`, `dev/death.ts`

## Public API
- **`DaocClient`** (`client.ts`)
  - `new DaocClient({ host?, port?, username, password, charName?, realm?, className?, raceName?, gender?, createIfMissing?=true, log?, trace?, publishIntervalMs?=250 })`
  - `connect(): Promise<void>` rejects with `SessionError`.
  - `collectState(): BotWorldState`. Each call counts as one publish and increments `tick`.
  - `onStateChange(fn)` and `onTick(fn)` return an unsubscribe function. They publish at most every 250 ms, and within about 50 ms of a significant change.
  - `onDisconnect(fn(reason, msg))`, `execute(action): Promise<ActionResult>`, `quit()`, `disconnect()`, `inGame`, `phase`, `session`.
  - `defaultCharName(username)`: digits map to letters (`bot1` → `Botb`, `smoke2` → `Smokec`), because names must be letters only.
- **`DaocSession`** (`session.ts`)
  - `connect()`, `quit(timeoutMs?)`, `close(reason)`, `send(code, payload)`, `waitFor(codes, ms, what)`
  - `onEnd`, `onPacket`, `onPhase`; fields `model`, `mover`, `sessionId`, `objectId`, `regionId`, `accountRealm`, `endReason`, `lastError`.
  - **`SessionError`**: `.reason` is one of `quit | connectFailed | loginDenied | accountInLogout | timeout | characterNotFound | creationFailed | realmLocked | serverClosed | decodeErrors | clientClosed | error`. It also has `.code` and `.mustBackOff`, which is true for 0x2C code 0x11 (wait 60 s or more before retrying).
- **`BotActionQueue`**: a port of rs-sdk's queue with the same API.
- **`Mover`**: `moveTo(target, {waypoints, tolerance, speedFactor, finalZ})`, `stop`, `face`, `faceTowards`, `holdPosition(ms)`, `snap`, `onStop`, `state()`. Also exported: `headingFromDelta`, `headingTo`, `pointFromHeading`.
- **`planCharacter(realm, class, race, gender?)`** returns a creation plan that passes the server's validity check. `findClass`, `findRace` and `creationPoints` are also exported.

## Verified live
- **Fresh accounts:** a new account (`smoke2`) was auto-created, given a character, and passed all 9 smoke checks:
  - walked 300 units and back with 0 server corrections;
  - the say was echoed;
  - 15 s idle with no link-death or teleport-back;
  - killed a spirit hound with 3 of 4 swings hitting, for 17 xp;
  - clean quit.
- **All other action types** passed in `dev/actions.ts`:
  - two bots see each other (the 0xD5 request path);
  - merchant window opens with 56 items, sell, moveItem, dropItem then pickup;
  - NPC dialog keywords parsed, and whispering a keyword made the trainer hand over an item;
  - openTrainer, sit/stand, jump, `/played`, useSkill (Sprint), and an unknown objectId rejected at the validation phase.
- **Server-forced moves** (GM account): a same-region jump snaps the position and reports `teleported`, and a round trip to region 51 and back worked.
- **Death:** the bot detects its death (`deathCount`, mover stop reason `died`), `/release` works and the respawn snaps the position.

## Only unit-tested (no live opportunity)
- castSpell: the Fighter has no spells.
- buy: the character only has 5 copper; the window and items decode fine.
- trainSpec: no spec points yet.
- respondDialog, setGroundTarget, destroyItem, groupSay/send, effect icons and concentration list: no live triggers were hit.
- The 0xD0 line-of-sight reply: the server never sent a request during the runs.

## Known gaps
- **Quit needs an extra step.** After the server's quit packet (0xA4) the client must send a character-overview request (0xFC) before closing. Otherwise the server starts a 60 s link-death and blocks re-login with code 0x11. `quit()` does this, and the server log confirmed it now disconnects cleanly from the character screen.
- **Loot detection is a guess.** The server's "owned by us" flag is reliable. Otherwise a ground object counts as loot if it is named coins/bag/pouch, or spawned within 5 s and 400 units of an NPC death. Autoloot is on by default, so kills usually need no pickup.
- **No terrain.** z comes from the destination, else from a known object within 96 units of it, else the current z is kept.
- **Idle players are never culled.** Players who stand still are removed only by distance or a remove packet.
- **Region id is the region skin** reported by the server, which equals the id outside instances.
- `Style.specName` is always null; the server's index does not map to the list.
- Phase `linkdead` is never set.

## Other modules need to know
- **`sdk/types.ts`, additive only:**
  - `Spell.skillIndex?`: hybrid-class spells live in the skills list with `lineIndex`/`spellIndex` = -1; cast them with `useSkill`.
  - New `ConcentrationEffect` interface.
  - `BotWorldState.concentrationEffects?` and `groundTarget?`.
- **Index conventions:**
  - `useSkill` takes the skill's position in the list with specializations excluded, and the client always sends type 1.
  - `trainSpec.specIndex` uses the trainer window's order (open the trainer first).
- **Action semantics:**
  - `interact`, `pickup` and `attack` warn in the result message when out of range (192 / 256 / 128) but still send. The bot layer should walk first.
  - `quit` returns at dispatch; the server's quit timer can run 20–60 s.
- **Test-script gotcha:** `package.json` runs `bun test sdk client ...`, and the `client` filter also picks up `reference/rs-sdk/.../webclient` tests, which fail. Use `bun test ./client`.
- **Server state I changed:**
  - Set `time_between_account_creation_sameip=0` and `total_accounts_allowed_sameip=1000` in the DB. Neither is active until a gameserver restart, which I did not do.
  - Accounts created: `smoke1` (pre-inserted, char Smoke), `smoke2` (auto-created, Smokec) and `probe1` (auto-created, Probeone and Probe). All use password `smoke123`.
  - Also created `gmtest` (PrivLevel 3, char Gmtest), for protocol tests only.

# REVIEW

I checked the client field by field against the C# (PacketLib chain 1127 → 1126 → 1125 → 1124 → 1112 → 1110 → 1105 → 190/189/186/179/176/175/174 → 168, plus each handler's `client.Version` branches). The wire codecs have no layout bugs. I fixed six behaviour bugs in the session, mover, model and connection, and added 7 regression tests. `bun test ./client` passes (111, was 104), `bunx tsc --noEmit` is clean, and the live smoke, actions and region scripts all pass.

## Bugs found and fixed
1. **Every login opened a second, empty TCP connection** (`client/net/connection.ts:13,52`). With host `localhost`, Bun tries IPv6 and IPv4 at once, and Docker's port proxy forwards both. The server logged a ghost "Disconnecting client because of 0 bytes received (VersionNotChecked)" before every login and burned a session id. I confirmed this with a bare `Bun.connect`. The new exported `resolveHost(host)` resolves to one address first (prefers IPv4; `localhost` becomes `127.0.0.1`). Live: the ghost connection is gone.
2. **A max speed of 0 was treated as 100%** (`client/session.ts:379`). The old code was `percent || 100`. The server sends 0 when the player is rooted, stunned, mezzed or over-encumbered (`PlayerMovementComponent.cs:29,132`). The mover then walked at full speed, which the speed monitor flags and teleports back. The mover now waits in place sending speed 0. `moveTo`'s `etaMs` is null in that case instead of Infinity (`client.ts:339`).
3. **The mover's sitting flag was never cleared by the server** (`client/session.ts:384`). When the server stood the player up (moving, attacked) or sat them down (`&quit`), our position updates kept the stale SITTING flag, and the state's `isSitting` was wrong. It now follows the sitting flag in 0xAD (`PacketLib168.cs:1252`).
4. **Loot flag was lost or wrongly set on periodic re-sends** (`client/model/world-model.ts:342`). The server re-sends every static object as 0xD9 every 30 s (`ClientService.cs:832-865`). A real drop lost `isLoot` after 30 s, and any old object re-sent within 5 s of a kill was marked as loot. Now the "spawned next to a fresh corpse" guess applies only to newly seen objects, and loot stays loot.
5. **Removed spell lines never went away** (`world-model.ts:662`). The model only cleared lines when line 0 arrived. A footer-only update (after a respec) or a shorter list left stale lines. The footer now trims the list to what was actually sent.
6. **Moving to your own position turned you to heading 0** (`client/movement.ts:174`).

## Tests added
- New `client/session.test.ts`: max speed 0 is honoured, the sitting flag syncs, and `resolveHost` returns one address.
- `client/movement.test.ts`: a rooted mover waits and then resumes; a zero-length move keeps the heading.
- `client/model/model.test.ts`: loot survives the re-send and old objects are not loot; spell lines are trimmed by the footer.

## Verified correct (no change needed)
- **Outgoing encoders:** all 30 match their handlers, including the 40-byte 0xA9, the 22/24-byte prefix packets, 0xFF at 1+(4+name+1)+100 bytes, 0x53 at 264 bytes, the little-endian 0xD5/0xBE ids, and 0xAF ReadString(255).
- **Server packets:** the framing checksum and every decoder match, including 0xFC, 0x20, 0xDA, the 9-bit zone skin in 0xA1, 0xD9, 0x4B, relayed 0xA9 and 0xBA, 0xAD, 0x91, 0xFB, item data, 0x02, 0x16 sub-packets 01/02/03/06, 0x17, 0x7B, 0x70, 0x7F, 0x75, 0xBC, 0xD6, 0x81 and 0xC4.
- **Other checks:**
  - The session state machine matches critic.md §7.
  - The 0xA9 cadence (200 ms moving, 1 s idle) stays under the 0.9× speed limit; the server measures 2D distance only.
  - The heading math equals `Point2D.GetHeading` and `GetPointFromHeading`.
  - Prefix packets that repeat the exact last position never reach the speed monitor (it only records on an XY change, `PlayerMovementComponent.cs:104`).
  - Creation stat tables match `STARTING_STATS_DICT`.
  - All 32 `BotAction` variants are implemented.

## Live runs against the server
- `bun client/dev/smoke.ts smoke2`: 9/9 PASS, 0 corrections.
- `dev/actions.ts`: 10/10 PASS.
- `dev/region.ts gmtest`: PASS (same-region jump, region 51 and back).
- Gameserver log: no warnings caused by our packets, only the server's own "Long PacketHandler (CharacterCreateRequest)" timing warnings; every disconnect was a clean one from the character screen.

**Side effect:** running `dev/actions.ts` (which uses the default character names) created new characters **Smokeb** on `smoke1` and **Probeb** on `probe1`.

## Remaining known gaps
- If `&quit` is refused (dead, in an instance, crafting), `quit()` waits 75 s, then closes the socket, which starts a 60 s link-death lockout. Releasing first is up to the bot layer.
- Prefix packets send speed 0 even while moving; the next 0xA9 corrects it within 200 ms.
- If the event loop stalls for more than 5 s, the server enters link-death recovery and does not read the 18-byte position prefix of the next skill, spell or slot packet, so that packet is misread. The normal 0xA9 heartbeat avoids this.
- Instances: the region and zone ids are skins, so the zone id we send can belong to another region (no kick, but area messages are wrong).
- Still open from the builder's list: `Style.specName` is always null, idle players are never culled, phase `linkdead` is never set, and there is no terrain z. Text-window lines longer than 255 characters arrive as several lines.

## For other modules
- `DaocClient`/`DaocSession` APIs are unchanged; `resolveHost` is a new export from `client/net/connection.ts`.
- `PlayerState.maxSpeed` / `maxSpeedPercent` can now be 0 while rooted.
- `moveTo`'s result `data.etaMs` can now be null.
- `sdk/types.ts` was not touched.