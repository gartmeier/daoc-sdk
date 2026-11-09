// The standard Warrior: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's list
// already taunts and swings a damage style; what is the class's own is what a block, a parry or a position opens.
// learnings/classes/warrior.md says which on Axe, and what has been measured. Against a player, fighterStyle reads
// whom it is on from its last swing (styles.ts heldElsewhere), so a positional (Disable, a 4 s stun from the side) comes up.

import type { Character } from '../group/character';
import { reactingTank } from './reacting-tank';

export function warrior(): Character {
    return { role: 'tank', fight: [reactingTank()] };
}
