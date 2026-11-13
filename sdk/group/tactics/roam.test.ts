import { describe, expect, test } from 'bun:test';
import { picture, report } from '../fixtures';
import { decideRvr, defaultPatrol, RVR_SETTINGS, THIDRANKI, type RvrSettings } from '../rvr';
import { mergeSettings, type CoordinatorContext } from '../strategy';
import type { GroupPicture, MemberReport, Point } from '../types';
import type { PlayerRealm } from '../keeps';
import { nextPlace, roamCircuit, roamPlaces, roamStep, ROAM_SETTINGS, shouldLeave, sideOf, sightingPlaces, type RoamMemory, type RoamPlace } from './roam';

const place = (key: string, x: number, y: number, side?: PlayerRealm): RoamPlace => ({ key, what: key, x, y, side });
const fresh = (): RoamMemory => ({ place: null, since: 0, until: 0, side: 0, done: [], passed: [] });
const seen = (x: number, y: number, at: number, n = 3) => ({ x, y, n, at });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('the roam\'s place picker (rule 1)', () => {
    const sides: PlayerRealm[] = ['hibernia', 'midgard', 'albion'];
    const ps = [place('h1', 2000, 0, 'hibernia'), place('h2', 6000, 0, 'hibernia'), place('m1', 20_000, 0, 'midgard'), place('m2', 24_000, 0, 'midgard'), place('a1', 0, 20_000, 'albion')];
    const args = (centre: Point, sightings: RoamPlace[] = []) => ({ centre, places: ps, sightings, circuit: sides });

    test('the nearest place on the current side we have not passed; that side done, the next side', () => {
        const r = fresh();
        expect(nextPlace(r, args({ x: 0, y: 0 }))?.key).toBe('h1');
        r.done = ['h1'];
        expect(nextPlace(r, args({ x: 2000, y: 0 }))?.key).toBe('h2');
        r.done = ['h1', 'h2'];
        expect(nextPlace(r, args({ x: 6000, y: 0 }))?.key).toBe('m1');
        expect(r.side).toBe(1);
    });

    test('round again: after the last side our own, its places fresh again', () => {
        const r = { ...fresh(), side: 2, done: ['a1', 'h1', 'h2'] };
        expect(nextPlace(r, args({ x: 0, y: 20_000 }))?.key).toBe('h1');
        expect(r.side).toBe(0);
        expect(r.done).toEqual(['a1']);
    });

    test('a fresh sighting near us comes first; one beyond sightingReach, or one we passed since, does not', () => {
        const near: RoamPlace = { ...place('seen:1:1', 4000, 3000, 'hibernia'), at: 1000 };
        const far: RoamPlace = { ...place('seen:9:9', 0, ROAM_SETTINGS.sightingReach + 2000, 'albion'), at: 1000 };
        expect(nextPlace(fresh(), args({ x: 0, y: 0 }, [far, near]))?.key).toBe('seen:1:1');
        expect(nextPlace(fresh(), args({ x: 0, y: 0 }, [far]))?.key).toBe('h1');
        const r = { ...fresh(), passed: [{ x: 4000, y: 3000, at: 2000 }] };
        expect(nextPlace(r, args({ x: 0, y: 0 }, [near]))?.key).toBe('h1');
        // Seen again there after we passed: news again.
        expect(nextPlace(r, args({ x: 0, y: 0 }, [{ ...near, at: 3000 }]))?.key).toBe('seen:1:1');
    });

    test('never where we stand, never a blocked place', () => {
        expect(nextPlace(fresh(), args({ x: 2100, y: 0 }))?.key).toBe('h2');
        expect(nextPlace(fresh(), { ...args({ x: 0, y: 0 }), blocked: p => p.x < 3000 })?.key).toBe('h2');
    });
});

describe('sightings by area (live 20:44: "past X, on to Y" every 2-5 s through cells 1200-2500 apart, 2-4 min old)', () => {
    test('those within 3000 of the freshest are one place with all their enemies; none older than 150 s', () => {
        const now = 200_000;
        const ps = sightingPlaces(1, [seen(0, 0, now - 60_000, 2), seen(1300, 0, now - 20_000, 5), seen(2500, 1000, now - 90_000, 3), seen(9000, 0, now - 10_000, 1), seen(20_000, 0, now - 160_000, 6)], now, () => true);
        expect(ps).toHaveLength(2);
        const area = ps.find(p => p.x === 1300)!;
        expect(area.what).toMatch(/^where 10 enemies were seen 20 s ago/);
        expect(ps.some(p => p.x === 9000)).toBe(true);
    });

    test('passing one area: its neighbours within 3000 are no news, so the roam goes on round the circuit', () => {
        const mem: Record<string, any> = {};
        const ps = [place('h1', 0, 8000), place('h2', 0, -8000)];
        const now = 100_000;
        const cells = [seen(4000, 0, now - 30_000, 3), seen(7200, 0, now - 100_000, 2), seen(8500, 800, now - 110_000, 2)];
        expect(roamStep(mem, { regionId: 1, centre: { x: 0, y: 0 }, places: ps, sightings: cells, now })!.place.key).toBe('seen:4000:0');
        const on = roamStep(mem, { regionId: 1, centre: { x: 4800, y: 0 }, places: ps, sightings: cells, now: now + 20_000 })!;
        expect(on.place.key).not.toMatch(/^seen:/);
    });
});

