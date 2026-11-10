# Handover: populating Thidranki with ~150 bots

This is a handover from the orchestrator session that ran the three-realm RvR arena on 2026-11-09 and 2026-11-10. It is written for a fresh session that picks up the next step, called item 13 in the orchestrator's notes.

Read these first:
- `CLAUDE.md`
- `learnings/group-coordination.md`, including its "Group tactics" section
- `learnings/rvr.md`, including the class reads section
- the closing summary at the end of `groups/arena-ledger.md`, which is private and not in git

## Goal

Thidranki (region 252, levels 20-24) should be populated with about 150 bots playing the way people do:
- solos, duos and trios
- 8v8 groups
- zergs

That means rotating players and mixed pickup groups, not three fixed rosters. Per-group experiments must stay possible. A group should still be able to try its own tactics on top of the shared ones.

## What exists now

**Class reads.** Every enemy player contact carries `Contact.classGuess`: its likely classes, their weights, and a role.
- It is read the way a human reads an enemy: race, gear models (packet 0x15), spell visual effects (0x1B/0x7E ClientEffect) and combat styles (0xBC).
- It never uses names, rosters or server truth. The server hides an enemy's class on examine (`GamePlayer.GetExamineMessages`), and enemy names show only as their race.
- In rounds 104-119 it read 159 of 161 enemies right, most of them within 10 s.
- Details are in `learnings/rvr.md`. The code is in `client/model` (decoding) and `sdk/group/class-read.ts` (scoring against truth: `class-score.ts`).

**Group tactics library**, `sdk/group/tactics/` (3480017). It is built like the class kits:
- A shared, tested module holds each tactic. A group's `strategy.ts` or `rvr.ts` only chooses and tunes them.
- There are four tactics:
  - focus by enemy role
  - no focus thrash (dwell and hold)
  - peeling a diver off the back line
  - adapting to the enemy's make-up
- Options name roles and compositions, never realms or opponents.
- `settings.tactics` switches any tactic off per run, for A/B tests.
- It was extracted with no behaviour change, proven by equivalence tests. It has not been played in a live round yet.
- `learnings/group-coordination.md` "Group tactics" lists the variants to unify later (step 2) and sketches composition playbooks.

**`Orders.settings`** (2bcf4c6). A coordinator's decide can switch members' settings mid-run, such as formation, heal limits or ccFlank.
- Hibernia's `withMakeUp` uses it to choose between caster-heavy and melee-heavy presets once the enemy's make-up has been read.

**Class kits**, `sdk/classes/<class>.ts`. There are 15 kits: the arena's five classes per realm.
- Each has a guide in `learnings/classes/<class>.md` that lists what is proven and what is open.
- Classes without a kit fall back to the generic role behaviours.

**Arena runner**, `groups/arena.ts` (private). It runs winner-stays rounds between two realms while the third waits.
- The ledger is `groups/arena-ledger.md`.
- A wipe is every member seen dead within 6 s. A round with no wipe is judged on the reports at the 600 s cap.
- A losing group that wasn't wiped goes home.
- Stop it with `touch groups/arena.stop`, which ends it after the current round. Resume it with `bun groups/arena.ts --resume`.
- It is built for exactly three groups of five. Population play needs a different scheduler (see the open questions).

**The 15 characters.**
- Albion (`camelot`): Galahad Paladin, Nimue Cleric, Merlin Sorcerer, Morgana Cabalist, Taliesin Theurgist.
- Hibernia: Cuchulainn Hero, Brigid Druid, Oisin Bard, Niamh Mentalist, Ciaran Enchanter.
- Midgard: Thorgrim Warrior, Sigrid Healer, Ulfgar Shaman, Bragi Skald, Hrafna Spiritmaster.
- All are level 24, set by a GM, with XP turned off: a member above 24 is moved out of Thidranki at its next logout.
- Characters are created with `bun bots/create-bot.ts`. A GM can set level and gear with `groups/<g>/gear-template.ts` (see the memory note on the GM account).

**Arena result.** 116 valid rounds: Hibernia won 50, Midgard 34 and Albion 32.
- The groups ended up countering each other's last change.
- That is a sign that three fixed rosters can't teach the tactics much more.

## Lessons that cost us rounds

- **Shared code goes live at once.** Rounds import `sdk/` from main's working tree when they start.
  - A dry-move guard went in untested and kept two groups stuck at the river bank for a whole round, so rounds 72-73 were void.
  - Rules: test the stepped walk the way members actually walk it. Land an edit to a shared file in one write (edit a scratch copy, then cp it over). Run the import check before a round can load the change.
