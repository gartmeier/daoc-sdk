// Mover: owns our position and streams 0xA9 position updates.
//
// - 0xA9 every 200 ms while moving and at least every 1000 ms idle; the server
//   soft-linkdeads after 5 s without one (PlayerMovementComponent.cs:15,52-61).
// - Steps stay under speedFactor × maxSpeed so the speed monitor
//   (gameutils/PlayerMovementMonitor.cs:56-130, tolerance ×1.15) never trips.
// - zoneId comes from the zone table (data/zones.ts); an unknown zone id kicks us
//   to the character screen (PlayerPositionUpdateHandler.cs:91-103), so we never send one.
// - Server corrections (0x04 / 0x20) snap the local position.

import type { MovementState, Vec3 } from '../sdk/types';
import { getZoneAt } from '../data/zones';
import { encodePositionUpdate, StateFlags, ActionFlags } from './protocol/outgoing';

export const PLAYER_BASE_SPEED = 191;
export const MOVE_INTERVAL_MS = 200;
export const IDLE_INTERVAL_MS = 1000;
/** Sent positions kept for isHeightNudge; the nudge answers one of the last few 0xA9 (one round trip). */
const RECENT_SENT_KEPT = 4;

/** DAoC heading (0 = +Y, clockwise, 4096 per turn) from a delta, as Point2D.GetHeading (world/Point2D.cs:95-112). */
export function headingFromDelta(dx: number, dy: number): number {
    let h = Math.atan2(-dx, dy) * (4096 / (2 * Math.PI));
    if (h < 0) h += 4096;
    return Math.floor(h) & 0xFFF;
}

export function headingTo(from: { x: number; y: number }, to: { x: number; y: number }): number {
    return headingFromDelta(to.x - from.x, to.y - from.y);
}

/** Point at heading/distance (Point2D.GetPointFromHeading). */
export function pointFromHeading(x: number, y: number, heading: number, distance: number): { x: number; y: number } {
    const a = (heading * 2 * Math.PI) / 4096;
    return { x: x - Math.sin(a) * distance, y: y + Math.cos(a) * distance };
}

export type StopReason = NonNullable<MovementState['lastStopReason']>;

export interface MoveOptions {
    waypoints?: Vec3[];
    tolerance?: number;
    speedFactor?: number;
    /** z for the final waypoint when the destination has none (e.g. a nearby object's z). */
    finalZ?: number;
}

interface Waypoint {
    x: number;
    y: number;
    z: number | undefined;
}

export interface MoverDeps {
    send(code: number, payload: Uint8Array): void;
    now?: () => number;
    log?: (msg: string) => void;
    /** Run the internal 100 ms timer (default true; tests drive pump() themselves). */
    timer?: boolean;
    /**
     * Ground under (x, y) on the layer nearest zHint (sdk/ground.ts moverGround). When set, every step
     * and every server snap takes z from it instead of interpolating between waypoints, and the swim
     * state flag follows it. Null means unknown there: keep the interpolated z.
     */
    ground?: (regionId: number, x: number, y: number, zHint: number) => { z: number; swimming: boolean } | null;
    /** The character is dead: every 0xA9 carries the DEAD state. */
    isDead?: () => boolean;
}

/** A segment that climbs more than this and twice its length is a ladder/off-mesh hop: keep its interpolated z. */
const HOP_MIN_RISE = 48;

export class Mover {
    regionId = 0;
    x = 0;
    y = 0;
    z = 0;
    heading = 0;
    speed = 0;
    maxSpeedPercent = 100;
    zoneId: number | null = null;

    objectId = 0;
    sessionId = 0;
    healthPercent = 100;
    sitting = false;
    /** In deep water (from deps.ground): 0xA9 carries the SWIMMING state flag instead of SITTING. */
    swimming = false;
    targetInView = true;

