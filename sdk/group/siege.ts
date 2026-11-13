// The raid on a keep: where a realm musters, the way in, and the order guards, doors and the lord go in. Data and
// pure functions only: rvr.ts (R3) runs the raid with them, the director (R2) reads rally and target for its muster,
// and keeps.ts lifts the keep's circle for a unit whose settings name the raid (`raid: 'Thidranki Faste'`).
//
// Thidranki Faste on this server (surveyed 2026-11-12 from the server source, the DB, the navmesh and a walk on a
// throwaway stack; groups/stint-realm-calls.md "R5: The Faste", learnings/rvr.md "The Faste"):
//
// - An island in a moat. Three bridges, one into each realm's half, 4600-6000 from the centre, outside every guard's
//   reach. Away from them the moat can only be swum.
// - One gateway, on the east side. An outer wall 900-1100 out with wall-walks at z ~3976, and the keep building on
//   the courtyard's west side. The lord stands on its roof (z 4592, 870 over the courtyard), up a spiral stair.
// - No keep components (keepcomponent is empty), so the walls are zone fixtures: a real client draws them and our
//   navmesh has them, but they block no line of sight. The doors are real (the `door` table, GameKeepDoor):
//   the outer gate and the building's door take melee only, 5200 health at keep level 1, 20800 at level 4.
//   Nothing on the server stops a player walking through a closed door; only a real client's collision does. So
//   the raid breaks them for the look of it (breakDoors), as a human raid must.
// - 17 guards and the lord, L28 and L33 while the keep is level 1; a capture puts it at level 4, so L33 and L38.
// - The lord takes damage only from within 400 in 3D (GuardLord.TakeDamage), so the whole raid climbs to the roof.
// - His death gives the keep to the killer's realm. He is back 1 s later in it; every other guard dies and returns
//   5-25 min later in it (guard_respawn 15 min, variance 10).

import type { Realm } from '../types';
import { getNavmeshStore, type NavMesh, type NavmeshStore } from '../navmesh';
import { BATTLEGROUND_LAYOUTS, keepAt, THIDRANKI, type Keep, type PlayerRealm } from './keeps';
import type { Point, Point3 } from './types';

export type GuardKind = 'fighter' | 'caster' | 'archer' | 'lord';

/** One thing the raid has to take: a guard at its post, or a door. */
export interface SiegeTarget {
    /** Short stable name: 'outer-1', 'gate', 'wall-ne', 'roof-s', 'lord'. */
    label: string;
    kind: GuardKind | 'door';
    /** The guard's post, or the door's spot. */
    at: Point3;
    /** Within this of a player of another realm the guard attacks it (0 for a door). */
    aggro: number;
    /** Order: lower goes first. Guards on us go before anything (raidOrders). */
    rank: number;
    /** Where the raid stands to take it. */
    stand: Point3;
    /** Who works on it: casters and archers on the walls and the roof are out of melee reach, doors take only melee. */
    who: 'all' | 'ranged' | 'melee';
    /** A door's id (DbDoor.InternalID), as NearbyObject.doorId has it. */
    doorId?: number;
}

/** A realm's way from its own bank to the stage, over its own bridge. */
export interface SiegeApproach {
    /** Where the realm musters: its own bank before its bridge, out of every guard's reach and the keep circle. */
    rally: Point3;
    /** From the rally (exclusive) to the stage (inclusive): over the bridge, round the guards' circles, dry. */
    route: Point3[];
}

/** A keep the raid knows how to take. */
export interface SiegeLayout {
    keep: string;
    regionId: number;
    /** Where the raid regroups before going in: on the island, outside every guard's aggro by 500. */
    stage: Point3;
    /** Every guard and door, with its rank. */
    targets: SiegeTarget[];
    /** From the stage to the lord's roof, through the gate and up the stair: the way the raid walks in, in order. */
    inside: Point3[];
    /** Where the raid stands round the lord: the roof by the stair's top, all within LORD_REACH of him. */
    roof: Point3;
    /** The lord takes damage only from attackers (and their pets) within this, in 3D (GuardLord.TakeDamage, a GameKeep). */
    lordReach: number;
    /** Lord names by the realm holding the keep (GuardLord, as our clients saw them). */
    lordName: RegExp;
    approach: Record<PlayerRealm, SiegeApproach>;
    /** Every door of the keep (the door table): the gate and the building's door break; posterns never do (IsPostern). */
    doors: SiegeDoor[];
}

/**
 * A keep door. To an enemy it is a wall until broken (a postern never breaks); to its own realm it opens by interact
 * (GameKeepDoor.Interact moves the player 100-150 through). The server checks no movement, a real client can't pass.
 */
export interface SiegeDoor {
    /** DbDoor InternalID (NearbyObject.doorId). */
    id: number;
    at: Point3;
    kind: 'gate' | 'door' | 'postern';
}

export const LORD_REACH = 400;

/** A keep door's health: BaseLevel x keep_doors_base_health (200), x the keep level (MaxHealthCalculator.cs:70-71). */
export const doorHealth = (baseLevel: number, keepLevel: number) => baseLevel * 200 * keepLevel;

