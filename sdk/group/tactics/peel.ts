// Tactic 3: peel a diver off our back line. An enemy that reaches our healers or casters is dealt with first, before
// the back-line focus: by the focus (everyone's damage interrupts and kills it), by crowd control (a mezz or a root on
// it), or by keeping the tank near the ones it would dive.
//
// - peelFocus: the diver becomes the focus. A diver is one in melee on a protected member (`melee`) or one casting at
//   one (`cast`).
// - meleeOn / peelByMezz: our mezzers go on the melee on our soft members, the one they had waits.
// - mezzMelee: the support's mezz goes on their melee, the one on us first.
// - rootMelee: members whose only crowd control is a root hold the enemy melee off our casters.
// - leashTank: in a fight the anchor stays within a leash of the other members, so the tank stands between.

import { isAlive, untouchable } from '../blackboard';
import type { Contact, OrdersUpdate, Role } from '../types';
import { centreOf, contactOf, dist, engagedFocus, living, packReach, retarget, type Ctx, type Retarget } from './common';
import { foeKind } from './make-up';

type MemberAt = { name: string; x: number; y: number };

/**
 * The enemy player in melee on one of `protect` for at least `heldMs`, within `within` of it (a target by swing, not by
 * spell; living, free, touchable, no pet), the longest on first; or null.
 */
export function diverOn(contacts: readonly Contact[], protect: readonly MemberAt[], now: number, heldMs = 1000, within = 500): Contact | null {
    return contacts
        .filter(c => c.kind === 'player' && !c.isPet && !c.stale && isAlive(c) && !c.cc && !untouchable(c, now) && !c.targetBySpell
            && protect.some(h => h.name === c.target && dist(h, c) <= within) && now - (c.targetSince ?? now) >= heldMs)
        .sort((a, b) => (a.targetSince ?? now) - (b.targetSince ?? now))[0] ?? null;
}

export interface PeelOptions {
    /** Our members it peels for, by role. */
    protect: readonly Role[];
    /**
     * Who is a diver: `melee`, in melee on one of them for `heldMs`, within `within` (diverOn); `cast`, any enemy player
     * on one of them that started a cast in the last `castMs`, within the pack's reach + `slack` of our centre, the one on
     * the most hurt member first. A `cast` peel is kept `holdMs` after it was last on one of them (memory `key`).
     */
    diver: { by: 'melee'; heldMs: number; within: number } | { by: 'cast'; castMs: number; slack: number; holdMs: number; key: string };
    /** No peel while the focus is under this health (`alive`: one the board has alive). */
    finish: { below: number; alive?: boolean };
    skipReason?: RegExp;
    retarget: Retarget;
    note: (c: Contact) => string;
}

/** A diver in melee on our healers, a second on them within 500. */
export const PEEL_MELEE: PeelOptions = {
    protect: ['healer'], diver: { by: 'melee', heldMs: 1000, within: 500 }, finish: { below: 30, alive: true }, retarget: 'grid',
    note: c => `(peel: ${c.objectId} on ${c.target})`,
};
/** A caster casting at our support or healer. */
export const PEEL_CASTER: PeelOptions = {
    protect: ['support', 'healer'], diver: { by: 'cast', castMs: 4000, slack: 700, holdMs: 6000, key: 'peelHold' }, finish: { below: 25 },
    skipReason: /^pick off/, retarget: 'grid-always', note: c => `(peel #${c.objectId} off ${c.target})`,
};

