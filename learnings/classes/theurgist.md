# Theurgist

Albion's elementalist: direct damage and roots from Cold, buffs and bladeturns from Earth, haste and speed from Wind, and short-lived pets from all three. For every spell, level and cost on this server run `bun data/class-sheet.ts Theurgist`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Theurgist "Ice and earth"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/theurgist.ts` is a nuker that stops at a floor of power and leaves the kill to the others:

```typescript
import { theurgist } from '../../sdk/classes/theurgist';
export default theurgist();                       // or theurgist({ saveBelow: 30 })
```

**Why, verified:** "the Theurgist empties his pool in every 14 s fight." At the wisps (runs 233455-001316, L10-11) the group waited 34-37 % of each hunt for Taliesin's power, even at `ready.mana` 20. With `thrifty(assist, 40)` the waiting on him ended in run 064716, at 4.66M XP/h, 0 deaths, and moved on to Merlin ([sorcerer.md](sorcerer.md)).

**The floor binds his pets too:** the kit sets `pet.fnfFloor` for him alone (`Character.pet`), so `fnfPet` stops at `saveBelow` as well, or at the run's own floor if that is higher. They count as nukes, cost more of the pool, and `thrifty` wraps only `assist`. Without the kit they stop at the run's floor, 20 by default. Its effect on a long fight hasn't been measured: the wisps' 14 s fights never reach `pet.fnfLifeMs`.

**The floor has a cost:** at the forest cats (run 210221) he was idle 54 % of fights. It's a choice for a group where others carry the damage. In RvR the strategy has none: `assist: no power` 121 times in 46 minutes, the most in his group. Nobody has run the floor there.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/theurgist.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Ice and earth: Earth Magic / Cold Magic / Wind Magic | Earth and wind: Wind Magic / Earth Magic / Cold Magic | Wind nuker: Wind Magic / Cold Magic / Earth Magic |
|---|---|---|---|---|
| 10 | 54 | 1 / 10 / 1 | 1 / 10 / 1 | 9 / 4 / 1 |
| 20 | 209 | 8 / 18 / 1 | 1 / 20 / 1 | 19 / 4 / 1 |
| 24 | 299 | 15 / 18 / 3 | 12 / 20 / 4 | 22 / 8 / 4 |
| 30 | 464 | 23 / 18 / 3 | 12 / 27 / 4 | 28 / 8 / 4 |
| 40 | 819 | 35 / 18 / 3 | 23 / 32 / 4 | 38 / 8 / 4 |
| 50 | 1494 | 35 / 41 / 3 | 36 / 40 / 4 | 45 / 25 / 16 |

Taliesin plays Ice and earth. **Community, unverified:** Earth and wind is the most common at 50 in two sources; one write-up calls Wind nuker the top damage. **Server code:** the Wind line's plain nuke is 102 at Wind 22, against 88 for Cold's baseline at level 24.

**Lines by KeyName:** `Cold Magic`, `Earth Magic`, `Wind Magic`; guides say Ice and Air. Promotion at 5: `join the Defenders of Albion` (**verified**, Master Cear).

## Ice and earth at 24 in Thidranki

**Server code,** Earth 15, Cold 18, Wind 3:

- **Nuke:** Ice Blast (Minor), baseline at 24: 88 Cold, 2.6 s, range 1500, 15 power. One spell, with no DoT to open on.
- **A cheaper nuke it doesn't cast:** Ice Blast, Cold 17: 64 and a 35 % snare for 30 s, 3 s, 10 power. 6.4 damage a power against 5.9. `pickNuke` takes the highest level, so the build's own Cold spell never goes off. Against players who run, the snare might be worth more than the damage. Not measured.
- **Crowd control:** a root, Fingers Of Ice (Lesser), 2.5 s, 38 s, baseline, since he has no mezz. He gets adds.
- **Buffs:** Emerald Shield and Skin of Dust on himself, and on others, for power rather than concentration: Earthen Burst (damage add) and Bolstering Storm (haste 11) for the tank, Skin of Sand (a bladeturn) for the tank and healer. At 12-13 power and 20 minutes a go, those come out of his pool between fights.
- **Pets:** Summon Aged Ice Spirit and the others go on the focus by `fnfPet`, on a fight with 13 s left at its rate, above his power floor: summoned at the target, gone in 20-30 s, which is how they're meant to fight (ice 25, air 20, earth 30 s; 60 s from Earth 32).
- **Reached, and no behaviour casts it:** Field of Snow (area root), Friction (attack slow), Brisk Wind.

## What the reports show

From runs with no pets: `--pet.enabled=false` is the run to compare with.

**Verified,** six Camelot RvR rounds at level 24, 46 minutes, to 2026-11-03 21:48:

| Deaths | Damage a minute | Nukes | Crowd control | First nuke | `nuke:crowd_controlled` | `cc:crowd_controlled` | Targeted | In melee |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 7 | 144 | 73 | 45 | 27.3 s | 18 | 22 | 14 % | 13 % |

- The most deaths of the group, at the same health as Merlin and Morgana (template 445).
- The most nukes, and the most time out of power, with `assist: no power` 121 times: no DoT, so 15 power for each 88, where Morgana's 13 buys 148 or more.
- He took the group's one accepted rez.
- `focus not in view` 84 times, as for the other casters.

**Server code:** a recall stone's cast fails if we were in combat in the last 10 s, and a pet's swing counts (`GatewayPersonalBind`).

## Not supported yet

- **Speed:** Brisk Wind, as for the Sorcerer ([sorcerer.md](sorcerer.md)).
- **Area root:** Field of Snow. `isRoot` wants a single target.
