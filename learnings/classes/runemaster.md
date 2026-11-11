# Runemaster

Midgard's rune caster: Darkness (damage), Runecarving (bolts) and Suppression (debuffs, root, later crowd control). For every spell and level on this server run `bun data/class-sheet.ts Runemaster`; for what a build reaches, `bun sdk/classes/reach.ts Runemaster "Darkness nuker"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/runemaster.ts`:

```typescript
import { runemaster } from '../../sdk/classes/runemaster';
export default runemaster();                       // the Darkness nuker
// runemaster({ lines: ['Runecarving', 'Runes of Destruction'] })   // a Runecarving build
```

- **Role nuker.** Its fight is the Spiritmaster kit's (`steppingAssist`, then `nukeInReach`: [spiritmaster.md](spiritmaster.md)) and Quickcast under fire, the Cabalist kit's. A Runemaster has Quickcast once promoted (a Mystic doesn't).
- **What is its own: which lines it nukes from.** Each of the three behaviours gets a view of the Spellbook (`onlyLines`) that sees damage spells only from the build's lines, `Darkness` and `Runes of Darkness` by default. Debuffs, buffs and the root stay as they are. The member's own book is untouched.

**Verified, arena rounds 130-187 (2026-11-10/11, Gudrun, 21 rounds with the kit):** 0-4261 damage a round, about 1500 on average and over 2000 in 7 rounds, with up to 37 nukes (Rune of Obscurity); the group's best damage in rounds 144, 150, 161 and 167. Before the kit (rounds 122-123, the generic nuker list) she dealt 881 and 68 and walked 54-77 % of the fight; with it 13-58 %. Her idle time is mostly "focus out of reach, holding ground" (5-36 %), as Hrafna's; round 142's 83 % came from a role focus behind their line, which the group's `roleNukerReach` (a role focus within 1500 of a nuker) addressed from round 143.

**Verified, the whole night (rounds 126-225, 37 of Midgard's 65 rounds, from `groups/midgard/runs/*.md`):**
- **Arena:** 15 rounds won of 37 (vs Camelot 7/14, vs Hibernia 8/23). Damage 0-4261 a round, on average 1823 in won rounds and 1481 in lost ones.
- **Since round 189:** 666-4075 a round, 2000 or more in 7 of 15 rounds. She was the group's top damage in most of them, e.g. 3803 in round 216 and 4075 in round 222.
- **Nukes:** a median of 9 a round (0-37). Quickcast under fire fired in 19 rounds.
- **Failed nukes:** `out_of_range` 52, `not_visible` 44 (in 9 rounds: line of sight over hills), `crowd_controlled` 40, `interrupted` 29, `no_power` 2.
- **Idle:** median 18 % of fight time. The reason named was "focus out of reach, holding ground" in 25 rounds and "nothing to do" in 5.
- **Deaths:** she died in 21 rounds and was the first of the group to die in 3. Targeted median 14 % of fight time (50 % or more in 1 round), the least of the group.

## Why the lines

**Server code:**
- A Runemaster gets every baseline spell up to its level, spec or not (`Specialization.cs`), so at Darkness 24 she also holds Runecarving's Greater Runebolt (22) and Symbol of Destruction (23).
- A spell's lowest damage roll depends on her spec in its line against the target's level (`SpellHandler.CalculateLowerVarianceBound`). At spec 1 against a level-24 player that is the floor of about 21 %, so the average is about 60 %: Greater Runebolt about 69 of its 115, Symbol about 51 of its 85. At Darkness 24 the floor is about 98 %.
- A focus staff cuts a spell's cost by her spec over the spell's level only, so an off-spec spell always costs 120 %.

**What the Spellbook would pick** (a test holds both): by spell level (`best`), Symbol of Destruction and Rune of Obscurity tie at 23 and the first listed wins, which is the Runecarving line (the server lists her lines Darkness, Suppression, Runecarving, Runes of Darkness). With the pack's `strongestNuke`, Greater Runebolt (115 on paper). On her lines both picks are Rune of Obscurity: 108, 2.8 s, 14 power, range 1500.

**The live line names** are the DB's `spellline.Name`, which the server sends (`PacketLib1112`): `Darkness` (baseline) and `Runes of Darkness` (spec). `reach.ts` prints the spec name for both.

## Spells at Darkness 24

**Data,** damage worth casting (Runecarving and Suppression at 1):

| Spell | Line | Damage | Cast | Power | Notes |
|---|---|---|---|---|---|
| Rune of Obscurity | Runes of Darkness 23 | 108 | 2.8 s | 14 | the kit's nuke |
| Greater Rune of Murk | Runes of Darkness 17 | 81 | 2.8 s | 10 | a little more damage per power |
| Greater Raven Bolt | Runes of Darkness 22 | 79 | 3 s | 13 | −10 % cold resist for 60 s, 20 s timer |
| Raven Horde | Runes of Darkness 19 | 56, radius 350 | 3 s | 15 | area: never cast (breaks mezz) |
| Murk Blast | Darkness 20 | 73 | 2.6 s | 12 | |

- **Bolts (Server code, `BoltSpellHandler.cs`):** half the damage against resists, half against armour; a block or a guard leaves only the magic half; 850 units/s in flight; hit chance −20 % per melee on the target.
- **Crowd control: only Suppress Movement** (a root, 2.5 s, 31 s), which breaks on damage. Mezz, confusion and nearsight need Suppression points she hasn't got. `capabilities.cc` is true for the root, so the pack may order her on an enemy healer; Midgard's nuker list has no `crowdControl`, so she never casts it.
- Instant debuffs: Quell Strength (about −17) and Field of Darkness (about −30), 60 s.
- Buffs: Rune of Pain (damage add, range 1000), Suppressive Barrier (her own armour), Mark of Movement (group speed +31 %, range 2000), none used in a fight.

## Open

- **`pickNuke` by expected damage** would fix this for every list caster (Hrafna holds off-spec Suppression baselines too). That is shared code (`sdk/group/spells.ts`); the kit's line filter is the local answer.
- **Greater Raven Bolt as an opener** on a fresh player focus: it gives up about 20 damage against Rune of Obscurity, and each later cold nuke on that target gains about 11. Measure before keeping it.
- **A root on a diver** (Suppress Movement on a free melee closing on our healer, not the focus): written nowhere yet.
- **Her idle is the focus out of reach** (25 of 37 rounds), and `out_of_range` is her most common failure. The step toward a focus is the Spiritmaster kit's (`steppingAssist`, step 250); the group's `roleNukerReach` 1500 (groups/midgard/plan.ts) keeps a role focus near her. Whether a longer step or a role focus nearer than 1500 gets more nukes out is unmeasured.
- **Line of sight:** 44 casts refused "not visible" over the night, the second-largest cost. `castSpell` steps toward the target until it sees it (CLAUDE.md "You can't see your target from here!"); a slot that sees the focus over the hills is the group's (`formation` in groups/midgard/rvr.ts).
- Settled: power. She ran out twice in 37 rounds, so power is no limit at Darkness 24 in rounds of up to 10 minutes. About 150-170 before items (formula, PIE estimated); a Darkness focus staff of 23 or more cuts Rune of Obscurity to about 11.
