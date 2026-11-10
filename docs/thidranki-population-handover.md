# Handover: Living Thidranki, humans and bots in one battleground

This handover is for a fresh session that picks up the work after the three-realm RvR arena (2026-11-09 and 2026-11-10). It started as a plan to fill Thidranki with about 150 bots. A planning session on 2026-11-10 widened the goal: humans play in the battleground together with the bots.

The full plan is a Claude Doc: [Living Thidranki: humans and bots in one battleground](https://claude.ai/artifact/SehSwg1Qwnin3upWutksXB). It has the research with sources, the design, the roadmap, and the open questions the user still has to answer. This file is the short version, plus what a session needs from the arena. If the two disagree, the doc wins: the user comments and decides there.

Read these first:
- `CLAUDE.md`
- `learnings/group-coordination.md`, including its "Group tactics" section
- `learnings/rvr.md`, including the class reads section
- the closing summary at the end of `groups/arena-ledger.md`, which is private and not in git

## Goal

A player logs in, picks a realm and class, and stands at their portal keep in Thidranki (region 252) at level 24 in full gear. Within a few minutes they are in a fight that suits them. Nobody waits for a group, and no group lacks a healer, because bots fill every gap.

A player can:
- **play solo:** roam, duel, hunt other solos and stealthers.
- **join a group:** ask, and a bot group missing their role takes them in. A bot steps out to make room. The group either runs its own plan or follows the human.
- **build their own group:** humans and bots mixed however they like, up to 8.
- **join the zerg:** a realm gathers 20 to 40 players, human and bot, to take Thidranki Faste in the middle.

So the battleground runs every size at once: solos and duos at the edges, groups of 3 to 8 in the open, a zerg at the Faste. These are rotating players and mixed pickup groups, not three fixed rosters. Per-group experiments must stay possible: a group can still try its own tactics on top of the shared ones.

Proposed targets for "alive" (the user may change them):
- From the portal keep, a fight within about 3 minutes' walk, at any hour.
- No realm outnumbers another by more than about 1.5 to 1 for longer than 10 minutes.
- Realm chat carries calls ("6 mids at the north bridge", "Faste in 5").
- A mixed group plays like a good pickup group: heals land on the human, the mezz lands on the adds, bots follow the human's calls.
- Watching bots with a real client, a human can't easily tell them from players, or stops caring.

Out of scope: levelling, PvE, crafting, the other battlegrounds and the frontiers.

## What the research changed

Details and sources are in the doc. Three findings shaped the design:
- **Bots fill gaps and step aside for humans.** Battlefield 6 removes a bot each time a player joins. Vermintide 2's bots support so the player is the star, and a bot that takes what the player needs steals their fun.
- **Bots that pass as people are found out by how they move and react.** Unlimited reactions, perfect aim, long straight runs and getting stuck give them away. Human-like reaction is about 200 to 500 ms.
- **A busy battleground is paced, not constant.** Left 4 Dead's AI Director runs build-up, a short peak, then quiet.

## Design in short

One engine plays every size: today's group coordinator. A solo is a group of one, and a zerg is several groups under one leader.

- **A director per realm.** A long-running process owns that realm's bots. It sees only what its own realm's bots see, so it can't ghost.
  - Population: keeps a target number of bots in the field. It logs bots in and out from a bench at the portal keep, benches one bot for each human of its realm, and never drops below a floor.
  - Mix: a spread of squad sizes, for example 2 solos, a duo, a trio, two groups of 5 to 8, and a zerg when one is due.
  - Balance: pulls bots in or benches them so no realm runs away with the numbers.
  - Pacing: sends squads where its realm last saw enemies, weighted toward humans, in waves of build-up, fight and quiet.
  - Events: calls a Faste raid now and then in /region. Handles a human's "lfg".
- **Squads of every size.** Solo (1), small-man (2 to 3), group (5 to 8, thresholds scaled to size, more than one tank, guard pairs), zerg (a battlegroup with a zerg leader who picks one objective, route and rally point; each group keeps its own heals, CC and focus). All of one realm's squads run in one process. No squad has an end time: a wiped squad releases, rests and gets a new task.
- **Humans as observed members.** The coordinator learns a second kind of member. Its health, power and death come from the server's group window (packet 0x70, already decoded), its position from what nearby bots see. Bots heal, buff, rez and guard it first, leave it the kills, and count it in formation and in outnumbered checks.
  - Bot-led: the squad runs its plan and says what it does in group chat ("pulling back", "focus the healer").
  - Human-led: the anchor follows the human, the focus comes from the server's `/assist <name>`, and group-chat commands work at three levels: a stance (fight, guard, passive), a place (follow, stay, go, back) and a target (focus, mezz, rez).
  - Joining: the client's LFG flag, a whisper "lfg" to any bot of the realm, or "lfg" in /region. A human can also invite bots directly. Zerg: `/bg join`, calls in /bc and /region.
- **Fair and believable.** Bots answer the server's line-of-sight checks from the terrain heightmap instead of always "clear". A skill setting per bot (reaction delay, time to switch target, small mistakes, the odd grudge chase). Bots act only on their own and their squad's sight. Player-like names, a guild tag per squad, /region calls.
- **The Faste.** The server already makes it capturable: two main doors with 5,200 health, guards around level 27 to 30, a lord around 33. His death gives the keep to the killer's realm. The project adds ownership tracking, attack (a door, the guards, the lord) and defence (the owner's director pulls squads home).
- **Login.** A C# script loaded at server start runs on a new character's first entry: promote to the advanced class, level 24, a default build from `data/builds`, the class's gear template, placed and bound at the portal keep. A Battlemaster NPC at each portal keep handles respec, builds and gear.

