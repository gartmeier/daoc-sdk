# Mentalist

Hibernia's list caster: damage, crowd control, some healing and a power regen buff. For every spell, level and cost on this server run `bun data/class-sheet.ts Mentalist`. This file holds what the data doesn't say.

Three kinds of claim here, marked as such:

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches. Treat it as a hypothesis.

## The kit

`sdk/classes/mentalist.ts` is the starting point. A bot imports it in its own `bots/<bot>/character.ts` and changes what it wants:

```typescript
import { assist } from '../../sdk/group/behaviors';
import { mentalist } from '../../sdk/classes/mentalist';

const kit = mentalist();
export default { ...kit.character, fight: [assist({ holdMs: 1500 })] };
```

**`stunCaster` (2026-11-09, from arena round 6; `sdk/classes/mentalist.test.ts`).** The kit's `react` throws Prismatic Flash (Light 22 at 24: stun, 2.5 s cast, range 1500, 9 power, 5 s) at an enemy player seen casting in the last 2.5 s: first one whose spell is on our support or healer (`Contact.target` with `targetBySpell`), then one on any member, then a casting healer of theirs, the nearest of each, not crowd-controlled and not stun-immune by the board. In the pack's nuker list it sits above `assist`.

**Correction, 2026-11-10 night (6cf6f96).** Until then `stunCaster` and `quickFlash` took the first Stun in the book, and the book lists Prismatic Flare (Light 5: 3 s, 4 power) before Prismatic Flash (Light 15: 5 s, 9 power). So every "Flash" counted in the rounds below was in fact a Flare, a 3 s stun (found in an Eldritch log: "Died while casting Prismatic Flare"). `bestStun` now takes the highest rank that is ready and paid for, Flare only when Flash can't be. The rounds below measured the 3 s stun.

- **Why, verified:** arena round 5 against Albion (Paladin, Cleric, Sorcerer, Cabalist, Theurgist), two wipes, Oisin dead first at 17 s and 36 s under their casters; the user asked for much more interrupting of casters.
- **Server code:** a stun ends the target's cast at once (`OnHardCCStart`: `StopCurrentSpellcast`). A player then takes no stun for 60 s from its end (`immunity_timer_flat_length`), so the kit marks the board's stun immunity, not crowd control: marked as cc, `assist` and the Hero would leave the focus while it lasts (`ccHolds`).
- **Range, verified, arena round 9:** her one Flash failed `stun:out_of_range`. The kit measured the board's ground-plane positions; the server measures in 3D. It now goes by our view's 3D distance with a 60-unit margin, and tries the next candidate when one is out of view.
- **Below 15 % power** she keeps it for nukes. Cuchulainn's style stuns share the same immunity and don't mark the board: a Flash on a target he stunned answers "immune" and is marked then.

- `character` only sets the role to `nuker`. The role's list already casts the nukes, buffs, mezzes and emergency heals from whatever the bot knows, so the kit adds no behaviour of its own yet.
- Spec points aren't in the kit: they are the character's own `bots/<bot>/build.ts`.

## Builds

A character's `bots/<bot>/build.ts` starts as a copy from the catalogue in `data/builds/mentalist.ts`, and one buying rule spends it: [builds.md](../builds.md) says how to choose, change and check one. The catalogue's `why` and `order` say which spells each number reaches. A respec is free, so a character can level on Mana and move to Light nuker later.

Levels the rule gives each build (`buildPath`), lines in buying order, as a level dings and before its half level:

| Character level | Points | Light nuker: Light / Mentalism / Mana | Mentalism healer: Mentalism / Mana / Light | Mana levelling: Mana / Mentalism / Light |
|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 9 / 4 / 1 | 10 / 1 / 1 |
| 20 | 209 | 20 / 1 / 1 | 19 / 4 / 1 | 20 / 1 / 1 |
| 24 | 299 | 22 / 9 / 1 | 23 / 5 / 1 | 24 / 1 / 1 |
| 30 | 464 | 28 / 9 / 1 | 29 / 5 / 1 | 30 / 1 / 1 |
| 40 | 819 | 35 / 19 / 1 | 39 / 5 / 1 | 40 / 1 / 1 |
| 50 | 1494 | 45 / 28 / 10 | 50 / 20 / 4 | 48 / 24 / 5 |

