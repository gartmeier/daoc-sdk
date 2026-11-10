// What every group tactic shares: distances, the living members' centre, how a tactic moves the orders onto a new
// focus (anchor, facing, crowd control off it, the reason), where it keeps a clock in the coordinator's memory, and the
// per-group on/off switch (settings.tactics).

import type { CoordinatorContext } from '../strategy';
import type { Contact, OrdersUpdate, Point3 } from '../types';

export type Ctx = CoordinatorContext<any>;
export type XY = { x: number; y: number };

export const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** The mean position of `ms`; call only with at least one. */
export function centreOf(ms: readonly XY[]): XY {
    return { x: ms.reduce((s, m) => s + m.x, 0) / ms.length, y: ms.reduce((s, m) => s + m.y, 0) / ms.length };
}

export const living = (ctx: Ctx) => ctx.picture.members.filter(m => !m.isDead);

export const contactOf = (ctx: Ctx, id: number | null | undefined): Contact | undefined =>
    id === null || id === undefined ? undefined : ctx.picture.contacts.find(c => c.objectId === id);

/** The focus of the orders in force, while they are an engage; null otherwise. */
export const engagedFocus = (ctx: Ctx): number | null | undefined => (ctx.orders.phase === 'engage' ? ctx.orders.focus : null);

/** The pack's reach (PackSettings.pack.reach): what "in reach of our centre" counts from. */
export const packReach = (ctx: Ctx): number => (ctx.settings as { pack: { reach: number } }).pack.reach;

/**
 * Where the anchor goes when a tactic puts the focus on `c`:
 * - `grid`: on `c`, rounded to 200, only when the update has an anchor (its z, or the update's);
 * - `grid-always`: the same, and with no anchor in the update too (z from the update, the orders, or 0);
 * - `{ toward }`: from the living members' centre toward `c`, at most this far;
 * - `kept`: the anchor in force when it is within 900 of `c`, else the update's;
 * - `kept-or-grid`: the anchor in force when within 900 of `c`, else `grid`;
 * - `previous`: the anchor in force, else the update's.
 */
export type AnchorRule = 'grid' | 'grid-always' | { toward: number } | 'kept' | 'kept-or-grid' | 'previous';

/** How a tactic changes the orders for its focus: `anchor` (with facing, and the focus taken out of crowd control), or `focus` alone. */
export type Retarget = AnchorRule | 'focus-only';

const zOf = (c: Contact): number | null | undefined => (c as { z?: number | null }).z;

export function anchorFor(rule: AnchorRule, ctx: Ctx, u: OrdersUpdate, c: Contact): Point3 | null | undefined {
    const o = ctx.orders;
    const grid = (always: boolean) => (always
        ? { x: Math.round(c.x / 200) * 200, y: Math.round(c.y / 200) * 200, z: zOf(c) ?? u.anchor?.z ?? o.anchor?.z ?? 0 }
        : u.anchor ? { x: Math.round(c.x / 200) * 200, y: Math.round(c.y / 200) * 200, z: zOf(c) ?? u.anchor.z } : u.anchor);
    if (rule === 'grid') return grid(false);
    if (rule === 'grid-always') return grid(true);
    if (rule === 'kept') return o.anchor && dist(o.anchor, c) <= 900 ? o.anchor : u.anchor;
    if (rule === 'kept-or-grid') return o.anchor && dist(o.anchor, c) <= 900 ? o.anchor : grid(false);
    if (rule === 'previous') return o.anchor ?? u.anchor;
    const alive = living(ctx);
    const centre = centreOf(alive);
    const d = dist(c, centre);
    const k = d > 1 ? Math.min(1, rule.toward / d) : 0;
    return { x: Math.round(centre.x + (c.x - centre.x) * k), y: Math.round(centre.y + (c.y - centre.y) * k), z: zOf(c) ?? u.anchor?.z ?? o.anchor?.z ?? 0 };
}

/** `u` with `c` as its focus, by `how`; `note` is added to the reason (none with `focus-only`). */
export function retarget(ctx: Ctx, u: OrdersUpdate, c: Contact, how: Retarget, note?: string): OrdersUpdate {
    if (how === 'focus-only') return { ...u, focus: c.objectId };
    return {
        ...u, focus: c.objectId, anchor: anchorFor(how, ctx, u, c), facing: { x: c.x, y: c.y },
        cc: (u.cc ?? []).filter(a => a.targetId !== c.objectId),
        ...(note !== undefined ? { reason: `${u.reason} ${note}` } : {}),
    };
}

/**
 * A focus clock in the coordinator's memory: which contact a tactic is holding and since when. `clockAt(key)` keeps
 * `{ id, since }` under one key (the field name for `since` can differ), `clockPair` two flat keys.
 */
export interface Clock {
    get(mem: Record<string, any>): { id: number; since: number } | null | undefined;
    set(mem: Record<string, any>, id: number, since: number): void;
    clear(mem: Record<string, any>): void;
}
export function clockAt(key: string, sinceField = 'since'): Clock {
    return {
        get: mem => (mem[key] ? { id: mem[key].id, since: mem[key][sinceField] } : mem[key]),
        set: (mem, id, since) => { mem[key] = { id, [sinceField]: since }; },
        clear: mem => { delete mem[key]; },
    };
}
export function clockPair(idKey: string, sinceKey: string): Clock {
    return {
        get: mem => (mem[idKey] === undefined ? undefined : { id: mem[idKey], since: mem[sinceKey] }),
        set: (mem, id, since) => { mem[idKey] = id; mem[sinceKey] = since; },
        clear: mem => { delete mem[idKey]; delete mem[sinceKey]; },
    };
}

/** The tactics a group can switch off one by one (settings.tactics), so an arena can A/B one realm at a time. */
export type TacticName = 'focusByRole' | 'focusHold' | 'peel' | 'makeUp';
export const TACTIC_NAMES: readonly TacticName[] = ['focusByRole', 'focusHold', 'peel', 'makeUp'];
export type TacticSwitches = Partial<Record<TacticName, boolean | string | number>>;

/**
 * Whether a tactic is on for this run: `settings.tactics.<name>`, on unless false ('false', 0 or '0': a flag such as
 * `--tactics.peel=false` arrives as a string). Absent means on.
 */
export function tacticOn(settings: unknown, name: TacticName): boolean {
    const v = (settings as { tactics?: TacticSwitches } | undefined)?.tactics?.[name];
    return v === undefined || !(v === false || v === 'false' || v === 0 || v === '0');
}
