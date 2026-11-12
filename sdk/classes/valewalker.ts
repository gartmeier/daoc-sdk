// The standard Valewalker: a starting point a bot imports into bots/<bot>/character.ts and tunes. Hibernia's scythe
// melee with nature magic: roleForClass makes it melee. What is the class's own:
// - `valewalkerStyle` (kitStyle, sdk/classes/hybrid.ts): at a player, Stunning Blade first once per stun immunity (from
//   the side, 5 s; Winter's Scythe follows it), with the fighter's choice behind it. The plain swing at a player is
//   Taunting Scythe (118 growth for 10): his only other anytime style is Reaper (11 for 15), and a taunt's growth is damage.
//   The parry chain Sawgrass -> Thorny Shield -> Grasping Roots (262) and the evade one Arboreal Fire -> Foxfire are the
//   fighter's reactions and follow-ups.
// - `kudzu`: Alacrity of Kudzu (+22 % attack speed, 30 s, 2 minutes to reuse) in the engage with the focus in reach.
//   Spellbook.buffs() leaves a self buff whose timer is longer than it lasts out, so buff() doesn't spend it on a trip.
// - `snareFocus`: Conceal Path (35 % snare, instant, range 1500) on a focus player that is out of melee reach.
// - `keepProc`: Banestrike (damage proc) and Barkcrust (defensive proc), 20 minutes, between fights: buff() has no slot for procs.
// Grove's Armor (AF) and Forest's Revenge (damage shield) are buff()'s. Enemy's Debt (2.5 s lifedrain) is left out: a swing
// at him interrupts it. learnings/classes/valewalker.md says why, and what is open.

import { assist } from '../group/behaviors';
import type { Character } from '../group/character';
import { combatBuff, keepSelfBuff, kitStyle, snareFocus, stunOpener } from './hybrid';

/** Stunning Blade's stun (StyleStun 5 s). */
export const VALEWALKER_OPENER = stunOpener('Stunning Blade', 5000);

export const valewalkerStyle = kitStyle({ openers: [VALEWALKER_OPENER] });

export const kudzu = () => combatBuff({ name: 'kudzu', want: s => s.type === 'CombatSpeedBuff' });
export const keepProc = () => keepSelfBuff({ name: 'keepProc', types: ['OffensiveProc', 'DefensiveProc'] });

export function valewalker(): Character {
    return { role: 'melee', react: [kudzu(), snareFocus()], fight: [assist({ melee: true, holdMs: 0, style: valewalkerStyle })], chores: [keepProc()] };
}
