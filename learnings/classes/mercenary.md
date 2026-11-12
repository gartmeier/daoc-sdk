# Mercenary

Albion's dual-wield melee: two one-handers, chain at 10, Parry from 17, no spells. For every style and level on this server run `bun data/class-sheet.ts Mercenary`; for what a build reaches, `bun sdk/classes/reach.ts Mercenary "Pure damage"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/mercenary.ts` (2026-11-12, R7) is the melee list's fight with a style pick of its own:

```typescript
import { mercenary } from '../../sdk/classes/mercenary';
export default mercenary();
```

- **Role melee** (`roleForClass` gives it too). For `lineup.ts`: **melee**, a damage slot beside the Armsman or Paladin that tanks.
- **Fight:** `assist({ melee: true, holdMs: 0, style: mercenaryStyle })`, the melee list's own fight with the pick below.
- **`mercenaryStyle`** is `kitStyle()` from `sdk/classes/hybrid.ts`: `fighterStyle` (a follow-up of what just landed, a reaction to what the foe just did, the back positional while the target is on someone else), and at a player the best plain swing with taunt styles counted (`withPlayerPlain`).
- **Taunt styles at a player, server code.** `StyleProcessor.cs:360-363` multiplies the swing by the style's GrowthRate whatever its proc, so a taunt style hits as hard as its growth says. A player has no threat table, so against one Inflame (Dual Wield 8) and Enrage (Slash 8), 114 growth for 10 endurance, are just the best anytime swings; Uppercut gives 68. Against a monster on someone else the kit keeps `fighterStyle`'s rule (no taunt pulls it off the tank). The Skald and Berserker kits leave taunts out at players; by this reading that costs them damage (Berserker's Provoke is worth 23 per endurance).

## Gear and build

R6's bot plays **"Pure damage"**: Dual Wield 24, Slash 23, Parry 7 at 24 (`data/builds/mercenary.ts`). The gear template gives two slashing weapons (`sdk/group/gear-template.ts`).

- **No shield, server code:** the Shields styles (Numb, Stun, Disable) need one in the left hand (`StyleProcessor.cs:167`), and Riposte (Slash 18) opens on his own block. With two swords none of them can fire; `canWield` leaves the shield styles out, and `mercenary.test.ts` holds that no queue names them.
- **The left hand** swings with every Dual Wield style and with the plain swings, by the left-hand chance Dual Wield raises (`AttackComponent.cs:2162-2170`).

## Styles at Dual Wield 24, Slash 23

**Data** (growth is GrowthRate × 200; value is growth per endurance):

| Style | Line, level | Opening | End | Effect |
|---|---|---|---|---|
| Twin Spikes | Dual Wield 2 | anytime | 10 | value 1 |
| Twin Return | Dual Wield 4 | after his evade | 5 | bleed |
| Shadow's Edge | Dual Wield 6 | behind | 10 | opens Eclipse and Penumbra |
| Inflame | Dual Wield 8 | anytime | 10 | **taunt**, value 11.4 |
| Orbit | Dual Wield 10 | after Twin Return | 10 | 60 % snare 12 s |
| Eclipse | Dual Wield 12 | after Shadow's Edge | 10 | attack speed -18 % 20 s |
| Misty Gloom | Dual Wield 15 | anytime | 15 | value 5.7 |
| Obscure | Dual Wield 18 | anytime | 10 | detaunt |
| Penumbra | Dual Wield 21 | after Shadow's Edge | 10 | growth 177 |
| Cross Slash | Slash 4 | side | 5 | opens Bloodletter |
| Uppercut | Slash 6 | anytime | 10 | value 6.8, opens Opal Slash |
| Enrage | Slash 8 | anytime | 10 | **taunt**, value 11.4 |
| Opal Slash | Slash 15 | after Uppercut | 10 | bleed |
| Riposte | Slash 18 | after his block | 5 | never fires without a shield |

- **What it plays at a player:** on a foe that is on him, Twin Return (if he evades) with Inflame or Enrage behind; on a foe hitting someone else, Shadow's Edge from behind, then Penumbra or Eclipse, with the taunt style behind.

## Verified

Nothing yet: the kit is offline-tested only (`sdk/classes/mercenary.test.ts`, `hybrid.test.ts`). The live check on R6's character comes after 21:00 on 2026-11-12, then the sortie logs in field mode.

## Open

- **No stun and no peel.** A Mercenary has neither without a shield. A shield build ("Dual wield with Slam") would bring Disable, but the gear template holds two swords, and the SDK's swap to a shield mid-fight (`takeMeleeSlot`) costs a swing.
- **Positionals** come only while the target is on someone else (`heldElsewhere`): a player's target is read from its last swing.
- Whether the chains (Shadow's Edge then Penumbra) land often enough to beat the plain taunt swing: count `You perform your` lines in the sortie logs.
