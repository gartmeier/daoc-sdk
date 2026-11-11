# Infiltrator

Albion's assassin: hides, picks a soft target, opens with a Critical Strike style from stealth. The kit is shared with the Nightshade and the Shadowblade. For every style and level on this server run `bun data/class-sheet.ts Infiltrator`. This file holds what that doesn't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/infiltrator.ts` is `stealther()` from `sdk/classes/stealther.ts`:

```typescript
import { infiltrator } from '../../sdk/classes/infiltrator';
export default infiltrator();
```

- **Role melee** (as `roleForClass` gives it).
- **`hide`** (an instant, above flee): out of a fight, alive, not hidden, 2.5 s past the client's own combat flag, it hides. A refusal waits its `retryAfterMs` or 3 s. Only a solo or a squad of stealthers hides (`allCanHide`): hidden it moves at 115, and anyone who can't hide would leave it behind at 191. In a mixed group it fights in the open.
- **`ambush`** (fight, ahead of the melee fight), hidden, with an engage order:
  - **Lurk** by a hard target: no healer, caster or crowd controller by the class read or its deeds, another enemy player within 1000 of it, and above half health. It stays hidden and leaves that fight to the rest.
  - **Open** on a soft or lone one: walk hidden to its front (Perforate Artery, Critical Strike 21) or, without that, its back (Backstab II at 10, Backstab at 2), then the style click alone. A style used out of attack mode starts the attack itself, and that first swing is the opener. An attack request of our own after it re-sends the target, which unstealths at once, and the opener fails ("You fail to execute your Backstab II perfectly!").
  - Not hidden: it does nothing, and `meleeFight` (fighterStyle, never a stealth style) goes on.
- **Leaving** a fight that turned is the squad's (`sdk/group/squad.ts` flee); out of combat `hide` hides again.

## Builds

Mordred (mordred) plays **Critical Strike assassin** (`bots/mordred/build.ts`). Spec points by level, as the buying rule spends them (`data/builds/infiltrator.ts` has the reasons and sources):

| Level | Points | Critical Strike assassin (Thrust / Critical Strike / Stealth / Envenom / Dual Wield) | Dual wield Mercfiltrator (Dual Wield / Thrust / Envenom / Stealth / Critical Strike) |
|---|---|---|---|
| 10 | 113 | 10 / 10 / 1 / 3 / 1 | 10 / 10 / 3 / 1 / 1 |
| 20 | 498 | 18 / 20 / 5 / 15 / 1 | 20 / 20 / 12 / 1 / 1 |
| 24 | 722 | 18 / 21 / 19 / 15 / 7 | 24 / 21 / 15 / 11 / 7 |
| 30 | 1133 | 30 / 26 / 19 / 15 / 7 | 30 / 30 / 16 / 11 / 7 |
| 40 | 2018 | 40 / 40 / 23 / 15 / 7 | 40 / 40 / 25 / 11 / 7 |
| 50 | 3706 | 50 / 44 / 36 / 36 / 19 | 50 / 44 / 36 / 36 / 19 |

## Gear

The level-24 gear template (`sdk/group/gear-template.ts`, since c37a732): leather, a dirk in each hand (Dual Wield 7), every stat, hit point, resist and skill bonus at the cap. Mordred wears it (audit 2026-11-11: no shortfall).

## Stealth on this server

**Server code** (`skillhandler/StealthSpecHandler.cs`, `ECS-Effects/StealthECSEffect.cs`, `GamePlayer.cs` CanDetect):
- Stealth is a click on the Stealth *specialization*, not an ability: `bot.stealth()` / `bot.unstealth()` (0xBB with type 0, the client's `useSpec` action, since 7d44279). Success is "You are now hidden!" or the server's 0x8D (`player.stealthed`).
- Refusals, as `reason`: `in_combat` (10 s after any combat), `enemy_near` (an enemy within 1024 - 896 x stealth / its level; at 24 with Stealth 24 that is 128), `busy` (attack mode or casting), `cooldown` (2 s between toggles), `crowd_controlled`, `dead`.
- Hidden, run speed drops from 191 to 115 and speed buffs pause. Any blow taken ends it, and so do a swing and a target change in attack mode. A monster can uncover it ("X uncovers you!": 10 % a second, plus 1 % a level over our Stealth, inside 125 + 20 a level of difference).
- **Who sees a stealther:** the server sends it only to a client that detects it, and deletes it from the rest (`SendObjectDelete`). A player of level L detects one with Stealth S (spec plus items) within 125 + 20 x (L - S), up to 1900; Detect Hidden makes it 250 + 50 x (L - S), and See Hidden 2700 - 36 x S against non-assassins. There is no realm check: our own realm loses sight of our stealther too. A detected one arrives with PlayerCreate's 0x10 flag (`NearbyPlayer.stealthed`). So a bot sees exactly what a human client would.

**Verified** (2026-11-11):
- Mordred and Tristram at the Albion arrival point (`bots/mordred/stealth-check.ts`): hidden, run speed 115; Tristram 160 and more away lost Mordred from view, at 90 saw him again with `stealthed: true`; `unstealth()` showed him at once.
- Across realms (`bots/mordred/duel-check.ts`, Mordred against Hodur, both level 24 with Stealth 24, north of the Midgard portal keep): Hodur saw him as "Saracen" (an enemy shows under its race) at 1431; once he hid, not at 1421, 751 or 243; at 92 and 70 again, flagged stealthed. That is 125 + 20 x (24 - 24): the server's rule, nothing more.

## The opener

**Data** (`styles.json`): Backstab (Critical Strike 2) and Backstab II (10) need stealth and the target's back, Perforate Artery (21) stealth and its front. Their follow-ups: Eviscerate (4) after Backstab, Thigh Cut (15) after Backstab II; Creeping Death after Perforate Artery comes at 34. Garrote (18) is anytime.

**Server code** (StyleProcessor.cs:81-117): a positional also needs the target within 120 degrees in front of us. The cones by the target's heading: back 150-210 degrees, side 45-150 and 210-315, front the rest. The style's stealth need is checked again at the swing (ExecuteStyle), so anything that unstealths before it fails the style.

**Verified** (2026-11-11, Mordred on a Hitback Dummy, `bots/mordred/ambush-check.ts`):
- Backstab II from behind, hidden, by the style click alone: "You perform your Backstab II perfectly! (+158)", 236 damage and its stun.
- The same with an attack request after the click: "You fail to execute your Backstab II perfectly!", as it re-sends the target.
- A Hitback Dummy hit before swings at us when we come back, and the blow unstealths: test on a fresh one.
- On a player (Hodur, Shadowblade 24 in template gear, standing): Backstab II from behind "perfectly" (+163), 153 after his armour and its stun; Perforate Artery from the front "perfectly" (+245), 204 after armour and a bleed. Each took him to about half health with the swings after it.
- In the loop (`groups/camelot-s1/rvr.ts 120`, a solo squad): hidden, the squad hunted a lone Shadowblade 2300 away, engaged, `ambush` walked in hidden and opened with Perforate Artery (success), then `meleeFight` swung Sting 5 times; dead in 41 s, Mordred never below full health (he didn't fight back: a client with no script).
- Walking out of a fight toward an enemy portal keep killed Mordred: its guards ("Nordic Jarl") stand round it.

## Open

- Not yet played in a field run: run B (from 23:15) is the first, run C (02:15) the one before the freeze.
- Poisons (Envenom) are trained but not applied: no poison in the bag and no kit step for it.
- Fight picking is the squad's (`sizeUp`): it leaves anyone within 4500 of an enemy keep alone (keep clearance), as it left Hodur 3150 from the Midgard portal keep. The opener's worth (about 200 and a stun or bleed) isn't in its strength count.
- Against a target that fights back, or a group, it is untried.
