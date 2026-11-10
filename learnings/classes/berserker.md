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

**Not played.** Bench bot Ragnar, from 2026-11-10. To look for in the next rounds: `berserk` in his actions (it should come once a round at most), Ravager, Atrophy and Scathing Blade in the styles column, and his damage against Bragi's.

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

- Berserk's thresholds are a first guess (Community: guides save it for a kill). Look at whether the focus dies within the 20 s after it.
- A peel of his own: Bragi's `guardSoft` is in Bragi's character only. With Ragnar and no Skald, nobody of the melee peels.
- Parry 14 for Hammer 18 in his build.
