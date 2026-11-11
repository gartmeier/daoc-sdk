# Wizard

Albion's elemental nuker: Cold, Earth and Fire lines, cloth, Quickcast. For every spell and level on this server run `bun data/class-sheet.ts Wizard`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Wizard Ice`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/wizard.ts` is a nuker that survives a dive:

```typescript
import { wizard } from '../../sdk/classes/wizard';
export default wizard();
```

- **`instant`: `quickcastUnderFire()`** (the Cabalist's, `cabalist.ts`): with a melee on her or her last cast cut short, Quickcast and one spell that can't be interrupted, her cc assignment's root or else Ice Blast on the focus. Once per 30 s, at twice the power. No `meleeDebuff`: she has no instant spell.
- **`react`: `giveGround()`** (the Theurgist's): every cast she has is 2.5-3 s, so with a melee on her each is cut. Beside the tank she steps round him, away from them, instead of casting.
- **`fight`: `nukerFight(saveBelow, offFocus)`**, the list's `assist` and the Cabalist's `offFocus`, both casting from `plainNukesFirst`: her spells without Entangling Haze (below). Options `saveBelow` (0, no floor, as Camelot plays the arena), `offFocus`, `giveGround`.
- **No `selfBuff`:** both her self buffs, Emerald Shield (AF 124) and Aura of Incineration (an absorb), have a slot `buff()` keeps up.

## At 24, Ice (Cold 24, Earth 1, Fire 1)

`bots/vivien/build.ts` is `data/builds/wizard.ts` "Ice": Cold 24 and nothing else by 24, Earth and Fire stay at 1.

**Server code**, by `reach.ts`:

| Spell | Line | What | Cast | Power | Range | Who casts it |
|---|---|---|---:|---:|---:|---|
| Ice Blast (Minor) | Cold 24 | 88 cold | 2.6 s | 15 | 1500 | `assist`, `offFocus`, quickcast |
| Entangling Haze (Minor) | Cold 24 | 88 cold, 35 % snare 30 s | 3 s | 15 | 1500 | none: the kit leaves it out |
| Searing Gust | Cold | 76, cold resist -10 % 20 s | 3 s | 13 | 1500 | none |
| Steaming Blast | Cold | 133 around her, radius 300 | 2.5 s | 12 | 0 | none (`pickNuke` takes no range-0 spell) |
| Sweltering Cloud | Cold | 62 in 350, with a debuff | 3 s | 18 | 1500 | none (RvR runs `aoe: false`) |
| Fingers Of Ice (Lesser) | Cold | root 38 s | 2.5 s | 13 | 1500 | `crowdControl` |
| Flaming Rocks (Minor) | Fire 1 | bolt 115, 20 s recast | 2.5 s | 13 | 1875 | none |
| Fire Storm (Major) | Fire 1 | 85 heat | 2.6 s | 14 | 1500 | none |
| Emerald Shield, Aura of Incineration | Earth, Fire | self AF 124, self absorb | 3-4 s | | | `buff` |
| Earthen Burst, Minor Shield of Magma | Earth | damage add 5, damage shield 0.7, on others | 3-4 s | | 1000 | `buff` (on the tanks) |

- **Why Haze is left out:** it ties Ice Blast on spell level (24), and `pickNuke` breaks a tie by the skill list's order. It is 0.4 s slower for the same damage and power, and its snare ends at the next hit, which on the group's focus comes at once. `plainNukesFirst` keeps it only if she has no plain direct damage.
- **Fire 1 is weak:** the damage roll's floor at spec 1 against a level 24 target averages about 60 % of the listed number (`SpellHandler.cs`). A bolt is worse against players: half of it goes against armour, a block or guard cancels that half, and each enemy meleeing the target takes 20 % off its chance (`BoltSpellHandler.cs`). So Flaming Rocks stays unused, and `strongestNuke` (the pack's `byDamage`) would open with it: don't set it for her.
- **Any spell damage ends a mezz or a root near it** (`GameLiving.cs`): Steaming Blast or Sweltering Cloud beside our Sorcerer's area mezz would wake it. That is why neither is in the kit yet.

## Arena

**Verified,** round 122 (2026-11-10, against Midgard, lost 0 / 6), on the plain nuker list without the kit: 929 damage, the group's highest, 8 nukes and 3 roots, first nuke 3.6 s after the engage; in melee 34 % of the fight, targeted 12 %, died once ("walk: died", en route). In that round `rootMelee` gave her root assignments on their melee (she is a member whose only crowd control is a root).

**Verified, with the kit,** arena rounds 130-165 (2026-11-10/11), 14 rounds: 1452 damage a round, the most of any Camelot member (Morgana 731, Taliesin 688 in the same rounds), up to 2696 (round 161); 170 nukes, 21 Quickcasts, 10 roots on assignments; targeted 28 %, in melee 27 % of fight time; 0.50 deaths a round, the fewest with the Cabalist. She runs dry in long fights (round 151: 5 casts refused for power, idle 16 % on it). Wins with her: 130, 143, 146, 151, 161, 162, 165.

## Open

- Which nuke `assist` cast live before the kit (Ice Blast or Haze): the round's nuke lines don't name the spell. With the kit it is Ice Blast either way.
- Steaming Blast with Quickcast when two or more enemy players are on her (133 each, 24 power), away from anything under crowd control: a kit option to try once her deaths in melee are counted.
- Searing Gust on the focus every 20 s: the 10 % on the next Ice Blasts is worth about 40 damage per 20 s, and whether a recast refreshes it is unchecked.
- Roots against nukes: each root assignment is an Ice Blast lost. Camelot's tactics keep its Cabalist on damage against two healers; the same may pay for her.
- How often the group waits for her power over a round (15 a nuke, no floor).
