# Bard

Hibernia's support: mezz and damage shouts from Music, songs and base buffs from Nurture, backup heals and a rez from Regrowth. For every spell, level and cost on this server run `bun data/class-sheet.ts Bard`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Bard "Nurture support"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/bard.ts` is the `support` role with one addition, `cureMezz` as `react` (2026-11-09, arena round 5 onwards; tested in `sdk/classes/bard.test.ts`):

- **The cure, server code.** Clarifying Harmonies (Music, baseline, CureMezz, single target, 3 s, range 1500) frees a mezzed member: the healer first, then the tank, then the most hurt (`mezzedMember`). It is Hibernia's only mezz cure. Arena rounds 2-3 had Brigid, Niamh and Oisin himself report "You can't cast while mesmerized!".
- **Where it goes:** `urgent` (Character.urgent, f4135fd): in the pack's support list, below `flee` and above `interrupt`, `crowdControl`, `backupHeal`, `confuse` and `song`, so a mezzed healer doesn't wait for those. As `react` (6b7978c, round 5) it sat at `shedLoad` and got only the turns they left.
- **interruptOnTheRun** (2026-11-10, from the round after 23): in `instant`, above `flee` (Character.instant, e72ffe8). With a melee on him `flee` takes every turn, so `interrupt` below it never ran; this casts only its instant (Minor Lullaby, range 2300, Amnesia), at the same casters in the same order (`interruptRank`), never walks, and returns false at once without a melee on him, so `flee` and `interrupt` keep their turns.
- **A shout wouldn't reach.** `assist` would cast Concussive Yell (21, instant, range 700, recast 10 s). The pack stands at 1500, so it is still left out.