- **The mezz waits its turn.** A line at character level takes every point, so Light nuker has only Enfeeble Mind, the first mezz, until level 23, and Mana levelling until 40.5. A mezz sooner takes a target of its own: `{ level: 20, specs: { Mana: 19, Mentalism: 6 } }` then `{ level: 24, specs: { Mana: 23, Mentalism: 6 } }` buys the Mana spec measured below, with Empowering Tranquility at 25 instead of 24.
- **Mentalism healer banks points** while Mentalism runs a level or two under character level: 26 at level 40.

**Community, unverified:**

- Full Mana is the usual levelling advice: strong power regen buffs, cheap DoTs, AoE DoTs for farming.
- 46 Light / 28 Mentalism / 4 Mana is the usual RvR split at 50, with Light's direct damage and Mentalism's crowd control. Mana DoTs are called weak in endgame RvR, and an AoE DoT can break a mezz.
- Lurikeen is the suggested race, for its Dexterity. Sources also list Shar, which can't be created here ([classes-and-races.md](../classes-and-races.md)).

**Server code,** why the builds at 50 leave that advice:

- **Light nuker is 45 / 28 / 10, not 46 / 28 / 4.** Light has no spell above 45, so the 46th level buys no spell. It does raise the damage floor: against a level 50 target 92.8 % instead of 91.2 % (SpellHandler.cs:2748-2763). Its 46 points buy Mana 4 to 10 for 45 (Lesser Mind Fade, Mind Fade, Curative Trance), leaving 1 of the 1494. Whether that trade is worth it is **untested**.
- **Mana levelling is 48 / 24 / 5, not full Mana.** It is full Mana up to 40. Mana has no spell above 48, so the half levels go to Mentalism 24 (Paralyze Mind at 23, Eccentricity at 24) and Light 5.

**Server code,** what each line gives:

- **Mana Magic:** the regen buff at 4, 14, 24, 34, 44; a heal over time at 10, 21; AoE DoTs at 17, 23.
- **Mentalism:** mesmerize at 1, 5, 10, 15, 23, 31, 41, 50; confusion at 3, 8, 12, 17, 24, 32, 40, 49; a mezz cure at 28.
- **Light Magic:** stronger direct damage, AoE damage and charm at 4, 10, 17, 25, 33, 42.
- Baseline spells follow the character's level, not the line (**verified:** Sun Ray at Light 1, level 20). A low line still weakens them: the lower bound of spell damage depends on line level against the target's level.

## Power

- **Server code:** regen is `2.5 + level x 0.2 + buff` per tick, about every 5 s, cut to a whole number. List casters get half below 50 % power (`PowerRegenerationAmountCalculator.cs`).
- **Verified:** at level 20, a caster below 50 % power went from 3 to 4 per tick with Empowering Harmony (Mana 14). By the formula, the first rank (+1) gives that caster nothing: `(6.5 + 1) / 2` still rounds down to 3.

## Measured: Mana or Light at level 20, in a group

Does a Mana spec help a group more than a Light one? Not in XP, so far. Level-20 hunts of the five-member Hibernia group on a disposable server, with clones reset before every run and only the Mentalist's spec changing. Nobody died in any run and the tank held every mob.

These are the specs the hunts ran, and neither is a catalogue build. At level 20 Light nuker is Light 20 / Mentalism 1 / Mana 1 and Mana levelling is Mana 20 / Mentalism 1 / Light 1. Both specs below had Cripple Mind (Mentalism 5), which those two don't, so this table doesn't measure them.

