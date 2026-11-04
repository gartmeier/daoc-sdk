# Paladin

Albion's tank: a weapon line, a shield and Parry, with chants for the group. For every chant, style and level on this server run `bun data/class-sheet.ts Paladin`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Paladin "Chants and sword"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/paladin.ts` is a tank that sings:

```typescript
import { paladin } from '../../sdk/classes/paladin';
export default paladin();
```

**Why: outside RvR, without it no chant ever plays.** The default tank list has no `song` (`rvrBehaviors` has had one since 2026-11-04), so Galahad's report showed no chant in 46 minutes, while his build spends its most points on Chants. Chant of Persistence is the only endurance song in the Camelot group, and styles stop silently below 15 % endurance ([group-coordination.md](../group-coordination.md)). The kit puts `song` above the fight, as it stands in the melee list.

- **What it plays:** in a fight Crusader's Defense (the armor kind), or Chant of Persistence while he is below 30 % endurance (`songs.enduranceBelow`). Out of a fight, Persistence. Refreshment and Battle Fury only if a build lacks the others: one pulse at a time means those two don't get a turn. Which of these is best in a fight hasn't been measured.
- **Verified, throwaway stack (2026-11-04):** his chants come through the skills list (`useSkill`), are instant, reach the group, and don't stop the swing. Three probes: 5, 6 and 6 hits in the 16 s before a chant, 6, 5 and 3 in the 16 s after it, and he never left attack state. An instant one goes out raw while he swings, so it doesn't lose the mob.
- **Twisting works on this server, and no behaviour does it.** A new chant ends the running pulse (`CancelIncompatiblePulseEffects`), but what the old one already put on the group runs out by itself (Duration 5-6 s). Changing chant every 2 s kept 2-3 of his 4 on him and on the Cleric at once, for free. Left alone, only the last one stays. `song` plays one.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/paladin.ts` ([builds.md](../builds.md)). Multiplier 20, so 584 points by 24, and Slash and Chants have free levels. Levels the rule gives each build, lines in buying order:

| Character level | Points | Chants and sword: Chants / Shields / Slash / Parry | Two-Handed hybrid: Chants / Shields / Two Handed / Slash / Parry | Thrust and chants: Shields / Thrust / Chants / Parry |
|---|---|---|---|---|
| 10 | 94 | 10 / 1 / 9 / 1 | 8 / 1 / 10 / 4 / 1 | 1 / 8 / 10 / 1 |
| 20 | 404 | 20 / 9 / 18 / 1 | 17 / 1 / 20 / 10 / 1 | 1 / 20 / 20 / 1 |
| 24 | 584 | 24 / 15 / 18 / 8 | 20 / 10 / 21 / 15 / 4 | 15 / 21 / 21 / 5 |
| 30 | 914 | 30 / 24 / 18 / 8 | 30 / 16 / 21 / 15 / 4 | 30 / 21 / 21 / 5 |
| 40 | 1624 | 40 / 37 / 18 / 8 | 40 / 32 / 21 / 15 / 4 | 40 / 34 / 21 / 5 |
| 50 | 2979 | 48 / 42 / 39 / 23 | 43 / 42 / 39 / 31 / 4 | 42 / 44 / 46 / 12 |

Galahad plays Chants and sword. **Server code:** Parry opens at 15, Two Handed at 5. **Community, unverified:** Uthgard's PvE build is the first, its group RvR hybrid the second.

**Server code: Chants 24 buys nothing a role list casts, kit or no kit, above Chants 22.** Persistence is at 22; the two levels above it buy Crusader's Defense (23) and Aura of Indestructability (24), both unused below. A character who won't get those used could move those 47 points to Slash, where his damage is the lowest of the three tanks. Not tried.

Promotion at 5 takes two keywords: `join the Church of Albion`, then `slashing` for Sword of the Initiate (**verified**, Lord Prydwen).

## Which style

**Verified,** at 24 his damage style is Uppercut (Slash 6, anytime, 10 endurance): 37 landed in 46 minutes of RvR. Enrage (Slash 8) is the taunt and Reflect (Slash 12) a detaunt, which the name doesn't say. `tankStyles` reads them from the server, as it does for a Warrior ([warrior.md](warrior.md)). Slash 18 reaches Riposte, a reaction, and Shields 15 Numb, Stun and Disable, which the plain `tank` doesn't use ([hero.md](hero.md)).

**Verified, PvE.** Tank hold 96-100 % at the bloated spiders, six hunts and 0 deaths. Chain from 10, plate from 20 ([merchants.md](../merchants.md)).

## What the reports show

**Verified,** six Camelot RvR rounds at level 24, 46 minutes, to 2026-11-03 21:48, beside [hero.md](hero.md)'s table of the three tanks:

| Deaths | Damage a minute | Styles landed | Targeted | `kill:out_of_reach` | `kill:timeout` | `kill:crowd_controlled` |
|---|---:|---:|---:|---:|---:|---:|
| 3 | 140 | Uppercut 37 | 22 % | 15 | 13 | 10 |

The fewest deaths of the group, with the lowest damage of the three tanks: Slash 18 against a Hero's Blades 24 and a Warrior's Axe 24. Template health is 616.

## Not supported yet

All of these are his and no behaviour casts them:

- **Crusader's Refreshment** (Chants 20), a group heal pulse: a `combatHeal` song, but it never gets a turn with an armor chant known. It heals nobody out of combat (`CombatHealSpellHandler`), so it isn't a between-fights `health` song.
- **Aura of Indestructability** (Chants 24, value 37, 17 power, 20 minutes), a self AF. `slotOf` doesn't know `PaladinArmorFactorBuff`.
- **Aggravate** (Chants 15), an instant taunt at range 1350, every 30 s. It would peel an add without walking.
- Only one pulse plays at a time ([spells.md](../spells.md)), so without twisting (above) endurance, heal, AF and damage are a choice. Crusader's Defense counts as a spec AF, capped at level x 1.875 (45 at 24; `ArmorFactorCalculator`), so its 61 gives 45 at most.
