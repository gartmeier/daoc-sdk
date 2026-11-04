// RvR roaming in a battleground: the group patrols a loop round a neutral meeting
// point, fights the enemy players it meets, hunts groups it sees when they don't
// outnumber it, falls back toward its own portal keep (or away from them when they stand
// that way) when they do, and regroups after deaths (a release lands at the realm's portal
// keep, 20k from the middle).
//
// Server rules it follows (server/core/GameServer, Normal rules):
//  - Players of different realms may attack each other anywhere: nothing checks the
//    region, zone or area (NormalServerRules.IsAllowedToAttack). For 10 s after arriving,
//    logging in or releasing, a player can neither attack nor be attacked by players
//    (AbstractServerRules.cs:235-261, 359-375); the behaviours retry on "immune".
//  - Enemy players come with their race as name ("Celt", NormalServerRules.GetPlayerName):
//    contacts are told apart by objectId, never by name.
//  - Keep guards take the realm of the keep whose area they stand in and attack enemy
//    players within 2000 (portal keeps, level 255) or 1000 (other keeps), with the LoS
//    check sent to the target's own client, which always answers clear
//    (GameKeepGuard.cs:88-95, 454-482, 803-806; KeepGuardBrain.cs:47). Keeps load without
//    walls here (keepcomponent is empty), so nothing gives cover: the group stays
//    keepClearance from every keep that isn't ours (keepDangers) and ignores enemies
//    standing inside those circles unless they attack us.
//  - With bg_release_to_portal_keep on, a release lands at the realm's portal keep
//    (GamePlayer.cs:1412-1427, 1560-1588), else at the bind point in another region:
//    such members count as missing and never hold the group up.
//  - An RvR death costs no experience and no constitution (GamePlayer.cs:5920-5944) and
//    battlegrounds have no town healer: the behaviour lists have no healer() visit.
//  - Thidranki takes levels 20-24 (battleground.sql); a member above 24 is moved out at
//    its next logout (GamePlayer.CleanupOnDisconnect): rvrFindings warns at 24.
//
// decide() runs every coordinator tick on the shared picture and only writes orders;
// members carry them out with their behaviour lists (rvrBehaviors).

import { estimateZ, getClass, realmName } from '../../data/index';
import type { Realm } from '../types';
import { assist, buff, crowdControl, flee, guard, hand, heal, holdFormation, meleeFight, position, rejoinFight, release, rest, retreat, rez, SAVING_POWER, shedLoad, song, spareNuke, sprint, tank, type TacticsSettings } from './behaviors';
import type { Behavior } from './member';
import type { Finding, RunReport } from './observer';
import { isAlive, untouchable } from './blackboard';
import { PET_SETTINGS, waitsForPet } from './pets';
import { assignCc } from './pve';
import type { CoordinatorContext, GroupStrategy } from './strategy';
import { BATTLEGROUND_LAYOUTS, clearOf, homeOf, KEEP_CLEARANCE, keepDangers, THIDRANKI, type KeepSettings, type PlayerRealm } from './keeps';
import { aggroZones, keepOnMap, safePath, type Danger } from './terrain';
import type { Contact, MemberReport, OrdersUpdate, Point, Point3, Role } from './types';

export { BATTLEGROUND_LAYOUTS, homeOf, keepDangers, KEEP_CLEARANCE, THIDRANKI, type BattlegroundLayout, type Keep, type KeepSettings, type PlayerRealm } from './keeps';

export interface RvrSettings extends TacticsSettings, KeepSettings {
    /**
     * Fight enemy players within this of the main body's centre (the focus and enemies that attacked us: 1000
     * beyond); enemies that attack one of the main body at any distance, one that attacks a member away from
     * it only within this (that member fights or flees by itself while the group comes to meet it).
     */
    engageRadius: number;
    /** Go after enemy players seen within this of the centre when they don't outnumber us. */
    huntRadius: number;
    retreat: {
        enabled: boolean;
        /**
         * Run (or fall back from a group in sight) when the enemy players against us are at least the members
         * in the main body plus this. Against us: one realm's players that are free (not crowd-controlled) and
         * not fighting the third realm, the largest such realm, plus those of the other realm attacking us.
         */
        margin: number;
        /** ... but never while the focus is below this % health: finish it first. */
        focusHp: number;
        /** How far to run: toward our portal keep, or straight away when the enemies stand that way. */
        distance: number;
        /**
         * Still followed after this long by enough to outnumber us: caught, fight it out (running on gets us
         * killed from behind). The next retreat comes only after they stopped outnumbering us in between.
         */
        maxMs: number;
    };
    /** Switch the focus to an enemy below this % health while the focus is above this + 20. */
    switchBelow: number;
    /** Patrol only when everyone is at least this healthy (mana: members that heal, nuke or mezz); hunt with one short of it. */
    ready: { hp: number; mana: number };
    /** Members farther than this from the main body are met halfway (walking back from the portal keep after a release). */
    gatherRadius: number;
    /** Travel in legs of at most this length. */
    travelLeg: number;
    /** Patrol this loop instead of defaultPatrol (a ring round the battleground's meeting point). */
    patrol: Point3[] | null;
}

