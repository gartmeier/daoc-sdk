// The standard Healer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list heals,
// mezzes and buffs from whatever she knows; what is the class's own:
// - Cleanse Mind, the mezz cure (baseline Pacification 23): a member held by an enemy mezz is lost for its whole length,
//   and she is Midgard's only cure. It goes in as urgent: in the pack's healer list below emergencyHeal and above heal.
// - Halt Attack, the baseline stun (2.5 s, range 1500, 8 s): the Cleric kit's stunPeel, on an enemy in melee on our soft
//   members, else on the enemy healer while our focus is low. Below heal and crowd control.
// Neither starts with an enemy swinging at her: a swing ends a cast half way. Both are guarded: a shared behaviour that
// throws costs the list a whole turn, and above heal that was every heal of arena round 9. learnings/classes/healer.md
// says what, and what has been measured.

import { cureMezz, hammeredBy, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { executionContext } from '../execution-context';
import { stunPeel } from './cleric';

/** `inner` only while no enemy player is in melee on us: its cast would be interrupted (hammeredBy). */
export const unlessHammered = (inner: Behavior<TacticsSettings>): Behavior<TacticsSettings> => ({
    ...inner,
    run: ctx => (hammeredBy(ctx) ? ctx.skip(`${inner.name}: a melee is on us`) : inner.run(ctx)),
});

/**
 * `inner`, with an error it throws read as a skip, so the list goes on to the next behaviour (heal) in the same turn. A
 * member's list treats a throw as a turn taken, with a second's pause (MemberAgent.step). A cancel still throws.
 * Arena round 9 (2026-11-09): cureMezz threw "RANGE_MARGIN_3D is not defined" (a shared file loaded mid-edit) on every
 * turn above heal, and Sigrid healed 5 times in 10 minutes.
 */
export const guarded = (inner: Behavior<TacticsSettings>): Behavior<TacticsSettings> => ({
    ...inner,
    async run(ctx) {
        try {
            return await inner.run(ctx);
        } catch (error) {
            if (executionContext.getStore()?.signal.aborted) throw error;
            return ctx.skip(`${inner.name} threw: ${(error as Error)?.message ?? error}`);
        }
    },
});

export function healer(): Character {
    return { role: 'healer', urgent: [guarded(unlessHammered(cureMezz()))], fight: [guarded(unlessHammered(stunPeel()))] };
}
