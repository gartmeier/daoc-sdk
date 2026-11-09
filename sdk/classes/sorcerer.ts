// The standard Sorcerer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list
// already nukes and mezzes from whatever it knows; what is the class's own is keeping power for those mezzes.
// learnings/classes/sorcerer.md says what that was worth, and what hasn't been run.

import { assist, type TacticsSettings } from '../group/behaviors';
import type { Behavior } from '../group/member';
import type { Character } from '../group/character';
import { thrifty } from './thrifty';

export interface SorcererOptions {
    /** No nukes below this % power; 0: no floor, as in Camelot's RvR rounds. 40 is what was measured. */
    saveBelow?: number;
    /** Below the fight, as a group adds them (Merlin's speed song, his power share). */
    chores?: Behavior<TacticsSettings>[];
}

export function sorcerer({ saveBelow = 40, chores = [] }: SorcererOptions = {}): Character {
    return { role: 'nuker', fight: [saveBelow > 0 ? thrifty(assist(), saveBelow) : assist()], ...(chores.length ? { chores } : {}) };
}
