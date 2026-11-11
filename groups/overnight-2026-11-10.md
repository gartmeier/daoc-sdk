# Overnight brief, 2026-11-10 to 11-11: the bench

The user's phase 2 starts with a bench. Each realm has 8 characters. Every arena round, each fighting group plays 5 of them, and the rest sit out at their portal keep. Humans in the group are set aside. So are 8-man groups, solo and stealth play, and the director. The aim is better bot-versus-bot play when the roster isn't fixed.

The plan is in the answer of the session that prepared this (2026-11-10 evening). Its short form:
1. **Bench (tonight):** rotate line-ups in the arena, record them, and learn which classes matter.
2. **Field mode (later):** all three realms roam at once with no end time, and a wiped group swaps bench members at its keep.
3. **Two groups per realm (later):** six groups, about 36 bots, and the load measurement.

Read first: `CLAUDE.md`, `docs/thidranki-population-handover.md` ("Lessons that cost us rounds"), the end of `groups/arena-ledger.md`, and the memory notes on the arena and message limits.

## The rosters

| Realm (group) | Members on 2026-11-10 | Bench, new on 2026-11-10 |
|---|---|---|
| Albion (`camelot`) | Galahad Paladin, Nimue Cleric, Merlin Sorcerer, Morgana Cabalist, Taliesin Theurgist | Gawain Armsman (Polearm hybrid), Tuck Friar (Group support), Vivien Wizard (Ice) |
| Hibernia (`hibernia`) | Cuchulainn Hero, Brigid Druid, Oisin Bard, Niamh Mentalist, Ciaran Enchanter | Fionn Blademaster (Group damage with Slam), Aine Warden (Support), Lugh Eldritch (Light nuker) |
| Midgard (`midgard`) | Thorgrim Warrior, Sigrid Healer, Ulfgar Shaman, Bragi Skald, Hrafna Spiritmaster | Ragnar Berserker (Left Axe, Hammer, high Parry), Sigurd Thane (Even hybrid with Parry), Gudrun Runemaster (Darkness nuker) |

How the bench was set up:
- Created with `create-bot`, then promoted by GM (`bots/gmlevel/promote.ts`: `/player class`, `/player level 24`).
- Relogged, then `/xp off` and `trainBuild` (`bots/gmlevel/bench-setup.ts`). All nine are on target for level 24.
- None has a `character.ts` yet, so each plays its generic role from `roleForClass`:
  - tank: Gawain, Sigurd
  - melee: Fionn, Ragnar
  - healer: Tuck, Aine
  - nuker: Vivien, Lugh, Gudrun

- Gear: all nine wear the gear template at every cap. The kits are in `sdk/group/gear-template.ts` (79023eb).
- Thidranki: all nine went in by `battleground.ts` (portal keep, bind, medallion) and stand at their realm's arrival point. Gmlevel is back at PrivLevel 1.
- Not done yet: the bench is still in its starter guilds (Clan Cotswold, Mularn Protectors, ...). Joining the realm guilds (Crimson Order, Wolves of Tir na Nog, Ravens of Jordheim; the leaders are Galahad, Cuchulainn and Thorgrim) and the guild dye is a quiet-moment task.

## How line-ups rotate

The code is in 5ab0980: `sdk/group/lineup.ts`, `loadGroup`'s bench and `--lineup`, and the gateway accepting a bench. The private `groups/arena.ts` uses it.
- **Before each round,** each fighting group with a bench gets a line-up from `pickLineup`.
  - It fills a healer, a front-liner and a mezzer first, each with whoever has played fewest rounds, then the rest by fewest played. On a tie the current member stays.
  - It counts only bots in game in region 252.
  - `writeLineup` rewrites `group.json` atomically, and bots that drop out `/disband`.
- **The ledger** has a Lineups cell at the end of each row, and rounds played are counted from it. `--fixed` turns rotation off.
- **Name rules replaced:**
  - Hibernia: `protect: 'Enchanter'`. The shared `guard` behaviour now matches a class.
  - Midgard: `trainCc` takes the Healer-class member as its mezzer.
  - Midgard: `stayBehind` steps behind the member with the healer role.
