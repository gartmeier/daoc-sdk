import { afterEach, describe, expect, test } from 'bun:test';
import { NavmeshStore } from '../navmesh';
import { getOccluderStore } from '../occluders';
import { lineOfSight } from '../vision';
import { clearOwnDoors, ownDoors } from '../doors';
import {
    defenceJobs, defenceOrders, defencePlan, defenceRouteFrom, defenceSeats, FASTE, inDefenceReach, openOwnDoors, ROOF_THREAT,
    type Defender, type DefenceSpell } from './siege';
import type { Point3 } from './types';

const plan = defencePlan('midgard')!;
const stand = (l: string) => plan.stands.find(s => s.label === l)!;

// Spells as the DB has them (SpellPick's fields).
const BOMB: DefenceSpell = { type: 'DirectDamage', target: 'Enemy', range: 0, radius: 300, damage: 133 };
const NUKE: DefenceSpell = { type: 'DirectDamage', target: 'Enemy', range: 1500, radius: 0, damage: 120 };
const BOLT: DefenceSpell = { type: 'Bolt', target: 'Enemy', range: 1875, radius: 0, damage: 150 };
const TURRET: DefenceSpell = { type: 'SummonAnimistPet', target: 'Self', range: 1000, radius: 0, damage: 0 };
const HEAL: DefenceSpell = { type: 'Heal', target: 'Realm', range: 2000, radius: 0, damage: 0 };
const SHORT_BOMB: DefenceSpell = { ...BOMB, damage: 52 };

describe('defenceJobs: by spells and role, never by name', () => {
    test('a bomb first, then the wall with a nuke', () => expect(defenceJobs({ role: 'nuker', spells: [BOMB, NUKE] })).toEqual(['bomb', 'wall', 'yard']));
    test('turrets', () => expect(defenceJobs({ role: 'support', spells: [TURRET, BOLT] })).toEqual(['turret', 'wall', 'yard']));
    test('a healer by its role', () => expect(defenceJobs({ role: 'healer', spells: [HEAL] })).toEqual(['heal', 'yard']));
    test('a weak bomb is no bomb', () => expect(defenceJobs({ role: 'nuker', spells: [SHORT_BOMB, NUKE] })).toEqual(['wall', 'yard']));
    test('an archer goes on the wall', () => expect(defenceJobs({ role: 'melee', spells: [], archer: true })).toEqual(['wall', 'yard']));
    test('a tank with a nuke stays in the courtyard', () => expect(defenceJobs({ role: 'tank', spells: [NUKE] })).toEqual(['yard']));
});

const d = (id: number, jobs: Defender['jobs'], at: Point3 = { x: 36300, y: 38300, z: 3349 }, alive = true): Defender => ({ id, ...at, alive, jobs });

describe('defenceSeats', () => {
    test('each job to its stands; a full job hands over to the next', () => {
        const bombers = [1, 2, 3, 4, 5].map(i => d(i, ['bomb', 'wall', 'yard']));
        const seats = defenceSeats(plan, bombers);
        expect([...seats.values()].filter(s => s.job === 'bomb')).toHaveLength(4);
        expect(seats.get(5)!.job).toBe('wall');
    });

    test('the gate\'s bomb seats fill first for one coming from outside', () => {
        const seats = defenceSeats(plan, [d(1, ['bomb', 'yard'])]);
        expect(seats.get(1)!.label).toMatch(/^bomb-gate/);
    });

    test("the dead take no seat; last tick's seat is kept while its job still fills it", () => {
        const prev = new Map([[2, 'wall-e'], [3, 'wall-se']]);
        const seats = defenceSeats(plan, [d(1, ['wall', 'yard'], undefined, false), d(2, ['wall', 'yard']), d(3, ['wall', 'yard']), d(4, ['wall', 'yard'])], prev);
        expect(seats.has(1)).toBe(false);
        expect(seats.get(2)!.label).toBe('wall-e');
        // One wall member alone fills only the first wall stand: an old seat farther down the list is given up.
        expect(defenceSeats(plan, [d(5, ['wall', 'yard'])], new Map([[5, 'wall-sw']])).get(5)!.label).toBe('wall-se');
    });

    test('a lone bomber on the roof still takes the gate: stands fill in order of need', () => {
        const seats = defenceSeats(plan, [d(1, ['bomb', 'yard'], stand('bomb-roof').at)], new Map([[1, 'bomb-roof']]));
        expect(seats.get(1)!.label).toMatch(/^bomb-gate/);
    });

    test('everyone gets a seat for a full group of eight', () => {
        const eight: Defender[] = [
            d(1, ['bomb', 'wall', 'yard']), d(2, ['turret', 'wall', 'yard']), d(3, ['heal', 'yard']), d(4, ['heal', 'yard']),
            d(5, ['wall', 'yard']), d(6, ['yard']), d(7, ['yard']), d(8, ['wall', 'yard']),
        ];
        const seats = defenceSeats(plan, eight);
        expect(seats.size).toBe(8);
        expect(seats.get(3)!.job).toBe('heal');
        expect(seats.get(6)!.job).toBe('yard');
    });
});

