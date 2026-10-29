# Build

# Browser viewer: done and verified live

The viewer works against the real server. I tested it with `client/runner.ts view1` and a gateway on port 7791, in the built-in browser. It drew the map with about 100 town NPCs, the other agent's player Runone, objects, zone rects, the bind point, and the bot's heading arrow. Things that worked from the page:
- **Control mode:** click-to-move (arrived, with the waypoint line and destination X drawn), click to target (ring, target line, target panel), say (echo appeared in the log).
- **NPC dialog:** double-clicking trainer Master Graent showed "Do you require a [training shield]?" with a keyword button. Clicking it whispered the keyword, and the item showed up in the inventory list.
- **Index page:** listed the bots, including one shown as dead after it quit.

`bun test ./gateway` passes (28 tests, 8 of them new). `bunx tsc --noEmit` is clean. The bot quit cleanly with exit 0, so there is no re-login lockout; the test gateway is stopped. Nothing is committed.

## URLs (all served by the gateway, e.g. `http://localhost:7780`)
| Route | What it does |
|---|---|
| `GET /viewer` | Bot index; polls `/bots` every 2 s |
| `GET /viewer/<bot>` | Single-page viewer for one bot; works before the client attaches |
| `GET /viewer/assets/app.js` | `app.ts` bundled with `Bun.build` on request, cached until the sources change |
| `GET /viewer/assets/viewer.css` | Stylesheet |
| `GET /bots` | `{bots: [{username, status, inGame, clientId, tick, stateAge, phase, player: {name, level, className, realm, regionId, zoneName} \| null, controllers, observers}]}` |
| `GET /zones/<regionId>` | `{regionId, region, zones: [{id, name, xOffset, yOffset, width, height}], zonePoints, bindpoints}`. Data modules are imported lazily. |
| `POST /bots/<bot>/auth` `{password}` | Checks the password before the page enables control |

The page connects over the gateway WebSocket as an observe-mode SDK (`clientId 'viewer-observe'`). If that socket is down it polls `GET /state/<bot>`, and it polls `/status/<bot>` every 1.5 s. Ticking control opens a **second** socket in control mode (`'viewer-control'`).

