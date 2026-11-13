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
import { meleeReach, passedDoors, planKeep, RAID_COMING, raidOrders, raidPlan, routeFrom, type RaidMember, type RaidOrders, type RaidPlan, type RaidView, type SiegeSeen } from '../siege';
import type { PlayerRealm } from '../keeps';
import type { GroupStrategy } from '../strategy';
import type { Contact, MemberReport, OrdersUpdate, Point, Point3, Role } from '../types';
import { answering, type RealmCall } from './help';
import type { RaidRez } from '../behaviors';

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
    /** The raid's other units' rezzers and corpses (behaviors.ts RaidRez): rez in the raid across its units. */
    raidRez?: RaidRez | null;
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
    /** When the raid first turned to the lord phase (the rush up waits for a fit, gathered unit from then: LORD_READY_MAX_MS). */
    lordSince?: number;
    /** Each member's health on the last lord tick: a fall ends the wait (lordHurt). */
    lordHp?: Record<string, number>;
}

/**
 * The rush up to the lord (siege.ts: once every breakable door is broken) waits, from the first lord tick, at most this long for the
 * unit to be fit and together: the dead rezzed while a rezzer lives, everyone at LORD_READY_HP % health or more, the healers and
 * casters at LORD_READY_MANA % power, every living one within LORD_READY_SPREAD of the body. The user, in hibernia's raid: "if the
 * second door is open and everyone is OK, rush up" (S2).
 */
export const LORD_READY_MAX_MS = 90_000;
export const LORD_READY_HP = 70;
export const LORD_READY_MANA = 70;
export const LORD_READY_SPREAD = 600;

/** Whether the unit is taking damage: a living member's health down since `last` (more than 1 %), or a guard aiming at one of us. */
export function lordHurt(members: readonly MemberReport[], guards: readonly Contact[], last: Readonly<Record<string, number>> | undefined): boolean {
    const names = new Set(members.map(m => m.name));
    if (guards.some(g => !g.stale && g.hp > 0 && !!g.target && names.has(g.target))) return true;
    return !!last && members.some(m => !m.isDead && last[m.name] !== undefined && m.hp < last[m.name]! - 1);
}

/** Why the unit isn't fit to rush the lord, or null when it is (LORD_READY_*). */
export function lordUnready(members: readonly MemberReport[], centre: Point): string | null {
    const alive = members.filter(m => !m.isDead);
    const dead = members.filter(m => m.isDead);
    const why: string[] = [];
    if (dead.length && alive.some(m => m.capabilities.rez)) why.push(`${dead.map(m => m.name).join(', ')} dead, a rez first`);
    for (const m of alive) {
        if (m.hp < LORD_READY_HP) why.push(`${m.name} at ${Math.round(m.hp)} % health`);
        else if (m.role !== 'tank' && m.role !== 'melee' && m.mana < LORD_READY_MANA) why.push(`${m.name} at ${Math.round(m.mana)} % power`);
    }
    const out = alive.filter(m => Math.hypot(m.x - centre.x, m.y - centre.y) > LORD_READY_SPREAD);
    if (out.length) why.push(`${out.map(m => m.name).join(', ')} not with us`);
    return why.length ? why.slice(0, 3).join(', ') : null;
}

/** The muster call we answer, once it says go; null otherwise. */
export function raidCall(mem: Record<string, any>): RealmCall | null {
    const c = answering(mem);
    return c && c.kind === 'muster' && c.stage === 'go' ? c : null;
}

/**
 * Enemy players this near the raid's keep stand under its guards (keeps.ts KEEP_AREA.keep). Before the assault none of them is fought
 * unless on us, and the raid waits outside for them (raidPeel in rvr.ts); the guards only once none is left. The user, playing Niamh
 * at 20:09: "try to peel the Albs at the keep from the outside, and only if everything is clean, we go for the guards."
 */
export const RAID_KEEP_AREA = 3000;
/** The raid waits for those this long at most, then leaves the raid. */
export const RAID_PEEL_MAX_MS = 180_000;
/** After a fight on the way, the raid rests and rebuffs this long at most (the user: "then rest if we win"). */
export const RAID_REST_MAX_MS = 120_000;

