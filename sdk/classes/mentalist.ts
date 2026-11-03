// The standard Mentalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. It
// holds only what is the class's own; the role list already picks nukes, heals, mezzes and buffs from
// whatever the bot knows. Spec points aren't here: they are the character's bots/<bot>/build.ts, copied
// from data/builds/mentalist.ts. learnings/classes/mentalist.md says why, and what has been tested.

import type { Character } from '../group/character';

export interface MentalistKit {
    character: Character;
}

export function mentalist(): MentalistKit {
    return { character: { role: 'nuker' } };
}
