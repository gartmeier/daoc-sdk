// The standard Mercenary: a starting point a bot imports into bots/<bot>/character.ts and tunes. Albion's dual-wield
// melee: roleForClass makes it melee, and the melee list already swings at the focus. What is the class's own is its
// style pick (kitStyle, sdk/classes/hybrid.ts): the fighter's follow-ups, reactions and back positional (Shadow's Edge,
// then Eclipse's attack slow or Penumbra), and at a player Inflame or Enrage as the plain swing. Both are taunts, and a
// taunt's growth is damage like any (114 for 10 endurance, against Uppercut's 68); a player has no threat table, so against
// one they are the best anytime swings. Two swords, no shield (the "Pure damage" build and the gear template): the Shields
// styles and Riposte (after a block) never fire. learnings/classes/mercenary.md says why, and what is open.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';
import { kitStyle } from './hybrid';

export const mercenaryStyle = kitStyle();

export function mercenary(): Character {
    return { role: 'melee', fight: [assist({ melee: true, holdMs: 0, style: mercenaryStyle })] };
}
