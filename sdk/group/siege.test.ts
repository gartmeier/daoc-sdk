import { describe, expect, test } from 'bun:test';
import { NavmeshStore } from '../navmesh';
import type { Point3 } from './types';
import { getOccluderStore } from '../occluders';
import { lineOfSight } from '../vision';
import { getTerrainStore } from '../terrain';
import { BATTLEGROUND_LAYOUTS, keepDangers, THIDRANKI, type PlayerRealm } from './keeps';
import {
    brokenDoors, doorDamage, doorHealth, FASTE, inLordReach, raidCentre, raidOrders, raidPlan, routeFrom, STAGE_SHARE,
    type RaidMember, type RaidView, type SiegeSeen, pastStage, DOOR_BROKEN_RE, meleeReach, shutDoors } from './siege';
import { isWet } from './water';

const REALMS: PlayerRealm[] = ['albion', 'midgard', 'hibernia'];
const terrain = getTerrainStore().available();
const faste = BATTLEGROUND_LAYOUTS[THIDRANKI]!.keeps.find(k => k.name === 'Thidranki Faste')!;
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const d3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('the Faste layout', () => {
    test('17 guards, the lord and two doors', () => {
        const kinds = FASTE.targets.map(t => t.kind);
        expect(kinds.filter(k => k === 'fighter').length).toBe(8);
        expect(kinds.filter(k => k === 'caster').length).toBe(6);
        expect(kinds.filter(k => k === 'archer').length).toBe(3);
        expect(kinds.filter(k => k === 'lord').length).toBe(1);
        expect(FASTE.targets.filter(t => t.kind === 'door').map(t => t.doorId)).toEqual([252000301, 252000302]);
        expect(new Set(FASTE.targets.map(t => t.label)).size).toBe(FASTE.targets.length);
    });

    test('ranged stands reach their targets with a 1500 nuke, in 3D', () => {
        for (const t of FASTE.targets.filter(x => x.who === 'ranged')) expect(d3(t.stand, t.at)).toBeLessThanOrEqual(1500);
    });

    test('door stands are beside their doors, and the lord is last', () => {
        for (const t of FASTE.targets.filter(x => x.kind === 'door')) expect(d3(t.stand, t.at)).toBeLessThanOrEqual(150);
        const lord = FASTE.targets.find(t => t.kind === 'lord')!;
        expect(Math.max(...FASTE.targets.map(t => t.rank))).toBe(lord.rank);
        expect(FASTE.targets.filter(t => t.rank === lord.rank)).toHaveLength(1);
    });

    test('the roof is within the lord\'s reach, and the inside walk ends there', () => {
        const lord = FASTE.targets.find(t => t.kind === 'lord')!;
        expect(d3(FASTE.roof, lord.at)).toBeLessThanOrEqual(FASTE.lordReach);
        expect(FASTE.inside.at(-1)).toEqual(FASTE.roof);
    });

    test('the stage is outside every guard\'s aggro by 500, and inside the default keep circle (a raid lifts it)', () => {
        for (const t of FASTE.targets.filter(x => x.aggro > 0)) expect(d2(FASTE.stage, t.at)).toBeGreaterThanOrEqual(t.aggro + 500);
        expect(d2(FASTE.stage, faste)).toBeLessThan(keepDangers(THIDRANKI, 'midgard').find(d => d.name === faste.name)!.r);
    });

    test('rallies stand outside the keep circle and every guard\'s aggro; routes end at the stage', () => {
        for (const realm of REALMS) {
            const a = FASTE.approach[realm];
            expect(d2(a.rally, faste)).toBeGreaterThan(4500);
            for (const t of FASTE.targets.filter(x => x.aggro > 0)) expect(d2(a.rally, t.at)).toBeGreaterThan(t.aggro + 2000);
            expect(a.route.at(-1)).toEqual(FASTE.stage);
        }
    });

    test('route waypoints keep out of every guard\'s aggro (100 clear) on the way to the stage', () => {
        for (const realm of REALMS) {
            for (const p of FASTE.approach[realm].route) {
                for (const t of FASTE.targets.filter(x => x.aggro > 0)) expect(d2(p, t.at)).toBeGreaterThan(t.aggro + 100);
            }
        }
    });

    test.skipIf(!terrain)('rallies, the stage and every route waypoint stand dry (bridges are the only wet legs)', () => {
        for (const realm of REALMS) {
            const a = FASTE.approach[realm];
            expect(isWet(THIDRANKI, a.rally)).toBe(false);
            for (const p of a.route) expect(isWet(THIDRANKI, p)).toBe(false);
        }
        expect(isWet(THIDRANKI, FASTE.stage)).toBe(false);
    });
});

