# Walking

## How movement works

DAoC has no click-to-walk. The headless client's **mover** streams position updates (0xA9) itself:

- Every 200 ms while moving, and at least once a second while idle as a heartbeat.
- At the max speed the server gave us, like a real client: full run speed is 191 units/s. It ran at 0.9 of that (171) until 2026-11-08, which a player watching could tell; the server's speed monitor allows 1.15 ×.
- Every update says "on the ground" with heading bit `0x1000` (`HEADING_ON_GROUND`), as a real client does: on the ground and in the short hops down a slope, off only in a real fall (more than 30 units up, until it lands). The server relays the heading word as sent, and without the bit a real client watching draws the player in steps at each 200 ms update, bobbing up and downhill, instead of moving it along the ground. That was what made bots easy to tell from players; with it a viewer can't tell Movewalk from a real player (seen 2026-11-08).
- Downhill it falls off the slope like a real client instead of sliding down glued to it: gravity 1000 units/s², nothing pulling it onto the ground, and the vertical speed in the update's zSpeed, which the server relays to every viewer. Uphill and on the flat z is the ground and zSpeed 0, exactly as a real client sends it. The fall-damage field's on-ground bit stays off in every update, as a real client's did in a capture (landings after falls at −665 included), so it never takes fall damage.

**Comparing with a real client:** `bun client/dev/record-moves.ts <observerBot> <Name> <Name>` logs in an idle bot and records every position update the server relays for those players, with the terrain under each and the raw bytes; `--analyze <file>` compares them by downhill, flat and uphill. A stealthed GM is invisible to it, and creating `<file>.stop` logs it out cleanly. What a client *sends* only shows in a packet capture: the game packets are unencrypted, and `tcpdump` in the gameserver container (`apk add tcpdump`, gone when the container is recreated) on ports 10300/10400 captures every client, all over TCP here (no UDP reached the server). Measured 2026-11-08 on the slope east of the Camelot Hills start (Vue, a real 1.127 client, against Movewalk): same z uphill and on the flat; downhill the real client was in the air in 59 % of updates (up to 54 units, zSpeed down to −437), and gravity 1000 at 60 steps/s replays its height within 2 units. At 191 it went from 0 to 191 in one update. Differences no viewer sees: it sends position every 210–217 ms while running (bot 200), every ~2 s idle (bot 1 s), and a ping every 5 s (bot 30 s).

The server checks only 2D speed. It doesn't check walls, cliffs or z. If the client ran too fast, the server teleports it back (a **correction**), and `walkTo` re-issues the move from the new spot.

## walkTo

```typescript
const r = await bot.walkTo(574797, 530161);           // z estimated
if (!r.success) console.log(r.reason, r.message);     // stuck | timeout | died | region_changed | no_path | bad_args
console.log(r.distance, r.reissues);                  // 2D distance left, re-issues after corrections
```

| Option | Default | Notes |
|---|---|---|
| `z` | navmesh ground, else estimated | pass it when you know it (an NPC's z, a spawn's z) |
| `tolerance` | 64 | arrival radius on the ground plane |
| `stuckMs` | 8000 | fail when the remaining route hasn't shrunk for this long |
| `timeout` | 1.5 × ETA + 15 s | overall deadline. The default ETA is measured along the planned route (a navmesh detour can be 4× the straight distance), and a re-plan after a correction extends it. An explicit `timeout` also covers planning |
| `speedFactor` | 1 | fraction of max speed (at most 1) |

- **Already there:** `walkTo` to where you stand stops any earlier move and returns `Already at destination`.
- **Region change** (zone exit, teleport) ends the walk with `region_changed`.
- **Cancelling:** an MCP cancel, a `runScript` timeout or Ctrl+C stops the mover, so the bot doesn't keep walking. The runner gives the aborted script up to 2 s to send its stop before it disconnects (seen live: a 3000-unit walk aborted after 3 s stopped 500 units out).

## Waypoints

`followPath(points)` walks the points in order as one continuous move. Use it around buildings, through gates, or along roads:

```typescript
const p = sdk.getPlayer();
await bot.followPath([{ x: p.x + 300, y: p.y + 200 }, { x: p.x, y: p.y + 200 }, { x: p.x, y: p.y }], { tolerance: 30 });
```

Progress counts the route still ahead, so a detour that first leads away from the end point isn't reported as stuck (verified live with a 700-unit detour).

## Following objects and players

