# Cabalist

Albion's list caster for damage over time: DoTs from Matter, lifedrains from Body, a pet from Spirit. For every spell, level and cost on this server run `bun data/class-sheet.ts Cabalist`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Cabalist "Matter"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/cabalist.ts` holds only the role, `nuker`, which is what `roleForClass` gives. It changes nothing against the role list. The list casts her DoTs first as it is, and no `assist: no power` shows in her top reasons, so she has no floor of power to carry where the Sorcerer and Theurgist do. Morgana going without is also the group's choice: "every fight has one caster at full rate" ([sorcerer.md](sorcerer.md)).

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/cabalist.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Matter: Matter Magic / Body Magic / Spirit Magic | Spirit debuffer: Spirit Magic / Body Magic / Matter Magic | Tri-spec: Matter Magic / Spirit Magic / Body Magic |
|---|---|---|---|---|
| 10 | 54 | 9 / 1 / 3 | 10 / 1 / 1 | 1 / 1 / 10 |
| 20 | 209 | 19 / 1 / 3 | 20 / 1 / 1 | 11 / 1 / 16 |
| 24 | 299 | 23 / 5 / 3 | 22 / 8 / 4 | 12 / 12 / 16 |
| 30 | 464 | 29 / 5 / 3 | 28 / 8 / 4 | 12 / 12 / 24 |
| 40 | 819 | 39 / 5 / 3 | 38 / 8 / 4 | 25 / 19 / 24 |
| 50 | 1494 | 46 / 28 / 4 | 46 / 28 / 4 | 25 / 33 / 34 |

Morgana plays Matter. **Community, unverified:** the sources agree it's the efficient PvE line, and the wiki gives Spirit debuffer the same 46 / 28 / 4.

**Server code: the spells that Spirit 3 buys need a pet.** Convert Spirit (Spirit 3) reclaims power from one, and it sacrifices the pet, so no behaviour casts it, though `summonPet` keeps a pet up. It costs Perforate Spirit one level later: Matter 24 alone also fits the 299, and the catalogue says so. The area DoT isn't cast either, so it's a wash until a behaviour uses one of them.

## Matter at 24 in Thidranki

**Server code,** Matter 23, Body 5, Spirit 3:

- **Nukes, in order:** Dissolving Smoke (37 every 5 s for 20 s, baseline), Devolution (37 every 4 s for 24 s, Matter 21), then Greater Essence Consumption (lifedrain, 85, 14 power, heals her for 40 %). The two DoTs stack, because `dotFamily` and the server tell them apart by tick frequency.
- **DoTs are her power efficiency:** 148 and 222 damage for 13 power each, against 85 for 14 for the lifedrain, if the target lives through them. **Server code:** `pickNuke` drops them below 40 % target health, which is why.
- **Crowd control:** a root, Major Crippling (2.5 s, range 1500, 31 s, baseline), since a mezz is Mind and she has no Mind. `capabilities().cc` counts it, so she gets adds.
- **Buffs:** her own Fend Offense and Barrier of Warding. Acuity comes from the Cleric.
- **Reached, and no behaviour casts it:** Puncture Spirit (area DoT, 33, radius 350, 17 power; only with `aoe`, and it breaks mezzes), Cursed Vigor (disease), Enfeeble Body and Magical Web (debuffs), Obscuring Dust (nearsight), Shift Health, Convert Spirit and the pulsing pet shields.
- **The pet:** Emerald Simulacrum, baseline at level 20, is kept up by `summonPet` and follows the focus (`petControl`), with its heals by `petHeal` and its long buffs by `petBuff` (`bun sdk/classes/reach.ts Cabalist Matter`). The reports below are from runs with no pet, so compare with `--pet.enabled=false`.

## What the reports show

**Verified,** six Camelot RvR rounds at level 24, 46 minutes, to 2026-11-03 21:48:

| Deaths | Damage a minute | Nukes | Crowd control | First nuke | `cc:crowd_controlled` | `nuke:interrupted` | Moving in fights | Targeted | In melee |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 148 | 60 | 52 | 27.3 s | 24 | 8 | 37 % | 14 % | 16 % |

- **The group's top damage, tied with Taliesin,** and no `assist: no power` in her top reasons, where he has 121 and Merlin 56. So DoTs seem to hold out on power in RvR too, though nothing has been compared.
- **52 crowd controls for a root.** A root doesn't stop a player casting, unlike a mezz, and `Spellbook.cc` makes no difference between them at `assignCc`. Whether her turns are better spent on a DoT in RvR is untested.
- `assist: focus not in view` 83 times, like the other casters: fights spread out.
- Every death to Midgard.

**Verified, PvE:** forest messengers came 3 to a pull at L14-15, with Merlin's mezz and her root holding the two adds; a clean first pull, then a wipe with 10 adds in the same hunt. That camp was dropped.

## Not supported yet

- **The Spirit line beyond the pet's upkeep:** its level comes with the character's whatever the spec. What more Spirit buys for it hasn't been measured.
- **Area DoT** and **disease:** no behaviour for either.
- **Spirit debuffer:** Diminish Immunities at Spirit 22 (Body, 15, 8 s) matches her Body lifedrain, so `resistDebuff` would cast it wherever `debuffPays` says ([enchanter.md](enchanter.md)). Nobody has run the build.

## Community, RvR at 20-24 (research 2026-11-09)

- **Unverified:** send the simulacrum at the enemy healer or caster, since every swing of an NPC pet starts the 3 s interrupt timer (**server code**, GameLiving.cs:708: 100 % plus 5 % per level above the target). A player DoT interrupts only when its first tick lands (DamageOverTimeECSEffect.cs:60). Disease (Cursed Vigor) goes on the kill target to cut its healing. Nearsight (Obscuring Dust) goes on back-line healers and casters. Sources: https://www.uthgard.net/forum/viewtopic.php?p=378462, eden-daoc.net/viewtopic.php?p=11675 (snippet).
- **Verified, arena round 5:** Morgana dealt 2836, the most in the group, plus 863 from her pet. 7 of her nukes were interrupted, and she was in melee 17 % of fight time.
