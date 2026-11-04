# Healer

Midgard's main healer: heals from Mending, base buffs from Augmentation, mezz, stun and root from Pacification. For every spell, level and cost on this server run `bun data/class-sheet.ts Healer`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Healer "Mending first"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/healer.ts` holds only the role, `healer`, which is what `roleForClass` gives. It changes nothing against the role list, and Sigrid plays the same either way.

**Server code: nothing that exists fits.** `assist` has no spell to cast, since Mending first has no damage spell, and outside the wolf pack it would still walk her toward a focus she can't see. `song` would play Ease of Movement, which the Skald's speed song outdoes in the same group. What she'd want is under "Not supported yet", and each needs a behaviour.

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
- **Reached, and no behaviour casts it:** Halt Attack (stun, 2.5 s, 8 s), Suspend Charge (area stun), Deny Movement (root), Hinder Spirit (instant attack slow), Cleanse Mind (mezz cure), Eir's Glorious Touch (instant group heal, 50 %, 20 minutes), the cures, Wake Senseless.
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

## Not supported yet

- **Stun on an enemy healer,** Halt Attack: asked for in the group's log since the first RvR rounds. Nothing picks a stun for a target.
- **Group heals:** Eir's Glorious Touch is instant, for fights where several are hurt at once. A rule would have to count who is hurt.
- **Mezz cure,** Cleanse Mind: nobody tracks which members are mezzed. A Shaman has none, so it's hers to give.
- **Root:** Deny Movement isn't taken while she has a mezz, and it lasts 9 s.
- **Cures** for poison, disease and nearsight.
