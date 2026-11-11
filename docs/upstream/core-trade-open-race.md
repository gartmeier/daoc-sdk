# Upstream PR draft: two trade adds in one tick hang the server

For [OpenDAoC/OpenDAoC-Core](https://github.com/OpenDAoC/OpenDAoC-Core). The fix is [core-trade-open-race.patch](core-trade-open-race.patch), branch `fix/trade-open-race` of our fork (b3cac47c5, not pushed yet). It is based on f0aaa1ea2 (tag 2026.09.36) and applies unchanged to upstream `master` a4dc4ed15; the commits in between don't touch the trade code. The PR isn't opened yet.

---

**Title:** `GamePlayer`: Open a trade under both players' trade locks

**Body:**

When two players drop an item or money on each other in the same game loop tick, the whole server can stop: every client's packets go unanswered, nobody can log in, and the process sits at 0 % CPU until it is restarted.

### Cause

`ReceiveTradeItem` and `ReceiveTradeMoney` run on the receiver and hold the receiver's `_tradeLock` and the source's monitor. When A and B add to each other in the same tick, the two packet handlers run on two workers and hold `B._tradeLock` + `A` against `A._tradeLock` + `B`: no lock in common. Both see `TradeWindow == null`, both call `OpenTrade`, and each creates its own pair of `PlayerTradeWindow`s with its own `sync` lock. The four assignments interleave, so A can end up with a window of one pair and B with a window of the other.

Those two windows share no lock, and each one's partner window is an orphan. The next time both add at once:

- A's handler holds A's window lock (`AddItemToTrade` / `AddMoneyToTrade` → `TradeUpdate`) and sends the trade window to B, which locks B's window (`PacketLib1109.SendTradeWindow`);
- B's handler does the same the other way round.

Each waits for the other's lock. The game loop waits for every client's packet handling with no timeout, so the whole server stops. `GameLoopThreadPoolWatchdog` interrupts the stuck worker once (the log shows `ThreadInterruptedException` in `SendTradeWindow` under `ReceiveTradeMoney`), but the next such hang lasts until a restart.

When the race doesn't cross the windows, one of the two adds is refused instead: its `OpenTrade` finds the partner's window already set and the source gets "X is still trading with Y."

### Fix

Take both players' `_tradeLock`s, in an order that doesn't depend on which side asks (`string.CompareOrdinal` on `InternalID`), before checking and opening the windows: in `ReceiveTradeItem`, `ReceiveTradeMoney` and `OpenTrade`. The second add of a simultaneous pair then waits for the first, sees the window it opened with the right partner, and adds to it. Nothing else takes a player's `_tradeLock` while holding a window lock or a player monitor (`ProcessDeath` and `OpenSelfCraft` take only their own), so the fixed order can't form a new cycle. The monitor and window locks inside are unchanged.

### How to reproduce

Two characters standing together, each with some copper. Each drops 1 copper on the other in the same tick, four times per window, then both cancel; repeat. The drops have to reach the server within one tick, so a script is easiest: [client/dev/trade-race.ts](../../client/dev/trade-race.ts) in daoc-sdk does it with two headless clients in one process.

### Tested

On a local server, 2026.09.36 with and without the patch, with the script above (two PrivLevel-1 Albion characters, 1 copper drops):

| Build | Rounds | Simultaneous pairs | Add not shown on both sides, server alive | Stalls |
|---|---|---|---|---|
| 2026.09.36 | 22+ | not recorded | most opening pairs | 12 s at round 15 (watchdog cured), then hung for good a few rounds later (output cut off) |
| 2026.09.36 | 74 | 290 | 33 | 11 s at round 62 (watchdog cured), hung for good at round 74 |
| with the patch | 60 | 240 | 0 | none |
| with the patch, plus our other fix | 120 | 480 | 0 | none |

With the patch, a window that a simultaneous pair opened commits normally: both drop 1, one adds 2 more, both accept, "Trade Completed", and the purses move by 2.

### Not addressed

A commit and an add at once can still deadlock, read from the source and not reproduced here: the second `AcceptTrade` holds the window lock and `CloseTrade` then wants both players' monitors, while `ReceiveTradeItem`/`ReceiveTradeMoney` holds the source's monitor and wants the window lock. That is a separate order (window → monitor against monitor → window) and is left for another change.

---

## Our side

- Branch `daoc-sdk` of [gartmeier/OpenDAoC-Core](https://github.com/gartmeier/OpenDAoC-Core) merges `fix/trade-open-race` (2988668e4) and extends the README notice ([core-daoc-sdk-readme-notice-trade.patch](core-daoc-sdk-readme-notice-trade.patch), on top of [core-daoc-sdk-readme-notice.patch](core-daoc-sdk-readme-notice.patch)). `server/core` pins ac64bb207. Neither branch is pushed: until it is, these patches are the only copy outside this checkout's submodule.
  - To rebuild the branch elsewhere: from f0aaa1ea2, `git am` the stale-skills patch on `fix/usable-skills-stale-specs` and this one on `fix/trade-open-race`; then on `daoc-sdk`, merge the two branches and `git am` the two README patches in order.
- Still to do, the user's call: push the branches, open the upstream PR.
- The shared gameserver runs the fix only once `daoc-sdk-gameserver:latest` is rebuilt (`docker compose -f server/docker/docker-compose.yml build gameserver`) and the gameserver recreated, which kicks every bot: in a stop window.
- Until then, and on any server without the fix, the SDK's clock slots in `bot.trade`/`bot.offerTrade` (learnings/trading.md) keep two opening adds 250 ms apart. They cost up to 750 ms per trade and can stay: a server with the fix doesn't need them, and one without does.
