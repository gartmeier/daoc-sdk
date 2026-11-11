# Walking

## How movement works

DAoC has no click-to-walk. The headless client's **mover** streams position updates (0xA9) itself:

- Every 200 ms while moving, and at least once a second while idle as a heartbeat.
- At the max speed the server gave us, like a real client: full run speed is 191 units/s. It ran at 0.9 of that (171) until 2026-11-08, which a player watching could tell; the server's speed monitor allows 1.15 ×.
- Every update says "on the ground" with heading bit `0x1000` (`HEADING_ON_GROUND`), as a real client does: on the ground and in the short hops down a slope, off only in a real fall (more than 30 units up, until it lands). The server relays the heading word as sent, and without the bit a real client watching draws the player in steps at each 200 ms update, bobbing up and downhill, instead of moving it along the ground. That was what made bots easy to tell from players; with it a viewer can't tell Movewalk from a real player (seen 2026-11-08).
- Downhill it falls off the slope like a real client instead of sliding down glued to it: gravity 1000 units/s², nothing pulling it onto the ground, and the vertical speed in the update's zSpeed, which the server relays to every viewer. Uphill and on the flat z is the ground and zSpeed 0, exactly as a real client sends it. The fall-damage field's on-ground bit stays off in every update, as a real client's did in a capture (landings after falls at −665 included), so it never takes fall damage.
- It speeds up and slows down like a real client run from the keyboard, instead of starting and stopping at full speed: +250 units/s² from rest (0 → 191 in 0.76 s and 73 units; updates read 50, 100, 150, 191), and −500 units/s² to stop (191 → 0 in 0.38 s and 37 units; updates read 191, 91, 0). The update's speed is the speed of the moment and each step covers what those speeds give. A move slows down to its rest point, tolerance / 2 short of the destination, and never passes it; a short move peaks below full speed. A move re-issued mid-run (chase, follow, the next leg of a walk) keeps its speed, and path corners keep it too: Vue turned at full speed. A lower speed limit (water, a snare, a buff ending) takes effect at once, since the server's speed monitor would object to anything above it; a higher one is ramped up to. The ramp leaves the heading bit and the fall alone.
- `sdk.sendStop()` / `bot.stop()` slow down like a player letting go of the keys: the bot goes on along its route for 0.38 s and up to 37 units, `movement.moving` stays true meanwhile, and the move ends as `stopped`. Casting, sitting and server moves still stop it dead, and the next move starts from 0. The ramp costs a walk about 0.57 s at 191 (`rampedMoveMs` in client/movement.ts, which moveTo's `etaMs` uses).

**Comparing with a real client:** `bun client/dev/record-moves.ts <observerBot> <Name> <Name>` logs in an idle bot and records every position update the server relays for those players, with the terrain under each and the raw bytes; `--analyze <file>` compares them by downhill, flat and uphill. A stealthed GM is invisible to it, and creating `<file>.stop` logs it out cleanly. What a client *sends* only shows in a packet capture: the game packets are unencrypted, and `tcpdump` in the gameserver container (`apk add tcpdump`, gone when the container is recreated) on ports 10300/10400 captures every client, all over TCP here (no UDP reached the server). Measured 2026-11-08 on the slope east of the Camelot Hills start (Vue, a real 1.127 client, against Movewalk): same z uphill and on the flat; downhill the real client was in the air in 59 % of updates (up to 54 units, zSpeed down to −437), and gravity 1000 at 60 steps/s replays its height within 2 units. How it starts and stops depends on what drives it. Run from the keyboard, the speeds it sent (the server relays a client's speed as is, PlayerPositionUpdateHandler.cs:86) ramp: at 191 about 40 different values between 2 and 190 over 7 runs (at-191b.jsonl), +50 per update from rest (38, 88, 139, 190, 191; 600–870 ms from the first non-zero speed) and −100 per update to stop (191, 90, 0); at 288 with a speed buff the same +250 units/s² (25, 78, 131, 184, 237, 288) and 288, 232, 132, 32, 0 (vue-vs-bot.jsonl). Following with /stick (the capture, cap.a9.jsonl) it sent only 0, 191 and 95.5: 0 to 191 in one update and back to 0 in one, with 95.5 for a few updates after a turn-around. Differences no viewer sees: it sends position every 210–217 ms while running (bot 200), every ~2 s idle (bot 1 s), and a ping every 5 s (bot 30 s).

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
- **Water:** the mesh marks river polys `Swim`, and Detour weighs them like land. When the shortest way swims, a second query with `Swim` left out (`NavMesh.findPath(..., exclude)`) finds the dry way round, and the walk takes it while it is no slower: water counted at 191/85 (run against swim speed). Where no dry way exists (Thidranki's rivers away from the Faste's bridges) the walk swims straight across. A destination in water is reached by swimming.
- Zone borders are crossed like the server does it: at the straight-line border point, snapped onto both meshes. Long routes chain past Detour's 256-poly corridor limit (a 62k-unit route across Camelot Hills takes ~250 ms).
- Any part of the route that can't use a mesh is a straight line, and the walk still arrives. `findPath(...).message` is set whenever any part is such a fallback: the start zone has no `.nav` or its mesh failed to load (the message includes `getNavmeshStore().loadError(zoneId)`), the start is off the mesh, a later zone has no mesh, or the destination is off the mesh or unreachable. A route entirely on the mesh has no message.
- Capitals are mesh only (no heightmap, so no `.terrain`). Planned offline from each teleporter, not walked live: routes go around buildings, about 1.4× the straight distance, and about 90 % of NPC spawns connect. Most others are on a raised floor or behind a counter and stay in reach of a route that stops under 192 units short (Jordheim's Vault Keeper: 104 short, 41 off in z), so the walk ends with the straight fallback above.
- A zone's mesh loads on its first query (~0.1 s, 20–50 MB of memory each).
- `navmeshGroundZ(regionId, x, y, zHint?)` gives the navmesh height (what the server snaps ground targets and mob paths to); `groundAt(regionId, x, y, zHint)` gives the real ground (next section); `getNavmeshStore().at(region, x, y)` gives the raw `NavMesh` (`closestPoint`, `surfaceZ`, `findPath`, `randomPoint`, `raycast`).
- `DAOC_NAVMESH=off` forces straight lines. `DAOC_NAVMESH_DIR` and `DETOUR_LIB` override the paths.
- `raycast` checks whether you can walk straight across the mesh. It is not visual line of sight: that is `sdk/vision.ts` `lineOfSight` over the terrain heightmap, which also answers the server's LoS checks.

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

## Slopes

The navmesh covers steep ground: in Thidranki 99-100 % of dry spots at every slope up to 2:1 (63°) and beyond have a poly within 8 units. The server checks no z either. So Detour routes straight up a cliff a real client would slide down, and nothing but our own routes keeps a bot off one. `sdk/group/slope.ts` reads the slope from the client's terrain (`zoneNNN.terrain`, the steeper of the two triangles in each 256-unit cell):
- `slopeAt(region, p)`: rise per unit, 0 without terrain. `isSteep` at `STEEP` 0.7 (35°). `isLevel(region, p, 300)`: `p` and 16 spots round it within 300 not steep: where a group can stand round a stop.
- `slopeCost`: extra cost per unit walked, 0 up to `GENTLE` 0.5 (27°), rising to 2 at `CLIFF` 1.0 (45°), 6 beyond. `safePath` adds it to each 400-unit cell (the mean of 5 samples), and a straight line with any cliff, or more than 200 units over 35°, isn't clear. Routes go round hills and cross rivers where the banks are low.
- `slopeAlong(region, a, b)`: units over 35° and over 45° on a straight way, and the steepest slope.
- `drySpot` (water.ts) also looks for level ground within 800 of the nearest dry spot. A river's banks are often its steepest ground, so a stop in a river lands past the bank's top. With no level ground near, the nearest dry spot will do. `{ level: false }` turns this off.

Thidranki's dry ground: half rises less than 0.28 per unit, 75 % less than 0.51, 90 % less than 0.94. The ground over 45° runs along the three rivers and round the map's edge. Walks between legs still use the navmesh (`walkTo`), so within a 1500 leg a member can still cut over a slope that `safePath` went round. The reports' `Slope:` line (observer) measures how much time that leaves on steep ground.

## Move guard

`sdk.setMoveGuard(guard)` cuts every move before it is sent: `walkTo`, `walkToObject`, `castSpell`'s approach and `killNpc`'s chase all end in `sendMoveTo`. The guard gets where we stand, the destination and the waypoints, and returns a shorter move or null. A cut that ends within `MOVE_GUARD_HERE` (48) of us, or within the move's tolerance, is refused with reason `water`, and the walk fails with that reason. A cut move is sent to the cut, and `sendMoveTo` says where in `heldAt`. A walk that stops there ends with reason `water` too. Before that fix (2026-11-11), the mover stopped up to its tolerance (60-80) short of the bank spot. A re-issue went to that spot, which is dry and not cut, and "arrived" at once. After 8 of those in about 2 s the walk failed as `stuck`, which the behaviours' water rules don't read, so the member walked at the river again. Hibernia, rounds 139 and 172: Brigid 5 such stucks and Ciaran 12 in one fight. It returns a remover. Group members with `stayDry` set `water.ts dryMoveGuard`: no move from dry ground ends in deep water, while a crossing to dry ground is left alone (learnings/rvr.md "Members keep out of the river themselves"). The members' guard works only while the orders are `engage` or `pull`. A guard sees each step, not where the walk ends: group travel walks in steps (`walkTowardSlot`'s 2500 units, the column's raw moves), and on a river crossing a step ends mid-river. The first version cut those steps, and Albion and Midgard stood at the bank through arena rounds 72-73. Before a rule on moves lands, test it on a stepped walk and limit it to the phases it is for (`water-guard.test.ts`). The check costs one terrain lookup per move, and a cell with no river at its corners is never sampled.

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
