// The standard Armsman: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's list
// already taunts and swings a damage style (Crippling Blow on a Polearm build); what is the class's own is what a
// parry or a position opens on the line in his hands. With a two-hander out the server clears the left hand
// (GameLiving.cs), so his shield styles, block and Guard do nothing, and a pick from everything he wears would queue
// the shield's Disable beside a polearm style and force a swap. The kit picks from one weapon line, the reacting
// tank's way. learnings/classes/armsman.md says why, and what is open.

import { tank, type StylePick } from '../group/behaviors';
import type { Character } from '../group/character';
import { reactingStyle } from './reacting-tank';

/** The reacting tank's pick (reactions, positionals, follow-ups, a plain style behind) from `weapon`'s styles only. */
export const lineStyle = (weapon: string): StylePick => seen => reactingStyle({ ...seen, styles: seen.styles.filter(s => s.details?.weapon === weapon || s.details?.weapon === 'Any') });

export interface ArmsmanOptions {
    /** The line his build swings, in a style's words (Polearm, Two Handed, Slash, Thrust, Crush). Polearm by default, Gawain's. */
    weapon?: string;
}

export function armsman({ weapon = 'Polearm' }: ArmsmanOptions = {}): Character {
    return { role: 'tank', fight: [tank({ style: lineStyle(weapon) })] };
}
