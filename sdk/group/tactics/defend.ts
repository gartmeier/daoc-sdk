// A unit answering its realm's defence call (director.ts 'defend', S3, stint 2026-11-13): our keep is attacked, and the
// director asked us in. The coordinator's side of S2's defence from inside (siege.ts defencePlan, defenceOrders; defence.ts
// defenceSettings, holdDefenceStand): each tick it seats every member on a stand by its jobs and hands the seats out in
// Orders.settings.defence; holdDefenceStand, first in every list, walks each member in over our bridge and through our own
// doors to its stand, and the kit fights from there. The orders keep no anchor outside a fight, so holdFormation doesn't
// pull members off their stands; the group neither hunts nor falls back while it defends (rvr.ts decideRvr).

import { defenceSettings, holdDefenceStand, type DefenceSettings } from '../defence';
import type { PlayerRealm } from '../keeps';
import type { Behavior } from '../member';
import { defenceOrders, defencePlan, type DefenceJob } from '../siege';
import type { GroupStrategy } from '../strategy';
import type { Contact, MemberReport, Role } from '../types';
import { answering, type RealmCall } from './help';

/** Enemies within this of the lord count as the keep's attackers (siege.ts threat: outside, inside, roof). */
const ATTACK_RADIUS = 4500;

/** The defence call we answer, if any. */
export function defendCall(mem: Record<string, any>): RealmCall | null {
    const c = answering(mem);
    return c && c.kind === 'defend' ? c : null;
}

/**
 * A member's defence jobs (siege.ts defenceJobs reads spells; a report carries capabilities): the member's own
 * `capabilities.defence` when its report has it, else from its role and capabilities: a healer heals by the stair, a caster
 * with a nuke takes the wall, the rest the courtyard.
 */
export function memberJobs(m: Pick<MemberReport, 'role' | 'capabilities'>): DefenceJob[] {
    const own = (m.capabilities as { defence?: DefenceJob[] }).defence;
    if (own?.length) return own;
    const jobs: DefenceJob[] = [];
    if (m.role === 'healer') jobs.push('heal');
    if (m.capabilities.nuke && m.role !== 'tank' && m.role !== 'melee') jobs.push('wall');
    jobs.push('yard');
    return jobs;
}

/**
 * The settings patch for this tick (Orders.settings.defence), the same object while the seats don't change; null without a
 * defence plan for our realm or once the keep is lost. Memory: defenceSeats (last tick's seats), defencePatch.
 */
export function defendPatch(mem: Record<string, any>, realm: PlayerRealm, members: readonly MemberReport[], contacts: readonly Contact[]): DefenceSettings | null {
    const plan = defencePlan(realm);
    if (!plan) return null;
    const near = (p: { x: number; y: number }) => Math.hypot(p.x - plan.lord.x, p.y - plan.lord.y) <= ATTACK_RADIUS;
    const foes = contacts.filter(c => !c.stale && c.hp > 0 && c.realm !== realm && (c.kind === 'player' || c.isPet) && !c.keepGuard && near(c)).map(c => ({ x: c.x, y: c.y, z: c.z }));
    const here = members.filter(m => m.regionId === plan.regionId);
    const defenders = here.map(m => ({ id: m.objectId, x: m.x, y: m.y, z: m.z, alive: !m.isDead, jobs: memberJobs(m) }));
    const o = defenceOrders(plan, { defenders, foes, owner: realm, seats: mem.defenceSeats as Map<number, string> | undefined });
    mem.defenceSeats = new Map([...o.seats].map(([id, s]) => [id, s.label]));
    const broken: number[] = [...new Set(here.flatMap(m => m.doorsBroken ?? []))];
    const names = new Map(here.map(m => [m.objectId, m.name]));
    const patch = defenceSettings(plan, o, names, broken, mem.defencePatch ?? null);
    mem.defencePatch = patch;
    mem.defenceWhy = o.why;
    return patch;
}

/** `base` with the defence patch on top: the same object while neither changes (members rebuild their settings on a new one). */
export function overDefence(mem: Record<string, any>, base: Record<string, unknown> | null, defence: DefenceSettings): Record<string, unknown> {
    const m = mem.defenceOver as { base: unknown; defence: unknown; out: Record<string, unknown> } | undefined;
    if (m && m.base === base && m.defence === defence) return m.out;
    const out = { ...(base ?? {}), defence } as Record<string, unknown>;
    mem.defenceOver = { base, defence, out };
    return out;
}

/** holdDefenceStand first in a list, once (it does nothing without settings.defence). */
export function withDefenceStand<S>(list: readonly Behavior<S>[]): Behavior<S>[] {
    if (list.some(b => b.name === holdDefenceStand.name)) return [...list];
    // After release and the answer to a rez: a corpse doesn't walk.
    const i = list.findIndex(b => b.name === 'release');
    return i >= 0 ? [...list.slice(0, i + 1), holdDefenceStand as Behavior<S>, ...list.slice(i + 1)] : [holdDefenceStand as Behavior<S>, ...list];
}

/** The strategy with holdDefenceStand in every role's and member's list. */
export function withDefence<S>(strategy: GroupStrategy<S>): GroupStrategy<S> {
    const behaviors = Object.fromEntries(Object.entries(strategy.behaviors).map(([role, list]) => [role, withDefenceStand(list as Behavior<S>[])])) as Record<Role, Behavior<S>[]>;
    const memberBehaviors = strategy.memberBehaviors && Object.fromEntries(Object.entries(strategy.memberBehaviors).map(([bot, list]) => [bot, withDefenceStand(list as Behavior<S>[])]));
    return { ...strategy, behaviors, ...(memberBehaviors ? { memberBehaviors } : {}) };
}
