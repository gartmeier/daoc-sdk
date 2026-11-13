// The raid on a keep at the muster's 'go' (R3, night of 2026-11-12/13; R1 asked for it before the Faste probe's second
// attempt). The muster (tactics/help.ts, the director's call) brings a realm's units to the rally on their own bank; at
// 'go' its target is the lord's spot, and the straight way there runs through every guard. So a unit answering a muster
// at 'go' plays the raid by siege.ts (R5): over its own bridge to the stage (routeFrom), then rank by rank (raidOrders),
// the ranged on the walls while the tanks and melee break the gate, and the roof last.
//
// - The board takes in an enemy realm's NPCs that are no pets (Contact.keepGuard) and shows them only while the orders
//   carry a raid (Orders.settings.raid), so nothing else changes.
// - The orders: travel to the next waypoint (approach, stage), engage the ranged half's focus (assault, lord), or recover
//   at the stand with nothing to hit. Orders.settings is the raid patch: `raid` lifts the keep's circle for every member
//   (keeps.ts keepDangers), `raidDoor` sends the tanks and melee at a door (breakDoor).
// - A door is broken once a member read "The Keep Door is broken!" by it (MemberReport.doorsBroken, observeState).

import type { Realm } from '../../types';
import type { Behavior } from '../member';
import { planKeep, raidOrders, raidPlan, routeFrom, type RaidOrders, type RaidPlan, type RaidView, type SiegeSeen } from '../siege';
import type { PlayerRealm } from '../keeps';
import type { GroupStrategy } from '../strategy';
import type { Contact, MemberReport, OrdersUpdate, Point3, Role } from '../types';
import { answering, type RealmCall } from './help';

/**
 * At the muster's go, an enemy player counts only on one of us or within this of the body (2D): the raid goes on past those
 * farther off, hunts none and falls back from none. R1, attempt 6 (2026-11-13 ~03:15): with all realms out, the main groups
 * dropped the muster at the first enemy in sight (hibernia hunted, hibernia-2 sat), and only the squads raided.
 */
export const RAID_FOE_REACH = 1500;

/** A door the tanks and melee break (Orders.settings.raidDoor). */
export interface RaidDoor {
    doorId: number;
    label: string;
    /** The door's spot. */
    x: number;
    y: number;
    z: number;
    /** Where to stand to hit it. */
    stand: Point3;
}

/** Orders.settings while raiding. Kept as one object while it doesn't change: members rebuild their settings on a new one. */
export interface RaidPatch {
    raid: string;
    raidDoor: RaidDoor | null;
}

/** The raid memory (memory.raid), for one muster call. */
export interface RaidMemory {
    callId: string;
    /** The raid stood at the stage: from then on it is inside, whatever its centre (RaidView.staged). */
    staged: boolean;
    /** Door ids members read broken since the raid set out. */
    broken: number[];
    patch?: RaidPatch;
    patchKey?: string;
}

/** The muster call we answer, once it says go; null otherwise. */
export function raidCall(mem: Record<string, any>): RealmCall | null {
    const c = answering(mem);
    return c && c.kind === 'muster' && c.stage === 'go' ? c : null;
}

/** The raid this unit plays now: the muster at 'go' and a plan for our realm in this region. Null otherwise (and the memory goes). */
export function raidNow(mem: Record<string, any>, realm: Realm, regionId: number): { call: RealmCall; plan: RaidPlan } | null {
    const call = raidCall(mem);
    const plan = call && realm !== 'none' ? raidPlan(realm as PlayerRealm) : null;
    if (!call || !plan || plan.regionId !== regionId) { mem.raid = undefined; return null; }
    if ((mem.raid as RaidMemory | undefined)?.callId !== call.id) mem.raid = { callId: call.id, staged: false, broken: [] } satisfies RaidMemory;
    return { call, plan };
}

/** A keep guard on the board as siege.ts reads it. */
export function guardSeen(c: Contact): SiegeSeen {
    return { id: c.objectId, name: c.name, realm: c.realm, kind: 'npc', x: c.x, y: c.y, z: c.z, healthPercent: c.hp, level: c.level, targetObjectId: c.targetId, isDead: c.hp <= 0 };
}

