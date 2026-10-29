# Build

# Report: runner, swarm and MCP pipeline (end to end)

The full pipeline works against the live OpenDAoC server: all five live checks (a) to (e) passed. `bun run check` has one failure: the API.md currency test. It fails because the other agent's in-progress `sdk/actions.ts` changed BotActions. I did not change any public BotSDK or BotActions method, so I did not regenerate API.md. The actions.ts owner needs to run `bun run docs:api`. Typecheck is clean, and the other 259 tests pass. `bun test ./client ./mcp` passes (148 tests).

## Files
**New**
- `C:/Users/joshu/Code/daoc-sdk/client/bridge.ts`: `GatewayBridge`, a port of the rs-sdk lite runner and GatewayConnection.
- `C:/Users/joshu/Code/daoc-sdk/client/bridge-config.ts`: reads and validates bot.env.
- `C:/Users/joshu/Code/daoc-sdk/client/runner.ts`
- `C:/Users/joshu/Code/daoc-sdk/client/swarm.ts`
- `C:/Users/joshu/Code/daoc-sdk/client/bridge.test.ts`: 16 tests, using a fake gateway (Bun.serve on port 0) and a fake client.
- Live scripts: `C:/Users/joshu/Code/daoc-sdk/client/dev/e2e-script.ts`, `mcp-e2e.ts`, `swarm-check.ts`

**Changed**
- `C:/Users/joshu/Code/daoc-sdk/client/model/classes.ts`: rewritten. Class, race, gender and stat rules now come only from `data/index.ts` (`validateCharacter`, `defaultStats`). Only the per-race creation models stay here.
- `C:/Users/joshu/Code/daoc-sdk/client/model/world-model.ts`: the maxConcentration fix, and message ids that stay monotonic across re-logins.
- `C:/Users/joshu/Code/daoc-sdk/client/session.ts`: an invalid creation plan now fails as `creationFailed`, and plan warnings are logged.
- `C:/Users/joshu/Code/daoc-sdk/client/model/model.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/mcp/api/index.ts`, `mcp/execute-code.ts`, `mcp/server.ts`, `mcp/bot-manager.test.ts`

## Public API
- **`GatewayBridge(client: BridgeClient, opts)`**
  - Methods: `.run(): Promise<BridgeExit>`, `.stop(reason)`. Fields: `.logins`, `.isRegistered`, `.isStopping`.
  - Options: `relogin`, `lockoutBackoffMs` (default 65 s), `loginRetryMs`/`loginRetryMaxMs`, `maxLoginAttempts` (default 5), `heartbeatMs` (default 1 s), `reconnectMinMs`/`reconnectMaxMs`, `showChat`, `stopLoginWaitMs`.
  - Exit codes: 0 for a clean stop, save_and_disconnect or quit; 1 for an unexpected session end or when transient login retries run out; 2 for a fatal login or config error (`loginDenied`, `creationFailed`, `realmLocked`, `characterNotFound`, bad bot.env).
  - A `quit` action is handled by the bridge itself in any phase, including mid-login and during a back-off: it replies success, quits cleanly and exits 0.
  - While not in game it keeps publishing state; during a back-off `connection.lastError` reads "…; retrying login in N s".
- **bot.env loading:** `loadBotConfig(name)`, `botConfigFromEnv(name, env)`, `parseServer()`, `createBotBridge(config, opts)`, `BotConfigError`.
- **Swarm:** `new Swarm(names, {staggerMs, reportMs})` with `.run()`, `.stop()`, `.statusLine()`. CLI: `bun client/swarm.ts a b c [--stagger=ms] [--report=s]`. Each bot gets its own gateway connection, with `relogin: true`.
- **`planCharacter()`** now also returns `warnings`. `RACE_MODELS` is exported; the `CLASSES` and `RACES` tables are gone.
- **`BotManager`**
  - `disconnect(name, {stopClient?})` returns `{stoppedClient, killed}`. For a client the manager spawned, it sends a quit action, waits up to `clientStopTimeoutMs` (default 90 s) for the process to exit, and kills it only after that.
  - `ensureLiveClient` now also waits for an attached client that is still logging in, instead of returning early.
- **`execute_code`:** the user timeout now starts once the bot is ready, so client start-up does not count against it.
- **MCP tool descriptions** for `disconnect_bot` and `timeout` are updated.

## Bugs fixed
- **maxConcentration 16960:** the 0xAD decoder was correct. The server sends `(ushort)1000000` for classes with no mana stat (`MaxConcentrationCalculator.cs:20`, `PacketLib190.cs:68`). The model now reports 0/0, and a regression test covers it. Live, run1, run2 and the swarm bots report `maxConcentration: 0`.
- **Message ids** used to restart at 1 on each re-login. They are now monotonic for the whole process.
- **The old class table was wrong** for Bainshee and Valkyrie (both are uncreatable on this server). It is replaced by the C#-derived data.

