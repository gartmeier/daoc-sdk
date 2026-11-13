import { describe, expect, test } from 'bun:test';
import { getTerrainStore } from '../terrain';
import { BATTLEGROUND_LAYOUTS, keepDangers, THIDRANKI, type PlayerRealm } from './keeps';
import {
    brokenDoors, doorDamage, doorHealth, FASTE, inLordReach, raidCentre, raidOrders, raidPlan, routeFrom, STAGE_SHARE,
    type RaidMember, type RaidView, type SiegeSeen, pastStage } from './siege';
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

    test('a peaceful or untargetable NPC at a post (the Hastener at the gate) is no guard', () => {
        const members = at(plan.stage, 10);
        const t = FASTE.targets.find(x => x.label === 'outer-se')!;
        const seen = [...garrison('albion', labelsUpTo(1)), { id: 77, name: 'Hastener', realm: 'albion', kind: 'npc' as const, level: 50, isPeaceful: true, x: t.at.x, y: t.at.y, z: t.at.z }];
        expect(raidOrders(plan, view({ members, seen, staged: true })).ranged.step!.rank).toBe(2);
        seen[seen.length - 1] = { ...seen[seen.length - 1]!, isPeaceful: false, isTargetable: false };
        expect(raidOrders(plan, view({ members, seen, staged: true })).ranged.step!.rank).toBe(2);
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

    test('first the outer fighters, from outside the gate', () => {
        const o = raidOrders(plan, view({ members: at(plan.stage, 10) }));
        expect(o.phase).toBe('assault');
        expect(o.ranged.step!.label).toMatch(/^outer-/);
        expect(o.ranged.focus!.name).toMatch(/^outer-/);
        expect(o.melee.step).toBe(o.ranged.step);
        expect(o.stand).toEqual(o.ranged.step!.stand);
    });

    test('then casters on the east walls while melee break the gate', () => {
        const members = at({ x: 34650, y: 38250, z: 3722 }, 10);
        const o = raidOrders(plan, view({ members, seen: [...garrison('albion', labelsUpTo(1)), ...doors], staged: true }));
        expect(o.ranged.step!.label).toBe('wall-e-n');
        expect(o.ranged.focus!.name).toBe('wall-e-n');
        expect(o.melee.step!.label).toBe('gate');
        expect(o.melee.focus!.id).toBe(503);
        expect(o.melee.stand).toEqual(o.melee.step!.stand);
    });

    test('a door is done when a member saw it break', () => {
        const members = at({ x: 34650, y: 38250, z: 3722 }, 10);
        const seen = [...garrison('albion', [...labelsUpTo(1), 'wall-e-n', 'wall-e-s', 'wall-se']), ...doors];
        expect(raidOrders(plan, view({ members, seen, staged: true })).melee.step!.label).toBe('gate');
        const o = raidOrders(plan, view({ members, seen, staged: true, broken: [252000301] }));
        expect(o.ranged.step!.label).toMatch(/^yard-/);
        expect(o.melee.step!.label).toMatch(/^yard-/);
    });

    test('a guard on one of us goes first, whatever its rank', () => {
        const members = at(plan.stage, 10);
        const seen = garrison();
        const archer = seen.find(s => s.name === 'roof-n')!;
        archer.targetObjectId = members[3]!.id;
        const o = raidOrders(plan, view({ members, seen, staged: true }));
        expect(o.ranged.focus!.name).toBe('roof-n');
        expect(o.melee.focus!.name).toBe('roof-n');
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
        expect(o.ranged.step!.label).toBe('wall-e-n');
        expect(o.melee.step).toBeNull();
        expect(o.melee.stand).toEqual(o.ranged.stand);
    });

    test('the lord is never taken for a roof archer, though he stands within 400 of their posts', () => {
        const members = at({ x: 33100, y: 38250, z: 3722 }, 10);
        const seen = [...garrison('albion', [...labelsUpTo(4), 'roof-e', 'roof-n', 'roof-s']), ...doors];
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
