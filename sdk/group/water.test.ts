import { describe, expect, test } from 'bun:test';
import { getTerrainStore } from '../terrain';
import { BATTLEGROUND_LAYOUTS } from './keeps';
import { safePath } from './terrain';
import type { Point } from './types';
import { DRY_MARGIN, drySpot, isDry, isWet } from './water';

// Thidranki's rivers from the client's terrain (bun run terrain:build); skipped without it.
const T = 252;
const terrain = getTerrainStore().available();
const river = BATTLEGROUND_LAYOUTS[T]!.pairs!['hibernia|midgard']!; // the river's middle between Hibernia's and Midgard's halves
const hibArrival = BATTLEGROUND_LAYOUTS[T]!.arrival.hibernia;
const wetLength = (pts: Point[]) => {
    let wet = 0;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!, n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 50);
        for (let k = 0; k < n; k++) if (isWet(T, { x: a.x + (b.x - a.x) * (k + 0.5) / n, y: a.y + (b.y - a.y) * (k + 0.5) / n })) wet += Math.hypot(b.x - a.x, b.y - a.y) / n;
    }
    return wet;
};

describe('water without terrain', () => {
    test('a region with no zone has no water, and drySpot passes the spot through', () => {
        const p = { x: 1000, y: 1000 };
        expect(isWet(99_999, p)).toBe(false);
        expect(drySpot(99_999, p)).toBe(p);
    });
});

describe.skipIf(!terrain)('water in Thidranki', () => {
    test('the river between Hibernia and Midgard is water; their arrival points are not', () => {
        expect(isWet(T, river)).toBe(true);
        expect(isDry(T, hibArrival)).toBe(true);
    });

    test('drySpot: a dry spot is itself; one in the river moves to the nearest bank, clear of water by the margin', () => {
        expect(drySpot(T, hibArrival)).toBe(hibArrival);
        const s = drySpot(T, river);
        expect(isDry(T, s, DRY_MARGIN)).toBe(true);
        expect(Math.hypot(s.x - river.x, s.y - river.y)).toBeLessThan(3000);
    });

    test('drySpot keeps to `ok`: either bank, as asked', () => {
        // The river runs north-east here: its banks lie west and east of the middle.
        const west = drySpot(T, river, { ok: q => q.x < river.x });
        const east = drySpot(T, river, { ok: q => q.x > river.x });
        expect(west.x).toBeLessThan(river.x);
        expect(east.x).toBeGreaterThan(river.x);
        expect(isDry(T, west) && isDry(T, east)).toBe(true);
    });

    test('safePath crosses a river no wider than the straight line does, and never calls a line across it clear', () => {
        const from = { x: river.x - 4000, y: river.y }, to = { x: river.x + 4000, y: river.y };
        const route = safePath(T, 24, from, to);
        expect(route.length).toBeGreaterThan(1);
        expect(wetLength([from, ...route])).toBeLessThanOrEqual(wetLength([from, to]) + 400);
    });
});
