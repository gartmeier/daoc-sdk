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
- `info.target` is one of `Enemy`, `Self`, `Realm`, `Group` or `Pet`.
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
- **Damage-add procs and other spells' DoT ticks during a cast** ("You hit X for N extra damage!") are no longer taken as completion or counted as damage (unit-tested, not re-run live).

## Verified live

- Elementalist: a self buff, and a direct-damage nuke for 1–4 damage.
- Mage: the self buff "Ward Blow" ("A crystal shield covers you."), and Minor Vitality Drain (Lifedrain, range 1500, 2 power).
- Acolyte (Cleric line): a heal through the hybrid `useSkill` path.
- The interrupt and must-wait messages and their `retryAfterMs`.
- **Pulses** (258 spell rows of 27 types, not only a Bard's songs: Paladin, Skald, Warden, Minstrel, Reaver): one sent keeps going by itself. Sending it again stops it (`CastingComponent.cs:348`), and a new pulse ends the running one (`EffectListComponent.CancelIncompatiblePulseEffects`; focus damage shields, spell group 30, are exempt), so send once and leave it. Its effect can drop out between two pulses, so count it as running until a pulse is overdue. A Warden's Nature's Revenge was being switched off by its own resends; after that fix, 11 of 12 hits carried the extra damage.
- `sdk.findEffect` matches substrings, shortest name first: with only Lesser Bark Skin on, it passes for Bark Skin and the upgrade never gets cast. To tell ranks apart, compare `sdk.getEffects()` names exactly. `bots/examples/caster.ts` has this trap.
- Unverified: pets, ground-target spells (`sdk.sendSetGroundTarget`), concentration buffs (`state.concentrationEffects`), resists.
- Ground targets (from source, not live): when the gameserver has the zone's navmesh loaded, it silently drops a ground target more than 16 units off the mesh (`ground_target_snap_max_distance`). Take z from `navmeshGroundZ(regionId, x, y)` (exported from `sdk/actions.ts`), not `estimateZ`.
