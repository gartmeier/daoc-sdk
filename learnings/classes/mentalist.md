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

const kit = mentalist();
export default { ...kit.character, fight: [assist({ holdMs: 1500 })] };
```

**`stunCaster` (2026-11-09, from arena round 6; `sdk/classes/mentalist.test.ts`).** The kit's `react` throws Prismatic Flash (Light 22 at 24: stun, 2.5 s cast, range 1500, 9 power, 5 s) at an enemy player seen casting in the last 2.5 s: first one whose spell is on our support or healer (`Contact.target` with `targetBySpell`), then one on any member, then a casting healer of theirs, the nearest of each, not crowd-controlled and not stun-immune by the board. In the pack's nuker list it sits above `assist`.

- **Why, verified:** arena round 5 against Albion (Paladin, Cleric, Sorcerer, Cabalist, Theurgist), two wipes, Oisin dead first at 17 s and 36 s under their casters; the user asked for much more interrupting of casters.
- **Server code:** a stun ends the target's cast at once (`OnHardCCStart`: `StopCurrentSpellcast`). A player then takes no stun for 60 s from its end (`immunity_timer_flat_length`), so the kit marks the board's stun immunity, not crowd control: marked as cc, `assist` and the Hero would leave the focus while it lasts (`ccHolds`).
- **Range, verified, arena round 9:** her one Flash failed `stun:out_of_range`. The kit measured the board's ground-plane positions; the server measures in 3D. It now goes by our view's 3D distance with a 60-unit margin, and tries the next candidate when one is out of view.
- **Below 15 % power** she keeps it for nukes. Cuchulainn's style stuns share the same immunity and don't mark the board: a Flash on a target he stunned answers "immune" and is marked then.

- `character` only sets the role to `nuker`. The role's list already casts the nukes, buffs, mezzes and emergency heals from whatever the bot knows, so the kit adds no behaviour of its own yet.
- Spec points aren't in the kit: they are the character's own `bots/<bot>/build.ts`.

## Builds

A character's `bots/<bot>/build.ts` starts as a copy from the catalogue in `data/builds/mentalist.ts`, and one buying rule spends it: [builds.md](../builds.md) says how to choose, change and check one. The catalogue's `why` and `order` say which spells each number reaches. A respec is free, so a character can level on Mana and move to Light nuker later.

Levels the rule gives each build (`buildPath`), lines in buying order, as a level dings and before its half level:

| Character level | Points | Light nuker: Light / Mentalism / Mana | Mentalism healer: Mentalism / Mana / Light | Mana levelling: Mana / Mentalism / Light |
|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 9 / 4 / 1 | 10 / 1 / 1 |
| 20 | 209 | 20 / 1 / 1 | 19 / 4 / 1 | 20 / 1 / 1 |
| 24 | 299 | 22 / 9 / 1 | 23 / 5 / 1 | 24 / 1 / 1 |
| 30 | 464 | 28 / 9 / 1 | 29 / 5 / 1 | 30 / 1 / 1 |
| 40 | 819 | 35 / 19 / 1 | 39 / 5 / 1 | 40 / 1 / 1 |
| 50 | 1494 | 45 / 28 / 10 | 50 / 20 / 4 | 48 / 24 / 5 |

- **The mezz waits its turn.** A line at character level takes every point, so Light nuker has only Enfeeble Mind, the first mezz, until level 23, and Mana levelling until 40.5. A mezz sooner takes a target of its own: `{ level: 20, specs: { Mana: 19, Mentalism: 6 } }` then `{ level: 24, specs: { Mana: 23, Mentalism: 6 } }` buys the Mana spec measured below, with Empowering Tranquility at 25 instead of 24.
- **Mentalism healer banks points** while Mentalism runs a level or two under character level: 26 at level 40.

**Community, unverified:**

- Full Mana is the usual levelling advice: strong power regen buffs, cheap DoTs, AoE DoTs for farming.
- 46 Light / 28 Mentalism / 4 Mana is the usual RvR split at 50, with Light's direct damage and Mentalism's crowd control. Mana DoTs are called weak in endgame RvR, and an AoE DoT can break a mezz.
- Lurikeen is the suggested race, for its Dexterity. Sources also list Shar, which can't be created here ([classes-and-races.md](../classes-and-races.md)).

**Server code,** why the builds at 50 leave that advice:

- **Light nuker is 45 / 28 / 10, not 46 / 28 / 4.** Light has no spell above 45, so the 46th level buys no spell. It does raise the damage floor: against a level 50 target 92.8 % instead of 91.2 % (SpellHandler.cs:2748-2763). Its 46 points buy Mana 4 to 10 for 45 (Lesser Mind Fade, Mind Fade, Curative Trance), leaving 1 of the 1494. Whether that trade is worth it is **untested**.
- **Mana levelling is 48 / 24 / 5, not full Mana.** It is full Mana up to 40. Mana has no spell above 48, so the half levels go to Mentalism 24 (Paralyze Mind at 23, Eccentricity at 24) and Light 5.

**Server code,** what each line gives:

- **Mana Magic:** the regen buff at 4, 14, 24, 34, 44; a heal over time at 10, 21; AoE DoTs at 17, 23.
- **Mentalism:** mesmerize at 1, 5, 10, 15, 23, 31, 41, 50; confusion at 3, 8, 12, 17, 24, 32, 40, 49; a mezz cure at 28.
- **Light Magic:** stronger direct damage, AoE damage and charm at 4, 10, 17, 25, 33, 42.
- Baseline spells follow the character's level, not the line (**verified:** Sun Ray at Light 1, level 20). A low line still weakens them: the lower bound of spell damage depends on line level against the target's level.

## Power

- **Server code:** regen is `2.5 + level x 0.2 + buff` per tick, about every 5 s, cut to a whole number. List casters get half below 50 % power (`PowerRegenerationAmountCalculator.cs`).
- **Verified:** at level 20, a caster below 50 % power went from 3 to 4 per tick with Empowering Harmony (Mana 14). By the formula, the first rank (+1) gives that caster nothing: `(6.5 + 1) / 2` still rounds down to 3.

## Measured: Mana or Light at level 20, in a group

Does a Mana spec help a group more than a Light one? Not in XP, so far. Level-20 hunts of the five-member Hibernia group on a disposable server, with clones reset before every run and only the Mentalist's spec changing. Nobody died in any run and the tank held every mob.

These are the specs the hunts ran, and neither is a catalogue build. At level 20 Light nuker is Light 20 / Mentalism 1 / Mana 1 and Mana levelling is Mana 20 / Mentalism 1 / Light 1. Both specs below had Cripple Mind (Mentalism 5), which those two don't, so this table doesn't measure them.

| 15 min hunt | XP per hour | Kills | Mentalist dealt | Group dealt | Group waited on Mentalist's power | Group waited on Enchanter's power |
|---|---|---|---|---|---|---|
| Light 17 / Mana 6 / Mentalism 8 | 23.4M | 16 | 3124 | 8899 | 6 % | 50 % |
| Light 17 / Mana 6 / Mentalism 8 | 20.8M | 16 | 3404 | 9183 | 3 % | 54 % |
| Mana 19 / Mentalism 6 / Light 1 | 22.7M | 18 | 2688 | 9712 | 2 % | 51 % |
| Mana 19 / Mentalism 6 / Light 1 | 21.7M | 18 | 3029 | 9993 | 9 % | 44 % |

- XP per hour is level: about 22.1M against 22.2M. Six 6-minute hunts of these specs were noisier (17.5M to 25.2M) and pointed the same way.
- The Mana spec's own damage is about 13 % lower. The group dealt about 8 % more and killed two more mobs per hunt, which earned no more XP. Two runs each can't separate that from which mobs were nearby.
- Waiting on the Mentalist's power is not what slows this group at level 20: about half the waits are on the Enchanter's. Half of each hunt goes to recovering in either spec.
- Holding back direct damage below 50 % power was tried and dropped: it showed no gain in two 6-minute hunts.

So choose by what the character will do, and don't expect a respec to change XP at this level. Levels above 20, solo play and RvR are **untested**.

## Not supported yet

No group behaviour uses charm or confusion, so neither is reachable through the kit yet. The sources call confusion useful on big pulls (**community, unverified**).

## Sources

Summarized in our own words: [Camelot Herald wiki: Mentalist](https://camelotherald.fandom.com/wiki/Mentalist) (CC-BY-SA) and [disorder.dk Hibernia class guide](https://disorder.dk/daoc/class-guide-hibernia/).

## Arena round 10: offFocus

**Verified,** round 10 (2026-11-09, against Albion: Paladin, Cleric, Sorcerer, Cabalist, Theurgist): wiped in 79 s, 0 kills. Niamh cast 1 nuke and moved 69 % of the fight; her two nukes before that were `out_of_range`. The pack's soft focus was their back line, beyond reach; the casters walked toward it and died en route. Albion's casters fixed the same idling with `offFocus` (Cabalist kit, 6675df9: Morgana, Taliesin and Merlin had idled 39-67 turns on "focus out of reach").

From round 11 the kit's fight is `nukerFight(0, true)` from `sdk/classes/cabalist.ts`: `assist`, then `offFocus`, which nukes the nearest free enemy player in reach (not crowd-controlled, not assigned or claimed for cc, so no mezz is woken) while the focus is out of reach, from where she stands, never into a melee swing. `mentalist({ offFocus: false })` leaves it out.

**Verified, arena round 12** (against Albion, won 7-0, no deaths): Niamh 9 nukes and 1 Prismatic Flash, 1,121 damage, against Ciaran's 26 nukes and 3,460. Her idle turns were 34 of "focus out of reach, holding ground" with `offFocus` in the list behind it: nobody else was in her reach either, so it is where she stands (the pack's fanOut and standStep), not the kit.

**Arena round 13** (2026-11-09, lost 1-4 to Midgard): three of their melee dove Oisin; he died at 11 s kiting (a speed song takes no effect in combat, `SpeedEnhancementSpellHandler.cs:69`), then Brigid at 35 s. Niamh cast no Flash: `stunCaster` took only casters. From round 14 a player swinging at our support or healer (`Contact.target` without `targetBySpell`, `swinging`) ranks first beside a caster on them, and she doesn't start the 2.5 s cast while a melee is on her herself (`hammeredBy`).

**Arena round 15** (wiped Camelot 5-0): Niamh was the one dived, 51 % of the fight in melee reach, 4 nukes. No Flash, as meant: `hammeredBy` holds it. A Mentalist at 24 has no instant spell to answer a melee on herself (Flash 2.5 s, Cripple Mind 3 s, Delirium 3 s), so that is the peel's and the others' crowd control.

**Arena round 18** (wiped 0-5 by Midgard, 171 s): Niamh 11 heals, 10 nukes, 4 cc, no Flash. The role list's `emergencyHeal` (members under 40 %) sits above her kit, so in a long losing fight her turns go to heals first. Midgard ran two healers (17 mezz cures, 12 heals) and our focus moved across four targets; nothing died.

**Verified, arena round 20** (wiped Midgard 5-1, the first win against them since round 9): 5 Prismatic Flashes, 2 of them `stun:out_of_range`, 8 nukes, 1,022 damage. The server checks range at the cast's end, and a melee chasing Oisin walks on during the 2.5 s cast: the margin under the range is now 150 (10 % of it, as `castSpell`'s own walk stops), from 60.

**Verified, arena round 25** (won 8-6 against Midgard): Niamh's best round, 28 nukes, 4 Prismatic Flashes, 3,739 damage, with the Flash above her emergency heals and `offFocus` in her fight.

## Quickcast (from the round after 28)

Niamh has the Quickcast ability (`bun sdk/cli.ts niamh`): the next spell can't be interrupted, at twice its power, then 30 s before the next (`QuickCastAbilityHandler.cs`; Albion class session, 1f05f78). Her kit's `instant` slot, above `flee`: `quickFlash` first, Quickcast and Prismatic Flash on the melee hitting her (`hammeredBy`), not on one stun-immune or crowd-controlled, within range less 150; then the Cabalist kit's `quickcastUnderFire` (her cc assignment, else her nuke on the focus) when the Flash can't go. They share one 31 s timer. Round 15 is why: dived 51 % of the fight with nothing to answer with.

**Verified, arena round 30** (wiped Camelot 5-0): the first round with Quickcast. Niamh used it once (`quickcast` 1) among 3 stuns and 13 nukes, 1,675 damage, never in melee long (0 % of the fight).

**Arena round 35** (wiped Camelot 6-0): Prismatic Flash 18 times out of range, retried at once each time with our view saying in range. From the next round the Hibernian kits back off: after the server's "That target is too far away!" at a target, it reads as out of reach for 10 s, unless our view puts it 200 nearer than when that was said (`viewDistance`, `noteTooFar` in `sdk/classes/mentalist.ts`, shared by the Flash, Quickcast Flash, `dazzle` and `rootDiver`).

**Arena round 39** (beat Midgard 5-1): Niamh the one death, 33 % of the fight in melee reach, 5 nukes, 2 Flashes, no Quickcast. `hammeredBy` (shared) counts enemy players only, so a pet on her (Midgard's spirit warrior) never set off `quickFlash`. From the next round `quickFlash` also takes an enemy pet swinging at her when no player is (`petOnMe`); Ciaran's kit uses the same `quickFlash`.
