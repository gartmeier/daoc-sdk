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
import { BATTLEGROUND_LAYOUTS, clearOf, homeOf, KEEP_CLEARANCE, keepDangers, pairMeet, THIDRANKI, type KeepSettings, type PlayerRealm } from './keeps';
import { aggroZones, keepOnMap, safePath, type Danger } from './terrain';
import { isLevel } from './slope';
import { drySpot, isDry, isWet, staysDry, waitAshore } from './water';
import { ONWARD_MIN } from './travel';
import { countFor, describeCount, groupSize, TUNED_SIZE, type Count } from './size';
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
         * A share of the group's size by default (size.ts): 3 at five, 5 at eight; a number is that number.
         */
        margin: Count;
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
    /**
     * A pair round against this realm only: the patrol rings the spot where the two meet (BattlegroundLayout.pairs) instead
     * of the meeting point, the two going round opposite ways. Both groups need it; the third stays out of the battleground.
     */
    opponent?: PlayerRealm | null;
    /**
     * Stop only on dry ground (water.ts drySpot): patrol waypoints, legs, the fight's anchor, retreat spots. Swimming is 85
     * against 191, so a fight in a river was won by whoever stood and cast. Crossing a river on the way stays allowed. Off: as before.
     */
    stayDry?: boolean;
    /** Choose the focus as the pack does (pickPackFocus: near, soft, a known healer last) and give up one a healer is winning. Off: pickRvrFocus. */
    softFocus?: SoftFocus;
}

/**
 * Monsters fighting us in a fight with players: a camp the fight came near. They get mezzed like the players and are killed
 * when they wake, after them. `first`: those on one of our healers or supports, which interrupt the heals (round 1 of the pair
 * rounds, 2026-11-08: black wolves cut ~15 heals in two minutes and killed three); they go before the players. `last`: the
 * rest, after them. Not a player's pet, not the focus, not one controlled already; nearest-dying order is the caller's.
 */
export function monsterAdds(candidates: readonly Contact[], focusId: number | null, members: readonly MemberReport[]): { first: Contact[]; last: Contact[] } {
    const soft = new Set(members.filter(m => m.role === 'healer' || m.role === 'support').map(m => m.name));
    const beasts = candidates.filter(c => c.kind !== 'player' && !c.isPet && c.objectId !== focusId && !c.cc && !c.stale && isAlive(c) && onWhom(c) !== null && members.some(m => m.name === onWhom(c)));
    return { first: beasts.filter(c => soft.has(onWhom(c)!)), last: beasts.filter(c => !soft.has(onWhom(c)!)) };
}

export { staysDry };

export interface SoftFocus {
    /** What a cast reaches: the nearer an enemy within it, the better. */
    reach: number;
    /** Give up a focus whose health climbs this much above the lowest we had it at ... */
    healedBy: number;
    /** ... and leave it alone for this long. */
    droppedMs: number;
}

