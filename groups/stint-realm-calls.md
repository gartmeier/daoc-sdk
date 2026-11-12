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

**Bench by 04:30:** none planned. I'll put a class on the bench here if its sortie logs show it failing.

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