- **Roster knowledge creeps in.** With fixed opponents, sessions wrote rules like "their one Dwarf is the healer". Rules like that break with any other roster. Target by `classGuess` role and adapt by make-up.
- **Session ownership worked.**
  - Each realm session owned only its `groups/<g>/` and `bots/<bot>/` files.
  - Each class session owned its `sdk/classes/*` files and class guides.
  - One orchestrator owned the rest of `sdk/group` and committed shared fixes.
  - Sessions committed only their own paths, with `git commit -- <paths>`.
- **The message limit.** The app pauses a session's outgoing messages to other sessions after 10 without a message from the user.
  - Don't acknowledge reports, and send one message per event.
  - Put shared facts in a file the sessions already read.
- **Client code needs a swarm restart.** Changes under `client/` take effect only after the clients restart.
  - Restart between rounds: stop the arena, quit every client with `bun client/dev/swarm-check.ts <bots...> --seconds=0 --quit`, start `bun client/swarm.ts <bots...>`, then resume.
  - Never kill a client: an abrupt kill causes a 60 s link-dead lockout.
- **Winner-stays gave decisive, fast data,** about 6 minutes a round with 77 % ending in wipes. But it measures three fixed groups against each other, not general skill.

## Scaling constraints

These are known or suspected. None has been tested at 150.

- **Clients.** 15 bots ran in one `client/swarm.ts` process without trouble. 150 bots means about 10 such swarms, or a few larger ones. CPU, memory and event-loop latency per swarm are unmeasured.
  - A bot freezes and goes link-dead after about 5 s without position updates. That makes event-loop health the first thing to watch.
- **Gateway.** One gateway carries all the bots' state and control traffic. Its throughput at 150 bots is unmeasured.
- **Game server.** OpenDAoC runs in Docker. Its tick and CPU load with 150 players in one zone are unmeasured.
  - There is a known deadlock: two trade-window adds in one tick hang the whole server (see CLAUDE.md).
- **Creating characters.** Names are unique and letters-only. Accounts must not be GM accounts, because mobs ignore GMs.
  - Pending item 3: `trainBuild` may stop with "No training observed" on fresh characters. This is unchecked, and it blocks training a hundred new characters. Check it first.
- **Gear and level.** Characters need level 24 (GM-set, XP off) and gear at that level's caps (`gear-template.ts`, by a GM). Both have to be scriptable in bulk.
- **Class coverage.** There are kits for 15 classes. A population needs every class that can be created at 20-24, and many have none yet.
  - Some classes can't be created at all, such as Valkyrie, Bainshee, Heretic, Warlock, Vampiir and the Maulers (see CLAUDE.md).
- **Navmeshes and terrain** are needed for walking. They are built into `server/navmesh` (90 files there; the arena walked Thidranki on them).

## Open design questions

Settle these before writing much code.

1. **Roster pool and rotation.** How many characters per realm and class? How are groups drawn per session or round, and do benched characters rest or log out?
2. **Activity types and matchmaking.**
   - Solos and duos roam and pick fights.
   - 8v8 groups form, roam and fight each other.
   - Zergs gather around keeps or the portal keep.
   - Does a scheduler decide who meets whom, or does open-world roaming produce meetings by itself? The arena forced two-realm fights. A population should meet more naturally, but with enough fights to learn from.
3. **Composition playbooks.** Picked from a group's own make-up (melee train, caster burn, balanced), with the enemy's make-up adjusting them through `Orders.settings`. The sketch is in `learnings/group-coordination.md`. Solos and duos may need their own small playbooks, such as kite, stick or flee.
4. **Measuring "good" without a winner-stays ledger.**
   - Possible measures: kills and deaths per group and per composition, realm points, fight win rate by size bracket, and time to first fight.
   - The observer reports per run already. A population needs aggregation across many groups.
5. **Ownership at scale.** One session per realm doesn't scale to dozens of groups. More likely: one session for the population runner and scheduler, one per playbook or class family, and the orchestrator for shared `sdk/group`.

## Suggested first steps

1. **Check `trainBuild` on a fresh character** (pending item 3). Fix it, or rule it out.
2. **Scaling smoke test.** Create about 30 throwaway characters across the realms, level and gear them by GM, and run them in two or three swarms in Thidranki doing simple roaming.
   - Measure client event-loop lag, gateway load, server tick and CPU, and link-dead events.
   - Use the throwaway stack (`bun run server:throwaway up`) if the shared server must stay clean.
3. **First live round of the tactics library** with the existing 15 bots, so a regression can't hide inside the scaling work.
4. **Then design the scheduler and roster pool** (questions 1 and 2), and start composition playbooks (question 3) on top of `sdk/group/tactics`.
