// The standard Mentalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. It
// holds only what is the class's own; the role list already picks nukes, heals, mezzes and buffs from
// whatever the bot knows. learnings/classes/mentalist.md says why, and what has been tested.

import type { Character } from '../group/character';

/** Spec weights, as a training plan reads them: always train the line furthest behind its weight. */
export const MENTALIST_BUILDS = {
    /** Levelling: power-cheap DoTs, the power regen buff and enough Mentalism to mezz. */
    levelling: { Mana: 1, Mentalism: 0.3 },
    /** The usual RvR split at 50: 46 Light, 28 Mentalism, 4 Mana. */
    rvr: { Light: 1, Mentalism: 0.61, Mana: 0.08 },
} as const satisfies Record<string, Record<string, number>>;

export type MentalistBuild = keyof typeof MENTALIST_BUILDS;

export interface MentalistKit {
    character: Character;
    specPlan: Record<string, number>;
}

export function mentalist({ build = 'levelling' }: { build?: MentalistBuild } = {}): MentalistKit {
    return {
        character: { role: 'nuker' },
        specPlan: { ...MENTALIST_BUILDS[build] },
    };
}
