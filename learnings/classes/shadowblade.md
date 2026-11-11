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
- **`hide`** (an instant, above flee): out of a fight, alive, not hidden, 2.5 s past the client's own combat flag, it hides. A refusal waits its `retryAfterMs` or 3 s.
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

## Open

- Not yet played in a field run: run B (from 23:15) is the first, run C (02:15) the one before the freeze.
- Poisons (Envenom) are trained but not applied: no poison in the bag and no kit step for it.
- Perforate Artery from the front: positioned and queued live, not yet landed on a fresh target.
