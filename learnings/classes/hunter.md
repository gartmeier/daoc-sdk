# Hunter

Midgard's archer, on the Scout's kit ([scout.md](scout.md) has the bow detail). Beastcraft brings a pet (Hunter's Companion); the group's pet behaviours handle it, the kit adds nothing of its own. For every style and level on this server run `bun data/class-sheet.ts Hunter`. This file holds what that doesn't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/hunter.ts` is `archer()` from `sdk/classes/archer.ts`:

```typescript
import { hunter } from '../../sdk/classes/hunter';
export default hunter();
```

- **Role nuker:** the group keeps it at a caster's distance (combatRange 700-1400), inside every bow's reach.
- **`hide`** (an instant, above flee): the assassins' hide. The first arrow comes from stealth. Only a solo or a squad of stealthers hides (`allCanHide`): hidden it moves at 115, and anyone who can't hide would leave it behind at 191. In a mixed group it fights in the open.
- **`swat`** (fight, first): a monster or pet attacking us within 250 (not a keep guard) while the focus stands 500 or more off: melee weapon in hand, hit it.
- **`shoot`** (fight, ahead of the melee fight): on the focus in view, within the bow's reach less 300, with no enemy player and nothing attacking us within 350, and arrows in the backpack: stop and stand still 0.6 s, target, face once, take the bow, draw, send nothing until "You are ready to fire!", then release. A draw that ends without a shot lowers the bow (attack off). Beyond reach it steps in to 85 % of it. Close, or out of arrows: it takes the melee weapon (with the bow in hand the melee fight's attack request would draw the bow) and `meleeFight` swings.
- **Arrows:** Thidranki has no fletcher. `bun bots/gmlevel/give-arrows.ts <bot> ...` (gmlevel at PrivLevel 3) trades 3 stacks of 200 barbed footed flight broadhead arrows; each archer got 600 on 2026-11-11.

## Builds

Skadi (skadi) plays **Hybrid bow and Spear** (`bots/skadi/build.ts`). Spec points by level, as the buying rule spends them (`data/builds/hunter.ts` has the reasons and sources):

| Level | Points | Spear and Beastcraft (Beastcraft / Spear / Stealth / Composite Bow) | Hybrid bow and Spear (Beastcraft / Composite Bow / Stealth / Spear) | Stealth archer (Stealth / Composite Bow / Beastcraft / Spear) |
|---|---|---|---|---|
| 10 | 94 | 8 / 10 / 1 / 1 | 10 / 1 / 4 / 7 | 8 / 10 / 1 / 1 |
| 20 | 404 | 19 / 20 / 1 / 1 | 20 / 5 / 4 / 18 | 19 / 20 / 1 / 1 |
| 24 | 584 | 23 / 24 / 4 / 1 | 21 / 15 / 11 / 18 | 20 / 24 / 4 / 11 |
| 30 | 914 | 30 / 29 / 4 / 1 | 30 / 20 / 11 / 18 | 30 / 26 / 4 / 11 |
| 40 | 1624 | 40 / 39 / 4 / 1 | 40 / 27 / 20 / 20 | 39 / 35 / 16 / 11 |
| 50 | 2979 | 50 / 44 / 36 / 9 | 40 / 35 / 35 / 42 | 39 / 35 / 32 / 45 |

## Gear

The level-24 gear template (`sdk/group/gear-template.ts`, since c37a732): studded, a composite bow and a spear, every stat, hit point, resist and skill bonus at the cap. Skadi wears it (audit 2026-11-11: no shortfall).

## Open

- Not yet played in a field run: run B (from 23:15) is the first, run C (02:15) the one before the freeze.
- Critical Shot, Rapid Fire and Volley aren't used. After 600 shots the arrows are gone and the kit fights in melee.
- A target that turns more than 90 degrees from our front during the 4.6 s draw is "not in view" at the release: the shot faces once, before the draw.