## Roadmap

Five phases. Each ends when its gate passes, not on a date.

**Phase 0 · now: 5v5 group play.** The user is working on this in a 5v5 setup. Two choices here save rework later:
- Settings that depend on group size become shares of the group, not fixed numbers: `minPack: 3` and `closeCount: 3` in `sdk/group/pack.ts`, the retreat `margin: 3` in `sdk/group/rvr.ts`, one tank.
- The observer report measures more than winning: fight length, comebacks, groups wiped before they could react. A group that wins every fight in 20 s is a bad opponent for humans.
- Gate: a bot group plays like a decent human group, judged by the reports and by the user's eye in a real client.

**Phase 1 · a human in the group.**
- Observed members on the blackboard; bots heal, buff, rez and guard the human.
- Bot-led mode with group-chat calls, then human-led mode with /assist and a few commands.
- Honest line of sight from the terrain heightmap.
- The login script for the class the user plays.
- A normal (non-GM) account for the user, because mobs and bots treat a GM differently.
- The trade freeze fixed in the server.
- Gate: the user plays an hour in a group with four bots against a bot group, in both modes, and it feels like a good pickup group.

**Phase 2 · every size, no breaks.**
- Runs without an end time, with bounded logs.
- 8-man groups; solo and small-man behaviour; stealth, starting with Infiltrator, Nightshade and Shadowblade.
- More class kits, in order of how common each class was in Thidranki.
- The director per realm; a skill setting per bot.
- Measure how many bots one machine carries. This is where the load test belongs; the user does not want one before.
- Gate: 30 bots, 10 per realm, run 4 hours unattended, and the reports show solo, small-man and group fights.

**Phase 3 · friends night.**
- Remote login, with accounts made by the user rather than on first login.
- A gear template and default build for every class; the Battlemaster NPC.
- Asking for a group and inviting bots.
- A supervisor that restarts clients and directors, also after a server restart.
- Player-like names, guild tags, /region calls.
- Gate: three to five friends play an evening without the user's help, and each found fights and a group.

**Phase 4 · the zerg and the Faste.**
- The battlegroup layer with a zerg leader.
- Faste ownership read live; the owner defends.
- Siege; raids on a rhythm; humans join with `/bg join`.
- Enough bots for a zerg on each side, maybe on a second machine.
- Gate: in one evening, zergs of 20 or more with humans in them, and the Faste changes hands at least twice.

## Where the project stands

The 5v5 bot group is strong. Almost everything around it is missing. Gaps found in the code during planning:
- **Remote players can't connect.** `REGION_IP` is `127.0.0.1` in `server/docker/docker-compose.yml`. No ports are forwarded, and anyone who reaches the port can make an account.
- **Login doesn't hand out level, class or gear.** New characters start as their base class (`start_as_base_class` defaults on). Gear templates exist for 15 classes and are put on by a GM bot.
- **Runs end.** Every run has an end time, groups reset between rounds, and a long run's log and fight list grow without limit.
- **Tuned for 5.** Group files take any number of members and the gateway allows 32 (`MAX_MEMBERS` in `gateway/groups.ts`), but thresholds are fixed numbers and an 8-man has never run.
- **No zerg layer.** Each group plans alone in its own process; there is no shared plan or target.
- **The coordinator sees only bot members.** Bots never heal, buff, rez or guard a human, nothing reads chat commands, and `/assist` is unused.
- **No solo or stealth play.** About 30 classes have no kit.
- **The Faste.** The strategy only avoids keeps, and nothing tracks who owns one.
- **Fairness.** The client answers line-of-sight checks from the terrain heightmap (`client/session.ts` `losClear`), so hills block casts and aggro. Human vision (`--vision=human`, learnings/rvr.md) gives a view cone, terrain occlusion and an 800 ms notice delay. There is no wider skill setting yet.
- **Scale is unmeasured.** At most 15 bots have run at once.

