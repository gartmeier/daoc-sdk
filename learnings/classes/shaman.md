# Shaman

Midgard's second healer and spec buffer: Augmentation's stat buffs, Mending's heals, Subterranean's DoTs and roots. For every spell, level and cost on this server run `bun data/class-sheet.ts Shaman`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Shaman "Buffer healer"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/shaman.ts` is a healer that casts on the focus when it has nothing to heal:

```typescript
import { shaman } from '../../sdk/classes/shaman';
export default shaman();
```

- **Why:** the healer's list has no `assist`, so a Shaman deals nothing. Midgard's strategy gives Ulfgar one in PvE (`memberBehaviors`), with `holdMs` 2.5 s beside Hrafna's: 18 runs measured the hold, with no caster targeted ([spiritmaster.md](spiritmaster.md)). Its RvR strategy has no such entry: Ulfgar dealt 0 damage in 46 minutes, with "nothing to do" as his idle reason 362 times.
- **In RvR** Ulfgar plays it through `bots/ulfgar/character.ts`: round 4 (2026-11-09) he cast 9 nukes, first one 2.2 s into a fight, and was idle 6 % ("no power").
- **Disease first (2026-11-09, after round 4):** the fight is `[disease(), assist()]`. `disease` casts Infectious Spores (3 s, range 1500, 10 power, 90 s) on the focus when it is a free enemy player in range and his last one there hasn't run out (a resist or a failed cast tries again 6 s later). A diseased target gets half the healing, which is what a kill on a player needs against a healer. It reports as `nuke`, and skips while an enemy player is in melee on him (`unlessHammered` in healer.ts). Heals stay above it. **Round 6 (2026-11-09, vs Camelot, 8 kills / 5 deaths):** 19 `nuke` actions, Spores among them (one resisted), first cast 0.1-11.6 s into a fight; 7 heals and 3 nukes interrupted. **Round 8 (vs Camelot, won 5 / 0):** 8 nukes, Spores resisted once; his first cast came 14.8-26.8 s into a fight, with 44 % of fight time walking: positioning, not the kit. **Round 25 (vs Hibernia, lost 6 / 8):** 0 damage, 1 nuke, 10 heals, 2 deaths; 3 heals refused under crowd control and 3 interrupted. With Sigrid controlled he was the healer. **Rounds 29 and 31:** damage 6 and 0; in round 31 (won by wipe 5 / 1) he had a melee on him 30 % of the fight and died, and every spell of his has a cast time, so under the swings `disease`, `assist` and `heal` all skip. Nothing instant to give him at Buffer healer 24; where he stands is the group's.

**Cave nuker instead? (weighed 2026-11-10, after round 41; not done):** at 24 (Mending 1, Augmentation 13, Subterranean 20) it adds Fungal Thistle, a 114 bolt with a 20 s timer, about 600 a two-minute fight. The DoT is the same. It costs str/con 37 to 30 and dex/qui 31 to 27 on the melee, Frigg's Medicant, and Mending 14 to 1: his real heals and his rez. He is the group's second healer when Sigrid is mezzed or dived (10 heals in round 25, 8 in round 36), so Buffer healer stays. **Round 43 (vs Hibernia, won by wipe 5 / 2):** 17 heals while Sigrid was in melee 52 % and died.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/shaman.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Buffer healer: Subterranean / Mending / Augmentation | Augmentation buffer: Subterranean / Augmentation / Mending | Cave nuker: Mending / Subterranean / Augmentation |
|---|---|---|---|---|
| 10 | 54 | 1 / 1 / 10 | 1 / 10 / 1 | 1 / 9 / 4 |
| 20 | 209 | 1 / 6 / 19 | 1 / 20 / 1 | 1 / 19 / 4 |
| 24 | 299 | 3 / 14 / 19 | 4 / 22 / 8 | 1 / 20 / 13 |
| 30 | 464 | 18 / 14 / 19 | 18 / 22 / 8 | 7 / 25 / 13 |
| 40 | 819 | 27 / 22 / 19 | 27 / 28 / 8 | 7 / 37 / 13 |
| 50 | 1494 | 27 / 28 / 37 | 27 / 46 / 8 | 7 / 41 / 34 |

Ulfgar plays Buffer healer. **Community, unverified:** Uthgard calls Augmentation buffer "pretty standard"; Blackthorn lists Buffer healer's shape first. The Cave nuker needs a `nuker` role, which this kit doesn't set.

**The line is `Subterranean`.** Items and guides call it Cave Magic. `train` once dropped that name without a word, and Ulfgar's Subterranean stayed at 1 ([builds.md](../builds.md)).

## Buffer healer at 24 in Thidranki

**Server code,** Augmentation 19, Mending 14, Subterranean 3:

- **Buffs:** the group's spec buffs are his: Might of the Deep (Str/Con 37, 13 concentration) and Murk's Guide (Dex/Qui 31), Sight of the Deep for Hrafna, and the damage add and shield on the melee. 19 buffs for 138 of about 210 concentration. Sigrid, listed before him, holds the base buffs ([healer.md](healer.md)).
- **Might of the Deep is why it's Augmentation 19:** at 18 he'd have a lower rank. Augmentation 22 (Wisdom of the Deep, Earth Invigoration) is the other build.
- **Heals:** cheapest that covers, up to Major Recovery (136, 3.2 s, 24 power). No instant.
- **Crowd control:** a root, Holding Creepers (2.5 s, range 1500, 43 s), baseline.
- **Rez:** Arrival from Valhalla, 10 % health. Reception from Valhalla, 30 %, is Mending 15, one level on and 15 points; he has 1 left and Augmentation 18 would lose Might of the Deep. So Sigrid should do the rezzing when she can, and nothing makes her.
- **Damage, with the kit:** Fungal Erosion (DoT, 35 every 4 s for 24 s, range 1500, 3 s cast, 12 power), then Fungal Pin (a bolt of 7, 20 s between uses). That DoT is 210 for 12 power against Hrafna's 90 for 14, though at Subterranean 3 its minimum is low ([mentalist.md](mentalist.md)).
- **Reached, and no behaviour casts it:** Fungal Mud, the group heal Group Reparation, the cures, Lesser Earth Invigoration (an endurance buff, which shares the `regen` slot with Frigg's Medicant, so only one of them is kept up).

## What the reports show

**Verified,** six Midgard RvR rounds at level 24, 46 minutes, to 2026-11-03 21:42:

| Deaths | Crowd control | Heals | `heal:crowd_controlled` | `heal:interrupted` | Targeted | In melee | Idle in fights |
|---|---:|---:|---:|---:|---:|---:|---:|
| 6 | 47 | 38 | 34 | 30 | 24 % | 14 % | 23 % |

- 64 of his heals failed against 38 that landed, where Sigrid's were 31 against 36. He stands on the same `combatRange`.
- `rez: Thorgrim out of reach` came 21 times.


## RvR, as players tell it

**Community, unverified** (research 2026-11-09):

- A group Shaman buffs, debuffs, diseases and support-heals: disease first on enemy healers, the assist train's target and peeling tanks (it cuts their healing and slows them), then DoTs ([Blackthorn](https://blackthorn-daoc.com/wiki/shaman-guide)).
- He heals as cover, not in competition with the main healer, cures disease and poison, and stays alive: a dead Shaman's buffs go with him ([Blackthorn](https://blackthorn-daoc.com/wiki/shaman-guide)). The instant point-blank disease comes at Subterranean 27, beyond 24.

## Status at wrap-up (2026-11-10, after arena round 119)

**Proven:** Buffer healer is the right build here. As the second healer he carried 9-17 heals in rounds Sigrid was dived or controlled (rounds 25, 36, 43, 55, 117). Cave nuker was weighed and rejected (above).

**Open:**
- **Infectious Spores on the focus** (`disease`): cast in most rounds, often resisted; its effect on kill time is unmeasured.
- **His damage** is 0-400 a round. Under a melee (in melee 20-60 % in many losses) every spell of his has a cast time, so `disease`, `assist` and `heal` all skip. Where he stands is the group's.

## Not supported yet

- **Area disease:** at Subterranean 27 Mold Cloud, the instant area disease every level 50 spec stops for (**community, unverified**).
- **Group heals** and **cures,** as for the Healer ([healer.md](healer.md)).
- **Who rezzes:** `rez` runs in every list and the first to act does it, whatever it restores.
