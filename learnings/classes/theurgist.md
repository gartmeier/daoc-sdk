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
- **Pets:** Summon Aged Ice Spirit and the others go on the focus by `fnfPet`, on a fight with 13 s left at its rate, above his power floor: each comes 64 in front of him and goes at the target, gone with it or in 20-30 s, which is how they're meant to fight (ice 25, air 20, earth 30 s; 60 s from Earth 32; 70 % of that under resurrection illness).
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

## Community, RvR at 20-24 (research 2026-11-09)

- **Server code:** a Theurgist's pet goes at one target, stays on it, dies with it and takes no orders (TheurgistPetBrain.cs). At most 16 at once. Confusion kills them (ConfusionECSEffect.cs:42).
- **Unverified:** "you'll spend most of your time throwing pets on casters/healers": the pets are interrupters. Field of Snow (AoE snare) is a cheap AoE interrupt when a group closes in. Source: https://forums.freddyshouse.com/threads/theurgist-rvr-spec.54373/
- **Verified, arena round 5:** Taliesin was targeted 45 % of fight time and in melee 31 %, both the group's highest. 5 nukes interrupted, 6 ice spirits summoned, and the pets dealt 0 damage. In round 3 two summons dealt 56.

## Gives ground instead of casting with a melee on him (kit, from Camelot's round after round 6, 2026-11-09)

**Why, verified:** in arena round 1 he died "while casting Summon Aged Ice Spirit" with an enemy on him, and was interrupted 7 times. In round 5 he was in melee 31 % of fight time with 5 nukes interrupted. Every cast he has takes 2.5-3 s, and a swing, a miss too, starts a 3 s timer that ends any cast short of its half (**server code**, SpellHandler.cs). `flee()` runs him to the tank, and once he's there the list's `fnfPet` and `assist` cast into the hits.

**The change** (`sdk/classes/theurgist.ts`, asked for by the Albion group session): `giveGround` (react, so above `fnfPet`, which withPets puts just above the fight) acts while an enemy is in melee on him, as `flee()` reads it. Near the tank (within 300) he steps to the tank's far side from the attackers, 130 out (inside flee's 150, so the two don't pull him back and forth). Already there, he steps a quarter turn round the tank. With no tank alive, the healer is the haven. He casts nothing while he does this: the peel is Nimue's stun (cleric kit) and Merlin's mezz (the group's peelMezz). `theurgist({ giveGround: false })` turns it off. **Since 47b79f7** the shared `flee()` circles the tank the same way (`giveGroundStep`, now in sdk/group/behaviors.ts), and flee comes first in the list. So `giveGround` acts only when there is no tank to run to, and then it gives ground toward Nimue, where flee would step 450 straight away.

**To look for:** his interrupts, deaths and in-melee share against round 5 (5, 1, 31 %), and `flee` turns that name the tank.

**Arena round 14** (Camelot wiped Midgard 5/0): top damage at 1892, no deaths, 3 interrupts. He was targeted 46 % and in melee 54 % of fight time, so flee's circling round Galahad kept him alive rather than out of reach.

**Arena rounds 101-106:** six straight Camelot wins, three over Hibernia (5/2, 5/0, 5/0) and three over Midgard (5/1, 4/3 cap, 5/0). Taliesin dealt 1010-2666 a round (2666 in the 371 s round 104) and died once in six rounds.

## Status at the end of the arena (2026-11-10, rounds 1-119)

**Proven:**
- Top or second damage in most wins (up to 2666 in round 104).
- `quickcastUnderFire` 1-3 times a round, plus `meleeDebuff` (Friction) and `offFocus`.
- The shared `flee` now circles the tank with `giveGroundStep`. His own `giveGround` acts only with no tank alive.

**Open:**
- His ice spirits (`fnfPet`) rarely show any damage in reports; whether they land is unverified.
- Field of Snow (area snare) and Ice Blast (snare nuke) are unused.
- Confusing Gust needs Wind 4, which costs his 5 spare points. Declined for now because it would lock out Merlin's mezz.
