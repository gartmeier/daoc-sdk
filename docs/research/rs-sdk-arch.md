# rs-sdk architecture map, and what to reuse for daoc-sdk

Root: `C:/Users/joshu/Code/daoc-sdk/reference/rs-sdk`. All paths below are relative to it. Line numbers come from the current checkout.

## 0. Topology

```
 script / MCP / cli                gateway (Bun.serve, :7780)            game client (browser tab OR lite headless)
 ┌──────────────┐  WS JSON  ┌──────────────────────────────┐  WS JSON  ┌──────────────────────────────────────┐  binary RS protocol
 │ BotActions   │──sdk_*──▶ │ botSessions[username]        │ ─action─▶ │ GatewayConnection / LiteGatewayRunner│ ──────────────▶ engine
 │  └ BotSDK    │◀─sdk_*─── │ sdkSessions[sessionId]       │ ◀─state── │ BotActionQueue → ActionExecutor      │ ◀────────────── (LostCity TS)
 └──────────────┘           │ HTTP /status /state /chat    │           │ BotStateCollector → BotWorldState    │
                            │      /say /dm /traffic       │           └──────────────────────────────────────┘
                            └──────────────────────────────┘
```

- **The SDK never speaks the game protocol.** It sends JSON `BotAction`s and receives JSON `BotWorldState` snapshots, one per game tick.
- **The client owns the game socket, protocol decode, state collection and primitive action encoding.** The gateway is a dumb router plus a cache of each bot's last state.
- **Pathfinding runs inside the SDK process** (`sdk/pathfinding.ts`, using `collision-data.json`, about 27.5MB). It does not run in the client. The client only does local BFS movement within its build area.

---

## 1. Wire protocol (JSON over WebSocket; types in `server/gateway/types.ts`)

### 1.1 Client → Gateway (`BotClientMessage`)

| type | fields | when |
|---|---|---|
| `connected` | `username, password, clientId ("<user>-<ts>" or "<user>-lite-<ts>"), maxMessageLength?` | First frame after WS open (`lite/runner.ts:101-108`, `bot/GatewayConnection.ts:86-92`) |
| `state` | `state: BotWorldState` | Every game tick (the `setOnGameTickCallback` hook), plus right after each action result (`runner.ts:260 finishAction → sendState`) |
| `actionResult` | `actionId, result: ActionResult` | When the queued action finishes |
| `screenshot_response` | `screenshotId, dataUrl` | The lite client answers with `dataUrl: ''` |

### 1.2 Gateway → Client (`SyncToBotMessage`)

| type | fields |
|---|---|
| `action` | `action: BotAction, actionId, actionTimeoutMs` |
| `status` | `status: string` (`"Connected to gateway"`) |
| `error` | `error` (auth fail, then close) |
| `screenshot_request` | `screenshotId` |
| `save_and_disconnect` | `reason`. Sent on session takeover. The client must log out (which triggers the engine save) and must not reconnect. |

### 1.3 SDK → Gateway (`SDKMessage`)

| type | fields |
|---|---|
| `sdk_connect` | `username, password, clientId ("sdk-<ts>-<rand>"), mode: 'control'\|'observe'` |
| `sdk_action` | `username` (ignored; the IDOR guard always uses the session target), `actionId ("act-<ts>-<rand>"), action, actionTimeoutMs` |
| `sdk_screenshot_request` | `username, screenshotId` |

### 1.4 Gateway → SDK (`SyncToSDKMessage`)

| type | fields |
|---|---|
| `sdk_connected` | `success, mode, otherControllers: 0, maxMessageLength`. Re-sent when the bot (re)registers. |
| `sdk_state` | `state, stateReceivedAt` (gateway epoch ms) |
| `sdk_action_result` | `actionId, result` |
| `sdk_error` | `error, actionId?, screenshotId?`. Known strings: `"Disconnected: another controller connected"`, `"Bot disconnected"`, `"Bot not connected"`, the observe-mode reject, `"Authentication failed: …"`, the outdated-client text. |
| `sdk_screenshot_response` | `screenshotId, dataUrl` |
| `sdk_info` | `message, maxMessageLength` |

### 1.5 Gateway semantics (`server/gateway/gateway.ts`)

- **Routing (`handleMessage` ~l.828-868):**
  - Frames are shape-checked first. Anything that is not a JSON object, or has a non-string `type`, gets `rejectFrame` and the socket is closed.
  - A socket that is already registered is routed by `wsToType`.
  - A new socket is routed by type: a `sdk_` prefix goes to the SDK handler; `connected`/`state`/`actionResult` go to the bot handler.
- **Bot session (l.172-200, 387-436):**
  - One session per username.
  - When a second client registers, the old one is sent `save_and_disconnect`. The new one waits in `pendingTakeovers`. After 5s the old socket is force-closed. Once the old socket closes, the gateway waits 700ms and then runs `completeBotConnection`, keeping `lastState` from the old session.
- **Staleness:** `STALE_THRESHOLD_MS = 8000`. Status is `active`, `stale` (no state for over 8s) or `dead` (`ws == null`).
- **SDK sessions (l.518-619):**
  - The gateway generates the `sessionId`. The client-supplied `clientId` is used as a log label only.
  - `control` mode is "last controller wins": every older controller gets `sdk_error` and is closed.
  - `observe` mode may only send `say` and `privateMessage`.
  - On connect, the gateway immediately replays `lastState` as `sdk_state`.
- **Fan-out (l.476-500):**
  - Each `state` frame is cached and fed into the per-bot `ChatHistory` (500 deep).
  - It is broadcast to every SDK session for that bot, except when `repeatsLastFanout`: same `tick` and JSON-equal apart from `revision` (`state-fanout.ts`).
- **Action results** are broadcast to every SDK session on the bot. Each SDK filters by its own `actionId`. `currentActionId` is a fallback for results that carry no id.
- **Auth:** `authenticateSDK` is a no-op unless `LOGIN_SERVER=true`. When enabled, it calls a WS login server with `{type:'sdk_auth', replyTo, username, password, sentAt}` and a 15s timeout. The same check is used for bots and SDKs.
- **HTTP endpoints (l.912-1250):**
  - `GET /status/:u` returns `{status, inGame, stateAge, maxMessageLength, controllers[], observers[], player:{name,worldX,worldZ}}`.
  - `GET /state/:u` returns `{state, stateAge, botStatus}`, or 404.
  - `GET /chat/:u?limit&system` returns `{messages, botStatus}`.
  - `POST /say/:u {text,password?,timeoutMs?}` and `POST /dm/:u {to,text}` send chat. Says are serialized per bot (`httpSayQueues`) and chunked.
  - `GET /traffic[/fields]` is internal metering.
  - `/` returns a text banner.
  - Password can come from the body, `Authorization: Bearer`, or `?password=`.
