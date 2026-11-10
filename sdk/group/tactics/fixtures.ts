// Small pictures for the tactics tests: a group at (10 000, 10 000) in region 200, enemies by role, a context with the pack's reach.
import { enemy, picture, report } from '../fixtures';
import type { CoordinatorContext } from '../strategy';
import type { Capabilities, Contact, MemberReport, Orders, OrdersUpdate, Role } from '../types';

export const R = 200;
const caps = (over: Partial<Capabilities> = {}): Capabilities => ({ heal: false, cc: false, nuke: false, buffs: [], buffSpells: [], ...over });

/** Tank in front, healer, support and two nukers behind it. */
export function team(over: Partial<Record<string, Partial<MemberReport>>> = {}): MemberReport[] {
    const at = (dx: number, dy: number) => ({ regionId: R, x: 10_000 + dx, y: 10_000 + dy, z: 0, level: 24 });
    const m = (name: string, role: Role, className: string, c: Partial<Capabilities>, dx: number, dy: number) =>
        report(name, { role, className, capabilities: caps(c), ...at(dx, dy), ...over[name] });
    return [
        m('Tank', 'tank', 'Hero', {}, 0, 0),
        m('Heals', 'healer', 'Druid', { heal: true }, -300, 100),
        m('Bard', 'support', 'Bard', { heal: true, cc: true, ccKinds: ['mezz'] }, -300, -100),
        m('Menta', 'nuker', 'Mentalist', { nuke: true }, -400, 150),
        m('Encha', 'nuker', 'Enchanter', { nuke: true, cc: true, ccKinds: ['root'] }, -400, -150),
    ];
}

export const guess = (role: string) => ({ classGuess: { classes: ['X'], p: [0.8], role: role as any, basis: [] } });

/** An enemy player `dx` in front of the group (x grows toward the enemy). */
export const foe = (id: number, dx: number, over: Partial<Contact> & Record<string, unknown> = {}, dy = 0): Contact =>
    enemy(id, 'midgard', { regionId: R, x: 10_000 + dx, y: 10_000 + dy, hp: 80, ...over } as Partial<Contact>);

export function ctx(foes: Contact[], o: { orders?: Partial<Orders>; memory?: Record<string, any>; members?: MemberReport[]; now?: number; settings?: Record<string, unknown> } = {}): CoordinatorContext<any> {
    const now = o.now ?? 1_000_000;
    const p = picture(o.members ?? team(), foes, o.orders ?? {}, now);
    return { picture: p, orders: p.orders, memory: o.memory ?? {}, now, windingDown: false, settings: { pack: { reach: 1500, focusSoft: true }, switchBelow: 25, ...o.settings } };
}

export const engage = (focus: number | null, over: Partial<OrdersUpdate> = {}): OrdersUpdate =>
    ({ phase: 'engage', focus, anchor: { x: 11_000, y: 10_000, z: 0 }, cc: [], reason: 'raid', ...over });
