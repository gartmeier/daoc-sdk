import { describe, expect, test } from 'bun:test';
import type { BasePlan } from './baseplan';
import { assignCc, decidePve, pickFocus, PVE_SETTINGS, rejectPull, type PveSettings } from './pve';
import { mergeSettings, type CoordinatorContext } from './strategy';
import { contact, picture, report } from './fixtures';
import type { GroupPicture, MemberReport, Orders } from './types';

// Region 9999 has no spawns: no danger zones or aggro data get in the way.
const R = 9999;
const BASE = { x: 10_000, y: 10_000, z: 0 };
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [], buffSpells: [] });

function team(over: Partial<Record<string, Partial<MemberReport>>> = {}): MemberReport[] {
    const at = (dx: number) => ({ regionId: R, x: BASE.x + dx, y: BASE.y });
    return [
        report('Tank', { role: 'tank', objectId: 1, mana: 0, capabilities: caps(false, false, false), ...at(0), ...over.Tank }),
        report('Druid', { role: 'healer', objectId: 2, capabilities: caps(true, false, false), ...at(500), ...over.Druid }),
        report('Bard', { role: 'support', objectId: 3, capabilities: caps(true, true, true), ...at(-500), ...over.Bard }),
        report('Menta', { role: 'nuker', objectId: 4, capabilities: caps(true, true, true), ...at(800), ...over.Menta }),
    ];
}

function ctx(p: GroupPicture, opts: { orders?: Partial<Orders>; memory?: Record<string, any>; settings?: Partial<PveSettings>; now?: number; windingDown?: boolean } = {}): CoordinatorContext<PveSettings> {
    const memory = opts.memory ?? { camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE };
    return {
        picture: p, orders: { ...p.orders, ...opts.orders }, memory, now: opts.now ?? p.at, windingDown: opts.windingDown ?? false,
        settings: mergeSettings(PVE_SETTINGS, { avoidAggressive: false, ...opts.settings } as any),
    };
}

