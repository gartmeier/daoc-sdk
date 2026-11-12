# Minstrel

Albion's singer: chain, a thrust weapon and a small shield, a lute for the songs, a single mezz, a stun shout and a damage shout from Instruments, and stealth. For every spell and style on this server run `bun data/class-sheet.ts Minstrel`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Minstrel "Group thrust"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/minstrel.ts` (2026-11-12, R7):

```typescript
import { minstrel } from '../../sdk/classes/minstrel';
export default minstrel();
```

- **Role support** (`roleForClass` gives it too). For `lineup.ts`: **support**, Albion's mezz and speed, the Bard's place in a Hibernian group.
- **The support list does the rest:** `crowdControl()` mezzes with Constraining Cadence (3 s, range 1500, 17 s), `song()` plays Motivational Song (speed) travelling and Song of Healing or Song of Energy between fights, `position()` keeps him at range.
- **`stunShout`** (instant, above flee): Stunning Shout (Stun, instant, range 700, 5 s, 10 s timer) at an enemy player within 350 of our healer and on her, else on him, else on another soft member (support, nuker), else one casting within the last 2 s. A stun stops a cast for certain and isn't broken by damage. It goes on a target once per immunity (60 s after it ends), kept in his own log and told to the board with `markCcImmune`. Not `markCc`: the board treats a cc'd enemy as one to leave alone, and a stunned one is one to hit.
- **`interruptOnTheRun`** (the Bard kit's, instant, above flee): Dischordant Wail (46 damage, instant, range 700) at a casting enemy while a melee is on him, when `flee` would take every turn.
- **`interrupt()`** (react, above `position`): the same shout at a casting enemy when nothing is on him. The RvR support list has no `interrupt()` of its own; the pack's has.

## The instrument

**Server code:** a song needs an instrument out (`SpellHandler.cs` `CheckInstrument`). The gear template gives the Minstrel a lute in the two-hand slot (`instrument: true`, `sdk/group/gear-template.ts`); the bard.md section "The instrument" says how the template puts it on last.

## Build

R6's bot plays **"Group thrust"**: Instruments 21, Thrust 20, Stealth 5 at 24 (`data/builds/minstrel.ts`).

**Server code, Instruments 21 at 24:** Constraining Cadence (mezz), Pacifying Lullaby (area mezz, 5 s cast; not cast), Stunning Shout (stun), Dischordant Wail (damage), Cant of Bewilderment (confusion, instant, range 700; the pack's `confuse()` casts it), Attracting Melodies (charm; not cast). Songs: speed 156, health 17, power 2.

## Verified

Nothing yet: offline tests only (`sdk/classes/minstrel.test.ts`). The live check comes after 21:00 on 2026-11-12.

## Open

- **He never swings.** Support stands at range; Thrust 20 buys Beartooth (a 6 s stun after his block, with the small shield) and Wolftooth, unused.
- **The shout's 700** against support's place at 450-1600 behind: it reaches a diver on him or our healer, rarely a caster at their back line.
- **Stealth** (Stealth 5) is unused.
- Whether a stunned enemy really keeps being hit by the group: the board's `ccImmune` is set, its `cc` not.
