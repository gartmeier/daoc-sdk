import { describe, expect, test } from 'bun:test';
import { findNpcSpawns } from '../../data/index';
import { aggroReach, isAggressiveTo, MOB_ROAM_REACH, PLAN_PADS, planBase, planBaseFrom, planRejects, segDist, SPAWN_PAD, type BasePlanOptions, type PlanSpawn } from './baseplan';
import { formationOffset } from './behaviors';
import { PVE_SETTINGS } from './pve';
import { chooseBase } from './terrain';

const roles = ['tank', 'healer', 'support', 'nuker', 'nuker'] as const;
const opts = (over: Partial<BasePlanOptions> = {}): BasePlanOptions =>
    ({ level: 12, minCon: -1, maxCon: 3, pullAggressive: false, huntRadius: 3500, roles: [...roles], formation: PVE_SETTINGS.formation, ...over });
const mob = (name: string, x: number, y: number, over: Partial<PlanSpawn> = {}): PlanSpawn =>
    ({ name, x, y, z: 0, level: 13, aggroLevel: 0, aggroRange: 0, flags: 0, ...over });
const aggro = (name: string, x: number, y: number) => mob(name, x, y, { level: 12, aggroLevel: 51, aggroRange: 500 });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const CAMP = { x: 0, y: 0, z: 0 };

/** Every formation slot of a plan, placed from the facing decidePve orders, as formationSlot does. */
function slots(plan: { base: { x: number; y: number }; facing: { x: number; y: number } }) {
    const away = Math.atan2(plan.base.y - plan.facing.y, plan.base.x - plan.facing.x);
    const seen = new Map<string, number>();
    return roles.map(r => { const i = seen.get(r) ?? 0; seen.set(r, i + 1); const o = formationOffset(PVE_SETTINGS.formation, r, i, away); return { x: Math.round(plan.base.x + o.x), y: Math.round(plan.base.y + o.y) }; });
}

// A lucradan (aggro range 500) reaches 1000 from its spawn: 500 of navmesh roam plus its aggro range.
const LUCRADAN = aggro('lucradan', 1600, 1600);
const WIDE = { huntRadius: 5000, campRadius: 5000 };
const WOLVES = [mob('wolf', 0, 0), mob('wolf', 300, -400), mob('wolf', -400, 300)];

