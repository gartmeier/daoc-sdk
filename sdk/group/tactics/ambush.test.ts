import { describe, expect, test } from 'bun:test';
import { contact, enemy, picture, report } from '../fixtures';
import { decideRvr, RVR_SETTINGS, type RvrSettings } from '../rvr';
import { mergeSettings, type CoordinatorContext } from '../strategy';
import type { GroupPicture, MemberReport, Orders, Point } from '../types';
import { AMBUSH_AFTER, ambushSpot, closestPass, entryOf, lastAppearance, loseQuarry, noteTracks, TRAIL_MAX, trailGoal, velocity, type Tracks } from './ambush';

const R = 9999;
const flat = () => 0;
const none = () => null;
const pt = (x: number, y: number, t: number) => ({ x, y, t });

describe('tracks', () => {
    test('one point per new sighting, stale ones and old ones left out', () => {
        const tracks: Tracks = {};
        noteTracks(tracks, [contact(7, { kind: 'player', x: 0, y: 0, lastSeen: 1000 })], 1000);
        noteTracks(tracks, [contact(7, { kind: 'player', x: 0, y: 0, lastSeen: 1000 })], 1250);
        noteTracks(tracks, [contact(7, { kind: 'player', x: 200, y: 0, lastSeen: 2000, stale: true })], 2000);
        noteTracks(tracks, [contact(7, { kind: 'player', x: 400, y: 0, lastSeen: 3000 })], 3000);
        expect(tracks[7]).toEqual([pt(0, 0, 1000), pt(400, 0, 3000)]);
        noteTracks(tracks, [], 200_000);
        expect(tracks[7]).toBeUndefined();
    });

    test('the latest appearance starts after a gap; velocity and the way in from it', () => {
        const pts = [pt(0, 0, 0), pt(100, 0, 1000), pt(5000, 5000, 20_000), pt(5000, 4800, 21_000), pt(5000, 4600, 22_000), pt(5000, 4400, 23_000)];
        expect(lastAppearance(pts)[0]).toEqual(pt(5000, 5000, 20_000));
        expect(velocity(lastAppearance(pts))).toEqual({ x: 0, y: -200 });
        expect(entryOf(pts)).toEqual({ at: { x: 5000, y: 5000 }, dir: { x: 0, y: -1 } });
        expect(entryOf([pt(0, 0, 0), pt(10, 0, 3000)])).toBeNull();   // it stood
    });
});

describe('the quarry', () => {
    const tracks: Tracks = { 7: [pt(1000, 0, 0), pt(1400, 0, 2000)], 8: [pt(1000, 100, 0), pt(1400, 100, 2000)] };
    test('lost: where it was, its walk, losses counted on for the same squad', () => {
        const q1 = loseQuarry(undefined, [7, 8], R, tracks, 3000)!;
        expect(q1).toMatchObject({ losses: 1, at: { x: 1400, y: 50 }, vel: { x: 200, y: 0 } });
        const q2 = loseQuarry(q1, [7], R, tracks, 60_000)!;
        expect(q2.losses).toBe(2);
        expect(q2.ids.sort()).toEqual([7, 8]);
        expect(loseQuarry(q1, [9], R, { 9: tracks[7]! }, 60_000)!.losses).toBe(1);    // another squad
        expect(loseQuarry(q1, [7], R, tracks, 400_000)!.losses).toBe(1);             // long ago
        expect(loseQuarry(q1, [7], 1, tracks, 60_000)!.losses).toBe(1);              // another region
    });
    test('its trail: where its walk leads, a little ahead, never past TRAIL_MAX', () => {
        const q = loseQuarry(undefined, [7], R, tracks, 3000)!;
        expect(trailGoal(q, 3000)).toEqual({ x: 1400 + 200 * 8, y: 0 });
        expect(trailGoal(q, 3000 + 60_000)).toEqual({ x: 1400 + TRAIL_MAX, y: 0 });
        expect(trailGoal({ ...q, vel: null }, 3000)).toBeNull();
    });
    test('a pass by us: how near and when; none walking away', () => {
        expect(closestPass({ x: 0, y: 1000 }, { x: 200, y: 0 }, { x: 2000, y: 0 })).toEqual({ d: 1000, inS: 10 });
        expect(closestPass({ x: 0, y: 1000 }, { x: -200, y: 0 }, { x: 2000, y: 0 })).toBeNull();
    });
});