| 15 min hunt | XP per hour | Kills | Mentalist dealt | Group dealt | Group waited on Mentalist's power | Group waited on Enchanter's power |
|---|---|---|---|---|---|---|
| Light 17 / Mana 6 / Mentalism 8 | 23.4M | 16 | 3124 | 8899 | 6 % | 50 % |
| Light 17 / Mana 6 / Mentalism 8 | 20.8M | 16 | 3404 | 9183 | 3 % | 54 % |
| Mana 19 / Mentalism 6 / Light 1 | 22.7M | 18 | 2688 | 9712 | 2 % | 51 % |
| Mana 19 / Mentalism 6 / Light 1 | 21.7M | 18 | 3029 | 9993 | 9 % | 44 % |

- XP per hour is level: about 22.1M against 22.2M. Six 6-minute hunts of these specs were noisier (17.5M to 25.2M) and pointed the same way.
- The Mana spec's own damage is about 13 % lower. The group dealt about 8 % more and killed two more mobs per hunt, which earned no more XP. Two runs each can't separate that from which mobs were nearby.
- Waiting on the Mentalist's power is not what slows this group at level 20: about half the waits are on the Enchanter's. Half of each hunt goes to recovering in either spec.
- Holding back direct damage below 50 % power was tried and dropped: it showed no gain in two 6-minute hunts.

So choose by what the character will do, and don't expect a respec to change XP at this level. Levels above 20, solo play and RvR are **untested**.

## Not supported yet