describe('defenceOrders', () => {
    const owner = 'midgard';
    test('lost once the keep is another realm\'s', () => {
        const o = defenceOrders(plan, { defenders: [d(1, ['yard'])], foes: [], owner: 'hibernia' });
        expect(o.phase).toBe('lost');
        expect(o.seats.size).toBe(0);
    });

    test('going until most stand on their stands, then holding', () => {
        const far = defenceOrders(plan, { defenders: [d(1, ['yard']), d(2, ['heal', 'yard'])], foes: [], owner });
        expect(far.phase).toBe('going');
        const there = defenceOrders(plan, { defenders: [d(1, ['yard'], stand('yard-gate').at), d(2, ['heal', 'yard'], stand('heal-stair').at)], foes: [], owner });
        expect(there.phase).toBe('holding');
    });

    test('foes by the lord send the courtyard and the healers to the roof; the wall stays', () => {
        const o = defenceOrders(plan, {
            defenders: [d(1, ['yard']), d(2, ['heal', 'yard']), d(3, ['wall', 'yard'])],
            foes: [{ x: plan.lord.x + 100, y: plan.lord.y, z: plan.lord.z }, { x: 35000, y: 38275, z: 3700 }], owner,
        });
        expect(o.phase).toBe('roof');
        expect(o.seats.get(1)!.at).toEqual(plan.roof);
        expect(o.seats.get(2)!.at).toEqual(plan.roof);
        expect(o.seats.get(3)!.job).toBe('wall');
        expect(o.threat).toEqual({ outside: 1, inside: 0, roof: 1 });
        expect(ROOF_THREAT).toBeGreaterThan(400);
    });
});

describe('inDefenceReach', () => {
    test('the gate-breakers outside the gate and the courtyard, not the stage', () => {
        expect(inDefenceReach(plan, { x: 34435, y: 38275 })).toBe(true);
        expect(inDefenceReach(plan, { x: 33100, y: 38250 })).toBe(true);
        expect(inDefenceReach(plan, FASTE.stage)).toBe(false);
    });
});

describe('defenceRouteFrom', () => {
    test('from the realm\'s bank over its bridge, ending outside the gate', () => {
        const r = defenceRouteFrom(plan, { ...plan.rally });
        expect(r.at(-1)).toEqual(plan.entry);
        expect(r[0]).toEqual(FASTE.approach.midgard.route[0]);
    });
    test('nothing left inside the walls or at the entry', () => {
        expect(defenceRouteFrom(plan, { x: 33100, y: 38250, z: 3722 })).toEqual([]);
        expect(defenceRouteFrom(plan, { ...plan.entry })).toEqual([]);
    });
});

describe('openOwnDoors', () => {
    afterEach(() => clearOwnDoors());
    test('registers the keep\'s unbroken doors as ours to use', () => {
        openOwnDoors(plan, [252000301], new NavmeshStore({ dir: 'C:/nonexistent-navmesh-dir' }));
        const ids = ownDoors(252).map(x => x.doorId);
        expect(ids).not.toContain(252000301);
        expect(ids).toContain(252000302);
    });
});

const navStore = new NavmeshStore();
const meshReady = navStore.available() && navStore.at(252, 33089, 38271) !== null;

