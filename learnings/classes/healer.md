# Healer

Midgard's main healer: heals from Mending, base buffs from Augmentation, mezz, stun and root from Pacification. For every spell, level and cost on this server run `bun data/class-sheet.ts Healer`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Healer "Mending first"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/healer.ts` holds the role, `healer` (what `roleForClass` gives), and `cureMezz` as `urgent`: Cleanse Mind (baseline Pacification 23, 3 s, range 1500) on a member whose effects show an enemy Mesmerize, the healer first, then the tank, then the most hurt. In the pack's healer list (what the arena runs) it lands below `emergencyHeal` and above `heal` and `crowdControl`: a dying member first, then the mezzed one, then the ordinary heals. In lists with `position` it goes just above it. It went in as `react` first (6b05df7), below every heal; Hibernia's Bard found a cure there waits behind heals all fight, and the losses go to whoever is mezzed first. She is Midgard's only mezz cure: the Shaman has none.

**Halt Attack (2026-11-09, after round 6):** the kit's `fight` is the Cleric kit's `stunPeel` ([cleric.md](cleric.md)): Halt Attack (2.5 s, range 1500, 12 power, 8 s) from where she stands, at an enemy player in melee on one of our soft members (a healer first), else at the enemy healer while our focus is at 60 % or less; never at one under crowd control or immune to stuns, not below 15 % power. It goes below heal and crowd control. **Community, unverified:** a Pacification healer stuns the enemy healer for kill windows ([Blackthorn](https://blackthorn-daoc.com/wiki/healer-guide)).

**Not into a swing:** the cure and the stun both skip while an enemy player is in melee on her (`unlessHammered`, the orchestrator's `hammeredBy`): a swing ends a cast half way, as `heal` and `crowdControl` already skip since f4135fd.

**Server code:** `assist` has no spell to cast, since Mending first has no damage spell. `song` would play Ease of Movement, which the Skald's speed song outdoes in the same group.

**Why the cure (round 4, 2026-11-09, Hibernia 3 kills / Midgard 1):** Bragi "can't cast while mesmerized" and Sigrid sat idle 51 % of fight time with "nothing to do". Over the 2026-11-03 rounds the group took 40 casts refused under a mezz. A human Healer's RvR job is heal, mezz, and cure the mezzed. **Round 6 (2026-11-09, vs Camelot, react version):** 2 cures, 1 `cure:out_of_range` (no approach: the mezzed member was beyond 1500); idle 30 %. **Round 8 (2026-11-09, vs Camelot, won 5 kills / 0 deaths, urgent cure and Halt Attack):** 5 cure attempts, 3 `cure:out_of_range` and 1 interrupted; 1 Halt Attack resisted, 1 out of range. The misses come from `mezzedMember`'s 2D distance against the server's 3D range on Thidranki's hills: asked of the orchestrator, fixed in 7557f12 (3D, 50 inside the range). Idle 16 %, down from 30 % and 51 %.

**Round 9 (2026-11-09, vs Hibernia, lost 4 kills / 7 deaths):** the round loaded the shared behaviors.ts mid-edit, and `cureMezz` threw "RANGE_MARGIN_3D is not defined" on nearly every turn. A member's list takes a throw as a turn spent, with a second's pause (MemberAgent.step), and the cure is above `heal`: Sigrid healed 5 times in 10 minutes. The round is marked tainted in the ledger. Since 83cf629 a member's list leaves a behaviour that throws out for 5 s, with the note, and goes on to the next one in the same turn; a kit guard of its own (f469716) hid the note and is gone again.

**Round 11 (2026-11-09, vs Camelot, 6 kills / 6 deaths, 3D range):** 9 cures, 1 interrupted, none out of range; 1 Halt Attack; 11 heals; idle 20 %.

**Round 13 (vs Hibernia, won 4 kills / 1 death):** Hibernia's melee went for her: targeted 71 %, in melee 36 %, 4 heals and 2 mezzes interrupted, 2 heals landed, and she was the one death. Under the swings everything with a cast time is lost. **Hinder Spirit since then:** `hinder` in `urgent`, after the cure: the instant attack slow (Pacification 2, 16 %, 20 s, 2 power, 5 s timer) at an enemy player or pet in melee on her, else on a soft member (a pet too: the tank's peel leaves pets, and Albion's simulacrum is in every Camelot fight), nearest first, once per its 20 s. In the pack's list `flee` is above it, so at the tank it goes on the others' attackers more than her own. Not measured yet: `debuff` actions in the next Midgard rounds.

**Round 14 (vs Camelot, wiped in 85 s, code before Hinder Spirit):** Camelot mezzed Ulfgar, Bragi and Hrafna and went for her: in melee 44 %, 1 heal landed, 2 mezzes and a cure interrupted, and she died casting Greater Reparation (3.3 s). The first to die in three of the last four rounds she was in.

**Round 16 (vs Hibernia, won by wipe 5 kills / 1 death, Hinder Spirit in):** in melee 2 %, targeted 16 %, 4 cures, 1 stun, 6 heals, no death; no slow cast, with no enemy in melee on her or the casters.

**Round 17 (vs Camelot, won 9 kills / 3 deaths):** 2 stuns, 2 cures (1 out of range), 6 heals, died once. Again no slow, though the report has Ulfgar in melee 30 %: that column may count an enemy in reach, not one swinging at him, which is what `hinder` needs (`onMember`). Watch `debuff` over the next rounds before changing it. She knows Hinder Spirit live (`bun sdk/cli.ts Sigrid`).

**Round 18 (vs Hibernia, won by wipe 5 kills / 0 deaths):** 17 cures (4 interrupted), 2 Hinder Spirits (1 resisted), 4 heals; targeted 27 %, never in melee, idle 4 %. Against Hibernia's mezzers the cure is her main work.

**Round 19 (vs Camelot, won by wipe 5 / 0 in 4 minutes):** 3 cure attempts, all `out_of_range` despite the 3D margin; she was moving 55 % of the fight, so the picture is likely behind her own walk. A miss fails at once, so it costs a turn, not a cast. If it keeps up, the cure could step toward the member (as `crowdControl` does) instead of casting from where she stands.

**Round 23 (vs Hibernia, wiped 1 / 5):** in melee 52 %, targeted 51 %, and no Hinder Spirit: `flee` sits above `urgent` in the pack's list and takes every turn while a melee is on her (circling the tank). Since then the orchestrator's `Character.instant` slot puts it just above `flee`: one slow costs her one turn, and `flee` goes on the next.

**Round 25 (vs Hibernia, lost on the cap 6 / 8, instant slot in):** 3 Hinder Spirits, 10 cures, 3 heals; 2 cures and 2 heals refused while she was crowd-controlled herself. Hibernia's mezzes and amnesia hit every caster (`crowd_controlled` on all four).

**Round 39 (vs Hibernia, wiped 1 / 5):** targeted 55 %, in melee 37 %; 1 heal, 2 cures, 3 Hinder Spirits (2 resisted). Hrafna was in melee 38 % too: Hibernia's melee went through to our casters, which is the group's positioning.

**Round 41 (vs Camelot, wiped 0 / 5):** 5 cures (3 interrupted), 3 Hinder Spirits, 3 heals; in melee 26 %. The group dealt about 2200 in all (Thorgrim 987, Hrafna 632, Bragi 331, Ulfgar 231), against about 6000 in the round 36 win. Midgard has lost rounds 34, 37, 39 and 41 by wipe, as Hibernia and Camelot improved; no kit behaviour failed outright.

**Round 52 (vs Camelot, won by wipe 5 / 1; the group's calmFan):** moving 7 % (62 % in round 50), 15 heals, 4 cures, but idle 31 % with "heal: not enough power" 34 times. Since then her stun and Nearsight cure stop below 40 % power (`EXTRAS_FLOOR`); the mezz cure (6 % of her power) and the slow (2) stay.

**Rounds 54-55 (floor in):** r54 3 heals, power waited 10 %; r55 (won 8 / 2) 13 heals, 14 cures, 3 stuns, no death, and no "not enough power" in her failures.

**Round 63 (vs Hibernia, wiped 0 / 5), effects sampled every 15 s with `bun sdk/cli.ts`:** Hrafna under Mesmerizing Hymn (their Bard's mezz) in 4 samples, about a minute; Sigrid stunned and mezzed herself (Illusory Convulsions, Mesmerizing Hymn), targeted 81 %, in melee 56 %. With Midgard's only mezz cure controlled, nobody frees the others. No Nearsight in a Hibernia round, as expected.

**Round 67 (vs Camelot, lost on the cap 3 / 9; Nearsight cure in urgent):** 3 `nearsight` cures, her first; 2 heals, 3 slows. Hrafna still idle 32 % ("focus out of reach" 74) with 7 nukes: Camelot's casters stand back even at her full range.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/healer.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Mending first: Mending / Augmentation / Pacification | Augmentation healer: Mending / Augmentation / Pacification | Pacification tri-spec: Augmentation / Pacification / Mending | Full Augmentation solo: Augmentation / Mending / Pacification |
|---|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 1 / 10 / 1 | 1 / 9 / 4 | 10 / 1 / 1 |
| 20 | 209 | 20 / 1 / 1 | 7 / 18 / 4 | 1 / 19 / 4 | 20 / 1 / 1 |
| 24 | 299 | 23 / 5 / 4 | 15 / 18 / 4 | 1 / 20 / 13 | 24 / 1 / 1 |
| 30 | 464 | 29 / 5 / 4 | 23 / 18 / 4 | 17 / 20 / 13 | 30 / 1 / 1 |
| 40 | 819 | 39 / 5 / 4 | 35 / 18 / 4 | 19 / 32 / 13 | 40 / 1 / 1 |
| 50 | 1494 | 42 / 33 / 7 | 39 / 37 / 4 | 19 / 38 / 33 | 49 / 22 / 5 |

Sigrid plays Mending first. **Community, unverified:** Blackthorn warns it gives up resists and uses more power; the tri-spec numbers are its too. **Server code:** Augmentation 18 is group haste on this server (Celerity), the reason the tri-specs stop there.

## Mending first at 24 in Thidranki

**Server code,** Mending 23, Augmentation 5, Pacification 4:

- **Heals:** `pickHeal` takes the cheapest that covers, up to Greater Reparation (314, 3.3 s, 62 power), then Boon from Eir: instant, no power, 55 % of her own health, 15 minutes. Template health 609 makes that 335. The percent counts the caster's health, not the target's ([spells.md](../spells.md)), so a Healer with more health heals more.
- **Crowd control:** Sedate, the baseline mezz, 2.5 s, range 1500, 43 s. It comes with the level whatever Pacification is. Allay Area, the area mezz, is Pacification 6, beyond her build and unused by the role lists anyway.
- **Rez:** Reception from Valhalla, 30 % health, at Mending 15. A Shaman at Mending 14 has only the 10 % one ([shaman.md](shaman.md)).
- **Buffs:** she's the group's first healer, so the base buffs are hers: Guardian's Lesser Barrier, Strengthen Health, Evasion and Lesser Power of the Viking, with Purity of Mind and haste, 19 buffs for 106 concentration. Piety 89 and the template's 36 make a pool of about 210 ([druid.md](druid.md)), so it fits. `providerFor` takes the first member of a role, so a group with two healers should list the base-buffer first.
- **Cure Nearsight I** (Mending 20, 6 s, range 1500, 30 power): the kit's `cureNearsight`, in `urgent` after the mezz cure since round 65 (in `react` below heal before, where it never fired: sampled Obscuring Dust on Ulfgar and Hrafna that round, no cure), on a member whose effects show an enemy Nearsight, our nuker first. Since 2026-11-10 (after round 37): Albion's Cabalist casts Obscuring Dust (-35 % spell range, 120 s), the server checks the shortened range, and Hrafna logged 15 "too far away" in 17 s. It skips while a melee is on her, and reports as `nearsight` (until round 58 it shared `cure` with the mezz cure, so the reports couldn't tell them apart).
- **Reached, and no behaviour casts it:** Suspend Charge (area stun), Deny Movement (root), Eir's Glorious Touch (instant group heal, 50 %, 20 minutes), the cures, Wake Senseless.
- **Ease of Movement** is a speed song, at Augmentation 5, and the healer's list has no `song`, so it never plays. The group has the Skald's for that.

## Sized heals

**Verified.** Heals by spell level kept picking Minor Recovery (48) over Major Reparation (172), both at 18. `pickHeal` sizes by what's missing. Alternating 4-minute runs at the wolf camp, Sigrid plus Ulfgar:

| Way | Heal casts | Fights | Thorgrim's lowest | Deaths |
|---|---:|---:|---:|---:|
| By spell level | 49 | 11 | 62-64 % | 0 |
| Sized | 12 | 9 | 64-65 % | 0 |

Nothing else needed from her at that camp: at any `ready.mana` from 10 to 35 her heals stayed at 3-5 a run, and nobody but Hrafna ever made the group wait for power.

## What the reports show

**Verified,** six Midgard RvR rounds at level 24, 46 minutes, to 2026-11-03 21:42:

| Deaths | Crowd control | Heals | `cc:crowd_controlled` | `heal:crowd_controlled` | `heal:interrupted` | `cc:interrupted` | Targeted | In melee | Idle in fights |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 61 | 36 | 25 | 15 | 16 | 13 | 22 % | 15 % | 17 % |

- **She mezzes more than she heals,** though the list has `heal` above `crowdControl`. The reports don't say whether the group wasn't hurt at those moments or she couldn't reach it.
- **Mezzed herself as often as interrupted.** 40 casts refused with "You can't cast while mesmerized!" Enemy mezzes are among the largest failures in this group's reports.

## RvR, as players tell it

**Community, unverified** (research 2026-11-09):

- A Pacification healer opens with a mezz, stuns an enemy healer for kill windows and pushes up to interrupt; an Augmentation or Mending healer heals, cures and calls the tanks back ([Blackthorn](https://blackthorn-daoc.com/wiki/healer-guide)). Sigrid at Pacification 4 is the second kind with the baseline mezz.
- Cure mezz and cure disease are called very important, mezz and cure mezz on quickbinds; CC belongs on enemy support, and the group must not break it ([Uthgard](https://www.uthgard.net/forum/viewtopic.php?f=65&t=24011)).

## Not supported yet

- **Group heals:** Eir's Glorious Touch is instant, for fights where several are hurt at once. A rule would have to count who is hurt.
- **Root:** Deny Movement isn't taken while she has a mezz, and it lasts 9 s.
- **Cures** for poison, disease and nearsight.