No group behaviour uses confusion yet; the sources call it useful on big pulls (**community, unverified**). The charm is `charmUp` ([below](#the-charm-charmup-2026-11-13)).

## Sources

Summarized in our own words: [Camelot Herald wiki: Mentalist](https://camelotherald.fandom.com/wiki/Mentalist) (CC-BY-SA) and [disorder.dk Hibernia class guide](https://disorder.dk/daoc/class-guide-hibernia/).

## Arena round 10: offFocus

**Verified,** round 10 (2026-11-09, against Albion: Paladin, Cleric, Sorcerer, Cabalist, Theurgist): wiped in 79 s, 0 kills. Niamh cast 1 nuke and moved 69 % of the fight; her two nukes before that were `out_of_range`. The pack's soft focus was their back line, beyond reach; the casters walked toward it and died en route. Albion's casters fixed the same idling with `offFocus` (Cabalist kit, 6675df9: Morgana, Taliesin and Merlin had idled 39-67 turns on "focus out of reach").

From round 11 the kit's fight is `nukerFight(0, true)` from `sdk/classes/cabalist.ts`: `assist`, then `offFocus`, which nukes the nearest free enemy player in reach (not crowd-controlled, not assigned or claimed for cc, so no mezz is woken) while the focus is out of reach, from where she stands, never into a melee swing. `mentalist({ offFocus: false })` leaves it out.

**Verified, arena round 12** (against Albion, won 7-0, no deaths): Niamh 9 nukes and 1 Prismatic Flash, 1,121 damage, against Ciaran's 26 nukes and 3,460. Her idle turns were 34 of "focus out of reach, holding ground" with `offFocus` in the list behind it: nobody else was in her reach either, so it is where she stands (the pack's fanOut and standStep), not the kit.

**Arena round 13** (2026-11-09, lost 1-4 to Midgard): three of their melee dove Oisin; he died at 11 s kiting (a speed song takes no effect in combat, `SpeedEnhancementSpellHandler.cs:69`), then Brigid at 35 s. Niamh cast no Flash: `stunCaster` took only casters. From round 14 a player swinging at our support or healer (`Contact.target` without `targetBySpell`, `swinging`) ranks first beside a caster on them, and she doesn't start the 2.5 s cast while a melee is on her herself (`hammeredBy`).

**Arena round 15** (wiped Camelot 5-0): Niamh was the one dived, 51 % of the fight in melee reach, 4 nukes. No Flash, as meant: `hammeredBy` holds it. A Mentalist at 24 has no instant spell to answer a melee on herself (Flash 2.5 s, Cripple Mind 3 s, Delirium 3 s), so that is the peel's and the others' crowd control.

**Arena round 18** (wiped 0-5 by Midgard, 171 s): Niamh 11 heals, 10 nukes, 4 cc, no Flash. The role list's `emergencyHeal` (members under 40 %) sits above her kit, so in a long losing fight her turns go to heals first. Midgard ran two healers (17 mezz cures, 12 heals) and our focus moved across four targets; nothing died.

**Verified, arena round 20** (wiped Midgard 5-1, the first win against them since round 9): 5 Prismatic Flashes, 2 of them `stun:out_of_range`, 8 nukes, 1,022 damage. The server checks range at the cast's end, and a melee chasing Oisin walks on during the 2.5 s cast: the margin under the range is now 150 (10 % of it, as `castSpell`'s own walk stops), from 60.

**Verified, arena round 25** (won 8-6 against Midgard): Niamh's best round, 28 nukes, 4 Prismatic Flashes, 3,739 damage, with the Flash above her emergency heals and `offFocus` in her fight.

## Quickcast (from the round after 28)

Niamh has the Quickcast ability (`bun sdk/cli.ts niamh`): the next spell can't be interrupted, at twice its power, then 30 s before the next (`QuickCastAbilityHandler.cs`; Albion class session, 1f05f78). Her kit's `instant` slot, above `flee`: `quickFlash` first, Quickcast and Prismatic Flash on the melee hitting her (`hammeredBy`), not on one stun-immune or crowd-controlled, within range less 150; then the Cabalist kit's `quickcastUnderFire` (her cc assignment, else her nuke on the focus) when the Flash can't go. They share one 31 s timer. Round 15 is why: dived 51 % of the fight with nothing to answer with.

**Verified, arena round 30** (wiped Camelot 5-0): the first round with Quickcast. Niamh used it once (`quickcast` 1) among 3 stuns and 13 nukes, 1,675 damage, never in melee long (0 % of the fight).

**Arena round 35** (wiped Camelot 6-0): Prismatic Flash 18 times out of range, retried at once each time with our view saying in range. From the next round the Hibernian kits back off: after the server's "That target is too far away!" at a target, it reads as out of reach for 10 s, unless our view puts it 200 nearer than when that was said (`viewDistance`, `noteTooFar` in `sdk/classes/mentalist.ts`, shared by the Flash, Quickcast Flash, `dazzle` and `rootDiver`).

**Arena round 39** (beat Midgard 5-1): Niamh the one death, 33 % of the fight in melee reach, 5 nukes, 2 Flashes, no Quickcast. `hammeredBy` (shared) counts enemy players only, so a pet on her (Midgard's spirit warrior) never set off `quickFlash`. From the next round `quickFlash` also takes an enemy pet swinging at her when no player is (`petOnMe`); Ciaran's kit uses the same `quickFlash`.

**Arena round 62, positions sampled by the group session:** within 10 s of the engage the Hero stood at the enemy back line while the casters were 1,200-3,500 from him; Niamh walked 1,200 → 3,500 in 16 s as the pack's `fanOut` stepped her back. From the next round the kit's fight is `casterFight` (`sdk/classes/mentalist.ts`): the Midgard Spiritmaster kit's `steppingAssist` in place of `assist` (after 4 s with the focus beyond the nuke's range and nothing cast, one leg toward it, to 85 % of the range), then `offFocus`. The brake on `fanOut` itself is the group plan's (Midgard's calmFan is in their group plan).

**Reverted after arena rounds 64 and 66** (both lost to Camelot): `steppingAssist` caps the step at 250, and at 750 only after 4 s, while Hibernia's `standStep` is 900. So it stepped the casters in less than plain `assist` did: Ciaran 3 and 2 nukes, 13-14 turns of "focus out of reach, holding ground". `casterFight` is plain `assist` plus `offFocus` again (the Cabalist kit's `nukerFight`). Check a borrowed helper's numbers against our own group settings first.

