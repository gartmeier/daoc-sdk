import { describe, expect, test } from 'bun:test';
import { contact, report } from './fixtures';
import { combatSpot, dangerStops, effectiveLimits, focusSettled, safeSpot, trackFocus, type TrailPoint } from './positioning';
import type { Contact, MemberReport, Point } from './types';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const NOW = 1_000_000;
const MOON_BLAST = { castTime: 2.6, range: 1500 };
const GREATER_REVIVAL = { castTime: 3.6, range: 2000 };

// Fight #1 of the session-2 recording (21:27:55, Lough Derg): the wolf at its spawn 587 from the
// base, the tank 53 from it, Niamh 711 and Ciaran 476 from the fight. Members keep the bearings
// recorded at engage.
const BASE = { x: 348900, y: 519900 };
const WOLF = { x: 348647, y: 519370 };
const TANK = { x: 348674, y: 519416 };
const NIAMH = { x: WOLF.x + 680, y: WOLF.y - 206 };
const CIARAN = { x: WOLF.x + 243, y: WOLF.y - 409 };

const wolf = (over: Partial<Contact> = {}) =>
    contact(587, { name: 'red wolfhound', ...WOLF, hp: 80, target: 'Tank', threat: true, inCombat: true, lastSeen: NOW, ...over });
const members = (tank: Point = TANK, me: Point = CIARAN) =>
    [report('Tank', { role: 'tank', ...tank }), report('Niamh', { ...NIAMH }), report('Ciaran', { ...me })];
/** Degrees from `from`'s bearing to `to`'s, both seen from the wolf. */
const turn = (from: Point, to: Point) => {
    const a = Math.atan2(to.y - WOLF.y, to.x - WOLF.x) - Math.atan2(from.y - WOLF.y, from.x - WOLF.x);
    return (Math.atan2(Math.sin(a), Math.cos(a)) * 180) / Math.PI;
};
/** The point `r` from the wolf on `of`'s bearing turned by `deg`. */
const onBearing = (of: Point, r: number, deg = 0) => {
    const a = Math.atan2(of.y - WOLF.y, of.x - WOLF.x) + (deg * Math.PI) / 180;
    return { x: WOLF.x + Math.cos(a) * r, y: WOLF.y + Math.sin(a) * r };
};

/** combatSpot for `me` at fight #1 as position() would call it (nuker limits 700-1400 with Moon Blast). */
function fight(me: MemberReport, o: { tank?: Point; threats?: Contact[]; settled?: boolean; safe?: (p: Point) => boolean } = {}) {
    const all = members(o.tank, me);
    const stops = dangerStops(o.threats ?? [wolf()], all, me, NOW);
    const [min, max] = effectiveLimits([700, 1400], MOON_BLAST);
    return combatSpot({ me, anchor: BASE, stops, focus: { ...WOLF, d3: dist(me, WOLF) }, settled: o.settled ?? true, min, max, safe: o.safe ?? (() => true) });
}

describe('effectiveLimits', () => {
    test('a nuker with Moon Blast keeps the band 700-1400: its cast needs only 510, its range allows 1400', () => {
        expect(effectiveLimits([700, 1400], MOON_BLAST)).toEqual([700, 1400]);
        expect(effectiveLimits([500, 1400], MOON_BLAST)).toEqual([510, 1400]);
    });

    test('a healer with a 3.6 s heal stays 610 out: a mob covers 360 while the heal is cast', () => {
        expect(effectiveLimits([500, 1600], GREATER_REVIVAL)).toEqual([610, 1600]);
    });

    test('without a spell: the band, and 1400 at most (range 1500 less 100)', () => {
        expect(effectiveLimits([500, 1600], null)).toEqual([500, 1400]);
        expect(effectiveLimits([500, 1600], { castTime: 0, range: 0 })).toEqual([500, 1400]);
    });
});

describe('dangerStops', () => {
    const me = report('Ciaran', { ...CIARAN });

    test('a threat running at the tank stops at the tank; one on him stops where it is', () => {
        const tank = { x: WOLF.x + 400, y: WOLF.y };
        expect(dangerStops([wolf()], members(tank), me, NOW)).toEqual([{ x: tank.x, y: tank.y, objectId: 587, toward: 'Tank' }]);
        const near = { x: WOLF.x + 200, y: WOLF.y };
        expect(dangerStops([wolf()], members(near), me, NOW)).toEqual([{ x: WOLF.x, y: WOLF.y, objectId: 587, toward: null }]);
    });

    test('a threat on us is left to flee(); one targeting nobody we know stops where it is', () => {
        expect(dangerStops([wolf({ target: 'Ciaran' })], members(), me, NOW)).toEqual([]);
        expect(dangerStops([wolf({ target: null })], members(), me, NOW)).toEqual([{ ...WOLF, objectId: 587, toward: null }]);
        expect(dangerStops([wolf({ target: 'Someone' })], members(), me, NOW)).toEqual([{ ...WOLF, objectId: 587, toward: null }]);
    });

    test('a mezz with 10 s left holds the add; one ending within 3 s does not', () => {
        const add = (left: number) => wolf({ objectId: 600, target: null, cc: { by: 'Oisin', kind: 'mezz', until: NOW + left } });
        expect(dangerStops([add(10_000)], members(), me, NOW)).toEqual([]);
        expect(dangerStops([add(2000)], members(), me, NOW)).toEqual([{ ...WOLF, objectId: 600, toward: null }]);
    });

    test('stale and dead threats are no danger', () => {
        expect(dangerStops([wolf({ stale: true }), wolf({ hp: 0 })], members(), me, NOW)).toEqual([]);
    });
});

