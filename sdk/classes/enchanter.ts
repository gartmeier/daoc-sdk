// The standard Enchanter: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role
// list already nukes, buffs and mezzes from whatever the bot knows; what is the class's own is its heat
// debuff. learnings/classes/enchanter.md says what that is worth at which level, and why it does nothing
// on a Mana line below 27.

import type { Character } from '../group/character';
import { resistDebuff } from '../group/debuff';
import { nukerFight, quickcastUnderFire } from './cabalist';

export interface EnchanterOptions {
    /** Other casters nuking heat beside this one: a Hibernian group's Light Mentalist counts. */
    heatAllies?: number;
    /** Nukes on a free enemy in reach while the focus is out of it (offFocus, from the Cabalist kit). On by default. */
    offFocus?: boolean;
}

/** Arena round 10 (2026-11-09): wiped by Albion in 79 s, Ciaran 2 nukes, moving 73 % with the focus on their back line out of reach. */
export function enchanter({ heatAllies = 0, offFocus = true }: EnchanterOptions = {}): Character {
    return { role: 'nuker', instant: [quickcastUnderFire()], react: [resistDebuff({ allies: heatAllies })], fight: nukerFight(0, offFocus) };
}
