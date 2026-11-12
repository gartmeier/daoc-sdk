// Human-like sight: what a player at the keyboard would notice of an enemy.
//
// The server sends every object within its visibility range whatever way we face and whatever
// stands between, so a client
// that reads its object list knows what's behind it and behind every hill. A human sees the
// screen: a cone ahead of the camera, cut off by the ground.
//
// The model here, for one viewer and one target:
//   - within awareRadius it is noticed whatever the facing or the ground (nameplates, footsteps, sound);
//   - farther off it must be inside the view cone (fovDegrees, centred on the viewer's heading),
//   - and the sight line from the viewer's eyes to the target's chest must clear the terrain.
// The terrain is the client's own heightmap (server/navmesh/zoneNNN.terrain, sdk/terrain.ts):
// hills and ridges block, keep walls, buildings and trees don't (they aren't in it). Where a zone
// has no .terrain (a city, a dungeon, a checkout without it), nothing blocks.
//
// What hits us is known whatever this says: that part is up to the caller (observeState).
//
// In a fight a player watches the fight, not the field (inFightVision): with a skill (sdk/group/skill.ts fightAttention)
// a member that fights narrows its cone and aware radius and is slower to notice an enemy new to its view.
//
// Noticing takes a moment: a member reports an enemy only once it has had it in view for noticeMs, which stands
// for spotting it and calling it out to the group (observeState keeps the clock per member).
//
// The same terrain answers the server's line-of-sight checks (0xD0) in the client (clientLineOfSight): our own
// casts, our pets' attacks and a monster's aggro on us are then cut off by hills as a real client's are.

import { getZoneAt } from '../data/zones';
import { getTerrainStore, sampleTerrain, type TerrainGrid } from './terrain';

export type VisionMode = 'omniscient' | 'human';

export interface VisionOptions {
    /** 'omniscient': everything the server sends (the old behaviour). 'human': the rules above. */
    mode: VisionMode;
    /** Noticed whatever the facing and the ground within this 2D distance (default 500). */
    awareRadius: number;
    /** Width of the view cone, degrees, centred on the heading (default 100). */
    fovDegrees: number;
    /** Eye height over the viewer's z (default 60). */
    eyeHeight: number;
    /** The point looked at, over the target's z (default 50). */
    targetHeight: number;
    /** Distance between terrain samples along the sight line (default 64; the heightmap grid is 256). */
    stepUnits: number;
    /** The ground must rise this far over the sight line to block it (default 0). */
    clearance: number;
    /**
     * An enemy seen (not one that hit us, nor our target) is reported only after it has been in this member's view this
     * long, ms: spotting it and calling it out (default 800). At most NOTICE_MAX_MS, so a member looking at a contact's
     * spot reports it before the board's forget rule (1500 ms unseen) drops it.
     */
    noticeMs: number;
}

/** The longest noticeMs: under the board's 1500 ms forget rule, with a snapshot (250 ms) to spare. */
export const NOTICE_MAX_MS = 1200;

export const HUMAN_VISION: VisionOptions = {
    mode: 'human',
    awareRadius: 500,
    fovDegrees: 100,
    eyeHeight: 60,
    targetHeight: 50,
    stepUnits: 64,
    clearance: 0,
    noticeMs: 800,
};

/**
 * Full options from a mode or a partial set (`'human'`, `{ mode: 'human', fovDegrees: 120 }`),
 * or null for omniscient sight. A partial set without a mode means human.
 */
export function resolveVision(v: VisionMode | Partial<VisionOptions> | null | undefined): VisionOptions | null {
    if (!v) return null;
    const opts: VisionOptions = typeof v === 'string' ? { ...HUMAN_VISION, mode: v } : { ...HUMAN_VISION, ...v };
    if (opts.mode !== 'human' && opts.mode !== 'omniscient') throw new Error(`vision mode '${String(opts.mode)}': expected 'human' or 'omniscient'`);
    if (!(opts.noticeMs >= 0 && opts.noticeMs <= NOTICE_MAX_MS)) throw new Error(`vision noticeMs ${opts.noticeMs}: expected 0..${NOTICE_MAX_MS}`);
    return opts.mode === 'human' ? opts : null;
}

