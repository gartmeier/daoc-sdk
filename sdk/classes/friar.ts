// The standard Friar: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list
// already casts his single heals, his rez and his buffs. What is the class's own: his group heal (Angelic
// Commendation, 33 to each member in 2000), which `heal` never picks; his endurance chant (Saint's Vigor, free),
// which no healer list plays; and, as the Druid kit does, a walk into heal reach of a hurt member beyond it.
// He has no crowd control, no instant heal and no spell stun at 24, so the Cleric's helpers find nothing for him.
// learnings/classes/friar.md says why, and what is open.

import { song } from '../group/behaviors';
import type { Character } from '../group/character';
import { groupHeal, reachHurt } from './druid';

export interface FriarOptions {
    /** groupHeal: how many members (him too) must each miss most of its 33. */
    groupHealMin?: number;
    /** groupHeal: below this % power he keeps it for single heals. */
    groupHealAbove?: number;
    /** Saint's Vigor, the group's endurance, between his heals. On by default. */
    chant?: boolean;
}

export function friar({ groupHealMin = 3, groupHealAbove = 30, chant = true }: FriarOptions = {}): Character {
    return {
        role: 'healer',
        // Below heal: the group heal only tops up while nobody is under the heal lines, and a 33-point heal never takes a
        // turn from Major Revival (136). Then the walk, with nobody in his reach to heal.
        react: [groupHeal(groupHealMin, groupHealAbove), reachHurt()],
        ...(chant ? { chores: [song()] } : {}),
    };
}
