// Mover: owns our position and streams 0xA9 position updates.
//
// - 0xA9 every 200 ms while moving and at least every 1000 ms idle; the server
//   soft-linkdeads after 5 s without one (PlayerMovementComponent.cs:15,52-61).
// - Full speed by default, like a real client (it ran a 0.9 margin until 2026-11-08, which a viewer
//   could tell at 171 against 191): the speed monitor allows ×1.15 plus one game tick
//   (gameutils/PlayerMovementMonitor.cs:56-130).
// - Off a downhill slope we fall like a real client instead of sliding down glued to it: gravity
//   FALL_GRAVITY, nothing pulling us onto the ground, and the vertical speed in the 0xA9's zSpeed,
//   which the server relays to every viewer (PlayerPositionUpdateHandler.cs:88, :697). Uphill and on
//   the flat z is the ground, as before.
// - Speed ramps like a real client's: up at RUN_ACCEL from 0, down at RUN_DECEL to rest at the end of
//   a move or on brake(), and the 0xA9 carries the speed of the moment. A re-issued move keeps its speed;
//   stop() (casting, sitting, server moves) still stops dead.
// - In deep water the limit is maxSwimSpeed: the server doesn't know about swimming (its monitor
//   only checks maxSpeed), a real client slows itself down, and so do we.
// - zoneId comes from the zone table (data/zones.ts); an unknown zone id kicks us
//   to the character screen (PlayerPositionUpdateHandler.cs:91-103), so we never send one.
// - Server corrections (0x04 / 0x20) snap the local position.

import type { MovementState, Vec3 } from '../sdk/types';
import { getZoneAt } from '../data/zones';
import { encodePositionUpdate, StateFlags, ActionFlags, HEADING_ON_GROUND } from './protocol/outgoing';

export const PLAYER_BASE_SPEED = 191;
/** A real client's swim speed at 100 % with water speed 0 (game.dll 0x4388d9). */
export const PLAYER_BASE_SWIM_SPEED = 85;
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
    ground?: (regionId: number, x: number, y: number, zHint: number) => { z: number; swimming: boolean; waterZ?: number } | null;
    /** The character is dead: every 0xA9 carries the DEAD state. */
    isDead?: () => boolean;
    /** We have a ground target: every 0xA9 says it is in view (see actionFlags). */
    hasGroundTarget?: () => boolean;
}

/** A segment that climbs more than this and twice its length is a ladder/off-mesh hop: keep its interpolated z. */
const HOP_MIN_RISE = 48;

/**
 * A real 1.127 client's gravity in units/s², with no pull onto the ground: fitted to Vue running down
 * the slope east of the Camelot Hills start at 191 (7 runs, bots/Movewatch/runs/at-191b.jsonl, client/dev/record-moves.ts).
 * Simulated at FALL_STEPS_PER_S it predicts the height in the air within about 2 units, and it is in the
 * air for 59 % of the updates downhill (up to 54 units over the slope), never uphill or on the flat.
 */
export const FALL_GRAVITY = 1000;
const FALL_STEPS_PER_S = 60;
/** Higher than this over the ground in a fall, HEADING_ON_GROUND goes off until we land (a real client kept it at 30, dropped it from 61). */
const ON_GROUND_MAX_HEIGHT = 30;

/**
 * A real 1.127 client's speed-up and slow-down in units/s², from Vue's relayed speeds
 * (bots/Movewatch/runs/at-191b.jsonl, vue-vs-bot.jsonl): about +50 per 200 ms update from 0 to 191
 * (0.76 s, 73 units), the same +250 at 288 run speed, and -100 per update when stopping (191, 90, 0:
 * 0.38 s, 37 units). Path corners keep the speed.
 */
export const RUN_ACCEL = 250;
export const RUN_DECEL = 500;
const RAMP_STEPS_PER_S = 60;

/**
 * ms to cover `distance` from speed v0 to rest at top speed `speed`, with RUN_ACCEL and RUN_DECEL
 * (a short move peaks below `speed`). For ETAs; Infinity at speed 0.
 */
export function rampedMoveMs(distance: number, speed: number, v0 = 0): number {
    if (distance <= 0) return 0;
    if (speed <= 0) return Infinity;
    const v = Math.min(v0, speed);
    const up = (speed * speed - v * v) / (2 * RUN_ACCEL);
    const down = (speed * speed) / (2 * RUN_DECEL);
    if (up + down <= distance) return ((speed - v) / RUN_ACCEL + (distance - up - down) / speed + speed / RUN_DECEL) * 1000;
    // Never reaches top speed: the peak where the speed-up meets the slow-down.
    const peak = Math.sqrt(Math.max(v * v, (2 * distance * RUN_ACCEL * RUN_DECEL + RUN_DECEL * v * v) / (RUN_ACCEL + RUN_DECEL)));
    return ((peak - v) / RUN_ACCEL + peak / RUN_DECEL) * 1000;
}

