# Trading between players

Verified live for the main paths: see "Verified live" at the end. The rest comes from reading the server source and from unit tests against a simulated server (`describe('trade')` in `sdk/test/actions.test.ts`). Source lines are relative to `server/core/GameServer/`.

## Quick start

```typescript
// Two processes or two MCP calls, one per bot. Both sides call, in any order.
const give = await bot.trade('Aine', { give: [/sleeves/], money: 10203 });   // on the giver: walks up, offers, accepts
const take = await bot.trade('Galahad');                                     // on the receiver: waits, accepts
// take.received: real slots of ours, ready for equipItem. Also gave, moneyGiven, moneyReceived, missing, messages.
```

```typescript
// One process with both connections (connectBot in bots/examples/duo.ts). For a swap, both pass give.
const [a, b] = await Promise.all([holder.trade(wearerName, { give: [sleeves] }), wearer.trade(holderName, { give: [gloves] })]);
```

- **`bot.trade(partner, { give, money, accept, range, timeout })`:** the main call. With `give` or `money` it walks up and offers first. Without them it only waits for that player's window, and closes one that holds anything of ours instead of accepting it.
- **`bot.offerTrade(partner, { give, money })` then `bot.acceptTrade({ from, accept })`:** the same in two steps, for looking at the partner's side in between. `offerTrade` leaves the window open on success and closes it on any failure. `acceptTrade` then finishes that window or nothing: if it closed in between, the answer is `cancelled` at once, and a window that came up in its place is closed, not accepted. The link lives in the `bot` object, so a new script has none.
- **`bot.acceptTrade()` with no offer of its own:** finish whatever window opens, as it stands, our side included.
- **`bot.cancelTrade()`:** close the window and observe it gone. It also clears a window the server holds but never told us about, so no window at all is a success. Use it first if an earlier script was killed mid-trade: `acceptTrade` in a new script would take a leftover window from a matching partner.
- **`sdk.getTrade()`** shows the open window: `partnerName`, `mySlots`, `myMoney`, `partnerItems`, `partnerMoney`, `id` and `revision`. `partnerItems[].slot` is the **partner's** slot, never ours. The state summary lists an open window as a blocker.
- **`give`:** items, name patterns or backpack slots. An item object means that item in that slot: when it has moved or gone the answer is `not_found`, so read the inventory again rather than giving away a similar one. `money` is the **total** copper our side should show, not an increment.
- **Afterwards:** when `trade` or `acceptTrade` returns, or the script is aborted, no window of ours stays open. A failure returns after the close has shown, up to 2 s past `timeout`, so a retry starts clean. A commit that crossed the close is reported as the completed trade. When another controller takes over, the old script can't reach the client any more, so the gateway sends the close. A script killed outright leaves the window.

## Between hunts only

A group run controls every member, and a second controller on any member aborts the whole run (`CLAUDE.md` Groups). A trade from a separate script ends the hunt, so wind it down first (`bun sdk/group/cli.ts <group> --wind-down`) and trade afterwards.

## Trades can hang the whole server

**Two adds that open a window in the same server tick (33 ms) can stop the game server for everyone.** Seen live with two bots swapping at the same instant, and reproduced on a throwaway stack with `bun client/dev/trade-race.ts --port=<port>` (2026-11-11: hung for good within 15-74 rounds).

**Fixed in our server fork** from the `server/core` pin ac64bb207 (branch `fix/trade-open-race`, [docs/upstream/core-trade-open-race.md](../docs/upstream/core-trade-open-race.md)): a trade opens under both players' trade locks, so the second add of a simultaneous pair joins the first one's window. 480 simultaneous pairs ran clean on it. A gameserver image built before that pin still hangs, so the rest of this section holds there, and the SDK keeps its clock slots for such servers.

**The cause.** The first add from each side takes different locks: `B._tradeLock` and `A`'s monitor against `A._tradeLock` and `B`'s monitor (`GamePlayer.cs:6259-6261`). So both can pass the null checks and both run `OpenTrade` (`:12072-12084`), and each side can end up with a different window and a different lock. In a correct pair the two windows share one lock, so adds only queue up. In a crossed pair the next two adds at once each hold their own lock and wait for the other's at the 0xEA (`PlayerTradeWindow.cs:321`, `:394`; `PacketLib1109.cs:32`).

**Why everything stops.** The game loop waits for every client's packet handling before it moves on, with no timeout (`GameLoopThreadPoolMultiThreaded.cs:176-177`, `GameLoop.cs:119-138`), and it sends queued packets only after that. The watchdog can interrupt one stuck worker, and the log shows the 9 s stall that cured. But the exception is swallowed at `PacketProcessor.cs:194`, so the worker never exits and the watchdog stays in `worker.Join()` for good (`GameLoopThreadPoolWatchdog.cs:101`). **It saves the server once per process.** The next hang lasts until a restart.

