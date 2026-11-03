# Sorcerer

Albion's list caster for control: mezz from Mind, lifedrains and DoTs from Body and Matter, a power regen buff. For every spell, level and cost on this server run `bun data/class-sheet.ts Sorcerer`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Sorcerer "Balanced body and mind"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/sorcerer.ts` is a nuker that stops at a floor of power and leaves the kill to the others:

```typescript
import { sorcerer } from '../../sdk/classes/sorcerer';
export default sorcerer();                       // or sorcerer({ saveBelow: 30 })
```

**Why, verified:** at the bloated spiders (run 064716, L11) the group waited 36 % of each hunt for Merlin's power, and once `thrifty(assist, 40)` took the same wait off Taliesin it fell on him. Camelot's strategy gives both of them the floor and leaves Morgana without, so that every fight has one caster at full rate. Which casters take it is the group's choice, and the helper is `sdk/classes/thrifty.ts`.

**In PvE only so far.** Camelot's RvR strategy has no floor, and he reports `assist: no power` 56 times there. A floor saves power for his mezzes, which share it, but nobody has run that.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/sorcerer.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Balanced body and mind: Body Magic / Mind Magic / Matter Magic | Mind crowd control: Mind Magic / Body Magic / Matter Magic | Body nuker: Body Magic / Mind Magic / Matter Magic | Mind and matter charmer: Mind Magic / Matter Magic / Body Magic |
|---|---|---|---|---|---|
| 10 | 54 | 8 / 5 / 1 | 10 / 1 / 1 | 10 / 1 / 1 | 5 / 8 / 1 |
| 20 | 209 | 11 / 16 / 1 | 20 / 1 / 1 | 20 / 1 / 1 | 10 / 17 / 1 |
| 24 | 299 | 17 / 16 / 4 | 24 / 1 / 1 | 22 / 8 / 4 | 15 / 18 / 4 |
| 30 | 464 | 24 / 16 / 4 | 30 / 1 / 1 | 28 / 8 / 4 | 17 / 24 / 4 |
| 40 | 819 | 28 / 28 / 4 | 40 / 1 / 1 | 38 / 8 / 4 | 31 / 24 / 4 |
| 50 | 1494 | 39 / 37 / 4 | 44 / 31 / 4 | 45 / 24 / 17 | 32 / 40 / 16 |

Merlin plays Balanced. **Community, unverified:** it's the standard Sorcerer in two sources; Mind crowd control is Uthgard's. **Server code:** at 24 the mezz is baseline, Greater Mesmerization at level 23 whatever Mind is, so Mind 24 buys Cloud of Senility, an area mezz the lists don't use, and Control Will, a charm they don't either.

## Balanced at 24 in Thidranki

**Server code,** Body 17, Mind 16, Matter 4:

- **Crowd control:** Greater Mesmerization, 3 s, range 1500, 44 s, 11 power. Longer than any other mezz in these three groups, for a half-second more than a Bard's. **Verified:** an older pick took Fog of Senility, an area mezz, some of the time, when the highest level won. Fixed.
- **Nukes:** Dissolving Smoke first (DoT, 37 Matter every 5 s for 20 s, 13 power), then Greater Essence Consumption (lifedrain, 85 Body, 2.5 s, 14 power, heals him for 40 % of the damage).
- **A nuke he paid for and doesn't cast:** Lesser Mind Scream, Body 16, is 77 for 10 power: 7.7 damage per power against 6.1, for 0.3 s more. `pickNuke` takes the highest level. On a character that runs out of power it might be the better spell. Not measured, and the lifedrain's heal is worth something.
- **Buffs:** his own Fend Offense and Barrier of Warding, and Perception of Power.
- **Reached, and no behaviour casts it:** Clear Mind (mezz cure, level 24), Major Crippling (root), Compel Will (charm), Mystify Mind (confusion), Imbalance and other debuffs, Shield Mind (a shorter mezz on himself).

## Perception of Power goes on himself only

**Server code.** It's a Realm buff, +2 power per tick, 9 power, 20 minutes, at Mind 15. By the formula ([mentalist.md](mentalist.md)) that takes a level 24 caster above 50 % power from 7 to 9 a tick, and below 50 % from 3 to 4. In a group where power was the limit in most hunts, Morgana and Taliesin could use it. They don't get it: `slotOf` puts every regen type in one `regen` slot, and `providerFor` prefers a healer, so the plan has Nimue's Renewal, a health regen, standing in for it. And that Renewal doesn't fit her concentration ([cleric.md](cleric.md)), so they end up with neither.

That's a fix in `sdk/group/spells.ts`, not a kit: power and health regen as separate slots. It's left here for the sessions working in `sdk/group`.

## Speed songs

**Server code.** Amplify Running is a Group speed song, value 132, 3 s cast. Taliesin has Brisk Wind, the same. The Skald's is 159 and the Bard's 174, and both those play it on every patrol. No Camelot member has `song` in its list, so that group walks at plain speed where the other two have one playing. `{ chores: [song()] }` in a character would play it in travel and retreat, and nothing else, since it's all he has. Not tried.

## What the reports show

**Verified,** six Camelot RvR rounds at level 24, 46 minutes, to 2026-11-03 21:48:

| Deaths | Damage a minute | Nukes | Crowd control | First nuke | `cc:crowd_controlled` | `cc:interrupted` | Targeted | In melee |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 88 | 50 | 52 | 27.4 s | 28 | 16 | 15 % | 15 % |

- **He's the group's mezzer and its lowest damage,** 88 a minute against Morgana's 148 and Taliesin's 144. `crowdControl` runs above `assist`, and more than half his turns went on it, or on being refused it.
- `assist: focus not in view` 88 times and `no power` 56.

## Not supported yet

- **Charm:** Compel Will at Mind 12. **Community, unverified:** the guides disagree on what Mind does for pet level.
- **Mezz cure:** Clear Mind, as for the Bard ([bard.md](bard.md)).
- **Debuffs:** no behaviour casts stat debuffs.
- **Pets** generally: what the class has, not how the SDK drives it.
