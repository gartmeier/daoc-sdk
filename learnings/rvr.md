# RvR in a battleground

Three groups of bots, one per realm, fighting each other in Thidranki (region 252, levels 20–24): how they get in, what the server allows, and what the `rvr-roam` strategy (`sdk/group/rvr.ts`) does. Read [group-coordination.md](group-coordination.md) first: RvR runs on the same blackboard, coordinator, behaviours and observer.

Verified live on 2026-11-01 with three level-20 groups: Albion (Paladin, Cleric, Sorcerer, Cabalist, Theurgist), Hibernia (Hero, Druid, Bard, Mentalist, Enchanter) and Midgard (Warrior, Healer, Shaman, Skald, Spiritmaster), in eight 5–10 minute rounds with all three groups out at once.

## Quick start

```sh
bun client/swarm.ts galahad nimue merlin morgana taliesin        # one swarm per group (or one for all)
bun groups/camelot/battleground.ts                                 # town teleporter → portal keep, bind, medallion, port in
bun groups/midgard/battleground.ts --via=804367,723895,4680        # walk the group to a town teleporter first
bun groups/camelot/rvr.ts 300                                      # roam and fight; report in groups/camelot/runs/<stamp>.md
```

- **Watch** at `http://localhost:7780/viewer/region/252`: every bot in Thidranki on one map in realm colours, each group's run (phase, reason, focus, score), its anchor and route, and the keeps. `/viewer/group/<group>` has one group's picture, with the enemies it sees.
- `groups/_template/` has the scripts, so `create-group.ts` gives every new group a `battleground.ts`, an `rvr.ts` and a `cloak-trip.ts`. Run each group's `rvr.ts` in its own process: every group plans alone, on what its own members see.
- `bun run server:setup` turns on `bg_release_to_portal_keep` (see Deaths below). It restarts the gameserver when it changes anything.

## Getting in (`sdk/group/battleground.ts`)

Verified live for all three realms (`enterBattleground`, about 2.5 minutes from a town teleporter, most of it waiting for the port):

| Realm | Town teleporter keyword | Portal keep | Medallion merchant | Battleground teleporter | Arrival in Thidranki |
|---|---|---|---|---|---|
| Albion | `Castle Sauvage` | Castle Sauvage (r1) | Sall Fadri | Master Visur (585995, 477187) | (38113, 53507) |
| Midgard | `Svasud Faste` | Svasud Faste (r100) | Gwulla | Stor Gothi Annark (765329, 668749) | (53568, 23643) |
| Hibernia | `Druim Ligen` | Druim Ligen (r200) | Araisa | Glasny (333733, 420740) | (17367, 18248) |

- **Every town teleporter takes the portal keep's exact name** (case-sensitive, `teleport.sql`): the LiveTeleporters in towns (Master Visur, Stor Gothi Annark, Channeler Glasny), the InlandTeleporters at the keeps and the SimpleTeleporter "emissaries".
- **The battleground teleporter is found by position, never by name:** the portal keep's OFTeleporter is renamed to the realm's town teleporter name (`OFTeleporters.cs:712, 726`), and it ignores whispers.
- **It ports everyone within 500 who wears the medallion** (free, "Battlegrounds Medallion of Passage", Mythical slot 37) each time it casts: every `of_teleport_interval`, 120 s by default (the 45 s in the script's comment is out of date). The port uses up the medallion. Five members standing by it were ported together each time.
- **A worn medallion is in the equipment** (`sdk.getEquipmentItem(37)`), not in the backpack list, and `equipItem` succeeds a snapshot before it shows there: wait for the slot before checking it.
- **The merchants stand about 500 from the teleporter** (Gwulla 499, Sall Fadri 535, Araisa 507), inside its port radius: `enterBattleground` buys every medallion into the backpack first and has everyone put it on only once all five have one, so a member without one never splits the group across two regions.
- **Bind at the portal keep's stone first** (`bindAtPortalKeep`): a death outside the battleground then lands next to the medallion merchant. The recall stone doesn't work at a portal keep or in a battleground (`GatewayPersonalBind.cs:24`: RvR zones).

## Getting out (`sdk/group/battleground.ts`, `cloak-trip.ts`)

**Verified live (2026-11-01):** Camelot, Hibernia and Midgard each ran `cloak-trip.ts` from Thidranki to their capital and back, about 7 minutes a group, and all 15 came back wearing a cloak. It rests on `bot.useZonePoint` ([regions-and-zones.md](regions-and-zones.md)).

A battleground has no merchants, and the recall stone doesn't work there. The way out is a zone point of the realm's own, inside its portal keep there (`zonepoint` rows):

| Realm | Zone point | Source in Thidranki | Lands at (the portal keep outside) | City medallion takes it to |
|---|---|---|---|---|
| Albion | 63 | (38116, 53679, 4154) | r1 (585039, 477305, 2600) | Camelot, r10 (36226, 29820, 7971) |
| Midgard | 64 | (54842, 24053, 4320) | r100 (766160, 669487, 5736) | Jordheim, r101 (31746, 27429, 8792) |
| Hibernia | 65 | (18187, 17522, 4320) | r200 (334435, 419941, 5184) | Tir na Nog, r201 (34140, 32058, 8047) |

- **`leaveBattleground(members)`:** the dead released first (with `bg_release_to_portal_keep` that lands them next to the exit), each cluster of members walking together (`walkTogether`, round aggressive mobs and enemy keeps), on through an attack since the exit stands in our own keep. Nobody jumps before all stand within 300 of the exit. After an RvR run members stand all over: on 2026-11-01 Albion had three at the middle, one dead there and one released at the keep. Members already out are left alone.
- **`bun groups/<g>/cloak-trip.ts [--stay]`** (`cloakTrip`): out, the free Medallion of City Passage from the keep's merchant (`portTogether`: the steps `enterBattleground` uses, everyone's into the backpack before anyone wears one), the OFTeleporter's next cast to the capital, a cloak for each member lacking one, `wearAccessories`, the capital's town teleporter, `enterBattleground`. Each step looks at where each member stands now, so it can run again after a stop.
- **A medallion for another destination comes off before the buy queue** (`portTogether`): the cast goes by whatever is in slot 37 (`OFTeleporters.cs:193`, `:673`), so a stopped run's leftover would otherwise take its wearer away while the others buy.
- **A member holding a cloak needs no trip:** inside it stays inside, at the portal keep it waits for the rest, in the capital it buys nothing. With `--stay` everyone goes to the capital, cloak or not. A dead holder is still released, inside too: the dead can't put a backpack cloak on (`GamePlayerInventory.cs:653-661`).
- **Sellers:** Radek Silven in Camelot (1,215 from the landing), Hyndla Gunderson in Jordheim (8,931), Dierdra in Tir na Nog (6,201). From Dierdra the group walks back to Channeler Glasny (5,652); Hyndla stands 1,826 from Jordheim's second Stor Gothi Annark.
- **Before anyone leaves,** everyone alive who must come back is checked against the battleground's levels and realm points: a member at level 25 keeps the group inside rather than stranding itself.

