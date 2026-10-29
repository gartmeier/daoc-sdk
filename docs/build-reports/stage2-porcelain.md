# Build

## bot.* report: BotActions, helpers, path providers, unit tests and live harness

`BotActions` (bot.*) is built and every method the task lists works live against the local OpenDAoC server, apart from killing a mob with spells alone (gap 1). A fresh level-1 Albion Fighter walked, talked to its trainer, killed a spirit hound for XP, rested, sold loot to a merchant, and ground for 3 minutes (14 kills, +238 xp, level 1→3, 0 deaths, 0 failures). Unit tests: `bun test ./sdk` passes 116/116. `bunx tsc --noEmit` is clean, and `sdk/API.md` is regenerated (48 BotActions methods; `docs:api:check` passes). Nothing committed.

### Files (all under `C:/Users/joshu/Code/daoc-sdk/`)
- `sdk/actions.ts`: `BotActions`, all `*Options`/`*Result` types, `castFailureReason()`. It re-exports `conLevel`, `conColor`, `isKillable`, the path-provider API, and the types `NpcTarget`, `ObjectTarget`, `PlayerTarget`, `Point` and `ConColor`.
- `sdk/actions-helpers.ts`:
  - refusal phrase lists per action, taken from `language/EN/*.txt` and `SpellHandler.cs`;
  - `conLevel()`, a port of `ConLevelGrid.cs`;
  - `isKillable()`, `diffInventory()`, `experienceFromMessages()`;
  - `MessageWatch`, which collects messages by id after a baseline so the 100-message window can't hide a refusal;
  - `ActionHelpers`: `waitFor`, `nextState`, `sleep`, target resolvers, `attackers`.
- `sdk/pathfinding.ts`:
  - the `PathProvider` interface;
  - `StraightLinePathProvider`: splits legs at 1000 units; z comes from data `estimateZ`, with an interpolation fallback for intermediate points;
  - `NavmeshPathProvider`: a stub that always fails (TODO);
  - `get/setDefaultPathProvider`.
- `sdk/test/actions.test.ts`: 50 tests against a simulated world behind a stubbed `BotSDK`.
- `sdk/test/actions-helpers.test.ts`: 13 tests.
- `sdk/test/live/`:
  - `harness.ts`: in-process gateway + `DaocClient` + `BotSDK` + `BotActions`; it releases if dead and quits cleanly.
  - `actions-live.ts <acct> [steps]`, `cast-live.ts <acct> [Class] [Race]`, `misc-live.ts <acctA> <acctB>`.
- `sdk/API.md`: regenerated.

### Public API (`bot.*`)
- **Movement:** `walkTo(x, y, {z, tolerance=64, timeout, pathProvider, speedFactor, stuckMs=8000})`, `walkToObject(t, {range=100})`, `followPath(points)`, `stop()`, `face(obj | point | heading)`, `follow(player, {distance, durationMs, until})`, `travelTo(pattern | point)`, `findNpcSpawn(pattern)`.
  - `walkTo` re-issues the move after a server correction or stop, and fails with reason `died`, `region_changed`, `stuck`, `timeout`, `bad_args` or `no_path`.
- **Targeting and dialog:** `target(t)` (also takes our own objectId), `interactWith(t, {range=150})`, `talkTo(npc)`, `whisper(npc, keyword)`, `navigateDialog(npc, [string | RegExp])`, `respondToDialog(accept)`.
  - `interactWith`'s response is one of `merchant`, `dialog`, `dialogBox`, `textWindow`, `trainer` or `message`.
  - `talkTo` returns `NpcDialog` plus keywords merged from every `"<npc> says"` line.
