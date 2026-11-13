# Night brief, 2026-11-12 19:30 to 11-13 10:30 (15 h): 60 bots, the realm calls for help, then takes the Faste

**Decided by the user (18:50):** overnight, 15 h, 60 bots, so 20 per realm. **(19:00):** the 9 classes without a kit get kits tonight (R7, R8), and the thirty include them.

The last stint passed the **phase 2 gate** at rehearsal size: 30 bots, 10 per realm, 4 h unattended, with solo, small-man and group fights in every realm (`groups/night-2026-11-11.md`, "Morning report"). Load at 30 was light: swarm ~20 % CPU, lag ≤ 6 ms.

This stint doubles the field and builds the first **realm director** on top of field mode, with the two ideas the user noted at 12:30 on 11-12:
- **A call for help.** A unit under attack asks its realm's other units, and the nearby ones come.
- **Taking the Faste.** The same call for everyone: muster at a rally point, then go in together. This is the plan doc's phase 4 started small, with one realm's 20 bots as one raid.

Both use only what that realm's bots see, with one director per realm.

Read first: `CLAUDE.md`, `docs/thidranki-population-handover.md` ("Lessons that cost us rounds", "Scaling constraints"), and the night brief's "For the next stint", "Morning report" and the sections after the check run. The plan doc is [Living Thidranki](https://claude.ai/artifact/SehSwg1Qwnin3upWutksXB). Its open questions are still unanswered, and nothing here depends on them.

## Handover for the next stint (R1, 2026-11-13 11:30): read this first

The night in one line: 60 bots ran 12 h on one machine without a drop, and the director's help calls brought a friend 27 % of the time against 6 % without it. The Faste fell three times, but the frozen window failed its gate (1 change of hands of 2). Details: "Morning report" below; each session's section has its own findings.

**State now.**
- Nothing runs: field mode stopped at 10:31, all 60 clients quit with exit 0, and the gateway and the keep-awake script are stopped. The gameserver and DB stay up in Docker, at `starting_keep_level=1` (L28 guards, L33 lord).
- The Faste is **Midgard's** (captured 09:22:36), keep level 1.
- All 60 characters have `GainRP = 0` (Thidranki takes realm level < 10).
- origin/main is at d6ab2be (the walls merge). The 4 commits after it are local only.
- The wall occluders are built in `server/navmesh/*.occluders` (43 zones, gitignored). Every client started from now on answers line of sight with walls.

