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
- `groups/_template/` has both scripts, so `create-group.ts` gives every new group a `battleground.ts` and an `rvr.ts`. Run each group's `rvr.ts` in its own process: every group plans alone, on what its own members see.
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

## Unverified / next

- **Resurrection:** healers don't rez yet; every death walks 17–23k back.
- **Class detection:** only behaviour marks healers and casters (they must cast first). The client's model id for a player isn't kept (the decoder reads it).
- **Pets** (Theurgist, Spiritmaster, Enchanter, Druid): no SDK pet commands; a pet's owner shares its realm, so enemy pets aren't board contacts.
- **Stealth:** none of the 15 bots stealths; a stealthed enemy appears only within detection range.
- **Keep ownership:** Thidranki Faste is Albion's in the dump. If someone takes it, set `keepOwners` (the strategy doesn't watch the lord).
