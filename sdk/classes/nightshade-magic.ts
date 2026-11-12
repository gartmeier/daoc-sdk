// The Nightshade's own spells (Nightshade Magic, baseline; spell type NightshadeNuke, a DirectDamage handler):
// an instant "of Night" (range 700, 20 s reuse) and a 3 s "Strike" (range 1500). From the DB dump (2026-11-12):
//
//   instant  Dart of Night (6) 12, Dagger of Night (9) 27, Knife of Night (13) 38, Stiletto of Night (18) 26,
//            Arrow of Night (24) 33. Knife of Night is the best at 24: more damage and less power (8 against 15).
//   3 s cast Lesser Twilight Strike (5) 13, Twilight Strike (8) 27, Lesser Gloaming Strike (12) 24, Gloaming Strike (16) 30,
//            Lesser Nocturnal Strike (22) 39.
//
// The group's interrupt behaviour takes only DirectDamage and Amnesia spells (spells.ts interrupts), and the melee role
// never casts, so the kit casts these itself:
//  - nightInstant (an instant behaviour): interrupt an enemy that started a cast within the last 2.5 s in reach; else
//    finish the focus out of melee reach when it runs or is under half health. Never from stealth: the opener is worth
//    five times as much.
//  - nightCast (fight, ahead of the melee fight): the 3 s Strike only on a runner beyond the instant's reach, under 40 %,
//    with nobody on us (a swing at us interrupts a cast; learnings/spells.md).

import type { Behavior, MemberContext } from '../group/member';
import type { Spell } from '../types';

/** Damage by name: which rank of each family hits hardest. */
export const NIGHT_INSTANTS: Readonly<Record<string, number>> = { 'Knife of Night': 38, 'Arrow of Night': 33, 'Dagger of Night': 27, 'Stiletto of Night': 26, 'Dart of Night': 12 };
export const NIGHT_CASTS: Readonly<Record<string, number>> = { 'Lesser Nocturnal Strike': 39, 'Gloaming Strike': 30, 'Twilight Strike': 27, 'Lesser Gloaming Strike': 24, 'Lesser Twilight Strike': 13, 'Dusk Strike': 10, 'Lesser Dusk Strike': 7 };
export const INSTANT_RANGE = 700;
export const CAST_RANGE = 1500;
/** The instant's reuse (spell RecastDelay 20). */
const INSTANT_REUSE_MS = 20_000;
/** A cast seen this recently can still be interrupted. */
const CASTING_WINDOW_MS = 2500;
/** Inside this the melee fight does the work. */
const MELEE = 180;

/** The hardest-hitting spell of a family among those we know. */
export function bestOf(spells: readonly Pick<Spell, 'name'>[], table: Readonly<Record<string, number>>): string | null {
    return spells.map(s => s.name).filter(n => table[n] !== undefined).sort((a, b) => table[b]! - table[a]!)[0] ?? null;
}

/** Whether to use the instant on the focus: out of melee, in reach, and running or under half health. */
export function finishWithInstant(o: { distance: number; hp: number; fleeing: boolean }): boolean {
    return o.distance > MELEE && o.distance <= INSTANT_RANGE - 50 && (o.fleeing || o.hp < 50);
}

/** Whether the 3 s cast is worth it: a runner past the instant's reach, low, and nobody on us. */
export function finishWithCast(o: { distance: number; hp: number; fleeing: boolean; onUs: number }): boolean {
    return o.onUs === 0 && o.distance > INSTANT_RANGE && o.distance <= CAST_RANGE - 100 && o.hp < 40 && o.fleeing;
}

const spellNamed = (ctx: Pick<MemberContext, 'sdk'>, name: string) => ctx.sdk.getSkills().spells.find(s => s.name === name) ?? null;
/** Further than at the last look by 40 or more within 2.5 s. */
function fleeing(ctx: MemberContext, id: number, distance: number): boolean {
    const now = Date.now();
    const prev = ctx.memory.get('nightFocus') as { id: number; d: number; at: number } | undefined;
    ctx.memory.set('nightFocus', { id, d: distance, at: now });
    return !!prev && prev.id === id && now - prev.at <= 2500 && distance - prev.d >= 40;
}

export const nightInstant = (): Behavior => ({
    name: 'nightInstant',
    interruptible: false,
    async run(ctx) {
        const me = ctx.me();
        if (me.isDead || ctx.sdk.isStealthed()) return false;
        const now = Date.now();
        if (now < (ctx.memory.get('nightInstantAt') ?? 0)) return false;
        const name = bestOf(ctx.sdk.getSkills().spells, NIGHT_INSTANTS);
        const spell = name ? spellNamed(ctx, name) : null;
        if (!spell || spell.cooldownRemaining > 0) return false;
        // An enemy player starting a cast, in reach: the interrupt first.
        const caster = ctx.picture().contacts
            .filter(c => c.kind === 'player' && !c.stale && now - (c.castingAt ?? 0) <= CASTING_WINDOW_MS)
            .map(c => ({ c, seen: ctx.sdk.getNearbyPlayer(c.objectId) }))
            .find(({ seen }) => !!seen && !seen.isDead && seen.distance <= INSTANT_RANGE - 50);
        let target: number | null = caster?.c.objectId ?? null;
        let why = 'interrupt a cast';
        if (target === null) {
            const o = ctx.orders();
            if (o.phase !== 'engage' || typeof o.focus !== 'number') return false;
            const f = ctx.sdk.getNearbyPlayer(o.focus) ?? ctx.sdk.getNearbyNpc(o.focus);
            if (!f) return false;
            if (!finishWithInstant({ distance: f.distance, hp: f.healthPercent, fleeing: fleeing(ctx, f.objectId, f.distance) })) return false;
            target = f.objectId;
            why = 'out of reach: finish it';
        }
        ctx.doing('nuke', target, `${spell.name}: ${why}`);
        const r = await ctx.bot.castSpell(spell, target, { approach: false });
        ctx.result('nightInstant', r, target);
        ctx.memory.set('nightInstantAt', Date.now() + (r.success ? INSTANT_REUSE_MS : 3000));
        return false;
    },
});

export const nightCast = (): Behavior => ({
    name: 'nightCast',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || typeof o.focus !== 'number' || ctx.sdk.isStealthed()) return false;
        const f = ctx.sdk.getNearbyPlayer(o.focus) ?? ctx.sdk.getNearbyNpc(o.focus);
        if (!f) return false;
        const onUs = ctx.bot.getAttackers().length + ctx.bot.getPlayerAttackers(4000).length;
        if (!finishWithCast({ distance: f.distance, hp: f.healthPercent, fleeing: fleeing(ctx, f.objectId, f.distance), onUs })) return false;
        const name = bestOf(ctx.sdk.getSkills().spells, NIGHT_CASTS);
        const spell = name ? spellNamed(ctx, name) : null;
        if (!spell) return false;
        ctx.doing('nuke', f.objectId, `${spell.name}: a runner past reach`);
        const r = await ctx.bot.castSpell(spell, f.objectId, { approach: false });
        ctx.result('nightCast', r, f.objectId);
        return true;
    },
});
