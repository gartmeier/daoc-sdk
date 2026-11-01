# Regions and zones

## Coordinates

- **A position is `regionId` plus global `x`, `y`, `z`.** `x`/`y` are the ground plane in world units; `z` is height.
- **Zones are rectangles inside a region,** for example Camelot Hills inside region 1 (Albion). `player.zoneId` and `player.zoneName` are what the server sends. Use `getZoneAt(regionId, x, y)` for any point.
- **Headings run 0..4095:** 0 points to +y, increasing clockwise. Use `sdk.headingTo(obj)` or `bot.face(obj)`. `bot.face(1024)` is always a heading, never object id 1024.
- **Distances:** `npc.distance` is 3D and `npc.distance2d` is the ground plane. Every range check except loot pickup is 3D.
- **Area messages** like "(Region) You have entered Prydwen Keep." appear as you walk. They are not region changes.

| Region | What |
|---|---|
| 1 | Albion (Camelot Hills, Black Mountains, ...): Albion starts here |
| 10 | Camelot City |
| 100 | Midgard: Midgard starts here (East Svealand, Gotar, ...) |
| 101 | Jordheim |
| 200 | Hibernia: Hibernia starts here (Shannon Estuary, Lough Derg, ...) |
| 201 | Tir na Nog |
| 2 | Albion Housing |
| 51 | Avalon (Shrouded Isles) |
| 249 | Darkness Falls |

`getRegion(id)` and `getZonesInRegion(id)` from `data/index` list the rest.

## Changing region

- **Teleporters** (verified live):
  - Master Visur <Teleporter> near Prydwen Keep takes a level-1 character to Camelot (region 10) and back for free. See [npc-dialog.md](npc-dialog.md).
  - The client reports phase `regionChange`, then `playing`. `player.regionId` changes, and the snapshot's NPC lists are replaced.
- **Battlegrounds** (verified live: five Hibernians at level 20 to Thidranki, region 252; `groups/hibernia/thidranki.ts`):
  - The portal keep's teleporter ports everyone within 500 of it each time it casts (every `of_teleport_interval`, 120 s by default; the "45 seconds" comment in the script is out of date). It only ports players wearing a medallion in the Mythical slot (37), and the medallion picks the destination (`scripts/teleporters/OFTeleporters.cs`).
  - All three realms verified live (2026-11-01) with `sdk/group/battleground.ts` (`groups/<g>/battleground.ts`): Castle Sauvage (Albion, keyword `Castle Sauvage`) and Svasud Faste (Midgard, `Svasud Faste`) work like Druim Ligen. See [rvr.md](rvr.md).
  - The Battlegrounds Medallion of Passage is free from the Medallion Merchant next to the teleporter (Hibernia: Glasny and Araisa at Druim Ligen). `equipItem` puts it in slot 37.
  - The medallion is used up by the port. Thidranki takes levels 20–24 below 7,125 realm points.
  - Whispering "battlegrounds" works only for teleporters that hand it to `GameTeleporter.GetTeleportLocation`. Channeler Glasny (LiveTeleporter) and SimpleTeleporters don't. A SimpleTeleporter answers only the exact names of its destinations (Channeler Ynsalg at Druim Cain: "Druim Ligen"), only to its own realm, and only once someone has right-clicked it since the server started: `Interact` loads its destinations and `WhisperReceive` searches nothing else (`SimpleTeleporter.cs` `LoadDestinations`). Until then whispers go unanswered, so `talkTo` it before the whisper, as `toPortalKeep` does.
