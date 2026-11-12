// Getting in a moving target's way for a stealth opener (sdk/classes/stealther.ts): Perforate Artery needs its front.
// Hidden we move at 115 (StealthECSEffect: speed buffs off, the stealth speed), a target runs at 191: a walk to a point
// just in front of it, aimed again each turn, ends behind it as a chase that never catches up (Mordred on a Ranger,
// run B 2026-11-12 10:34 UTC, watched by the user). A human assassin stands in its path and lets it walk into the stab.
//
// Plans, from the target's velocity (its last positions):
//  - still (under STILL): walk to its front (or back), as before;
//  - coming to us: hold, facing it, and open as it comes into reach;
//  - passing: the earliest point on its path we can reach first (the classic intercept: |T + v t - M| = s t), a little
//    ahead of it, then hold there facing it;
//  - leaving faster than we can follow: no chase; stay hidden.

export interface XY { x: number; y: number }
export interface Fix extends XY { at: number }

/** Below this many units a second a target counts as standing. */
export const STILL = 40;
/** Our speed hidden. */
export const HIDDEN_SPEED = 115;
/** Arrive this much ahead of the target, so it walks into us rather than past. */
export const LEAD_MS = 800;
/** Further out than this an intercept isn't worth the walk: it would turn or stop first. */
export const MAX_INTERCEPT_MS = 12_000;
/** Coming to us: its course passes within this of us. */
export const ON_COURSE = 120;

/** Velocity from the last fixes (units a second), over the newest span of at least 400 ms; none: null. */
export function velocityOf(fixes: readonly Fix[]): XY | null {
    const last = fixes.at(-1);
    if (!last) return null;
    const first = [...fixes].reverse().find(f => last.at - f.at >= 400);
    if (!first) return null;
    const dt = (last.at - first.at) / 1000;
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

/** Earliest t (s) at which a mover from `me` at `speed` meets a target at `t0` moving at `v`; null if never. */
export function interceptTime(t0: XY, v: XY, me: XY, speed: number): number | null {
    const dx = t0.x - me.x, dy = t0.y - me.y;
    const a = v.x * v.x + v.y * v.y - speed * speed;
    const b = 2 * (dx * v.x + dy * v.y);
    const c = dx * dx + dy * dy;
    if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : null;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const r = Math.sqrt(disc);
    const ts = [(-b - r) / (2 * a), (-b + r) / (2 * a)].filter(t => t > 0).sort((p, q) => p - q);
    return ts[0] ?? null;
}

/** How near the target's course passes us, and in how many seconds; behind it (moving away): null. */
export function closestApproach(t0: XY, v: XY, me: XY): { distance: number; seconds: number } | null {
    const vv = v.x * v.x + v.y * v.y;
    if (vv === 0) return null;
    const t = ((me.x - t0.x) * v.x + (me.y - t0.y) * v.y) / vv;
    if (t <= 0) return null;
    return { distance: Math.hypot(t0.x + v.x * t - me.x, t0.y + v.y * t - me.y), seconds: t };
}

export type ApproachPlan =
    | { kind: 'still' }
    | { kind: 'hold'; seconds: number }
    | { kind: 'go'; to: XY; seconds: number }
    | { kind: 'leave' };

/** What to do about a target at `t0` moving at `v` (null: unknown, treat as still). */
export function approachPlan(t0: XY, v: XY | null, me: XY, speed = HIDDEN_SPEED): ApproachPlan {
    if (!v || Math.hypot(v.x, v.y) < STILL) return { kind: 'still' };
    const pass = closestApproach(t0, v, me);
    if (pass && pass.distance <= ON_COURSE && pass.seconds * 1000 <= MAX_INTERCEPT_MS) return { kind: 'hold', seconds: pass.seconds };
    const t = interceptTime(t0, v, me, speed);
    if (t === null || t * 1000 > MAX_INTERCEPT_MS) return { kind: 'leave' };
    const ahead = t + LEAD_MS / 1000;
    return { kind: 'go', to: { x: Math.round(t0.x + v.x * ahead), y: Math.round(t0.y + v.y * ahead) }, seconds: t };
}

/** Keep a target's recent fixes (by object id) in `memory`; the newest 8 within 3 s. */
export function trackFix(memory: Map<string, unknown>, id: number, p: XY, now = Date.now()): Fix[] {
    const key = `fixes:${id}`;
    const fixes = ((memory.get(key) as Fix[] | undefined) ?? []).filter(f => now - f.at <= 3000);
    const last = fixes.at(-1);
    if (!last || last.x !== p.x || last.y !== p.y || now - last.at >= 250) fixes.push({ x: p.x, y: p.y, at: now });
    const kept = fixes.slice(-8);
    memory.set(key, kept);
    return kept;
}
