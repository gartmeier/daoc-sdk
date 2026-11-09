# Paladin

Albion's tank: a weapon line, a shield and Parry, with chants for the group. For every chant, style and level on this server run `bun data/class-sheet.ts Paladin`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Paladin "Chants and sword"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/paladin.ts` is a tank that sings:

```typescript
import { paladin } from '../../sdk/classes/paladin';
export default paladin();
```

**Why: outside RvR, without it no chant ever plays.** The default tank list has no `song` (`rvrBehaviors` has had one since 2026-11-04), so Galahad's report showed no chant in 46 minutes, while his build spends its most points on Chants. Chant of Persistence is the only endurance song in the Camelot group, and styles stop silently below 15 % endurance ([group-coordination.md](../group-coordination.md)). The kit puts `song` above the fight, as it stands in the melee list.

- **What it plays:** in a fight Crusader's Defense (the armor kind), or Chant of Persistence while he is below 30 % endurance (`songs.enduranceBelow`). Out of a fight, Persistence. Refreshment and Battle Fury only if a build lacks the others, or with a twist (below). Beside a Cleric's Blessed Barrier the armor chant is the weakest of the four ("What each chant gives").
- **Verified, throwaway stack (2026-11-04):** his chants come through the skills list (`useSkill`), are instant, reach the group, and don't stop the swing. Three probes: 5, 6 and 6 hits in the 16 s before a chant, 6, 5 and 3 in the 16 s after it, and he never left attack state. An instant one goes out raw while he swings, so it doesn't lose the mob.
- **Twisting works on this server, and it costs endurance.** A new chant ends the running pulse (`CancelIncompatiblePulseEffects`), but what the old one already put on the group runs out by itself (Duration 5-6 s). Left alone, only the last one stays. `song` plays one; the kit's `twist` setting plays several ("Twisting").

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/paladin.ts` ([builds.md](../builds.md)). Multiplier 20, so 584 points by 24, and Slash and Chants have free levels. Levels the rule gives each build, lines in buying order:

| Character level | Points | Chants and sword: Chants / Shields / Slash / Parry | Two-Handed hybrid: Chants / Shields / Two Handed / Slash / Parry | Thrust and chants: Shields / Thrust / Chants / Parry |
|---|---|---|---|---|
| 10 | 94 | 10 / 1 / 9 / 1 | 8 / 1 / 10 / 4 / 1 | 1 / 8 / 10 / 1 |
| 20 | 404 | 20 / 9 / 18 / 1 | 17 / 1 / 20 / 10 / 1 | 1 / 20 / 20 / 1 |
| 24 | 584 | 24 / 15 / 18 / 8 | 20 / 10 / 21 / 15 / 4 | 15 / 21 / 21 / 5 |
| 30 | 914 | 30 / 24 / 18 / 8 | 30 / 16 / 21 / 15 / 4 | 30 / 21 / 21 / 5 |
| 40 | 1624 | 40 / 37 / 18 / 8 | 40 / 32 / 21 / 15 / 4 | 40 / 34 / 21 / 5 |
| 50 | 2979 | 48 / 42 / 39 / 23 | 43 / 42 / 39 / 31 / 4 | 42 / 44 / 46 / 12 |

Galahad plays Chants and sword. **Server code:** Parry opens at 15, Two Handed at 5. **Community, unverified:** Uthgard's PvE build is the first, its group RvR hybrid the second.

**Server code: Chants 24 buys nothing a role list casts, kit or no kit, above Chants 22.** Persistence is at 22; the two levels above it buy Crusader's Defense (23) and Aura of Indestructability (24), both unused below. A character who won't get those used could move those 47 points to Slash, where his damage is the lowest of the three tanks. Not tried.

Promotion at 5 takes two keywords: `join the Church of Albion`, then `slashing` for Sword of the Initiate (**verified**, Lord Prydwen).

## What each chant gives

**Verified,** throwaway stack, 2026-11-04, `sdk/test/live/chant-twist-live.ts`: Chants 24, Slash 18, the level's template gear, 3.36 s swings, Uppercut queued every swing. A level 24 Warrior hit the Cleric while he hit the Warrior. Chants run at effectiveness 1.25 ("Effectiveness (spec): 1.25"), so the sheet's numbers are low.

| Chant | Reach | Recast | Measured |
|---|---|---|---|
| Crusader's Defense | 1500 | 8 s | The AF the server reads on the Cleric goes 62.4 → 77.6, and a hit on her from about 49 to 41 (-19 %). **With her own Blessed Barrier up: AF 71 → 77.6, a hit from 42.6 to 40.0 (-6 %).** Same effect group, and the higher one counts. Melee only. |
| Crusader's Refreshment | 1500 | 8 s | 21 on each hurt member per cast or pulse, every 6 s: 126-147 in 45 s on the Cleric alone. Only in a fight. |
| Battle Fury | 1500 | 8 s | About 15 extra on each swing that lands, so 86 on top of about 270 in 45 s (+30 %). Only members who swing use it. |
| Chant of Persistence | **1000** | none | A style every swing (10 endurance each) and still 93-100 % after 45 s; without it he is out after 30-35 s. 7 power per pulse: 19 % of 190 in 45 s. |

Blessed Barrier is in a Cleric's plan for every role ("specaf", `buffs.ts`), so in Camelot the fight's default chant is probably the -6 % line. Not checked on Nimue herself.

## Twisting

**A chant costs 5 endurance on each cast, and a pulse costs nothing** (`SpellHandler.CalculateEnduranceCost`, any spell without its own). With no style, 100 % stayed 100 % over 30 s without chants and fell to 40 % with a chant every 2.7 s. So the earlier "for free" was wrong, and the rhythm matters more than the number of chants. A chant cast just after its pulse stays up 12 s on one cast.

**Verified,** same setup, 45 s on a training dummy, a style queued every swing:

| Rhythm | Swings | Styles | Endurance after | Time on the Cleric |
|---|---:|---:|---:|---|
| none | 13-14 | 10 | 0 (from about 30 s) | |
| hold Battle Fury | 14 | 9 | 5 | Fury 100 % |
| hold Persistence | 12-14 | 11-13 | 93-100 | Persistence 100 % |
| 3 chants every 2.7 s | 13 | 5 | 0 (from about 20 s) | armor 78, heal 72, Fury 66 |
| 4 chants every 2 s | 12 | 6 | 0 | armor 78, heal 74, Fury 69, Persistence 55 |
| 3 chants every 1 s | 14 | 5 | 0 | heal 98, others 67; 20 "must wait", 5 chants cancelled by sending the running one |
| armor, Fury every 6.1 s | 13 | 7 | 0 | armor 99, Fury 87 |
| 3 chants every 6.1 s | 14 | 7 | 0 | armor 74, heal 61, Fury 49 |
| Persistence, Fury every 6.1 s | 14 | **14** | 33 | Persistence 82, Fury 86 |
| Persistence, Fury, heal every 6.1 s | 14 | 14 | 3 | Persistence 61, Fury 62, heal 49 |
| kit `CHANT_TWIST` | 13 | 10 | 16 | Fury 80, heal 55, Persistence 38 |
| kit, 3 chants every 2.7 s | 13 | 8 | 5 | armor 54, heal 53, Fury 41, Persistence 52 |

Against the Warrior, 45 s, one or two runs each, and her 9-12 hits vary:

| Rhythm | She took | A hit | His extra | She was healed | His styles |
|---|---:|---:|---:|---:|---:|
| none | 540, 585 | 49 | 0 | 0 | 6, 8 |
| hold armor | 404, 458 | 41 | 0 | 0 | 7, 6 |
| hold heal | 494, 485 | 49 | 0 | 147, 126 | 7, 8 |
| hold Fury | 495 | 49 | 86 | 0 | 6 |
| 3 chants every 2.7 s | 428, 421 | 42 | 82, 74 | 84, 105 | 4, 3 |
| kit `CHANT_TWIST` | 494 | 49 | 87 | 84 | 7 |
| kit, Fury and armor every 6.1 s | 476 | 43 | 97 | 0 | 9 |
| kit, 3 chants every 6.1 s | 423 | 47 | 44 | 63 | 9 |
| kit, 3 chants every 2.7 s | 435 | 44 | 18 | 63 | 6 |

- **Swings:** none lost, and he never left attack state (0 of about 180 samples in every case).
- **Styles:** a twist costs them only by spending endurance; hold or twist, he lands one on every swing until he runs low. On a Warrior a style is worth little, though: 33-36 a hit with half his swings styled or nearly all. 5 endurance on Battle Fury buys about 27 damage, against 10 on Uppercut for a few.
- **Who gets them:** the same on the Paladin, the Cleric beside him and a Sorcerer at 1200, within 1-2 points in every rhythm, except that Persistence never reached the one at 1200. At 1700, nothing.
- **Recast:** three of them wait 8 s on themselves, so with a 6 s effect none passes about 78 % in a steady rotation. A refused one ("must wait") ends nothing.

**Is it worth playing?** A slow twist, yes; a fast one, no. Compared with today's armor chant in a group with Blessed Barrier, `CHANT_TWIST` trades about 6 % of the melee damage on one member for +30 % on his own and 21 HP per hurt member every 8-12 s, and armor doesn't touch a caster's spells at all. The fast one has the most on at once for its first 20 s, then lives at about 10 % endurance with Persistence taking its turns, which also leaves no endurance to sprint with. **No group round has been played with it,** so a Camelot round is the real test. Three 4-minute fights on starter gear (`TWIST=... rvr-routines-live.ts`) showed it runs inside the real `tank()` with no errors and sent 2, 7 and 33 chants for off, slow and fast, but those fights differ too much to compare: 112, 65 and 141 s engaged.

To turn it on, in `bots/<bot>/character.ts`:

```typescript
import { paladin } from '../../sdk/classes/paladin';
import { CHANT_TWIST } from '../../sdk/group/songs';
export default paladin({ twist: CHANT_TWIST });
```

- **How it runs:** `twisting` (`sdk/group/twist.ts`) wraps his fight in a clock. `tank()` holds its turn for a whole kill, up to 90 s, so `song` gets no turn there: that is why he sent 7 chants in 7 minutes. It sends only while he swings, never the running chant, and an endurance chant goes first while he is below `songs.enduranceBelow`, in the order or not. Between fights `song` plays as before.
- **A group's own fight:** the kit's fight is a plain `tank()`, so a group that gives `tank` a style in its list loses that with `twist`.

**Other songs, by the rows in the DB; not tried, and nothing changed for them:**

- **Skald:** yes, the same mechanics. Damage, health and speed are all instant with an 8 s recast, but last 5 s, so a pulse-timed rhythm is about 5.1 s.
- **Warden:** its damage chant is instant, its speed song isn't.
- **Minstrel:** only its ablative is instant.
- **Bard:** its regeneration and speed songs take 3 s to cast, which stops the swing and which `nextTwist` leaves out. Only its resist songs are instant.

## Which style

**Verified,** at 24 his damage style is Uppercut (Slash 6, anytime, 10 endurance): 37 landed in 46 minutes of RvR. Enrage (Slash 8) is the taunt and Reflect (Slash 12) a detaunt, which the name doesn't say. `tankStyles` reads them from the server, as it does for a Warrior ([warrior.md](warrior.md)). Slash 18 reaches Riposte, a reaction, and Shields 15 Numb, Stun and Disable, which the plain `tank` doesn't use ([hero.md](hero.md)).

**Verified, PvE.** Tank hold 96-100 % at the bloated spiders, six hunts and 0 deaths. Chain from 10, plate from 20 ([merchants.md](../merchants.md)).

## What the reports show

**Verified,** six Camelot RvR rounds at level 24, 46 minutes, to 2026-11-03 21:48, beside [hero.md](hero.md)'s table of the three tanks:

| Deaths | Damage a minute | Styles landed | Targeted | `kill:out_of_reach` | `kill:timeout` | `kill:crowd_controlled` |
|---|---:|---:|---:|---:|---:|---:|
| 3 | 140 | Uppercut 37 | 22 % | 15 | 13 | 10 |

The fewest deaths of the group, with the lowest damage of the three tanks: Slash 18 against a Hero's Blades 24 and a Warrior's Axe 24. Template health is 616.

## Self AF (kit, from arena round 5, 2026-11-09)

**Server code.** Aura of Indestructability (Chants 24, value 37, 17 power, 20 minutes; Aura of Defense at Chants 17) is a `PaladinArmorFactorBuff`: its own effect group (`PaladinAf`, EffectHelper.cs) in the uncapped `OtherBuff` category (SingleStatBuff.cs), so it adds to Crusader's Defense and to Nimue's AF buffs. `buff()` doesn't slot that type, so the kit's `selfBuff` chore (`sdk/classes/paladin.ts`) casts it between fights when no rank of it is on him. Not yet seen in a round: look for `buff` results naming it in his first Camelot round after commit.

## Community, RvR at 20-24 (research 2026-11-09)

- **Recasting a running chant turns it off** (**server code**, CastingComponent.cs:350). The heal chant works in combat only (CombatHealSpellHandler.cs).
- **A taunt starts the interrupt timer on its target** (**server code**, TauntSpellHandler.cs:30). Instants skip the interrupt check (SpellHandler.cs:597, :603). So Aggravate (Chants 15, instant, range 1350, every 30 s) interrupts an enemy caster from range without stopping his swing. Not used yet.
- **Unverified:** keep the endurance chant up. Skip the AF chant when a Cleric's AF is on the group. Put shield stuns on the enemy healer or caster, never on a mezzed or stun-immune one. Guard the Cleric and peel melee off her. Sources: https://forums.freddyshouse.com/threads/paladin-chants.217766/, https://www.camelotherald.com/node/203

## Not supported yet

All of these are his and no behaviour casts them:

- **Crusader's Refreshment** (Chants 20), a group heal pulse: a `combatHeal` song, which gets a turn only with a twist. It heals nobody out of combat (`CombatHealSpellHandler`), so it isn't a between-fights `health` song.
- **Aggravate** (Chants 15), an instant taunt at range 1350, every 30 s. It would peel an add without walking.
- Only one pulse plays at a time ([spells.md](../spells.md)), so without a twist (above) endurance, heal, AF and damage are a choice. Crusader's Defense counts as a spec AF, capped at level x 1.875 (45 at 24; `ArmorFactorCalculator`), so its 61 gives 45 at most.
