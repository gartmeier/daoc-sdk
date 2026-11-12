# Scout

Albion's archer: hides, shoots from range, the first arrow from stealth, and takes dirk and shield when caught. The kit is shared with the Ranger and the Hunter. For every style and level on this server run `bun data/class-sheet.ts Scout`. This file holds what that doesn't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/scout.ts` is `archer()` from `sdk/classes/archer.ts`:

```typescript
import { scout } from '../../sdk/classes/scout';
export default scout();
```

- **Role nuker:** the group keeps it at a caster's distance (combatRange 700-1400), inside every bow's reach.
- **`hide`** (an instant, above flee): the assassins' hide. The first arrow comes from stealth. Only a solo or a squad of stealthers hides (`allCanHide`): hidden it moves at 115, and anyone who can't hide would leave it behind at 191. In a mixed group it fights in the open.
- **`swat`** (fight, first): a monster or pet attacking us within 250 (not a keep guard) while the focus stands 500 or more off: melee weapon in hand, hit it.
- **`shoot`** (fight, ahead of the melee fight): on the focus in view, within the bow's reach less 300, with no enemy player and nothing attacking us within 350, and arrows in the backpack: stop and stand still 0.6 s, target, face once, take the bow, draw, send nothing until "You are ready to fire!", then release. A draw that ends without a shot lowers the bow (attack off). Beyond reach it steps in to 85 % of it. Close, or out of arrows: it takes the melee weapon (with the bow in hand the melee fight's attack request would draw the bow) and `meleeFight` swings.
- **Arrows:** Thidranki has no fletcher. `bun bots/gmlevel/give-arrows.ts <bot> ...` (gmlevel at PrivLevel 3) trades 3 stacks of 200 barbed footed flight broadhead arrows; each archer got 600 on 2026-11-11.

## Builds

Tristram (tristram) plays **Archer** (`bots/tristram/build.ts`). Spec points by level, as the buying rule spends them (`data/builds/scout.ts` has the reasons and sources):

| Level | Points | Archer (Longbows / Shields / Stealth / Thrust) | Melee slash (Shields / Slash / Stealth / Longbows) | Thrust and shield (Shields / Longbows / Stealth / Thrust) |
|---|---|---|---|---|
| 10 | 94 | 10 / 1 / 8 / 1 | 8 / 10 / 1 / 1 | 10 / 1 / 1 / 8 |
| 20 | 404 | 20 / 11 / 16 / 1 | 18 / 20 / 6 / 1 | 20 / 1 / 6 / 18 |
| 24 | 584 | 24 / 13 / 16 / 12 | 18 / 21 / 18 / 6 | 23 / 6 / 16 / 18 |
| 30 | 914 | 30 / 22 / 16 / 12 | 30 / 23 / 18 / 6 | 30 / 18 / 16 / 18 |
| 40 | 1624 | 40 / 35 / 16 / 12 | 40 / 35 / 18 / 6 | 40 / 32 / 16 / 18 |
| 50 | 2979 | 50 / 42 / 35 / 21 | 42 / 41 / 36 / 35 | 42 / 45 / 35 / 30 |

## Gear

The level-24 gear template (`sdk/group/gear-template.ts`, since c37a732): studded, a longbow, a dirk and a small shield, every stat, hit point, resist and skill bonus at the cap. Tristram wears it (audit 2026-11-11: no shortfall).

## The bow on this server

**Verified** (2026-11-11, Tristram on a Hitback Dummy at 1035, `bots/tristram/bow-check.ts`):
- With a melee weapon in hand the first use of the ranged slot (`bot.useItem(EquipmentSlot.Ranged)`) only takes the bow: "You wield the ... Longbow in both hands."
- The next use draws: "You prepare your shot (4.6s to fire, target is in range)", then "You are ready to fire!".
- A use before it is ready sets it to release by itself ("You will now automatically release your shot."), one more "... and reload". A use when ready fires.
- A turn while drawing interrupts it: "You move and interrupt your shot!". Face once, before the draw.
- At the release the target must be within 90 degrees in front ("... is not in view!").
- Hidden, the shot unstealths ("You are no longer hidden!" just before "You shoot Hitback Dummy ... for 223 damage!"). Nocking keeps the stealth with a chance of Stealth x 100 / level (AttackComponent.cs:605-616).

- In the loop (`groups/camelot-s2/rvr.ts 100`, a solo squad, 2026-11-11): Tristram engaged a lone Shadowblade 2000 away, standing still, and killed him with 6 shots in 41 s, no failure, never in melee.

- **Run B** (2026-11-12, solo squads, from the archers' own server lines):
  - First kit (a second use half a second into the draw): 11 of 12 shots failed in the first 19 minutes, 4 "You move and interrupt your shot!". Any packet whose x/y differs from what the server holds interrupts a draw, a turn's 0xA9 too.
  - Still kit (5207fc2): Diarmuid, Tristram and Skadi hit for 80-123 a shot (Skadi 19 hits in 20 minutes). What still failed: "X is attacking you and your shot is interrupted!" by a pet, "You're too tired to use your ... Bow!" (Skadi 56 times in 4 minutes on the pre-c064e43 kit: a draw never released, then every use refused), and the melee fight drawing the bow. Fixed in c064e43 and 19a3c2f.

**Server code:** reach by bow (AttackComponent.AttackRange): longbow 1760, recurve 1680, composite 1600. Arrows come from the active quiver slot, else the first arrows in the backpack (RangeAttackComponent.cs:67-77); without them "You must select a quiver slot".

Stealth itself is in [infiltrator.md](infiltrator.md) "Stealth on this server".

## Open

- Not yet played in a field run: run B (from 23:15) is the first, run C (02:15) the one before the freeze. Against a target that moves or fights back it is untried.
- Critical Shot, Rapid Fire and Volley aren't used. After 600 shots the arrows are gone and the kit fights in melee.
- A target that turns more than 90 degrees from our front during the 4.6 s draw is "not in view" at the release: the shot faces once, before the draw.
