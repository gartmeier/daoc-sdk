// The standard Friar: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list
// already casts his single heals, his rez and his buffs. What is the class's own: his group heal (Angelic
// Commendation, 33 to each member in 2000), which `heal` never picks; his endurance chant (Saint's Vigor, free),
// which no healer list plays; and, as the Druid kit does, a walk into heal reach of a hurt member beyond it.
// He has no crowd control, no instant heal and no spell stun at 24, so the Cleric's helpers find nothing for him.
// learnings/classes/friar.md says why, and what is open.

import { heal, song, type TacticsSettings } from '../group/behaviors';
import type { Behavior } from '../group/member';
import type { Character } from '../group/character';
import { groupHeal, quietlyAbove, reachHurt } from './druid';

export interface FriarOptions {
    /** groupHeal: how many members (him too) must each miss most of its 33. */
    groupHealMin?: number;
    /** groupHeal: below this % power he keeps it for single heals. */
    groupHealAbove?: number;
    /** Saint's Vigor, the group's endurance, between his heals. On by default. */
    chant?: boolean;
    /** topUp: heal a member below this % in his spare turns, above `topUpAbove` % power. 0: off. */
    topUpBelow?: number;
    topUpAbove?: number;
}

/**
 * The healer list's heal again, with higher lines (`below` % for everyone), in his spare turns and only above `above` % power.
 * Arena round 126 (2026-11-10): 9 heals, and still idle 55 % on "nothing to do" (48 turns) at the RvR lines of 75 / 70, while
 * six of ours died in 131 s. His heals are small (Major Revival 136, about a fifth of a template's health), so one that lands at
 * 85 % is one fewer to land under a burst. Below heal in his list: never ahead of a member under the real lines.
 */
export const topUp = (below = 85, above = 50): Behavior<TacticsSettings> => ({
    ...quietlyAbove({ ...heal({ limits: { tank: below, other: below } }), name: 'topUp' }, above),
    name: 'topUp',
});

/**
 * His top-ups stop at 70 % power: arena rounds 156 and 177 (2026-11-11) he ran dry mid-fight (idle 40 % and 26 % on "heal: not
 * enough power") with the floor at 50.
 */
export const FRIAR_TOP_UP_ABOVE = 70;

export function friar({ groupHealMin = 3, groupHealAbove = 30, chant = true, topUpBelow = 85, topUpAbove = FRIAR_TOP_UP_ABOVE }: FriarOptions = {}): Character {
    return {
        role: 'healer',
        // Below heal: the group heal only tops up while nobody is under the heal lines, and a 33-point heal never takes a
        // turn from Major Revival (136). Then single heals at the top-up line, then the walk, with nobody in his reach to heal.
        react: [groupHeal(groupHealMin, groupHealAbove), ...(topUpBelow > 0 ? [topUp(topUpBelow, topUpAbove)] : []), reachHurt()],
        ...(chant ? { chores: [song()] } : {}),
    };
}
