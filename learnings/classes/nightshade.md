# Nightshade

Hibernia's assassin, on the Infiltrator's kit ([infiltrator.md](infiltrator.md) has the stealth and opener detail). Nightshade magic (her own line, a few direct-damage spells) isn't in the kit yet. For every style and level on this server run `bun data/class-sheet.ts Nightshade`. This file holds what that doesn't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/nightshade.ts` is `stealther()` from `sdk/classes/stealther.ts`:

```typescript
import { nightshade } from '../../sdk/classes/nightshade';
export default nightshade();
```

- **Role melee** (as `roleForClass` gives it).
- **`hide`** (an instant, above flee): as a player does in Thidranki (the user played a Nightshade there): open while travelling, at full speed (191; hidden it is 115), hidden as soon as an enemy player shows in its own view, within 4000 of a hotspot (the groups' meeting point and the three pair-round spots, `hotspotsOf`), or with an engage order. Shown again once nobody has been in view for 30 s and it is beyond 5000 of every hotspot (`wantHidden`). It hides out of combat only, 2.5 s past the client's own combat flag. A refusal waits its `retryAfterMs` or 3 s. Only a solo or a squad of stealthers hides (`allCanHide`): hidden it moves at 115, and anyone who can't hide would leave it behind at 191. In a mixed group it fights in the open.
- **`ambush`** (fight, ahead of the melee fight), hidden, with an engage order:
  - **Lurk** by a hard target: no healer, caster or crowd controller by the class read or its deeds, another enemy player within 1000 of it, and above half health. It stays hidden and leaves that fight to the rest.
  - **Open** on a soft or lone one: walk hidden to its front (Perforate Artery, Critical Strike 21) or, without that, its back (Backstab II at 10, Backstab at 2), then the style click alone. A style used out of attack mode starts the attack itself, and that first swing is the opener. An attack request of our own after it re-sends the target, which unstealths at once, and the opener fails ("You fail to execute your Backstab II perfectly!").
  - Not hidden: it does nothing, and `meleeFight` (fighterStyle, never a stealth style) goes on.
- **Leaving** a fight that turned is the squad's (`sdk/group/squad.ts` flee); out of combat `hide` hides again.

## Builds

Scathach (scathach) plays **Stealth assassin** (`bots/scathach/build.ts`). Spec points by level, as the buying rule spends them (`data/builds/nightshade.ts` has the reasons and sources):

| Level | Points | Stealth assassin (Envenom / Critical Strike / Piercing / Stealth / Celtic Dual) | Dual-wield damage (Celtic Dual / Envenom / Critical Strike / Piercing / Stealth) |
|---|---|---|---|
| 10 | 100 | 2 / 10 / 9 / 1 / 1 | 1 / 9 / 1 / 10 / 1 |
| 20 | 437 | 10 / 15 / 15 / 16 / 1 | 1 / 20 / 5 / 20 / 1 |
| 24 | 633 | 15 / 21 / 17 / 16 / 4 | 10 / 20 / 10 / 24 / 8 |
| 30 | 994 | 30 / 22 / 17 / 16 / 4 | 28 / 20 / 10 / 24 / 8 |
| 40 | 1771 | 35 / 37 / 25 / 16 / 4 | 36 / 25 / 25 / 29 / 8 |
| 50 | 3253 | 35 / 44 / 36 / 35 / 25 | 44 / 33 / 34 / 34 / 33 |

## Gear

The level-24 gear template (`sdk/group/gear-template.ts`, since c37a732): leather, a dagger in each hand (Celtic Dual 4), every stat, hit point, resist and skill bonus at the cap. Scathach wears it (audit 2026-11-11: no shortfall).

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

## Nightshade Magic

`sdk/classes/nightshade-magic.ts`, in her kit since a6fdd4b (`sdk/classes/nightshade.ts`). These are baseline spells of the NightshadeNuke type. The group's interrupt takes only DirectDamage and Amnesia spells, and the melee role never casts, so the kit casts them itself.
- **The instant "…of Night"** (range 700, reuse 20 s): at 24 the best is Knife of Night, 38 damage for 8 power. Arrow of Night does 33 for 15.
  - `nightInstant` (an instant behaviour) casts it on an enemy player that started a cast within the last 2.5 s and is in reach.
  - Otherwise it casts it on the focus out of melee reach (over 180) when the focus runs or is under half health.
  - Never from stealth: the opener is worth five times as much.
- **The 3 s cast "…Strike"** (range 1500): Lesser Nocturnal Strike, 39 damage.
  - `nightCast` (fight, after `ambush`) casts it only on a runner past 700, under 40 %, with nobody on her, because a swing at her would interrupt it.
- Not yet seen live.

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
