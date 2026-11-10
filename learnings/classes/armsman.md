# Armsman

Albion's weapons tank: plate, every Albion weapon line, a shield, Parry, and no spells. For every style and level on this server run `bun data/class-sheet.ts Armsman`; for what a build reaches, `bun sdk/classes/reach.ts Armsman "Polearm hybrid"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/armsman.ts` is a tank that picks from the weapon line in his hands:

```typescript
import { armsman } from '../../sdk/classes/armsman';
export default armsman();                     // { weapon: 'Two Handed' } for a two-hander build
```

- **`fight`: `tank({ style: lineStyle('Polearm') })`.** The reacting tank's pick (`reacting-tank.ts`: a follow-up, a reaction, a positional when the foe is on someone else, a plain style behind), from the Polearm line's styles only. Taunts stay the plain tank's (Distract).
- **Why one line:** `canWield` counts every weapon worn, and the state can't say which is out. So the plain reacting pick, with the foe on someone else, queues the shield's Disable (growth 129, the strongest positional he has) ahead of Crippling Blow: two weapons in one queue and a forced swap. `armsman.test.ts` holds both picks.
- **What it plays at 24:** Executioner (after a parry) with Crippling Blow behind; on a foe hitting someone else, Defender's Cross then Disabler; after Defender's Faith, Defender's Courage.

## Gear and hands

**Server code.** The gear template (`sdk/group/gear-template.ts`) dresses him in a sword, a large shield and a slash halberd in the two-hand slot. `wearOrder` puts the two-hander on last, and `hand()` keeps it out, since his opener Crippling Blow needs a Polearm.

- With a two-hander out the server clears the left hand (`GameLiving.cs`): shield styles are refused (`StyleProcessor.cs`), and block and Guard come to 0. So Numb, Stun, Disable, Riposte and Guard do nothing while the halberd is out.
- `killNpc`/`killPlayer` swap to the weapon a refused style names, once per weapon per call (`actions.ts`), and one `tank()` turn can last 90 s. A stun swap would work once at most per turn, then refusals.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/armsman.ts` ([builds.md](../builds.md)). Gawain plays "Polearm hybrid": Polearm 24, Slash 18, Shields 15, Parry 5 at 24.

**Server code, styles at 24** (endurance as the table lists it; the server scales it by weapon speed, so about 1.2× on the 4.8 s halberd):

| Style | Line | Kind | Effect | End |
|---|---|---|---|---:|
| Defender's Cross | Polearm 4 | side positional | 60 % snare 11 s | 10 |
| Defender's Faith → Defender's Courage | Polearm 8 / 15 | anytime, then follow-up | bleed, then attack speed -19 % | 15 / 10 |
| Executioner | Polearm 10 | after a parry | attack speed -16 % 20 s, highest growth | 10 |
| Distract | Polearm 12 | anytime | taunt | 10 |
| Crippling Blow | Polearm 18 | anytime | 60 % snare 12 s, best damage per endurance | 10 |
| Disabler | Polearm 21 | follow-up to Defender's Cross | attack speed -21 % | 5 |
| Numb, Stun, Disable | Shields 3 / 8 / 13 | anytime, after a block, side | stun 2 / 3 / 4 s | 15 |
| Uppercut → Opal Slash, Cross Slash → Bloodletter, Riposte | Slash | | bleeds, damage | 5-10 |

**Server code, abilities from his class, not his lines** (so `reach.ts` lists none): Protect (11, 20) moves monster threat only; Intercept (12) takes 50 % of the hits on one group member within 128, 60 s reuse; Guard (Shields 5/10/15) needs the shield in hand. No behaviour uses Intercept or Engage.

## Arena

**Verified,** on the plain tank list before the kit:
- Round 122 (2026-11-10, against Midgard, lost 0 / 6): 905 damage, Crippling Blow 7 landed, targeted 16 %, died once.
- Round 124 (against Hibernia, lost 0 / 5), as the only tank: 418 damage, Crippling Blow 2 and Distract 1, targeted 41 %, died once.

## Open

- How often Executioner and Defender's Cross land with Parry 5, and whether he runs dry at 1.2× endurance.
- A stun mode: sword and shield for one Disable or Numb per 60 s stun immunity (the Hero's `StunLog`), then back to the halberd. It needs a weapon switch a style pick can ask for, and it shares the immunity with our Cleric's Stunning Flare.
- Intercept on our healer when she is dived, and whether a shield mode near her (Guard, Intercept) beats the halberd's damage.
- Crippling Blow's snare every swing against chaining Defender's Faith into Defender's Courage.
