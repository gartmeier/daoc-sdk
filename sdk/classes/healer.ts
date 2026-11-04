// The standard Healer: a starting point a bot imports into bots/<bot>/character.ts and tunes. Only the role, and
// it's what roleForClass gives: the list heals, mezzes and buffs from whatever she knows, she has no damage spell
// for a fight to cast, and what's left needs a behaviour. learnings/classes/healer.md says what.

import type { Character } from '../group/character';

export function healer(): Character {
    return { role: 'healer' };
}
