// The standard Savage: a starting point a bot imports into bots/<bot>/character.ts and tunes. Midgard's hand-to-hand
// melee: roleForClass makes it melee. What is the class's own:
// - `savageStyle` (kitStyle, sdk/classes/hybrid.ts): at a player, Clan's Call first once per stun immunity (from behind,
//   4 s stun; Clan's Might follows it with 5 s more and the line's best growth, 290), with the fighter's choice behind it
//   for when he isn't behind. The plain swing at a player is Wild Call: a taunt, but its growth (173 for 10) is damage and
//   a player has no threat table. Without it a Savage has no plain swing worth its endurance at all (Kelgor's Bane 7 for 5).
// - `kelgor`: his Savagery self buffs, Drive of Kelgor (+20 % attack speed) and Fierce Blows (damage), each 15 s with a 5 s
//   timer, paid with 3 % of his health (SavageBuff.cs:9-24). Cast in the engage with the focus in reach, while he is above
//   60 %. Spellbook.buffs() leaves Savage buffs out, so buff() doesn't spend his health between fights.
// learnings/classes/savage.md says why, and what is open.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';
import { combatBuff, kitStyle, stunOpener } from './hybrid';

/** Clan's Call's stun (StyleStun 4 s), and Clan's Might's after it (5 s), which start the same 60 s immunity. */
export const SAVAGE_OPENER = stunOpener("Clan's Call", 4000, { "Clan's Might": 5000 });
/** The buffs worth his health in a fight: attack speed and damage. Parry, evade and the resists are left out. */
export const KELGOR_TYPES: ReadonlySet<string> = new Set(['SavageCombatSpeedBuff', 'SavageDPSBuff']);
/** Above this % health only: each costs 3 %, every 15 s. */
export const KELGOR_MIN_HP = 60;

export const savageStyle = kitStyle({ openers: [SAVAGE_OPENER] });

export const kelgor = () => combatBuff({ name: 'kelgor', want: s => KELGOR_TYPES.has(s.type), minHp: KELGOR_MIN_HP });

export function savage(): Character {
    return { role: 'melee', react: [kelgor()], fight: [assist({ melee: true, holdMs: 0, style: savageStyle })] };
}
