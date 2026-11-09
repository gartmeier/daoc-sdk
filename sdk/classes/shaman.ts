// The standard Shaman: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's
// list has no fight, so a Shaman with nothing to heal stands idle; what is the class's own is its disease on the
// focus (it halves the healing the target gets), then its DoTs. learnings/classes/shaman.md says what that reaches
// and what has been measured.

import { assist, foeInView, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import type { Contact } from '../group/types';
import { guarded, unlessHammered } from './healer';

/** After a resist, try again this much later at the earliest: a resist leaves no timer. */
const RESIST_RETRY_MS = 6000;

/** The disease worth casting: an enemy Disease spell with range, ready by power. */
export const diseaseSpell = (all: readonly SpellPick[], mana: number): SpellPick | null =>
    all.filter(s => s.type === 'Disease' && s.target === 'Enemy' && s.range > 0 && s.power <= mana).sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;

/** Whether the focus takes a disease now: an enemy player, alive, free (a cast on a mezzed one wakes it), not held off by `until` (when ours runs out), in range. */
export function diseaseWanted(focus: Contact | undefined, until: number, distance: number, range: number, now = Date.now()): boolean {
    return !!focus && focus.kind === 'player' && !focus.stale && isAlive(focus) && !focus.cc && !untouchable(focus, now) && until <= now && distance <= range;
}

/** Infectious Spores on the focus in a fight, once per its length: the kill target's heals land at half. */
export const disease = (): Behavior<TacticsSettings> => ({
    name: 'disease',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || !o.focus) return false;
        const sp = diseaseSpell(ctx.spells.all(), ctx.me().mana);
        if (!sp || sp.spell.cooldownRemaining > 0) return false;
        const held: Map<number, number> = ctx.memory.get('diseaseUntil') ?? new Map();
        ctx.memory.set('diseaseUntil', held);
        const focus = ctx.contact(o.focus);
        const distance = foeInView(ctx, o.focus)?.distance ?? Infinity;
        if (!diseaseWanted(focus, held.get(o.focus) ?? 0, distance, sp.range)) return false;
        ctx.doing('nuke', o.focus, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, o.focus, { approach: false });
        ctx.result('nuke', c.success && c.resisted ? { ...c, success: false, reason: 'resisted' } : c, o.focus);
        const now = Date.now();
        held.set(o.focus, c.success && !c.resisted ? now + sp.duration * 1000 : now + RESIST_RETRY_MS);
        return true;
    },
});

export function shaman(): Character {
    return { role: 'healer', fight: [guarded(unlessHammered(disease())), assist()] };
}
