// A member's part in the defence of its own keep from inside (siege.ts defencePlan, defenceOrders): walk in over our own bridge and
// through our own doors to the stand the orders give it, and hold it. The kit fights from there; this only brings it back.
//
// Wiring (S3, rvr.ts at the director's defence call): each tick compute `defenceOrders`, put `defenceSettings(...)` into the orders'
// settings patch as `defence`, and run `holdDefenceStand` first in every role's list while `settings.defence` is set.

import type { Behavior, MemberContext } from './member';
import {
    defencePlan, ON_STAND, openOwnDoors, type DefenceOrders, type DefencePhase, type DefencePlan, type DefenceStand,
} from './siege';
import type { PlayerRealm } from './keeps';

/** Orders.settings.defence: the keep, the phase, and each member's stand by its name. */
export interface DefenceSettings {
    keep: string;
    phase: DefencePhase;
    seats: Record<string, DefenceStand>;
    /** Door ids seen broken: they are walked through, not used. */
    broken: number[];
}

const seatKey = (s: DefenceSettings) => `${s.keep}|${s.phase}|${s.broken.join(',')}|${Object.entries(s.seats).map(([n, x]) => `${n}:${x.label}`).sort().join(',')}`;

/**
 * The settings patch for this tick from defenceOrders, with seats by member name (`names`: defender id → name). The same object
 * as `prev` while nothing in it changed (members rebuild their settings on a new one). Null on 'lost'.
 */
export function defenceSettings(plan: Pick<DefencePlan, 'keep'>, orders: DefenceOrders, names: ReadonlyMap<number, string>, broken: readonly number[] = [], prev?: DefenceSettings | null): DefenceSettings | null {
    if (orders.phase === 'lost') return null;
    const seats: Record<string, DefenceStand> = {};
    for (const [id, s] of orders.seats) { const n = names.get(id); if (n) seats[n] = s; }
    const next: DefenceSettings = { keep: plan.keep, phase: orders.phase, seats, broken: [...broken].sort((a, b) => a - b) };
    return prev && seatKey(prev) === seatKey(next) ? prev : next;
}

/** Within this of the keep's centre a member walks to its own stand (the entry outside the gate is 1560 out, the stage 3200). */
export const DEFENCE_APPROACH = 2200;
const nearKeep = (plan: Pick<DefencePlan, 'centre'>, p: { x: number; y: number }) => Math.hypot(p.x - plan.centre.x, p.y - plan.centre.y) <= DEFENCE_APPROACH;
const insideWalls = (plan: Pick<DefencePlan, 'centre'>, p: { x: number; y: number }) => Math.hypot(p.x - plan.centre.x, p.y - plan.centre.y) <= 1000;

/** A leg of the walk in: short enough that a change of orders is heard between legs. */
const LEG_MS = 20_000;
/** Back to the stand when this far off it (beyond its leash). */
const OFF_Z = 100;

/** The defence of `keep` for our realm, cached per realm and keep. */
const plans = new Map<string, DefencePlan | null>();
function planFor(realm: string, keep: string): DefencePlan | null {
    const key = `${realm}|${keep}`;
    if (!plans.has(key)) plans.set(key, realm === 'albion' || realm === 'midgard' || realm === 'hibernia' ? defencePlan(realm as PlayerRealm, keep) : null);
    return plans.get(key)!;
}

/** Whether `me` is on `stand`, or within its leash of it (3D) while a fight is on. */
export function onStand(me: { x: number; y: number; z: number }, stand: DefenceStand, fighting: boolean): boolean {
    const flat = Math.hypot(me.x - stand.at.x, me.y - stand.at.y);
    if (flat <= ON_STAND && Math.abs(me.z - stand.at.z) <= OFF_Z) return true;
    return fighting && stand.leash > 0 && Math.hypot(flat, me.z - stand.at.z) <= stand.leash;
}

/**
 * Walk to our stand and keep to it, our own doors opened to the walk. Falls through (the kit acts) while we stand on it, or within
 * its leash in a fight; farther than DEFENCE_APPROACH from the keep (the unit travels in as a body: the defence call's own legs);
 * and outside the walls while an enemy attacks us (fight back first).
 */
export const holdDefenceStand: Behavior = {
    name: 'defence-stand',
    async run(ctx: MemberContext<any>): Promise<boolean> {
        const d = (ctx.settings as { defence?: DefenceSettings | null }).defence;
        if (!d) return false;
        const seat = d.seats[ctx.name];
        const me = ctx.me();
        if (!seat || !me || me.isDead) return false;
        const plan = planFor(String(me.realm).toLowerCase(), d.keep);
        if (!plan || me.regionId !== plan.regionId) return false;
        openOwnDoors(plan, d.broken);
        const fighting = ctx.threats().length > 0 || ctx.orders().focus !== null;
        if (onStand(me, seat, fighting)) return false;
        // Far from the keep the unit walks in as one body (the defence call's travel), never each member alone: live 14:20-14:23
        // midgard-2's members walked 25000 alone through the field, four rooted on the way, two dead before the gate.
        if (!nearKeep(plan, me)) return false;
        // Attacked outside the walls (the raid at our gate): fight back first; inside them, on to the stand. Live 14:20:46 Grimhild
        // died walking to our own gate through the raid.
        if (!insideWalls(plan, me) && ctx.threats().some(c => c.targetId === me.objectId)) return false;
        ctx.doing('defence', null, `to ${seat.label}`);
        const w = await ctx.bot.walkTo(seat.at.x, seat.at.y, { z: seat.at.z, tolerance: 60, timeout: LEG_MS });
        // A timeout is the leg's end, not a failure: the next turn goes on from where it stopped.
        ctx.result('defence', w.reason === 'timeout' ? { success: true, message: w.message } : w);
        return true;
    },
};
