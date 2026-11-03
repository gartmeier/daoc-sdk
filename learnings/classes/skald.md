# Skald

Midgard's singing melee: damage adds, shouts and an instant mezz from Battlesongs, and a weapon. For every song, style and level on this server run `bun data/class-sheet.ts Skald`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Skald "Even songs and Hammer"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/skald.ts` sets the role to `melee`:

```typescript
import { skald } from '../../sdk/classes/skald';
export default skald();
```

**Why:** `roleForClass` makes a Skald `support`, a list that stands at range, heals and never swings, which is no use for a class with no heals. Midgard's `group.json` pins Bragi to `melee` for this; the kit carries it with the class. The melee list plays `song` and `meleeFight` already.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/skald.ts` ([builds.md](../builds.md)). Multiplier 15, so 437 points by 24. Levels the rule gives each build, lines in buying order:

| Character level | Points | Even songs and Hammer: Battlesongs / Hammer / Parry | Battlesongs first: Battlesongs / Hammer / Parry | Hammer first: Hammer / Battlesongs / Parry |
|---|---|---|---|---|
| 10 | 73 | 10 / 5 / 1 | 10 / 5 / 1 | 10 / 5 / 1 |
| 20 | 303 | 18 / 15 / 1 | 20 / 13 / 1 | 20 / 13 / 1 |
| 24 | 437 | 22 / 18 / 5 | 24 / 16 / 2 | 24 / 16 / 2 |
| 30 | 683 | 30 / 19 / 5 | 30 / 20 / 2 | 30 / 20 / 2 |
| 40 | 1213 | 35 / 33 / 5 | 40 / 27 / 2 | 40 / 27 / 2 |
| 50 | 2223 | 46 / 44 / 17 | 50 / 39 / 18 | 50 / 43 / 2 |

Bragi plays Even songs with Axe for Hammer, which he carries; the two cost the same and have styles at the same levels up to 24. **Server code:** Chant of the Charge is Battlesongs 14 and the stronger damage adds come at 19, 25, 35 and 46, so at 24 all three builds have one, and Hammer first, at 16, the weaker. **Community, unverified:** the rest is Uthgard's and Blackthorn's, none compared here.

## Even songs at 24 in Thidranki

**Server code,** Battlesongs 22, Axe 18, Parry 5:

- **Songs:** Chant of the Battle (damage add 3.4), Song of Travel (speed), Harmonic Song of Rest (health). There's no endurance song, so in a fight `song` plays the damage add ([group-coordination.md](../group-coordination.md)). All instant, 8 s between uses. No power song, so casters aren't helped between fights.
- **Styles:** `fighterStyle` picks by what's in reach, weapon and what just happened ([combat.md](../combat.md)). Reported in RvR: Plague, a taunt that does nothing on a player, 21 times.
- **Weapon:** his template holds axe, small shield and greataxe. Before it, the gear pass took a Bodybender Greataxe at 10.47 over 8.72 for axe and shield. What a two-hander costs in defence hasn't been read from a report.
- **Reached, and no behaviour casts it:** Crippling Shout, Warshriek, Compel Resignation. See below.

## What meleeFight is worth

**Verified,** wolf camp, alternating 4-minute runs at level 20: `meleeFight` against plain swings waiting for the tank's hold, no song.

| Way | Damage per fight second | Avg fight | Tank hold |
|---|---:|---:|---:|
| Plain, waiting | 1.7-2.4 | 34.0, 27.9, 36.0 s | 99-100 % |
| `meleeFight` | 3.2-4.1 | 23.5, 28.4, 28.1 s | 96-100 % |

About twice the damage, with the ranges apart. Styles, joining at once and the song aren't separated. On a real axe in place of the training one (7.2 effective DPS against 1.1) his damage went from 2.5-4.0 to 5.3-8.7.

**His swing is what can take the mob from the tank.** Over 18 hold runs Thorgrim lost the wolf in 11 of 103 fights, and each time to Bragi, because he joins at once whatever the hold, with 0 deaths. Casters weren't targeted in any of them.

## What the reports show

**Verified,** six Midgard RvR rounds at level 24, 46 minutes, to 2026-11-03 21:42:

| Deaths | Damage a minute | Styles landed | Targeted | In melee | `melee:stuck` | `melee:out_of_reach` |
|---|---:|---:|---:|---:|---:|---:|
| 4 | 208 | Plague 21 | 17 % | 38 % | 33 | 25 |

- The fewest deaths of the group, and nearly the tank's damage (232 a minute). He was the only one of the 15 who didn't die in round 9.
- 58 failed approaches, not traced. `rejoinFight` didn't end them: 8 and 7 in round 11.

## An order nobody carries out

**Server code.** `Spellbook.capabilities().cc` counts Crippling Shout (a mezz, range 700, instant, 18 s, 30 s between uses), so `assignCc` can hand Bragi an add, after Hrafna, Sigrid and Ulfgar. The melee list has no `crowdControl`, so in a fight with a fourth add that assignment does nothing, and the blackboard thinks it's under control until `peelAfterMs` runs out.

**Not tried:** `{ ...skald(), react: [crowdControl({ assignedOnly: true })] }` in a character. An instant mezz from a melee at range 700 is what the shout is for, and it needs a run: it stops his swing each time, and range 700 is close for most of an add's life.

## Not supported yet

- **Warshriek** (49 damage, instant, range 700, 15 s between uses, 11 power) and the other shouts: `assist` casts nukes only without `melee`, so a Skald on `meleeFight` never shouts. **Community, unverified:** weapon or shout damage is the class's main choice.
- **Compel Resignation,** an instant 40 % snare for 68 s, for players who run.
