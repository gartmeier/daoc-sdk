# BUILD

The gateway, the BotSDK plumbing, the runner/CLI/chat tools and the MCP server are written and pass tests. 85 tests pass across gateway, sdk and mcp. Typecheck is clean for my files and `bun sdk/generate-api-docs.ts --check` passes. Nothing has been tried against the real DAoC server yet, because `client/runner.ts` doesn't exist. Nothing is committed.

## Files created
- **gateway/**: `gateway.ts`, `types.ts`, `state-fanout.ts`, `gateway.test.ts`
- **sdk/**: `index.ts`, `runner.ts`, `cli.ts`, `chat.ts`, `chat-history.ts`, `chunking.ts`, `formatter.ts`, `execution-context.ts` (verbatim), `redact.ts` (verbatim), `generate-api-docs.ts`, `API.md`
- **sdk/actions.ts**: placeholder only, `export class BotActions { constructor(public sdk: BotSDK) {} }`. It didn't exist; the bot.* stage replaces it.
- **sdk/test/**: `fixtures.ts` (fabricated BotWorldState), `fake-client.ts` (a fake client that speaks the gateway protocol), and tests `chat`, `sdk-unit`, `formatter`, `api-docs`, `live-smoke`
- **mcp/**: `server.ts`, `execute-code.ts`, `console-capture.ts`, `api/index.ts`, tests `execute-code`, `bot-manager`, `server`
- **.mcp.json**: registers `daoc-agent` as `bun run mcp/server.ts`

## Public API
**Gateway**
- `createGateway(opts?: {port?, hostname?, auth?: GatewayAuthHook, staleThresholdMs?, takeoverGraceMs?, takeoverSettleMs?, quiet?}): {server, port, url, stop()}`. Running the file directly starts it on `AGENT_PORT` (default 7780).
- `GatewayAuthHook = ({kind: 'bot'|'sdk'|'http', username, password}) => {success, error?}`. The default allows everything; passwords are carried but not checked.
- `OBSERVER_ACTIONS = {'say', 'send'}`.

**sdk/index.ts helpers**
- `deriveGatewayUrl(url?)`: `process.env.GATEWAY_URL` wins, default `ws://localhost:7780`.
- `gatewayHttpBase`, `isGatewayReachable`, `ensureGateway(url, {repoRoot?, timeoutMs?, logPath?}): Promise<ChildProcess|null>`
- `launchClientProcess(botName, {repoRoot?, logPath?, env?}): ChildProcess`
- `parseEnvFile`, `findBotEnv`, `nameMatcher`, `bestNameMatch`, `isAttackable`, `distanceBetween`, `headingBetween` (matches `world/Point2D.cs:102`), `REPO_ROOT`

**BotSDK** (98 public methods; the full list with signatures is in `sdk/API.md`)
- Connection: `connect`, `disconnect`, `isConnected`, `isAuthenticated`, `getConnectionState`, `onConnectionStateChange`, `waitForConnection`, `checkBotStatus` (returns `'unknown'` when the gateway is unreachable), `isBotConnected`, `launchClient`, `waitForBotConnection`.
- State reads: everything in the task list, plus `getMovement`, `getInventoryItem`, `getFreeInventorySlots` (40 slots), `getEquipmentItem`, `getVault`, `getNearbyNpc(oid)`, `findNearbyNpcs`, `getNearbyLoot`, `getObject(oid)`, `findSpecialization`, `findEffect`, `getTrainer`, `getTextWindow`, `getGameMessages`.
- `findNearbyNpc(pattern, {maxDistance, minLevel, maxLevel, attackable})`. A string pattern is a case-insensitive substring; the shortest matching name wins, then the nearest.
- Chat: `getChat({limit, types|'all', includeSelf})`, `getNewChat`, `getChatFrom`, `waitForChat`, `say(text, {maxLen, delayMs=700})`, `send(to, text)`, `maxMessageLength`.
- Actions: every send* wrapper from the task list, plus `sendJump`. `sendAction(action)` is public.
- Waits: `waitForReady` (inGame and a player present), `waitForCondition`, `waitForStateChange`, `waitForTicks`. All are abortable.
- Geometry: `distanceTo` (3D when both have z), `headingTo`.

**Runner, CLI, formatter, MCP**
- `runScript(fn, {timeout, connection, autoConnect, disconnectAfter, printState, onDisconnect, reconnectTimeout, args})`. `ScriptContext = {bot, sdk, args}`. When no client is attached the error says to run `bun client/runner.ts <bot>`.
- `bun sdk/cli.ts <bot> [--json] [--timeout]`; `bun sdk/chat.ts <bot> [msg] [--to P] [--watch] [--system] [--limit]`.
- Formatter: `formatWorldState(state, age, {sinceMessageId, brief})`, `formatWorldStateSummary(state, age, {baseline})`, `summarizeWorldState(...) → WorldSummary`, `formatMoney`.
- MCP: `createServer()`; tools `execute_code`, `list_bots`, `disconnect_bot`. Inline code gets `bot`, `sdk`, `args`, `EquipmentSlot` (no Spells global).
- `BotManager({repoRoot?, clientStartTimeoutMs=120s, freshStateMs=3s, autoStartGateway, autoLaunchClient})` and `ClientNotLiveError`.

## Verified vs unit-tested
- **Run for real (no DAoC server involved):**
  - In-process gateway plus the fake client plus real BotSDKs: state arrives, a move action round-trips, observe mode is refused both in the SDK and at the gateway, the newest controller wins, takeover works, and a client that never answers produces a timeout result.
  - BotManager spawned a stand-in `client/runner.ts` from a temp repo root, waited for its state and reused it on the next connect.
  - `ensureGateway` spawned a real gateway process.
  - By hand against a spawned gateway and fake client: `cli.ts` (text and `--json`), `chat.ts` (read, say, `--to`, `--system`), `runScript` (moveTo then observe), and the stdio MCP server running `execute_code` end to end.
- **Unit-tested only:** gateway HTTP endpoints, staleness, auth hook, malformed frames, auth races, dispatch-failure conversion, chat history, chunking, formatter (including a test that the WorldSummary keys match the MCP output schema), execute-code supersede/timeout/cancel/redaction/script loading, and the API.md currency check.
- **Not tested:** anything against the real OpenDAoC server.

## What other modules must know
- **`client/runner.ts` contract:** send `{type: 'connected', username, password, clientId, maxMessageLength?}`, then `{type: 'state', state}` frames.
  - Answer each `{type: 'action', action, actionId, actionTimeoutMs}` with `{type: 'actionResult', actionId, result}`.
  - On `save_and_disconnect`: '&quit', close the socket, don't reconnect. The gateway waits 70 s (`GATEWAY_TAKEOVER_GRACE_MS`) before force-closing, because the DAoC quit timer runs 20–60 s.
  - `state.tick` must increase. The runner and BotManager take a changing tick as proof that a live client is attached.
  - `GameMessage.id` must be monotonic per process; chat dedup and "already shown" tracking key on it.
  - Own speech is detected by sender `'You'` or the player's name, or by text starting "You say," / "You send,".
  - The default `maxMessageLength` is 200, sized for `ReadString(255)` in `PlayerCommandHandler.cs:15`. Say chunks are paced 700 ms apart because the say handler rejects anything faster than 500 ms (`say.cs:47`).
- **Gateway URL:** it is never derived from bot.env `SERVER`, since that is the DAoC game server. Only `GATEWAY_URL` is used, else the default.
- **Logs:** BotManager writes client logs to `bots/<name>/client.log` and a spawned gateway's log to `<repo>/gateway.log`.
- **API.md:** when the real `sdk/actions.ts` lands, run `bun sdk/generate-api-docs.ts` or `api-docs.test.ts` will fail. The generator picks up `*Result` and `*Options` interfaces exported from actions.ts.
- **Test command:** `bun test gateway sdk mcp`, and the package.json `test` script, also match the tests under `reference/rs-sdk` and fail there. Use `bun test ./gateway ./sdk ./mcp`, or the root config owner should add a test ignore for `reference/**`.

## Known gaps
- `disconnect_bot` doesn't stop a client the manager spawned; the client process keeps running.
- If a stale client is replaced, the old one can hold the account for up to 60 s (linkdead), so the new client must back off. The manager waits up to 120 s.
- The vault, the custom text window and combat events are only shown in summaries where noted; there are no SDK helpers for combat events.

# REVIEW

Four bugs fixed, two small additions, and 8 regression tests. `bun test ./gateway ./sdk ./mcp` passes 93/93 (was 85), run twice. `bunx tsc --noEmit -p tsconfig.json` and `bun sdk/generate-api-docs.ts --check` are clean. Gateway plus BotSDK now work against the real OpenDAoC server, using a scratch bridge because `client/runner.ts` still doesn't exist. Nothing committed.

## Bugs found and fixed
1. **`gateway/gateway.ts:211-219` (takeover).** A client waiting on a takeover that re-sent `connected` closed its own socket. It was treated as "an older waiting client", and the new pending entry then pointed at a dead socket. It now closes `previous.ws` only when it is a different socket.
2. **`gateway/gateway.ts:376-393` (handleClose).** When a client socket closed with an action unanswered, the action was lost silently.
   - On takeover no `Bot disconnected` goes out, so the SDK caller waited out its full `actionTimeout` (60 s by default).
   - An HTTP `/say` or `/dm` in flight waited out its per-chunk timeout.
   - Now the lost action gets `sdk_error {actionId, error: 'Bot client disconnected before answering'}`, or an HTTP result `{success:false, reason:'disconnected'}`.
3. **`sdk/index.ts` handleMessage (sdk_error branch).** On `Bot disconnected` (no actionId), every pending action now fails at once with `reason: 'disconnected', phase: 'dispatch'`, instead of each waiting for its timeout. The gateway's per-action "Bot client disconnected…" error also maps to `reason: 'disconnected'`. Other gateway errors keep `reason: 'error'`.
4. **`mcp/api/index.ts` ensureLiveClient.** It resolved on the first new state frame. A starting client publishes not-in-game frames while it logs in, creates the character, or backs off the 60 s linkdead lockout. So the "waits up to 120 s" claim didn't hold: `execute_code` then gave up after its own 15 s `waitForReady` and ran against a client that was not in game.
   - It now waits for a fresh frame with `inGame && player`.
   - A client this manager spawned that is still logging in is waited for, even if its status is `active`.
   - The timeout error now gives the last `phase` and `lastError`.

## Additions
- **`sendNone()` in `sdk/index.ts`:** the task requires a wrapper for every BotAction variant, and `'none'` had none. `sdk/API.md` is regenerated (99 BotSDK methods).
- **`mcp/api/index.ts` connect, existing-connection path:** when the connection has dropped, it calls `ensureGateway` before reconnecting. Before, a gateway the manager had spawned was never restarted after it died.

## Regression tests added
- `gateway/gateway.test.ts`:
  - a waiting client re-sending `connected` stays open and gets registered;
  - an action in flight fails on takeover and on a plain disconnect;
  - an HTTP chat in flight resolves as failed within 5 s of the client closing.
- `sdk/test/sdk-unit.test.ts`:
  - `Bot disconnected` fails all pending actions;
  - an exhaustive `Record<BotActionType, …>` table checks each wrapper's action type and field names. Adding a variant to `sdk/types.ts` without a wrapper now fails typecheck.
- `sdk/test/live-smoke.test.ts`: an in-flight action fails as `disconnected` within 2 s when the client dies, with a 30 s actionTimeout.
- `mcp/bot-manager.test.ts`:
  - a spawned client publishing `login` frames for 1.5 s is waited for until in game;
  - a client stuck on `charScreen` reports its phase and `lastError` in `ClientNotLiveError`.

## Verification
**Unit and in-process:** the full suite above.

**Live, against OpenDAoC on :10300:** a scratch bridge (real `DaocClient` ↔ in-process gateway ↔ real `BotSDK`) at `C:\Users\joshu\AppData\Local\Temp\claude\C--Users-joshu-Code-daoc-sdk\8a26ca28-643a-4772-a3b5-f937b7c99a27\scratchpad\live-bridge.ts`, using account `gwreview1`, which I created in the DB.
- **In game:** login took 0.5 s. The SDK got in-game state with 101 NPCs, and `tick` advanced.
- **Move:** `sendMoveTo` +150 units arrived with `lastStopReason` `arrived`.
- **Chat:** `say()` worked. Its echo `You say, "…"` arrives with sender `null`, is caught by `isOwnMessage`, and is left out of `getChat()`.
- **Status and observe:** HTTP `/status` was correct, and observe mode refused `stop`.
- **Takeover:** `save_and_disconnect` led to `&quit`. The client was disconnected and the new registration completed about 1.3 s later.

**Not verified live:** the MCP `execute_code` path, `BotManager` spawning, `runScript` and the CLIs. They all need `client/runner.ts`.

Comparison with rs-sdk: routing, last-controller-wins, observe gating, reconnect backoff, the one handshake deadline, abort propagation, `execute_code` supersede/cancel and console capture all match the originals. No changes were needed there.

## Remaining gaps and things other modules must know
- **Client model bug:** the live state reported `maxConcentration` 16960 for a level-1 Fighter.
- **`client/runner.ts` contract additions:**
  - Register with the gateway and wait for its `status` frame before logging into DAoC. A pending takeover client must not log in while the old one is still quitting.
  - A runner that publishes `inGame:false` frames while backing off is waited for by BotManager for up to 120 s.
- **The test command bug is real:** `bun test gateway sdk mcp` and the `package.json` `test` script also pick up tests under `reference/rs-sdk` and fail there. Use `bun test ./gateway ./sdk ./mcp`. The owner of the root config needs to exclude `reference/**`.
- **Still open from the builder:**
  - `disconnect_bot` doesn't stop a client the manager spawned.
  - The default 2-minute `execute_code` timeout can expire before the 120 s client-start wait finishes. The call then reports `timeout` while the client keeps starting in the background.
  - A gateway error that isn't about a disconnect, such as `Bot not connected`, still comes back as `reason: 'error'`, as in rs-sdk.
- **Chat history:** if a restarted client's message ids climb past the old client's last id before the first snapshot arrives, the history merge drops the overlap.

Files changed: `gateway/gateway.ts`, `gateway/gateway.test.ts`, `sdk/index.ts`, `sdk/API.md`, `sdk/test/sdk-unit.test.ts`, `sdk/test/live-smoke.test.ts`, `mcp/api/index.ts`, `mcp/bot-manager.test.ts` (all under `C:/Users/joshu/Code/daoc-sdk/`).