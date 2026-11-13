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
import { setOwnDoors, setShutDoors } from '../doors';
import { lineOfSight } from '../vision';
import { BATTLEGROUND_LAYOUTS, keepAt, THIDRANKI, type Keep, type PlayerRealm } from './keeps';
import type { Point, Point3, Role } from './types';

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
    /**
     * A wall caster's spot outside the walls that sees it within a nuke's reach and that no other wall caster or roof archer sees
     * (a merlon gap works both ways): the ranged half works it from there before the gate breaks, or while the melee climb.
     */
    outside?: Point3;
    /**
     * A spot that sees this guard only at a bolt's or a bow's reach (1650-1875), not a nuke's: a roof archer seen from the wall-walk
     * above the gate. For the members whose reach is that long, once the walls' casters are down (RaidOrders.bolt).
     */
    bolt?: Point3;
    /**
     * Known at its post but no step of the raid: it holds up no rank. It sees too little of where the raid stands to matter
     * (the west wall), or it is fought from the roof in the lord phase (the roof archers). A guard on us within reach is still
     * the focus, as any other.
     */
    optional?: boolean;
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
    /** Where the ranged half waits while wall casters that see the courtyard live (no wall caster sees it); absent: no wait. */
    outOfSight?: Point3;
    /** The lord takes damage only from attackers (and their pets) within this, in 3D (GuardLord.TakeDamage, a GameKeep). */
    lordReach: number;
    /** Lord names by the realm holding the keep (GuardLord, as our clients saw them). */
    lordName: RegExp;
    approach: Record<PlayerRealm, SiegeApproach>;
    /** Every door of the keep (the door table): the gate and the building's door break; posterns never do (IsPostern). */
    doors: SiegeDoor[];
    /** Where its owner's defenders stand (defencePlan); absent: no defence from inside. */
    defence?: DefenceLayout;
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
    /** The door table's heading: its front, where the heading points, is the inside (sdk/doors.ts doorFront). */
    heading: number;
    /**
     * Where a raider can stand only once this door is passed (no other way in on the island): a circle round the keep for its
     * gate (the courtyard, the walls, the building), a box for the building's door. A living raider there proves it broken.
     */
    behind?: { centre: Point; r: number } | { box: [number, number, number, number] };
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
        // Ranked by line of sight with the walls (sdk/vision.ts lineOfSight over zone252.occluders, measured 2026-11-13): each
        // stand sees what is fought from it, and the guards that see a stand are those of its rank or earlier ones.
        // Outside the gate, 1300-1700 out. GATE_OUT sees all five (OUTSIDE only one) and no wall caster sees it.
        { label: 'outer-armswoman', kind: 'fighter', at: { x: 34687, y: 38050, z: 3716 }, aggro: 1000, rank: 1, stand: GATE_OUT, who: 'all' },
        { label: 'outer-se', kind: 'fighter', at: { x: 34720, y: 38637, z: 3715 }, aggro: 1000, rank: 1, stand: GATE_OUT, who: 'all' },
        { label: 'outer-ne', kind: 'fighter', at: { x: 34396, y: 37556, z: 3730 }, aggro: 1000, rank: 1, stand: GATE_OUT, who: 'all' },
        { label: 'outer-n', kind: 'fighter', at: { x: 34247, y: 37179, z: 3720 }, aggro: 1000, rank: 1, stand: GATE_OUT, who: 'all' },
        { label: 'outer-s', kind: 'fighter', at: { x: 34024, y: 39282, z: 3720 }, aggro: 1000, rank: 1, stand: GATE_OUT, who: 'all' },
        // The outer gate, melee only. No wall caster sees its stand, so the ranged wait there with them, out of the east wall's
        // sight (nothing outside the gate sees wall-e-n, wall-e-s or wall-se, nor they it).
        { label: 'gate', kind: 'door', at: { x: 34333, y: 38275, z: 3720 }, aggro: 0, rank: 2, stand: { x: 34420, y: 38275, z: 3720 }, who: 'melee', doorId: 252000301 },
        // The courtyard: the yard pair and every wall caster that sees it (wall-e-n, wall-e-s, wall-se, wall-n, 93-152 of 215
        // courtyard points each). COURTYARD sees all of them.
        { label: 'yard-1', kind: 'fighter', at: { x: 33353, y: 38186, z: 3720 }, aggro: 1000, rank: 3, stand: COURTYARD, who: 'all' },
        { label: 'yard-2', kind: 'fighter', at: { x: 33485, y: 38252, z: 3720 }, aggro: 1000, rank: 3, stand: COURTYARD, who: 'all' },
        // Melee too (the user, in hibernia's raid 2026-11-13 17:25: "tanks need to go in. up the walls and kill the runemasters"):
        // once the gate is broken the wall-walk stair at (33530-33660, 38860-38960) is a found route (meleeReach), so the tanks and
        // melee climb to them while the ranged cover from the courtyard; before it, meleeReach keeps them off. Nearest the stair first.
        // Their `outside` spots (lineOfSight both ways, measured 2026-11-13 after the user nuked a Runemaster from outside the
        // north-west wall): seen by that caster alone, within 1250 of it in 3D, reachable from the stage with the gate shut.
        // wall-se and wall-sw have none.
        { label: 'wall-se', kind: 'caster', at: { x: 33679, y: 39074, z: 3976 }, aggro: 1850, rank: 3, stand: COURTYARD, who: 'all' },
        { label: 'wall-e-s', kind: 'caster', at: { x: 33971, y: 38815, z: 3976 }, aggro: 1850, rank: 3, stand: COURTYARD, who: 'all', outside: { x: 35000, y: 39400, z: 3619 } },
        { label: 'wall-e-n', kind: 'caster', at: { x: 33976, y: 37722, z: 3976 }, aggro: 1850, rank: 3, stand: COURTYARD, who: 'all', outside: { x: 35000, y: 37150, z: 3712 } },
        { label: 'wall-n', kind: 'caster', at: { x: 33185, y: 37386, z: 3975 }, aggro: 1850, rank: 3, stand: COURTYARD, who: 'all', outside: { x: 33200, y: 36900, z: 3724 } },
        // The west wall: no reachable ground spot sees wall-sw, and wall-nw only from outside the walls; they see 1 and 6 of 215
        // courtyard points, not the building's door, not the roof. Optional: their stands are the wall-walk spots that see them
        // (up the stair from the courtyard), should one ever be wanted.
        { label: 'wall-sw', kind: 'caster', at: { x: 32478, y: 39130, z: 3976 }, aggro: 1850, rank: 4, stand: { x: 32592, y: 39293, z: 3994 }, who: 'ranged', optional: true },
        { label: 'wall-nw', kind: 'caster', at: { x: 32441, y: 37328, z: 3991 }, aggro: 1850, rank: 4, stand: { x: 32441, y: 37828, z: 3978 }, who: 'ranged', optional: true, outside: { x: 32300, y: 37050, z: 3720 } },
        // The building's door, then the fighter on its third floor (he comes down to us). No wall or roof guard sees the door's stand
        // but the courtyard's own.
        { label: 'keep-door', kind: 'door', at: { x: 32654, y: 38180, z: 3720 }, aggro: 0, rank: 4, stand: { x: 32740, y: 38180, z: 3720 }, who: 'melee', doorId: 252000302 },
        { label: 'floor-3', kind: 'fighter', at: { x: 32308, y: 38560, z: 4272 }, aggro: 1000, rank: 4, stand: KEEP_DOOR_OUT, who: 'all' },
        // The roof archers are seen from the roof only (roof-n and roof-s see none of the courtyard, roof-e 30 points): fought in
        // the lord phase from ROOF, the ranged first on them, the melee on the lord.
        // roof-e is seen from the east wall-walk by the gate only (33 spots, 1647-1700 away, lineOfSight both ways; the user, 2026-11-13:
        // "you can only see it from above the entrance ... only in bolt distance"), and those spots are in every east wall caster's
        // sight: a bolt or a bow takes it from there once the wall casters are down. roof-n and roof-s are seen from nowhere but the roof.
        { label: 'roof-e', kind: 'archer', at: { x: 32526, y: 38271, z: 4592 }, aggro: 2100, rank: 6, stand: ROOF, who: 'ranged', optional: true, bolt: { x: 34016, y: 38610, z: 3978 } },
        { label: 'roof-n', kind: 'archer', at: { x: 32218, y: 37987, z: 4592 }, aggro: 2100, rank: 6, stand: ROOF, who: 'ranged', optional: true },
        { label: 'roof-s', kind: 'archer', at: { x: 32213, y: 38573, z: 4592 }, aggro: 2100, rank: 6, stand: ROOF, who: 'ranged', optional: true },
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
    // The ranged half waits here while a courtyard-side wall caster lives: no wall caster sees it (lineOfSight, 2026-11-13).
    outOfSight: GATE_OUT,
    lordReach: LORD_REACH,
    // Albion's is Lady (or Lord) Thidranki, Midgard's Jarl Thidranki (both seen); Hibernia's is unseen yet.
    lordName: /\bThidranki$/,
    // The door table (2026-11-13): 301 the gate, 302 the building's door, 303-306 the building's posterns at wall-walk height.
    doors: [
        // Behind the gate: within 950 of the keep's centre (the outer wall runs 900-1100 out, the gate is 1245 east of it); behind
        // the building's door: the building, x 31830-32640 (its door at 32654), y 37950-38600.
        { id: 252000301, at: { x: 34333, y: 38275, z: 3720 }, kind: 'gate', heading: 1024, behind: { centre: { x: 33089, y: 38271 }, r: 950 } },
        { id: 252000302, at: { x: 32654, y: 38180, z: 3720 }, kind: 'door', heading: 1030, behind: { box: [31830, 37950, 32640, 38600] } },
        { id: 252000303, at: { x: 32323, y: 37845, z: 3975 }, kind: 'postern', heading: 4079 },
        { id: 252000304, at: { x: 32311, y: 38669, z: 3976 }, kind: 'postern', heading: 2058 },
        { id: 252000305, at: { x: 32315, y: 37950, z: 3952 }, kind: 'postern', heading: 2058 },
        { id: 252000306, at: { x: 32311, y: 38669, z: 3952 }, kind: 'postern', heading: 2058 },
    ],
    // The owner's defence from inside (defencePlan), measured 2026-11-13 with lineOfSight over zone252.occluders and the navmesh:
    // - No wall-walk spot within 1500 of the stair sees anything outside the gate (merlons; the eye is below their tops), nor does
    //   anything there see it. So the ranged stand where they see the courtyard: each wall stand sees 155-175 of 202 courtyard points
    //   and the gate's inside, and is a found route from the stair's foot (526-1360 long). They fight once the gate is down.
    // - A point-blank bomb has no line-of-sight check on the server (SpellHandler.SelectTargets, ENEMY with a radius:
    //   GetPlayersInRadius), so a bomber 120 inside the gate reaches the melee breaking it from its outside stand (34420): 210 away.
    // - The stair to the wall-walk climbs from (33500, 38950) at 3722 to (33664, 38863) at 3968; the spiral stair's top is the
    //   roof's way in (32154, 38342, 4579).
    defence: {
        entry: { x: 34650, y: 38275, z: 3722 },
        stands: [
            { label: 'bomb-gate-n', job: 'bomb', at: { x: 34210, y: 38225, z: 3720 }, seats: 1, leash: 0 },
            { label: 'bomb-gate-s', job: 'bomb', at: { x: 34210, y: 38325, z: 3720 }, seats: 1, leash: 0 },
            { label: 'bomb-stair', job: 'bomb', at: { x: 33664, y: 38863, z: 3968 }, seats: 1, leash: 0 },
            { label: 'bomb-roof', job: 'bomb', at: { x: 32154, y: 38342, z: 4579 }, seats: 1, leash: 0 },
            { label: 'turret-gate', job: 'turret', at: { x: 33950, y: 38420, z: 3720 }, ground: { x: 34120, y: 38275, z: 3720 }, seats: 2, leash: 0 },
            { label: 'wall-se', job: 'wall', at: { x: 33752, y: 38764, z: 3968 }, seats: 2, leash: 0 },
            { label: 'wall-e', job: 'wall', at: { x: 34016, y: 38610, z: 3978 }, seats: 2, leash: 0 },
            { label: 'wall-s-1', job: 'wall', at: { x: 33400, y: 39000, z: 3968 }, seats: 1, leash: 0 },
            { label: 'wall-s-2', job: 'wall', at: { x: 33099, y: 39056, z: 3978 }, seats: 1, leash: 0 },
            { label: 'wall-sw', job: 'wall', at: { x: 32890, y: 38958, z: 3978 }, seats: 1, leash: 0 },
            { label: 'heal-stair', job: 'heal', at: { x: 33450, y: 38800, z: 3722 }, seats: 3, leash: 300 },
            { label: 'yard-gate', job: 'yard', at: { x: 33900, y: 38275, z: 3720 }, seats: 8, leash: 700 },
        ],
    },
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
    /** The layout's outOfSight: where the ranged half waits while the walls' casters live. */
    outOfSight?: Point3;
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
        target: lord.at, roof: layout.roof, lordReach: layout.lordReach, lordName: layout.lordName, ...(layout.outOfSight ? { outOfSight: layout.outOfSight } : {}),
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
    /**
     * Set when this half holds, out of sight, while the other works: the ranged half while a wall caster that sees the courtyard
     * lives (the melee climb to it). Its focus is then null, and it takes none of the other half's.
     */
    hold?: string;
    /**
     * The melee's: every wall caster they can go for now, alive and seen, nearest the stair first (focus is the first). For one
     * melee on each (the user: "tanks go in. up the stairs. one for each runi."): the caller spreads its tanks and melee over them.
     */
    split?: SiegeSeen[];
}