/** Short text for logs and reports: "human (cone 100°, aware 500, notice 800 ms)". */
export function describeVision(v: VisionOptions | null): string {
    return v ? `human (cone ${v.fovDegrees}°, aware ${v.awareRadius}, notice ${v.noticeMs} ms)` : 'omniscient';
}

/**
 * How much a member that fights still watches the field: `focus` 0..1 scales its cone and aware radius (1 changes
 * nothing), and `extraNoticeMs` is added to noticeMs for an enemy new to its view. What swings or casts at it, and its
 * own target, stay known at once (observeState). Past NOTICE_MAX_MS observeState reports the ids still being noticed
 * (Observation.sight.pending), so the board's forget rule spares a contact the member hasn't taken in yet.
 */
export interface FightAttention {
    focus: number;
    extraNoticeMs: number;
}

/** The member's sight while it fights: `v` narrowed by `a`, or `v` itself when `a` changes nothing. */
export function inFightVision(v: VisionOptions, a: FightAttention): VisionOptions {
    const focus = Math.min(1, Math.max(0, a.focus));
    const extra = Math.max(0, a.extraNoticeMs);
    if (focus === 1 && extra === 0) return v;
    return { ...v, fovDegrees: Math.round(v.fovDegrees * focus), awareRadius: Math.round(v.awareRadius * focus), noticeMs: Math.round(v.noticeMs + extra) };
}

/** Fighting, for inFightVision: its own target set, and swinging or in combat (attacked, or casting at an enemy). */
export function fighting(p: { targetObjectId: number | null; inCombat: boolean; attacking?: boolean } | null | undefined): boolean {
    return !!p && p.targetObjectId !== null && (p.inCombat || !!p.attacking);
}

/**
 * When each enemy came into one member's view (noticed()), kept between its snapshots. An id out of view for
 * NOTICE_GRACE_MS starts over: one that ducked behind a hill for a moment is still known.
 */
export const NOTICE_GRACE_MS = 3000;
export type NoticeClock = Map<number, { first: number; last: number }>;

/** Seen at `now`: whether it has been in view noticeMs yet. Without a clock or with noticeMs 0, at once. */
export function noticed(clock: NoticeClock | undefined, id: number, now: number, noticeMs: number): boolean {
    if (!clock || noticeMs <= 0) return true;
    const was = clock.get(id);
    const held = was && now - was.last <= NOTICE_GRACE_MS ? was : { first: now, last: now };
    held.last = now;
    clock.set(id, held);
    return now - held.first >= noticeMs;
}

/** Drop what has been out of view longer than NOTICE_GRACE_MS. */
export function pruneNoticeClock(clock: NoticeClock, now: number): void {
    for (const [id, t] of clock) if (now - t.last > NOTICE_GRACE_MS) clock.delete(id);
}

export interface Viewer {
    regionId: number;
    x: number;
    y: number;
    z: number;
    /** DAoC heading, 0..4095, 0 = +Y, clockwise (headingBetween). */
    heading: number;
}

export interface Seen {
    x: number;
    y: number;
    z: number;
}

/** Ground height at a spot, or null where it isn't known (then it never blocks). */
export type GroundAt = (regionId: number, x: number, y: number) => number | null;

/** A zone's grid is asked of the store again after this: TerrainStore.forZone stats its file on every call, too slow for ~50 samples a sight line. */
const GRID_RECHECK_MS = 30_000;
const grids = new Map<number, { grid: TerrainGrid | null; at: number }>();

/** The client heightmaps (sdk/terrain.ts), each zone's grid kept GRID_RECHECK_MS between the store's file checks. */
export const terrainGround: GroundAt = (regionId, x, y) => {
    const zone = getZoneAt(regionId, x, y);
    if (!zone) return null;
    const now = Date.now();
    let held = grids.get(zone.id);
    if (!held || now - held.at > GRID_RECHECK_MS) grids.set(zone.id, held = { grid: getTerrainStore().forZone(zone.id), at: now });
    return held.grid ? sampleTerrain(held.grid, x, y)?.z ?? null : null;
};