describe('raidPlan', () => {
    test('each realm gets its own rally and route, the lord as target', () => {
        for (const realm of REALMS) {
            const p = raidPlan(realm)!;
            expect(p.rally).toEqual(FASTE.approach[realm].rally);
            expect(p.route).toEqual(FASTE.approach[realm].route);
            expect(p.target).toEqual({ x: 32296, y: 38267, z: 4592 });
            expect(p.breakDoors).toBe(true);
            expect(p.targets.map(t => t.rank)).toEqual(p.targets.map(t => t.rank).slice().sort((a, b) => a - b));
        }
    });

    test('breakDoors off drops the doors', () => {
        expect(raidPlan('midgard', undefined, { breakDoors: false })!.targets.some(t => t.kind === 'door')).toBe(false);
    });

    test('no plan for a portal keep or an unknown one', () => {
        expect(raidPlan('midgard', 'Albion Portal Keep')).toBeNull();
        expect(raidPlan('midgard', 'Caer Benowyc')).toBeNull();
    });
});

describe('routeFrom', () => {
    const plan = raidPlan('midgard')!;
    test('from the rally: the whole route', () => {
        expect(routeFrom(plan, plan.rally)).toEqual(plan.route);
    });
    test('on the bridge: from its far end on', () => {
        const mid = { x: (plan.route[0]!.x + plan.route[1]!.x) / 2, y: (plan.route[0]!.y + plan.route[1]!.y) / 2 };
        expect(routeFrom(plan, mid)).toEqual(plan.route.slice(1));
    });
    test('at the stage: nothing left', () => {
        expect(routeFrom(plan, plan.stage)).toEqual([]);
    });
});

// ── raidOrders ───────────────────────────────────────────────────────────────

const at = (p: { x: number; y: number; z: number }, n: number, spread = 100): RaidMember[] =>
    Array.from({ length: n }, (_, i) => ({ id: 1000 + i, alive: true, x: p.x + (i % 5) * spread / 5, y: p.y + Math.floor(i / 5) * spread / 5, z: p.z }));

/** Every guard of the Faste at its post, of `realm`, ids from 1. */
const garrison = (realm = 'albion', skip: string[] = []): SiegeSeen[] => FASTE.targets
    .filter(t => t.kind !== 'door' && !skip.includes(t.label))
    .map((t, i) => ({ id: i + 1, name: t.kind === 'lord' ? 'Lady Thidranki' : t.label, realm, kind: 'npc', level: 28, x: t.at.x, y: t.at.y, z: t.at.z }));
const doors: SiegeSeen[] = [
    { id: 503, name: 'Keep Door', realm: 'albion', kind: 'object', doorId: 252000301, x: 34333, y: 38275, z: 3720 },
    { id: 508, name: 'Keep Door', realm: 'albion', kind: 'object', doorId: 252000302, x: 32654, y: 38180, z: 3720 },
];
const labelsUpTo = (rank: number) => FASTE.targets.filter(t => t.rank <= rank && t.kind !== 'door').map(t => t.label);

describe('DOOR_BROKEN_RE', () => {
    test('the break and a swing at a broken door, as seen live', () => {
        expect(DOOR_BROKEN_RE.test('The Keep Door is broken!')).toBe(true);
        expect(DOOR_BROKEN_RE.test('the Keep Door is already dead!')).toBe(true);
        expect(DOOR_BROKEN_RE.test('Conall attacks the Keep Door with his blade!')).toBe(false);
        expect(DOOR_BROKEN_RE.test('the Keep Door is too far away to attack!')).toBe(false);
    });
});