/** What a melee hit on a keep door says, to the hitter (GameKeepDoor.ModifyAttack takes 5 % a keep level off). */
export const DOOR_HIT_RE = /^You attack the Keep Door with .+ and hit for (\d+) damage!$/;
/**
 * What a door says when it breaks, to players within 512 of it (GameKeepDoor.Die, WorldMgr.INFO_DISTANCE), and what a
 * swing at a broken one says to the swinger. A door stays broken for long (it repairs 5 % per 30 min out of combat,
 * GameKeepDoor.REPAIR_INTERVAL), so a later raid learns it only by swinging (live 02:57:14: "the Keep Door is already dead!").
 */
export const DOOR_BROKEN_RE = /^(The Keep Door is broken|the Keep Door is already dead)!$/i;

// The Faste's posts are the DB's mob rows (DOL.GS.Keeps.*), seen at those spots by a client on 2026-11-12. Aggro:
// fighters 1000 (GameKeepGuard.SetAggression), static casters 1850, static archers 2100. Stands are picked so a
// caster's nukes (1500) reach from them, in 3D, and the order keeps the raid out of the next ring's reach until it
// is ready for it.
const OUTSIDE: Point3 = { x: 35500, y: 38250, z: 3570 };
const GATE_OUT: Point3 = { x: 34650, y: 38250, z: 3722 };
const COURTYARD: Point3 = { x: 33100, y: 38250, z: 3722 };
const KEEP_DOOR_OUT: Point3 = { x: 32850, y: 38200, z: 3722 };
const ROOF: Point3 = { x: 32238, y: 38298, z: 4592 };