## What the server allows

- **Players of different realms may attack each other anywhere in Thidranki:** nothing checks region, zone or area (`NormalServerRules.IsAllowedToAttack`). The safe-area check is commented out.
- **PvP immunity, 10 s:** after logging in, a region change (the port in) and a release (`AbstractServerRules.cs:235-261`). Two refusals: "You can't attack players until your PvP invulnerability timer wears off!" (ours) and "{name} is temporarily immune to PvP attacks!" (theirs). `attack`, `killPlayer`, `castSpell` and `petAttack` report both as reason `immune` with `retryAfterMs`: it covers a pet's order, whoever is immune. "Your temporary PvP invulnerability timer has expired." is the end of it, not a refusal.
- **Enemy players are named by race** ("Briton", "Celt", "Troll"), with no guild (`NormalServerRules.cs:292-338`): tell them apart by `objectId`. The board labels them `Celt#410`.
- **How long crowd control holds a level 24 player:** Suppress Movement about 19 s (31 in the DB), the board's mark about 17 s; Sedate 43 s and Mesmerizing Hymn 42 s, their DB time.
- **Their health is known** (every 0xA9 position relay carries it), **their target is not:** the server sends a target only to its own client. The blackboard infers it from the player's last melee swing, or a spell effect on someone of another realm, within 6 s (`observeState`, `PLAYER_AIM_MS`: two-handed weapons at these levels swing every 4.4-5.4 s). A spell effect on another player of its own realm marks it as a healer, a cast start as a caster; both stick for the contact.
- **Deaths:** an RvR death costs no experience and no constitution (`GamePlayer.cs:5920-5944`). After a revive: "RvR Resurrection Illness", 60 s.
- **Kills give experience, hardly any realm points:** a level-20 victim is worth `max(1, (level-20)²) + realm level` = 1 RP, split among everyone who damaged it, so 0 RP each (`PlayerKillRewardProcessor.cs`). In round 2 members made up to 6M XP/h and 0 RP. Watch the levels: Thidranki takes 20–24, and a member above 24 is moved out at its next logout (`rvrFindings` warns at 24).
- **Keep guards attack enemy players** within 2000 at a portal keep (level 255, speed 575) and 1000 at Thidranki Faste (`GameKeepGuard.cs:803-806`). The LoS check goes to the target's own client, which always answers clear, and the keeps load without walls (`keepcomponent` is empty), so nothing gives cover. The strategy stays 4500 from enemy portal keeps and 3000 from a keep that isn't ours (`keepDangers`, `sdk/group/keeps.ts`): patrols and routes go round those circles, the fight's anchor never moves into one, and tank and melee never follow a player into one (`beyondLeash`); an attacker standing under the guards is answered by the casters, from range.
- **Thidranki's PvE mobs** (282 aggressive spawns, L20–28, aggro 500) sit away from the straight lines between the portal keeps and the middle; routes go round them (`safePath`).

## Deaths: release to the portal keep

- **By default a release in a battleground goes to the home bind point**, in another region: `bg_release_to_portal_keep` is off (`ServerProperties.cs:1353`). With it on, the release lands at the realm's portal keep inside the battleground (`GamePlayer.cs:1412-1427, 1560-1588`). `scripts/setup-server.ts` now sets it.
- Verified live: Hibernians released in Thidranki stood at their portal keep (18362, 18257) a moment later, 17–23k from the fight, and walked back.
- The coordinator treats members in another region as missing: they never hold the group up.

## The rvr-roam strategy (`sdk/group/rvr.ts`)

`defineStrategy(rvrRoaming, { name: '<group>-rvr', settings: {...} })`. Phases are the PvE ones (`travel` for every walk, with the objective saying which):

| Phase | When |
|---|---|
| `engage` | an enemy player within `engageRadius` (2500) of the main body, or anyone attacking a member. Monsters only when they attack us and no player is about. Enemies standing in an enemy keep's circle are left alone unless they attack us |
| `retreat` | the enemy players against us outnumber the main body by `retreat.margin` (3; 2 until round 6), unless the focus is below `retreat.focusHp` (25 %). Toward our portal keep, or straight away when the enemies stand that way. Still followed after `retreat.maxMs`: stand and fight |
| `travel` (hunt) | enemy players seen within `huntRadius` (5000), not outnumbering us, at most one member not ready: legs toward them, re-planned when they move 800 |
| `travel` (fall back) | the same, but they outnumber us |
| `recover` | a member is dead (waiting for its release), or someone is below `ready` (75 % health, 50 % power) |
| `gather` | a member walks back from the portal keep: the main body meets it halfway, in fixed legs |
| `travel` (patrol) | otherwise: a loop of 5–6 waypoints on a ring of 5500 round the meeting point (34000, 32000), out of aggro zones and keep circles (`defaultPatrol`). Albion and Hibernia go round one way, Midgard the other, so they meet |

