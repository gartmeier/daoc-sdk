# Night brief, 2026-11-12 19:30 to 11-13 10:30 (15 h): 60 bots, the realm calls for help, then takes the Faste

**Decided by the user (18:50):** overnight, 15 h, 60 bots, so 20 per realm. **(19:00):** the 9 classes without a kit get kits tonight (R7, R8), and the thirty include them.

The last stint passed the **phase 2 gate** at rehearsal size: 30 bots, 10 per realm, 4 h unattended, with solo, small-man and group fights in every realm (`groups/night-2026-11-11.md`, "Morning report"). Load at 30 was light: swarm ~20 % CPU, lag ≤ 6 ms.

This stint doubles the field and builds the first **realm director** on top of field mode, with the two ideas the user noted at 12:30 on 11-12:
- **A call for help.** A unit under attack asks its realm's other units, and the nearby ones come.
- **Taking the Faste.** The same call for everyone: muster at a rally point, then go in together. This is the plan doc's phase 4 started small, with one realm's 20 bots as one raid.

Both use only what that realm's bots see, with one director per realm.

Read first: `CLAUDE.md`, `docs/thidranki-population-handover.md` ("Lessons that cost us rounds", "Scaling constraints"), and the night brief's "For the next stint", "Morning report" and the sections after the check run. The plan doc is [Living Thidranki](https://claude.ai/artifact/SehSwg1Qwnin3upWutksXB). Its open questions are still unanswered, and nothing here depends on them.

## Milestone for the night

1. **60 bots in Thidranki.** Thirty new characters: the 9 classes with no kit yet, and 21 more of the healer, support and group classes. All at level 24 with XP off, trained, in template gear at the caps, bound at the portal keep.
1. **Every creatable class has a kit.** Mercenary, Minstrel, Necromancer, Reaver, Animist, Champion, Valewalker, Bonedancer, Savage: each with tests, a guide in `learnings/classes/`, and a live check. A kit not solid by 04:30 puts its class on the bench for the frozen window. It never holds up the help calls or the Faste.
2. **Two main groups per realm.** Per realm: two groups of 6, a trio, a duo and two solos (19), with one on the bench. Each Hibernian group fields a Druid and a Bard, and every group has a healer.
3. **The realm board and director exist.** Per realm, one process gathers what each unit's members saw (contacts, losses, where it stands) and posts calls. Offline tests cover it, and it runs live in field mode.
4. **Help comes.** A unit outnumbered or caught posts a call. The units nearby answer if they are free and the way is short. The ledger shows calls, answers and arrival times, and how fights with help ended against fights without.
5. **The Faste.** A survey of what stands there on this server, then one realm's 20 muster, go in and kill the lord. Ownership is read live afterwards, and the owner's units defend it when it is attacked.
6. **Load at 60, measured.** Swarm, gateway and gameserver CPU, memory and event-loop lag. This is the plan doc's phase 2 item "how many bots one machine carries".
7. **The frozen window.** 4 h with everything on, no shared edits and no manual restart. The Faste changes hands at least twice, bots only.

## Sessions and who owns what

All sessions work in main's checkout. Commit only your own paths with `git commit -- <paths>`. Nothing is pushed.

