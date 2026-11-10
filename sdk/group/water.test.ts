import { describe, expect, test } from 'bun:test';
import { getTerrainStore } from '../terrain';
import { BATTLEGROUND_LAYOUTS } from './keeps';
import { safePath } from './terrain';
import type { Point } from './types';
import { bankStop, DRY_MARGIN, drySpot, isDry, isWet } from './water';

// Thidranki's rivers from the client's terrain (bun run terrain:build); skipped without it.
const T = 252;
const terrain = getTerrainStore().available();
const river = { x: 41_069, y: 26_768 }; // the river's middle between Hibernia's and Midgard's halves (the pair spot until 2026-11-09)
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
        expect(bankStop(99_999, p, { x: 5000, y: 1000 })).toBeNull();
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

describe.skipIf(!terrain)('bankStop in Thidranki', () => {
    // On the east river's north bank, where Albion fought Midgard in round 67: water starts some 400 south.
    const bank = { x: 47_866, y: 39_266 };
    const south = { x: 47_866, y: 40_766, z: 123 };

    test('a move from the bank into the river ends dry, on the line, just short of the water', () => {
        expect(isWet(T, bank)).toBe(false);
        expect(isWet(T, south)).toBe(true);
        const s = bankStop(T, bank, south)!;
        expect(s).not.toBeNull();
        expect(s.z).toBe(123);
        expect(s.x).toBe(bank.x);
        expect(s.y).toBeGreaterThan(bank.y);
        expect(s.y).toBeLessThan(south.y);
        expect(isWet(T, s)).toBe(false);
        expect(isWet(T, { x: s.x, y: s.y + 150 })).toBe(true);
    });

    test('no cut for a dry end, for a swimmer, or for a crossing to the far bank', () => {
        expect(bankStop(T, bank, { x: 47_866, y: 38_000 })).toBeNull();
        expect(bankStop(T, south, bank)).toBeNull();
        // Across the river between Hibernia's and Midgard's halves: wet in the middle, dry at both ends.
        const a = drySpot(T, river, { toward: hibArrival }), b = drySpot(T, river, { toward: { x: 2 * river.x - hibArrival.x, y: 2 * river.y - hibArrival.y } });
        expect(isWet(T, river)).toBe(true);
        expect(bankStop(T, a, b)).toBeNull();
    });

    test('at the edge already, the stop is where we stand', () => {
        const s = bankStop(T, bank, south)!;
        const again = bankStop(T, s, south)!;
        expect(Math.hypot(again.x - s.x, again.y - s.y)).toBeLessThanOrEqual(80);
    });
});
