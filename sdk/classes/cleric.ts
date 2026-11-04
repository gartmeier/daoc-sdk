// The standard Cleric: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list
// has no fight, and with no mezz or root a Cleric with nothing to heal stands idle; what is the class's own is
// casting Smite in that time, above a floor of power for the heals. learnings/classes/cleric.md says what that
// reaches, and that neither it nor the floor has been played.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';
import { thrifty } from './thrifty';

export interface ClericOptions {
    /** No nukes below this % power. A guess: Greater Revival costs 52. */
    saveBelow?: number;
}

export function cleric({ saveBelow = 50 }: ClericOptions = {}): Character {
    return { role: 'healer', fight: [thrifty(assist(), saveBelow)] };
}