describe('combatSpot (fight #1)', () => {
    const niamh = report('Niamh', { ...NIAMH });
    const ciaran = report('Ciaran', { ...CIARAN });

    test('Niamh, 711 from the fight, stays put', () => {
        expect(Math.round(dist(NIAMH, WOLF))).toBe(711);
        expect(fight(niamh)).toBeNull();
    });

    test('Ciaran, 476 from it, steps straight out to 900 on his own bearing', () => {
        const s = fight(ciaran)!;
        expect(s).toMatchObject({ move: 'out', d: 476, want: 900 });
        const to = s.to!;
        expect(Math.abs(dist(to, WOLF) - 900)).toBeLessThan(1);
        // Never the far side of the fight, and no farther than the straight step (900 - 476, give or take rounding).
        expect((to.x - WOLF.x) * (CIARAN.x - WOLF.x) + (to.y - WOLF.y) * (CIARAN.y - WOLF.y)).toBeGreaterThan(0);
        expect(dist(CIARAN, to)).toBeLessThan(425);
    });

    test('with the tank 27 from the wolf the step is the same: where the tank stands does not matter', () => {
        const close = { x: WOLF.x + 14, y: WOLF.y + 23 };
        expect(Math.round(dist(close, WOLF))).toBe(27);
        expect(fight(ciaran, { tank: close })).toEqual(fight(ciaran)!);
    });

    test('a settled focus beyond max: a step in to 1250 on our bearing; an unsettled one: no move', () => {
        const far = report('Ciaran', onBearing(CIARAN, 1729));
        expect(fight(far, { settled: false })).toBeNull();
        const s = fight(far)!;
        expect(s).toMatchObject({ move: 'in', d: 1729, want: 1250 });
        expect(Math.abs(dist(s.to!, WOLF) - 1250)).toBeLessThan(1);
        expect(Math.abs(turn(CIARAN, s.to!))).toBeLessThan(0.1);
    });

    test('a spot in an aggressive mob\'s reach is turned to the first safe bearing', () => {
        // A zone over the straight spot and the +25° one (the first tried after it): -25° is next.
        const zone = onBearing(CIARAN, 880, 12.5);
        const s = fight(ciaran, { safe: p => dist(p, zone) > 250 })!;
        expect(Math.abs(turn(CIARAN, s.to!) + 25)).toBeLessThan(0.2);
        expect(Math.abs(dist(s.to!, WOLF) - 900)).toBeLessThan(1);
    });

    test('when every bearing is unsafe there is no spot: the member stays and casts', () => {
        expect(fight(ciaran, { safe: () => false })).toEqual({ move: 'out', d: 476, want: 900, to: null });
    });

    test('a spot near another stop is turned until every stop is min + 100 away', () => {
        // An add whose mezz ends soon, 500 beyond the straight spot: ±25° are 697 from it, ±50° 1072.
        const add = wolf({ objectId: 600, target: null, ...onBearing(CIARAN, 1400), cc: { by: 'Oisin', kind: 'mezz', until: NOW + 1000 } });
        const s = fight(ciaran, { threats: [wolf(), add] })!;
        expect(s.move).toBe('out');
        expect(Math.abs(turn(CIARAN, s.to!) - 50)).toBeLessThan(0.2);
        expect(dist(s.to!, add)).toBeGreaterThanOrEqual(800);
    });

    test('an out step that would leave the focus beyond max - 150 finds no spot', () => {
        // An add 300 from us, between us and the focus 1100 away: every bearing away from it is > 1250 from the focus.
        const focus = { x: 0, y: 0 }, me = { x: 1100, y: 0 }, add = { x: 800, y: 0 };
        const s = combatSpot({ me, anchor: null, stops: [focus, add], focus: { ...focus, d3: 1100 }, settled: true, min: 700, max: 1400, safe: () => true });
        expect(s).toEqual({ move: 'out', d: 300, want: 900, to: null });
    });

    test('standing on a stop: step away from the anchor, else east', () => {
        const at = { ...WOLF };
        const away = combatSpot({ me: at, anchor: BASE, stops: [WOLF], focus: null, settled: false, min: 700, max: 1400, safe: () => true })!;
        const u = { x: (WOLF.x - BASE.x) / dist(WOLF, BASE), y: (WOLF.y - BASE.y) / dist(WOLF, BASE) };
        expect(away.to).toEqual({ x: Math.round(WOLF.x + u.x * 900), y: Math.round(WOLF.y + u.y * 900) });
        const east = combatSpot({ me: at, anchor: null, stops: [WOLF], focus: null, settled: false, min: 700, max: 1400, safe: () => true })!;
        expect(east.to).toEqual({ x: WOLF.x + 900, y: WOLF.y });
    });

    test('no stops and no focus: no move', () => {
        expect(combatSpot({ me: CIARAN, anchor: BASE, stops: [], focus: null, settled: true, min: 700, max: 1400, safe: () => true })).toBeNull();
    });
});

