# Bard

Hibernia's support: mezz and damage shouts from Music, songs and base buffs from Nurture, backup heals and a rez from Regrowth. For every spell, level and cost on this server run `bun data/class-sheet.ts Bard`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Bard "Nurture support"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## No kit

There is no `sdk/classes/bard.ts`. `roleForClass` makes a Bard support, the one list that mezzes on its own and plays songs, and Oisin runs on it unchanged. A kit would hold nothing of the class's own.

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
- **Reached, and no behaviour casts it:** Concussive Yell (21 damage, instant, range 700, recast 10 s), Clarifying Harmonies, Lullaby, Befuddling Cadence, the cures, the group heal.

## The instrument

A song needs an instrument out (`SpellHandler.cs` `CheckInstrument`), and the SDK has no weapon switch. Oisin wears Bard Initiate Lute, the gift of his promotion. The gear template's club would put it away, so `gear-template.ts` takes the lute off and puts it on again last ([gear-template.md](../gear-template.md)). Hibernia's `keepItems` protects `Initiate|Lute|Drum|Flute` from `shedLoad`.

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

- **Clarifying Harmonies,** a mezz cure, at level 24. Most members' reports are full of `crowd_controlled` failures, so a cure on a mezzed healer looks worth trying: it has 1500 range and 3 s to cast. Nobody tracks which members are mezzed yet, and he can't cast it mezzed himself.
- **Area mezz:** Captivate Audience (radius 350) and up. On a player, its duration falls to half at the edge of the area (`SpellHandler.CalculateEffectDuration`).
- **Shouts:** Concussive Yell and up, direct damage, needing `assist` in a character's list. Short range, and it would compete with mezzes for his turns.
- **Lullaby** (Amnesia, instant, area) and **confusion** (Befuddling Cadence).
- **Weapon styles:** the build leaves Blades at 1 to 40, and he stands at range with a lute. Music crowd control's Blades 10 reaches Glowing Blade, but there's no behaviour that would have him swing.
