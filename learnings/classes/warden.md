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

- **`damageAdd`: Nature's Retaliation kept on.** Nurture 19, instant, no power, a pulsing damage add on every group member within 1500 (3.4 per second of weapon speed, 5 s pulse). The healer's list has no `song()`, so before the kit it was never cast, and plain `song()` would have played her endurance chant in a fight (`songs.ts` `wantedSongs`). Since round 145 the kit keeps it on in and out of fights and never stops it: it costs nothing, and one pulse of hers at a time means nothing else of hers needs the slot (`EffectListComponent.cs:404-412`). It is cast only once its effect has been missing 12 s, at most once per 15 s: a pulse's effect drops out of her list between pulses, and `song()`, which waits 6 s, took that for stopped and cast it again, and a cast at a running pulse ends it ("You cancel your effect.", twice in round 145's fight). Results report as `damageAdd`.
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

Thidranki Warden Blade and a medium shield, 621 health in scale. Blades 10: Glowing Blade (side, 60 % snare, 14 s) is the one style worth a swing in RvR. No Guard, Protect or Intercept. In a group the kit doesn't melee: her turns are heals.

## On her own: `lastStand` (2026-11-12, R7)

**Why.** hibernia-s1, 19:51 UTC: her Blademaster partner died in a caught fight against an Albion Highlander. With nobody left to heal, the healer list gave her only `flee`'s kite step (no tank to run to: a step straight away). Her heals were skipped while he was on her (`castBlocked`). She walked to the river bank ("held at the bank" eleven times) and died 75 s after him.

**What it does** (the character's `instant` slot, so above `flee` and below the emergency heal, which skips while a melee is on her). Only when no other member of hers is alive within 2000 in her region and an enemy player is targeting her (`onHerOwn`, `attackerOn`, within 1500). `lastStandMove` decides:
- **Not snared, he within 750:** she swings at him with the melee list's `assist`, whatever the squad's focus. The style is `wardenStyle` (`kitStyle` with Glowing Blade as its opener): Glowing Blade first whenever it isn't on him, the best plain swing behind it (Taunting Blade, 116 growth for 10; a taunt's growth is damage).
- **The side step.** Glowing Blade needs his side (45-150° or 210-315° off his heading, `StyleProcessor.cs:97-104`). A melee on her faces her, so while it is due and she stands in front of or behind him, she steps 90 units square to his heading, at most once per 4 s. A bot attacker turns back to face her within about 0.5 s (`actions.ts` attack re-faces past 200 heading units), so the step lands only when her swing falls in that window. A human attacker turns slower.
- **Snared** (read from "You perform your Glowing Blade perfectly!", 14 s):
  - She heals herself (`spells.heal`) once he is 450 off and she is below 70 %. Snared at 40 % speed, he covers about 250 of a 3.2 s heal.
  - Otherwise she fights it out if she is as healthy as he is or he is at 30 % or below.
  - Else she walks a 500 leg away from him, the straightest dry one (straight on, then 45° and 90° either way; `isWet`).
- **A caster on her from range** (beyond 750, not snared): a heal on herself from 800 when hurt; otherwise nothing, and the list goes on.
- `warden({ lastStand: false })` leaves it out.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/warden.ts` ([builds.md](../builds.md)). Aine plays Support: at 24 Nurture 24, Regrowth 12, Blades 10.

## Arena

**Before the kit** (generic healer list): round 121 (2026-11-10) 2 heals, 3 interrupted, died; round 123 6 heals, 9 buffs, idle 26 %, moving 61 %.

**Verified, with the kit** (38 rounds, 126-226, the night of 2026-11-10/11; numbers from `groups/hibernia/runs/*.md`):

- **Line-ups:**
  - The only healer once, in round 128: 7 heals, idle 37 %, won.
  - From 881f449 on, every line-up needs a Druid (the user's rule: Druid and Bard for the spec buffs), so she always played beside Brigid. That is the two healers with one nuker make-up.
- **Hibernia won 21 of the 38** (by wipe or holding the cap): 9 of 17 against Camelot, 12 of 21 against Midgard. That is below the realm's 46 of 74, and two healers with one nuker is the weak make-up (groups/hibernia/lab_log.md, morning report).
- **The formation:** from round 199 the two healers stand apart (`twoHealerFormation` in the private `rvr.ts`). Before that, she and the Bard stood on one spot, and one area mezz took both (round 196). After the change she won 4 of 10, though by then the other realms were stronger too.
- **Heals:**
  - 385 heals, about 10 a round. 84 were interrupted (22 %).
  - Group Revigoration only 5 times: four hurt members within reach is rare beside a Druid.
  - Idle 0-80 % "nothing to do", about 30 % typically.
  - 17 deaths in 38 rounds. She was targeted 12 % of fight time on average, up to 62 % in round 210.
- **The damage add:**
  - Under `song()` it cancelled itself 7 times in rounds 126-145 (`song:pulse_cancelled`).
  - Under the kit's own keeper (d9a79ba), none in rounds 150-226, with 12 casts in all. Mostly it was already pulsing from the round before.
- **Her bladeturn** reports as `buff`, so a report doesn't count it apart.

**Verified 2026-11-10 night** (her effects between rounds 139 and 140, `bun sdk/cli.ts aine`):
- Nature's Shield is up out of a fight, and Nature's Retaliation still pulses.
- A round's script stops only a pulse it started itself (`song()`'s memory), and every round is a fresh process. So a damage add started in one round runs on into the next, and it costs no power.

## Open

- **Two healers with one nuker** is the make-up she plays in, and it is the weakest. Requiring two nukers would bench her, so the picker's mix stands. A line-up with her as the Druid's partner and two nukers needs a fifth class that isn't the Bard, the Druid or a tank, and there is none.
- **The heal thresholds as the only healer** (tank 90, others 83, emergency 55) are still unmeasured. She can't be the only healer while the Druid is required.
- **Major Regeneration over Regrowth** for a member missing more than ~110 (`pickHeal` ties them).
- **Glowing Blade** on a diver beside her while the Druid carries the heals. At idle 30 % she has the time.
- **`lastStand` live, verified 2026-11-12/13** (13 hibernia-s1 sorties, 20:06-05:45 UTC):
  - **It ran in 6 sorties.** Its swing reports as `melee`, so it shows as `Aine: melee: ...` in the sortie logs. Only its heal reports as `lastStand`.
  - **No style of hers landed:** the reports read `styles {}` every time, so Glowing Blade never landed.
  - **Five swings were refused with "X is not in view!"** A melee swing needs the target within 120° in front of her as well as in sight (`WeaponAction.cs:389-392`), and after the side step she faces the spot she walked to.
  - **Three heal tries in 3 s, each `must_wait`,** after an interrupted cast.
  - **Her deaths in those sorties** came with a member still within 2000, or under the squad's `retreat`, which ranks above `lastStand`.
  - **Fixed 2026-11-13 (tests only, live at the next stint):**
    - After the side step she faces him (`bot.face`).
    - A heal refused with `must_wait` counts as none until its seconds are over (`healWaitMs`). Meanwhile the swing or the leg away goes on.
  - **To see at the next stint:** whether "not in view" is gone, and whether Glowing Blade lands against a bot at all.
  - **Still open:** does fighting it out at even health beat getting away?
- **Her bladeturn in fights:** give it a result name of its own (now `buff`), so its recasts can be counted.

