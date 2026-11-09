// The standard Healer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list heals,
// mezzes and buffs from whatever she knows; what is the class's own is Cleanse Mind, the mezz cure (baseline
// Pacification 23): a member held by an enemy mezz is lost for its whole length, and she is Midgard's only cure.
// It goes in below heal and crowd control. learnings/classes/healer.md says what, and what has been measured.

import { cureMezz } from '../group/behaviors';
import type { Character } from '../group/character';

export function healer(): Character {
    return { role: 'healer', react: [cureMezz()] };
}