- `bot.walkToObject(target, { range: 100 })` walks within a 3D range of an NPC, player or object, and follows it if it moves. Its `timeout` applies to each of up to 4 attempts.
- `bot.follow(player, { distance: 150, durationMs, until })` follows a player on the client side. OpenDAoC has no `/follow` or `/stick`.
- `bot.travelTo('spirit hound')` walks to the nearest **static spawn point** with that name from the DB, in this region, through `walkTo` (a navmesh route when meshes are built, else a straight line). `bot.travelTo({ x, y })` is `walkTo`.

## Navmesh routing

No navmesh ships with the server. `bun run navmesh:build` generates `server/navmesh/zoneNNN.nav` from the local DAoC client (`C:\Program Files (x86)\OpenDAoC`, or `--daoc=`), using `server/buildnav`, plus `server/navmesh/lib/Detour.dll` (Windows only, needs VS Build Tools, CMake and a .NET 10 SDK). The default build covers the home regions 1, 100 and 200 (42 zones), the capitals 10, 101 and 201 (one zone each) and Thidranki 252: 46 zones, ~1.3 GB, ~20 min at `--jobs=8`. `--zones=`, `--regions=`, `--all` and `--skip-existing` pick zones.

When the library and at least one `.nav` exist, `walkTo`/`followPath`/`travelTo` route with `NavmeshPathProvider` (Detour through Bun FFI, the same queries the server's `LocalPathfindingMgr` runs):

- Routes go around buildings, walls and cliffs. Live in Cotswold, 800 and 2500-unit walks arrived with 0 reissues.
- A start or destination whose z is a guess is snapped onto the mesh with growing boxes (taller first, then wider).
- Zone borders are crossed like the server does it: at the straight-line border point, snapped onto both meshes. Long routes chain past Detour's 256-poly corridor limit (a 62k-unit route across Camelot Hills takes ~250 ms).
- Any part of the route that can't use a mesh is a straight line, and the walk still arrives. `findPath(...).message` is set whenever any part is such a fallback: the start zone has no `.nav` or its mesh failed to load (the message includes `getNavmeshStore().loadError(zoneId)`), the start is off the mesh, a later zone has no mesh, or the destination is off the mesh or unreachable. A route entirely on the mesh has no message.
- Capitals are mesh only (no heightmap, so no `.terrain`). Planned offline from each teleporter, not walked live: routes go around buildings, about 1.4× the straight distance, and about 90 % of NPC spawns connect. Most others are on a raised floor or behind a counter and stay in reach of a route that stops under 192 units short (Jordheim's Vault Keeper: 104 short, 41 off in z), so the walk ends with the straight fallback above.
- A zone's mesh loads on its first query (~0.1 s, 20–50 MB of memory each).
- `navmeshGroundZ(regionId, x, y, zHint?)` gives the navmesh height (what the server snaps ground targets and mob paths to); `groundAt(regionId, x, y, zHint)` gives the real ground (next section); `getNavmeshStore().at(region, x, y)` gives the raw `NavMesh` (`closestPoint`, `surfaceZ`, `findPath`, `randomPoint`, `raycast`).
- `DAOC_NAVMESH=off` forces straight lines. `DAOC_NAVMESH_DIR` and `DETOUR_LIB` override the paths.
- `raycast` checks whether you can walk straight across the mesh. It is not visual line of sight, and the client still answers every server LoS check with "clear".

## Ground height (navmesh zones)

Navmesh z floats above the real ground: Recast rounds every surface up to its 3.2-unit cell height, adds one more cell inside polygons and rounds higher on slopes. Measured against the client's own terrain over the 42 default zones, the mesh is 0.9–12.5 units above it (p1–p99, median 4.5). A real client draws that as feet above the grass. Interpolating z between path corners made it worse while walking (p5 −17 to p95 +22 units).

So the client's mover takes z from `groundAt` (sdk/ground.ts) on every step and every server position snap:

- **Terrain:** `navmesh:build` (or `bun run terrain:build` alone, under a second) writes `server/navmesh/zoneNNN.terrain`, the exact outdoor heightmap the client uses (256×256 vertices from `zones/zoneNNN/datNNN.mpk`, same triangles as buildnav). Real-client positions sit at floor(terrain z). Outdoors the bot stands on the terrain unless the mesh at its own height (a ±64 poly search around its current z) is an object: 99.9 % of dry outdoor points. A gap in the mesh (eroded at walls, trees, steep slopes) keeps the terrain; it never jumps to a roof or cliff top found further away.
- **Objects** (bridges, roofs, rocks, and all of cities and dungeons, which have no heightmap): mesh z − 2.5, the mean flat-surface offset. A layer counts as an object when it is more than 8 (+16 × slope, at most 40) units above the surface buildnav built the mesh from, so the bot can sink up to 8 units into a low object on flat ground, more on slopes. A floor below the surface (cave, tunnel) counts once the bot's z is closer to it than to the surface.
- **Water at least 40 deep:** z = river surface − 40 and the 0xA9 carries the SWIMMING state flag (`state.movement.swimming`). buildnav moves every terrain vertex under a river to 16 under the surface (deep beds up, shallow banks down), so the mesh in water is that plane; mobs placed by real clients while swimming sat 40 under the surface, and a bot at 40 under it swims with its head at the waterline in a real 1.127 client (checked by eye in Lough Derg). On bank cells the mesh is compared with that warped surface, not the bed. The server only relays the flag to other clients (it never sets `IsSwimming` for 1.124+ clients), so to the server it changes the animation, nothing else. SWIMMING is never combined with SITTING (= DEAD, sent only while dead, see [death-and-rest.md](death-and-rest.md)) or JUMPING (= flying, an autoban under `ban_hackers`). Shallower water: the bot wades on the bed, up to 24 units under the mesh.
- **Swimming is slower, and only the client knows:** a real client swims at 85 units/s at 100 % speed, against 191 running, and the server checks neither (its speed monitor only knows `maxSpeed`). The mover does the same (`state.player.maxSwimSpeed`), times the walk's `speedFactor` like on land (76 units/s at the old 0.9 default, 85 now). From the 1.127 client code (game.dll 0x4388d9; not timed live): `swim = floor(floor((min(100, W) + 100) * 85 / 100) * P / 100)`, with P the speed percent and W the water speed byte of 0xB6. W = 15 gives 97, and W ≥ 100 gives the cap of 170. Wading on the bed is running speed. 1000 units of river take about 13 s. **Routes don't price water:** `walkTo` plans over the navmesh with no cost for it, so a straight route across a lake swims the whole way. Timed live from Ardagh across Lough Derg: 77 units/s against 173 on land, so about 45 %, and 34,000 units took 7:15. A speed pulse speeds up swimming too (about 94 against 77). No route around the water was tried, so the saving is unproven; `followPath` with waypoints round the shore would be the way.
- Ladders (a waypoint that rises more than 48 units and twice its distance) keep the interpolated z.
- `GROUND_TUNING` holds the constants. `DAOC_NAVMESH=off` turns ground correction off with the routing; without `.terrain` files only the mesh − 2.5 rule applies.
- Each runner process loads the meshes of the zones its bot walks through (20–50 MB each) on the first step there.

## Height (z) without navmeshes

Without a navmesh there is **no terrain data**. When `z` isn't given, `StraightLinePathProvider` splits each leg every 1000 units and takes z from `estimateZ`. That function interpolates the heights of nearby spawns, bind points and startup locations.

- Typical error is about 25 units. Worst cases are hundreds of units near cliffs, in towns on hills, and in dungeons. (With navmeshes, snapping 400 Camelot Hills spawns lands within 4 units of their DB z (median), 7 at p90.)
- The server never checks z for movement, but every range check is 3D (melee 128, interact 192). A wrong z makes things "too far away" even when they are close on the map.
- `killNpc`, `walkToObject` and `interactWith` use the target's z from the server, which is reliable. Prefer them to walking to raw coordinates.

## Straight lines and getting stuck

Without a navmesh, the route is a straight line. It goes through walls, but the server doesn't stop you, so in practice walks rarely fail. When they do:

- `stuck` with "max speed 0" in the message: you are rooted, stunned or overloaded. Wait or drop items.
- `stuck` otherwise: no progress for `stuckMs`, usually a correction loop. Retry with waypoints.
- `timeout`: the walk took longer than 1.5 × the planned ETA + 15 s, for example after many corrections.

A custom `PathProvider` can be passed per call or set with `setDefaultPathProvider()` (exported from `sdk/actions.ts`, along with `StraightLinePathProvider` and `NavmeshPathProvider`).

## Verified live

- A 300-unit walk out and back from the Prydwen Keep start: 0 corrections.
- Walks of 2400–3900 units to monster camps, and back to merchants.
- `followPath`, `stop`, `face`, `follow` (another bot), and `travelTo(/spirit hound/)`.
- A 5-point exploration loop of radius 600 (`bots/examples/explorer.ts`) arrived within tolerance on every leg.
- Never observed live: the correction re-issue, the `stuck` path and the `timeout` path (unit-tested only).

## Speed

- **Sprint:** `bot.useAbility('Sprint')` toggles it (verified live). It drains endurance.
- **Speed buffs:** the mover follows the max speed the server sends, so speed buffs apply automatically.