export const FASTE: SiegeLayout = {
    keep: 'Thidranki Faste',
    regionId: THIDRANKI,
    stage: { x: 36300, y: 38300, z: 3349 },
    targets: [
        // Outside the gate, 1300-1700 out: they come to the raid at OUTSIDE, and the two east casters reach it there too.
        { label: 'outer-armswoman', kind: 'fighter', at: { x: 34687, y: 38050, z: 3716 }, aggro: 1000, rank: 1, stand: OUTSIDE, who: 'all' },
        { label: 'outer-se', kind: 'fighter', at: { x: 34720, y: 38637, z: 3715 }, aggro: 1000, rank: 1, stand: OUTSIDE, who: 'all' },
        { label: 'outer-ne', kind: 'fighter', at: { x: 34396, y: 37556, z: 3730 }, aggro: 1000, rank: 1, stand: OUTSIDE, who: 'all' },
        { label: 'outer-n', kind: 'fighter', at: { x: 34247, y: 37179, z: 3720 }, aggro: 1000, rank: 1, stand: OUTSIDE, who: 'all' },
        { label: 'outer-s', kind: 'fighter', at: { x: 34024, y: 39282, z: 3720 }, aggro: 1000, rank: 1, stand: OUTSIDE, who: 'all' },
        // The wall-walks over the gate side: out of melee reach (254 up), 900-1350 from GATE_OUT in 3D.
        { label: 'wall-e-n', kind: 'caster', at: { x: 33976, y: 37722, z: 3976 }, aggro: 1850, rank: 2, stand: GATE_OUT, who: 'ranged' },
        { label: 'wall-e-s', kind: 'caster', at: { x: 33971, y: 38815, z: 3976 }, aggro: 1850, rank: 2, stand: GATE_OUT, who: 'ranged' },
        { label: 'wall-se', kind: 'caster', at: { x: 33679, y: 39074, z: 3976 }, aggro: 1850, rank: 2, stand: GATE_OUT, who: 'ranged' },
        // The outer gate: melee break it while the casters work the walls.
        { label: 'gate', kind: 'door', at: { x: 34333, y: 38275, z: 3720 }, aggro: 0, rank: 2, stand: { x: 34420, y: 38275, z: 3720 }, who: 'melee', doorId: 252000301 },
        // The courtyard pair come out once anyone is at the gate.
        { label: 'yard-1', kind: 'fighter', at: { x: 33353, y: 38186, z: 3720 }, aggro: 1000, rank: 3, stand: GATE_OUT, who: 'all' },
        { label: 'yard-2', kind: 'fighter', at: { x: 33485, y: 38252, z: 3720 }, aggro: 1000, rank: 3, stand: GATE_OUT, who: 'all' },
        // The far walls, from the courtyard: 900-1170 in 3D.
        { label: 'wall-n', kind: 'caster', at: { x: 33185, y: 37386, z: 3975 }, aggro: 1850, rank: 4, stand: COURTYARD, who: 'ranged' },
        { label: 'wall-sw', kind: 'caster', at: { x: 32478, y: 39130, z: 3976 }, aggro: 1850, rank: 4, stand: COURTYARD, who: 'ranged' },
        { label: 'wall-nw', kind: 'caster', at: { x: 32441, y: 37328, z: 3991 }, aggro: 1850, rank: 4, stand: COURTYARD, who: 'ranged' },
        // The roof archers, from the courtyard: 1040-1290 in 3D, 870 up.
        { label: 'roof-e', kind: 'archer', at: { x: 32526, y: 38271, z: 4592 }, aggro: 2100, rank: 5, stand: COURTYARD, who: 'ranged' },
        { label: 'roof-n', kind: 'archer', at: { x: 32218, y: 37987, z: 4592 }, aggro: 2100, rank: 5, stand: COURTYARD, who: 'ranged' },
        { label: 'roof-s', kind: 'archer', at: { x: 32213, y: 38573, z: 4592 }, aggro: 2100, rank: 5, stand: COURTYARD, who: 'ranged' },
        // The building's door, in front of the stair, then the fighter on its third floor (he comes down to us).
        { label: 'keep-door', kind: 'door', at: { x: 32654, y: 38180, z: 3720 }, aggro: 0, rank: 6, stand: { x: 32740, y: 38180, z: 3720 }, who: 'melee', doorId: 252000302 },
        { label: 'floor-3', kind: 'fighter', at: { x: 32308, y: 38560, z: 4272 }, aggro: 1000, rank: 6, stand: KEEP_DOOR_OUT, who: 'all' },
        // Everyone on the roof: he takes no damage from beyond 400.
        { label: 'lord', kind: 'lord', at: { x: 32296, y: 38267, z: 4592 }, aggro: 1000, rank: 7, stand: ROOF, who: 'all' },
    ],
    // The navmesh's way in (2026-11-12): the gate, the courtyard, the building's door, the spiral stair (x 32144-32285,
    // y 38202-38342) past floors at ~3960 and ~4272, the roof. A client walking to ROOF with its z takes the stair by itself.
    inside: [
        OUTSIDE, GATE_OUT, { x: 34000, y: 38240, z: 3722 }, COURTYARD, KEEP_DOOR_OUT, { x: 32461, y: 38205, z: 3728 },
        { x: 32154, y: 38202, z: 3837 }, { x: 32285, y: 38208, z: 4061 }, { x: 32285, y: 38208, z: 4381 },
        { x: 32154, y: 38342, z: 4579 }, ROOF,
    ],
    roof: ROOF,
    lordReach: LORD_REACH,
    // Albion's is Lady (or Lord) Thidranki, Midgard's Jarl Thidranki (both seen); Hibernia's is unseen yet.
    lordName: /\bThidranki$/,
    // The door table (2026-11-13): 301 the gate, 302 the building's door, 303-306 the building's posterns at wall-walk height.
    doors: [
        { id: 252000301, at: { x: 34333, y: 38275, z: 3720 }, kind: 'gate' },
        { id: 252000302, at: { x: 32654, y: 38180, z: 3720 }, kind: 'door' },
        { id: 252000303, at: { x: 32323, y: 37845, z: 3975 }, kind: 'postern' },
        { id: 252000304, at: { x: 32311, y: 38669, z: 3976 }, kind: 'postern' },
        { id: 252000305, at: { x: 32315, y: 37950, z: 3952 }, kind: 'postern' },
        { id: 252000306, at: { x: 32311, y: 38669, z: 3952 }, kind: 'postern' },
    ],
    // Each checked on the navmesh without swimming (bridges are the only wet stretches) and against every post's aggro:
    // at least 100 clear on the way to the stage (Hibernia's leaves its bridge 350 off a wall caster's circle, and
    // walls are 250+ up, so 3D adds to it), no monster camp within reach.
    approach: {
        hibernia: {
            rally: { x: 28454, y: 32768, z: 3208 },
            route: [
                { x: 29635, y: 33997, z: 3202 }, { x: 31176, y: 35533, z: 3152 }, { x: 31900, y: 35350, z: 3101 },
                { x: 32800, y: 35100, z: 3076 }, { x: 34500, y: 35200, z: 3092 }, { x: 36000, y: 36500, z: 3290 },
                { x: 36300, y: 38300, z: 3349 },
            ],
        },
        midgard: {
            rally: { x: 40448, y: 35226, z: 3216 },
            route: [
                { x: 39526, y: 35779, z: 3284 }, { x: 37683, y: 36454, z: 3267 }, { x: 36900, y: 37300, z: 3222 },
                { x: 36300, y: 38300, z: 3349 },
            ],
        },
        albion: {
            rally: { x: 27546, y: 42330, z: 3024 },
            route: [
                { x: 28160, y: 41792, z: 3059 }, { x: 30177, y: 40208, z: 3020 }, { x: 31500, y: 41250, z: 3178 },
                { x: 33500, y: 41450, z: 3293 }, { x: 35500, y: 41000, z: 3353 }, { x: 36400, y: 39500, z: 3351 },
                { x: 36300, y: 38300, z: 3349 },
            ],
        },
    },
};

export const SIEGE_LAYOUTS: Record<string, SiegeLayout> = { [FASTE.keep]: FASTE };

/** What a raid needs from the layout: the realm's own way, and the target for the director's muster. */
export interface RaidPlan {
    keep: string;
    realm: PlayerRealm;
    regionId: number;
    rally: Point3;
    /** Rally (exclusive) to stage (inclusive). */
    route: Point3[];
    stage: Point3;
    /** Stage (exclusive) to the roof (inclusive). */
    inside: Point3[];
    /** The lord's spot: the director's muster target. */
    target: Point3;
    roof: Point3;
    lordReach: number;
    lordName: RegExp;
    /** Ranked, doors left out when breakDoors is off. */
    targets: SiegeTarget[];
    breakDoors: boolean;
}

