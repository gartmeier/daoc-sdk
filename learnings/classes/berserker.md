# Berserker

Midgard's two-axe melee: Left Axe swings both hands every round, with no shield. For every style and level on this server run `bun data/class-sheet.ts Berserker`; for what a build reaches, `bun sdk/classes/reach.ts Berserker "Left Axe, Hammer, high Parry"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/berserker.ts` is the melee list's fight with a style pick of its own, and Berserk:

```typescript
import { berserker } from '../../sdk/classes/berserker';
export default berserker();
```

- **Role melee** (`roleForClass` gives it too): studded armour, no shield, and Berserk takes his defences away. He is no tank.
- **Fight:** `assist({ melee: true, holdMs: 0, style: berserkerStyle })`, which is the melee list's own fight with this style pick.
- **`berserkerStyle`:** `fighterStyle` without taunts at a player (the Skald kit's `stylesFor`: Snowblind and Provoke taunt, and a player has no threat table), and with the Left Axe chain's opener as the plain swing (`withChain`). Reactions, positionals and follow-ups keep their places in front.
- **`berserk`** (instant, above flee): Berserk on the focus when it is a player within 250, not crowd-controlled, under 60 % (a healer, caster or cc class under 75 %), with Ragnar above 50 % and at most one enemy swinging at him in the last 8 s. The kit keeps its own 7-minute clock, because `findAbility` lists the ability while it waits; a refused try waits 10 s.

**Verified, arena rounds 127-187 (2026-11-10/11, Ragnar, 26 rounds with the kit):** the chain fires every round he gets to swing: Ravager 1-7 a round, Atrophy in 15 of them, Scathing Blade in 10, and the side positional Frost Hammer with its stun follow-up Demolish (round 187). Damage 0-2505 a round, about 1150 on average, the group's best in rounds 127 and 160; before the kit (rounds 122-123, generic melee list) his swings were Provoke and nothing else. Berserk fires once a round (a fresh process starts its clock empty; since 434ddcf a refusal that names the wait sets it). Two zero-damage rounds were a swimming focus (round 146, the shared assistMelee retry, fixed in feb811e) and a no-fight round.
- Ragnar's character adds Bragi's `guardSoft` and `hitInReach` (groups/midgard/plan.ts) from round 137: with Bragi benched nobody of the melee peeled.

**Verified, the whole night (rounds 126-225, 37 of Midgard's 65 rounds, from `groups/midgard/runs/*.md`):**
- **Arena:** 16 rounds won of 37 (vs Camelot 8/13, vs Hibernia 8/24). Damage 0-2505 a round, on average 1247 in won rounds and 919 in lost ones.
- **Styles, rounds in which each landed:** Ravager 31, Atrophy 18, Scathing Blade 11, Frost Hammer 5 with Demolish 3, Crushing Blow 1 (after a parry, round 217, with Slam behind it), Comeback 1 (after an evade, round 191).
- **Berserk** fired in 30 rounds (31 times) and was refused 9 times. Since 434ddcf a refusal that names the wait sets the clock, so a refusal costs one try.
- **What costs him swings:** `melee:out_of_reach` 92 and `melee:timeout` 61 over the night (a focus that runs or kites off), `melee:stuck` 31, `melee:crowd_controlled` 8. The 60 `melee:water` all came in rounds 146 and 150, before feb811e.
- **Deaths:** he died in 20 of 37 rounds, and was the first of the group to die in 3. Targeted median 25 % of fight time, 50 % or more in 5 rounds. The enemy goes for him less than for Sigrid or Sigurd.

## Styles at Left Axe 24, Hammer 21, Parry 10

**Data** (growth is the style's GrowthRate × 200; value is growth per endurance, what `pickStyle` ranks plain styles by):

| Style | Line, level | Opening | End | Effect |
|---|---|---|---|---|
| Doubler | Left Axe 4 | behind | 10 | bleed |
| Ravager | Left Axe 6 | anytime | 10 | value 7, opens the chain |
| Polar Light | Left Axe 8 | after his parry | 5 | attack speed −16 % for 20 s |
| Snowblind | Left Axe 10 | anytime | 10 | **taunt** |
| Atrophy | Left Axe 12 | after Ravager | 10 | snare 60 % for 12 s |
| Frost Shadow | Left Axe 15 | after Polar Light | 10 | |
| Comeback | Left Axe 18 | after his evade | 5 | |
| Scathing Blade | Left Axe 21 | after Atrophy | 10 | attack speed −21 % for 20 s |
| Crushing Blow | Hammer 4 | after his parry | 5 | 2 s stun |
| Placate | Hammer 6 | anytime | 10 | detaunt |
| Ruiner | Hammer 10 | anytime | 10 | value 8 |
| Frost Hammer | Hammer 12 | side | 10 | snare 60 % for 15 s |
| Provoke | Hammer 15 | anytime | 5 | **taunt**, value 23 |
| Demolish | Hammer 18 | after Frost Hammer | 15 | 2 s stun |
| Revenge | Hammer 21 | after a block | 5 | never fires |

- **The chain never started under `fighterStyle`.** It takes the plain style with the best value, Ruiner (8) over Ravager (7), and has no idea of chains, so Atrophy (13) and Scathing Blade (19), with their snare and attack slow, never came. `withChain` swaps the plain swing for the opener whose follow-up is worth most. A test holds both: `fighterStyle` alone gives `['Polar Light', 'Ruiner']`, the kit `['Polar Light', 'Ravager']`.
- **Against players Provoke would have been his plain swing** (value 23, five endurance), a taunt that does nothing to a player. `stylesFor` leaves it and Snowblind out.
- **Revenge never fires. Server code:** its block opening needs a shield, which a Berserker can't use. Hammer 21 buys nothing over Hammer 18; the points would put Parry at about 14 instead of 10. The build file is unchanged.
- **Round 123 (2026-11-10, before the kit):** on the generic melee list he landed one Provoke, 324 damage, and was "stuck" three times with max speed 0 (rooted).

## Server code worth knowing

- **Left Axe:** with a non-shield weapon in the left hand and Left Axe trained, every swing round hits with both hands, each at 0.625 + 0.0034 × Left Axe of full damage (70.7 % at 24). A Left Axe in the right hand counts as Axe, which is 1 for Ragnar. The gear template gives him a Hammer in the right and a Left Axe in the left (`sdk/group/gear-template.ts`), and the SDK's `canWield` treats Left Axe as a dual line. Hammer styles check only the right hand.
- **Berserk 4:** 20 s, reuse 7 minutes; every hit a critical (10-100 % more against 0-50 % without it); no parry, evade, block or intercept while it runs; not while mezzed, stunned or sitting (`BerserkAbilityHandler.cs`).
- **Protect** shifts only monster threat: nothing against players.
- **Repeat stuns:** nothing tracks stun immunity for Crushing Blow and Demolish (the Hero kit's `noteStun` does it for shields). A stun on an immune target loses only the stun.

## Open

- Berserk's thresholds are a first guess (Community: guides save it for a kill). It fires in almost every round (30 of 37), but the reports don't say whether the focus died within the 20 s after it. That needs the event log of a round, read against the Berserk time.
- **The chase.** Over 150 of his failures were a focus out of reach or a timeout: a kited focus or a caster behind their line. That is the group's focus choice (`hitInReach` in his character, `roleNukerReach` in groups/midgard/plan.ts), not the kit. A snare first (Frost Hammer from the side, Atrophy after Ravager) is what the kit has against it, and it comes only once he is in reach.
- Parry 14 for Hammer 18 in his build.
- Settled: a peel of his own. Ragnar's character has carried Bragi's `guardSoft` and `hitInReach` since round 137 (above).
