# Ranger

Hibernia's archer, on the Scout's kit ([scout.md](scout.md) has the bow detail). Pathfinding self-buffs aren't cast by the kit yet. For every style and level on this server run `bun data/class-sheet.ts Ranger`. This file holds what that doesn't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/ranger.ts` is `archer()` from `sdk/classes/archer.ts`:

```typescript
import { ranger } from '../../sdk/classes/ranger';
export default ranger();
```

- **Role nuker:** the group keeps it at a caster's distance (combatRange 700-1400), inside every bow's reach.
- **`hide`** (an instant, above flee): the assassins' hide. The first arrow comes from stealth. Only a solo or a squad of stealthers hides (`allCanHide`): hidden it moves at 115, and anyone who can't hide would leave it behind at 191. In a mixed group it fights in the open.
- **`swat`** (fight, first): a monster or pet attacking us within 250 (not a keep guard) while the focus stands 500 or more off: melee weapon in hand, hit it.
- **`shoot`** (fight, ahead of the melee fight): on the focus in view, within the bow's reach less 300, with no enemy player and nothing attacking us within 350, and arrows in the backpack: stop and stand still 0.6 s, target, face once, take the bow, draw, send nothing until "You are ready to fire!", then release. A draw that ends without a shot lowers the bow (attack off). Beyond reach it steps in to 85 % of it. Close, or out of arrows: it takes the melee weapon (with the bow in hand the melee fight's attack request would draw the bow) and `meleeFight` swings.
- **Arrows:** Thidranki has no fletcher. `bun bots/gmlevel/give-arrows.ts <bot> ...` (gmlevel at PrivLevel 3) trades 3 stacks of 200 barbed footed flight broadhead arrows; each archer got 600 on 2026-11-11.

## Builds

Diarmuid (diarmuid) plays **Hybrid bow** (`bots/diarmuid/build.ts`). Spec points by level, as the buying rule spends them (`data/builds/ranger.ts` has the reasons and sources):

| Level | Points | Melee Celtic Dual (Celtic Dual / Piercing / Pathfinding / Stealth / Recurve Bow) | Hybrid bow (Recurve Bow / Pathfinding / Piercing / Stealth / Celtic Dual) | Sniper (Recurve Bow / Pathfinding / Stealth / Piercing / Celtic Dual) |
|---|---|---|---|---|
| 10 | 94 | 1 / 10 / 8 / 1 / 1 | 7 / 10 / 4 / 1 / 1 | 10 / 7 / 1 / 4 / 1 |
| 20 | 404 | 4 / 20 / 18 / 1 / 1 | 15 / 20 / 12 / 1 / 1 | 20 / 19 / 1 / 6 / 1 |
| 24 | 584 | 12 / 21 / 23 / 1 / 6 | 21 / 21 / 12 / 9 / 4 | 24 / 19 / 10 / 10 / 1 |
| 30 | 914 | 28 / 21 / 23 / 1 / 6 | 30 / 25 / 12 / 9 / 4 | 30 / 26 / 10 / 10 / 1 |
| 40 | 1624 | 40 / 26 / 29 / 1 / 6 | 35 / 40 / 18 / 9 / 4 | 40 / 38 / 10 / 10 / 1 |
| 50 | 2979 | 42 / 35 / 40 / 35 / 12 | 35 / 40 / 39 / 35 / 18 | 50 / 40 / 35 / 24 / 8 |

## Gear

The level-24 gear template (`sdk/group/gear-template.ts`, since c37a732): reinforced, a recurve bow and a dagger in each hand, every stat, hit point, resist and skill bonus at the cap. Diarmuid wears it (audit 2026-11-11: no shortfall).

## Open

- Not yet played in a field run: run B (from 23:15) is the first, run C (02:15) the one before the freeze.
- Critical Shot, Rapid Fire and Volley aren't used. After 600 shots the arrows are gone and the kit fights in melee.
- A target that turns more than 90 degrees from our front during the 4.6 s draw is "not in view" at the release: the shot faces once, before the draw.
