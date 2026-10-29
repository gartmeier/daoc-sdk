# Spells

## What you know

```typescript
const spells = sdk.getSkills().spells;          // name, level, lineName, lineIndex, spellIndex, cooldownRemaining
const nuke = sdk.findSpell(/bolt|blast|drain/i);
const info = bot.getSpellInfo(nuke);            // from the DB: type, target, range, power, castTime, damage, ...
```

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

- **Melee interrupts every cast.** A level-1 caster with a mob in melee range can't finish a cast.
- **Open from range:** buff yourself, nuke from as far away as the spell allows, then finish in melee or retreat. `bots/examples/caster.ts` does exactly this.
  - Don't walk into the camp first. Walking to a spawn point (tolerance 300) left a fresh Mage 255 units from a puny skeleton: one cast for 4 damage, two interrupts, then it died in melee.
  - caster.ts now stops 0.85 × range (1275 for Minor Vitality Drain) short of the spawn point. Live with a fresh level-1 Mage: target at 1412 units, four casts (3 + 5 + resisted + 2 damage) before the skeleton arrived, two interrupts, then a melee finish with the staff (+35 XP).
- **Mana is tiny at level 1:** a Mage starts with 10 power, and the drain costs 2. Rest for mana with `bot.rest({ healthPercent: 80, manaPercent: 80 })`, or in a grind with `restBelowMana: 30`.
- **There is no kiting helper.** Moving interrupts casting, so step back, stop, then cast. This is unverified as a working tactic at low level, because mobs run as fast as we do.
- **Damage-add procs and other spells' DoT ticks during a cast** ("You hit X for N extra damage!") are no longer taken as completion or counted as damage (unit-tested, not re-run live).

## Verified live

- Elementalist: a self buff, and a direct-damage nuke for 1–4 damage.
- Mage: the self buff "Ward Blow" ("A crystal shield covers you."), and Minor Vitality Drain (Lifedrain, range 1500, 2 power).
- Acolyte (Cleric line): a heal through the hybrid `useSkill` path.
- The interrupt and must-wait messages and their `retryAfterMs`.
- Unverified: pets, ground-target spells (`sdk.sendSetGroundTarget`), concentration buffs (`state.concentrationEffects`), resists.
- Ground targets (from source, not live): when the gameserver has the zone's navmesh loaded, it silently drops a ground target more than 16 units off the mesh (`ground_target_snap_max_distance`). Take z from `navmeshGroundZ(regionId, x, y)` (exported from `sdk/actions.ts`), not `estimateZ`.
