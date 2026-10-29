# Walking

## How movement works

DAoC has no click-to-walk. The headless client's **mover** streams position updates (0xA9) itself:

- Every 200 ms while moving, and at least once a second while idle as a heartbeat.
- At up to 0.9 × the max speed the server gave us. Full run speed is 191 units/s, about 172 at the 0.9 cap.

The server checks only 2D speed. It doesn't check walls, cliffs or z. If the client ran too fast, the server teleports it back (a **correction**), and `walkTo` re-issues the move from the new spot.

## walkTo

```typescript
const r = await bot.walkTo(574797, 530161);           // z estimated
if (!r.success) console.log(r.reason, r.message);     // stuck | timeout | died | region_changed | no_path | bad_args
console.log(r.distance, r.reissues);                  // 2D distance left, re-issues after corrections
```

| Option | Default | Notes |
|---|---|---|
| `z` | estimated | pass it when you know it (an NPC's z, a spawn's z) |
| `tolerance` | 64 | arrival radius on the ground plane |
| `stuckMs` | 8000 | fail when the remaining route hasn't shrunk for this long |
| `timeout` | 1.5 × ETA + 15 s | overall deadline |
| `speedFactor` | 0.9 | fraction of max speed; keep it ≤ 0.9 |

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
- `bot.travelTo('spirit hound')` walks to the nearest **static spawn point** with that name from the DB, in this region, in a straight line. `bot.travelTo({ x, y })` is `walkTo`.

## Height (z)

There is **no terrain data and no navmesh** in this server image. When `z` isn't given, `StraightLinePathProvider` splits each leg every 1000 units and takes z from `estimateZ`. That function interpolates the heights of nearby spawns, bind points and startup locations.

- Typical error is about 25 units. Worst cases are hundreds of units near cliffs, in towns on hills, and in dungeons.
- The server never checks z for movement, but every range check is 3D (melee 128, interact 192). A wrong z makes things "too far away" even when they are close on the map.
- `killNpc`, `walkToObject` and `interactWith` use the target's z from the server, which is reliable. Prefer them to walking to raw coordinates.

## Straight lines and getting stuck

The default route is a straight line. It goes through walls, but the server doesn't stop you, so in practice walks rarely fail. When they do:

- `stuck` with "max speed 0" in the message: you are rooted, stunned or overloaded. Wait or drop items.
- `stuck` otherwise: no progress for `stuckMs`, usually a correction loop. Retry with waypoints.
- `timeout`: the route was longer than the estimate, for example after many corrections.

A custom `PathProvider` can be passed per call or set with `setDefaultPathProvider()` (exported from `sdk/actions.ts`). `NavmeshPathProvider` is a stub that always fails (TODO: Detour plus `.nav` files).

## Verified live

- A 300-unit walk out and back from the Prydwen Keep start: 0 corrections.
- Walks of 2400–3900 units to monster camps, and back to merchants.
- `followPath`, `stop`, `face`, `follow` (another bot), and `travelTo(/spirit hound/)`.
- A 5-point exploration loop of radius 600 (`bots/examples/explorer.ts`) arrived within tolerance on every leg.
- Never observed live: the correction re-issue, the `stuck` path and the `timeout` path (unit-tested only).

## Speed

- **Sprint:** `bot.useAbility('Sprint')` toggles it (verified live). It drains endurance.
- **Speed buffs:** the mover follows the max speed the server sends, so speed buffs apply automatically.