## Verified live
- **(a)** `bun sdk/cli.ts run1` shows the in-game state. Character Runone was created and the account auto-created.
- **(b)** The `runScript` script (`client/dev/e2e-script.ts run1`) passed every check: 200-unit move with 0 corrections, setTarget, say echoed, walk back, inGame.
- **(c)** `client/dev/mcp-e2e.ts run2` spawned `mcp/server.ts` and spoke MCP over stdio while the gateway was down.
  - BotManager auto-started the gateway, spawned `client/runner.ts run2` and created the character.
  - `execute_code` returned `ok`, in game, with the say echoed; a second call reused the client.
  - `disconnect_bot` stopped the client: the character quit, the process exited 0, and nothing was killed.
- **(d) Takeover:** a second run1 runner sent `connected`, and the first got save_and_disconnect, quit cleanly (0xA4) and exited 0. The second runner received `status` 1.1 s later and logged in with no 0x11.
- **Gateway restart:** run1 reconnected with backoff (0.5 s, doubling up to 8 s) and kept its DAoC session.
- **0x11 lockout:** after an abrupt kill, the runner got code 0x11, backed off 65 s, published its back-off state, then logged in.
- **(e) Swarm** of run3, run4 and run5 for about 100 s, walking back and forth: 0 not-in-game samples, max state age 391 ms, 0 teleports, 0 corrections. A quit action on each bot gave a clean exit 0. The server log shows only clean CharScreen disconnects and no link-deaths.

The SIGINT/SIGTERM handlers, back-off and takeover logic also have unit tests.

## Known gaps
- **Windows signals:** `process.kill(pid, 'SIGINT')` terminates the process abruptly, which causes the 60 s lockout. Ctrl+C in the runner's own console is the only signal that reaches the handler. To stop runners programmatically, use a quit action (`sdk.sendQuit()`, `disconnect_bot`, or `bun client/dev/swarm-check.ts <bots> --seconds=0 --quit`).
- **Windows handle leak:** detached children started with Bun's spawn (and with `Bun.spawn`) inherit the parent's open handles. Tested: a pipe stays open until the child exits. So a gateway or runner started by the MCP server keeps the server's stdio pipes open.
- **Possible issue (not tested):** a bot whose client was started outside the manager and sits stale for 3 s or more may get a second runner spawned, which takes it over.

## Notes for other modules
- **Gateway left running:** a gateway that the MCP run auto-started is still up on :7780 (log: repo `gateway.log`), and another agent's runner (vrev1) is using it.
- **Test bots:** I created run1–run5; all are logged out cleanly now.
- **Using classes.ts:** pass the class key or name; `validateCharacter` is the source of truth.
- **Writing scripts:** a send action's result arrives before the next state frame. A script that waits on `!movement.moving` right after `sendMoveTo` can resolve immediately; wait on the position instead.

# Review

The review found four real lifecycle bugs. Each one link-deaths the character (60 s re-login lockout) or ends a bot for good with no reason to. All four are fixed and covered by new regression tests, and the three that can be reproduced against the server are verified live. `bun test ./client ./mcp ./sdk ./gateway ./data` passes (322 tests, 0 failures) and typecheck is clean. API.md was not regenerated because no public BotSDK or BotActions method changed.

## Bugs fixed
1. **Quitting a dead character** (`client/session.ts`, `quit()` about lines 458-500, plus a new private `waitUntil`).
   - **Before:** the server refuses `&quit` for a dead character ("CantQuitDead", `GamePlayer.cs:1025`). The client waited 75 s for an 0xA4 that never came, then closed the socket, so the character link-died. This hit runner/swarm stop, quit actions and MCP `disconnect_bot` alike.
   - **Now:** it waits until 11 s after the death and then sends `&release`. The 11 s matters: before the server's 10 s minimum wait, a second `&release` cancels the automatic release (`GamePlayer.cs:1438-1448`). Once the character is alive and `playing` again, it sends `&quit`.
2. **Socket dropped mid-transition** (`client/session.ts` `quit()`, and `client/bridge.ts` `stop()` with a new `QUIT_PHASES` set).
   - **Before:** `GatewayBridge.stop()` only quit when `client.inGame`. In the `regionChange` or `quitting` phase it called `client.disconnect()`, so the character link-died. `session.quit()` also closed straight away in any phase other than `playing`, and a second quit during the 0xA4 → 0xFC step closed the socket.
   - **Now:** `stop()` quits in the `playing`, `enteringWorld`, `regionChange` and `quitting` phases. `session.quit()` waits up to 30 s for a world entry or region change to finish, and waits for a quit already under way instead of closing.
