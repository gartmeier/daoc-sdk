// The standard Scout (Albion): the archers' kit (hide, shoot from range, melee when caught), sdk/classes/archer.ts.
// A bot imports it into bots/<bot>/character.ts; learnings/classes/scout.md has the build, the play and what is verified.
import type { Character } from '../group/character';
import { archer } from './archer';

export function scout(): Character {
    return archer();
}