- **Zone exits do not fire by walking: use `bot.useZonePoint(idOrZonePoint)`** (`getZonePointsFrom(regionId)` gives `id`, `sourceX/Y/Z` → `targetRegion`). **Verified live (2026-11-01):** all 15 group bots left Thidranki with it, by zone points 63, 64 and 65, one per realm.
  - Verified live: walking onto zone point 111 (region 1 → 2, at 554895, 523579, 2512) ended "Arrived" 10 units from it, and 5 s later the bot was still in region 1.
  - Why: the server uses a zone point only when the client sends 0x90 PlayerRegionChangeRequest with its id (`RegionChangeRequestHandler.cs:11`, u16 little-endian for 1.126+ at `:23`; `IPacketLib.cs:148`). Position updates never trigger it. For PrivLevel-1 players the zone point's `realm` must be 0 or theirs (`:33-37`).
  - `bot.useZonePoint` walks to the source when farther than `tolerance` (200), sends 0x90 and waits for the jump (`timeout`, 20 s). Reasons: `not_found` (no such id), `wrong_region`, `wrong_realm` (from static data, before any walk), `refused` (a server message said so), `timeout` (no jump, no word: the server ignores a wrong id or realm in silence, `:41-45`), `dead`, and the walk's own (`stuck`, `died`, ...). `sdk.sendRegionChangeRequest(id)` is the raw send.
  - 20 ids have three rows, one per realm, most with their own source (`getZonePoint(84)` alone gives Albion's). The server picks by id and realm (`:33-39`), and `bot.useZonePoint(id)` does the same with `getZonePoint(id, realm)`.
  - The server checks no distance from the zone point (the handler reads only the id, `:23-167`). The walk is ours: a real client asks when it steps on the zone point.
  - A custom jump point can still say no: `classType` decides in `IsAllowedToJump` (`:154`). The one in the dump, `DFEnterJumpPoint` (the realm that holds Darkness Falls), does so without a message, which reads as `timeout`.
  - `travelTo` still refuses other regions.
  - In region 1, the nearest exits to Prydwen are 20,000+ units away (to regions 2, 51 and 249).
- **Zone boundaries inside a region do work by walking** (verified live): walking to 560000, 549600 logged "Camelot Hills → Salisbury Plains" in region 1, and `player.zoneId`/`zoneName` updated.
- **Walks end on a region change:** any `walkTo` in progress ends with `region_changed`. Plan the next leg from the new position.
- **Region ids are skins in instances:** the region id is the "skin" the server reports, which equals the real id everywhere except instanced dungeons.

## Static data vs live view

The DB dump knows every spawn point. The client knows only what is within view, about 6000 units, and objects come and go.

```typescript
import { findNpcSpawns, getZoneAt, getZonePointsFrom, nearestBindpoint } from '../../data/index';
const me = sdk.getPlayer();
findNpcSpawns({ regionId: me.regionId, near: me, radius: 5000, levelRange: [0, me.level], realm: 0 });   // easy monsters
findNpcSpawns({ regionId: me.regionId, near: me, guild: /merchant/i, limit: 5 });                          // shops
findNpcSpawns({ regionId: me.regionId, near: me, classType: /Trainer/ });                                  // trainers
nearestBindpoint(me.regionId, me.x, me.y, me.realm);
```

- **Spawn fields:** `classType` is the server class (`GameMerchant`, `Trainer.FighterTrainer`, `GameHealer`, `GameGuard`, `Scripts.LiveTeleporter`, `GameNPC` for monsters). `flags & 0x10` marks peaceful NPCs.
- **Spawn points aren't live positions:** a spawn point is where a mob starts. Live mobs wander, and roaming or respawning ones may be elsewhere or dead. Confirm with `sdk.getNearbyNpcs()` once you are there.
- **Comparing data with the live view:** `bun bots/examples/explorer.ts <bot> [radius] [points]` walks a loop and reports both. A 600-unit loop around Prydwen Keep showed:
  - 10 merchants, 3 trainers, 1 healer, 3 guards, a teleporter and a hastener;
  - monsters: spirit hound (L0), brownie (L0), spriggarn (L2), wild sow (L2), black wolf, snake and giant frog (L3), cutpurse, small bear and giant frog (L4), large skeleton (L5), bandit (L8).

## What the world doesn't have

- **No terrain heights and no navmesh** ship with this server image. `bun run navmesh:build` generates per-zone meshes and terrain grids from the local client (`zoneNNN.nav` and `zoneNNN.terrain` per zone; a region spans several zones). The gameserver loads the `.nav` meshes from the mounted `server/navmesh/` at startup and paths NPCs around walls; without them it moves NPCs in straight lines. Only the SDK reads the `.terrain` grids. On the bot side, walks route around walls and the bot stands on the exact terrain; without meshes, z is estimated (see [walking.md](walking.md)).
- **No real line of sight:** the client answers every LoS check with "clear".
