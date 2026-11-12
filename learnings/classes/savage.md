# Savage

Midgard's hand-to-hand melee: a claw in each hand, studded armour, and Savagery self buffs paid in health. For every style and level on this server run `bun data/class-sheet.ts Savage`; for what a build reaches, `bun sdk/classes/reach.ts Savage "Hand to Hand first"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/savage.ts` (2026-11-12, R7):

```typescript
import { savage } from '../../sdk/classes/savage';
export default savage();
```

- **Role melee** (`roleForClass` gives it too). For `lineup.ts`: **melee**, a damage slot; studded armour, so not a tank.
- **Fight:** `assist({ melee: true, holdMs: 0, style: savageStyle })`.
- **`savageStyle`** (`kitStyle` in `sdk/classes/hybrid.ts`): at a player, Clan's Call first once per stun immunity (from behind, a 4 s stun), with a backup the server swings when he isn't behind: the fighter's reaction when it is earned (Tribal Rage after a parry), else the plain swing. Clan's Might follows a landed Clan's Call (5 s more stun, growth 290, the line's best). A stun by either starts the immunity (60 s after it ends, `CrowdControlECSEffect.cs:20`); the kit keeps its own log from "You perform your X perfectly!", as the Hero kit does.
- **Wild Call at a player.** It is a taunt, but a taunt's growth is damage (`StyleProcessor.cs:360-363`), and a player has no threat table. Without it a Savage has no plain swing worth its endurance: Kelgor's Bane is 7 for 5, Kelgor's Might 4 for 15. Against a monster on someone else `fighterStyle` leaves taunts out.
- **`kelgor`** (react, above the fight): Drive of Kelgor (+20 % attack speed) and Fierce Blows (damage), each 15 s, 5 s timer, instant. In the engage with the focus within 350, while he is above 60 % health, when its effect isn't on him.

## Savagery buffs, server code

- **They cost health:** `SavageBuff.cs:9-24`, `CostType Health`, 3 % of his maximum per cast (the DB's power -3). Two buffs every 15 s is about 24 % of his health a minute of fighting. A healer covers it; alone below 60 % the kit stops paying.
- **`Spellbook.buffs()` leaves every Savage buff out** (`sdk/group/spells.ts`, 2026-11-12). Before that, Bear Punctures (a thrust resist, slot `resist`) was a buff `buff()` kept up between fights at 3 % health each 15 s.
- Not cast by the kit: Hooks of Kelgor (parry), Alacrity of Kelgor (evade), the three resist buffs, Insulting Gesture (taunt, 2 s cast).

## Gear and build

R6's bot plays **"Hand to Hand first"**: Hand to Hand 24, Savagery 16, Parry 2 at 24 (`data/builds/savage.ts`). The gear template gives a hand-to-hand weapon in each hand; `canWield` wants one in the left for every Hand to Hand style.

## Styles at Hand to Hand 24

| Style | Level | Opening | End | Effect |
|---|---|---|---|---|
| Kelgor's Bane | 2 | anytime | 5 | parry buff, value 1.4 |
| Tribal Rage | 4 | after his parry | 4 | growth 233 |
| Wild Call | 6 | anytime | 10 | **taunt**, value 17.3 |
| Clan's Call | 8 | behind | 5 | **stun 4 s**, growth 235 |
| Tribal Assault | 10 | after Tribal Rage | 4 | hits 2 targets |
| Kelgor's Might | 12 | anytime | 15 | attack speed -7 % |
| Taunting Call | 15 | anytime | 10 | detaunt |
| Clan's Might | 18 | after Clan's Call | 4 | **stun 5 s**, hits 2, growth 290 |
| Totemic Fear | 21 | after his evade | 4 | 60 % snare 19 s |

## Verified

Nothing yet: offline tests only (`sdk/classes/savage.test.ts`, `hybrid.test.ts`). The live check comes after 21:00 on 2026-11-12.

## Open

- Whether the effects show by name in `state.effects` (the kit reads them so): if not, it recasts every 2 s and pays health for nothing. First thing to read in the live check.
- **Clan's Call needs his back to the foe's back.** On a player that is on him it never fires; the backup swings. A flank step of his own (the Blademaster's side) is not built.
- The 60 % floor for the buffs is a first guess.
