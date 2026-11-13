// Our own keep's doors, used as a player uses them. A door opens to nobody: a player of the keep's realm goes through by
// interacting with it (GameKeepDoor.Interact, also "enter"/"exit" said at it), and the server puts them on its other side,
// 150 past a gate (DoorIndex 1, DoorId % 10) or 100 past any other door, at the door's z (no keep components, as at
// Thidranki Faste). The server checks no movement, so a bot could walk through a shut door; a real client can't.
//
// Who knows that a keep is ours (siege.ts applyDoors, from the owner read) registers its doors here, per process, the way it
// opens them on the navmesh. walkTo (actions.ts route) then stops before each registered door its route passes, interacts, and
// watches for the jump. Live on a throwaway 2026-11-13: at 116 out from the Faste's gate the jump came in 47 ms, to 150 inside.

import type { Vec3 } from './types';

export interface OwnDoor {
    /** DbDoor InternalID (NearbyObject.doorId). */
    doorId: number;
    /** The door's spot, as the door table and its object have it. */
    at: Vec3;
    /** Its heading (0..4095): its front, where the heading points, is the keep's inside. */
    heading: number;
}

/** How far the server puts a player past the door (GameKeepDoor.Interact): a gate 150, an inner door or postern 100. */
export const doorJump = (doorId: number) => doorId % 10 === 1 ? 150 : 100;
/** Where we stand to use a door: this far out on our side, well within the server's 192 (WorldMgr.INTERACT_DISTANCE, 3D). */
export const DOOR_NEAR = 90;
/** The server's reach for the interact (GameObject.Interact, 3D). */
export const DOOR_REACH = 192;
/** A route goes through a door where it crosses the door's plane within this of its spot, sideways ... */
export const DOOR_HALF_WIDTH = 160;
/** ... and within this of its z: the wall-walk over a gate (256 up) passes above it. */
export const DOOR_Z = 120;

const registry = new Map<number, Map<string, OwnDoor[]>>();

type DoorRealm = 'albion' | 'midgard' | 'hibernia';
/**
 * The battlegrounds' portal keeps' doors (the door table, 2026-11-13; regions 250-253, each a gate then an inner door). A portal
 * keep never changes hands, so its realm's doors are always ours to open and the others' always shut to us: no caller registers
 * them. The user, playing in Thidranki 2026-11-13: "bots do still walk through the door. Humans have to click the first and then
 * the second door."
 */
export const PORTAL_DOORS: Record<number, Record<DoorRealm, OwnDoor[]>> = {
    250: {
        albion: [{ doorId: 250000101, at: { x: 36919, y: 51655, z: 4004 }, heading: 41 }, { doorId: 250000102, at: { x: 36926, y: 52087, z: 4010 }, heading: 2015 }],
        midgard: [{ doorId: 250000201, at: { x: 53506, y: 25603, z: 4295 }, heading: 2268 }, { doorId: 250000202, at: { x: 53641, y: 25261, z: 4307 }, heading: 273 }],
        hibernia: [{ doorId: 250041601, at: { x: 19270, y: 18868, z: 4317 }, heading: 1486 }, { doorId: 250041602, at: { x: 18817, y: 18486, z: 4320 }, heading: 3531 }],
    },
    251: {
        albion: [{ doorId: 251000101, at: { x: 36919, y: 51665, z: 4010 }, heading: 4087 }, { doorId: 251000102, at: { x: 36917, y: 52074, z: 4010 }, heading: 2053 }],
        midgard: [{ doorId: 251000201, at: { x: 53509, y: 25583, z: 4296 }, heading: 2315 }, { doorId: 251000202, at: { x: 53653, y: 25256, z: 4308 }, heading: 300 }],
        hibernia: [{ doorId: 251041601, at: { x: 19263, y: 18884, z: 4317 }, heading: 1482 }, { doorId: 251041602, at: { x: 18821, y: 18479, z: 4320 }, heading: 3581 }],
    },
    252: {
        albion: [{ doorId: 252000101, at: { x: 36921, y: 51730, z: 4010 }, heading: 2046 }, { doorId: 252000102, at: { x: 36922, y: 52062, z: 4010 }, heading: 2031 }],
        midgard: [{ doorId: 252000201, at: { x: 53526, y: 25571, z: 4305 }, heading: 2256 }, { doorId: 252000202, at: { x: 53636, y: 25273, z: 4320 }, heading: 155 }],
        hibernia: [{ doorId: 252041601, at: { x: 19264, y: 18822, z: 4319 }, heading: 1444 }, { doorId: 252041602, at: { x: 18871, y: 18533, z: 4320 }, heading: 1474 }],
    },
    253: {
        albion: [{ doorId: 253000101, at: { x: 36923, y: 51689, z: 4010 }, heading: 19 }, { doorId: 253000102, at: { x: 36927, y: 52085, z: 4010 }, heading: 2088 }],
        midgard: [{ doorId: 253000201, at: { x: 53512, y: 25597, z: 4296 }, heading: 2331 }, { doorId: 253000202, at: { x: 53649, y: 25241, z: 4308 }, heading: 264 }],
        hibernia: [{ doorId: 253041601, at: { x: 19257, y: 18865, z: 4318 }, heading: 1469 }, { doorId: 253041602, at: { x: 18807, y: 18470, z: 4320 }, heading: 3591 }],
    },
};

