# Bonedancer

Midgard's pet caster: a commander from Bone Army with minions under it, instant lifedrains from Suppression, a direct-damage nuke and a dexterity debuff from Darkness. For every spell, level and cost on this server run `bun data/class-sheet.ts Bonedancer`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Bonedancer "Suppression lifetap"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/bonedancer.ts` is a `nuker` (2026-11-12, night stint R8). Written offline from the data and [pets.md](../pets.md); the live check is below.

- **The commander is the group's.** Summon Bone Boss (1) and Summon Bone Chieftan (15) are `SummonCommander`, a window pet, so `withPets` puts `summonPet`, `petControl`, `petHeal` (Bones to Iron, Rigid, Adamant, Thicken, Build Bones: Pet-target heals) and `petBuff` (the Hasten, Strengthen and Bone Spurs lines, Pet-target) in its list by itself. **Server code.**
- **The minion is the kit's.** `SummonMinion` is no kind `withPets` knows, so `summonMinion` (in `chores`, below the fight) raises one between fights: a commander up, room under it (`minionRoom`: one from 15, two from 30, three from 45, `CommanderPet.cs:84-102`), nothing hostile within 2500 (a 6 s cast), 40 % power (a summon is 20 %, 24 % with no focus item). Which one, `minionPick`: `damage` (the default) takes a caster (Bonemage, Bonecaster, Bonejinxer: Darkness), then an archer (Bone Dart, Bone Arrow: Bone Army), then a melee one, then a healer; `heal` takes a Bonepatcher or Bonefixer (Suppression) first. "already has as many followers" holds it until the commander is a new one. A minion goes with its commander ([pets.md](../pets.md#death-and-loss)), so after a commander's death the next quiet phase raises both.
- **The nukes are `assist`'s.** Every build at 24 has an instant lifedrain from Suppression (Crunch Skeleton at 22, Crumple at 17, Crush at 9), which `assist` picks under fire by itself (`nukeUnderFire`); out of fire the top spell: Murk Blast (73, 2.6 s) or the lifedrain, by level. The four drains share one 4 s recast ([pets.md](../pets.md#who-has-what)).
- **Under a melee** with the drain on its recast, `giveGroundUnlessInstant` steps round the tank as the Theurgist does ([theurgist.md](theurgist.md)); Quickcast (`quickcastUnderFire`) is in the instant slot as for the Spiritmaster.
- Options: `bonedancer({ minion: 'heal' })`, `{ minion: false }`, `{ saveBelow: 30 }`.

Not in the kit: Lessen Movement (a 99 % snare, 9 s) makes the Bonedancer a `root` for crowd control by its capabilities, which the group may assign. Armor of Bone (Bladeturn, Self) and the Magic Shield line are `buff`'s.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/bonedancer.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Suppression lifetap: Suppression / Darkness / Bone Army | Bone Army: Bone Army / Suppression / Darkness | Split Darkness and Suppression: Darkness / Suppression / Bone Army |
|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 9 / 4 / 1 | 1 / 10 / 1 |
| 20 | 209 | 20 / 1 / 1 | 19 / 4 / 1 | 8 / 18 / 1 |
| 24 | 299 | 22 / 9 / 2 | 22 / 9 / 2 | 15 / 18 / 4 |
| 30 | 464 | 28 / 9 / 2 | 28 / 9 / 2 | 23 / 18 / 4 |
| 40 | 819 | 38 / 9 / 2 | 38 / 9 / 2 | 28 / 28 / 4 |
| 50 | 1494 | 47 / 26 / 5 | 48 / 24 / 6 | 38 / 38 / 5 |

At 24 the minion each build gets: Suppression lifetap a Suppression one (Bone Patroller 15, Bonepatcher 18, Bone Sentry 21), Bone Army Bone Arrow (21), Split a Bonemage (Darkness 15) or a Bonepatcher.

## What pets.md already measured

From [pets.md](../pets.md), at L20: the commander takes about 59 s on a L17, 25 s with Bone Dart on a L15; it hits 60-105 on its first swing, then about every 4 s unhasted, and styles ("You perform your Havoc perfectly!"). Bone Dart stands by us and shoots from about 1700, its first hit 65 % off a L7 crab. A L19 commander hit cloth for 104-139 in Thidranki. Melee is no answer: a Bonedancer's branch hits for 1-2.

## Live check

**2026-11-12, 19:11-19:29, three solo sorties in Thidranki** (Grimhild, L24, Split Darkness and Suppression, a one-member squad `groups/r8-grimhild`): one fight in three, against the Necromancer's servant, lost in 27 s: 5 casts interrupted, one Quickcast, her commander 266 damage. Solo she has no haven for `giveGround`, so she stood and cast into the servant's swings.
- **`summonMinion` works:** a Bonemage (Darkness 15) after every Chieftan, between fights, with no "as many followers" loop.
- Once the commander was released and raised again while travelling: "You release control of your controlled target", then a new Chieftan. That is `pets.ts`'s re-summon of a pet left behind (`leftBehind`, 3500 or out of view), not the kit.

## Not seen live

- A fight against players in a group, and the minion in it: whether a caster minion draws them, whether a healer minion keeps the commander up.
- `giveGroundUnlessInstant`: it gives ground only while the drain recasts, 4 s.
