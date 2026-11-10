# Warden

Hibernia's hybrid healer: scale armour, a blade and a medium shield, group bladeturns, a pulsing damage add and modest heals. For every spell and level on this server run `bun data/class-sheet.ts Warden`; for what a build reaches, `bun sdk/classes/reach.ts Warden Support`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/warden.ts` is the healer's list with three behaviours of her own (tested in `sdk/classes/warden.test.ts`):

```typescript
import { warden } from '../../sdk/classes/warden';
export default warden();
```

- **`damageAdd`: Nature's Retaliation in a fight.** Nurture 19, instant, no power, a pulsing damage add on every group member within 1500 (3.4 per second of weapon speed, 5 s pulse). The healer's list has no `song()`, so before the kit it was never cast. Plain `song()` wouldn't do either: in a fight it wants armour, endurance, combat heal, then damage (`songs.ts` `wantedSongs`), and she has an endurance chant (Attack Unending), which would win. `damageAdd` is `song()` over her damage chant alone. One pulse of hers at a time: a new one ends the other (`EffectListComponent.cs:404-412`), so her speed chant stays unplayed (the Bard's is faster anyway).
- **`bladeturn`: Nature's Shield put back in a fight.** Nurture 18, 4 s, 12 % of her power, every member within 1250, absorbs one melee hit (between level-24 players it never lets one through: `AttackComponent.cs`). `buff()` keeps it up out of a fight (a Group buff, rank 99 in `buffs.ts`). In a fight the kit recasts it once ours is gone (we can't see the others' effects; ours popping is the best sign theirs did), only while everyone is at 80 % or more, nobody is on her, she has 40 % power, at most once per 20 s.
- **`groupHeal`: Group Revigoration** (the Druid kit's behaviour), 33-41 to every member within 2000, 3 s, 17 power, when four or more each miss most of it.

**To look for:** `damageAdd` and `buff` (Nature's Shield) in her actions in fights, "Nature's Retaliation" in her effects, Group Revigoration among her heals, and her idle share (round 123: 26 %, "nothing to do").

## As the only healer

**Server code.** Her heals are about half a Druid's rate at 24 (heal size 0.25 + (spec−1)/spell level, up to ×1.25: `HealSpellHandler.cs:250-270`; Regrowth 12 +5 from gear):

| | Warden (Aine) | Druid (Brigid) |
|---|---|---|
| Best single heal | Major Regeneration 136 per 3.2 s, 42 health/s | Greater Regrowth 329 per 3.4 s, 97 health/s |
| Group heal, 5 hurt | Group Revigoration ~205 in all | Renewing Conflux 174 each, 870 in all |
| Instant heal | none | Nature's Blessing |

Health per power is about the same (6.8 against 7.4), so she runs dry no sooner, she just heals slower. The line-up picker counts her as a healer, so a line-up can have her alone. Then Hibernia's `rvr.ts` (`ownMakeUp`, `slowHealsOnly`) starts heals earlier: tank 90, others 83, emergency 55, against 80 / 78 / 50. That is a guess, to be measured.

`pickHeal` ranks single heals by the DB's value: Regrowth and Major Regeneration both read 109 there and tie, though Major Regeneration always heals 136 at her spec (open).

## Buffs and what overlaps

- **Concentration:** only her four base buffs (AF, str, con, dex) use it; 210 in all.
- **With a Bard** (Oisin has the same base line): `buffs.ts` gives the base buffs from the support role first, so she buffs herself. Without one, the base buffs fall to her as the healer.
- **With a Druid:** the Druid's spec buffs are other effect groups and stack with hers. The Druid's haste shares group 100 with her Anger of Nature (25 %, self).
- **With an Enchanter:** a damage add of his (group 40) and hers (41) both apply, the bigger in full, the next at half (`WeaponAction.cs:528-570`). Ciaran's Enchantments 1 has none.
- **Speed:** a speed pulse doesn't land on anyone in combat (`SpeedEnhancementSpellHandler.cs:69`).

## Melee

Thidranki Warden Blade and a medium shield, 621 health in scale. Blades 10: Glowing Blade (side, 60 % snare, 14 s) is the one style worth a swing in RvR. No Guard, Protect or Intercept. The kit doesn't melee: her turns are heals.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/warden.ts` ([builds.md](../builds.md)). Aine plays Support: at 24 Nurture 24, Regrowth 12, Blades 10.

## Arena

**Before the kit** (generic healer list): round 121 (2026-11-10) 2 heals, 3 interrupted, died; round 123 6 heals, 9 buffs, idle 26 %, moving 61 %.

**With the kit** (2026-11-10 night): rounds 126 (solo, not grouped), 128 (only healer: 7 heals, idle 37 %, two deaths), 131, 135, 136 (beside the Druid: idle 46-55 %, 4-11 heals, no deaths; won all three). The damage add started and stopped once a fight in 126-135.

## Open

- Not yet played with the kit: the damage add, the bubble in fights, Group Revigoration at four.
- The heal thresholds as the only healer (tank 90, others 83, emergency 55) are unmeasured.
- Major Regeneration over Regrowth for a member missing more than ~110 (`pickHeal` ties them).
- **Verified 2026-11-10 night** (her effects between rounds 139 and 140, `bun sdk/cli.ts aine`): Nature's Shield is up out of a fight, and Nature's Retaliation still pulses. A round's script stops only a pulse it started itself (`song()`'s memory), and every round is a fresh process, so the damage add started in one round runs on into the next; it costs no power. That is why rounds 136 and 139 show no damage-add result: it was already on.
- Glowing Blade on a diver beside her while a Druid carries the heals.