export class Mover {
    regionId = 0;
    x = 0;
    y = 0;
    z = 0;
    heading = 0;
    speed = 0;
    maxSpeedPercent = 100;
    /** Water speed byte of 0xB6: percent on top of the swim speed (Mastery of Water, water breathing). */
    waterSpeedPercent = 0;
    zoneId: number | null = null;

    objectId = 0;
    sessionId = 0;
    healthPercent = 100;
    sitting = false;
    /** In deep water (from deps.ground): 0xA9 carries the SWIMMING state flag instead of SITTING. */
    swimming = false;
    targetInView = true;

    moving = false;
    /** Vertical speed in units/s: below 0 while falling, 0 on the ground (and swimming). */
    vz = 0;
    /** In a real fall (more than ON_GROUND_MAX_HEIGHT up at some point since we left the ground): HEADING_ON_GROUND is off. */
    falling = false;
    private waypoints: Waypoint[] = [];
    private tolerance = 16;
    private speedFactor = 1;
    private segmentStart: Vec3 = { x: 0, y: 0, z: 0 };
    lastStopReason: MovementState['lastStopReason'] = null;
    /** How the current move ends at its last waypoint: 'arrived', or 'stopped' after brake(). */
    private arrivalReason: StopReason = 'arrived';
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

    /**
     * Swim speed as a real client works it out (game.dll 0x4388d9, integer maths): the bonus stops at
     * 100 %, which is the "about 90 % of normal speed" cap of OpenDAoC a0c8941e0 (170 of 191).
     * The client's own Mastery of Water table stays out of it: the server sends that ability so the
     * client doesn't apply it (AtlasOF_Masteries.cs:132-135) and adds it to the byte instead.
     */
    get maxSwimSpeed(): number {
        const base = Math.floor(((Math.min(100, this.waterSpeedPercent) + 100) * PLAYER_BASE_SWIM_SPEED) / 100);
        return Math.floor((base * this.maxSpeedPercent) / 100);
    }

    /**
     * The action byte of a 0xA9. Each one overwrites the server's GroundTargetInView (PlayerPositionUpdateHandler.cs:667),
     * which a ground-target summon checks at the start and the end of its cast (SummonAnimistPet.cs:28, :54). Like line
     * of sight, we report it clear. PetInView stays off: the server never reads it (:664-671).
     */
    get actionFlags(): number {
        return (this.targetInView ? ActionFlags.TargetInView : 0) | (this.deps.hasGroundTarget?.() ? ActionFlags.GroundTargetInView : 0);
    }

