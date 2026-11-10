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

**Not played.** Bench bot Gudrun, from 2026-11-10. To look for: Rune of Obscurity in her casts (not Symbol of Destruction or Greater Runebolt), her damage against Hrafna's, and her time moving (77 % in round 123 on the generic list, 3.3 s to her first nuke, 68 damage).

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
- Power: about 150-170 before items (formula, PIE estimated). A Darkness focus staff of 23 or more cuts Rune of Obscurity to about 11.