/** Who holds the keep, as its guards say: the realm most of those within 3000 of it are of; 'none' with none seen. */
export function guardOwner(plan: RaidPlan, guards: readonly Contact[]): Realm {
    const keep = planKeep(plan);
    const near = guards.filter(g => !keep || Math.hypot(g.x - keep.x, g.y - keep.y) <= 3000);
    const n = new Map<Realm, number>();
    for (const g of near) n.set(g.realm, (n.get(g.realm) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
}

/** The settings patch for this step, the same object while nothing in it changes. */
export function raidPatch(r: RaidMemory, keep: string, o: RaidOrders): RaidPatch {
    const step = o.melee.step?.kind === 'door' && o.melee.step.doorId !== undefined ? o.melee.step : null;
    const key = `${keep}:${step?.doorId ?? ''}`;
    if (r.patch && r.patchKey === key) return r.patch;
    const raidDoor: RaidDoor | null = step ? { doorId: step.doorId!, label: step.label, x: step.at.x, y: step.at.y, z: step.at.z, stand: step.stand } : null;
    r.patch = { raid: keep, raidDoor };
    r.patchKey = key;
    return r.patch;
}

const at = (p: { x: number; y: number }) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

/**
 * The raid's orders for this tick (pure but for memory.raid). `members` are the unit's in the raid's region, dead ones too;
 * `guards` the board's keep guards there (fresh ones). The caller adds calm's empty fields.
 */
export function raidStep(o: { plan: RaidPlan; mem: Record<string, any>; members: readonly MemberReport[]; guards: readonly Contact[] }): { update: OrdersUpdate; orders: RaidOrders } {
    const { plan } = o;
    const r: RaidMemory = o.mem.raid;
    for (const m of o.members) for (const id of m.doorsBroken ?? []) if (!r.broken.includes(id)) r.broken.push(id);
    const view: RaidView = {
        members: o.members.map(m => ({ id: m.objectId, x: m.x, y: m.y, z: m.z, alive: !m.isDead })),
        seen: o.guards.map(guardSeen),
        owner: guardOwner(plan, o.guards),
        broken: r.broken,
        staged: r.staged,
    };
    const ro = raidOrders(plan, view);
    if (ro.phase === 'assault' || ro.phase === 'lord') r.staged = true;
    const settings = raidPatch(r, plan.keep, ro) as unknown as Record<string, unknown>;
    const objective = `raid ${plan.keep}: ${ro.phase}`;
    const door = ro.melee.step?.kind === 'door' ? `; melee on the ${ro.melee.step.label}` : '';
    const reason = `raid ${ro.phase}: ${ro.why}${door}`;
    if (ro.phase === 'approach' || ro.phase === 'stage') {
        // Each leg of our own bridge in turn: the body's next waypoint (routeFrom); at the stage, the stage.
        const alive = o.members.filter(m => !m.isDead);
        const centre = alive.length ? { x: alive.reduce((a, m) => a + m.x, 0) / alive.length, y: alive.reduce((a, m) => a + m.y, 0) / alive.length } : plan.rally;
        const next = ro.phase === 'stage' ? plan.stage : routeFrom(plan, centre)[0] ?? plan.stage;
        return { orders: ro, update: { phase: 'travel', focus: null, anchor: { x: next.x, y: next.y, z: next.z }, facing: { x: plan.stage.x, y: plan.stage.y }, settings, objective, reason: `${reason}, next ${at(next)}` } };
    }
    if (ro.phase === 'taken') return { orders: ro, update: { phase: 'recover', focus: null, anchor: ro.stand, settings, objective, reason } };
    const focus = [ro.ranged.focus, ro.melee.focus].find(f => f && f.kind === 'npc') ?? null;
    if (focus) return { orders: ro, update: { phase: 'engage', focus: focus.id, anchor: ro.stand, facing: { x: focus.x, y: focus.y }, settings, objective, reason } };
    return { orders: ro, update: { phase: 'recover', focus: null, anchor: ro.stand, settings, objective, reason: `${reason}, nothing to hit in view` } };
}

/** A door's spot within this (2D) to swing at it. */
const DOOR_REACH = 200;
/** Between swings' checks: the auto-attack goes on by itself. */
const DOOR_TICK_MS = 750;
/** The roles that break doors: raidOrders' melee half. */
export const DOOR_ROLES: ReadonlySet<Role> = new Set<Role>(['tank', 'melee']);

/**
 * Tanks and melee (DOOR_ROLES, by the member's own role: a list of one bot's carries it whatever the role) break the door the orders name (settings.raidDoor): to its stand, target the door object (it isn't on the
 * board: group frames carry no objects) and swing. Not while something is on this member (that fight first, raidOrders
 * makes it the focus), nor in a retreat. Off the door's orders, a swing still on the door is stopped.
 */
export const breakDoor = <S = any>(): Behavior<S> => ({
    name: 'breakDoor',
    async run(ctx) {
        const door = (ctx.settings as { raidDoor?: RaidDoor | null }).raidDoor ?? null;
        const me = ctx.me();
        const was: number | undefined = ctx.memory.get('doorOn');
        if (!door || !me || me.isDead || ctx.orders().phase === 'retreat' || !DOOR_ROLES.has(ctx.role)) {
            if (was !== undefined && me && !me.isDead && me.attacking && me.targetObjectId === was) await ctx.sdk.sendAttack(false);
            if (was !== undefined) ctx.memory.delete('doorOn');
            return false;
        }
        if (ctx.threats().some(c => c.target === ctx.name)) return false;
        const obj = ctx.sdk.getNearbyObjects().find(x => x.doorId === door.doorId) ?? null;
        const spot = obj ?? door;
        const d = Math.hypot(me.x - spot.x, me.y - spot.y);
        if (d > DOOR_REACH) {
            ctx.doing('door', obj?.objectId ?? null, `to the ${door.label}, ${Math.round(d)} away`);
            const w = await ctx.bot.walkTo(door.stand.x, door.stand.y, { z: door.stand.z, tolerance: 60 });
            if (!w.success) ctx.result('door', w, obj?.objectId ?? null);
            return true;
        }
        if (!obj) {
            ctx.doing('door', null, `at the ${door.label}, no door object in view`);
            return false;
        }
        ctx.doing('door', obj.objectId, `breaking the ${door.label}`);
        ctx.memory.set('doorOn', obj.objectId);
        if (me.targetObjectId !== obj.objectId) await ctx.sdk.sendSetTarget(obj.objectId);
        await ctx.sdk.sendFaceObject(obj.objectId);
        if (!me.attacking || me.targetObjectId !== obj.objectId) await ctx.sdk.sendAttack(true);
        await new Promise(res => setTimeout(res, DOOR_TICK_MS));
        return true;
    },
});

/** Where breakDoor goes in a list: before the first of the fight behaviours (tank, meleeFight, guard, assist), else before holdFormation, else last; once. */
export function withBreakDoor<S>(list: readonly Behavior<S>[]): Behavior<S>[] {
    if (list.some(b => b.name === 'breakDoor')) return [...list];
    const fight = ['tank', 'meleeFight', 'guard', 'assist', 'holdFormation'].map(n => list.findIndex(b => b.name === n)).filter(i => i >= 0);
    const i = fight.length ? Math.min(...fight) : list.length;
    return [...list.slice(0, i), breakDoor<S>(), ...list.slice(i)];
}

/** The strategy with breakDoor in the tanks' and melee's role lists (DOOR_ROLES) and in every member's own list (it checks the role itself). */
export function withRaid<S>(strategy: GroupStrategy<S>): GroupStrategy<S> {
    const behaviors = Object.fromEntries(Object.entries(strategy.behaviors).map(([role, list]) => [role, DOOR_ROLES.has(role as Role) ? withBreakDoor(list as Behavior<S>[]) : list])) as Record<Role, Behavior<S>[]>;
    const memberBehaviors = strategy.memberBehaviors && Object.fromEntries(Object.entries(strategy.memberBehaviors).map(([bot, list]) => [bot, withBreakDoor(list as Behavior<S>[])]));
    return { ...strategy, behaviors, ...(memberBehaviors ? { memberBehaviors } : {}) };
}