export interface RaidOrders {
    phase: RaidPhase;
    /** Where the raid as a body stands now (the ranged half's spot in the assault). */
    stand: Point3;
    ranged: RaidTask;
    melee: RaidTask;
    /**
     * For members whose reach is a bolt's or a bow's (1650 and more): a guard only that reach takes, from its `bolt` spot, once the
     * ranks with wall casters are done and before the lord. Absent otherwise. The others go on with ranged and melee.
     */
    bolt?: RaidTask;
    why: string;
}

/** A seen thing is near its post: within 400 on the ground and 200 in height (static guards never move, fighters return). */
const AT_POST = 400, AT_POST_Z = 200;
/** A member this near a post that sees nothing there takes it for gone (dead, respawning): NPCs are seen to 6000. */
const SEEN_FROM = 2500;
/** With no guard seen at all, a post this near one of us counts as gone (once staged). Rank 1's posts lie 200-1500 from its stand. */
const POST_NEAR = 1600;
/** A guard off its post this near a fighter's post still holds it open (a fighter chases 1000 out from its post and comes back). */
const OFF_POST_NEAR = 1500;
/** A guard this far above or below the raid's centre stands on another level (a floor, the wall-walk): reached only by a route. */
const LEVEL_DZ = 150;
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
    // A door some living one of us stands behind is passed, whether or not a member read it break (each unit learns that only from
    // its own members' chat: live 18:48, hibernia sat at rank 2 "melee on the gate" with the user and bots already past it).
    const broken = new Set([...(view.broken ?? []), ...passedDoors(plan, view.members)]);
    // A door broken is the raid past every rank before it: a guard of those respawning at its post (5-25 min) doesn't send the
    // raid back (live 14:33, hibernia back to rank 1 with the gate down). One that comes at us is still the focus (onUs, offPost).
    const passed = Math.max(0, ...plan.targets.filter(t => t.kind === 'door' && t.doorId !== undefined && broken.has(t.doorId)).map(t => t.rank));
    const isDone = (t: SiegeTarget): boolean => {
        if (done.has(t.label) || t.optional || t.rank < passed) return true;
        if (t.kind === 'door') return t.doorId !== undefined && broken.has(t.doorId);
        if (atPost(plan, t, foes)) return false;
        // A fighter off its post near it (it came out after us) is still its guard: the rank stays open until it dies, rather than
        // flipping open and done as it walks out and back (live 19:05, albion-1: rank 1 and rank 2 tick by tick with outer-se left).
        if (t.kind === 'fighter' && offPost.some(s => Math.hypot(s.x - t.at.x, s.y - t.at.y) <= OFF_POST_NEAR)) return false;
        // Nothing at the post: gone, if one of us is near enough to see it; else assume it still stands. Seeing no guard
        // at all is no news (a picture without them, live 02:39: a unit walked to the gate past five outer fighters).
        // Once staged, a post one of us stands near shows its guard if one is there (a client sees NPCs much farther): none
        // seen means gone, so the raid goes on (live 16:47, the user in hibernia's raid: rank 1's outer fighters dead, the wall
        // casters out of sight of the gate's stand, and the raid rested "nothing to hit in view" for minutes).
        if (!foes.length) return !!view.staged && view.members.some(m => m.alive && Math.hypot(m.x - t.at.x, m.y - t.at.y) <= POST_NEAR);
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
    // A fighter on another floor behind a door shut to us (the building's floor-3 fighter, a postern) can't come to us, and no
    // melee can go to it: live 18:36, albion-1's melee 'Huscarl is on another level with no way there (... a shut door at
    // (32311, 38669))' over and over. On another level it is a focus only by a found route (view.reach).
    const upOrDown = (s: SiegeSeen) => Math.abs(s.z - centre.z) > LEVEL_DZ;
    const fighterOk = (s: SiegeSeen) => !view.reach || !upOrDown(s) || view.reach(s);
    const reachable = (s: SiegeSeen) => { const t = postOf(plan, s); return !t || t.kind === 'fighter' ? fighterOk(s) : !onLord && Math.hypot(s.x - stepStand.x, s.y - stepStand.y) <= FOCUS_REACH; };
    const first = near(onUs.filter(reachable)) ?? near(offPost.filter(fighterOk));
    // Melee take a static guard (caster, archer, lord) only where they can walk to it (view.reach); a fighter comes to them.
    const meleeOk = (x: SiegeSeen | null): boolean => {
        if (!x || x.kind !== 'npc' || !view.reach) return true;
        const t = postOf(plan, x);
        return !t || t.kind === 'fighter' ? fighterOk(x) : view.reach(x);
    };
    // The ranged half holds out of the walls' sight while the melee's step is a caster on the walls they can reach (a found route:
    // the gate broken). Not on the lord, nor without a layout spot for it.
    // Only once every door before that rank is broken (the user, 18:05: "the melee climb should start only once the gate is
    // broken; before that, ranged on the wall casters"), and only for a caster the melee can walk to now.
    const doorsDown = (r: number) => plan.targets.filter(t => t.kind === 'door' && t.rank < r).every(t => t.doorId !== undefined && broken.has(t.doorId));
    const wallsHold = (step: SiegeTarget | null): boolean => {
        if (!plan.outOfSight || !step || step.kind !== 'caster' || step.who === 'ranged' || rank === null || !doorsDown(step.rank)) return false;
        const f = focusOf(step);
        return !!f && !!view.reach && meleeOk(f);
    };
    // The ranged half's work from outside the walls: the live wall caster with an `outside` spot nearest the raid, from that spot
    // (the user, 18:41: "you can kill the Runemasters like I just did", from outside the north-west wall). Before the lord only.
    const outsideWork = (): RaidTask | null => {
        if (rank === null) return null;
        const live = plan.targets
            .filter(t => t.outside && t.kind === 'caster' && !done.has(t.label))
            .map(t => ({ t, f: atPost(plan, t, foes) }))
            .filter((x): x is { t: SiegeTarget; f: SiegeSeen } => !!x.f)
            .sort((a, b) => Math.hypot(a.t.outside!.x - centre.x, a.t.outside!.y - centre.y) - Math.hypot(b.t.outside!.x - centre.x, b.t.outside!.y - centre.y));
        const w = live[0];
        return w ? { step: w.t, focus: w.f, stand: w.t.outside! } : null;
    };
    // The bolt's work: a live guard with a `bolt` spot, once no wall caster of an earlier or this rank stands (their sight covers
    // those spots) and before the lord.
    const boltWork = (): RaidTask | null => {
        // No wall caster left at all (the spot is in every east wall caster's sight, and up the stair beyond the gate): live 19:48, at
        // rank 1 "Blaise on the roof-e from the wall" while the wall casters of rank 3 stood (open counted only ranks up to this one).
        if (rank === null || open.some(t => t.kind === 'caster' && !t.optional)) return null;
        const t = plan.targets.find(x => x.bolt && !done.has(x.label) && atPost(plan, x, foes));
        return t ? { step: t, focus: atPost(plan, t, foes), stand: t.bolt! } : null;
    };
    // The wall casters the melee can go for now, one each: those of this rank, alive at their posts, reachable.
    const splitOf = (): SiegeSeen[] => rank === null || !doorsDown(rank) ? [] : inRank
        .filter(t => t.kind === 'caster' && t.who !== 'ranged')
        .map(t => focusOf(t))
        .filter((f): f is SiegeSeen => !!f && !!view.reach && meleeOk(f));
    // The hold for the walls goes on whatever static guard (a roof archer, a far wall caster) shoots at one of us: the ranged would
    // otherwise leave their spot out of sight for the courtyard, into the wall casters' sight, after a guard they may never see
    // (live 18:35, albion-1: "Hunter is on us" two seconds after the hold began). A fighter on us still turns everyone.
    if (first && rank !== null && wallsHold(meleeStep)) {
        const firstPost = postOf(plan, first);
        if (firstPost && firstPost.kind !== 'fighter' && !(meleeOk(first) && firstPost.kind === 'caster' && firstPost.rank === rank)) {
            const melee: RaidTask = { ...task(meleeStep, rangedStep), ...(splitOf().length > 1 ? { split: splitOf() } : {}) };
            const ranged: RaidTask = { step: rangedStep, focus: null, stand: plan.outOfSight!, hold: `${meleeStep!.label} on the wall` };
            return { phase: 'assault', stand: ranged.stand, ranged, melee, why: `${first.name} is on us; ranged out of sight, the melee on ${meleeStep!.label}` };
        }
    }
    if (first) {
        const stand = (rangedStep ?? meleeStep)?.stand ?? plan.roof;
        const t: RaidTask = { step: rangedStep ?? meleeStep, focus: first, stand };
        const own = meleeStep ? focusOf(meleeStep) : null;
        const melee: RaidTask = meleeOk(first) ? { ...t } : { step: meleeStep, focus: own && meleeOk(own) ? own : null, stand: meleeStep?.stand ?? stand };
        // A wall caster on us that the melee can reach: theirs; the ranged half waits out of the walls' sight.
        const firstPost = postOf(plan, first);
        if (firstPost && wallsHold(firstPost) && melee.focus?.id === first.id) {
            const ranged: RaidTask = { step: rangedStep, focus: null, stand: plan.outOfSight!, hold: `${firstPost.label} on the wall` };
            const split = splitOf();
            return { phase: 'assault', stand: ranged.stand, ranged, melee: split.length > 1 ? { ...melee, split } : melee, why: `${first.name} is on us; ranged out of sight` };
        }
        return { phase: rank === null ? 'lord' : 'assault', stand, ranged: t, melee, why: `${first.name} is on us` };
    }
    if (rank !== null) {
        let ranged = task(rangedStep, meleeStep);
        let melee = task(meleeStep, rangedStep);
        if (melee.focus && !meleeOk(melee.focus)) melee = { ...melee, focus: null };
        // A wall caster that sees the courtyard still up, and the melee can go for it: the ranged half (casters, healers,
        // support) waits out of every wall caster's sight while the melee climb (the user, 2026-11-13 17:30: "Fiacra and
        // Amergin are not safe, they are being hit by the Runemasters", killed in the courtyard).
        const fromOutside = outsideWork();
        if (wallsHold(meleeStep)) {
            ranged = fromOutside ?? { step: rangedStep, focus: null, stand: plan.outOfSight!, hold: `${meleeStep!.label} on the wall` };
            const split = splitOf();
            if (split.length > 1) melee = { ...melee, split };
        } else if (!rangedStep && fromOutside) {
            // Melee alone on this rank's step (the gate): the ranged half works a wall caster from outside meanwhile.
            ranged = fromOutside;
        }
        const why = [rangedStep && `ranged: ${ranged.hold ? `out of sight while ${ranged.hold}` : rangedStep.label}`, meleeStep && meleeStep !== rangedStep && `melee: ${meleeStep.label}`].filter(Boolean).join(', ');
        // "N left": the rank's targets still standing, for the director's progress hold (a wall caster down is progress too).
        const bolt = boltWork();
        return { phase: 'assault', stand: ranged.stand, ranged, melee, ...(bolt ? { bolt } : {}), why: `rank ${rank}: ${why}; ${inRank.length} left${bolt ? `; bolt: ${bolt.step!.label}` : ''}` };
    }
    const lordStep = plan.targets.find(t => t.kind === 'lord')!;
    const lord = foes.find(s => plan.lordName.test(s.name)) ?? atPost(plan, lordStep, foes);
    const t: RaidTask = { step: lordStep, focus: lord, stand: plan.roof };
    // The roof archers (optional, fought from the roof): the ranged take them first, the melee stay on the lord.
    const archerStep = plan.targets.find(x => x.optional && x.kind === 'archer' && atPost(plan, x, foes)) ?? null;
    const archer = archerStep ? atPost(plan, archerStep, foes) : null;
    const ranged: RaidTask = archer ? { step: archerStep, focus: archer, stand: plan.roof } : t;
    const why = archer ? `${archerStep!.label} on the roof first, then ${lord?.name ?? 'the lord'}` : lord ? `${lord.name} on the roof` : 'up to the roof';
    return { phase: 'lord', stand: plan.roof, ranged, melee: { ...t, focus: meleeOk(lord) ? lord : null }, why };
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

/**
 * Shut and open the keep's doors on `mesh` (NavMesh.setDoorBlocking) as `doors` says: every later walk in this process obeys them.
 * In our own keep its unbroken doors are also ours to use (sdk/doors.ts setOwnDoors): walkTo stops at each on its way, interacts and
 * goes through as a player does. Out of it (or with no keep named), they are no longer.
 */
export function applyDoors(layout: Pick<SiegeLayout, 'doors'> & Partial<Pick<SiegeLayout, 'keep' | 'regionId'>>, doors: DoorState, mesh: NavMesh): void {
    if (layout.keep !== undefined && layout.regionId !== undefined) useOwnDoors(layout as Pick<SiegeLayout, 'doors' | 'keep' | 'regionId'>, doors);
    const shut = new Set(shutDoors(layout, doors).map(d => d.id));
    let known = applied.get(mesh);
    if (!known) applied.set(mesh, known = new Map());
    for (const d of layout.doors) {
        const blocking = shut.has(d.id);
        if (known.get(d.id) === blocking) continue;
        if (mesh.setDoorBlocking(d.at, blocking)) known.set(d.id, blocking);
    }
}

/** Register (or, when the keep isn't ours, forget) the keep's doors we go through by interacting: every unbroken one of ours. */
export function useOwnDoors(layout: Pick<SiegeLayout, 'doors' | 'keep' | 'regionId'>, doors: DoorState): void {
    const asDoor = (d: SiegeDoor) => ({ doorId: d.id, at: d.at, heading: d.heading });
    setOwnDoors(layout.regionId, layout.keep, doors.ours ? layout.doors.filter(d => !doors.broken.includes(d.id)).map(asDoor) : []);
    // The enemy's shut doors: no chase goes straight through one (actions.ts doorBetween), as no walk does on the mesh.
    setShutDoors(layout.regionId, layout.keep, shutDoors(layout, doors).map(asDoor));
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
    // A raid's centre with members on several levels (the courtyard, the wall-walk, the stair) has its height between floors: look
    // wider before giving up (live 19:07, albion-1 at the lord: "melee hold" on and off as the centre's height moved).
    const a = mesh.closestPoint(from, { x: 64, y: 64, z: 256 }) ?? mesh.closestPoint(from, { x: 200, y: 200, z: 600 });
    // Still no mesh near `from` (over the water): no route to say yes by. It answered yes before, and as the centre moved the raid
    // flipped between the melee's climb and their hold every few seconds (live 18:03, the user).
    if (!a) { reachCache.set(key, false); return false; }
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

// ── The defence from inside (defencePlan, defenceOrders) ─────────────────────
//
// The keep's owner sends some units in (S3's defence call). Each member takes a stand by what it can cast, never by who it is: a
// point-blank bomb at the gate's inside and the stairs, an Animist's turrets inside the gate, the ranged on the wall-walk where they
// see the courtyard, the healers by the wall stair's foot, the melee in the courtyard behind the gate. Walks in go through our own
// doors (openOwnDoors: walkTo interacts at each, sdk/doors.ts).

/** What a member does in the defence, by its spells and the group role it plays. */
export type DefenceJob = 'bomb' | 'turret' | 'wall' | 'heal' | 'yard';

/** One place to stand and how many stand there. */
export interface DefenceStand {
    label: string;
    job: DefenceJob;
    at: Point3;
    seats: number;
    /** How far from it a member may go after a foe (3D): 0 never leaves it (it fights from there), else that far and back. */
    leash: number;
    /** A turret stand's ground target: where its turrets go (SummonAnimistPet stands them on it). */
    ground?: Point3;
}

export interface DefenceLayout {
    /** Outside the gate on the way in: the defenders come here first (over their own bridge), then through the gate. */
    entry: Point3;
    /** In order of need: within a job, the stands listed first fill first when equally near. */
    stands: DefenceStand[];
}

/** What a member can cast that the defence asks about (SpellPick's fields). */
export interface DefenceSpell {
    type: string;
    target: string;
    range: number;
    radius: number;
    damage: number;
}

/** A bomb worth a seat: the point-blank damage sdk/classes/pbae.ts casts (Disenchanting Emission, Steaming Blast: 133, radius 300). */
const isBomb = (s: DefenceSpell) => s.type === 'DirectDamage' && s.target === 'Enemy' && s.range === 0 && s.radius > 0 && s.damage >= 100;
const isTurret = (s: DefenceSpell) => s.type === 'SummonAnimistPet' || s.type === 'SummonAnimistFnF';
/** A nuke that reaches from the wall-walk into the courtyard: 1000 and more (a wall stand is 1100-1300 from the gate's inside). */
const isRangedNuke = (s: DefenceSpell) => /^(DirectDamage|Bolt|Lifedrain|DamageOverTime|DirectDamageWithDebuff|DamageSpeedDecrease)$/.test(s.type) && s.range >= 1000 && s.target === 'Enemy';

/**
 * The jobs a member takes, best first, from its spells and its group role (never its name or class): a bomb, then turrets, then
 * the healers, then a ranged nuke or a bow for the wall, the courtyard last. A job whose seats are full hands it to its next.
 */
export function defenceJobs(kit: { role: Role; spells: readonly DefenceSpell[]; archer?: boolean }): DefenceJob[] {
    const jobs: DefenceJob[] = [];
    if (kit.spells.some(isBomb)) jobs.push('bomb');
    if (kit.spells.some(isTurret)) jobs.push('turret');
    if (kit.role === 'healer') jobs.push('heal');
    if (kit.archer || (kit.role !== 'tank' && kit.role !== 'melee' && kit.spells.some(isRangedNuke))) jobs.push('wall');
    jobs.push('yard');
    return jobs;
}

/** The plan for `realm` to hold a keep from inside. */
export interface DefencePlan {
    keep: string;
    realm: PlayerRealm;
    regionId: number;
    /** The realm's own way to the island: the raid's rally and route to its stage, then the entry outside the gate. */
    rally: Point3;
    route: Point3[];
    entry: Point3;
    stands: DefenceStand[];
    roof: Point3;
    lord: Point3;
    /** The keep's centre (keeps.ts): inside the walls is within 1000 of it. */
    centre: Point;
    doors: SiegeDoor[];
}

/** The defence of `keep` (default the Faste) for its owner `realm`; null for a keep with no defence layout. */
export function defencePlan(realm: PlayerRealm, keep = FASTE.keep): DefencePlan | null {
    const layout = SIEGE_LAYOUTS[keep];
    if (!layout?.defence) return null;
    const a = layout.approach[realm];
    const lord = layout.targets.find(t => t.kind === 'lord')!;
    const k = BATTLEGROUND_LAYOUTS[layout.regionId]?.keeps.find(x => x.name === keep);
    return {
        keep, realm, regionId: layout.regionId, rally: a.rally, route: [...a.route, layout.defence.entry], entry: layout.defence.entry,
        stands: layout.defence.stands, roof: layout.roof, lord: lord.at, centre: k ? { x: k.x, y: k.y } : { x: lord.at.x, y: lord.at.y }, doors: layout.doors,
    };
}

/** A member of the defence: where it is and the jobs it takes (defenceJobs). */
export interface Defender extends Point3 {
    id: number;
    alive: boolean;
    jobs: readonly DefenceJob[];
}

export interface DefenceView {
    /** The defending unit's members (or every defending unit's). */
    defenders: readonly Defender[];
    /** Enemy players and their pets seen near the keep (no guards). */
    foes: readonly Point3[];
    /** Who holds the keep now (KeepOwnerRead, or the guards' realm). */
    owner: Realm | string;
    /** Last tick's seats, stand label by defender id: a member keeps its seat while its job still fits. */
    seats?: ReadonlyMap<number, string>;
}

export type DefencePhase = 'going' | 'holding' | 'roof' | 'lost';

export interface DefenceOrders {
    phase: DefencePhase;
    /** Each living defender's stand, by id. On 'roof' the courtyard's and the healers' stand is the roof. Empty on 'lost'. */
    seats: Map<number, DefenceStand>;
    /** Foes outside the walls, in the courtyard, and on the roof (by the lord). */
    threat: { outside: number; inside: number; roof: number };
    why: string;
}

/** On its stand: within this of it on the ground, and DEFENCE_ON_Z of its height. */
export const ON_STAND = 150;
const DEFENCE_ON_Z = 100;
/** Foes this close to the lord (3D) are on the roof: the courtyard and the healers go up. */
export const ROOF_THREAT = 700;
/** Holding once this share of the living stand on their stands. */
export const HOLD_SHARE = 0.6;
/** Inside the walls: this close to the keep's centre on the ground (the outer wall runs 900-1100 out). */
const INSIDE = 1000;

const insideOf = (centre: Point, p: Point) => Math.hypot(p.x - centre.x, p.y - centre.y) <= INSIDE;

/**
 * Seats: each living defender's first job with a free seat. Within a job the stands fill in the layout's order of need (the gate's
 * bombers before the roof's), the nearest member first. Last tick's seat is kept while it is among the stands its job fills now
 * (so a death elsewhere doesn't shuffle everyone); a job whose stands are full hands the member to its next. Defenders in id order.
 * Rehearsal 13:45: by nearest stand alone, a lone bomber who had stood on the roof took the roof's seat and the gate had none.
 */
export function defenceSeats(plan: Pick<DefencePlan, 'stands'>, defenders: readonly Defender[], prev?: ReadonlyMap<number, string>): Map<number, DefenceStand> {
    const free = new Map(plan.stands.map(s => [s.label, s.seats]));
    const out = new Map<number, DefenceStand>();
    const take = (id: number, s: DefenceStand) => { out.set(id, s); free.set(s.label, free.get(s.label)! - 1); };
    const alive = defenders.filter(d => d.alive).slice().sort((a, b) => a.id - b.id);
    // The stands each job fills now: in order of need, as many seats as members put that job first.
    const wanted = new Map<DefenceJob, number>();
    for (const d of alive) if (d.jobs[0]) wanted.set(d.jobs[0], (wanted.get(d.jobs[0]) ?? 0) + 1);
    const filled = new Set<string>();
    for (const [job, n] of wanted) {
        let left = n;
        for (const s of plan.stands) if (s.job === job && left > 0) { filled.add(s.label); left -= s.seats; }
    }
    for (const d of alive) {
        const label = prev?.get(d.id);
        const s = label ? plan.stands.find(x => x.label === label) : undefined;
        if (s && d.jobs[0] === s.job && filled.has(s.label) && (free.get(s.label) ?? 0) > 0) take(d.id, s);
    }
    const maxJobs = Math.max(0, ...alive.map(d => d.jobs.length));
    for (let k = 0; k < maxJobs; k++) {
        for (const job of new Set(alive.map(d => d.jobs[k]).filter((j): j is DefenceJob => !!j))) {
            const takers = alive.filter(d => !out.has(d.id) && d.jobs[k] === job);
            for (const s of plan.stands) {
                if (s.job !== job) continue;
                while ((free.get(s.label) ?? 0) > 0 && takers.length) {
                    const i = takers.reduce((best, d, j) => Math.hypot(s.at.x - d.x, s.at.y - d.y) < Math.hypot(s.at.x - takers[best]!.x, s.at.y - takers[best]!.y) ? j : best, 0);
                    take(takers[i]!.id, s);
                    takers.splice(i, 1);
                }
            }
        }
    }
    return out;
}

/**
 * The defence for this tick: 'lost' once the keep isn't ours; 'roof' while foes stand by the lord (the courtyard and the healers
 * go up); else 'going' until HOLD_SHARE of the living stand on their stands, then 'holding'.
 */
export function defenceOrders(plan: DefencePlan, view: DefenceView): DefenceOrders {
    const roof = view.foes.filter(f => Math.hypot(f.x - plan.lord.x, f.y - plan.lord.y, f.z - plan.lord.z) <= ROOF_THREAT).length;
    const inside = view.foes.filter(f => insideOf(plan.centre, f)).length - roof;
    const outside = view.foes.length - inside - roof;
    const threat = { outside, inside, roof };
    if (view.owner !== plan.realm) return { phase: 'lost', seats: new Map(), threat, why: `the keep is ${view.owner || 'nobody'}'s` };
    const seats = defenceSeats(plan, view.defenders, view.seats);
    if (roof > 0) {
        const up: DefenceStand = { label: 'roof', job: 'yard', at: plan.roof, seats: 0, leash: 400 };
        for (const [id, s] of seats) if (s.job === 'yard' || s.job === 'heal') seats.set(id, up);
        return { phase: 'roof', seats, threat, why: `${roof} by the lord: the courtyard and the healers to the roof` };
    }
    const alive = view.defenders.filter(d => d.alive);
    const on = alive.filter(d => {
        const s = seats.get(d.id);
        return s && Math.hypot(s.at.x - d.x, s.at.y - d.y) <= ON_STAND && Math.abs(s.at.z - d.z) <= DEFENCE_ON_Z;
    }).length;
    const holding = alive.length > 0 && on >= HOLD_SHARE * alive.length;
    return { phase: holding ? 'holding' : 'going', seats, threat, why: `${on}/${alive.length} on their stands; ${outside} outside, ${inside} inside` };
}

/**
 * How far from the keep's centre (2D) a defence fights: the walls (900-1100 out) and the gate's outside, where the melee break it
 * (34420, 1330 out). Rehearsal 2026-11-13 13:39: with no limit the defenders engaged two attackers at the stage, 3200 out, and
 * walked out to them; the keep's defence fights what comes to the keep.
 */
export const DEFENCE_REACH = 1450;

/** Whether a foe is the defence's to fight: within DEFENCE_REACH of the keep, or by the lord (any height). */
export function inDefenceReach(plan: Pick<DefencePlan, 'centre'>, foe: Point): boolean {
    return Math.hypot(foe.x - plan.centre.x, foe.y - plan.centre.y) <= DEFENCE_REACH;
}

/**
 * The rest of the way in from `at`: the realm's bank and bridge to the stage (as routeFrom), then the entry outside the gate.
 * Empty inside the walls or at the entry: from there walk to the stand itself, through our own doors.
 */
export function defenceRouteFrom(plan: DefencePlan, at: Point3): Point3[] {
    if (insideOf(plan.centre, at) || Math.hypot(at.x - plan.entry.x, at.y - plan.entry.y) <= AT_SPOT) return [];
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

/**
 * Open our own keep's doors to this process's walks (applyDoors with ours): call it each tick of the defence, with the doors seen
 * broken. Without a mesh it only registers them, and walkTo still goes through them by interact.
 */
export function openOwnDoors(plan: Pick<DefencePlan, 'keep' | 'regionId' | 'doors' | 'lord'>, broken: readonly number[] = [], store: NavmeshStore = getNavmeshStore()): void {
    const layout = { keep: plan.keep, regionId: plan.regionId, doors: plan.doors };
    const mesh = store.available() ? store.at(plan.regionId, plan.lord.x, plan.lord.y) : null;
    if (mesh) applyDoors(layout, { ours: true, broken }, mesh);
    else useOwnDoors(layout, { ours: true, broken });
}

// ── Out of the walls' sight (wallSight) ──────────────────────────────────────

const sightCache = new Map<string, string[]>();

/**
 * The wall casters and roof archers of the keep at `p` that see it within their aggro (lineOfSight with the walls, from each post),
 * by label. Empty off every layout, with nothing in sight, or for a keep that is ours (the caller knows the owner). Cached per 50
 * units. For a stand, a rest or a healer's step during a raid: where it is empty no static guard casts at us (live 16:43, the user
 * in hibernia's raid: Amergin killed by wall-e-n's Runemaster at (35170, 36949), 1420 from it, seen through a merlon gap).
 */
export function wallSight(regionId: number, p: Point3, ours = false): string[] {
    if (ours) return [];
    const keep = keepAt(regionId, p);
    const layout = keep ? SIEGE_LAYOUTS[keep.name] : undefined;
    if (!layout || layout.regionId !== regionId) return [];
    const key = `${layout.keep}|${Math.round(p.x / 50)},${Math.round(p.y / 50)},${Math.round(p.z / 50)}`;
    const known = sightCache.get(key);
    if (known) return known;
    const out = layout.targets
        .filter(t => (t.kind === 'caster' || t.kind === 'archer') && Math.hypot(t.at.x - p.x, t.at.y - p.y, t.at.z - p.z) <= t.aggro && lineOfSight(regionId, t.at, p))
        .map(t => t.label);
    sightCache.set(key, out);
    return out;
}

/**
 * Doors a living member stands behind (SiegeDoor.behind): passed, so broken (or ours). On the island there is no other way into
 * the courtyard or the building, and our walks treat a shut door as a wall. For a raid's own broken list, beside its chat.
 */
export function passedDoors(plan: Pick<RaidPlan, 'keep'>, members: readonly RaidMember[]): number[] {
    const layout = SIEGE_LAYOUTS[plan.keep];
    if (!layout) return [];
    const inside = (b: NonNullable<SiegeDoor['behind']>, p: Point) => 'box' in b
        ? p.x >= b.box[0] && p.y >= b.box[1] && p.x <= b.box[2] && p.y <= b.box[3]
        : Math.hypot(p.x - b.centre.x, p.y - b.centre.y) <= b.r;
    return layout.doors.filter(d => d.behind && members.some(m => m.alive && inside(d.behind!, m))).map(d => d.id);
}