**What it looks like.**
- In a script: `no_response` on both sides, or `partner_no_accept` on both if the windows crossed without hanging (read from source, not seen). When the race doesn't cross the windows, one of the two adds is refused instead: its sender reads "X is still trading with Y." while the partner's add shows (seen in most simultaneous opening pairs on 2026-11-11).
- In the game: chat and moves do nothing, a quit gets no answer, and the gameserver sits near 0 % CPU.
- In the log: `Watchdog: Thread ... is taking too long` and `ThreadInterruptedException` in `SendTradeWindow` under `ReceiveTradeMoney` or `ReceiveTradeItem`, after a stall of 9-12 s. After the hang for good, no more lines at all, not even the minutely `StatPrint`, and a new login gets no answer to its handshake.
- The cure is `docker compose -f server/docker/docker-compose.yml restart gameserver`. Nothing was lost. Do it also after a single stall, because the watchdog is spent by then.

**What the SDK does about it.**
- **Clock slots:** an add that would open a window goes out only in this side's slot. The alphabetically earlier name sends in the first 250 ms of each second, the later name in the 250 ms from the half second, so two opening adds are never within 250 ms of each other, whoever starts first and however long the walks take. It costs up to 750 ms per trade. Adds to an open window don't wait. Both bots must share a clock: one host, or NTP.
- **A window that closed mid-list isn't reopened:** the call ends in `cancelled` instead of sending its next add.
- **With our accept standing, the client refuses** adds, drops, sells and item use with `trade_accepted`, until a new revision or a cancel. The partner's commit holds the window and wants our monitor and inventory, and those actions hold them and want the window (`PlayerTradeWindow.cs:406`, `:513`, `:718-722`; `GamePlayer.cs:6261`; `GamePlayerInventory.cs:335`). A plain move in the backpack is safe (`:489`).

**Still open.**
- Raw `sendTradeOfferItem` and `sendTradeOfferMoney` skip the slots: never send them from both bots at once.
- Don't retry a failed trade in a tight loop. During a stall, packets queue up and land together in one pass, whatever slot they left in.
- A snapshot that still shows a window the server has just closed skips the slot, for one round trip.
- The server fix covers two opening adds. A commit and an add at once is a separate lock order the fix leaves alone (the accept bullet above), so the `trade_accepted` refusal stays needed on every server.

## What the server does

**Opening.** The first add opens a window on both sides. The target does nothing and can't refuse the opening (`GamePlayer.cs:6263`). The window is the only channel between the two bots, with no chat protocol.

**Partner in view.** An offer needs the partner in `nearbyPlayers`, and any match by likeness could hand the items to another player. So a string must be its exact name (case-insensitive), a pattern is refused with `bad_args`, and a `NearbyPlayer` snapshot goes by its name, because the server gives a freed object id to the next object in the region (`Region.cs:779`, `:955`). A bare number is taken as it is. A standing player is announced only when it enters view, so both bots take a step after walking together ([grouping-and-chat.md](grouping-and-chat.md)). A call without `give` or `money` only compares names, needs nobody in view, and may use a pattern.

**Range.** 128 units in 3D (`WorldMgr.GIVE_ITEM_DISTANCE`).
- An add from farther away is refused: "You are too far away to give anything to X." `offerTrade` walks to 100 first (`range`), and on that refusal walks to 64 and retries once.
- An open window closes on either trader's next position update past 128 (`PlayerPositionUpdateHandler.cs:176-177`). An idle client sends one every second, so stand still until the trade is done.

**Same realm.** "You can't trade with enemy realm!" (`NormalServerRules.cs:181`).

**Stacks.** A stack always goes whole: the count in the packet is not used for a player target. A stack's name comes as `<count> <name>`, but real templates start with a number too (`100 gold rent token`, `20 Elven Arrows`), so the client takes a prefix as a count only where the item's value bytes agree (`PacketLib1124.cs:850-863`, `:978-979`).

**10 per side** (`PlayerTradeWindow.MAX_ITEMS`). `offerTrade` refuses more with `too_many_items` before it sends anything.

**What can be traded.** On a PrivLevel-1 account an item must be droppable, pickable and tradable and must lose durability, or the answer is "You can't trade this item!" (`PlayerTradeWindow.cs:326-327`). The server opens the window **before** it checks the item and sends no 0xEA for that refusal, so a refused first item leaves a window on both sides that neither client can see, and the next add answers "You are still trading with X." `offerTrade` closes it on failure, and on that line with no visible window it closes and retries once.