**Arena rounds 101-105** (three Camelot wins in a row): Albion's pets (Theurgist simulacrum and ice beings, Cabalist pet) dive our casters; `hammeredBy` counts players only, so casts went off under pet swings and were cut (`stun:interrupted` in rounds 101, 103, 105). From the next round `stunCaster` also waits while an enemy pet swings at her (`petOnMe`); asked the orchestrator to count pets in `hammeredBy` for every cast.

## Where the kit stands (arena end, 2026-11-10, round 119)

Hibernia won 51 of the 85 arena rounds it played (Midgard 20, Camelot 14); round 119 a 5-0 wipe of Midgard.

**Proven:** Prismatic Flash at casters and melee on our Bard and Druid (`stunCaster`, urgent, above emergency heals), Quickcast Flash on a melee or pet hitting her (`quickFlash`), `offFocus`, and the 10 s back-off after a server "too far"; 2-7 Flashes a round, best rounds 3,000-4,000 damage.

**Open:**
- Dived first in many Albion losses; Quickcast is once per 30 s and she has no other instant.
- Emergency heals still take her turns in long fights (role list).
- `steppingAssist` was tried and reverted (rounds 64-66): a borrowed step shorter than the group's standStep.

## The user's Mentalist (2026-11-13, play/niamh-1113-findings.md)

52 min of the user's own Niamh, from a capture of the connection:
- **Casts:** two in three were Glittering Visions on the assist target, recast at once. Then Prismatic Flash 12, Cripple Mind 11, Somatic heals on others 8, and 6 charms with Imaginary Enemy (a bwca, mature boars) to tank the adds.
- **Self buffs:** Barrier of Negation recast each time it popped (11) and Powershield kept up (8).
- **Other:** she sat 4 times, and 47 of ~180 casts were interrupted.

What the kit took from it:
- **`bladeturnUp` (chores):** Barrier of Negation back up as soon as it pops, in a fight too, when no enemy aims at her and no melee is on her. `buff()` keeps it, and Powershield, only in the quiet phases.
- **Already the kit's:** the nuke on the assist target (the role's assist), the Flash on a melee (`quickFlash`), the emergency heal.

- **The charm (`charmUp`):** the next section.

Not yet:
- **Cripple Mind on the focus.**

## The charm: charmUp (2026-11-13)

`charmUp` (chores, with the group's `petControl` on the kit's list from the start, since a run picks its pet behaviours once, when she has no pet yet; tests in `sdk/classes/mentalist.test.ts`). With no window pet, not in a pull, a travel or a retreat, with no melee or enemy aim on her and pets on for the run, she casts her best charm, Imaginary Enemy at Light 22 (Illusory Enemy 4, Fabricated 10, Imaginary 17, Phantom 25; range 2000, 3 s, no power to cast), with `approach: false` at a mob within 1500 of her: a monster, not named, not a pet, at 90 % health or more, on nobody and in no fight, not the focus or a threat, the strongest first, then the nearest. After that `petControl` drives it like any window pet. `mentalist({ charm: false })` leaves it out; `mentalist({ charm: { maxResist: 35 } })` takes riskier mobs.