- **Env:**
  - `AGENT_PORT` (7780), `GATEWAY_HOSTNAME`, `GATEWAY_PUBLIC_PORT` (second listener with permessage-deflate).
  - `LOGIN_SERVER`, `LOGIN_HOST`, `LOGIN_PORT` (43500).
  - `ENGINE_MANAGEMENT_URL` (outdated-client lookup).
- **Engine coupling (avoid this):** the gateway imports `server/engine/src/util/{MemoryDiagnostics,NetworkPressure}`.

---

## 2. State model: `BotWorldState` (`sdk/types.ts:558-600`)

```ts
BotWorldState {
  tick: number;            // client-counted server ticks (runner increments serverTick per tick callback)
  revision?: number;       // publication revision (monotonic, per collector)
  inGame: boolean;
  player: PlayerState|null;   // name, combatLevel, hp, maxHp, x,z (scene), worldX, worldZ, level(plane 0-3),
                              // runEnergy, runWeight, animId, spotanimId, combat{inCombat,targetIndex,targetType,lastDamageTick},
                              // isDead, lifeId, respawnCount, lastDeathTick
  skills: SkillState[];       // {name, level, baseLevel, experience}; SDK wraps in Proxy so skills.Woodcutting works
  inventory: InventoryItem[]; // {slot,id,name,count,optionsWithIndex:[{text,opIndex}]}; occupied slots only
  equipment: InventoryItem[];
  nearbyNpcs: NearbyNpc[];    // kind:'npc', id, index, name, combatLevel, x,z, tileX?,tileZ?, size?, distance, hp|null, maxHp|null,
                              // healthPercent, targetIndex, inCombat, lastCombatTick, animId, spotanimId, optionsWithIndex, options[], reachable?
  nearbyPlayers: NearbyPlayer[]; // kind:'player', index, name, combatLevel, x,z, worldX?,worldZ? (SDK fills), distance, reachable?, combatTarget*
  nearbyLocs: NearbyLoc[];    // id,name,x,z,level,distance,optionsWithIndex,options,reachable?
  groundItems: GroundItem[];  // id,name,count,x,z,distance,reachable?
  gameMessages: GameMessage[];// {type,text,sender,tick,observationId?,fromSelf}; last 50; PLAYER_CHAT_TYPES=[1,2,3,6,7]
  recentDialogs: DialogEntry[];
  dialog: DialogState;        // isOpen, options[{index,text,componentId?,buttonType?}], isWaiting, pageId?, text?, allComponents?
  interface: InterfaceState;  // isOpen, interfaceId, options[{index,text,componentId}]
  shop: ShopState; bank: BankState; trade?: TradeState; ge?: GEState|null;
  modalOpen: boolean; modalInterface: number;
  combatStyle?: CombatStyleState; combatEvents: CombatEvent[]; prayers: PrayerState;
  isSkulled?, autoRetaliateEnabled?,
  opFeedback?: { mapFlagUnsetCount, lastMapFlagUnsetTick, opRejectedCount, lastOpRejectedTick } // the only "server rejected op" signal
}
```

- **Producer:** `server/webclient/src/bot/StateCollector.ts:148 collectState(tick, publish)`. The same collector runs against both the browser `Client` and the `LiteClient` façade (see §6).
- **Size concern:** full state goes out every tick to every SDK. The gateway meters it (`traffic.ts` `StateFieldSampler`) and offers permessage-deflate, which brings frames to about 13%.

---

## 3. Action dispatch and acknowledgement

### 3.1 The `BotAction` union (`types.ts:604-649`, about 45 variants)

Every variant has the shape `{type, …, reason: string}`.

- **Movement and world interaction:** `none`, `wait{ticks}`, `walkTo{x,z,running}`, `talkToNpc{npcIndex}`, `interactNpc{npcIndex,optionIndex}`, `interactPlayer`, `interactLoc{x,z,locId,optionIndex}`, `pickupItem{x,z,itemId}`, `interactGroundItem`.
- **Inventory and items:** `useInventoryItem{slot,optionIndex,interfaceId?}`, `useEquipmentItem`, `dropItem`, `useItemOnItem`, `useItemOnLoc`, `useItemOnNpc`.
- **Interfaces and dialogs:** `clickDialogOption{optionIndex,guard?{pageId,componentId}}`, `clickComponent`, `clickComponentWithOption`, `setTab`, `submitCountDialog`.
- **Shop, bank, GE:** `shopBuy`, `shopSell`, `closeShop`, `closeModal`, `bankDeposit`, `bankWithdraw`, `searchGE`.
- **Combat and magic:** `setCombatStyle`, `spellOn{Npc,Player,Item,GroundItem}`, `togglePrayer`.
- **Chat:** `say`, `privateMessage`.
- **Character creation:** `acceptCharacterDesign`, `randomizeCharacterDesign`.
- **Scans:** `scanNearbyLocs{radius}`, `scanGroundItems{radius}`. These return their results in `result.data`.

### 3.2 `ActionResult`

`{success, message, data?, reason?, phase?: 'validation'|'routing'|'dispatch'|'observation'|'completion'}`

### 3.3 SDK side (`sdk/index.ts:1072-1121 sendAction`)

1. If the connection is reconnecting, `await waitForConnection()`.
2. If not connected, it **throws**.
3. Otherwise it registers `pendingActions[actionId]` with a timeout of `actionTimeout` (default 60s) and sends `sdk_action`.
4. The promise resolves on `sdk_action_result` and rejects on `sdk_error` with that `actionId`.
5. Timeout, disconnect and error are **converted into a failed ActionResult**: `{success:false, reason:'timeout'|'disconnected'|'error', phase:'dispatch'}`. The script does not throw.

Everything is wrapped in `executionWait` so an abort signal cancels it (`sdk/execution-context.ts`).

### 3.4 Client side (`lite/runner.ts`)

- **Enqueue:** `onAction` enqueues into `BotActionQueue` (`bot/ActionQueue.ts`): single-consumer FIFO, maxPending 64, TTL = `actionTimeoutMs - 1000`. If the queue is full, it replies `{reason:'busy'}`.
- **Tick loop:** `tick()` runs every 20ms (`TICK_MS`) and in order:
  1. Expires pending entries (`queue_expired`).
  2. Expires the active entry.
  3. Counts down `waitTicks`.
  4. Otherwise runs `startNext()` and then `client.executeBotAction(action)`. That call returns `ActionResult | Promise<ActionResult>`.
  5. `finishAction` sends `actionResult` followed by a fresh `state`.
- **Reconnect generations:** `beginGeneration()` drops queued work on gateway reconnect. Results from a stale generation are not published.
- **Executor:** `bot/ActionExecutor.ts:42 execute()` is a switch with about 63 `case`s, mapping each action to a `Client` method such as `client.walkTo`, `interactNpc` or `interactLoc`. Success means **bytes were written**. The executor pathfinds locally before writing; if it cannot route, it returns `cant_reach` and sends nothing.

