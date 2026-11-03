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
- **PvP immunity, 10 s:** after logging in, a region change (the port in) and a release (`AbstractServerRules.cs:235-261`). Two refusals: "You can't attack players until your PvP invulnerability timer wears off!" (ours) and "{name} is temporarily immune to PvP attacks!" (theirs). `attack`, `killPlayer` and `castSpell` report both as reason `immune` with `retryAfterMs`. "Your temporary PvP invulnerability timer has expired." is the end of it, not a refusal.
- **Enemy players are named by race** ("Briton", "Celt", "Troll"), with no guild (`NormalServerRules.cs:292-338`): tell them apart by `objectId`. The board labels them `Celt#410`.
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

- **Main body:** distances are measured from the cluster of members where the fight is (round a member an enemy attacks, when that cluster has at least 2 members or half of the group), else the largest cluster. A member walking back from the portal keep is not part of a fight, and a lone member attacked far away fights or flees with its own behaviours while the group gathers toward it. Round 1: three released Midgard members outnumbered the two still fighting 16k away, got every mezz assignment and logged `cc: not_found` 59 times.
- **Hostile:** an enemy player is a threat to the group only when its inferred target is a member, a member attacked or hit it, or it swings or casts within `hostileRadius` (2500) of a member. An enemy fighting the third realm 5000 away is not.
- **Who counts as "against us":** the largest single realm's free players (not mezzed, not busy with the third realm), plus any player of the other realm attacking us. Two other realms fighting each other are two groups, not one: before this, a 5 v 5 between the others made the third group retreat from "10 enemies".
- **Focus:** kept while it lives (no target thrash), unless another enemy drops below `switchBelow` (25 %) while the focus is above 45 %. A new focus by score: healer +60, caster +30, on one of our healers or casters +20, missing health, near our centre.
- **Crowd control:** `assignCc` over the other enemy players in reach of the main body, mezzers first. A mezzer casts on the first target its own client sees. "Your target is immune to this effect!" (a player stays immune for a while after a mezz) after a mezz marks the contact `ccImmuneUntil` for 60 s on the board, so no mezzer is assigned it (a root's "immune" is the server's separate snare immunity: it stays with the rooter); an assignment whose target is still free after 8 s goes to the next mezzer.
- **Behaviours** (`rvrBehaviors`): the PvE lists without the town `healer` visit. Against a player: no hold wait (players have no aggro table), the tank uses its damage style (taunts move nothing), `killPlayer` instead of `killNpc`.
- **`chaseLeash` (2000):** the tank and melee don't chase an enemy player farther than this from the fight's anchor: a chase stops the moment the foe leaves it, and with the focus beyond it they fight the nearest enemy inside it instead. The coordinator keeps foci inside the leash: it prefers foci in reach, and moves the anchor toward a focus beyond it, not more than 1500 from the centre. Round 2: the Hero followed fleeing players and logged 192 "ran beyond 3000 units".
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

## Unverified / next

- **Resurrection:** only a short run with one enemy so far (below), not yet a round against the other groups.
- **Class detection:** only behaviour marks healers and casters (they must cast first). The client's model id for a player isn't kept (the decoder reads it).
- **Pets** (Theurgist, Spiritmaster, Enchanter, Druid): no SDK pet commands; a pet's owner shares its realm, so enemy pets aren't board contacts.
- **Stealth:** none of the 15 bots stealths; a stealthed enemy appears only within detection range.
- **Keep ownership:** Thidranki Faste is Albion's in the dump. If someone takes it, set `keepOwners` (the strategy doesn't watch the lord).