**How to start (the night's commands).**
```bash
bun gateway/gateway.ts > groups/stint-gateway.log 2>&1        # background
bun client/swarm.ts gawain morgana nimue tuck mordred galahad tristram merlin taliesin vivien oisin fionn brigid lugh ciaran cuchulainn niamh scathach diarmuid aine ragnar sigrid skadi gudrun hodur ulfgar bragi hrafna sigurd thorgrim lancelot dagonet agravaine morgause enid gildas percival gareth elaine blaise fergus cathbad etain amergin fiacra conall laoghaire deirdre emer manannan bjorn grimhild eir groa egil leif vidar ivar mimir freydis > groups/stint-swarm.log 2>&1   # background; ready at 60 "in game (phase playing)"
bun groups/field.ts --mix=6,6,3,2,1,1 --director=on --raid-every=30 --muster-after=3 --swarm-log=groups/stint-swarm.log -- --skill=average > groups/stint-field.log 2>&1   # background
```
- Stop with `touch groups/field.stop` (each unit ends its fight), then quit the clients: `bun client/dev/swarm-check.ts <the 60> --seconds=0 --quit`. Never kill a client.
- `groups/field.ts` is private (git-excluded) and has **no import.meta.main guard**: importing it starts field mode.
- Flags: `--director=on|off|ab`, `--raid-every=<min>` (a realm that holds the Faste skips its turn), `--muster=<realm>` for a one-off muster, and `--mix.<realm>=` per realm. Every realm must play in a raid run: a realm left out stands idle and gets hunted.
- Keep the PC awake (Windows standby stopped earlier runs): a SetThreadExecutionState loop, as in the memory note "Unattended runs stay awake".

**Committed but never seen live (the next stint's first check).**

| What | Commits | Look for |
|---|---|---|
| Walls block line of sight (matches the user's real client on 13 checks) | c1a48b7, cf0bba3 | fewer deaths to wall Wizards; our casts refused through walls (`not_visible`) |
| The Faste's ranks by line of sight | fb9173e, a2ad09e | the gate taken by melee alone, then the courtyard set; the west wall skipped |
| Shut enemy doors are walls on the navmesh | 8e0a8d7, d7bc5af | nobody inside before the gate breaks |
| Melee only on what they can reach | e80c2bf, 2baafeb | no climb up the inside wall |
| Only a fighter pulls the raid off the lord | 48fa6a4 | the lord phase holds |
| The lord hold (the clock waits up to 10 min more) and the go waits while the defenders outnumber us | 59b44a0 | raids ending `captured` instead of `timeout` |
| Warden: face after the side step; no heal retried each second | 8a0212a | Aine's styles landing |
| Turret and servant drop their list near crowd control | 23cef5c | `Broke cc` per sortie |

**Open, by owner (each in its section below).**
- **Pathing (R5 with R3), `sdk/actions.ts`:** `walkToObject`'s straight last step onto the target's z (around line 1505) and the melee chase (around line 2297). A layer step only on a short found route.
- **Own doors (R5):** `sendInteract` at our own keep's doors (the 100-150 jump through). Not needed until a unit walks inside a keep it holds.
- **The client reading door state (0x99):** a client change and a swarm restart.
- **The raid's waves (R3):** the whole-raid wait should count units still on their way, and squads shouldn't lead (hold short of the stage until a main group passes). Also: why hibernia-s4 stood 14 min on the approach.
- **R2:** a field.ts restart closes an open muster as `broken`, because the units stop before the director. Stop the director first (in field.ts, R1's file).
- **R7:**
  - The Reaver's aura goes out of step with the server.
  - The Minstrel plays one song at a time (`pulse_cancelled`).
  - The Savage chases into the river (the shared `assist`).
- **R8:** Etain's `petAttack:out_of_range` (focus 1287-1545 from the turret), and Morgause's Vitality Theft `no_response` and `walk:water`.
- **The raids' real problem (R5's table):** enemy players killed most raiders, and each death walks 12000-20000 back. Ideas: rez in the raid, a forward rally, or holding the go while the defenders outnumber us (59b44a0 starts this).

**The user's calls, still open.**
- Pushing the 4 local commits.
- The upstream OpenDAoC PRs in `docs/upstream/`.
- The plan doc's questions, including whether 150 bots fits Thidranki (memory "Pending items").
- The next gate: two changes of hands in a frozen window, kept or changed?

**Sessions:** R2-R8 and "Keep walls block line of sight" are idle with nothing in progress. They can be archived. The notes folder has `R5-faste.md` and `LOS-walls.md`.


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

### The report (R1, 10:15, 2026-11-13)

**In one line:** 60 bots played 15 hours on one machine without a stall. The help calls brought friends four times as often with the director on. The Faste fell three times (the probe twice, the window once), but the frozen window's gate of two changes of hands failed: one change, Midgard at 09:22:36.

- **The thirty (R6):**
  - All 30 were created, promoted, trained by build.ts and in template gear by 19:20, 1 h 40 min early: 9 new classes and 21 more of the existing ones.
  - From 22:28 they played all night beside the first thirty, all 60 at PrivLevel 1.
  - Learned:
    - The realm-point cap (Thidranki takes realm level < 10) moved Oisin and Brigid out. Realm points are now off for all 60 (`GainRP = 0`).
    - `starting_keep_level=1` keeps every capture at L28 guards and an L33 lord.
- **The nine kits (R7: Mercenary, Reaver, Savage, Champion, Valewalker, Minstrel; R8: Necromancer, Animist, Bonedancer):**
  - All nine played the frozen window in their units, with none benched.
  - Fixed live during the night:
    - The Necromancer counts as its servant while in shade (734f008, 6f9e921, 4a23c39, f415247).
    - The Animist's turrets come off mezzed targets (2b9358c, 2125074; one try reverted in cea2872).
    - The Warden makes a last stand (e4a1d36).
    - The Hunter's pet stays away while he is hidden (259fe32).
  - Open: the turret and the servant still break some crowd control on targets they pick themselves (R8). Aine's last stand ran in 6 of 13 sorties with no style landing (R7).
- **Load at 60:** one `client/swarm.ts` process for all 60 clients.
  - All night: swarm 31-40 % CPU, 265 MB, event-loop lag at most 14 ms, never over 100 ms.
  - Gateway 25-38 % CPU, lag at most 20 ms.
  - Gameserver 33-43 % CPU, 3.9-4.35 GiB.
  - 60/60 in game at every sample from 22:34 to 10:00, with no client restart.
  - One machine carries 60 comfortably; the swarm has room for at least twice that.
- **Help calls (run B, 22:28-01:54, director A/B in 20 min slots, realms out of step):**

  | | calls | someone coming | arrived | wiped | our dead per call |
  |---|---|---|---|---|---|
  | director on | 306 | 133 | 82 (27 %) | 23 | 1.01 |
  | director off (shadow) | 310 | 2 | 20 (6 %) | 20 | 1.11 |

  - With the director on, a call brought a friend four times as often, with about 10 % fewer dead per call.
  - Wipes were about the same: most calls close before help can cover 6000-9000.
  - From run D on the director ran for every realm, since a muster needs it.
- **The Faste (R5's sections have every row):**
  - Survey at 19:00: a raid plan by ranks (`siege.ts`), and the owner read live within 2-4 s (`siege-watch`).
  - Probe, 01:54-03:52, eight starts:
    - Attempts 1-6 each found one bug. Fixed: guards on the board, `raidOrders` at go, the pack's settings overwrite, the stage count, far casters, respawns pulling off the lord, the "already dead" door, and players drawing the mains away.
    - Hibernia captured at 03:38:48: 10 min from muster to the lord's death.
    - Albion retook at 03:51:04: 4 min from go, into a keep that was nearly empty.
  - Integration, 03:53-05:46 (runs D-D3): the raid rhythm, and the whole-raid wait at the stage (R2 1b23d2e, R3 313dffe, R5 ab6567c, e1302ff).
- **The frozen window (06:00-10:00, run D3, no edits, no restart): failed, 1 change of 2.**
  - 11 raids: Midgard 5, Hibernia 5, Albion 1. Midgard captured at 09:22:36; the rest ended on the 15-min clock.
  - Several of those reached the lord. Albion's at 09:42 had him at 43 %, then Hibernia found him healed to 99 %.
  - Why (R5's table): players killed far more of the raids than guards did (Albion's defenders most), and each death walks 12000-20000 back. The 15-min clock ends raids in the lord phase. Only melee damage the lord.
  - 643 fights in the window.
- **Carry-overs (each in its session's section; the first wave lands after 10:00):**
  - R2: hold the muster while a unit is in the lord phase, and hold the go while the defenders outnumber us.
  - R3:
    - count units on their way in the whole-raid wait;
    - squads don't lead;
    - casters up the stair;
    - melee never take a wall or roof caster without a found route.
  - R5:
    - keep pathing: shut enemy doors are walls through Door ↔ BlockingDoor poly flags, own doors by interact, no straight climb (`walkToObject`'s last step);
    - static guards out of the focus in the lord hold;
    - caster stands rechecked against the new LoS.
  - Walls block line of sight: branch `claude/eloquent-shannon-df1922` (c1a48b7, cf0bba3). It matches the user's real client on all 13 checks at the Faste. To go live: merge, `bun run occluders:build` in main, restart the clients, and R5's new stands in the same restart.
  - R4: squads; R7: Warden; R8: turret and servant crowd control.
- **What broke and what is open:**
  - Units of realms not in a run stood idle in the field and were hunted (attempts 1-2). Now every realm always plays.
  - Raids end on the clock in the lord phase (above).
  - The user watched three things: walls don't block LoS, bots walk through shut doors, and a melee climbed the inside wall. All three have fixes, either on the branch or after 10:00.
  - 10:01: an import check (R3) imported `groups/field.ts`, which has no import.meta.main guard, so a second field mode started with default flags. It pre-empted D3's three main groups (BotPreemptedError at 10:01:43, two quick ends, a 5 min wait) and was stopped at 10:03. D3 recovered on its own. Import checks cover the rvr.ts files only from now on.
  - Nothing is pushed. Local main is ahead of origin.
- **The end (R1, 10:31):** field mode stopped at 10:31:05. All 60 clients quit with swarm-check `--quit` (SWARM CHECK PASS; every one exit 0, logins 1, so no client dropped all night). The gateway and the keep-awake script are stopped. Logs: `groups/stint-field-*.log`, `groups/stint-probe*.log`, `groups/stint-swarm.log`, `groups/stint-gateway.log`.

## R2: Realm director

**The call interface (for R3 and R4, fixed from now; code lands in `sdk/group/director.ts`).** Units read calls from a file the realm's director writes, so a unit needs no director in its own process. Our realm's sight only: the board takes an enemy from a group frame's `world` only when the unit's run board holds it (`w.board`, human vision), never the raw client sightings.

```ts
import { callWatch, type RealmCall } from './director';
const watch = callWatch('camelot-s1', 'albion');   // polls groups/director/albion.json every 2 s
watch.calls();      // RealmCall[]: the realm's open calls, not this unit's own; [] while the director is off or absent
watch.answer(call.id, 'coming' | 'declined' | 'arrived' | 'left', why?);   // writes groups/director/answers/<unit>.json
watch.stop();
```

```ts
interface RealmCall {
  id: string;                       // 'albion-17'
  kind: 'help' | 'muster';
  from: string;                     // the calling unit (help), 'director' (muster)
  why: 'outnumbered' | 'caught' | 'camped' | 'raid';
  at: Point3;                       // where to go: the fight's centre (help), the rally point, then the target (muster)
  stage?: 'rally' | 'go';           // muster only: gather at `at`, then go for `target`
  target?: Point3;                  // muster only: what the raid goes for (the Faste)
  foes: number; ours: number;       // as our realm saw it: enemy players near `at`, ours alive there
  foeRoles: Partial<Record<FoeRole | 'unknown', number>>;
  want: number;                     // bodies still needed to even it (foes + 1 - ours - those coming); 0 = covered
  asked: string[];                  // units the director picked (free, nearest, way short); others may still come
  coming: string[];                 // units that answered 'coming'
  since: number; updatedAt: number; // ms epoch
}
```

- A unit decides itself: answer a call when it is in `asked` (or it judges by its own odds), it is free (no fight of its own), and the way is short. Answer `'coming'` once, walk to `at`, `'arrived'` when there (the director also measures arrival itself), `'left'` if it gives up. A call vanishes from `calls()` when it closes.
- Pure helper: `askedOf(calls, unit)` gives the calls that name the unit, nearest first by `at` if you pass its centre.
- **For R1:** `new RealmDirector({ realm, units, enabled })`, then each poll `director.update(frames, now)` with the group frames field.ts already reads (`GET /groups/<g>/live`), or `startDirector({ realm, units, enabled })` that polls the gateway itself every 2 s. `director.setEnabled(bool)` for the 20-minute A/B slots: when off it still keeps the board and logs the calls it would have made (`shadow: true`), and publishes none. Log: `groups/director/<realm>-log.jsonl` (calls, asks, answers, arrivals, closes with losses).
- **For R5:** the muster takes `{ rally, target }`; when `sdk/group/siege.ts` exports a raid plan I read rally and target from it.

### R1, Coordinator (status)
- **18:53 run A started** (30 bots, `-- --skill=average`, human vision; logs `groups/stint-field.log`, `groups/stint-swarm.log`, `groups/stint-gateway.log`). That's 35 min ahead of the timeline; the windows stay at the brief's times.
- **The realm-point cap.** Thidranki takes realm level < 10, so fewer than 7125 realm points (`battleground` table, MaxRealmLevel 10; `GamePlayer.cs:955` moves anyone at the cap out on logout or login).
  - Oisin (7658) and Brigid (7694) are over it. They stand in Connacht, so Hibernia's main group plays run A with no Druid and no Bard.
  - 13 more of the first thirty are at realm level 9 (5000-6600 points) and will cross the cap tonight. Each one that crosses is moved out at the next client restart.
  - **The fix, in the 22:30 window, with every client logged out:** set the bots' RealmPoints and RealmLevel back to 0 by SQL. That's bots only, and the cap stays as live Thidranki has it for humans (my pick in the plan doc). Then Oisin and Brigid come back in.
  - R6's new characters start at 0 and are fine.
  - **R3, R4:** don't read realm points or rank as a measure tonight. They get reset.
- **Built for 22:30 (R1, by 19:00):**
  - `groups/field.ts` takes `--mix=6,6,3,2,1,1`: main groups are the sizes 4 and up (`<realm>`, `<realm>-2`), squads the sizes 1-3 (`<realm>-s1..s4`). The second main group starts 60 s after the first. field.test.ts passes.
  - New folders `groups/{camelot,midgard,hibernia}-2/` (group.json copied from the realm's group, and an `rvr.ts` that runs the realm's own strategy on its own folder) and `groups/<realm>-s4/` (copied from -s3). All six pass the import check.
  - **R3, in your files:** each realm's `rvr.ts` main now takes `args.dir` (default its own folder) and passes it to `runGroup` (Hibernia's `loadGroup` too). That's one line each, written atomically and import-checked. `<realm>-2/rvr.ts` imports the realm's default export, so your strategy changes reach both groups at once. Keep the `dir` argument when you edit.
  - **The director in field.ts:** `--director=on|off|ab`, with `--director.ab=20` minutes a slot. In the A/B the realms are out of step, so each slot has some realms on and some off. One `call` ledger row per closed call (shadow ones say "director off (shadow)"). Notes when a slot switches.
- **Run B command (23:00):** `bun groups/field.ts --mix=6,6,3,2,1,1 --director=ab --swarm-log=groups/stint-swarm.log -- --skill=average`

**R2 status (19:01 by the machine clock): landed in 13ae2bc, offline tests green (31 across `director.test.ts`, `realm-board.test.ts`), no type errors in my files, the 4 realm group scripts import clean.**
- **Rules as built** (`DIRECTOR_SETTINGS`, all overridable per director):
  - *outnumbered:* a unit in a fight (phase engage, pull or retreat, or a living member in combat) has more enemy players within 2500 of its centre than ours there. Ours means its own living plus other units' members within 2000. Enemies come from every unit's board, merged.
  - *caught:* its reason starts `caught:` or `flee:` with enemies near, or it lost a third of its size in 30 s. It wants at least one more body, even at even odds.
  - *camped:* 2 or more enemies within 5000 of our portal keep for 15 s. The unit that sees most of them calls.
  - *asks:* the nearest units that are free (running, no fight of their own, half or more alive, mean health 60 or more), within 7000, not asked or answering for another call. It asks until `foes + 1 - ours - (asked + coming)` reaches 0.
  - *closes:* 15 s after the condition last held (`quiet`), at once when the caller is `wiped`, `gone` when its run ended, `timeout` at 3 min. The close event carries ms, our losses, wiped, asked, coming, arrived, player kills from the caller's and arrivals' report totals, and the most foes and ours seen. R1's ledger row comes from it.
- **Muster:** `director.startMuster(plan?)`, `endMuster(why)`. It rallies, then goes once 70 % of the raid's living stand within 2250 of the rally, or after 4 min with half. In 'go' it ends `captured` when `targetOwner()` returns our realm, `broken` below 30 % of those who went, or `timeout` after 15 min. Rhythm for the frozen window: `settings.raidEveryMs` (0 = off) starts a muster that long after the last one ended. The plan is `opts.raidPlan()`, else `defaultRaid` (rally 5500 from the Faste toward our portal keep). **R5/R1:** pass siege.ts's plan as `raidPlan: () => ...` and the live owner as `targetOwner: () => ...` to `startDirector`.
- **Live read checked** (19:00, run A on, director files untouched: `write: false`): all three boards fill, including units between runs. Albion's solo camelot-s2, fleeing one enemy, made a shadow 'caught' call.
- **Known gap, R1's call:** the gateway's `contactOf` (gateway/groups.ts:741) drops `classGuess`, so `foeRoles` read only the healer and caster signs. The board already reads `board.classGuess.role` when present. Adding it to `contactOf` and to the frame's `board` view needs a gateway restart in a stop window.
- **Load:** each director reads its units' frames every 2 s, with no events, plan or report it already had (cursors), so about 10 requests a second for 3 realms with 7 units each, beside field.ts's own polls. If the gateway lags, use `everyMs: 3000`.

**R2, 05:50: the director in run D3 (05:00-05:46), observed only; fixes are carry-overs for after 10:00.**
- **Help calls:** 113 closed (Albion 47, Midgard 36, Hibernia 30), none in shadow. Helpers arrived on 32 of them (Albion 15, Midgard 8, Hibernia 9). The rest: on 20 nobody free stood within reach, and on 61 the asked units declined or didn't arrive before the fight ended (mean call 35-62 s). Declines are mostly R3's odds rule ("odds there", Albion 23 of 29).
- **Do arrivals help?** Kills per call are higher with arrivals in every realm (Albion 1.27 vs 0.93, Midgard 2.25 vs 1.33, Hibernia 1.67 vs 0.67), and losses are mixed (Albion 1.47 vs 0.96, Midgard 0.50 vs 1.17, Hibernia 1.44 vs 1.40). The samples are small and a call with an arrival lasts longer, so this is no proof yet.
- **Raids:** Albion holds the Faste (by guard, since 05:00), so field.ts skips its raids, as built. Midgard (05:13): 13 of 18 at the rally in 74 s, go, but no unit came within 1500 of the Faste in 15 min: `timeout`. Hibernia (05:23): rally 7 min (the "half after 4 min" rule held until 7 of 13), go, s1-s3 reached the Faste, 21 kills, `timeout` at 05:45 with no capture. hibernia-s4 stalled 5 min at "raid approach: 8629 to the stage" (R3's side).
- **Carry-overs (director.ts, after 10:00):**
  1. A muster's close reports `lost: 0` always and counts `kills` only over units that arrived (Midgard's raid logged `kills: null`). It should count losses and kills over every asked unit.
  2. When no unit is asked, the log doesn't say why (out of reach, in a fight, busy with another call, low health). Add the nearest refused unit and its reason to the open event.
  3. D2's last Hibernia raid closed `broken` at 05:00:08, at the field.ts restart: the units stopped before the director did. `stop()` should close open calls as `stopped`, so a restart doesn't read as a broken raid.

**R2, 10:30: the two raid holds landed in 59b44a0 (live from the next stint's field.ts start).** Offline tests: 35 in `director.test.ts` and `realm-board.test.ts` (3 new). `squad.test.ts` and `tactics/` (160) still pass, there are no type errors in my files, and the rvr.ts files import clean.
- **The lord hold:** past the 15 min in 'go', the clock waits while a raid unit's reason reads `raid lord` (tactics/raid.ts writes `raid <phase>: ...`), read within the last 30 s (`lordGraceMs`), for up to 10 min more (`lordMaxMs`). Without a lord read it ends at 15 min as before.
- **The defence hold:** the rally doesn't go while more enemy players were seen within 4500 of the target in the last 60 s than the raid has living (`defenceRadius`, `defenceMemoryMs`, `defenceShare: 1`). Held 10 min without a break (`defenceMaxMs`), the muster ends `defended`, and field.ts's rhythm starts the next one 30 min later. **It counts only what our units see:** from the rally, 5500 out, the raid sees few defenders, so a squad or scout near the keep is what feeds it.
- **On the call:** a muster now carries `defenders` (that count) and `hold: 'defenders' | 'lord'` while one holds. A new log event `hold` (`why`, `on`, `defenders`, `living`) marks each start and end. field.ts ignores it; R1 can add a ledger row for it.
- **Also fixed (my 05:50 carry-over 1):** a muster's close counts `lost` and `kills` over every unit in the raid, not only the caller and arrivals. Before, it was always 0 and null.
- **Still open (carry-over 3):** a field.ts restart closes an open muster as `broken`, because the units stop before the director does. Stopping the director first, in field.ts, is R1's side.

## R5: The Faste

### Survey (19:00, from the server source, the DB and the navmesh; the walk follows on a throwaway stack)

**What stands there.** Thidranki Faste (keep 11, centre 33089, 38271, z 3720) is Albion's (`keep.Realm` 1, Level 1, BaseLevel 26). It has **no keep components on the server** (`keepcomponent` is empty), so there are **no server walls and no door**. The building is a static structure in the client's zone files. A human's client draws it, and our navmesh has it (`buildnav` reads the zone fixtures).
- **The island.** The Faste stands on an island in a moat: water on every side, about 3000-4500 out. Three bridges cross it, one into each realm's half. Each lies about 4600-6000 from the centre, outside every guard's reach. Away from them the moat can only be swum.
  - Hibernia: the north-west bridge, from about (29600, 34000) to (31200, 35500).
  - Midgard: the east bridge, from about (39500, 35800) to (37700, 36450).
  - Albion: the south-west bridge, from about (28200, 41800) to (30200, 40200).
- **The way in.** It is one open gateway on the east side, at about (34050, 38250), roughly 960 from the centre. Every navmesh path from any side goes through it. An outer wall ring runs about 900-1100 from the centre, with wall-walks at z ~3976. The keep building stands on the west of the courtyard, at x 31830-32670.
- **The lord's roof.** The lord stands on the building's roof, at (32296, 38267), z 4592, which is 870 above the courtyard. A spiral stair inside the building climbs to it, at x 32144-32285, y 38202-38342, past floors at ~3960 and ~4272. The navmesh path from the gate to the lord is about 1900 long.

**The guards** (mob rows with `DOL.GS.Keeps.*` in the Faste's keep area). They take the keep's realm on spawn, whatever the row says (`GameKeepGuard.SetRealm`). Their level is BaseLevel+1 + keep level x 1.6, so 28 today; the lord's is BaseLevel + 6 + keep level x 1.6, so 33 (`AbstractGameKeep.GetBaseLevel`/`SetGuardLevel`, `keep_guard_level_multiplier` 1.6).

| Ring | Who | Where (z) | Aggro |
|---|---|---|---|
| outside the gate, 1300-1700 out | 5 fighters (Armswoman, Huscarl, 3 more) | (34024,39282) (34247,37179) (34396,37556) (34687,38050) (34720,38637), z ~3720 | 1000 |
| by the gate | Hastener (L1, speed buffs, harmless) | (34365,38483) | none |
| wall-walks, 890-1140 out | 6 static casters | (33185,37386) (33976,37722) (33971,38815) (33679,39074) (32478,39130) (32441,37328), z ~3976 | 1850 |
| courtyard | 2 fighters | (33353,38186) (33485,38252), z 3720 | 1000 |
| building, floor 3 | 1 fighter | (32308,38560), z 4272 | 1000 |
| roof | 3 static archers | (32526,38271) (32218,37987) (32213,38573), z 4592 | 2100 |
| roof | **the lord** (Armsman/Warrior/Hero by realm, 3x health, heals himself) | (32296,38267), z 4592 | 1000 |

That's 17 guards and the lord. All aggro on enemy players (aggro level 99), and the fighters come out after what they aggro on.

**Taking it (server rules).**
- **The lord takes damage only from within 400, in 3D** (`GuardLord.TakeDamage`, "immune to damage from this range"). That counts the attacker and a pet. So melee, casters and pets all have to stand on the roof or just below it.
- **His death gives the keep to the killer's realm** (`NormalServerRules.ResetKeep` then `Reset(killer.Realm)`).
  - The lord respawns 1 s later in the new realm (`LordRespawnTime` 1000).
  - Every other guard dies at once and respawns 5-25 min later (`guard_respawn` 15 min, variance 10), in the new realm.
  - So for 5-25 min after a capture, only the lord holds the Faste.
- **A capture sets the keep level from 1 to 4** (`starting_keep_level` 4). From then on, guards are L33 and the lord L38, and the DB keeps it. The first raid meets L28/L33; every retake meets L33/L38, purple to a 24.
  - **R1, the user's call:** `bun run server:setup --set starting_keep_level=1` would keep every capture at L28/L33. I'm checking this on the throwaway.
- A guild can't claim it (`allow_bg_claim` False), and nothing in a capture depends on guilds.

**How a client sees who owns it.**
1. **The capture message, to every player on the server.** `The forces of <Realm> have captured Thidranki Faste!` arrives twice: once as `important` and once as `screenCenter` (`PlayerManager.BroadcastKeepTakeMessage`). Our clients already type both.
2. **The guards' realm** in each NPC's create packet (`NearbyNpc.realm`). After a capture only the lord shows it at first, until the guards respawn.
3. **Nothing else.** With no components, the server sends no keep or warmap packets for the Faste.
- The DB keeps the owner across a server restart. A client that missed the message learns the owner only by seeing a guard. So `keeps.ts` gets a pure owner read from both signals, and the caller keeps the last answer (below).

**Can 20 level-24 bots take it?**
- **The first time: probably yes.**
  - The guards are 4 levels over us, and we can take them one at a time.
  - The real cost is the 9 ranged guards. The casters reach 1850 and the archers 2100, so they out-range most of our nukes and hit whoever is in the courtyard all the while.
  - The order below kills the outer fighters, then the gate-side casters, then the roof archers from the courtyard (3D ~1000 away), and only then climbs.
  - The lord is L33 with 3x health and heals himself. At most about 10 can stand within 400 of him on the roof.
- **A retake at L33/L38: doubtful** unless `starting_keep_level` is set to 1.
- **Holding it is cheap:** the captor's guards come back by themselves.

**Raid plan** (`sdk/group/siege.ts`, interface below once it lands):
1. Rally on our own bank before our bridge, out of every reach.
2. Cross together and stage on the island, outside every aggro circle.
3. Kill the outer fighters east of the gate.
4. Kill the gate-side wall casters, then the far ones.
5. Kill the courtyard fighters (they come out).
6. Kill the roof archers from the courtyard.
7. Climb the stair, killing the floor-3 fighter.
8. Kill the lord with everyone on the roof.

There is no door to break. `keeps.ts` lifts the Faste's keep circle only for a unit whose settings name the raid (`raid: 'Thidranki Faste'`). It is off by default.

**Survey walk.** I'll do it on my own throwaway stack (`server:throwaway --name=r5faste`) with SQL-placed level-24 characters, so I need no field bot. An Albion character walks in among friendly guards, reads every guard's name, level and realm, and climbs to the roof. Then a Midgard GM kills the lord, to see the capture message, the realm flip and the new levels. Results go here.
- **R2 for R3, on `ours` and unit names (19:10):**
  - **Unit names.** A unit's name is its group folder name (`camelot`, `camelot-2`, `camelot-s1`), the same as in `from` and `asked`, and the same name to pass to `callWatch`.
  - **`ours` counts by position, not by answers.** A help call counts the caller's own living, plus the living members of every other running unit within 2000 of `at` (the caller's centre). A helper that has arrived (within 1500) is in that count, whether it answered or not. To count allies other than yourself, subtract your own living members within 2000 of `at`.
  - **Camped calls:** the living members of every running unit within 2000 of `at`, which there is the enemies' centre.
  - **Muster:** the raid's living within 2250 of the rally point, or of the target once the stage is `go`.
  - **`want`:** subtracts asked and coming units that have not arrived yet. An arrived unit is in `ours` instead, so nobody is counted twice.

## R8: Pet kits

**Roles for `lineup.ts` (R1):** all three are **`nuker`**, the role `roleForClass` already gives them (`strategy.ts`), and each kit's `character.ts` says so too. None is a healer or support. As a pet class each brings its own pet's damage: the Bonedancer's commander is a window pet the group's `withPets` runs as for a Spiritmaster; the Animist's turrets and the Necromancer's servant are run by their kits only (`petControl` leaves turrets and shades alone).
- Necromancer (Albion): `nuker`. In shade it can't be hit; its servant is its body. Place it as a nuker, not as a tank, though the servant goes in front.
- Bonedancer (Midgard): `nuker`.
- Animist (Hibernia): `nuker`.

**Offline (19:05):** `sdk/classes/{bonedancer,animist,necromancer}.ts`, shared helpers `sdk/classes/summoner.ts` and test fixtures `summoner-fixtures.ts`, tests green (15), guides in `learnings/classes/`. Not committed yet. **No change to `sdk/group/pets.ts` is needed** (R3): the kits run their own pets, and the Bonedancer's commander is already handled there.
- Bonedancer: the nuker's `assist` and the group's commander, plus `summonMinion` between fights (one minion at 24, a caster first).
- Animist: `plantTurret` (main turret between us and the focus, re-planted when left behind), `fnfTurret` (a damage turret near an enemy player at 50 % power), `bomb` (Spirit of Wrath before the lifedrain), then `assist`.
- Necromancer: `raiseServant` (only with nothing hostile within 2500), `fallBack` (no servant and enemies near: step away), `keepTether`, `servantFight` (servant at the focus, PetSpell nukes, owner-cast ones under a melee), `servantHeal`, `servantBuffs`.

**Live checks (19:11-19:29, done):** R6 handed over at 19:15. Each kit is now in its bot's `character.ts`: **morgause** (Necromancer), **etain** (Animist), **grimhild** (Bonedancer). Three sorties of 3-5 min, all three solos at once in Thidranki as one-member squads (`groups/r8-<bot>/`, which field.ts doesn't run), against each other and other sessions' units:
- **Morgause:** 3 player kills, 0 deaths. Her servant was cut twice in sortie 1: the retreat's walk took every turn from my leash, fixed by moving it to the side tick (db6bc19). Up 100 % of sorties 2 and 3 after the fix. Solid.
- **Etain:** 8 kills, 3 deaths, her turret dealing 3131 in one sortie. Fixed turret orders refused as out of range (db6bc19). Solid.
- **Grimhild:** commander and Bonemage minion up as designed; one fight only, lost to Morgause's servant (casters lose to it). Kit is the plain nuker plus the minion, so low risk, but the least seen live.
- All three are ready for R1's benches at 22:30. From then on I only read the sortie logs. The bench rule for 04:30 stands: none is on it now.
- **For R3, no action needed:** `pets.ts` unchanged. The Necromancer's servant is the shade's body, and the group's healers never heal it (it's a pet); its own heal and lifedrains keep it up. A servant's death drops the owner out of shade at 10 % health without counting as a death. Details: `learnings/classes/necromancer.md` "In a group".

**Field run B, first sorties (22:28-23:07, read 23:15), each in its realm's main group:**
- **Morgause (camelot):** servant up 95 % and 89 %, but on the focus only 28 % and 51 %: 94 and 35 attack orders refused ("too far away to attack with your pet"), idle 50 % and 26 % on "nothing to cast", first nuke 32-34 s in. The server wants the owner within 2000 of the target for an order and within the PetSpell's range for a cast; she stood back with the casters. **4a23c39:** `servantFight` walks the shade to 1300 of the focus first (nobody can hit it). Live at camelot's next sortie. 3 deaths, all out of shade after the servant's.
- **Etain (hibernia):** turret 6565 damage (twice hers, 3041), up 66 %, 21 plants; 3 deaths; 6 refused turret orders. Nothing to fix yet.
- **Grimhild (midgard):** 6365 damage, commander on the focus 76 %, 2 deaths. Nothing to fix.
- None on the bench. Next look after camelot's next sortie, for the walk-in.

**00:10, the next sorties:**
- **Morgause, camelot 23:35 (after 4a23c39):** no refused attack order (90 before), servant on the focus 70 % (28-51 %), first nuke 6.1 s (32-34 s), 3278 damage, her best. One death: her servant died and she died 2 s later, still walking in. **f415247:** a walk in is at most 1.5 s a turn, and none into a 500-range nuke with the servant below 40 %.
- **Etain:** turret 7695 and 7700 in the next two sorties. It broke crowd control 5 and 2 times (a turret picks its own next target). **2b9358c:** it now goes passive on any mezzed target.
- **Grimhild:** 9279 damage and 0 deaths in a 45 min sortie, commander up 100 %; 4 deaths in the next. Nothing kit-side.
- All three stay in; none on the bench. Next look about 01:30.

**01:30, the sorties after f415247 and 2b9358c:**
- **Morgause (camelot 00:20, 00:37):** first nuke 6-7 s, servant on the focus 61-65 %, 1556 and 4690 damage (her best), no refused order. 2 deaths a sortie, out of shade after the servant's. Holding.
- **Etain (hibernia 00:18, 42 min):** the turret still broke crowd control 6×: the check sat in her fight turn, which her 2.5 s casts held. **2125074:** it now runs on the side tick (250 ms) and counts a mezz another member is casting. Live at hibernia's next sortie.
- **Grimhild (midgard, three sorties):** 1993-3829 damage, commander up 70-94 %, 3-4 deaths a sortie, first nuke 0-1.3 s. Nothing kit-side.
- None on the bench. Next look about 03:00, then the 04:30 call.

**03:00, sorties 01:00-02:50:**
- **Morgause (camelot, 5 sorties):** first nuke 7-15 s, servant up 83-91 %, 1534-3277 damage, 0-2 deaths. No refused order. Holding.
- **Etain (hibernia):** with 2125074 (00:43 and 01:11 sorties) no crowd control broken, but those were quiet sorties for the whole group (6 short fights and 1), so it's not proven. Before it (01:01) 2 broken in a 40 min sortie, turret 7471.
- **Grimhild (midgard, 3 sorties):** 1652-3808 damage, commander up 96-99 %, 1-3 deaths. Holding.
- No kit change. The 04:30 call follows a last read at 04:15.

**04:30 bench call (read 04:15, sorties 03:02-04:41 local).**
- **None of the three goes on the bench.** Necromancer, Animist and Bonedancer play the frozen window.
- **Morgause (camelot, 5 sorties):**
  - damage 898-2757 a sortie, 0-1 deaths, servant up 84-95 %;
  - no refused attack orders and no broken crowd control;
  - first nuke a median 3.6-9.4 s after the engage, 23 s in one sortie of mostly PvE fights that waited for the tank's hold;
  - one quirk, no change: in 02:13 her walk-in was refused 23 times as `walk:water`, so she stays dry and nukes out of range.
- **Etain (hibernia):**
  - The crowd-control fix (2125074) holds: 1 broken mezz in 5 sorties after it, against 1-6 in every sortie before.
  - It cost the turret most of its damage: 0-1178 a sortie after it, against 4676-7700 before.
  - The cause (server code): passive wipes the turret's list of what it has been fighting (`Disengage`), and its own picks off that list after each kill were most of its damage.
  - **b2ee129 (04:19)** sends the turret back at the focus when it reaches it, which stops the shot just as passive does and keeps the list; passive only without a focus.
  - It goes live at hibernia's next sortie, so the integration hour (05:00-06:00) is its check.
  - If that hour shows 2 or more broken mezzes in a sortie, I revert to 2125074's behaviour in `sdk/classes/animist.ts` before 06:00 (my own file) and say so here.
- **Grimhild (midgard, 2 sorties, then rotated out):** commander up 95-98 %, on the focus 78-83 %, 1 death each, no broken crowd control. Holding.
- Next look: hibernia's first sortie after 04:19, then about 05:45, before the freeze.

**05:10: b2ee129 reverted (cea2872).**
- Its first sortie was hibernia-2's at 04:28 (31 min): the turret was back to 6278 damage (Etain's own 3256), but it broke crowd control 3 times.
- The three: a root on a Highlander, a mezz on a Briton, and a mezz on the servant that had been the focus earlier and was still on the turret's list.
- By the rule above, the Animist plays the frozen window with 2125074: passive on crowd control, about 1 broken mezz in 5 sorties, turret damage around 1000 a sortie. Still on the field, not the bench.
- The open trade (the turret's own picks are both its damage and its breaks) is for after the freeze.
- No more kit changes from me before 06:00.

**07:55, frozen window D3, read only (sorties 06:04-07:56).** All three are playing, and none is a problem for its group. Carry-overs for after 10:00:
- **Etain (hibernia, 3 sorties):**
  - Her turret dealt 3881, 3109 and 9133 with 2125074's passive on crowd control, and broke cc 1, 0 and 2 times. The 2 were roots on a PvE mob.
  - So passive did not cost the damage: the 0-1178 sorties after 2125074 were quiet ones. My 04:19 reading and the b2ee129 change rested on that misreading.
  - The guide is corrected (learnings only).
  - Carry-over: `petAttack:out_of_range` 14-17 times in the long sorties. The SDK refuses the order with the focus 1287-1545 from the turret, while `plantTurret` read it as in reach. Look at the turret's position against `turretState`'s 900.
- **Morgause (camelot, 4 sorties):**
  - Damage 1500-6255 a sortie, servant up 89-97 % and on the focus 65-74 %, deaths 1-3.
  - Carry-overs:
    - The servant broke a mezz in 2 of the 4 sorties (a Celt and an Elf). `servantFight` checks only the focus, not what the servant chooses itself, so it needs a cc check like the turret's side tick.
    - `nuke:no_response` on Vitality Theft 6-14 times a sortie.
    - `walk:water` 18-28 times a sortie: her walk-in won't go into water.
- **Grimhild (midgard, 2 sorties of 38-43 min):** damage 3782 and 7206, commander up 95-98 % and on the focus 69-73 %, commander damage 2325-2842, no broken cc, 3 deaths each. No carry-over.

**09:47, the frozen window in full (D3, sorties 06:04-09:24 local; for the morning report).** All three pet kits played the whole window, and none was benched or changed.

| | Sorties | Damage (own) | Pet up | Pet on focus | Pet damage | Deaths | Broken cc |
|---|---|---|---|---|---|---|---|
| Morgause, Necromancer (camelot) | 7 | 29455 (1500-6255) | 87-97 % | 54-74 % | 5135 | 13 | 2 |
| Etain, Animist (hibernia) | 7 | 18620 (937-3814) | 44-71 % | 6-35 % | 44183 (3109-11636) | 17 | 10 |
| Grimhild, Bonedancer (midgard) | 5 | 22609 (2993-7206) | 87-98 % | 69-78 % | 10003 | 14 | 0 |

- **Etain's turret** is her damage: 2.4 times her own.
- **Its breaks** stayed at 0-3 a sortie. Six were on players: 5 mezzes and a root. The side tick catches what the turret is already shooting, not the next target it takes off its list after a kill. The carry-over: a middle way such as passive while a mezzed enemy stands within its reach. b2ee129's return to the focus wasn't it: 3 breaks in its one sortie.
- **Morgause's servant** broke 2 mezzes. Same carry-over: a cc check on what the servant picks itself.

**10:19, the turret and servant carry-overs landed for the next stint (23cef5c; tests 338 pass, the typecheck clean for these files; nothing live after 10:30).**
- New `sdk/classes/pet-cc.ts`, `petOffCc`, on the side tick.
- The pet's own target under crowd control sends it passive, as before.
- Crowd control newly landing on any enemy within the pet's reach does too. Passive wipes the pet's list, where its own picks after a kill came from.
- Then it attacks the clean focus if that is in reach: the turret within 900 of it, the servant within 2000 of Morgause.
- The Animist's `turretOffCc` now uses it, and the Necromancer gets `servantOffCc`, whose wipe for crowd control nearby waits out the servant's 3 s cast half.
- Not seen live: the next stint's first sorties are its check. Read `Broke cc` and the pet damage in the Pets table.
- Still open: Morgause's Vitality Theft `no_response` and `walk:water`, and Etain's `petAttack:out_of_range` (the focus 1287-1545 from the turret while `plantTurret` read it as in reach).

## R3: Group play

**Landed 19:05-19:15 (913e38f; the realm `rvr.ts` mains are private), live from each main group's next sortie** (`sdk/group/rvr.ts`, new `sdk/group/tactics/help.ts`, the realm `rvr.ts` mains; import check ok for all six main groups; field.ts never waited on my `.editing` locks).
- **Help calls, every main group** (`camelot`, `hibernia`, `midgard` and their `-2`, Albion on roaming, the other two on the pack through its calm side):
  - Each realm `rvr.ts` main wraps its strategy in `realmCalls(strategy, <folder name>)`. It loads R2's `callWatch` on the first tick, once our realm is known; with no director file there are no calls and the group plays as before. The watch stops when the run ends.
  - **Which call:** one asking us within 9000 (nearest first), then the muster, then one still wanting bodies within 6000 that doesn't name us. Never our own, never one we left. The one we answer is kept while it is open.
  - **When:** only from the quiet branch: no fight of our own, no enemy in sight, nobody dead or away, at most one member short of ready. A fight on the way comes first, and the walk goes on after it.
  - **Together:** legs of 1500 that wait for every member (`stepLeg`), as the patrol.
  - **There:** `'arrived'` within 1500 (also when it happens in a fight). Nobody in sight for 20 s without a break: `'left'` ("nobody in sight"), and back to the patrol. A call that closes is dropped without an answer.
  - **Odds with friends:** near the call, its `ours` less our own living within 2000 of it (R2's count) stand on our side in the retreat and fall-back counts. Reasons read `7 enemies vs 5 + 3 of ours`.
  - **Muster:** walk to the rally point, rest there until the director says go, then walk to the target. The rally doesn't time out.
  - `--calls.enabled=false` turns it off for a run; `--calls.maxWay`, `--calls.maxWayOpen`, `--calls.muster=false` tune it.
  - Log lines: `call <id>: <from> (<why>, F vs O), D away`, `call <id>: there, ...`.
- **Carry-overs** (decideRvr, Albion's roaming; the pack doesn't retreat on numbers):
  - **While retreating,** those we ran from that dropped out of view count as following for 30 s after last seen (`FLED_SEEN_MS`). The retreat no longer ends early on human vision.
  - **For 60 s after a retreat** (`FLED_MS`), the group we ran from is sized up whole when the hunt sees part of it: those mezzed and those out of view count (`fall back: 4 enemies and 3 more we ran from (mezzed or out of view)`). And no patrol leg walks back toward where it was (`keep off: the 7 enemies we ran from ...`). A call is still answered.
- **Two main groups per realm:** Camelot's class lists (`memberLists`) read `groups/camelot/group.json`, not the run's folder, so `camelot-2`'s new bots (Mordred, Tristram) would have played their role lists. Fixed: `ourClasses(String(dir))`. The unit name for the calls is the run's folder too. Nothing else I own assumes one main group per realm.
- **For the raid (R5, R1):** keep guards and the lord are enemy realm NPCs, and the board leaves them out: `blackboard.ts:332` keeps only `isKillable` monsters and enemy pets. A raid can't focus, mezz or count a guard until the board takes in enemy-realm attackable NPCs, at least for a unit whose settings name the raid. That's blackboard.ts, not mine: who takes it? I'll call siege.ts's plan from decideRvr's muster `go` stage once it lands.
- **Tests:** `tactics/help.test.ts` (9), rvr.test.ts +7 (the carry-over ones fail on the old code), pack.test.ts +1.
- **Next:** the raid's `go` stage, once R5's `siege.ts` plan and the `raid` keep setting land, and once the board takes in keep guards (above). Until then a muster's `go` walks to the target as far as the keep circle lets the route.

**Landed 20:50 (734f008): a Necromancer in shade is its servant** (R1's 20:45 finding; live from each main group's next sortie; import check ok for all six; `bun test sdk/group` 2250 pass).
- **Board mark** (`blackboard.ts`): `picture()` marks an enemy pet `servantOf: <shade id>` when it is a living pet of the shade's realm, in its region, within 2000 of it (the server's leash). One servant per shade, one shade per pet; a servant's name (`servant|zombie|abomination`) beats a nearer pet, then the nearest. The pure function is `servantsOf(contacts)`.
- **Main groups** (`decideRvr`, `decidePack`): both read `shadeBodies(contacts)`, which turns each servant into that player (kind `'player'`, no pet flag, the shade's `classGuess`, `caster` and `healer`, plus `servantOf`). The shade stays untouchable and drops out, so the Necromancer counts once, as its servant: hunted, focused, counted for a retreat and sized up. The member that gets the servant as focus finds a pet on the board and fights it with `killNpc`, as it already does for a threatening pet. Killing it drops the Necromancer out of shade at 10 %, and it is a plain player again.
- **For R4 (squads):** `shadeBodies(p.contacts)` at the top of the squad's decide does the same there. The `servantOf` mark is on every picture already.
- **Tests:** blackboard-pets.test.ts +2 (the mark; pick rules), rvr.test.ts +3 (hunted as one enemy; the servant the focus, never the shade; six plus a shade fall back at margin 2), pack.test.ts +1 (prey, the servant the focus).

**Landed 21:02 (18db88b): the pack holds one state** (R1's Midgard flips, `groups/midgard/runs/field-20261112-191632.log`; Hibernia and Midgard main groups, live from their next sortie; `bun test sdk/group` 2256 pass, import check ok for all six).
- **Broken pack, run vs regroup** (19:55:46-19:56:26, 9 flips in 40 s): the run starts when an enemy presses (on us, or within 700). It now goes on for 6 s after the last press (`HOME_RUN_HOLD_MS`) while an enemy is within reach + 500. Only then does the pack regroup. A new press runs again at once.
- **A kiter** (19:54:09-19:55:01, about 12 engage/stalk flips on Briton#456, a healer at 1500-2800): a focus that runs out of reach of our engage (past reach + 200, not on us) twice within 60 s is let go for 60 s (`noteRunners`, memory `runners`). In that time it is no hunt, stalk, raid or focus, unless it comes on us or within 700. It is still counted in the odds. The log line reads `...; let go of Norseman#456 (...): ran out of reach 2 times, left alone 60 s unless it comes on us`. On that log it would have stopped at the second run-out (19:54:35) instead of coming back at 19:55:04.
- Not done: the pack's "hunt" (prey) and "stalk" alternate when the count in sight changes (1 vs 3), but both are travel toward the same lead, so it isn't a real flip. Albion's roaming (`decideRvr`) has no runner rule yet; it wasn't reported.
- **Ragnar rooted (19:55:27), noted only:** "stuck ... max speed 0" for 8 s on the raid's focus (an Avalonian). Sigrid was mezzed at the same moment, and Hrafna and Gudrun died within 12 s: the Albion group was crowd-controlling and burning ours. Nothing in the pack reacts to a rooted tank: the focus stays where he can't reach, and nobody cures or purges the root. A rooted melee could swap to a target in reach, or the healer could cure it. I'm not changing it tonight unless R1 wants it.

**Landed 21:14 (6615bfe): hasteners** (the user: our units never used them; live from each unit's next sortie; `bun test sdk/group groups` all pass, import check ok for the six main groups and three squads).
- **What:** a member behaviour `hasten` (`sdk/group/tactics/hasten.ts`). A member without Speed of the Realm, with a hastener within 1200 (2D), walks within 150 of it and interacts (`sendInteract`). It then waits up to 3 s for the effect (spell 2430: +147 %, 600 s, on the member and its pets). That covers the rest before a sortie at the portal keep, a member back after a release, and the Faste's hastener for its owner.
- **When:** orders say recover, gather, idle or travel; no threat and not in combat; no enemy player within 2500. A failed walk, or no effect after the click, waits 30 s before the next try.
- **Server facts:** the hastener has the PEACE flag, and `NormalServerRules.IsSameRealm` reads a PEACE NPC as of every realm, so any one in reach works. The DB rows are realm 0, which doesn't matter. Interact range is 192 (`WorldMgr.INTERACT_DISTANCE`). There is no dialog answer, so the result is read from the effect (or a max speed of 200 % or more), not from `talkTo`.
- **Where it sits:** in every list just above `holdFormation` (else `buff`, else `rest`).
  - `rvrBehaviors` (Albion's roaming, and every list built from it) and the pack's rebuilt support list.
  - The main groups' own lists (Camelot's per-member lists, Midgard's `packList`, Hibernia's calmed lists): `realmCalls` wraps their strategy in `withHastener`, so no group file changed.
- **Squads (R4):** no squad.ts change. `squadRoaming` takes `rvrRoaming`'s lists, which now have it, and the `-sN` scripts don't replace them. If a squad builds its own list later, `withHasten(list)` adds it.
- **Live check:** look for `hasten` in the runs logs (`doing hasten ... Speed of the Realm, the hastener N away`, then `hasten: Speed of the Realm`, or `no_effect`). Not seen live yet.
- **Tests:** `tactics/hasten.test.ts` (8: the rule, the placing, the behaviour with a fake member). pets.test.ts and rvr.test.ts list pins now include `hasten`.

**Landed 02:09 (baf78da): the raid at the muster's go** (R1, 01:50, for the Faste probe's attempt 2). Live from each main group's next sortie: attempt 2 needs a fresh field.ts start (or a rotation) of the raiding realm's main groups. Squads aren't wired.
- **Board** (`blackboard.ts`, `types.ts`):
  - `observeState` reports an enemy realm's NPC that is no pet as a sighting marked `keepGuard`: attackable, level 2 and up, not a peace NPC like a hastener.
  - The board holds these. `picture()` shows them only while the orders carry a raid (`Orders.settings.raid`), so every other reader (squads, the observer, the fight branches) sees nothing new.
  - Each member's report carries `doorsBroken`: the door nearest it when it read "The Keep Door is broken!" in the last 60 s. That is a door object in view, else the siege layout's door, within 900.
- **decideRvr** (Albion's roaming, and the pack's calm side). `decidePack` hands the tick to calm when the muster says go and no enemy player is about.
  - A unit answering a muster at `'go'`, in the plan's region, runs `raidStep` (`tactics/raid.ts`). It builds the `raidOrders(raidPlan(realm), view)` view from the board's keep guards, the members (dead ones too), the doors read broken, and `staged`. The owner is read from the guards' realm.
    - **approach/stage:** travel to `routeFrom(plan, centre)[0]` (the body's next waypoint), and at stage to the stage.
    - **assault/lord:** engage the ranged half's focus (else the melee's), anchored at `stand`.
    - **Nothing to hit in view:** recover at `stand`.
  - It sits after the fight and hunt branches (enemy players first) and before "attacked by guards: moving off".
  - The orders' `settings` patch `{ raid: 'Thidranki Faste', raidDoor }` lifts the Faste's circle for every member (keepDangers) and puts the guards in the picture. `realmCalls` sets it back to null once no muster says go.
- **Doors:** a new behaviour, `breakDoor`, for tanks and melee (by the member's role).
  - It goes into the role lists and every member's own list, by `realmCalls` (`withRaid`), before tank, meleeFight, guard or assist.
  - With `settings.raidDoor` set: walk to the door's stand, `sendSetTarget` the door object found by `doorId` in `sdk.getNearbyObjects()`, face it, and auto-attack.
  - It stands down for something on the member or a retreat, and stops its swing when the orders drop the door.
- **Squads (R1 asked):** R4's squads answer the muster too (`chooseCall`). At go they walk straight at the lord's spot (`callGoal`), through every guard. Either they get the same `raidStep`, or they leave the muster at go. That's R4's call, through squad.ts.
- **Known gaps for attempt 2:**
  - A straggler walks straight to the anchor, not along the route.
  - Melee with no step of their own (ranks 4-5, walls and roof) follow the ranged focus and stand under a wall they can't reach.
  - The lord phase's formation slots round the roof anchor may fall off the roof.
  - Nobody rezzes mid-raid: the raid never waits for the dead.
  - Hibernia's lord name is unseen (`/\bThidranki$/`).
- **Tests:** `tactics/raid.test.ts` (12): the board's guards and their picture gate, broken doors, raidStep (approach, assault, gate, broken), decideRvr at go and after, and breakDoor (placing, walk, swing, stand-down).

**Landed 02:47 (8197311): attempt 3's "nothing to hit in view" at every rank.**
- Hibernia's `withMakeUp` (groups/hibernia/rvr.ts:215-217) and Camelot's `withOurMakeUp` set `Orders.settings` to their own make-up patch, or to null, on every tick. That overwrote the raid patch, so the board never showed the guards: no focus, no lifted circle, no door. The squads don't wrap the decide that way, so they saw guards.
- Now `realmCalls`, the outermost wrapper, lays the raid patch over whatever the strategy returned while the muster says go. It returns one object while neither patch changes. After the go, the strategy's own patch is left alone.
- Checked with Hibernia's real `pack` strategy offline: the orders carry `settings.raid`.
- Test: `tactics/raid.test.ts` +1, which fails on the old code. No group file changed.

**Landed 03:24 (245e89e): attempt 6, the main groups dropped the muster at the first enemy in sight.**
- **Before:** `decidePack` handed the raid to calm only with no foe at all. With all realms out there's always one, so hibernia hunted and hibernia-2 sat resting.
- **Now, at the muster's go:** an enemy player matters only if it is on one of us or within 1500 of the body (`RAID_FOE_REACH`, tactics/raid.ts). Anyone farther off is no reason to stop the raid.
  - **Pack:** the raid goes on unless such a foe is near. The pack also lifts the raid keep's circle, as decideRvr does: before, a foe by the stage read as "in the keep" and didn't count.
  - **decideRvr (Albion's roaming):** no hunt and no fall-back while raiding. A player not on us and farther than 1500 is not fought.
- Tests: `tactics/raid.test.ts` +2 (decideRvr and decidePack: one at 3000 is passed by, one at 1200 is fought).

**Landed 04:25 (313dffe; R2's director side in 1b23d2e, live from the next field.ts start): the stage waits for the whole raid** (R1, run D 04:19: midgard staged alone and lost 4 at rank 1 while midgard-2 and the squads were 13000-18000 out).
- `raidStep` passes R5's `RaidView.raid` (ab6567c). It holds our own members as they stand, plus every other unit's members from the muster call's new optional `RealmCall.raid`: `{ unit, x, y, z, alive }[]` (`tactics/help.ts`, `raidMembers` in `tactics/raid.ts`).
- With it, a unit at the stage waits until 75 % of the raid's living within 12000 have come. Without it, nothing changes.
- **R2:** asked at 04:23 to write `raid` on the open muster call in director.ts: every BoardMember of each running unit in `call.asked`, each tick. Landed in 1b23d2e at 04:25, same shape (places rounded to 50). field.ts loads director.ts only when it starts, so it is live from R1's next field.ts start.
- Tests: `tactics/raid.test.ts` +2.

**Run D3, 05:00-05:47, observed only (the frozen window; times local, the units' logs read one hour earlier):**
- **Hibernia's raid at 05:30 came in three waves, and every wave lost.**
  - The go came with "7 of 13 at the rally". hibernia and hibernia-2 were rotating then (05:30:43 and 05:33:25), so only the squads were at the rally.
  - The squads s1, s2 and s3 walked the route (05:30:46-05:31:49) and stood 2300-2400 from the stage. At 05:32:22, about 10 Albion caught them at (36753, 38448), beside the stage, and they wiped by 05:33:31.
  - hibernia (new sortie, 23000 out) reached the stage at 05:37:18 ("1/6 at the stage") and went into rank 1 alone at 05:37:34. It wiped at 05:42 (14/6).
  - hibernia-2 went in at 05:44:56, on its own as well.
  - **Why the whole-raid wait didn't hold them:** the wait counts only members within 12000 of the stage (`RAID_COMING`), alive. A unit coming from the portal keep (~25000) doesn't count, and neither do dead ones, so each unit passed on its own count.
- **Midgard's raid at 05:14** (go at 13 of 18): every unit got caught in the three-way battle 2700-5000 before the stage. The director's call timed out after 974 s with nobody arrived. This is the 1500 reach working as intended (it fights who comes at it); nobody reached the keep.
- **hibernia-s4 (diarmuid, a Ranger alone) stood still 14 min on the approach** (05:30:46-05:44:36, stall at 05:35:51). It stayed about 730 from the route's first waypoint (29635, 33997), and its orders didn't change. The other three squads walked the same orders through in 1 min. The order logs don't show the member's reason; candidates are `slotWet` holding the bank, the column, and a pickup wait. Not found yet.
- **Carry-overs for after 10:00 (none edited now):**
  1. **The wait counts the units on their way.** `raidMembers`/`raidOrders` should count every unit answering the call, at any distance (or every unit the call asked), with a time cap so a dead unit doesn't hold the rest forever. R5 owns the `RAID_COMING` rule; R2 owns the director's go at 7 of 13 with the main groups rotating.
  2. **Squads don't lead.** A squad of 1-3 holds at a waypoint before the stage, e.g. (34500, 35200) on the Hibernian route, until a main group passes it. At an enemy-held keep, the stage itself is within the defenders' reach (the squads were caught next to it).
  3. **Find why hibernia-s4 didn't move.** Watch a solo squad's member reason (`ctx.skip`/`doing`) at the raid approach's first waypoint.

**Landed 10:08 (e80c2bf): the melee's own focus** (R1's ask from 08:45: midgard-2's Egil, Leif and Sigurd walked up the inside wall to wall-se's Wizard at 08:36). The interface was agreed with R5 ("R5: pathing inside the keep", item 3).
- **`Orders.meleeFocus`:** the focus for tanks and melee when it isn't the unit's. null means none: they hold at the anchor. It lasts one decide; an update that doesn't name it drops it (`Blackboard.setOrders`), so it can't outlive the raid.
- **`MemberContext.orders()`:** hands a tank or melee member that focus, before the skill lens (`sdk/group/melee-focus.ts`).
- **`raidStep`:** the unit's focus is the ranged half's. `meleeFocus` is `RaidOrders.melee.focus` when that's an NPC, otherwise null:
  - At the gate (rank 2), that's breakDoor's job.
  - On a rank with only wall or roof casters (rank 2 once the gate is broken, ranks 4-5), the melee hold ("; melee hold" in the reason).
- **The case at 08:36, landed 10:50 (2baafeb, on R5's d7bc5af):** "Wizard is on us", which `raidOrders` used to give the melee too.
  - `raidStep` now fills `RaidView.reach` from the living members' centre with R5's `meleeReach`. The shut doors count as walls: those not in the raid's broken list, unless the keep is ours.
  - Tested on the Faste's real navmesh: a wall-se Wizard on a member at the gate.
    - Gate shut: the casters take it and the melee hold (`meleeFocus` null).
    - Gate broken: the stair is a route, and the melee share the focus.
  - `bun test sdk/group` plus `navmesh-doors`: 2319 pass, 0 fail. All 23 guarded `rvr.ts` files import cleanly. Not seen live: field mode stopped at 10:30, so it goes live at the next stint.
- Tests: `melee-focus.test.ts` (4), `tactics/raid.test.ts` +1. `bun test sdk/group`: 2302 pass. The one failure was `siege.test.ts` while R5 was editing it, and it is green after 48fa6a4. All 23 guarded `rvr.ts` files import cleanly. Live from each unit's next sortie.
- **My mistake, 10:01:30-10:03:** my first import check also imported `groups/field.ts`, which has no `import.meta.main` guard. It started a second field mode, which pre-empted D3's camelot, midgard and hibernia sorties (10:01:43-10:02:23). I stopped it at about 10:03, and no stray process is left. camelot and midgard were back at 10:07:34, and hibernia's 5-minute wait ended at about 10:10. From now on I import-check guarded files only.

## R7: Melee and song kits

**Status (19:40 machine clock): all six kits written, tested offline, checked live, and in their bots' `character.ts`. None goes on the bench.** Commit 82b23fa (kits, tests, guides, the `spells.ts` edit) plus a second commit for the live fixes. Files: `sdk/classes/{mercenary,reaver,savage,champion,valewalker,minstrel}.ts` with tests, the shared `sdk/classes/hybrid.ts`, guides in `learnings/classes/<class>.md`, live checks `sdk/test/live/kits-r7-live.ts` and `kit-probe-r7.ts`.

**Characters (R6 handed them over at 19:15):** `bots/{lancelot,dagonet,agravaine,fergus,cathbad,bjorn}/character.ts` now `export default <kit>()`; each loads through `loadCharacter` with its lists. They play from R1's 22:30 window, when they join the benches. I don't control them after that; their sortie logs are my live check.

**Roles for `lineup.ts` (R1)**, the same as `roleForClass` gives:

| Class | Bot | Role | Kit in one line |
|---|---|---|---|
| Mercenary | Lancelot | melee | style pick only: back positional chain, a taunt style's damage as the plain swing at players |
| Reaver | Agravaine | melee | Disable/Viper stuns once per immunity, Vitality Siphon as an interrupt, Surge damage add in fights, a pulsing PBAE aura started on 2+ players and stopped near cc, damage proc between fights |
| Savage | Bjorn | melee | Clan's Call stun (behind) once per immunity, Kelgor haste and damage buffs in fights (3 % health each, above 60 %) |
| Champion | Fergus | melee | Frontal Assault snare, Blast of Defiance as an interrupt (like the Thane's Horn), Lumber snare on a runner, Enervation on enemy melee |
| Valewalker | Cathbad | melee | Stunning Blade (side) once per immunity, Kudzu haste in fights, Conceal Path snare on a runner, procs between fights; cloth, so not a front-liner |
| Minstrel | Dagonet | support | the support list mezzes and sings; Stunning Shout on a diver on our healer or on him, the Wail as an interrupt |

**Live checks:**
- **On the real characters** (read-only probe through MCP, 19:20): the server's style details have the shape the tests' fixtures assume, every spell the kits look for is known, and each kit's first pick at a player is what the tests expect.
- **On a throwaway stack** (`--name=r7`, four fights of 120-240 s: Albion Mercenary/Reaver/Minstrel/Cleric, Hibernia Champion/Valewalker/Druid, Midgard Savage/Warrior/Healer, all at 24 in the template): every kit behaviour fired and landed. Per fight: Reaver 2-8 lifedrain interrupts and 1-2 Surges; Champion 2-8 Blast interrupts, 1-4 Enervations, 1-2 Lumbers; Minstrel 3-5 Wail interrupts and 0-5 stuns; Savage 2-13 Kelgor buffs; Valewalker 1-2 Kudzu and a Conceal Path. Mercenary 922-2066 damage, best on its side three times.
- **Fixed from the runs:** the Reaver's Demolishing Aura is a pulse (a second cast cancels it, and it doesn't show among his effects), so the kit now keeps its own on/off and stops it when the fight ends or cc comes near. A snare that comes back immune waits 15 s, not 4.
- **Open, for the sortie logs:** positional stuns (Clan's Call from behind, Stunning Blade and Disable from the side) land rarely, as expected without a flank step; the Savage swings few styles (endurance is the first guess).

**One shared edit, landed in one write and import-checked (19:00):** `Spellbook.buffs()` (`sdk/group/spells.ts`) leaves out a self buff whose timer is longer than it lasts, and every Savage buff. `buff()` cast the Valewalker's haste (30 s, 120 s timer) and the Reaver's Surge (30 s, 150 s) between fights, so they were on their timers when the fight came; a Savage's buffs cost 3 % health every 15 s. The kits cast them in the engage instead. The only other class with such a buff at 24 is the Friar (Alacrity of the Angel, 30 s, 180 s), which the healer's buff needs already left out; nobody loses a buff they cast. Tests in `spells.test.ts`.

**A finding for R3 and the kit owners (not changed):** a taunt style's growth is damage like any style's (`StyleProcessor.cs:360-363` scales every style by GrowthRate, whatever its proc), and a player has no threat table. So the Skald and Berserker kits' `stylesFor` (no taunts at players) costs damage: Berserker's Provoke is his best value per endurance (23). My kits count taunts as damage at players (`withPlayerPlain`), and keep `fighterStyle`'s rule at monsters. Live, the Mercenary's styled swings were all Enrage (a taunt style) and it out-damaged its side.

**Bench by 04:30:** none benched. All six stay in play (sortie numbers under "Night's sortie logs" below).

**The Warden on her own (R1's ask for the user, 20:55): landed e4a1d36, live at hibernia-s1's next sortie.** The code is `lastStand` in `sdk/classes/warden.ts`, with tests in `warden.test.ts` and notes in `learnings/classes/warden.md` under "On her own". The import check passed for 90 group and character modules, and `bun test sdk/classes` passed.

Aine died at 19:51 UTC after Fionn died to the Highlander. With nobody to heal, she only kited (`flee`'s step with no tank), reached the river bank and died 75 s later.

Now, when no member of hers is alive within 2000 and an enemy player targets her:
- She swings at him, whatever the focus: Glowing Blade first, Taunting Blade behind it. Glowing Blade is a side style, so when he faces her she steps to his side, at most every 4 s.
- Once Glowing Blade has landed (14 s):
  - she heals herself from 450 away when below 70 %;
  - she fights it out if she is as healthy as he is, or he is at 30 % or less;
  - otherwise she walks 500 units away, choosing a direction that keeps her out of water.
- A caster on her from beyond 750: she heals herself from 800 away when hurt.
- In a group nothing changes.

**Open, for her sortie logs:** does the side step ever land Glowing Blade on a bot? A bot turns back to face its target within about 0.5 s. Look for `lastStand` results and "Glowing Blade perfectly".

### R7: night's sortie logs (read 05:50, observe only; carry-overs for after 10:00)

**Aine's `lastStand`, 13 hibernia-s1 sorties from 20:06 to 05:45 UTC (e4a1d36 loaded from the 20:06 one):**
- **It ran in 6 sorties.** Its swing reports as `melee`, so it shows as `Aine: melee: ...` in the logs (she has no other melee). The `lastStand` result shows only for its heal.
- **Glowing Blade never landed, and no style of hers did:** `styles {}` in every report.
- **Her swings were refused with "X is not in view!"** five times: 20:47:32, 20:55:58, 21:58:27, 23:40:34 (right after a `walk: timeout`) and 03:24:36. The server's melee needs the target within 120° in front of her as well as in sight (`WeaponAction.cs:389-392`). After the side step she faces the spot she walked to, not him.
  - **Carry-over:** face him after the side step and before each swing, or drop the step.
- **Three heals in 3 s, each `must_wait`** (21:38:51-53, the wait after an interrupted cast).
  - **Carry-over:** while the heal waits, swing instead.
- **`out_of_reach` three times** (Norseman at 218, Highlander at 1579 and at 679): he walked off and the swing chased him.
- **The deaths it didn't save** (8 deaths in those sorties):
  - Mostly she wasn't on her own: Niamh or Fionn was alive within 2000.
  - Or the squad's `retreat`, which ranks above it, took her. At 20:47:31 a caught fight, 1 vs 2: she swung for 5 s, then `retreat: flee` at 1 vs 5, and she died running 12 s later. That one is R4's caught rule.
- **No change during the frozen window.** Both carry-overs are in `sdk/classes/warden.ts`, and I'll do them after 10:00 unless R1 says otherwise.
- **Landed 10:18 in 8a0212a, live at the next stint** (R1, 10:10).
  - After the side step she faces him.
  - A heal refused with `must_wait` counts as none for its seconds (`healWaitMs`).
  - `bun test sdk/classes` passes (336), and the import check passes for 90 modules.
  - Not yet seen live. To check: "not in view" gone, and any Glowing Blade landing.
  - **Still open:** the Reaver, Minstrel and Savage carry-overs above.

**The six kits, 22:30 to 05:45** (observer reports of camelot, camelot-2, hibernia, hibernia-2, midgard, midgard-2; per sortie, against their units' other members):

| Bot (kit) | Sorties | Deaths / sortie | Dealt / sortie | What fired | What failed most |
|---|---|---|---|---|---|
| Lancelot (Mercenary) | 21 | 1.6 | ~2280 | Enrage 108, Shadow's Edge (back) 40, Eclipse 23 | melee out_of_reach 37, refused 34 |
| Agravaine (Reaver) | 21 | 1.9 | ~2480 | interrupt 211, aura 71, surge 59; Disable 12, Viper 2 | auraStop:cooldown 34, aura:pulse_cancelled 27 |
| Bjorn (Savage) | 18 | 1.3 | ~1950 | kelgor 376, Clan's Call (stun, behind) 41, Wild Call 101 | melee out_of_reach 62, stuck 27, water 25 |
| Fergus (Champion) | 17 | 1.6 | ~2910 | interrupt 194, snare 92, debuff 85 | snare resisted 26, immune 21, no_effect 20 |
| Cathbad (Valewalker) | 16 | 1.5 | ~2060 | buff 114, snare 72, kudzu 65; Stunning Blade (side) 18 | melee out_of_reach 53, snare resisted 32 |
| Dagonet (Minstrel) | 20 | 1.9 | ~240 | cc 147, song 110, interrupt 101, stun 88 | cc interrupted 77, immune 63, pulse_cancelled 38; song pulse_cancelled 35 |

- **Nothing to bench.** Damage and deaths are in their units' range. Camelot's other members died 1.2-2.2 per sortie, Midgard's 1.1-3.4, and Hibernia's 0.6-1.9 (Hibernia's own classes die least).
- **The positional stuns land:** Clan's Call 41 times, Stunning Blade 18, Disable 12. The 19:40 worry was that they would land rarely.
- **Carry-overs, after 10:00:**
  - **Reaver, `sdk/classes/reaver.ts`:** its aura on/off goes out of step with the server.
    - `aura:pulse_cancelled` 27: a start that found an aura already running cancelled it ("You cancel your effect.").
    - `auraStop:cooldown` 34: a stop while the aura's recast timer runs is refused, so the aura pulses on.
    - Fix: read the timer before a stop and wait for it, and check whether the aura is running before a start.
  - **Minstrel, `sdk/classes/minstrel.ts` and the support list's `song()`:** one song at a time.
    - A mezz or song cast while another pulse plays reads as `pulse_cancelled` ("You stop playing your song.", 73 in all).
    - Open: is the old song stopping, which is expected for a Minstrel, or the new one? Then count only a real loss.
    - Most of his cc failures are fight noise: interrupted 77, immune 63.
  - **Savage melee in water:** `melee:water` 25 and `melee:stuck` 27, the most of the six. The chase leads to a target standing in the river; that is the shared `assist`, not his kit.

## R6: Thirty new characters

### Status (19:15)
- **The 9 new classes are ready and handed over** (19:15): level 24, `/xp off`, promoted by `/player class`, trained by build.ts, in template gear at every cap (audit: no problems), bound at their portal keep and standing in Thidranki. Their clients run in R6's swarm (`bots/r6-swarm.log`) until R6 quits them before 22:30.
  - **To R7** (melee and song): Lancelot (Mercenary, "Pure damage": two swords), Dagonet (Minstrel, "Group thrust": dirk, small shield, and a template lute in the two-hand slot, held; Song of Energy played live), Agravaine (Reaver, "Flex, shield and tap": flail and large shield), Fergus (Champion, "Valor and Large Weapons": greatsword, no shield), Cathbad (Valewalker, "Scythe first"), Bjorn (Savage, "Hand to Hand first": a claw in each hand).
  - **To R8** (pets): Morgause (Necromancer, "Sight and servant split"), Etain (Animist, "Arboreal group"), Grimhild (Bonedancer, "Split Darkness and Suppression"). All three: cloth and a focus staff.
  - Their `character.ts` is the generic routine: `{ role }` only (melee for the five melee, support for Dagonet, nuker for the three pet casters), so the role's own list plays them. R7 and R8 own these files from now on.
  - Roles for R1's lineup are R7's and R8's to give; `roleForClass` already reads Mercenary, Reaver, Champion, Valewalker, Savage melee, Minstrel support, Necromancer, Animist, Bonedancer nuker.
- **The 21:** created, promoted, trained and in template gear at every cap (no problems). **In Thidranki and bound at their portal keep since 19:16.** Albion: Enid (Cleric), Gildas (Friar), Percival (Paladin), Gareth (Armsman), Elaine (Sorcerer), Blaise (Wizard). Hibernia: Amergin (Druid), Fiacra (Bard), Conall (Hero), Laoghaire (Blademaster), Deirdre (Mentalist), Emer (Enchanter), Manannan (Eldritch). Midgard: Eir (Healer), Groa (Shaman), Egil (Skald), Leif (Warrior), Vidar (Thane), Ivar (Berserker), Mimir (Runemaster), Freydis (Spiritmaster).
  - Each plays its class's kit and the build its classmate in the first thirty plays (`character.ts` copied; Egil, Vidar and Ivar without Midgard's `groups/midgard/plan.ts` behaviours, which are that group's).
- **"No training observed": not seen.** All 30 trained to target with `trainBuild(null)` after `/player class`, `/player level 24` and a relog (the fork's fix, learnings/builds.md).
- **Gear templates for the 9 new classes** are in `sdk/group/gear-template.ts` `CLASS_KITS` (+ test). New in it: an `instrument` kit field (the Minstrel's lute), the Flexible, Hand to Hand, Large Weapons and Scythe looks, and an off-hand sword.
- **19:20: all 30 done**, 1 h 40 ahead of 22:30. Each has 1p (as the first thirty, by `give-money.ts`). gmlevel is quit and back at PrivLevel 1; all 30 accounts are PrivLevel 1. Committed 45c62ca (gear template + learnings; `bots/` is untracked).
- **For R1 at 22:30:** the 9 run in `bun client/swarm.ts` from R6 (`bots/r6-swarm.log`), the 21 in a second one (`bots/r6-swarm2.log`). R6 quits both with swarm-check `--quit` before 22:30, or earlier when you say. The 21 stand idle at their portal keeps in Thidranki meanwhile; R7 and R8 drive the 9.
- How: `bun bots/gmlevel/promote.ts 24 Name:Class ...`, relog, `bun bots/gmlevel/thirty-setup.ts --steps=train|gear|bg --only=...` (N5's stealth-setup for the thirty).
- **22:20: all 30 logged out cleanly.** swarm-check `--quit` on both swarms, SWARM CHECK PASS twice, every client `exit 0, logins 1`, swarms done at 22:20:25 (`bots/r6-quit1.log`, `bots/r6-quit2.log`). Nothing of R6's runs now; the thirty are free for R1's window (benches, `GainRP = 0`).

## R4: Squads

### Landed (19:25 by the machine clock; live at each squad's next sortie, import check clean for all 12 squad folders, `bun test sdk/group` green)
- **e248afe, the stealth opener.** A hidden stealther's opening odds now count the target it would open on (soft, under 50 %, or no enemy player within 1000, as the kit's `softTarget`) at half its worth and head, and enemies over 1000 from that target at 0.6 (they come after the burst). The squad's focus goes to that target (`; open on <name>`). Two fighters side by side, or three, are still left alone; a caster with its friend 1500 off, two players 1500 apart, or a player with its pet are taken. The freeze: the three assassins kept clear of "1 vs 2, from stealth" 140 times and opened twice in 4 h. A hidden squad leaving a fight walks away hidden (a retreat order would show it to sprint).
- **e248afe, fleeing at full health.** A chosen fight is fought on through an add or two, but left at once when enemy players in view reach 2 × ours + 1 (`, N in view` in the flee's reason): a duo at 5, a solo at 3. The user's trio case (3 vs 6) still fights on. The commit hour: 14 squad deaths while fleeing, most of them a flee started only at 40 points down against a whole group (Aine and Fionn: "2 vs 2", then "2 vs 7" at 50 %, both dead in 13 s).
- **597eb2e, help calls.** Squads read R2's `callWatch` (squad-run.ts) and answer:
  - asked: `coming` unless the odds there with our realm's own counted (`callOdds`: us + `ours` at 0.8 each against `foes` by `foeRoles`) stay below 0.55, or it is over 7000 away, or we aren't ready (a member dead, health or power below `ready`); else `declined` with the reason;
  - unasked: only from within 5000, while `want` > 0, at 0.9 or better;
  - on the way: `travel`, reason `call: to <unit>'s fight (outnumbered, 2 vs 3), 4050 away, odds there 1.89`; the call's enemies are not kept clear of;
  - there (within 1500): `arrived`, and the fight there is one we chose, so it is fought out (`; at <unit>'s call`);
  - `left` when the odds there fall below 0.33 or after 90 s on the way;
  - a muster when asked: to the rally, held there ("waiting for go"), then to the target, into its keep circle;
  - `--squad.calls=false` turns it off.
  - A hidden solo assassin answers like any squad, walks there hidden, and opens by the opener rule above.
- **597eb2e, a throw in run A.** camelot-s3's coordinator threw `sq.fight.start` 38 times at 17:58 (log clock): the "beside N friends" reason on the first tick of a friend's fight, with no fight begun. Fixed, with a test.
- **df8851a, Hibernia's solos.** Most of their freeze losses were the Faste's guards: after each release a solo walked ~30000 straight to the patrol leg it had before it died (stepLeg walks on to an unreached leg). The navmesh's shortest way crosses the Faste's island: Diarmuid died so 8 times (10:41-11:42), Scathach 6, 4-8 min apart, "attacked by something unseen 1859 from Thidranki Faste". Now a leg over 6000 off is dropped and the patrol starts at its nearest waypoint. The safePath routes themselves stay 6000+ from the Faste.
  - **R3:** `rvr.ts stepLeg` has the same stale leg wherever a run goes on after a jump. Main groups start a fresh run after a wipe, so I left it.

### Findings
- **Scathach's Perforate Artery "failed" (13:08 on 11-12, hibernia-s2 field-20261112-130650.log).** The coordinator dropped the engage at 13:08:06: Norseman#418 left her contacts. At 13:08:08 the kit clicked the opener at a target still in reach on its own read, and no "perfectly" line came in 3.5 s, so no swing followed. The logs don't say who the Norseman was. Hodur stood 6000+ away, so it wasn't a Shadowblade hiding. The likely cause is a target that vanished (out of view or released) between the order and the click. For the kit owner (`sdk/classes/stealther.ts`, not mine): re-check the orders and the target in view right before `sendUseSkill`, and name a vanished target in the result, not "failed".
- **Run A so far** (18:53-19:12): no squad has started a new sortie, so every squad row up to now is 3b8c8ab, the baseline. The sortie line's `main <commit>` splits run A into before and after.

### R5: the raid interface, landed in 99934b5 (19:20)

Files: `sdk/group/siege.ts` (new) and `sdk/group/keeps.ts`. 46 tests, and `bun test sdk/group` passes (2234). Import check is clean for the 6 main groups and the 12 squads. Nothing calls it yet, so nothing changed live.

```ts
import { raidPlan, raidOrders, routeFrom, brokenDoors, inLordReach, type RaidView } from './siege';
import { KeepOwnerRead } from './keeps';

const plan = raidPlan('midgard');          // the Faste by default; { breakDoors: false } walks through the doors
plan.rally; plan.target;                    // R2's muster: { rally: plan.rally, target: plan.target } (the lord's spot)
plan.route; plan.stage; plan.inside;        // rally -> over our bridge -> stage; stage -> gate -> stair -> roof

const o = raidOrders(plan, {
  members,          // { id, x, y, z, alive }[]: the unit's (or the whole raid's) members
  seen,             // NPCs and door objects the members see: { id, name, realm, kind: 'npc'|'object', x, y, z, level?, isDead?, isPet?, targetObjectId?, doorId? }
  owner,            // ownerRead.owner('Thidranki Faste')
  broken,           // door ids seen broken: brokenDoors(plan, [{ text, at: member's spot }]) over the members' chat
  staged,           // true once the raid stood at the stage (keep it from the first 'assault')
});
o.phase;            // 'approach' | 'stage' | 'assault' | 'lord' | 'taken'
o.ranged; o.melee;  // { step, focus, stand }: casters and archers vs tanks and melee
```

- **approach / stage.** Each member walks `routeFrom(plan, itself)` to the stage. Those already there wait until 75 % have come.
- **assault, by rank.**
  1. The five outer fighters, fought at (35500, 38250) outside the gate.
  2. The ranged take the three gate-side wall casters from (34650, 38250), while the melee break the gate.
  3. The courtyard pair.
  4. The ranged take the far wall casters from the courtyard (33100, 38250).
  5. The ranged take the three roof archers from there.
  6. The melee break the keep door, and everyone takes the floor-3 fighter.
  7. The lord.
  - A keep guard attacking a member, or a fighter off its post, is everyone's focus first.
  - A half with nothing in the current rank stands with the other.
- **A door's focus is its object.** Attack it with `sdk.sendSetTarget(focus.id)` then `sdk.sendAttack(true)`, standing at `melee.stand`. `killNpc` won't take an object.
- **lord.** Everyone walks to `plan.roof` (32238, 38298, z 4592) with its z, and the client takes the stair. `inLordReach(plan, p)` tells whether a member or pet stands where he takes damage.
- **taken.** The keep is ours, and the raid is over.
- **A raiding unit sets `settings.raid = 'Thidranki Faste'`.** That lifts the Faste's circle from `keepDangers`, so routes, `holdFormation` and the keep-circle rules let it in. Off (absent) everywhere else, so nothing changes until R3 sets it.
- **The owner read.** `const owners = new KeepOwnerRead(252)`.
  - Feed it chat with `owners.seeMessages(sdk.getGameMessages())` and NPCs with `owners.seeNpcs(sdk.getNearbyNpcs())` (a group frame's `world` works too).
  - Read it with `owners.owner('Thidranki Faste')`, and pass `owners.owners()` as `settings.keepOwners`.
  - It lives in memory. To outlive a restart, persist `toJSON()` and pass it back to the constructor. The DB keeps the owner across server restarts, and a client that missed the broadcast learns it only by seeing a guard.
- **R1:** a capture happens only once the lord dies. Whoever runs the director or field.ts can keep one `KeepOwnerRead` per realm, fed by any member's chat. The broadcast reaches every client on the server, so one bot is enough.
- **Realm points off instead of a reset (R1, 19:30, the user asked "is there an rp off?"):** there is. `/rp off` (`rp.cs`) clears `GainRP`, and `GainRealmPoints` returns at once without it (`GamePlayer.cs:3636`). The command only works from level 40, but `GainRP` is a column of `dolcharacters`. So in the 22:30 window, with every client logged out: `GainRP = 0` for all 60 bots, and only Oisin and Brigid get their realm points set back under the cap. The others keep what they have and gain no more, so nobody reaches the cap again. Realm points are no measure tonight.
- **Realm points off, done at 19:23-19:30 (the user: "do it now").** Run A stopped, the 30 clients quit cleanly, `GainRP = 0` for all 30 (checked: 30 rows), and Oisin and Brigid set to 7000 realm points, realm level 9. The swarm came back with 30/30 in game. Oisin and Brigid went through Druim Ligen (bound, medallion) into Thidranki. Run A restarted at about 19:31 on the same command. **The 30 new characters get `GainRP = 0` in the 22:30 window,** when R6's timer has logged them out. They're near 0 realm points, so the cap can't reach them before then.

### R5: status 19:35 (commits 99934b5, 167dc8a, 8ba7970, 260a206; all on the throwaway, the shared server untouched)

- **The routes, walked live.** One level-24 bot on my throwaway walked each realm's route.
  - Albion: rally to stage in 63 s, over its bridge at running speed.
  - Hibernia and Midgard: walked in reverse, the same legs.
  - None swam, and no guard came for it on any of them.
  - The stage held at full health with L33 Midgard guards in the keep.
- **Ownership read live.**
  - On the shared server, from 58 bots, the Faste reads **Albion's, by its guards** (19:21).
  - On the throwaway, a GM's Albion capture was read **4 s after it happened**.
  - `bun sdk/group/siege-watch.ts` gives a one-shot read; `--watch=<s>` keeps it going; `--state=<file>` keeps the reading across runs. To embed it: `watchOwners()`.
  - It observes only, so it never takes control. A full sweep of all bots runs at start and every 5 min, for the guards in view. Between sweeps, 3 bots (one per realm) are read every 5 s for the broadcast. A bot's state is ~80 KB, and a client keeps 100 chat lines.
- **The keep level, checked.**
  - With `starting_keep_level=1` set on the throwaway, a capture brought the lord back at L33 and left the keep at level 1.
  - With the default 4, the first capture made him L38, and the guards that came back were L33. One of those Huscarls hit my starter-clothed bot for 279 a swing.
  - **R1, the user's call before the probe:** `bun run server:setup --set starting_keep_level=1`. It restarts the gameserver, so do it in a stop window. Without it, the first capture at 02:00 makes every later raid face L33 guards and an L38 lord.
- **Wiring for R1 and R2 (the director's muster):**
  ```ts
  import { raidPlan } from '../sdk/group/siege';
  import { watchOwners } from '../sdk/group/siege-watch';
  const owners = watchOwners();   // once per process; owners.stop() at the end
  startDirector({ realm, units, enabled, raidPlan: () => raidPlan(realm), targetOwner: () => owners.read.owner('Thidranki Faste') });
  ```
  - `raidPlan(realm)` has `rally` and `target`, the director's `RaidPlan` shape.
  - R2's 70 % within 2250 of the rally fits: each realm's rally stands on its own bank, 6800-8000 from the centre.
- **For R3:** at the muster's 'go', `at` is the lord's spot. **Don't walk to it:** the straight way runs through every guard. Run `raidOrders(raidPlan(realm), view)` instead, and walk `routeFrom(plan, member)` while the phase is approach or stage.
  - The door objects aren't in group frames (`world` has NPCs and players only). The melee members find the door with `sdk.getNearbyObjects().find(o => o.doorId === orders.melee.step.doorId)`.
  - They feed `The Keep Door is broken!` (their own chat) to `brokenDoors`.
- **Probe, 02:00 (R1, R3 and me).** I'll run `siege-watch --watch` and log each step: phase, losses, and the time per rank. I need from R1 the realm that goes first and whether `starting_keep_level` is set, and from R3 the switch that puts the main groups on `raidOrders`.
- **R1, 20:00: the raid wiring and the gateway.**
  - **e6d3866:** the gateway's `contactOf` keeps `classGuess`, so the director's `foeRoles` see every role (R2's known gap). The 168 gateway tests pass. It goes live with the gateway restart in the 22:30 window.
  - **field.ts** passes `raidPlan: () => raidPlan(realm)` and `targetOwner` (one `watchOwners()` per field.ts) to every director. New flags: `--raid-every=<min>` (`raidEveryMs`) and `--muster=<realm,...>` with `--muster-after=<min>` (default 4) for a one-off muster. Ledger rows: `raid` for each stage, and `keep` (group `battle`) for each owner change.
  - **The probe at 02:00:** Hibernia goes first (Albion holds the Faste), then Albion takes it back. Command: `bun groups/field.ts --groups=hibernia --mix.hibernia=6,6,3,2,1,1 --director=on --muster=hibernia -- --skill=average`. The other two realms stand where field.ts left them.
  - **`starting_keep_level`:** I've put it to the user; the answer goes here. A gameserver restart can only happen in the 22:30 window.
- **`starting_keep_level=1`, the user's decision (about 20:05).** R1 sets it in the 22:30 window with `bun run server:setup --set starting_keep_level=1` (a gameserver restart, with every client logged out). Every capture tonight then meets L28 guards and an L33 lord.

### Run A, first half hour each way (20:05)
R1 restarted run A at 19:28 for the realm-point reset, so it splits cleanly: 18:55-19:23 on 3b8c8ab (old squads), 19:28-19:58 on db6bc19 (e248afe, 597eb2e, df8851a). The director isn't writing calls in run A, so no call was answered.

| Squads | Fights | Won | Lost | Kills | Deaths | Fled | Died fleeing |
|---|---|---|---|---|---|---|---|
| Old, 28 min | 37 | 12 | 11 | 22 | 17 | 16 | 8 |
| New, 30 min | 41 | 19 | 16 | 25 | 18 | 15 | 8 |

- By realm, new: Midgard 10 won 5 lost (old 1 and 5), Camelot 7 and 4 (7 and 1), Hibernia 2 and 7 (4 and 5). The samples are small.
- **Dying while fleeing didn't drop.** The overrun break fired 4 times. Most flees still came after a loss ("health 100 to 56 %", "Tuck died"): a solo or duo against 3-4 in view at once, or the add came while already hurt.
- **The Faste again:** squads were hit by its guards 11 times in the new half hour, not after a release this time. Hodur's straight patrol leg from Midgard's road to Albion's road passed 5740 from the Faste, beside the bridges (4600-6000 out), and the walk went over the island. **db530b8:** squads now keep 7000 from a keep that isn't ours (4500 while answering a help call, so a call by the meeting point, 6300 out, stays reachable). Checked offline: the safePath routes and the navmesh walks between their legs stay 6900+ out.
- **The opener:** "open on" fired twice, both times pulling a hidden stealther off a target its friends were on (a Troll at 47 %, a Highlander at 5 %). **030d301:** the opener's pick now replaces only a focus the kit wouldn't open on. No opener was clicked in this half hour.
- db530b8 and 030d301 go live at the next rotation (about 20:13). Next look: 21:15.
- **R1, 20:45: an enemy Necromancer is invisible to our units (the user saw two Hibernians walk past Morgause).**
  - Morgause stood idle in shade with her necroservant at (21787, 43314), left there after R8's check.
  - **Why:** a shade is `untouchable` (blackboard.ts:435), so it's no focus, no enemy and no count. Its servant is a pet, and pets count only with `threat` (squad.ts:534) or not at all (pack.ts:307 `players(c)`, and squad.ts's `!c.isPet` counts). So a Necromancer nobody has been hit by counts as nobody.
  - **What a player does:** a Necromancer in shade is its servant. Kill the servant and the Necromancer drops out of shade at 10 % health.
  - **Wanted for run B, where Morgause plays in Albion's units:** a pet whose owner is a shade counts as that enemy player for focus, counts and sizing-up. **R3** owns the board-side mark and the main groups (pack.ts, rvr.ts); **R4** owns squads (squad.ts). R8 knows the shade's rules (`learnings/classes/necromancer.md`). Check with a unit test that a shade's servant becomes a focus and a head.

### R4: a Necromancer in shade (R1's ask, 20:45), landed 6f9e921
- **Squads** count an enemy shade's servant as that Necromancer (`squad.ts withServants`). It becomes a player with the shade's class read, level and caster sign, and the servant's id, place and health, ahead of every count, the focus, the opener and the inner decide. The shade itself stays untouchable and is counted nowhere, so a Necromancer counts once.
- **The field:** `servantOf` (the shade's objectId) on the pet, as R3's board writes it (blackboard.ts `picture()`, `servantsOf`/`shadeBodies`, uncommitted at 21:00). Squads take a marked pet first; with no mark, the pet of the shade's realm nearest it within 2000 (the bond breaks past 1500). Once R3 commits, `withServants` can become a call to `shadeBodies`.
- **Tests:** a duo engages an idle shade and focuses its servant; a solo leaves two Necromancers alone; a hidden stealther opens on the servant; a marked pet wins over a nearer one. The 2248 sdk/group tests pass, and all 12 squads pass the import check. Live at each squad's next sortie.

### R4: the Hunter's pet while hidden (R1's ask for the user, 21:00), landed 259fe32
- **Live check first** (`bun sdk/cli.ts skadi`, observing only, 20:55): Skadi read "Hidden" with her hunter's protector out 118 off, fighting a perturbed bwca. So yes, the pet was out beside a hidden Hunter.
- **Now, in `sdk/classes/hunter.ts`** (pets.ts untouched):
  - `stowPet` (instant, after `hide`): hidden with a pet up, release it.
  - The kit's own `summonPet`: only out of stealth and in a fight (orders `engage`, in combat, or a threat within 1500), with no pet up and the summon ready. That covers the first arrow, or being found. `withPets` keeps it in place of `pets.ts`'s, whose gate refuses near any threat anyway.
  - No quiet summon and none walking back from a release (`summonOnTheWayBack` is replaced by a no-op): the next hide would release that pet, and the 120 s recast would miss the fight.
  - `petControl` still sends the pet at the focus.
- 4 new tests (`hunter.test.ts`), 320 class tests pass, and Skadi's character.ts loads `hide, stowPet, summonPet, summonOnTheWayBack`. It goes live at midgard's next squad sortie with Skadi.
- **Not seen live yet:** whether a release while hidden keeps the stealth (pet commands shouldn't break it), and the first summon mid-fight. Her next sortie log will show "release" and "summon" lines.

### R4: what the user watched at 20:48-20:51 (camelot-s1 against hibernia-s1), landed e0e23b7
- **Engaging from out of reach.** camelot-s1 flipped engage and hunt 25 times in 100 s (log 19:49:12-19:50:51). The inner decide keeps a threat or its focus as a fight out to engageRadius + 1000 (3000 for squads). The board keeps a runner's last target on us, and the Hibernian duo walked off at 2400-3900, so every crossing of 3000 flipped the order. Gawain chased on each engage, and Tuck fell 2000+ behind ("gather: meeting Gawain").
  - **Now:** a new engage on a focus beyond engageRadius (2000) is a hunt, `hunt: close on <name>, N away, engage within 2000`, walked together. Once engaged, the inner's 3000 holds. The 2000-3000 gap is the hysteresis, and with no chase from far off the duo stays together.
- **The 3 s flee (hibernia-s1 19:50:02 engage "1 vs 2", 19:50:05 flee at "0.36 (2 vs 3)", no losses).**
  - **Why it wasn't held:** whether a fight was chosen was judged on its first engaged tick, one tick after the engage. The engage came from the squad's judgement of Highlander#459's group alone, while the fight's own reading a tick later counted everyone within 3500 of us, two remembered Albions included. 0.36 < 0.9, so not chosen and not committed, and below 0.55 it fled.
  - **Now:** a fight the squad lets the inner decide start (from no fight) is chosen at once. It is committed against players, so it's left only on our losses or a whole group in view (2 × ours + 1).
- **Caught after a death (hibernia-s1, Fionn died 19:51:25, the order still "caught: fight" at 19:52:14).**
  - **Now:** a caught stand records our health and dead when it begins. A new death or 40 points of health lost ends it, and the odds then say flee or fight. Against one enemy player with no safety near, that's still fight (it runs as fast as we do), but the order no longer reads "caught".
- **The focus switching** between Celt#464 and Celt#471 by whichever friend stood nearest: the focus we're on is now held while a friend is on it too.
- 4 new tests, each failing on the old code. `bun test sdk/group` 2256 pass, and all 12 squads pass the import check. Live at each squad's next sortie.

### R4: "Fionn just let Aine die" (hibernia-s1, log 20:00-20:02), landed cd0d550
- **Why:** after the flee at 20:00:22 the duo stood 2009-2085 apart, on the inner decide's own gather line (gatherRadius 2000 from its lead, no hysteresis). The order flipped "gather: meeting Fionn" and "patrol" every second, so neither walked to the other, and Aine's heals failed out_of_range. At 20:01:25 the squad engaged Briton#462 still split, and Aine died alone at 20:01:34 casting Regrowth. Gawain and Tuck at 19:49 had the same root.
- **Now:** a squad whose living members are more than gatherRadius apart gathers toward the middle of them and holds it until they're within 700 (`gather: Aine and Fionn 2050 apart, together first`). No patrol, no call and no new engage come in between. A fight already on, or an enemy on one of us, isn't interrupted. The inner's `holdObservedFar` does the same for an observed human.
- 1 new test, `bun test sdk/group` 2257 pass, and all 12 squads pass the import check. Live at each squad's next sortie.

### R4: the bwca camp (midgard-s1 20:08:21, Aine 19:33), landed 3c2aabd
- **Why, not quite as asked:** `safePath` already routes round every aggro zone (`terrain.ts avoidIndex`: aggroZones, aggro range + 300), so adding the camps to `avoid` alone changed nothing. Its routes passed the bwca camp by only 236-275 beyond that 800 edge, the ~280 learnings/squads.md listed as open. A trio walking spread out crossed it. The patrol's legs are planned by the inner decide (`rvr.ts:624`, `avoid: keeps`), not by squad.ts's trip.
- **Now:** the squad's own legs avoid `campBerth` (the same camps + 700). A leg route the inner decide planned through a berth is planned again with it, once per goal, and the inner keeps it (same kind and goal); the reason ends `; round a camp`. Offline: 729-794 beyond the edge, about 1030 past real aggro range, for about 500 more walk on a 34000 leg.
- **R3:** main groups take the same legs (`rvr.ts:624`). `avoid: [...keeps, ...campBerth(regionId, level)]` there would cover them; `campBerth` is exported from squad.ts.
- 1 new test (a leg from (33000, 25000) to (24852, 24436) stays 600+ beyond every camp edge over two ticks; 236 before). `bun test sdk/group` 2266 pass, and all 12 squads pass the import check.

### R4: run A at 21:15, squads per hour
| Window (code) | Fights | Kills | Deaths | Fled | Died fleeing |
|---|---|---|---|---|---|
| 18:55-19:23, old (3b8c8ab) | 79 | 47 | 36 | 34 | 17 |
| 19:28-20:13, e248afe/597eb2e/df8851a | 75 | 47 | 33 | 28 | 15 |
| 20:13-21:15, + db530b8 (7000 from the Faste), 030d301 | 50 | 18 | 23 | 25 | 7 |
- **Faste guard hits** went from 11 in the half hour before db530b8 to 2 in the hour after. Deaths while fleeing halved.
- **Kills fell more than deaths** in the last hour (K/D 0.8, against 1.3-1.4 before), and fights fell by a third. I can't separate the causes from one hour. The 7000 berth keeps squads off the ground round the Faste and the meeting point's south side, and every realm's squads and main groups changed in the same hour. To watch in the next hour: whether fights per hour stay at 50.
- **No stealth opener was clicked** by an assassin in the hour ("open on" twice; the 16 "opener" lines are fighters' style openers on bwca). The opener odds let the assassins engage, but the kit lurks unless the target is soft or alone.
- e0e23b7 (engage within reach, chosen at start, caught re-judged, focus held), cd0d550 (gather until together) and 3c2aabd (camps) went live at the 21:02-21:10 sorties, too late for this table. Next look: 22:15.

### R4: run A at 22:15 (squads, per hour), and what it showed
| Window (code) | Fights | Kills | Deaths | Died fleeing |
|---|---|---|---|---|
| 18:55-19:23, old | 79 | 47 | 36 | 17 |
| 19:28-20:13 | 75 | 47 | 33 | 15 |
| 20:13-21:10, + 7000 Faste berth | 44 | 18 | 20 | 6 |
| 21:10-22:14, + e0e23b7, cd0d550, 3c2aabd | 69 | 30 | 30 | 15 |
- Fights per hour are back near 70; K/D is 1.0. In the last window: "hunt: close on" 2, "together first" 7, "round a camp" 20, overrun flees 12, no TypeError.
- **Skadi's pet (259fe32) works live:** "Skadi lost hunter's protector (released)" at 20:53, 20:56 and 20:59 log clock, each on hiding. No summon in a fight yet.
- **"Attacked by something unseen N from Thidranki Faste"** needs care as a measure: most of the 21 since 21:10 were 6850-8500 from the Faste. That's an attacker out of view, a stealther or an archer, not the guards; the line names the nearest keep. Real guard hits: 2, both hidden stealther solos (Scathach 22:12, Hodur 21:48) on the leg (24852, 24436) to (37535, 45102), whose straight line passes the Faste. Offline, the same decide plans a route 7000+ out (7263 and 7098), and so do the navmesh walks between its points. So the plan is right and the walk went straight. **Open:** a read-only watcher (`faste-watch.ts` in my scratchpad: each stealther squad's orders anchor and its member's walk destination every 3 s) runs until 22:50 to catch where the two part.
- **79870b7, the waypoint flip:** midgard-s2 flipped "patrol to waypoint 7" and "waypoint 8, round 2 groups" every second for 90 s (log 20:45:30-20:46:59). The skip past blocked waypoints picked the waypoint Hodur stood at. Now a waypoint within 1500 is no way on for that skip.
- **abeb482, the "failed" opener, explained:** Hodur's at 20:18:27 (log) matched Scathach's at 13:08. In both, the engage dropped 2 s before the click as the target left view, very likely the other realm's stealther hiding on sight. (I said at 19:25 that Hodur was 6000+ away at 13:08; those were distances to a waypoint, not positions, so that was wrong.) The kit (`sdk/classes/stealther.ts`, which nobody owns tonight, so I took it) now re-reads the target in its own client right before the click and lurks if it's gone or hidden.
- **The 22:30 window, as run (R1, 22:24-22:34).** Run A stopped at 22:24 and its 30 clients quit cleanly (30 exit 0). R6's thirty were already out at 22:20. `GainRP = 0` for all 60 (60 rows), and none is at the cap or outside Thidranki. `starting_keep_level = 1` was set and the gameserver restarted (logins after 84 s). The gateway restarted with e6d3866 (classGuess in contacts). The thirty went onto every unit's bench (each unit's members plus bench = its realm's 20). The 60-bot swarm was in game at 22:28 with loop lag max 3 ms.
- **Run B started at 22:28:** `bun groups/field.ts --mix=6,6,3,2,1,1 --director=ab --swarm-log=groups/stint-swarm.log -- --skill=average`. All 18 units sortied by 22:34. First slot: the director on for Albion and Hibernia, off for Midgard. The first calls closed by 22:34: camelot's "caught" call was answered by camelot-2, which arrived. Midgard's shadow calls were logged with nobody asked.
- **The Faste watch (22:23-22:48, read-only, 2813 samples of camelot-s3, hibernia-s2/s3, midgard-s2/s3):** no Hibernian or Midgard stealther, and none of their walk destinations, came within 4000 of the Faste. Only Mordred passed it, by design: the Faste is Albion's, so it's no circle for him. The straight walk of 21:48 and 22:12 didn't recur in that window. **Still open:** if it shows again in run B, the watcher (`bun <scratchpad>/faste-watch.ts <units...>`, a copy can go in `groups/`) shows whether the coordinator's anchor or the member's walk leaves the route.

- **Run B, 22:28-01:54 (R1):** 60/60 in game the whole run; swarm 37 % CPU with lag ≤ 4 ms, gateway about 30 %, gameserver about 40 % and 4.3 GiB. Its log is kept as `groups/stint-field-runB.log`. Run C (02:05-02:10, all realms, between attempts) is `groups/stint-field-runC.log`.
- **The probe, as run (R1, 01:54-03:52).** Eight field.ts starts, logs `groups/stint-probe<N>.log`. R5's sections below have the details.
  - 1: `--groups=hibernia`, no raid orders. 8 dead to the guards.
  - 2: `--mix.hibernia=8,8`, no squads. Stuck at the stage (R5's 600 radius).
  - From attempt 3 on, every realm plays, so nobody stands idle in the field. Attempts 1-2 left the other two realms idle where run B ended, and Hibernia stalked them instead of raiding.
  - 3: the gate, but the pack saw no guards (R3 8197311).
  - 4: the lord to 43 % (R5 8ca5569, 9b16e04).
  - 5: an already broken door (7cce1a1).
  - 6: the mains dropped the muster for far players (R3 245e89e).
  - **7: Hibernia captured at 03:38:48.**
  - **8: `--mix.camelot=8,8,2,1,1 --muster=camelot`, Albion back at 03:51:06.**
- **Run D, integration, from 03:53 (R1):** `bun groups/field.ts --mix=6,6,3,2,1,1 --director=on --raid-every=30 --muster-after=3 --swarm-log=groups/stint-swarm.log -- --skill=average`, log `groups/stint-field-D.log`.
  - field.ts now keeps the raid rhythm itself, not the director's `raidEveryMs`: a muster 30 min after the realm's last one ended, the first ones a third apart (Albion +3, Midgard +13, Hibernia +23 min).
  - A realm that holds the Faste skips its turn, and so does a director that is off.
  - The director A/B ends here: run B (3 h 26 min, slots of 20 min) is the help-call comparison. The frozen window runs with the director on, since an off director's units never see a muster.
- **Carry-over (R1, 08:40, the user watching D3): the keep walls block no line of sight.** The user saw the wall Wizards cast down at our bots through the narrow slits between the stones. The server asks the target's client for an NPC's LoS (0xD0, `client/session.ts` losClear), and ours answers from the terrain heightmap only (`sdk/vision.ts` lineOfSight). Keep walls and buildings aren't in it, so every guard cast through stone is answered clear, and so are our casts at the wall guards. A real client tests the wall geometry. Fix after 10:00: measure a real client's answer at the Faste first (the recorder), then add the keep's wall fixtures (the navmesh build has them) as occluders for LoS and for human vision.
### R5: the Faste probe, attempt 1 (Hibernia, 01:58-02:04, field.ts `--muster=hibernia`, no raidOrders yet)

Read live with `siege-watch --watch` (owners) and an observe-only log of every Hibernian's state each 10 s (place, dead, guards at their posts, the phase `raidOrders` would give).

- **Muster: 3 min 6 s.** It began at 01:58:37 (rally 28454, 32768) and went at 02:01:43 with 16 of 19 at the rally.
- **The 'go': 8 dead in 51 s, no guard touched.** Scathach went down at 02:02:13, then Fionn, Niamh, Cuchulainn, Aine, Ciaran, Diarmuid and Brigid by 02:03:04. Each kill line reads "killed by Wizard / Armsman / Armswoman in Thidranki Faste". Every guard stayed at 100 % throughout, so nobody hit back.
  - **Why:** the go walks the straight line from Hibernia's rally toward the lord's spot. That line crosses the north-west wall, inside the aggro of wall-nw and wall-n (Wizards, 1850), the roof Scouts (2100) and the yard Armsmen. The board leaves guards out (R3's note, `blackboard.ts:332`), so units neither focus a guard nor defend against one.
  - **Fighters follow.** An Armsman and an Armswoman left their posts after the body (seen off-post at 02:03:01). The dead released to the portal keep, and by 02:03:21 the body was back near the rally.
- **Owner:** albion all the way (guards, 60 bots), as expected.
- **Fixed during the attempt (39669cc, `siege.ts` only):**
  - Before the muster, Hibernia's body was roaming 2600 south-west of the keep. `raidOrders` read that as "past the stage" and called the assault from the wrong side. Past the stage now means on the corridor from the stage to the keep, or inside the walls (`pastStage`).
  - A Hastener at the gate matched an outer post. Peaceful and untargetable NPCs are no guards now.
  - 54 siege tests pass.
- **For attempt 2 (R1, R3):** a 'go' without `raidOrders` plus guards on the board costs about 8 bodies a minute for nothing. Hold the go until R3's switch lands.
  - With the switch, each member walks `routeFrom(plan, itself)`. Hibernia's route goes east along the north bank to the stage at (36300, 38300), outside all aggro (walked dry on the throwaway).
  - After that it is rank by rank. The first fight is the 5 outer fighters at (35500, 38250), out of the casters' reach.
- **Attempt 1 in total (R5, 02:10):** the director ended the muster as `broken` at 02:04:51, 3 min 8 s after the go. Hibernia lost at least 14 deaths across 8 characters. Wave 1 was 8 between 02:02:13 and 02:03:04. Wave 2 was 6, between 02:04:41 and 02:05:12: Niamh, Aine, Fionn, Ciaran, Cuchulainn and Scathach, who died again after walking back in from the portal keep. Every guard was still at 100 % at the end. The 10 s samples miss a death and quick release between them (Brigid's shows only in chat), so 14 is a floor. Field mode stopped at 02:09:44.

### R4: squads at the muster's go (R1's ask, 02:10), landed 3207f5d at 02:13

- **What changed:** a squad answering a muster at `'go'` now raids as the main groups do. It no longer walks straight at the lord's spot (`callGoal`). The squad sets `memory.help` and `memory.realmCalls` to that muster, which is what R3's `raidNow` reads. Its inner decide (`decideRvr`) then runs `raidStep`: our own bridge to the stage (`routeFrom`), then rank by rank, with the raid patch in `Orders.settings`. With the patch on, the board shows the keep guards and the keep's circle is lifted.
  - The squad's own judgement of enemy players still runs first: it flees from a group it wouldn't take, and keeps clear of one.
  - Its own legs (flee, avoid, close) lift the raid keep's circle too.
  - Once staged, it no longer gathers, because the ranged and the melee stand apart by the raid's orders.
- **Doors:** the squads' tank and melee lists carry `breakDoor` (`withRaid` on `squadRoaming`), as the mains' do.
- **End:** when the go ends, the patch goes as `settings: null`, as R3's `realmCalls` does it, and `memory.help` is cleared.
- **Fallback:** a go the squad can't raid is left, with the answer `left` and the reason "no raid plan for its keep here". That covers no plan for our realm, another region, or a muster target more than 3000 from the plan's lord spot.
- **Tests:** `squad.test.ts` has 65. At go, a Hibernian duo at the rally travels to `routeFrom`'s next waypoint with `settings.raid`, not to the lord. A closed muster gives `settings: null`. Tank and melee carry `breakDoor`. A go with no plan here is left.
- **Live:** at each squad's next sortie after 02:13. The import check is clean for all 12 squad folders.

### R5: the Faste probe, attempt 2 (Hibernia as two groups of 8, R3's baf78da, 02:11-02:32)

- **Muster: 4 min.** It began at 02:12:57 and went at 02:16:57 on the 4-minute rule, with only 8 of 16 at the rally.
- **hibernia never raided.** From 02:12:54 to the end it stalked an Albion pack (Briton#445, 4 together) at about (39500, 31600), 1588 away. The pack picks enemy players over the muster. Those were probably field bots left standing after run C stopped.
- **hibernia-2 raided as designed, up to the stage.**
  - It took Hibernia's route and passed (31176, 35533) and (36000, 36500).
  - By 02:17:56 it was staging at (36300, 38300), with no deaths and no aggro on the way.
- **Then it stalled 14 min at "5/8 at the stage",** with its centre 320 from the stage. The director ended the muster at 02:31:57 (`timeout`, 1141 s), and the unit went back to its patrol. It killed two Albions there with no losses.
  - **Cause, mine:** `raidOrders` counted a member at the stage only within 600 of it, and wanted 6 of 8.
  - The anchor and the facing point were both the stage, and with an enemy in sight the pack's `spreadOnSight` widened the formation. That fanned three casters out beyond 600 (my reading; I have no per-member positions from the stall).
  - **Fix in e0eece9 (`siege.ts`):** `STAGE_NEAR = 1000`. The outer fighters' posts are 1600 or more from the stage, with aggro 1000. Also, once the body's centre is within 600 of the stage, the stage wait ends. 64 siege and raid tests pass, and the import check is clean.
- **Losses: none.** No guard was fought, and the owner is still albion.
- **For attempt 3:**
  - Start rvr.ts again so the units load e0eece9; a running unit keeps its old imports.
  - Clear the Albions standing to the north-east first, or both groups will hunt them.
  - From the stage, `raidOrders` sends rank 1 against the 5 outer fighters, standing at (35500, 38250).

### R5: the Faste probe, attempt 3 (Hibernia 8,8,2,1,1 with squads raiding, all realms playing, 02:34-)

- **Muster: 1 min 40 s.** It began at 02:37:02 and went at 02:38:42 with 8 of 11 at the rally. hibernia, hibernia-2, s1, s2 and s3 all took the raid.
- **hibernia, from its run events:** it walked the route to "2382 to the stage" by 02:39:41. At 02:39:57 it went straight to "assault rank 2: ranged wall-se, melee gate", without staging, and then to the gate.
  - **8 died between 02:40:15 and 02:41:00:** Laoghaire, Deirdre, Amergin, Manannan, Cathbad, Emer, Fiacra and Fergus. The run went "broken pack: running" at 02:40:44.
  - **Cause 1, mine (fixed in c43ed13):** e0eece9's 1200-wide corridor counted Hibernia's last leg into the stage as past it. `pastStage` now needs the body within 600 of the stage-to-keep line and at least 15 % of the way in (or inside the walls), and the tests check every route leg. Also, when no guard at all is seen, no post counts as gone.
  - **Cause 2, open for R3:** hibernia's `raidStep` saw no keep guards from 02:39:57 to 02:41:55 ("nothing to hit in view" at every rank). Every guard was at its post the whole time; my observe-only log saw them at 100 %.
    - I replayed the live Hibernian states offline (observeState, Blackboard.publish, setOrders with settings.raid, then rvr.ts:874's filter). All 18 guards came through, each matched to its post. The code is right, and something in the live pack run drops them. My suspect is `orders.settings.raid` on the board.
  - So with no guards, every post within 2500 read as gone.
- **Squads s1 and s2** do see guards ("Armsman is on us", "rank 1: ranged: outer-armswoman" with a focus), but alone they die at rank 1. s2 lost everyone at 02:43:55.
- **Owner:** albion throughout.
- **Fix during attempt 3 (2afeaf0, R5, 02:48):** after the gate, hibernia regrouped by its rally and read "assault rank 1". raid.ts keeps `staged` once set, so the unit would have walked the straight line from home to the rank's stand, past the north side's fighter and wall caster. `staged` now holds only while the body's centre is no farther from the keep than the stage plus `STAGE_NEAR`; a body that fell back walks the route again. 133 tests pass. Units need a restart to load c43ed13 and 2afeaf0.
- **Attempt 3 ended (R5):** the director closed the muster as `broken` at 02:48:48, after 706 s, with 3 foes against our 8. Squads s1 and s2 kept going in alone at rank 1 until then; s1 lost everyone at 02:47:34. R3 fixed the missing guards in 8197311: the realms' make-up wrappers had overwritten the raid patch on every tick. Attempt 4 runs on 8197311, c43ed13 and 2afeaf0.

### R5: the Faste probe, attempt 4 (8197311, c43ed13, 2afeaf0; 02:49-)

The first real raid. The guards reach the board now (R3's 8197311).
- **Muster: 26 s.** It began at 02:52:05 and went at 02:52:31 with 13 of 16 at the rally. hibernia-2 crossed the route in 40 s (Bard speed), with no aggro.
- **Rank 1: the 5 outer fighters fell between 02:53:51 and 02:54:38.** The rank-1 stand (35500, 38250) is 1613 and 1630 from the two east wall Wizards (reach 1850), so they joined in, and the "on us" rule killed three Wizards by 02:54:37.
- **Rank 2: the gate (5200 health) broke at 02:57:13,** after about 2.5 min of 3 melee at 23-31 a swing. Seven casters already stood in the courtyard meanwhile, since nothing stops anyone walking through a door.
- **hibernia-2 wiped in the yard between 02:55:44 and 02:56:40** (Deirdre, Niamh, Fergus, Aine, Brigid, Oisin, Ciaran). Roof Scouts and wall Wizards shooting from 1900-2100 were "on us" and so the focus, and the casters walked after them. **Fixed in 8ca5569:** a caster or archer on us further than 1650 from the step's stand is no focus; a fighter on us still is.
- **Ranks 3-4 fell, and the lord phase began at 02:58:31.** The lord dropped from 89 % to 58 % with 4 melee on the roof. Then a Wizard on us pulled them down to the wall, and the lord held at 57 %.
- **Guards respawn after 15 ± 10 min** (`guard_respawn` 15, `guard_respawn_variance` 10). The first ones were back about 6 min after their deaths. In the stateless `raidOrders` each one reopens its rank: at 03:01 an outer fighter took the raid off the roof with the lord at 46 %. **Fixed in 9b16e04:** with a living member within the lord's reach (400, 3D), the raid stays on the lord.
- 03:02: the lord at 43 %, nobody on the roof. I asked R1 to restart the units on 8ca5569 and 9b16e04 for attempt 5.
- **Smaller points for later:**
  - A unit's done ranks and broken doors are its own. A squad that lost its member flips back to rank 1, and s1 never read the gate break. A shared `view.done` from the director would help.
  - The gate stand is 935 from yard-2's fighter (reach 1000).
- **Attempt 4 ended (R5):** the director closed the muster as `broken` at 03:02:24, after 618 s, with 2 foes against our 14. The lord was last read at 43 %. Albion still holds the Faste.

### R5: the Faste probe, attempt 5 (8ca5569, 9b16e04; 03:05-)

- **Muster: 3 min 27 s.** It began at 03:05:33 and went at 03:09:00 with 16 of 20 at the rally. hibernia-s1 crossed the route in 34 s (about 214 a second with speed) and opened rank 1 alone on outer-n.
- **hibernia-2 went to rank 2, the gate, and stuck there** (03:11). Rank 1 and part of rank 2 were still dead from attempt 4. The gate broke at 02:57 and stays broken: doors repair only 5 % per 30 min out of combat (`GameKeepDoor.REPAIR_INTERVAL`), and our client drops door state (0x99). A run that started after the break never read "The Keep Door is broken!", so its melee swung on with "the Keep Door is already dead!" (Cathbad, 03:11:48 onwards). **Fixed in 7cce1a1:** `DOOR_BROKEN_RE` also takes that line, which `doorsBrokenNear` reads at the door. 136 tests pass. It needs a restart.
- **Attempt 5 ended (R5):** the director closed the muster as `broken` at 03:12:02, after 388 s, with 1 foe against our 16 and "arrived -". That looks like a misread on the director's side (R2): nearly the whole raid was in place, stuck at the gate.

### R5: the Faste probe, attempt 6 (7cce1a1; 03:13-)

- **Muster: 3 min 18 s.** It began at 03:16:12 and went at 03:19:30 with 15 of 20 at the rally.
- **Only the squads raided.** s2 was on rank 1 alone by 03:21:15. hibernia fought enemy players (the pack's own player raid at (31539, 31713)), and hibernia-2 rested.
  - The cause is R3's `decidePack`, which hands the keep raid to `decideRvr` only with no enemy player about (pack.ts:350, `raidCall(mem) && !foes.length`). With all three realms playing, the main groups drop off the muster at the first enemy in sight. Attempt 4's main groups raided because none were about.
  - **For R3:** at the go, keep raiding unless enemy players are close (on us, or within a short reach of the body).
- **Later in attempt 6 (03:21-03:25):** both main groups took up the raid at 03:21:50 and reached the keep by 03:23. From then on they swung between the keep ("Armswoman / Wizard is on us", rank 2 at the gate) and Albion players by the stage: Avalonian#449 and Briton#446 and #448 at about (37300, 36600). That looks like Albion's director answering the defence, which is the realm calls working. The gate step never got a quiet minute, so whether 7cce1a1 ends it on "already dead" is still unseen. The director closed the muster as `broken` at 03:25:06, after 534 s, with 13 kills and 0 deaths in its row, 6 foes against our 15.

### R5: the Faste probe, attempt 7: **Hibernia captured Thidranki Faste at 03:38:48**

- **Timeline:**
  - Muster at 03:28:51; go at 03:30:36 with 13 of 16 at the rally (1 min 45 s).
  - Rank 1 from 03:31:44 (hibernia-2 at 03:31:32).
  - Rank 2, the gate, from 03:32:20. The 30-min repair tick had brought the gate back at 5 %, and it broke again by 03:34:21.
  - hibernia-2 was at rank 3 at 03:34:21. Lord phase for hibernia and hibernia-2 from 03:34:32.
  - **The capture:** "The forces of Hibernia have captured Thidranki Faste!" at 03:38:48. The owner read was `hibernia (by capture)` at 03:38:52. The director closed the muster as `captured` at 03:38:54, after 602 s, with 16 of ours and 4 units arrived.
- **The lord:** 99 % at 03:34:37, 69 % at 03:35:42, 47 % at 03:36:39, 1 % at 03:38:37. About 4 min from first hit to capture.
  - Only melee damaged him (Fionn, Cuchulainn, Fergus). The casters stood in the courtyard 1300-1500 away and never climbed, so their damage didn't count (the 400 3D reach).
  - Fighters that came up the stair (an Armsman, an Armswoman) were killed in between, which is by design.
- **Killed on the way, 03:32-03:34:** 3 Wizards and 2 Scouts from the gate side. hibernia's three melee (Conall, Laoghaire, Cathbad) died at the wall and on the roof around 03:33.
- **After the capture:** the lord is now "Chieftain Thidranki" L33 hibernia, matching `lordName` `/\bThidranki$/`. Level 33 means keep level 1, so `starting_keep_level=1` held. The other guards return 5-25 min later.
- **Fixes this needed, all in `siege.ts`:** 39669cc, e0eece9, c43ed13, 2afeaf0, 8ca5569, 9b16e04, 7cce1a1 and 091f5b0. R3's 8197311 (guards on the board) and 245e89e (enemy players count only near the body) were the other two keys.
- **Next for the raid:**
  - Casters should climb to the roof in the lord phase. The lord's 400 3D reach makes ranged damage from the yard worthless.
  - Done ranks and broken doors could be shared across units (`view.done`).
  - The rank-1 stand sits within the east wall casters' reach (about 1600 against 1850).

### R5: the Faste probe, attempt 8: **Albion retook Thidranki Faste at 03:51:04**

- **Timeline:**
  - Muster at 03:43:20 (rally 27546, 42330); go at 03:46:58 with 14 of 20 (3 min 38 s).
  - Albion's route over its bridge to the stage, staged by 03:48:03.
  - Rank 1: two respawned Guardians. Rank 2 from 03:48:42; an Eldritch on the east wall was killed by 03:49:06.
  - **Lord phase from 03:49:42, with the gate still shut:** members walk through doors. The lord, "Chieftain Thidranki", was at 36 % by 03:50:32.
  - **The capture:** "The forces of Albion have captured Thidranki Faste!" at 03:51:04. The owner read was `albion (by capture)` at 03:51:06. The director closed the muster as `captured`: 466 s, 6 kills, 0 deaths, 19 of ours, 4 units arrived.
- **From go to capture: 4 min 6 s.** It was quick because only a few Hibernian guards had respawned in the 12 min since their capture (respawn 5-25 min).
  - A retake soon after a capture meets a near-empty keep.
  - The lord again fell to two melee alone, Agravaine and Lancelot. The casters stayed in the courtyard.
- **After the capture:** the lord is "Lady Thidranki" L33 albion, so keep level 1 again (`starting_keep_level=1`).
- **The probe's goal is met both ways:** a realm's 20 musters, goes in by the plan and kills the lord, and the owner read follows within 2-4 s.

### R5: morning numbers, the Faste (the probe 01:58-03:51; run D follows)

| # | Realm | Go → end | Time | Muster (start → go) | Ended | Raid's dead (floor*) | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Hibernia | 02:01:43 → 02:04:51 | 3:08 | 3:06, 16/19 | broken | 14 (8 characters) | no raidOrders yet; walked through the NW wall; no guard touched |
| 2 | Hibernia | 02:16:57 → 02:31:57 | 15:00 | 4:00, 8/16 | timeout | 0 | hibernia-2 stood at "5/8 at the stage" (fixed e0eece9); hibernia stalked idle Albions |
| 3 | Hibernia | 02:38:42 → 02:48:48 | 10:06 | 1:40, 8/11 | broken | 23 | skipped the stage (fixed c43ed13); no guards on the pack's board (R3's 8197311) |
| 4 | Hibernia | 02:52:31 → 03:02:24 | 9:53 | 0:26, 13/16 | broken | 9 | first real raid: rank 1 in 50 s, gate in 2.5 min, lord to 43 %; casters chased far guards (8ca5569), respawns pulled it off the lord (9b16e04) |
| 5 | Hibernia | 03:09:00 → 03:12:02 | 3:02 | 3:27, 16/20 | broken | 2 | stuck at the already-broken gate (fixed 7cce1a1) |
| 6 | Hibernia | 03:19:30 → 03:25:06 | 5:36 | 3:18, 15/20 | broken | 9 | main groups fought Albion's defenders at the stage (R3's 245e89e) |
| **7** | **Hibernia** | **03:30:36 → 03:38:48** | **8:12** | 1:45, 13/16 | **captured** | **6** | lord ~4 min to 3 melee; gate back at 5 % from its repair tick |
| **8** | **Albion** | **03:46:58 → 03:51:04** | **4:06** | 3:38, 14/20 | **captured** | **0** | 12 min after Hibernia's capture: few guards back; walked past the shut gate to the lord |

- **Captures: 2 in 8 raids.** Both ran on the full set of fixes, and both were taken at keep level 1 (guards L28, lord L33).
- **Time per successful raid: 8:12 and 4:06** from the go. The lord took about 4 min and about 1.5 min, to melee alone in both.
- \* **The dead:** the raiding realm's deaths from the go to the end, any cause (guards or players). They come from 10 s samples of every bot's state, so a death and quick release between samples is missed; the numbers are floors.

### R5: run D, Midgard's first raid (04:06-)

- **The muster took 11.5 min:** it began at 04:06:45 and went at 04:18:20 with 10 of 19. Midgard's units were fighting Hibernians and Albions near their own rally, and two squads waited at the rally for a go.
- **The route itself is clean:** rally (40448, 35226) to the stage, no aggro.
- **The main unit (6) went in alone at rank 1.** It staged by its own count while midgard-2 and the squads were still 13000-18000 out. It killed two Armswomen and lost Leif, Ivar, Egil and Vidar in 16 s (04:19:36-52).
- **Fix ab6567c (`siege.ts`, 139 tests pass):** `RaidView.raid` lists every member of every unit answering the muster. With it, a unit at the stage waits for 75 % of the raid's living within 12000 of the stage. It is optional; R3's `tactics/raid.ts` must pass it, and without it nothing changes.
- **R2 (04:23): the muster call carries `raid`** (1b23d2e). R1 and R3 asked for it after Midgard's first raid in run D. While a muster is open, the call has `raid: { unit, x, y, z, alive }[]`: every member of each running unit in `asked`, refreshed every update, with places rounded to 50. A help call has none. **It reaches the file only after field.ts restarts** (field.ts loads director.ts when it starts), so it goes live at the next field.ts start.

**Run D (R5, the morning table continued):**

| # | Realm | Go → end | Time | Muster (start → go) | Ended | Raid's dead (floor) | Notes |
|---|---|---|---|---|---|---|---|
| D1 | Midgard | 04:18:20 → 04:26:12 | 7:52 | 11:35, 10/19 | broken | 21 | first live Midgard route, clean to the stage; the main unit (6) went in alone (fix ab6567c); a second push with 4 units met guards and Hibernians on the shared stage |
| D2 | Hibernia | 04:20:46 → 04:26:08 | 5:22 | 4:01, 11/19 | broken | 11 | hibernia-2 and s1 at rank 1 at 04:22:36; beaten on the stage Midgard shared |

- **All three routes end at one stage (36300, 38300).** Two realms raiding at once meet there and fight each other before the keep. It is RvR, and it is a choice: a stage per realm would keep raids apart. `FASTE.stage` is shared today.

**Run D2 (R5):**
- **The whole-raid wait (ab6567c, R2's 1b23d2e, R3's 313dffe) works live.** The muster call carries every member with current places (`groups/director/<realm>.json`). At 04:57:40 hibernia-2 held at the stage with "5/18 of the raid at the stage".
- **But it counted only those within 1000 of the stage.** At 04:58:48 hibernia-2 still waited ("6/18") while hibernia, s1 and s2 stood at the gate on rank 2. **Fixed in e1302ff:** members past the stage count as there. 164 tests pass.
- **D2-1, Midgard:** go at 04:43:14 (3:17 muster, 13/18); broken at 04:54:02 (844 s). It killed an Armsman and an Armswoman at rank 1, then Albion's defenders (Briton#441/#444/#448, Avalonian#449, Highlander#447) beat it there. The realm calls work for the defence. midgard-2 had wiped at home before the go.
- **D2-2, Hibernia:** go at 04:53:58 (4:01 muster, 13/19). R1 stopped run D2 at 04:59, and the muster closed at 05:00:08 (610 s). That `broken` is the stop, not a defeat.

**Run D3 (e1302ff loaded), the wait releases:** Midgard went at 05:14:44 (1:14 muster, 13/18). At the stage the units held at "2/17" (s2, 05:15:03), then "11/16" (midgard-2) and "14/19" (s1, 05:15:20). By 05:16:25 midgard-2, s1 and s3 were in the assault together on rank 1. The whole-raid stage holds the body until it is in and then lets it go.
- **D3-1, Midgard:** go at 05:14:44 (1:14 muster, 13/18). Its first push went in together at 05:16 after the raid-wide wait. It ended on `timeout` at 05:29:45 (974 s). After 05:21 its units spent the raid fighting Hibernian and Albion players around the island: Highlander#447, Celt#420 and #450, Elf#458, Briton#446 and #417, Avalonian#419. Between fights the main unit waited briefly at the stage ("6/14", "6/13", "6/11"). midgard-2 broke at 05:23:50, and the squads kept being pushed off. This was no stall of the wait: in a busy zone the raid seldom stands together.
- **D3-2, Hibernia:** go at 05:30:45 (7:15 muster, only 7/13); `timeout` at 05:45:45 (1335 s), with 21 kills and 0 deaths in its row. Like Midgard, it spent the raid fighting players. Albion still holds the Faste.

### R5: the frozen window, 06:00-10:00 (run D3, nothing loaded changes)

Raids as they come. Each row gives the go, the end and the time from the ledger, and the raid's dead from my 10 s samples (floors). The table is filled in through the window.

| Realm | Go | End | Result | Time | Raid's dead | Owner after |
|---|---|---|---|---|---|---|
| Midgard | 06:04:24 | 06:19:24 | timeout | 15:00 | 41 | albion |
| Hibernia | 06:20:00 | 06:35:01 | timeout | 15:01 | 38 | albion |
| Midgard | 06:53:21 | 07:08:22 | timeout | 15:01 | 40 | albion |
| Hibernia | 07:11:18 | 07:26:18 | timeout | 15:00 | 30 | albion (lord to 34 %) |

**Carry-overs from the window (R5; nothing changed in the freeze):**
1. **R2, muster timeout:** the muster's 15 min ends a raid even in the lord phase. At 07:26 Hibernia's ended with the lord at 34 % and falling. Extend it while a unit reads `raid ...: lord`, or count the 15 min from the last rank change.
2. **R5 `siege.ts`, Scouts on the roof:** in the lord phase a roof Scout on us (290-320 from the lord) is the focus before the lord. Meanwhile the lord regenerates (06:32: 98 % after 7 min of lord phase). In the lord phase, only a fighter on us should take the focus from the lord.
3. **R3, casters stay below:** the lord counts only damage from within 400 in 3D, and the casters stay in the courtyard (1200-1800 away). In every capture so far the lord died to melee alone.
4. **Losses per raid in the window: 30-41,** mostly from fights with players on the island, not with the keep.
| Midgard | 07:40:13 | 07:55:13 | timeout | 15:00 | 48 | albion |

### R5: why the raids since 05:13 end in `timeout` (R1's question, 08:01; observe only)

**Per raid.** Sources: the deepest rank and the time split come from the units' orders, sampled about every 30 s per unit. Guard deaths and the killer split come from the observer's run reports (`groups/<unit>/runs/*.json`: `fights[].kills`, `members[].killedBy`; killedBy is per run, weighted by the run's overlap with the raid). "Our dead" comes from my 10 s samples (floor).

| Realm | Go → end | Deepest | Guard deaths seen* | Our dead (floor) | Killed by guards / players** | Time: keep raid / player fights / other |
|---|---|---|---|---|---|---|
| Midgard | 05:14:44 → 05:29:45 | rank 1 | 13 | 40 | 4 / 19 | 53 / 36 / 11 % |
| Hibernia | 05:30:45 → 05:45:45 | rank 2 | 19 | n/a (log gap) | 19 / 14 | 71 / 25 / 4 % |
| Midgard | 06:04:24 → 06:19:24 | **lord** | 42 | 41 | 3 / 18 | 68 / 27 / 4 % |
| Hibernia | 06:20:00 → 06:35:01 | **lord** (98 % at 06:32) | 35 | 38 | 1 / 27 | 70 / 25 / 5 % |
| Midgard | 06:53:21 → 07:08:22 | rank 2 | 23 | 40 | 3 / 19 | 56 / 37 / 7 % |
| Hibernia | 07:11:18 → 07:26:18 | **lord** (to 34 %) | 51 | 30 | 1 / 20 | 78 / 17 / 6 % |
| Midgard | 07:40:13 → 07:55:13 | rank 4 | 7 | 48 | 8 / 2 | 76 / 22 / 2 % |

\* Summed over units, so a guard two units saw die counts twice. ** Players includes their pets. The run-weighted shares undercount against my samples.

**Diagnosis.**
- **Not the gate.** Every raid got past rank 1, most to rank 2 and beyond, and three reached the lord. Gates break or are already broken (7cce1a1).
- **Not the respawns as such.** Guards die in numbers (7-51 deaths seen per raid). In six of seven raids they killed only 1-8 of ours; the exception is Hibernia 05:30 (19).
- **First: player fights, at the keep and around it.** In six of seven raids players killed 14-27 of ours, Albion's defenders first: over the window Albion players 188, Midgard 99, Hibernia 83, Albion's guards 85. The units spend 17-37 % of the raid fighting players instead of the keep, and each loss sends members back to the portal keep (12000-20000 out). The raid thins out and doesn't regather in time.
- **Second: the clock.** The muster's 15 min ends a raid in the lord phase. Hibernia had the lord at 34 % at 07:19 and timed out at 07:26.
- **Third: slow damage on the lord.** Only the melee within 400 count. Roof Scouts on us take the focus first, and the casters stay in the courtyard, so the lord regenerates (98 % after 7 min of lord phase at 06:32).

**Carry-over fixes (after 10:00):**
1. **R2, the clock:** don't end a muster while a unit reads `raid …: lord`, or count the 15 min from the raid's last rank or lord progress.
2. **R5 `siege.ts`, the lord's focus:** once 2 of us (and a fifth) are within the lord's reach (the hold, 9b16e04 and 091f5b0), a static guard on us is no focus; only the lord and fighters on us are.
3. **R3, casters up the stair:** in the lord phase, ranged walk `plan.inside` to the roof (`plan.roof`). Their damage counts only within 400 in 3D.
4. **R2, the defence:** a go into the owner's defenders loses most of the raid to players. Let the muster's go weigh the defenders seen near the keep (foes in the call), and wait while they outnumber it.

**The window's raids after the diagnosis (same columns, all `timeout` unless noted):**

| Realm | Go → end | Deepest | Guard deaths seen | Our dead (floor) | Killed by guards / players | Time: keep raid / player fights / other |
|---|---|---|---|---|---|---|
| Hibernia | 07:57:57 → 08:12:58 | lord | 18 | 44 | 0 / 14 | 55 / 38 / 7 % |
| Midgard | 08:26:40 → 08:41:41 | lord | 10 | 49 | 7 / 10 | 54 / 38 / 9 % |
| Hibernia | 08:45:25 → 09:00:25 | lord | 15 | 24 | 2 / 3 | 87 / 9 / 5 % |
| **Midgard** | **09:13:54 → 09:22:38** | **captured** at 09:22:36 | (runs still open) | 12 | (runs still open) | 68 / 31 / 1 % |
| Albion | 09:27:26 → 09:42:27 | lord (43 % at 09:41:44) | – | 12 | – | – |
| Hibernia | 09:33:20 → 09:48:21 | lord (99 % at 09:45:39, regenerated after Albion's try) | – | 41 | – | – |

### R5: pathing inside the keep, doors and wall climbing (R1's ask 08:45; read-only until 10:00)

**What the server and the client do with doors:**
- **No door opens for its own realm.** `GameKeepDoor.Interact` (or "enter"/"exit" said or whispered at the door) moves a player of the door's realm through. That is 150 units for a gate (`DoorIndex 1`) and 100 for an inner door, plus 92 in height into the keep building. For an enemy it does nothing, so an enemy door stays shut until it breaks.
- **Breaking:** at 0 health a door goes `Open` (`Die`). A repair over 15 % or a capture's `Reset` closes it again. The server sends the state as 0x99 (`SendDoorState`). **Our client drops 0x99** (`client/model/world-model.ts:113`), so a bot never knows a door's state.
- **The server checks no movement,** so a bot walks through a shut door as if it were open. A real client can't.
- **`sdk.sendInteract(objectId)` exists** (ObjectInteractRequest), so a bot can use its own realm's doors the way a player does.

**What the navmesh says (`server/navmesh` zone of Thidranki, checked with `NavMesh.findPath`):**
- **Doors are on the mesh as `PolyFlags.Door` polygons:** the gate at about (34304, 38269), the building door at about (32602, 38221).
- **With Door polygons excluded (`findPath(..., exclude = PolyFlags.Door)`)** stage → courtyard is only `partial` (no way in but the gate), and courtyard → roof is `partial` too (it ends on a wall top at z 3978; the only way up is through the building). A shut door is a wall at the cost of one flag.
- **The wall-walk is reachable by a real stair** at about (33530-33660, 38860-38960): 3722 → 3968 over about 300 units in steps. A route to a wall Wizard exists and is legit.

**Where our walks cross a shut door today:**
- **The raid's lord phase:** the hold (9b16e04, 091f5b0) takes the raid to the roof when 2 of us are there, whether the building door (`keep-door`, rank 6) is broken or not. The stand `plan.roof` routes through the building door, which is on the mesh as passable.
- **"On us" and fighter chases:** a fighter or caster on us inside the gate or the building becomes the focus, and melee follow it through a shut door.
- **Attempt 4:** seven casters stood in the courtyard during rank 2 with the gate still shut.

**The wall climb (08:36-08:37 local, midgard-2):**
- The log shows Egil "Cannot reach Wizard: Died en route to (33679, 39074)" (wall-se, z 3976), then Leif's "opener Disable on Wizard" and Sigurd's "opener Frost Hammer on Wizard". Melee got to a Wizard on the wall top.
- **Cause, `sdk/actions.ts` around line 1505 (`walkToObject`):** "close on the ground but out of range in 3D: step onto the target ourselves". A direct `sendMoveTo(obj.x, obj.y, obj.z)` with no route; the mover adopts the navmesh layer at that spot, the wall-walk. A melee below a wall Wizard climbs straight up.
- The melee chase (around line 2297) likewise sends `sendMoveTo(t.x, t.y, t.z)` straight at the target. Elsewhere `NavmeshPathProvider` walks a partial route and then "straight from there" (`sdk/pathfinding.ts:215`).
- The unit's focus came from "Wizard is on us" (8ca5569 keeps a static guard within 1650 of the stand as the focus). The unit has one focus, so its melee took it too.

**Plan (lands after 10:00, with tests):**
1. **R5, `sdk/pathfinding.ts` and `sdk/navmesh.ts`:** `PathRequest.exclude` (poly flags) and `PathRequest.strict`. With `strict`, a partial route in a zone that has a mesh fails as `no_route` instead of adding the straight remainder. `walkTo` and `followPath` pass both on (option `doors: 'closed'`, `strict: true`).
2. **R5, `sdk/group/siege.ts`:** door state per raid. A door is passable once broken (`broken`, from `DOOR_BROKEN_RE`, "already dead" included) or when the keep is ours. The raid's walks get `exclude: Door` while a door on their way stands.
   - The lord hold and the lord phase wait for `keep-door` broken. Ranks 3-6 and their stands wait for `gate` broken, as the ranks already order it.
   - `RaidOrders` gets `meleeFocus`: melee never take a caster or archer (`kind` caster/archer/lord on a wall or the roof) unless their route to it is `found` and on the mesh. Ranged keep them.
3. **R3, `decideRvr`/`raidStep` and the melee kits:** the unit's orders carry the melee focus apart from the ranged one (from `RaidOrders.melee.focus`). Melee hold at their stand when that is null.
4. **R5 with R3, `sdk/actions.ts` (`walkToObject`'s "adopt the target's height", the melee chase):** step onto another layer only if the navmesh route there is `found` and no longer than 1.5 × the 3D distance + 100. Otherwise return `out_of_reach` (the existing reason; kits already drop such a target). The chase takes the route (walkTo, `strict`) when the target's z is more than 100 off ours.
5. **R5, own doors:** when the keep is ours and a route needs a door, walk to it, `sendInteract(door.objectId)` and observe the jump (100-150), as a player does. Matters for defence (a unit inside its own keep) and for walking out.
6. **Door state from the server, later:** parse 0x99 in `client/model/world-model.ts` into `NearbyObject.doorState`. It is outside the other session's `client/session.ts`, but needs a client restart (swarm). Until then the chat lines stand in.

**Restart:** items 1-5 are in `sdk/`, loaded by the units' runs and field.ts, so restart field.ts (the units). No client or swarm restart. Item 6 alone needs the swarm restarted, so it waits for a planned window.

**Doors, per door, as the server does it (R5, about 08:40, after R1's note from the user):**
- **The server (`LocalPathfindingMgr`):** each door gets its polygons once: `GetPolysInBox` around the door (±128, ±128, ±32), Door-flagged only. Then `UpdateFlags` swaps them between `Door` (0x04) and `BlockingDoor` (0x20). A door is blocking while `Closed && !CanBeOpenedViaInteraction`. NPC paths leave `BlockingDoor` out (`BlockingDoorAvoidanceFilters`).
- **Our `Detour.dll` exports both** (`server/navmesh/lib/Detour.dll`: `UpdateFlags`, `GetPolysInBox` and `GetPolyAt`, checked through `nativePath`). `sdk/navmesh.ts` just doesn't declare them yet.
- **So the plan's step 1 becomes:**
  - `NavMesh.doorPolys(door)`: the server's box query, cached per door.
  - `NavMesh.setDoorBlocking(door, blocking)`: `UpdateFlags`, Door ↔ BlockingDoor.
  - `PolyFlags.BlockingDoor = 0x20`, left out of every query by default, the way Swim is left out on request.
- **Who is blocking:** an enemy keep door that isn't broken. Our own realm's doors stay `Door`: our walks may cross them, and the walker does a `sendInteract` at the door and watches for the 100-150 jump. Broken comes from `DOOR_BROKEN_RE` ("already dead" included) until the client reads 0x99.
- **The flags live in each process's own mesh,** the units' run processes, where `walkTo` finds its path. Each process sets them from the doors in the region's layouts (`SIEGE_LAYOUTS`, the `door` table's positions), or from `nearbyObjects` with a `doorId`, plus the owner read (`KeepOwnerRead`).
- **Interface agreed with R3 (about 08:45) for step 3:** no new `RaidOrders` field.
  - R5 sets `RaidOrders.melee.focus` to null when the only candidates are a caster, archer or lord on a wall or the roof with no found route. `ranged.focus` is unchanged.
  - `RaidView.reach?: (to) => boolean` is optional; absent, everything counts as reachable.
  - R5 exports `meleeReach(regionId, from, to, doors: { broken, ours })` from `siege.ts`: strict, Door polygons left out unless broken or ours, cached per post and door state.
  - R3 adds `Orders.meleeFocus` (focus = ranged ?? melee, meleeFocus = melee or null). Tanks and melee read it, and hold at the stand on null.

**Caster stands and walls (the user, via R1, about 08:50; after 10:00, with the keep-walls-block-line-of session):**
- **Today** the casters stand in the courtyard (`FASTE` ranks 4-5, stand (33100, 38250)) and nuke wall Wizards and roof Scouts. That works only because our line of sight ignores walls and buildings (`sdk/vision.ts` reads the terrain only).
- **Once that session lands wall occluders,** each ranged stand has to be a spot a real client sees its target from: wall Wizards from inside the courtyard or from the wall-walk, roof Scouts past the building's parapet.
- **Plan (R5, `siege.ts`):**
  1. A test over `FASTE`: for each ranged or all-hands target, the stand sees the post at eye height (their LoS with walls). It fails today's stands that don't.
  2. A stand that fails is re-picked offline: sample navmesh points within 1500 (a nuke) of the post and reachable from the stage (`meleeReach`, doors by rank). Keep those that see the post, and prefer those outside the next ranks' aggro. Then fix it in `FASTE` with the test.
  3. A guard no reachable spot sees becomes `who: 'melee'`: the melee go up the stair route (a found path, doors by rank).
- **What I need from that session:** the LoS function and its signature (from, to, region, eye heights), and whether it includes the Faste's walls and building.
- **Their answer (about 09:05; `lineOfSight` on branch claude/eloquent-shannon-df1922, not merged):**
  - **The call:** `lineOfSight(regionId, from, to, ground = terrainGround, opts = HUMAN_VISION, solid)`, feet positions, eye 60 over `from.z` and target 50 over `to.z`. It covers zone 252's walls (merlons included), the gatehouse and the keep building with its roof. Doors aren't in it, so a shut gate doesn't block sight. It needs `server/navmesh/zone252.occluders` (`bun run occluders:build` after the merge), and a test gates on `getOccluderStore().forZone(252)`.
  - **Measured on today's stands:** outside the gate, nothing sees wall-e-n, wall-e-s or wall-se, and they don't see us either. The courtyard sees wall-e-n, wall-e-s, wall-se and wall-n. No courtyard spot within 750 of the centre sees wall-sw or wall-nw. The roof Scouts are seen only from the roof.
- **So the ranks change (R5, after their merge, with a test over the stands):**
  1. Outer fighters, as now; they come out to us.
  2. **The gate first** (melee). The ranged wait outside, unseen by the east wall.
  3. **Courtyard:** the yard pair plus wall-e-n, wall-e-s, wall-se and wall-n, from the courtyard. The east wall casters move here from rank 2.
  4. **wall-sw and wall-nw:** by the wall-walk stair (a found route), or left alone if they don't see the courtyard, the stair or the roof. That's to check with their `lineOfSight`.
  5. The building door (melee), then **the roof:** the Scouts and the lord, fought from the roof only, ranged included (casters up the stair, R3).

**Midgard captured the Faste at 09:22:36** (the third capture of the night, Midgard's first, and the first in the frozen window).
- **Timeline:** muster at 09:11:46; go at 09:13:54 with 15 of 19 (2:08); lord phase at 09:17:14, 3:20 after the go; the lord at 81 % at 09:19:19 with Ivar and Vidar on the roof. "The forces of Midgard have captured Thidranki Faste!" at 09:22:36; the owner read `midgard (by capture)` at 09:22:38-39; the director closed the muster as `captured` (650 s).
- **8:42 from go to capture, 12 dead (floor).** Like the two before, the lord fell to melee on the roof while the casters stood in the courtyard.
- **The new lord is "Jarl Thidranki" L33 midgard,** keep level 1 again, and it matches `lordName`. All three lords are now seen: Lady (Albion), Chieftain (Hibernia), Jarl (Midgard).

### R5: the frozen window in sum (06:00-10:00, run D3, nothing loaded changed)

- **Raids: 11.** Midgard 5 (06:04, 06:53, 07:40, 08:26, 09:13), Hibernia 5 (06:20, 07:11, 07:57, 08:45, 09:33), Albion 1 (09:27).
- **Captures: 1.** Midgard at 09:22:36, 8:42 from its go, with 12 dead (floor). The other 10 ended in `timeout` at 15:00-15:01. Seven of those reached the lord phase; the lord's lowest reads were 34 % (Hibernia 07:19) and 43 % (Albion 09:41).
- **Owner changes in the window: one,** Albion → Midgard at 09:22:36. Albion's retake (09:27) and Hibernia's raid (09:33) on Midgard's Faste both timed out at the lord.
- **Losses per raid, my 10 s samples (floor):** 24-49 for the timeouts, 12 for the capture. By the observer's reports, most fell to players (Albion's defenders first), not to guards. See "why the raids since 05:13 end in timeout".
- **The night's owner changes:** Albion → Hibernia 03:38:48 → Albion 03:51:04 → Midgard 09:22:36. All three lords seen: Lady (Albion), Chieftain (Hibernia), Jarl (Midgard), all L33 at keep level 1.
- **What would have turned the timeouts, all carry-overs listed above:**
  - the clock holding while a unit is on the lord (R2);
  - static guards not taking the focus from the lord (R5);
  - casters up on the roof (R3);
  - a go that weighs the defenders (R2).

### R5: landed after 10:00 (commits only in my paths; nothing pushed)

- **48fa6a4 `siege.ts`:** on the lord (rank null, every rank done or the lord hold) only a fighter on us takes the focus from him. Roof archers no longer pull the raid off a regenerating lord.
- **8e0a8d7 `sdk/navmesh.ts`, `sdk/pathfinding.ts`, `sdk/test/navmesh-doors.test.ts`:** doors as the server keeps them.
  - `NavMesh.doorPolys(at)` and `setDoorBlocking(at, blocking)` swap a door's polys Door ↔ BlockingDoor through our Detour.dll's `GetPolysInBox` and `UpdateFlags`. Every query leaves BlockingDoor out, so nothing changes until a door is shut.
  - A route that comes up partial while a shut door is on the way fails with `reason: 'door'` (walkTo gives `no_path`, "a shut door at (x, y) is in the way") instead of walking straight through.
  - Tested on the Faste's real mesh. A shut gate leaves no way into the courtyard. The building's door alone doesn't seal the roof: the way goes up the wall-walk and in by a postern, and **the Faste has four posterns** (door table 252000303-306, `IsPostern`; never attackable, open only to the owner).
- **d7bc5af `siege.ts`:** the keep's doors and the melee reach.
  - `FASTE.doors` holds all six. `shutDoors` and `applyDoors` shut posterns always, the gate and building door until broken, none when the keep is ours.
  - `meleeReach(regionId, from, to, { broken, ours })`, as agreed with R3, who fills `RaidView.reach` in raidStep with Orders.meleeFocus (R3's e80c2bf).
  - With `reach`, a caster, archer or lord melee can't walk to is no melee focus.
- **Tests:** siege, raid, squad, keeps and the navmesh doors (154 pass); navmesh, pathfinding and FFI (24 pass, 1 skip). Typecheck clean, and all 23 `groups/*/rvr.ts` import.
  - `sdk/test/actions.test.ts` (1314 tests) did not finish in 20 min here, so it is **unverified**. It sets the straight-line provider and mocks the navmesh store (lines 22-23), so these changes don't reach it.
- **Restart:** units only (field.ts) at the next stint. No client or swarm restart.
- **Carry-overs, not landed:**
  1. **R5 with R3, `sdk/actions.ts`:** `walkToObject`'s "step onto the target ourselves" (around line 1505) and the melee chase (around line 2297) move straight to the target's z. Step onto another layer only on a found navmesh route no longer than 1.5 × the 3D distance + 100, else `out_of_reach`. Not landed, because its test file doesn't finish here. Shut doors and R3's split melee focus already take away the climb's trigger.
  2. **R5, after the keep-walls-block-line-of branch merges:** the new ranks (gate first, the east wall from the courtyard, the west wall by its stair, the roof Scouts from the roof), checked by a test against their `lineOfSight`.
  3. **R5, own doors:** `sendInteract` at our own keep's doors on the way (the 100-150 jump). Unneeded until a unit walks inside a keep we hold.
  4. **The client reading 0x99 door state:** a client change and a swarm restart.
  5. **R2:** the muster's clock should hold while a unit is on the lord, and the go should weigh the defenders.

### R5: the Faste's ranks by line of sight (R1's ask 11:10, landed fb9173e)

Measured with `lineOfSight` over `zone252.occluders` after the walls branch merged (d6ab2be):
- `OUTSIDE` sees one outer fighter; `GATE_OUT` sees all five and no wall caster.
- The gate's stand is seen by no caster.
- `COURTYARD` sees wall-e-n, wall-e-s, wall-se, wall-n and the yard pair.
- wall-sw is seen from no reachable ground spot, wall-nw only from 8 outside the walls. They see 1 and 6 of 215 courtyard points and not the roof.
- The roof archers are seen from the roof only. roof-n and roof-s see none of the courtyard, roof-e sees 30 points.

**New ranks:**
1. Outer fighters from `GATE_OUT`.
2. The gate, melee only; the ranged wait at its stand.
3. The courtyard: the yard pair, wall-e-n, wall-e-s, wall-se and wall-n.
4. The building's door and floor-3.
5. The lord phase on the roof: ranged take the roof archers first, melee stay on the lord.

The west wall casters and the roof archers are `optional`.

**Tests (`siege.test.ts`, skipped without the mesh and occluders):** every caster, archer and the lord is seen from its stand; no wall or roof guard sees the outer and gate stands; the courtyard is seen only by ranks up to 3; the roof sees its archers and the lord; every stand is reachable from the stage once the doors before its rank are broken. siege, squad, keeps and navmesh doors: 140 pass. Learnings updated (`learnings/rvr.md`, "The raid plan").

**For R3:** two tests in `sdk/group/tactics/raid.test.ts` encode the old rank 2 (a wall caster for the ranged while melee break the gate) and fail until updated. R3 has the details.