- **Main body:** distances are measured from the cluster of members where the fight is (round a member an enemy attacks, when that cluster has at least 2 members or half of the group), else the largest cluster, and no tie goes to a tank over `gatherRadius` × 4 from everyone else. A member walking back from the portal keep is not part of a fight, and a lone member attacked far away fights or flees with its own behaviours while the group gathers toward it. Round 1: three released Midgard members outnumbered the two still fighting 16k away, got every mezz assignment and logged `cc: not_found` 59 times.
- **Hostile:** an enemy player is a threat to the group only when its inferred target is a member, a member attacked or hit it, or it swings or casts within `hostileRadius` (2500) of a member. An enemy fighting the third realm 5000 away is not.
- **Who counts as "against us":** the largest single realm's free players (not mezzed, not busy with the third realm), plus any player of the other realm attacking us. Two other realms fighting each other are two groups, not one: before this, a 5 v 5 between the others made the third group retreat from "10 enemies".
- **Focus:** kept while it lives (no target thrash), unless another enemy drops below `switchBelow` (25 %) while the focus is above 45 %. A new focus by score: healer +60, caster +30, on one of our healers or casters +20, missing health, near our centre.
- **Crowd control:** `assignCc` over the other enemy players in reach of the main body, mezzers first. A member casts on the first target its own client sees, of a kind it isn't immune to; an assignment whose target is still free after 8 s goes to the next one. What repeats do on the server, and what breaks what: [spells.md](spells.md#crowd-control-what-repeats-do). What the board remembers: [group-coordination.md](group-coordination.md) "Crowd control on the board".
- **Behaviours** (`rvrBehaviors`): the PvE lists without the town `healer` visit. Against a player: no hold wait (players have no aggro table), the tank uses its damage style (taunts move nothing), `killPlayer` instead of `killNpc`.
- **`chaseLeash` (2000):** the tank and melee don't chase an enemy player farther than this from the fight's anchor: a chase stops within 500 ms of the foe leaving it, or of the focus moving, and with the focus beyond it they fight the nearest enemy inside it instead. The coordinator keeps foci inside the leash: it prefers foci in reach, and moves the anchor toward a focus beyond it, not more than 1500 from the centre. Round 2: the Hero followed fleeing players and logged 192 "ran beyond 3000 units".
- **Which mezz:** `Spellbook.cc()` takes a single-target mezz first, an area mezz only with `aoe` (it mezzes the focus next to the add too), and never a point-blank one (range 0: the Spiritmaster's Dark Wave line, the Cleric's Heavenly Visions). Before, the highest level won, and Hrafna cast Dark Wave at enemies 1500 away ("No cast observed", 22 times in round 3) instead of her Hold Spirit.
- **Mezzed or stunned members wait** (`attack`, `killPlayer` and `castSpell` report reason `crowd_controlled` with `retryAfterMs` for "You can't attack when you are mesmerized!", "You can't cast while stunned!" and the like) instead of retrying every turn: round 1's tanks logged 63 and 84 of those. Before, a cast refused that way came back as `no_response`.
- **0 % is not dead for a player:** the server rounds health down, so a living player can read 0 %. A player dies by its death event or dead flag only (`isAlive`).
- **Retreat routes:** the retreat point is picked so the whole way there is clear of aggro zones and keep circles, and members run there round them (`safePath`). The perturbed bwca camp (~27500, 25600) lies between the meeting point and the Hibernia portal keep: in round 7 straight retreats toward home crossed it, and the bwca killed six Hibernians.
- **Far members rejoin a fight:** `holdFormation` walks a member more than 3000 from the fight's anchor back to it (after a release); tank and melee from beyond `chaseLeash`. Before, released healers stood idle at the portal keep through the whole fight.
- **Far from the fight, the way back comes first** (`rejoinFight`, in every RvR list right after `retreat`): over 5000 from the anchor a member walks back by `safePath` before any fight behaviour. Before it, `assist` walked straight at the focus and `killPlayer` failed `out_of_reach` before its first step. In round 10 Niamh died to the perturbed bwca four times on that line and Thorgrim logged 100 such failures; in round 11, none of either.

## Resurrection

A rez in RvR saves only the walk back, about 100 s: an RvR death costs no XP or constitution, and a release gives full health, power and endurance (`GamePlayer.cs:1668-1670`). It costs the rezzer half its pool at equal level, whatever the rank, so the strongest rank is always the one to cast. The member comes back with the spell's health and power, buffless, with 60 s of illness at -50 %. A released member loses its buffs as well, but its illness has mostly run out by the time it is back. So `RVR_SETTINGS.rez` is `{ holdMs: 60_000, sit: false, reserve: 25, inFight: true }`:

- **It pays only from what it has:** the rezzer never sits for it and must keep 25 % of its pool, so at equal level it needs 75 %. Without that a corpse doesn't wait for it, and releases.
- **Any rank will do:** a 10 % rez counts.
- **Also mid-fight, from where it stands,** when the group isn't under pressure (`rezPressure`): nobody within heal reach below the healing limit, no more free enemies than living members, no enemy on a caster or healer, and none on or next to the rezzer. Crowd control ordered on the rezzer comes first. Not in a retreat, or in travel, which can be a fall back.
- **Live (2026-11-03, throwaway stack, 3 Albion at level 20 against 1 Viking, a GM doing the killing):** with the enemy on a healthy tank, the Acolyte's Revive had the victim up 4 s after the death. With the tank hurt to 28 %, it healed instead and never cast; its power fell from 100 to 72 %, under the reserve, and the corpse released 11 s after the death.
- **Not seen live:** an enemy really hitting the rezzer, which fled instead (`flee` sits above `rez`), being outnumbered, and what a rezzed member lives through against real groups. Whether the reserve of 25 is right is a guess: at equal level a healer who has healed twice no longer rezzes.

## Live results

All three groups out at once, each `rvr.ts` in its own process. Kills count every enemy player the group hit before it died, so with three realms one death can count for two groups.

