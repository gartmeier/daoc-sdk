# Mentalist

Hibernia's list caster: damage, crowd control, some healing and a power regen buff. For every spell, level and cost on this server run `bun data/class-sheet.ts Mentalist`. This file holds what the data doesn't say.

Three kinds of claim here, marked as such:

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches. Treat it as a hypothesis.

## The kit

`sdk/classes/mentalist.ts` is the starting point. A bot imports it in its own `bots/<bot>/character.ts` and changes what it wants:

```typescript
import { assist } from '../../sdk/group/behaviors';
import { mentalist } from '../../sdk/classes/mentalist';

const kit = mentalist({ build: 'rvr' });
export default { ...kit.character, fight: [assist({ holdMs: 1500 })] };
```

- `character` only sets the role to `nuker`. The role's list already casts the nukes, buffs, mezzes and emergency heals from whatever the bot knows, so the kit adds no behaviour of its own yet.
- `specPlan` holds the weights of the chosen build, for the bot's own training script. Nothing applies it on its own: `bot.trainSpec` spends the points, and `/respec` undoes them ([npc-dialog.md](../npc-dialog.md)).

## Builds

Levels each `MENTALIST_BUILDS` plan gives (`specLevelsAt`):

| Character level | Points | `levelling` Mana / Mentalism | `rvr` Light / Mentalism / Mana |
|---|---|---|---|
| 10 | 54 | 9 / 4 | 8 / 5 / 3 |
| 20 | 209 | 19 / 6 | 17 / 10 / 2 |
| 30 | 464 | 28 / 10 | 25 / 16 / 3 |
| 40 | 819 | 38 / 12 | 33 / 22 / 3 |
| 50 | 1494 | 50 / 20 | 46 / 28 / 4 |

**Community, unverified:**

- Full Mana is the usual levelling advice: strong power regen buffs, cheap DoTs, AoE DoTs for farming.
- 46 Light / 28 Mentalism / 4 Mana is the usual RvR split at 50, with Light's direct damage and Mentalism's crowd control. Mana DoTs are called weak in endgame RvR, and an AoE DoT can break a mezz.
- Lurikeen is the suggested race, for its Dexterity. Sources also list Shar, which can't be created here ([classes-and-races.md](../classes-and-races.md)).

**Server code,** what each line gives:

- **Mana Magic:** the regen buff at 4, 14, 24, 34, 44; a heal over time at 10, 21; AoE DoTs at 17, 23.
- **Mentalism:** mesmerize at 1, 5, 10, 15, 23, 31, 41, 50; confusion at 3, 8, 12, 17, 24, 32, 40, 49; a mezz cure at 28.
- **Light Magic:** stronger direct damage, AoE damage and charm at 4, 10, 17, 25, 33, 42.
- Baseline spells follow the character's level, not the line (**verified:** Sun Ray at Light 1, level 20). A low line still weakens them: the lower bound of spell damage depends on line level against the target's level.

## Power

- **Server code:** regen is `2.5 + level x 0.2 + buff` per tick, about every 5 s, cut to a whole number. List casters get half below 50 % power (`PowerRegenerationAmountCalculator.cs`).
- **Verified:** at level 20, a caster below 50 % power went from 3 to 4 per tick with Empowering Harmony (Mana 14). By the formula, the first rank (+1) gives that caster nothing: `(6.5 + 1) / 2` still rounds down to 3.

## Measured: does the levelling build help a group?

Not in XP, so far. Level-20 hunts of the five-member Hibernia group on a disposable server, with clones reset before every run and only the Mentalist's spec changing. Nobody died in any run and the tank held every mob.

| 15 min hunt | XP per hour | Kills | Mentalist dealt | Group dealt | Group waited on Mentalist's power | Group waited on Enchanter's power |
|---|---|---|---|---|---|---|
| Light 17 / Mana 6 / Mentalism 8 | 23.4M | 16 | 3124 | 8899 | 6 % | 50 % |
| Light 17 / Mana 6 / Mentalism 8 | 20.8M | 16 | 3404 | 9183 | 3 % | 54 % |
| Mana 19 / Mentalism 6 / Light 1 | 22.7M | 18 | 2688 | 9712 | 2 % | 51 % |
| Mana 19 / Mentalism 6 / Light 1 | 21.7M | 18 | 3029 | 9993 | 9 % | 44 % |

- XP per hour is level: about 22.1M against 22.2M. Six 6-minute hunts of these builds were noisier (17.5M to 25.2M) and pointed the same way.
- The levelling build's own damage is about 13 % lower. The group dealt about 8 % more and killed two more mobs per hunt, which earned no more XP. Two runs each can't separate that from which mobs were nearby.
- Waiting on the Mentalist's power is not what slows this group at level 20: about half the waits are on the Enchanter's. Half of each hunt goes to recovering in either build.
- Holding back direct damage below 50 % power was tried and dropped: it showed no gain in two 6-minute hunts.

So choose by what the character will do, and don't expect a respec to change XP at this level. Levels above 20, solo play and RvR are **untested**.

## Not supported yet

No group behaviour uses charm or confusion, so neither is reachable through the kit yet. The sources call confusion useful on big pulls (**community, unverified**).

## Sources

Summarized in our own words: [Camelot Herald wiki: Mentalist](https://camelotherald.fandom.com/wiki/Mentalist) (CC-BY-SA) and [disorder.dk Hibernia class guide](https://disorder.dk/daoc/class-guide-hibernia/).