export const RVR_SETTINGS: RvrSettings = {
    // Hold times apply to monsters only: no tank holds an enemy player (assist hits those at once).
    holdMs: 1500,
    assistAfterMs: 6000,
    // Players hit harder and in bursts: heal earlier than in PvE.
    heal: { tank: 75, other: 70, emergency: 40, outOfCombat: 90 },
    // An RvR death costs no XP or constitution, and a release gives full health and power: a rez saves only the walk
    // back, about 100 s. So the rezzer pays only from what it has, keeping a reserve, and may do it mid-fight when the group can spare it.
    rez: { holdMs: 60_000, sit: false, reserve: 25, inFight: true },
    rest: { hp: 90, mana: 80 },
    combatRange: { healer: [500, 1600], support: [500, 1600], nuker: [700, 1400] },
    slotSlack: 350,
    // Tighter than PvE: nothing is pulled to the tank, and a spread group gets picked apart.
    formation: { tank: { back: 0, angle: 0 }, healer: { back: 450, angle: 0.45 }, support: { back: 450, angle: -0.45 }, nuker: { back: 700, angle: 0.3 }, melee: { back: 120, angle: 0.8 } },
    pullDistance: 700,
    buffMana: 40,
    aoe: false,
    meleeWhenOom: false,
    shedLoadAt: 95,
    keepItems: 'Bind Recall|Initiate|Staff of|Lute|Focus Staff|^task',
    tauntOpenMs: 6000,
    peelAfterMs: 4000,
    guard: { guard: 'healer', protect: 'nuker' },
    pet: PET_SETTINGS,
    // Round 2 (20261101-085134): tanks chased fleeing players 3000+ away from their group. Measured from
    // the fight's anchor, which decideRvr moves toward a focus beyond it: with FIGHT_DRIFT this covers every
    // focus within engageRadius + FOCUS_SLACK of the centre (2000 + 1500 ≥ 2500 + 1000).
    chaseLeash: 2000,
    engageRadius: 2500,
    huntRadius: 5000,
    keepClearance: KEEP_CLEARANCE,
    keepOwners: {},
    // margin 2 → 3 (round 6, 20261101-101056): Midgard on 3 retreated 4× instead of 12×, 10 player kills instead of 4,
    // 5 deaths instead of 7; Hibernia on 2 spent 42 % of the same run retreating, often caught rooted.
    retreat: { enabled: true, margin: 3, focusHp: 25, distance: 3000, maxMs: 20_000 },
    switchBelow: 25,
    ready: { hp: 75, mana: 50 },
    gatherRadius: 2500,
    travelLeg: 1500,
    patrol: null,
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ps: Point[]): Point => ({ x: ps.reduce((a, p) => a + p.x, 0) / Math.max(1, ps.length), y: ps.reduce((a, p) => a + p.y, 0) / Math.max(1, ps.length) });
const usesMana = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc || !!m.capabilities.pet;
/** The member a contact is on: itself, or its pet. */
export const onWhom = (c: Contact): string | null => c.target ?? c.targetPet ?? null;
const names = (ms: { name: string }[]) => ms.map(m => m.name).join(', ');
const enemiesText = (n: number) => `${n} ${n === 1 ? 'enemy' : 'enemies'}`;
const at = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
const label = (c: Contact) => c.kind === 'player'
    ? `${c.name}#${c.objectId} (${c.realm} L${c.level}${c.healer ? ' healer' : c.caster ? ' caster' : ''}, ${c.hp}%)`
    : `${c.name} L${c.level} (${c.hp}%)`;

