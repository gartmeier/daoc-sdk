import { describe, expect, test } from 'bun:test';
import { getTerrainStore } from '../terrain';
import { BATTLEGROUND_LAYOUTS, clearOf, keepDangers, type PlayerRealm } from './keeps';
import { defaultPatrol } from './rvr';
import { CLIFF, GENTLE, isLevel, isSteep, SHEER, slopeAlong, slopeAt, slopeCost, STEEP } from './slope';
import { aggroZones, safePath } from './terrain';
import type { Point } from './types';
import { drySpot, isDry, isWet } from './water';

// Thidranki's terrain (bun run terrain:build); skipped without it.
const T = 252;
const terrain = getTerrainStore().available();
const along = (pts: Point[]) => pts.slice(1).reduce((s, b, i) => {
    const r = slopeAlong(T, pts[i]!, b);
    return { steep: s.steep + r.steep, cliff: s.cliff + r.cliff };
}, { steep: 0, cliff: 0 });

describe('slope without terrain', () => {
    test('a region with no zone is flat everywhere, and drySpot passes the spot through', () => {
        const p = { x: 1000, y: 1000 };
        expect(slopeAt(99_999, p)).toBe(0);
        expect(isSteep(99_999, p)).toBe(false);
        expect(isLevel(99_999, p)).toBe(true);
        expect(slopeCost(99_999, p)).toBe(0);
        expect(slopeAlong(99_999, p, { x: 5000, y: 1000 })).toEqual({ steep: 0, cliff: 0, max: 0 });
    });
});

describe.skipIf(!terrain)('slope in Thidranki', () => {
    // A dry bank 1.02 steep, with level ground 450 north-west of it.
    const bank = { x: 26_300, y: 35_400 };
    const arrivals = BATTLEGROUND_LAYOUTS[T]!.arrival;

    test('slopeCost: nothing up to GENTLE, 2 at CLIFF, 6 at SHEER, 60 beyond; isSteep at STEEP', () => {
        expect(slopeAt(T, bank)).toBeGreaterThan(CLIFF);
        expect(isSteep(T, bank)).toBe(true);
        expect(slopeCost(T, bank)).toBeCloseTo(2 + 4 * (slopeAt(T, bank) - CLIFF) / (SHEER - CLIFF));
        // The west river's north bank at x 19000: a cliff face.
        expect(slopeCost(T, { x: 19_000, y: 36_000 })).toBe(60);
        for (const a of Object.values(arrivals)) {
            expect(slopeAt(T, a)).toBeLessThan(GENTLE);
            expect(slopeCost(T, a)).toBe(0);
        }
        expect(STEEP).toBeGreaterThan(GENTLE);
    });

    test('drySpot moves a stop off a steep bank to level dry ground near it; with level off it stays', () => {
        expect(isDry(T, bank)).toBe(true);
        const s = drySpot(T, bank);
        expect(s).not.toBe(bank);
        expect(isLevel(T, s) && isDry(T, s)).toBe(true);
        expect(Math.hypot(s.x - bank.x, s.y - bank.y)).toBeLessThanOrEqual(800);
        expect(drySpot(T, bank, { level: false })).toBe(bank);
        // A level dry spot is itself.
        expect(drySpot(T, arrivals.albion)).toBe(arrivals.albion);
    });

    test('safePath goes round a cliff a straight line would cross', () => {
        // 3000 east across a ridge north of the Faste: 511 of cliff on the straight line, none on the route.
        const from = { x: 32_100, y: 35_400 }, to = { x: 35_100, y: 35_400 };
        expect(slopeAlong(T, from, to).cliff).toBeGreaterThan(400);
        const route = [from, ...safePath(T, 24, from, to)];
        expect(route.length).toBeGreaterThan(2);
        expect(along(route).cliff).toBe(0);
        expect(along(route).steep).toBeLessThan(slopeAlong(T, from, to).steep);
    });

    test('every pair\'s ring is dry with the river far off, level, and its waypoints stand on level ground', () => {
        const zones = aggroZones(T, 24);
        for (const [key, spot] of Object.entries(BATTLEGROUND_LAYOUTS[T]!.pairs!)) {
            const [a, b] = key.split('|') as [PlayerRealm, PlayerRealm];
            const ring = Array.from({ length: 36 }, (_, k) => ({ x: spot.x + Math.cos(k * Math.PI / 18) * 4000, y: spot.y + Math.sin(k * Math.PI / 18) * 4000 }));
            // No water within 2500 of the ring (sampled on 12 spokes each way).
            for (const p of ring) for (let k = 0; k < 12; k++) {
                const q = { x: p.x + Math.cos(k * Math.PI / 6) * 2500, y: p.y + Math.sin(k * Math.PI / 6) * 2500 };
                expect(isWet(T, q)).toBe(false);
            }
            expect(ring.filter(p => !isLevel(T, p)).length).toBeLessThanOrEqual(2);
            for (const [realm, opponent] of [[a, b], [b, a]] as const) {
                const loop = defaultPatrol(T, realm, 24, { opponent });
                expect(loop.length).toBe(6);
                for (const w of loop) {
                    expect(isLevel(T, w) && isDry(T, w)).toBe(true);
                    expect(clearOf(w, [...zones, ...keepDangers(T, realm)], 900)).toBe(true);
                }
            }
        }
    });

    test('the way from each arrival to its first pair waypoint crosses no cliff on the home bank, and swims at most once', () => {
        for (const key of Object.keys(BATTLEGROUND_LAYOUTS[T]!.pairs!)) {
            const [a, b] = key.split('|') as [PlayerRealm, PlayerRealm];
            for (const [realm, opponent] of [[a, b], [b, a]] as const) {
                const home = arrivals[realm];
                const route = [home, ...safePath(T, 24, home, defaultPatrol(T, realm, 24, { opponent })[0]!, keepDangers(T, realm))];
                // Wet stretches along the route: one river at most.
                let swims = 0, wet = false;
                for (let i = 1; i < route.length; i++) {
                    const p = route[i - 1]!, q = route[i]!, n = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 50);
                    for (let k = 0; k <= n; k++) {
                        const w = isWet(T, { x: p.x + (q.x - p.x) * k / n, y: p.y + (q.y - p.y) * k / n });
                        if (w && !wet) swims++;
                        wet = w;
                    }
                }
                expect(swims).toBeLessThanOrEqual(1);
                // Without a river to cross, no cliff at all.
                if (!swims) expect(along(route).cliff).toBe(0);
            }
        }
    });
});