export interface RaidSettings {
    /** Break the doors on the way in, as a human raid must; off, the raid walks through them (the server allows it). */
    breakDoors: boolean;
}

export const RAID_SETTINGS: RaidSettings = { breakDoors: true };

/** The plan for `realm` to take `keep` (default the Faste); null for a keep with no layout or a portal keep. */
export function raidPlan(realm: PlayerRealm, keep = FASTE.keep, settings: Partial<RaidSettings> = {}): RaidPlan | null {
    const s = { ...RAID_SETTINGS, ...settings };
    const layout = SIEGE_LAYOUTS[keep];
    if (!layout) return null;
    const k = BATTLEGROUND_LAYOUTS[layout.regionId]?.keeps.find(x => x.name === keep);
    if (!k || k.portal) return null;
    const a = layout.approach[realm];
    const lord = layout.targets.find(t => t.kind === 'lord')!;
    return {
        keep, realm, regionId: layout.regionId,
        rally: a.rally, route: a.route, stage: layout.stage, inside: layout.inside.slice(),
        target: lord.at, roof: layout.roof, lordReach: layout.lordReach, lordName: layout.lordName,
        targets: layout.targets.filter(t => s.breakDoors || t.kind !== 'door').slice().sort((x, y) => x.rank - y.rank),
        breakDoors: s.breakDoors,
    };
}

/** The keep record a plan goes for. */
export function planKeep(plan: RaidPlan): Keep | null {
    return BATTLEGROUND_LAYOUTS[plan.regionId]?.keeps.find(k => k.name === plan.keep) ?? null;
}

/**
 * The rest of the way from `at` to the stage: the waypoints of rally + route still ahead. The nearest waypoint counts
 * as reached when we stand within AT_SPOT of it, or nearer the next one than it is (we are on that leg already).
 * Empty at the stage.
 */
export function routeFrom(plan: RaidPlan, at: Point): Point3[] {
    const way = [plan.rally, ...plan.route];
    let best = 0, bestD = Infinity;
    for (let i = 0; i < way.length; i++) {
        const d = Math.hypot(way[i]!.x - at.x, way[i]!.y - at.y);
        if (d < bestD) { best = i; bestD = d; }
    }
    const next = way[best + 1];
    const onLeg = next && Math.hypot(next.x - at.x, next.y - at.y) < Math.hypot(next.x - way[best]!.x, next.y - way[best]!.y);
    return way.slice(bestD <= AT_SPOT || onLeg ? best + 1 : best);
}

// ── The raid, step by step ───────────────────────────────────────────────────

/** A guard, the lord or a door as a client sees it (NearbyNpc, NearbyObject or a group frame's WorldContact). */
export interface SiegeSeen extends Point3 {
    id: number;
    name: string;
    realm: Realm | string;
    kind: 'npc' | 'object';
    healthPercent?: number;
    isDead?: boolean;
    isPet?: boolean;
    level?: number;
    /** NPC flags (NearbyNpc): a peaceful or untargetable NPC (a Hastener at the gate) is never a guard. */
    isPeaceful?: boolean;
    isTargetable?: boolean;
    /** Whom it attacks, when the client knows (NearbyNpc.targetObjectId). */
    targetObjectId?: number | null;
    doorId?: number | null;
}

export interface RaidMember extends Point3 { id: number; alive: boolean }

export interface RaidView {
    members: readonly RaidMember[];
    /** Everything our members see in the keep's area, merged. */
    seen: readonly SiegeSeen[];
    /** Who owns the keep now (KeepOwnerRead.owner). */
    owner: Realm;
    /** Door ids our members saw break (DOOR_BROKEN_RE) since the raid set out. */
    broken?: readonly number[];
    /** Target labels the caller knows are done (a guard seen to die at its post). */
    done?: readonly string[];
    /** The raid has stood at the stage already: from then on it is inside, whatever its centre. */
    staged?: boolean;
    /**
     * Whether our melee can walk to `to` (meleeReach, from the unit's centre). With it, a caster, archer or lord they can't reach
     * (a wall-walk or the roof behind a shut door, no route) is no melee focus: melee.focus null, they hold at their stand. Absent:
     * everything counts as reachable. Live 2026-11-13 08:36: midgard-2's melee climbed the wall straight up to a Wizard.
     */
    reach?: (to: Point3) => boolean;
    /**
     * Every member of the raid, all units answering the muster (ours included), when the caller knows them. The stage then
     * waits for STAGE_SHARE of the raid's living within RAID_COMING of the stage, not of this unit's alone: live 04:19 a unit
     * of six (Midgard) staged on its own, went in alone at rank 1 and lost four in 16 s while the others were on the way.
     */
    raid?: readonly RaidMember[];
}

export type RaidPhase = 'approach' | 'stage' | 'assault' | 'lord' | 'taken';