| # | Session | Owns | Done when |
|---|---|---|---|
| R1 | **Coordinator** (this session) | gateway, swarm, `groups/field.ts` (two main groups per realm), `sdk/group/lineup.ts`, the ledger, observer measures for calls and raids, group.json benches, this file; merges | runs A and B, the Faste probe, the frozen window, morning report |
| R2 | **Realm director** | new `sdk/group/director.ts` and `realm-board.ts` (+ tests): the board, the calls, the muster; a `calls()` read for units, like squads' `friends()` | offline tests green by 22:30; live in run B |
| R3 | **Group play** | `sdk/group/rvr.ts`, `behaviors.ts`, `pack.ts`, `tactics/`, the realm `groups/<g>/` strategies and the new second groups' | main groups answer calls, rally and go in as the raid's core |
| R4 | **Squads** | `sdk/group/squad.ts`, `squad-run.ts`, `size.ts` below 5 | squads answer calls (or don't, by their odds); the carry-overs below |
| R5 | **The Faste** | `sdk/group/keeps.ts`, new `sdk/group/siege.ts`, `learnings/rvr.md` "The Faste" | the survey by 22:30; ownership read live; a raid plan (route, rally point, order: guards, door, lord) |
| R6 | **Thirty new characters** | the 30 new `bots/<bot>/` (bot.env, build.ts, character.ts), `bots/gmlevel` setup, gear templates for the 9 new classes, `learnings/` notes on what creating them taught | the 9 new-class characters ready by 21:00 (for R7 and R8); all 30 in Thidranki at 24 in template gear by 22:30, clients quit cleanly |
| R7 | **Melee and song kits** | new `sdk/classes/{mercenary,reaver,savage,champion,valewalker,minstrel}.ts` (+ tests), their guides, and the 6 new bots' `character.ts` once R6 hands them over | each kit tested offline, checked live on its character, and in that bot's character.ts |
| R8 | **Pet kits** | new `sdk/classes/{necromancer,bonedancer,animist}.ts` (+ tests), their guides, and the 3 new bots' `character.ts` once R6 hands them over; pet changes in `sdk/group/pets.ts` only by agreement with R3 | the same; the Necromancer's shade in a group (heals, positioning, the pet as its body) is the risky part |

**The thirty (R6):** the 9 new classes, plus two of each healer and support class per realm, so each realm fields two groups with a healer each, and each Hibernian group a Druid and a Bard. No second stealther or archer: the mix has two solo slots per realm, and the six we have fill them.
- Albion: **Mercenary, Minstrel, Necromancer, Reaver**, Cleric, Friar, Paladin, Armsman, Sorcerer, Wizard.
- Hibernia: **Animist, Champion, Valewalker**, Druid, Bard, Hero, Blademaster, Mentalist, Enchanter, Eldritch.
- Midgard: **Bonedancer, Savage**, Healer, Shaman, Skald, Warrior, Thane, Berserker, Runemaster, Spiritmaster.
- The 9 new classes come first, ready by 21:00, so R7 and R8 can check their kits live. R6 writes their character.ts on the generic routine, then hands each to R7 or R8 and notes it here.
- A Champion starts as a Guardian: check it has armour (CLAUDE.md "A Guardian ... dies to level-1 mobs").
- Names: letters only, unique, at most 12, in each realm's own style, as the first thirty. Normal accounts, never GM.
- The way N5 made six on 11-11: `bun bots/create-bot.ts` with a build, first login, GM level and `/xp off` through `bots/gmlevel`, promote, `trainBuild`, the gear template, bind at the portal keep. The handover warns `trainBuild` may stop with "No training observed" on fresh characters: note it if it does.
- R6 runs its own clients for the thirty and quits them cleanly before 22:30. **R6 leaves group.json alone:** R1 adds the thirty to the benches in the 22:30 window.

**Overlaps:**
- R2 defines the call interface and stays out of `rvr.ts` and `squad.ts`. R3 and R4 each wire it into their own files.
- R5's raid plan is data and pure functions in `siege.ts`. R3 calls it from `rvr.ts`, and R5 doesn't edit `rvr.ts`.
- Today `keeps.ts` makes every unit avoid the keep circles. R5 changes that only for a raid, behind a setting that is off by default.
- R7 and R8 check kits live on their own clients before 22:30. After 22:30 the bots are in the 60-bot swarm and field mode: a kit change goes live at that unit's next sortie, and the sortie logs are the live check. Never take control of a bot in field mode (it aborts its unit's run).
- R7 and R8 give each new class's role (tank, healer, support, caster, melee, pet) to R1 in this file, for `lineup.ts`.
- R1's second main group per realm: R1 makes `groups/<realm>-2/` from the realm's group (field.ts and lineup), and R3 owns its strategy from then on.