const realmOf = (realm: string | undefined): DoorRealm | null => {
    const r = realm?.toLowerCase();
    return r === 'albion' || r === 'midgard' || r === 'hibernia' ? r : null;
};

/** Our realm's portal keep doors in `regionId` (none for another region or no realm). */
export function portalDoorsOf(regionId: number, realm: string | undefined): OwnDoor[] {
    const r = realmOf(realm);
    return r ? PORTAL_DOORS[regionId]?.[r] ?? [] : [];
}

/** The other realms' portal keep doors in `regionId`: always shut to us. */
function enemyPortalDoors(regionId: number, realm: string | undefined): OwnDoor[] {
    const r = realmOf(realm);
    const all = PORTAL_DOORS[regionId];
    if (!all || !r) return [];
    return (Object.keys(all) as DoorRealm[]).filter(k => k !== r).flatMap(k => all[k]);
}
/** Doors that are walls to us (an enemy keep's, unbroken), by region and keep: no straight move goes through one. */
const shut = new Map<number, Map<string, OwnDoor[]>>();

/** The doors under `key` in `regionId` are shut to us now (an enemy keep's, unbroken). Empty clears. */
export function setShutDoors(regionId: number, key: string, doors: readonly OwnDoor[]): void {
    let byKey = shut.get(regionId);
    if (!byKey) shut.set(regionId, byKey = new Map());
    if (doors.length) byKey.set(key, doors.slice());
    else byKey.delete(key);
}

/** Every door that is a wall to us in `regionId`: those registered shut, and with our `realm` the other realms' portal keeps'. */
export function shutDoorsIn(regionId: number, realm?: string): OwnDoor[] {
    const byKey = shut.get(regionId);
    const registered = byKey ? [...byKey.values()].flat() : [];
    const enemy = enemyPortalDoors(regionId, realm);
    return enemy.length ? [...registered, ...enemy] : registered;
}

/**
 * A door the straight move from `from` to `to` would pass through: one of ours (a real client goes through it only by
 * interacting, which a chase doesn't) or one shut to us. Null when none: the move is as good as before.
 */
export function doorBetween(regionId: number, from: Vec3, to: Vec3, realm?: string): OwnDoor | null {
    const doors = [...ownDoors(regionId, realm), ...shutDoorsIn(regionId, realm)];
    return doors.length ? doorOnRoute(from, [to], doors)?.door ?? null : null;
}

/** The doors under `key` (a keep's name) in `regionId` are ours now: every later walk in this process uses them. Empty clears. */
export function setOwnDoors(regionId: number, key: string, doors: readonly OwnDoor[]): void {
    let byKey = registry.get(regionId);
    if (!byKey) registry.set(regionId, byKey = new Map());
    if (doors.length) byKey.set(key, doors.slice());
    else byKey.delete(key);
}

/** Every door we use by interacting in `regionId`: those registered (our keep), and with our `realm` our portal keep's. */
export function ownDoors(regionId: number, realm?: string): OwnDoor[] {
    const byKey = registry.get(regionId);
    const registered = byKey ? [...byKey.values()].flat() : [];
    const portal = portalDoorsOf(regionId, realm).filter(d => !dropped.has(d.doorId));
    return portal.length ? [...registered, ...portal] : registered;
}

