// Tactic 1: the focus by enemy role. Their crowd control, healer or casters first, from the class read
// (Contact.classGuess.role) with the sticky healer and caster flags as the fallback; their tank and melee last.
//
// - focusByRole: the best-ranked enemy in reach becomes the focus. `pick: 'rank'` moves up a rank only (and never off a
//   nearly dead focus); `pick: 'sticky'` keeps the one it chose until it stops being a candidate.
// - focusBackLine: off a focus never seen casting or healing, onto the best one that was (by the deeds alone).

import { isAlive, untouchable } from '../blackboard';
import type { Contact, OrdersUpdate } from '../types';
import { centreOf, contactOf, dist, engagedFocus, living, packReach, retarget, type Ctx, type Retarget, type XY } from './common';

/**
 * What decides a contact's role: `read`, the class read alone; `read-or-deed`, the read, else what it did (healer flag,
 * then caster flag).
 */
export type RoleBy = 'read' | 'read-or-deed';
export function roleOf(c: Contact, by: RoleBy = 'read-or-deed'): string | undefined {
    const r = c.classGuess?.role;
    if (by === 'read') return r;
    if (r) return r;
    return c.healer ? 'healer' : c.caster ? 'caster' : undefined;
}

/**
 * Where a contact must stand to count: `{ centre: slack }`, within the pack's reach + slack of the living members'
 * centre; `{ member: d }`, within d of a living member in its region (`notTank`: not counting the tank).
 */
export type Near = { centre: number } | { member: number; notTank?: boolean };

export function isNear(ctx: Ctx, near: Near, c: Contact, alive: ReturnType<typeof living>, centre: XY | null): boolean {
    if ('centre' in near) return !!centre && dist(c, centre) <= packReach(ctx) + near.centre;
    return alive.some(m => (!near.notTank || m.role !== 'tank') && m.regionId === c.regionId && dist(m, c) <= near.member);
}

export interface FocusByRoleOptions {
    /** Roles first to last; a contact with any other role (or none) is never a switch. */
    order: readonly string[];
    roleBy: RoleBy;
    near: Near;
    /** ... and within this of one of our nukers, when the group has any. */
    nukerReach?: number;
    /**
     * `rank`: the best-ranked candidate (then the most hurt) unless the focus ranks as well (with `keepNeedsReach`: and
     * itself stands free, not meleeing if `skip.meleeing`, and near). `sticky`: the one chosen before while it is still a
     * candidate (out-healed or not), else the focus, the last orders' focus, the most hurt; kept in memory under `key`.
     */
    pick: 'rank' | 'sticky';
    keepNeedsReach?: boolean;
    key?: string;
    /** `rank`: never off a focus under `hp` (`orEqual`: at or under). */
    finish?: { hp: number; orEqual?: boolean };
    /** `rank`: the focus counts (for finish and keep) only while the board has it alive. */
    focusAlive?: boolean;
    /**
     * Who is no candidate: pets, untouchable ones (shades and refusals), shades, ones meleeing one of us (a target by
     * swing), ones the pack dropped as out-healed (`any` mark; `active`: an unexpired one, and in `sticky` only for a new
     * pick), and the dead (`board`: the board's isAlive, which keeps players; `hp`: health above 0).
     */
    skip: { pets?: boolean; untouchable?: boolean; shades?: boolean; meleeing?: boolean; dropped?: 'any' | 'active'; dead: 'board' | 'hp' };
    /** Leave the orders alone when their reason matches (the pack's "pick off" of a straggler). */
    skipReason?: RegExp;
    retarget: Retarget;
    /** Added to the reason on a switch. */
    note?: (c: Contact, role: string | undefined) => string;
}

const meleeing = (c: Contact) => !!c.target && !c.targetBySpell;

export function focusByRole(ctx: Ctx, u: OrdersUpdate, o: FocusByRoleOptions): OrdersUpdate {
    if (u.phase !== 'engage') return u;
    if (o.skipReason?.test(u.reason ?? '')) return u;
    const alive = living(ctx);
    if (!alive.length) return u;
    const now = ctx.now;
    const centre = centreOf(alive);
    const dropped = (ctx.memory as { dropped?: Record<number, number> }).dropped ?? {};
    // A runner the pack let go (pack.ts noteRunners) is no pick for its time unless it is on one of us (live 09:40:07-09: the healer
    // let go, "healer first" on it again 2 s later).
    const runners = (ctx.memory as { runners?: Record<number, { until: number }> }).runners ?? {};
    const ours = new Set(ctx.picture.members.map(m => m.name));
    const letGo = (c: Contact) => (runners[c.objectId]?.until ?? 0) > now && !ours.has(c.target ?? c.targetPet ?? '');
    const nukers = o.nukerReach !== undefined ? alive.filter(m => m.role === 'nuker') : [];
    const rank = (c: Contact) => { const i = o.order.indexOf(roleOf(c, o.roleBy) ?? ''); return i < 0 ? Infinity : i; };
    const standing = (c: Contact) => !c.cc && !(o.skip.meleeing && meleeing(c)) && isNear(ctx, o.near, c, alive, centre)
        && (o.nukerReach === undefined || !nukers.length || nukers.some(m => dist(m, c) <= o.nukerReach!));
    const candidate = (c: Contact) => c.kind === 'player' && !(o.skip.pets && c.isPet) && !c.stale
        && (o.skip.dead === 'hp' ? c.hp > 0 : isAlive(c)) && !(o.skip.untouchable && untouchable(c, now)) && !(o.skip.shades && c.isShade)
        && !(o.skip.dropped === 'any' && dropped[c.objectId]) && !letGo(c) && rank(c) < Infinity && standing(c);
    const note = (c: Contact) => (o.note ? o.note(c, roleOf(c, o.roleBy)) : undefined);

    if (o.pick === 'sticky') {
        const mem = ctx.memory as Record<string, any>;
        const key = o.key ?? 'roleFocus';
        const kept = mem[key] !== undefined ? ctx.picture.contacts.find(c => c.objectId === mem[key] && candidate(c)) : undefined;
        const fresh = ctx.picture.contacts.filter(c => candidate(c) && !(o.skip.dropped === 'active' && dropped[c.objectId]! > now));
        if (!kept && !fresh.length) { delete mem[key]; return u; }
        const prevId = engagedFocus(ctx);
        const pick = kept ?? fresh.find(c => c.objectId === u.focus) ?? fresh.find(c => c.objectId === prevId) ?? [...fresh].sort((a, b) => a.hp - b.hp)[0]!;
        mem[key] = pick.objectId;
        if (pick.objectId === u.focus) return u;
        return retarget(ctx, u, pick, o.retarget, note(pick));
    }

    const focus = contactOf(ctx, u.focus);
    const counts = (c: Contact) => !o.focusAlive || isAlive(c);
    if (focus && counts(focus) && o.finish && (o.finish.orEqual ? focus.hp <= o.finish.hp : focus.hp < o.finish.hp)) return u;
    const best = ctx.picture.contacts.filter(candidate).sort((a, b) => rank(a) - rank(b) || a.hp - b.hp)[0];
    if (!best || best.objectId === u.focus) return u;
    if (focus && counts(focus) && rank(focus) <= rank(best) && (!o.keepNeedsReach || standing(focus))) return u;
    return retarget(ctx, u, best, o.retarget, note(best));
}

