# Valewalker

Hibernia's scythe melee with Arboreal Path magic: cloth armour, a two-handed scythe, intelligence for power, and self buffs. For every style and level on this server run `bun data/class-sheet.ts Valewalker`; for what a build reaches, `bun sdk/classes/reach.ts Valewalker "Scythe first"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/valewalker.ts` (2026-11-12, R7):

```typescript
import { valewalker } from '../../sdk/classes/valewalker';
export default valewalker();
```

- **Role melee** (`roleForClass` gives it too). For `lineup.ts`: **melee**. Cloth armour: he dies fast at the front, so not a tank.
- **Fight:** `assist({ melee: true, holdMs: 0, style: valewalkerStyle })`.
- **`valewalkerStyle`** (`kitStyle`, `sdk/classes/hybrid.ts`): at a player, Stunning Blade first once per stun immunity (from the side, 5 s), with the earned reaction or the plain swing behind it. Winter's Scythe follows a landed Stunning Blade. The plain swing at a player is Taunting Scythe, 118 growth for 10 (a taunt's growth is damage, `StyleProcessor.cs:360-363`): his only other anytime style is Reaper, 11 for 15. The parry chain Sawgrass, Thorny Shield, Grasping Roots (262) and the evade one Arboreal Fire, Foxfire come from `fighterStyle`.
- **`kudzu`** (react): Alacrity of Kudzu, +22 % attack speed for 30 s, 2 minutes to reuse, instant, in the engage with the focus within 350.
- **`snareFocus`** (react): Conceal Path, a 35 % snare for 20 s, instant, range 1500, on a focus player more than 450 away. Again 3 s before it runs out; 4 s after a resist.
- **`keepProc`** (chore, below the fight): Banestrike (damage proc) and Barkcrust (defensive proc), 20 minutes, 3 s casts, while the group stands (recover, gather, idle). `buff()` has no slot for procs (`slotOf`).
- **`buff()` keeps** Grove's Armor (AF) on him and Forest's Revenge (damage shield, Realm target) on whoever the plan names.

## The haste, server code

Alacrity of Kudzu lasts 30 s with 120 s to reuse. `buff()` cast it between fights before 2026-11-12, so the fight found it on its timer. `Spellbook.buffs()` now leaves out any self buff whose timer is longer than it lasts (`sdk/group/spells.ts`), and the kit casts it when the fight starts.

## Gear and build

R6's bot plays **"Scythe first"**: Scythe 24, Arboreal Path 16 at 24 (`data/builds/valewalker.ts`). The gear template gives a scythe in the two-hand slot and cloth.

- **No focus bonus:** the Valewalker is the one Forester class that gets nothing from a focus (`ClassValewalker.cs:24`, `sdk/group/gear-score.ts`).
- **Enemy's Debt** (80 lifedrain, 2.5 s, range 1500) is left out: in melee a swing at him interrupts a cast that hasn't reached half way. Nature's Rot (DoT, instant) is left out too; both are open.

## Styles at Scythe 24

| Style | Level | Opening | End | Effect |
|---|---|---|---|---|
| Reaper | 2 | anytime | 15 | value 0.7 |
| Sawgrass | 4 | after his parry | 5 | slash resist -15 % 20 s |
| Taunting Scythe | 6 | anytime | 10 | **taunt**, value 11.8 |
| Arboreal Fire | 8 | after his evade | 5 | damage add 30 s |
| Stunning Blade | 10 | side | 10 | **stun 5 s** |
| Foxfire | 12 | after Arboreal Fire | 5 | DoT |
| Thorny Shield | 15 | after Sawgrass | 5 | damage shield 30 s |
| Winter's Scythe | 18 | after Stunning Blade | 5 | damage add 30 s |
| Grasping Roots | 21 | after Thorny Shield | 4 | 33 direct damage, growth 262 |

## Verified

Nothing yet: offline tests only (`sdk/classes/valewalker.test.ts`). The live check comes after 21:00 on 2026-11-12.

## Open

- **Parry 1** on "Scythe first": the parry chain is the line's best and opens on his parry. "Arboreal first" buys Parry 8.
- Whether the procs show by name in `state.effects` (`keepProc` reads them so) and whether Kudzu's does.
- Stunning Blade fires only from the side: no flank step of his own.