/** Whether `p` stands under the raid keep's guards (RAID_KEEP_AREA). */
export function underRaidKeep(plan: RaidPlan, p: Point): boolean {
    const k = planKeep(plan);
    return !!k && Math.hypot(p.x - k.x, p.y - k.y) <= RAID_KEEP_AREA;
}

/** Where the raid waits outside its keep's guards: RAID_KEEP_AREA + 900 out from the keep toward the rally (before any dry-ground fix). */
export function peelStand(plan: RaidPlan): Point3 {
    const k = planKeep(plan) ?? plan.stage;
    const d = Math.hypot(plan.rally.x - k.x, plan.rally.y - k.y) || 1;
    const r = Math.min(d, RAID_KEEP_AREA + 900);
    return { x: Math.round(k.x + (plan.rally.x - k.x) * r / d), y: Math.round(k.y + (plan.rally.y - k.y) * r / d), z: plan.rally.z };
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

/**
 * The raid's other units' rezzers (alive, knowing a rez) and corpses, from the muster call (director.ts RaidMember), by
 * object id; null without any. Stint 2026-11-13 (S3): the dead walked 12000-20000 back while a rezzer of another unit stood by.
 */
export function raidRez(call: Pick<RealmCall, 'raid'> | null | undefined, unit: string): RaidRez | null {
    const others = (call?.raid ?? []).filter(m => m.unit !== unit && m.id);
    const rezzers = others.filter(m => m.alive && m.rez).map(m => m.id!).sort((a, b) => a - b);
    const corpses = others.filter(m => !m.alive).map(m => ({ id: m.id!, name: m.name ?? '', level: m.level ?? 0 })).sort((a, b) => a.id - b.id);
    return rezzers.length || corpses.length ? { rezzers, corpses } : null;
}

/** The settings patch for this step, the same object while nothing in it changes. */
export function raidPatch(r: RaidMemory, keep: string, o: RaidOrders, rez: RaidRez | null = null): RaidPatch {
    const step = o.melee.step?.kind === 'door' && o.melee.step.doorId !== undefined ? o.melee.step : null;
    const key = `${keep}:${step?.doorId ?? ''}:${rez ? `${rez.rezzers.join(',')}/${rez.corpses.map(c => c.id).join(',')}` : ''}`;
    if (r.patch && r.patchKey === key) return r.patch;
    const raidDoor: RaidDoor | null = step ? { doorId: step.doorId!, label: step.label, x: step.at.x, y: step.at.y, z: step.at.z, stand: step.stand } : null;
    r.patch = { raid: keep, raidDoor, ...(rez ? { raidRez: rez } : {}) };
    r.patchKey = key;
    return r.patch;
}

/**
 * The whole raid for RaidView.raid: our own members as they are now, and every other unit's from the muster call (RealmCall.raid,
 * the director's picture, a few seconds old). Undefined when the call carries none: each unit then stages on its own count.
 * R1, run D 04:19: midgard staged alone and lost four in 16 s at rank 1 while midgard-2 and the squads were 13000-18000 out.
 */
export function raidMembers(call: Pick<RealmCall, 'raid'> | null | undefined, unit: string, ours: readonly MemberReport[], stage?: Point): RaidMember[] | undefined {
    if (!call?.raid?.length) return undefined;
    // A member on its way (director.ts onWay: its unit still closing on the target) counts at any distance: placed just inside
    // siege.ts RAID_COMING on its line to the stage. Run D3 05:30 (R3): the squads, then hibernia, then hibernia-2 went in as
    // three waves, each passing the wait on its own count because the others were 13000-25000 out.
    const near = (m: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
        if (!stage) return m;
        const d = Math.hypot(m.x - stage.x, m.y - stage.y);
        if (d <= RAID_COMING) return m;
        const k = (RAID_COMING - 100) / d;
        return { x: Math.round(stage.x + (m.x - stage.x) * k), y: Math.round(stage.y + (m.y - stage.y) * k), z: m.z };
    };
    const others = call.raid.filter(m => m.unit !== unit).map((m, i) => ({ id: -(i + 1), ...(m.onWay && m.alive ? near(m) : { x: m.x, y: m.y, z: m.z }), alive: m.alive }));
    return [...ours.map(m => ({ id: m.objectId, x: m.x, y: m.y, z: m.z, alive: !m.isDead })), ...others];
}

/** The bolt (siege.ts RaidOrders.bolt): members whose longest damaging spell reaches this far (capabilities.reach) ... */
export const BOLT_REACH = 1650;
/** ... at most this many. */
const BOLT_SHOOTERS = 2;

/** A unit of this many members or fewer is a squad: it doesn't lead a raid (raidStep's squad hold). */
export const SQUAD_MAX = 3;
/** A main group has at least this many members in the raid. */
const MAIN_MIN = 4;
/** The squads' hold: the last waypoint of the approach at least this far from the stage (out of the defenders' reach). */
export const SQUAD_HOLD_FROM = 3000;

/** Where a squad waits for a main group to pass: the last approach waypoint at least SQUAD_HOLD_FROM from the stage; the rally else. */
export function squadHold(plan: Pick<RaidPlan, 'rally' | 'route' | 'stage'>): Point3 {
    const way = [plan.rally, ...plan.route];
    for (let i = way.length - 1; i >= 0; i--) if (Math.hypot(way[i]!.x - plan.stage.x, way[i]!.y - plan.stage.y) >= SQUAD_HOLD_FROM) return way[i]!;
    return plan.rally;
}

/**
 * A squad doesn't lead: while the raid has a main group on its way (a unit of MAIN_MIN or more with a living member on its
 * way or within RAID_COMING) and none of its living stands as near the stage as the hold point, the squad waits at the hold.
 * Null: go on. R3, run D3 05:32: Hibernia's squads stood 2300 from the stage and about ten Albions wiped them there.
 */
export function squadWait(plan: Pick<RaidPlan, 'rally' | 'route' | 'stage'>, call: Pick<RealmCall, 'raid'> | null | undefined, unit: string): { hold: Point3; why: string } | null {
    const raid = call?.raid ?? [];
    const size = new Map<string, number>();
    for (const m of raid) size.set(m.unit, (size.get(m.unit) ?? 0) + 1);
    const hold = squadHold(plan);
    const holdD = Math.hypot(hold.x - plan.stage.x, hold.y - plan.stage.y);
    const toStage = (m: { x: number; y: number }) => Math.hypot(m.x - plan.stage.x, m.y - plan.stage.y);
    const mains = raid.filter(m => m.unit !== unit && (size.get(m.unit) ?? 0) >= MAIN_MIN && m.alive && (m.onWay || toStage(m) <= RAID_COMING));
    if (!mains.length) return null;
    if (mains.some(m => toStage(m) <= holdD + 300)) return null;
    const lead = mains.reduce((a, b) => (toStage(a) <= toStage(b) ? a : b));
    return { hold, why: `squad waits for ${lead.unit} to pass (it is ${Math.round(toStage(lead))} from the stage)` };
}

const at = (p: { x: number; y: number }) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

/**
 * The raid's orders for this tick (pure but for memory.raid). `members` are the unit's in the raid's region, dead ones too;
 * `guards` the board's keep guards there (fresh ones). The caller adds calm's empty fields.
 */
export function raidStep(o: { plan: RaidPlan; mem: Record<string, any>; members: readonly MemberReport[]; guards: readonly Contact[]; call?: Pick<RealmCall, 'raid' | 'rush'> | null; unit?: string }): { update: OrdersUpdate; orders: RaidOrders } {
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
    // A living member behind a door proves it passed (siege.ts passedDoors): broken, for the walks and the melee's reach too, whether
    // or not anyone read "The Keep Door is broken!" (the user in hibernia's raid: members past the gate, "melee on the gate" still).
    for (const id of passedDoors(plan, view.members)) if (!r.broken.includes(id)) r.broken.push(id);
    const whole = raidMembers(o.call, o.unit ?? '', o.members, plan.stage);
    if (whole) view.raid = whole;
    // The director's rush (RealmCall.rush: a raid unit at the lord or by his room): for siege.ts's raidOrders, everyone up now.
    if (o.call?.rush) (view as RaidView & { rush?: boolean }).rush = true;
    // Doors the whole raid passed (another unit's living members behind them) are broken for our walks too (S2: hibernia-s1 joined
    // late at 21:53 and started at rank 1, its walks blocked by "a shut door at (34333, 38275)" while hibernia stood at the lord).
    for (const id of passedDoors(plan, whole ?? [])) if (!r.broken.includes(id)) r.broken.push(id);
    const alive = o.members.filter(m => !m.isDead);
    const centre = alive.length ? { x: alive.reduce((a, m) => a + m.x, 0) / alive.length, y: alive.reduce((a, m) => a + m.y, 0) / alive.length, z: alive.reduce((a, m) => a + m.z, 0) / alive.length } : null;
    // Melee take a caster on a wall or the roof only by a found route from where we stand, the shut doors as walls (R5's
    // meleeReach): live 08:36 a Wizard on us on wall-se drew midgard-2's melee straight up the wall.
    if (centre) view.reach = to => meleeReach(plan.regionId, centre, to, { broken: r.broken, ours: view.owner === plan.realm });
    const ro = raidOrders(plan, view);
    if (ro.phase === 'assault' || ro.phase === 'lord') r.staged = true;
    const settings = raidPatch(r, plan.keep, ro, raidRez(o.call, o.unit ?? '')) as unknown as Record<string, unknown>;
    const objective = `raid ${plan.keep}: ${ro.phase}`;
    const door = ro.melee.step?.kind === 'door' ? `; melee on the ${ro.melee.step.label}` : '';
    const reason = `raid ${ro.phase}: ${ro.why}${door}`;
    // Squads don't lead: short of the stage, they wait at the hold until a main group passes it (squadWait).
    const wait = (ro.phase === 'approach' || ro.phase === 'stage') && !r.staged && o.members.length <= SQUAD_MAX ? squadWait(plan, o.call, o.unit ?? '') : null;
    if (wait && centre && Math.hypot(centre.x - plan.stage.x, centre.y - plan.stage.y) <= Math.hypot(wait.hold.x - plan.stage.x, wait.hold.y - plan.stage.y) + 600) {
        return { orders: ro, update: { phase: 'recover', focus: null, anchor: { x: wait.hold.x, y: wait.hold.y, z: wait.hold.z }, facing: { x: plan.stage.x, y: plan.stage.y }, settings, objective, reason: `raid ${ro.phase}: ${wait.why}, at ${at(wait.hold)}` } };
    }
    // The rush up to the lord: from the first lord tick, everyone fit and together first (lordUnready), LORD_READY_MAX_MS at most.
    if (ro.phase === 'lord') r.lordSince ??= Date.now();
    // Taking damage while it waits (someone's health falling since the last tick, or a guard on one of us): go at once, no more
    // waiting (S2, albion-149 at 22:33: held in the courtyard under live wall casters, Elaine dead, Gareth 61 % to 15 % in 45 s).
    if (ro.phase === 'lord' && Date.now() - r.lordSince! < LORD_READY_MAX_MS) {
        const hurt = lordHurt(o.members, o.guards, r.lordHp);
        r.lordHp = Object.fromEntries(o.members.map(m => [m.name, m.hp]));
        if (hurt) r.lordSince = 0;
    }
    if (ro.phase === 'lord' && centre && Date.now() - r.lordSince! < LORD_READY_MAX_MS) {
        const unready = lordUnready(o.members, centre);
        if (unready) {
            const left = Math.ceil((LORD_READY_MAX_MS - (Date.now() - r.lordSince!)) / 1000);
            return { orders: ro, update: { phase: 'recover', focus: null, anchor: { x: Math.round(centre.x), y: Math.round(centre.y), z: Math.round(centre.z) }, settings, objective, reason: `raid lord: everyone OK before the rush up: ${unready}, ${left} s at most` } };
        }
    }
    if (ro.phase === 'approach' || ro.phase === 'stage') {
        // Each leg of our own bridge in turn: the body's next waypoint (routeFrom); at the stage, the stage.
        // The way on from the member furthest along it, not the centre: a formation trails behind its anchor, so the centre of a
        // group stood at the waypoint is 500-1000 short of it and never "reached" it (live 15:18-15:27: camelot idle at the rally's
        // first waypoint for 9 min; 13:01-13:15 1700 short of the stage; hibernia-s4 730 from its first waypoint on 11-13).
        const way = alive.length ? alive.map(m => routeFrom(plan, m)).reduce((a, b) => (b.length < a.length ? b : a)) : routeFrom(plan, plan.rally);
        const next = ro.phase === 'stage' ? plan.stage : way[0] ?? plan.stage;
        return { orders: ro, update: { phase: 'travel', focus: null, anchor: { x: next.x, y: next.y, z: next.z }, facing: { x: plan.stage.x, y: plan.stage.y }, settings, objective, reason: `${reason}, next ${at(next)}` } };
    }
    if (ro.phase === 'taken') return { orders: ro, update: { phase: 'recover', focus: null, anchor: ro.stand, settings, objective, reason } };
    // The ranged half's focus is the unit's; the melee get their own (Orders.meleeFocus): a door is breakDoor's, and a caster
    // on a wall or the roof they can't reach is the ranged half's alone (live 08:36: midgard-2's melee climbed to wall-se).
    const npc = (f: SiegeSeen | null) => (f && f.kind === 'npc' ? f : null);
    const melee = npc(ro.melee.focus);
    // The bolt (siege.ts RaidOrders.bolt, S2: the roof-e Hunter, seen only from the wall-walk above the gate at 1650-1700): one or two
    // living non-melee of reach 1650 or more, nearest its stand first, go there with it as their own focus (Orders.memberOwn).
    const boltFocus = npc(ro.bolt?.focus ?? null);
    const shooters = ro.bolt && boltFocus ? o.members.filter(m => !m.isDead && m.role !== 'tank' && m.role !== 'melee' && (m.capabilities.reach ?? 0) >= BOLT_REACH)
        .sort((a, b) => Math.hypot(a.x - ro.bolt!.stand.x, a.y - ro.bolt!.stand.y) - Math.hypot(b.x - ro.bolt!.stand.x, b.y - ro.bolt!.stand.y)).slice(0, BOLT_SHOOTERS) : [];
    const memberOwn = shooters.length ? Object.fromEntries(shooters.map(m => [m.name, { focus: boltFocus!.id, anchor: ro.bolt!.stand }])) : undefined;
    const own = memberOwn ? { memberOwn } : {};
    const bolted = memberOwn ? `; ${shooters.map(m => m.name).join(' and ')} on the ${ro.bolt!.step?.label ?? 'roof'} from the wall` : '';
    // The ranged half holds out of the walls' sight (siege.ts RaidTask.hold) while the melee climb to a wall caster: the casters and
    // healers stay at ro.stand, the melee get the caster. The user at 17:3x: "Fiacra and Amergin are not safe, they are being hit by
    // the Runemasters" (they followed the melee's focus into the courtyard).
    if (ro.ranged.hold) {
        // Two or more wall casters up and reachable (siege.ts melee.split, nearest the stair first): one tank or melee on each, in turn
        // (the user, 18:0x: "tanks go in. up the stairs. one for each runi. then the casters").
        const split = (ro.melee.split ?? []).filter(x => x.kind === 'npc');
        const climbers = o.members.filter(m => !m.isDead && (m.role === 'tank' || m.role === 'melee'));
        const meleeSplit = split.length > 1 && climbers.length > 1 ? Object.fromEntries(climbers.map((m, i) => [m.name, split[i % split.length]!.id])) : undefined;
        const spread = meleeSplit ? `; ${split.length} wall casters, one each` : '';
        return { orders: ro, update: { phase: 'engage', focus: null, meleeFocus: melee?.id ?? null, ...(meleeSplit ? { meleeSplit } : {}), ...own, anchor: ro.stand, ...(melee ? { facing: { x: melee.x, y: melee.y } } : {}), settings, objective, reason: `${reason}; ranged out of sight: ${ro.ranged.hold}${spread}${bolted}` } };
    }
    const focus = npc(ro.ranged.focus) ?? melee;
    if (focus) {
        const meleeFocus = melee?.id ?? null;
        return { orders: ro, update: { phase: 'engage', focus: focus.id, meleeFocus: meleeFocus === focus.id ? undefined : meleeFocus, ...own, anchor: ro.stand, facing: { x: focus.x, y: focus.y }, settings, objective, reason: `${reason}${meleeFocus === null && !door ? '; melee hold' : ''}${bolted}` } };
    }
    if (memberOwn) return { orders: ro, update: { phase: 'engage', focus: null, meleeFocus: null, ...own, anchor: ro.stand, settings, objective, reason: `${reason}${bolted}` } };
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
