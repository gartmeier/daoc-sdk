# Thane

Midgard's hybrid tank: a hammer, a shield, Parry and the Stormcalling spells. For every style and level on this server run `bun data/class-sheet.ts Thane`; for what a build reaches, `bun sdk/classes/reach.ts Thane "Even hybrid with Parry"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/thane.ts`:

```typescript
import { thane } from '../../sdk/classes/thane';
export default thane();
```

- **Role tank** (`roleForClass` too), so the tank list's `guard` keeps Guard on our healer between fights.
- **Styles: the Hero kit's `heroStyle`.** At Shields 18 he has the Hero's Numb, Stun, Disable and Incapacitate under the same names, so the same stun once per immunity applies: Incapacitate after a block, else Disable from the side with Numb behind it. A stun stops a cast for certain. Between stuns the reacting tank's pick, never a taunt at a player.
- **Fight, `thaneFight` (named `tank`, the role's fight):** against a monster the tank's own, with its taunts. Against a player the melee assist. The plain tank's fight against a player is one `killPlayer` of up to 90 s, and nothing above it in his list gets a turn until it ends; the melee assist comes back about every 400 ms.
- **`interrupt()` (instant, above flee):** the shared behaviour, which casts Toothgrinder's Horn at a casting enemy, healers first, as Bragi's Warshriek does. That is why the fight has short turns.

**Not played.** Bench bot Sigurd, from 2026-11-10. To look for: `interrupt` in his actions, Disable, Numb and Incapacitate in the styles column, and his damage. Round 123 (before the kit) on the generic tank list: 171 damage, no style landed, `guard` once.

## Stormcalling at 22

**Data,** every spell energy damage:

| Spell | Kind | Range / radius | Cast | Power | Timer |
|---|---|---|---|---|---|
| Toothgrinder's Horn | 49 on one target | 1500 | instant | 11 | 20 s |
| Thor's Minor Lightning | 55 bolt | 1500 | 3 s | 10 | |
| Invoke Mjollnir | 79 at a target | 1500, radius 350 | 4 s | 13 | |
| Thor's Might | his own Str/Con +39 | self | 3 s | 12 | 20 minutes |
| Thunder's Crush | his own damage add, 4.2 a hit | self | 3 s | 13 | 20 minutes |

- **Only the Horn can be cast in melee.** A swing at him starts the interrupt timer, and a cast that reaches its half way under it ends (CLAUDE.md "Casters get interrupted"). `Spellbook.interrupts()` takes it (instant, single target, direct damage); `reach.ts` lists Mjollnir as reached and cast by nobody.
- **`buff()` keeps his two self buffs up** out of combat (he is his own provider for a slot only he can buff), unless Ulfgar's Str/Con already covers the slot.
- None of his spells stuns or snares: the snare is Frost Hammer's.

## Styles at Hammer 15, Shields 18, Parry 8

**Data:**
- Hammer: Thor's Anvil (2, anytime), Crushing Blow (4, after his parry, 2 s stun), Placate (6, detaunt), Slam (8, follow-up), Ruiner (10, anytime: the plain tank's damage style), Frost Hammer (12, side, snare 60 % for 15 s), Provoke (15, taunt).
- Shields: Numb (3, anytime, 2 s stun), Stun (8, after a block, 3 s), Disable (13, side, 4 s), Incapacitate (18, after a block, 5 s).
- **Server code:** a player takes no other stun for 60 s after one ends; the Hero kit's `noteStun` tracks it per target.

## Open

- **Guard reach.** Guard blocks only within 256 of the guarded member (Server code), and the pack's formation puts the healer 200 and more behind the tank, fanned out further by fanOut. Walking to the healer when a diver reaches it is the candidate behaviour (Bragi's `guardSoft` in `groups/midgard/plan.ts` is the model).
- **The Horn on the focus** when nobody casts: 49 damage every 20 s. Left out for now, so the Horn is ready for an interrupt.
- **Mjollnir before melee** (4 s cast, radius 350) as an opener while closing, with nobody swinging at him: not written.
- His power pool at 24 is unread.