/** The diver becomes the focus, unless the focus is nearly dead. Returns `u` itself when nothing changes. */
export function peelFocus(ctx: Ctx, u: OrdersUpdate, o: PeelOptions): OrdersUpdate {
    if (u.phase !== 'engage' || o.skipReason?.test(u.reason ?? '')) return u;
    const now = ctx.now;
    const soft = ctx.picture.members.filter(m => !m.isDead && o.protect.includes(m.role));
    if (!soft.length) return u;
    const focus = contactOf(ctx, u.focus);
    if (focus && (!o.finish.alive || isAlive(focus)) && focus.hp < o.finish.below) return u;
    const d = o.diver;
    if (d.by === 'melee') {
        const diver = diverOn(ctx.picture.contacts, soft, now, d.heldMs, d.within);
        if (!diver || diver.objectId === u.focus) return u;
        return retarget(ctx, u, diver, o.retarget, o.note(diver));
    }
    const byName = new Map(soft.map(m => [m.name, m]));
    const centre = centreOf(living(ctx));
    const inReach = (c: Contact) => dist(c, centre) <= packReach(ctx) + d.slack;
    const on = ctx.picture.contacts
        .filter(c => c.kind === 'player' && !c.stale && !c.cc && c.hp > 0 && !c.isShade && c.target !== null && byName.has(c.target)
            && now - (c.castingAt ?? 0) <= d.castMs && inReach(c))
        .sort((a, b) => byName.get(a.target!)!.hp - byName.get(b.target!)!.hp || dist(a, centre) - dist(b, centre));
    const mem = ctx.memory as Record<string, { id: number; until: number } | undefined>;
    const usable = (c: Contact | undefined): c is Contact => !!c && c.kind === 'player' && !c.stale && !c.cc && c.hp > 0 && inReach(c);
    const kept = mem[d.key];
    const held = kept && kept.until > now ? contactOf(ctx, kept.id) : undefined;
    const prevId = engagedFocus(ctx);
    const peel = (usable(held) ? held : undefined) ?? on.find(c => c.objectId === u.focus) ?? on.find(c => c.objectId === prevId) ?? on[0];
    if (!peel) return u;
    if (on.some(c => c.objectId === peel.objectId) || !kept || kept.id !== peel.objectId) mem[d.key] = { id: peel.objectId, until: now + d.holdMs };
    if (peel.objectId === u.focus) return { ...u, cc: (u.cc ?? []).filter(a => a.targetId !== peel.objectId) };
    return retarget(ctx, u, peel, o.retarget, o.note(peel));
}

export interface MeleeOnOptions {
    /** Our soft members, by role. */
    protect: readonly Role[];
    /** In swing reach of one of them. */
    within: number;
}
export const MELEE_ON_SOFT: MeleeOnOptions = { protect: ['nuker', 'healer', 'support'], within: 350 };

/** Enemy players (no pets, free, fresh) swinging at one of our soft members within reach of it; never the focus. */
export function meleeOn(ctx: Ctx, focus: number | null | undefined, o: MeleeOnOptions = MELEE_ON_SOFT): Contact[] {
    const soft = living(ctx).filter(m => o.protect.includes(m.role));
    return ctx.picture.contacts.filter(c => {
        if (c.kind !== 'player' || c.isPet || c.cc || c.stale || !isAlive(c) || c.objectId === focus || c.targetBySpell || !c.target) return false;
        const m = soft.find(x => x.name === c.target);
        return !!m && dist(m, c) <= o.within;
    });
}

/**
 * Each diver (meleeOn) gets a mezz: from a mezzer not already on a diver or on one of `reserved`; its current target
 * waits. Divers already assigned are left as they are.
 */
export function peelByMezz(ctx: Ctx, u: OrdersUpdate, o: MeleeOnOptions & { reserved?: readonly number[] } = MELEE_ON_SOFT): OrdersUpdate {
    const divers = meleeOn(ctx, u.focus, o);
    const reserved = o.reserved ?? [];
    const mezzers = living(ctx).filter(m => m.capabilities?.cc && (m.capabilities.ccKinds ?? []).includes('mezz'));
    let cc = u.cc ?? [];
    for (const d of divers) {
        if (cc.some(a => a.targetId === d.objectId)) continue;
        const by = mezzers.find(m => !cc.some(a => a.by === m.name && (divers.some(x => x.objectId === a.targetId) || reserved.includes(a.targetId))));
        if (!by) break;
        cc = [...cc.filter(a => a.by !== by.name), { targetId: d.objectId, by: by.name }];
    }
    return cc === (u.cc ?? []) ? u : { ...u, cc };
}

export interface MezzMeleeOptions {
    /** The mezzer, by role (the first living one). */
    by: Role;
    /** Their melee within this of it. */
    within: number;
}
export const MEZZ_MELEE: MezzMeleeOptions = { by: 'support', within: 1400 };

/**
 * The mezzer's assignment goes on the free enemy fighter (foeKind) within reach of it that is not the focus and not
 * immune to mezz: the one on one of ours first, then the nearest.
 */
