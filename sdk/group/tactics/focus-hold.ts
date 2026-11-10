// Tactic 2: no thrash. An assist train keeps its target until it dies; a focus that flips every second between
// two enemies (each crossing reach, changing its label, getting healed) kills nothing.
//
// - holdFocus: keep the focus of the orders in force over a new pick while it is free and in reach.
// - finishLow: a focus under some health stays ahead of every other switch.
// - dwellFocus: a new focus stays at least `ms`, unless it dies, is crowd-controlled, goes stale or leaves reach.
//   dwellHold and dwellRecord are its two halves, for a decide that picks in between (the hold first, then its own
//   picks, then the clock records what it settled on).

import { isAlive, untouchable } from '../blackboard';
import type { Contact, OrdersUpdate } from '../types';
import { centreOf, clockAt, contactOf, dist, engagedFocus, living, packReach, retarget, type Clock, type Ctx, type Retarget } from './common';
import { isNear, type Near } from './focus-role';

const backLine = (c: Contact) => !!c.caster || !!c.healer;

export interface HoldOptions {
    /** The old focus must stand within the pack's reach + this of the living members (in its region). */
    slack: number;
    /** Leave the orders alone when their reason matches (the pack's pick off of a straggler). */
    skipReason: RegExp;
    /** Let go of one that became untouchable (a shade, a refusal). */
    untouchable?: boolean;
    /** `board`: the board's isAlive (which keeps players); `hp`: health above 0. */
    dead: 'board' | 'hp';
    /** Let go of a front-liner when the new pick is their back line (seen casting or healing): pass the pack's focusSoft. */
    yieldToBackLine?: boolean;
    /** `kept-or-grid`: the anchor in force when near it, else one on it; `kept-only`: hold only while the anchor in force is within 900 of it. */
    anchor: 'kept-or-grid' | 'kept-only';
    note: (prevId: number, newId: number) => string;
}
export const HOLD: HoldOptions = { slack: 700, skipReason: /^pick off/, dead: 'hp', anchor: 'kept-only', note: (p, n) => `(held #${p} over #${n})` };

/**
 * The focus in force stays over the update's new pick while it lives, is free and within reach + slack of our
 * centre. The new pick wins when the old one was dropped as out-healed, or it is nearly dead (< 30 %) and the old
 * one 30 points healthier.
 */
export function holdFocus(ctx: Ctx, u: OrdersUpdate, o: HoldOptions): OrdersUpdate {
    const prevId = engagedFocus(ctx);
    if (u.phase !== 'engage' || typeof u.focus !== 'number' || prevId === null || prevId === undefined || u.focus === prevId) return u;
    if (o.skipReason.test(u.reason ?? '')) return u;
    if ((ctx.memory as { dropped?: Record<number, number> }).dropped?.[prevId]) return u;
    const prev = contactOf(ctx, prevId);
    const next = contactOf(ctx, u.focus);
    if (!prev || !next || prev.kind !== 'player' || prev.stale || prev.cc || (o.dead === 'hp' ? prev.hp <= 0 : !isAlive(prev)) || (o.untouchable && untouchable(prev, ctx.now))) return u;
    const alive = living(ctx).filter(m => m.regionId === prev.regionId);
    if (!alive.length) return u;
    if (dist(prev, centreOf(alive)) > packReach(ctx) + o.slack) return u;
    if (o.yieldToBackLine && !backLine(prev) && backLine(next)) return u;
    if (next.hp < 30 && prev.hp > next.hp + 30) return u;
    const a = ctx.orders.anchor;
    if (o.anchor === 'kept-only' && (!a || dist(a, prev) > 900)) return u;
    return retarget(ctx, u, prev, o.anchor === 'kept-only' ? 'kept' : 'kept-or-grid', o.note(prevId, u.focus));
}

export interface FinishOptions {
    /** A focus in force under this health (%) stays. */
    below: number;
    /** ... while within the pack's reach + this of the living members' centre. */
    slack: number;
    skipReason: RegExp;
    retarget: Retarget;
}
export const FINISH_LOW: FinishOptions = { below: 40, slack: 700, skipReason: /^pick off/, retarget: 'kept' };

