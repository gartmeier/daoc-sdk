# Resting, death and quitting

## Resting

```typescript
const r = await bot.rest({ healthPercent: 90 });                 // casters: add manaPercent: 80
// r.healthPercent, r.manaPercent, r.durationMs, r.reason ('attacked' | 'in_combat' | 'timeout' | 'died')
```

- **Sitting:** `rest` sits, and waits for the server's "You sit down." (a refused sit fails). It stands up again when the thresholds are reached, on failure, and on cancel.
- **Live:** health went from 89 % to 100 % in 18 s at level 1. (DAoC regenerates faster sitting; standing rates were not measured.) A level-5 Blademaster from 16-34 % took about 96-160 s including its walks, and about 80 s at level 6. `rest` stops at 120 s by default, so size a script's timeout for that.
- **Attacked while sitting:** a mob attacking you while you sit ends the rest with `attacked`. Fight it (`bot.getAttackers()[0]`), then rest again. `rest` refuses to start while an NPC in view targets you or hit you in the last 6 s (`in_combat`).
- **No sitting:** `bot.waitForHealth(percent)` waits without sitting.
- **Healers** (Brother Maynard <Healer>, near the Albion start) answer interact. In DAoC they remove constitution loss after deaths; untested here.

## Death

You know you died when `bot.isDead()` / `player.isDead` is true. `player.deathCount` also goes up.

- **Running actions fail with `died`:** `walkTo`, `killNpc` and `grind` stop.
- **The server says** "You will now release automatically in 8 more seconds!" after a death. It may release you before you do.
- **Release yourself:**
  ```typescript
  if (bot.isDead()) {
      const rel = await bot.releaseAndRespawn();   // retries /release until allowed; waits for the bind point
      console.log(rel.message, rel.regionId, rel.position);
  }
  ```
  After a release you are at your **bind point**, alive with low health. Rest before fighting again.
- **Grinding:** `grind({ respawn: true })` releases, walks back to the anchor and carries on. With `respawn: false` (the default) it stops with `stopReason: 'died'`. Deaths the server auto-released are counted too.
- **Viewers:** a real client shows a player as dead from the state byte of its 0xA9 (0x14, SITTING|SWIMMING), and the server relays that byte as the player's client sent it. The client sends it while `player.isDead`. Without it a real client showed the corpse dying and vanishing over and over, with one 0xAE and no remove or create from the server; with it the corpse lies still (verified in a real 1.127 client). Moving, turning and jumping are refused while dead.
- **Nobody releases an idle corpse for you:** without a running script a dead bot lies there for the server's full release timer, 900 s.
- **Bind points:** `nearestBindpoint(regionId, x, y, realm)` from `data/index`. Binding elsewhere: `/bind` near a bind stone answers "You are now bound to this location." (verified live at Ardagh).
- **Unverified:** the XP and constitution loss penalties at low level.

## Quitting and the 60 s lockout

- **Stopping cleanly:** a quit action. The runner sends `/quit`, waits for the character screen, then exits 0 within seconds (verified):
  - `await sdk.sendQuit()` from a script or MCP `execute_code`;
  - MCP `disconnect_bot`;
  - `bun client/dev/swarm-check.ts <bot> [<bot> ...] --seconds=0 --quit` from a shell (verified live; it also releases a dead character first);
  - Ctrl+C typed in the client's **own** console.
- **Signals from another process are not clean on Windows:** `process.kill(pid, 'SIGINT')`, `child.kill()`, `Stop-Process` and `taskkill` terminate bun outright (Node/Bun emulate signals on Windows with TerminateProcess), so the runner never sends `/quit` and you get the 60 s lockout below. Git Bash `kill -INT` doesn't reach bun at all (verified live). From a script:
  ```typescript
  await runScript(async ({ sdk }) => (await sdk.sendQuit()).message, { printState: false });
  ```
- **Quit timer:** with `disable_quit_timer` quit is instant out of combat. After recent combat the server still says "You will quit after sitting for 59 seconds", so give it a minute.
- **Lockout:** a socket that drops while you are in the world leaves the character **link-dead for 60 s**. Logins are refused meanwhile with 0x2C code 0x11 (`AccountIsInLogoutProcedure`). The runner waits 65 s and retries by itself. Just wait.
- **Quitting while dead:** `/quit` is refused while dead. `sdk.sendQuit()` releases first by itself (verified live: "quit: dead, releasing first", then exit 0).
- **Event loop:** a busy-wait loop that stalls the event loop for more than 5 s stops the heartbeat, and the server starts link-death recovery.