**Carry-overs, each with its session:**
- **R3:** count enemies seen in the last 30 s while retreating (human vision drops the pursuers out of sight), and stop the hunt from walking back to a group we just fled.
- **R4:** squads died fleeing 14 times in the commit-fix hour, against 7 in the 4 h freeze. Hibernia's solos lost 30 of 41. The assassins hardly fight, because `sizeUp` gives a stealth opener no worth. Scathach's failed Perforate Artery (13:08 on 11-12) wasn't looked into.
- **R1:** run A is the first live run of everything that landed after 15:17 on 11-12: the friendly-group join, the road-out rule, poisons, the intercept, Nightshade Magic, the bow-duel fix, the hidden retreat, Hodur's way back. R1 lists what each did.

## Timeline

- **19:30-22:30 Build.**
  - **Run A (R1), 30 bots,** on current main: `bun groups/field.ts --swarm-log=<log> -- --skill=average`, human vision. It gives the without-help numbers and the live check of the carry-overs.
  - R2-R4 build and test offline. R5 surveys: the server source, the DB, and one careful walk with a single bot (guards attack enemy players within 1000).
  - R6 creates the thirty, the 9 new classes first (by 21:00).
  - R7 and R8 write kits offline, then check them live on the new characters from 21:00.
  - R1 builds two main groups per realm into field.ts and lineup.ts, with the mix `6,6,3,2,1,1`.
- **22:30-23:00 First stop window (R1).**
  1. `touch groups/field.stop`, wait for field.ts to end.
  2. Quit the 30 clients with swarm-check `--quit`.
  3. Add the thirty to the benches.
  4. Start the swarm with all 60. If one swarm's event loop lags over 50 ms, split it into two swarms of 30.
  5. Start run B.
- **23:00-02:00 Run B, 60 bots, help calls.** The director is on or off by 20-minute slot per realm, as the skill A/B ran. Pass: most calls answered, help in time for at least half of the fights it answered, and flaps no higher than run A's. Load sampled all along.
- **02:00-04:30 The Faste probe (R1 with R3 and R5),** field mode stopped. One realm's 20 muster and attack while the other two stand at home; then the next realm takes it back. Fixes go in between attempts.
- **04:30-06:00 Integration.** Fixes from run B and the probe land, then one hour of field mode with raids on, to check before the freeze. A swarm restart only if `client/` changed.
- **06:00-10:00 The frozen window.** Everything on, raids on a rhythm by each director. No shared edits, no manual restart.
- **10:00-10:30 Morning report** (below).

## Rules (still in force)
- Shared code goes live at the next sortie: one write, then the import check. `groups/<g>/.editing` holds a group's next sortie while you edit.
- Client code needs a swarm restart, in a stop window. Never kill a client: quit with swarm-check `--quit`.
- At most 10 messages to other sessions per user turn. No acks. Shared facts go in this file.
- No roster knowledge: read enemies by `classGuess` and make-up.
- `rvr.ts --help` starts a real run: read the script to check a flag.
- The machine stays awake: R1 runs the stay-awake script. The 11-11/12 night lost 9 h to a Windows update restart, so the user pauses updates before 19:30.

## The user's call (still open, not needed tonight)
- Pushing: local main is 24 commits ahead of origin.
- The plan doc's open questions. Who holds the Faste after a capture is left to the server: the captor holds it, my pick in the doc.

## Morning report

Append it here:
- **The thirty:** made, and what creating them taught.
- **The nine kits:** what each does, what was seen live, which played the frozen window.
- **Load at 60:** per process, and what one machine carries.
- **Help calls:** calls, answers, arrival times, fights with and without help.
- **The Faste:** the survey, each capture, losses, how long it took.
- **The frozen window:** passed or not, and why.
- **Carry-overs:** what each did live.
- **What broke and what is open.**