describe('focusSettled', () => {
    const tank = report('Tank', { role: 'tank', ...TANK });
    const focus = wolf();
    const trail = (moved: number): TrailPoint[] => [{ id: 587, x: WOLF.x - moved, y: WOLF.y, at: NOW - 1200 }, { id: 587, ...WOLF, at: NOW - 250 }];

    test('on the tank and still: settled, from our own client\'s speed or the trail', () => {
        expect(focusSettled({ focus, at: WOLF, tank, speed: 0, trail: [], now: NOW })).toBe(true);
        expect(focusSettled({ focus, at: WOLF, tank, speed: 120, trail: trail(30), now: NOW })).toBe(true);
    });

    test('moving: not settled, nor without a sample a second old', () => {
        expect(focusSettled({ focus, at: WOLF, tank, speed: 191, trail: trail(190), now: NOW })).toBe(false);
        expect(focusSettled({ focus, at: WOLF, tank, speed: 191, trail: trail(0).slice(1), now: NOW })).toBe(false);
    });

    test('400 from the tank, on someone else, or no tank: not settled', () => {
        expect(focusSettled({ focus, at: { x: TANK.x + 400, y: TANK.y }, tank, speed: 0, trail: [], now: NOW })).toBe(false);
        expect(focusSettled({ focus: wolf({ target: 'Niamh' }), at: WOLF, tank, speed: 0, trail: [], now: NOW })).toBe(false);
        expect(focusSettled({ focus, at: WOLF, tank: undefined, speed: 0, trail: [], now: NOW })).toBe(false);
        expect(focusSettled({ focus, at: WOLF, tank: { ...tank, isDead: true }, speed: 0, trail: [], now: NOW })).toBe(false);
    });

    test('trackFocus keeps the last second plus the newest older sample, for this focus only', () => {
        let t: TrailPoint[] = [{ id: 9, x: 0, y: 0, at: NOW - 500 }];
        for (const ms of [2000, 1500, 1100, 700, 300]) t = trackFocus(t, 587, { x: WOLF.x - ms / 10, y: WOLF.y }, NOW - ms);
        t = trackFocus(t, 587, WOLF, NOW);
        expect(t.map(p => NOW - p.at)).toEqual([1100, 700, 300, 0]);
        expect(trackFocus(undefined, 587, WOLF, NOW)).toEqual([{ id: 587, ...WOLF, at: NOW }]);
    });
});

describe('safeSpot (static data, Shannon Estuary / Lough Derg)', () => {
    // An aggressive wind ghoul (L7, aggro range 500): its reach is 500 + roam 500 + slot pad 150 = 1150.
    const GHOUL = { x: 290348, y: 458975 };

    test('inside an aggressive mob\'s reach is unsafe, beyond it safe; tolerated cons are ignored', () => {
        const safe = safeSpot(200, 7, -3);
        expect(safe(GHOUL)).toBe(false);
        expect(safe({ x: GHOUL.x - 1100, y: GHOUL.y })).toBe(false);
        expect(safe({ x: GHOUL.x - 1200, y: GHOUL.y })).toBe(true);
        // Yellow to level 7: tolerated at aggroTolerance 0.
        expect(safeSpot(200, 7, 0)(GHOUL)).toBe(true);
        expect(safeSpot(200, 7, -3)).toBe(safe);
    });

    test('fight #1: at level 13 with hibernia\'s tolerance (0) Ciaran steps straight out; with only grey tolerated the lucradans turn him', () => {
        const ciaran = report('Ciaran', { ...CIARAN, level: 13 });
        const straight = fight(ciaran, { safe: safeSpot(200, 13, 0) })!;
        expect(Math.abs(turn(CIARAN, straight.to!))).toBeLessThan(0.1);
        const strict = safeSpot(200, 13, -3);
        expect(strict(onBearing(CIARAN, 900))).toBe(false);
        const turned = fight(ciaran, { safe: strict })!;
        expect(strict(turned.to!)).toBe(true);
        expect(Math.abs(dist(turned.to!, WOLF) - 900)).toBeLessThan(1);
        expect(Math.abs(turn(CIARAN, turned.to!))).toBeGreaterThan(20);
    });
});
