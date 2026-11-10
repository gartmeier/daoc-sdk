import { describe, expect, test } from 'bun:test';
import { canSee, clientLineOfSight, describeVision, HUMAN_VISION, inViewCone, lineOfSight, NOTICE_GRACE_MS, NOTICE_MAX_MS, noticed, offHeading, pruneNoticeClock, resolveVision, sightLineClear, sightOf, type GroundAt, type NoticeClock, type Viewer } from '../vision';

// Heading 0 faces +Y, 1024 faces -X, 2048 faces -Y, 3072 faces +X (headingBetween).
const at = (heading: number): Viewer => ({ regionId: 1, x: 0, y: 0, z: 0, heading });
const flat: GroundAt = () => 0;
/** A ridge 300 high across the x axis between y = 900 and y = 1100. */
const ridge: GroundAt = (_r, _x, y) => (y > 900 && y < 1100 ? 300 : 0);

describe('vision: the view cone', () => {
    test('offHeading follows the DAoC heading convention', () => {
        expect(offHeading(at(0), { x: 0, y: 1000 })).toBeCloseTo(0);
        expect(offHeading(at(0), { x: 0, y: -1000 })).toBeCloseTo(180);
        expect(offHeading(at(1024), { x: -1000, y: 0 })).toBeCloseTo(0);
        expect(offHeading(at(3072), { x: 1000, y: 0 })).toBeCloseTo(0);
        expect(offHeading(at(0), { x: 1000, y: 0 })).toBeCloseTo(90);
        // Across the wrap: heading 4000 is just left of +Y.
        expect(offHeading(at(4000), { x: 0, y: 1000 })).toBeCloseTo((96 / 4096) * 360);
    });

    test('inViewCone: half the width each side', () => {
        expect(inViewCone(at(0), { x: 800, y: 1000 }, 100)).toBe(true); // ~39°
        expect(inViewCone(at(0), { x: 1300, y: 1000 }, 100)).toBe(false); // ~52°
        expect(inViewCone(at(0), { x: 1300, y: 1000 }, 120)).toBe(true);
    });
});

describe('vision: the ground', () => {
    test('a ridge between blocks the line, flat ground does not', () => {
        const eye = { x: 0, y: 0, z: 60 }, far = { x: 0, y: 2000, z: 50 };
        expect(sightLineClear(1, eye, far, HUMAN_VISION, flat)).toBe(true);
        expect(sightLineClear(1, eye, far, HUMAN_VISION, ridge)).toBe(false);
        // From high up the ridge is below the line.
        expect(sightLineClear(1, { ...eye, z: 1000 }, { ...far, z: 1000 }, HUMAN_VISION, ridge)).toBe(true);
    });

    test('the slope at either end does not hide what stands on it', () => {
        // Ground rising to 200 within the first step: under the viewer's own feet as terrain samples go.
        const slope: GroundAt = (_r, _x, y) => (y < 40 ? 200 : 0);
        expect(sightLineClear(1, { x: 0, y: 0, z: 60 }, { x: 0, y: 2000, z: 50 }, HUMAN_VISION, slope)).toBe(true);
    });

    test('no ground known (no .terrain) never blocks', () => {
        expect(sightLineClear(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 2000, z: 0 }, HUMAN_VISION, () => null)).toBe(true);
    });
});

describe('vision: sightOf', () => {
    const v = HUMAN_VISION;
    test('near is noticed whatever the facing or the ground', () => {
        expect(sightOf(at(2048), { x: 0, y: 400, z: 0 }, v, ridge)).toBe('aware');
    });
    test('ahead and clear is seen, behind is not, behind a ridge is blocked', () => {
        expect(sightOf(at(0), { x: 0, y: 2000, z: 0 }, v, flat)).toBe('seen');
        expect(sightOf(at(2048), { x: 0, y: 2000, z: 0 }, v, flat)).toBe('behind');
        expect(sightOf(at(0), { x: 0, y: 2000, z: 0 }, v, ridge)).toBe('blocked');
        expect(canSee(at(0), { x: 0, y: 2000, z: 0 }, v, ridge)).toBe(false);
        expect(canSee(at(0), { x: 0, y: 2000, z: 0 }, v, flat)).toBe(true);
    });
});

describe('vision: options', () => {
    test('resolveVision: omniscient and nothing are null, a partial set is human', () => {
        expect(resolveVision(undefined)).toBeNull();
        expect(resolveVision('omniscient')).toBeNull();
        expect(resolveVision({ mode: 'omniscient', fovDegrees: 90 })).toBeNull();
        expect(resolveVision('human')).toEqual(HUMAN_VISION);
        expect(resolveVision({ fovDegrees: 120 })).toEqual({ ...HUMAN_VISION, fovDegrees: 120 });
        expect(() => resolveVision('eagle' as never)).toThrow("vision mode 'eagle'");
    });
    test('describeVision', () => {
        expect(describeVision(null)).toBe('omniscient');
        expect(describeVision(HUMAN_VISION)).toBe('human (cone 100°, aware 500, notice 800 ms)');
    });
});

describe('vision: line of sight between objects (0xD0 answers)', () => {
    test('lineOfSight ignores facing, and the ridge blocks it both ways', () => {
        const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 2000, z: 0 };
        expect(lineOfSight(1, a, b, flat)).toBe(true);
        expect(lineOfSight(1, a, b, ridge)).toBe(false);
        expect(lineOfSight(1, b, a, ridge)).toBe(false);
        expect(lineOfSight(1, { ...a, z: 1000 }, { ...b, z: 1000 }, ridge)).toBe(true);
    });

    test('clientLineOfSight: none with DAOC_LOS=clear', () => {
        const was = process.env.DAOC_LOS;
        process.env.DAOC_LOS = 'clear';
        try {
            expect(clientLineOfSight()).toBeUndefined();
        } finally {
            if (was === undefined) delete process.env.DAOC_LOS;
            else process.env.DAOC_LOS = was;
        }
    });
});

describe('vision: noticing takes noticeMs', () => {
    test('reported once in view that long; out of view past the grace starts over', () => {
        const clock: NoticeClock = new Map();
        expect(noticed(clock, 7, 1000, 800)).toBe(false);
        expect(noticed(clock, 7, 1500, 800)).toBe(false);
        expect(noticed(clock, 7, 1800, 800)).toBe(true);
        // Behind a hill for 2 s: still known when it comes back.
        expect(noticed(clock, 7, 3800, 800)).toBe(true);
        // Gone longer than the grace: noticed anew.
        pruneNoticeClock(clock, 3800 + NOTICE_GRACE_MS + 1);
        expect(clock.has(7)).toBe(false);
        expect(noticed(clock, 7, 9000, 800)).toBe(false);
    });

    test('no clock or noticeMs 0: at once; noticeMs above NOTICE_MAX_MS is refused', () => {
        expect(noticed(undefined, 7, 0, 800)).toBe(true);
        expect(noticed(new Map(), 7, 0, 0)).toBe(true);
        expect(() => resolveVision({ noticeMs: NOTICE_MAX_MS + 1 })).toThrow('noticeMs');
        expect(resolveVision({ noticeMs: 0 })?.noticeMs).toBe(0);
    });
});
