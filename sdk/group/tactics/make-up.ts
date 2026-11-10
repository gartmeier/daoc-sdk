// Tactic 4: adapt to the enemy's make-up, read from its classes (Contact.classGuess, learnings/rvr.md "Reading an enemy's
// class") and its deeds (the sticky healer and caster flags), never from which realm, race or roster it is.
//
// - foeKind / enemyMix / meleeHeavy: what a contact is and what the group in sight is made of.
// - healersRead: enemy healers in sight by the class read alone (a count some groups switch on: two healers heal each
//   other's targets back).
// - readMakeUp / withMakeUp: settle the make-up once enough of the enemy is read, hold it, and hand every member one
//   constant settings patch for it (Orders.settings).
// - byMakeUp: a setting given on the command line wins over what the make-up says.

import { isAlive } from '../blackboard';
import type { Contact, OrdersUpdate } from '../types';
import type { Ctx } from './common';

/** What an enemy is to us: a healer, a caster (crowd control counts as one), or a fighter (tank, melee, support). */
export type FoeKind = 'healer' | 'caster' | 'fighter';

/** A contact's kind from its class read when one is settled, else from what it did (the healer and caster flags). */
export function foeKind(c: Contact): FoeKind {
    const role = c.classGuess?.role;
    if (role === 'healer') return 'healer';
    if (role === 'caster' || role === 'cc') return 'caster';
    if (role === 'tank' || role === 'melee' || role === 'support') return 'fighter';
    return c.healer ? 'healer' : c.caster ? 'caster' : 'fighter';
}

/** Enemy players in sight (living, no shades; stale ones count) by kind. */
export function enemyMix(contacts: readonly Contact[]): Record<FoeKind, number> {
    const mix: Record<FoeKind, number> = { healer: 0, caster: 0, fighter: 0 };
    for (const c of contacts) if (c.kind === 'player' && c.hp > 0 && !c.isShade) mix[foeKind(c)]++;
    return mix;
}

/** A melee-heavy enemy: at most `maxCasters` casters and at least `minOthers` healers and fighters together. */
export interface MeleeHeavyRule { maxCasters: number; minOthers: number }
export const MELEE_HEAVY: MeleeHeavyRule = { maxCasters: 1, minOthers: 3 };
export function meleeHeavy(contacts: readonly Contact[], rule: MeleeHeavyRule = MELEE_HEAVY): boolean {
    const m = enemyMix(contacts);
    return m.caster <= rule.maxCasters && m.healer + m.fighter >= rule.minOthers;
}

/** Enemy healers in sight by the class read alone (players, no pets, fresh, living); the flags don't count. */
export function healersRead(contacts: readonly Contact[]): number {
    return contacts.filter(c => c.kind === 'player' && !c.isPet && !c.stale && isAlive(c) && c.classGuess?.role === 'healer').length;
}

/** A setting given for the run wins; else what the make-up says. */
export const byMakeUp = <T>(set: T | undefined, fromMix: T): T => (set !== undefined ? set : fromMix);

export type MakeUp = 'melee' | 'caster';

/**
 * How the make-up is settled: once `minSeen` enemy players are in sight (fresh, living, no shades) and `readShare` of
 * them are read (a class role or a deed), from `rule`; held until none has been in sight for `forgetMs`. Kept in memory
 * under `key` and `seenKey`.
 */
export interface MakeUpOptions {
    minSeen: number;
    readShare: number;
    forgetMs: number;
    rule: MeleeHeavyRule;
    key: string;
    seenKey: string;
}
export const MAKE_UP: MakeUpOptions = { minSeen: 3, readShare: 0.6, forgetMs: 60_000, rule: MELEE_HEAVY, key: 'makeUp', seenKey: 'makeUpSeen' };

export function readMakeUp(ctx: Ctx, o: MakeUpOptions = MAKE_UP): MakeUp | null {
    const mem = ctx.memory as Record<string, any>;
    const sight = ctx.picture.contacts.filter(c => c.kind === 'player' && !c.stale && c.hp > 0 && !c.isShade);
    if (sight.length) mem[o.seenKey] = ctx.now;
    else if (mem[o.key] && ctx.now - (mem[o.seenKey] ?? 0) >= o.forgetMs) delete mem[o.key];
    if (!mem[o.key] && sight.length >= o.minSeen) {
        const read = sight.filter(c => !!c.classGuess?.role || !!c.healer || !!c.caster).length;
        if (read / sight.length >= o.readShare) mem[o.key] = meleeHeavy(sight, o.rule) ? 'melee' : 'caster';
    }
    return mem[o.key] ?? null;
}

/**
 * Every member's settings by the make-up (Orders.settings): `patches[makeUp]`, or null until it is read. Pass constant
 * objects: members rebuild their settings only when the patch changes.
 */
export function withMakeUp(ctx: Ctx, u: OrdersUpdate, patches: Record<MakeUp, object>, o: MakeUpOptions = MAKE_UP): OrdersUpdate {
    const m = readMakeUp(ctx, o);
    return { ...u, settings: m ? patches[m] as OrdersUpdate['settings'] : null };
}
