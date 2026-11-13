# Reaver

Albion's flex-and-shield melee with Soulrending magic: chain, a flexible weapon, a large shield, a lifedrain, point-blank auras and a damage add. For every spell and style on this server run `bun data/class-sheet.ts Reaver`; for what a build reaches, `bun sdk/classes/reach.ts Reaver "Flex, shield and tap"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/reaver.ts` (2026-11-12, R7):

```typescript
import { reaver } from '../../sdk/classes/reaver';
export default reaver();
```

- **Role melee** (`roleForClass` gives it too). For `lineup.ts`: **melee**. Chain and a shield: he can take a hit, but he has no taunt the tank list would use well and the kit plays him as damage.
- **Fight:** `assist({ melee: true, holdMs: 0, style: reaverStyle })`.
- **`reaverStyle`** (`kitStyle`, `sdk/classes/hybrid.ts`): at a player, Disable first once per stun immunity (shield, from the side, 4 s), with the earned reaction or the plain swing behind it. The reactions are `fighterStyle`'s: Viper after his block (Flexible, a 5 s stun, then Copperhead's attack speed -21 %) and Kingsnake after his parry (then Tigersnake). Viper, Stun and Numb start the same immunity as Disable. The plain swing at a player is Diamondback, 115 growth for 10 (a taunt, and a taunt's growth is damage: `StyleProcessor.cs:360-363`).
- **`interruptWith(['Lifedrain'])`** (instant, above flee): the shared `interrupt()` with Vitality Siphon (52 damage that heals him, instant, range 1000, 30 s timer) counted as an interrupt. `Spellbook.interrupts()` takes only direct damage and amnesia; a lifedrain hurts the same, and damage starts the interrupt timer.
- **`surge`** (react): Surge of Maiming, damage add 8.1 for 30 s, 150 s to reuse, instant, in the engage with the focus within 350.
- **`aura`** (react): Demolishing Aura, 19 damage to every enemy within 350 of him, instant, 8 s timer, when two enemy players (not pets) stand within 300 and nothing crowd-controlled is within 700. Anything hostile but a mezz wakes a mezzed enemy (`GameLiving.cs:1716-1727`).
- **`keepProc`** (chore, below the fight): Credit to Arawn, a damage proc for 20 minutes, 3 s cast, while the group stands. `buff()` has no slot for procs.

## The Surge, server code

Surge of Maiming lasts 30 s with 150 s to reuse, and costs 12 % of his power. `Spellbook.buffs()` now leaves out any self buff whose timer is longer than it lasts (`sdk/group/spells.ts`, 2026-11-12), so `buff()` no longer spends it between fights.

## Gear and build

R6's bot plays **"Flex, shield and tap"**: Flexible 21, Soulrending 22, Shields 13, Parry 6, Slash 4 at 24 (`data/builds/reaver.ts`). The gear template gives a flexible weapon and a large shield.

## Styles at 24

| Style | Line, level | Opening | End | Effect |
|---|---|---|---|---|
| Blacksnake | Flexible 2 | anytime | 10 | value 0.9 |
| Kingsnake | Flexible 4 | after his parry | 5 | bleed |
| Diamondback | Flexible 6 | anytime | 10 | **taunt**, value 11.5 |
| Asp | Flexible 8 | behind | 15 | longer reach |
| Viper | Flexible 10 | after his block | 5 | **stun 5 s** |
| Copperhead | Flexible 12 | after Viper | 5 | attack speed -21 % 20 s |
| Tigersnake | Flexible 15 | after Kingsnake | 5 | growth 175 |
| Indigosnake | Flexible 18 | side | 10 | lifedrain 58 |
| Boomslang | Flexible 21 | anytime | 10 | detaunt |
| Numb | Shields 3 | anytime | 15 | stun 2 s |
| Stun | Shields 8 | after his block | 15 | stun 3 s |
| Disable | Shields 13 | side | 15 | **stun 4 s** |

## Verified

**Verified, throwaway stack, 2026-11-12 (`sdk/test/live/kits-r7-live.ts`):** three realm groups at 24 in the Thidranki template, each with a healer, on the rvr-roam lists, four fights of 120-240 s. The probe `sdk/test/live/kit-probe-r7.ts` on R6's real character showed the same style details from the server as the tests' fixtures, and the same first picks.

- Vitality Siphon interrupted 2-8 times a fight through `interruptWith`. Surge 1-2 times, each ok. Disable landed in three of four fights, Diamondback 1-3. Damage 565-1440.
- **The aura is a pulse.** Runs 1-2 cast it as an 8 s instant, and a third of the casts came back `pulse_cancelled`: the second cast ended the first. It doesn't show among his effects either. From run 4 the kit keeps its own on/off (start on two players near, stop when the fight ends, cc comes near or nobody is in reach): 2 starts and 2 stops, none stray.
- Live on Agravaine from 22:30: read the sortie logs.

## Open

- **Numb is left out of the opener** (the Hero's kit swings it): a 2 s stun starts the same 60 s immunity Viper's 5 s would use.
- The other auras (Cramping Curse, a melee damage debuff; Aura of Destiny, an armour debuff) and Spirit Decay (DoT) are untried.
- Whether Credit to Arawn shows by name in `state.effects` (`keepProc` reads it so).

## The aura in step with the server (stint 2026-11-13, S5)

**The night of 2026-11-12** (21 sorties): 27 `aura:pulse_cancelled` (a start that cancelled an aura still running) and 34 `auraStop:cooldown` (a stop refused, the aura pulsing on near crowd control).

**Server code:**
- A cast of a running pulse cancels it before anything looks at the recast timer (`CastingComponent.cs` CastSpellRequest.StartSkill, :347-365). Only `castSpell`'s own client-side check refused those stops; the server would have taken them.
- Every pulse sends its effect animation from him on himself (`SpellHandler.cs:236-237`), so the client sees each 6 s pulse in its combat events (`spellEffect`, client effect 9645).

**The change (`sdk/classes/reaver.ts`):**
- `auraWatch` (side tick) keeps the time of the last such pulse.
- `auraRunning` says the aura runs while a pulse or our own start is under 7.5 s old and newer than our last cancel. A new sortie with the aura still pulsing from the last one now reads it as running, and stops it outside an engage.
- A stop goes out with the recast timer ignored.
- **To look for:** `auraStop:cooldown` gone, `aura:pulse_cancelled` rare.