describe('raidOrders', () => {
    const plan = raidPlan('midgard')!;
    const view = (v: Partial<RaidView>): RaidView => ({ members: [], seen: [...garrison(), ...doors], owner: 'albion', ...v });

    test('taken when the keep is ours', () => {
        expect(raidOrders(plan, view({ owner: 'midgard', members: at(plan.rally, 5) })).phase).toBe('taken');
    });

    test('from the rally it walks the route, waypoint by waypoint', () => {
        const o = raidOrders(plan, view({ members: at(plan.rally, 10) }));
        expect(o.phase).toBe('approach');
        expect(o.stand).toEqual(plan.route[0]!);
        expect(o.ranged.focus).toBeNull();
        expect(raidOrders(plan, view({ members: at(plan.route[1]!, 10) })).stand).toEqual(plan.route[2]!);
    });

    test('a body near the keep on another side is not past the stage: it walks the route (live 2026-11-13 01:58)', () => {
        const hib = raidPlan('hibernia')!;
        // Hibernia's body came in from the south-west, 2600 from the keep and 5300 from the stage.
        const o = raidOrders(hib, view({ members: at({ x: 31101, y: 39959, z: 3200 }, 10) }));
        expect(o.phase).toBe('approach');
        expect(o.ranged.step).toBeNull();
        // On the stage→keep corridor, or inside the walls, it is past the stage.
        expect(raidOrders(hib, view({ members: at({ x: 34650, y: 38250, z: 3722 }, 10) })).phase).toBe('assault');
        expect(raidOrders(hib, view({ members: at({ x: 32238, y: 38298, z: 4592 }, 10), seen: [...garrison('albion', labelsUpTo(6)), ...doors], broken: [252000301, 252000302] })).phase).toBe('lord');
    });

    test('pastStage: the corridor between stage and keep, the keep itself, nothing beyond the stage', () => {
        const keep = { x: 33089, y: 38271 };
        expect(pastStage(plan, keep, { x: 34650, y: 38250 })).toBe(true);
        expect(pastStage(plan, keep, { x: 32300, y: 38300 })).toBe(true);
        expect(pastStage(plan, keep, { x: 31101, y: 39959 })).toBe(false);
        for (const r of ['albion', 'midgard', 'hibernia'] as const)
            for (const p of FASTE.approach[r].route.slice(0, -1)) expect(pastStage(plan, keep, p)).toBe(false);
    });

    test("no point on any route leg into the stage is past it (live 02:39: Hibernia's last leg was)", () => {
        const keep = { x: 33089, y: 38271 };
        for (const r of ['albion', 'midgard', 'hibernia'] as const) {
            const way = [FASTE.approach[r].rally, ...FASTE.approach[r].route];
            for (let i = 1; i < way.length; i++)
                for (let k = 0; k <= 20; k++) {
                    const p = { x: way[i - 1]!.x + (way[i]!.x - way[i - 1]!.x) * k / 20, y: way[i - 1]!.y + (way[i]!.y - way[i - 1]!.y) * k / 20 };
                    expect(pastStage(plan, keep, p)).toBe(false);
                }
        }
        // The rank-1 and gate stands are past it.
        for (const label of ['outer-armswoman', 'gate', 'wall-e-n']) expect(pastStage(plan, keep, FASTE.targets.find(x => x.label === label)!.stand)).toBe(true);
    });

    test('staged holds about the keep only: a body back at the rally walks the route again (live 02:46)', () => {
        expect(raidOrders(plan, view({ members: at(plan.rally, 8), staged: true })).phase).toBe('approach');
        expect(raidOrders(plan, view({ members: at(plan.rally, 8), staged: true })).stand).toEqual(plan.route[0]!);
        // Fighting rank 1 at its stand, still staged.
        const r1 = FASTE.targets.find(x => x.label === 'outer-armswoman')!.stand;
        expect(raidOrders(plan, view({ members: at(r1, 8), staged: true })).phase).toBe('assault');
    });

    test('seeing no guard at all is no news: posts near us still stand (live 02:39)', () => {
        const members = at(plan.stage, 10);
        const o = raidOrders(plan, view({ members, seen: [], staged: true }));
        expect(o.phase).toBe('assault');
        expect(o.ranged.step!.rank).toBe(1);
        expect(o.ranged.focus).toBeNull();
    });

    test('a peaceful or untargetable NPC at a post (the Hastener at the gate) is no guard', () => {
        const members = at(plan.stage, 10);
        const t = FASTE.targets.find(x => x.label === 'outer-se')!;
        const seen = [...garrison('albion', labelsUpTo(1)), { id: 77, name: 'Hastener', realm: 'albion', kind: 'npc' as const, level: 50, isPeaceful: true, x: t.at.x, y: t.at.y, z: t.at.z }];
        expect(raidOrders(plan, view({ members, seen, staged: true })).melee.step!.rank).toBe(2);
        seen[seen.length - 1] = { ...seen[seen.length - 1]!, isPeaceful: false, isTargetable: false };
        expect(raidOrders(plan, view({ members, seen, staged: true })).melee.step!.rank).toBe(2);
    });

    test('at the stage it waits for STAGE_SHARE of the living', () => {
        const members = [...at(plan.stage, 6), ...at(plan.route[1]!, 4).map(m => ({ ...m, id: m.id + 100 }))];
        const o = raidOrders(plan, view({ members, staged: false }));
        expect(6 / 10).toBeLessThan(STAGE_SHARE);
        expect(o.phase).toBe('stage');
        expect(o.stand).toEqual(plan.stage);
        const dead = members.map((m, i) => i >= 6 ? { ...m, alive: false } : m);
        expect(raidOrders(plan, view({ members: dead })).phase).toBe('assault');
    });

    test('a body spread round the stage (formation) is staged: within STAGE_NEAR, or its centre on the stage (live 02:18-02:32)', () => {
        // 5 at the stage, 3 casters fanned out 800 east: the centre 300 from the stage.
        const members = [...at(plan.stage, 5), ...at({ ...plan.stage, x: plan.stage.x + 800 }, 3).map(m => ({ ...m, id: m.id + 100 }))];
        expect(raidOrders(plan, view({ members, staged: false })).phase).toBe('assault');
        // 1100 out they don't count, but the centre (410 off) is on the stage.
        const wide = [...at(plan.stage, 5), ...at({ ...plan.stage, x: plan.stage.x + 1100 }, 3).map(m => ({ ...m, id: m.id + 100 }))];
        expect(raidOrders(plan, view({ members: wide, staged: false })).phase).toBe('assault');
        // Still on the way: they wait.
        const coming = [...at(plan.stage, 5), ...at(plan.route[0]!, 3).map(m => ({ ...m, id: m.id + 100 }))];
        expect(raidOrders(plan, view({ members: coming, staged: false })).phase).toBe('stage');
    });

    test('with the whole raid known, a unit at the stage waits for the raid on the way (live 04:19)', () => {
        const unit = at(plan.stage, 6);
        const others = at(plan.route[0]!, 10).map(m => ({ ...m, id: m.id + 100 }));
        const far = at({ x: 20_000, y: 20_000, z: 3000 }, 5).map(m => ({ ...m, id: m.id + 200 }));
        const o = raidOrders(plan, view({ members: unit, raid: [...unit, ...others, ...far] }));
        expect(o.phase).toBe('stage');
        expect(o.why).toContain("6/16 of the raid at the stage");
        // The others there too: in it goes. Those back at the portal keep don't count.
        const arrived = at(plan.stage, 10).map(m => ({ ...m, id: m.id + 100 }));
        expect(raidOrders(plan, view({ members: unit, raid: [...unit, ...arrived, ...far] })).phase).toBe('assault');
        // The rest already in at the gate: they count, in it goes (live 04:58).
        const atGate = at(FASTE.targets.find(x => x.label === 'gate')!.stand, 10).map(m => ({ ...m, id: m.id + 100 }));
        expect(raidOrders(plan, view({ members: unit, raid: [...unit, ...atGate, ...far] })).phase).toBe('assault');
        // Without the raid: as before, the unit alone.
        expect(raidOrders(plan, view({ members: unit })).phase).toBe('assault');
        // Staged already: the raid count is not asked again.
        expect(raidOrders(plan, view({ members: unit, raid: [...unit, ...others], staged: true })).phase).toBe('assault');
    });

    test('first the outer fighters, from outside the gate', () => {
        const o = raidOrders(plan, view({ members: at(plan.stage, 10) }));
        expect(o.phase).toBe('assault');
        expect(o.ranged.step!.label).toMatch(/^outer-/);
        expect(o.ranged.focus!.name).toMatch(/^outer-/);
        expect(o.melee.step).toBe(o.ranged.step);
        expect(o.stand).toEqual(o.ranged.step!.stand);
    });

    test('then the gate, melee only; the ranged on a wall caster from its outside spot meanwhile', () => {
        const members = at({ x: 34650, y: 38250, z: 3722 }, 10);
        const o = raidOrders(plan, view({ members, seen: [...garrison('albion', labelsUpTo(1)), ...doors], staged: true }));
        expect(o.melee.step!.label).toBe('gate');
        expect(o.melee.focus!.id).toBe(503);
        expect(o.melee.stand).toEqual(o.melee.step!.stand);
        // The nearest wall caster with an outside spot (S2, after the user nuked a Runemaster from outside, 2026-11-13 18:41).
        expect(o.ranged.step!.label).toBe('wall-e-n');
        expect(o.ranged.stand).toEqual(o.ranged.step!.outside!);
        // The gate broken: the courtyard, the east wall casters with the yard pair.
        const yard = raidOrders(plan, view({ members, seen: [...garrison('albion', labelsUpTo(1)), ...doors], staged: true, broken: [252000301] }));
        expect(yard.ranged.step!.rank).toBe(3);
        expect(FASTE.targets.filter(x => x.rank === 3).map(x => x.label)).toEqual(['yard-1', 'yard-2', 'wall-se', 'wall-e-s', 'wall-e-n', 'wall-n']);
    });

    test('a door is done when a member saw it break', () => {
        const members = at({ x: 34650, y: 38250, z: 3722 }, 10);
        const seen = [...garrison('albion', [...labelsUpTo(1), 'wall-e-n', 'wall-e-s', 'wall-se']), ...doors];
        expect(raidOrders(plan, view({ members, seen, staged: true })).melee.step!.label).toBe('gate');
        const o = raidOrders(plan, view({ members, seen, staged: true, broken: [252000301] }));
        expect(o.ranged.step!.label).toMatch(/^yard-/);
        expect(o.melee.step!.label).toMatch(/^yard-/);
    });

    test('a fighter on one of us goes first, whatever its rank', () => {
        const members = at(plan.stage, 10);
        const seen = garrison();
        const fighter = seen.find(s => s.name === 'yard-1')!;
        fighter.targetObjectId = members[3]!.id;
        const o = raidOrders(plan, view({ members, seen, staged: true }));
        expect(o.ranged.focus!.name).toBe('yard-1');
        expect(o.melee.focus!.name).toBe('yard-1');
    });

    test('a static guard on us beyond reach of our stand is no focus; a fighter on us always is (live 02:55)', () => {
        const members = at({ x: 34420, y: 38275, z: 3720 }, 10);
        const seen = [...garrison('albion', labelsUpTo(1)), ...doors];
        const scout = seen.find(s => s.name === 'roof-e')!;
        scout.targetObjectId = members[2]!.id;
        const o = raidOrders(plan, view({ members, seen, staged: true }));
        expect(o.ranged.focus?.name).not.toBe('roof-e');
        expect(o.why).not.toMatch(/on us/);
        const yard = seen.find(s => s.name === 'yard-2')!;
        yard.targetObjectId = members[1]!.id;
        expect(raidOrders(plan, view({ members, seen, staged: true })).ranged.focus!.name).toBe('yard-2');
    });

    test('one of us by the lord keeps the raid on him, whatever respawned behind (live 03:01)', () => {
        const roof = [...at(plan.roof, 3), ...at({ x: 33100, y: 38250, z: 3722 }, 5).map(m => ({ ...m, id: m.id + 100 }))];
        // Everything back at its post but the doors: still the lord.
        const o = raidOrders(plan, view({ members: roof, seen: garrison(), staged: true }));
        expect(o.phase).toBe('lord');
        // On the roof the ranged take its archers first (seen from there only), the melee stay on the lord.
        expect(o.ranged.focus!.name).toBe('roof-e');
        expect(o.melee.focus!.name).toBe('Lady Thidranki');
        const archersDead = garrison('albion', ['roof-e', 'roof-n', 'roof-s']);
        expect(raidOrders(plan, view({ members: roof, seen: archersDead, staged: true })).ranged.focus!.name).toBe('Lady Thidranki');
        // A roof archer on us takes the melee off nothing; a fighter on us does (frozen window 06:32).
        const archerOnUs = garrison().map(s => s.name === 'roof-e' ? { ...s, targetObjectId: roof[0]!.id } : s);
        expect(raidOrders(plan, view({ members: roof, seen: archerOnUs, staged: true })).melee.focus!.name).toBe('Lady Thidranki');
        const fighterOnUs = garrison().map(s => s.name === 'floor-3' ? { ...s, targetObjectId: roof[0]!.id } : s);
        expect(raidOrders(plan, view({ members: roof, seen: fighterOnUs, staged: true })).ranged.focus!.name).toBe('floor-3');
        // One stray up there alone: the ranks (live 03:33).
        const stray = [...at(plan.roof, 1), ...at({ x: 33100, y: 38250, z: 3722 }, 7).map(m => ({ ...m, id: m.id + 100 }))];
        expect(raidOrders(plan, view({ members: stray, seen: garrison(), staged: true })).phase).toBe('assault');
        // Nobody up there: the ranks again.
        expect(raidOrders(plan, view({ members: at({ x: 33100, y: 38250, z: 3722 }, 8), seen: garrison(), staged: true })).phase).toBe('assault');
    });

    test('a fighter off its post (it came out after us) goes first', () => {
        const members = at(plan.stage, 10);
        const seen = garrison('albion', ['outer-s']);
        seen.push({ id: 99, name: 'Armsman', realm: 'albion', kind: 'npc', level: 28, x: 35900, y: 38300, z: 3400 });
        expect(raidOrders(plan, view({ members, seen, staged: true })).ranged.focus!.id).toBe(99);
    });

    test('a post nobody sees anything at, with a member near, is taken for gone; far off, it still stands', () => {
        const seen = [...garrison('albion', labelsUpTo(5)), ...doors];
        const near = raidOrders(plan, view({ members: at({ x: 33100, y: 38250, z: 3722 }, 10), seen, staged: true, broken: [252000301] }));
        expect(near.melee.step!.label).toBe('keep-door');
        // Nobody within 2500 of any post and nothing seen: every guard is assumed standing, from the first rank on.
        const far = raidOrders(plan, view({ members: at({ x: 36000, y: 41000, z: 3350 }, 10), seen: doors, staged: true }));
        expect(far.ranged.step!.label).toMatch(/^outer-/);
        expect(far.ranged.focus).toBeNull();
    });

    test('done labels from the caller count', () => {
        const all = FASTE.targets.filter(t => t.kind !== 'lord').map(t => t.label);
        const o = raidOrders(plan, view({ members: at(plan.stage, 10), seen: garrison('albion', all), done: all, staged: true }));
        expect(o.phase).toBe('lord');
        expect(o.ranged.focus!.name).toBe('Lady Thidranki');
        expect(o.stand).toEqual(plan.roof);
    });

    test('the lord last: everyone to the roof', () => {
        const all = FASTE.targets.filter(t => t.kind !== 'lord').map(t => t.label);
        const members = at({ x: 32300, y: 38300, z: 3722 }, 10);
        const o = raidOrders(plan, view({ members, seen: [...garrison('albion', all), ...doors], staged: true, broken: [252000301, 252000302] }));
        expect(o.phase).toBe('lord');
        expect(o.melee.stand).toEqual(plan.roof);
        expect(o.melee.focus!.name).toBe('Lady Thidranki');
    });

    test('our own realm\'s NPCs, pets, the dead and the Hastener are no foes', () => {
        const members = at(plan.stage, 10);
        const seen: SiegeSeen[] = [
            { id: 1, name: 'Hastener', realm: 'albion', kind: 'npc', level: 1, x: 34365, y: 38483, z: 3720, targetObjectId: members[0]!.id },
            { id: 2, name: 'outer-armswoman', realm: 'midgard', kind: 'npc', level: 28, x: 34687, y: 38050, z: 3716, targetObjectId: members[0]!.id },
            { id: 3, name: 'spirit', realm: 'albion', kind: 'npc', isPet: true, level: 20, x: 36200, y: 38300, z: 3349, targetObjectId: members[0]!.id },
        ];
        const o = raidOrders(plan, view({ members, seen, staged: true }));
        expect(o.ranged.focus?.id ?? null).not.toBe(1);
        expect(o.ranged.focus?.id ?? null).not.toBe(2);
        expect(o.ranged.focus?.id ?? null).not.toBe(3);
    });

    test('without breakDoors the raid walks through: no door step, melee stand with the casters', () => {
        const p = raidPlan('midgard', undefined, { breakDoors: false })!;
        const members = at({ x: 34650, y: 38250, z: 3722 }, 10);
        const o = raidOrders(p, { members, seen: garrison('albion', labelsUpTo(1)), owner: 'albion', staged: true });
        // No door step: from the outer fighters straight to the courtyard rank.
        expect(o.ranged.step!.rank).toBe(3);
        expect(o.melee.stand).toEqual(o.ranged.stand);
    });

    test('the lord is never taken for a roof archer, though he stands within 400 of their posts', () => {
        const members = at({ x: 33100, y: 38250, z: 3722 }, 10);
        const seen = [...garrison('albion', [...labelsUpTo(3), 'wall-sw', 'wall-nw', 'roof-e', 'roof-n', 'roof-s']), ...doors];
        const o = raidOrders(plan, view({ members, seen, staged: true, broken: [252000301] }));
        expect(o.melee.step!.label).toBe('keep-door');
        expect(o.ranged.step!.label).toBe('floor-3');
    });
});