export const RVR_SETTINGS: RvrSettings = {
    // Hold times apply to monsters only: no tank holds an enemy player (assist hits those at once).
    holdMs: 1500,
    assistAfterMs: 6000,
    // Players hit harder and in bursts: heal earlier than in PvE.
    heal: { tank: 75, other: 70, emergency: 40, outOfCombat: 90 },
    // An RvR death costs no XP or constitution, and a release gives full health and power: a rez saves only the walk
    // back, about 100 s. So the rezzer pays only from what it has, keeping a reserve, and may do it mid-fight when the group can spare it.
    // Nobody releases until the fight is over (user): one released mid-fight walks back from the portal keep alone into it.
    // fightHoldMs only caps a fight that never seems to end; the rez wait (holdMs) starts when it does.
    rez: { holdMs: 60_000, sit: false, reserve: 25, inFight: true, fightHoldMs: 300_000 },
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
    // Tuned for five (3 of 5): a share of the size now, 3 at five (size.ts).
    retreat: { enabled: true, margin: { share: 0.6 }, focusHp: 25, distance: 3000, maxMs: 20_000 },
    switchBelow: 25,
    ready: { hp: 75, mana: 50 },
    gatherRadius: 2500,
    travelLeg: 1500,
    patrol: null,
    opponent: null,
    stayDry: true,
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
/** A pair round's patrol: a smaller ring round the pair's spot (on one realm's bank, keeps.ts), so the two meet within a minute or so. */
const PAIR_RADIUS = 4000;
/** Each waypoint stays this far outside aggro zones and keep circles: casters stand up to ~700 behind the anchor. */
const PATROL_MARGIN = 900;
/**
 * ... and from monster camps on a pair's ring, where the fights are: members stand up to ~1000 from a waypoint in a fight
 * and chase farther. Arena round 71 (2026-11-10): Hibernia and Midgard fought at Midgard's west waypoint (30007, 25197),
 * 1450 outside the perturbed bwca camp's aggro circle, a bwca came in and killed Hibernia's Hero (Hibernia group session).
 */
const PAIR_CAMP_MARGIN = 1500;
/** Where an unsafe waypoint is tried next: [radius change, angle change in radians]. */
const NUDGES: [number, number][] = [[0, 0], [-500, 0], [500, 0], [-1000, 0], [1000, 0], [0, 0.15], [0, -0.15], [-1000, 0.15], [-1000, -0.15],
    // Wider, for a waypoint on a river where the three meet by the Faste (stayDry): last, so no earlier waypoint moves.
    [0, 0.3], [0, -0.3], [-1000, 0.3], [-1000, -0.3], [1000, 0.3], [1000, -0.3], [-1500, 0.3], [-1500, -0.3]];
/**
 * Which way each realm goes round (+1: increasing angle). Midgard and Albion start ~100° apart
 * on the ring and close that gap head-on; Hibernia comes round behind Albion.
 */
const PATROL_TURN: Record<PlayerRealm, 1 | -1> = { albion: -1, midgard: 1, hibernia: -1 };

/**
 * A loop of waypoints on a ring round the battleground's meeting point, starting at the one
 * nearest our arrival point. Each is nudged out of aggro zones and keep circles (PATROL_MARGIN),
 * and with stayDry out of water, and onto level ground (slope.ts isLevel: the members stand round it), or dropped when nothing near it is safe. With an opponent, the
 * ring is the pair's (PAIR_RADIUS round BattlegroundLayout.pairs), and the realm first in the
 * alphabet goes round by increasing angle, the other the other way. Empty outside a known battleground.
 */
/** The ring the default patrol goes round: the pair's spot (PAIR_RADIUS) against an opponent, else the meeting point (PATROL_RADIUS); null outside a known battleground. */
export function patrolRing(regionId: number, realm: Realm, opponent?: PlayerRealm | null): (Point & { r: number; pair: boolean }) | null {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    if (!bg || realm === 'none') return null;
    const pair = opponent && opponent !== realm ? pairMeet(regionId, realm, opponent) : null;
    return pair ? { x: pair.x, y: pair.y, r: PAIR_RADIUS, pair: true } : { x: bg.meet.x, y: bg.meet.y, r: PATROL_RADIUS, pair: false };
}

export function defaultPatrol(regionId: number, realm: Realm, level: number, settings: Partial<KeepSettings & Pick<RvrSettings, 'opponent' | 'stayDry'>> = {}): Point3[] {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    const home = homeOf(regionId, realm);
    const ring = patrolRing(regionId, realm, settings.opponent);
    if (!bg || !home || !ring) return [];
    const camps = aggroZones(regionId, level), keeps = keepDangers(regionId, realm, settings);
    const dry = staysDry(settings);
    const { opponent } = settings;
    const pair = ring.pair;
    const campMargin = pair ? PAIR_CAMP_MARGIN : PATROL_MARGIN;
    const centre: Point = ring;
    const radius = ring.r;
    const turn = pair ? (realm < opponent! ? 1 : -1) : PATROL_TURN[realm as PlayerRealm];
    const a0 = Math.atan2(home.arrival.y - centre.y, home.arrival.x - centre.x);
    const out: Point3[] = [];
    for (let k = 0; k < PATROL_POINTS; k++) {
        const a = a0 + turn * k * 2 * Math.PI / PATROL_POINTS;
        const spot = NUDGES
            .map(([dr, da]) => ({ x: Math.round(centre.x + Math.cos(a + da) * (radius + dr)), y: Math.round(centre.y + Math.sin(a + da) * (radius + dr)) }))
            .find(p => clearOf(p, camps, campMargin) && clearOf(p, keeps, PATROL_MARGIN) && (!dry || isDry(regionId, p)) && isLevel(regionId, p));
        if (spot) out.push({ ...spot, z: estimateZ(regionId, spot.x, spot.y, bg.meet.z, { radius: 8000 }) });
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

/**
 * Who the damage goes on: the nearest free enemy, a known caster ahead of a fighter, nearly dead ones first. A known
 * healer only when nothing else is in reach: healers wear chain and heal themselves, and in round 9 Troll#438 stayed
 * the focus for 5 minutes while its health went back up. They get the mezz instead (packCc). With `soft`, the other way round.
 */
export function pickPackFocus(pool: readonly Contact[], centre: Point, reach: number, soft = false): Contact | null {
    // soft (pack.focusSoft): the back line first, as human groups did (casters, then healers, research 2026-11-09), and
    // never one in melee with us while another is in reach: that is the tank's, and the nearest is usually their tank.
    const role = (c: Contact) => !soft ? (c.healer ? -200 : 0) + (c.caster ? 30 : 0)
        : c.caster && !c.healer ? 100 : c.healer ? 60 : c.target !== null && !c.targetBySpell ? -50 : 0;
    const score = (c: Contact) => role(c) + (100 - c.hp) * 0.3 + (c.hp < 25 ? 40 : 0) + Math.max(0, 1 - dist(c, centre) / reach) * 40;
    return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * Whether to give up the focus: its health climbed this much above the lowest we had it at, so a healer is out-healing
 * us. s11: Troll#437 went 36, 11, 46, 92, while five members died round it. Remembers the lowest per target in `seen`.
 */
export function focusHealed(seen: Record<number, number>, focus: Pick<Contact, 'objectId' | 'hp'>, healedBy: number): boolean {
    const low = Math.min(seen[focus.objectId] ?? 100, focus.hp);
    seen[focus.objectId] = low;
    return focus.hp - low >= healedBy;
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
/** A mezzer walking to its target (crowdControl, in steps) has that time from its last step: a tick with this much to show for it. A walk used to be one turn, and landed (r8on Rbspi: +2 to +17). Held, it stands, and the time runs as ever ... */
const CC_WALK_MOVED = 20;
/** ... and this long after the assignment even a walker's time runs: a target it doesn't catch. */
const CC_WALK_MS = 30_000;
/** Hunting goes on with at most this many members not ready (dead, away, hurt or low on power). */
const HUNT_UNREADY = 1;
/** A hunt is re-planned from the group's centre once the enemies' centre moved this far. */
const HUNT_REPLAN = 800;
/** Members within this of a leg have reached it (casters stand ~700 behind the anchor). */
const LEG_REACHED = 1200;
/** After this long, a leg counts as reached with one member still short of it (stuck or lagging). */
const LEG_TIMEOUT_MS = 30_000;
/**
 * ... or with everyone within this of it: they came up and stand in their slots, and a spread formation's stand farther
 * off than LEG_REACHED (Camelot's support 1100 straight back, its nukers 900 at ±0.4). Field mode, 2026-11-11: Albion's
 * patrol stood 10 minutes 1000 short of a waypoint, with Merlin 1417 and Morgana 1307 off the leg and all of them idle.
 */
const LEG_SLOTS = 1800;

export interface Trip {
    mem: Record<string, any>;
    now: number;
    regionId: number;
    level: number;
    /** Keep circles a route stays out of (keepDangers). */
    avoid: Danger[];
    travelLeg: number;
    zAt(p: Point): number;
    /** Legs and run spots end on dry ground (settings.stayDry). */
    dry?: boolean;
}

/**
 * With stayDry, a leg isn't reached while a member still swims, nor does a new trip replace it (stepLeg), for up to this
 * long after it was set: a crossing of ~2500 at 85 takes 30 s. User, live 2026-11-09: Albion's tank and a caster came out
 * of the river, the leg counted as reached (within LEG_REACHED), a hunt planned on from the bank, and they ran on at 250
 * while Merlin, Nimue and Morgana still swam at 111.
 */
const LEG_SWIM_MS = 60_000;
/**
 * ... counting only a swimmer farther than this from the leg: one nearer is about in its slot. Live, 23:37-23:44: a leg
 * along the south bank of the Faste's moat put Morgana's slot in the water 700 off it, and the group stood 60 s at every leg.
 */
const SWIM_HOLD = 900;
/** A travel leg keeps this far from water (water.ts drySpot), so the slots round it, up to 700 off, stay dry. */
const LEG_DRY_MARGIN = 800;

function reachedBy(leg: Point, movers: readonly Point[], ageMs: number, swimming = 0): boolean {
    if (swimming && ageMs < LEG_SWIM_MS) return false;
    const short = movers.filter(m => dist(m, leg) >= LEG_REACHED).length;
    return short === 0 || (ageMs > LEG_TIMEOUT_MS && (short <= 1 || movers.every(m => dist(m, leg) < LEG_SLOTS)));
}

/**
 * The leg in force toward `goal`: kept until `movers` reached it, then the next one, chained from
 * it along a route round aggro zones and keep circles (safePath). A new kind of trip, or a goal
 * that moved more than `replan`, starts over from `from`. With `meet`, a leg covers at most half
 * the gap (the other side walks toward us). With t.dry, nobody goes on while a mover still swims (LEG_SWIM_MS).
 * Writes memory.leg, legFacing and route (the viewer draws them).
 */
export function stepLeg(t: Trip, kind: string, goal: Point, o: { from: Point; movers: readonly Point[]; replan: number; meet?: boolean; force?: boolean }): void {
    const { mem } = t;
    // Members still swimming: the dry leg in force (the far bank) stays, whatever the trip, until they are out (LEG_SWIM_MS).
    const swimming = t.dry && mem.leg ? o.movers.filter(m => isWet(t.regionId, m) && dist(m, mem.leg) > SWIM_HOLD).length : 0;
    if (!o.force && swimming && mem.leg && !isWet(t.regionId, mem.leg) && t.now - (mem.legAt ?? t.now) < LEG_SWIM_MS) return;
    if (mem.legKind !== kind || !mem.goal || dist(mem.goal, goal) > o.replan) {
        mem.legKind = kind;
        mem.leg = null;
        mem.legOnward = null;
        mem.route = null;
    }
    if (!o.force && mem.leg && !reachedBy(mem.leg, o.movers, t.now - mem.legAt, swimming)) return;
    const from: Point = mem.leg ?? o.from;
    if (!mem.route || dist(mem.goal, goal) > 1) {
        mem.route = safePath(t.regionId, t.level, from, goal, t.avoid);
        mem.goal = { x: Math.round(goal.x), y: Math.round(goal.y) };
    }
    while (mem.route.length > 1 && dist(from, mem.route[0]) < 300) mem.route.shift();
    const next: Point = mem.route[0] ?? goal;
    const len = o.meet ? Math.min(t.travelLeg, Math.max(300, dist(from, goal) / 2)) : t.travelLeg;
    const f = Math.min(1, len / Math.max(1, dist(from, next)));
    let leg: Point = keepOnMap(t.regionId, from, { x: Math.round(from.x + (next.x - from.x) * f), y: Math.round(from.y + (next.y - from.y) * f) });
    if (t.dry) {
        // A leg in a river is the far bank (the nearest dry spot that gets us nearer the goal, toward the next route point),
        // and the route points of the crossing are behind it then. No such bank: the leg stays where it is.
        const ahead = dist(from, goal);
        // isDry looks north, south, east and west: the diagonals too, or a bend of the river comes within 600 of a slot.
        const diagonal = (q: Point) => [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([dx, dy]) => !isWet(t.regionId, { x: q.x + dx! * LEG_DRY_MARGIN * Math.SQRT1_2, y: q.y + dy! * LEG_DRY_MARGIN * Math.SQRT1_2 }));
        const bank = drySpot(t.regionId, leg, { margin: LEG_DRY_MARGIN, toward: next, ok: q => clearOf(q, t.avoid) && dist(q, goal) < ahead && diagonal(q) });
        if (bank !== leg) {
            leg = bank;
            const route: Point[] = mem.route;
            const passed = route.reduce((best, q, k) => (dist(q, bank) < dist(route[best]!, bank) ? k : best), 0);
            route.splice(0, Math.min(passed + 1, route.length - 1));
        }
    }
    const { x, y } = leg;
    mem.leg = { x, y, z: t.zAt({ x, y }) };
    mem.legAt = t.now;
    // Facing on along the route: after a crossing's bank moved the leg, `next` lies behind it in the river.
    const on: Point = (mem.route as Point[]).find(q => dist(q, leg) > 300) ?? goal;
    mem.legFacing = { x: on.x, y: on.y };
    // Where the trip goes on after this leg (travel.ts): nowhere on its last, where the leg is the goal.
    mem.legOnward = dist(leg, on) >= ONWARD_MIN ? { x: Math.round(on.x), y: Math.round(on.y) } : null;
}

/** The leg in force as an order's anchor, with where the trip goes on after it (Orders.anchor.onward); null with no leg. */
export function legAnchor(mem: Record<string, any>): (Point3 & { onward?: Point | null }) | null {
    if (!mem.leg) return null;
    return mem.legOnward ? { ...mem.leg, onward: mem.legOnward } : mem.leg;
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
    // With t.dry, a spot on dry ground first, and one in water moved to the nearest bank, the one on our side by preference.
    const dryEnd = (p: Point) => !t.dry || isDry(t.regionId, p);
    const near = spots.slice(0, 5);
    const picked = keepOnMap(t.regionId, from, near.find(p => pathClear(p) && dryEnd(p)) ?? near.find(pathClear) ?? spots.find(p => clearOf(p, blocked)) ?? spots[0]!);
    const spot = t.dry ? drySpot(t.regionId, picked, { toward: from, ok: q => clearOf(q, blocked) }) : picked;
    return { x: spot.x, y: spot.y, z: t.zAt(spot) };
}

/**
 * In a pair round a group within its ring's radius plus this of the pair's spot is at the ring. Away from it, it sets out
 * with one member short of power, and doesn't wait for members away from it (released at home: they walk out to it);
 * at the ring it rests for them (decideRvr). Orchestrator, 2026-11-09: rounds lost minutes regrouping before the first fight.
 */
const AT_RING = 1500;

/** A group within a keep's circle plus this, in combat with nothing on the board on it, is under that keep's guards (decideRvr). */
const GUARD_REACH = 1500;

/** rvrFindings' contact finding: the first fight with players this late in a pair round, or this long without one. */
const SLOW_FIRST_FIGHT_S = 240, SLOW_QUIET_S = 300;

/** A tank this many cluster radii from every other member is walking back from a release, as in PvE (pve.ts tankIsFar). */
const FAR_TANK_RADII = 4;

/** That tank, if he is. No base to go by here. */
function farTank(here: readonly MemberReport[], radius: number): MemberReport | undefined {
    const tank = here.find(m => m.role === 'tank');
    return tank && here.length > 1 && here.every(m => m === tank || dist(m, tank) > radius * FAR_TANK_RADII) ? tank : undefined;
}

/**
 * The cluster of members where the fight is (round a member an enemy attacks), else the largest
 * one (within `radius` of its best-connected member; ties: the last lead, then the tank, unless he is
 * the far one: then the group's centre and its legs would stand at his release), and
 * the rest. Live run 20261101-084333: three members released to the portal keep outnumbered the
 * two still fighting 16k away, so the mezzes went to members who couldn't see the enemies. A
 * cluster under attack needs 2 members, or half of those here: one attacked on its way back from
 * the portal keep fights or flees by itself, and the others stay the main body.
 */
export function mainBody(here: readonly MemberReport[], radius: number, mem: Record<string, any>, attacked: ReadonlySet<string> = new Set()): { main: MemberReport[]; far: MemberReport[] } {
    const size = (m: MemberReport) => here.filter(o => dist(m, o) <= radius).length;
    const hot = (m: MemberReport) => (size(m) >= 2 || size(m) * 2 >= here.length) && here.some(o => attacked.has(o.name) && dist(m, o) <= radius);
    const gone = farTank(here, radius);
    const rank = (m: MemberReport) => (hot(m) ? 100 : 0) + size(m) * 4 + (m !== gone && m.name === mem.gatherLead ? 2 : 0) + (m === gone ? -1 : m.role === 'tank' ? 1 : 0);
    const lead = [...here].sort((a, b) => rank(b) - rank(a))[0]!;
    mem.gatherLead = lead.name;
    const main = here.filter(m => dist(m, lead) <= radius);
    return { main, far: here.filter(m => !main.includes(m)) };
}

/** A gather for an observed member ends once the group's bots stand within this share of the gather radius of it. */
export const OBSERVED_GATHER_CLOSE = 0.5;

/**
 * mainBody's split with observed members (observed.ts: a human) held far until met. A bot that is far walks to the
 * meeting point, but a human may stand still. With only the gather radius as the line, the group flipped between
 * gather and patrol every second while a still human stood just past it. Gathering walked the group inside the radius,
 * so it patrolled; patrolling walked it out again. That happened 60 times in 2.5 minutes in the live run of
 * 2026-11-11 18:41, with Galahad standing at the portal keep 2700 away.
 * Once a gather for one starts (`mem.gatherObserved`), it stays far until the bots' centre is within
 * OBSERVED_GATHER_CLOSE of the radius of it. With no observed member, this returns the split unchanged and leaves the memory alone.
 */
export function holdObservedFar(split: { main: MemberReport[]; far: MemberReport[] }, radius: number, mem: Record<string, any>): { main: MemberReport[]; far: MemberReport[] } {
    if (!split.far.some(m => m.observed) && !(mem.gatherObserved?.length && split.main.some(m => m.observed))) {
        if (mem.gatherObserved) delete mem.gatherObserved;
        return split;
    }
    const was = new Set<string>(mem.gatherObserved ?? []);
    const bots = split.main.filter(m => !m.observed);
    const at = bots.length ? centroid(bots) : null;
    const still = at ? split.main.filter(m => m.observed && was.has(m.name) && dist(m, at) > radius * OBSERVED_GATHER_CLOSE) : [];
    const far = [...split.far, ...still];
    const pending = far.filter(m => m.observed).map(m => m.name);
    if (pending.length) mem.gatherObserved = pending; else delete mem.gatherObserved;
    return { main: split.main.filter(m => !still.includes(m)), far };
}

/** The region most living members are in (ties: the tank's). Members elsewhere were released to their bind point. */
export function groupRegion(alive: readonly MemberReport[]): number {
    const n = new Map<number, number>();
    for (const m of alive) n.set(m.regionId, (n.get(m.regionId) ?? 0) + 1);
    const tankRegion = alive.find(m => m.role === 'tank')?.regionId;
    return [...n].sort((a, b) => b[1] - a[1] || Number(b[0] === tankRegion) - Number(a[0] === tankRegion))[0]![0];
}

/** A focus with its health frozen this long is taken for a phantom ... */
export const RVR_FROZEN_MS = 20_000;
/** ... and left out of the fight for this long. */
export const RVR_PHANTOM_MS = 120_000;

/**
 * Notes a phantom focus in `mem.rvrPhantoms` (id → until): one whose health hasn't moved for RVR_FROZEN_MS while we were on it.
 * Arena round 33 (2026-11-10): Camelot engaged Norseman#496, left over from the round before, for 70 s with nobody seeing
 * him ("focus not in view, holding ground" 69 times, "disappeared at 100% health"; Albion group session). The pack has its own.
 */
export function rvrPhantom(mem: Record<string, any>, contacts: readonly Contact[], focusId: number | null, now: number): void {
    mem.rvrPhantoms ??= {};
    for (const [id, until] of Object.entries(mem.rvrPhantoms) as [string, number][]) if (until <= now) delete mem.rvrPhantoms[id];
    const focus = focusId === null ? undefined : contacts.find(c => c.objectId === focusId);
    if (!focus) { mem.rvrFrozen = undefined; return; }
    const f = mem.rvrFrozen;
    if (f?.id !== focus.objectId || f.hp !== focus.hp) mem.rvrFrozen = { id: focus.objectId, hp: focus.hp, since: now };
    else if (now - f.since >= RVR_FROZEN_MS) { mem.rvrPhantoms[focus.objectId] = now + RVR_PHANTOM_MS; mem.rvrFrozen = undefined; }
}

export function decideRvr(ctx: CoordinatorContext<RvrSettings>): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, settings: s, now } = ctx;
    if (!p.members.length) return { phase: 'idle', reason: 'no member reports yet' };
    // A shade is nobody here: no focus, no cc, no enemy to count or hunt (AbstractServerRules.cs:449-455). Its servant is a candidate like any enemy pet, and a focus that turns out to be one moves at once.
    // A focus whose health stands still that long is a phantom, left alone a while (rvrPhantom), as the pack does.
    rvrPhantom(mem, p.contacts, o.phase === 'engage' ? o.focus : null, now);
    const contacts = p.contacts.filter(c => !untouchable(c, now) && !((mem.rvrPhantoms?.[c.objectId] ?? 0) > now));
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
    const { main, far } = holdObservedFar(mainBody(here, s.gatherRadius, mem, attacked), s.gatherRadius, mem);
    const centre = centroid(main);
    if (!mem.realm || mem.realm === 'none') mem.realm = realmOfGroup(p.members);
    const realm: Realm = mem.realm;
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    const home = homeOf(regionId, realm);
    if (home) mem.base = home.arrival;
    const keeps = keepDangers(regionId, realm, s);
    const zAt = (q: Point) => estimateZ(regionId, q.x, q.y, leader.z, { radius: 8000 });
    const dry = staysDry(s);
    const trip: Trip = { mem, now, regionId, level, avoid: keeps, travelLeg: s.travelLeg, zAt, dry };
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
    const margin = countFor(s.retreat.margin, groupSize(mem, p.members));
    const outnumbered = (n: number) => s.retreat.enabled && n >= main.length + margin;
    const counted = (big: readonly Contact[], all: readonly Contact[]) => (big.length === all.length ? enemiesText(all.length) : `${big.length} of ${enemiesText(all.length)}`);
    const homeAt = home?.arrival ?? null;
    const gone = missing.length ? `; missing ${missing.map(m => `${m.name} (region ${m.regionId})`).join(', ')}` : '';
    // Waiting where the group stands: on the nearest bank when that is in a river.
    const standHere = (): Point3 => {
        const q = dry ? drySpot(regionId, centre, { toward: centre, ok: c => clearOf(c, keeps) }) : centre;
        return { x: Math.round(q.x), y: Math.round(q.y), z: zAt(q) };
    };
    // Without the last leg's way on (Orders.anchor.onward): standing here goes nowhere.
    const stay: Point3 = o.anchor ? { x: o.anchor.x, y: o.anchor.y, z: o.anchor.z } : standHere();
    const calm = { focus: null, puller: null, cc: [], retreatTo: null, waiting: [] };

    // ── Who a fight here is with: enemies near the main body (any kind) or attacking one of it ──
    // An enemy attacking a member away from the main body (walking back from the portal keep) counts only
    // near it, like any other: the group comes to meet that member (gather, hunt) instead of sending its
    // casters 15k off after it. Winding down, only enemies already fighting us count. Enemies under enemy
    // keep guards are left alone unless they attack us, which lasts as long as its aim (6 s), and not as long as it is a threat: our own landed nukes keep it that (blackboard.ts hitByUs), and the fight would feed itself.
    // petControl holds the stance through that lapse (underGuards). An enemy pet that is a threat near us is in it whoever it aims at: a caster's target is on nobody's client for stretches.
    const inMain = new Set(main.map(m => m.name));
    const swimming = (c: Contact) => dry && isWet(regionId, c);
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
    // With stayDry, a player swimming that isn't on us is no focus, mezz or reason to fight until it is ashore, as in the pack;
    // it still counts against us (retreat, outnumbered). The hunt waits for it on dry ground (waitAshore).
    const ashore = candidates.filter(c => !(c.kind === 'player' && swimming(c) && !onUs(c)));
    const fighters = ashore.filter(c => c.kind === 'player');
    // Players first, while one is free: with all of them crowd-controlled, a pet on us is what's left to hit (pickRvrFocus takes the free first).
    const pool = fighters.some(c => !c.cc) ? fighters : ashore;
    if (pool.length) {
        // The trip is interrupted: it is planned again from wherever the fight ends.
        mem.legKind = null;
        const soft = s.softFocus;
        // A healer winning: give the focus up, and leave that target alone a while.
        const lowHp: Record<number, number> = mem.lowHp ??= {};
        const dropped: Record<number, number> = mem.dropped ??= {};
        for (const [id, until] of Object.entries(dropped)) if (until <= now) { delete dropped[+id]; delete lowHp[+id]; }
        // A crowd-controlled focus stays only while nothing is free: then it was chosen to be broken (ccHolds lets the members at it), and a new pick
        // each tick could flip between two of them, as the group moves, before the first blow lands. Once hit it is free and held as any.
        const held = pool.find(c => c.objectId === o.focus && (!c.cc || !pool.some(x => !x.cc))) ?? null;
        if (soft && held && focusHealed(lowHp, held, soft.healedBy)) dropped[held.objectId] = now + soft.droppedMs;
        const current = held && !dropped[held.objectId] ? held : null;
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
        const others = pool.filter(c => c !== current);
        const open = others.filter(c => !c.cc);
        const fresh = open.filter(c => !dropped[c.objectId]);
        const focus = weaker ?? kept ?? (soft ? pickPackFocus(fresh.length ? fresh : open.length ? open : others, centre, soft.reach) : pickRvrFocus(others, { centre, members: here, settings: s, reach }))!;
        // A focus beyond the leash moves the anchor toward it, at most FIGHT_DRIFT from the centre (so the next
        // tick keeps it), leaving it LEASH_FIT of the leash away; else tank and melee would stand idle.
        // Never toward one under keep guards, and never into a keep circle.
        let anchor = was;
        if (!reach(focus) && !inKeep(focus)) {
            const d = dist(centre, focus);
            const k = Math.min(FIGHT_DRIFT, Math.max(0, d - leash * LEASH_FIT)) / Math.max(1, d);
            const moved = { x: centre.x + (focus.x - centre.x) * k, y: centre.y + (focus.y - centre.y) * k };
            // Nor into a monster camp: round 1 of the pair rounds (2026-11-08) followed its focus into black wolves, which killed three.
            if (clearOf(moved, keeps) && clearOf(moved, aggroZones(regionId, level))) anchor = moved;
        }
        // A new anchor in a river goes to the nearest bank, so the fight stands on land: an enemy in the water swims to us.
        if (anchor !== mem.fightAnchor) {
            const spot = dry ? drySpot(regionId, anchor, { toward: centre, ok: q => clearOf(q, keeps) }) : anchor;
            mem.fightAnchor = { x: Math.round(spot.x), y: Math.round(spot.y), z: zAt(spot) };
        }
        // A mezz assignment that hasn't landed in CC_STALL_MS goes to another mezzer: ours may be held itself.
        const since: Record<string, number> = mem.ccSince ?? {};
        const bench: Record<string, number> = mem.ccBench ?? {};
        const walks: Record<string, { x: number; y: number; from: number }> = mem.ccWalks ?? {};
        const ccKey = (a: { targetId: number; by: string }) => `${a.targetId}:${a.by}`;
        const walker = (a: { targetId: number; by: string }) => here.find(m => m.name === a.by && m.activity.kind === 'move' && m.activity.targetId === a.targetId);
        for (const a of o.cc) {
            const k = ccKey(a), m = walker(a), was = walks[k];
            if (m && was && dist(m, was) >= CC_WALK_MOVED && now - was.from <= CC_WALK_MS) since[k] = now;
            if (now - (since[k] ?? now) > CC_STALL_MS) bench[a.by] = now + CC_BENCH_MS;
        }
        // With softFocus healers aren't damaged, so they get the mezz first, then known casters.
        const ccRank = (c: Contact) => (soft ? (c.healer ? 0 : c.caster ? 1 : 2) : 0);
        // Monsters on us join the mezz list (monsterAdds): those on a healer or support before the players, the rest after.
        const beasts = monsterAdds(candidates, focus.objectId, here);
        const adds = [...beasts.first, ...fighters.filter(c => c.objectId !== focus.objectId && !c.cc).sort((x, y) => ccRank(x) - ccRank(y)), ...beasts.last];
        // That walk can take one past the cluster's radius, and the main body is no reason to drop it there.
        const onTheWay = here.filter(m => !main.includes(m) && o.cc.some(a => walker(a) === m && adds.some(c => c.objectId === a.targetId)));
        const mezzers = [...main, ...onTheWay].filter(m => !((bench[m.name] ?? 0) > now));
        const cc = assignCc(adds, mezzers, o.cc, now);
        mem.ccSince = Object.fromEntries(cc.map(a => [ccKey(a), since[ccKey(a)] ?? now]));
        mem.ccWalks = Object.fromEntries(cc.map(a => {
            const m = here.find(x => x.name === a.by);
            return [ccKey(a), { x: m?.x ?? 0, y: m?.y ?? 0, from: walks[ccKey(a)]?.from ?? now }];
        }));
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
            return { ...calm, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: `fall back ${way.home ? 'toward our portal keep' : 'away from them'}${gone}`, reason: `fall back: ${counted(big, seen)} ${d} away vs ${main.length}` };
        }
        // With stayDry, those swimming aren't hunted into the river: with only such in sight, the group waits on dry ground for them (waitAshore).
        const ashore = seen.filter(c => !swimming(c));
        const wet = seen.length - ashore.length;
        if (!ashore.length && waitAshore(mem, wet, now)) {
            const them = centroid(seen);
            return { ...calm, phase: 'travel', anchor: standHere(), facing: { x: Math.round(them.x), y: Math.round(them.y) }, objective: `wait for ${enemiesText(wet)} swimming${gone}`, reason: `wait ashore: ${enemiesText(wet)} swimming ${Math.round(dist(centre, them))} away` };
        }
        if (!wet) mem.ashoreSince = undefined;
        const them = centroid(ashore);
        const d = Math.round(dist(centre, them));
        const unready = new Set([...deadHere, ...far].map(m => m.name).concat(low.map(w => w.name)));
        if (ashore.length && unready.size <= HUNT_UNREADY) {
            stepLeg(trip, 'hunt', them, { from: centre, movers: main, replan: HUNT_REPLAN });
            return { ...calm, phase: 'travel', anchor: legAnchor(mem), facing: them, objective: `hunt ${enemiesText(ashore.length)} round ${at(them)}${gone}`, reason: `hunt ${enemiesText(ashore.length)} ${d} away: ${ashore.slice(0, 3).map(label).join(', ')}` };
        }
    } else waitAshore(mem, 0, now);

    // ── Attacked by guards: in combat near an enemy keep with nothing on the board on us. Keep guards are realm NPCs, never on
    // the board (isKillable), so this is the only sign of them: walk off, away from that keep, instead of resting under them. ──
    const guarded = keeps.find(k => dist(centre, k) < k.r + GUARD_REACH);
    if (guarded && here.some(m => m.inCombat) && !contacts.some(c => !c.stale && isAlive(c) && onUs(c))) {
        const dx = centre.x - guarded.x, dy = centre.y - guarded.y, d = Math.hypot(dx, dy);
        const way = d < 1 ? { x: 1, y: 0 } : { x: dx / d, y: dy / d };
        const goal = spotAlong(trip, centre, way, guarded.r + GUARD_REACH + 500 - d);
        stepLeg(trip, 'off guards', goal, { from: centre, movers: main, replan: 1500 });
        return { ...calm, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: `get away from ${guarded.name}'s guards${gone}`, reason: `attacked by something unseen ${Math.round(d)} from ${guarded.name}: moving off` };
    }

    // ── Regroup: wait for the dead to be rezzed or release, then meet those walking back from the portal keep ──
    if (deadHere.length) return { ...calm, phase: 'recover', anchor: stay, waiting: deadHere.map(m => ({ name: m.name, why: 'dead' })), reason: `waiting for ${names(deadHere)}: a rez or a release${gone}` };
    // A pair round with no enemy in sight: away from the ring, go there with one short of power and without those away (they walk
    // out to us, holdFormation); at it, rest for them. With an enemy in sight, as before: regroup first.
    const ring = !s.patrol && s.opponent && !seen.length ? patrolRing(regionId, realm, s.opponent) : null;
    const pairRing = ring?.pair ? ring : null;
    const atRing = !!pairRing && dist(centre, pairRing) <= pairRing.r + AT_RING;
    const onTheWay = !!pairRing && !atRing && low.length <= HUNT_UNREADY && low.every(w => w.why === 'power' || w.why === 'pet power');
    if (far.length && atRing) return { ...calm, phase: 'recover', anchor: stay, waiting: [...far.map(m => ({ name: m.name, why: 'away' })), ...low], objective: `wait at the ring for ${names(far)}${gone}`, reason: `waiting at the ring for ${names(far)}, ${Math.round(dist(centre, centroid(far)))} away${low.length ? `, and ${low.map(w => `${w.name}'s ${w.why}`).join(', ')}` : ''}` };
    if (far.length && !pairRing) {
        // A far tank walks back by himself: a leg toward a middle with him in it meets nobody. Only him to meet, they go to meet him: there is no base to wait at.
        const walking = farTank(here, s.gatherRadius);
        const meeting = far.filter(m => m !== walking);
        const goers = meeting.length ? meeting : far;
        const them = centroid(goers);
        // Only observed members to meet (a human, who may stand still): the legs go all the way, not halfway.
        stepLeg(trip, 'gather', them, { from: centre, movers: main, replan: Infinity, meet: goers.some(m => !m.observed) });
        return { ...calm, phase: 'gather', anchor: legAnchor(mem), facing: them, waiting: far.map(m => ({ name: m.name, why: 'away' })), objective: `regroup with ${names(far)}${gone}`, reason: `meeting ${names(far)}, ${Math.round(dist(centre, them))} away` };
    }
    if (low.length && !onTheWay) return { ...calm, phase: 'recover', anchor: stay, waiting: low, reason: `waiting for ${low.map(w => `${w.name}'s ${w.why}`).join(', ')} (ready at ${s.ready.hp}% health, ${s.ready.mana}% power)` };

    // ── Patrol: the loop in legs, next waypoint once everyone stands at the leg that ends at this one ──
    const key = `${regionId}:${realm}:${level}:${s.opponent ?? ''}:${dry}`;
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
    // The leg that ends at the waypoint goes on to the next one: the group walks through it, not to a stop at it.
    if (mem.leg && !mem.legOnward && dist(mem.leg, wp) < 1 && loop.length > 1) {
        const next = loop[(mem.wp + 1) % loop.length]!;
        if (dist(next, wp) >= ONWARD_MIN) mem.legOnward = { x: Math.round(next.x), y: Math.round(next.y) };
    }
    mem.camp = { x: wp.x, y: wp.y, z: wp.z, names: `patrol waypoint ${mem.wp + 1}/${loop.length}` };
    return {
        ...calm, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing,
        objective: `patrol ${loop.length} waypoints${bg && !s.patrol ? (s.opponent ? ` round where we meet ${s.opponent}` : ` round ${bg.name}'s meeting point`) : ''}${gone}`,
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
    const margin = describeCount(s.retreat.margin, Math.max(TUNED_SIZE, Object.keys(r.members).length));
    if (seen === 0 && r.durationMs > 120_000) {
        out.push({ severity: 'high', topic: 'no-contact', issue: 'No enemy player seen in the whole run', evidence: `phases ${phases}`, suggestion: `Raise huntRadius (${s.huntRadius}), or patrol where the other realms walk (settings.patrol; the default rings the meeting point). Members report enemies within the strategy's agent.sightRadius.` });
    }
    if (t.retreats >= 3 && t.retreats * 2 >= Math.max(1, fights)) {
        out.push({ severity: 'medium', topic: 'outnumbered', issue: `The group retreated ${t.retreats}× in ${fights} fights`, evidence: r.timeline.filter(l => l.includes('retreat')).slice(-3).join(' | '), suggestion: `Raise retreat.margin (${margin}) to take more uneven fights, or lower huntRadius (${s.huntRadius}) so the group walks into fewer large groups.` });
    }
    if (lost >= 3 && lost >= 2 * Math.max(1, kills)) {
        const killers: Record<string, number> = {};
        for (const m of Object.values(r.members)) for (const [k, v] of Object.entries(m.killedBy ?? {})) killers[k] = (killers[k] ?? 0) + v;
        const by = Object.entries(killers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
        out.push({ severity: 'high', topic: 'trades', issue: `${lost} members died to players for ${kills} player kills`, evidence: by ? `killed by ${by}` : `${fights} fights`, suggestion: `Kill faster: switch to the weakest sooner (switchBelow ${s.switchBelow}), keep the other enemies mezzed (crowd control assignments), and retreat earlier (retreat.margin ${margin}, retreat.focusHp ${s.retreat.focusHp}).` });
    }
    if ((t.wetInFights ?? 0) >= 20) {
        const swimmers = Object.entries(r.members).filter(([, m]) => (m.wetInFights ?? 0) >= 20).map(([n, m]) => `${n} ${m.wetInFights}%`).join(', ');
        const where = t.wetWhere ?? {};
        const most = Object.entries(where).sort((a, b) => b[1] - a[1])[0]?.[0];
        out.push({
            severity: 'medium', topic: 'water', issue: `Members swam ${t.wetInFights}% of fight time`,
            evidence: `${swimmers}; the enemies in our fights ${t.enemiesWetInFights ?? 0}%; stayDry ${staysDry(s) ? 'on' : 'off'}${Object.keys(where).length ? `; wet fight time ${Object.entries(where).map(([k, v]) => `${k} ${v}%`).join(', ')}` : ''}`,
            suggestion: !staysDry(s) ? 'Turn stayDry on: the fight\'s anchor, legs and retreat spots then stand on the nearest bank.'
                : most === 'travel' ? 'Most of it was on the way, attacked while crossing: check where the routes cross the rivers (safePath) against where the enemies patrol (BattlegroundLayout.pairs).'
                : most === 'near' || most === 'anchor' ? 'Most of it was by the anchor: the bank it stands on is too narrow for the slots round it; widen water.ts DRY_MARGIN.'
                : `The anchor stands on dry ground, so the chases went in: lower chaseLeash (${s.chaseLeash}) to keep tank and melee nearer it.`,
        });
    }
    if ((t.steepInFights ?? 0) >= 15 || (t.steepInTravel ?? 0) >= 15) {
        out.push({
            severity: 'low', topic: 'slope', issue: `Members stood on ground steeper than 35° ${t.steepInFights ?? 0}% of fight time and ${t.steepInTravel ?? 0}% of travel`,
            evidence: `${t.steepPct ?? 0}% of the time alive${t.steepSpots?.length ? `; most at ${t.steepSpots.join(', ')}` : ''}`,
            suggestion: 'Stops stand on level ground (water.ts drySpot) and routes weigh slopes (safePath): look at what led there, a chase or a walk to a slot (walkTo routes on the navmesh, which covers cliffs).',
        });
    }
    // As many fights as possible (user): ten minutes of a round is little, and a walk that long is most of it.
    if (s.opponent && ((t.firstFightS ?? 0) >= SLOW_FIRST_FIGHT_S || (t.quietMaxS ?? 0) >= SLOW_QUIET_S)) {
        out.push({
            severity: 'low', topic: 'contact', issue: `${t.firstFightS == null ? 'No fight with enemy players' : `The first fight with enemy players came at ${Math.round(t.firstFightS / 60)} min`}, the longest stretch without one ${Math.round((t.quietMaxS ?? 0) / 60)} min`,
            evidence: `first enemy seen at ${t.contactS == null ? 'never' : `${Math.round(t.contactS)} s`}, ${t.engagements ?? 0} fights with players; phases ${Object.entries(r.phases).map(([k, v]) => `${k} ${v}%`).join(', ')}`,
            suggestion: 'Check where the two patrols ring (BattlegroundLayout.pairs, the walk there from each arrival: bun sdk/group/survey.ts), and what held the group back (waiting for a member, resting).',
        });
    }
    if (s.opponent && (t.threeWay ?? 0) > 0) {
        const realms = [...new Set(r.fights.flatMap(f => f.enemyRealms ?? []))].join(', ');
        out.push({ severity: 'high', topic: 'pair', issue: `A third realm joined ${t.threeWay} of ${fights} fights in a pair round against ${s.opponent}`, evidence: `enemy realms seen in fights: ${realms}`, suggestion: 'Keep the third group out of the battleground in pair rounds (groups/pair-rounds.sh runs only the two), and leave these fights out of a comparison.' });
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
