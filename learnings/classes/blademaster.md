# Blademaster

Hibernia's dual-wield melee: a blade in each hand (Celtic Dual), Evade and Parry, no shield in play. For every style and level on this server run `bun data/class-sheet.ts Blademaster`; for what a build reaches, `bun sdk/classes/reach.ts Blademaster "Group damage with Slam"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/blademaster.ts` (tested in `sdk/classes/blademaster.test.ts`):

```typescript
import { blademaster } from '../../sdk/classes/blademaster';
export default blademaster();
```

- **No role of its own.** The kit's fight (`bladeFight`) plays the tank's fight when the member has the tank's role, and the melee's assist (holdMs 0, as `meleeFight`) otherwise. The group decides: Hibernia's `rvr.ts` gives a Blademaster the tank's role when the line-up has no tank class (`roleOfLineup`), so he anchors the pack, peels divers off the casters and takes the leash. With a Hero in the line-up he is the melee on the focus.
- **Ice Storm once per stun immunity (`bladeStyle`).** At a player whose stun immunity is over: Ice Storm (Celtic Dual 18, from the side, 4 s stun, 10 endurance) with Hurricane behind it. The server keeps a first style and a backup and swings the backup when the side isn't met, so the swing is never wasted. The kit keeps its own log of the stuns it landed (the Hero kit's `noteStun`, with `BLADEMASTER_STUNS`), since style stuns aren't on the board.
- **Between stuns, the reacting tank's pick, no taunts.** Follow-ups, the reaction he just earned (Blinding Rain after his evade, Return Blade after his parry), a positional while the target is on someone else, then Hurricane. The plain `fighterStyle` ranks Taunting Blade and Squall above Hurricane per endurance; taunts do nothing to players, and round 121 had a Taunting Blade on one.
- **Triple Wield (`tripleWield`, level 20).** In an engage, swinging, with an enemy player within 350: 30 s of an extra Body hit worth about half the weapon's damage on every swing, 7 min reuse (`TripleWieldAbilityHandler.cs`, `TripleWieldECSEffect.cs`). The kit counts the reuse itself; a refusal waits 30 s.

**To look for:** "You perform your Ice Storm perfectly" in the fight log and `Styles landed` in the report (Ice Storm, Hurricane, Blinding Rain); the result `tripleWield` in his actions; no Taunting Blade or Squall at players.

## What he has at 24

**Server code.** Fionn's build reaches Blades 21, Celtic Dual 21, Shields 13, Parry 6 (plus the gear template's +5 to trained lines).

| Style | When | Does |
|---|---|---|
| Ice Storm (CD 18) | from the side | 4 s stun (spell 20400; a Blademaster-only proc), growth 0.77 |
| Hurricane (CD 21) | any time | growth 0.48, 15 endurance: the best plain style |
| Fire Blade (Blades 18) | any time | growth 0.46, 15 endurance |
| Blinding Rain (CD 4) | after his evade | bleed; Blizzard (CD 12, 21 % attack slow, 20 s) follows it |
| Return Blade (Blades 4) | after his parry | 16 % attack slow, 20 s; Lunging Blade (bleed) follows it |
| Snow Shower (CD 8) | from behind | 60 % snare, 12 s; Gale (bleed) or Thunderstorm (detaunt) follow it |
| Glowing Blade (Blades 10) | from the side | 60 % snare, 14 s; Auroric Blade (slow) follows it |
| Squall (CD 6), Taunting Blade (Blades 6) | any time | taunts: nothing against players |

- **No shield styles, and no Slam at 24.** Every Shields style (Numb, Stun, Disable, Slam) needs a shield in the left hand (`StyleProcessor.cs:167`), and he wears a second blade (`sdk/group/gear-template.ts`). Slam is Shields 42, a level-50 target of the build ("Group damage with Slam"). Horizon Blade needs his block, which needs a shield too. Guard and Engage need a shield as well.
- **The left hand** swings an extra, unstyled hit with chance 0.25 + 0.0068 × Celtic Dual, 39 % at 21 (`AttackComponent.cs`), whatever the style. Celtic Dual styles need two non-shield weapons (`StyleProcessor.cs:527-545`).
- **Abilities at 24:** Triple Wield (20), Evade II (15), Intercept (19), Protect 2 (23). Protect moves a mob's threat and does nothing against players. No behaviour uses Intercept yet.
- **Later:** Flurry at 30, Charge at 40.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/blademaster.ts` ([builds.md](../builds.md)). Fionn plays Group damage with Slam: at 24 Celtic Dual 21, Blades 21, Shields 13, Parry 6. The 13 in Shields buys nothing he can use while he dual-wields; it is a step toward Slam at 50. A level-24 build for RvR could put it into Parry or Celtic Dual instead (open).

## Arena

**Before the kit** (generic melee list, `fighterStyle`): round 121 (2026-11-10, with the Hero) 3,589 damage, Ice Storm 3, Hurricane 2, Taunting Blade 1; round 123 (no Hero, as melee) 317 damage, 2 styles, `melee:out_of_reach` 3.

## Open

- Not yet played with the kit: the stun log, Triple Wield, and the tank's role without a Hero.
- Intercept (19) on our Bard or healer: no behaviour casts it.
- Ice Storm from the side: he swings from where he stands; a flank step to the target's side (as the Bard's ccFlank does for casts) would make it land more often on a target that fights him.
- Shields 13 is dead weight at 24 while he dual-wields.
