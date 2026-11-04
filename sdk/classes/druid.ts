// The standard Druid: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list
// already heals, roots and buffs from whatever the bot knows, and a Heal druid has no damage spell for a fight
// to cast, so by default this holds only the role. A Nature build does have one. learnings/classes/druid.md
// says what that reaches, and that it hasn't been played.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';
import { thrifty } from './thrifty';

export interface DruidOptions {
    /** For a Nature build: cast its DoTs on the focus, above this % power. Without a damage spell it does nothing. */
    dotsAbove?: number;
}

export function druid({ dotsAbove }: DruidOptions = {}): Character {
    return dotsAbove === undefined ? { role: 'healer' } : { role: 'healer', fight: [thrifty(assist(), dotsAbove)] };
}