### 3.5 Contract (stated in CLAUDE.md and the API.md header)

- `sdk.send*` success means "dispatched", **not** "applied".
- `bot.*` methods observe evidence (inventory delta, XP, position, dialog, message tick) through `waitForCondition`.
- Rejection detection relies on `opFeedback.opRejectedCount` (the engine replies UNSET_MAP_FLAG) and on refusal-phrase scans of `gameMessages` (`actions-helpers.ts` `findRefusal`, `PVP_REFUSALS`, …).

---

## 4. SDK: `sdk/`

### 4.1 Files

| File | Lines | Role |
|---|---|---|
| `index.ts` | 2093 | `BotSDK` (low level): WS connection, state cache, wait primitives, `send*` wrappers, chat history, local pathfinding wrapper. `deriveGatewayUrl` (l.71), `preferDirectGateway` (l.101). |
| `actions.ts` | 5050 | `BotActions` (high level), built from a `BotSDK`, plus `ActionHelpers` and `GEActions`. |
| `actions-helpers.ts` | 638 | Target resolution (`resolveLocation`/`resolveNpc`/`resolveGroundItem`/`resolveCombatTarget`, `refind*`), message-tick cursors, `wasOpRejectedSince`, `checkCantReachMessage`, `walkAdjacentTo`, `walkStepToward`, `waitForMovementComplete`, `openDoorAt`, `tryOpenBlockingDoor`, refusal phrase lists. |
| `action-quantity.ts` | 247 | `shortestNameMatch` (prefers reachable), `exactNamePattern`, quantity validation, skill-dialog product resolution, `countItems`. |
| `types.ts` | 988 | All state, action and result types, `SDKConfig`, `BotStatus`, `ConnectionState`. The gateway types re-export it. |
| `runner.ts` | 501 | `runScript` (§4.4). |
| `cli.ts` | 362 | `bun sdk/cli.ts <bot> [state] [--json] [--server] [--timeout]`. Primary path is HTTP `GET /state/:bot`. Fallback is an observer WS that calls `connect()` with `readyTimeout:0` so "gateway down" and "no client logged in" are reported separately. Output via `formatWorldState`. |
| `chat.ts` | 410 | Chat CLI over HTTP `/say`, `/dm`, `/chat`. `--watch` uses an observer WS. |
| `chat-history.ts` | 106 | `ChatHistory`: 500-deep dedup ring keyed by `observationId ?? tick`. Shared with the gateway. |
| `chunking.ts` | 58 | `chunkMessage(text,maxLen)`. |
| `pathfinding.ts` | 279 | Wraps the vendored `rsmod-pathfinder` (`server/vendor`): `initPathfinding()` (synchronous, slow; warmed before any socket opens), `findLongPath(level,sx,sz,dx,dz,maxWp,blockedDoors)` (2048×2048 BFS), `isTileWalkable`, `isFlagged`, `findDoorsAlongPath`, `getDoorAt`, `TemporaryDoorBlocklist` (TTL per session). Door walls are unmasked at init, except for a `ONE_WAY_DOORS` set. |
| `collision-data.json` / `fetch-collision-data.ts` | — | Format `{tiles:[[lvl,x,z,flags]], zones:[[lvl,zx,zz]], doors:[[lvl,x,z,shape,angle,blockrange]]}`, from `GET <server>/api/exportCollision`. |
| `formatter.ts` | 587 | `formatWorldStateSummary` (post-script), `formatWorldState` (CLI/MCP text), `summarizeWorldState` → `WorldSummary` (MCP structured output; brief caps lists at 10 and messages at 5, full at 50/50). |
| `execution-context.ts` | 73 | `AsyncLocalStorage<{signal, log?}>`, `throwIfExecutionAborted`, `executionWait(setup→cleanup)`, `abortable(p)`, `withExecutionDeadline(ms, work, onTimeout)`. This is how MCP cancellation and timeouts reach deep into `bot.*`. |
| `generate-api-docs.ts` | 287 | Uses the TS compiler API to extract public methods of `BotActions`/`BotSDK` plus types ending in `*Result`/`*State`/`GE*`/`Market*`. Groups them by `methodCategory(name)` and writes `sdk/API.md`. `--check` diffs against the file. |
| `redact.ts`, `bug-report.ts`, `spells.ts`, `ge-*.ts`, `market.ts`, `trade-helpers.ts` | — | Credential redaction; telemetry POST to a fixed endpoint; spell component ids; RS-specific GE, market and trade code. |

### 4.2 `SDKConfig` defaults (`index.ts:204-224`)

| Option | Default |
|---|---|
| `host` / `port` | `localhost` / `7780` |
| `connectionMode` | `'control'` |
| `autoLaunchBrowser` | `'auto'` (launches when status shows no fresh state within `freshDataThreshold`, 3000ms) |
| `browserLaunchTimeout` | 30000 |
| `readyTimeout` | 15000 (`connect()` then calls `waitForReady`; 0 skips it) |
| `connectTimeout` | 30000 (covers the whole handshake) |
| `actionTimeout` | 60000 |
| `autoReconnect` | true, unlimited retries, backoff 1s→30s |
| `showChat` | true |

On a `sdk_error` during the handshake, auto-reconnect is disabled. It is also disabled when the SDK is pre-empted by another controller.

### 4.3 `handleMessage` normalisation of `sdk_state` (`index.ts:1942-2030`)

1. Drop player chat if `showChat` is false.
2. Record chat into `ChatHistory`.
3. Fill `worldX`/`worldZ` on `nearbyPlayers`.
4. Mirror trade `count` to `amount`.
5. Wrap `skills` in a name Proxy.
6. Set `state` and `stateReceivedAt`, then notify listeners. All `waitFor*` calls are built on these listeners.

### 4.4 `runScript(fn, opts)` (`sdk/runner.ts`)

**Credential loading (`loadEnvFromArgs`), in priority order:**
1. Values already in `process.env` (from `bun --env-file`).
2. A `bot.env` next to the script (`process.argv[1]`).
3. The first non-flag argument, resolved to `bots/<arg>/bot.env`.

**Connection (`getOrCreateConnection`):**
- Requires `BOT_USERNAME` and `PASSWORD`. `SERVER` goes through `deriveGatewayUrl`. `SHOW_CHAT` is read too.
- Calls `initPathfinding()` first.
- Creates the SDK with `{connectionMode:'control', autoReconnect:true, autoLaunchBrowser:false}` and a 90s overall connect budget.
- Then `requireLiveClient`: waits up to 10s for `tick` to advance. If it doesn't, it throws "No game client is attached …" with instructions. Without this check, the gateway's cached `lastState` would make it look as if a client were attached.

**Options:** `timeout`, `connection` (reuse an existing one), `autoConnect`, `disconnectAfter` (default true when the runner owns the connection), `printState` (default true), `onDisconnect: 'error'|'wait'|'ignore'`, `reconnectTimeout` (60000).

