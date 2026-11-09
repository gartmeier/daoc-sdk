# Druid

Hibernia's main healer: strong heals from Regrowth, the group's spec buffs from Nurture, roots and a pet from Nature. For every spell, level and cost on this server run `bun data/class-sheet.ts Druid`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Druid "Heal druid"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/druid.ts` holds the role, and for a Nature build, its DoTs on the focus:

```typescript
import { druid } from '../../sdk/classes/druid';
export default druid();                        // Heal or Buff druid
export default druid({ dotsAbove: 50 });       // Group or Solo Nature: Wither and up, above 50 % power
```

**`druid()` adds `groupHeal` as `react` (2026-11-09, arena round 5 onwards; `sdk/classes/druid.test.ts`).** **Server code:** `heal` picks the cheapest single heal that covers one member (`pickHeal`), and Major Restoration (190 for 32 power) beats Renewing Conflux (139 for 57) on that, so the group heal was never cast. A Group-target heal with no radius lands on every member within its range (2000) of her, pets too (`SpellHandler.SelectTargets`, GROUP). `groupHeal` casts the best one she can pay for when three or more members there each miss 70 % of what it restores (about 97 of a 700-health member: below 86 %), in a fight, above 25 % power. Options `groupHealMin`, `groupHealAbove`.

**Where it goes:** `urgent` (Character.urgent, f4135fd): in the pack's healer list, below `emergencyHeal` and above `heal`, so with three hurt it is her first heal. It fires only when three or more each miss 70 % of what it restores, so a single hurt member still gets `heal`'s cheapest cover.

**Server code:** a Heal druid at Nature 1 has no damage spell, so `assist` would have nothing to cast.

**`dotsAbove`** is for a Nature build, and nobody runs one. Group Nature at 24 casts Wither (27 a tick for 24 s, 3 s to cast, 9 power). Not played, and 50 is a guess.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/druid.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Heal druid: Regrowth / Nurture / Nature | Buff druid: Nurture / Regrowth / Nature | Group Nature: Nature / Regrowth / Nurture | Solo Nature: Nature / Nurture / Regrowth |
|---|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 10 / 1 / 1 | 9 / 4 / 1 | 10 / 1 / 1 |
| 20 | 209 | 20 / 1 / 1 | 14 / 13 / 1 | 15 / 13 / 1 | 20 / 1 / 1 |
| 24 | 299 | 22 / 9 / 1 | 20 / 13 / 1 | 16 / 15 / 9 | 20 / 11 / 6 |
| 30 | 464 | 28 / 9 / 1 | 26 / 13 / 1 | 16 / 23 / 9 | 27 / 11 / 6 |
| 40 | 819 | 30 / 26 / 1 | 29 / 26 / 1 | 24 / 30 / 9 | 37 / 11 / 6 |
| 50 | 1494 | 35 / 39 / 12 | 42 / 33 / 7 | 36 / 39 / 9 | 48 / 22 / 11 |

Brigid plays Heal druid. No two Druid builds have been compared in a run. **Community, unverified:** the level 50 numbers come from Blackthorn's wiki and disorder.dk; each build's `why` and `sources` in the catalogue say whose they are. No guide covers level 24.

## Heal druid at 24 in Thidranki

**Server code,** Regrowth 22, Nurture 9, Nature 1:

- **Heals:** `pickHeal` takes the cheapest that covers what the target misses, from 6 up to Greater Regrowth (263, 3.4 s, 52 power). Past 263 it takes Nature's Blessing: instant, no power, 55 % of the Druid's own full health, 15 minutes between uses. With her template's 575 health that restores 316.
- **What the heal list never picks:** Nature's Appreciation, because a heal on a timer waits until nothing else covers, and Greater Regrowth covers all its 33 % does. And the group heals: Renewing Conflux (139 on everyone, 3.6 s, 57 power) passes `heal`'s filter but is never the cheapest for one target, since Major Regrowth restores 145 for 25.
- **Crowd control:** a root, Holding Vines (2.5 s, range 1500, 38 s), because she has no mezz. `capabilities().cc` counts it, so the coordinator assigns her adds.
- **Rez:** Lesser Reconstitution, at Regrowth 16. Reconstitution comes at Regrowth 24.
- **Buffs:** the plan gives her Strength of the Thicket and Breeze's Dance on everyone, her own Redwood's Stoutness, Skin of the Redwood and Dexterity of the Badger, and Hunter's Attack on the tank: 14 buffs for 78 concentration.
- **Concentration:** `(level x 8.8 + (Empathy - 50) x 2.8) / 2` (`MaxConcentrationCalculator.cs`). Empathy 89 plus the template's 36 makes 210 at 24, so she has 132 to spare. **Verified:** 51 at level 9.
- **Reached, and no behaviour casts it:** Cure Poison, Cure Disease, Cure Nearsight I, the group heals.
- **The pet at Nature 1:** Call Minor Nature Spirit caps at L7 whatever her level (`GameSummonedPet.cs:34-52`). `summonPet` leaves it from level 15, when that is under half her own (`Spellbook.summon`), so at 24 she keeps no pet and spends no 25 % on one. One still up from a script is ordered as any other (`petControl`).

## The group has no acuity at 24

**Server code.** Both Hibernian nukers ask for `acuity` first (`BUFF_NEEDS`), and nobody in the group can give it. Nature's Sight is Nurture 11 and Brigid has Nurture 9. A Bard's Nurture has no acuity. Midgard's Shaman and Albion's Cleric do give theirs, so Hibernia is the only one of the three groups without it.

It's two levels away, for a spell the role lists don't use:

```typescript
{ level: 24, specs: { Regrowth: 21, Nurture: 11 } },   // 230 + 65 of the 299 points
```

- **It costs** Renewing Conflux (Regrowth 22), never cast. Nature's Blessing stays, at 21, and so does Greater Regrowth's minimum: 0.25 + (spec - 1) / spell level is over the cap of 1.25 at either spec (`HealSpellHandler.cs:253-262`).
- **It buys** Nature's Sight (21 acuity), and Hunter's Blow (haste 10 against 8). That's about 6.5 % more damage on both nukers: spell damage scales with `1 + stat x 0.005` (`SpellHandler.CalculateDamageBase`), which is 1.625 at the template's Intelligence 125 and 1.73 with 21 more. An on-line buff lands at about 1.24 times its value ([enchanter.md](enchanter.md)), which would make it nearer 8 %, and the same stat raises their power.
- **Not played.** It's a change to Brigid's own `build.ts` (`train.ts --respec`, free), and a comparison would show whether the extra damage shows up in kills.

## What the reports show

**Verified,** three Hibernian RvR rounds at level 24, 33 minutes, to 2026-11-03 21:17:

| Deaths | Heals | Crowd control | `heal:interrupted` | `cc:interrupted` | Targeted | In melee | Moving in fights |
|---|---|---|---|---|---|---|---|
| 5, to players | 32 | 39 | 15 | 10 | 20 % | 24 % | 38 % |

- 25 of her casts were interrupted against 71 that landed, and she spends a quarter of the fight in melee range. In PvE it's another life: 0 deaths in the group over 17 hunts on the way to level 20, with the tank holding 97-100 %.
- A root stays through the add's swings at what stands in its reach. It ends when a landed hit breaks it, when the add walks off, or when it lands a spell, and then the blackboard drops it. One PvE hunt was watched for it and no add came, so no measurement separates what her roots are worth.
- The Hibernian strategy puts the Hero's Guard on her (`guard: { guard: 'healer' }`).

## Not supported yet

**The pet is played now** (`sdk/group/pets.ts`, [group-coordination.md](../group-coordination.md)): Call Nature Spirit at Nature 12 (L18 at 24) and Call Major Nature Spirit at 20 are kept up by `summonPet`, follow the focus (`petControl`) and get a heal from `petHeal`, one that covers what the pet misses, at the pet's id, never on a timer, and in a fight only with a quarter of her power left after it. So Group and Solo Nature have their pet; a character can still say no (`pet: false`). Nobody has run them with it in a round, and the table above is from runs with no pet.

What the class has that no behaviour uses:

- **Nature's damage:** the DoTs are for `assist`, which isn't in the healer's list. `druid({ dotsAbove })` adds it for a Nature build.
- **Group heals:** Healing Conflux, Renewing Conflux, and Bith's Benison at Regrowth 23 (instant, 50 %, 20 minutes). A rule would have to count who is hurt.
- **Cures:** poison, disease and nearsight. No behaviour watches for them.
- **Area roots:** Patch of Ivy and up in Nature. `isRoot` wants a single target.

## Arena rounds 13 and 16: rootDiver

**Verified:** both lost to Midgard, whose melee dove our support and healer: round 13 Oisin dead at 11 s, Brigid at 35 s; round 16 a wipe, Brigid 7 heals in 131 s with 2 `out_of_range` and 1 mezzed. She roots only on the coordinator's assignment (`crowdControl({ assignedOnly })`), so nothing rooted a diver.

**From round 17** her kit's `urgent` starts with `rootDiver`: Holding Vines (Nature, 2.5 s, range 1500, 38 s; a root on a player holds half of that by the board, then ends on damage or expiry) on an enemy player swinging at a member who isn't the tank, our support first, then the nearest. Not on the focus (the group's damage would break it), not on one in someone's crowd control or assigned for it, not root-immune (60 s after one, `immunity_timer_flat_length`), by our view's 3D distance with a 60 margin, never with a melee on herself (`hammeredBy`), above 15 % power. A landed root is marked like `crowdControl`'s, so nobody hits it, and `flee` walks the member out of a rooted melee's reach (`rootedOnUs`).

**Server code:** a speed song takes no effect in combat (`SpeedEnhancementSpellHandler.cs:69`), so a dived member can't outrun the melee without it.