describe('decidePve', () => {
    test('rests until everyone is ready; a tank without power does not count as low on mana', () => {
        let d = decidePve(ctx(picture(team({ Druid: { mana: 30 } }))));
        expect(d.phase).toBe('recover');
        expect(d.waiting).toEqual([{ name: 'Druid', why: 'power' }]);
        d = decidePve(ctx(picture(team())));
        expect(d.phase).not.toBe('recover');
    });

    test('pulls the highest con in the window near the base, with the tank as puller', () => {
        const mobs = [
            contact(50, { regionId: R, level: 6, x: BASE.x + 800, y: BASE.y }),
            contact(51, { regionId: R, level: 7, x: BASE.x + 1200, y: BASE.y }),
            contact(52, { regionId: R, level: 9, x: BASE.x + 600, y: BASE.y }),   // con 3: out of the window
            contact(53, { regionId: R, level: 7, x: BASE.x + 5000, y: BASE.y }),  // too far
        ];
        const d = decidePve(ctx(picture(team(), mobs)));
        expect(d.phase).toBe('pull');
        expect(d.focus).toBe(51);
        expect(d.puller).toBe('Tank');
    });

    describe('roaming', () => {
        const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y });
        const settings = { roam: true };

        test('a passive mob is a fight for everyone at once: no puller, no carrying it home', () => {
            const d = decidePve(ctx(picture(team(), [mob]), { settings }));
            expect(d.phase).toBe('engage');
            expect(d.focus).toBe(51);
            expect(d.puller).toBeNull();
            expect(d.anchor).toMatchObject({ x: mob.x, y: mob.y });
        });

        test('the walk there stays the fight until the mob is dead or the time is up', () => {
            const now = Date.now();
            const walking = { orders: { phase: 'engage', focus: 51, reason: 'together' } as Partial<Orders>, settings, now };
            const memory = () => ({ camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE, pullStart: now - 1000 });
            expect(decidePve(ctx(picture(team(), [mob]), { ...walking, memory: memory() }))).toEqual({ phase: 'engage', reason: 'together' });
            const late = { ...memory(), pullStart: now - 60_000 };
            expect(decidePve(ctx(picture(team(), [mob]), { ...walking, memory: late })).focus).not.toBe(51);
            expect((late as { exclude?: Set<number> }).exclude?.has(51)).toBeTrue();
        });

        test('they rest where they stand: the base comes to the leader', () => {
            const at = { x: BASE.x + 700, y: BASE.y + 300 };
            const d = decidePve(ctx(picture(team({ Tank: at, Druid: { ...at, mana: 30 }, Bard: at, Menta: at })), { settings }));
            expect(d.phase).toBe('recover');
            expect(d.anchor).toMatchObject(at);
        });

        test('on the way to a new camp the base stays there; after a chase it comes along', () => {
            const far = { x: BASE.x + 9000, y: BASE.y };
            const together = team({ Tank: far, Druid: far, Bard: far, Menta: far });
            const memory = (heading: boolean) => ({ camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE, heading });
            expect(decidePve(ctx(picture(together), { settings, memory: memory(true) })).phase).toBe('travel');
            const chased = memory(false);
            expect(decidePve(ctx(picture(together), { settings, memory: chased })).phase).not.toBe('travel');
            expect(chased.base).toMatchObject(far);
        });

        test('a walk to a passive mob stays clear of aggressive mobs, even ones it would pull', () => {
            // Real spawns in region 200: aggroAt reads the static data. A trapper stands halfway to the eirebug.
            const trapper = contact(61, { regionId: 200, level: 12, x: 323284, y: 538834, name: 'curmudgeon trapper' });
            const eirebug = contact(60, { regionId: 200, level: 11, x: 326250, y: 535210, name: 'large eirebug' });
            const base = { x: 320318, y: 542458 };
            const opts = (roam: boolean) => ({ base, regionId: 200, level: 12, exclude: new Set<number>(), settings: mergeSettings(PVE_SETTINGS, { roam, aggroTolerance: 1, minCon: -3, maxCon: 3, huntRadius: 20_000 } as any) });
            expect(rejectPull(eirebug, [eirebug, trapper], opts(true))).toContain('aggressive on the way');
            expect(rejectPull(eirebug, [eirebug, trapper], opts(false))).toBeNull();
            // The trapper itself is still a target, so it goes first.
            expect(rejectPull(trapper, [eirebug, trapper], opts(true))).toBeNull();
        });

        test('split up, they gather first and the base stays', () => {
            const d = decidePve(ctx(picture(team({ Druid: { x: BASE.x + 4000 } })), { settings }));
            expect(d.phase).toBe('gather');
            expect(d.anchor).toMatchObject({ x: BASE.x, y: BASE.y });
        });
    });

    test('says why nothing was pulled', () => {
        const d = decidePve(ctx(picture(team(), [contact(52, { regionId: R, level: 9, x: BASE.x + 600, y: BASE.y })])));
        expect(d.phase).toBe('idle');
        expect(d.reason).toContain('con 3');
    });

    test('a body pull stays a pull until the mob is near the base, then the fight starts', () => {
        const now = Date.now();
        const memory = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE, pullStart: now - 5000 };
        const far = contact(51, { regionId: R, level: 7, x: BASE.x + 1500, y: BASE.y, target: 'Tank', targetId: 1, threat: true, hostileSince: now - 2000 });
        const orders = { phase: 'pull' as const, focus: 51, puller: 'Tank', anchor: BASE };
        let d = decidePve(ctx(picture(team({ Tank: { x: BASE.x + 1400 } }), [far], orders, now), { memory }));
        expect(d.phase).toBe('pull');
        const near = { ...far, x: BASE.x + 300 };
        d = decidePve(ctx(picture(team(), [near], orders, now), { memory }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
    });

    test('engage keeps the focus and gives an add to a mezzer (the support first)', () => {
        const now = Date.now();
        const focus = contact(51, { regionId: R, target: 'Tank', targetId: 1, threat: true, hostileSince: now - 9000, hp: 40, x: BASE.x, y: BASE.y });
        const add = contact(60, { regionId: R, target: 'Druid', targetId: 2, threat: true, hostileSince: now - 1000, hp: 100, x: BASE.x + 400, y: BASE.y });
        const d = decidePve(ctx(picture(team({ Tank: { targetId: 51 } }), [focus, add], { phase: 'engage', focus: 51 }, now)));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        expect(d.cc).toEqual([{ targetId: 60, by: 'Bard' }]);
    });

    test('the add count for a retreat leaves out the focus and adds with a mezz ordered', () => {
        const now = Date.now();
        const settings = { retreat: { ...PVE_SETTINGS.retreat, enabled: true, maxAdds: 2 } };
        const mob = (id: number) => contact(id, { regionId: R, target: 'Tank', targetId: 1, threat: true, hostileSince: now - 3000, hp: 90, x: BASE.x + 100, y: BASE.y });
        // The focus plus two adds the Bard and the Mentalist are mezzing: under control.
        let d = decidePve(ctx(picture(team(), [mob(51), mob(52), mob(53)], { phase: 'engage', focus: 51, cc: [{ targetId: 52, by: 'Bard' }, { targetId: 53, by: 'Menta' }] }, now), { settings }));
        expect(d.phase).toBe('engage');
        // A third add nobody can take: two adds loose (52 kept by the Bard, 53 and 54 have no mezzer left).
        d = decidePve(ctx(picture(team({ Menta: { capabilities: caps(true, false, true) } }), [mob(51), mob(52), mob(53), mob(54)], { phase: 'engage', focus: 51, cc: [{ targetId: 52, by: 'Bard' }] }, now), { settings }));
        expect(d.phase).toBe('retreat');
        expect(d.reason).toContain('2 adds not under control');
    });

    test('retreat is off by default; when on: retreats when the tank is dead, keeps running while followed', () => {
        const now = Date.now();
        const mob = contact(51, { regionId: R, target: 'Druid', targetId: 2, threat: true, hostileSince: now - 9000, hp: 90, x: BASE.x + 200, y: BASE.y });
        const memory: Record<string, any> = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE };
        const members = team({ Tank: { isDead: true, hp: 0 } });
        const settings = { retreat: { ...PVE_SETTINGS.retreat, enabled: true } };
        expect(decidePve(ctx(picture(members, [mob], { phase: 'engage', focus: 51 }, now), { memory: { ...memory } })).phase).toBe('engage');
        let d = decidePve(ctx(picture(members, [mob], { phase: 'engage', focus: 51 }, now), { memory, settings }));
        expect(d.phase).toBe('retreat');
        expect(d.retreatTo).toBeTruthy();
        expect(d.reason).toContain('tank is dead');
        d = decidePve(ctx(picture(members, [mob], { phase: 'retreat', reason: d.reason }, now + 5000), { memory, now: now + 5000, settings }));
        expect(d.phase).toBe('retreat');
        d = decidePve(ctx(picture(members, [mob], { phase: 'retreat', reason: d.reason }, now + 30_000), { memory, now: now + 30_000, settings }));
        expect(d.phase).toBe('retreat');   // still lost: the tank is dead, so it starts running again
    });

    test('travels in legs when most of the group is far away, gathers for a single straggler', () => {
        const far = (dx: number) => ({ x: BASE.x + dx, y: BASE.y });
        let d = decidePve(ctx(picture(team({ Tank: far(9000), Druid: far(9100), Bard: far(8900), Menta: far(9000) }))));
        expect(d.phase).toBe('travel');
        expect(Math.hypot(d.anchor!.x - (BASE.x + 9000), d.anchor!.y - BASE.y)).toBeLessThanOrEqual(PVE_SETTINGS.travelLeg + 1);
        // Next leg once the group stands at this one, even with casters trailing ~900 behind it.
        const memory: Record<string, any> = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE };
        const first = decidePve(ctx(picture(team({ Tank: far(9000), Druid: far(9100), Bard: far(8900), Menta: far(9000) })), { memory })).anchor!;
        const leg = (dx: number) => ({ x: first.x + dx, y: first.y });
        const second = decidePve(ctx(picture(team({ Tank: leg(0), Druid: leg(550), Bard: leg(550), Menta: leg(900) })), { memory })).anchor!;
        expect(first.x - second.x).toBeCloseTo(PVE_SETTINGS.travelLeg, -1);
        d = decidePve(ctx(picture(team({ Menta: far(5000) }))));
        expect(d.phase).toBe('gather');
        expect(d.reason).toContain('Menta');
    });

    test('waits for dead members and starts nothing new when winding down', () => {
        let d = decidePve(ctx(picture(team({ Bard: { isDead: true } }))));
        expect(d.phase).toBe('recover');
        expect(d.reason).toContain('Bard');
        d = decidePve(ctx(picture(team(), [contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y })]), { windingDown: true }));
        expect(d.phase).toBe('recover');
    });

    test('a pull under way is finished when time is up (a mob already hit would follow the tank)', () => {
        const now = Date.now();
        const memory = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE, pullStart: now - 3000, exclude: new Set<number>() };
        const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 1500, y: BASE.y });
        const d = decidePve(ctx(picture(team(), [mob], { phase: 'pull', focus: 51, puller: 'Tank', anchor: BASE }, now), { memory, windingDown: true }));
        expect(d.phase).toBe('pull');
    });

    test('with a base plan: no pulls from unsafe spawns, the group faces the targets, the objective names them', () => {
        const spawn = (x: number) => ({ name: 'water beetle', x, y: BASE.y, z: 0, level: 7, aggroLevel: 0, aggroRange: 0, flags: 0 });
        const plan: BasePlan = {
            base: BASE, facing: { x: BASE.x + 800, y: BASE.y }, score: 800, margin: 400,
            targets: [{ ...spawn(BASE.x + 800), d: 800 }], unsafe: [{ ...spawn(BASE.x - 900), why: 'stand: wild lucradan 700' }],
        };
        const memory = { camp: { ...BASE, zone: '', count: 0, names: 'beetles' }, campLevel: 6, base: BASE, plan, facing: plan.facing };
        // The beetle from the unsafe spawn cons higher and would win without the plan.
        const mobs = [contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y }), contact(52, { regionId: R, level: 8, x: BASE.x - 950, y: BASE.y + 50 })];
        const d = decidePve(ctx(picture(team(), mobs), { memory }));
        expect(d.phase).toBe('pull');
        expect(d.focus).toBe(51);
        expect(d.facing).toEqual(plan.facing);
        expect(d.objective).toContain('1 targets 800-800 away');
        expect(d.reason).toContain('800 away');
    });
});

