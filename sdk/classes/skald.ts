// The standard Skald: a starting point a bot imports into bots/<bot>/character.ts and tunes. roleForClass
// makes it support, which stands at range and never swings; its melee list already sings and fights.
// learnings/classes/skald.md says why, and what has been measured.

import type { Character } from '../group/character';

export function skald(): Character {
    return { role: 'melee' };
}
