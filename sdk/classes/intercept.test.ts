import { describe, expect, test } from 'bun:test';
import { approachPlan, closestApproach, interceptTime, trackFix, velocityOf } from './intercept';

const me = { x: 0, y: 0 };

describe('velocityOf', () => {
    test('from the newest span of at least 400 ms', () => {
        expect(velocityOf([{ x: 0, y: 0, at: 0 }, { x: 191, y: 0, at: 1000 }])).toEqual({ x: 191, y: 0 });
        expect(velocityOf([{ x: 0, y: 0, at: 0 }, { x: 10, y: 0, at: 200 }])).toBeNull();
        expect(velocityOf([])).toBeNull();
    });
});

describe('interceptTime and closestApproach', () => {
    test('a target running straight at us is met; one running off faster never', () => {
        expect(interceptTime({ x: 1000, y: 0 }, { x: -191, y: 0 }, me, 115)).toBeCloseTo(1000 / 306, 2);
        expect(interceptTime({ x: 1000, y: 0 }, { x: 191, y: 0 }, me, 115)).toBeNull();
    });
    test('the course passes us, or it is moving away', () => {
        expect(closestApproach({ x: 1000, y: 50 }, { x: -191, y: 0 }, me)).toMatchObject({ distance: 50 });
        expect(closestApproach({ x: 1000, y: 0 }, { x: 191, y: 0 }, me)).toBeNull();
    });
});

describe('approachPlan', () => {
    test('a target standing (casting): walk to its front as before', () => {
        expect(approachPlan({ x: 800, y: 0 }, { x: 10, y: 0 }, me)).toEqual({ kind: 'still' });
        expect(approachPlan({ x: 800, y: 0 }, null, me)).toEqual({ kind: 'still' });
    });
    test('coming to us: hold and let it walk into the stab', () => {
        expect(approachPlan({ x: 1500, y: 60 }, { x: -191, y: 0 }, me)).toMatchObject({ kind: 'hold' });
    });
    test('passing across: go to a point on its path, a little ahead of where we meet', () => {
        const p = approachPlan({ x: -1500, y: 800 }, { x: 191, y: 0 }, me);
        expect(p.kind).toBe('go');
        if (p.kind !== 'go') return;
        expect(p.to.y).toBe(800);
        // On its line, ahead of the meeting point: it arrives after we do.
        const t = interceptTime({ x: -1500, y: 800 }, { x: 191, y: 0 }, me, 115)!;
        expect(p.to.x).toBeGreaterThan(-1500 + 191 * t);
        expect(Math.hypot(p.to.x, p.to.y) / 115).toBeLessThan(t + 1);
    });
    test('running off faster than we can follow: no chase', () => {
        expect(approachPlan({ x: 300, y: 0 }, { x: 191, y: 0 }, me)).toEqual({ kind: 'leave' });
    });
    test('an intercept too far off is not worth it', () => {
        expect(approachPlan({ x: -9000, y: 3000 }, { x: 191, y: 0 }, me).kind).toBe('leave');
    });
});

test('trackFix keeps the newest fixes of a target within 3 s', () => {
    const memory = new Map<string, unknown>();
    trackFix(memory, 7, { x: 0, y: 0 }, 0);
    trackFix(memory, 7, { x: 100, y: 0 }, 500);
    const fixes = trackFix(memory, 7, { x: 200, y: 0 }, 4000);
    expect(fixes.map(f => f.x)).toEqual([200]);
    expect(velocityOf(trackFix(memory, 7, { x: 391, y: 0 }, 5000))).toEqual({ x: 191, y: 0 });
});
