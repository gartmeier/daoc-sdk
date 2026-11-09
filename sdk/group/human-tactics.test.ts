// What human groups did when two met (user, live 2026-11-09, and research): the casters fan out and stay off, the
// focus goes on the back line, the Bard walks round the fight to interrupt. All off by default (pack.ts, behaviors.ts).
import { describe, expect, test } from 'bun:test';
import { FLANK_CLEAR, flankStep, formationOffset, spreadFormation } from './behaviors';
import { enemy } from './fixtures';
import { fanOutStep, HEAL_REACH, healerStep, PACK_OPTIONS, PACK_SETTINGS } from './pack';
import { pickPackFocus } from './rvr';
import type { Point } from './types';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('pickPackFocus soft (pack.focusSoft)', () => {
    const c = { x: 0, y: 0 };
    const tank = enemy(1, 'midgard', { x: 500, y: 0, target: 'Druid', targetBySpell: false });
    const back = enemy(2, 'midgard', { x: 1400, y: 0 });

    test('the back line before the nearest: a caster, then a healer, and not the one in melee with us', () => {
        expect(pickPackFocus([tank, back], c, 1500)!.objectId).toBe(1);
        expect(pickPackFocus([tank, back], c, 1500, true)!.objectId).toBe(2);
        expect(pickPackFocus([tank, { ...back, healer: true }], c, 1500, true)!.objectId).toBe(2);
        const caster = enemy(3, 'midgard', { x: 1450, y: 0, caster: true });
        expect(pickPackFocus([tank, { ...back, healer: true }, caster], c, 1500, true)!.objectId).toBe(3);
    });

    test('the one in melee with us when nobody else is in reach', () => {
        expect(pickPackFocus([tank], c, 1500, true)!.objectId).toBe(1);
    });
});

describe('fanOutStep (pack.fanMin)', () => {
    const k = { ...PACK_OPTIONS, fanMin: 1100, fanGap: 400 };

    test('off: stays', () => {
        expect(fanOutStep({ x: 0, y: 0 }, [{ x: 300, y: 0 }], [], { ...k, fanMin: 0 })).toBeNull();
    });

    test('an enemy within fanMin: a step straight away from it', () => {
        const to = fanOutStep({ x: 0, y: 0 }, [{ x: 700, y: 0 }], [], k)!;
        expect(to.x).toBeLessThan(0);
        expect(Math.abs(to.y)).toBeLessThan(1);
        expect(dist(to, { x: 0, y: 0 })).toBeLessThanOrEqual(500);
    });

    test('no step into water or toward a second enemy: turned off the straight way', () => {
        const to = fanOutStep({ x: 0, y: 0 }, [{ x: 700, y: 0 }], [], k, p => p.x < -100 && Math.abs(p.y) < 100)!;
        expect(Math.abs(to.y)).toBeGreaterThan(100);
        expect(dist(to, { x: 700, y: 0 })).toBeGreaterThan(700);
    });

    test('far enough off and a caster of ours close: sideways, away from it, no nearer the enemy', () => {
        const to = fanOutStep({ x: 0, y: 0 }, [{ x: 1500, y: 0 }], [{ x: 0, y: 150 }], k)!;
        expect(to.y).toBeLessThan(0);
        expect(dist(to, { x: 0, y: 150 })).toBeGreaterThanOrEqual(400);
    });

    test('far enough off and spread: stays', () => {
        expect(fanOutStep({ x: 0, y: 0 }, [{ x: 1500, y: 0 }], [{ x: 0, y: 600 }], k)).toBeNull();
    });
});

describe('flankStep (ccFlank): round the fight to a target at the back', () => {
    // Their supporter at the back, 2600 east; the melee in the middle at 1300 east.
    const me = { x: 0, y: 0 };
    const target = { x: 2600, y: 0 };
    const middle = [enemy(11, 'midgard', { x: 1300, y: 0 }), enemy(12, 'midgard', { x: 1300, y: 200 })];
    const contacts = [enemy(10, 'midgard', target), ...middle];

    test('a leg that keeps clear of the middle, toward a spot in reach of the target', () => {
        const to = flankStep(me, target, 1500, 4000, contacts, 10)!;
        expect(to).not.toBeNull();
        expect(dist(me, to)).toBeLessThanOrEqual(601);
        for (const m of middle) expect(dist(m, to)).toBeGreaterThanOrEqual(FLANK_CLEAR);
    });

    test('step by step it comes into reach without ever passing the middle', () => {
        let at: Point = me;
        for (let i = 0; i < 20 && dist(at, target) > 1500 * 0.85 + 1; i++) {
            const to = flankStep(at, target, 1500, 6000, contacts, 10);
            if (!to) break;
            for (const m of middle) expect(dist(m, to)).toBeGreaterThanOrEqual(FLANK_CLEAR);
            at = to;
        }
        expect(dist(at, target)).toBeLessThanOrEqual(1500 * 0.85 + 1);
    });

    test('beyond its budget, or a mezzed middle: holds, or goes straight', () => {
        expect(flankStep(me, target, 1500, 500, contacts, 10)).toBeNull();
        const mezzed = [enemy(10, 'midgard', target), ...middle.map(m => ({ ...m, cc: { by: 'Oisin', kind: 'mezz', until: Date.now() + 30_000 } }))];
        const to = flankStep(me, target, 1500, 4000, mezzed, 10)!;
        expect(Math.abs(to.y)).toBeLessThan(1);
    });
});

describe('spreadOnSight: wider caster slots once an enemy is known', () => {
    const f = PACK_SETTINGS.formation;

    test('1 or less: the formation as it is', () => {
        expect(spreadFormation(f, 0)).toBe(f);
        expect(spreadFormation(f, 1)).toBe(f);
    });

    test('2: nukers and the healer twice as far back and apart, the tank and the Bard where they were', () => {
        const s = spreadFormation(f, 2);
        expect(s.tank).toEqual(f.tank);
        expect(s.support).toEqual(f.support);
        expect(s.nuker!.back).toBe(f.nuker!.back * 2);
        const gap = (form: typeof f) => dist(formationOffset(form, 'nuker', 0, 0), formationOffset(form, 'nuker', 1, 0));
        expect(gap(s)).toBeGreaterThan(gap(f) * 2);
        expect(s.healer!.angle).toBeLessThanOrEqual(1.2);
    });
});

describe('healerStep: everyone in heal reach, toward where the damage goes', () => {
    const k = { fanMin: 1100 };
    const me = { x: 0, y: 0 };

    test('everyone within HEAL_REACH: stays', () => {
        expect(healerStep(me, [{ x: 1500, y: 0 }, { x: -800, y: 300 }], [], [], k)).toBeNull();
    });

    test('one beyond it: a leg toward the members being hit, not the others', () => {
        const tank = { x: 2600, y: 0 }, nuker = { x: 0, y: 900 };
        const to = healerStep(me, [tank, nuker], [tank], [], k)!;
        expect(to.x).toBeGreaterThan(400);
        expect(Math.abs(to.y)).toBeLessThan(1);
        expect(HEAL_REACH).toBeLessThan(2000);
    });

    test('nobody hit: toward them all; an enemy on the straight way: round it', () => {
        const far = [{ x: 2600, y: 0 }, { x: 2400, y: 200 }];
        expect(healerStep(me, far, [], [], k)!.x).toBeGreaterThan(400);
        const to = healerStep(me, far, [], [{ x: 900, y: 0 }], k)!;
        expect(dist(to, { x: 900, y: 0 })).toBeGreaterThanOrEqual(770);
        expect(to.x).toBeGreaterThan(0);
    });
});