## Files
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/routes.ts`: exports `handleViewerRequest(req, url, ctx): Promise<Response|null>`, `listBots`, `regionData`, `buildAppBundle`, and the types `ViewerContext` / `BotListEntry`.
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/app.ts`: the browser app (canvas map and side panel).
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/con-level.ts`: `conLevel(user, target)` and `conColor(...)`, a port of `CharacterConLevelGrid`, plus `CON_HEX`.
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/index.html`, `bot.html`, `viewer.css`
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/viewer.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/gateway/gateway.ts`: 3 lines added. They are an import, one delegation line after the OPTIONS check (`await handleViewerRequest(req, url, { botSessions, sdkSessions, sessionStatus, auth })`), and one help-text line.

## What the page shows
- **Map:** NPCs coloured by con (hollow ring for peaceful, red ring for in combat, X for dead, dashed red line when a mob targets the bot), players as realm-coloured diamonds, loot, doors and objects, the waypoint path and destination, ground target, zone exits, bind circles, and the 192-unit interact ring.
- **Map interaction:** drag to pan, wheel or +/− to zoom around the cursor, follow toggle, labels that skip overlaps (players and loot first), and hover tooltips with name, level, con, HP %, distance, guild/role and object id.
- **Side panel:** HP/power/endurance/concentration bars, XP and RP, realm/class/race, zone and region, money, state flags, target or selection, the dialog box (accept/decline), NPC dialog with keyword buttons, the text window, the merchant window (buy/close), effects and concentration effects, group, inventory and equipment, and the chat log and combat events. Scroll position is kept between updates.
- **Control mode:**
  - click the ground to move, click an entity to target it, double-click to interact (or pick up loot);
  - say box, Stop, Sit/stand, Attack, Clear target.
  - It warns before pre-empting an existing controller, and falls back to observe if another controller takes over.

## Verified live vs unit-only
- **Live:** everything in the first section. I also ran a fake bot sending sparse and malformed state (null lists, missing ids, non-numeric level) and the page rendered with no console errors.
- **Unit-only:** the routes (`/bots`, the HTML pages and name escaping, the bundle, `/zones/1` with Camelot Hills, the auth hook and empty password, gateway routes still working, observe socket receiving state) and the con grid at levels 1, 10, 50 and 51.
- **Never seen with real data:** dialog boxes, merchant buy, group, effects and the text window. I only saw them with the fake bot.

## Known gaps
- **The password check is advisory only.**
  - **Why:** the gateway's default auth hook allows everything, and `/bots/<bot>/auth` only rejects a password that doesn't match `bots/<bot>/bot.env`. It looks for that file relative to the gateway's working directory or the repo root.
  - **Effect:** with no bot.env and the default hook, any non-empty password passes.
  - **Fix:** real protection needs a gateway auth hook.
- **Taking control pre-empts a running script's SDK**, because the last controller wins. The page asks for confirmation first.
- The page saves the typed password in `sessionStorage` (cleared when the tab closes), and the zoom level in `localStorage`.
- The NPC dialog shows only the client's last `npcDialog` line, not the whole conversation.
- Some town NPCs come through unnamed (a level-1 NPC sitting on top of Master Visur); they are drawn and labelled "(unnamed)".
- In a hidden browser pane, screenshots can lag a frame or two behind (likely `requestAnimationFrame` throttling); a later screenshot was up to date.

## Notes for other modules
- Whoever owns `gateway.ts`: keep the `handleViewerRequest` line before the `/status` and fallback routes. The viewer claims `/viewer*`, `/bots*` and `/zones/*`.
- `bots/` in the repo is empty. For the live run I put a test `bot.env` (account `view1`, character `Viewone`) under `C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/viewer-live/bots/view1/` and started the runner from there, which `findBotEnv` supports.
- The new `client/runner.ts`, clean `quit` action, `PlayerState.speed` (172 while moving) and `movement.waypoints` all behaved correctly live.

# Review

The viewer review is done: I fixed five bugs, all in files the builder owned. `bun test ./gateway` passes (31 tests, 3 new) and `bunx tsc --noEmit` is clean for the whole project. I re-ran the live check against the real server. The bot quit cleanly with exit 0, so there is no re-login lockout. My test gateway (port 7792) and browser tab are stopped. Nothing is committed.

## Bugs fixed
1. **Race when toggling control.** `gateway/viewer/app.ts`, `enableControl` / `disableControl` (~l.205-262).
   - **Before:** if you unticked control while `/bots/<bot>/auth` was still answering, the page opened a control socket anyway. That pre-empted any running script while the checkbox showed "off". Toggling quickly opened two control sockets, and one of them leaked.
   - **Fix:** a `controlGen` counter, bumped by both functions. `enableControl` stops after each wait unless it is still the newest call and the box is still ticked.
   - **Live check:** click, click left 0 controllers. Three clicks left exactly 1 controller, and the gateway log showed no pre-emption.
2. **Zone data refetched on every state update after an error.** `app.ts` `applyState` / `loadRegion` (~l.80-115).
   - **Before:** a `/zones` error set nothing that stopped the next try, so the page fetched again on every state update. A slow reply for a region the bot had already left could also replace the current region's zones.
   - **Fix:** a 10 s backoff after a failure (`REGION_RETRY_MS`), and a reply is ignored unless it is for the region still being loaded.
3. **Polling fallback broke under a real auth hook.** `app.ts` `pollFallback`.
   - **Before:** `GET /state/<bot>` went out with no credentials, so it would get 401 once a real hook is installed. A slow poll reply could also replace newer state that the observe socket had just delivered.
   - **Fix:** the page now sends the typed password as an `Authorization: Bearer` header (never in the URL). The poll result is applied only if the observe socket is still down.
4. **Stale bundle cache.** `gateway/viewer/routes.ts` `newestSourceMtime` (~l.102).
   - **Before:** the cache only checked `app.ts` and `con.ts`. Changing any other module the app imports kept serving the old bundle.
   - **Fix:** it now watches every non-test `.ts` file in the folder except `routes.ts`.
5. **Toast implied success.** `app.ts` `act`.
   - **Before:** results the client returns as soon as the packet is sent (phase `dispatch`) read like success. Live, a buy with 0 copper toasted "buying 1 × rough blunt bolts" while the server said "You need 19 copper to buy this."
   - **Fix:** those toasts now say "(sent)". The server's real answer is in the chat log.

The new file `gateway/viewer/logic.ts` holds the page logic that doesn't need the browser, so it can be unit-tested. It exports `shouldLoadRegion`, `REGION_RETRY_MS` and `authHeaders`. No public BotSDK or `sdk/types.ts` changes, so no API docs to regenerate.

## Tests added (`gateway/viewer/viewer.test.ts`)
- The zone-data backoff and the region-change cases.
- `/state` with an auth hook: 401 without a password, 200 with the page's header.
- The bundle is rebuilt when `logic.ts`'s timestamp changes (watches `Bun.build`; fails on the old code).

## Verified live
I used a new account `vrev1` (character Vrevone), `client/runner.ts`, a gateway on 7792 and the built-in browser. Everything here checked out:
- **Basics:** the map rendered with about 100 NPCs; click-to-move went to "arrived" with speed 172 while moving; say echoed; no console errors.
- **Pre-emption:** another controller connecting took over, and the page dropped to observe with a toast.
- **Merchant:** Torr Fletcher's window showed 56 items; buy and Close worked from the page.
- **Text window:** `&realm` showed the realm status window.
- **Dialog box:** `&hardcore on` opened it; Decline from the page closed it, and the server confirmed the decline.
- **Reload and quit:** reloading the page left exactly 1 observer and 1 controller. After quit, the page showed "ws · bot dead" and `/bots` showed the bot as dead.

The control-toggle race fix has no unit test because there is no DOM test setup; it is verified live only.

## Checked and found correct
- The con grid matches the C# `CharacterConLevelGrid` data, including levels past 50 and targets out of range.
- The heading arrow matches the server's `GetPointFromHeading`.
- The action shapes match `sdk/types.ts` and `client/client.ts`.
- Pending action timers are cleared when control is turned off.

## Remaining gaps
- The password check is still advisory only, as the builder reported. `/bots/<bot>/auth` with the default allow-all hook can also be used to guess the password in `bot.env`. Real protection needs a gateway auth hook.
- `readBotEnvPassword` in `routes.ts` takes the first `PASSWORD` line, while `parseEnvFile` takes the last. This only matters if a `bot.env` has duplicate lines.
- The control socket also receives the full state stream (gateway fan-out goes to every SDK), so bandwidth is doubled while control is on.
- A double-click also sends two click actions (setTarget or moveTo) before the interact. It is harmless live.
- Group and effects panels have still not been seen with real data.

## Notes for other modules
- **`gateway.ts` owner:** nothing changed in `gateway.ts`. Keep the `handleViewerRequest` line before the `/status` and fallback routes.
- **Client owner:** the client answers buy (and other packet-only actions) with success at phase `dispatch`, even when the server then refuses. Higher-level `BotActions` should confirm the result from chat or inventory.
- **Test config:** the test `bot.env` is under `C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/viewer-review/bots/vrev1/`.

## Files
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/app.ts`
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/routes.ts`
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/logic.ts` (new)
- `C:/Users/joshu/Code/daoc-sdk/gateway/viewer/viewer.test.ts`