3. **MCP `disconnect` killed the client when the gateway was down** (`mcp/api/index.ts`, `disconnect()` about lines 246-305).
   - **Before:** if the SDK was not connected to the gateway at that moment, the client was killed straight away, so the character link-died. A refused quit action was never sent again; it waited 90 s and then killed.
   - **Now:** it loops until the client exits or `clientStopTimeoutMs` runs out. Each pass restarts a local gateway if needed, reconnects, and sends the quit again every 3 s until one succeeds. It kills only after the timeout.
   - Also added `hasExited()`, which checks `exitCode` and `signalCode`, so a child killed by a signal no longer counts as still running.
4. **AccountAlreadyLoggedIn treated as fatal** (`client/bridge.ts`, `ALREADY_LOGGED_IN` near line 68 and the check at line 334).
   - **Before:** login error 0x2C code 0x0B (another client of the account is still in game or quitting) mapped to `loginDenied`. That exited with code 2, so a swarm bot was never restarted. It can happen when the gateway's 70 s takeover grace runs out during a quit in combat, or when the server has not yet noticed a dropped socket.
   - **Now:** 0x0B is retried with back-off like other transient errors.

## Tests added
- **`client/session.test.ts`:** a `DaocSession.quit` group with three tests: release-then-quit when dead, a second quit waiting instead of closing, and waiting out a region change before `&quit`.
- **`client/bridge.test.ts`:** `stop()` during `regionChange` or `quitting` calls quit and never disconnects; 0x0B is retried, not fatal.
- **`mcp/bot-manager.test.ts`:** `disconnect` sends the quit again after a refusal and ends with `{stoppedClient: true, killed: false}`. The old code killed the client after the timeout.

## Verified live
I used new accounts rrev1, rrev2 and rrev3, plus a GM helper rrevgm (PrivLevel 3, used only to `/harm`).

| Check | Result |
|---|---|
| Runner, then `client/dev/e2e-script.ts rrev1` | All checks pass, clean quit, exit 0 |
| Dead quit: GM harms rrev1, quit action sent 0.1 s after death | Runner logs "dead, releasing first", is released at 11 s, gets 0xA4, exits 0. Server log shows only a CharScreen disconnect, no link-death |
| MCP with the gateway down: BotManager spawns rrev2 on a private gateway (:7791), I kill the gateway, then call `disconnect` | Gateway restarted, one "Bot not connected" retry, then a clean quit, `killed: false`. The old code would have killed the client at once |
| Swarm rrev1 + rrev3 walking for 20 s | 0 not-in-game samples, max state age 723 ms, 0 teleports, 0 corrections |
| Takeover: a standalone rrev3 runner while the swarm held rrev3 | The swarm's rrev3 got save_and_disconnect, quit cleanly, exited 0 and was not restarted. The new runner was in game 1.5 s later |
| `client/dev/mcp-e2e.ts rrev2` over stdio | PASS |

Every bot is logged out cleanly now. The private :7791 gateway is stopped.

The stop during a region change and the 0x0B retry are unit-tested only: I had no reliable way to force either on the live server.

## Remaining gaps
- **Quit can still time out:** in endless combat (each hit resets the quit timer), on a mount, in an instance or while crafting, the quit still takes 75 s and then link-dies. I did not add early detection of the refusal messages.
- **Stale external client:** if a client started outside the manager has no fresh state for 3 s or more (for example while it reconnects to a restarted gateway), `ensureLiveClient` spawns a second runner. That runner now retries 0x0B instead of exiting 2, and it is taken over cleanly once the first runner registers again. But the `execute_code` waiting on it can still fail once with "client exited with code 0".
- **Windows, still open from the builder's report:** `child.kill()` and `SIGINT` from another process end the process abruptly, and detached children inherit the parent's handles. Because of the handle leak, my own `| tail` pipeline hung until I stopped the restarted gateway by hand.
- **Shutdown budget:** a stop can take up to 45 s waiting for a login, plus 30 s for a transition, plus 75 s for the quit. That is more than MCP's 90 s `clientStopTimeoutMs`, so only extreme cases end in a kill.

## Notes for other modules
- **Session owner:** `session.quit()` now waits instead of closing in the `quitting`, `enteringWorld` and `regionChange` phases, and releases first when dead.
- **Dev scripts:** the swarm-check script's teleport counter only samples `lastStopReason` once a second, so it can miss teleports.
- **Scratch scripts:** the live-test scripts are in `C:\Users\joshu\AppData\Local\Temp\claude\C--Users-joshu-Code-daoc-sdk\8a26ca28-643a-4772-a3b5-f937b7c99a27\scratchpad\`: `dead-quit.ts`, `mgr-gwdown.ts` and `gm-create.ts`. The GM password is in `gmpw.txt` in that folder.

Changed files:
- `C:/Users/joshu/Code/daoc-sdk/client/session.ts`
- `C:/Users/joshu/Code/daoc-sdk/client/bridge.ts`
- `C:/Users/joshu/Code/daoc-sdk/mcp/api/index.ts`
- `C:/Users/joshu/Code/daoc-sdk/client/session.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/client/bridge.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/mcp/bot-manager.test.ts`