describe.skipIf(!meshReady || getOccluderStore().forZone(252) === null)('the defence stands on the Faste\'s navmesh and walls', () => {
    const mesh = navStore.at(252, 33089, 38271)!;
    const foot = mesh.closestPoint({ x: 33500, y: 38950, z: 3722 })!;
    const outside = mesh.closestPoint(plan.entry)!;

    test('every stand stands on the mesh, and a route reaches it from outside the gate with every door open', () => {
        for (const s of plan.stands) {
            const c = mesh.closestPoint(s.at, { x: 32, y: 32, z: 64 });
            expect([s.label, !!c && Math.abs(c.z - s.at.z) <= 40]).toEqual([s.label, true]);
            expect([s.label, mesh.findPath(outside, c!).status]).toEqual([s.label, 'found']);
        }
    });

    test('each wall stand sees the courtyard and the gate\'s inside, and nothing outside the gate sees it', () => {
        const yard = [{ x: 33100, y: 38250, z: 3722 }, { x: 33700, y: 38250, z: 3720 }, { x: 33900, y: 38275, z: 3720 }];
        const out = [{ x: 34650, y: 38250, z: 3722 }, { x: 34420, y: 38275, z: 3720 }, { x: 35000, y: 38275, z: 3700 }];
        for (const s of plan.stands.filter(x => x.job === 'wall')) {
            expect([s.label, yard.filter(p => lineOfSight(252, s.at, p)).length]).toEqual([s.label, yard.length]);
            expect([s.label, out.filter(p => lineOfSight(252, p, s.at)).length]).toEqual([s.label, 0]);
        }
        expect(mesh.findPath(foot, stand('wall-se').at).status).toBe('found');
    });

    test('the gate\'s bombers reach the gate\'s outside stand with a radius-300 bomb, less the margin', () => {
        for (const s of plan.stands.filter(x => x.label.startsWith('bomb-gate'))) expect(Math.hypot(s.at.x - 34420, s.at.y - 38275, s.at.z - 3720)).toBeLessThanOrEqual(240);
    });
});

describe('raidOrders: a broken door is the raid past the ranks before it', () => {
    test('outer fighters back at their posts after the gate broke send no raid back to rank 1', async () => {
        const { raidOrders, raidPlan } = await import('./siege');
        const raid = raidPlan('hibernia')!;
        const guard = (label: string, id: number) => {
            const t = FASTE.targets.find(x => x.label === label)!;
            return { id, name: 'Huscarl', realm: 'midgard', kind: 'npc' as const, ...t.at };
        };
        const gate = { id: 900, name: 'Keep Door', realm: 'midgard', kind: 'object' as const, x: 34333, y: 38275, z: 3720, doorId: 252000301 };
        // Rank 1's five back at their posts, the yard pair at theirs; the raid at the gate's stand.
        const seen = [guard('outer-armswoman', 1), guard('outer-se', 2), guard('outer-ne', 3), guard('outer-n', 4), guard('outer-s', 5), guard('yard-1', 6), guard('yard-2', 7), gate];
        const members = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, x: 34600, y: 38250 + i * 10, z: 3722, alive: true }));
        const before = raidOrders(raid, { members, seen, owner: 'midgard', staged: true });
        expect(before.ranged.step?.rank).toBe(1);
        const after = raidOrders(raid, { members, seen, owner: 'midgard', staged: true, broken: [252000301] });
        expect(after.phase).toBe('assault');
        expect(after.ranged.step?.rank).toBe(3);
    });
});

describe('raidOrders: no guard seen at all, once staged', () => {
    test('rank 1 with its fighters dead and nothing else in view: on to the gate, not resting at rank 1', async () => {
        const { raidOrders, raidPlan } = await import('./siege');
        const raid = raidPlan('hibernia')!;
        const gate = { id: 900, name: 'Keep Door', realm: 'midgard', kind: 'object' as const, x: 34333, y: 38275, z: 3720, doorId: 252000301 };
        const members = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, x: 34650, y: 38200 + i * 20, z: 3722, alive: true }));
        expect(raidOrders(raid, { members, seen: [gate], owner: 'midgard', staged: true }).melee.step?.label).toBe('gate');
        // Not staged yet (a picture with no guards on the approach): still rank 1, as before.
        expect(raidOrders(raid, { members, seen: [gate], owner: 'midgard', staged: false }).ranged.step?.rank ?? 1).toBe(1);
    });
});

describe.skipIf(!meshReady || getOccluderStore().forZone(252) === null)('wallSight', () => {
    test('where Amergin died the north-east wall caster sees; the gate\'s stand and the stage are clear; our own keep never', async () => {
        const { wallSight } = await import('./siege');
        expect(wallSight(252, { x: 35170, y: 36949, z: 3606 })).toContain('wall-e-n');
        expect(wallSight(252, { x: 34650, y: 38250, z: 3720 })).toEqual([]);
        expect(wallSight(252, { x: 36300, y: 38300, z: 3353 })).toEqual([]);
        expect(wallSight(252, { x: 35170, y: 36949, z: 3606 }, true)).toEqual([]);
    });
});

