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
