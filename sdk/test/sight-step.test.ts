import { describe, expect, test } from 'bun:test';
import { SIGHT_STEP_MAX, SIGHT_STEP_SHORT, sightStep } from '../actions';

/** A ridge 300 high across the y axis between y = 900 and y = 1100; flat elsewhere at 0. */
const ridge = (_r: number, _x: number, y: number) => (y > 900 && y < 1100 ? 300 : 0);
/** A ridge within a step's reach, 500..700: a step onto its top sees over it. */
const climb = (_r: number, _x: number, y: number) => (y >= 500 && y < 700 ? 300 : 0);

describe('sightStep: where castSpell steps after "You can\'t see your target"', () => {
    test('the first spot along the way that sees over the ridge', () => {
        const spot = sightStep(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 2000, z: 0 }, climb)!;
        // On the ridge's top, with its own height.
        expect(spot.y).toBe(500);
        expect(spot.z).toBe(300);
    });

    test('no spot sees it: the whole step, at most SIGHT_STEP_MAX', () => {
        const spot = sightStep(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 5000, z: 0 }, () => null)!;
        // No ground known never blocks: the first sample already sees it.
        expect(spot.y).toBe(100);
        const far = sightStep(1, { x: 0, y: -3000, z: 0 }, { x: 0, y: 2000, z: 0 }, ridge)!;
        expect(far.y).toBe(-3000 + SIGHT_STEP_MAX);
    });

    test('holding ground (approach false): only a short step, and only to a spot that sees it', () => {
        expect(sightStep(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 2000, z: 0 }, climb, SIGHT_STEP_SHORT, true)).toBeNull();
        const near = sightStep(1, { x: 0, y: 300, z: 0 }, { x: 0, y: 2300, z: 0 }, climb, SIGHT_STEP_SHORT, true)!;
        expect(near.y).toBe(500);
    });

    test('no room for a step next to the target', () => {
        expect(sightStep(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 200, z: 0 }, ridge)).toBeNull();
    });
});

describe('sightStep: round a wall when the line has no spot', () => {
    // A wall 600 high along x = 450 for y between -400 and 400: the straight line east is behind it all the way.
    const wall = (_r: number, x: number, y: number) => (x > 400 && x < 500 && y > -400 && y < 400 ? 600 : 0);
    test('holding: a ring spot to the side, within the short step, that sees past the wall', () => {
        const spot = sightStep(1, { x: 0, y: 350, z: 0 }, { x: 1500, y: 0, z: 0 }, wall, SIGHT_STEP_SHORT, true)!;
        expect(spot).not.toBeNull();
        expect(Math.hypot(spot.x, spot.y - 350)).toBeLessThanOrEqual(SIGHT_STEP_SHORT + 1);
        expect(spot.y).toBeGreaterThan(350);
    });
    test('no ring spot within the step sees it: still null when holding', () => {
        expect(sightStep(1, { x: 0, y: 0, z: 0 }, { x: 1500, y: 0, z: 0 }, wall, 150, true)).toBeNull();
    });
});