describe('raidOrders: the ranged half waits out of the walls\' sight while the melee climb', () => {
    test('rank 3, the gate broken, a wall caster up: ranged hold out of sight with no focus, melee on the caster', async () => {
        const { raidOrders, raidPlan } = await import('./siege');
        const raid = raidPlan('hibernia')!;
        const t = FASTE.targets.find(x => x.label === 'wall-se')!;
        const caster = { id: 7, name: 'Runemaster', realm: 'midgard', kind: 'npc' as const, ...t.at };
        const members = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, x: 34000, y: 38200 + i * 20, z: 3720, alive: true }));
        const o = raidOrders(raid, { members, seen: [caster], owner: 'midgard', staged: true, broken: [252000301], reach: () => true });
        expect(o.melee.focus?.id).toBe(7);
        expect(o.ranged.focus).toBeNull();
        expect(o.ranged.hold).toContain('wall-se');
        expect(o.ranged.stand).toEqual(raid.outOfSight!);
        expect(o.stand).toEqual(raid.outOfSight!);
        // The caster on one of us: the same, the melee's.
        const on = raidOrders(raid, { members, seen: [{ ...caster, targetObjectId: 101 }], owner: 'midgard', staged: true, broken: [252000301], reach: () => true });
        expect(on.ranged.hold).toBeDefined();
        expect(on.melee.focus?.id).toBe(7);
        // No route for the melee (the gate shut): no hold, the ranged keep it as before.
        const shut = raidOrders(raid, { members, seen: [caster], owner: 'midgard', staged: true, broken: [252000301], reach: () => false });
        expect(shut.ranged.hold).toBeUndefined();
        expect(shut.ranged.focus?.id).toBe(7);
    });
});

describe('raidOrders: the hold only once the gate is broken, and one wall caster each', () => {
    const raid = () => raidPlanOf();
    const at = (label: string) => FASTE.targets.find(x => x.label === label)!.at;
    const rune = (id: number, label: string, extra: object = {}) => ({ id, name: 'Runemaster', realm: 'midgard', kind: 'npc' as const, ...at(label), ...extra });
    const members = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, x: 34600, y: 38200 + i * 20, z: 3722, alive: true }));

    test('a wall caster on us with the gate still shut: the ranged fight it, no hold (live 18:03, "nobody fought back")', async () => {
        const { raidOrders } = await import('./siege');
        const gate = { id: 900, name: 'Keep Door', realm: 'midgard', kind: 'object' as const, x: 34333, y: 38275, z: 3720, doorId: 252000301 };
        const o = raidOrders(raid(), { members, seen: [gate, rune(7, 'wall-e-s', { targetObjectId: 101 })], owner: 'midgard', staged: true, broken: [], reach: () => true });
        expect(o.ranged.hold).toBeUndefined();
        expect(o.ranged.focus?.id).toBe(7);
    });

    test('the gate broken and three wall casters up: the melee get all three to spread over', async () => {
        const { raidOrders } = await import('./siege');
        const o = raidOrders(raid(), { members, seen: [rune(7, 'wall-se'), rune(8, 'wall-e-s'), rune(9, 'wall-e-n')], owner: 'midgard', staged: true, broken: [252000301], reach: () => true });
        // The ranged work one with an outside spot from there (no hold while one is up), the melee spread over all three.
        expect(o.ranged.hold).toBeUndefined();
        expect([8, 9]).toContain(o.ranged.focus?.id ?? 0);
        expect(o.ranged.stand).toEqual(FASTE.targets.find(t => t.label === (o.ranged.focus?.id === 8 ? 'wall-e-s' : 'wall-e-n'))!.outside!);
        expect(o.melee.focus?.id).toBe(7);
        expect(o.melee.split?.map(s => s.id)).toEqual([7, 8, 9]);
    });
});

function raidPlanOf() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./siege').raidPlan('hibernia');
}

