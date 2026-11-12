# Handover: Living Thidranki, humans and bots in one battleground

This handover is for a fresh session that picks up the work after the three-realm RvR arena (2026-11-09 and 2026-11-10). The goal: humans play in Thidranki together with bots that fill every gap, from solos to a zerg at the Faste.

The plan is a Claude Doc: [Living Thidranki: humans and bots in one battleground](https://claude.ai/artifact/SehSwg1Qwnin3upWutksXB). It holds the goal, the research with sources, the design, the roadmap with its gates, where the project stands, the risks and the open questions. The user comments and decides there, so read it first and treat it as the source for all of those. Until the user answers an open question, build nothing that depends on it.

This file holds only what a session needs and the doc doesn't: what the arena left behind, the lessons it cost, the scaling constraints and where to start.

Read these first:
- the doc above
- `CLAUDE.md`
- `learnings/group-coordination.md`, including its "Group tactics" section
- `learnings/rvr.md`, including the class reads and human vision sections
- the closing summary at the end of `groups/arena-ledger.md`, which is private and not in git

## Where it stands (2026-11-12 evening)

- **The phase 2 gate passed at rehearsal size.** 30 bots, 10 per realm, played 4 h unattended in field mode (`groups/field.ts`, private). Every realm fought as a group of 5, as a duo or trio, and as solos.
- **The full record:** `groups/night-2026-11-11.md` (the stint's brief, report and the afternoon's runs) and `groups/day-2026-11-11.md` (field mode, group size, the trade fix, the observed member).
- **New since this handover was written:**
  - small squads (`sdk/group/squad.ts`, `learnings/squads.md`);
  - six stealther and archer characters, with stealth in the client and SDK (`learnings/classes/`);
  - a skill setting (`sdk/group/skill.ts`);
  - human vision as the default for every group run, with in-fight attention;
  - observer measures for fight quality, flapping and engages without a hit.
- **The user's ideas for the next stint,** both on a per-realm director:
  - a realm call for help;
  - taking the Faste together (gather everyone, one raid).
- **Open question raised on 2026-11-12: is 150 the right population for this map?**
  - Thidranki is about 36k × 26k units, and the middle is about a minute's run from a keep.
  - At 30 bots, groups already fight 12-14 times an hour, and most battles are three-way.
  - The suggestion is to grow in steps (30, 45, 60) and stop where the small-man play gets crowded out, with zergs coming in as raid events. The user hasn't decided.

## Numbers, per realm

Each realm has its own director, so the population numbers are per realm (proposed in the doc on 2026-11-10):
- Target about 50 bots per realm in the field, about 150 in all. Floor about 10 per realm.
- Squad mix: 2 solos, a duo, a trio, two groups of 5 to 8, and a zerg when one is due. Without the zerg that is 15 to 23 bots; with a zerg of 20 to 40, about 35 to 60.
- The phase 2 gate runs 30 bots, 10 per realm: solo, small-man and group fights, no zerg yet.

No source gave Thidranki's historical headcount, so these are design numbers, not history.

## What exists now

**Class reads.** Every enemy player contact carries `Contact.classGuess`: its likely classes, their weights, and a role.
- It is read the way a human reads an enemy: race, gear models (packet 0x15), spell visual effects (0x1B/0x7E ClientEffect) and combat styles (0xBC).
- It never uses names, rosters or server truth. The server hides an enemy's class on examine (`GamePlayer.GetExamineMessages`), and enemy names show only as their race.
- In rounds 104-119 it read 159 of 161 enemies right, most of them within 10 s.
- Details are in `learnings/rvr.md`. The code is in `client/model` (decoding) and `sdk/group/class-read.ts` (scoring against truth: `class-score.ts`).

**Human vision and line of sight** (29dbc98).
- The client answers the server's line-of-sight checks from the terrain heightmap (`client/session.ts` `losClear`), so hills block casts, pet attacks and aggro. `DAOC_LOS=clear`, or no terrain, answers clear as before.
- A member with human vision (`--vision=human`, or `agent.vision` in a strategy, code in `sdk/vision.ts`) reports an enemy only within 500, or in a 100° cone with a clear sight line, after 800 ms in view.
- There is no wider skill setting (reaction delay, target switching, mistakes) yet.
- Arena rounds 120-143 ran with it; see `learnings/rvr.md`.

**Group tactics library**, `sdk/group/tactics/` (3480017). It is built like the class kits:
- A shared, tested module holds each tactic. A group's `strategy.ts` or `rvr.ts` only chooses and tunes them.
- There are four tactics: focus by enemy role, no focus thrash (dwell and hold), peeling a diver off the back line, and adapting to the enemy's make-up.
- Options name roles and compositions, never realms or opponents.
- `settings.tactics` switches any tactic off per run, for A/B tests.
- It was extracted with no behaviour change, proven by equivalence tests. It has not been played in a live round yet.
- `learnings/group-coordination.md` "Group tactics" lists the variants to unify later and sketches composition playbooks.

**`Orders.settings`** (2bcf4c6). A coordinator's decide can switch members' settings mid-run, such as formation, heal limits or ccFlank. Hibernia's `withMakeUp` uses it to choose between caster-heavy and melee-heavy presets once the enemy's make-up has been read.

**Class kits**, `sdk/classes/<class>.ts`. There are 15 kits: the arena's five classes per realm. Each has a guide in `learnings/classes/<class>.md` that lists what is proven and what is open. Classes without a kit fall back to the generic role behaviours.

**Arena runner**, `groups/arena.ts` (private). It runs winner-stays rounds between two realms while the third waits.
- The ledger is `groups/arena-ledger.md`.
- A wipe is every member seen dead within 6 s. A round with no wipe is judged on the reports at the 600 s cap. A losing group that wasn't wiped goes home.
- Stop it with `touch groups/arena.stop`, which ends it after the current round. Resume it with `bun groups/arena.ts --resume`.
- It is built for exactly three groups of five. The director replaces it for population play.

**The 15 characters.**
- Albion (`camelot`): Galahad Paladin, Nimue Cleric, Merlin Sorcerer, Morgana Cabalist, Taliesin Theurgist.
- Hibernia: Cuchulainn Hero, Brigid Druid, Oisin Bard, Niamh Mentalist, Ciaran Enchanter.
- Midgard: Thorgrim Warrior, Sigrid Healer, Ulfgar Shaman, Bragi Skald, Hrafna Spiritmaster.
- All are level 24, set by a GM, with XP turned off: a member above 24 is moved out of Thidranki at its next logout.
- Characters are created with `bun bots/create-bot.ts`. A GM can set level and gear with `groups/<g>/gear-template.ts` (see the memory note on the GM account).

**Arena result.** 116 valid rounds to round 119: Hibernia won 50, Midgard 34 and Albion 32. The groups ended up countering each other's last change, a sign that three fixed rosters can't teach the tactics much more.

## Lessons that cost us rounds

- **Shared code goes live at once.** Rounds import `sdk/` from main's working tree when they start.
  - A dry-move guard went in untested and kept two groups stuck at the river bank for a whole round, so rounds 72-73 were void.
  - Rules: test the stepped walk the way members actually walk it. Land an edit to a shared file in one write (edit a scratch copy, then cp it over). Run the import check before a round can load the change.
- **Roster knowledge creeps in.** With fixed opponents, sessions wrote rules like "their one Dwarf is the healer". Rules like that break with any other roster, and with humans in the field they break at once. Target by `classGuess` role and adapt by make-up.
- **Session ownership worked.**
  - Each realm session owned only its `groups/<g>/` and `bots/<bot>/` files.
  - Each class session owned its `sdk/classes/*` files and class guides.
  - One orchestrator owned the rest of `sdk/group` and committed shared fixes.
  - Sessions committed only their own paths, with `git commit -- <paths>`.
- **The message limit.** The app pauses a session's outgoing messages to other sessions after 10 without a message from the user. Don't acknowledge reports, send one message per event, and put shared facts in a file the sessions already read.
- **Client code needs a swarm restart.** Changes under `client/` take effect only after the clients restart.
  - Restart between rounds: stop the arena, quit every client with `bun client/dev/swarm-check.ts <bots...> --seconds=0 --quit`, start `bun client/swarm.ts <bots...>`, then resume.
  - Never kill a client: an abrupt kill causes a 60 s link-dead lockout.
- **Winner-stays gave decisive, fast data,** about 6 minutes a round with 77 % ending in wipes. But it measures three fixed groups against each other, not general skill, and not how a group feels to a human.

## Scaling constraints

These are known or suspected. They matter from phase 2 on; none has been tested beyond 15 bots.

- **Clients.** 15 bots ran in one `client/swarm.ts` process without trouble. CPU, memory and event-loop latency per swarm are unmeasured. A bot freezes and goes link-dead after about 5 s without position updates, so event-loop health is the first thing to watch.
- **Gateway.** One gateway carries all the bots' state and control traffic. Its throughput at scale is unmeasured. It allows 32 members per group (`MAX_MEMBERS` in `gateway/groups.ts`).
- **Game server.** OpenDAoC runs in Docker. Its tick and CPU load with many players in one zone are unmeasured. Two trade-window adds in one tick hang the whole server (see CLAUDE.md); phase 1 fixes this in the server.
- **Creating characters.** Names are unique and letters-only. Accounts must not be GM accounts, because mobs ignore GMs. New characters start as their base class (`start_as_base_class` defaults on). `trainBuild` may stop with "No training observed" on fresh characters; this is unchecked and would block training many new characters.
- **Gear and level.** Bots need level 24 (XP off) and gear at that level's caps. Gear templates exist for 15 classes and are put on by a GM bot. The login script in phase 1 is meant to do this for humans and new bots alike.
- **Class coverage.** Some classes can't be created at all: Valkyrie, Bainshee, Heretic, Warlock, Vampiir and the Maulers (see CLAUDE.md).
- **Navmeshes and terrain** are needed for walking and for line of sight. They are built into `server/navmesh`, and the arena walked Thidranki on them.

## Next steps

1. **Phase 0 alongside the user's 5v5 work.** Make the size-dependent settings shares of the group (`minPack: 3` and `closeCount: 3` in `sdk/group/pack.ts`, the retreat `margin: 3` in `sdk/group/rvr.ts`, one tank), and add fight-quality measures to the observer report. Coordinate with whoever owns the 5v5 setup before touching `sdk/group/pack.ts` or `rvr.ts`.
2. **First live round of the tactics library**, so a regression can't hide inside later work.
3. **Phase 1 groundwork that doesn't touch the 5v5 files:** the login script on the server and the trade-freeze fix. Line of sight is done (29dbc98).
4. **No load test until the user asks.** Scale is measured in phase 2.
