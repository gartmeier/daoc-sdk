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

**Arena round 20** (wiped Midgard 5-1): Brigid 19 heals and 16 turns of "heal: not enough power" (dry). `rootDiver` uses the same 150 margin as the Flash from round 21. Watch her power: Renewing Conflux is 57 a cast, and her floor for it is 25 %.

**Verified, arena round 23** (wiped Midgard 5-1): 17 heals, then 20 turns of "heal: not enough power" and 3 `no_power`. Her pool at 24 is 197 power (`bun sdk/cli.ts brigid`), so Greater Regrowth (52) and Renewing Conflux (57) each cost over a quarter of it, and two fights in a row (rounds 20, 23) ran her dry. The RvR heal thresholds (tank 75, others 70) are the group's setting; suggested 65 / 55 to the Hibernia group session.

**Verified, arena round 24** (wiped Camelot 5-0, 104 s fight): 14 heals, then idle 50 % of fight time on "heal: not enough power" (45 turns). Third fight in a row dry. Niamh was idle 42 % on "assist: no power" in the same fight. Suggested to the group session: Oisin's power song (Rhyme of Nature, +2 power a pulse to each member) in a fight, not only between fights.

**Arena round 31** (wiped 1-5 by Midgard, 113 s): `rootDiver` fired 3 times: resisted twice (Norseman, Troll), once out of range; 3 heals. **Server code:** Holding Vines is a SpeedDecrease spell, so the resist is the plain hit roll, 100 - (87.5 + (spell level - target level) / 2) (`SpellHandler.CalculateToHitChance`): a baseline spell from her line, around level 12, on a level-24 player is resisted about 18 % of the time. Two in a row is about 3 %: bad luck, no kit change.

## Nearsight cure (from the round after 40)

**Verified by the orchestrator (13f8de7):** round 35's run of `out_of_range` was Albion's Obscuring Dust (Cabalist, Nearsight, -35 % spell range for 120 s): our 1500-range spells reached 975. Spell ranges now follow our own effects (`effectiveSpellRange`). Brigid has Cure Nearsight I (Regrowth, `CureNearsightCustom`, 6 s, 30 power, range 1500). Her kit's `react` casts it with the Midgard Healer kit's `cureNearsight` (a nuker first, then a healer, a support, the rest; herself too), wrapped in `unlessHammered` and `thrifty(…, 50)`: in the pack's healer list `react` lands at `shedLoad`, so it takes her idle turns; never under a melee, and in a fight only above 40 % of her 197 power, without a skip reason (round 42: `thrifty`'s "saving power" stood as her idle reason 33 turns).

**Verified, arena round 59** (beat Camelot 7-0, no deaths): Brigid's Nearsight cure cast 3 times (1 `cure:out_of_range`), the first round it found Albion's Obscuring Dust on someone.

**Arena round 62** (wiped Camelot 5-1): both Nearsight cures interrupted (6 s each). `unlessHammered` covers only a melee on her; Albion's spells interrupt as well. From the next round the cure also waits while any enemy aims at her (`unlessAimedAt`: a free contact whose target is her, by swing or by spell).

**Arena round 76** (lost 2-8 to Midgard): Brigid survived, idle 57 % of the fights on "nothing to do" (187 turns), while the others died 8 times. `heal` only looks within 2000, so a hurt member beyond that is no work. From the next round `reachHurt` (react, first): in a fight, with nobody in reach to heal, one 3 s leg toward the most hurt member below the heal threshold 2000-3500 away, to 1500 from them; never under a melee. **Distance was not the cause** (the group session's position samples of that fight: from Brigid, Niamh 400-650, Ciaran 490-940, the Hero 1,100-1,900, Oisin 1,400-2,600 and beyond 2000 only 13 s): the group's Midgard heal thresholds were 72 / 68 that round, and Midgard's burst took members from above them to dead in seconds. They are back to 80 / 78 / 50. `reachHurt` stays for the times Oisin runs beyond 2000.

**Arena round 81** (wiped Midgard 5-0): 4 Nearsight cures at 30 power each (120 of her 197), then 34 turns of "heal: not enough power". From the next round the cure waits below 60 % power (was 40) and goes at most once per 20 s (`atMostEvery`).

**Arena round 83** (wiped 0-5 by Midgard, 105 s): with the 60 % / 20 s limits, still 3 Nearsight cures (18 s of casting) against 3 heals. From the next round, in a fight the cure goes only while every member is at 85 % or more (`whileCalm`); out of fights it is free.

**Verified, arena round 85** (lost 2-5 to Midgard, 171 s): with `whileCalm`, no Nearsight cure in the fight and 14 heals (3 in round 83).

## Where the kit stands (arena end, 2026-11-10, round 119)

Hibernia won 51 of the 85 arena rounds it played (Midgard 20, Camelot 14); round 119 a 5-0 wipe of Midgard.

**Proven:** `groupHeal`, `rootDiver`, `reachHurt` and the Nearsight cure run as meant; the cure is now held in a fight unless everyone is at 85 % or more, above 60 % power, once per 20 s, and never while aimed at (rounds 81-85: heals 3 → 14).

**Open:**
- Power: a 197-point pool runs dry in long fights (rounds 20-24, 81, 108); the group's heal thresholds and the Bard's power song are the levers.
- Focused by Midgard (round 87: 9 heals interrupted) she has no instant or uninterruptible heal at 24.
- `groupHeal` firing count is not visible in the reports (it reports as `heal`); `reachHurt` was added on a wrong theory (round 76) and kept for the Bard's runs.
