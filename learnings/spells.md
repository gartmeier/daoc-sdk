# Spells

## What you know

```typescript
const spells = sdk.getSkills().spells;          // name, level, lineName, lineIndex, spellIndex, cooldownRemaining
const nuke = sdk.findSpell(/bolt|blast|drain/i);
const info = bot.getSpellInfo(nuke);            // from the DB: type, target, range, power, castTime, damage, ...
nuke.details;                                   // from the server: castTimeMs, damageType, powerCost, range, durationSeconds, recastSeconds, target, description, ...
```

- **`spell.details` is what the server says about this character's spell**, from the 0xD8 tooltip it pushes after the skills list (PacketLib1110.cs:159-212; property `use_new_tooltip_forcedupdate`, on by default). `castTimeMs` is 0 when instant and null for a cast under 2 s, which the tooltip doesn't state. Verified live on a level-1 Mage: Minor Vitality Drain reads 2500 ms, 2 power, range 1500, "Inflicts 5 body damage and heals for 30% of the damage dealt."

- **The tooltip's wording is its own.** `SpellInfo.description` comes from the database and `spell.details.description` from the server's handler, and they differ: "Heals the target for 36" against "Heals the target for 38 hit points.", "increased by 123%" against "increased to 123% of normal". Test a regex on what the client really holds. A routine reading a tooltip's wording silently never fired on the database's.
- **A negative heal value is a percent of the caster's own full health,** not the target's (`HealSpellHandler.cs:33`): "Heals the target for 33% hit points." A Healer with 600 health heals 198 with it, on a tank of any size.
- **A negative `powerCost` or `info.power` is a percent of the pool:** Nature's Ward -8 costs 8 % of full power (`SpellHandler.cs` PowerCost). 267 spell rows, among them pets, skins and hybrid self-buffs.
- `info.target` is one of `Enemy`, `Self`, `Realm`, `Group`, `Pet` or `Corpse` (resurrection: `bot.resurrect`, learnings/death-and-rest.md).
- Common `info.type` values: `DirectDamage`, `Bolt`, `DamageOverTime`, `Lifedrain`, `Heal`, `BaseArmorFactorBuff`, `DamageAdd`, `DamageShield`, `SpeedDecrease`, `Mesmerize`.
- **Hybrid classes** (Fighter-type classes that later gain spells, and the Cleric/Acolyte line) keep their spells in the skills list instead of a spell line: `lineIndex` is -1 and `skillIndex` is set. `castSpell` handles both forms.

## castSpell

```typescript
const c = await bot.castSpell(nuke, mob);       // target: NPC, player, name, object id, or omitted (current target)
// c.completed, c.damage, c.resisted, c.castTimeMs, c.reason, c.retryAfterMs
```

