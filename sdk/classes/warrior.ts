// The standard Warrior: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's list
// already taunts and swings a damage style; what is the class's own is what a block, a parry or a position opens,
// and its shield stuns. At Shields 18 a Warrior has the Hero's Numb, Stun, Disable and Incapacitate under the same
// names, so the Hero kit's heroStyle applies: a stun at a player once per immunity (60 s), else the reacting tank's
// pick. learnings/classes/warrior.md says which on Axe, and what has been measured.
// 2026-11-11 (Midgard session): heroStyle replaces reactingTank's style. Rounds 4-119 landed Disable 1-2 times in a few rounds;
// the Hero, on heroStyle, lands a stun every round (hero.md). Measure the trade against Pillager in the next rounds.

import { tank } from '../group/behaviors';
import type { Character } from '../group/character';
import { heroStyle } from './hero';

export function warrior(): Character {
    return { role: 'tank', fight: [tank({ style: heroStyle() })] };
}