**Execution:**
- Runs `executionContext.run({signal}, () => abortable(script({bot,sdk})))`.
- The timeout or SIGINT/SIGTERM/SIGHUP aborts the controller. Signal exits use 128+n; a second signal forces exit.
- A disconnect during the run aborts with `BotDisconnectedError`.

**Output and result:**
- Prints `── Result ──`, `── Error ──` (first 4 stack frames) and `── State ──` (summary with XP deltas since start).
- Sets `process.exitCode = 1` on error.
- Returns `RunResult {success, result?, error?, duration, finalState}`.

`ScriptContext = {bot, sdk, args?}`.

### 4.5 `bot.env` format

Plain `KEY=VALUE` lines; `#` starts a comment.

```
BOT_USERNAME=…     PASSWORD=…     SERVER=host | host:port | ws(s)://…
GATEWAY_URL=ws://localhost:7780   (optional override; create-bot --local writes SERVER=localhost:8888 + GATEWAY_URL)
SHOW_CHAT=true     TELEMETRY=true  PROFANITY_FILTER=(lite only)
```

`deriveGatewayUrl` rules:
- empty → `ws://localhost:7780`
- `ws(s)://…` → used as-is
- `localhost[:p]` → `ws://localhost:p` (default port 7780)
- anything else → `wss://HOST/gateway`
- `process.env.GATEWAY_URL` always wins.

---

## 5. Public API surface

`sdk/API.md` is generated from source; regenerate with `bun run docs:api`.

### 5.1 `sdk.*` (BotSDK)

**Connection**

| Method | Semantics |
|---|---|
| `connect()` | WS handshake and ready wait; idempotent. |
| `disconnect()` | Intentional close; no reconnect. |
| `isConnected()` | WS open. |
| `isAuthenticated()` | `sdk_connected` received. |
| `getConnectionState()` / `getReconnectAttempt()` | Connection state machine. |
| `onConnectionStateChange(cb)` | Subscribe; returns an unsubscribe function. |
| `getConnectionMode()` | `'control'` or `'observe'`. |
| `checkBotStatus()` | HTTP `/status`. |
| `isBotConnected()` | From the status endpoint. |
| `launchBrowser()` / `waitForBotConnection(t)` | Auto-launch support. |
| `waitForConnection(t)` | Wait for reconnect. |

**State reads (all synchronous)**

| Method | Semantics |
|---|---|
| `getState()` | Last snapshot. |
| `getStateReceivedAt()` / `getStateAge()` | Gateway timestamp / ms since. |
| `onStateUpdate(cb)` | Subscribe to snapshots. |
| `getSkill(name)` / `getSkillXp(name)` / `getSkills()` | Skills. |
| `getInventory()` / `getInventoryItem(slot)` / `findInventoryItem(pat)` / `countInventoryItems(pat)` | Inventory. |
| `getEquipment()` / `getEquipmentItem(slot)` / `findEquipmentItem(pat)` | Equipment. |
| `getBankItems()` / `getBankItem(slot)` / `findBankItem(pat)` / `isBankOpen()` | Bank. |
| `getNearbyNpcs()` / `getNearbyNpc(idx)` / `findNearbyNpc(pat, {reachable?, withOption?})` | NPCs. |
| `getNearbyPlayers()` / `findNearbyPlayer(pat)` | Players. |
| `getNearbyLocs()` / `getNearbyLoc(x,z,id)` / `findNearbyLoc(pat, opts)` | Locs. |
| `getGroundItems()` / `findGroundItem(pat)` | Ground items. |
| `getDialog()` | Dialog state. |
| `getTradeState()` | Trade state. |
| `getPrayerState()` / `isPrayerActive(p)` / `getActivePrayers()` | Prayers. |
| `getGEState()` / `getGEAvailability()` / `getMarketItems()` / `getMarketItem()` / `getMarketHistory()` | GE and market (RS only). |

**Chat**

| Method | Semantics |
|---|---|
| `getChat({limit, types, includeSelf})` | From the 500-deep history. |
| `getNewChat()` | Messages since the cursor; advances it. |
| `getChatFrom(name)` | Filter by sender. |
| `waitForChat({from, matching, timeout})` | Wait for a matching message. |
| `maxMessageLength` (getter) | Server chat cap. |
| `say(text)` / `dm(name, text)` | Auto-chunked and tick-paced; return `ActionResult[]`. |
| `sendSay(msg)` / `sendPrivateMessage(name, msg)` | Raw single send. |

**Scans (async, through the client)**

`scanNearbyLocs(radius)`, `scanGroundItems(radius)`, `scanFindNearbyLoc(pat, r)`, `scanFindGroundItem(pat, r)`.

**Raw dispatch: `send*`, each 1:1 with a BotAction, returns `ActionResult`**

| Group | Methods |
|---|---|
| Movement and world | `sendWalk(x,z,run=true)`, `sendInteractLoc(x,z,id,op=1)`, `sendInteractNpc(idx,op=1)`, `sendInteractPlayer(idx,op=2)`, `sendTalkToNpc`, `sendPickup(x,z,id)` |
| Items | `sendUseItem(slot,op,ifId?)`, `sendUseEquipmentItem`, `sendDropItem`, `sendUseItemOnItem`, `sendUseItemOnLoc`, `sendUseItemOnNpc` |
| Dialog and interfaces | `sendClickDialog(idx)`, `clickDialogByText(pat)`, `sendClickComponent(id)`, `sendClickComponentWithOption(id,op,slot)`, `sendClickInterfaceOption(pos)`, `clickInterfaceOption(sel)`, `sendCountDialog(v)`, `sendSetTab` |
| Character creation | `sendAcceptCharacterDesign`, `sendRandomizeCharacterDesign` |
| Shop and bank | `sendShopBuy/Sell(slot,amt)`, `sendCloseShop`, `sendCloseModal`, `sendBankDeposit/Withdraw` |
| Trade | `sendTradeRequest`, `sendOfferItem`, `sendRetractItem`, `sendAcceptTrade`, `sendDeclineTrade`, `waitForTradeRequest` |
| Combat and magic | `sendSetCombatStyle`, `sendTogglePrayer`, `sendSpellOnNpc/Player/Target/Item/GroundItem` |
| Other | `sendGESearch`, `sendWait(ticks)`, `sendScreenshot(t)` |

**Pathing**

| Method | Semantics |
|---|---|
| `findPath(dx,dz,maxWp)` | Synchronous local BFS from the player's position. Returns `{success, waypoints[{x,z,level}], reachedDestination, error}`. |
| `sendFindPath(...)` | Alias. |
| `blockDoorTemporarily(l,x,z,ttl)` / `isDoorTemporarilyBlocked` | Session door blocklist. |

**Waits (all abortable)**

