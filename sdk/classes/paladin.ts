// The standard Paladin: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's
// list has no song, so without this no chant ever plays; what is the class's own is singing while it tanks.
// learnings/classes/paladin.md says what that plays, and what hasn't been run.

import { song } from '../group/behaviors';
import type { Character } from '../group/character';

export function paladin(): Character {
    return { role: 'tank', react: [song()] };
}
