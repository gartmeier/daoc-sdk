# Champion

Hibernia's Valor hybrid: scale armour, a large weapon, and instant debuffs, a snare and a nuke. For every spell and style on this server run `bun data/class-sheet.ts Champion`; for what a build reaches, `bun sdk/classes/reach.ts Champion "Valor and Large Weapons"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/champion.ts` (2026-11-12, R7):

```typescript
import { champion } from '../../sdk/classes/champion';
export default champion();
```

- **Role melee** (`roleForClass` gives it too). For `lineup.ts`: **melee**; scale armour and a big weapon, a damage slot beside the Hero.
- **Fight:** `assist({ melee: true, holdMs: 0, style: championStyle })`. Its short turns leave room for the instants above it, as the Thane's fight does against players.
- **`championStyle`** (`kitStyle`, `sdk/classes/hybrid.ts`): at a player, Frontal Assault first (from the front, a 60 % snare for 19 s) whenever the last one has run out, with the earned reaction or the plain swing behind it. The plain swing at a player is Celtic Fury, 117 growth for 10 (a taunt's growth is damage, `StyleProcessor.cs:360-363`), against Domination's 86 for 15. The parry chain Celtic Rage, Hibernian Vigor (2 s stun) and the side one Hibernian Force, Obliteration (attack speed -18 %) are `fighterStyle`'s.
- **`interrupt()`** (instant, above flee): the shared behaviour casts Blast of Defiance (61 damage, instant, range 1500, 15 s timer; `Spellbook.interrupts()` takes instant direct damage) at a casting enemy, healers and casters on our support first. The Thane's Horn does the same (thane.md: 2-8 interrupts a round).
- **`snareFocus`** (react): Lumber, a 40 % snare for 68 s, instant, range 1500, on a focus player more than 450 away.
- **`enervate`** (react): Enervation, strength and constitution -43 for 60 s, instant, range 1000, on a focus player read as melee or tank (`classGuess`), above 30 % health; once per 55 s per target by our own casts.
- **`buff()` keeps** Focus of the Champion (strength and constitution) on him.

## Gear and build

R6's bot plays **"Valor and Large Weapons"**: Valor 24, Large Weapons 23, Parry 4 at 24 (`data/builds/champion.ts`). The gear template gives a large weapon in the two-hand slot and scale (Champion scale from 20, HibArmor 4).

- **He starts as a Guardian**, which upstream's dump left unarmoured (CLAUDE.md "A Guardian ... dies to level-1 mobs"). R6 checks the armour; the template's scale replaces it anyway.

## Styles at Large Weapons 23

| Style | Level | Opening | End | Effect |
|---|---|---|---|---|
| Celtic Might | 2 | anytime | 15 | value 4.5 |
| Celtic Rage | 4 | after his parry | 5 | growth 180 |
| Celtic Fury | 6 | anytime | 10 | **taunt**, value 11.7 |
| Hibernian Wrath | 8 | anytime | 10 | detaunt |
| Hibernian Force | 10 | side | 10 | bleed |
| Hibernian Vigor | 12 | after Celtic Rage | 10 | **stun 2 s** |
| Domination | 15 | anytime | 15 | value 5.7 |
| Obliteration | 18 | after Hibernian Force | 10 | attack speed -18 % 20 s |
| Frontal Assault | 21 | front | 15 | **60 % snare 19 s** |

## Valor at 24, data

Blast of Defiance (61 damage), Lumber (snare 40 %, 68 s), Enervation (str/con -43), Capitulation (dex/qui -39), Major Demoralization (attack speed -10 %): all instant, all reaching 1000-1500. Focus of the Champion is the self buff (3 s cast).

## Verified

**Verified, throwaway stack, 2026-11-12 (`sdk/test/live/kits-r7-live.ts`):** three realm groups at 24 in the Thidranki template, each with a healer, on the rvr-roam lists, four fights of 120-240 s. The probe `sdk/test/live/kit-probe-r7.ts` on R6's real character showed the same style details from the server as the tests' fixtures, and the same first picks.

- Blast of Defiance interrupted 2-8 times a fight through `interrupt()`. Enervation landed 1-4 times, Lumber 1-2 (the rest immune or resisted); the Savage on the other side ended one fight wearing both. Frontal Assault landed in two fights, Celtic Fury 1-3 a fight. Damage 282-1234.
- Live on Fergus from 22:30: read the sortie logs.

## Open

- **Which debuff on whom.** The kit casts only the str/con debuff, and only on melee. Capitulation (dex/qui) on a caster and Demoralization on a melee are untried.
- **Frontal Assault from the front only:** on a foe that is on him he stands in front; on one hitting someone else the swing goes to the backup.
- Blast of Defiance on the focus when nobody casts (61 every 15 s) is left out, so it is ready for an interrupt, as the Thane's Horn.