| Method | Semantics |
|---|---|
| `waitForReady(t)` | `inGame`, position not (0,0), and at least one entity. |
| `waitForCondition(pred, t=30s)` | Throws on timeout. |
| `waitForStateChange(t)` | Next frame. |
| `waitForStateUpdate()` | Next frame, 5s. |
| `waitForTicks(n)` | `state.tick ≥ start + n`. |

### 5.2 `bot.*` (BotActions)

Every porcelain method starts with `dismissBlockingUI()`, resolves its target as `X | string | RegExp`, dispatches, then observes, and returns a typed `*Result {success, message, reason?}`.

**Movement and doors**

| Method | Semantics |
|---|---|
| `walkTo(x,z,tol=3,{timeout=120s})` | Up to 50 iterations of: `findPath` → `walkStepToward` per waypoint (intermediate tolerance 2) → proactively open doors on the path → detect stuck or partial path → temporary door blocks. Aborts on death (`lifeId` change) or stale state over 10s. |
| `openDoor(t?)` | Open a door or gate, walking to it if needed. |

**Interaction**

| Method | Semantics |
|---|---|
| `interactLoc(t, option?)` / `interactNpc(t, option?)` | Walk to the target and use any option. |
| `talkTo(npc)` | Walk to the NPC and wait for the dialog to open. |
| `useItemOnLoc(item, loc)` / `useItemOnNpc(item, npc)` | Walk there, then use the item. |

**Combat**

| Method | Semantics |
|---|---|
| `attack(t, timeout)` / `attackPlayer` | Observes `inCombat` and target. |
| `castSpell(t, spell)` / `castSpellOnPlayer` | Observes hit or XP. |
| `eatFood(t?)` | Returns `hpGained`. |
| `activatePrayer` / `deactivatePrayer` / `deactivateAllPrayers` | Prayer toggles. |
| `pickpocketNpc(t)` | XP or stun detection. |

**Gathering and skilling (RS-specific)**

`chopTree`, `mineRock`, `burnLogs`, `fletchLogs`, `craftLeather`, `smithAtAnvil`, `craftJewelry`, `enchantItem`, `stringAmulet`.

**Items**

| Method | Semantics |
|---|---|
| `pickupItem(t)` | Pick up a ground item. |
| `dropItem(t, amount\|'all')` | Re-resolves the slot from fresh state for each drop. |
| `equipItem` / `unequipItem` / `getEquipment` / `findEquippedItem` | Equipment. |

**Shop and bank**

| Method | Semantics |
|---|---|
| `openShop(t?)` / `closeShop()` | Open via shopkeeper / close. |
| `buyFromShop(t, n)` / `sellToShop(t, n\|'all')` | Report partial fills. |
| `openBank()` / `closeBank()` | Nearest bank. |
| `depositItem(t, n=-1)` / `withdrawItem(t, n, {asNote})` | Bank transfers. |
| `closeInterface()` | Close any modal. |

**Trade**

`tradeWith`, `offerTradeItems`, `acceptTrade`, `declineTrade`, `trade(target, {give, want, accept, …})`, `serveTrades(opts)`.

**GE (RS only)**

`openGE`, `searchGE`, `placeGEOffer`, `cancelGEOffer`, `collectGEOffer`, `collectGE`.

**UI**

| Method | Semantics |
|---|---|
| `dismissBlockingUI()` | Clicks single-option dialogs; closes modals except `NEVER_AUTO_CLOSE` (trade, character design, …); never answers multi-option dialogs. |
| `navigateDialog(choices[])` | Auto-click through options. |
| `skipTutorial()` | RS tutorial island. |

**Waits**

`waitForSkillLevel`, `waitForInventoryItem`, `waitForDialogClose`, `waitForIdle`.

Private helper `waitForActionCondition(pred, t)` (`actions.ts:333`) clears safe incidental UI while waiting. This is the core observation loop.

**Porcelain example, `chopTree` (`actions.ts:701`):**
1. `dismissBlockingUI`.
2. Resolve the target, default `/^tree$/i`.
3. Record `logsBefore = countInventoryItems(/logs/)`.
4. `sendInteractLoc(x, z, id, 1)`; if it fails, return the failure.
5. `waitForCondition(logs > before || tree despawned, 30s)`.
6. Success only if the log count rose.

---

## 6. Game clients

### 6.1 Browser bot

`server/webclient/src/bot/`:
- `BotOverlay.ts` hooks `client.setOnGameTickCallback(onGameTick → sendState)`.
- `GatewayConnection.ts` builds the URL `ws(s)://<page host>/gateway` (the engine relays it). Credentials come from the page's `?bot=&password=` URL.
- `OverlayUI.ts` is the DOM overlay.
- The SDK auto-launch opens `<origin>/bot?bot=<u>&password=<p>`.

### 6.2 Lite headless client

`server/webclient/src/lite/` (README is the spec):

| File | Role |
|---|---|
| `session.ts` | `startSession({host, username, password, …})` runs bootstrap → login → packet pump every 20ms (`LOOP_MS`). Keepalive every 50 cycles. Idle death after 3000 cycles (about 60s with no bytes). `stopped: Promise<SessionEnd{reason: 'stopped'\|'logged-out'\|'disconnected'\|'idle'\|'error'}>`, plus `onEnd`. |
| `net/GameConnection.ts` (227) | TCP/WS socket, RSA+ISAAC login, `OutdatedClientError` (runner exits with code 3). |
| `protocol/incoming.ts` (662) | Framing and dispatch. Unknown opcodes are skipped using `ServerProtSizes`. A burst of 20 handler throws within 500 cycles ends the session. |
| `protocol/entities.ts` (566) | PLAYER_INFO/NPC_INFO bit decoders. |
| `protocol/zone.ts` | Ground items and loc changes. |
| `LiteClient.ts` (1021) | **Façade** exposing the same ~54 methods and ~36 fields the bridge reads off the browser `Client`, so `StateCollector`/`ActionExecutor` run unmodified. `collectBotState(tick)`, `executeBotAction(a)`, interaction methods. `activate()` repoints the shared static interface table per client; a prototype wrapper does this automatically. |
| `world/LocIndex.ts`, `SceneLite.ts`, `CollisionBuilder.ts` | World loc and terrain index built from `/ondemand.zip`. Collision rebuilt lazily (`collisionDirty`). |
| `movement.ts` | `tryMove` BFS port and MOVE packets. |
| `actions.ts` | Packet encoders. |
| `interfaces.ts` | Per-client copy-on-write interface table. |
| `cache.ts`, `dom-shim.ts` | Config/interface cache fetch; browser shims for Bun. |

`runner.ts` (445) is the gateway bridge for one bot per process, described in §3.4. Usage: `cd server/webclient && bun src/lite/runner.ts <bot>`. Gateway URL is `env.GATEWAY_URL || deriveGatewayUrl(SERVER)`. It exits non-zero when the session ends for any reason other than `stopped`.

`swarm.ts` runs many clients in one process **without the gateway**: `StateCollector` and `ActionExecutor` are called directly from the tick callback, which avoids about 2s of round trip per action. Sessions are supervised and re-login with backoff.