- **Combat:**
  - `attack(npc)`.
  - `killNpc(t, {timeout=60s, styles, useStyle, chase=true, maxChaseDistance, force})` returns `xpGained`, `rpGained`, `moneyGained`, `itemsGained`, `durationMs`, `levelsGained` and `stylesUsed`.
  - `castSpell(spell, target?, {range, approach})` returns `completed`, `damage`, `resisted` and `castTimeMs`. Failure reasons: `no_power`, `must_wait` and `interrupted` (both with `retryAfterMs`), `out_of_range`, `not_visible`, `no_target`, `invalid_target`, `cooldown`. Self-target spells don't approach the target; Realm/Group spells default to targeting ourselves.
  - `useStyle`, `useAbility`, `findKillableNpc(s)({pattern, minCon=-2, maxCon=0, maxLevelDiff, minLevelDiff, radius, from, exclude})`, `isInCombat()`, `getAttackers()`, `getSpellInfo()`.
- **Loot and recovery:** `lootNearby({radius=500})`, `rest({healthPercent=90, manaPercent, endurancePercent})` (sits, then stands; fails with `attacked` or `in_combat`), `waitForHealth`, `releaseAndRespawn()`, `isDead()`.
- **Items:** `equipItem` and `unequipItem` (both move the item through server paper-doll slot 100), `dropItem`, `destroyItem`, `useItem`, `findInventoryItem`, `freeBackpackSlots`.
- **Merchants and trainers:** `openMerchant`, `closeMerchant`, `buyItem(m, pattern | {page, slot}, count)`, `sellItem`, `sellItems(m, predicate | pattern)`, `trainSpec(trainer, spec, levels)` (trainer window first, `/train` as fallback).
- **Social:** `say`, `send` (retries once on "Slow down"), `groupSay`, `invite`, `acceptGroupInvite`.
- **Grinding:** `grind({pattern, con/level window, radius=2000, anchor, restBelowHealth=50, restToHealth=90, restBelowMana, durationMs=180s, maxKills, loot, respawn, styles, onKill})`.

### Verified live vs unit-only
- **Live (fresh accounts):** every method listed above, except the items in the next bullet.
  - Movement, dialog and combat: walkTo there and back (0 corrections), followPath, stop, face, talkTo + whisper (the trainer gave an item), killNpc, findKillableNpc, the 3-minute grind.
  - castSpell with an Elementalist: a self buff, plus a direct-damage nuke for 1–4 damage. With an Acolyte (Cleric): a heal through the `useSkill` path for hybrid spells.
  - releaseAndRespawn after a caster died.
  - Loot, items and shops: lootNearby (picked a dropped item back up; autoloot normally takes the drops), rest 89%→100% in 18 s, equip/unequip/drop/destroy/useItem, openMerchant across several merchants, buy 20 bolts for 19c, sell, sellItems, an insufficient-funds refusal, trainSpec Crush 1→2.
  - Social: say/send (to a real player and to an unknown one), invite, acceptGroupInvite, groupSay, follow, useAbility(Sprint), travelTo and findNpcSpawn.
- **Unit-only:**
  - styles: the base Fighter has no styles at levels 1–3;
  - respondToDialog called directly;
  - walkTo correction re-issue, stuck and timeout paths (no correction happened live);
  - the grind respawn path;
  - abort propagation.

### Learnings for learnings/*.md
- **Start areas:** a Fighter starts at Prydwen Keep (region 1, about 574797,530161,2896). Its trainer Master Graent and the merchants are within 100–500 units. Spirit hounds (level 0, blue) are about 2400 away at z≈2179. Mage/Elementalist characters start near 564138,513825, beside puny skeletons (level 1).
- **XP and money:** at level 1 a spirit hound gives "You get 17 experience points. (2 camp bonus)" with xp_rate 3. A kill takes about 5–20 s, plus walking. Autoloot: "You pick up N copper." and "You get a X and put it in your backpack."
- **Kill sequence:** "The X dies!" (type otherDeath) arrives, then the XP and loot messages within about 0.5 s.
- **Merchants:** they sell back at 50% (bought for 19c, sold for 9c). Refusals read "X isn't interested in the practice sword." (zero-value items) and "costs…" (my own insufficient-funds check).
- **Approach ranges that work:**
  - melee: within 90 units 3D, adopting the target's z; re-approach above 118;
  - interact: within 150;
  - pickup: within 150 on the ground plane;
  - whisper: within 300.
