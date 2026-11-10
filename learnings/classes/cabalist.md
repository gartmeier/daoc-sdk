# Cabalist

Albion's list caster for damage over time: DoTs from Matter, lifedrains from Body, a pet from Spirit. For every spell, level and cost on this server run `bun data/class-sheet.ts Cabalist`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Cabalist "Matter"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/cabalist.ts` holds only the role, `nuker`, which is what `roleForClass` gives. It changes nothing against the role list. The list casts her DoTs first as it is, and no `assist: no power` shows in her top reasons, so she has no floor of power to carry where the Sorcerer and Theurgist do. Morgana going without is also the group's choice: "every fight has one caster at full rate" ([sorcerer.md](sorcerer.md)).

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/cabalist.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Matter: Matter Magic / Body Magic / Spirit Magic | Spirit debuffer: Spirit Magic / Body Magic / Matter Magic | Tri-spec: Matter Magic / Spirit Magic / Body Magic |
|---|---|---|---|---|
| 10 | 54 | 9 / 1 / 3 | 10 / 1 / 1 | 1 / 1 / 10 |
| 20 | 209 | 19 / 1 / 3 | 20 / 1 / 1 | 11 / 1 / 16 |
| 24 | 299 | 23 / 5 / 3 | 22 / 8 / 4 | 12 / 12 / 16 |
| 30 | 464 | 29 / 5 / 3 | 28 / 8 / 4 | 12 / 12 / 24 |
| 40 | 819 | 39 / 5 / 3 | 38 / 8 / 4 | 25 / 19 / 24 |
| 50 | 1494 | 46 / 28 / 4 | 46 / 28 / 4 | 25 / 33 / 34 |

Morgana plays Matter. **Community, unverified:** the sources agree it's the efficient PvE line, and the wiki gives Spirit debuffer the same 46 / 28 / 4.

**Server code: the spells that Spirit 3 buys need a pet.** Convert Spirit (Spirit 3) reclaims power from one, and it sacrifices the pet, so no behaviour casts it, though `summonPet` keeps a pet up. It costs Perforate Spirit one level later: Matter 24 alone also fits the 299, and the catalogue says so. The area DoT isn't cast either, so it's a wash until a behaviour uses one of them.

## Matter at 24 in Thidranki

**Server code,** Matter 23, Body 5, Spirit 3:

- **Nukes, in order:** Dissolving Smoke (37 every 5 s for 20 s, baseline), Devolution (37 every 4 s for 24 s, Matter 21), then Greater Essence Consumption (lifedrain, 85, 14 power, heals her for 40 %). The two DoTs stack, because `dotFamily` and the server tell them apart by tick frequency.
- **DoTs are her power efficiency:** 148 and 222 damage for 13 power each, against 85 for 14 for the lifedrain, if the target lives through them. **Server code:** `pickNuke` drops them below 40 % target health, which is why.
- **Crowd control:** a root, Major Crippling (2.5 s, range 1500, 31 s, baseline), since a mezz is Mind and she has no Mind. `capabilities().cc` counts it, so she gets adds.
- **Buffs:** her own Fend Offense and Barrier of Warding. Acuity comes from the Cleric.
- **Reached, and no behaviour casts it:** Puncture Spirit (area DoT, 33, radius 350, 17 power; only with `aoe`, and it breaks mezzes), Cursed Vigor (disease), Enfeeble Body and Magical Web (debuffs), Obscuring Dust (nearsight), Shift Health, Convert Spirit and the pulsing pet shields.
- **The pet:** Emerald Simulacrum, baseline at level 20, is kept up by `summonPet` and follows the focus (`petControl`), with its heals by `petHeal` and its long buffs by `petBuff` (`bun sdk/classes/reach.ts Cabalist Matter`). The reports below are from runs with no pet, so compare with `--pet.enabled=false`.

## What the reports show

**Verified,** six Camelot RvR rounds at level 24, 46 minutes, to 2026-11-03 21:48:

| Deaths | Damage a minute | Nukes | Crowd control | First nuke | `cc:crowd_controlled` | `nuke:interrupted` | Moving in fights | Targeted | In melee |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 148 | 60 | 52 | 27.3 s | 24 | 8 | 37 % | 14 % | 16 % |

- **The group's top damage, tied with Taliesin,** and no `assist: no power` in her top reasons, where he has 121 and Merlin 56. So DoTs seem to hold out on power in RvR too, though nothing has been compared.
- **52 crowd controls for a root.** A root doesn't stop a player casting, unlike a mezz, and `Spellbook.cc` makes no difference between them at `assignCc`. Whether her turns are better spent on a DoT in RvR is untested.
- `assist: focus not in view` 83 times, like the other casters: fights spread out.
- Every death to Midgard.