describe('planBaseFrom (synthetic)', () => {
    test('passive targets without aggressive mobs: the base sits among them', () => {
        const ring = Array.from({ length: 6 }, (_, i) => mob('wolf', Math.round(Math.cos(i) * 1500), Math.round(Math.sin(i) * 1500)));
        const plan = planBaseFrom(ring, CAMP, opts())!;
        expect(plan.targets.length).toBe(6);
        expect(dist(plan.base, CAMP)).toBeLessThan(800);
        for (const sl of slots(plan)) for (const s of ring) expect(dist(sl, s)).toBeGreaterThanOrEqual(SPAWN_PAD);
    });

    test('a target in an aggressive mob\'s reach is unsafe ("stand"), and so is one reached past it ("path")', () => {
        expect(aggroReach(LUCRADAN)).toBe(500 + MOB_ROAM_REACH);
        // 849 from the lucradan: in its reach once either roams. 1414 beyond it: the walk passes it.
        const spawns = [...WOLVES, mob('wolf', 2200, 2200), LUCRADAN, mob('wolf', 2600, 2600)];
        const plan = planBaseFrom(spawns, CAMP, opts(WIDE))!;
        expect(plan.unsafe.find(s => s.x === 2200)?.why).toStartWith('stand: lucradan');
        expect(plan.unsafe.find(s => s.x === 1600)?.why).toBe('aggressive');
        expect(plan.unsafe.find(s => s.x === 2600)?.why).toStartWith('path: lucradan');
        expect(plan.targets.map(t => t.x).sort((a, b) => a - b)).toEqual([-400, 0, 300]);
        for (const sl of slots(plan)) expect(dist(sl, LUCRADAN)).toBeGreaterThanOrEqual(aggroReach(LUCRADAN) + PLAN_PADS.slot);
    });

    test('the formation is checked with the facing the plan returns (its safe targets only)', () => {
        // The nearest wolf east is reached past a lucradan: it must not turn the formation.
        const spawns = [...WOLVES, LUCRADAN, mob('wolf', 2700, 2600)];
        const plan = planBaseFrom(spawns, CAMP, opts(WIDE))!;
        expect(plan.unsafe.find(s => s.x === 2700)?.why).toStartWith('path: lucradan');
        const safe = plan.targets.slice(0, 6);
        expect(plan.facing).toEqual({ x: Math.round(safe.reduce((t, s) => t + s.x, 0) / safe.length), y: Math.round(safe.reduce((t, s) => t + s.y, 0) / safe.length) });
        for (const sl of slots(plan)) expect(dist(sl, LUCRADAN) - aggroReach(LUCRADAN)).toBeGreaterThanOrEqual(PLAN_PADS.slot);
        expect(Math.round(Math.min(...slots(plan).map(sl => dist(sl, LUCRADAN) - aggroReach(LUCRADAN))))).toBe(plan.margin);
    });

    test('grey aggressive mobs are no danger; pullAggressive makes them targets', () => {
        const spawns = [mob('wolf', 0, 0), mob('wolf', 500, 0), mob('wolf', 0, 500), mob('rat', 250, 250, { level: 2, aggroLevel: 51, aggroRange: 500 })];
        expect(planBaseFrom(spawns, CAMP, opts())!.unsafe).toEqual([]);   // L2 rat: grey to 12, ignored entirely
        const hot = [mob('wolf', 0, 0), aggro('lucradan', 3000, 0), aggro('lucradan', 3000, 600), aggro('lucradan', 3000, -600)];
        expect(planBaseFrom(hot, CAMP, opts({ minTargets: 1 }))!.targets.map(t => t.name)).toEqual(['wolf']);
        // pullAggressive with a yellow limit: the con-0 lucradans become targets, not obstacles.
        expect(planBaseFrom(hot, CAMP, opts({ minTargets: 1, pullAggressive: true, tolerateCon: 0 }))!.unsafe.some(s => s.why === 'aggressive')).toBe(false);
        expect(planBaseFrom(hot, CAMP, opts({ minTargets: 1, pullAggressive: true, tolerateCon: -1 }))!.unsafe.filter(s => s.why === 'aggressive').length).toBe(3);
    });

    test('targets surrounded by aggressive reach give no plan; an avoided spot is never the base', () => {
        const spawns = [mob('wolf', 0, 0), mob('wolf', 200, 0), mob('wolf', 0, 200),
            ...Array.from({ length: 8 }, (_, i) => aggro('lucradan', Math.round(Math.cos(i * Math.PI / 4) * 900), Math.round(Math.sin(i * Math.PI / 4) * 900)))];
        expect(planBaseFrom(spawns, CAMP, opts())).toBeNull();
        const first = planBaseFrom(WOLVES, CAMP, opts())!;
        const next = planBaseFrom(WOLVES, CAMP, opts({ avoid: [first.base] }));
        expect(next === null || dist(next.base, first.base) >= 2500).toBe(true);
    });

    test('planRejects: a live mob near an unsafe spawn is rejected; near a safe or unknown one it is not', () => {
        const plan = planBaseFrom([...WOLVES, mob('wolf', 2200, 2200), LUCRADAN], CAMP, opts(WIDE))!;
        expect(planRejects(plan, { name: 'wolf', x: 2300, y: 2150 })).toStartWith('unsafe spawn (stand: lucradan');
        expect(planRejects(plan, { name: 'wolf', x: 50, y: 20 })).toBeNull();
        expect(planRejects(plan, { name: 'wolf', x: 2200 + MOB_ROAM_REACH + 200, y: 2200 })).toBeNull();
        expect(planRejects(plan, { name: 'beetle', x: 2200, y: 2200 })).toBeNull();
    });

    test('segDist and formationOffset', () => {
        expect(segDist({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
        expect(segDist({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
        const r = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
        expect(r(formationOffset(PVE_SETTINGS.formation, 'tank', 0, 0))).toEqual({ x: 0, y: 0 });
        expect(r(formationOffset(PVE_SETTINGS.formation, 'healer', 0, 0))).toEqual({ x: 495, y: 239 });
        expect(r(formationOffset(PVE_SETTINGS.formation, 'nuker', 1, 0))).toEqual({ x: 860, y: -266 });
    });
});

describe('planBase (static data, Lough Derg)', () => {
    test('the red wolfhound camp has no safe base: wild lucradans and badgers roam over every spot', () => {
        // Session 2: from the clearance base the Hero walked 1,300-3,000 per pull; the first planner
        // (roam 250) put the base among the wolves and lucradans walked in anyway.
        expect(planBase(200, { x: 348620, y: 520607, z: 5672 }, opts({ level: 13 }))).toBeNull();
    });

    test('the fishing bear camp gets a base among its bears, every slot clear of the cubs\' reach', () => {
        const camp = { x: 367367, y: 499922, z: 5400 };
        const plan = planBase(200, camp, opts({ level: 13 }))!;
        expect(plan.targets.length).toBeGreaterThanOrEqual(6);
        expect(plan.targets.every(t => t.name === 'fishing bear forager')).toBe(true);
        const mean = (b: { x: number; y: number }) => plan.targets.slice(0, 6).reduce((t, s) => t + dist(b, s), 0) / 6;
        expect(mean(plan.base)).toBeLessThan(1000);
        expect(mean(chooseBase(200, 13, camp, { x: 348900, y: 519900 }, 1300))).toBeGreaterThan(2 * mean(plan.base));
        const near = findNpcSpawns({ regionId: 200, realm: 0, near: camp, radius: 9000, limit: 5000 }).filter(s => !(s.flags & 0x10));
        for (const sl of slots(plan)) {
            for (const a of near.filter(s => isAggressiveTo(s, 13))) expect(dist(sl, a)).toBeGreaterThanOrEqual(aggroReach(a) + PLAN_PADS.slot);
            for (const s of near) expect(dist(sl, s)).toBeGreaterThanOrEqual(SPAWN_PAD);
        }
        expect(planBase(200, camp, opts({ level: 13 }))).toEqual(plan);
    });
});