describe('ambushSpot', () => {
    const entry = { at: { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
    test('flat ground: beside its way, ahead of where it came back, on our side', () => {
        const s = ambushSpot(R, entry, { x: 1000, y: -3000 }, () => true, flat, flat)!;
        expect(s.hidden).toBe(0);
        expect(s.y).toBeLessThan(0);
        expect(Math.abs(s.y)).toBeGreaterThanOrEqual(1000);
        expect(s.x).toBeGreaterThanOrEqual(1000);
    });
    test('a ridge along one side hides a spot behind it, even on the far side from us', () => {
        // A 400-high wall along y = +600 (x from -3000 to 4000): a spot north of it, low, is hidden from the way at y = 0.
        const ridge = (_r: number, x: number, y: number) => (y > 500 && y < 700 && x > -3000 && x < 4000 ? 400 : 0);
        const s = ambushSpot(R, entry, { x: 1000, y: -3000 }, () => true, () => 0, ridge)!;
        expect(s.y).toBeGreaterThan(0);
        expect(s.hidden).toBeGreaterThan(0.5);
    });
    test('none where nothing is a place to stand; no terrain hides nothing', () => {
        expect(ambushSpot(R, entry, { x: 0, y: 0 }, () => false, flat, flat)).toBeNull();
        expect(ambushSpot(R, entry, { x: 0, y: 0 }, () => true, flat, none)!.hidden).toBe(0);
    });
});

// The loop of field run B (2026-11-12 07:36-07:40): our five hunt a duo, it steps out of sight, comes back, steps out again.
describe('decideRvr with a quarry', () => {
    const BASE = { x: 10_000, y: 10_000 };
    const team = (at: Point = BASE): MemberReport[] => ['Tank', 'Druid', 'Bard', 'Menta', 'Encha'].map((n, i) =>
        report(n, { role: i === 0 ? 'tank' : i === 1 ? 'healer' : i === 2 ? 'support' : 'nuker', objectId: i + 1, regionId: R, x: at.x - (i ? 300 : 0), y: at.y + (i % 2 ? 150 : -150) * (i ? 1 : 0), level: 24 }));
    const LOOP = [{ x: 10_000, y: 10_000, z: 0 }, { x: 4000, y: 10_000, z: 0 }];
    const ctx = (p: GroupPicture, memory: Record<string, any>, orders: Partial<Orders>, settings: Record<string, unknown> = {}): CoordinatorContext<RvrSettings> => ({
        picture: p, orders: { ...p.orders, ...orders }, memory, now: p.at, windingDown: false,
        settings: mergeSettings(RVR_SETTINGS, { patrol: LOOP, ...settings } as any),
    });
    const duo = (x: number, y: number, t: number) => [7, 8].map(id => enemy(id, 'hibernia', { regionId: R, x, y: y + (id - 7) * 100, lastSeen: t, firstSeen: 0 }));

    function play(settings: Record<string, unknown> = {}) {
        const memory: Record<string, any> = {};
        let orders: Partial<Orders> = { phase: 'travel' };
        const step = (contacts: ReturnType<typeof duo>, t: number, at: Point = BASE) => {
            const d = decideRvr(ctx(picture(team(at), contacts, {}, t), memory, orders, settings));
            orders = { phase: d.phase ?? orders.phase, anchor: d.anchor ?? null };
            return d;
        };
        return { memory, step };
    }

    test('lost once: it follows the trail instead of turning back to the patrol', () => {
        const { step } = play();
        // The duo walks east, away from us, 4240-4840 off; then it is out of sight (or past huntRadius).
        for (let t = 0; t <= 3000; t += 1000) expect(step(duo(14_000 + t / 5, 10_000, t), t).reason).toContain("hunt 2 enemies");
        const d = step([], 5000);
        expect(d.reason).toContain('trail');
        expect(d.anchor!.x).toBeGreaterThan(BASE.x);       // east, after it; the patrol is west
    });

    test('lost again: lie in wait beside its way in, then hold while it comes on toward a pass by us', () => {
        const { memory, step } = play();
        for (let t = 0; t <= 3000; t += 1000) step(duo(14_000 + t / 5, 10_000, t), t);
        step([], 5000);
        // Back in sight 30 s later, from the east, walking west at us; then gone again.
        for (let t = 35_000; t <= 40_000; t += 1000) expect(step(duo(14_500 - (t - 35_000) / 5, 10_300, t), t).reason).toContain('hunt');
        let d = step([], 41_000);
        expect(memory.quarry.losses).toBe(AMBUSH_AFTER);
        expect(d.reason).toMatch(/ambush|lie in wait/);
        const spot = memory.quarry.spot;
        expect(Math.abs(spot.y - 10_300)).toBeGreaterThanOrEqual(900);    // off its line
        expect(spot.x).toBeLessThan(14_500);                              // ahead of where it came back, its way in
        // At the spot, it comes on along its line: hold, don't walk out at it.
        d = step(duo(17_000, 10_300, 60_000), 60_000, spot);
        d = step(duo(16_800, 10_300, 61_000), 61_000, spot);
        d = step(duo(16_600, 10_300, 62_000), 62_000, spot);
        expect(d.reason).toContain('lie in wait');
        expect(d.anchor).toMatchObject({ x: spot.x, y: spot.y });
    });

    test('ambush off: back to the patrol at once, as before', () => {
        const { step } = play({ ambush: false });
        for (let t = 0; t <= 3000; t += 1000) step(duo(14_000 + t / 5, 10_000, t), t);
        expect(step([], 5000).reason).toContain('patrol');
    });
});
