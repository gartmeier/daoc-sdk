# Warrior

Midgard's tank: a weapon line, a shield and Parry, with no spells. For every style and level on this server run `bun data/class-sheet.ts Warrior`; for what a build reaches, `bun sdk/classes/reach.ts Warrior "Hammer, Shields 42, high Parry"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/warrior.ts` is the tank's list with a fight that also swings what a block, a parry or a position opens, the same `reactingTank` as the Hero's ([hero.md](hero.md)):

```typescript
import { warrior } from '../../sdk/classes/warrior';
export default warrior();
```

**What changes, server code,** on Axe 24, Shields 18: Pillager stays the backup, with its attack slow. Ahead of it go Valkyrie's Shield after a block, Disable (4 s stun, from the side) with the enemy on someone else, and Cleave otherwise, which needs a parry and slows the target by 16.

**On Axe a block buys damage, not a stun.** Valkyrie's Shield has no proc: it's growth 0.89 for 5 endurance, and the picker takes the first reaction to a block in the data's order, ahead of Stun and Incapacitate. A Hero gets Horizon Blade there, a stun.

In `rvrRoaming`, which is what Midgard runs, the list keeps `tank` and this replaces it in place.

**Not played.** To look for: landed reactions in the log, his damage a minute and his endurance. Pillager's slow goes on less often if reactions land instead.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/warrior.ts` ([builds.md](../builds.md)). Multiplier 20, so 584 points by 24. Levels the rule gives each build, lines in buying order:

| Character level | Points | Hammer, Shields 42, high Parry: Hammer / Shields / Parry | Hammer, Shields 50, less Parry: Hammer / Shields / Parry | Sword two-hander, Shields 42: Sword / Shields / Hammer / Parry |
|---|---|---|---|---|
| 10 | 94 | 10 / 8 / 1 | 10 / 8 / 1 | 10 / 8 / 1 / 1 |
| 20 | 404 | 20 / 18 / 8 | 20 / 20 / 1 | 20 / 18 / 1 / 8 |
| 24 | 584 | 24 / 18 / 16 | 24 / 23 / 7 | 24 / 18 / 1 / 16 |
| 30 | 914 | 30 / 25 / 16 | 30 / 29 / 7 | 30 / 25 / 1 / 16 |
| 40 | 1624 | 40 / 37 / 16 | 40 / 40 / 8 | 40 / 37 / 1 / 16 |
| 50 | 2979 | 50 / 42 / 41 | 50 / 50 / 31 | 50 / 42 / 29 / 31 |

- Thorgrim plays the first with Axe for Hammer: he carries an axe, and the two cost the same and have styles at the same levels up to 24. **Server code:** autotrain makes a weapon line's levels up to character level / 4 free (`ClassWarrior.cs`).
- **Community, unverified:** Blackthorn and Uthgard insist on Shields 42 for Slam at 50, and on a Hammer for its snares in group play. Only the Axe version has been played.
- **The line is `Shields`, shown as Shield.** For a while `town.ts` named a line the client didn't know, and `train` dropped the name without a word: he stood at Axe 20, Parry 20, Shield 1 at level 20. `bot.trainBuild` fails loudly now ([builds.md](../builds.md)).

## Which style

**Verified: the name doesn't tell you the threat.** On Axe, Plague taunts and Hoarfrost detaunts. Runs 070604 and 072248 at level 14 had tank hold 53 % and 31 %, with 2 and 7 deaths: an old match on the word "taunt" had made Hoarfrost his damage style once Axe 12 made it his best, so he shed threat on every hit. With `tankStyles` reading the proc, test run 075641 had hold 100 % and 0 deaths, and the group then had 0 deaths in about 40 hunts up to level 20. The other lines have their own: Draw Out and Provoke taunt, Temper and Placate detaunt. [group-coordination.md](../group-coordination.md) has the threat numbers.

**Verified,** at 24 his damage style is Pillager (Axe 10, anytime, 15 endurance, slows the target's attacks by 21 for 20 s). The same block reactions and side stuns as a Hero's are in reach ([hero.md](hero.md)), from Shields 18: Stun, Disable, Incapacitate. The plain `tank` doesn't use them. The kit swings Disable, and after a block on Axe it swings Valkyrie's Shield instead of a stun.

## A slower weapon

**Verified,** wolf camp, alternating 4-minute runs, Thorgrim's damage per fight second (all at level 20-21, 0 deaths):

| His weapon | Runs | Damage per fight second | Tank hold | Fight | Kills/h |
|---|---:|---:|---:|---:|---:|
| Training axe, 1.1 effective DPS | 6 | 3.9-7.2 | 78-100 % | 26.7 s | 53 |
| Alloy double-bladed axe, 6.1 | 3 | 11.4-12.7 | 98-100 % | 19.7 s | 103 |
| Dragonmight, level 51 | 2 | 15.3, 15.4 | 93 %, 92 % | 21 s, 18 s | 132, 115 |

- More damage is more threat, and hold didn't suffer between the first two.
- **A slow axe lands fewer styles:** about 5 a run on the 4.2 s axe against 13-20 on the 2.5 s one, so taunts come slower. That's the likely cost in the last row's hold. Harder fights and RvR weren't tried.

## What the reports show

**Verified,** six Midgard RvR rounds at level 24, 46 minutes, to 2026-11-03 21:42:

| Deaths | Damage a minute | Styles landed | Targeted | `kill:out_of_reach` | `kill:timeout` |
|---|---:|---:|---:|---:|---:|
| 5 | 232 | Pillager 22 | 18 % | 121 | 11 |

- **Almost all of the 121 were one round.** Round 10 had 100, then `rejoinFight` in `rvrBehaviors` took it to 0 in round 11, with his damage 1091 to 4077, when he also began near the fight.
- Tank hold reads 0-3 % in RvR. It means nothing there: players have no threat table.
- Template health is 698, the most of the 15.

## Not supported yet

- **Stuns on demand and Engage:** as for the Hero ([hero.md](hero.md)).
- **Thrown Weapons:** a line of the class, and the SDK has no ranged attack.
- **The two-hander** in the Sword build: `tank` keeps what `hand` took in hand at the run's start (`bot.takeMeleeSlot`, by spec and styles) and doesn't switch by the fight.