Measured cost: about 13.8MB and 0.42% CPU per bot.

---

## 7. MCP (`mcp/`; registered in `.mcp.json`)

`.mcp.json`: `{"rs-agent": {"command": "bun", "args": ["run", "mcp/server.ts"]}}`

### 7.1 `server.ts`

- Stdio `Server{name:'rs-agent-bot'}` with an `instructions` string covering: the structuredContent shape, the error kinds, using `args` instead of interpolating into `code`, one execution per bot, and keeping tight loops inside one call.
- `main()` installs console capture (stdout must stay clean for MCP) and calls `initPathfinding()` before connecting.
- **Resources:** `file://../sdk/API.md` and `MARKET.md`, read relative to `mcp/`.

**Tools:**

| Tool | Behaviour |
|---|---|
| `execute_code{bot_name*, code? \| script?, args?, world: 'none'\|'brief'\|'full' = 'brief', timeout (minutes, default 2, clamped 0.1–60)}` | Exactly one of `code`/`script`. Has an `outputSchema`. |
| `disconnect_bot{name}` | Runs through `botExecutions.run`, so it supersedes the running execution. |
| `list_bots{}` | Returns `{bots:[{name, username, connected}], count}`. |
| `get_market` | RS only. |

### 7.2 `api/index.ts` `BotManager`

- Connections are keyed case-insensitively.
- `connect(name)` reads `bots/<name>/bot.env` (cwd first, then repo root). `GATEWAY_URL` > `deriveGatewayUrl(SERVER)`.
- Creates `BotSDK{control, autoReconnect, autoLaunchBrowser:'auto'}`.
- `connectWithRetry`: 3 attempts, 30s each, backoff 2s then 4s.
- `BotConnection` tracks `lastShownMessageTick` so each call shows only new messages.

### 7.3 `execute-code.ts` semantics

- **One execution per bot (`BotExecutions.run`):** a new call aborts the previous one with `ExecutionStopped('superseded')` and awaits its `done` before starting. A client abort (MCP cancel) maps to `'cancelled'`.
- **Pre-flight:**
  - Ensures a connection.
  - If `stateAge > 10s`, waits for a state change (15s).
  - If not `inGame`, waits for ready (15s).
  - On failure it logs a warning **and still runs**.
- **`tracked()` Proxy around `bot` and `sdk`:**
  - Records in-flight method names into `activeActions` for error reports.
  - Once aborted, every call returns a never-settling promise. This stops catch-all loops in cancelled code from spinning.
- **Inline `code`:**
  - Transpiled with `Bun.Transpiler({loader:'ts'})` as `const __rsExec = async (bot, sdk, Spells, args) => {{ <code> }};`.
  - Evaluated with `new Function`.
  - Runs inside `executionContext.run({signal, log: record})` so every SDK wait is cancellable and every `console.*` is captured per execution.
- **`script` path:**
  - Resolved relative to the repo root.
  - Must `export default async ({bot, sdk, args}) => …`.
  - Re-imported with `?v=<mtime>-<size>` cache-busting.
  - Rejected if it calls `runScript(` without an `import.meta.main` guard, because that would open a second controller.
- **Result:**
  - The return value goes through a JSON round-trip and `redactValue` (password/token/secret/api key).
  - Text content: `── Console ──` / `── Error ──` (+ elapsed and active action) / `── Result ──` / `── World State ──` / a tip when code is over 2000 characters.
  - `structuredContent: ExecuteCodeResult {ok, result, logs[], error: {kind, message, activeActions[]}|null, elapsedMs, world: WorldSummary|null}`.
  - `isError: true` when `!ok`.
  - `kind ∈ {exception, timeout, superseded, cancelled, not_connected, invalid_input, unserializable_result}`.
  - `EXECUTE_CODE_OUTPUT_SCHEMA` (l.~250) mirrors `WorldSummary`.
- **`console-capture.ts`:** bounded head/tail ring with line clipping; routes by `executionContext`.

The MCP server **does not launch the lite client**. It relies on the SDK's `autoLaunchBrowser:'auto'` to open the browser bot page.

---

## 8. Bots, learnings, docs

- **`bots/create-bot.ts [name] [--local|--server=h] [--no-chat]`:**
  - Name must be at most 12 alphanumeric characters; otherwise a random 9-character name is used. Password is 12 random characters.
  - Copies `bots/_template/` and replaces `{{USERNAME}}`/`{{PASSWORD}}`.
  - `--local` rewrites the env to `SERVER=localhost:8888` + `GATEWAY_URL=ws://localhost:7780`.
- **`bots/_template/`:**
  - `bot.env`.
  - `script.ts`: `import {runScript} from '../../sdk/runner'; await runScript(async ({bot, sdk}) => {…}, {timeout: 60_000})`.
  - `lab_log.md`: session sections Goals / Observations / Next Steps / SDK bugs.
- **`learnings/*.md`:** one markdown per topic (banking, combat, dialogs, walking, shops, skills, an area). Snippets assume the `execute_code` globals. The README fixes the action-semantics rules.
- **`wiki/`:** items, npcs, shops, skills, quests, plus `generate-*.ts` scripts that build them from content.
- **Agent docs:** `CLAUDE.md` (agent playbook: create bot → start lite runner → cli state → script → iterate; duration guidance of 10s → 1min → 5min; troubleshooting the two silent-failure modes). `AGENTS.md` and `GEMINI.md` point to it.
- **`sdk/API.md`:** generated with `bun run docs:api` and kept in sync by `sdk/test/api-docs.test.ts`. That test checks that the checked-in file equals the generated one, that there are over 100 methods, and that historically omitted methods are present.

---

## 9. Tests (`sdk/test/PRINCIPLES.md`)

Two tiers.

**Unit tests** (`*.test.ts`, `bun:test`, no server, under 1s, part of `bun run check`). Patterns:
- Stub the SDK: `Object.create(BotSDK.prototype)` with fake `config`, `connectionState`, `pendingActions`, `ws`, `send`. Drive `handleMessage(JSON)` directly (`action-dispatch-failure.test.ts`).
- Fake servers with `Bun.serve({port:0})` (`direct-gateway.test.ts`, `gateway-*.test.ts`).
- Feed fabricated `BotWorldState` into pure helpers (`state-summary`, `walkto-tolerance`, `inventory-count`, `chat-history`, `find-loc-with-option`).
- Docs tests (`api-docs.test.ts`, `docs-snippets.test.ts`).
- Lite protocol tests in `server/webclient/src/lite/*.test.ts`: `action-encoding` (golden packets), `packet-errors`, `cycles`, `interfaces` (real dispatch path), `CollisionBuilder` (byte-identical against the browser `ClientBuild` oracle), `zone-reset`.

