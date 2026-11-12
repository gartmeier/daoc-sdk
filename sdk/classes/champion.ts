// The standard Champion: a starting point a bot imports into bots/<bot>/character.ts and tunes. Hibernia's Valor hybrid
// with a large weapon: roleForClass makes it melee. What is the class's own:
// - `championStyle` (kitStyle, sdk/classes/hybrid.ts): at a player, Frontal Assault first (from the front, a 60 % snare for
//   19 s) whenever the last one has run out, with the fighter's choice behind it; the plain swing at a player is Celtic Fury
//   (117 growth for 10: a taunt, and a taunt's growth is damage). The parry chain Celtic Rage -> Hibernian Vigor (2 s stun) and
//   the side one Hibernian Force -> Obliteration (attack slow) are the fighter's reactions, positionals and follow-ups.
// - `interrupt()` (instant, above flee): the shared behaviour casts Blast of Defiance (61 damage, instant, range 1500, 15 s
//   timer) at a casting enemy, as the Thane's Horn.
// - `snareFocus`: Lumber (40 % snare, 68 s, instant, range 1500) on a focus player out of melee reach.
// - `enervate`: Enervation (strength and constitution -43, 60 s, instant) on a focus that fights in melee.
// Focus of the Champion (strength/constitution) is buff()'s. learnings/classes/champion.md says why, and what is open.

import { assist, interrupt } from '../group/behaviors';
import type { Character } from '../group/character';
import { debuffFocus, kitStyle, snareFocus, type Opener } from './hybrid';

/** Frontal Assault's snare (StyleSpeedDecrease 60 % for 19 s): again once it has run out. */
export const CHAMPION_OPENER: Opener = { name: 'Frontal Assault', lastsMs: 19_000, immuneMs: 0 };

export const championStyle = kitStyle({ openers: [CHAMPION_OPENER] });

export const enervate = () => debuffFocus({ name: 'enervate', type: 'StrengthConstitutionDebuff', roles: ['melee', 'tank'] });

export function champion(): Character {
    return { role: 'melee', instant: [interrupt()], react: [snareFocus(), enervate()], fight: [assist({ melee: true, holdMs: 0, style: championStyle })] };
}