describe('helpers', () => {
    test('raidCentre ignores the dead', () => {
        expect(raidCentre([{ id: 1, alive: true, x: 0, y: 0, z: 0 }, { id: 2, alive: true, x: 100, y: 0, z: 10 }, { id: 3, alive: false, x: 9999, y: 9999, z: 0 }])).toEqual({ x: 50, y: 0, z: 5 });
        expect(raidCentre([])).toBeNull();
    });

    test('door health: 5200 at keep level 1, 20800 at 4', () => {
        expect(doorHealth(26, 1)).toBe(5200);
        expect(doorHealth(26, 4)).toBe(20800);
    });

    test('door hits and the broken line, as seen live', () => {
        expect(doorDamage([
            { text: 'You attack the Keep Door with your sword and hit for 1 damage!' },
            { text: 'You attack the Keep Door with your sword and hit for 57 damage!' },
            { text: 'You enter combat mode and target [the Keep Door]' },
        ])).toBe(58);
        const plan = raidPlan('albion')!;
        expect(brokenDoors(plan, [{ text: 'The Keep Door is broken!', at: { x: 34400, y: 38275 } }])).toEqual([252000301]);
        expect(brokenDoors(plan, [{ text: 'The Keep Door is broken!', at: { x: 32750, y: 38180 } }])).toEqual([252000302]);
        expect(brokenDoors(plan, [{ text: 'The Keep Door is broken!', at: { x: 40000, y: 30000 } }])).toEqual([]);
    });

    test('inLordReach is 3D', () => {
        const plan = raidPlan('hibernia')!;
        expect(inLordReach(plan, plan.roof)).toBe(true);
        expect(inLordReach(plan, { x: 32296, y: 38267, z: 3722 })).toBe(false);
        expect(inLordReach(plan, { x: 32296, y: 38267, z: 4272 })).toBe(true);
    });
});

