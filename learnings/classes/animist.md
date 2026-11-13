# Animist

Hibernia's turret caster: main turrets (a window pet that never moves), fire-and-forget turrets, bombers, and a lifedrain. For every spell, level and cost on this server run `bun data/class-sheet.ts Animist`; for what a build reaches, `bun sdk/classes/reach.ts Animist "Arboreal group"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/animist.ts` is a `nuker` (2026-11-12, night stint R8). Written offline from the data and [pets.md](../pets.md#turrets); the live check is below. The group's pet behaviours leave a turret alone (`petControl` skips a member that `knowsTurret`, and `SummonAnimistFnF` is not automatic, `spells.ts`), so the kit does it all. Its fight, ahead of `assist`:

1. **`plantTurret`:** the main turret on `turretSpot`: on the line from us to the focus, as near us as reaches it (turret reach 1000 less 200), at least 100 out, within the summon's 1000 less 80 (**server code:** every Animist turret has range 1000 and a shot of range 1000, `spell.sql`). With `replace`, so the old one goes only once the new can. Then `petAttack` at the focus. A turret up and in reach gets the order at each new focus and the turn goes on. The focus out of its reach for 3 s: planted again (no more than every 8 s). The focus under crowd control: the turret goes passive (it stops within a shot, [pets.md](../pets.md#commanding)).
2. **`fnfTurret`:** with an enemy player as the focus, 50 % power and fewer than 2 of ours up, the fire-and-forget turret that hurts one enemy hardest (`fnfPick`: Forest's Spirit, 76 a shot, 120 s; never a tangler, which roots, a vent or a debuffer), on the same kind of spot. They take their own targets: what isn't grey to us.
3. **`bomb`:** the bomber that hurts one enemy hardest (`bomberPick`: Spirit of Wrath, 102, 3 s, 13 power), above 50 % health and with no melee on us; below that `assist`'s lifedrain heals (Enemy's Debt, 80, 2.5 s, 13 power). Never an area bomber (Circle of Enmity, Entangling Spirit's root, Dancing Flame's debuff): they wake a mezz.
4. Then the nuker's `assist` and `offFocus`, `giveGround` under a melee ([theurgist.md](theurgist.md)), and Quickcast under fire.

Options: `animist({ fnf: false, bombers: false, saveBelow: 30 })`. The main turret goes at any power.

What each main turret does (**server code**, its shot from `spell.sql`): Forest's Sentry (Arboreal 24) a direct damage of 112 per 3 s; Grove's Agent (Creeping 22) 80 and a 40 % snare per 2.5 s; Battle Harbinger (Verdant 23) a taunt from 1350, and melee on what comes.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/animist.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Arboreal group: Arboreal Path / Creeping Path / Verdant Path | Creeping turret farm: Creeping Path / Arboreal Path / Verdant Path | Verdant bomber core: Verdant Path / Arboreal Path / Creeping Path |
|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 10 / 1 / 1 | 10 / 1 / 1 |
| 20 | 209 | 20 / 1 / 1 | 20 / 1 / 1 | 20 / 1 / 1 |
| 24 | 299 | 24 / 1 / 1 | 24 / 1 / 1 | 23 / 6 / 1 |
| 30 | 464 | 30 / 1 / 1 | 30 / 1 / 1 | 29 / 6 / 1 |
| 40 | 819 | 40 / 1 / 1 | 40 / 1 / 1 | 39 / 6 / 1 |
| 50 | 1494 | 50 / 19 / 7 | 50 / 18 / 9 | 50 / 18 / 9 |

For RvR at 24 the kit fits Arboreal group best: the hardest-hitting main turret and bomber. The Verdant build's turret taunts, and its Briar spells (TurretPBAoE, area) no behaviour casts.

## What pets.md already measured

From [pets.md](../pets.md#turrets): a ground target first; a spot off the mesh is dropped and wipes a good earlier one. A main turret is lost 55-60 s out of every player's view and at 10000; it shoots its last target with us 5000 off. Fire-and-forget ones live 120 s, at most 10 in 1000 and 12 per player. Grove's Hunter took a L14 bear in 23.5 s; Grove's Agent hit 79-95 per 2.5-3 s in Thidranki and reached 62 % under two pets in 40 s. Standing within about 400 of a turret among L14 bears killed its owner 3 times: what is on a turret turns on the owner when it goes.

## Live check

**2026-11-12, 19:11-19:29, three solo sorties in Thidranki** (Etain, L24, Arboreal group, a one-member squad `groups/r8-etain`): 8 player kills, 3 deaths, 131 realm points. Sortie 2 had two long fights against 8 and 5 Albion players (5 kills, 2 deaths), and her Forest's Sentry dealt 3131 there, three times her own 1011. Sortie 3: 3 kills one by one, the turret 1404 and on the focus 87 % of the time it was up; she died to the Necromancer's servant. Every turret summon landed on its spot: no `no_ground_target`, `refused` or `out_of_range` from `summonPet`.
- **Fixed after sortie 2:** in the 3 s before a re-plant, `plantTurret` still sent the turret at the focus, which the server refused, "Briton is 1772 from it, beyond its 1000", 6 times. Now `turretState` waits then (`wait`), and sortie 3 had none.
- Her first damage came 36 s into sortie 2's first fight, as the plant and the fire-and-forget turret went first; 1-11 s in sortie 3.
- Casts with a cast time get interrupted under a melee (4-5 a sortie). Solo she has no haven for `giveGround`.

**Field run B, hibernia's main group (three sorties, 22:28-00:00):** her Forest's Sentry dealt 6565, 7695 and 7700, two to seven times her own (3041, 1036, 2170), up 58-70 %, 10-21 plants a sortie; 3, 3 and 2 deaths. It broke crowd control 2, 5 and 2 times: only a turret on the focus was called off, and a turret takes its own next target when its target dies. **Fixed, twice:** whatever the turret shoots, mezzed or assigned a mezz, sends it passive. In `plantTurret`'s turn that still let 6 through in the next sortie (23:18): her 2.5 s casts held the turn. Now `turretOffCc` runs on the side tick, every 250 ms, and also counts a mezz another member is casting at it.

**After the side-tick fix (5 sorties, 00:43-03:13):** 1 broken mezz in all five, but the turret dealt 0-1178 a sortie, a fifth of what it dealt before. **Why (server code):** passive wipes the turret's list of what it has been fighting (`ControlledMobBrain.Disengage`), and a turret starts `Defensive`, so after each kill it picks its next target off that list. Those picks were most of its damage. An attack order also stops the shot (`Attack`, `StopCurrentSpellcast`) and keeps the list. So `turretOffCc` now sends the turret back at the focus when it reaches it (`offCcMove`), and goes passive only when it doesn't (b2ee129, 04:19). It hasn't been seen live yet.

## Not seen live

- In a group, with a haven for `giveGround`.
- `fnfTurret`: the reports don't tell its summons from the main turret's.
- Whether enemy players go for the turret: none died in these sorties.