- **Still keyed by bot name:** per-bot `memberBehaviors` in the strategies (ciaran, sigrid, ulfgar, hrafna). A substitute in that slot plays its role's generic list.
- **One healer is enough for the picker.** A Warden counts as a healer, so a line-up can have Aine as its only healer. Pass a stricter need if a realm wants two.

**Live test, 2026-11-10 evening:**
- Round 120 (Hibernia vs Albion, cap) kept the old fives. With no history and every tie keeping the current members, nobody swapped.
- Round 121 put Fionn, Aine and Lugh in for Oisin, Niamh and Ciaran. Group forming worked: all three were invited and joined, and the group travelled.
- But the gateway refused Hibernia's publish with HTTP 409 "roster mismatch". **The gateway was running from a worktree, whose `groups/` still had the old `group.json`.** The gateway reads `groups/` from its own working directory and from its repo (`gateway/gateway.ts` roots).
  - So rotation needs the gateway started from main: `bun gateway/gateway.ts` in `C:\Users\joshu\Code\daoc-sdk`, or `DAOC_GROUPS_DIR` pointed at main's `groups/`.
  - Clients reconnect to a restarted gateway by themselves.
  - Without that, a swapped group runs unpublished, and both wind-down and the wipe check miss it. Round 121 ran to its own end (9 min, Midgard on the reports: 4/0 against 4/4).
- Hibernia's `group.json` now holds the round-121 line-up (cuchulainn, brigid, fionn, aine, lugh). That is what the next rotation starts from.

**Verified later, 2026-11-10 20:27:**
- The gateway is now started from main. One swarm runs all 24 clients, and all reached Thidranki.
- Both rounds ran with every group published and no 409.
- **Round 122:** Midgard (thorgrim, sigrid, ragnar, sigurd, gudrun) wiped Camelot (galahad, merlin, gawain, tuck, vivien), 6/0.
- **Round 123:** Hibernia (fionn, aine, lugh, oisin, niamh) wiped Midgard (ragnar, sigurd, gudrun, ulfgar, bragi), 5/0.
- Lessons for the group and class sessions:
  - Line-ups with three bench bots without kits lost both rounds without a kill: Camelot in 122, Midgard in 123.
  - The kits for the new classes come first.
  - Midgard's 123 line-up had no Healer-class mezzer for `trainCc`.
- **When the member who leads sits out, the first bot in the line-up leads.** In round 123 that was Ragnar for Midgard and Fionn for Hibernia.
- **The Eldritch counts as cc.** It does have a mez at 24 (the Paralyzing line).
- **What is running:** nothing. At 20:58 all 24 clients were quit cleanly (swarm exit 0), and the gateway was stopped. The arena is stopped after round 123.
- **To start the night,** from main (`C:\Users\joshu\Code\daoc-sdk`):
  1. Start the gateway: `bun gateway/gateway.ts`.
  2. Start the 24-client swarm (below).
  3. Run `bun groups/arena.ts --resume`. Round 124 is Hibernia against Camelot.
- Start them in the coordinator's own session. A background process dies with the session that started it.

## Tonight's milestone and layout (decided 2026-11-10 ~21:30, replaces the 8-session table below)

**Milestone, "any 5 of 8":** by morning all nine new classes have a kit and a guide, no strategy names a bot (the `memberBehaviors` keyed by ciaran, sigrid, ulfgar, hrafna go by class or role), and line-ups with two or more new classes win about a third of their rounds over 40 or more rounds.

**Five sessions, all in main's checkout (no worktrees):** class and group work merge into one session per realm.

| Session | Owns | Commits |
|---|---|---|
| **Coordinator** | gateway, swarm, `groups/arena.ts`, the ledger, shared `sdk/group` (incl. `lineup.ts`), this file | shared fixes, `git commit -- <paths>` |
| **Albion** | `sdk/classes/{armsman,friar,wizard}.ts` (+ tests), `learnings/classes/{armsman,friar,wizard}.md`, the old Albion kits and guides, `groups/camelot/`, the members' `bots/<bot>/character.ts` | its own sdk/learnings paths |
| **Hibernia** | the same for Blademaster, Warden, Eldritch and `groups/hibernia/` | its own sdk/learnings paths |
| **Midgard** | the same for Berserker, Thane, Runemaster and `groups/midgard/` | its own sdk/learnings paths |
| **Roaming** | `sdk/group/pack.ts` travel formation, `sdk/group/rvr.ts` travel legs and patrol, walking, `sdk/group/runner.ts` and the observer for runs with no end time | its own paths |