// ── Melee and what they can reach (keep pathing, 2026-11-13) ─────────────────

describe('raidOrders with reach: melee take no static guard they cannot walk to', () => {
    const plan = raidPlan('midgard')!;
    const view = (v: Partial<RaidView>): RaidView => ({ members: [], seen: [...garrison(), ...doors], owner: 'albion', ...v });
    const yard = at({ x: 33300, y: 38700, z: 3722 }, 8);

    test('a wall Wizard on us: ranged take it, melee hold when it is out of their reach (live 08:36, the climb)', () => {
        const seen = [...garrison('albion', labelsUpTo(1)), ...doors].map(s => s.name === 'wall-se' ? { ...s, targetObjectId: yard[0]!.id } : s);
        const blind = raidOrders(plan, view({ members: yard, seen, staged: true, broken: [252000301] }));
        expect(blind.melee.focus?.name).toBe('wall-se');
        const o = raidOrders(plan, view({ members: yard, seen, staged: true, broken: [252000301], reach: () => false }));
        expect(o.ranged.focus!.name).toBe('wall-se');
        // The melee keep to their own step, the yard pair's fighter, not the Wizard up on the wall.
        expect(o.melee.focus?.name).not.toBe('wall-se');
        expect(o.melee.focus!.name).toBe('yard-1');
        expect(raidOrders(plan, view({ members: yard, seen, staged: true, broken: [252000301], reach: () => true })).melee.focus!.name).toBe('wall-se');
    });

    test('a fighter needs no route: it comes to us', () => {
        const seen = [...garrison('albion', labelsUpTo(2)), ...doors].map(s => s.name === 'yard-1' ? { ...s, targetObjectId: yard[0]!.id } : s);
        const o = raidOrders(plan, view({ members: yard, seen, staged: true, broken: [252000301], reach: () => false }));
        expect(o.melee.focus!.name).toBe('yard-1');
    });

    test('the lord behind a shut door: ranged keep him, melee hold', () => {
        const roof = [...at(plan.roof, 3), ...at({ x: 33100, y: 38250, z: 3722 }, 5).map(m => ({ ...m, id: m.id + 100 }))];
        const o = raidOrders(plan, view({ members: roof, seen: garrison(), staged: true, reach: () => false }));
        expect(o.phase).toBe('lord');
        expect(o.ranged.focus!.name).toBe('roof-e');
        expect(o.melee.focus).toBeNull();
    });
});