describe('raidOrders: a roof archer on us keeps the hold for the walls', () => {
    test('the ranged stay out of sight and the melee stay on the wall caster', async () => {
        const { raidOrders, raidPlan } = await import('./siege');
        const raid = raidPlan('hibernia')!;
        const at = (label: string) => FASTE.targets.find(x => x.label === label)!.at;
        const members = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, x: 33700, y: 38800 + i * 10, z: 3722, alive: true }));
        const seen = [
            { id: 7, name: 'Runemaster', realm: 'midgard', kind: 'npc' as const, ...at('wall-se') },
            { id: 9, name: 'Hunter', realm: 'midgard', kind: 'npc' as const, ...at('roof-e'), targetObjectId: 101 },
        ];
        // The roof is no route for the melee: reach says no there, yes on the wall.
        const reach = (to: { z: number }) => to.z < 4200;
        const o = raidOrders(raid, { members, seen, owner: 'midgard', staged: true, broken: [252000301], reach });
        expect(o.ranged.hold).toBeDefined();
        expect(o.ranged.focus).toBeNull();
        expect(o.melee.focus?.id).toBe(7);
    });
});

describe('raidOrders: a fighter behind a door shut to us is no focus', () => {
    test('the building\'s Huscarl on us, on the next floor with no route: not the focus; with a route: the focus', async () => {
        const { raidOrders, raidPlan } = await import('./siege');
        const raid = raidPlan('hibernia')!;
        const members = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, x: 33200, y: 38700 + i * 10, z: 3722, alive: true }));
        const hus = { id: 5, name: 'Huscarl', realm: 'midgard', kind: 'npc' as const, x: 32300, y: 38600, z: 3944, targetObjectId: 101 };
        const yard = { id: 6, name: 'Huscarl', realm: 'midgard', kind: 'npc' as const, x: 33353, y: 38186, z: 3720 };
        const base = { members, owner: 'midgard' as const, staged: true, broken: [252000301] };
        expect(raidOrders(raid, { ...base, seen: [hus, yard], reach: () => false }).ranged.focus?.id).not.toBe(5);
        expect(raidOrders(raid, { ...base, seen: [hus, yard], reach: () => true }).ranged.focus?.id).toBe(5);
    });
});

describe.skipIf(!meshReady || getOccluderStore().forZone(252) === null)('the wall casters\' outside spots', () => {
    test('each sees its caster within a nuke\'s reach, is seen by no other wall caster or roof archer, and is reachable from the stage with the gate shut', async () => {
        const { applyDoors } = await import('./siege');
        const mesh = navStore.at(252, 33089, 38271)!;
        applyDoors(FASTE, { ours: false, broken: [] }, mesh);
        const stage = mesh.closestPoint(FASTE.stage, { x: 64, y: 64, z: 256 })!;
        const statics = FASTE.targets.filter(t => t.kind === 'caster' || t.kind === 'archer');
        for (const t of FASTE.targets.filter(x => x.outside)) {
            const o = t.outside!;
            expect([t.label, lineOfSight(252, o, t.at), Math.hypot(o.x - t.at.x, o.y - t.at.y, o.z - t.at.z) <= 1450]).toEqual([t.label, true, true]);
            expect([t.label, statics.filter(s => s !== t && Math.hypot(s.at.x - o.x, s.at.y - o.y, s.at.z - o.z) <= s.aggro && lineOfSight(252, s.at, o)).map(s => s.label)]).toEqual([t.label, []]);
            expect([t.label, mesh.findPath(stage, mesh.closestPoint(o, { x: 32, y: 32, z: 64 })!).status]).toEqual([t.label, 'found']);
        }
    });
});

describe('passedDoors: a member behind a door proves it passed', () => {
    test('one of us in the courtyard: the gate; in the building: its door too; outside: none', async () => {
        const { passedDoors, raidOrders, raidPlan } = await import('./siege');
        const raid = raidPlan('hibernia')!;
        const m = (x: number, y: number, alive = true) => ({ id: 1, x, y, z: 3720, alive });
        expect(passedDoors(raid, [m(34650, 38250)])).toEqual([]);
        expect(passedDoors(raid, [m(33777, 37900)])).toEqual([252000301]);
        expect(passedDoors(raid, [m(32300, 38300)])).toEqual([252000301, 252000302]);
        expect(passedDoors(raid, [m(33500, 38300, false)])).toEqual([]);
        // The unit at rank 2 with no chat of the gate breaking, one of us inside: on to the courtyard (rank 3).
        const members = [...Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, x: 34600, y: 38200 + i * 20, z: 3722, alive: true })), { id: 106, x: 33777, y: 37900, z: 3720, alive: true }];
        const o = raidOrders(raid, { members, seen: [], owner: 'midgard', staged: true, broken: [] });
        expect(o.melee.step?.label).not.toBe('gate');
    });
});