Still unverified: Thidranki's historical peak headcount, whether a battleground keep can be claimed, whether rams work without the keep's hook points, and whether the Faste has walls in a real client (the client probably draws them from its own map data).

## What exists now

**Class reads.** Every enemy player contact carries `Contact.classGuess`: its likely classes, their weights, and a role.
- It is read the way a human reads an enemy: race, gear models (packet 0x15), spell visual effects (0x1B/0x7E ClientEffect) and combat styles (0xBC).
- It never uses names, rosters or server truth. The server hides an enemy's class on examine (`GamePlayer.GetExamineMessages`), and enemy names show only as their race.
- In rounds 104-119 it read 159 of 161 enemies right, most of them within 10 s.
- Details are in `learnings/rvr.md`. The code is in `client/model` (decoding) and `sdk/group/class-read.ts` (scoring against truth: `class-score.ts`).

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

**Arena result.** 116 valid rounds: Hibernia won 50, Midgard 34 and Albion 32. The groups ended up countering each other's last change, a sign that three fixed rosters can't teach the tactics much more.

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
- **Gateway.** One gateway carries all the bots' state and control traffic. Its throughput at scale is unmeasured.
- **Game server.** OpenDAoC runs in Docker. Its tick and CPU load with many players in one zone are unmeasured. Two trade-window adds in one tick hang the whole server (see CLAUDE.md); phase 1 fixes this in the server.
- **Creating characters.** Names are unique and letters-only. Accounts must not be GM accounts, because mobs ignore GMs. `trainBuild` may stop with "No training observed" on fresh characters; this is unchecked and would block training many new characters.
- **Gear and level.** Bots need level 24 (XP off) and gear at that level's caps. The login script in phase 1 is meant to do this for humans and new bots alike.
- **Class coverage.** Some classes can't be created at all: Valkyrie, Bainshee, Heretic, Warlock, Vampiir and the Maulers (see CLAUDE.md).
- **Navmeshes and terrain** are needed for walking and for honest line of sight. They are built into `server/navmesh`, and the arena walked Thidranki on them.

## Open questions for the user

The doc's last section has these with options and a proposed pick; the user's answers go in its "Your call" column. Until they answer, build nothing that depends on them.

| Question | Proposed pick |
|---|---|
| Who plays first, and how many? | The user in phase 1, 3 to 5 friends in phase 3; public only after phase 4, if at all |
| Are bots marked as bots? | A guild tag that says so. They should play like people, but hidden bots get found out and resented |
| Which mode comes first: bot-led or human-led? | Bot-led first (it needs only the observed member), human-led right after in the same phase |
| Which classes can humans pick? | Any class: templates and builds for humans are generated; bots stay on classes with kits |
| How are humans equipped? | The template at the caps, not scaling their own gear |
| Do realm points and ranks count? | Capped as on live (rank 1 level 4), and the lord's death announced in /region |
| Who holds the Faste after a capture? | The captor until the next capture |
| Where does it run? | This PC until phase 2 measures what one machine carries |
| What map do players get? | Their own realm only; the full map stays the user's |

The biggest risk is that humans don't enjoy playing with and against bots, which is why phase 1 comes before scale. Another: group-size work collides with the user's 5v5 work in `sdk/group`, which is why the size-proof settings come in phase 0, before other phases touch the same files.

## Next steps

1. **Phase 0 alongside the user's 5v5 work.** Make the size-dependent settings shares of the group, and add fight-quality measures to the observer report. Coordinate with whoever owns the 5v5 setup before touching `sdk/group/pack.ts` or `rvr.ts`.
2. **First live round of the tactics library**, so a regression can't hide inside later work.
3. **Phase 1 groundwork that doesn't touch the 5v5 files:** honest line of sight in `client/session.ts`, the login script on the server, and the trade-freeze fix.
4. **No load test until the user asks.** Scale is measured in phase 2.