describe('rejectPull (static data, Lough Derg)', () => {
    test('maxLevelAbove rejects a mob far above the group that con still calls purple', () => {
        // camelot run 20261031-004507: Granddaddy Longlegs L24 at group level 11 conned 3 (purple).
        const longlegs = contact(53, { regionId: 200, name: 'red wolfhound', level: 24, x: 348300, y: 520700 });
        const at = (maxLevelAbove: number) => rejectPull(longlegs, [longlegs], { base: { x: 348800, y: 520300 }, regionId: 200, level: 11, exclude: new Set<number>(), settings: mergeSettings(PVE_SETTINGS, { huntRadius: 3500, maxCon: 3, maxLevelAbove } as any) });
        expect(at(4)).toBe('13 levels above');
        expect(at(99)).not.toBe('13 levels above');
    });

    test('a wolf whose pull walks past a live aggressive lucradan is rejected', () => {
        // Hunt 195452 / 201202: wolves west of the clearance base were pulled past a wild lucradan, which joined.
        const settings = mergeSettings(PVE_SETTINGS, { huntRadius: 3500, pullAggressive: false } as any);
        const base = { x: 350439, y: 521657 };
        const wolf = contact(51, { regionId: 200, name: 'red wolfhound', level: 12, x: 347046, y: 521117 });
        const lucradan = contact(52, { regionId: 200, name: 'wild lucradan', level: 10, x: 347965, y: 520638 });
        const opts = { base, regionId: 200, level: 12, exclude: new Set<number>(), settings };
        expect(rejectPull(wolf, [wolf, lucradan], opts)).toBe('aggressive on the way: wild lucradan');
        expect(rejectPull(wolf, [wolf], opts)).toBeNull();
    });

    test('with pullAggressive, aggressive mobs are pulled up to aggroTolerance; grey and tolerated ones block nothing', () => {
        // A level-13 wild lucradan at a lucradan spawn: aggressive (aggroAt goes by name and place), yellow to L13.
        const lucradan = contact(52, { regionId: 200, name: 'wild lucradan', level: 13, x: 347965, y: 520638 });
        const settings = (over: Partial<PveSettings>) => mergeSettings(PVE_SETTINGS, { huntRadius: 3500, maxCon: 3, ...over } as any);
        const at = (level: number, over: Partial<PveSettings>) => rejectPull(lucradan, [lucradan], { base: { x: 348800, y: 520300 }, regionId: 200, level, exclude: new Set<number>(), settings: settings(over) });
        expect(at(13, { pullAggressive: false, aggroTolerance: 0 })).toBe('aggressive');
        expect(at(13, { pullAggressive: true, aggroTolerance: 0 })).toBeNull();            // yellow: pulled
        expect(at(12, { pullAggressive: true, aggroTolerance: 0 })).toBe('aggressive');    // orange to L12: not
        // A tolerated (here blue) aggressive mob next to a wolf doesn't make the wolf "near aggressive mobs".
        const wolf = contact(51, { regionId: 200, name: 'red wolfhound', level: 12, x: 348300, y: 520700 });
        const blue = { ...lucradan, level: 10 };   // blue to L12
        const near = (tol: number) => rejectPull(wolf, [wolf, blue], { base: { x: 348800, y: 520300 }, regionId: 200, level: 12, exclude: new Set<number>(), settings: settings({ aggroTolerance: tol }) });
        expect(near(-3)).toBe('near aggressive wild lucradan');
        expect(near(-1)).toBeNull();
    });
});