describe('the roam\'s leave rule (rule 2)', () => {
    const goal = place('m1', 20_000, 0, 'midgard');
    const sighting: RoamPlace = { ...place('seen:1:1', 4000, 0), at: 0 };
    const held = (since: number, p: RoamPlace = goal): RoamMemory => ({ ...fresh(), place: p, since, until: since + 300_000 });

    test('a place holds 10 s against a sighting, then the sighting takes over; nothing else takes over', () => {
        expect(shouldLeave(held(0), { centre: { x: 0, y: 0 }, now: 9_000, better: sighting })).toBe(false);
        expect(shouldLeave(held(0), { centre: { x: 0, y: 0 }, now: 11_000, better: sighting })).toBe(true);
        expect(shouldLeave(held(0), { centre: { x: 0, y: 0 }, now: 60_000, better: place('h1', 100, 0) })).toBe(false);
        // A sighting we go to is never left for another.
        expect(shouldLeave(held(0, sighting), { centre: { x: 10_000, y: 0 }, now: 60_000, better: { ...sighting, key: 'seen:2:2', at: 50_000 } })).toBe(false);
    });

    test('passed (within reach), given up (too long on the way) or blocked: left at once', () => {
        expect(shouldLeave(held(0), { centre: { x: 19_200, y: 0 }, now: 1000, better: null })).toBe(true);
        expect(shouldLeave(held(0), { centre: { x: 0, y: 0 }, now: 300_001, better: null })).toBe(true);
        expect(shouldLeave(held(0), { centre: { x: 0, y: 0 }, now: 1000, better: null, blocked: () => true })).toBe(true);
    });
});

describe('roamStep', () => {
    const ps = [place('a', 5000, 0), place('b', 10_000, 0), place('c', 15_000, 0)];

    test('no stop: reaching a place goes straight on to the next in the same tick (the user: "there shouldn\'t be stops")', () => {
        const mem: Record<string, any> = {};
        let r = roamStep(mem, { regionId: 1, centre: { x: 0, y: 0 }, places: ps, now: 0 })!;
        expect(r.place.key).toBe('a');
        expect(r.reason).toMatch(/^roam: to a /);
        r = roamStep(mem, { regionId: 1, centre: { x: 4300, y: 0 }, places: ps, now: 30_000 })!;
        expect(r.place.key).toBe('b');
        expect(r.reason).toMatch(/^roam: past a, on to b /);
    });

    test('passing through a place on the way counts: it is not gone to again this lap', () => {
        const mem: Record<string, any> = {};
        expect(roamStep(mem, { regionId: 1, centre: { x: 0, y: 0 }, places: ps, now: 0 })!.place.key).toBe('a');
        // Pulled off by a hunt, the group passes b: done, though a is still where it goes.
        expect(roamStep(mem, { regionId: 1, centre: { x: 10_100, y: 0 }, places: ps, now: 5_000 })!.place.key).toBe('a');
        expect(mem.roam.done).toContain('b');
        expect(roamStep(mem, { regionId: 1, centre: { x: 4_500, y: 0 }, places: ps, now: 30_000 })!.place.key).toBe('c');
    });

    test('a sighting near us: taken after the 10 s hold; reached on another side, the circuit goes on from that side', () => {
        const sides: PlayerRealm[] = ['hibernia', 'midgard', 'albion'];
        const T = THIDRANKI;
        const places = [place('h1', 30_000, 28_000, 'hibernia'), place('m1', 50_000, 20_000, 'midgard'), place('m2', 56_000, 20_000, 'midgard')];
        const spot = { x: 38_000, y: 27_000 };
        expect(sideOf(T, spot)).toBe('midgard');
        const s = [seen(spot.x, spot.y, 4000)];
        const mem: Record<string, any> = {};
        const go = (centre: Point, now: number, sightings: typeof s = []) => roamStep(mem, { regionId: T, centre, places, sightings, circuit: sides, now })!;
        expect(go({ x: 30_000, y: 20_000 }, 0).place.key).toBe('h1');
        expect(go({ x: 32_000, y: 23_000 }, 5_000, s).place.key).toBe('h1');
        const turned = go({ x: 33_000, y: 24_000 }, 11_000, s);
        expect(turned.place.key).toMatch(/^seen:/);
        expect(turned.reason).toMatch(/^roam: turning for where 3 enemies were seen/);
        const on = go(spot, 40_000, s);
        expect(mem.roam.side).toBe(1);
        expect(on.place.key).toBe('m1');
    });

    test('a place we never get to is given up (stuck or a detour that never ends), and not picked again this lap', () => {
        const mem: Record<string, any> = {};
        roamStep(mem, { regionId: 1, centre: { x: 0, y: 0 }, places: ps, now: 0 });
        const until = mem.roam.until;
        let r = roamStep(mem, { regionId: 1, centre: { x: 100, y: 0 }, places: ps, now: 1000 })!;
        for (let t = 2000; t <= until + 1000 && r.place.key === 'a'; t += 1000) r = roamStep(mem, { regionId: 1, centre: { x: 100, y: 0 }, places: ps, now: t })!;
        expect(r.reason).toMatch(/^roam: gave up on a, on to b/);
        expect(mem.roam.done).toContain('a');
    });

    test('the give-up clock pauses while something else has the group (live 20:22: camelot-2 gave up on a sighting after a 2-min rest)', () => {
        const mem: Record<string, any> = {};
        roamStep(mem, { regionId: 1, centre: { x: 0, y: 0 }, places: ps, now: 0 });
        const until = mem.roam.until;
        // A rest of until + 60 s, the roam not asked in between: still on to a, the clock moved on by the gap.
        const r = roamStep(mem, { regionId: 1, centre: { x: 100, y: 0 }, places: ps, now: until + 60_000 })!;
        expect(r.place.key).toBe('a');
        expect(r.reason).toMatch(/^roam: to a /);
        expect(mem.roam.until).toBeGreaterThan(until + 60_000);
    });
});