**Server code** (`CharmSpellHandler.cs`, `CharmECSEffect.cs`, `EffectService.cs`):
- **Limits:** refused above the spell's value (76) or 110 % of the modified Light spec (`cap`, Light 22: L24). The resist chance per roll goes by the sweet spot `level x 0.66 + spec x 0.33 - mob level`: at 0 or above `10 - 3 x that`, at least 1 %; below 0 `(10 + 1.5 x the shortfall) x 3`, at most 99 % (`charmResist`). At 24 with Light 22: L20 and under 1 %, L21 3.7 %, L23 9.7 %, L24 34 %, L25 52 %. `charmLimits().safe` is the highest level at or under `maxResist`, 10 % by default (L23 here).
- **A song:** it pulses every 4.8 s at 3 power a pulse, and each pulse rolls the resist again. The charm effect lasts 10 s, so a lost pulse alone breaks nothing. Casting it again stops it (`releasePet` does that). With no power for a pulse: "You do not have enough power and your spell was canceled."
- **Any end turns the mob on her:** a lapse, the power, a release. It puts her on its list at level x 10 and attacks, and every mob on the pet turns to her too. A release is no way out, so the kit never releases. Over a lapse with the mob alive and within 10000 the song goes on pulsing and can take it back.
- **Body type** goes by the npctemplate, not the mob row. Imaginary Enemy (AmnesiaChance 5) takes humanoid, animal, insect and reptile; type 0 is "can't be charmed!". The kit keeps such a name off its list for the run.
- **A lone mob only, so its camp stays put:** once charmed it is a player's pet, and every aggressive monster with it in its aggro range takes it as a target (`StandardMobBrain.CheckNpcAggro`); one that cons grey to it doesn't (`CanAggroTarget`). Bring-a-friend is not the cause: a charmed mob neither starts nor answers one (`CanBaf`), and it needs an attack. So `charmTarget` passes over a mob with an aggressive neighbour (`aggroAt` from the spawn data, passive ones don't count) within that neighbour's aggro range + 300, at its spot or on its walk to her (`charmNeighbour`); without aggro data every monster counts, at 500. Every Thidranki bwca, boar and tomte spawn has AggroRange 500, so that is 800 from its kin: in a camp it takes the outermost one on her side, or none.
- **Else a pull, as the user did** ("I pulled one with a nuke"; charmed in its camp "they attack the charmed pet right away"): with no fight on and no threat on the board, `charmPullTarget` takes a mob of a camp at 600 to her nuke's range, of no faction by the spawn data, with her spot and the spot 700 from her on its run in both out of the camp's reach (aggro range + 300). She nukes it (`ctx.spells.nuke`, `approach: false`), waits up to 12 s for it to come clear of its camp (`charmNeighbour` from where it is) at 300 or more from her, and charms it. Her activity `charm` on it marks it `Contact.charming` on the board for 15 s (`CHARM_CLAIM_MS`): no threat for anyone, and no fight in `rvr.ts`, so the group doesn't kill the pet-to-be. If it comes on her first, she drops the claim and the group fights it like any mob on her.
- **When it pulls, and the log:** no pull with an enemy player on the board, or with a fight within 2000 of her (a contact in combat or a threat, a member in combat): `pullBlocked`. Every pull writes `Deirdre: charm pull: ...` lines in the run log: the nuke, a failed nuke, a mob that reached her before it was clear, a failed charm. A charm that lands writes its `charmed ... pulled out of its camp` note.
- **The adds of the field sorties on 2026-11-13 (20:27 and 20:39 UTC, 1fe7b66) weren't her pulls, as far as the logs go:** at 20:37 the raid fought Midgard inside a bwca camp (Deirdre died 364 from a bwca spawn, in its 500 aggro range), with the phase engage throughout and travel before, and she pulls in neither. At 20:42-20:44 the unit met bwcas while travelling (hunt, trail, roam), where `charmUp` never runs. Only one fight could have been a pull, an L20 bwca 5 s after a `recover`, and the pull lines above didn't exist then. So the adds come from fights and routes through aggressive camps, a matter for the coordinator, not the charm.
- **Faction:** only a mob with a faction brings friends when hit (`StandardMobBrain.BringFriends`): 0 % alone, 50 % more for each other group member within 5000, from within 450 + 150 each. A charmed mob neither starts nor answers one. In Thidranki every bwca and mature boar has none, while every tomte soldier and hunter has faction 175, so the pull leaves the tomtes alone. The spawn data now carries `factionId` (`data/build.ts`, `factionAt` in `sdk/group/terrain.ts`).
- **A Mentalist's charm takes a mob in combat:** the server's "You can't charm X while it is in combat!" is for the Hunter's and Sorcerer's charms only (`CharmSpellHandler.cs` CheckEndCast, the non-pulse branch).
- **A resisted first pulse is no failure:** the song pulses on and each pulse rolls again. So after "resists the charm!" `charmUp` waits up to two more pulses (10.6 s) for the pet window.

**Verified** on a throwaway stack, L24 Mentalist with Light 22 / Mentalism 9 (Deirdre's build), Thidranki:
- **What takes it in Thidranki:** mature boar L24-26 (animal), perturbed bwca L26-30 (its template is humanoid, though its mob row says magical: that is the user's bwca), tomte soldier, visionary and mystic L20-28. Clicking beetles (template 0 though the row says insect), the badgers and most tomte hunters answered "The X can't be charmed!", after the whole 3 s cast. Spawn levels vary: the same beetle camp was L20 in the dump and L22 live.
- **One charm through the kit's own `charmUp`** (with `maxResist: 40`, nothing safer being within 1500): a L24 tomte soldier at 928, "The tomte soldier is now under your control.", window up at 3.2 s, defensive and on follow.
- **It held for about 5 minutes at 34 % a pulse:** 14 "The tomte soldier resists the charm! (34.05%)" lines, never two pulses running, the window never closed. The server rolls with a pseudo-random dice (`GetPseudoDouble`, `RandomContextFactory.Resist()`) that spreads resists out. Each pulse cost 3 of her 136 power, which regen gave back at full power.
- **Its old camp:** a tomte hunter came at the pet a minute in and hit it for 33-39 every 3 s. The defensive pet never answered, as a defensive pet answers hits on its owner only. In a group run `petControl` sends it at the focus.
- **The release:** "You cancel your effect.", "You lose control of the tomte soldier!", "You release control of your controlled target.", then in the same snapshot "The tomte soldier hits your leg for 138 (-6) damage!" (262 health in cloth), and a second hit killed her 3 s later. So whatever ends a charm of her own level in a fight, the tank has to take that mob at once.
- **In a field run** (2026-11-13 19:39, `groups/hibernia/runs/field-20261113-193026.log`): Deirdre charmed a perturbed bwca (L24, 7.8 % a pulse) in its camp, before the lone rule. The user, playing Niamh: "Deirdre got herself a pet, nice. She got a lot of adds though." Three more bwcas (L23, L23, L21) came in the next 40 s and Laoghaire killed them while the unit moved on. 
- **The pull, verified** on a throwaway stack (Thidranki 238, a mature boar camp near 540300, 569800), same character, the kit's own `charmUp` with `maxResist: 40`:
  - **Run 1:** Sun Streak was resisted (12.5 %) and pulled the L24 boar anyway. It was clear of its L25 kin at 1107 from her, and the first charm pulse was resisted (34 %), which the kit then counted as a failure. The boar hit her for 138, and the song's next pulse, 5 s on, took it: "The mature boar is now under your control." The kin never moved. That is why the kit now waits on the next pulses.
  - **Run 2**, under the first pull rule (only her spot clear by reach + 350): the kin stood beside the path, 1224 from her. The boar came clear only 441 from her and was under 300 before the next check, so the kit dropped the charm, and the boar killed her alone in two hits (138 each of her 262). Hence the rule on the spot 700 out.
  - **Run 3**, under that rule: the kit waited 55 s for the roaming kin to stand off the path, pulled, cast at 3.0 s, and had the pet at 6.2 s on the first pulse. It stood at her side, and the kin stayed at its spawn 1240 away.
  - Boars run in at about 180 a second.
- **Not seen live:** a lapse (two resisted pulses running), the song taking a lapsed mob back, the power running out under it, and a charm in a real group run. The default 10 % pick wasn't cast live either: no mob at L23 or under was within 1500 of either spot tried.

**The user's own charms** (play/niamh-1113-findings.md): 6 in 52 min, on L24-26 boars and a L26-30 bwca. Above L24 that needs a modified Light of at least 24 (gear or more spec), and those mobs resist 34-52 % a pulse. The kit's default is safer than that; pass `maxResist` to play it as she did.

