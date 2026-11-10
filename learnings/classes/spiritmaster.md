# Spiritmaster

Midgard's list caster: lifetaps and debuffs from Darkness, area damage and mezz from Suppression, a pet from Summoning. For every spell, level and cost on this server run `bun data/class-sheet.ts Spiritmaster`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Spiritmaster "Darkness caster"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/spiritmaster.ts` is a `nuker` whose fight is `assist()`, then `nukeInReach()`. **Why (2026-11-10, after arena round 20):** with the pack holding ground, `assist` skips when the focus is beyond her nukes ("focus out of reach, holding ground"), and she stood idle: 36 % of fight time in round 4, 22 % in 6, 45 % in 19, 39 % (53 skips) in 20, a round Hibernia won by wipe. A human caster nukes what is in reach instead. `nukeInReach` gets the turn only when `assist` has none: her best single-target nuke at a free enemy player in range (50 inside it), not the focus, never one under crowd control (a nuke wakes a mezz), healers first, then casters, the most hurt, the nearest; not while a melee is on her (`hammeredBy`). It reports as `nuke`. Her pet stays on the focus. Not measured yet: her idle share and damage in the next Midgard rounds.

**Round 22 (2026-11-10, vs Camelot, won by wipe 5 kills / 1 death; with the group's standStep 1000):** idle 0 % (39 % in round 20), 14 nukes, 2039 damage, first nuke 3.1 s; 5 `nuke:out_of_range` and 3 interrupted. Whether the out-of-range ones are `assist`'s or `nukeInReach`'s the report doesn't say; if they keep coming, widen RANGE_MARGIN.

**Round 27 (vs Camelot, wiped 2 / 5, one fight of 229 s):** moving 73 %, targeted 73 %, 4 nukes, 1 out of range. Against round 22 (moving 52 %, targeted 19 %) the group's longer step may walk her into their casters; told the group session.

**Round 29 (vs Hibernia, wiped 1 / 5, standStep 750, before Quickcast):** 3 nukes, 302 damage, her mezz on their healer crowd-controlled once and interrupted once; targeted 15 %, moving 33 %. Hibernia has won 4 of the last 5 against Midgard (rounds 20, 23, 25, 29).

**Round 31 (vs Hibernia, won by wipe 5 / 1, Quickcast in):** 9 nukes, 1232 damage, never targeted, so no Quickcast; idle 4 %.

**Round 32 (vs Camelot, wiped 0 / 5 in 89 s):** her cc order failed `cc:out_of_range` 9 times and no nuke landed; first nuke at 20.6 s, moving 73 %. The distance is 3D, so the target moving off or her own walk is the likelier cause; `crowdControl` holding ground answers it with a 1 s wait and the same target again. Asked of the orchestrator (shared).

**Round 34 (vs Hibernia, wiped 0 / 5; the group's own list for her, without crowdControl):** 2 nukes, 218 damage, first at 13.3 s, moving 73 %. Moving by round: r22 52 % (won), r27 73 %, r29 33 %, r31 65 % (won), r32 73 %, r34 73 %. Suspected: `assist`'s step toward the focus (standStep 750) against `fanOut` stepping her back; proposed `assist({ holdGround: 250 })` to the group session, who agreed: since then her fight is `assist({ holdGround: HOLD_GROUND })` (250), whatever the group's standStep, with `nukeInReach` behind it. The group's `holdFocus` came into the pack in the same round, so read the two together.

**Round 36 (vs Hibernia, won by wipe 5 / 1; holdGround 250 and the group's focus hold):** moving 20 % (73 % in round 34), 13 nukes, 1601 damage, first at 7.3 s, no death; but idle 32 % ("focus out of reach, holding ground" 54 times) with no free enemy in her reach either. If that holds over more rounds, try holdGround 400-500.

**Round 37 (vs Camelot, wiped 2 / 5):** `nuke:out_of_range` 15 times in 17 s, about one a second, and 1 nuke (139 damage). Holding ground, `assist` casts when our 3D distance says in range and, on the server's "too far away", tries the same focus the next turn: the loop `crowdControl` had in round 32. Asked of the orchestrator for `assist`; `nukeInReach` now leaves a target the server called out of range for 8 s (`FAR_MS`).

**Round 43 (vs Hibernia, won by wipe 5 / 2):** 17 nukes, 2167 damage, first at 3.5 s, no death; idle 23 %, 5 `nuke:out_of_range`.

**Round 44 (vs Camelot, won 6 / 4):** 3 nukes, 336 damage, idle 69 % ("focus out of reach, holding ground" 193 times in a 246 s fight); her pet dealt 2387. The 250 step left her standing when nothing else was in reach for minutes. Since then `steppingAssist`: a step of 250, and of 750 once the focus has been out of reach for 4 s with nothing cast meanwhile (a cast by `assist` or `nukeInReach` starts the wait again). Rounds 27-34 showed 750 every turn keeps her walking; this takes it only when standing gets nothing.

**Round 45 (vs Hibernia, lost on the cap 5 / 9; still the plain 250 step):** 15 nukes, 1904 damage, idle 22 % but as "focus not in view" (19), not out of reach. Round 44's standing isn't every round's.

**Round 47 (vs Hibernia, won on the cap 4 / 3; `steppingAssist` in):** idle 20 %, moving 35 %, 14 nukes, 1728 damage, no death; her first Quickcast. Against round 44 (idle 69 %) and round 34 (moving 73 %) the two-step rule holds both down. One round so far.

**Round 52 (vs Camelot, won by wipe 5 / 1; the group's calmFan):** idle 80 % ("focus out of reach, holding ground" 96), moving 7 %, 7 nukes. Even the 750 step is refused when the focus is more than 650 beyond her range or an enemy stands near the spot (`standStepTo`, STEP_CLEAR 500), and with fanOut calmed nothing else brought her in. Since then, after 4 s with the focus out of reach and nothing cast, `steppingAssist` walks one leg (3 s) toward the focus, to 85 % of her nuke's range.

**Rounds 54-55 (walk leg in):** r54 vs Camelot (won 5 / 2): 5 nukes, moving 48 %, idle 37 %. r55 vs Hibernia (won on the cap 8 / 2): 38 nukes, 4993 damage, idle 17 %, moving 19 %, her best round by far. Camelot's casters stand far back, Hibernia's close in. **Round 56 (vs Camelot, won on the cap 5 / 3):** moving 70 %, 5 nukes, 467 damage: the legs chased their back line. Since then a leg only toward a focus at most 900 beyond her range (`LEG_MAX_GAP`).

**Round 102 (vs Camelot, wiped 1 / 5), effects sampled:** Obscuring Dust on her in 5 samples (about 75 s), mezzed in 4; idle 55 % ("focus out of reach" 47), 2 nukes. Sigrid, in melee 64 %, got one Nearsight cure off. With the range cut by a third the 900 gate refused most legs, so under an enemy Nearsight it allows 500 more (`NEARSIGHT_GAP`).

**Quickcast (2026-11-10, after round 27):** she has the ability (`bun sdk/cli.ts Hrafna`) and nothing used it. The kit's `instant` is the Cabalist kit's `quickcastUnderFire` ([cabalist.md](cabalist.md)): with a melee on her, or a cast of hers interrupted in the last 5 s, Quickcast, then her cc order or her nuke on the focus, uninterruptible, at twice the power, once per 31 s. In round 27 she was targeted 73 % of the fight.

Before that the kit held only the role. Everything measured below is a setting or a piece of gear: `holdMs` and `ready.mana` are Midgard's, and a focus staff took her `no_power` from 5.0 to 0.3 a run, so she has no floor of power to carry.

In PvE, Midgard's `memberBehaviors.hrafna` (the nuker's list plus `restOnPull`) overrides any character. In RvR nothing does.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/spiritmaster.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Darkness caster: Darkness / Suppression / Summoning | Suppression bomber: Suppression / Darkness / Summoning | Summoning pet: Summoning / Suppression / Darkness |
|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 7 / 7 / 1 | 10 / 1 / 1 |
| 20 | 209 | 20 / 1 / 1 | 18 / 7 / 1 | 20 / 1 / 1 |
| 24 | 299 | 23 / 6 / 2 | 20 / 13 / 1 | 24 / 1 / 1 |
| 30 | 464 | 29 / 6 / 2 | 26 / 13 / 1 | 30 / 1 / 1 |
| 40 | 819 | 39 / 6 / 2 | 37 / 13 / 1 | 40 / 1 / 1 |
| 50 | 1494 | 47 / 26 / 5 | 49 / 22 / 5 | 50 / 20 / 4 |

Hrafna plays Darkness caster. **Community, unverified:** Blackthorn and Uthgard call 47 / 26 the usual one; Uthgard calls the pet build unplayable in battlegrounds. The bomber is point-blank, and `pickNuke` wants range above 0, so it needs a behaviour first.

## Darkness caster at 24 in Thidranki

**Server code,** Darkness 23, Suppression 6, Summoning 2:

- **Nuke:** Silence Lifeforce (lifedrain, Darkness 23, 90 Cold, 2.5 s, 14 power, range 1500), always, because the highest level wins. Murk Blast (73, 12 power) is a little cheaper for what it does and never goes off.
- **Crowd control:** Hold Spirit, at Suppression 4: 3 s, 3 power, 20 s. Half what a Healer's baseline Sedate lasts, for a quarter of the power ([healer.md](healer.md)). Dark Wave is point-blank and no longer picked ([rvr.md](../rvr.md): it was cast at enemies 1500 away, "No cast observed", 22 times in one round). Shroud of Gloom (Darkness, radius 300) is an area mezz, not used.
- **Buffs:** her own Suppressive Barrier (AF) and Protecting Spirit (absorb), timed and costing power. Sight of the Deep comes from the Shaman.
- **Reached, and no behaviour casts it:** Darken Vision, Field of Darkness, Quell Strength and Attenuate Strength (stat debuffs, instant), Suppress Movement (a root, taken only when she has no mezz), Dampen Health (Body, and her nukes are Cold).
- **The pet:** Summon Spirit Warrior, baseline at level 20, is kept up by `summonPet` at about 30 % of her pool each, a focus caster's 25 % times 1.2 with next to no focus bonus at Summoning 2 ([pets.md](../pets.md#summoning); `bun sdk/classes/reach.ts` shows it with `petHeal` and `petBuff`). It follows the focus (`petControl`). Her power is the group's limit below, and the pet makes it more so: the reports below are from runs with no pet, so compare with `--pet.enabled=false`.

## Her power was the group's limit

**Verified,** wolf camp, level 21-22, alternating 4-minute runs, 0 deaths in all of them.

**The cost of a nuke.** A focus staff of her line cuts it: Murk Blast costs 14 on a trimmed branch and 10 on a focus staff (`12 x (1.2 - 0.4 x 17/20)`: Darkness over the spell's level). Over 12 runs:

| She holds | Power a nuke | Nukes a run | `no_power` a run | Kills/h |
|---|---:|---:|---:|---:|
| Trimmed branch | 14 | 13 | 5.0 | 104 |
| Focus staff | 10 | 17 | 0.3 | 117 |

The power went into more nukes. `wearFocusStaff` holds the staff ([merchants.md](../merchants.md)), and a Healer or Shaman doesn't count as a focus caster.

**The hold.** The melee do most of the damage, so waiting for her at each fight costs more than it gives. Over 18 runs, 6 at each:

| Her hold | Idle in fights | First nuke | Avg fight | Thorgrim's lowest | Kills/h |
|---|---:|---:|---:|---:|---:|
| 5 s | 45 % | 5.1 s | 19.6 s | 64 % | 87 |
| 2.5 s (kept) | 29 % | 2.7 s | 16.2 s | 72 % | 83 |
| 1.5 s | 21 % | 1.5 s | 15.4 s | 70 % | 87 |

No caster was targeted at any of them. Her 5 s dated from a run where the real cause was the Warrior's detaunt ([warrior.md](warrior.md)). She drew aggro twice at level 3, with Major Dusk Dart on an orange mob, as a Mystic of 40 health.

**`ready.mana`,** the group's: 10 % against 35 % gave kills/h 106 against 70, with the tank's lowest 70 % against 75 %. It's in Midgard's strategy, not here; only single passive wolves were tried.

## What the reports show

**Verified,** six Midgard RvR rounds at level 24, 46 minutes, to 2026-11-03 21:42:

| Deaths | Damage a minute | Nukes | Crowd control | First nuke | `cc:crowd_controlled` | `nuke:interrupted` | `cc:interrupted` | Targeted | In melee |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 171 | 67 | 59 | 24.2 s | 31 | 18 | 16 | 15 % | 20 % |

- **In RvR she mezzes nearly as often as she nukes,** and her first nuke comes 24 s in: `crowdControl` is above `assist`, and the coordinator gives nukers adds before healers. Whether a 20 s mezz is worth more than a 90-damage nuke there hasn't been compared. The group order is set in `assignCc`, so it's the same for Hrafna, Merlin, Morgana and Taliesin.
- Template health is 459, the lowest of her group.

## At low levels

**Verified,** solo: Major Magic Shield (Suppression baseline at L10, a base AF buff) decides a mob reaching her. It takes a thrall's hit from 37 to 15 and an ant worker's from 28-31 to 10-11. It survives a relog with the time it had left, and a death ends it.

## Weight

She can't wear chain, and for a long time `equipUpgrades` tried it on every visit ("You have no skill in wearing this armor type!", 19 s a pass). **Verified:** at 19.9 she was stuck at 95 % load from armour in her bags. `shedLoad` and the sale cover it now, and [gear-care.md](../gear-care.md) says what's kept.

## RvR, as players tell it

**Community, unverified** (research 2026-11-09):

- The usual RvR spec is 47 Darkness / 26 Suppression, and with a mezzer in the group she nukes one target while the others stay mezzed ([disorder.dk](https://disorder.dk/daoc/class-guide-midgard/)).
- Her pet is weak in RvR: it intercepts some blows, about a third of the damage ([Uthgard](https://www.uthgard.net/forum/viewtopic.php?f=15&t=8273)). Nothing found on her power or positioning.

## Not supported yet

- **Pet tactics beyond following the focus:** taking aggro, the pulsing damage shields (Spirit's Revenge, 5 s) and Convert Spirit. No behaviour casts those.
- **Stat debuffs:** no behaviour casts them. Instant ones would be free turns between nukes.
- **Area mezz** and **point-blank** Suppression damage: a behaviour for the bomber would need the group's tank to gather adds.