describe('defineStrategy', () => {
    test('merges settings deeply and adds per-member behaviour lists', async () => {
        const { defineStrategy } = await import('./strategy');
        const { pveLeveling } = await import('./pve');
        const { assist, release } = await import('./behaviors');
        const s = defineStrategy(pveLeveling, { settings: { ready: { mana: 35 } }, memberBehaviors: { ciaran: [release(), assist({ holdMs: 4000 })] } });
        expect(s.settings.ready).toEqual({ hp: 80, mana: 35 });
        expect(s.settings.holdMs).toBe(PVE_SETTINGS.holdMs);
        expect(s.memberBehaviors?.ciaran?.map(b => b.name)).toEqual(['release', 'assist']);
        expect(s.behaviors.nuker).toBe(pveLeveling.behaviors.nuker);
    });
});

describe('focus and crowd control', () => {
    test('pickFocus: what the tank hits, else whoever is on a non-tank, never a mezzed mob if another is free', () => {
        const a = contact(1, { target: 'Tank', hp: 80, threat: true });
        const b = contact(2, { target: 'Druid', hp: 90, threat: true });
        const m = contact(3, { target: 'Druid', hp: 10, threat: true, cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 5000 } });
        const tank = report('Tank', { role: 'tank', targetId: 1 });
        expect(pickFocus([a, b, m], tank)?.objectId).toBe(1);
        expect(pickFocus([a, b, m], report('Tank', { role: 'tank' }))?.objectId).toBe(2);
    });

    test('assignCc keeps standing assignments and gives each add one mezzer', () => {
        const members = [
            report('Bard', { role: 'support', capabilities: caps(true, true, true) }),
            report('Menta', { role: 'nuker', capabilities: caps(true, true, true) }),
            report('Druid', { role: 'healer', capabilities: caps(true, false, false) }),
        ];
        const adds = [contact(7), contact(8), contact(9)];
        expect(assignCc(adds, members, [{ targetId: 8, by: 'Menta' }])).toEqual([{ targetId: 8, by: 'Menta' }, { targetId: 7, by: 'Bard' }]);
    });
});
