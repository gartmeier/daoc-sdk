# Wizard

Albion's elemental nuker: Cold, Earth and Fire lines, cloth, Quickcast. For every spell and level on this server run `bun data/class-sheet.ts Wizard`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Wizard Ice`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/wizard.ts` is a nuker that survives a dive:

```typescript
import { wizard } from '../../sdk/classes/wizard';
export default wizard();
```

- **`instant`: `quickcastUnderFire()`** (the Cabalist's, `cabalist.ts`): with a melee on her or her last cast cut short, Quickcast and one spell that can't be interrupted, her cc assignment's root or else Ice Blast on the focus. Once per 30 s, at twice the power. No `meleeDebuff`: she has no instant spell.
- **`react`: `giveGround()`** (the Theurgist's): every cast she has is 2.5-3 s, so with a melee on her each is cut. Beside the tank she steps round him, away from them, instead of casting.
- **`fight`: `nukerFight(saveBelow, offFocus)`**, the list's `assist` and the Cabalist's `offFocus`, both casting from `plainNukesFirst`: her spells without Entangling Haze (below). Options `saveBelow` (0, no floor, as Camelot plays the arena), `offFocus`, `giveGround`.
- **No `selfBuff`:** both her self buffs, Emerald Shield (AF 124) and Aura of Incineration (an absorb), have a slot `buff()` keeps up.

## At 24, Ice (Cold 24, Earth 1, Fire 1)

`bots/vivien/build.ts` is `data/builds/wizard.ts` "Ice": Cold 24 and nothing else by 24, Earth and Fire stay at 1.

**Server code**, by `reach.ts`:

| Spell | Line | What | Cast | Power | Range | Who casts it |
|---|---|---|---:|---:|---:|---|
| Ice Blast (Minor) | Cold 24 | 88 cold | 2.6 s | 15 | 1500 | `assist`, `offFocus`, quickcast |
| Entangling Haze (Minor) | Cold 24 | 88 cold, 35 % snare 30 s | 3 s | 15 | 1500 | none: the kit leaves it out |
| Searing Gust | Cold | 76, cold resist -10 % 20 s | 3 s | 13 | 1500 | none |
| Steaming Blast | Cold | 133 around her, radius 300 | 2.5 s | 12 | 0 | none (`pickNuke` takes no range-0 spell) |
| Sweltering Cloud | Cold | 62 in 350, with a debuff | 3 s | 18 | 1500 | none (RvR runs `aoe: false`) |
| Fingers Of Ice (Lesser) | Cold | root 38 s | 2.5 s | 13 | 1500 | `crowdControl` |
| Flaming Rocks (Minor) | Fire 1 | bolt 115, 20 s recast | 2.5 s | 13 | 1875 | none |
| Fire Storm (Major) | Fire 1 | 85 heat | 2.6 s | 14 | 1500 | none |
| Emerald Shield, Aura of Incineration | Earth, Fire | self AF 124, self absorb | 3-4 s | | | `buff` |
| Earthen Burst, Minor Shield of Magma | Earth | damage add 5, damage shield 0.7, on others | 3-4 s | | 1000 | `buff` (on the tanks) |

- **Why Haze is left out:** it ties Ice Blast on spell level (24), and `pickNuke` breaks a tie by the skill list's order. It is 0.4 s slower for the same damage and power, and its snare ends at the next hit, which on the group's focus comes at once. `plainNukesFirst` keeps it only if she has no plain direct damage.
- **Fire 1 is weak:** the damage roll's floor at spec 1 against a level 24 target averages about 60 % of the listed number (`SpellHandler.cs`). A bolt is worse against players: half of it goes against armour, a block or guard cancels that half, and each enemy meleeing the target takes 20 % off its chance (`BoltSpellHandler.cs`). So Flaming Rocks stays unused, and `strongestNuke` (the pack's `byDamage`) would open with it: don't set it for her.
- **Any spell damage ends a mezz or a root near it** (`GameLiving.cs`): Steaming Blast or Sweltering Cloud beside our Sorcerer's area mezz would wake it. That is why neither is in the kit yet.

## Arena

**Verified,** round 122 (2026-11-10, against Midgard, lost 0 / 6), on the plain nuker list without the kit: 929 damage, the group's highest, 8 nukes and 3 roots, first nuke 3.6 s after the engage; in melee 34 % of the fight, targeted 12 %, died once ("walk: died", en route). In that round `rootMelee` gave her root assignments on their melee (she is a member whose only crowd control is a root).

**Verified, with the kit,** arena rounds 126-226 (2026-11-10/11, the whole night; Camelot's reports in `groups/camelot/runs/`), 39 rounds:
- **Damage:** 1254 a round, the most of any Camelot member (Gawain 962, Taliesin 760, Morgana 659, Galahad 499, Merlin 460), up to 3009 (round 172). 10.7 nukes, 1.3 Quickcasts and 0.7 roots on assignments a round.
- **Exposure:** targeted 25 %, in melee 30 % of fight time; 0.62 deaths a round, the second fewest after the Friar (0.58). Idle 9 % of fight time.
- **What cost her casts:** nukes refused `out_of_range` 44, `interrupted` 43, `not_visible` 35 (a hill, `lineOfSight`), `crowd_controlled` 29, `no_power` 23. Her idle turns: "no power" 118, "focus in the river, holding the bank" 90, "focus out of reach, holding ground" 67, "focus not in view, holding ground" 64, "focus out of reach, enemies by the step" 63.
- **Results:** 17 wins in 39 (against Hibernia 10 of 21, against Midgard 7 of 18): 130, 143, 146, 151, 161, 162, 165, 172, 176, 196, 197, 198, 207, 211, 214, 223, 226.

## Open

- **Power is her most common idle reason** (118 turns, 23 nukes refused, over 39 rounds), with no floor (`saveBelow: 0`). Not tried: a floor, or Merlin's power regen and `sharePower` aimed at her first.
- **Holding ground** ("not in view" 64, "out of reach" 67 + 63 turns) is the shared `assist` under Camelot's `standGround` (`groups/camelot/rvr.ts` STAND). Camelot's `closeIn` (`groups/camelot/close-in.ts`, a step toward a focus out of view or beyond 1500 plus the stand step) ran as an A/B by the run's start minute from round 187: off 4 W in 8, on 7 W in 17, no difference to call. `--closeIn=true|false` fixes it.
- **The river:** "focus in the river, holding the bank" 90 turns. The move guard keeps her dry, so a focus in the water is out of her fight until it leaves.
- **Steaming Blast under a dive:** in melee 30 % of fight time and 43 nukes interrupted. Quickcast and Steaming Blast (133 each around her, 24 power) when two or more enemy players are on her, away from anything under crowd control, is a kit option still to try.
- **Searing Gust on the focus every 20 s:** the 10 % on the next Ice Blasts is worth about 40 damage per 20 s, and whether a recast refreshes it is unchecked.
- **Roots against nukes:** 26 roots over the night (0.7 a round, 4 resisted), each an Ice Blast lost. Camelot's tactics keep its Cabalist on damage against two healers; nobody has measured whether that pays for her too.
