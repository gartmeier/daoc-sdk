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

**Verified, arena rounds 129-185 (2026-11-10/11, Sigurd, 21 rounds with the kit):** the Horn interrupts 2-8 times a round through `interrupt()` (the short turns work); Numb in most rounds, Disable in 5, Crushing Blow once. Damage 69-1428: 575-1428 in won rounds, 69-490 in most lost ones. He is often the enemy's first target (targeted 53-100 % in rounds 138, 178, 181, 185) and dies with little damage then: chain armour and less health than the Warrior at the front of the formation. His character adds `guardSoft` (groups/midgard/plan.ts) from round 164, which also brings him within Guard's 256 of the member he guards.

**Verified, the whole night (rounds 126-225, 37 of Midgard's 65 rounds, from `groups/midgard/runs/*.md`):**
- **Arena:** 17 rounds won of 37 (vs Camelot 7/15, vs Hibernia 10/22). Damage 0-1428 a round, on average 827 in won rounds and 364 in lost ones.
- **The Horn interrupts** a median of 3 times a round (0-9; 9 in round 216). 15 tries failed because he was crowd-controlled himself.
- **Stuns, rounds in which each landed:** Numb 25, Disable 12, Incapacitate 1 (round 200, his only block reaction), Crushing Blow 1. Ruiner was his plain swing in 11 rounds.
- **Guard and protect:** 50 guards and 55 protects over the night, between fights.
- **Deaths:** he died in 22 of 37 rounds, and was the first of the group to die in 5 (Sigrid in 14). Targeted median 38 % of fight time, 50 % or more in 13 rounds.
- **Failures:** `melee:out_of_reach` 34, `walk:stuck` 23, `melee:refused` 15, `kill:immune` 5 (a player still in PvP immunity, round 224).

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

- **Is he the enemy's first target because he is a Thane?** The night says no. In the 11 rounds he played beside Thorgrim (Warrior), the enemy targeted them alike (median 29 % against 28 %), and Sigurd died in 7 of them, Thorgrim in 5. As the only tank (26 rounds) he was targeted 40 % and died in 15. The front-liner the enemy reaches first gets the pressure, whatever his class. So standing him behind the Warrior is not the fix. The open part is the group's: peel and the formation (`formation` in groups/midgard/rvr.ts, tank at 0, healers 600 back). His deaths in losses cost more than his damage gains in wins.
- **Guard reach.** Guard blocks only within 256 of the guarded member (Server code), and the pack's formation puts the healer 200 and more behind the tank (600 in Midgard's), fanned out further by fanOut. His character has carried `guardSoft` since round 164 (above). Its worth is unmeasured: from round 164 every member's targeted share rose (Sigurd 29 → 40 %, Sigrid 18 → 31 %, Ragnar 19 → 28 % median), so the rounds can't separate it from the rest.
- **`walk:stuck` 23 times** over the night, at slopes and river banks. The cause was not read.
- **The Horn on the focus** when nobody casts: 49 damage every 20 s. Left out for now, so the Horn is ready for an interrupt.
- **Mjollnir before melee** (4 s cast, radius 350) as an opener while closing, with nobody swinging at him: not written.
- His power pool at 24 is unread.