/** Angle between the viewer's heading and the direction to `target`, degrees 0..180. */
export function offHeading(viewer: Viewer, target: { x: number; y: number }): number {
    const dx = target.x - viewer.x;
    const dy = target.y - viewer.y;
    if (dx === 0 && dy === 0) return 0;
    // headingBetween's convention: heading = atan2(-dx, dy) in 4096ths of a turn.
    const toTarget = Math.atan2(-dx, dy);
    const facing = (viewer.heading / 4096) * 2 * Math.PI;
    let d = Math.abs(toTarget - facing) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return (d * 180) / Math.PI;
}

/** Inside a view cone `fovDegrees` wide. */
export function inViewCone(viewer: Viewer, target: { x: number; y: number }, fovDegrees: number): boolean {
    return offHeading(viewer, target) <= fovDegrees / 2;
}

/**
 * The straight line from `from` to `to` (3D) clears the ground: no sample along it, one step
 * in from either end, has the ground above the line by more than `clearance`. The ends are
 * skipped so the slope a viewer stands on doesn't hide what's down it.
 */
export function sightLineClear(regionId: number, from: Seen, to: Seen, opts: Pick<VisionOptions, 'stepUnits' | 'clearance'>, ground: GroundAt = terrainGround): boolean {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.max(8, opts.stepUnits);
    for (let d = step; d < len - step; d += step) {
        const t = d / len;
        const x = from.x + t * (to.x - from.x);
        const y = from.y + t * (to.y - from.y);
        const g = ground(regionId, x, y);
        if (g === null) continue;
        const line = from.z + t * (to.z - from.z);
        if (g > line + opts.clearance) return false;
    }
    return true;
}

/** Why a target is or isn't seen (for tests, the viewer and logs). */
export type SightVerdict = 'aware' | 'seen' | 'behind' | 'blocked';

/** The rules above for one viewer and target, with the reason. */
export function sightOf(viewer: Viewer, target: Seen, opts: VisionOptions, ground: GroundAt = terrainGround): SightVerdict {
    if (Math.hypot(target.x - viewer.x, target.y - viewer.y) <= opts.awareRadius) return 'aware';
    if (!inViewCone(viewer, target, opts.fovDegrees)) return 'behind';
    const eye = { x: viewer.x, y: viewer.y, z: viewer.z + opts.eyeHeight };
    const at = { x: target.x, y: target.y, z: target.z + opts.targetHeight };
    return sightLineClear(viewer.regionId, eye, at, opts, ground) ? 'seen' : 'blocked';
}

/** True when the viewer notices the target (sightOf is 'aware' or 'seen'). */
export function canSee(viewer: Viewer, target: Seen, opts: VisionOptions, ground: GroundAt = terrainGround): boolean {
    const v = sightOf(viewer, target, opts, ground);
    return v === 'aware' || v === 'seen';
}

/** Line of sight over the terrain between two objects, whatever way either faces: `from`'s eyes to `to`'s chest. */
export function lineOfSight(regionId: number, from: Seen, to: Seen, ground: GroundAt = terrainGround, opts: Pick<VisionOptions, 'eyeHeight' | 'targetHeight' | 'stepUnits' | 'clearance'> = HUMAN_VISION): boolean {
    return sightLineClear(regionId, { x: from.x, y: from.y, z: from.z + opts.eyeHeight }, { x: to.x, y: to.y, z: to.z + opts.targetHeight }, opts, ground);
}

/**
 * The client's answer to the server's 0xD0 checks (lineOfSight on the client heightmaps), or undefined to answer
 * every check "clear" as before: with DAOC_LOS=clear (or off/0/false/no), or with no terrain built.
 */
export function clientLineOfSight(): ((regionId: number, from: Seen, to: Seen) => boolean) | undefined {
    if (/^(0|off|false|no|clear)$/i.test(process.env.DAOC_LOS ?? '')) return undefined;
    if (!getTerrainStore().available()) return undefined;
    return (regionId, from, to) => lineOfSight(regionId, from, to);
}
