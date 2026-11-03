// The standard Theurgist: a starting point a bot imports into bots/<bot>/character.ts and tunes. Its one
// direct nuke empties the pool every fight, so what is the class's own is stopping at a floor of power.
// learnings/classes/theurgist.md says what that was worth, and what it costs.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';
import { thrifty } from './thrifty';

export interface TheurgistOptions {
    /** No nukes below this % power. 40 is what was measured. */
    saveBelow?: number;
}

export function theurgist({ saveBelow = 40 }: TheurgistOptions = {}): Character {
    return { role: 'nuker', fight: [thrifty(assist(), saveBelow)] };
}