1. Walks into range (85 % of the spell's range from the DB, else 1500) unless `approach: false`.
2. Selects the target every time, even when the state already shows it: the server drops our target when we die and doesn't tell the client, so the snapshot can show a stale one after a release. On "You must select a target" it selects again and retries once. Then it stops moving, stands up if sitting, and faces the target.
3. Casts, then waits for "You begin casting a X spell!".
4. Waits for completion. "You cast a X spell!" (SpellHandler.cs:1337) counts at once. Weaker evidence counts only once the cast time is up: a spell effect, a resist, "Your X hits" for this spell, or a bare "You hit the Y for N damage!". "Extra damage" and "additional" lines (damage adds, procs, crits) never count, and an interrupt after weak evidence still wins. `c.damage` sums only this spell's hits.

**Self** spells keep the current target. **Realm/Group** spells (heals, buffs) target ourselves when no target is given. Casting one on an enemy is refused with `invalid_target`; the server would give no answer at all.

**That costs a swing:** a swing reads our current target every tick (`AttackAction.cs:84`), so `castSpell` on a Group spell mid-fight loses the mob. For an instant Group spell while swinging, send it raw, `sdk.sendCastSpell(lineIndex, spellIndex)` or `sdk.sendUseSkill(skillIndex)` for a hybrid, and watch the effect yourself. A Realm spell with a mob selected stays out of this: the server refuses it silently.

| Reason | Meaning / what to do |
|---|---|
| `interrupted` | hit while casting ("The Y attacks you and your spell is interrupted!"); retry after `retryAfterMs` (~2 s) |
| `must_wait` | "You must wait N seconds to cast a spell!"; `retryAfterMs` says how long |
| `no_power` | out of mana: `bot.rest({ manaPercent: 90 })` |
| `out_of_range` / `not_visible` | approach failed or `approach: false`; walk closer and face the target |
| `no_target` | "You must select a target for this spell!" |
| `cooldown` | `spell.cooldownRemaining > 0` |
| `spell_not_found` | the message lists the spells we know |
| `died` | we died while casting ("You are dead and can't cast!" counts too); see [death-and-rest.md](death-and-rest.md) |
| `dead` | we were already dead before the cast; release first |

## Caster tactics

- **A swing at you interrupts a cast through a timer, at the halfway mark** (`SpellHandler.PerformDuringCastInterruptCheck`). Each swing that targets you starts a timer lasting until the attacker's next swing (`AttackComponent.cs:1110`), about 3.1 s on the mobs measured; if it's still running when the cast reaches halfway, the cast ends.
  - **So in melee a cast almost never lands:** a Warden tried 7 times and all 7 were interrupted, 5.1 s each.
  - **A mob below your level sometimes skips the timer,** 5 % per level (`GameLiving.cs:707`), so about 10 % at two levels below and never at your level or above.
  - **Past the halfway mark a swing doesn't interrupt** (`hard_interrupt_on_attacked` is off). Focus spells still do, and moving and crowd control still end a cast. An `Uninterruptible` spell ignores swings, not moving.
  - **Your own swing holds a timer too,** checked when the cast begins: "You must wait N seconds to cast a spell!" (`must_wait`). Stop swinging first, and the shared `heal` behaviour does.
  - **A swing at someone else sets nothing on you:** a Warden fighting beside a tank landed 13 heals out of 13 in two runs. A fighter who heals should hold the heal while a mob is on it and cast once the tank has the mob back.
- **Open from range:** buff yourself, nuke from as far away as the spell allows, then finish in melee or retreat. `bots/examples/caster.ts` does exactly this.
  - Don't walk into the camp first. Walking to a spawn point (tolerance 300) left a fresh Mage 255 units from a puny skeleton: one cast for 4 damage, two interrupts, then it died in melee.
  - caster.ts now stops 0.85 × range (1275 for Minor Vitality Drain) short of the spawn point. Live with a fresh level-1 Mage: target at 1412 units, four casts (3 + 5 + resisted + 2 damage) before the skeleton arrived, two interrupts, then a melee finish with the staff (+35 XP).
- **Mana is tiny at level 1:** a Mage starts with 10 power, and the drain costs 2. Rest for mana with `bot.rest({ healthPercent: 80, manaPercent: 80 })`, or in a grind with `restBelowMana: 30`.
- **There is no kiting helper.** Moving ends a cast, so step back, stop, then cast. At a walk it doesn't work, because mobs run as fast as we do.
- **Sprint away, then cast, does work alone.** Sprint makes about 246 units/s against 180-188 for a chasing mob, and a mob out of reach doesn't swing. Wait out its timer, and cast only when it can't arrive before your halfway mark. A Warden's 10 timed tries: with 0.3 s to spare 4 of 5 were interrupted, with 0.8 s 5 of 5 landed. Small sample, two spells, all from 82-87 % health. Measure the chaser from distance over time, not `npc.speed`, which read 72-130 for mobs closing at 188. In a group, go to the tank instead (`flee`).
- **Spec raises what a heal does, not just which you have.** Spells in a class's base line come with character level, whatever the spec (`Specialization.cs:163`; `isBaseLine` in `spelllines.json`): a Warden on Regrowth 1 got Minor Renewal at 3, Renewal at 4 and Revivification at 6. Each heal lands between 0.25 + (spec - 1) / spell level, at most 1.25, and 1.25 times its value (`HealSpellHandler.cs:230`), so Revivification (36) on Regrowth 1 can restore 9 to 45. Measured: 28 and 10.
- **A resist debuff matches one damage type, and on its own it rarely pays.** It only raises spells checked against that resist: a Mana Enchanter's Amplify Cold did nothing for his Heat nuke (76 per hit against 75). On a monster the gain is about 1.24 times its value, on a player half that (`ResistCalculator.cs:76-79`). Short ones lose damage for a lone caster because of the casts they cost: Amplify Heat +17 % per hit, -23 % per second; Empower Heat +61 % per hit, even per second. See [classes/enchanter.md](classes/enchanter.md).
- **A nuke off your spec line lands anywhere from 20.8 % of its base.** The minimum follows the spec of the spell's own line (`SpellHandler.CalculateLowerVarianceBound`): an Enchanter's level 24 Light baseline nuke at Light 1 hits for 26-127, mean 75, while Light 22's nuke of the same level range hits for 140. `/combatstats on` prints the base, the roll and its bounds for each hit.
- **Damage-add procs and other spells' DoT ticks during a cast** ("You hit X for N extra damage!") are no longer taken as completion or counted as damage (unit-tested, not re-run live).

## Crowd control: what repeats do

**A repeat doesn't shorten anything on a player. It does on a monster, for a mezz or a stun, and never for a root.** Verified live on 2026-11-03 with `sdk/test/live/cc-live.ts` (throwaway stack, level 12 Healers and a Shaman).

| | Player | Monster |
|---|---|---|
| **Mezz** | Full length. While it's on and for 60 s after it ends: "Your target is immune to this effect!" | Each repeat within 60 s of the first is shorter: full, then 1/2, 1/4, 1/6, ... |
| **Stun** | The same, on its own timer | The same as a mezz, on its own timer. Live, a 7 s stun: 7, 3.5, 1.75, 1.2, then immune |
| **Root or snare** | Full length, then 60 s of immunity. While it's on, a second cast answers "{name} already has that effect" | No limit, no shortening, no immunity |

- **Immunity is one per kind, on the target, whoever cast it** (`EffectHelper.cs:275-292`): a mezz, stun and root can all follow one another at once, as seen live. Roots and snares share one; a style's stun shares the spell stun's. A pet's stun gives none (`ECSGameSpellEffect.cs:73`).
- **It is a full refusal, not a reduction, and it starts when the effect ends** (`EffectListComponent.cs:936`, `ECSGameSpellEffect.cs:66-80`): ended by time or broken, the same. Live: a mezz's end at t = 0, still immune at 57.2 s, landed at 61.3 s. Power is spent all the same (`ImmunityEffectSpellHandler.cs:16`).
- **The 60 s for a mezz and a stun is a server property,** `immunity_timer_flat_length`, with `immunity_timer_use_adaptive` off (`CrowdControlECSEffect.cs:14-21`); a root's is fixed (`ECSGameEffect.cs:54`). A client can't read either.
- **The monster rule:** the first mezz or stun opens a 60 s window, not extended by more (`CrowdControlECSEffect.cs:79, 115`). A repeat lasts `duration / (2 * count)`, and under 1 s it answers immune (`ECSImmunityEffect.cs:38-56`). So a 28 s mezz takes 14 repeats. **A repeat onto one still on replaces it, without a word to anyone:** live, a mezz cast 6 s into a 28 s one ended 14 s after its own landing, so a second mezz cut about 8 s off. A mezz on a monster below 75 % health answers "Your target is enraged and resists the spell!" (`CCSpellHandler.cs:174`).
- **A root holds for half its length, then wears off** to full speed at its end (`ECSGameSpellEffect.cs:32`, `EffectService.cs:227-244`). Live, a 30 s root: 2 units/s for 15.3 s, full speed at 30.1 s. A rooted player can still swing and cast.

**What breaks what** (`GameLiving.cs:1676-1731`):

| | Melee hit | Melee that misses, or is parried, blocked or evaded | A spell's damage | A stun, root, or resist debuff spell |
|---|---|---|---|---|
| Mezz | breaks | breaks | breaks | breaks, **even a member's own root** |
| Root or snare | breaks (not an `UnbreakableSpeedDecrease`) | holds | breaks | holds |
| Stun | holds | holds | holds | holds |

**How long it really lasts varies:** a target's resist to the spell's damage type shortens it, and the caster's hit chance moves it (`ImmunityEffectSpellHandler.cs:36`, `CCSpellHandler.cs:76-90`). Up to 4 times the spell's duration. Don't take the spell's number as the end.

**What the server tells a client:**

| Line | Who gets it | `castSpell` |
|---|---|---|
| Landed, the spell's `Message2` ("{0} is entranced!", `SpellInfo.effectStarts`) | the caster at any range, others within 512 | `effectLanded: true`, `landedOn` |
| "Your target is immune to this effect!" | the caster | `effectImmune` |
| "{0} already has that effect. Wait until it expires. Spell failed." (`EffectListComponent.cs:595`) | the caster | `alreadyOn` |
| A resist | the caster | `resisted` (a root rolls this before its immunity: `SpeedDecreaseSpellHandler` checks in `ApplyEffectOnTarget`, so a resist says nothing about it) |
| Nothing: a monster's repeat onto one still on | | `effectLanded: false` |
| Ended, the spell's `Message4` ("{0} is no longer entranced.", `effectEnds`; empty for most roots) | **only those within 512 of the target** (`WorldMgr.INFO_DISTANCE`); the caster gets no copy of its own | |

- **All of these still count as `success: true`,** since the cast went off. To know it landed, read the fields above.
- **The name is its real one,** which an enemy's entry in the world state never shows: that goes by race. `landedOn` is how to learn it.

## Verified live

- Elementalist: a self buff, and a direct-damage nuke for 1–4 damage.
- Mage: the self buff "Ward Blow" ("A crystal shield covers you."), and Minor Vitality Drain (Lifedrain, range 1500, 2 power).
- Acolyte (Cleric line): a heal through the hybrid `useSkill` path.
- The interrupt and must-wait messages and their `retryAfterMs`.
- **Pulses** (258 spell rows of 27 types, not only a Bard's songs: Paladin, Skald, Warden, Minstrel, Reaver): one sent keeps going by itself. Sending it again stops it (`CastingComponent.cs:348`), and a new pulse ends the running one (`EffectListComponent.CancelIncompatiblePulseEffects`; focus damage shields, spell group 30, are exempt), so send once and leave it. Its effect can drop out between two pulses, so count it as running until a pulse is overdue. A Warden's Nature's Revenge was being switched off by its own resends; after that fix, 11 of 12 hits carried the extra damage.
- `sdk.findEffect` matches substrings, shortest name first: with only Lesser Bark Skin on, it passes for Bark Skin and the upgrade never gets cast. To tell ranks apart, compare `sdk.getEffects()` names exactly. `bots/examples/caster.ts` has this trap.
- Unverified: pets, ground-target spells (`sdk.sendSetGroundTarget`), concentration buffs (`state.concentrationEffects`), resists.
- Ground targets (from source, not live): when the gameserver has the zone's navmesh loaded, it silently drops a ground target more than 16 units off the mesh (`ground_target_snap_max_distance`). Take z from `navmeshGroundZ(regionId, x, y)` (exported from `sdk/actions.ts`), not `estimateZ`.