    /** The limit where we are now: maxSwimSpeed in deep water, maxSpeed elsewhere. */
    get speedLimit(): number {
        return this.swimming ? this.maxSwimSpeed : this.maxSpeed;
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
        this.vz = 0;
        this.falling = false;
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
        this.speedFactor = Math.min(1, Math.max(0.05, opts.speedFactor ?? 1));
        this.segmentStart = this.position;
        this.lastStopReason = null;
        this.arrivalReason = 'arrived';
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

    /**
     * Stop like a real client letting go of the keys: slow down at RUN_DECEL along the route still ahead
     * (191 → 0 takes 0.38 s and 37 units), then stop with reason 'stopped'. Still `moving` meanwhile.
     * At rest, holding or with no route this is stop().
     */
    brake(): void {
        if (!this.moving) return;
        if (this.holding || this.speed <= 0 || this.waypoints.length === 0) {
            this.finish('stopped', false);
            return;
        }
        let left = (this.speed * this.speed) / (2 * RUN_DECEL);
        let at: { x: number; y: number; z: number | undefined } = this.segmentStart;
        let cur: { x: number; y: number } = this;
        const kept: Waypoint[] = [];
        for (const w of this.waypoints) {
            const d = Math.hypot(w.x - cur.x, w.y - cur.y);
            if (d > left) {
                // The rest point on this leg, its z on the same line as the leg's.
                const f = left / d;
                const x = cur.x + (w.x - cur.x) * f;
                const y = cur.y + (w.y - cur.y) * f;
                const legLen = Math.hypot(w.x - at.x, w.y - at.y);
                const t = legLen > 0 ? 1 - Math.hypot(w.x - x, w.y - y) / legLen : 1;
                kept.push({ x, y, z: w.z !== undefined && at.z !== undefined ? at.z + (w.z - at.z) * t : undefined });
                left = 0;
                break;
            }
            kept.push(w);
            left -= d;
            at = w;
            cur = w;
        }
        this.waypoints = kept;
        // The rest point is tolerance / 2 short of the last waypoint: put it on the cut, and keep a last
        // leg that is already shorter than the slow-down.
        this.tolerance = left > 0 ? Math.min(this.tolerance, 2) : 2;
        this.arrivalReason = 'stopped';
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

    /** The cast it was for has ended early: walk again. */
    releaseHold(): void {
        this.holdUntil = 0;
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
        // A hold (casting) freezes us: the move after it starts from 0.
        if (this.holding) this.speed = 0;
        if (this.moving && !this.holding) {
            if (now - this.lastStepAt >= MOVE_INTERVAL_MS - 5) {
                this.step(now);
                if (this.enabled) this.sendUpdate();
            }
            return;
        }
        // Stopped (or casting) in the air: keep falling, with an update every step until we land.
        if (this.vz !== 0) {
            if (now - this.lastStepAt >= MOVE_INTERVAL_MS - 5) {
                const dt = Math.min(500, now - this.lastStepAt) / 1000;
                this.lastStepAt = now;
                this.fall({ x: this.x, y: this.y }, this.z, dt);
                this.sendUpdate();
            }
            return;
        }
        this.lastStepAt = now;
        if (now - this.lastSentAt >= IDLE_INTERVAL_MS) this.sendUpdate();
    }

    private step(now: number): void {
        const dt = Math.min(500, now - this.lastStepAt) / 1000;
        this.lastStepAt = now;
        const from = { x: this.x, y: this.y };
        const zFrom = this.z;
        // From rest already within tolerance of the end: arrive without a step (and without a ramp).
        const end = this.waypoints[this.waypoints.length - 1];
        if (this.speed === 0 && this.waypoints.length === 1 && end && Math.hypot(end.x - this.x, end.y - this.y) <= this.tolerance) {
            this.arriveAt(end, true);
            this.finish(this.arrivalReason, false);
            return;
        }
        const { distance, rested } = this.ramp(dt);
        let budget = distance;
        while (budget > 0 && this.waypoints.length > 0) {
            const w = this.waypoints[0]!;
            const isLast = this.waypoints.length === 1;
            const dx = w.x - this.x;
            const dy = w.y - this.y;
            const d = Math.hypot(dx, dy);
            // The last waypoint ends at its rest point, tolerance / 2 short of it, where the slow-down ends.
            const tol = isLast ? this.tolerance * 0.5 : 1;
            if (d <= tol) {
                this.arriveAt(w, isLast);
                continue;
            }
            const advance = Math.min(budget, isLast ? d - tol : d);
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
        // At rest where the ramp says the route ends: what is left (a last leg shorter than tolerance / 2,
        // rounding) is within tolerance of the end.
        if (rested && this.waypoints.length > 0) {
            this.waypoints.splice(0, this.waypoints.length - 1);
            this.arriveAt(this.waypoints[0]!, true);
        }
        this.updateZone();
        if (!this.isHop()) this.fall(from, zFrom, dt);
        else this.vz = 0;
        if (this.waypoints.length === 0 && this.moving) this.finish(this.arrivalReason, false);
    }

    /** Path length from here to the rest point: through every waypoint, ending tolerance / 2 short of the last. */
    private routeLeft(): number {
        let d = 0;
        let at: { x: number; y: number } = this;
        for (const w of this.waypoints) {
            d += Math.hypot(w.x - at.x, w.y - at.y);
            at = w;
        }
        return Math.max(0, d - this.tolerance * 0.5);
    }

    /**
     * Speed over the next dt: up by RUN_ACCEL to speedLimit × speedFactor, down by RUN_DECEL to stop at
     * the rest point (routeLeft), in RAMP_STEPS_PER_S steps. A lower limit (water, a snare) takes effect at
     * once, like a real client: above it the server's speed monitor would object. Sets this.speed to the
     * speed at the end of dt; returns the distance covered and whether that ends at rest at the rest point.
     */
    private ramp(dt: number): { distance: number; rested: boolean } {
        const top = this.speedLimit * this.speedFactor;
        const left = this.routeLeft();
        let v = Math.min(this.speed, top);
        let distance = 0;
        const n = Math.max(1, Math.round(dt * RAMP_STEPS_PER_S));
        const h = dt / n;
        for (let i = 0; i < n; i++) {
            const next = Math.min(top, v + RUN_ACCEL * h, Math.sqrt(2 * RUN_DECEL * (left - distance)));
            const ds = ((v + next) / 2) * h;
            // At the rest point: within a fraction of a unit at the end of the slow-down, or at once when
            // the move came too close to slow down for (a re-issued move with its end next to us).
            if (distance + ds >= left - 1e-3) {
                this.speed = 0;
                return { distance: left, rested: true };
            }
            distance += ds;
            v = next;
        }
        this.speed = v;
        return { distance, rested: false };
    }

    /**
     * Take z (and the swim state) from deps.ground, with the current z as the layer hint. During a
     * move z is the waypoint interpolation up to here; ladder hops (skipHops) keep it.
     */
    private reground(skipHops: boolean): void {
        const ground = this.deps.ground;
        if (!ground) return;
        if (skipHops && this.isHop()) return;
        const g = ground(this.regionId, this.x, this.y, this.z);
        if (!g) return;
        this.z = g.z;
        this.swimming = g.swimming;
        if (g.swimming) this.sitting = false;
    }

    /** The current segment is a ladder/off-mesh hop: its interpolated z stands. */
    private isHop(): boolean {
        const w = this.waypoints[0];
        if (w?.z === undefined) return false;
        const rise = Math.abs(w.z - this.segmentStart.z);
        return rise > HOP_MIN_RISE && rise > 2 * Math.hypot(w.x - this.segmentStart.x, w.y - this.segmentStart.y);
    }

    /**
     * z over the last dt, from (from, zFrom) to where we are now, in FALL_STEPS_PER_S steps along the
     * straight line: the ground lifts us, and where it drops away faster than we fall we are in the air
     * under FALL_GRAVITY until we meet it again (vz < 0 meanwhile). Swimming holds us at the swim height.
     * Without a ground source z stays as it is, and a step with no ground under it keeps the waypoint z.
     */
    private fall(from: { x: number; y: number }, zFrom: number, dt: number): void {
        const ground = this.deps.ground;
        if (!ground) return;
        const n = Math.max(1, Math.round(dt * FALL_STEPS_PER_S));
        const h = dt / n;
        let z = zFrom;
        let vz = this.vz;
        let swimming = this.swimming;
        let falling = this.falling;
        for (let i = 1; i <= n; i++) {
            const f = i / n;
            const g = ground(this.regionId, from.x + (this.x - from.x) * f, from.y + (this.y - from.y) * f, z);
            if (!g) {
                this.vz = 0;
                this.falling = false;
                return;
            }
            swimming = g.swimming;
            if (swimming) {
                z = g.z;
                vz = 0;
                continue;
            }
            vz -= FALL_GRAVITY * h;
            z += vz * h;
            if (z <= g.z) {
                z = g.z;
                vz = 0;
            }
            if (vz === 0) falling = false;
            else if (z - g.z > ON_GROUND_MAX_HEIGHT) falling = true;
        }
        this.z = z;
        this.vz = vz;
        this.falling = falling;
        this.swimming = swimming;
        if (swimming) this.sitting = false;
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
            zSpeed: this.vz,
            sessionId: this.sessionId,
            objectId: this.objectId,
            zoneId: this.zoneId,
            // The server relays this byte as is and never sets DEAD itself (PlayerPositionUpdateHandler.cs:415,
            // no IsAlive check), so without it viewers get a standing player at 0 % once a second, which a
            // real client shows dying and vanishing over and over. Otherwise never both: SWIMMING|SITTING
            // reads as DEAD, and SWIMMING|JUMPING as FLYING (an autoban under ban_hackers; ProcessStateFlags).
            stateFlags: this.deps.isDead?.() ? StateFlags.Dead : this.swimming ? StateFlags.Swimming : this.sitting ? StateFlags.Sitting : 0,
            // Bit 15 would ask the server for fall damage from zSpeed (PlayerPositionUpdateHandler.cs:151-161).
            // A real client left it off in every update of a capture, landings after falls at -665 included,
            // and so do we. Viewers never see this field (it goes out as the steed seat).
            fallingDamage: 0,
            heading: this.heading,
            headingFlags: this.falling ? 0 : HEADING_ON_GROUND,
            actionFlags: this.actionFlags,
            healthPercent: this.healthPercent,
        });
        this.lastSentAt = this.now();
        this.sentCount++;
        this.recentSent.push({ x: this.x, y: this.y, z: this.z });
        if (this.recentSent.length > RECENT_SENT_KEPT) this.recentSent.shift();
        this.deps.send(0xA9, payload);
    }
}