    moving = false;
    private waypoints: Waypoint[] = [];
    private tolerance = 16;
    private speedFactor = 0.9;
    private segmentStart: Vec3 = { x: 0, y: 0, z: 0 };
    lastStopReason: MovementState['lastStopReason'] = null;
    correctionCount = 0;
    /** While > now, XY is frozen (casting). */
    private holdUntil = 0;

    private timer: ReturnType<typeof setInterval> | null = null;
    private lastStepAt = 0;
    private lastSentAt = 0;
    private enabled = false;
    sentCount = 0;
    /** The last few positions we sent in 0xA9, newest last (see isHeightNudge). */
    private recentSent: Vec3[] = [];
    private readonly now: () => number;
    private stopListeners: Array<(reason: StopReason) => void> = [];

    constructor(private readonly deps: MoverDeps) {
        this.now = deps.now ?? Date.now;
    }

    get maxSpeed(): number {
        return (PLAYER_BASE_SPEED * this.maxSpeedPercent) / 100;
    }

    get position(): Vec3 {
        return { x: this.x, y: this.y, z: this.z };
    }

    onStop(fn: (reason: StopReason) => void): () => void {
        this.stopListeners.push(fn);
        return () => {
            this.stopListeners = this.stopListeners.filter(f => f !== fn);
        };
    }

    /**
     * Set position from the server (0x20 / 0x04) and stop any move. A server move (reason 'teleported'
     * or 'regionChange') also stands us up: GamePlayer.MoveTo sets IsSitting = false and sends no 0xAD
     * (GamePlayer.cs:7900-7910), so the SITTING state flag must go too.
     */
    snap(regionId: number, x: number, y: number, z: number, heading: number, reason: StopReason | null = 'teleported'): void {
        const wasMoving = this.moving;
        if (reason === 'teleported' || reason === 'regionChange') this.sitting = false;
        this.regionId = regionId;
        this.x = x;
        this.y = y;
        this.z = z;
        this.heading = heading & 0xFFF;
        this.updateZone();
        this.swimming = false;
        this.reground(false);
        if (reason === 'teleported') this.correctionCount++;
        if (wasMoving || reason === 'teleported') this.finish(reason ?? 'stopped', true);
    }

    /**
     * True when a non-heading 0x04 is the IsDiving height nudge rather than a MoveTo: underwater in a
     * zone without diving, the IsDiving setter (run from ProcessActionFlags on every 0xA9, before the new
     * position is applied) does `Z += 1; SendPlayerJump(false)` and returns (GamePlayer.cs:8378-8384,
     * PlayerPositionUpdateHandler.cs:78/669). XY is the position of one of our recent 0xA9 (the server
     * stores it as an int), Z is one higher. It neither moves us elsewhere nor touches IsSitting.
     */
    isHeightNudge(x: number, y: number, z: number): boolean {
        return this.recentSent.some(p => Math.abs(p.x - x) <= 1.5 && Math.abs(p.y - y) <= 1.5 && z - p.z > 0 && z - p.z <= 2.5);
    }

    /** Start the 0xA9 stream (call right after 0x2D GameOpenReply). Sends the first update immediately. */
    start(): void {
        this.enabled = true;
        this.lastStepAt = this.now();
        this.sendUpdate();
        if (!this.timer && this.deps.timer !== false) this.timer = setInterval(() => this.pump(), MOVE_INTERVAL_MS / 2);
    }

    /** Pause the stream (region change, quit). */
    pause(): void {
        this.enabled = false;
    }

    resume(): void {
        if (!this.timer && this.deps.timer !== false) {
            this.start();
            return;
        }
        this.enabled = true;
        this.lastStepAt = this.now();
        this.sendUpdate();
    }