describe('shutDoors', () => {
    test('posterns always, the gate and the building door until broken, nothing in our own keep', () => {
        const ids = (b: number[], ours = false) => shutDoors(FASTE, { broken: b, ours }).map(d => d.id).sort();
        expect(ids([])).toEqual(FASTE.doors.map(d => d.id).sort());
        expect(ids([252000301])).not.toContain(252000301);
        expect(ids([252000301, 252000302])).toEqual([252000303, 252000304, 252000305, 252000306]);
        expect(ids([], true)).toEqual([]);
    });
});

const navStore = new NavmeshStore();
const meshReady = navStore.available() && navStore.at(FASTE.regionId, 33089, 38271) !== null;

describe.skipIf(!meshReady)('meleeReach on the Faste\'s navmesh', () => {
    const R = FASTE.regionId;
    const courtyard = { x: 33300, y: 38700, z: 3722 };
    const stage = FASTE.stage;
    const wallSe = FASTE.targets.find(t => t.label === 'wall-se')!.at;
    const lord = FASTE.targets.find(t => t.kind === 'lord')!.at;
    const none = { broken: [] as number[], ours: false };
    const gateOpen = { broken: [252000301], ours: false };
    const bothOpen = { broken: [252000301, 252000302], ours: false };

    test('the wall-walk is reachable by its stair from the courtyard; from outside only through a broken gate', () => {
        expect(meleeReach(R, courtyard, wallSe, gateOpen, navStore)).toBe(true);
        expect(meleeReach(R, stage, wallSe, none, navStore)).toBe(false);
        expect(meleeReach(R, stage, wallSe, gateOpen, navStore)).toBe(true);
    });

    test('the lord: only through the broken building door, or in our own keep', () => {
        expect(meleeReach(R, courtyard, lord, gateOpen, navStore)).toBe(false);
        expect(meleeReach(R, courtyard, lord, bothOpen, navStore)).toBe(true);
        expect(meleeReach(R, courtyard, lord, { broken: [], ours: true }, navStore)).toBe(true);
    });

    test('outside a keep, nothing to say', () => {
        expect(meleeReach(R, stage, { x: 40448, y: 35226, z: 3216 }, none, navStore)).toBe(true);
    });
});

