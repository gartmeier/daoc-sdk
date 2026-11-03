# Spiritmaster

Midgard's list caster: lifetaps and debuffs from Darkness, area damage and mezz from Suppression, a pet from Summoning. For every spell, level and cost on this server run `bun data/class-sheet.ts Spiritmaster`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Spiritmaster "Darkness caster"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## No kit

There is no `sdk/classes/spiritmaster.ts`. `roleForClass` makes her a nuker and the list casts what she knows, so a kit would hold nothing of the class's own. Midgard's `memberBehaviors.hrafna` is the nuker's list plus `restOnPull`, and that's the group's. Everything measured below is a setting or a piece of gear.

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
- **Reached, and no behaviour casts it:** Darken Vision, Field of Darkness, Quell Strength and Attenuate Strength (stat debuffs, instant), Suppress Movement (a root, taken only when she has no mezz), Dampen Health (Body, and her nukes are Cold), the pet and its buffs.

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

## Weight

She can't wear chain, and for a long time `equipUpgrades` tried it on every visit ("You have no skill in wearing this armor type!", 19 s a pass). **Verified:** at 19.9 she was stuck at 95 % load from armour in her bags. `shedLoad` and the sale cover it now, and [gear-care.md](../gear-care.md) says what's kept.

## Not supported yet

- **The pet:** Summon Spirit Warrior, baseline at level 20. The class has it, and no bot has summoned it.
- **Stat debuffs:** no behaviour casts them. Instant ones would be free turns between nukes.
- **Area mezz** and **point-blank** Suppression damage: a behaviour for the bomber would need the group's tank to gather adds.
