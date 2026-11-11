// The standard Infiltrator (Albion): the assassins' kit (hide, lurk, open from stealth), sdk/classes/stealther.ts.
// A bot imports it into bots/<bot>/character.ts; learnings/classes/infiltrator.md has the build, the play and what is verified.
import type { Character } from '../group/character';
import { stealther } from './stealther';

export function infiltrator(): Character {
    return stealther();
}
