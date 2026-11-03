// The standard Enchanter: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role
// list already nukes, buffs and mezzes from whatever the bot knows; what is the class's own is its heat
// debuff. learnings/classes/enchanter.md says what that is worth at which level, and why it does nothing
// on a Mana line below 27.

import type { Character } from '../group/character';
import { resistDebuff } from '../group/debuff';

export interface EnchanterOptions {
    /** Other casters nuking heat beside this one: a Hibernian group's Light Mentalist counts. */
    heatAllies?: number;
}

export function enchanter({ heatAllies = 0 }: EnchanterOptions = {}): Character {
    return { role: 'nuker', react: [resistDebuff({ allies: heatAllies })] };
}
