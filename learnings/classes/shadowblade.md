# Shadowblade

Midgard's assassin, on the Infiltrator's kit ([infiltrator.md](infiltrator.md) has the stealth and opener detail). For every style and level on this server run `bun data/class-sheet.ts Shadowblade`. This file holds what that doesn't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/shadowblade.ts` is `stealther()` from `sdk/classes/stealther.ts`:

```typescript
import { shadowblade } from '../../sdk/classes/shadowblade';
export default shadowblade();
```

- **Role melee** (as `roleForClass` gives it).
- **`hide`** (an instant, above flee): as a player does in Thidranki (the user played a Nightshade there): open while travelling, at full speed (191; hidden it is 115), hidden as soon as an enemy player shows in its own view, within 4000 of a hotspot (the groups' meeting point and the three pair-round spots, `hotspotsOf`), or with an engage order. Shown again once nobody has been in view for 30 s and it is beyond 5000 of every hotspot (`wantHidden`). It hides out of combat only, 2.5 s past the client's own combat flag. A refusal waits its `retryAfterMs` or 3 s. Only a solo or a squad of stealthers hides (`allCanHide`): hidden it moves at 115, and anyone who can't hide would leave it behind at 191. In a mixed group it fights in the open.
- **`ambush`** (fight, ahead of the melee fight), hidden, with an engage order:
  - **Lurk** by a hard target: no healer, caster or crowd controller by the class read or its deeds, another enemy player within 1000 of it, and above half health. It stays hidden and leaves that fight to the rest.
  - **Open** on a soft or lone one: walk hidden to its front (Perforate Artery, Critical Strike 21) or, without that, its back (Backstab II at 10, Backstab at 2), then the style click alone. A style used out of attack mode starts the attack itself, and that first swing is the opener. An attack request of our own after it re-sends the target, which unstealths at once, and the opener fails ("You fail to execute your Backstab II perfectly!").
  - Not hidden: it does nothing, and `meleeFight` (fighterStyle, never a stealth style) goes on.
- **Leaving** a fight that turned is the squad's (`sdk/group/squad.ts` flee); out of combat `hide` hides again.

## Builds

Hodur (hodur) plays **Critical Strike, five lines** (`bots/hodur/build.ts`). Spec points by level, as the buying rule spends them (`data/builds/shadowblade.ts` has the reasons and sources):

| Level | Points | Shadowzerk (Left Axe / Axe / Stealth / Envenom / Critical Strike) | Left Axe leveller, no Stealth spend (Left Axe / Envenom / Axe / Critical Strike / Stealth) | Critical Strike, five lines (Left Axe / Axe / Critical Strike / Stealth / Envenom) |
|---|---|---|---|---|
| 10 | 100 | 1 / 10 / 9 / 1 / 1 | 10 / 9 / 2 / 1 / 1 | 1 / 8 / 10 / 4 / 1 |
| 20 | 437 | 1 / 19 / 19 / 11 / 1 | 20 / 18 / 10 / 1 / 1 | 1 / 9 / 20 / 18 / 5 |
| 24 | 633 | 15 / 19 / 19 / 17 / 2 | 24 / 19 / 16 / 4 / 6 | 3 / 12 / 21 / 19 / 17 |
| 30 | 994 | 30 / 20 / 19 / 17 / 2 | 30 / 27 / 16 / 4 / 6 | 26 / 12 / 21 / 19 / 17 |
| 40 | 1771 | 40 / 35 / 20 / 17 / 2 | 40 / 36 / 23 / 4 / 6 | 39 / 30 / 21 / 19 / 17 |
| 50 | 3253 | 50 / 35 / 36 / 36 / 13 | 50 / 36 / 35 / 13 / 36 | 39 / 34 / 34 / 36 / 36 |

## Gear

The level-24 gear template (`sdk/group/gear-template.ts`, since c37a732): leather, an axe and a left axe (Left Axe 3), every stat, hit point, resist and skill bonus at the cap. Hodur wears it (audit 2026-11-11: no shortfall).

## Poisons

`sdk/classes/poison.ts`, in the kit since a6fdd4b: `swapPoison` (an instant), `restock` and `envenom` (chores).
- **What each weapon carries** (`envenom`, out of combat after a fight or every 5 minutes, one delve per weapon):
  - the main hand: the damage over time;
  - the off hand: the debuff;
  - 3 spare main hands in the bag (the gear template's main hand, `bun bots/gmlevel/give-poisons.ts <bot>`): the snare, the disease and a second damage over time.
- **Which debuff** (`debuffFor`): by the stat the target's weapon uses (GamePlayer.GetWeaponStat). Disease on a healer, caster or archer: it halves heals, and DEX shortens casting. The STR (or STR/CON) debuff on the rest.
- **In a fight** (`swapPoison`, every 2.5 s or on a runner):
  - a spare comes into the main hand when its poison would land: the snare when the focus runs;
  - the disease once per healer, caster or archer;
  - a fresh damage over time 18 s after the last one fired.
- **Each poison has one charge:** the first hit that lands with that weapon fires it.
- **Buying** (`restock`): a solo below 2 damage over time or 1 debuff leaves Thidranki for its realm's poison merchant and comes back (enterBattleground: bind, medallion, port). The merchants: Onyg (Castle Sauvage), Riber (Druim Ligen), Gwaell (Audliten, by Young Gothi from Svasud).
  - One buy is a pack of 20, so a trip buys one pack of each kind, about 22s.

**Verified** (2026-11-12, Mordred, `bots/mordred/poison-check.ts`, log in `bots/mordred/runs/poison-check-20261112.log`):
- The trip out to Onyg and back took 4 min 45 s.
- All 5 weapons were poisoned at once ("You apply the greater lethal poison to the Thidranki Infiltrator Dirk."), and the delves read back dot, debuff, snare, disease, dot.
- The delve's lines as the server sends them:
  - "Inflicts 26 body damage every 4 seconds for 20 seconds."
  - "Decreases the target's strength by 44 for 1 minute."
  - "The target is slowed by 40% for 1 minute 1 second."
  - "Inflicts a wasting disease on the target that slows target by 15%, reduces its strength by 7.5% and inhibits healing by 50% for 1 minute 30 seconds."
- Not yet seen: a poison firing in a fight, and a swap in combat.

## Against a moving target

`sdk/classes/intercept.ts`, in `ambush`'s opener since a6fdd4b. Hidden we walk at 115, and a runner moves at 191. A walk to its front, aimed again each turn, ends as a chase behind it that never catches up: the user watched Mordred do that to a Ranger in run B. So:
- From its last positions (`trackFix`, `velocityOf`), a target faster than 40 a second is moving.
- **Coming at us** (its course passes within 120): hold, facing it, and open as it walks into reach.
- **Passing:** go to the earliest point on its path we can reach first, 0.8 s ahead of it.
- **Running off faster than we walk:** no chase; stay hidden.
- Not yet seen against a moving player.

## Open

- Played in run B and the freeze (11-12) as a solo. Mostly it stayed out of fights: sizeUp counts a hidden assassin as 1 against the enemy's number and avoids. Two openers in the freeze, both failed. Hodur's, because the skill setting's style slip changed Backstab II into Pincer; fixed in 79d73cf (no slip while hidden).
- Perforate Artery from the front: positioned and queued live, not yet landed on a fresh target.
