// The standard Cabalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. Only the role, and
// it's what roleForClass gives: the list casts her DoTs first as it is, and they hold out on power without a floor.
// learnings/classes/cabalist.md says what has been measured.

import type { Character } from '../group/character';

export function cabalist(): Character {
    return { role: 'nuker' };
}