/** Presets, named by what they do; a group spreads one and tunes it. */

/** Their crowd control, then healers, then casters; up a rank only; a focus under 30 % is finished; in reach + 700 of our centre. */
export const CC_HEALER_CASTER: FocusByRoleOptions = {
    order: ['cc', 'healer', 'caster'], roleBy: 'read-or-deed', near: { centre: 700 }, pick: 'rank', finish: { hp: 30 }, focusAlive: true,
    skip: { pets: true, untouchable: true, dropped: 'any', dead: 'board' }, retarget: 'grid',
    note: (c, role) => `(${role} first: ${c.objectId})`,
};

/** Their casters first, then healers, then crowd control (by the read alone); not one meleeing us; within 1700 of a non-tank member. */
export const CASTER_HEALER_CC: FocusByRoleOptions = {
    order: ['caster', 'healer', 'cc'], roleBy: 'read', near: { member: 1700, notTank: true }, pick: 'rank', finish: { hp: 30, orEqual: true },
    keepNeedsReach: true, skip: { pets: true, meleeing: true, dead: 'board' }, retarget: 'focus-only',
};
/** The same with healers first: against two healers, who heal each other's targets back. */
export const HEALER_CASTER_CC: FocusByRoleOptions = { ...CASTER_HEALER_CC, order: ['healer', 'caster', 'cc'] };

/** Their healer, the one chosen kept until it dies, is controlled or leaves reach; within 1500 of a nuker; the anchor 600 toward it. */
export const HEALER_STICKY: FocusByRoleOptions = {
    order: ['healer'], roleBy: 'read-or-deed', near: { centre: 300 }, nukerReach: 1500, pick: 'sticky', key: 'roleFocus',
    skip: { shades: true, dropped: 'active', dead: 'hp' }, skipReason: /^pick off/, retarget: { toward: 600 },
    note: c => `(healer first #${c.objectId})`,
};

export interface BackLineOptions {
    /** A candidate stands within this of a living member in its region. */
    range: number;
    /** A focus the class read gives one of these roles stays. */
    keepRoles?: readonly string[];
    /** A focus this says to keep stays (a group's own rule). */
    keep?: (c: Contact) => boolean;
    /** A focus at this health or below stays. */
    finishAt: number;
    retarget: Retarget;
}
export const BACK_LINE: BackLineOptions = { range: 2300, keepRoles: ['healer', 'caster', 'cc'], finishAt: 30, retarget: 'focus-only' };

/**
 * Off a focus never seen casting or healing (their tank, a melee), onto the best enemy that was: healer and caster 70,
 * healer 60, caster 50, + 0.3 per % missing, - 40 when it has a crowd-control assignment, - 1 per 100 from our nearest.
 */
export function focusBackLine(ctx: Ctx, u: OrdersUpdate, o: BackLineOptions): OrdersUpdate {
    if (u.phase !== 'engage') return u;
    const cur = contactOf(ctx, u.focus);
    if (!cur || cur.caster || cur.healer || !(cur.hp > o.finishAt) || o.keep?.(cur) || (o.keepRoles ?? []).includes(cur.classGuess?.role ?? '')) return u;
    const alive = living(ctx);
    const assigned = new Set((u.cc ?? ctx.orders.cc).map(a => a.targetId));
    const near = (c: Contact) => alive.some(m => m.regionId === c.regionId && dist(m, c) <= o.range);
    const pool = ctx.picture.contacts.filter(c => c.kind === 'player' && !c.isPet && !c.isShade && !c.stale && isAlive(c) && !c.cc && (c.caster || c.healer) && near(c));
    const score = (c: Contact) => (c.healer && c.caster ? 70 : c.healer ? 60 : 50) + (100 - c.hp) * 0.3 - (assigned.has(c.objectId) ? 40 : 0)
        - Math.min(...alive.map(m => dist(m, c))) / 100;
    const pick = [...pool].sort((a, b) => score(b) - score(a))[0];
    return pick ? retarget(ctx, u, pick, o.retarget) : u;
}
