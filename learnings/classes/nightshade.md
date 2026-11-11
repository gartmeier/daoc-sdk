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
- **`hide`** (an instant, above flee): out of a fight, alive, not hidden, 2.5 s past the client's own combat flag, it hides. A refusal waits its `retryAfterMs` or 3 s.
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

## Open

- Not yet played in a field run: run B (from 23:15) is the first, run C (02:15) the one before the freeze.
- Poisons (Envenom) are trained but not applied: no poison in the bag and no kit step for it.
- Perforate Artery from the front: positioned and queued live, not yet landed on a fresh target.
