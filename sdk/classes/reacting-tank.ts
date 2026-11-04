// A tank's fight that also swings what a block, a parry or a position opens. The plain tank swings one damage
// style, and with the reactions in reach at 24 (a Hero's or Warrior's stuns) that leaves most of the shield
// line unused. Taunts stay the tank's own business, so the damage style is the plain tank's too. Not played.
// learnings/classes/hero.md has the styles.

import { tank, type StylePick } from '../group/behaviors';
import { fighterStyle, raisesThreat } from '../group/styles';

/** Styles down to killNpc's own limit, as the plain tank's: this adds reactions and takes no swing away. */
const fighter = fighterStyle({ saveEndurance: 15 });

export const reactingStyle: StylePick = seen => fighter({ ...seen, styles: seen.styles.filter(s => !raisesThreat(s)) });

export const reactingTank = () => tank({ style: reactingStyle });
