// The standard Warrior: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's list
// already taunts and swings a damage style; what is the class's own is what a block, a parry or a position
// opens. learnings/classes/warrior.md says which on Axe, and that they haven't been played.

import type { Character } from '../group/character';
import { reactingTank } from './reacting-tank';

export function warrior(): Character {
    return { role: 'tank', fight: [reactingTank()] };
}
