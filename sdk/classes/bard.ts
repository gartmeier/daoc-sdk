// The standard Bard: a starting point a bot imports into bots/<bot>/character.ts and tunes. The support list and the
// wolf pack's already mezz, interrupt and sing; what is the class's own is Clarifying Harmonies, the mezz cure
// (Music, baseline, 3 s, range 1500): Hibernia's only one, and arena rounds 3-4 had Brigid, Niamh and Oisin himself
// mezzed. cureMezz goes in as react, which in a list without a fight lands at shedLoad: below crowd control and
// songs, so it takes the turns those leave. learnings/classes/bard.md says why, and what was measured.

import { cureMezz } from '../group/behaviors';
import type { Character } from '../group/character';

export function bard(): Character {
    return { role: 'support', react: [cureMezz()] };
}