**Verified, PvE:** forest messengers came 3 to a pull at L14-15, with Merlin's mezz and her root holding the two adds; a clean first pull, then a wipe with 10 adds in the same hunt. That camp was dropped.

## Not supported yet

- **The Spirit line beyond the pet's upkeep:** its level comes with the character's whatever the spec. What more Spirit buys for it hasn't been measured.
- **Area DoT** and **disease:** no behaviour for either.
- **Spirit debuffer:** Diminish Immunities at Spirit 22 (Body, 15, 8 s) matches her Body lifedrain, so `resistDebuff` would cast it wherever `debuffPays` says ([enchanter.md](enchanter.md)). Nobody has run the build.

## Community, RvR at 20-24 (research 2026-11-09)

- **Unverified:** send the simulacrum at the enemy healer or caster, since every swing of an NPC pet starts the 3 s interrupt timer (**server code**, GameLiving.cs:708: 100 % plus 5 % per level above the target). A player DoT interrupts only when its first tick lands (DamageOverTimeECSEffect.cs:60). Disease (Cursed Vigor) goes on the kill target to cut its healing. Nearsight (Obscuring Dust) goes on back-line healers and casters. Sources: https://www.uthgard.net/forum/viewtopic.php?p=378462, eden-daoc.net/viewtopic.php?p=11675 (snippet).
- **Verified, arena round 5:** Morgana dealt 2836, the most in the group, plus 863 from her pet. 7 of her nukes were interrupted, and she was in melee 17 % of fight time.

## DoTs and nukes off the focus (kit, from Camelot's round after round 6, 2026-11-09)

**Verified, arena round 6** (camelot vs midgard, `groups/camelot/runs/20261109-211626.md`): the group holds its ground with the casters 700 behind the tank (spread formation). Morgana idled 51 turns on "assist: focus out of reach, holding ground", and 10 of her nukes went out of range. Taliesin idled 67 turns and Merlin 39 on the same reason.

**The change** (`sdk/classes/cabalist.ts`; the Sorcerer and Theurgist kits use it too): `offFocus` sits right below `assist`. While the focus is beyond her nuke's reach, or held by crowd control, she casts her DoTs and then her top nuke on the nearest enemy player in reach, from where she stands. It skips anyone who is mezzed, assigned to crowd control or claimed for it in the last 4 s, a pet, or in another region. It never uses area spells. The DoT families go into assist's memory for that target, so they aren't recast if it becomes the focus. Nothing is cast while an enemy is in melee on her (`hammeredBy`). `cabalist({ offFocus: false })` turns it off. The kit now has a fight, so it is no longer a role-only kit.

**To look for:** `nuke` results "(off the focus)", her damage against round 6's 2292, and fewer "focus out of reach" idles. Also whether a mezz breaks on a target she hit (`mezz on X broke` lines).

**Arena round 14** (Camelot wiped Midgard 5/0, one 72 s fight, `groups/camelot/runs/20261109-223037.md`): the group's root assignments put 2 Major Cripplings out. 1367 damage, no deaths, though she was in melee 52 % of fight time and targeted 25 %.

## Instant debuffs under the swings (kit, from Camelot's round after round 22, 2026-11-10)

**Why, verified:** in round 11 Morgana was in melee 55 % of fight time with nothing she could cast. Every cast with a cast time was interrupted, and flee took her turns. The orchestrator's `Character.instant` slot (e72ffe8) sits above flee.

**The change** (`sdk/classes/cabalist.ts` `meleeDebuff`, used by the Sorcerer and Theurgist kits too): while a free enemy player or pet is in melee on her (else on one of our casters or the healer), she casts her instant single-target debuffs on it, one per turn, each type once per its length. The order is attack speed (Inflict Malaise, 5 %, 33 s), then strength (Enfeeble Body, 27, 60 s), then dexterity (Magical Web, 28, 60 s). Merlin casts Enfeeble Body, then Minor Mesh of Force (Dex/Qui 19). Taliesin casts Friction (attack speed 9 %, 120 s). Area debuffs (Imbalance, Banish Conviction) are left out, since they would wake a mezzed neighbour. A target under crowd control is skipped. `cabalist({ meleeDebuff: false })` and the same option on the other two kits turn it off. **Server code:** instants skip the interrupt check (SpellHandler.cs:597, :603).

**To look for:** `debuff` results in the three casters' report lines, and whether their time in melee or their deaths change.

**Arena round 27** (Camelot wiped Midgard 5/2 in one 220 s fight, the first round with `meleeDebuff`): Merlin cast 9 debuffs, Morgana 4 and Taliesin 3, and 4 were resisted. Merlin then had 4 nukes and 2 mezzes refused for power, so debuffs now stop below 35 % power (`DEBUFF_MIN_MANA`). Taliesin had 10 nukes `out_of_range`, so `offFocus` now picks and casts 50 inside the spell's range, as Nimue's stun does.