**Community, unverified:** in small-man fights a Bard pairs with a caster (often a Mentalist) to cover mezz, mezz cure, heals and amnesia between them ([Eden forum](https://eden-daoc.net/viewtopic.php?p=4968)).

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/bard.ts` ([builds.md](../builds.md)). A Bard's spec multiplier is 15, so it has half as many points again as a caster. Levels the rule gives each build, lines in buying order:

| Character level | Points | Nurture support: Music / Regrowth / Nurture / Blades | Music crowd control: Music / Nurture / Regrowth / Blades |
|---|---|---|---|
| 10 | 73 | 1 / 5 / 10 / 1 | 10 / 5 / 1 / 1 |
| 20 | 303 | 10 / 9 / 19 / 1 | 16 / 13 / 9 / 7 |
| 24 | 437 | 10 / 14 / 23 / 1 | 21 / 13 / 9 / 10 |
| 30 | 683 | 10 / 17 / 30 / 1 | 29 / 16 / 9 / 10 |
| 40 | 1213 | 23 / 27 / 33 / 1 | 40 / 23 / 9 / 10 |
| 50 | 2223 | 37 / 33 / 43 / 5 | 47 / 43 / 13 / 10 |

Oisin plays Nurture support. **Community, unverified:** the level 50 numbers come from disorder.dk and Blackthorn's wiki; the level 24 ones are ours, and the two have never been compared in a run.

**Server code: at 24 the role lists don't use what the Music build pays for.** Its mezz is a baseline spell, Mesmerizing Hymn at level 21 whatever Music is, so Music 10 and Music 21 cast the same one. Music 21 buys Captivate Swarms, an area mezz `Spellbook.cc` doesn't take while a single-target one is ready, and Concussive Scream, which the support list has no `assist` to cast. Meanwhile it loses the songs at the top of Nurture, a rank each: speed 159 against 174, endurance 2 against 3, power 1 against 2. Until a behaviour plays area mezzes, Nurture support is the better fit.

## Nurture support at 24 in Thidranki

**Server code,** Music 10, Regrowth 14, Nurture 23:

- **Crowd control:** Mesmerizing Hymn, 2.5 s, range 1500, 42 s. The support list runs `crowdControl()` without `assignedOnly`, so unlike the nukers it mezzes any threat nobody has claimed, without waiting for an order. Captivate Audience, the area mezz at Music 10, never goes off.
- **Songs,** one at a time, chosen by `song`: Clear Road (speed) travelling, Rhythm of Nature (endurance) pulling and fighting, between fights Rhyme of Nature (power) when a caster is under 70 %, Song of Healing when someone is under 80 %. Added damage is the fighting song's fallback and a Bard has none.
- **Heals:** after crowd control in the list, cheapest that covers, up to Regrowth (109). No instant.
- **Rez:** Minor Reconstitution.
- **Buffs:** the group's base buffs, Skin of the Redwood, Redwood's Stoutness, Dexterity of the Badger and Vigor of the Redwood: 11 buffs for 81 concentration. Charisma 89 and the template's 36 make a pool of about 210 by the Druid's formula ([druid.md](druid.md)), so it fits.
- **No acuity:** a Bard's Nurture has none, and the group's nukers go without ([druid.md](druid.md)).
- **Reached, and no behaviour casts it:** Concussive Yell (21 damage, instant, range 700, recast 10 s), Lullaby, Befuddling Cadence, the cures, the group heal.

## The instrument

A song needs an instrument out (`SpellHandler.cs` `CheckInstrument`), and `bot.takeMeleeSlot`, the SDK's weapon switch, only takes melee weapons in hand. Oisin wears Bard Initiate Lute, the gift of his promotion. The gear template's club would put it away, so `gear-template.ts` takes the lute off and puts it on again last ([gear-template.md](../gear-template.md)). Hibernia's `keepItems` protects `Initiate|Lute|Drum|Flute` from `shedLoad`.

## Weight

**Verified.** Oisin is the group's worst carrier. On 2026-10-31 he stood at 90/70 with a speed of 34 against 191, and the whole group waited for him at each leg until he sold his bags. After the level-24 template he was at 97 %, the heaviest of all 15. A Bard that's left full costs every member.

## What the reports show

**Verified,** three Hibernian RvR rounds at level 24, 33 minutes, to 2026-11-03 21:17:

| Deaths | Crowd control | Heals | Songs | `cc:crowd_controlled` | `cc:interrupted` | Targeted | In melee | Moving in fights |
|---|---|---|---|---|---|---|---|---|
| 5, to players | 82 | 22 | 7 | 22 | 13 | 15 % | 18 % | 18 % |

- **He's the group's mezzer.** 82 against Brigid's 39 and Niamh's 22. 22 more were refused because he was mezzed himself: "You can't cast while mesmerized!"
- **The speed song works:** the group patrolled 12,000 units in a minute on it (run 084211). Its worth in RvR is getting there first or getting away, and `song` plays it in `retreat` too.
- **`songs.holdMs` is 30 s** because the coordinator's idle and travel once swapped every 20 s, and he re-cast his song each time.
- **Mezzes under way count as control now.** Of 30 retreat orders in one PvE campaign, 20 came from counting adds whose mezz was still being cast.

## Not supported yet

What the class has that no behaviour uses:

- **Area mezz:** Captivate Audience (radius 350) and up. On a player, its duration falls to half at the edge of the area (`SpellHandler.CalculateEffectDuration`).
- **Shouts:** Concussive Yell and up, direct damage, needing `assist` in a character's list. Short range, and it would compete with mezzes for his turns.
- **Lullaby** (Amnesia, instant, area) and **confusion** (Befuddling Cadence).
- **Weapon styles:** the build leaves Blades at 1 to 40, and he stands at range with a lute. Music crowd control's Blades 10 reaches Glowing Blade, but there's no behaviour that would have him swing.

## Arena rounds, 2026-11-09

**Verified,** rounds 1-4 (Hibernia won all four): Oisin died in every one, was targeted 39-44 % of fight time and in melee reach 24-50 %, and `cc:interrupted` came to 3, 15, 0 and 6. `flee` runs him to the tank, then skips once he is within 150 ("attacked, already at the tank"), and `crowdControl` casts the 2.5 s mezz with the melee still on him. Raised with the orchestrator, whose `crowdControl` that is.

**Verified, arena round 9** (won against Midgard): Oisin cast no mezz, interrupt or cure all round and died twice. The shared `cureMezz` threw "RANGE_MARGIN_3D is not defined" every turn: the arena loads `sdk/group` from the working tree, which held a half-made edit (fixed in 7557f12). As `urgent` it sits above everything, and a behaviour that throws counts as having acted (`member.ts` `step`), so the list started over at it each time. A kit's urgent behaviour is only as safe as the shared code under it; asked the orchestrator for a fall-through on a throw.

**Verified, arena round 12** (against Albion, won 7-0): Oisin survived the round for the first time in the arena, with 8 crowd control, 14 interrupts and 3 cure attempts (2 interrupted, 1 while mezzed himself). Rounds 10 and 12 had the orchestrator's f4135fd (no cast into a melee swing, step away) and ebf2fd2 (interrupt casters on our healer or support first) besides the kit's cure.

**Arena round 21** (wiped 0-5 by Camelot, 99 s): 4 s after the engage Oisin, Niamh and Brigid were mezzed at once by an area mezz, and Oisin died mezzed 8 s later. The kit's cure can't help when the Bard is the one mezzed, and `interrupt()` runs only in the engage phase, so his instant Minor Lullaby (range 2300) can't cut a cast begun during the stalk. Asked the orchestrator to let it run earlier.

**Verified, arena round 23** (wiped Midgard 5-1, no Bard death): 11 mezz cures, 13 interrupts, 4 mezzes. The first round with the cure high in his list (urgent), the earlier interrupt (before the engage) and Midgard's Sigrid as the group's focus.

**Verified, arena round 28** (beat Camelot 9-0, no deaths): 21 interrupts, his most yet, and 7 mezzes; the first round with `interruptOnTheRun` in the instant slot (the report counts both kinds as `interrupt`).

**Arena rounds 43-51** (lost 43, 47, 49, 51): Oisin died first and early in every loss (11-24 s), and with him the group's only mezz cure. Round 51: Brigid was mezzed 9 s after his death and cast 3 heals in a 126 s fight. His `flee` brings him to the tank, inside Guard's 256, and the Hero's Guard sits on Brigid at range: suggested to the group session to guard Oisin in RvR.

**Arena round 53** (wiped 1-5 by Midgard, Oisin dead first again, with the Hero now guarding him): 4 `cure:interrupted`. From the next round his `cureMezz` is wrapped in the Midgard Healer kit's `unlessHammered`: no 3 s cure under a melee swing, so `flee` and `interruptOnTheRun` take those turns.

**Arena round 73** (beat Midgard 4-0): 5 of 8 mezz cures interrupted with only the melee guard; spells interrupt too. From the next round the cure also waits while any enemy aims at him (the Druid kit's `unlessAimedAt`). Watch the cure count: he is aimed at about half of each fight, so this trades attempts for ones that finish.

**Verified, arena round 78** (beat Camelot 5-1): with `unlessAimedAt` on the cure, 8 mezz cures and none interrupted (round 73: 5 of 8 interrupted). Fewer attempts were not the cost feared: 8 is his usual count.

## Where the kit stands (arena end, 2026-11-10, round 119)

Hibernia won 51 of the 85 arena rounds it played (Midgard 20, Camelot 14); round 119 a 5-0 wipe of Midgard.

**Proven:** the mezz cure (`cureMezz` in urgent, held under a melee or while anyone aims at him) cures 5-14 a round with almost none interrupted (round 78 on); `interruptOnTheRun` keeps his instant Lullaby going while chased (21-26 interrupts in good rounds); he survives most wins.

**Open:**
- He is still the first death in most losses (dived, 50-90 % in melee reach). Guard on him (group, round 51 on) helped less than hoped; no class tool beyond kiting and instants.
- His mezzes are resisted ~14 % and often interrupted under melee; Captivate Audience (area) and Lullaby (area amnesia) are unused.
- Confuse (shared `confuse()`) wastes turns on must_wait and interrupts.
