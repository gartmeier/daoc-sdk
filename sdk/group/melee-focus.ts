// The tanks' and melee's own focus (Orders.meleeFocus). A raid gives the ranged half a caster on a keep wall or the roof
// and the melee half something they can reach, or nothing: a melee below a wall Wizard walked straight up the inside
// wall to it (live 2026-11-13 08:36, midgard-2's Egil, Leif and Sigurd on wall-se). MemberContext.orders() hands each
// member the orders as its role reads them, before its skill's lens.
import type { Orders, Role } from './types';

/** The roles that read Orders.meleeFocus as their focus: siege.ts's melee half (tactics/raid.ts DOOR_ROLES). */
export const MELEE_FOCUS_ROLES: ReadonlySet<Role> = new Set<Role>(['tank', 'melee']);

/** The orders as a member of `role` acts on them: a tank or melee gets meleeFocus as its focus when the orders set one apart. */
export function ordersForRole(o: Orders, role: Role): Orders {
    if (o.meleeFocus === undefined || o.meleeFocus === o.focus || !MELEE_FOCUS_ROLES.has(role)) return o;
    return { ...o, focus: o.meleeFocus };
}
