# Tail fixes

## client

## client/ fixes: dead target, 0x04 sit state, log timestamps

All three items are fixed in client/** only. `bun test ./client` passes (162 tests, 0 fail) and `bun run typecheck` is clean. I didn't run anything live, so no processes were started, and nothing is committed.

### 1. Target cleared on death
- **Fix (`client/model/world-model.ts`):** `markSelfDead()` now sets `self.targetObjectId = null`. This matches the server, which clears the target in `GamePlayer.Die` (`TargetObject = null`, GamePlayer.cs:5743 and :5900) without telling the client.
- **Test (`client/model/model.test.ts`):** the self-death test now sets a target first and expects it to be null after 0xAE.

### 2. Sit state on the two 0x04 paths that don't stand the player up
Until now every non-heading 0x04 was treated as `MoveTo` and stood the player up. The two other senders are now told apart:
- **Height nudge when underwater (GamePlayer.cs:8378-8384):** in a zone without diving, the server adds 1 to Z and sends a jump on every 0xA9 that is underwater. The position check runs before the new position is applied (PlayerPositionUpdateHandler.cs:78/669).
  - `client/movement.ts`: `Mover` keeps its last 4 sent positions. The new `isHeightNudge(x, y, z)` returns true when x and y match one of them within 1.5 units and z is 0 to 2.5 units higher.
  - `client/session.ts`: on a nudge, only z is adopted. Sitting is kept, there is no snap or correction count, and no 0xA9 goes out right away, because each 0xA9 would trigger another nudge.
- **Rider resync (PlayerPositionUpdateHandler.cs:36-49):** the server moves a rider back to its steed with a jump and leaves `IsSitting` alone.
  - The client now decodes 0xC8 Riding: `ServerOp.Riding` in `client/protocol/opcodes.ts`, `decodeRiding` in `client/protocol/incoming/world.ts` (PacketLib168.cs:1304-1322).
  - `client/session.ts` tracks `session.steedId` for our own object id (GamePlayer.cs:7664, :7708) and resets it on world entry and region change.
  - A 0x04 while mounted snaps the position but keeps sitting. A real `MoveTo` dismounts first (GamePlayer.cs:7891-7892), so it is still handled as a `MoveTo`.
- **Tests (`client/session.test.ts`):** two new cases:
  - The nudge keeps sitting, adopts z only and sends nothing. A later real `MoveTo` stands the player up.
  - Another player's 0xC8 is ignored. A resync while mounted keeps sitting. After a dismount, a 0x04 stands the player up.

### 3. Viewer times about 1 h off the runner logs
The bug was ours, in the runner logs. The viewer was already correct:
- **Message times are not server time.** The model stamps `receivedAt` with the client's own `Date.now()`, and the viewer shows it in local time with `getHours()` (`gateway/viewer/app.ts:893`).
- **The runner and swarm logged UTC.** Both used `new Date().toISOString().slice(11, 23)`. The machine is on Europe/Berlin (UTC+1 now that summer time has ended), which explains 13:51 in the viewer against 12:56 in the logs.
- **Fix:** new `client/log-stamp.ts` with `logStamp()`, which formats local time as `HH:MM:SS.mmm`. `client/runner.ts` and `client/swarm.ts` now use it. `client/log-stamp.test.ts` covers it.
- **gateway/viewer/:** nothing needs changing there.

## sdk

## grind / example fixes

grind now ends close to `durationMs`, and with `respawn: true` it no longer returns with the bot dead. caster.ts and grinder.ts handle the problem results. `bun test ./sdk ./bots` gave 181 pass, 0 fail, and `bun run typecheck` is clean. Nothing was checked on the live server and nothing was committed.

### Files changed
- **`C:/Users/joshu/Code/daoc-sdk/sdk/actions.ts`** (`grind`, `GrindOptions`)
  - **New option `minEngageMs`:** grind won't pull a new target when less than this much time is left. The default is the average kill time so far in the run, 15 s before the first kill, but never more than half of `durationMs`. That cap means short grinds still fight. A monster that is already attacking is always fought.
  - **No walking or resting late in the run:** when time is short and nothing is attacking, the loop stops instead of resting or walking.
  - **Last kill is bounded:** each kill now gives up at `min(killTimeout, remaining + 30 s)`, so a run overshoots by about 30 s at most. The old worst case was the full 60 s.
  - **Walks back to the anchor** (when drifted, idle, or after a respawn) now time out with the run's deadline, with a 5 s minimum. After a respawn, the walk back is skipped if less than `minEngage` remains.
  - **Dead at the end:** with `respawn: true`, grind calls `releaseAndRespawn()` before returning. If the release fails, it returns `stopReason: 'error'` with the message "Could not respawn: …". Without `respawn`, a death still returns `'died'`.
  - The JSDoc for `durationMs`, `minEngageMs` and `respawn` is updated.
- **`C:/Users/joshu/Code/daoc-sdk/sdk/API.md`:** regenerated with `bun run docs:api`.
- **`C:/Users/joshu/Code/daoc-sdk/bots/examples/caster.ts`:** there is a new `STOP_CASTING` set: `no_power`, `not_found`, `spell_not_found`, `no_target`, `invalid_target`, `died`, `dead`. Any of these ends the casting loop instead of retrying every second. The existing code after the loop then finishes in melee or releases.
- **`C:/Users/joshu/Code/daoc-sdk/bots/examples/grinder.ts`:** after grind it checks `bot.isDead()`. If the bot is dead, it releases once more and logs it. The result now also contains `message`, `isDead` and `respawn`.

### Tests (`C:/Users/joshu/Code/daoc-sdk/sdk/test/actions.test.ts`, grind block)
- **Changed:** "counts a death in the last fight … and releases it with respawn". It now adds a release handler and checks that `release` was sent once and `isDead()` is false.
- **New:** without `respawn`, a death in the last fight returns `'died'` and nothing is released.
- **New:** with `minEngageMs` larger than the time left, there are no attacks and grind returns in under 500 ms.
- **New:** the default margin is the average kill time, so there is no second pull too close to the deadline. I confirmed this test fails with `minEngageMs: 0`: it got 2 kills where 1 was expected.
- **New:** a monster that is already attacking is still fought when time is short.

## docs

## Docs brought up to date with the final-pass changes

I checked every claim below against the code (`gateway/gateway.ts`, `gateway/security.ts`, `gateway/viewer/*`, `sdk/index.ts`, `sdk/runner.ts`, `sdk/actions.ts`, `mcp/execute-code.ts`, `mcp/api/index.ts`, `client/dev/swarm-check.ts`). Nothing is committed and `docs/build-reports` is untouched.

Licence/attribution, submodules, Windows stop advice and MCP script mode were already done by the earlier docs-bots-data fixer in CLAUDE.md, the learnings and the README. I left the README License section as it was: `scripts/license-notices.test.ts` parses it, and its file list matches every file that carries the Lost City notice. There is still no root `LICENSE` file and no `license` field in package.json; adding them is the maintainer's call.

### Files changed
- **`C:/Users/joshu/Code/daoc-sdk/CLAUDE.md`** (short additions only)
  - Setup step 3: the gateway listens on 127.0.0.1 and checks no passwords there; points to README "Gateway access".
  - Action semantics: what throws now includes `BotDisconnectedError` and `BotPreemptedError` in `runScript`. The "one controller" line lists what takes control (scripts, `execute_code`, `swarm-check`) and what only observes (`cli.ts`, `chat.ts`).
  - Troubleshooting, new `BotPreemptedError` bullet: the script aborts, the client keeps running, and the next `execute_code` takes control back.
  - Troubleshooting, new bullet for gateway answers 403, 401 and 415.
- **`C:/Users/joshu/Code/daoc-sdk/README.md`**
  - Quick start: how to stop a client, including the Windows signal caveat.
  - Writing bots: a "One controller per bot" bullet covering `BotPreemptedError`.
  - Architecture: the gateway bullet now lists `/say` and `/dm`.
  - New "Gateway access" subsection:
    - `GATEWAY_HOSTNAME` (default 127.0.0.1) and `AGENT_PORT`.
    - `GATEWAY_AUTH=botenv|none`: botenv is the default off loopback, the password comes from bot.env, and HTTP callers send it as a Bearer header or a body `password`.
    - Under botenv the viewer needs the password even to observe.
    - Origin and Host checks, with CORS headers only for loopback origins.
    - The JSON content-type rule, with a curl example.
- **`C:/Users/joshu/Code/daoc-sdk/docs/DESIGN.md`**
  - Three new sub-bullets under the gateway bullet: takeover (`sdk_error` text, `wasPreempted()`/`getPreemptedReason()`, `BotPreemptedError` in both error and wait modes), exposure (`security.ts`, 403/415), and auth (the pluggable hook, `botEnvAuth`, how the default is chosen).
  - `security.ts` added to the layout.
  - A comment on `PASSWORD` in the bot.env block.
- **`C:/Users/joshu/Code/daoc-sdk/docs/SERVER.md`**: a gateway row in the ports table, and the quit actions plus the Windows signal caveat in the link-dead gotcha.
- **`C:/Users/joshu/Code/daoc-sdk/learnings/README.md`**: rule 2 now covers one controller per bot and `BotPreemptedError`.
- **`C:/Users/joshu/Code/daoc-sdk/learnings/combat.md`**
  - Grind `stopReason` values.
  - `noTargetTimeoutMs` and `no_targets`; resting resets the idle count.
  - The last fight runs past `durationMs`; check `isDead()` afterwards.
  - `face(number)` is always a heading.
- **`C:/Users/joshu/Code/daoc-sdk/learnings/spells.md`**
  - `castSpell` always selects the target and retries once on `no_target`.
  - New completion-evidence rules: strong evidence vs weak evidence after the cast time, and extra-damage lines are skipped.
  - New `died` vs `dead` reasons.
  - The stale "damage-add counted" limitation is replaced with the fixed behaviour; that fix is unit-tested but not re-run live.
- **`C:/Users/joshu/Code/daoc-sdk/learnings/regions-and-zones.md`**: `bot.face(1024)` is a heading, never an object id.
- **AGENTS.md**: no change needed (it points to CLAUDE.md).

### Tests
- `bun test scripts/`: 11 pass, 0 fail. This includes `license-notices.test.ts`, the only test that reads these docs.
- I checked the README gateway claims against an in-process gateway on port 0 (scratch script in `C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/docs-check/check.ts`). Results:

  | Request | Status |
  |---|---|
  | POST `/say` as `text/plain` | 415 |
  | POST `/say` as JSON | 409 (past the content-type check; no bot connected) |
  | Foreign `Origin` | 403 |
  | `Origin: http://localhost:5173` | 200, origin echoed back in `Access-Control-Allow-Origin` |

  The gateway was stopped and the process exited. No bots or long-running processes were started.

## Check

## Final-pass smoke results

`bun run check` passes and the API docs match `sdk/API.md`, so nothing needed fixing. In the live smoke, grind ended before 60 s in every run and counted its one death correctly, and the viewer times now match the runner log. caster.ts ran but the level-1 Mage died, as expected. All bots quit cleanly, the gateway is stopped, and nothing is committed.

| Check | Result | Details |
|---|---|---|
| `bun run check` (typecheck + tests) | PASS | 446 pass, 0 fail, 29 files |
| `bun run docs:api:check` | PASS | `sdk/API.md` verified: 48 BotActions methods, 101 BotSDK methods, 71 types |
| Fresh accounts | OK | ftl1 = Ftlb (Albion Fighter), ftl2 = Ftlc (Midgard Viking), ftl3 = Ftld (Albion Mage). All are new accounts at PrivLevel 1, created on first login. |
| Gateway :7780, runners, cli | PASS | All three clients reached `in game (phase playing)` within about 5 s. `sdk/cli.ts` showed `In Game: true` for each. |
| grinder.ts 60 s, ftl1 Fighter (run 1) | PASS | 3 kills, 0 deaths, `duration`, grind reported 53 s |
| grinder.ts 60 s, ftl2 Viking | PASS | 2 kills, 0 deaths, `duration`, grind reported 56 s, ended at 13 % HP |
| grinder.ts 60 s, ftl1 Fighter (run 2) | PASS | 8 kills, 0 deaths, `duration`, grind reported 56 s, wall clock 58.5 s including connect |
| grinder.ts 60 s, ftl3 Mage at the bind point | PASS | No target within 3000 units. Stopped at 45 s (`duration`) because 15 s, the default margin before any kill, were left. Wall clock 47.5 s. |
| Death reporting: grinder 60 s, ftl3 at the puny skeleton camp | PASS | `deaths: 1`, `failures: 1`, `stopReason: duration`, `isDead: false`, wall clock 48.0 s. grind released, walked back and ended alive. |
| caster.ts, ftl3 Mage | Works as designed | Self-buff (Ward Blow), approach to 1515 units, 2 Minor Vitality Drain casts (5 damage), 2 interrupts, melee, died, released once: "Respawned at 1:559975,513748". |
| Viewer vs runner log times | PASS | My `/say` "timecheck one": runner log `14:15:29.060`, viewer `14:15:29`, local clock 14:15:28.8 (Europe/Berlin, UTC+1). The kill lines match too. |
| Shutdown | PASS | `swarm-check ftl1 ftl2 ftl3 --quit`: each runner logged `exit 0: quit`. Gateway stopped; nothing listens on 7780 and `/status` gets no answer. |

### Still open
- **0x04 changes not tested live.** The height nudge underwater and the rider resync both need water or a mount, which none of the runs reached. They are covered only by the unit tests.
- **`no_targets` never shows up on short grinds.** `noTargetTimeoutMs` defaults to 60 s, but the run stops 15 s before the end when nothing is in range. For any grind up to 75 s, an empty area therefore returns `duration`.
- **The end-of-script state summary can be out of date.**
  - caster.ts printed `HP 0/31` right after "Respawned"; `cli.ts` a few seconds later showed 31/31.
  - The grinder summaries showed `IN COMBAT` right after the last kill, but no monster followed.
- **Fighting a death in the last fight is still only unit-tested.** In the one live death, the bot was released and fought again well before the deadline.
- **A level-1 Mage can't solo-kill a puny skeleton with caster.ts.** Melee interrupts every cast and there is no kiting helper. This is a known limitation.
- **A viewer from someone else connected to my gateway.** The gateway log showed a `viewer-observe -> acpt1` connection that I didn't start; I left it alone. I opened and closed only my own tab (tab-5).

### Files
- Created: `C:/Users/joshu/Code/daoc-sdk/bots/ftl1`, `C:/Users/joshu/Code/daoc-sdk/bots/ftl2` and `C:/Users/joshu/Code/daoc-sdk/bots/ftl3` (bot.env, script.ts, lab_log.md). The scratch script `bots/ftl3/death-grind.ts` was deleted after use.
- Logs: `C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/` contains gw.log, ftl1.log to ftl3.log, grind1.out, grind2.out, grind1b.out, grind3.out and caster3.out.