- **Message texts:**
  - spells: "You begin casting a X spell!", "You cast a X spell!", "You hit the Y for N (-1) damage!";
  - interruption: "The Y attacks you and your spell is interrupted!", followed by "You must wait 2 seconds to cast a spell!";
  - heal with no target: "You must select a target for this spell!";
  - a heal cast on an enemy gets **no reply at all**.
- **Casters:** a level-1 caster in melee range is interrupted on every swing and can't finish a mob without kiting.
- **Trainer:** its reply comes as three separate say lines, each with one [keyword]. "You receive the X from Master Graent!" is the evidence for a whisper.
- **Quit, death and release:**
  - After recent combat, quit takes about 60 s even with `disable_quit_timer` ("You will quit after sitting for 59 seconds"); right after login it is instant.
  - Death sends "You will now release automatically in 8 more seconds!", so the server may auto-release before `/release`.
- **OpenDAoC has no `/follow` or `/stick`,** so `follow()` runs client-side.

### Gaps
1. A caster can't spell-kill a mob in melee range: there's no kiting helper.
2. Styles are untested live.
3. There is no navmesh. The straight-line route ignores walls; the server doesn't check them.
4. Message phrases are English-only.

### Client fixes needed (I did not edit client/)
1. **Merchant window id** (`client/model/world-model.ts:487`): pages arriving within 1 s of the previous window are merged into it, and it keeps the old `merchantObjectId`. Opening a second merchant right after a first one then looks like the wrong shop. My workaround: `openMerchant` calls `closeMerchant` first. The model should reset when the target changes.
2. **NPC dialog** (`npcDialog`): only the last line is kept, so earlier [keywords] are lost. The bot layer merges the messages itself.

### Notes for other modules
- **Live tests:** use `sdk/test/live/harness.ts`, or the new `client/runner.ts`. I did not exercise `runScript` with the real runner.
- **Event loop:** a synchronous wait loop in the SDK (my bug, now fixed) starves the in-process client. Any helper that waits must use `helpers.nextState()`/`sleep`, never a `waitFor` whose check returns the state it is given.
- **Accounts I created** (PrivLevel 1, password `<name>pw`): `act1`–`act5` (Fighter), `cast1`–`cast3` (Mage), `cast4` (Cleric, which the server creates as an Acolyte), `cast5`–`cast6` (Elementalist), `misca1`, `miscb1`, `misca2`, `miscb2`.

# Review

I found and fixed 8 real bugs in the bot.* porcelain. Each has a regression test, and I re-ran the affected behaviour live on fresh accounts. `bun test ./sdk` passes 124/124 (was 116), `tsc --noEmit` is clean, and `sdk/API.md` is regenerated with `docs:api:check` passing. Nothing is committed.

### Bugs fixed (all paths under `C:/Users/joshu/Code/daoc-sdk/`)