**Items and money stay put until the commit.** An offered item stays in its backpack slot, and the purse doesn't move. The evidence of an add is the 0xEA that shows it, so that is what `offerTrade` waits for. Money adds up on the server, one 0xDD per nonzero coin. The server holds each drop alone against the purse, never the running total (`PlayerMoveItemRequestHandler.cs:258`, `PlayerTradeWindow.cs:350`). So an amount above the purse can lose some coins silently and keep others, or show in full and fail at the commit. `offerTrade` checks the purse first and returns `insufficient_funds`. A raw `sendTradeOfferMoney` doesn't.

**Who accepts.** Both sides. Order is free, and the second accept commits (`PlayerTradeWindow.cs:408-414`). A plain accept sends no 0xEA, only the system line "X has accepted the trade." to the partner. `trade` and `acceptTrade` accept each new revision of the window, so a commit can't come before a giver's last add. `accept(window)` judges each one: false means "not yet", and false after a yes returns `offer_changed`, because our earlier accept may still stand on the server. A revision whose `mySlots` or `myMoney` isn't what we offered is never accepted, whatever `accept` says, and also ends in `offer_changed`.

**What resets an accept.** `TradeUpdate` clears both flags and sends 0xEA to both sides, and accept state is not on the wire. So every 0xEA means both accepts are gone, and `revision` counts them.
- Either side adds an item or money, or tries an 11th item (`PlayerTradeWindow.cs:333-351`).
- A commit fails (`:455`, `:531`).
- Either side moves or loses **any** inventory item while a window is open, even one that isn't in the trade (`GamePlayerInventory.cs:335`, `:542-543`; `PlayerTradeWindow.cs:367`). A moved item also leaves the offer, and the call then ends in `offer_changed` rather than give the partner's side for nothing. Don't equip, sell or drop during a trade.

**The commit.**
- **Money** is taken first. A side short of it gets "You don't have enough money.", its money in the window drops to 0, its items stay in the window, and the window stays open. A blind re-accept could then give an item away for nothing, so a failure line ends the call before any re-accept, and the window is closed.
- **Space** counts the net change only: `max(0, their items - our items)` free backpack slots. A failure is "You don't have enough space in your inventory." and the money goes back.
- **Weight is not checked** (`PlayerTradeWindow.cs:511-514`). The receiver can end up overloaded with max speed 0 ([group-coordination.md](group-coordination.md) "Pitfalls seen live").
- **Item changes:** the emblem is cleared when the two aren't in the same guild, and poison is stripped unless the receiver is an Infiltrator, Shadowblade or Nightshade (`:587-603`).
- **The end:** inventories change, "Trade Completed. N items for M items." arrives (`0 items for 0 items` for money alone), then the window closes. A failed add is only logged on the server and still prints that line, so the SDK checks the backpack: `item_missing`, with `missing` filled, means the commit ran and an item never arrived. An identical item we had and kept doesn't count as arrived.

**Closes.** A cancel from either side closes both windows. So do a range close, link death and leaving the game (`GamePlayer.cs:861`, `:923`). All of them are the same silent 0xEA with no cause, so `cancelled` covers them alike. Layout: 0xEA in [docs/research/daoc-server-packets.md](../docs/research/daoc-server-packets.md).

**Other people's windows.** While waiting, a window from anyone who doesn't match the partner, or a self-craft window, is closed at once: holding it would tell the real partner "X is still trading with Y."

## Failure reasons

Game failures never throw. Branch on `reason`.

