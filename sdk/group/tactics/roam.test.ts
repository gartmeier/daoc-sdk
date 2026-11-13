import { describe, expect, test } from 'bun:test';
import { picture, report } from '../fixtures';
import { decideRvr, defaultPatrol, RVR_SETTINGS, THIDRANKI, type RvrSettings } from '../rvr';
import { mergeSettings, type CoordinatorContext } from '../strategy';
import type { GroupPicture, MemberReport } from '../types';
import { roamGoal } from './help';
import { meetingPlaces, pickPlace, ROAM_SETTINGS, roamStep, sightingPlaces, type RoamPlace } from './roam';

const place = (key: string, x: number, y: number, weight = 1): RoamPlace => ({ key, what: key, x, y, weight });
const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]!; };

describe('the roam (S3; the user: "we\'re doing the same back and forth every time")', () => {
    test('pickPlace: never one of the last few nor where we stand; within a leg\'s reach while one is; weighted', () => {
        const ps = [place('a', 1000, 0), place('b', 6000, 0), place('c', 30_000, 0), place('here', 100, 0)];
        expect(pickPlace(ps, { x: 0, y: 0 }, ['a'], () => 0)?.key).toBe('b');
        // c is 30k off: never while a and b are within 16000.
        for (const r of [0, 0.3, 0.6, 0.99]) expect(pickPlace(ps, { x: 0, y: 0 }, [], () => r)?.key).not.toBe('c');
        // A fresh big sighting outweighs an empty meeting place at the same distance.
        const w = [place('meet', 5000, 0, 1), place('seen', -5000, 0, 8)];
        const picks = Array.from({ length: 50 }, (_, i) => pickPlace(w, { x: 0, y: 0 }, [], () => i / 50)?.key);
        expect(picks.filter(k => k === 'seen').length).toBeGreaterThan(35);
    });

    test('pickPlace: a sighting first, at any distance (the user at 19:51: "There are no enemies here")', () => {
        const ps = [place('meet', 3000, 0), place('seen:1', 30_000, 0, 0.5)];
        for (const r of [0, 0.5, 0.99]) expect(pickPlace(ps, { x: 0, y: 0 }, [], () => r)?.key).toBe('seen:1');
    });

    test('roamStep: 5 min in one area with no enemy seen in it, then a place at least 12000 off', () => {
        const mem: Record<string, any> = {};
        const ps = [place('a', 2000, 0), place('b', -2000, 0), place('c', 0, 2500), place('far', 20_000, 0)];
        roamStep(mem, { centre: { x: 0, y: 0 }, places: ps, now: 0, rand: seq(0) });
        // A sighting in the area 2 min in keeps it fresh until 7 min.
        const sightings = [{ x: 1000, y: 0, n: 2, at: 120_000 }];
        expect(roamStep(mem, { centre: { x: 100, y: 0 }, places: ps, now: 400_000, rand: seq(0), sightings })!.reason).not.toMatch(/far off/);
        const r = roamStep(mem, { centre: { x: 100, y: 0 }, places: ps, now: 421_000, rand: seq(0), sightings })!;
        expect(r.reason).toMatch(/min here with no enemy seen, far off/);
        expect(r.place.key).toBe('far');
    });

    test('roamGoal: only a friend out roaming or fighting, never one resting (19:51: hibernia closed on hibernia-2 resting)', () => {
        const friend = (phase: string | null) => ({ realmUnits: [{ unit: 'hibernia-2', x: 8000, y: 0, z: 0, alive: 6, size: 6, fight: false, phase }] });
        expect(roamGoal(friend('travel'), { x: 0, y: 0 }, null, undefined, 0)?.friend.unit).toBe('hibernia-2');
        expect(roamGoal(friend('recover'), { x: 0, y: 0 }, null, undefined, 0)).toBeNull();
        expect(roamGoal(friend('idle'), { x: 0, y: 0 }, null, undefined, 0)).toBeNull();
    });

    test('sightingPlaces: weight from how many and how fresh; none past 5 min', () => {
        const ok = () => true;
        const s = sightingPlaces([{ x: 1, y: 1, n: 6, at: 0 }, { x: 5000, y: 1, n: 2, at: 0 }], 60_000, ok);
        expect(s[0]!.weight).toBeGreaterThan(s[1]!.weight);
        expect(sightingPlaces([{ x: 1, y: 1, n: 6, at: 0 }], ROAM_SETTINGS.sightingMs + 1, ok)).toHaveLength(0);
    });

    test('roamStep by default: no stop, on reaching a place on to the next at once (the user: "there shouldn\'t be stops")', () => {
        const mem: Record<string, any> = {};
        const ps = [place('a', 5000, 0), place('b', -5000, 0)];
        let r = roamStep(mem, { centre: { x: 0, y: 0 }, places: ps, now: 0, rand: seq(0.99) })!;
        const first = r.place.key;
        r = roamStep(mem, { centre: { x: r.place.x - 800, y: 0 }, places: ps, now: 10_000, rand: seq(0.99) })!;
        expect(r.kind).toBe('go');
        expect(r.place.key).not.toBe(first);
        expect(r.reason).toMatch(/^roam: past /);
    });

    test('roamStep with a long stay: go, stay a while walking a small circle, then on to another place (not the same)', () => {
        const S = { ...ROAM_SETTINGS, stayMin: 60_000, stayMax: 150_000 };
        const mem: Record<string, any> = {};
        const ps = [place('a', 5000, 0), place('b', -5000, 0), place('c', 0, 6000)];
        let r = roamStep(mem, { centre: { x: 0, y: 0 }, places: ps, now: 0, rand: seq(0), settings: S })!;
        expect(r.kind).toBe('go');
        const first = r.place.key;
        r = roamStep(mem, { centre: r.place, places: ps, now: 10_000, rand: seq(0), settings: S })!;
        expect(r.kind).toBe('stay');
        expect(r.reason).toContain('looking about');
        r = roamStep(mem, { centre: r.place, places: ps, now: 10_000 + S.stepMs + 1, rand: seq(0), settings: S })!;
        expect(r.kind).toBe('stay');
        expect(Math.hypot(r.goal.x - r.place.x, r.goal.y - r.place.y)).toBeCloseTo(S.circle, -1);
        r = roamStep(mem, { centre: r.place, places: ps, now: 10_000 + S.stayMax + 1, rand: seq(0), settings: S })!;
        expect(r.kind).toBe('go');
        expect(r.place.key).not.toBe(first);
    });

    test('meetingPlaces in Thidranki: the ring, our two pair grounds, each realm\'s bank by the Faste', () => {
        const ring = defaultPatrol(THIDRANKI, 'hibernia', 24);
        const ps = meetingPlaces(THIDRANKI, 'hibernia', ring, () => true);
        expect(ps.filter(p => p.key.startsWith('pair:')).map(p => p.key).sort()).toEqual(['pair:albion|hibernia', 'pair:hibernia|midgard']);
        expect(ps.filter(p => p.key.startsWith('bank:'))).toHaveLength(3);
        expect(ps.filter(p => p.key.startsWith('ring')).length).toBe(ring.length);
        // The user: "going by mid PK, alb PK, Faste": the approaches to the other two portal keeps and the Faste's surroundings.
        expect(new Set(ps.filter(p => p.key.startsWith('pk:')).map(p => p.key.split(':')[1]))).toEqual(new Set(['midgard', 'albion']));
        expect(ps.filter(p => p.key.startsWith('faste:')).length).toBe(6);
    });

    test('decideRvr with no patrol of its own roams instead of the fixed ring', () => {
        const caps = { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] };
        const members: MemberReport[] = ['Tank', 'Druid', 'Bard'].map((n, i) => report(n, { role: i ? 'healer' : 'tank', className: i ? 'Druid' : 'Hero', objectId: i + 1, regionId: THIDRANKI, x: 30_000 + i * 50, y: 30_000, z: 3800, level: 24, capabilities: caps }));
        const ctx = (p: GroupPicture, memory: Record<string, any>): CoordinatorContext<RvrSettings> =>
            ({ picture: p, orders: p.orders, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, { patrol: null } as any) });
        const d = decideRvr(ctx(picture(members), {}));
        expect(d.reason).toMatch(/^roam: to /);
        const off = decideRvr({ ...ctx(picture(members), {}), settings: mergeSettings(RVR_SETTINGS, { patrol: null, roamPlaces: false } as any) });
        expect(off.reason).toMatch(/^patrol to waypoint/);
    });
});