/** What one half of the raid does: casters and archers (ranged), or tanks and melee (melee). */
export interface RaidTask {
    /** The plan's step, null while walking or with nothing of its own to do (it then stands with the other half). */
    step: SiegeTarget | null;
    /** What to hit: a guard seen alive, or a door as an object. Null when there is nothing to hit, or its guard is unseen. */
    focus: SiegeSeen | null;
    /** Where to stand. */
    stand: Point3;
}

export interface RaidOrders {
    phase: RaidPhase;
    /** Where the raid as a body stands now (the ranged half's spot in the assault). */
    stand: Point3;
    ranged: RaidTask;
    melee: RaidTask;
    why: string;
}

/** A seen thing is near its post: within 400 on the ground and 200 in height (static guards never move, fighters return). */
const AT_POST = 400, AT_POST_Z = 200;
/** A member this near a post that sees nothing there takes it for gone (dead, respawning): NPCs are seen to 6000. */
const SEEN_FROM = 2500;
/** The raid is at a spot when its centre is this near. */
const AT_SPOT = 600;
/** The raid goes in from the stage once this share of the living stand there. */
export const STAGE_SHARE = 0.75;
/** The raid stays on the lord once this many of the living (and this share of them) stand within his reach. */
export const AT_LORD_MIN = 2;
export const AT_LORD_SHARE = 0.2;
/** A static guard on us further than this from the step's stand is no focus: a nuke's 1500 and a step closer. */
export const FOCUS_REACH = 1650;
/**
 * A member this near the stage stands at it. The pack's formation fans casters out behind the anchor, further with an enemy
 * in sight (spreadOnSight): live 2026-11-13 02:18-02:32, hibernia-2 stood 5/8 within AT_SPOT for 14 min, its centre 320
 * from the stage. The outer fighters' posts are 1600+ from the stage, their aggro 1000.
 */
export const STAGE_NEAR = 1000;
/** With the whole raid known (RaidView.raid), the stage waits for those of it this near (on the way, not back at the portal keep). */
export const RAID_COMING = 12_000;

const isFoe = (s: SiegeSeen, realm: PlayerRealm) => s.kind === 'npc' && !s.isPet && !s.isDead && (s.healthPercent ?? 100) > 0
    && !s.isPeaceful && s.isTargetable !== false && s.realm !== 'none' && s.realm !== realm && (s.level ?? 2) > 1;

/** Inside the keep: this near its centre (inside its walls). */
export const CORRIDOR = 1200;
/** The way in past the stage: this wide each side of the line from the stage to the keep, */
export const CORRIDOR_WIDTH = 600;
/** and at least this share of the way from the stage to the keep (about 480 at the Faste). */
export const CORRIDOR_FROM = 0.15;

/**
 * Whether `p` is on the way in past the stage: inside the keep (CORRIDOR), or beside the line from the stage to the
 * keep (CORRIDOR_WIDTH) and some way along it (CORRIDOR_FROM). A body anywhere else near the keep (one that came in from
 * another side, live 2026-11-13 01:58), or on a route's last leg into the stage (live 02:39, the 1200 corridor it had
 * then took Hibernia's last leg for "past the stage" and skipped the staging), is not past the stage and still walks.
 */
export function pastStage(plan: Pick<RaidPlan, 'stage'>, keep: Point, p: Point): boolean {
    if (Math.hypot(p.x - keep.x, p.y - keep.y) <= CORRIDOR) return true;
    const dx = keep.x - plan.stage.x, dy = keep.y - plan.stage.y, len2 = dx * dx + dy * dy;
    if (!len2) return false;
    const t = ((p.x - plan.stage.x) * dx + (p.y - plan.stage.y) * dy) / len2;
    if (t < CORRIDOR_FROM || t > 1) return false;
    return Math.hypot(p.x - (plan.stage.x + t * dx), p.y - (plan.stage.y + t * dy)) <= CORRIDOR_WIDTH;
}

/** The centre of the living members (their mean), or null with none alive. */
export function raidCentre(members: readonly RaidMember[]): Point3 | null {
    const alive = members.filter(m => m.alive);
    if (!alive.length) return null;
    const n = alive.length;
    return { x: alive.reduce((a, m) => a + m.x, 0) / n, y: alive.reduce((a, m) => a + m.y, 0) / n, z: alive.reduce((a, m) => a + m.z, 0) / n };
}

/**
 * The post a seen guard stands at: the lord's for the lord (by name), else the nearest guard post within AT_POST
 * (AT_POST_Z in height). Null for one off every post. The roof archers stand 290-320 from the lord, so it goes by
 * the nearest post, not the first in reach.
 */
export function postOf(plan: Pick<RaidPlan, 'targets' | 'lordName'>, s: SiegeSeen): SiegeTarget | null {
    if (plan.lordName.test(s.name)) return plan.targets.find(t => t.kind === 'lord') ?? null;
    let best: SiegeTarget | null = null, bestD = Infinity;
    for (const t of plan.targets) {
        if (t.kind === 'door' || t.kind === 'lord') continue;
        const d = Math.hypot(s.x - t.at.x, s.y - t.at.y);
        if (d <= AT_POST && Math.abs(s.z - t.at.z) <= AT_POST_Z && d < bestD) { best = t; bestD = d; }
    }
    return best;
}