| Round | Length | Albion kills / deaths | Hibernia | Midgard | Change before it |
|---|---|---|---|---|---|
| 1 | 5 min | 6 / 0 | 4 / 6 | 3 / 4 | first fights: Midgard and Hibernia met at (37900, 33300) after 75 s, Albion arrived 30 s later |
| 2 | 8 min | 13 / 5 | 12 / 6 | 7 / 7 | main body = the cluster under attack; cc only on targets in view; backoff on no power and when mezzed |
| 3 | 10 min | 9 / 3 | 8 / 5 | 10 / 4 | `chaseLeash` 2000; it started from where round 2 left everyone (released members alone at their keeps) |
| 4 | 10 min | 7 / 5 | 14 / 4 | 7 / 4 | single-target mezzes only (no point-blank or area ones); a chase stops when the foe leaves the leash |
| 5 | 10 min | 10 / 2 | 8 / 4 | 4 / 7 | the review fixes: leash fallback and anchor drift, hostile only near us, mezz immunity on the board, `crowd_controlled` (round 4's `no_response` casts were members mezzed), players at 0 % alive |
| 6 | 10 min | 12 / 4 | 9 / 7 | 10 / 5 | Midgard alone on `retreat.margin` 3: 4 retreats instead of 12, while Hibernia on 2 spent 42 % of the run retreating (14×). 3 is the default since |
| 7 | 5 min | 6 / 3 | 3 / 8 | 6 / 3 | the final review's fixes (keep circles for tank, melee and routes; mezz-only immunity on the board). Six of Hibernia's deaths were to perturbed bwca: its retreats ran straight through their camp. Fixed after the round |
| 8 | 5 min | 6 / 4 | 6 / 2 | 4 / 4 | retreats clear of aggro zones: no deaths to the bwca, every death to players or their pets |
| 9 | 11 min | 9 / 7 | 11 / 9 | 13 / 5 | all at level 24, `/xp off`. Three of Hibernia's deaths to the bwca |
| 10 | 11 min | 9 / 5 | 9 / 10 | 11 / 5 | the level-24 gear template. Four of Hibernia's deaths to the bwca |
| 11 | 11 min | 11 / 6 | 10 / 7 | 13 / 4 | `rejoinFight` |

**Reading the table:** the kills column is close to capped. In rounds 9-11 each group is credited with 88-100 % of all enemy player deaths, so it mostly shows how often the other two die. Compare killing blows (`killedBy` in the victims' reports), realm points and deaths. Over rounds 9-11: Midgard 26 killing blows, 336 RP, 14 deaths; Albion 17, 216, 18; Hibernia 8, 199, 26.

**What separated the groups in rounds 9-11** (same settings and routines; three rounds, full analysis in `groups/midgard/lab_log.md`):

- **Melee damage:** Bragi, a second melee fighter, accounts for all of Midgard's damage lead. Melee needs no power, but a group that relies on it can be denied: in one 4-minute round against the Hibernia hit-and-run group (20261103-214813) its two melee fighters dealt 0.
- **Group HP and healers:** the other two spent about two thirds of their focus time on Midgard and dropped 66 % of those foci. Base HP is 2971 against 2526 and 2649, with two healers and one cloth member.
- **The focus score favours sturdy healers:** healer +60 sends a group at a Troll Shaman or Dwarf Healer rather than a 459 HP caster.
- **Not the cause:** geography (keeps 21.3-21.9k from the middle, fights at about (34100, 33600)), crowd control (Midgard's was the weakest) and staying together (about equal).

## Crowd control: wasted casts

Two groups of five in Thidranki, starter gear, 5 minutes each, counted by each bot's client from the server's answers (`sdk/test/live/cc-group-live.ts`). Stuns aren't in it: no behaviour casts one.

| | Crowd-control casts | Landed | Immune | Already on | Resisted | Wasted |
|---|---|---|---|---|---|---|
| Before | 36 | 22 | 9 | 1 | 4 | **10 (28 %)** |
| After | 30 | 25 | 0 | 0 | 5 | **0** |

- **The real rounds can't show this:** before this change a cast answered "immune" counted as a success, so round 9's reports (20261103-2038xx) have 116 `cc: ok` and no way to tell how many were wasted. Reports now keep them apart: `actions.cc` is what landed, and `failures` has `cc:immune`, `cc:already_on`, `cc:resisted` and `cc:no_effect`.
- **33 "broke" lines in round 9, 25 of them about roots,** most of them false: a rooted player swings and casts as before. Each freed its target for another root, which then got "already has that effect". A swing or a cast of its own doesn't break a root now: walking off does, and a landed hit of ours (`root on X broke` with X standing still), or of a pet's, which says so. A hit sets its 60 s immunity too, so it costs no second root.

## Pets in the rounds

A rehearsal on a throwaway stack on 2026-11-04, not the real rounds: three groups of five at level 24, gear template, `/xp off`, three realms at once, 180 s a round, each starting unbuffed from a set spot with no pets. Midgard (Warrior, Healer, Shaman, Skald, Spiritmaster) and Albion (Paladin, Cleric, Sorcerer, Cabalist, Theurgist) roam, Hibernia (Hero, Druid, Bard, Mentalist, Enchanter) runs the pack. So four pets in play: Spiritmaster, Cabalist, Enchanter, and the Theurgist's fire and forget. The Druid's L7 is under the half-level gate. No navmeshes on that server, no shade or turret in the lineup.

**Whether pets win rounds: not shown.** Kills / deaths / RP, three rounds each way unless noted:

| Group | Pets on, first | Pets on, after one fix round | Pets off | Off, a fourth round |
|---|---|---|---|---|
| Midgard | 11 / 11 / 44 | 11 / 12 / 20 | 9 / 8 / 0 | 4 / 3 / 0 |
| Albion | 10 / 11 / 45 | 9 / 11 / 17 | 8 / 9 / 3 | 3 / 4 / 0 |
| Hibernia (pack) | 22 / 0 / 67 | 16 / 0 / 90 | 14 / 0 / 139 | 6 / 0 / 35 |

Per round, after the fixes against all four off rounds: Midgard 3.7 kills and 4.0 deaths against 3.25 and 2.75, Albion 3.0 and 3.7 against 2.75 and 3.25, Hibernia 5.3 and 0 against 5.0 and 0. At n = 3 and 4 none of that separates on from off, and one 120 s round went 4 / 0 and 0 / 4 for two groups. Realm points are noise: "has been killed recently and is worth no realm points!". Fights are deadlier for everyone: 36 kills and 23 deaths across the groups on, 31 and 17 off. Hibernia's lead before the fixes (22 against 14) went once enemy tanks stopped swinging at pets, which fits, and this sample can't prove.

**What the fix round did show, three rounds each:**

| | Before | After | Off |
|---|---|---|---|
| Warrior's melee, on players / on pets | 302/256, 44/619, 188/305 | 254/0, 508/0, 638/133 | 198-617 / 0 |
| Paladin's | 176/365, 94/505, 33/344 | 215/0, 116/0, 169/0 | 58-342 / 0 |
| `kill:timeout` lines | 1, 3, 3 | 0, 0, 0 | 0 in the fourth |
| First attack order after the engage: Spiritmaster | +25.1, +19.1, +25.2 | +7.2, +7.0, +6.9 | |
| Cabalist | +24.6, +24.8, +27.2 | +3.5, +3.3, +3.1 | |
| Enchanter, in the pack | +0.3, +0.3, +0.7 | +0.7, +0.9, +0.6 | |
| On focus %: Spiritmaster | 51, 59, 23 | 87, 89, 87 | |
| Cabalist | 50, 59, 39 | 72, 63, 90 | |
| Pet damage: Spiritmaster | 353, 615, 299 | 1377, 1220, 796 | |
| Cabalist | 453, 451, 611 | 543, 346, 375 | |

- **The peel:** an ordered pet never turns (`ControlledMobBrain.cs:549-552`), so a tank peeling one timed out at 20 s, again and again. Now none is peeled while a player is the focus. The Warrior's 133 is one swing with a pet as the group's focus, "0 of 3 enemies vs 5", which is `decideRvr`'s rule.
- **The order's delay** came from crowd control's walk, which held the order 15-25 s. What is left is range: the focus starts 2550-2720 off and crosses the 2000 at about +3 for the Cabalist, +6 to +7 for the Spiritmaster. Mezzes land about as often, 44 of 59 cast against 44 of 66 before and 48 of 78 off, and the owners' first lands at +13 to +14 and +10, from +19 to +27.
- **That has a price elsewhere:** the Theurgist, mezzed at +13 to +14 for 16 s in all three rounds, cast no cc and no pet (before 1, 2, 2 and 4, 0, 3), and the Shaman's first cc came at +94 to +111 s (before +14 to +20). Position reversals over the 15 members rose to 15, 16, 9 from 9, 11, 7, against 0-3 off, with no loop found.
- **The melee fixes** (a chase that ends at the leash, a swing on a corpse) don't show in these rounds: the lineup has no melee role and `is already dead` read 0 lines in 11 rounds. A staged 85 s with a temporary melee role held: within 1388 and 1710 of the anchor with the first focus off to 5753, a swing on a dead target lasting one sample.
- **Not read:** the group page's chip and stroke with `enemy: true`, `/live` having an old gateway behind it.

**What pets did there, in the first ten rounds and small runs:**

- **No pet died in a three-realm round.** Died 0 in every row, every loss with its owner's death (3-9 a row). A summon goes 0.27 s after the release at the keep, 5.67 s, and the group doesn't wait: 180 to 585-672 from the tank by +18 s, and power back to 100 by first contact. Pets only died when hunted: in a probe round 2 ice beings and a spirit warrior.
- **Spiritmaster:** spirit warrior L21 at Summoning 2, 25 % of the pool, 299-742 damage a round before the fixes against his own 131-981, and 0-655 own with pets off. Intercepts hardly matter, 3 blows in 4 rounds, with the pet on the focus 300-1300 away.
- **Cabalist:** Emerald Simulacrum L21, up 88-97 %, 230-694 a round. Its Pet DOT broke the Sorcerer's mezz once in six rounds, which `petControl` can't prevent. It reached 9 % with him at full power and not one heal cast (`petHealUrgent` since, tests only).
- **Theurgist:** 0, 4, 0, 3, 1, 0 casts a round, Summon Aged Ice Spirit each time, and 343-776 damage in the rounds that cast, against his own 0-110 on or off. `pet.fnfLifeMs`'s clock lets casts through in long fights, and never blocked for lack of a reading; the 40 % floor never bound, lowest power 72-93. What limits him is crowd control above it on his list, and being mezzed.
- **Enchanter in the pack:** Underhill Compatriot L21, up 95-97 %, on focus 98-99 %. Passive and following between raids, ordered within a second at each, first swing 3.7-4.2 s later, 1-3 swings of 46-55 on cloth a raid, 232-417 a round on top of his own 1430-2029, with lowest power 39-70 against 55-76 off. It is back from 400-1534 in about 6 s at a leave. Enemies within 1000 of the pack at leave + 10 s: on 0.4, 0.67, 0.2 (n 5, 3, 5), off 0.5, 0.4, 0.25 (n 4, 5, 4), so it brings nobody that shows. Passive doesn't stop an enemy pet chasing it: one hit it 6 times in 16 s.
- **Druid:** no pet logic with her L7 under the gate. One summoned by hand goes passive at the pack's start and defensive at the end. It never saw a raid: that run wound down before contact.
- **Enemy pets on healers:** interrupts on a Cleric 5, 7, 3 (by pets 3, 7, 2) against 1, 2, 0 off, on a Shaman 12, 5, 9 (9, 5, 9) against 5, 1, 1. The Shaman's damage fell to 0 and 4, from 583 and 225. Healers heal no pet, by design.
- **`killedBy`:** `pet:<realm>` where only the pet landed, 4 times in those rounds, and `player:<realm>` when the owner's lifetap landed 7 s before a pet's killing blow, by the rule. A fight's kills now equal the header's, with enemy pets out: before, 8 against 4 and 6 against 3.
- **A shade and a turret** came in small runs, two or three a side: the shade stayed out of the focus and the cc in 3 runs of 3, its servant fought, cut at its tether or killed, and the Necromancer died 8 s after. A turret shooting a member started an engage at its first hit and held it for 40 s with the owner 3700 off, and that fight ended about 14 s after the last shot. A turret goes with its owner: a note, no kill.
- **A summon doesn't starve the nukes:** a Spiritmaster's lowest power was 73-81 in 180 s rounds, which ended near 100.

**Not reached:** a bear cub in a raid, real rolling rounds with buffs carried over, navmeshes on the server, a shade or turret in a whole round. Everything in [group-coordination.md](group-coordination.md#pets-sdkgrouppetsts)'s "tests only" came after these.

## Three routine gaps, closed on 2026-11-04

From the analysis of rounds 9-11 (`groups/midgard/lab_log.md`). Checked with `sdk/test/live/rvr-routines-live.ts` on a throwaway stack: Albion against Midgard, five each at level 24, starter gear, three runs of 4-7 minutes. It shows the code does what it says. No round against the real groups has run on it, so what it does to kills and deaths isn't known.

- **A Paladin plays his chants in RvR:** `song()` is in the tank list, for anyone who knows one. Galahad's kit already had it, since after round 11, and a second `song()` sends nothing twice. New in the choice: armor in a fight, endurance while he is below 30 %. In the two 7-minute runs he had Crusader's Defense on for 307 and 131 s and Persistence for 95 and 135 s, with 7 and 4 chant casts, and landed 36 and 18 styles. How many he can run, and the swing: [classes/paladin.md](classes/paladin.md).
- **`0 song actions` undercounts:** a chant sent raw while swinging logs no action. Read his effects instead.
- **An idle healer nukes on spare power (`spareNuke`):** below every heal and `position` in the healer list, above 75 % power only (so a heal or the rez at 75 % stays affordable), for whoever knows a nuke. That includes a Druid, in the pack's lists too. A member with no nuke is untouched, and a Shaman's kit keeps its own `assist`.
  - **Live:** the Cleric cast 7 and 4 Minor Judgements for 307 and 151 damage, against about 7 and 14 heals. Her power fell to 12 and 1 % from healing, so the nukes stopped long before that: "saving power" was her last skip in about 90 s of each run.
  - **The step:** with no step at all, "focus out of reach" was her last skip in 187 of 374 s. With a step of up to 400 it was 5 of 256 s. That's one run each, and the run with the step had fewer nukes because she healed twice as much.
  - **What it's worth:** little damage, as the analysis expected. The other four of her group dealt 404-1454 each in the same runs. Whether it costs a heal hasn't been measured: a 3 s cast can't be stopped for one, and "heal: not enough power" was her last skip for 2 s in one run.
- **No crowd-control orders for a member who can't carry them out:** a member reports `cc` only with `crowdControl` in its list, as `rez` already did. This also leaves a Skald's power out of `ready` and the songs' `powerBelow` unless it heals or nukes.
  - **Why it mattered:** an assignment is kept (`assignCc`) and the other mezzers stay off its target until the 8 s stall. In round 11 (20261103-211703) Bragi held a target for 191 s over 65 of 185 order lines, and for 178 s of those another of the three mezzers had no assignment. That's an upper bound, since the log doesn't show who was dead or away.
  - **Live:** the Skald reported `cc=false` and got none of the orders in 371 order lines. The Healer, Shaman and Spiritmaster got them all.

## Casters that cast: Camelot on roaming, 2026-11-04

Camelot's casters landed 0.7 nukes a minute each, first nuke about 44 s into a round, losing 2.7 kills to 7.3 deaths per 10 minutes. Alternating 10-minute rounds against the other two groups, in the order tried. Each row is 2-6 rounds a side, and identical settings vary from 4 to 23 kills, so only the sum of them means much. Flags in `groups/camelot/rvr.ts`, details in its lab log.

| Change | Kills / deaths / RP | Against |
|---|---|---|
| Morgana and Taliesin don't root, `standGround` with no `position()`, `softFocus` (5 rounds) | 53 / 33 / 660 | 5 / 17 / 151 in 2 rounds of the control |
| The same with no power floor, `standStep` 1000 (3) | 30 / 11 / 312 | 35 / 20 / 340 in the 3 alternating rounds |
| Chant twist on the Paladin (3) | 28 / 8 / 313 | 33 / 19 / 310 |
| `standStep` 1800 (6) | 86 / 32 / 1022 | 67 / 44 / 775 |
| Clear Mind (`cureMezz`) (3): no clear gain | 42 / 14 / 236 | 33 / 13 / 405 |
| Amplify Running in travel (3): no gain | 17 / 21 / 244 | 33 / 23 / 57 |

- **Why the casters did so little:** a root doesn't stop a player casting and costs a cast; a cast that walks at its target walks into melee; and focus stuck on a healer who heals it back.
- **`softFocus`** (`RvrSettings`, off by default): the pack's `pickPackFocus` and `focusHealed` on roaming, and known healers first for the mezz.
- **A long step works on roaming:** with `standStep` 1800 casters stand closer together and deal more, against the pack's 500. A fight here lasts minutes instead of 8 s, so they need to follow it.
- **The pack on Camelot, with its own choices:** 4 / 7 / 36 in two rounds, 64-73 % of the time walking. Too few rounds to say why; Camelot has no Bard to go in front.
- **What isn't known:** whether this suits a group with a second melee fighter. Midgard and Hibernia haven't run it.

## Unverified / next

- **Resurrection:** only a short run with one enemy so far (above), not yet a round against the other groups.
- **Class detection:** only behaviour marks healers and casters (they must cast first). `NearbyPlayer.model` has a player's model id; nothing reads a class from it yet.
- **Pets** ([pets.md](pets.md#rvr), [above](#pets-in-the-rounds)): none of them has fought in the rounds of the tables above; the rehearsal is what there is. Ours follow the focus (`sdk/group/pets.ts`), and in the wolf pack they come off a fight when the pack walks off or rests (`pet.strayFightsOff`), as its orders don't turn a threat into a fight. An enemy pet is a board contact with `isPet`, its owner unknown (`PacketLib1124.cs:186-187`); it is a focus only with no free enemy player in the fight, a threat near the main body is in the fight whoever it aims at (a caster pet's target shows only on its victim's client and for moments, so every client reads it from the combat events), and its death is no kill. The death packet names a pet's owner, never the pet, also for a turret with its owner 5900 away (`GameLiving.cs:1299-1300`; live `<victim> was just killed by <owner> in Thidranki.`): `killedBy` says `pet:<realm>` when the newest blow before the death is that pet's and the named player has no blow of its own in the window, else `player:<realm>`, and `guard:<realm>` for a keep guard. Up to round 11, and in the wolf pack's rounds, the reports had only `pet:<realm>`, for both, so "their pets" in the table above may be guards.
- **A Necromancer in shade** can't be attacked, and no pet can be ordered at it: `You can't attack a shadowed necromancer!` (`AbstractServerRules.cs:449-455`). Its servant can be. `NearbyPlayer.isShade` reads model 822, from its create and from 0xDB (`GamePlayer.cs:12345-12346`, `:2021`); `decideRvr` leaves it out of the focus, crowd control and the enemy count, and the line from any member marks the contact for 30 s for a client that has no model to go by. A shade's end when its servant dies was seen against players too: `You are no longer a shade!`, 0xDB from 822 to its own model, health 100 and then 10 within about 0.75 s, dead 8 s on ([pets.md](pets.md#shade)). Not with the focus moving onto it in an intact group: that main body was walking back from a release. `decidePack` leaves it out of its foes the same way, and its servant reaches the pack through the patrol's `decideRvr`.
- **Stealth:** none of the 15 bots stealths; a stealthed enemy appears only within detection range.
- **Keep ownership:** Thidranki Faste is Albion's in the dump. If someone takes it, set `keepOwners` (the strategy doesn't watch the lord).

## The wolf pack (`sdk/group/pack.ts`, `rvrPack`)

Hit and run for one group, as an alternative to `rvr-roam`: `defineStrategy(rvrPack, { name: '<group>-pack' })`. Live on 2026-11-03 for Hibernia against Midgard and Camelot on roaming, with the user watching and correcting.

**The cycle:** walk at the nearest enemy, Bard in front; at 1450 open a raid: Hero on the nearest (anchor on the focus, leash 800), casters on the same target from where they stand, area mezz on the biggest cluster without the focus, single mezz on the rest. 8 s, or 3 enemies on the casters: run 1500 (sprint), turn, kill whatever is near for up to 12 s, run again. Enemies in sight of at most 2, and us two more: hunt them, no raid clock. Rest only when the healer or Bard is low, two nukers are, or someone is badly hurt, and stick to it until `ready`; rest where it stands, moving off first if enemies are within 2500.

**Nobody walks alone:** a released member waits in the keep (`waiting: pickup`, `holdFormation` holds it) and the pack comes for it; fewer than 3 alive: everyone goes home; then a rebuff before it starts over. A rez only in `recover`, from within 2000 of the corpse.

**Bard:** a mezz and a Lullaby need no instrument, songs any one in hand, whatever the server's "You are not wielding the right type of instrument!" says of its type (`SpellHandler.cs:252-261`: a club in hand is the usual cause). It reads `refused`, with 60 s off. Interrupts (`interrupt()`): Minor Lullaby, instant, range 2300, 5 s, clears the target's cast (`AmnesiaSpellHandler.cs:50-51`); Concussive Yell, instant, range 700. Then crowd control, heals only as a backup (`backupHealWanted`: the healer dead or attacked, two members low, or one out of its reach), then a confusion on a known healer or caster: range 1350, 3.5 s, interrupts even when resisted.

**Focus:** the nearest, a known caster first, a known healer only when nothing else is in reach. Round 9 spent over 5 minutes on one Troll healer whose health kept coming back. Healers get the mezz.

**What wakes a mezzed enemy** (`GameLiving.cs:1716-1727`): any damage, any melee swing even a miss, and non-damaging roots, stuns, confusions, amnesia, disease, nearsight and resist debuffs. Another mezz doesn't. So nothing but a mezz goes on a mezzed target, area Lullabies stay out, and a root keeps 350 from where the Bard's mezz can land. A resisted spell other than a mezz wakes it too (`:1729`).

**A speed song doesn't take on anyone in combat in the last 10 s** (`SpeedEnhancementSpellHandler.cs:69`): the first stretch of a run is sprint alone.

**Spec and damage:** a spell's lowest roll depends on the spec of its line (`SpellHandler.CalculateLowerVarianceBound`): Light 1 at target level 24 rolls 21-100 %, Light 22 91-100 %. Round 9's Mana Enchanter averaged 58 a nuke with Sun Streak (88), and Niamh picked Sun Streak (level 24) over Glittering Visions (102, level 22) by level; `strongestNuke` picks by damage.

| Round | Length | Strategy | Kills / deaths | RP | Spread | Change before it |
|---|---|---|---|---|---|---|
| c1 | 11 min | roaming | 10 / 4 | 82 | | control |
| s4 | 6 min | pack | 12 / 0 | 110 | 261 | head on, broken only below 3 alive, anchor on the focus |
| s5 | 9 min | pack | 8 / 0 | 38 | 352 | wound down early: it flipped between hunting and walking off |
| s6 | 10 min | pack | 13 / 0 | 145 | 287 | commits to resting until ready |
| s7 | 10 min | pack | 13 / 0 | 55 | 288 | one low nuker doesn't make five rest |
| s8 | 10 min | pack | 17 / 0 | 160 | 366 | same |
| c2 | 11 min | roaming | 10 / 6 | 24 | | control |
| s9 | 10.5 min | pack | 14 / 1 | 70 | 1506 | a caster steps up to 500 toward a focus just out of range: idle fell from 33-40 % to 2-8 % |
| s10 | 10 min | pack | 21 / 0 | 40 | 247 | same; nearly all Albion |
| s11 | 10 min | pack | 6 / 5 | 53 | | Brigid's acuity; 5 minutes on one healed Troll |
| s12 | 10 min | pack | 17 / 0 | 120 | | same; 10 of them Midgard |
| s14 | 10 min | pack | 16 / 0 | 95 | | Horizon Blade on the Hero: never landed, taken out |
| s15 | 10 min | pack | 8 / 2 | 20 | | gives up a focus healed 30 above its lowest |
| s16 | 10 min | pack | 17 / 0 | 40 | | same |

**The fair comparison,** on one code version (2026-11-04), rounds alternating, the same two opponents on roaming, 10 minutes each:

| Round | Strategy | Kills / deaths | RP | Midgard kills | Spread | Strayed |
|---|---|---|---|---|---|---|
| r1 | roaming | 10 / 7 | 130 | 8 | 2397 | 16 % |
| p1 | pack | 13 / 1 | 130 | 6 | 702 | 3 % |
| r2 | roaming | 11 / 4 | 57 | 8 | 1400 | 6 % |
| p2 | pack | 19 / 1 | 95 | 10 | 545 | 3 % |
| r3 | roaming | 9 / 8 | 19 | 3 | 2804 | 20 % |
| p3 | pack | 18 / 1 | 125 | 8 | 910 | 7 % |
| | **roaming total** | **30 / 19** | **206** | **19** | | |
| | **pack total** | **50 / 3** | **350** | **24** | | |

Deaths are the clear result: every pack round lost fewer than the best roaming round. Kills are better too, but the pack's gain is mostly Albion (26 against 11): against Midgard, 24 and 19 is within the noise, so the pack doesn't yet beat the stronger group by more than it survives it. Realm points vary a lot with who else hit a kill: pack and roaming tied on p1 and r1.

**Then two fixes, 4 rounds:** the Bard mezzes what it can reach and steps up when nothing is; a pack no longer parks short of an enemy that stands still (a stalk aimed at the stand-off while a raid opens 50 closer, and formation slack kept the centre from the last units: one round sat 1469 from a Briton for 5 minutes).

| Round | K | D | RP | Midgard | Spread | Oisin's mezzes | "Out of reach" turns |
|---|---|---|---|---|---|---|---|
| n1 | 15 | 0 | 140 | 14 | 274 | 7 | 6 |
| n2 | 14 | 0 | 135 | 11 | 311 | 6 | 16 |
| n3 | 16 | 0 | 200 | 6 | 239 | 7 | 10 |
| n4 | 15 | 0 | 90 | 15 | 332 | 8 | 1 |

Against p1-p3 (17 kills, 1 death, 117 RP, 8 Midgard kills a round; spread 545-910): 15 kills, 0 deaths, 141 RP, 11.5 Midgard kills a round; spread 239-332, none strayed. The tighter pack and the Midgard kills are more than the rounds before varied, but three things changed at once: both fixes, and the opponents came back from their own guild trip. Oisin's idle turns fell (97 to 33 over the rounds compared by length), his mezz count didn't rise (6-8 against 6-13): cc:immune and cc:resisted now take up the gain. So it's the parking fix, 5 raids opened by it, and less idling; not more mezzes.

**Raid length,** three rounds each:

| Raid | Kills / deaths | RP | Midgard kills | Hero's damage | Rounds (kills) |
|---|---|---|---|---|---|
| 12 s | 47 / 1 | 425 | 32 | 4712 | 16, 18, 13 |
| 8 s | 42 / 0 | 465 | 26 | 2747 | 10, 20, 12 |

Alternating, 10 minutes each. The Hero's damage rose in two of three pairs (he reaches the focus before the clock is up), but kills, Midgard kills and realm points are within the noise, and the one death came on 12 s. The default stays 8 s; `--pack.raidMs=12000` to try it.

**The crowd limit,** `maxFoes` 11 against 8, three rounds each: 49 kills, 3 deaths, 372 RP, 36 Midgard kills against 39, 0, 371, 26. Says nothing about the limit: neither side's log shows one refusal for a crowd in these rounds or the six before. The 8 stays. What it does show is how far identical settings vary: 10 to 20 kills a round. A difference of a few kills over three rounds is noise here.

**Checked, no gain to be had:** about 30 % of Oisin's mezzes answer "immune" though the board tracks every mezz of ours, so they most likely come from Midgard's and Camelot's crowd control on each other, which no client hears. Brigid idles most of a fight, but her only damage at this spec is a weak damage over time after a respec out of Nurture; left as is.

**Open:** the Hero's kill failed "ran beyond 3800 units" in bursts of about 48 tries (4 rounds of the last 16; a minute lost in one) with the group 1500-2500 from that Briton. The chase limit counts from the Hero, so his own client must place it far off while the board doesn't. Not explained yet.

**A phantom focus:** two whole rounds (0 and 4 kills) went round hunt, kill and pull back on Briton#468, frozen at 33 %, in nobody's view and never hit. Why the board kept it fresh isn't known. A focus whose health stands still for 20 s is now left alone for 2 minutes (`noticePhantom`, `frozenMs`, `phantomMs`). No such loop in the six rounds since, but it was rare before too. The Hero's "ran beyond 3800 units" looks like the same kind, at 100 %.

**Patrol detours toward the enemy homes** (tried, taken out): a round of 0 kills walked the ring for 9.5 minutes while the other two groups fought each other out of its sight. Three rounds each: with detours 28 kills, 6 deaths, 315 RP, without 33, 8, 345; no less travel. Not what fixes that round.

**A mezz cure for the pack:** tried and taken out. Oisin cured 1-24 times a round, and six rounds each came to 47 kills, 14 deaths with it, 68 and 12 without, phantom rounds included; 27 / 6 against 34 / 8 without them. Lines about acting while mezzed fell in the first three rounds (0, 1, 1 against 35, 26, 13) and not in the next three (11, 23, 0 against 0, 13, 28). Oisin is often mezzed himself. Main's `cureMezz` stays available for a list that wants it.

**Harder since the night:** the pack went from 15 kills, 0 deaths a round to about 10 and 2 once Midgard and Camelot had their fixes, and Ciaran had his pet and kit. Those arrived together, so this doesn't say which.

**Ciaran's pet,** three rounds each, alternating: with it 27 kills, 10 deaths, 240 RP, 18 Midgard kills; without 7, 9, 84, 2. It doesn't hurt the raid. That's as far as this goes: the rounds without it also met far fewer enemies (travel 75, 89, 58 % against 54, 41, 55; one had no fight at all), which a pet shouldn't cause, so the gap in kills overstates it.

**Bolting** (`pack.boltRun`, off): run 4000 from everyone when a member is dead and we're outnumbered, or a second realm arrives with us three short. Four rounds each: on 41 kills, 6 deaths, 396 RP, 21 Midgard kills; off 46, 5, 339, 31. It fired once in eight rounds, and no round had a wipe, so this says nothing yet about the wipes it's meant for. Kills follow contact: 86 % travel gave 4 kills, 38-49 % gave 11-16.

**The ring the other way,** four rounds each: reversed 16 kills, 13 deaths, 180 RP, 8 Midgard kills; as it was 44, 15, 292, 23. Tried because Hibernia and Albion go round the same way, and kills follow contact. The reversed rounds did walk the other way, and met no more enemies. Taken out.

**Pack against roaming again, on the tougher field** (roaming with softFocus, batch stopped early): roaming 4 rounds, 28 kills, 50 deaths, 440 RP; pack 3 full rounds, 24 kills, 17 deaths, 384 RP. Per round about the same kills and half the deaths or better for the pack. The pack is down to about 8 kills and 6 deaths a round from 15 and 0 last night.

**Within the noise so far:** Brigid's acuity and giving up a healed focus. Before the give-up the pack went 17/0, 16/0, 21/0 and 6/5; with it 8/2, 17/0, 13/1, 19/1, 18/1. It did stop the 5 minutes on one Troll, but single deaths now show up where the rounds before it had none. The early comparison (63/0 in 45 minutes against 20/10 in 22) overstated the gain: opponents get absent or farmed, and s17 and s18 (18/0, 11/1, 0 RP) had no Midgard at all, so count those out. c3, 12/0, was also the pack and no control.

**Not done:** Oisin's mezz cure (Clarifying Harmonies): a member's report doesn't say it's mezzed. The Hero's post-block stuns. A member rezzed in the field isn't told apart from a released one for the rebuff.
