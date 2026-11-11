# Eldritch

Hibernia's Light/Mana/Void list caster: cloth, the hardest single-target nukes of the three Hibernian casters at 24, a stun and an area mezz. For every spell and level on this server run `bun data/class-sheet.ts Eldritch`; for what a build reaches, `bun sdk/classes/reach.ts Eldritch "Light nuker"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/eldritch.ts` is the nuker's list with these of its own (tested in `sdk/classes/eldritch.test.ts`):

```typescript
import { eldritch } from '../../sdk/classes/eldritch';
export default eldritch();
```

- **Nukes from the Light lines only.** He is given every Void baseline spell up to his level, at Void 1, where the server rolls a spell's damage down to about 21-60 % of its listed value (`SpellHandler.cs:2748-2763`). With the pack's `strongestNuke` the Spellbook ranked Void Fissure (115 listed, about 69 at Void 1, 20 s timer) first whenever it was ready. The kit sees damage spells only from `ELDRITCH_NUKE_LINES` (the Runemaster kit's `onlyLines` view): Shadowcrash, then Sun Streak.
- **Prismatic Flash** (Way of the Sun, 2.5 s, 9 power, 5 s stun) as the Mentalist kit throws it: `stunCaster` at a caster on our Bard or healer, `quickFlash` with Quickcast on a melee on him. Prismatic Flash is the Mentalist's baseline too ([mentalist.md](mentalist.md)).
- **`veil`: Paralyzing Veil, his own area mezz.** Shadow Control 15, 3 s, 9 power, radius 350 round the target, 15 s. Cast when it catches two or more free enemy players, none of them the focus (our damage would wake them) nor another member's crowd-control assignment, at most once per 20 s, above 25 % power, never with a melee or pet on him. Everyone caught is marked crowd-controlled on the board, so the group's damage keeps off them.

**Why the kit casts the mezz itself (shared code, 2026-11-10).** Until 50c844b the line-up picker (`lineup.ts` `hasMezz`) counted any Mesmerize, so it took him as a line-up's crowd controller. But `Spellbook.capabilities()` counts only a single-target mezz or a root, so he has `cc: false`: the coordinator never assigns him, and `crowdControl` drops every target. Round 123: 16 nukes, no mezz. Since 50c844b (coordinator, 2026-11-10 night) the picker agrees: `hasMezz` counts only a single-target mezz, so a line-up no longer takes him as its mezzer, and his area mezz stays the kit's own.

**To look for:** Shadowcrash among his nukes and no Void Fissure, `cc` results "Paralyzing Veil on N", and nothing of ours hitting what the veil caught.

## What he has at 24

**Server code.** Lugh's build: Light 22, Mana 9 (Void 1). Average damage against a level-24 target, the lowest roll about 91 % of listed at Light 22, 48 % at Mana 9, 21 % at Void 1:

| Spell | Line (live name) | Listed → avg | Cast | Power | Range | Notes |
|---|---|---|---|---|---|---|
| Shadowcrash | Shadow Control 22 | 102 → ~97 | 2.8 s | 13 | 1500 | cold; 35 damage per cast second, 7.5 per power |
| Sun Streak | Way of the Sun 21 | 88 → ~84 | 2.6 s | 15 | 1500 | heat |
| Void Fissure | Way of the Eclipse | 115 → ~69 | 2.5 s | 13 | 1875 | bolt (can be blocked), 20 s timer |
| Prismatic Flash | Way of the Sun | stun | 2.5 s | 9 | 1500 | 5 s |
| Paralyzing Veil | Shadow Control 15 | area mezz | 3 s | 9 | 1500 | radius 350, 15 s |
| Nullify Sight | Shadow Control 19 | nearsight | 2 s | 9 | 2300 | their range −35 %, 120 s |
| Abrogate Coordination | Shadow Control | dex/qui −36 | instant | 8 | 1500 | 60 s |
| Greater Ensnaring Blast | Vacuumancy | 37 + 40 % snare | 3 s | 6 | 1500 | any damage ends the snare |
| Mana Ripple | Vacuumancy | 52, radius 300 | 2.5 s | 5 | | around himself |

Self buffs: Powershield (AF), Barrier of Negation (bladeturn), Aura of Reflection (damage shield on a realm-mate). Quickcast.

The live line names differ from the data's: "Light Magic" is Way of the Sun (baseline) and Shadow Control (spec); "Mana Magic" Way of the Moon and Vacuumancy; "Void Magic" Way of the Eclipse and Void Mastery (verified from Lugh's skill list, 2026-11-10).