export function mezzMelee(ctx: Ctx, u: OrdersUpdate, o: MezzMeleeOptions = MEZZ_MELEE): OrdersUpdate {
    if (u.phase !== 'engage') return u;
    const mezzer = ctx.picture.members.find(m => m.role === o.by && !m.isDead && !m.observed);
    if (!mezzer) return u;
    const names = new Set(ctx.picture.members.map(m => m.name));
    const on = (c: Contact) => Number(!!(c.target && names.has(c.target)));
    const melee = ctx.picture.contacts
        .filter(c => c.kind === 'player' && !c.stale && !c.cc && c.hp > 0 && !c.isShade && foeKind(c) === 'fighter' && c.objectId !== u.focus
            && (c.ccImmune?.mezz ?? 0) <= ctx.now && dist(mezzer, c) <= o.within)
        .sort((a, b) => on(b) - on(a) || dist(mezzer, a) - dist(mezzer, b))[0];
    if (!melee) return u;
    const cc = (u.cc ?? []).filter(a => a.by !== mezzer.name && a.targetId !== melee.objectId);
    return { ...u, cc: [...cc, { targetId: melee.objectId, by: mezzer.name }], reason: `${u.reason} (mezz melee #${melee.objectId})` };
}

export interface RootMeleeOptions {
    /** A free melee to root stands within this of one of our members. */
    within: number;
    /** An enemy never seen casting or healing counts as melee only this close to a non-tank member, or swinging at one. */
    close: number;
    /** Members of these classes keep to their damage, no roots. */
    stayOnDamage?: readonly string[];
}
export const ROOT_MELEE: RootMeleeOptions = { within: 2000, close: 1100 };

/**
 * Members whose only crowd control is a root (no mezz) are kept off casters and healers and put on the free enemy melee
 * nearest our members, the one on a non-tank member first: one each.
 */
export function rootMelee(ctx: Ctx, u: OrdersUpdate, o: RootMeleeOptions = ROOT_MELEE): OrdersUpdate {
    const alive = living(ctx);
    const rooters = alive.filter(m => m.capabilities?.cc && (m.capabilities.ccKinds ?? []).includes('root') && !(m.capabilities.ccKinds ?? []).includes('mezz')
        && !(o.stayOnDamage ?? []).includes(m.className));
    if (!rooters.length) return u;
    const onSoft = (c: Contact) => !!c.target && !c.targetBySpell && alive.some(m => m.name === c.target && m.role !== 'tank');
    const melee = (c: Contact | undefined): c is Contact => !!c && c.kind === 'player' && !c.isPet && !c.caster && !c.healer && !c.targetBySpell
        && (onSoft(c) || Math.min(...alive.filter(m => m.role !== 'tank' && m.regionId === c.regionId).map(m => dist(m, c))) <= o.close);
    const isRooter = (name: string) => rooters.some(r => r.name === name);
    let cc = (u.cc ?? []).filter(a => !isRooter(a.by) || melee(contactOf(ctx, a.targetId)));
    const gap = (c: Contact) => Math.min(...alive.filter(m => m.regionId === c.regionId).map(m => dist(m, c)));
    const free = ctx.picture.contacts
        .filter(c => melee(c) && !c.stale && isAlive(c) && !c.cc && c.objectId !== u.focus && !cc.some(a => a.targetId === c.objectId) && gap(c) <= o.within)
        .sort((a, b) => Number(onSoft(b)) - Number(onSoft(a)) || gap(a) - gap(b));
    for (const r of rooters) {
        if (cc.some(a => a.by === r.name)) continue;
        const c = free.shift();
        if (!c) break;
        cc = [...cc, { targetId: c.objectId, by: r.name }];
    }
    return { ...u, cc };
}

/** In a fight the anchor stays within `leash` of the centre of the members other than the tank (in the tank's region), on the line toward it. */
export function leashTank(ctx: Ctx, u: OrdersUpdate, leash: number): OrdersUpdate {
    if (!leash || u.phase !== 'engage' || !u.anchor) return u;
    const region = ctx.picture.members.find(t => t.role === 'tank')?.regionId;
    const rest = ctx.picture.members.filter(m => !m.isDead && m.role !== 'tank' && m.regionId === region);
    if (!rest.length) return u;
    const c = centreOf(rest);
    const d = dist(c, u.anchor);
    if (d <= leash) return u;
    const k = leash / d;
    return { ...u, anchor: { x: Math.round(c.x + (u.anchor.x - c.x) * k), y: Math.round(c.y + (u.anchor.y - c.y) * k), z: u.anchor.z } };
}