/** The seen foe of `plan.realm` standing at a target's post, or null. */
export function atPost(plan: Pick<RaidPlan, 'targets' | 'lordName' | 'realm'>, t: SiegeTarget, seen: readonly SiegeSeen[]): SiegeSeen | null {
    return seen.find(s => isFoe(s, plan.realm) && postOf(plan, s) === t) ?? null;
}

/**
 * Where a raid of `plan.realm` stands and what it hits, from what its members see. Stateless: the caller passes the
 * doors it saw break and the labels it knows are done (or nothing, and a post nobody sees anything at from within
 * SEEN_FROM counts as done).
 *
 * - taken: the keep is ours.
 * - approach: not yet staged, nobody at the stage and the centre not past it (pastStage): walk the route. `stand` is the body's
 *   next waypoint; each member walks routeFrom(plan, itself), so stragglers follow the same bridge.
 * - stage: some at the stage (STAGE_NEAR), fewer than STAGE_SHARE of the living and the centre not on it yet: those wait,
 *   the rest come (routeFrom each).
 * - assault: the lowest rank with a target not done. Ranged take its first ranged-or-all target, melee its first
 *   melee-or-all target (a door), so casters work the walls while melee break the gate. A half with nothing in that
 *   rank stands with the other. A guard of the keep attacking a member, or a fighter off its post (one that came out
 *   after us), is everyone's focus first, whatever its rank.
 * - lord: everything else done: everyone to the roof, the lord is the focus.
 */