/** The realm most members' classes belong to; 'none' when no class is known. */
export function realmOfGroup(members: readonly { className: string }[]): Realm {
    const votes = new Map<Realm, number>();
    for (const m of members) {
        const c = getClass(m.className);
        if (c) votes.set(realmName(c.realm), (votes.get(realmName(c.realm)) ?? 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
}

/** Default patrol: waypoints on a ring of this radius round the meeting point. */
const PATROL_RADIUS = 5500, PATROL_POINTS = 6;
/** Each waypoint stays this far outside aggro zones and keep circles: casters stand up to ~700 behind the anchor. */
const PATROL_MARGIN = 900;
/** Where an unsafe waypoint is tried next: [radius change, angle change in radians]. */
const NUDGES: [number, number][] = [[0, 0], [-500, 0], [500, 0], [-1000, 0], [1000, 0], [0, 0.15], [0, -0.15], [-1000, 0.15], [-1000, -0.15]];
/**
 * Which way each realm goes round (+1: increasing angle). Midgard and Albion start ~100° apart
 * on the ring and close that gap head-on; Hibernia comes round behind Albion.
 */
const PATROL_TURN: Record<PlayerRealm, 1 | -1> = { albion: -1, midgard: 1, hibernia: -1 };

/**
 * A loop of waypoints on a ring round the battleground's meeting point, starting at the one
 * nearest our arrival point. Each is nudged out of aggro zones and keep circles (PATROL_MARGIN),
 * or dropped when nothing near it is safe. Empty outside a known battleground.
 */
export function defaultPatrol(regionId: number, realm: Realm, level: number, settings: Partial<KeepSettings> = {}): Point3[] {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    const home = homeOf(regionId, realm);
    if (!bg || !home || realm === 'none') return [];
    const blocked = [...aggroZones(regionId, level), ...keepDangers(regionId, realm, settings)];
    const { meet } = bg;
    const a0 = Math.atan2(home.arrival.y - meet.y, home.arrival.x - meet.x);
    const out: Point3[] = [];
    for (let k = 0; k < PATROL_POINTS; k++) {
        const a = a0 + PATROL_TURN[realm] * k * 2 * Math.PI / PATROL_POINTS;
        const spot = NUDGES
            .map(([dr, da]) => ({ x: Math.round(meet.x + Math.cos(a + da) * (PATROL_RADIUS + dr)), y: Math.round(meet.y + Math.sin(a + da) * (PATROL_RADIUS + dr)) }))
            .find(p => clearOf(p, blocked, PATROL_MARGIN));
        if (spot) out.push({ ...spot, z: estimateZ(regionId, spot.x, spot.y, meet.z, { radius: 8000 }) });
    }
    // The first waypoint may have been dropped: start at the one nearest home.
    const first = out.reduce((best, p, i) => (dist(p, home.arrival) < dist(out[best]!, home.arrival) ? i : best), 0);
    return [...out.slice(first), ...out.slice(0, first)];
}

/**
 * Who to focus among the candidates, free (not crowd-controlled) ones first. Score: a healer
 * +60, a caster +30, on one of our healers or casters +20, missing health up to +30 and below
 * switchBelow +40 more (nearly dead goes first), within our tank's and melee's reach (`reach`:
 * the chase leash) +15, near our centre up to +10. A healer beyond the leash still goes before a
 * fighter in it: the fight's anchor moves toward it (decideRvr). decideRvr's pool has what isn't a player
 * only with every player crowd-controlled: so what's free and on us comes before a mezzed or rooted player.
 */
export function pickRvrFocus(pool: readonly Contact[], opts: { centre: Point; members: readonly MemberReport[]; settings: Pick<RvrSettings, 'switchBelow' | 'engageRadius'>; reach?: (c: Contact) => boolean }): Contact | null {
    const soft = new Set(opts.members.filter(m => m.role === 'healer' || m.role === 'support' || m.role === 'nuker').map(m => m.name));
    const s = opts.settings;
    const score = (c: Contact) => (c.healer ? 60 : 0) + (c.caster ? 30 : 0) + (c.target !== null && soft.has(c.target) ? 20 : 0)
        + (100 - c.hp) * 0.3 + (c.hp < s.switchBelow ? 40 : 0) + (opts.reach?.(c) ? 15 : 0) + Math.max(0, 1 - dist(c, opts.centre) / s.engageRadius) * 10;
    const free = pool.filter(c => !c.cc);
    return [...(free.length ? free : pool)].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The focus stays a candidate this much beyond engageRadius (it runs; we don't drop it at the line). */
const FOCUS_SLACK = 1000;
/** A fight's anchor is moved back to the group's centre once it is this far from it (and toward a focus at most this far from it). */
const FIGHT_DRIFT = 1500;
/**
 * A focus beyond chaseLeash from the fight's anchor moves the anchor toward it, to leave it this share
 * of the leash away: with the default leash it runs 800 farther before the anchor moves again.
 */
const LEASH_FIT = 0.6;
/** A crowd-control assignment whose target is still free after this long goes to another mezzer ... */
const CC_STALL_MS = 8000;
/** ... and the member who had it gets none for this long (it may be mezzed or stunned itself, which it can't tell us). */
const CC_BENCH_MS = 10_000;
/** Hunting goes on with at most this many members not ready (dead, away, hurt or low on power). */
const HUNT_UNREADY = 1;
/** A hunt is re-planned from the group's centre once the enemies' centre moved this far. */
const HUNT_REPLAN = 800;
/** Members within this of a leg have reached it (casters stand ~700 behind the anchor). */
const LEG_REACHED = 1200;
/** After this long, a leg counts as reached with one member still short of it (stuck or lagging). */
const LEG_TIMEOUT_MS = 30_000;

export interface Trip {
    mem: Record<string, any>;
    now: number;
    regionId: number;
    level: number;
    /** Keep circles a route stays out of (keepDangers). */
    avoid: Danger[];
    travelLeg: number;
    zAt(p: Point): number;
}

function reachedBy(leg: Point, movers: readonly Point[], ageMs: number): boolean {
    const short = movers.filter(m => dist(m, leg) >= LEG_REACHED).length;
    return short === 0 || (ageMs > LEG_TIMEOUT_MS && short <= 1);
}

/**
 * The leg in force toward `goal`: kept until `movers` reached it, then the next one, chained from
 * it along a route round aggro zones and keep circles (safePath). A new kind of trip, or a goal
 * that moved more than `replan`, starts over from `from`. With `meet`, a leg covers at most half
 * the gap (the other side walks toward us). Writes memory.leg, legFacing and route (the viewer draws them).
 */
export function stepLeg(t: Trip, kind: string, goal: Point, o: { from: Point; movers: readonly Point[]; replan: number; meet?: boolean; force?: boolean }): void {
    const { mem } = t;
    if (mem.legKind !== kind || !mem.goal || dist(mem.goal, goal) > o.replan) {
        mem.legKind = kind;
        mem.leg = null;
        mem.route = null;
    }
    if (!o.force && mem.leg && !reachedBy(mem.leg, o.movers, t.now - mem.legAt)) return;
    const from: Point = mem.leg ?? o.from;
    if (!mem.route || dist(mem.goal, goal) > 1) {
        mem.route = safePath(t.regionId, t.level, from, goal, t.avoid);
        mem.goal = { x: Math.round(goal.x), y: Math.round(goal.y) };
    }
    while (mem.route.length > 1 && dist(from, mem.route[0]) < 300) mem.route.shift();
    const next: Point = mem.route[0] ?? goal;
    const len = o.meet ? Math.min(t.travelLeg, Math.max(300, dist(from, goal) / 2)) : t.travelLeg;
    const f = Math.min(1, len / Math.max(1, dist(from, next)));
    const { x, y } = keepOnMap(t.regionId, from, { x: Math.round(from.x + (next.x - from.x) * f), y: Math.round(from.y + (next.y - from.y) * f) });
    mem.leg = { x, y, z: t.zAt({ x, y }) };
    mem.legAt = t.now;
    mem.legFacing = { x: next.x, y: next.y };
}

/** Which way to run from `enemies`: toward home, unless they stand that way (within 60° of it), then straight away from them. */
export function runWay(from: Point, enemies: readonly Point[], home: Point | null): Point & { home: boolean } {
    const unit = (dx: number, dy: number) => { const l = Math.hypot(dx, dy); return l < 1 ? null : { x: dx / l, y: dy / l }; };
    const e = centroid([...enemies]);
    const away = unit(from.x - e.x, from.y - e.y) ?? { x: 1, y: 0 };
    const toHome = home ? unit(home.x - from.x, home.y - from.y) : null;
    return toHome && -(toHome.x * away.x + toHome.y * away.y) < 0.5 ? { ...toHome, home: true } : { ...away, home: false };
}

/** The spot `distance` from `from` along the unit vector `way`, turned by up to 40° to stay out of aggro zones and keep circles, and on the map as a PvE retreat (keepOnMap). */
export function spotAlong(t: Trip, from: Point, way: Point, distance: number): Point3 {
    const blocked = [...aggroZones(t.regionId, t.level), ...t.avoid];
    const base = Math.atan2(way.y, way.x);
    const spots = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05].map(turn => ({ x: Math.round(from.x + Math.cos(base + turn) * distance), y: Math.round(from.y + Math.sin(base + turn) * distance) }));
    // The whole way there clear first: round 7 (20261101-104807) ran Hibernia "toward our portal keep" straight
    // through the perturbed bwca camp between the middle and its keep, and the bwca killed five of its eight dead.
    const pathClear = (p: Point) => { for (let i = 1; i <= 10; i++) if (!clearOf({ x: from.x + (p.x - from.x) * i / 10, y: from.y + (p.y - from.y) * i / 10 }, blocked)) return false; return true; };
    const spot = keepOnMap(t.regionId, from, spots.slice(0, 5).find(pathClear) ?? spots.find(p => clearOf(p, blocked)) ?? spots[0]!);
    return { x: spot.x, y: spot.y, z: t.zAt(spot) };
}

/**
 * The cluster of members where the fight is (round a member an enemy attacks), else the largest
 * one (within `radius` of its best-connected member; ties: the last lead, then the tank), and
 * the rest. Live run 20261101-084333: three members released to the portal keep outnumbered the
 * two still fighting 16k away, so the mezzes went to members who couldn't see the enemies. A
 * cluster under attack needs 2 members, or half of those here: one attacked on its way back from
 * the portal keep fights or flees by itself, and the others stay the main body.
 */
export function mainBody(here: readonly MemberReport[], radius: number, mem: Record<string, any>, attacked: ReadonlySet<string> = new Set()): { main: MemberReport[]; far: MemberReport[] } {
    const size = (m: MemberReport) => here.filter(o => dist(m, o) <= radius).length;
    const hot = (m: MemberReport) => (size(m) >= 2 || size(m) * 2 >= here.length) && here.some(o => attacked.has(o.name) && dist(m, o) <= radius);
    const rank = (m: MemberReport) => (hot(m) ? 100 : 0) + size(m) * 4 + (m.name === mem.gatherLead ? 2 : 0) + (m.role === 'tank' ? 1 : 0);
    const lead = [...here].sort((a, b) => rank(b) - rank(a))[0]!;
    mem.gatherLead = lead.name;
    const main = here.filter(m => dist(m, lead) <= radius);
    return { main, far: here.filter(m => !main.includes(m)) };
}

/** The region most living members are in (ties: the tank's). Members elsewhere were released to their bind point. */
export function groupRegion(alive: readonly MemberReport[]): number {
    const n = new Map<number, number>();
    for (const m of alive) n.set(m.regionId, (n.get(m.regionId) ?? 0) + 1);
    const tankRegion = alive.find(m => m.role === 'tank')?.regionId;
    return [...n].sort((a, b) => b[1] - a[1] || Number(b[0] === tankRegion) - Number(a[0] === tankRegion))[0]![0];
}

export function decideRvr(ctx: CoordinatorContext<RvrSettings>): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, settings: s, now } = ctx;
    if (!p.members.length) return { phase: 'idle', reason: 'no member reports yet' };
    // A shade is nobody here: no focus, no cc, no enemy to count or hunt (AbstractServerRules.cs:449-455). Its servant is a candidate like any enemy pet, and a focus that turns out to be one moves at once.
    const contacts = p.contacts.filter(c => !untouchable(c, now));
    const alive = p.members.filter(m => !m.isDead);
    if (!alive.length) return { phase: 'recover', focus: null, cc: [], puller: null, retreatTo: null, reason: 'everyone is dead: releasing' };
    const regionId = groupRegion(alive);
    const here = alive.filter(m => m.regionId === regionId);
    const missing = p.members.filter(m => m.regionId !== regionId);
    const leader = here.find(m => m.role === 'tank') ?? here[0]!;
    const level = Math.min(...here.map(m => m.level));
    // Everything is measured from the main body: a member walking back from the portal keep is no part of a fight.
    const names0 = new Set(p.members.map(m => m.name));
    // A member whose pet is attacked counts as attacked: the fight is as far off as the pet.
    const attacked = new Set(contacts.filter(c => !c.stale && isAlive(c)).map(onWhom).filter((n): n is string => n !== null && names0.has(n)));
    const { main, far } = mainBody(here, s.gatherRadius, mem, attacked);
    const centre = centroid(main);
    if (!mem.realm || mem.realm === 'none') mem.realm = realmOfGroup(p.members);
    const realm: Realm = mem.realm;
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    const home = homeOf(regionId, realm);
    if (home) mem.base = home.arrival;
    const keeps = keepDangers(regionId, realm, s);
    const zAt = (q: Point) => estimateZ(regionId, q.x, q.y, leader.z, { radius: 8000 });
    const trip: Trip = { mem, now, regionId, level, avoid: keeps, travelLeg: s.travelLeg, zAt };
    const ours = new Set(p.members.map(m => m.name));
    const onUs = (c: Contact) => { const n = onWhom(c); return n !== null && ours.has(n); };
    const inKeep = (c: Point) => !clearOf(c, keeps);
    const enemies = contacts.filter(c => c.kind === 'player' && !c.stale && c.regionId === regionId);
    // The enemy players against us (retreat.margin): two other realms fighting each other are two groups, not one.
    const byId = new Map(enemies.map(c => [c.objectId, c]));
    const busy = (c: Contact) => !onUs(c) && c.targetId !== null && (byId.get(c.targetId)?.realm ?? c.realm) !== c.realm;
    const against = (cs: readonly Contact[]): Contact[] => {
        const free = cs.filter(c => c.kind === 'player' && !c.cc && !busy(c));
        return [...new Set(free.map(c => c.realm))].map(r => free.filter(c => c.realm === r || onUs(c))).sort((a, b) => b.length - a.length)[0] ?? [];
    };
    const outnumbered = (n: number) => s.retreat.enabled && n >= main.length + s.retreat.margin;
    const counted = (big: readonly Contact[], all: readonly Contact[]) => (big.length === all.length ? enemiesText(all.length) : `${big.length} of ${enemiesText(all.length)}`);
    const homeAt = home?.arrival ?? null;
    const gone = missing.length ? `; missing ${missing.map(m => `${m.name} (region ${m.regionId})`).join(', ')}` : '';
    const stay: Point3 = o.anchor ?? { x: Math.round(centre.x), y: Math.round(centre.y), z: zAt(centre) };
    const calm = { focus: null, puller: null, cc: [], retreatTo: null, waiting: [] };

    // ── Who a fight here is with: enemies near the main body (any kind) or attacking one of it ──
    // An enemy attacking a member away from the main body (walking back from the portal keep) counts only
    // near it, like any other: the group comes to meet that member (gather, hunt) instead of sending its
    // casters 15k off after it. Winding down, only enemies already fighting us count. Enemies under enemy
    // keep guards are left alone unless they attack us, which lasts as long as its aim (6 s), and not as long as it is a threat: our own landed nukes keep it that (blackboard.ts hitByUs), and the fight would feed itself.
    // petControl holds the stance through that lapse (underGuards). An enemy pet that is a threat near us is in it whoever it aims at: a caster's target is on nobody's client for stretches.
    const inMain = new Set(main.map(m => m.name));
    const inFight = (c: Contact) => {
        if (c.stale || !isAlive(c) || c.regionId !== regionId) return false;
        const near = dist(c, centre) <= s.engageRadius + (c.threat || c.objectId === o.focus ? FOCUS_SLACK : 0);
        if (onUs(c)) return inMain.has(onWhom(c)!) || near;
        if (c.isPet && c.threat) return near;
        if (c.kind !== 'player' || inKeep(c) || (ctx.windingDown && !c.threat && c.objectId !== o.focus)) return false;
        return near;
    };

    // ── Retreating: keep running while enemies against us follow, on toward home from each point reached ──
    if (o.phase === 'retreat' && o.retreatTo) {
        // Counted as the retreat was (against): two other realms fighting each other near us don't follow us.
        const following = against(enemies.filter(inFight));
        if (following.length && now - (mem.retreatStart ?? now) < s.retreat.maxMs) {
            const to = dist(centre, o.retreatTo) < 600 ? spotAlong(trip, centre, runWay(centre, following, homeAt), s.retreat.distance) : o.retreatTo;
            return { phase: 'retreat', retreatTo: to, anchor: to, reason: o.reason };
        }
        if (outnumbered(following.length)) mem.stand = true;
    }

    // ── Fighting: enemy players near us or on us; monsters only when they attack us and no player is about ──
    const candidates = contacts.filter(inFight);
    const players = candidates.filter(c => c.kind === 'player');
    // Players first, while one is free: with all of them crowd-controlled, a pet on us is what's left to hit (pickRvrFocus takes the free first).
    const pool = players.some(c => !c.cc) ? players : candidates;
    if (pool.length) {
        // The trip is interrupted: it is planned again from wherever the fight ends.
        mem.legKind = null;
        const current = pool.find(c => c.objectId === o.focus && !c.cc) ?? null;
        const big = against(players);
        // Caught (retreat.maxMs): fight it out while they outnumber us. Once they don't, the next outnumbering is a new retreat.
        if (!outnumbered(big.length)) mem.stand = false;
        if (outnumbered(big.length) && !mem.stand && !(current && current.hp < s.retreat.focusHp)) {
            mem.retreatStart = now;
            const way = runWay(centre, big, homeAt);
            const to = spotAlong(trip, centre, way, s.retreat.distance);
            return { ...calm, phase: 'retreat', retreatTo: to, anchor: to, objective: `get away from ${enemiesText(big.length)}${gone}`, reason: `retreat: ${counted(big, players)} vs ${main.length}${way.home ? ', toward our portal keep' : ''}` };
        }
        // The fight's anchor: the centre when it starts, and again once the group drifted FIGHT_DRIFT from it.
        const was: Point = o.phase === 'engage' && mem.fightAnchor && dist(centre, mem.fightAnchor) <= FIGHT_DRIFT ? mem.fightAnchor : centre;
        // Tank and melee chase an enemy player only within chaseLeash of the anchor, and never one under an enemy
        // keep's guards (beyondLeash): one that attacks us from there is answered by the casters only.
        const leash = s.chaseLeash ?? Infinity;
        const reach = (c: Contact) => c.kind !== 'player' || (dist(c, was) <= leash && !inKeep(c));
        const inReach = pool.filter(c => !c.cc && reach(c));
        // Keep the focus (no target thrash) while it is in reach, or while no other free enemy is: a player
        // running off is let go for one standing by the group. Switch to one in reach that is nearly dead while it isn't.
        const kept = current && (reach(current) || !inReach.length) ? current : null;
        const weaker = kept && kept.hp > s.switchBelow + 20 ? inReach.filter(c => c !== kept && c.hp < s.switchBelow).sort((a, b) => a.hp - b.hp)[0] : undefined;
        const focus = weaker ?? kept ?? pickRvrFocus(pool.filter(c => c !== current), { centre, members: here, settings: s, reach })!;
        // A focus beyond the leash moves the anchor toward it, at most FIGHT_DRIFT from the centre (so the next
        // tick keeps it), leaving it LEASH_FIT of the leash away; else tank and melee would stand idle.
        // Never toward one under keep guards, and never into a keep circle.
        let anchor = was;
        if (!reach(focus) && !inKeep(focus)) {
            const d = dist(centre, focus);
            const k = Math.min(FIGHT_DRIFT, Math.max(0, d - leash * LEASH_FIT)) / Math.max(1, d);
            const moved = { x: centre.x + (focus.x - centre.x) * k, y: centre.y + (focus.y - centre.y) * k };
            if (clearOf(moved, keeps)) anchor = moved;
        }
        if (anchor !== mem.fightAnchor) mem.fightAnchor = { x: Math.round(anchor.x), y: Math.round(anchor.y), z: zAt(anchor) };
        // A mezz assignment that hasn't landed in CC_STALL_MS goes to another mezzer: ours may be held itself.
        const since: Record<string, number> = mem.ccSince ?? {};
        const bench: Record<string, number> = mem.ccBench ?? {};
        const ccKey = (a: { targetId: number; by: string }) => `${a.targetId}:${a.by}`;
        for (const a of o.cc) if (now - (since[ccKey(a)] ?? now) > CC_STALL_MS) bench[a.by] = now + CC_BENCH_MS;
        const mezzers = main.filter(m => !((bench[m.name] ?? 0) > now));
        const cc = assignCc(players.filter(c => c.objectId !== focus.objectId && !c.cc), mezzers, o.cc, now);
        mem.ccSince = Object.fromEntries(cc.map(a => [ccKey(a), since[ccKey(a)] ?? now]));
        mem.ccBench = Object.fromEntries(Object.entries(bench).filter(([, until]) => until > now));
        return {
            phase: 'engage', focus: focus.objectId, puller: null, cc, retreatTo: null, waiting: [], anchor: mem.fightAnchor, facing: { x: focus.x, y: focus.y },
            objective: `fight ${players.length ? 'enemy players' : 'monsters'} at ${at(mem.fightAnchor)}${gone}`,
            reason: `${mem.stand ? 'caught: ' : ''}fight ${label(focus)}: ${players.length ? `${counted(big, players)} vs ${main.length}` : `${pool.length} attacking`}`,
        };
    }
    mem.stand = false;

    if (ctx.windingDown) return { ...calm, phase: 'recover', anchor: stay, reason: 'time is up: no more roaming' };

    const deadHere = p.members.filter(m => m.isDead && m.regionId === regionId);
    const low = here.flatMap(m => [
        ...(m.hp < s.ready.hp ? [{ name: m.name, why: 'health' }] : []),
        ...(usesMana(m) && m.mana < s.ready.mana ? [{ name: m.name, why: m.activity.detail === SAVING_POWER ? 'pet power' : 'power' }] : []),
        ...(waitsForPet(m, s.pet) ? [{ name: m.name, why: 'pet' }] : []),
    ]);

    // ── Hunting: enemy players in sight beyond engageRadius. Too many: fall back (toward home unless they stand that way) ──
    const seen = enemies.filter(c => !inKeep(c) && dist(c, centre) <= s.huntRadius);
    if (seen.length) {
        const big = against(seen);
        if (outnumbered(big.length)) {
            const d = Math.round(dist(centre, centroid(big)));
            const way = runWay(centre, big, homeAt);
            const goal = way.home && homeAt ? homeAt : spotAlong(trip, centre, way, s.huntRadius);
            stepLeg(trip, 'fall back', goal, { from: centre, movers: main, replan: way.home ? 1 : 2000 });
            return { ...calm, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, objective: `fall back ${way.home ? 'toward our portal keep' : 'away from them'}${gone}`, reason: `fall back: ${counted(big, seen)} ${d} away vs ${main.length}` };
        }
        const them = centroid(seen);
        const d = Math.round(dist(centre, them));
        const unready = new Set([...deadHere, ...far].map(m => m.name).concat(low.map(w => w.name)));
        if (unready.size <= HUNT_UNREADY) {
            stepLeg(trip, 'hunt', them, { from: centre, movers: main, replan: HUNT_REPLAN });
            return { ...calm, phase: 'travel', anchor: mem.leg, facing: them, objective: `hunt ${enemiesText(seen.length)} round ${at(them)}${gone}`, reason: `hunt ${enemiesText(seen.length)} ${d} away: ${seen.slice(0, 3).map(label).join(', ')}` };
        }
    }

    // ── Regroup: wait for the dead to be rezzed or release, then meet those walking back from the portal keep ──
    if (deadHere.length) return { ...calm, phase: 'recover', anchor: stay, waiting: deadHere.map(m => ({ name: m.name, why: 'dead' })), reason: `waiting for ${names(deadHere)}: a rez or a release${gone}` };
    if (far.length) {
        const them = centroid(far);
        stepLeg(trip, 'gather', them, { from: centre, movers: main, replan: Infinity, meet: true });
        return { ...calm, phase: 'gather', anchor: mem.leg, facing: them, waiting: far.map(m => ({ name: m.name, why: 'away' })), objective: `regroup with ${names(far)}${gone}`, reason: `meeting ${names(far)}, ${Math.round(dist(centre, them))} away` };
    }
    if (low.length) return { ...calm, phase: 'recover', anchor: stay, waiting: low, reason: `waiting for ${low.map(w => `${w.name}'s ${w.why}`).join(', ')} (ready at ${s.ready.hp}% health, ${s.ready.mana}% power)` };

    // ── Patrol: the loop in legs, next waypoint once everyone stands at the leg that ends at this one ──
    const key = `${regionId}:${realm}:${level}`;
    if (!s.patrol && mem.patrolKey !== key) {
        mem.patrol = defaultPatrol(regionId, realm, level, s);
        mem.patrolKey = key;
        mem.wp = undefined;
    }
    const loop: Point3[] = s.patrol ?? mem.patrol;
    if (!loop.length) return { ...calm, phase: 'idle', anchor: stay, reason: `no patrol in region ${regionId} for ${realm}: set settings.patrol` };
    if (mem.wp === undefined || mem.wp >= loop.length) mem.wp = loop.reduce((best: number, w, i) => (dist(w, centre) < dist(loop[best]!, centre) ? i : best), 0);
    let wp = loop[mem.wp]!;
    const arrived = mem.legKind === 'patrol' && !!mem.leg && dist(mem.leg, wp) < 1 && reachedBy(mem.leg, here, now - mem.legAt);
    if (arrived) {
        mem.wp = (mem.wp + 1) % loop.length;
        wp = loop[mem.wp]!;
    }
    stepLeg(trip, 'patrol', wp, { from: centre, movers: here, replan: Infinity, force: arrived });
    mem.camp = { x: wp.x, y: wp.y, z: wp.z, names: `patrol waypoint ${mem.wp + 1}/${loop.length}` };
    return {
        ...calm, phase: 'travel', anchor: mem.leg, facing: mem.legFacing,
        objective: `patrol ${loop.length} waypoints${bg && !s.patrol ? ` round ${bg.name}'s meeting point` : ''}${gone}`,
        reason: `patrol to waypoint ${mem.wp + 1}/${loop.length} ${at(wp)}, ${Math.round(dist(centre, wp))} away`,
    };
}

/** Behaviour lists by role. No healer() visit: battlegrounds have no town healer, and RvR deaths cost no constitution. */
export function rvrBehaviors(): Record<Role, Behavior<TacticsSettings>[]> {
    return {
        tank: [release(), hand(), sprint(), retreat(), rejoinFight(), rez(), song(), tank(), guard(), shedLoad(), holdFormation(), buff(), rest()],
        healer: [release(), sprint(), retreat(), rejoinFight(), heal({ emergencyOnly: true }), flee(), rez(), heal(), crowdControl({ assignedOnly: true }), position(), spareNuke(), shedLoad(), holdFormation(), buff(), rest()],
        support: [release(), sprint(), retreat(), rejoinFight(), heal({ emergencyOnly: true }), flee(), rez(), crowdControl(), heal(), song(), position(), shedLoad(), holdFormation(), buff(), rest()],
        nuker: [release(), sprint(), retreat(), rejoinFight(), flee(), rez(), crowdControl({ assignedOnly: true }), heal({ emergencyOnly: true }), position(), assist(), shedLoad(), holdFormation(), buff(), rest()],
        melee: [release(), hand(), sprint(), retreat(), rejoinFight(), rez(), song(), meleeFight(), shedLoad(), holdFormation(), buff(), rest()],
    };
}

/** Observer rules for RvR runs, from the report's optional RvR totals (absent: 0). */
export function rvrFindings(r: RunReport, s: RvrSettings): Finding[] {
    const out: Finding[] = [];
    const t = r.totals;
    const seen = t.enemiesSeen ?? 0, kills = t.playerKills ?? 0, lost = t.deathsToPlayers ?? 0, fights = t.engagements ?? t.fights;
    const phases = Object.entries(r.phases).map(([k, v]) => `${k} ${v}%`).join(', ');
    if (seen === 0 && r.durationMs > 120_000) {
        out.push({ severity: 'high', topic: 'no-contact', issue: 'No enemy player seen in the whole run', evidence: `phases ${phases}`, suggestion: `Raise huntRadius (${s.huntRadius}), or patrol where the other realms walk (settings.patrol; the default rings the meeting point). Members report enemies within the strategy's agent.sightRadius.` });
    }
    if (t.retreats >= 3 && t.retreats * 2 >= Math.max(1, fights)) {
        out.push({ severity: 'medium', topic: 'outnumbered', issue: `The group retreated ${t.retreats}× in ${fights} fights`, evidence: r.timeline.filter(l => l.includes('retreat')).slice(-3).join(' | '), suggestion: `Raise retreat.margin (${s.retreat.margin}) to take more uneven fights, or lower huntRadius (${s.huntRadius}) so the group walks into fewer large groups.` });
    }
    if (lost >= 3 && lost >= 2 * Math.max(1, kills)) {
        const killers: Record<string, number> = {};
        for (const m of Object.values(r.members)) for (const [k, v] of Object.entries(m.killedBy ?? {})) killers[k] = (killers[k] ?? 0) + v;
        const by = Object.entries(killers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
        out.push({ severity: 'high', topic: 'trades', issue: `${lost} members died to players for ${kills} player kills`, evidence: by ? `killed by ${by}` : `${fights} fights`, suggestion: `Kill faster: switch to the weakest sooner (switchBelow ${s.switchBelow}), keep the other enemies mezzed (crowd control assignments), and retreat earlier (retreat.margin ${s.retreat.margin}, retreat.focusHp ${s.retreat.focusHp}).` });
    }
    const cap = BATTLEGROUND_LAYOUTS[THIDRANKI]!.levels[1];
    for (const [name, m] of Object.entries(r.members)) {
        const lvl = Number(String(m.level).split('→').at(-1));
        if (lvl >= cap) out.push({ severity: 'high', topic: 'level', member: name, issue: `${name} is level ${lvl}`, evidence: `level ${m.level} this run; Thidranki takes levels ${BATTLEGROUND_LAYOUTS[THIDRANKI]!.levels.join('-')}`, suggestion: `At ${cap + 1} the server moves a member out of the battleground at its next logout, and it can't come back (GamePlayer.CleanupOnDisconnect): stop the run for it, or lower xp_rate.` });
    }
    return out;
}

export const rvrRoaming: GroupStrategy<RvrSettings> = {
    name: 'rvr-roam',
    description: 'Battleground roaming: patrol a loop round the meeting point, fight enemy players, hunt groups no larger than ours, fall back toward the portal keep when outnumbered, regroup after releases.',
    settings: RVR_SETTINGS,
    behaviors: rvrBehaviors(),
    decide: decideRvr,
    findings: rvrFindings,
    // Players move fast and fights are short: forget them sooner, stay hostile through a gap in their swings.
    board: { staleAfterMs: 4000, forgetAfterMs: 30_000, hostileMs: 6000 },
    agent: { sightRadius: 5000 },
};