| Call | Reason | Meaning |
|---|---|---|
| offer | `not_in_game`, `dead` | Checked first; no add sent |
| offer | `bad_args` | Two refs to one slot, bad money, nothing to offer, or a pattern as the partner; no add sent |
| offer | `not_found` | No such item or player (no add sent), or the server's "Invalid trade target." |
| offer | `too_many_items`, `insufficient_funds` | More than 10 items, money above the purse; no add sent |
| offer | the walk's reason, `out_of_reach` | Couldn't get to the partner |
| offer | `timeout` | Out of time: the walk, also behind a partner that keeps running, or no budget left for an add |
| offer | `out_of_range` | "Too far away" again after the step to 64 |
| offer | `busy` | Either side is still in a window with someone else |
| offer | `wrong_realm` | Enemy realm |
| offer | `refused` | "You can't trade this item!" and the like; `refused.item` and `refused.message` say which |
| offer | `empty_slot` | The slot emptied after it was resolved |
| offer | `no_response` | Neither the 0xEA nor a refusal within 3 s. On both sides at once, suspect the hang in "Trades can hang the whole server" |
| offer | `trade_accepted` | Our accept still stands on the open window, for instance after a killed script. The call closes the window, so a rerun comes back clean |
| offer | `cancelled` | The window closed during the offer, and a later add reopened it without the earlier items |
| offer | `wrong_partner` | The open window is with someone else |
| settle | `timeout` | No window opened |
| settle | `offer_rejected` | `accept` never said yes before the deadline |
| settle | `offer_changed` | `accept` said no after a yes, or our side is no longer what we offered |
| settle | `partner_no_accept` | We accepted and the partner never did, or its client is too old to see the window |
| settle | `cancelled` | The window closed with no "Trade Completed": a cancel or a range close, the server doesn't say which. After `offerTrade`, also a window that closed before `acceptTrade` |
| settle | `unknown_action` | The client runs older code; the state has no `trade` field, so this comes at once |
| settle | `inventory_full`, `partner_inventory_full` | A commit failed on space |
| settle | `insufficient_funds`, `partner_insufficient_funds` | A commit failed on money |
| settle | `item_missing` | The commit ran, and an item isn't in our backpack after 1 s |
| settle | `not_in_game`, `not_found` | Left the game; `from` or `partner` is an object id nobody in view has |
| cancel | `timeout`, `already_completed` | Still open after 2 s; the commit got there first |

"offer" is `offerTrade` and the first half of `trade`, "settle" is `acceptTrade` and the second half of `trade`. An offer that has to close a stale window can also return the cancel reasons. Any refusal, also one before an add was sent, closes a window that was already open. A client started before the trade code answers `unknown_action` to every trade call: restart it with a quit action.

The raw calls are `sdk.sendTradeOfferItem(oid, slot)`, `sdk.sendTradeOfferMoney(oid, copper)`, `sdk.sendTradeAccept(revision?, windowId?)` (reasons `no_trade`, `trade_changed`) and `sdk.sendTradeCancel()`. Success only means dispatched.

## `accept` is not a safeguard

A partner's change can cross our accept in flight, so our accept can land on an offer we never saw. The guard on revision and window id shrinks this to one round trip (the packet itself names neither), and `offer_changed` catches a worse offer afterwards, but a commit could still land first. That's fine between your own bots. Don't rely on it against strangers.

## Verified live

Two PrivLevel-1 bots in Hibernia, level 13-15, 2026-11-02: `bun sdk/test/live/trade-live.ts <botA> <botB> [check ...]`. With the clock slots and the client guard: 65 checks passed. The 66th, `full`, stopped in its setup with 9 slots free, because it needs enough stack pieces and spare items to fill the receiver's pack; it passed in the run before those two changes. Everything else on this page is from source and unit tests.

- **One item:** both windows show the exact slot, name, count and partner. `received[0]` is at a real slot, and both `getTrade()` are null afterwards, so the 40-byte close holds.
- **A stack** goes whole, and arrives as its own stack beside one of the same name: 8 + 7 scraps stayed two stacks.
- **3 items with the receiver accepting first:** no commit until the giver accepts too.
- **Money:** 1g 2s 3c reads as 10203 on both sides and the purses move by that. The line is "Trade Completed. 0 items for 0 items."
- **Two-way swap, both calling at once or with the later name 100-900 ms ahead:** 11 of 11 went through with the clock slots, with no stall in the server log.
- **With our accept standing:** a raw add and a drop both read `trade_accepted`, nothing changed, and after a cancel the next offer went through.
- **10 items and an 11th:** `offerTrade` refuses 11 before sending. A raw 11th add stays out, the revision goes up, and the line is "You can't trade this item!"
- **Full backpack:** `partner_inventory_full` and `inventory_full`. Nothing moves and the windows close.
- **Walking away:** both `cancelled` 0.6-1.3 s after the walk began, 141-147 units apart by the last snapshot.
- **`cancelTrade` mid-window:** A succeeds, B reads `cancelled`. With no window it's a success too.
- **A non-tradable first item:** the Personal Bind Recall Stone gives `refused` ("You can't trade this item!"), and a fresh trade works straight after, so the cure for the invisible window holds.
- **An unrelated move after the partner accepted:** a new revision on both sides, no commit, and it takes both accepts again.
- **A script gone mid-window:** the window outlives it, and the next `trade` from that bot succeeds. A new controller taking over closes the old script's window.
- **Standing still since login, offering with no step:** each saw the other at once, with both logged in within a second of each other. A pair that stood apart for a while may still need the step.