/** The focus in force, under `below` %, free, fresh and in reach, stays the focus. Returns `u` itself when it doesn't apply. */
export function finishLow(ctx: Ctx, u: OrdersUpdate, o: FinishOptions = FINISH_LOW): OrdersUpdate {
    const orders = ctx.orders;
    if (u.phase !== 'engage' || orders.phase !== 'engage' || orders.focus === null || o.skipReason.test(u.reason ?? '')) return u;
    const prev = contactOf(ctx, orders.focus);
    if (!prev || prev.kind !== 'player' || prev.stale || prev.cc || prev.hp <= 0 || prev.hp >= o.below) return u;
    const alive = living(ctx);
    if (!alive.length) return u;
    if (dist(prev, centreOf(alive)) > packReach(ctx) + o.slack) return u;
    return retarget(ctx, u, prev, o.retarget, `(finish #${prev.objectId} at ${prev.hp} %)`);
}

export interface DwellOptions {
    /** How long a new focus stays; 0: off. */
    ms: number;
    /** Which focus is held: `clock`, the one the clock started on; `orders`, the focus of the orders in force (the clock restarts when it changes). */
    heldFrom: 'clock' | 'orders';
    clock: Clock;
    /** Where the held one must stand. `{ centre }` with nobody alive: `emptyOk` holds anyway. */
    near: Near & { emptyOk?: boolean };
    /** Only a player is held. */
    players?: boolean;
    untouchable?: boolean;
    dead: 'board' | 'hp';
    /** Let go for a new pick under `below` % (`alive`: one the board has alive), while the held one is over `heldAbove`. */
    letGo?: { below: number; heldAbove?: number; alive?: boolean };
    /** Off an engage (or with no focus), forget the clock (`off-engage`) or keep it (`never`). */
    forget: 'off-engage' | 'never';
    /** How the orders move back onto the held one: `kept`, `previous`, or `focus-only`. */
    retarget: Retarget;
    note?: (id: number) => string;
}
export const DWELL: DwellOptions = {
    ms: 6000, heldFrom: 'clock', clock: clockAt('focusDwell'), near: { centre: 700 }, players: true, dead: 'hp', forget: 'off-engage',
    retarget: 'kept', note: id => `(dwell #${id})`,
};

/** The hold alone: the update moved back onto the held focus, or `u` itself. With heldFrom `orders` it also restarts the clock on a new focus in force. */
export function dwellHold(ctx: Ctx, u: OrdersUpdate, o: DwellOptions): OrdersUpdate {
    const mem = ctx.memory;
    let heldId: number | null | undefined;
    let since: number | undefined;
    if (o.heldFrom === 'orders') {
        heldId = engagedFocus(ctx);
        if (typeof heldId === 'number' && o.clock.get(mem)?.id !== heldId) o.clock.set(mem, heldId, ctx.now);
        if (typeof heldId !== 'number') return u;
        since = o.clock.get(mem)?.since;
    } else {
        const held = o.clock.get(mem);
        heldId = held?.id;
        since = held?.since;
    }
    if (heldId === null || heldId === undefined || heldId === u.focus) return u;
    if (!(ctx.now - (since ?? ctx.now) < o.ms)) return u;
    const c = contactOf(ctx, heldId);
    if (!c || (o.players && c.kind !== 'player') || c.stale || c.cc || (o.dead === 'hp' ? c.hp <= 0 : !isAlive(c)) || (o.untouchable && untouchable(c, ctx.now))) return u;
    const alive = living(ctx);
    const centre = alive.length ? centreOf(alive) : null;
    if ('centre' in o.near && !centre ? !o.near.emptyOk : !isNear(ctx, o.near, c, alive, centre)) return u;
    if (o.letGo) {
        const next = contactOf(ctx, u.focus);
        if (next && (!o.letGo.alive || isAlive(next)) && next.hp < o.letGo.below && (o.letGo.heldAbove === undefined || c.hp > o.letGo.heldAbove)) return u;
    }
    return retarget(ctx, u, c, o.retarget, o.note?.(c.objectId));
}

/** The clock records the update's focus when it is a new one. */
export function dwellRecord(ctx: Ctx, u: OrdersUpdate, o: Pick<DwellOptions, 'clock'>): void {
    if (typeof u.focus !== 'number') return;
    if (o.clock.get(ctx.memory)?.id !== u.focus) o.clock.set(ctx.memory, u.focus, ctx.now);
}

/** dwellHold, and when it doesn't hold, dwellRecord. Off an engage the clock is forgotten or kept (`forget`). */
export function dwellFocus(ctx: Ctx, u: OrdersUpdate, o: DwellOptions): OrdersUpdate {
    if (!o.ms || u.phase !== 'engage' || typeof u.focus !== 'number') {
        if (o.forget === 'off-engage' && u.phase !== 'engage') o.clock.clear(ctx.memory);
        return u;
    }
    const held = dwellHold(ctx, u, o);
    if (held !== u) return held;
    dwellRecord(ctx, u, o);
    return u;
}