export function raidOrders(plan: RaidPlan, view: RaidView): RaidOrders {
    const realm = plan.realm;
    const idle = (stand: Point3): RaidTask => ({ step: null, focus: null, stand });
    const walk = (phase: RaidPhase, stand: Point3, why: string): RaidOrders => ({ phase, stand, ranged: idle(stand), melee: idle(stand), why });
    if (view.owner === realm) return walk('taken', plan.roof, `${plan.keep} is ours`);
    const centre = raidCentre(view.members);
    if (!centre) return walk('approach', plan.rally, 'nobody alive');

    const toStage = Math.hypot(centre.x - plan.stage.x, centre.y - plan.stage.y);
    const keep = planKeep(plan);
    // Staged holds while the body is about the keep: one that fell back (a wipe, a regroup at the rally, live 02:46) walks
    // the route again, never the straight line from home to the rank's stand.
    const stageFromKeep = keep ? Math.hypot(plan.stage.x - keep.x, plan.stage.y - keep.y) : 0;
    const staged = !!view.staged && (!keep || Math.hypot(centre.x - keep.x, centre.y - keep.y) <= stageFromKeep + STAGE_NEAR);
    if (!staged) {
        const alive = view.members.filter(m => m.alive);
        const there = alive.filter(m => Math.hypot(m.x - plan.stage.x, m.y - plan.stage.y) <= STAGE_NEAR).length;
        // The whole raid (when known): wait at the stage for the share of it on the way.
        const coming = view.raid?.filter(m => m.alive && Math.hypot(m.x - plan.stage.x, m.y - plan.stage.y) <= RAID_COMING) ?? [];
        // At the stage or past it: those who went in already count (live 04:58: hibernia-2 waited for "6/18" while the rest stood at the gate).
        const raidThere = coming.filter(m => Math.hypot(m.x - plan.stage.x, m.y - plan.stage.y) <= STAGE_NEAR || (keep && pastStage(plan, keep, m))).length;
        // Nobody there yet and the body not past the stage: walk on (each member by routeFrom from itself).
        if (there === 0 && toStage > AT_SPOT && !(keep && pastStage(plan, keep, centre))) {
            const next = routeFrom(plan, centre)[0] ?? plan.stage;
            return walk('approach', next, `${Math.round(toStage)} to the stage`);
        }
        // Some there: they wait, the rest come.
        if (there > 0 && there < Math.ceil(alive.length * STAGE_SHARE) && toStage > AT_SPOT) return walk('stage', plan.stage, `${there}/${alive.length} at the stage`);
        if (there > 0 && coming.length && raidThere < Math.ceil(coming.length * STAGE_SHARE)) return walk('stage', plan.stage, `${raidThere}/${coming.length} of the raid at the stage`);
    }

    const memberIds = new Set(view.members.map(m => m.id));
    const foes = view.seen.filter(s => isFoe(s, realm) && (!keep || Math.hypot(s.x - keep.x, s.y - keep.y) <= 3000 || (s.targetObjectId != null && memberIds.has(s.targetObjectId))));
    // A guard on one of us goes first; then a fighter off its post (it came out after us), nearest first.
    const onUs = foes.filter(s => s.targetObjectId != null && memberIds.has(s.targetObjectId) && !plan.lordName.test(s.name));
    const offPost = foes.filter(s => !postOf(plan, s));
    const near = (list: SiegeSeen[]) => list.slice().sort((a, b) => Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y))[0];

    const done = new Set(view.done ?? []);
    const broken = new Set(view.broken ?? []);
    const isDone = (t: SiegeTarget): boolean => {
        if (done.has(t.label)) return true;
        if (t.kind === 'door') return t.doorId !== undefined && broken.has(t.doorId);
        if (atPost(plan, t, foes)) return false;
        // Nothing at the post: gone, if one of us is near enough to see it; else assume it still stands. Seeing no guard
        // at all is no news (a picture without them, live 02:39: a unit walked to the gate past five outer fighters).
        if (!foes.length) return false;
        return view.members.some(m => m.alive && Math.hypot(m.x - t.at.x, m.y - t.at.y) <= SEEN_FROM);
    };
    // One of us by the lord (within his reach): the lord it is, whatever came back behind us. Guards respawn 5-25 min after
    // they die (guard_respawn 15 ± 10): live 03:01 an outer fighter back at its post took the raid off the roof, the lord at 46 %.
    // Not one of us alone (a stray, live 03:33: it turned the whole raid on the roof's Scouts with the gate still shut).
    const living = view.members.filter(m => m.alive);
    const atLord = living.filter(m => inLordReach(plan, m)).length >= Math.max(AT_LORD_MIN, Math.ceil(living.length * AT_LORD_SHARE));
    const open = atLord ? [] : plan.targets.filter(t => t.kind !== 'lord' && !isDone(t));
    const rank = open.length ? Math.min(...open.map(t => t.rank)) : null;
    const inRank = open.filter(t => t.rank === rank);
    const rangedStep = inRank.find(t => t.who !== 'melee') ?? null;
    const meleeStep = inRank.find(t => t.who !== 'ranged') ?? null;
    const focusOf = (t: SiegeTarget | null): SiegeSeen | null => !t ? null : t.kind === 'door'
        ? view.seen.find(s => s.kind === 'object' && s.doorId === t.doorId) ?? null
        : atPost(plan, t, foes);
    const task = (t: SiegeTarget | null, other: SiegeTarget | null): RaidTask => t
        ? { step: t, focus: focusOf(t), stand: t.stand }
        : idle(other?.stand ?? plan.roof);

    // A static guard (caster, archer) on us is the focus only within reach of where we stand: one shooting from a wall or
    // the roof further off would draw the casters in after it, into the yard (live 02:55, hibernia-2 lost 7 that way).
    // A fighter on us comes to us, so it always is.
    const stepStand = (rangedStep ?? meleeStep)?.stand ?? plan.roof;
    // On the lord (rank null: every rank done, or the hold): only a fighter on us takes the focus from him. Roof archers
    // stand 290-320 from him, and while they were the focus he regenerated (06:32 in the frozen window: 98 % after 7 min).
    const onLord = rank === null;
    const reachable = (s: SiegeSeen) => { const t = postOf(plan, s); return !t || t.kind === 'fighter' || (!onLord && Math.hypot(s.x - stepStand.x, s.y - stepStand.y) <= FOCUS_REACH); };
    const first = near(onUs.filter(reachable)) ?? near(offPost);
    // Melee take a static guard (caster, archer, lord) only where they can walk to it (view.reach); a fighter comes to them.
    const meleeOk = (x: SiegeSeen | null): boolean => {
        if (!x || x.kind !== 'npc' || !view.reach) return true;
        const t = postOf(plan, x);
        return !t || t.kind === 'fighter' || view.reach(x);
    };
    if (first) {
        const stand = (rangedStep ?? meleeStep)?.stand ?? plan.roof;
        const t: RaidTask = { step: rangedStep ?? meleeStep, focus: first, stand };
        const own = meleeStep ? focusOf(meleeStep) : null;
        const melee: RaidTask = meleeOk(first) ? { ...t } : { step: meleeStep, focus: own && meleeOk(own) ? own : null, stand: meleeStep?.stand ?? stand };
        return { phase: rank === null ? 'lord' : 'assault', stand, ranged: t, melee, why: `${first.name} is on us` };
    }
    if (rank !== null) {
        const ranged = task(rangedStep, meleeStep);
        let melee = task(meleeStep, rangedStep);
        if (melee.focus && !meleeOk(melee.focus)) melee = { ...melee, focus: null };
        const why = [rangedStep && `ranged: ${rangedStep.label}`, meleeStep && meleeStep !== rangedStep && `melee: ${meleeStep.label}`].filter(Boolean).join(', ');
        return { phase: 'assault', stand: ranged.stand, ranged, melee, why: `rank ${rank}: ${why}` };
    }
    const lordStep = plan.targets.find(t => t.kind === 'lord')!;
    const lord = foes.find(s => plan.lordName.test(s.name)) ?? atPost(plan, lordStep, foes);
    const t: RaidTask = { step: lordStep, focus: lord, stand: plan.roof };
    return { phase: 'lord', stand: plan.roof, ranged: t, melee: { ...t, focus: meleeOk(lord) ? lord : null }, why: lord ? `${lord.name} on the roof` : 'up to the roof' };
}

// ── Doors and walking (meleeReach) ───────────────────────────────────────────

