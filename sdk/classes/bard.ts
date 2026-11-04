// The standard Bard: a starting point a bot imports into bots/<bot>/character.ts and tunes. Only the role, and
// it's what roleForClass gives: the support list and the wolf pack's already mezz and sing, and a shout's range
// is under half the distance they stand at. learnings/classes/bard.md says why, and what would change that.

import type { Character } from '../group/character';

export function bard(): Character {
    return { role: 'support' };
}