describe('raidOrders: the bolt on the east roof archer from above the gate', () => {
    test('after the wall casters, before the lord: a bolt task at its spot; not while a wall caster stands', async () => {
        const { raidOrders, raidPlan } = await import('./siege');
        const raid = raidPlan('hibernia')!;
        const t = FASTE.targets.find(x => x.label === 'roof-e')!;
        const hunter = { id: 9, name: 'Hunter', realm: 'midgard', kind: 'npc' as const, ...t.at };
        const door = { id: 901, name: 'Keep Door', realm: 'midgard', kind: 'object' as const, x: 32654, y: 38180, z: 3720, doorId: 252000302 };
        const members = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, x: 33100, y: 38250 + i * 10, z: 3722, alive: true }));
        const o = raidOrders(raid, { members, seen: [hunter, door], owner: 'midgard', staged: true, broken: [252000301] });
        expect(o.bolt?.focus?.id).toBe(9);
        expect(o.bolt?.stand).toEqual(t.bolt!);
        const wall = FASTE.targets.find(x => x.label === 'wall-e-n')!;
        const with_ = raidOrders(raid, { members, seen: [hunter, door, { id: 7, name: 'Runemaster', realm: 'midgard', kind: 'npc' as const, ...wall.at }], owner: 'midgard', staged: true, broken: [252000301] });
        expect(with_.bolt).toBeUndefined();
    });
});

describe.skipIf(!meshReady || getOccluderStore().forZone(252) === null)('the bolt spot', () => {
    test('sees roof-e both ways at 1650-1875 and is reached by the stair from the courtyard once the gate is broken', async () => {
        const { applyDoors } = await import('./siege');
        const mesh = navStore.at(252, 33089, 38271)!;
        applyDoors(FASTE, { ours: false, broken: [252000301] }, mesh);
        const t = FASTE.targets.find(x => x.label === 'roof-e')!;
        const b = t.bolt!;
        const d = Math.hypot(b.x - t.at.x, b.y - t.at.y, b.z - t.at.z);
        expect(d).toBeGreaterThan(1500);
        expect(d).toBeLessThanOrEqual(1875);
        expect(lineOfSight(252, b, t.at)).toBe(true);
        expect(lineOfSight(252, t.at, b)).toBe(true);
        expect(mesh.findPath(mesh.closestPoint({ x: 33100, y: 38250, z: 3722 })!, mesh.closestPoint(b, { x: 32, y: 32, z: 64 })!).status).toBe('found');
    });
});

describe('raidStep end to end: the long-reach members go up for the roof archer', () => {
    test('walls done, the gate broken, the inner tower\'s Hunter in view: a nuker of reach 1875 gets it and the bolt spot as its own', async () => {
        const { raidStep } = await import('./tactics/raid');
        const { report, contact } = await import('./fixtures');
        const raid = defencePlanOf();
        const roofE = FASTE.targets.find(x => x.label === 'roof-e')!;
        const caps = (reach: number) => ({ heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], reach });
        const roles = ['tank', 'melee', 'healer', 'nuker', 'nuker'] as const;
        const members = roles.map((role, i) => report(`M${i}`, { role, className: 'Warrior', objectId: 10 + i, regionId: 252, x: 33100 + i * 40, y: 38250, z: 3722, level: 24, capabilities: caps(i === 3 ? 1875 : 1500) as any, doorsBroken: [252000301] }));
        const hunter = contact(55, { kind: 'npc', name: 'Hunter', realm: 'albion', level: 28, regionId: 252, ...roofE.at, keepGuard: true });
        const mem: Record<string, any> = { raid: { callId: 'x', staged: true, broken: [] as number[] } };
        const { update, orders } = raidStep({ plan: raid, mem, members, guards: [hunter] });
        expect(orders.bolt?.focus?.id).toBe(55);
        const own = (update as any).memberOwn as Record<string, { focus: number; anchor: Point3 }>;
        expect(Object.keys(own)).toEqual(['M3']);
        expect(own.M3).toEqual({ focus: 55, anchor: roofE.bolt! });
    });
});

function defencePlanOf() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./siege').raidPlan('midgard');
}