/** Portal keep doors that didn't open for us this process (dropOwnDoor): not tried again. */
const dropped = new Set<number>();

/** Forget one door: it didn't let us through, so it isn't ours (any more). */
export function dropOwnDoor(regionId: number, doorId: number): void {
    if (Object.values(PORTAL_DOORS[regionId] ?? {}).some(list => list.some(d => d.doorId === doorId))) dropped.add(doorId);
    const byKey = registry.get(regionId);
    if (!byKey) return;
    for (const [key, doors] of byKey) {
        const left = doors.filter(d => d.doorId !== doorId);
        if (left.length) byKey.set(key, left);
        else byKey.delete(key);
    }
}

/** Forget them all (tests). */
export function clearOwnDoors(): void {
    registry.clear();
    shut.clear();
    dropped.clear();
}

/** The door's front as a unit vector on the ground (Point2D.GetPointFromHeading: x - sin, y + cos). */
export function doorFront(heading: number): { x: number; y: number } {
    const a = heading * Math.PI * 2 / 4096;
    return { x: -Math.sin(a), y: Math.cos(a) };
}

const along = (door: OwnDoor, p: { x: number; y: number }) => {
    const f = doorFront(door.heading);
    return (p.x - door.at.x) * f.x + (p.y - door.at.y) * f.y;
};
const across = (door: OwnDoor, p: { x: number; y: number }) => {
    const f = doorFront(door.heading);
    return (p.x - door.at.x) * -f.y + (p.y - door.at.y) * f.x;
};

/** The side of the door `p` stands on: 1 in front (inside), -1 behind (outside). The server's own test is the front half. */
export function doorSide(door: OwnDoor, p: { x: number; y: number }): 1 | -1 {
    return along(door, p) >= 0 ? 1 : -1;
}

/** Where to stand to use the door from `side`. */
export function doorApproach(door: OwnDoor, side: 1 | -1): Vec3 {
    const f = doorFront(door.heading);
    return { x: Math.round(door.at.x + f.x * DOOR_NEAR * side), y: Math.round(door.at.y + f.y * DOOR_NEAR * side), z: door.at.z };
}

/** Where the server puts a player who uses the door from `side`: its jump past the door on the other side. */
export function doorLanding(door: OwnDoor, side: 1 | -1): Vec3 {
    const f = doorFront(door.heading);
    const d = doorJump(door.doorId) * -side;
    return { x: Math.round(door.at.x + f.x * d), y: Math.round(door.at.y + f.y * d), z: door.at.z };
}

/** A door the route passes: the index in `points` of the leg that crosses it (from the point before, or from `from`), and our side. */
export interface DoorOnRoute {
    door: OwnDoor;
    index: number;
    side: 1 | -1;
}

/**
 * The first of `doors` the route from `from` through `points` goes through: a leg that crosses its plane (strictly, one end on
 * each side) within DOOR_HALF_WIDTH of its spot and DOOR_Z of its z. Of two doors on one leg, the nearer crossing; at one spot,
 * the nearer z (the Faste's posterns 304 and 306 share x and y, 24 apart in z). Null when it passes none.
 */
export function doorOnRoute(from: Vec3, points: readonly Vec3[], doors: readonly OwnDoor[]): DoorOnRoute | null {
    let prev = from;
    for (let i = 0; i < points.length; i++) {
        const next = points[i]!;
        let best: { door: OwnDoor; t: number; dz: number; side: 1 | -1 } | null = null;
        for (const door of doors) {
            const a = along(door, prev);
            const b = along(door, next);
            if (!(a * b < 0)) continue;
            const t = a / (a - b);
            const c = { x: prev.x + (next.x - prev.x) * t, y: prev.y + (next.y - prev.y) * t, z: prev.z + (next.z - prev.z) * t };
            if (Math.abs(across(door, c)) > DOOR_HALF_WIDTH) continue;
            const dz = Math.abs(c.z - door.at.z);
            if (dz > DOOR_Z) continue;
            if (!best || t < best.t - 0.01 || (Math.abs(t - best.t) <= 0.01 && dz < best.dz)) best = { door, t, dz, side: a > 0 ? 1 : -1 };
        }
        if (best) return { door: best.door, index: i, side: best.side };
        prev = next;
    }
    return null;
}
