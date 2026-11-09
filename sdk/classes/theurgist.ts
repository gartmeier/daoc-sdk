// The standard Theurgist: a starting point a bot imports into bots/<bot>/character.ts and tunes. Its one
// direct nuke empties the pool every fight, so what is the class's own is stopping at a floor of power.
// learnings/classes/theurgist.md says what that was worth, and what it costs.

import { assist, type TacticsSettings } from '../group/behaviors';
import type { Behavior } from '../group/member';
import type { Character } from '../group/character';
import { thrifty } from './thrifty';

export interface TheurgistOptions {
    /** No nukes below this % power, nor his pets, which count as nukes (fnfPet). 40 is what was measured. */
    saveBelow?: number;
    /** Below the fight, as a group adds them. */
    chores?: Behavior<TacticsSettings>[];
}

export function theurgist({ saveBelow = 40, chores = [] }: TheurgistOptions = {}): Character {
    return { role: 'nuker', fight: [saveBelow > 0 ? thrifty(assist(), saveBelow) : assist()], pet: { fnfFloor: saveBelow }, ...(chores.length ? { chores } : {}) };
}
