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

/** The doors under `key` (a keep's name) in `regionId` are ours now: every later walk in this process uses them. Empty clears. */
export function setOwnDoors(regionId: number, key: string, doors: readonly OwnDoor[]): void {
    let byKey = registry.get(regionId);
    if (!byKey) registry.set(regionId, byKey = new Map());
    if (doors.length) byKey.set(key, doors.slice());
    else byKey.delete(key);
}

/** Every door we use by interacting in `regionId`. */
export function ownDoors(regionId: number): OwnDoor[] {
    const byKey = registry.get(regionId);
    return byKey ? [...byKey.values()].flat() : [];
}

/** Forget one door: it didn't let us through, so it isn't ours (any more). */
export function dropOwnDoor(regionId: number, doorId: number): void {
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
