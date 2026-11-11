// The standard Nightshade (Hibernia): the assassins' kit (hide, lurk, open from stealth), sdk/classes/stealther.ts.
// A bot imports it into bots/<bot>/character.ts; learnings/classes/nightshade.md has the build, the play and what is verified.
import type { Character } from '../group/character';
import { stealther } from './stealther';

export function nightshade(): Character {
    return stealther();
}
