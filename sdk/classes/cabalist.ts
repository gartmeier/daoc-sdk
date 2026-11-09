// The standard Cabalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role is what
// roleForClass gives: the list casts her DoTs first as it is, and they hold out on power without a floor. What is
// the class's own is spreading them: with the focus out of her reach she puts them on a free enemy in reach (offFocus),
// which Albion's Sorcerer and Theurgist kits use for their nukes too. learnings/classes/cabalist.md says what has been measured.

import { assist, ccHolds, ckey, claimedBy, foeInView, hammeredBy, isDown, noteNukeEnd, stopSwinging, type TacticsSettings } from '../group/behaviors';
import { dist } from '../group/battleground';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { dotFamily } from '../group/spells';
import type { Contact, Orders, Point } from '../group/types';
import { thrifty } from './thrifty';

export interface CabalistOptions {
    /** No nukes below this % power; 0 (the default): no floor. */
    saveBelow?: number;
    /** DoTs and nukes on a free enemy in reach while the focus is out of it (offFocus). On by default. */
    offFocus?: boolean;
}

/** How long a cc claim keeps others' damage off its target: a mezz on its way. */
const CC_CLAIM_MS = 4000;

/**
 * Whom to hit while the focus is out of `range` (or held by crowd control): the nearest enemy player in reach that nobody
 * controls or is about to (a cc assignment, a cc claim), so no damage of ours wakes a mezz. Not a pet: its owner matters.
 * Null with the focus in reach and free, which is assist's.
 */
export function offFocusTarget(me: Point & { regionId: number }, focus: Contact | undefined, threats: readonly Contact[], orders: Pick<Orders, 'cc' | 'focus'>, range: number, focusHeld: boolean, claimed: (id: number) => boolean = () => false): Contact | null {
    if (focus && !focusHeld && dist(me, focus) <= range) return null;
    return threats
        .filter(t => t.kind === 'player' && !t.isPet && !t.stale && !t.cc && t.objectId !== orders.focus && t.regionId === me.regionId
            && !orders.cc.some(a => a.targetId === t.objectId) && !claimed(t.objectId) && dist(me, t) <= range)
        .sort((a, b) => dist(me, a) - dist(me, b))[0] ?? null;
}

/**
 * Below assist, which held its ground with the focus out of reach: her DoTs, then the top nuke, on offFocusTarget's pick, from
 * where she stands. The DoT families go in assist's memory for that target, so if it becomes the focus they aren't cast again.
 * Nothing with an enemy in melee on her (a cast would only be interrupted), and no area spells, which would wake a mezz.
 * Arena round 6 (2026-11-09): holding ground 700 behind the tank, Morgana idled 51 turns, Taliesin 67 and Merlin 39 on
 * "focus out of reach", and Morgana's nukes were out of range 10 times.
 */
export const offFocus = (): Behavior<TacticsSettings> => ({
    name: 'offFocus',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const focus = ctx.focus();
        const me = ctx.me();
        const best = ctx.spells.nuke({ aoe: false });
        if (!best) return false;
        const held = !!focus && ccHolds(ctx, focus);
        const t = offFocusTarget(me, focus, ctx.threats(), o, best.range, held, id => claimedBy(ctx, 'cc', id, CC_CLAIM_MS).length > 0);
        if (!t) return false;
        const seen = foeInView(ctx, t.objectId);
        if (!seen || isDown(ctx, seen)) return false;
        const key = `dotted:${ckey(t)}`;
        const dotted: Set<string> = ctx.memory.get(key) ?? new Set();
        const sp = ctx.spells.nuke({ dotted, targetHp: t.hp, aoe: false, byDamage: ctx.settings.strongestNuke });
        if (!sp || seen.distance > sp.range) return false;
        if (sp.castTime > 0 && hammeredBy(ctx)) return ctx.skip(`offFocus: ${sp.spell.name} would be interrupted`);
        await stopSwinging(ctx);
        ctx.doing('nuke', t.objectId, `${sp.spell.name} (off the focus)`);
        const c = await ctx.bot.castSpell(sp.spell, t.objectId, { approach: false });
        ctx.result('nuke', c, t.objectId);
        noteNukeEnd(ctx.memory, sp, c, Date.now());
        if (sp.type === 'DamageOverTime' && (c.success || /already has that effect/i.test(c.message ?? ''))) { dotted.add(dotFamily(sp)); ctx.memory.set(key, dotted); }
        if (!c.success && c.reason === 'out_of_range') await Bun.sleep(1000);
        else if (!c.success && (c.reason === 'crowd_controlled' || c.reason === 'no_power')) await Bun.sleep(Math.min(c.retryAfterMs ?? 2000, 3000));
        return true;
    },
});

/** The list's assist, then offFocus; both under the floor if there is one. */
export function nukerFight(saveBelow: number, withOffFocus: boolean): Behavior<TacticsSettings>[] {
    const floor = (b: Behavior<TacticsSettings>) => (saveBelow > 0 ? thrifty(b, saveBelow) : b);
    return [floor(assist()), ...(withOffFocus ? [floor(offFocus())] : [])];
}

export function cabalist({ saveBelow = 0, offFocus: off = true }: CabalistOptions = {}): Character {
    return { role: 'nuker', fight: nukerFight(saveBelow, off) };
}