**Arena round 28** (Hibernia beat Camelot 9-0): debuffs Merlin 9, Morgana 7 and Taliesin 3. The damage loss came from Hibernia's mezz and amnesia (Merlin entranced, then amnesia'd, then dead; Morgana dead 3 s after one debuff), but Merlin and Taliesin each held the group 12 % of the run for power. Now a debuff on a melee hitting another member needs 60 % power (`DEBUFF_FOR_OTHERS_MIN_MANA`). One on a melee hitting the caster still needs 35 %, since then nothing else can be cast.

## Quickcast under fire (kit, from Camelot's round after round 28, 2026-11-10)

**Verified, arena round 28:** Hibernia's interrupts ("Oisin" 21 of them, and a Hero's Numb and Disable) cut every cast with a cast time. Merlin and Morgana dealt 0 damage, and only the instant debuffs went off. `bun sdk/cli.ts` shows that Merlin, Morgana and Taliesin all have the Quickcast ability, and no behaviour used it.

**Server code** (QuickCastAbilityHandler.cs, QuickCastECSEffect.cs, SpellHandler.cs:389, :1226, :1388): the next spell can't be interrupted by melee or spells and costs twice the power. The effect lasts 3 s, so the spell must start within that. It's refused while swinging, and using it again while it's on cancels it. After a quickcast cast it is locked for 30 s.

**The change** (`quickcastUnderFire` in `sdk/classes/cabalist.ts`, first in all three nukers' instant slot, above `meleeDebuff` and `flee`): under fire, meaning a melee on the caster or a cast interrupted in the last 5 s, it uses Quickcast and then casts. The spell is the caster's cc assignment's mezz or root if any, else the nuke on the focus, from where the caster stands, within 50 of the spell's range. It needs twice the spell's power, and runs at most once per 31 s.

**To look for:** `quickcast` results and `(quickcast)` casts in the report, and damage against round 28.

## Nearsight on enemy casters (kit, from Camelot's round after round 30, 2026-11-10)

**Verified:** against Hibernia, Camelot lost rounds 12, 15, 24, 28 and 30, winning only 21. Each time Hibernia's casters mezzed, amnesia'd or interrupted ours from range (round 28: 21 interrupts from one caster; round 30: Quickcast went once each for Morgana and Taliesin, and Morgana's 4 debuffs were refused while she was crowd-controlled).

**Server code:** Nearsight adds its value to the target's SpellRange and ArcheryRange debuffs (NearsightECSEffect.cs), and SpellRangePercentCalculator gives `100 - debuff` %. Obscuring Dust (Matter 19, value 35, range 2300, 2 s, 9 power, 120 s) takes a 1500-range caster to 975, and she casts it from beyond that caster's reach. The target is then immune for a while (ImmunityEffectSpellHandler). Nearsight wakes a mezz (GameLiving.cs, the non-damage spells that break one).

**The change** (`nearsight` in `sdk/classes/cabalist.ts`, in Morgana's react, so above her assist and below flee and crowdControl): in engage, and in travel with enemy players in reach, it casts Obscuring Dust on an enemy caster or healer within 2250. The order is the group's marked mezzer (`camMezzer`), then whoever was seen casting last, then a healer, then the nearest. It skips anyone mezzed, on a cc assignment or claimed for one, a pet, nearsighted by her in the last 3 minutes, or out of reach. Nothing is cast while a melee is on her. `cabalist({ nearsight: false })` turns it off.

**To look for:** `nearsight` results in her report line, and whether Hibernia's opening mezz still lands from 1500.

**Arena round 32** (Camelot wiped Midgard 5/0 in one 80 s fight, no deaths): `quickcast` went once each for Merlin, Morgana and Taliesin. Morgana's `nearsight` cast twice, was interrupted twice and resisted once. Taliesin's one Quickcast was refused with "You must wait 1 second to use this ability." and then sat out the full 31 s lock, so a refusal naming a wait now retries after that wait (`quickcastWaitMs`).

**Arena round 33** (Hibernia won the cap from Camelot 5/2; the 264 s fight beat recent wipes): `nearsight` tried 7 times in under a minute and landed none. It was amnesia'd twice, interrupted twice, resisted once, `out_of_range` at 2250 once, and `must_wait` once, and Morgana dealt 57 damage. Now a failed try leaves that target alone 20 s, she doesn't try while under fire (a melee on her or a cast cut in the last 5 s), and she casts from 2100.

**Arena round 35** (Hibernia wiped Camelot 6/0, 123 s): with the backoff, `nearsight` landed 4 of 4. Hibernia's melee then sat on our casters instead: Morgana and Merlin were each in melee 72 % of fight time, Morgana cast 10 debuffs and 2 quickcasts, and her damage was 290.