/** Doors a raid knows about: broken ones (DOOR_BROKEN_RE, by id) and whether the keep is ours (then every door opens to us). */
export interface DoorState {
    broken: readonly number[];
    ours: boolean;
}

/** The doors that are walls to us now: posterns always, the gate and the building's door until broken; none in our own keep. */
export function shutDoors(layout: Pick<SiegeLayout, 'doors'>, doors: DoorState): SiegeDoor[] {
    if (doors.ours) return [];
    return layout.doors.filter(d => d.kind === 'postern' || !doors.broken.includes(d.id));
}

/** What each mesh was last told per door (applyDoors), so the flags change only when the state does. */
const applied = new WeakMap<NavMesh, Map<number, boolean>>();

/** Shut and open the keep's doors on `mesh` (NavMesh.setDoorBlocking) as `doors` says: every later walk in this process obeys them. */
export function applyDoors(layout: Pick<SiegeLayout, 'doors'>, doors: DoorState, mesh: NavMesh): void {
    const shut = new Set(shutDoors(layout, doors).map(d => d.id));
    let known = applied.get(mesh);
    if (!known) applied.set(mesh, known = new Map());
    for (const d of layout.doors) {
        const blocking = shut.has(d.id);
        if (known.get(d.id) === blocking) continue;
        if (mesh.setDoorBlocking(d.at, blocking)) known.set(d.id, blocking);
    }
}

/** A target this far (3D) off the mesh at its spot stands where no walk ends (a merlon, a ledge): not reachable on foot. */
const OFF_MESH_Z = 64;
const reachCache = new Map<string, boolean>();

/**
 * Whether a melee at `from` can walk to `to` inside a keep's area: a navmesh route that is `found`, with the keep's shut doors
 * (shutDoors) as walls. Outside every siege layout's keep, without a mesh, or with `from` off the mesh: true (nothing to say).
 * Cached per (keep, door state, from to 250, to to 50): a static guard's post costs one query per door state.
 */
export function meleeReach(regionId: number, from: Point3, to: Point3, doors: DoorState, store: NavmeshStore = getNavmeshStore()): boolean {
    const keep = keepAt(regionId, to);
    const layout = keep ? SIEGE_LAYOUTS[keep.name] : undefined;
    if (!layout || layout.regionId !== regionId || !store.available()) return true;
    const mesh = store.at(regionId, to.x, to.y);
    if (!mesh) return true;
    applyDoors(layout, doors, mesh);
    const doorKey = shutDoors(layout, doors).map(d => d.id).join(',');
    const key = `${layout.keep}|${doorKey}|${Math.round(from.x / 250)},${Math.round(from.y / 250)},${Math.round(from.z / 100)}|${Math.round(to.x / 50)},${Math.round(to.y / 50)},${Math.round(to.z / 50)}`;
    const known = reachCache.get(key);
    if (known !== undefined) return known;
    const a = mesh.closestPoint(from, { x: 64, y: 64, z: 256 });
    if (!a) return true;
    const b = mesh.closestPoint(to, { x: 64, y: 64, z: 128 });
    let ok = false;
    if (b && Math.abs(b.z - to.z) <= OFF_MESH_Z) {
        const path = mesh.findPath(a, b);
        const end = path.points.at(-1);
        ok = path.status === 'found' && !!end && Math.hypot(end.x - b.x, end.y - b.y, end.z - b.z) <= 50;
    }
    if (reachCache.size > 4000) reachCache.clear();
    reachCache.set(key, ok);
    return ok;
}

/** The doors a member's chat says broke (DOOR_BROKEN_RE), matched to the plan's door nearest the member when it read it. */
export function brokenDoors(plan: RaidPlan, lines: readonly { text: string; at: Point }[]): number[] {
    const doors = plan.targets.filter(t => t.kind === 'door' && t.doorId !== undefined);
    const out: number[] = [];
    for (const l of lines) {
        if (!DOOR_BROKEN_RE.test(l.text.trim())) continue;
        let best: SiegeTarget | null = null, bestD = Infinity;
        for (const d of doors) {
            const dd = Math.hypot(d.at.x - l.at.x, d.at.y - l.at.y);
            if (dd < bestD) { best = d; bestD = dd; }
        }
        // The line reaches only players within 512 of the door; a little more for a member that moved since.
        if (best && bestD <= 900 && !out.includes(best.doorId!)) out.push(best.doorId!);
    }
    return out;
}

/** Damage a member's own hits on a keep door add up to (DOOR_HIT_RE), for a guess at how far along it is. */
export function doorDamage(lines: readonly { text: string }[]): number {
    let sum = 0;
    for (const l of lines) {
        const m = DOOR_HIT_RE.exec(l.text.trim());
        if (m) sum += Number(m[1]);
    }
    return sum;
}

/** Whether `p` is within the lord's reach (3D): where an attacker or its pet must stand for him to take damage. */
export const inLordReach = (plan: RaidPlan, p: Point3, lord: Point3 = plan.target) =>
    Math.hypot(p.x - lord.x, p.y - lord.y, p.z - lord.z) <= plan.lordReach;
