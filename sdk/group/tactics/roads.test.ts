import { describe, expect, test } from 'bun:test';
import { picture, report } from '../fixtures';
import { BATTLEGROUND_LAYOUTS, clearOf, keepDangers, THIDRANKI } from '../keeps';
import { decidePack, PACK_SETTINGS, type PackSettings } from '../pack';
import { decideRvr, RVR_SETTINGS, type RvrSettings } from '../rvr';
import { mergeSettings, type CoordinatorContext } from '../strategy';
import type { MemberReport, Point } from '../types';
import { offRoadsOut, onRoadOut, ROAD_OUT_NEAR, ROAD_OUT_WIDTH, roadsOut } from './roads';

const bg = BATTLEGROUND_LAYOUTS[THIDRANKI]!;
const keep = (name: string) => bg.keeps.find(k => k.name === name)!;
const MID = keep('Midgard Portal Keep');
const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** `km` thousand units from Midgard's arrival toward the meeting point. */
const midRoad = (units: number): Point => {
    const a = bg.arrival.midgard, l = d(a, bg.meet);
    return { x: Math.round(a.x + (bg.meet.x - a.x) * units / l), y: Math.round(a.y + (bg.meet.y - a.y) * units / l) };
};

describe('roads out of the enemy portal keeps', () => {
    const roads = roadsOut(THIDRANKI, 'albion');

    test("Albion's enemies' roads: Midgard's and Hibernia's, never its own", () => {
        expect(roads.map(r => r.realm).sort()).toEqual(['hibernia', 'midgard']);
        expect(roadsOut(9999, 'albion')).toEqual([]);
    });

    test('Camelot camping Midgard (11:05 UTC, 12:20 local): its ambush spot 5864 out and its rest 5000 out are on the road', () => {
        expect(onRoadOut({ x: MID.x - 5864, y: MID.y }, roads)?.realm).toBe('midgard');
        expect(onRoadOut({ x: MID.x, y: MID.y + 5000 }, roads)?.realm).toBe('midgard');
        expect(onRoadOut(midRoad(11_000), roads)?.realm).toBe('midgard');           // along its road to the meeting point
    });

    test('off it: beside the road, the meeting point, the far side of the map', () => {
        const at = midRoad(11_000), a = bg.arrival.midgard, l = d(a, bg.meet);
        // The south side: the north one is between its two roads west, to the meeting point and to the pair point with Hibernia.
        const side = { x: at.x + (bg.meet.y - a.y) / l * (ROAD_OUT_WIDTH + 500), y: at.y - (bg.meet.x - a.x) / l * (ROAD_OUT_WIDTH + 500) };
        expect(d(side, MID)).toBeGreaterThan(ROAD_OUT_NEAR);
        expect(onRoadOut(side, roads)).toBeNull();
        expect(onRoadOut(bg.meet, roads)).toBeNull();
        expect(onRoadOut(bg.arrival.albion, roads)).toBeNull();
    });

    test('a spot off the roads: itself when off, else the nearest one clear of them', () => {
        expect(offRoadsOut(bg.meet, roads)).toEqual({ x: bg.meet.x, y: bg.meet.y, road: null });
        const from = { x: MID.x, y: MID.y + 5000 };
        const off = offRoadsOut(from, roads)!;
        expect(off.road?.realm).toBe('midgard');
        expect(onRoadOut(off, roads, 250)).toBeNull();
        expect(d(off, from)).toBeLessThan(5000);
        expect(offRoadsOut(from, roads, () => false)).toBeNull();
    });
});

// Camelot sat recovering about 5000 out on Midgard's road out (2026-11-12 12:20) and fought each unit that came out of it.
describe('resting off an enemy road out', () => {
    const at = { x: MID.x, y: MID.y + 5000 };
    const team = (power: number): MemberReport[] => ['Tank', 'Cleric', 'Minstrel', 'Wizard', 'Sorcerer'].map((n, i) =>
        report(n, { role: i === 0 ? 'tank' : i === 1 ? 'healer' : i === 2 ? 'support' : 'nuker', objectId: i + 1, regionId: THIDRANKI, x: at.x - i * 100, y: at.y, level: 24, mana: i >= 3 ? power : 100 }));
    const keeps = keepDangers(THIDRANKI, 'albion');

    test('decideRvr: waiting for power, off the road', () => {
        const p = picture(team(10), [], {}, 1000);
        const c: CoordinatorContext<RvrSettings> = { picture: p, orders: { ...p.orders, phase: 'travel', anchor: null }, memory: { realm: 'albion' }, now: 1000, windingDown: false, settings: mergeSettings(RVR_SETTINGS, {} as any) };
        const o = decideRvr(c);
        expect(o.phase).toBe('recover');
        expect(o.reason).toContain("off midgard's road out of its portal keep");
        expect(onRoadOut(o.anchor!, roadsOut(THIDRANKI, 'albion'))).toBeNull();
        expect(clearOf(o.anchor!, keeps)).toBe(true);
    });

    test('decideRvr: away from the roads it rests where it stands, as before', () => {
        const here = { x: bg.meet.x, y: bg.meet.y };
        const p = picture(team(10).map(m => ({ ...m, x: here.x + (m.x - at.x), y: here.y })), [], {}, 1000);
        const c: CoordinatorContext<RvrSettings> = { picture: p, orders: { ...p.orders, phase: 'travel', anchor: null }, memory: { realm: 'albion' }, now: 1000, windingDown: false, settings: mergeSettings(RVR_SETTINGS, {} as any) };
        const o = decideRvr(c);
        expect(o.phase).toBe('recover');
        expect(o.reason).not.toContain('road out');
        expect(d(o.anchor!, here)).toBeLessThan(1000);
    });

    test('decidePack: the same rest, off the road', () => {
        const p = picture(team(10), [], {}, 1000);
        const c: CoordinatorContext<PackSettings> = { picture: p, orders: { ...p.orders, phase: 'travel', anchor: null }, memory: { realm: 'albion' }, now: 1000, windingDown: false, settings: mergeSettings(PACK_SETTINGS, {} as any) };
        const o = decidePack(c);
        expect(o.phase).toBe('recover');
        expect(onRoadOut(o.anchor!, roadsOut(THIDRANKI, 'albion'))).toBeNull();
    });
});
