// Speed of the Realm from a hastener (R3, night of 2026-11-12/13; the user: our units never used them). Thidranki has a
// DOL.GS.Keeps.FrontierHastener at each portal keep (Hibernia 19075, 19035; Midgard 53318, 25496; Albion 37196, 51612) and
// one in the Faste (34365, 38483). An interact within 192 (WorldMgr.INTERACT_DISTANCE) casts spell 2430 on the player and its
// pets: +147 % speed for 600 s (Hastener.cs Interact, CastSpellOnOwnerAndPets). The hastener has the PEACE flag, and
// NormalServerRules.IsSameRealm reads a PEACE NPC as of every realm, so any one in reach serves. As a human plays it: leaving
// the keep (the rest before a sortie, or back after a release), a member without the speed walks over, clicks it, and goes.

import type { Effect, NearbyNpc, PlayerState } from '../../types';
import type { Behavior } from '../member';
import type { GroupStrategy } from '../strategy';
import type { Role } from '../types';

/** Speed of the Realm (spell.sql 2430: SpeedEnhancement 147, 600 s, "Your speed greatly increases!"). */
export const SPEED_OF_THE_REALM = 2430;
/** A hastener this near (2D) is worth the walk: at a portal keep the pack rests within this of it. */
export const HASTENER_REACH = 1200;
/** Walk within this (3D) to interact: the server's 192, less a margin. */
const HASTENER_RANGE = 150;
/** Not with an enemy player this near any of us: the fight comes first. */
const HASTEN_FOE_CLEAR = 2500;
/** After a failed try, leave it this long. */
const HASTEN_RETRY_MS = 30_000;
/** The effect shows within this of the interact. */
const HASTEN_WAIT_MS = 3000;
/** With no effect names to go by, a max speed this high is the hastener's (100 + 147; a Bard's or Skald's speed is far below). */
const SPED_PERCENT = 200;
/** Orders a member may step out of for it: resting, gathering, idle, and travel (the leg waits for it). */
const PHASES: ReadonlySet<string> = new Set(['recover', 'gather', 'idle', 'travel']);

/** It has the speed already: the effect by its spell id or name, or a max speed only the hastener gives. */
export function hasRealmSpeed(effects: readonly Pick<Effect, 'spellId' | 'name'>[], me?: Pick<PlayerState, 'maxSpeedPercent'> | null): boolean {
    return effects.some(e => e.spellId === SPEED_OF_THE_REALM || /speed of the realm/i.test(e.name)) || (me?.maxSpeedPercent ?? 0) >= SPED_PERCENT;
}

/** The nearest hastener within `reach` (2D), if any. */
export function nearestHastener(npcs: readonly Pick<NearbyNpc, 'name' | 'distance2d' | 'objectId'>[], reach = HASTENER_REACH): Pick<NearbyNpc, 'name' | 'distance2d' | 'objectId'> | null {
    return [...npcs].filter(n => /hastener/i.test(n.name) && n.distance2d <= reach).sort((a, b) => a.distance2d - b.distance2d)[0] ?? null;
}

/** Why a member doesn't go now, or null when it should. Pure: the behaviour's whole rule. */
export function hastenBlock(o: {
    me: Pick<PlayerState, 'isDead' | 'inCombat' | 'x' | 'y' | 'maxSpeedPercent'>; phase: string; effects: readonly Pick<Effect, 'spellId' | 'name'>[];
    hastener: { distance2d: number } | null; threats: number; foes: readonly { x: number; y: number }[]; retryAt: number; now: number;
}): string | null {
    if (o.me.isDead) return 'dead';
    if (!o.hastener) return 'no hastener in reach';
    if (hasRealmSpeed(o.effects, o.me)) return 'sped already';
    if (!PHASES.has(o.phase)) return `orders say ${o.phase}`;
    if (o.threats || o.me.inCombat) return 'in a fight';
    if (o.foes.some(f => Math.hypot(f.x - o.me.x, f.y - o.me.y) <= HASTEN_FOE_CLEAR)) return 'an enemy near';
    if (o.retryAt > o.now) return 'tried lately';
    return null;
}

/** Walk to the hastener in reach and click it, once per Speed of the Realm (hastenBlock says when). Answers false when it doesn't go. */
export const hasten = <S = any>(): Behavior<S> => ({
    name: 'hasten',
    async run(ctx) {
        const me = ctx.me();
        if (!me) return false;
        const effects = ctx.sdk.getEffects();
        const hastener = nearestHastener(ctx.sdk.getNearbyNpcs());
        const foes = ctx.picture().contacts.filter(c => c.kind === 'player' && !c.stale);
        const now = Date.now();
        if (hastenBlock({ me, phase: ctx.orders().phase, effects, hastener, threats: ctx.threats().length, foes, retryAt: ctx.memory.get('hastenRetry') ?? 0, now })) return false;
        const h = hastener!;
        ctx.doing('hasten', h.objectId, `Speed of the Realm, the hastener ${Math.round(h.distance2d)} away`);
        const walk = await ctx.bot.walkToObject(h.objectId, { range: HASTENER_RANGE, timeout: 15_000 });
        if (!walk.success) {
            ctx.memory.set('hastenRetry', Date.now() + HASTEN_RETRY_MS);
            ctx.result('hasten', walk, h.objectId);
            return true;
        }
        await ctx.sdk.sendInteract(h.objectId);
        const sped = await ctx.sdk.waitForCondition(s => hasRealmSpeed(s.effects ?? [], s.player), HASTEN_WAIT_MS).then(() => true, () => false);
        if (!sped) ctx.memory.set('hastenRetry', Date.now() + HASTEN_RETRY_MS);
        ctx.result('hasten', sped ? { success: true, message: 'Speed of the Realm' } : { success: false, reason: 'no_effect', message: `No Speed of the Realm ${HASTEN_WAIT_MS / 1000} s after the interact` }, h.objectId);
        return true;
    },
});

/** Where hasten goes in a list: above holdFormation (which would walk the member back to its slot), else buff, else rest, else last. */
export function withHasten<S>(list: readonly Behavior<S>[]): Behavior<S>[] {
    if (list.some(b => b.name === 'hasten')) return [...list];
    const at = ['holdFormation', 'buff', 'rest'].map(n => list.findIndex(b => b.name === n)).find(i => i >= 0) ?? list.length;
    return [...list.slice(0, at), hasten<S>(), ...list.slice(at)];
}

/** The strategy with hasten in every role's list and every member's own (memberBehaviors). Lists that have it already are kept. */
export function withHastener<S>(strategy: GroupStrategy<S>): GroupStrategy<S> {
    const behaviors = Object.fromEntries(Object.entries(strategy.behaviors).map(([role, list]) => [role, withHasten(list as Behavior<S>[])])) as Record<Role, Behavior<S>[]>;
    const memberBehaviors = strategy.memberBehaviors && Object.fromEntries(Object.entries(strategy.memberBehaviors).map(([bot, list]) => [bot, withHasten(list as Behavior<S>[])]));
    return { ...strategy, behaviors, ...(memberBehaviors ? { memberBehaviors } : {}) };
}
