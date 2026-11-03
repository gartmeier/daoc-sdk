// The standard Shaman: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's
// list has no fight, so a Shaman with nothing to heal stands idle; what is the class's own is casting its
// DoTs on the focus. learnings/classes/shaman.md says what that reaches and what has been measured.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';

export function shaman(): Character {
    return { role: 'healer', fight: [assist()] };
}