describe('the roam in Thidranki: the circuit over the realms\' sides (the user: "Hib\'s island, then Mid\'s, then Albion\'s")', () => {
    const ring = defaultPatrol(THIDRANKI, 'hibernia', 24);
    const ps = roamPlaces(THIDRANKI, 'hibernia', ring, () => true);

    test('places on every side, our own portal keep\'s approach among ours', () => {
        expect(roamCircuit('hibernia')).toEqual(['hibernia', 'midgard', 'albion']);
        expect(roamCircuit('albion')).toEqual(['albion', 'hibernia', 'midgard']);
        for (const side of ['hibernia', 'midgard', 'albion']) expect(ps.some(p => p.side === side)).toBe(true);
        expect(ps.some(p => p.key.startsWith('pk:hibernia') && p.side === 'hibernia')).toBe(true);
        expect(new Set(ps.filter(p => p.key.startsWith('pk:')).map(p => p.key.split(':')[1]))).toEqual(new Set(['hibernia', 'midgard', 'albion']));
    });

    test('walked out from our portal keep: each side in turn, every place once a lap, moving all the time, no short hops back', () => {
        const mem: Record<string, any> = {};
        let centre: Point = { x: 18_400, y: 18_300 };
        const visits: RoamPlace[] = [];
        let now = 0;
        for (let tick = 0; tick < 4000 && visits.length < ps.length * 2; tick++) {
            const r = roamStep(mem, { regionId: THIDRANKI, centre, places: ps, circuit: roamCircuit('hibernia'), now })!;
            if (visits[visits.length - 1]?.key !== r.place.key) visits.push(r.place);
            // Walk 190 a second toward it.
            const d = dist(centre, r.goal);
            const k = Math.min(1, 190 / Math.max(1, d));
            centre = { x: centre.x + (r.goal.x - centre.x) * k, y: centre.y + (r.goal.y - centre.y) * k };
            now += 1000;
        }
        const runs = visits.map(p => p.side).reduce<string[]>((a, x) => (a[a.length - 1] === x ? a : [...a, x!]), []);
        expect(runs.slice(0, 4)).toEqual(['hibernia', 'midgard', 'albion', 'hibernia']);
        // A lap: every place once before any comes again.
        const lap = visits.slice(0, ps.length).map(p => p.key);
        expect(new Set(lap).size).toBe(lap.length);
    });
});

describe('decideRvr roams the circuit with no patrol of its own', () => {
    const caps = { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] };
    const members: MemberReport[] = ['Tank', 'Druid', 'Bard'].map((n, i) => report(n, { role: i ? 'healer' : 'tank', className: i ? 'Druid' : 'Hero', objectId: i + 1, regionId: THIDRANKI, x: 30_000 + i * 50, y: 30_000, z: 3800, level: 24, capabilities: caps }));
    const ctx = (p: GroupPicture, memory: Record<string, any>, extra: Partial<RvrSettings> = {}): CoordinatorContext<RvrSettings> =>
        ({ picture: p, orders: p.orders, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, { patrol: null, ...extra } as any) });

    test('roam on our side first; roamPlaces: false is the old ring', () => {
        const d = decideRvr(ctx(picture(members), { realm: 'hibernia' }));
        expect(d.reason).toMatch(/^roam: to .*our side/);
        const off = decideRvr(ctx(picture(members), {}, { roamPlaces: false }));
        expect(off.reason).toMatch(/^patrol to waypoint/);
    });

    test('a friendly group resting nearby is not trailed: the roam goes its own way', () => {
        const friend = { unit: 'hibernia-2', x: 36_000, y: 30_000, z: 0, alive: 6, size: 6, fight: false, phase: 'recover' };
        const d = decideRvr(ctx(picture(members), { realm: 'hibernia', realmUnits: [friend] }));
        expect(d.reason).toMatch(/^roam: /);
        expect(d.reason).not.toContain('hibernia-2');
    });
});