**Integration scripts** (`sdk/test/<mechanic>.ts`):
- Standalone Bun programs run against a local server, e.g. `HEADLESS=true bun sdk/test/mining.ts`.
- `utils/save-generator.ts generateSave(name, {position, skills, inventory})` writes the engine `.sav` directly (sets up preconditions, never used to cheat outcomes). `TestPresets`.
- `utils/browser.ts launchBotWithSDK` uses Puppeteer.
- `utils/test-runner.ts runTest({name, preset}, fn → boolean)`.
- Rules: one mechanic per test; pass only on an observed state change; no `page.evaluate`; no engine/DB shortcuts for outcomes; exit early.

**Root `package.json` scripts:**

| Script | Command |
|---|---|
| `check` | typecheck + typecheck:webclient + test |
| `test` | `bun test sdk/test server/webclient/src/{bot,util,lite,mapview} <engine tests> server/gateway/state-fanout.test.ts` |
| `typecheck` | `tsc --noEmit` |
| `typecheck:webclient` | `tsc -p server/webclient/tsconfig.json` |
| `docs:api` / `docs:api:check` | API.md generation / verification |
| `fetch-collision-data` | Refresh `collision-data.json` |

Dependencies: `@modelcontextprotocol/sdk ^1.32.1`, `@inquirer/prompts`, `open`. Dev: `@types/bun`, `puppeteer`. Peer: `typescript ^5`. `bunfig.toml`: `[install] auto=true`.

**Root `tsconfig.json`:** ESNext lib + DOM, module ESNext, `moduleResolution: bundler`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `noEmit`, `strict`, `noUncheckedIndexedAccess`, `resolveJsonModule`. `include: ["*.ts", "server/gateway/**/*.ts", "sdk/**/*.ts"]`. `exclude` covers engine and webclient.

**Webclient tsconfig:** `baseUrl src`, paths `#/*` and `#3rdparty/*` (mirrored by `package.json` `imports`), `noImplicitOverride`, `noImplicitAny`.

---

## 10. Recommendations for daoc-sdk (OpenDAoC at `server/core`)

### Copy 1:1 (rename `rs` → `daoc`; game-agnostic)

1. **`sdk/execution-context.ts`**: verbatim.
2. **`mcp/execute-code.ts`, `mcp/console-capture.ts`, the `mcp/server.ts` tool definitions, `mcp/api/index.ts`**:
   - Replace the `Spells` global with a DAoC equivalent (spell line/id table) or drop it.
   - Keep the `ExecuteCodeResult` shape, the error kinds, supersede semantics, the `tracked` Proxy, the TS transpile wrapper and the `script` module loading.
   - Change `autoLaunchBrowser:'auto'` so it **spawns the headless client process**. There is no browser client for DAoC, so the BotManager should own a `Bun.spawn` of the client runner, or run the client in-process.
3. **Gateway protocol envelope (§1):** keep it unchanged (message type names, `actionId` correlation, control/observe modes, last-controller-wins, takeover via `save_and_disconnect`, `lastState` replay, `repeatsLastFanout`, HTTP `/status`, `/state`, `/chat`, `/say`, `/dm`).
   - Drop the engine imports (`MemoryDiagnostics`, `NetworkPressure`), the Fly direct-port logic, `/traffic` and the outdated-client lookup at first.
   - Bun.serve on 7780.
4. **`BotActionQueue`, the runner tick loop, and the generation and expiry logic** (`lite/runner.ts:171-262`): copy, but drive the tick from DAoC server packets rather than a 20ms poll. DAoC has no fixed 600ms tick. Define `state.tick` as a client publish counter (e.g. a 250–500ms publish timer plus publish-on-change). Everything that uses `waitForTicks` assumes a monotonic `tick`.
5. **`BotSDK` plumbing:** `connect`/reconnect/handshake deadline, `sendAction` with conversion of failures into `ActionResult`, `waitForCondition`, `waitForStateChange`, `waitForTicks`, `waitForReady`, `onStateUpdate`, `ChatHistory`, `chunking`, `redact`.
6. **`runScript` (`sdk/runner.ts`):** verbatim. Change the `requireLiveClient` hint text to point at the DAoC client runner.
7. **Conventions:** `bots/create-bot.ts` plus `_template` (`bot.env` keys `BOT_USERNAME`, `PASSWORD`, `SERVER`, `GATEWAY_URL`, `SHOW_CHAT`; add `REALM`, `CHAR_NAME`, `CLASS`, `RACE` for character creation since DAoC splits account and character), `learnings/` structure, `CLAUDE.md` playbook structure, `generate-api-docs.ts` (only `methodCategory` buckets change), `api-docs.test.ts`, PRINCIPLES.md two-tier testing, `package.json` scripts, root tsconfig.
8. **Formatter:** keep `summarizeWorldState`/`WorldSummary` as the MCP contract shape, with fields re-mapped as below.

### Adapt for DAoC

1. **State model.**
   - Replace tile coordinates `x`/`z`/`level` with DAoC **`regionId` + global `x`, `y`, `z` (height) + `heading` (0–4095)**, plus zone id. Keep `distance` in world units.
   - Players, NPCs, mobs and objects all share one **object-id (OID / session id) space** in the DAoC protocol. Use `objectId` instead of `index`.
   - Remove `skills` with XP-per-skill as the primary progress signal. Instead:
     - `player.level` and `experience` (+ `expForNextLevel`), `realmPoints`, `bountyPoints`.
     - `health`/`maxHealth`, `mana`/`maxMana`, `endurance`/`maxEndurance`, `concentration`.
     - `realm`, `class`, `race`.
     - `specs` (spec points and specialization levels), `abilities`, `spellLines`.
   - New fields:
     - `target` (current target OID), `inCombat`, `attackState`, `effects`/`buffs` (concentration effects, timers), `isSitting`, `isStealthed`, `groupMembers`, `quickbar`.
   - Replace RS-specific blocks:
     - `dialog`/`interface` become DAoC **dialog/popup (CustomDialog, accept/decline), NPC "interact" text windows with `[bracketed]` keywords (`/whisper` responses), and trainer and merchant windows**.
     - `shop` becomes a merchant window with item pages.
     - `bank` becomes the vault.
     - `trade` maps to DAoC trade.
     - Drop `prayers`, `ge`, `combatStyle` (replace with styles available from specs), `opFeedback` (replace with `lastErrorMessage` / system-message refusal scanning: "You can't see your target", "is too far away").
   - Keep `gameMessages` with DAoC chat types (say, send/tell, group, guild, system, combat, spell result, damage).
   - DAoC combat feedback is in **messages and the attack/spell-result packets**. Build `combatEvents` from those.
