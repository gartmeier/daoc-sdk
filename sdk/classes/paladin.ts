// The standard Paladin: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's
// list has no song, so without this no chant ever plays; what is the class's own is singing while it tanks.
// learnings/classes/paladin.md says what that plays, and what hasn't been run.

import { song, tank } from '../group/behaviors';
import type { Character } from '../group/character';
import type { TwistSettings } from '../group/songs';
import { twisting } from '../group/twist';

/** `twist`: chants in turn while he swings, instead of the one song() holds. Off by default. */
export function paladin(opts: { twist?: TwistSettings } = {}): Character {
    return { role: 'tank', react: [song()], ...(opts.twist ? { fight: [twisting(tank(), opts.twist)] } : {}) };
}