    dispose(): void {
        this.enabled = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    get isStreaming(): boolean {
        return this.enabled;
    }

    /** ms since the last 0xA9 we sent (Infinity before the first). */
    msSinceLastSend(): number {
        return this.sentCount === 0 ? Infinity : this.now() - this.lastSentAt;
    }

    moveTo(target: Vec3 | { x: number; y: number; z?: number }, opts: MoveOptions = {}): void {
        const list: Waypoint[] = [];
        for (const w of opts.waypoints ?? []) list.push({ x: w.x, y: w.y, z: w.z });
        const last = list[list.length - 1];
        if (!last || Math.hypot(last.x - target.x, last.y - target.y) > 1) {
            list.push({ x: target.x, y: target.y, z: target.z ?? opts.finalZ });
        } else if (last.z === undefined) {
            last.z = target.z ?? opts.finalZ;
        }
        this.waypoints = list;
        this.tolerance = Math.max(1, opts.tolerance ?? 16);
        this.speedFactor = Math.min(1, Math.max(0.05, opts.speedFactor ?? 0.9));
        this.segmentStart = this.position;
        this.lastStopReason = null;
        const first = this.waypoints[0]!;
        // atan2(0, 0) would turn us to heading 0 when the target is where we stand.
        if (Math.hypot(first.x - this.x, first.y - this.y) >= 1) this.heading = headingTo(this, first);
        if (!this.moving) {
            this.moving = true;
            this.lastStepAt = this.now();
        }
        this.sitting = false;
    }

    stop(reason: StopReason = 'stopped'): void {
        if (!this.moving) return;
        this.finish(reason, false);
    }

    face(heading: number): void {
        this.heading = heading & 0xFFF;
        this.sendUpdate();
    }

    faceTowards(p: { x: number; y: number }): void {
        if (Math.hypot(p.x - this.x, p.y - this.y) < 1) return;
        this.face(headingTo(this, p));
    }

    /** Keep XY fixed for `ms` (a cast is running). Stops any current move. */
    holdPosition(ms: number): void {
        if (this.moving) this.finish('stopped', false);
        this.holdUntil = Math.max(this.holdUntil, this.now() + ms);
    }

    get holding(): boolean {
        return this.holdUntil > this.now();
    }

    get destination(): Vec3 | null {
        const w = this.waypoints[this.waypoints.length - 1];
        return w ? { x: w.x, y: w.y, z: w.z ?? this.z } : null;
    }

    state(): MovementState {
        return {
            moving: this.moving,
            destination: this.moving ? this.destination : null,
            waypoints: this.moving ? this.waypoints.map(w => ({ x: w.x, y: w.y, z: w.z ?? this.z })) : [],
            lastStopReason: this.lastStopReason,
            correctionCount: this.correctionCount,
            swimming: this.swimming,
        };
    }

    private finish(reason: StopReason, fromSnap: boolean): void {
        const was = this.moving;
        this.moving = false;
        this.waypoints = [];
        this.speed = 0;
        this.lastStopReason = reason;
        if (!fromSnap) this.sendUpdate();
        if (was || reason === 'teleported') for (const fn of this.stopListeners) fn(reason);
    }

    /** Advance movement and send a due 0xA9 (driven by the internal timer; public for tests). */
    pump(): void {
        if (!this.enabled) return;
        const now = this.now();
        if (this.moving && !this.holding) {
            if (now - this.lastStepAt >= MOVE_INTERVAL_MS - 5) {
                this.step(now);
                if (this.enabled) this.sendUpdate();
            }
            return;
        }
        this.lastStepAt = now;
        if (now - this.lastSentAt >= IDLE_INTERVAL_MS) this.sendUpdate();
    }

    private step(now: number): void {
        const dt = Math.min(500, now - this.lastStepAt) / 1000;
        this.lastStepAt = now;
        const speed = this.maxSpeed * this.speedFactor;
        let budget = speed * dt;
        this.speed = speed;
        while (budget > 0 && this.waypoints.length > 0) {
            const w = this.waypoints[0]!;
            const isLast = this.waypoints.length === 1;
            const dx = w.x - this.x;
            const dy = w.y - this.y;
            const d = Math.hypot(dx, dy);
            const tol = isLast ? this.tolerance : 1;
            if (d <= tol) {
                this.arriveAt(w, isLast);
                continue;
            }
            const advance = Math.min(budget, isLast ? d - Math.min(tol * 0.5, d) : d);
            const f = advance / d;
            this.x += dx * f;
            this.y += dy * f;
            if (w.z !== undefined) {
                const segLen = Math.hypot(w.x - this.segmentStart.x, w.y - this.segmentStart.y) || 1;
                const remaining = Math.hypot(w.x - this.x, w.y - this.y);
                const t = Math.min(1, Math.max(0, 1 - remaining / segLen));
                this.z = this.segmentStart.z + (w.z - this.segmentStart.z) * t;
            }
            this.heading = headingFromDelta(dx, dy);
            budget -= advance;
            if (Math.hypot(w.x - this.x, w.y - this.y) <= tol + 0.01) this.arriveAt(w, isLast);
        }
        this.updateZone();
        this.reground(true);
        if (this.waypoints.length === 0 && this.moving) this.finish('arrived', false);
    }

    /**
     * Take z (and the swim state) from deps.ground, with the current z as the layer hint. During a
     * move z is the waypoint interpolation up to here; ladder hops (skipHops) keep it.
     */
    private reground(skipHops: boolean): void {
        const ground = this.deps.ground;
        if (!ground) return;
        const w = this.waypoints[0];
        if (skipHops && w?.z !== undefined) {
            const rise = Math.abs(w.z - this.segmentStart.z);
            if (rise > HOP_MIN_RISE && rise > 2 * Math.hypot(w.x - this.segmentStart.x, w.y - this.segmentStart.y)) return;
        }
        const g = ground(this.regionId, this.x, this.y, this.z);
        if (!g) return;
        this.z = g.z;
        this.swimming = g.swimming;
        if (g.swimming) this.sitting = false;
    }

    private arriveAt(w: Waypoint, isLast: boolean): void {
        if (!isLast) {
            this.x = w.x;
            this.y = w.y;
        }
        if (w.z !== undefined) this.z = w.z;
        this.waypoints.shift();
        this.segmentStart = this.position;
        const next = this.waypoints[0];
        if (next) this.heading = headingTo(this, next);
    }

    private updateZone(): void {
        const z = getZoneAt(this.regionId, this.x, this.y);
        if (z) this.zoneId = z.id;
        else this.deps.log?.(`no zone for region ${this.regionId} at ${Math.round(this.x)},${Math.round(this.y)}; keeping zone ${this.zoneId}`);
    }

    /** Send one 0xA9 now (no-op until started or when no valid zone is known). */
    sendUpdate(): void {
        if (!this.enabled) return;
        if (this.zoneId === null) this.updateZone();
        if (this.zoneId === null) return; // never send an unknown zone id
        const payload = encodePositionUpdate({
            x: this.x,
            y: this.y,
            z: this.z,
            speed: this.moving && !this.holding ? this.speed : 0,
            sessionId: this.sessionId,
            objectId: this.objectId,
            zoneId: this.zoneId,
            // The server relays this byte as is and never sets DEAD itself (PlayerPositionUpdateHandler.cs:415,
            // no IsAlive check), so without it viewers get a standing player at 0 % once a second, which a
            // real client shows dying and vanishing over and over. Otherwise never both: SWIMMING|SITTING
            // reads as DEAD, and SWIMMING|JUMPING as FLYING (an autoban under ban_hackers; ProcessStateFlags).
            stateFlags: this.deps.isDead?.() ? StateFlags.Dead : this.swimming ? StateFlags.Swimming : this.sitting ? StateFlags.Sitting : 0,
            fallingDamage: 0x8000,
            heading: this.heading,
            actionFlags: this.targetInView ? ActionFlags.TargetInView : 0,
            healthPercent: this.healthPercent,
        });
        this.lastSentAt = this.now();
        this.sentCount++;
        this.recentSent.push({ x: this.x, y: this.y, z: this.z });
        if (this.recentSent.length > RECENT_SENT_KEPT) this.recentSent.shift();
        this.deps.send(0xA9, payload);
    }
}