1. **False `stuck` on detours** (`sdk/actions.ts:1794`, helper `routeLength`). `route()` measured progress as straight-line distance to the destination. A `followPath` whose first legs lead away from the end point failed as `stuck` after `stuckMs`. Progress is now the remaining route length (from the mover's waypoints), reset after a correction re-plan (:1813).
2. **Cleanup never ran after a cancel** (`sdk/actions-helpers.ts:389` new `ActionHelpers.cleanup`; used at `actions.ts:737-739`, 1115, 1539, 1825-1829). After an MCP cancel or runScript timeout, every cleanup dispatch was rejected immediately by the aborted signal. The bot kept walking, kept swinging and chasing, or stayed sitting. Cleanup now runs via `executionContext.exit`, and `walkTo` stops the mover on cancel. `killNpc` now also stops a chase after a timeout or abort.
3. **`rest()` claimed it sat down without evidence** (`actions.ts:1083`). `DaocClient` sets `isSitting` as soon as it sends the request, so a refused sit counted as success. It now waits for the server's "You sit down" / "already sitting" or a refusal message, and uses `isSitting` only as a fallback.
4. **`grind()` missed auto-released deaths** (`actions.ts:1588`). It counted deaths only from `isDead`. A death the server auto-released while the bot was looting, resting or in `onKill` went unnoticed, so with `respawn: false` it carried on grinding from the bind point. It now uses `deathCount`, and tolerates `not_dead` from `releaseAndRespawn`.
5. **`groupSay()` false failure** (`actions.ts:1459`). It returned `not_grouped` on a stale local group list. My first live run failed exactly this way: the inviter's group list trailed the accept. It now waits up to 1.5 s, then trusts the server's answer ("You are not part of a group" gives `not_grouped`, "Slow down!" gives `rate_limited`).
6. **`talkTo()` returned an old conversation's keywords** (`actions.ts:578`) when the NPC answered with a trainer window or a bare message. It now ignores dialog older than the interact.
7. **`walkTo` to where the bot already stands** (`actions.ts:1744`) returned success while an earlier move carried it away. It now stops first.
8. **`useItem(RegExp)`** (`actions.ts:1213`) never fell back to equipped items.

Also fixed in the live harness (`sdk/test/live/harness.ts:85`, :114): a bot that got in game but failed on the SDK side was never quit, which triggers the 60 s lockout. The new `startLiveBots()` quits the bots already started if a later one fails; `misc-live.ts` uses it.

### Tests added (`sdk/test/actions.test.ts`)
- The fake `sendAction` now refuses to dispatch after an abort, like the real one. Without that, the abort tests could not see the bug.
- New tests cover:
  - a detour longer than `stuckMs`;
  - a cancel during `walkTo`, `killNpc` and `rest`;
  - a refused sit;
  - a death that was auto-released during `onKill`;
  - `groupSay` with a lagging or stale group list;
  - `talkTo` with a stale dialog;
  - already-there while moving;
  - `useItem` by RegExp.
- The fake sit handler now emits "You sit down."
- With the old code, 8 of the new tests fail (temporarily reverted); the rest are trivially red on the old code.

### Live verification (all quit cleanly, no lockouts)
- **Before my changes:** `actions-live.ts rev1` (walk, talk, kill, loot, rest) passed.
- **New `sdk/test/live/review-live.ts rev2`:** 7/7 passed.
  - A 700-unit detour with `stuckMs` 2000 arrives.
  - Cancelling a walk leaves the bot moved 0 units after the cancel.
  - Cancelling a kill leaves attack off and the bot not moving; the mob was then killed normally.
  - Cancelling a rest gets "You stand up."
- **`misc-live.ts rev5 rev6`:** all 20 checks passed, including `groupSay`, which failed with rev3/rev4 before fix 5.
- **`actions-live.ts rev7 grind sell`:** a 60 s grind made 3 kills, 0 deaths, 0 failures, level 1→2; then a sale.
- **Not re-run live:** `castSpell`, since my changes don't touch it.

### Remaining gaps and notes for other modules
- **`client/` (not edited):**
  - The published `isSitting` is `self.isSitting || mv.sitting`, and `mv.sitting` is only cleared by `moveTo` or a stand. When the server stands the player up (attack, combat), the state still says sitting. `rest()`'s "keeps standing up" check can't fire, though attack detection covers the common case.
  - The `respondDialog` and `closeMerchant` actions update the model before any server answer, so `respondToDialog`'s "closed" check proves nothing. `acceptGroupInvite` still checks membership, so it is fine.
- **`castSpell`:** damage-add procs ("You hit X for N extra damage!") during melee could count as spell completion and damage.
- **`walkToObject`:** its `timeout` applies per attempt, up to 4 attempts.
- **Builder's gaps still open:** spell-only kills in melee range (no kiting), styles untested live, no navmesh, English-only phrase lists.
- **Accounts I created** (PrivLevel 1, password `<name>pw`): rev1–rev7, all Albion Fighters.