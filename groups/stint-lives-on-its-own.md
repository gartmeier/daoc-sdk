# Stint brief (draft, 2026-11-13 13:00 to 11-14 08:00): Thidranki lives on its own

**The goal (plan doc, [Living Thidranki](https://claude.ai/artifact/SehSwg1Qwnin3upWutksXB)):** Thidranki is alive on its own, filled with bots, with a natural life cycle, and a human (for now only the user) can log in and try it.

**This stint's measure:** at 08:00 the world is still running, nobody has touched it since 02:00, and the "alive" numbers held through the night. The night doesn't end by stopping everything: it ends with the world handed to the supervisor.

**Decided by the user (2026-11-13):**
- 60 bots, from 13:00 until 08:00 on 11-14.
- No gate on captures and no frozen window for its own sake. Restart anything whenever that's faster than waiting. (The hands-off window below is the goal's own test, not a gate.)
- The keep defended from inside, and taken against a defence: the user wants to see both.
- The user may play Niamh (Mentalist) in `hibernia` for 30-90 min some time after 19:00, or may not. They follow and assist by themselves; no bot follows them.
- The group says what it does in group chat, the realm talks in `/region`, and the ledger measures "alive".
- No rams: this server's Thidranki has no siegemaster, so they aren't meant there.

Read first: `CLAUDE.md`, `groups/stint-realm-calls.md` ("Handover for the next stint", "Morning report"), `docs/thidranki-population-handover.md` ("Lessons that cost us rounds", "Scaling constraints").

## Where we start

- Docker is up, at `starting_keep_level=1` (L28 guards, L33 lord). Gateway and clients are stopped.
- The Faste is Midgard's. All 60 characters have `GainRP = 0`.
- All 12 commits in the handover's "committed but never seen live" table are in main. origin/main is at 8e2ba0a; only 67301d3 (the handover) is local.
- Wall occluders are built, so every client answers line of sight with walls.
- Thidranki has no smith, healer or vault: only the realm-point merchants. Gear that wears out can only be repaired in a capital.
- `observed.ts` (a human in a bot group) ran live three times with a script standing in for the human (2026-11-11), never with a real human and never in field mode.

## What changed from the first draft, and why

The first draft was a list of features, mostly around the keep. It never tested the two things the goal names:
- **On its own:** it stopped everything at 08:00, nine sessions fixed things live all night, and the supervisor came at 21:00 as a side item.
- **A life cycle:** all 60 bots were on all night, every hour the same. Real Thidranki had people logging in and out, a busy evening and quiet small hours.

So this version puts those two first and makes "alive" the scoreboard. It keeps help in time, the keep (one track) and what the user's hour needs. It cuts the login script, the 8-man hour and most of the manners, and runs six sessions instead of nine.

## Milestone

1. **It runs on its own (S1).**
   - A supervisor from 13:30: a dropped client is quit cleanly and started again; a field mode or director that ends on its own is started again with the same flags; after a gameserver restart it waits for logins, brings every bot back in and starts field mode again. Every action is logged.
   - One deliberate gameserver restart in a quiet moment before 02:00, to see the supervisor bring the world back with nobody's help.
   - Log sizes checked (last night's swarm log reached 4.6 MB in 15 h): a world meant to run for days caps or rotates them.
   - **02:00-08:00, hands off.** No edits, no restarts by hand, no session acting on the world. Sessions only read logs and write notes. Units import `sdk/` and `groups/` from the working tree, so even an uncommitted edit goes live: a fix waits as a patch file in the session's notes (`groups/notes/`), applied after 08:00.
   - At 08:00 the world keeps running under the supervisor, and the machine stays awake, until the user says stop.
2. **A natural life cycle (S4).**
   - **Sessions like players.** A bot plays a session of 1-3 h, logs out cleanly, and comes back 20-90 min later. Which bots are online changes all the time.
   - **A daily curve.** How many play follows the hour: a full evening (about 20 per realm), thin small hours (about 8), a middling morning and afternoon. Never below a floor of about 6 per realm, so the field doesn't read empty.
   - **Units from who is online.** Line-ups and the mix come from the bots online: two groups and squads in the evening, a group and small-man at night. Hibernian groups keep a Druid and a Bard.
   - **Waves.** Units go toward where the realm last saw enemies: build-up, a fight, then a few minutes of quiet at the portal keep, where they rest and stand around (sit, turn, move a little) rather than stand in formation.
   - **Balance.** Each director compares its realm's online units with what its units see of the others, and sends one out or lets one log off early, so no realm outnumbers another by more than about 1.5 to 1 for long. Only what the realm sees.
   - **Raids from the situation.** A realm calls a muster when it has the numbers online, not on a fixed 30 min timer. When the go goes is S3's "moment to raid".
   - **Gear wear.** Item condition for all 60 at the start and at 08:00. If it wears enough to matter in days, a bot with worn gear spends part of a break on a repair trip to its capital (`cloak-trip.ts`, `gear-care.ts`), as a player would.
3. **"Alive" is the scoreboard (S1).** The plan doc's measures, from logs we already write, hour by hour:
   - the distance from each portal keep to the nearest fight;
   - every size at once: how often solos, small-man and groups are all fighting in the same 10 minutes;
   - realms even: time any realm outnumbers another by more than 1.5 to 1 for over 10 minutes;
   - bots online per realm against the curve;
   - time the world was playable with nobody's help, drops and recoveries.
   The opening run gives the "before", the hands-off window the "after".
4. **Help arrives in time (S3).** Last night with the director on, a friend arrived 27 % of the time (6 % with it off), but wipes stayed the same: help is usually 6000-9000 away, 30-50 s at a run, and most fights end first.
   - Call on first sight: when a bigger group is seen coming, not once we're losing.
   - The caller falls back toward its helpers and turns when they meet (the coordinator's retreat point, with S2).
   - Free units roam within about 3000-4000 of another of their realm's units where they can.
   - Measured: time from call to first arrival, the distance at the call, fights with help against without.
5. **The keep, one track (S2, S3, S5).**
   - **Defended from inside.** When its keep is attacked, the owner's director sends the units nearest it (not all, so a feint doesn't empty the field). They go in through their own doors: ranged up the wall-walk stair to cast and shoot down; point-blank area damage at the gate's inside and the stair (a Mana Enchanter's Disenchanting Emission, 133 dmg, radius 300, at spec 20; the Ice Wizards'); an Animist's turrets inside the gate and on the stair; melee and healers in the courtyard. Stands by spell, never by roster.
   - **Taken against a defence.** 20 against 20 with the third realm behind loses, so a raid goes when it can win: few defenders seen at the keep, or the owners seen fighting the third realm elsewhere. A third realm that sees the other two at the keep joins on the weaker side or waits to take it from the winner. The defence hold (59b44a0) already waits while defenders outnumber us.
   - **Raid fixes the night asked for:** rez in the raid (the dead hold for a rezzer from any of its units), and the dead go back together (the whole-raid wait counts units on their way; squads don't lead).
   - Seen live: at least one defence from the walls, and at least one capture of a defended Faste.
6. **Healers like players (S5).** At 24 the heal builds have a real group heal: Druid Renewing Conflux (139 on everyone within 2000, spec 22), Healer Favor of Battle (103, spec 16), Cleric Heaven's Commendation (97, spec 15). The Druid, Friar and Warden kits cast theirs (`groupHeal`); the Cleric and Healer kits get the same rule. A healer stands within group-heal reach and out of the enemy's sight (terrain, keep walls, buildings). Time in an enemy's sight is measured.
7. **For a human (S6, S1).**
   - **The group says what it does** in group chat: "pulling back", "focus the Cleric", "mezz on the Troll", "going in", "rez Brigid". From the coordinator's own decisions, when they change, rate-limited. Live before the user's hour.
   - **The realm talks in `/region`:** help ("6 mids at the north bridge, need help"), musters ("Faste in 5, gather at the bridge"), the defence ("Faste under attack"), captures. At most one line every few seconds per realm.
   - **"lfg":** a human whispers any bot of their realm "lfg" (or says it in `/region`, or ticks the client's LFG flag). The director picks a unit missing the human's role, one bot logs off for them (the life cycle's own log-out), the leader invites, and the human is an observed member until they leave; then a bot comes back. If it holds by 18:30, the user's hour goes through it; otherwise through the manual slot below.
8. **The night's fixes, seen live (S1).** Each row of the table at the end gets a verdict from the opening run.

## The user's hour: Niamh in `hibernia`

- **Who:** Niamh, the Mentalist of the first thirty (the user's pick), in `hibernia` with no rotation while the user plays. If Deirdre is in `hibernia`'s line-up then, she logs off.
- **How they play:** the bots lead; the user follows and assists by themselves (`/follow`, `/assist`). The group chat calls tell them the plan.
- **When:** after 19:00, 30-90 min, on the user's word in S1's session. If they don't come, nothing changes.
- **Manual way in (if "lfg" isn't ready), by S1:**
  1. Hold `hibernia`'s next sortie (`groups/hibernia/.editing`) and wait for its current one to end.
  2. Log Niamh out (the life cycle's log-out, or `bun client/dev/swarm-check.ts niamh --seconds=0 --quit`), and keep the life cycle from logging her back in.
  3. `groups/hibernia/group.json`: Niamh in `"observed": [{ "name": "Niamh" }]`, line-up fixed.
  4. The user logs in to Niamh's account (credentials in `bots/niamh/bot.env`) with their own client. Refused as link-dead: wait 60 s.
  5. Release the hold; `formGroup` invites Niamh.
- **Out:** the user quits; S1 puts group.json back and lets the life cycle have Niamh again.
- **Before 19:00 (S1):** a per-group fixed line-up and observed members in field mode, rehearsed on the throwaway stack with a script standing in for the human.
- **While the user is in game:** no swarm or field mode restart and no edit to `hibernia`'s strategy without their OK.
- **Watch for:** `observed.ts`'s known gaps (pets still attack the focus, kits with their own fight behaviours, the coordinator's focus choice), and note what the user says in this file.

## Sessions and who owns what

Six sessions. Everyone works in main's checkout, commits only their own paths (`git commit -- <paths>`), and pushes nothing.

| # | Session | Owns | Done when |
|---|---|---|---|
| S1 | **Coordinator and supervisor** | gateway, swarm (with a way to log one bot out and back in, for S4), `groups/field.ts`, `lineup.ts`, the supervisor, the ledger and the "alive" measures, this file; the user's hour; merges | supervisor from 13:30; verdicts and the "before" by 15:00; the hour rehearsed by 18:30; the gameserver restart recovered before 02:00; the world running at 08:00 |
| S2 | **The keep** | `sdk/group/siege.ts` (defence stands by spell; the raid plan), `keeps.ts`, `sdk/actions.ts`'s pathing (`walkToObject`'s straight last step, about line 1505; the melee chase, about 2297), own doors by `sendInteract`, the client reading door state (0x99), `learnings/rvr.md` "The Faste"; the defence path in `rvr.ts` by agreement with S3 | on the throwaway: a unit through its own door, up the stair at (33530-33660, 38860-38960), on its stand, fighting; then a defence from the walls live |
| S3 | **Director** | `director.ts` calls, musters and the defence call; `realm-board.ts`, `squad.ts`, `squad-run.ts`, the raid paths in `rvr.ts` | help on first sight, fall back, roam within reach; the defence call; the moment to raid; rez in the raid; the dead back together; a field.ts restart stops the director first (with S1) |
| S4 | **Life cycle** | new `sdk/group/lifecycle.ts` (+ tests): sessions, the daily curve, the floor, balance, waves and idling at the portal keep, raids by numbers online; the gear-wear check and repair trips; the field.ts side with S1 | offline tests by 17:00; live by 20:00; the curve and balance visible in the "alive" numbers before 02:00 |
| S5 | **Kits** | `sdk/classes/*`, `sdk/group/pets.ts` by agreement with S2 | healers' group heals and stands; the bomb at a chokepoint (Emer respecced to Mana with `train.ts --respec`; Blaise and Vivien are Ice already), Etain's turrets inside; carry-overs: Reaver aura, Minstrel songs (`pulse_cancelled`), the Savage out of the river, Etain's `petAttack:out_of_range`, Morgause's Vitality Theft |
| S6 | **Voice and lfg** | new `sdk/group/voice.ts` and `sdk/group/lfg.ts` (+ tests), their hooks in the coordinator and the director by agreement with S3 | group chat calls live by 17:00; `/region` calls by 19:00; "lfg" on the throwaway by 18:30, live after |

**Overlaps.**
- S3 and S4 both touch the director. S3 owns calls, musters and the defence; S4 owns who is online, balance and when a muster is called, in `lifecycle.ts`, with one hook in the director. Each commits only its own hunks after the other's import check.
- S4 and S6 both log bots out (sessions, "lfg"): both use S1's log-out and log-in, never their own.
- S2 writes plans as data and pure functions; S3 calls them from `rvr.ts` and the director.
- Client changes (the 0x99 door state, S1's log-out and log-in) need a swarm restart: any time before 02:00, not during the user's hour.

## Timeline (13:00 on 11-13 to 08:00 on 11-14)

Times are targets. Work moves on when ready; restarts whenever faster, except during the user's hour and the hands-off window.

- **13:00-13:30, start (S1).** The stay-awake script; gateway; the 60 in one swarm (the handover's commands); field mode with the night's flags (`--mix=6,6,3,2,1,1 --director=on --raid-every=30 --muster-after=3`), nothing new loaded. The user pauses Windows updates. S2 brings up a throwaway stack (`bun run server:throwaway up`) for the keep; the shared server stays field mode's.
- **13:30, the supervisor's first version (S1):** restarts field mode and dropped clients. More comes through the day.
- **13:30-15:00, the opening run.** Verdicts, and the "alive" numbers as the "before". S4 takes the gear-condition reading for all 60.
- **15:00-19:00, build, landing as ready.**
  - S6: group chat calls live by 17:00.
  - S2: a unit through its own door and up the stair on the throwaway by 16:00, then the stands.
  - S3: help in time first, then the defence call and the moment to raid.
  - S4: the life cycle offline, with S1's log-out and log-in.
  - S5: healers first, then the bomb and turrets.
  - S1: the user's hour rehearsed by 18:30; one swarm restart for client changes before 19:00 if any are ready.
- **From 19:00, the user's hour, if they come.**
- **19:00-02:00, everything goes live and settles.**
  - The life cycle on by 20:00: bots log in and out by the curve, so the evening is full and it thins toward midnight.
  - The first defence from the walls; raids at the right moment; a capture of a defended Faste is the thing to see.
  - `/region` calls; "lfg" if it held.
  - One deliberate gameserver restart in a quiet moment, around 00:30-01:30: the supervisor must bring the world back alone. (`docker compose -f server/docker/docker-compose.yml restart gameserver`.)
  - Everything that has to land, lands by 01:45. At 01:45 S1 checks every process is up and nothing is mid-edit.
- **02:00-08:00, hands off.** The world runs with the supervisor only. Sessions read logs and note what they see; fixes wait as patch files in `groups/notes/`, never in the working tree, until 08:00.
- **08:00, the morning report (S1)** in this file, from the window's logs. The world stays running under the supervisor, and the stay-awake script stays on, until the user says stop. Throwaway stacks come down. The "Pending items" memory gets a handover.

## Measures for the morning report

- **On its own:** time playable with nobody's help in the window; drops and recoveries by the hour; the gameserver restart and how long the world took to come back.
- **Life cycle:** bots online per realm against the curve; sessions played (count, lengths); balance (time outside 1.5 to 1); waves (fights per hour, quiet between).
- **"Alive":** before (the opening run) and after (the window).
- **Help:** as last night, plus time from call to arrival and distance at the call.
- **The keep:** each defence (units in, stands, time held, kills from the wall, by bombs and turrets, result); each raid (moment, result, dead, rezzed in the raid, waves back); changes of hands.
- **Healers:** time in an enemy's sight, group heals cast.
- **For a human:** group chat and `/region` lines per hour; "lfg" requests and time to an invite; the user's hour if played (minutes, deaths, heals and rezzes on them, kills left to them, whether the group chat told them enough, what they said).
- **Gear:** condition at 08:00 against 13:30, and whether a repair trip was needed.
- **Load at 60** and log sizes.

## Verdicts on the night's fixes (S1, during the opening run)

| What | Commits | Look for | Verdict |
|---|---|---|---|
| Walls block line of sight | c1a48b7, cf0bba3 | fewer deaths to wall Wizards; our casts refused through walls (`not_visible`) | |
| The Faste's ranks by line of sight | fb9173e, a2ad09e | the gate taken by melee alone, then the courtyard set; the west wall skipped | |
| Shut enemy doors are walls on the navmesh | 8e0a8d7, d7bc5af | nobody inside before the gate breaks | |
| Melee only on what they can reach | e80c2bf, 2baafeb | no climb up the inside wall | |
| Only a fighter pulls the raid off the lord | 48fa6a4 | the lord phase holds | |
| The lord hold; the go waits while defenders outnumber us | 59b44a0 | raids ending `captured` instead of `timeout` | |
| Warden: face after the side step; no heal retried each second | 8a0212a | Aine's styles landing | |
| Turret and servant drop their list near crowd control | 23cef5c | `Broke cc` per sortie | |

## Deferred (not this stint)

- The login script on the server (new characters at 24, promoted, built, geared, bound): only the user plays for now, on a ready character.
- 8-man groups, `/bow` and the other manners beyond idling at the portal keep, guild tags.
- Remote login for friends (phase 3).

## Rules

- Never take control of a bot in field mode. `rvr.ts --help` starts a real run. `field.ts` has no import.meta.main guard: never import it.
- Never kill a client; quit cleanly (`bun client/dev/swarm-check.ts <bots> --seconds=0 --quit`, or S1's log-out).
- At most 10 messages to other sessions per user turn, no acks. Shared facts go in this file.
- No roster knowledge: read enemies by `classGuess`; choose stands by spells, not names.
- The machine stays awake (memory "Unattended runs stay awake"). The user pauses Windows updates before the start.
- While the user is in game: no swarm or field mode restart, no edit to `hibernia`'s strategy, without their OK.
- 02:00-08:00: hands off (milestone 1).

## Still open for the user

- How long the world runs after 08:00 (until the user says stop, by default).
- Whether bots are marked as bots (the plan doc's open question).
- From the last handover: pushing 67301d3, the upstream PRs in `docs/upstream/`, archiving R2-R8 and "Keep walls block line of sight", the old branches.

## S1: Coordinator (status)

**13:30. Running under the supervisor:** gateway, the swarm of 60 with a control folder, and field mode with the night's flags, all started and watched by `bun scripts/supervisor.ts groups/supervisor.json`. Log: `groups/supervisor.log`; process logs `groups/stint2-{gateway,swarm,field}.log`. The keep-awake script runs from S1's session.
- To stop everything cleanly: `touch groups/supervisor.stop` (field mode stops, the bots quit, then the swarm and gateway end).
- **To restart field mode with the current code: `touch groups/field.stop`.** field.ts deletes the stop file as it ends, so the supervisor starts it again 10 s later. Its flags: the supervisor's command line plus `groups/field.flags` (one flag a line; the file wins), so flags change without a supervisor restart.

**13:32, field mode restarted (S1) with:**
- the life cycle in **shadow** (`--life=shadow` in `groups/field.flags`): it plans and logs to `groups/lifecycle/` and the field log (`life:` lines), logs nobody in or out, and doesn't touch the line-ups. `--life=on` gives it the unit sizes and who plays; `--raid-every=life` (needs on) musters by numbers instead of the 30 min timer;
- the directors stopped first on a stop file (S3's ask), so an open muster closes as `stopped`;
- **`groups/lifecycle/pinned.json` "away"** honoured at every line-up, life cycle on or off: a bot listed there is never picked. Emer is in it for S5's respec trip (S5 takes her off). Niamh goes in it for the user's hour.
- field.ts is private (git-excluded): these changes are in the working tree only; the previous version is in S1's scratchpad.

**13:38, field mode restarted again (S1) for S6:** a unit's size counts its observed members (a human takes a bot's place), and the directors' calls go out in `/region` (`regionVoiceHook` in each director's onUpdate).
- **The lfg watcher** runs under a second supervisor (`bun scripts/supervisor.ts groups/supervisor-extra.json`; log `groups/supervisor-extra.log`, process log `groups/stint2-lfg.log`; stop with `touch groups/supervisor-extra.stop`): `bun sdk/group/lfg-watch.ts --units=hibernia --presence=swarm`. Only `hibernia` takes a human for now; `--presence=lifecycle` once the life cycle is on.

**Logging one bot out and in (for S4's life cycle and S6's lfg): the swarm's control folder.**
- `bun client/swarm-control.ts logout <bot> [...] [--wait=90]` and `bun client/swarm-control.ts login <bot> [...] [--wait=120]`; `bun client/swarm-control.ts status`.
- From code: `requestControl('login' | 'logout', bot)` and `readControlState()` from `client/swarm-control.ts`. The swarm acts within 3 s; `groups/swarm-control/state.json` says each bot's `online`, `logging-in`, `leaving` or `offline`.
- A logout is a clean quit (up to 60 s after combat). A login for a bot still quitting waits for the quit. Checked live on Enid at 13:24: out in 10 s, back in 10 s.
- Never quit or start clients any other way.

**Found at 13:24: 13 of the 60 weren't in Thidranki, and the cause will hit every logout.**
- At login the server moves a character standing near an enemy keep, or a keep in combat, to its bind point: "This area isn't currently secure and you are being transported to a safer location" (`PlayerInitRequestHandler.cs:141-153`, `CheckNearbyKeepAndMoveIfUnsafe`, within visibility distance of the keep).
- Every character's bind is at its realm's portal keep outside the battleground (Castle Sauvage for Albion, Druim Ligen for Hibernia, Midgard's own), not in Thidranki. So a bot that logs out near the Faste, while it is an enemy's or in combat, comes back outside and stays there: field mode never put Gawain, Morgana, Tuck, Mordred, Merlin, Enid, Fionn, Niamh, Aine, Cathbad, Etain, Amergin and Laoghaire in a unit. Last night may have run on fewer than 60 for part of the time.
- Brought back at 13:27 with `enterBattleground` (portal keep, bind, medallion, port): all 13 in Thidranki and bound at their portal keeps.
- **For S4:** a bot the life cycle logs in must check its region and, outside Thidranki, walk back in (`enterBattleground` for that bot, as `groups/_template/battleground.ts` does for a group) before it counts as online. Better still, log out away from the Faste. **For S6:** the same for a bot that comes back after an lfg.

## S5: Kits

**13:40, healers landed (608577c), live at each unit's next sortie.** Import check clean (90 group and character modules), `bun test sdk/classes` 347 pass.
- **Group heals:** the Cleric (Enid, Nimue) casts Heaven's Commendation and the Healer (Eir, Sigrid) Favor of Battle through the Druid's `groupHeal`: three or more around her each missing most of it, in a fight, above 30 % power, not under a melee. Result kind `groupHeal` in the reports.
- **The stand** (`sdk/classes/healer-stand.ts`, Druid, Cleric and Healer kits): in a fight, while nobody in her reach is under the heal line (or an enemy is casting at her), a step of at most 450 out of every free enemy player's sight (terrain, keep walls, buildings), keeping the members in her reach within 1800. Result kind `stand`.
- **Time in an enemy's sight (the morning report's measure):** each Druid, Cleric and Healer notes it at every fight's end in its unit's run log: `<Name>: in enemy sight 12.0 s of 41.5 s in the fight (29 %)`. `grep -h "in enemy sight" groups/*/runs/*.log` gives every fight.

- **First readings (13:20-13:26 local, before the stand could have moved anyone much):** in enemy sight Brigid 39-63 %, Eir 94-100 %, Sigrid 56 % of fight time. One stand walk timed out (now a step part of the way, b9eeb33).

**13:45, the keep pieces (part 1) and the carry-overs.** Import check clean after each commit, `bun test sdk/classes` 354 pass.
- **The bomb (d1e94ac):** `sdk/classes/pbae.ts`, `pbae` in the Enchanter and Wizard kits. It casts the top point-blank rank (at least 100 damage) when 2+ enemy players or pets stand within 240 (3D), nothing under our cc is within 380, and no melee swings at the caster. Blaise and Vivien (Steaming Blast 133) have it now. Ciaran's Light build stays under the floor. Emer gets it after her Mana respec.
- **Emer's respec:** Thidranki has no trainer (the nearest Enchanter trainer is Anwar in Tir na Nog). Ready in `groups/s5-emer/` (one-member group: `cloak-trip.ts --stay`, `choose-build`, `train.ts --respec`, `cloak-trip.ts` back). Waiting for S1 to keep her out of line-ups for ~20 min.
- **Etain's turrets inside the gate and on the stair:** waiting for S2's defence orders (what a defending member reads, and where). Asked S2.
- **Reaver (c6d5408):** the aura's on/off now comes from its pulses (each pulse is an effect animation from him on himself). A stop goes out during the recast timer: the server cancels a running pulse before it checks the timer, and only castSpell's client-side check refused it.
- **Minstrel (2bc0d51):** the `song: pulse_cancelled` were mostly song()'s own deliberate stop in a quiet phase, recorded as a failure, and every singer had them (Oisin 1174, Elaine 1037, Tuck 790 in the run logs). Now a `songStop` success (one hunk in `sdk/group/behaviors.ts` song()). One song at a time is the server's rule for every singer. `cc: pulse_cancelled` is a stuck flute mezz cleared by the next one: a lost turn, left as is.
- **Etain (2bc0d51):** `petAttack:out_of_range` was keep targets: the lord, Lady Thidranki, wall Scouts, 1182-1233 from the turret in 3D, which the kit measured on the ground. Turret reach and plant spot are now 3D.
- **Morgause (2bc0d51):** Vitality Theft `no_response` was the servant mid-cast: the server queues the new spell silently, and the power is paid each time. The servant now reads as busy by its own cast animation, and a `no_response` holds the next spell. `walk:water`: a refused walk-in holds 8 s at the bank (`noteWet`).
- **Savage (e082ebe, guide only):** never in the river. Water refusals are the dry move guard plus the 8 s hold working; `stuck` is "max speed 0", so rooted or stunned. Two ideas for the shared `assist` are in `learnings/classes/savage.md`; not done.
- **For whoever owns it:** `bun test sdk/group` has 2 failures from the uncommitted `loiter` behaviour now last in the role lists, after `rest` (`behaviors-lull.test.ts`, `withPets ... RvR lists`). Not from S5.

**13:50, Emer is a Mana Enchanter (Mana 24) and back in play.** Out through the cloak trip, respecced at Anwar in Tir na Nog (Light 22 and Mana 9 regained, Mana 1 → 24), back in Thidranki and bound at Druim Ligen, and off `groups/lifecycle/pinned.json`'s away list. She knows Disenchanting Emission, so `pbae` and S2's `bomb` job take her. Her old build was the catalogue's "Light nuker" unchanged (a copy is in my scratchpad). Ciaran stays Light.
- One thing seen on the way: when field mode closed the unit she had been in (13:33), it connected to her for a moment while she was already pinned away, and that ended my trip script (`BotPreemptedError`). It was harmless and I ran the trip again, but a script driving a pinned bot at a unit's end gets cut off.
- **Etain's defence turret (4bfb241):** reads `settings.defence.seats[name].ground` from S2's plan.

## S4: Life cycle

**13:50, offline and committed (e90e362, ccfabe0), not on yet.** `sdk/group/lifecycle.ts` + 23 tests; `sdk/group/waves.ts` hooked into `rvr.ts` (no wave file: no change). field.ts side for S1: `S4-lifecycle-field-side.md` in the sessions' notes folder (flag `--life=on|shadow|off`, `--raid-every=life`).
- **Sessions:** 1-3 h, rest 20-90 min. A bot whose session ends is `leaving`: field.ts leaves it out of its unit's next line-up (`mayPlay`), and once no unit holds it the life cycle asks S1's swarm control to log it out. One log-out per realm per 90 s, up to two log-ins. A session ends even if nobody comes in at once (one under the target is fine), except the floor.
- **Curve** (per realm, by the hour, linear between): 0h 14, 2h 10, 3h 8, 4-6h 7, 9h 10, 12-15h 12, 17h 15, 18h 17, 19-21h 19, 22h 18, 23h 16; floor 6. Simulated day (Hibernia, 24 h): within 1 of the target every hour; median session 2 h 6 min.
- **Mix from who plays** (`mixFor`, capped by `--mix`): 19 → 6,6,3,2,1,1; 13 → 5,5,2,1; 12 → 6,3,2,1; 8 → 5,2,1; 6 → 5,1. A unit sized 0 sits its next sortie out.
- **Needed classes:** a main group's `requires.classes` (and a healer when none of those heals) stay on until another of the class is rested (up to 5 h), counted for the groups an hour ahead. **Finding:** Hibernia has two Druids and two Bards, so with two groups for ~9 evening hours the second group goes without one about 15-30 % of that time (each takes its 20-min break every ~5 h). One group: covered > 98 %. More Druids/Bards in the pool would fix it (a user call).
- **Balance** (each realm's own board only): ours seen within 4000 of an enemy vs distinct enemies of each realm seen, 20-min window; one side over 1.5× for 10 min moves the realm's target by one (±3 at most), back toward 0 after 20 min even.
- **Raids by numbers** (`wantsMuster`): ≥14 online, ≥10 alive out, 25 min since the last, not holding the Faste, not outnumbered. The go is the director's (S3).
- **Waves:** a realm goes out (toward its last sighting outside enemy spawns); once out ≥12 min with its last fight over 90 s (or 30 min with none), a 4-7 min break: main groups walk to their own spot round the portal keep's arrival and idle (`loiter`: sit, turn, a step, stand). Fights, help calls and the muster come first. Squads keep roaming (not hooked).
- **No director hook needed** (S3): the life cycle reads `director.lastBoard()` and `director.muster()` from field.ts, and field.ts starts the muster.
- **Gear wear, 13:19 (opening):** all 60 read from the gateway's `/state` (observe only). Mean condition 100.0 %; lowest a weapon at 97 % (staffs, Merlin's, Galahad's sword, Thorgrim's axe), armour 100 %. `groups/lifecycle/gear-wear.jsonl`; again at ~15:00 and ~02:00 (`bun groups/gear-wear.ts --label=...`). Repair trips only if it falls toward 90 %.
- **Logins outside Thidranki (S1's finding, 87efefc):** a bot that logs in outside the battleground, or one no unit holds found outside, is `entering`: the life cycle takes it back in itself (`enterAlone`: enterBattleground for that bot alone, by its own control connection, never a bot a unit holds) before it counts as online; retried every 4 min, after 20 min it logs out to rest. A leaving bot within 7000 of the Faste (whoever holds it) or an enemy portal keep waits to log out (`logOutUnsafe`; the server looks within 6000). After a sortie field.ts walks units home first, so this is the rare case.
- **Shadow means no effect on play (452a364).** The first shadow run (13:32) still wrote the wave files, which the main groups (all restarted 13:32-13:36 with the hook) would have followed into breaks at the keep, spoiling the "before". Blocked at 13:36 by directories in the files' place (the running field.ts logs `wave file: EPERM` every 30 s until its next restart; harmless). From the next field.ts start, shadow writes no wave and `writeWave` clears the directories itself under `on`. Pinned-away bots (Emer's respec trip, Niamh) are now left entirely alone.
- **For the supervisor (S1):** a bot the life cycle logged out is not a dropped client: read `groups/swarm-control/state.json` or `groups/lifecycle/state.json` before bringing one back.

## S2: The keep

**13:25, own doors and the defence plan landed (4c97350, 3e10179, e6b42ed); nothing calls the defence yet, so nothing changed live.** Throwaway stack `s2keep` (game 10310, gateway 7823); the shared server untouched. Import check 23/23 rvr.ts; tests: own-doors 15, siege-defence 19, defence 4, siege/raid 88.
- **Own doors (`sdk/doors.ts`, `walkTo`):** where a planned route passes a door registered as ours, the walk stops 90 out, `sendInteract`s, and watches for the server's jump (150 past a gate, 100 past an inner door or postern, at the door's z), then plans on from the other side. A door that doesn't open is dropped (walk reason `door`). Doors are registered by `applyDoors(layout, { ours: true, broken }, mesh)` / `openOwnDoors(plan, broken)`; with nothing registered `walkTo` is unchanged.
  - **Live (throwaway, an L24 Albion Wizard, Albion holding the Faste):** interact at 116 out → 150 inside in 47 ms. Outside the gate → up the wall-walk stair → (33877, 38851, 3978) in 9.4 s; back out the same way (34201 → 34536). From Albion's rally over its bridge, through the gate, to a wall stand in 85 s.
- **The defence plan (`sdk/group/siege.ts`, pure):** `defencePlan(realm)`, `defenceJobs({ role, spells, archer? })`, `defenceOrders(plan, { defenders, foes, owner, seats })` → `{ phase: going|holding|roof|lost, seats: Map<id, stand>, threat }`, `defenceRouteFrom(plan, at)`, `openOwnDoors(plan, broken)`.
  - **Jobs by spell and group role, never by name:** a point-blank bomb ≥ 100 → `bomb`; an Animist turret → `turret`; role healer → `heal`; a ranged nuke ≥ 1000 (not tank/melee) or a bow → `wall`; else `yard`. A full job hands the member to its next.
  - **The Faste's stands (measured):** bombers 120 inside the gate (the server's point-blank AE has no line-of-sight check, so it reaches the melee breaking the gate at 210) and at the two stair tops (wall-walk, roof); turrets inside the gate (ground target in `stand.ground`); the ranged on five wall-walk spots that each see 155-175 of 202 courtyard points; healers by the wall stair's foot; melee behind the gate (leash 700). **No wall-walk spot sees outside the gate, and nothing outside sees them** (the merlons), so the wall fights once the gate is down; until then only the gate bombers reach the gate-breakers. `roof`: foes within 700 of the lord send the courtyard and the healers to the roof.
- **The member side (`sdk/group/defence.ts`):** `defenceSettings(plan, orders, idToName, broken, prev)` → `Orders.settings.defence`; `holdDefenceStand` (put first in each role's list while it's set) walks in over the bridge and through our doors to its stand, and falls through on it (or within its leash in a fight) so the kit fights from there.
- **For S3 (interface sent 13:20):** at the defence call, per tick: `openOwnDoors`, `defenceOrders`, the settings patch, the behaviour first. Next for me: the pathing in `actions.ts` (the straight last step and the chase), then a defence on the throwaway with a few members, then live (19:00-02:00).
- **0x99 door state:** not needed so far (doors broken are read from chat as before). If it becomes needed it goes to S1 for a swarm restart before 19:00.

## S3: Director

**13:35 (bun clock, CET), all five pieces committed:** 75e95a1, 0bfc215, 5ffd895, da83f8a, 20e084b, 1c8250a. Tests: director 34, raid 24, defend 4, rvr/help 126. Import check: 23/23 guarded rvr.ts files. The units' side (rvr.ts, tactics/help.ts, raid.ts, defend.ts, behaviors.ts) goes live at each unit's next sortie. The director side is live with field.ts's restart at 13:32:25 (after 1c8250a at 13:30), so all of it.
- **Help in time (75e95a1, live):**
  - A unit calls `sighted` on first sight: 3 or more of one realm within 5000, more than ours there, in a fight or not. Helpers may come from 9000. A call's reason only gets worse (a `why` event).
  - The caller falls back toward the nearest helper coming, unless the enemy stands that way. Helpers within 2500 count on its side, so it turns when they meet. Reason: `fall back toward <unit> coming to help`.
  - A free main group farther than 4500 from the nearest friendly unit closes to 3000 first (`roam near: ...`). It roams by a main group first, a trio only when no main group is out (1c8250a). `--roam=false` turns it off for a run.
  - First live look, 13:16-13:29: 26 `sighted` calls (Midgard 14, Hibernia 12). midgard-s3's two calls had midgard-s2 and -s4 arrive. 74 `roam near` lines.
- **The defence call (da83f8a + 20e084b, live since 13:32; members' jobs by their own spells from S2's abcd848):**
  - While we hold the Faste and 2 or more enemy players were seen within 4500 of it, a `defend` call (why `keep`) asks the nearest main groups in until we outnumber the attackers, at most half the running units. Help calls go on with the rest.
  - A unit asked in seats its members on S2's stands each tick (`Orders.settings.defence`) and holds them (`holdDefenceStand`). It doesn't hunt or fall back.
  - The call closes `quiet` 45 s after the last attacker was seen, or `lost`.
  - Squads don't answer it yet.
- **The moment to raid (5ffd895, live since 13:32):** the go waits for few defenders seen at the keep (at most half the raid's living, at least 2), unless the owners are seen fighting the third realm far off (3 or more, over 8000 out). With the third realm at the keep too: as many or more, hold `winner` (take it from the winner); fewer, go with them on the weaker side. The stage event logs `defenders`, `third`, `ownersAway`, `owner`.
- **Raid fixes (da83f8a, units' side live):**
  - A corpse in a raid holds its release for a rezzer of any raid unit it sees near. A rezzer takes another unit's corpse once none of its own needs it (`await_rez <name> (raid)`).
  - The stage's whole-raid wait counts units still closing on the target, at any distance (the director's `onWay`; a unit that hasn't come 1000 closer in 2 min drops out).
  - A squad waits at the last approach waypoint 3000 or more from the stage (Hibernia (34500, 35200)) until a main group on its way has passed: `squad waits for <unit> to pass`.
- **Stop order (S1, done 13:32):** field.ts stops every director as soon as the stop file appears, before the units end; open calls close as `stopped` and stay out of the "alive" numbers.
- **Measure:** `bun sdk/group/director-report.ts --since=HH:MM [--until=HH:MM]` prints last night's columns plus first sight, call to first arrival, the nearest unit at the call, the ask distance, and with help against without. Last night's run B (22:28-01:54) reads the same as the morning report: on 308 calls, 26 % arrived, first arrival 22 s (median), ask 5231 away.

## S6: Voice and lfg

**13:36. Group chat is live (68a3638, refined 24fd9a9); `/region` and "lfg" are committed and wait on S1's field.ts hunks (below).** Tests: voice 22, lfg 7. Import check 85/85 (rvr.ts and character.ts files).
- **Group chat** (`sdk/group/voice.ts` pure, the hook in `sdk/group/runner.ts`): the run's leader says in `/group` what its coordinator decided, once a decision has held 1-1.5 s (a flicker is never said), within limits: a line every 3.5 s at most, 6 a minute (pulling back and the wipe skip the cap), no same words within 20 s. The lines, from the orders and the board (foes by their class read, never by roster):
  - `going in, focus the Druid` / `switch, focus the Troll` / `next Celt`;
  - `pulling back to our PK, stay with me` (a place only when it is one: our PK, the mid bridge, the Faste);
  - `inc 4 mids and 2 hibs north of the Faste` (first sight, then only when it grew by 2+);
  - `mezz on the Troll, leave it`; `rez Eir and Leif`; `wiped, release and meet at our PK`;
  - `too many for us, steering clear`, `friends need help, heading over`, `on to the Faste, keep together`, `rest and buff up here`;
  - for a human (observed member): `hi Niamh, stick with us and /assist Gawain, I call the targets here`; dead: `Niamh, don't release, rez coming`.
  - Every line is in the unit's run log as `said: ...` (`grep -h "said:" groups/*/runs/field-*.log` for lines per hour). A solo says nothing. `DAOC_VOICE=off` silences it.
  - First live hour (12:16-12:33 UTC): every realm talking, about one line per unit a minute; the four lines that read badly (re-said inc for every +1, three rez lines in a row, "pulling back to north-east of the Faste", solos) are fixed in 24fd9a9.
- **`/region`** (`regionClaims` in voice.ts, `sdk/group/voice-io.ts`): the director's update in, one line every 5 s at most per realm (5 a minute), said by a unit's leader with `/region` (only our realm hears it):
  - help with count and place, by the caller: `6 mids at the mid bridge, need help`, `4 albs coming north of the Faste, need help` (sighted), `3 hibs on us at our bridge, help!` (caught), `2 mids camping our PK, need help`; again only if it grew by 3; `omw` by each unit that answers coming;
  - the muster: `Faste raid, gather at our bridge`, `5 on the Faste, wait at the rally`, `they are fighting at the Faste, wait for the winner`, `go go, Faste!`, then `Faste is ours!` / `raid broke, back to our PK` / `too many on the Faste, calling it off`;
  - the defence: `Faste under attack, 5 albs there, defend!`, then `Faste holds, nice` / `Faste lost`.
  - Transport: the director's process writes `groups/director/<realm>-voice.json` (the line and the unit to say it); each unit's run reads it and its leader says the lines named for it (lines older than 12 s are dropped). Nothing in director.ts changes.
- **"lfg"** (`sdk/group/lfg.ts` pure, `sdk/group/lfg-watch.ts` the process): a human whispers any bot of their realm `lfg` (or `lfg ment`, `any room?`), or says it in `/region`. The bot answers `sure, what class are you?` if the words named none. The watcher picks the realm's main group missing the human's role (then the fewest of it; never a squad, one human a unit), and one bot of it steps out: of the human's role if it has one, else of its most doubled role, never the leader nor a required class (Druid, Bard). Then: group.json gets `observed: [{ name }]` and the bot goes to the bench (under `.editing`), the bot logs off, the asked bot answers `inv coming from <leader> in a minute, ...`, and the unit's run winds down so the next sortie invites. Once the human has been out of the leader's group window 45 s (or never joined within 8 min), `observed` goes and the bot logs back in. State `groups/lfg/state.json` (`held`: bots stepped out), log `groups/lfg/log.jsonl`.
  - **Rehearsed on a throwaway stack (s6lfg, game 10320, gateway 7797), 13:22-13:32:** five fresh Hibernians, one unit of four in a stand-in field loop (line-up size = 4 less observed), a script as the human. Whisper `lfg` → asked the class → `magician` → placed in 2 s (a Forester stepped out, logged off) → run wound down → next sortie invited → **joined 14 s after the ask**; welcome line in group chat; the human left with `/disband`, 45 s later observed removed and the Forester back in game. Again with `/region lfg magician`: joined 16 s after the ask. The LFG flag (the client's tick box) is not read: it needs a client packet (0x... LookingForGroup → find-group window), not done.
- **For S1 (field.ts, private, so these are yours):**
  1. `chooseLineup`: `const size = sizeOf(u);` → `const size = Math.max(1, sizeOf(u) - (def.observed?.length ?? 0));` (a human takes a bot's place).
  2. The `/region` hook, in the director's `onUpdate` (after the ledger): `import { regionVoiceHook } from '../sdk/group/voice-io';` and per realm `const regionVoice = regionVoiceHook(realmOf(g) as PlayerRealm, () => director.enabled, { log });` (declared before `startDirector`; `director` is read only when an update comes), then `regionVoice(out);` in `onUpdate`. Takes effect at a field.ts restart.
  3. Run the watcher under the supervisor: `bun sdk/group/lfg-watch.ts` (all realms) with `--presence=lifecycle` once the life cycle is on (S4 then does the log-out and log-in), `--presence=swarm` (default) before. It only reads the gateway (60 `/chat` reads every 4 s) and writes group.json under `.editing`; it never takes control. For the user's hour: `--units=hibernia` puts a human only in `hibernia`. Niamh pinned away (as planned) and logged off, the user logs in and whispers any Hibernian `lfg`.
- **For S4:** with `--presence=lifecycle`, a bot in `groups/lfg/state.json` `held` should be treated as a session ended now (leaving: out of line-ups, logged off safely) and never logged in while held; once it leaves `held` it rests as usual. Until then the watcher logs it out and in through the swarm control itself, and a bot it logs back in may land outside Thidranki (S1's finding): your `entering` takes it back in.
