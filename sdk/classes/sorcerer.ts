// The standard Sorcerer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list
// already nukes and mezzes from whatever it knows; what is the class's own is keeping power for those mezzes.
// learnings/classes/sorcerer.md says what that was worth, and what hasn't been run.

import { type TacticsSettings } from '../group/behaviors';
import type { Behavior } from '../group/member';
import type { Character } from '../group/character';
import { meleeDebuff, nukerFight, quickcastUnderFire } from './cabalist';
import { selfBuff } from './paladin';

/** Shield Mind (Mind 16): mezzes on him last 10 % less (MesmerizeDurationBuff, CCSpellHandler.cs:212). buff() doesn't slot it. */
/** His power is the group's mezzes and cures: debuffs only on a melee on him, and only above this. Arena round 116: 11 debuffs, 0 damage, the group waiting 17 % of the run on his power. */
export const SORCERER_DEBUFF_MIN_MANA = 50;

export const SORCERER_SELF_BUFFS: readonly string[] = ['MesmerizeDurationBuff'];

export interface SorcererOptions {
    /** No nukes below this % power; 0: no floor, as in Camelot's RvR rounds. 40 is what was measured. */
    saveBelow?: number;
    /** Below the fight, as a group adds them (Merlin's speed song, his power share). */
    chores?: Behavior<TacticsSettings>[];
    /** Its nukes on a free enemy in reach while the focus is out of it (cabalist.ts offFocus). On by default. */
    offFocus?: boolean;
    /** Instant debuffs on a melee hitting him or a caster (cabalist.ts meleeDebuff, the instant slot). On by default. */
    meleeDebuff?: boolean;
}

export function sorcerer({ saveBelow = 40, chores = [], offFocus: off = true, meleeDebuff: debuff = true }: SorcererOptions = {}): Character {
    return { role: 'nuker', instant: [quickcastUnderFire(), ...(debuff ? [meleeDebuff({ selfOnly: true, minMana: SORCERER_DEBUFF_MIN_MANA })] : [])], fight: nukerFight(saveBelow, off), chores: [...chores, selfBuff(SORCERER_SELF_BUFFS)] };
}