**How a mezz holds (server code):** any melee swing, a miss too, breaks it (`GameLiving.cs:1702`), any spell damage (`:1713`), nearsight, disease, snares, stuns and resist debuffs even without damage (`:1716-1727`); on a player a resisted spell other than a mezz too (`:1729`). A mezzed player is immune to another (`CCSpellHandler.cs:165-167`), and after one ends immune for 60 s (`CrowdControlECSEffect.cs:14-21`).

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/eldritch.ts` ([builds.md](../builds.md)). Lugh plays Light nuker: at 24 Light 22, Mana 9.

## Arena

**Before the kit** (generic nuker list): round 121 (2026-11-10) 4 nukes, 431 damage, died; round 123 16 nukes, 1,952 damage, first nuke 1.2 s, no mezz.

**With the kit** (2026-11-10 night): rounds 127 (solo, not grouped), 128, 129, 133, 134, 137. Against Midgard 11-13 nukes a round at 144-154 a nuke (122 before the kit, with Void Fissure in his picks). Against Albion he is their target every round (128, 133, 137: in melee 27-81 %, targeted 39-78 %, 2-3 nukes, died in two); the veil tried twice (a hill, an enemy pet's interrupt) and never landed. Since then the veil waits while any enemy aims at him (`unlessAimedAt`).

**Verified, with the kit** (37 rounds, 127-223, the night of 2026-11-10/11; numbers from `groups/hibernia/runs/*.md`):

- **Hibernia won 27 of the 37** (by wipe or holding the cap): 13 of 18 against Camelot, 14 of 19 against Midgard.
- **Nukes:** 428 in all, about 12 a round. Shadowcrash and Sun Streak; Void Fissure is gone.
  - 43 were interrupted.
  - 38 were out of range and 19 out of sight. Most came while the last enemies held back, with idle "focus out of reach, holding ground", up to 72 % in round 213.
  - His best rounds were against Midgard: 52 nukes and 4,335 damage in round 167, and 39 nukes and 5,126 damage in round 191.
- **Against Albion he is the target:**
  - He died in 10 of 18 Camelot rounds: 128, 133, 147, 162, 190, 192, 205, 208, 214 and 223.
  - He was targeted 36 % of fight time on average and in melee 23 %, up to 81 % in rounds 133 and 208.
  - He dealt 1,018 damage a round, against 2,111 against Midgard, where he died in 6 of 19.
  - Albion reads him as a caster and dives casters first.
- **The Flash:** 78 stuns. 20 were refused with `must_wait`: the server still held his casting after an interrupt. 11 were interrupted. Since 6cf6f96 it is Prismatic Flash (5 s), not Flare (3 s); [mentalist.md](mentalist.md) has the details.
- **The veil:** 8 tries in 37 rounds, and it landed twice (171, 180). Four were interrupted, one out of sight, one out of range and one resisted. Since a961482 it waits while anyone aims at him, so in the Albion rounds it hardly ever comes.

## Open

- **His placement against Albion's caster-first rule.** He stands with the nukers in the private `groups/hibernia/rvr.ts` `ALBION_FORMATION` (nukers 550 back at ±1.3 rad), and that is still within one dive. Not changed in the night. To try: farther back against a caster-first enemy, the tank's Intercept ([blademaster.md](blademaster.md)), or the Abrogate below.
- **The Flash's `must_wait`** (20 of 78), "You must wait N seconds to cast a spell!": the stun was tried while the server still held his casting (1-3 s after an interrupt). The result carries `retryAfterMs`. `stunCaster` and `quickFlash` could hold the stun until then rather than try it and lose the turn. It happens to Niamh too.
- Nullify Sight on their main caster or healer at the opening (2300 range, beyond their 1500): no behaviour casts it, and it breaks a mezz in its target.
- The instant Abrogate Coordination on a melee chasing him (the Enchanter kit's `dazzle` pattern).
- His standing range: 1300-1450 from the focus keeps him in reach (round 123: moving 51 % of the fight).
