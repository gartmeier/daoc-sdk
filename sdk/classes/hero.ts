// The standard Hero: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's list
// already taunts and swings a damage style; what is the class's own is the stuns its shield and blades open
// after a block. learnings/classes/hero.md says which, and that they haven't been played.

import type { Character } from '../group/character';
import { reactingTank } from './reacting-tank';

export function hero(): Character {
    return { role: 'tank', fight: [reactingTank()] };
}