2. **BotAction union.** Rebuild it around DAoC client verbs:
   - Movement and targeting: `moveTo`/position-update stream, `setTarget(oid)`.
   - Combat: `attack(on|off)`, `useStyle(id)`, `castSpell(lineIdx, spellLevel | quickbar slot)`, `useSkill`/`useAbility`.
   - Interaction: `interact(oid)` (the right-click "interact" request), `whisper(oid, keyword)` (dialog navigation; it replaces `clickDialogOption`), `respondDialog(id, accept)`.
   - Items: `pickup`, `useItem(slot)`, `moveItem(from, to, count)` (DAoC equip, unequip, drop, vault and trade are all item-slot moves), `buy(merchantPage, slot, count)`, `sell`.
   - Social and status: `say`/`send`/`groupChat`, `sit`/`stand`, `release` (on death), `bindstone`, `/stick`, `/face`.
   - Keep the `{type, …, reason}` envelope and `ActionResult.phase`.
3. **Movement and pathfinding.**
   - DAoC has no server-side click-to-walk. **The client must stream player position-update packets**, interpolating along a path at the run speed the server allows, or it gets flagged or rubber-banded.
   - So `walkTo` cannot be a single fire-and-forget action as in RS. Implement a **client-side mover**: the client owns the path follower and position-update cadence; the SDK sends `walkTo{x,y,z,regionId}` or `followPath{waypoints}`.
   - Replace the `rsmod` tile BFS and `collision-data.json` with **Recast/Detour navmeshes**. OpenDAoC already has them: `server/core/GameServer/world/Pathfinding/LocalPathfindingMgr.cs`, `server/core/Pathing/Detour.Managed/DetourNavMesh*.cs`, navmesh builder `server/buildnav`.
   - Two options:
     - (a) Expose a pathfinding HTTP endpoint from the server or a sidecar.
     - (b) Load the navmeshes in TS (port Detour queries or use a recast-navigation WASM build).
   - Keep the `findPath` → `{success, waypoints, reachedDestination}` contract.
   - Doors and gates are minor in DAoC. Drop the door machinery (`findDoorsAlongPath`, `TemporaryDoorBlocklist`), except for keeps.
   - Keep the progress, stuck and death-abort logic from `_walkToRoute`.
4. **Headless client.**
   - The rs-sdk lite client reuses the real browser client as a façade and oracle. **DAoC has no TS reference client**, so the client is a from-scratch protocol implementation against OpenDAoC's handlers:
     - `server/core/GameServer/packets/Client/<version>/*` gives the inbound packet handlers. This is the spec for what the bot must send.
     - `server/core/GameServer/packets/Server/PacketLib*.cs` gives the outbound encoders. This is the spec for what the bot must parse.
     - `server/core/Pathing/PacketEncoding1110.cs`, `PacketEncoding168.cs` and `CryptLib168.cs` (already visible in the tree) cover encryption and encoding.
   - Choose one client version (e.g. 1.127+/1.128) and pin it the way rs-sdk pins its revision.
   - Keep from the lite design:
     - typed `SessionEnd` reasons;
     - idle-socket death;
     - "skip unknown opcode by size" (DAoC TCP packets carry a length header, which makes this easy);
     - a burst-of-handler-errors kill switch;
     - one process per bot (`runner.ts`) **and** an in-process swarm mode.
   - Separate `StateCollector` (protocol model → `BotWorldState`) from `ActionExecutor` (`BotAction` → packet encoders). Since there is no browser oracle, **golden-packet tests** (`action-encoding.test.ts` style) become the main correctness tool. Validate them against the OpenDAoC handlers, possibly with a C# test harness in `server/core/Tests` or a recorded-pcap fixture.
   - DAoC uses TCP plus UDP: position updates can go over UDP, but TCP fallback works on OpenDAoC. Start TCP-only.
5. **Auth.**
   - Gateway auth stays pluggable. Default to no-op as in rs-sdk.
   - Account auto-creation: OpenDAoC can auto-create accounts on first login (`AUTO_ACCOUNT_CREATION` server property). Character creation needs class, race and realm, which come from `bot.env`.
6. **Test saves.** Replace `generateSave` (`.sav` writer) with direct DB seeding of the OpenDAoC MariaDB/SQLite `DOLCharacters`/`inventory` tables for setting up preconditions only. Alternatively use GM `/` commands from a privileged test account (`/jump`, `/item`, `/level`). The same rule applies: never use it to cheat outcomes.
7. **Porcelain set (`bot.*`):**
   - Keep the generic ones with DAoC semantics: `walkTo`, `interactNpc`, `talkTo` (interact, then a whisper keyword chain replacing `navigateDialog`), `attack` (target + attack, observe target health / combat messages), `castSpell`, `pickupItem`, `dropItem`, `equipItem`/`unequipItem`, `eatFood` → `useItem`/`rest` (sit to regen), `openShop`/`buyFromShop`/`sellToShop`, `openBank` → `openVault`, `closeInterface`, `dismissBlockingUI` (auto-decline or accept DAoC dialog popups based on an allowlist), `waitForIdle`.
   - New ones: `bindAt`, `release`/`respawn`, `trainSpec`, `useStyleChain`, `assistGroupLeader`, `followTarget`, `pullAndKill(pattern)`, `restUntil(hp/mana%)`, `acceptGroupInvite`, `useHorseRoute` (stable masters), `teleport`.
   - Drop the RS skilling set (`chopTree` … `stringAmulet`), GE and market, `skipTutorial`, prayers.
8. **MCP world summary:** remap `WorldSummary.player` to `{name, level, realm, class, x, y, z, regionId, zone, hp, maxHp, mana, endurance, inCombat, targetOid}`. Replace `skills` with `{xp, xpToLevel, rp, specs}`.

### Suggested daoc-sdk layout (mirrors rs-sdk)

```
sdk/{index.ts(BotSDK), actions.ts(BotActions), actions-helpers.ts, types.ts, runner.ts, cli.ts, chat.ts, chat-history.ts,
     chunking.ts, pathfinding.ts(navmesh), formatter.ts, execution-context.ts, generate-api-docs.ts, API.md, test/}
gateway/{gateway.ts, types.ts, state-fanout.ts}            # copy, de-engined
client/{session.ts, runner.ts, swarm.ts, net/(Tcp, crypto, framing), protocol/(incoming/*, outgoing/*),
        model/(World, Player, Npc, Inventory, Chat), StateCollector.ts, ActionExecutor.ts, ActionQueue.ts, movement.ts}
mcp/{server.ts, execute-code.ts, console-capture.ts, api/index.ts}
bots/{create-bot.ts, _template/{bot.env, script.ts, lab_log.md}}
learnings/   CLAUDE.md   .mcp.json   package.json   tsconfig.json
```

**Highest-leverage reuse:** the SDK↔gateway↔client JSON contract, `runScript`, `execute_code`, and execution-context cancellation. That is roughly 1,500 lines that port almost verbatim.

**Real new work:**
- the DAoC binary protocol client (handshake, crypto, the packet set);
- the position-streaming mover plus navmesh pathfinding;
- a DAoC-specific `BotWorldState` and `BotAction` set;
- the porcelain layer on top.