describe.skipIf(!meshReady || getOccluderStore().forZone(252) === null)('the Faste\'s stands against the walls (lineOfSight) and the doors', () => {
    const R = FASTE.regionId;
    const statics = FASTE.targets.filter(t => t.kind === 'caster' || t.kind === 'archer' || t.kind === 'lord');
    const sees = (from: Point3, to: Point3) => lineOfSight(R, from, to);
    const stand = (l: string) => FASTE.targets.find(t => t.label === l)!.stand;

    test('every caster, archer and the lord is seen from its stand', () => {
        for (const t of statics) expect([t.label, sees(t.stand, t.at)]).toEqual([t.label, true]);
    });

    test('the outer fighters\' stand sees all five; no wall or roof guard sees it, nor the gate\'s', () => {
        for (const t of FASTE.targets.filter(x => x.rank === 1)) expect([t.label, sees(t.stand, t.at)]).toEqual([t.label, true]);
        for (const at of [stand('outer-s'), stand('gate')]) expect(statics.filter(t => sees(t.at, at)).map(t => t.label)).toEqual([]);
    });

    test('the guards that see the courtyard are of its rank, and none of the roof\'s; the roof sees its archers and the lord', () => {
        const courtyard = stand('wall-n');
        expect(statics.filter(t => sees(t.at, courtyard) && !t.optional).every(t => t.rank <= 3)).toBe(true);
        expect(statics.filter(t => sees(t.at, courtyard)).map(t => t.label)).not.toContain('roof-n');
        expect(['roof-e', 'roof-n', 'roof-s', 'lord'].every(l => sees(FASTE.roof, FASTE.targets.find(t => t.label === l)!.at))).toBe(true);
    });

    test('each stand is reachable from the stage once the doors before its rank are broken', () => {
        const doorsBefore = (rank: number) => FASTE.targets.filter(t => t.kind === 'door' && t.rank < rank).map(t => t.doorId!);
        for (const t of FASTE.targets) {
            if (t.kind === 'door') continue;
            const broken = t.kind === 'lord' || t.stand === FASTE.roof ? [252000301, 252000302] : doorsBefore(t.rank);
            expect([t.label, meleeReach(R, FASTE.stage, t.stand, { broken, ours: false }, navStore)]).toEqual([t.label, true]);
        }
    });
});

