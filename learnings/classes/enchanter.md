# Enchanter

Hibernia's list caster: nukes from Light, point-blank bombs and resist debuffs from Mana, a pet from Enchantments. For every spell, level and cost on this server run `bun data/class-sheet.ts Enchanter`. This file holds what the data doesn't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.

## Which nuke at level 24

Verified 2026-11-03 on a throwaway stack, clones with Ciaran's stats (Int 89, Dex 100, no gear), casting at a training dummy of their own level, spell costs set to 0 so power didn't end a run. Three to five 30 s runs each, about 2.85 s per nuke.

| Build | Spell | Per landed hit | Damage per second | Power |
|---|---|---|---|---|
| Mana 24 | Sun Streak (Light baseline, 88) | 75, spread 26-127 | 22 | 15 |
| Light 22, Mana 9 | Deceiving Rapture (102) | 140, tight (91-100 % of its base) | 36 | 13 |
| Mana 24 | Disenchanting Emission (133, radius 300) | 139 at about 80 units from the target | 47 | 12 |

- **A Mana Enchanter's single-target nuke is a weak one.** A spell's minimum damage comes from the spec of its own line (`SpellHandler.CalculateLowerVarianceBound`), and at Light 1 Sun Streak can land anywhere from 20.8 % to 100 % of its base. Light 22 lands at 91-100 %. So Light 22 hits 87 % harder, for less power, from 1500 range.
- **The Mana line's strength at 24 is the bomb, which is point-blank.** It has range 0 and centres on the caster, and its damage falls with distance from the caster: base 192, 139 at about 80 units. A 278-health caster would have to stand on the target. Nothing in the group behaviours casts it (`pickNuke` wants range above 0).

## The debuffs

Server code: Empowering has one for each of three damage types.

| Value | Heat, 8 s | Cold, 15 s | Matter, 15 s |
|---|---|---|---|
| 15 | Amplify Heat at 27 | Amplify Cold at 24 | Amplify Matter at 23 |
| 30 | Endow Heat at 36 | Endow Cold at 34 | Endow Matter at 33 |
| 50 | Empower Heat at 49 | Empower Cold at 46 | Empower Matter at 44 |

- **All of Hibernia's nukes in this group are Heat:** the Enchanter's and Mentalist's Light spells. Mentalist DoTs and the Enchanter's bombs and damage shields are Energy, which has no debuff here. The Bard's shouts and the Druid's DoTs are Body. Nothing in the group does Cold or Matter, so at Mana 24 the two debuffs he has help no one. Measured: Amplify Cold on Sun Streak, 76 per hit against 75.
- **No Enchanter has a Heat debuff at level 24.** Mana 27 costs 377 points and level 24 has 299; level 27 is the first with 377, and Thidranki ends at 24. Items don't help: a line's spells follow the trained level alone (`Specialization.GetSpecLevelForLiving`), and an item's bonus only raises damage and the minimum.
- **Effectiveness:** an on-line debuff lands at about 1.24 times its value (`SingleStatBuff.cs:46-50`; the server said 1.23 and 1.24). A resist below 0 counts in full on a monster and half on a player (`ResistCalculator.cs:76-79`). Buffed resists are taken off first.
- **The ranks of a type don't stack:** they share one spell group, and a stat debuff conflicts with any spell of its group (`SingleStatDebuff.HasConflictingEffectWith`).
- **Messages:** "X seems vulnerable to heat!" when it lands, "X's heat vulnerability fades." when it ends. A resist on the target shortens it (`ResistDebuff.cs:25-38`).

## What the Heat debuff is worth

Verified 2026-11-03, alternating runs in pairs, one caster alone. The gain comes from the `(+N)` in the server's damage line, so it doesn't depend on the spread.

| Level, spec | Debuff | Monster: extra per hit | Monster: damage per second, without and with | Player: extra per hit | Player: damage per second, without and with |
|---|---|---|---|---|---|
| 27, Mana 27 | Amplify Heat | +17 % | 22.3 and 17.2 (-23 %) | +8 % | 19.9 and 15.5 (-22 %) |
| 36, Mana 36 | Endow Heat | +36 % | 31.0 and 27.3 (-12 %) | not run | not run |
| 50, Mana 49, Light 22 | Empower Heat | +61 % | 59.2 and 59.5 (even) | +30 % | 50.9 and 44.9 (-12 %) |

