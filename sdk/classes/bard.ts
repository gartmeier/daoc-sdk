// The standard Bard: a starting point a bot imports into bots/<bot>/character.ts and tunes. The support list and the
// wolf pack's already mezz, interrupt and sing; what is the class's own is:
// - Clarifying Harmonies, the mezz cure (Music, baseline, 3 s, range 1500): Hibernia's only one, and arena rounds 3-4 had
//   Brigid, Niamh and Oisin himself mezzed. cureMezz goes in as urgent: in the pack's support list, above interrupt, crowd
//   control and songs (Character.urgent, f4135fd), so a mezzed healer doesn't wait for them.
// - interruptOnTheRun, in the instant slot above flee (Character.instant, e72ffe8): with a melee on him flee takes every
//   turn, and his instant Minor Lullaby (range 2300) went unused while their casters cast.
// learnings/classes/bard.md says why, and what was measured.

import { cureMezz, foeInView, hammeredBy, interruptRank, type TacticsSettings } from '../group/behaviors';
import { untouchable } from '../group/blackboard';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { Contact, Role } from '../group/types';

/** An enemy started a cast this long ago at most, so an instant can still catch it (behaviors.ts INTERRUPT_WINDOW_MS). */
const WINDOW_MS = 2000;

/**
 * The casters to interrupt, best first: a recent cast, not crowd-controlled (an amnesia would wake a mezz) or untouchable,
 * outside an engage only one casting at one of ours; ranked as interrupt() ranks them.
 */
export function castersToCut(contacts: readonly Contact[], roles: ReadonlyMap<string, Role>, engaged: boolean, now: number): Contact[] {
    return contacts
        .filter(c => c.kind === 'player' && !c.stale && !c.cc && !untouchable(c, now) && now - (c.castingAt ?? -Infinity) <= WINDOW_MS)
        .filter(c => engaged || (!!c.targetBySpell && !!c.target && roles.has(c.target)))
        .sort((a, b) => interruptRank(a, roles) - interruptRank(b, roles));
}

/** interrupt()'s instant cast, without its walk, and only while a melee is on him: otherwise interrupt() below has the turn. */
export const interruptOnTheRun = (): Behavior<TacticsSettings> => ({
    name: 'interruptOnTheRun',
    interruptible: false,
    async run(ctx) {
        if (!hammeredBy(ctx)) return false;
        const spells = ctx.spells.interrupts();
        if (!spells.length) return false;
        const roles = new Map(ctx.members().map(m => [m.name, m.role] as const));
        for (const foe of castersToCut(ctx.picture().contacts, roles, ctx.orders().phase === 'engage', Date.now())) {
            const view = foeInView(ctx, foe.objectId);
            if (!view || ('isDead' in view && view.isDead)) continue;
            const sp = spells.find(s => view.distance <= s.range);
            if (!sp) continue;
            ctx.doing('interrupt', foe.objectId, `${sp.spell.name} (on the run)`);
            ctx.result('interrupt', await ctx.bot.castSpell(sp.spell, foe.objectId, { approach: false }), foe.objectId);
            return true;
        }
        return false;
    },
});

export function bard(): Character {
    return { role: 'support', instant: [interruptOnTheRun()], urgent: [cureMezz()] };
}
