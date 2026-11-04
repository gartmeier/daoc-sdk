// The standard Spiritmaster: a starting point a bot imports into bots/<bot>/character.ts and tunes. Only the role,
// and it's what roleForClass gives: what has been measured on her is a setting or a piece of gear, and a focus
// staff ended her `no_power` without a floor. learnings/classes/spiritmaster.md has the runs.

import type { Character } from '../group/character';

export function spiritmaster(): Character {
    return { role: 'nuker' };
}