- Realm sessions: kits first. Research each new class at 24 with a subagent per class (`bun data/class-sheet.ts <class>`, `data/builds/<class>.ts`, the bot's `build.ts`), keep the conclusions, write kit + test + guide. Then the strategy for any 5 of 8.
- Shared `sdk/group` files outside your list: tell the coordinator, don't edit.
- Report to the coordinator only on a landed kit, a breakage, or a need. One message per event, no acks.
- **Stay awake on your own.** A session whose turn ends with nothing running sleeps until someone messages it, and the coordinator can send only 10 messages per user turn. Before ending a turn, start a background watcher that ends when your realm's next round is in the ledger, e.g. `n=$(grep -c '^| [0-9]' groups/arena-ledger.md); until [ $(grep -c '^| [0-9]' groups/arena-ledger.md) -gt $n ] && tail -1 groups/arena-ledger.md | grep -q <group>; do sleep 30; done` (run_in_background). Its exit wakes you.

**Kit timeline (for the with/without split):** rounds 122-125 ran the bench classes without kits. All nine kits were committed by 21:22 (Albion 61ab5cd, 6d16fa1, f2ce89a; Hibernia 409024e, c489fa9, 59b2f7e; Midgard 199ba8f), so every round from 126 on has them. Line-up picker: only a single-target mezz counts as cc (50c844b). Cross-realm import: `sdk/classes/eldritch.ts` uses `onlyLines` from `sdk/classes/runemaster.ts`.

**Grouping bug, rounds 126-127 (Hibernia):** members who came off the bench never joined the in-game group: Aine in 126, Lugh and Oisin in 127. The line-up's leader sat in a group another member led, so every invite was refused ("You are not the leader of your group"). The user spotted it: only the Bard had speed. Fixed in 732b768 (`formGroup` leaves such a group first). Treat those rounds' numbers for those bots as solo play. `arena.ts` loads `lineup.ts` once at start, so 50c844b went live only after the arena restart that follows round 128.

**Later shared fixes:** `group.json` `requires.classes` (881f449; Hibernia requires Druid and Bard, live from round 129). Pack focus no longer flips between a free fighter and a mezzed back-liner under `focusSoft` (4d60249, Hibernia and Midgard), live from the round after 21:55. Two tanks: a refused Guard or Protect ("already guarding") moves to the next back-liner (7a7a1db). Required classes: Camelot Sorcerer; Midgard Healer and Warrior or Thane (any-of lists, 8739d3c; arena restarted at 22:09). Pack stalk stalemate (two packs ~1700 apart until the cap, rounds 125 and 132): a stalled stalk closes in on a direct anchor (9a63d40, from round 135).

## Sessions and who owns what (2026-11-10 evening draft, superseded above)

The user starts the coordinator thread, and the coordinator starts the others. Keep the 2026-11-09 split; it worked.

| Session | Owns | Commits |
|---|---|---|
| **Coordinator** (one) | `groups/arena.ts`, the ledger, the clients, everything in `sdk/group` not owned below, and `sdk/group/lineup.ts` | Shared fixes to local main, `git commit -- <paths>` |
| **Group, one per realm** (3) | `groups/<g>/` (strategy, rvr.ts, plan, lab_log) and the members' `bots/<bot>/character.ts` | Nothing (private files) |
| **Class kits, one per realm** (3) | that realm's `sdk/classes/<class>.ts` and `learnings/classes/<class>.md` | Their own paths to local main |
| **Roaming and other** (one) | walking, travel, water, `sdk/group/rvr.ts` travel legs and patrol, `sdk/group/pack.ts` formation while travelling | Its own paths to local main, through the coordinator's import check |

What each session works on tonight:
- **Group sessions:** the strategy must work for any 5 of its 8. Work by role and `classGuess`, never by bot name or roster.
  - The three name rules were replaced on 2026-11-10 (Hibernia's `protect: 'Ciaran'`, Midgard's `trainCc` mezzer and `stayBehind` mate).
  - Use `Orders.settings` presets by the group's own make-up as well as the enemy's: a two-tank line-up wants other settings than a three-caster one.
  - Read the ledger's Lineups column. Which line-ups win, and which of our members die first?
- **Class sessions:** the three new classes of the realm come first. Each gets a kit (`sdk/classes/<class>.ts` plus `bots/<bot>/character.ts`) and a guide (`learnings/classes/<class>.md`), the way the 15 were built: research the class at 24 (styles, spells, what the build reaches), then test in rounds.
  - Albion: Armsman, Friar, Wizard
  - Hibernia: Blademaster, Warden, Eldritch
  - Midgard: Berserker, Thane, Runemaster

  Next comes what the old 15 still have open (`learnings/classes/*.md`).
- **Roaming session:** pending item 8 in the memory notes first. Groups stop every ~7 s while travelling, because the slot walk brakes at each anchor jump; the fix idea is to aim past the slot along the leg, like the column's lead.
  - Then field-mode prep that doesn't run live yet: runs with no end time and with bounded logs and fight lists (`sdk/group/runner.ts`, the observer).
  - Test stepped walks the way members really walk them (memory note "Member moves walk in steps").

## Rules that cost rounds before

- **Shared code goes live at the next round.** Land a multi-step edit in one write: edit a scratch copy, then `cp` it over. Run the import check (`bun --eval "await import('./groups/<g>/rvr.ts')"`) before the next round can load it.
- **`groups/<g>/.editing`** holds that group's next round while a session edits. Remove it when done. The arena removes a lock older than 20 minutes.
- **Client code needs a swarm restart.** Changes under `client/` take effect only after the clients restart, between rounds: stop the arena, quit with `swarm-check --quit`, start the swarm, resume. Never kill a client.
- **The message cap.** At most 10 messages to other sessions per user turn. Don't acknowledge reports. Put shared facts in this file or the lab_logs.
- **Pushing.** Nothing is pushed. Commit to local main only.

## Running it

Every bot of a realm must be in Thidranki with a client: members and bench, 24 bots.

```bash
bun client/swarm.ts galahad nimue merlin morgana taliesin gawain tuck vivien cuchulainn brigid oisin niamh ciaran fionn aine lugh thorgrim sigrid ulfgar bragi hrafna ragnar sigurd gudrun
bun groups/arena.ts --resume          # rotation is on whenever group.json has a bench; --fixed turns it off
touch groups/arena.stop               # ends after the current round
```

This is the first time 24 clients run in one swarm (15 before). If event-loop lag shows (link-dead, freezes), split into two swarms, one per pair of realms.

## Morning report

Append it to this file under "## Morning report": the rounds played, wins by realm, wins by line-up and by class (with and without), what each session changed, what broke, and what is open.

### Summary (coordinator, 2026-11-11 09:00)

**Milestone: met.**
- **Kits and guides:** all nine new classes have a kit (`sdk/classes/`), a test and a guide (`learnings/classes/`), all live from round 126.
- **Line-ups with 2+ new classes:** 51 wins in 110 such line-ups since the kits (46 %). Each realm is above a third over 30-40 of them (table below).
- **No strategy names a bot:** true for every RvR round. camelot/rvr.ts and hibernia/rvr.ts key their lists by class, midgard/rvr.ts by role, and camelot's `any-five.test.ts` checks it. The PvE `strategy.ts` files used by `hunt.ts` keyed five lists by bot name until the morning (camelot `taliesin`, `merlin`; midgard `bragi`, `hrafna`, `ulfgar`); at the user's go-ahead they now go by class (Theurgist, Sorcerer; Skald, Spiritmaster, Shaman), and the same bots get the same lists (checked by loading both, group tests pass). `groups/` is private, so this is not committed.

**Rounds:** 1-226 in the ledger. Tonight's rounds were 122-226; 122-125 had the bench classes without kits, so 126-226 (101 rounds, 18 ended at the 10-minute cap) is "with kits". Code and strategy were frozen from round 211 to the end (16 rounds) so the last stretch measures one version. Wins below count a cap won on kills as a win, as the ledger marks it.

| Realm | All rounds | 2+ new classes | 0-1 new class | Frozen 211-226 |
|---|---|---|---|---|
| Hibernia | 46 / 74 (62 %) | 21 / 30 (70 %) | 25 / 44 (57 %) | 4 / 10 |
| Midgard | 30 / 65 (46 %) | 14 / 40 (35 %) | 16 / 25 (64 %) | 8 / 12 |
| Camelot | 25 / 63 (40 %) | 16 / 40 (40 %) | 9 / 23 (39 %) | 4 / 10 |

Without kits (122-125, 4 rounds), line-ups with 2+ new classes won 3 of 7: too few to compare with.

**By bot** (share of its rounds won since 126, the realm's own average in brackets):
- **Hibernia (62 %):** Lugh, Eldritch 73 %, Ciaran, Enchanter 70 %, Fionn, Blademaster 68 % lead. Aine, Warden 55 %, Cuchulainn, Hero 55 % and Niamh, Mentalist 54 % trail. Brigid and Oisin (Druid, Bard) are required, so they read as the average.
- **Midgard (46 %):** Bragi, Skald 62 % stands out; the rest are 39-47 % (Sigurd, Thane 46 %, Ragnar, Berserker 43 %, Gudrun, Runemaster 41 %, Ulfgar, Shaman lowest at 39 %).
- **Camelot (40 %):** Morgana, Cabalist 48 %, Vivien, Wizard 44 %, Tuck, Friar 42 %, Gawain, Armsman 41 %; Nimue, Cleric lowest at 32 %.

**By line-up** (57 different ones, most played 2-11 times, so patterns more than a ranking):
- Best: Hibernia Lugh, Ciaran, Cuchulainn, Brigid, Oisin 7/8 and Lugh, Niamh, Fionn, Brigid, Oisin 8/11; Midgard all three new with Bragi and Sigrid 4/4; Camelot Gawain, Tuck, Merlin, Morgana, Taliesin 4/6 (with Vivien in Taliesin's place 3/3).
- Worst: Hibernia two healers with one nuker (Aine, Cuchulainn, Niamh, Brigid, Oisin) 1/9; Midgard without the Skald (Gudrun, Ragnar, Thorgrim, Ulfgar, Sigrid) 0/5; Camelot Gawain, Merlin, Taliesin, Vivien, Nimue 1/6.
- Counted from `groups/arena-ledger.md` (the Lineups column, rounds 126-226).

**Shared fixes by the coordinator** (`sdk/group`, each with a test, each from a realm session's report):
- Line-ups (`lineup.ts`, `arena.ts`, `group.json`): only a single-target mezz makes a mezzer (50c844b); `requires.classes` and any-of lists (881f449, 8739d3c: Hibernia Druid + Bard by the user's rule, Camelot Sorcerer, Midgard Healer, Warrior or Thane, Skald or Berserker); mixing by rounds played together (c18dd85); a nuker need (d5fd6f0); `limits` per role (d67f1d2, Camelot one healer, one tank).
- Grouping: a leader inside someone else's group leaves it first (732b768). Rounds 126-127 had bench members playing ungrouped (the user spotted it: only the Bard had speed).
- Fights: focus no longer flaps onto a mezzed back-liner (4d60249); a second tank refused on a member guards the next (7a7a1db); pack stalk stalemate closes in (9a63d40, 0b205fd); a melee swing refused at the bank marks the focus wet (feb811e); a formation slot in the river holds the bank (e85da2c); "can't see your target" twice leaves the focus 8 s (2e93829); a slot across the river is reached by crossing (6beb4f5, with Roaming's dc8a2d3).

**What broke during the night:** the grouping bug (126-127); a Blademaster test file that didn't parse (7b759bc, fixed in 5163836); the Mentalist's and Eldritch's stun had been the 3 s Prismatic Flare since 2026-11-09, not the 5 s Flash (6cf6f96). Arena, gateway and swarm ran all night; the arena was restarted on purpose several times to load picker changes, and stopped itself after round 226.

**Open, across sessions:**
- River fights: dc8a2d3 and 6beb4f5 are live from round 212. Hibernia won 212 with no fight time in water; not measured over more rounds yet.
- Idle in fights: casters "focus out of reach" (Lugh 64 % in 178, Merlin and Vivien a quarter of 217), Hibernia's tank "focus beyond the chase leash" (6-48 %), healers idle 40-50 % in Camelot.
- Power: Camelot's Taliesin and Vivien ran dry late in long fights (26-30 % idle in 214); Hibernia's two-healer line-ups run Niamh and Brigid dry.
- Midgard has one cure against Hibernia's three mezzers; whether the Thane should stand behind the Warrior.
- Line of sight over hills still costs casts ("not visible" 10-17 a member in some rounds).
- Field mode (`seconds: Infinity`) is prepared but not run live; the viewer would show "0:00 left" (gateway `num()`).

Each realm's own report, with its make-up findings: `groups/camelot/lab_log.md` ("Albion, for the morning report"), `groups/hibernia/lab_log.md` ("Morning report, Hibernia"), `groups/midgard/lab_log.md` ("Morning report, Midgard session" and "Final numbers, Midgard"). Roaming's is below.

### Roaming (travel and field mode)

**Groups no longer stop at every travel leg** (38041dc, live from 21:27).
- **Cause.** A leg counts as reached once everyone is within 1200 of it. Camelot's deepest slot stood ~1150 behind the anchor, so the leg moved on only as the last member arrived. The others had already braked to rest at their slots.
- **Fix.** A leg's anchor now carries `onward`. While travelling, members aim 400 past their slots that way. A walk cut off by the next leg keeps running (walkTo `stopOnAbort`). The trip's last leg, gather legs, stand-offs and fights are as before.
- **Measured** at 4 Hz with an observe-only sampler (scripts in the shared notes folder, roaming-travel-sampler/): 6 rounds before against 16 after, leaving out each round's first 2 minutes. A stop is a member moving under 30 units in 0.75 s.

| | Before | After |
|---|---|---|
| Stops at a leg jump, all realms, per member-minute | 0.59 | 0.21 |
| Camelot (deep formation) | 3.0 | 0.5 |
| Hibernia | 0.45 | 0.37 |
| Midgard | 0.12 | 0.06 |
| Patrol speed, members' mean | 188 u/s | 217 u/s |
| Long waits in patrol, per member-minute | 0.84 | 0.28 |

What is left:
- **Laggards.** A member that stops to cast in travel (Oisin's Clear Road, Merlin's round-start Perception of Power pass, Morgana's pet) holds the leg. The others wait at their lead points. The leg rule (everyone within 1200) is unchanged.
- **Waypoints by water.** A waypoint leg that the dry-bank rule moved off the waypoint gets no `onward`, so the group brakes there once per waypoint.

**Field-mode prep** (43983c6). It is off by default: every arena round runs as before.
- `runGroup` takes `seconds: Infinity` (no end time) and `RunBounds`. With no end time the defaults are the last 200 fights, 500 values per median, and 2000-4000 log lines in memory, the rest written to runs/<stamp>.log as the run goes.
- The observer folds older fights into running totals. They come out the same as unbounded (tested).
- **Fixed on the way:** `runScript` treated `timeout: Infinity` as 1 ms, because setTimeout fires at once on Infinity.
- **Open, gateway (coordinator):** `num()` in gateway/groups.ts turns the Infinity deadline into 0, so the viewer would show "0:00 left" for a field run.
- **Open, group scripts:** a group's rvr.ts passes `seconds` straight through, so `bun groups/<g>/rvr.ts Infinity` should start a field run. It has not been run live.

**Stuck walks at the river in fights** (dc8a2d3, from the Hibernia session's report on rounds 139 and 172).
- **Cause.** The stayDry guard cut a fight walk at the bank, but the walk kept aiming at the river spot. The mover stopped up to its tolerance (60-80) short of the bank spot. Each re-issue "arrived" at once, and after 8 in about 2 s the walk failed as `stuck`, not `water`, so noteWet and slotWet never fired. Ciaran had 12 of these in one fight in round 139; Brigid had 5 in round 172.
- **Fix.** `sendMoveTo` reports where the guard held a move (`heldAt`), and a walk that stops there ends with reason `water`.
- **Together with the coordinator's 6beb4f5:** a slot across the river is now reached by crossing. Only a slot in the river itself holds at the bank.
- Not yet measured: they landed at 07:13 and 07:20, so they apply to rounds started after 07:20. In those rounds, look for `walk:stuck` with "last stop: arrived" (should be gone) and for Hibernia's water time in fights. Round 172 was 22-24%; Albion's was 0%.
