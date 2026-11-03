// The standard Sorcerer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list
// already nukes and mezzes from whatever it knows; what is the class's own is keeping power for those mezzes.
// learnings/classes/sorcerer.md says what that was worth, and what hasn't been run.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';
import { thrifty } from './thrifty';

export interface SorcererOptions {
    /** No nukes below this % power. 40 is what was measured. */
    saveBelow?: number;
}

export function sorcerer({ saveBelow = 40 }: SorcererOptions = {}): Character {
    return { role: 'nuker', fight: [thrifty(assist(), saveBelow)] };
}
