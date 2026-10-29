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
- **Zone exits do not fire by walking** (`getZonePointsFrom(regionId)` gives `id`, `sourceX/Y/Z` → `targetRegion`):
  - Verified live: walking onto zone point 111 (region 1 → 2, at 554895, 523579, 2512) ended "Arrived" 10 units from it, and 5 s later the bot was still in region 1.
  - Why: the server uses a zone point only when the client sends 0x90 PlayerRegionChangeRequest with its id (`RegionChangeRequestHandler.cs:11`, u16 little-endian for 1.126+ at `:23`; `IPacketLib.cs:148`). Position updates never trigger it. For PrivLevel-1 players the zone point's `realm` must be 0 or theirs (`:33-37`).
  - The SDK has no way to send 0x90 yet (no `sdk.sendRegionChangeRequest` / `bot.useZonePoint`), and `travelTo` refuses other regions. **Change regions with teleporters.** Dungeon entrances and other jump points are out of reach until then.
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

- **No terrain heights and no navmesh** ship with this server image, so the server moves NPCs in straight lines. On the bot side, `bun run navmesh:build` generates per-zone meshes from the local client (one `zoneNNN.nav` per zone; a region spans several zones). With those, walks route around walls and follow the ground z; without them, z is estimated (see [walking.md](walking.md)).
- **No real line of sight:** the client answers every LoS check with "clear".
