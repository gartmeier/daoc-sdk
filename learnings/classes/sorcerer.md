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

- **Charm:** Compel Will at Mind 12 takes a mob up to L26 or his own level, whichever is lower: that's the spell's value, so Mind buys the rank and nothing more (`CharmSpellHandler.cs`, [pets.md](../pets.md)). **Community, unverified:** the guides disagree, and the server is what counts here.
- **Mezz cure:** Clear Mind, as for the Bard ([bard.md](bard.md)).
- **Debuffs:** no behaviour casts stat debuffs.
- **Pets** generally: a charm stays out of the automatic behaviours (`group-coordination.md`), though `petControl` orders one that is up. [pets.md](../pets.md) has how one is driven.

## Community, RvR at 20-24 (research 2026-11-09)

- **Unverified:** mezz the adds, crowd-control the enemy healer, debuff the kill target, then DoT and nuke. Never DoT or AoE a mezzed target. Snare a melee that chases you. Source: camelotherald.fandom.com/wiki/Sorcerer (search snippet only).
- **Server code:** confusion on a Theurgist's pet kills it (ConfusionECSEffect.cs:42), so Mystify Mind (Mind 16 on Merlin, 2.5 s, 9 power) clears an enemy Theurgist's pets. Instants skip the interrupt check (SpellHandler.cs:597, :603). His 0 s debuffs (Imbalance, Magical Web, Banish Conviction, Enfeeble Body) can go out in melee, but they do no damage.
- **Verified, arena round 5:** Merlin was targeted 34 % of fight time and in melee 19 %, with 5 nukes interrupted and 4 casts refused while he was mezzed or stunned.

## Shield Mind, and Hibernia's opening mezz (kit, from Camelot's round after round 12, 2026-11-09)

**Verified, arena round 12** (Hibernia took the cap from Camelot, 1 kill / 7 deaths, `groups/camelot/runs/20261109-220938.md`): Hibernia opened with its mezzes. Merlin was "entranced" 4 s into the engage, then Morgana, Nimue and Galahad went within 10 s. Merlin dealt 182 damage in the round, and his mezzes went resisted 2, immune 1, interrupted 1.

**The change** (`sdk/classes/sorcerer.ts`): a `selfBuff` chore (from the Paladin kit) keeps Shield Mind up between fights. That's Mind 16, self, 10 power, 20 minutes. **Server code:** a `MesmerizeDurationBuff` SingleStatBuff on MesmerizeDurationReduction, which CCSpellHandler.cs:212 multiplies into every mezz on him, so mezzes are 10 % shorter. `buff()` doesn't slot that type.

**Not the kit's:** Clear Mind (`cureMezz`) is the group's `--cure` flag, and was within the noise on 2026-11-04 (groups/camelot/lab_log.md).

**Arena round 21** (Camelot wiped Hibernia 5/0 in one 90 s fight, `groups/camelot/runs/20261109-231607.md`): the first Hibernia round with Shield Mind, the group's `--cure` against Hibernia, and its mezz-the-mezzer plan. Merlin cured 4 times (1 interrupted), cast 3 cc and dealt 421 damage, with no deaths. He was targeted 56 % and in melee 38 % of fight time. Against rounds 12 and 15 (1 kill, 12 deaths together), the opener no longer decided it.

**Arena round 40** (Camelot wiped Hibernia 5/0, no deaths): Merlin cured 8 times (`--cure` against Hibernia), cast 2 cc, 5 debuffs and 1 quickcast, and dealt 260 damage.

**Arena round 116** (Hibernia wiped Camelot 0/5): Merlin cast 11 debuffs (about 90 power), 3 cures and 3 cc, dealt 0 damage, and the group waited 17 % of the run on his power. His power is the group's mezzes and cures, so his `meleeDebuff` is now `selfOnly` and needs 50 % power: only on a melee on him, where nothing else of his can land anyway. Morgana and Taliesin keep the general rule (35 % on their own attacker, 60 % on another member's).

## Status at the end of the arena (2026-11-10, rounds 1-119)

**Proven:**
- Shield Mind is kept up (mezzes on him 10 % shorter).
- `quickcastUnderFire` went 1-3 times a round.
- `offFocus` and `meleeDebuff` run. Since 4f49b87 his debuffs go only on a melee on him, above 50 % power, after 11 debuffs drained him in round 116. In round 118: 3 debuffs, 6 cures, and no waiting on power.

**Open:**
- Hibernia often mezzes or focuses him first (up to 63 % targeted), and then the group's only cure is gone.
- Mystify Mind (confusion) and the area debuffs are unused.