Five pairs of 30 s runs on a monster, two pairs of 25 s on a player. The player figures are few.

- **Alone it never gains.** 8 s holds 2 nukes after the debuff's own cast of about 2.3 s, and 14 % of debuffs are resisted (13 of 94 at the caster's level), so 4.8 debuffs went into every 6.8 nukes. Empower Heat costs about the same power as the nukes it replaces: 344 against 330 per run.
- **It's a debuff for the group, not for his own nuke.** The window raises every Heat nuke on the target, so it pays beside other Heat casters. That part is calculated from the table, not measured: with a Light Mentalist beside him dealing 1.7 times his damage, Endow Heat pays on a monster and Empower Heat on a player too. Amplify Heat comes out about even on a monster and short on a player.

## In a group

`resistDebuff` (`sdk/group/debuff.ts`) casts the debuff matching the caster's direct-damage type on the focus and goes in a character's `react`, right above `assist`. `sdk/classes/enchanter.ts` wraps it. It acts only where `debuffPays` says the damage pays for the cast, so on its own it first casts at Empower Heat, on monsters.

```typescript
import { enchanter } from '../../sdk/classes/enchanter';
export default enchanter({ heatAllies: 1.7 });   // the same-type damage others deal beside him, in multiples of his
```

Verified in a real `runGroup`, 40 s on a dummy with two clones: the level 50 cast 5 Empower Heat and 10 nukes with no failures, and the level 36 with `allies` unset cast no debuff and 14 nukes. Not yet played in a fight with a tank or in RvR.

## Arena round 10: offFocus

**Verified,** round 10 (2026-11-09, against Albion: Paladin, Cleric, Sorcerer, Cabalist, Theurgist): wiped in 79 s, 0 kills. Ciaran cast 2 nukes and moved 73 % of the fight; 2 more were `out_of_range`. The pack's soft focus was their back line, beyond reach; the casters walked toward it and died en route. Albion's casters fixed the same idling with `offFocus` (Cabalist kit, 6675df9: Morgana, Taliesin and Merlin had idled 39-67 turns on "focus out of reach").

From round 11 the kit's fight is `nukerFight(0, true)` from `sdk/classes/cabalist.ts`: `assist`, then `offFocus`, which nukes the nearest free enemy player in reach (not crowd-controlled, not assigned or claimed for cc, so no mezz is woken) while the focus is out of reach, from where he stands, never into a melee swing. `enchanter({ offFocus: false })` leaves it out.

## Quickcast (from the round after 28)

Ciaran has Quickcast. His kit's `instant` slot holds the Cabalist kit's `quickcastUnderFire` (Albion class session, 1f05f78): with a melee on him, or a cast of his cut in the last 5 s, Quickcast and then his cc assignment or his nuke on the focus, uninterruptible, twice the power, once per 31 s. Rounds 21 and 23: in melee 51-57 % of the fight, `nuke:interrupted` 3-5 a round.

## Arena round 33: answers to a melee

**Verified,** round 33 (beat Camelot 5-2, one 251 s fight): Ciaran moved 85 % of the fight, cast 2 nukes and died; `quickcastUnderFire` never fired (the focus was out of his reach). **Server code / data:** Light nuker at 24 reaches Prismatic Flash (stun, 2.5 s, 5 s) and two instants no behaviour cast: Blinding Scintillation (attack-speed debuff, value 11, 120 s, 12 power) and Dazzling Torch (melee-damage debuff, value 10, 30 s, 13 power), plus Field of Scintillation (the same with radius 350).

From the next round his `instant` slot, above `flee`: `quickFlash` (the Mentalist kit's: Quickcast and Prismatic Flash on the melee hitting him), `dazzle` (Blinding Scintillation, else Dazzling Torch, at the melee on him, else on a soft member, by the Midgard Healer kit's `slowTarget`; never the area one, which would wake a mezz beside its target; never a crowd-controlled enemy), then `quickcastUnderFire`.
