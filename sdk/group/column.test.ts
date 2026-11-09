// Travelling as a column (Orders.column): the pack decides when (pack.column) and who leads, holdFormation walks it,
// the observer measures it. Region 9999 has no spawns and no battleground: nothing gets in the way.
import { describe, expect, test } from 'bun:test';
import { COLUMN_BAND, COLUMN_FAR, COLUMN_LEAD, columnPace, columnSpot, holdFormation, type TacticsSettings } from './behaviors';
import { isMaterialChange } from './blackboard';
import { enemy, picture, report } from './fixtures';
import type { MemberContext } from './member';
import { formatReport, GroupObserver } from './observer';
import { columnOrder, decidePack, PACK_OPTIONS, PACK_SETTINGS, type PackSettings } from './pack';
import { mergeSettings, type CoordinatorContext } from './strategy';
import type { ColumnOrder, Contact, GroupPicture, MemberReport, Orders, Point } from './types';

const R = 9999;
const BASE = { x: 10_000, y: 10_000 };
const LOOP = [{ x: 10_000, y: 10_000, z: 0 }, { x: 13_000, y: 10_000, z: 0 }];
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [], buffSpells: [] });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function team(over: Partial<Record<string, Partial<MemberReport>>> = {}): MemberReport[] {
    const at = (dx: number, dy: number) => ({ regionId: R, x: BASE.x + dx, y: BASE.y + dy, level: 24 });
    return [
        report('Tank', { role: 'tank', className: 'Hero', objectId: 1, mana: 0, capabilities: caps(false, false, false), ...at(0, 0), ...over.Tank }),
        report('Druid', { role: 'healer', className: 'Druid', objectId: 2, capabilities: caps(true, true, false), ...at(-100, 100), ...over.Druid }),
        report('Bard', { role: 'support', className: 'Bard', objectId: 3, capabilities: caps(true, true, false), ...at(-100, -100), ...over.Bard }),
        report('Menta', { role: 'nuker', className: 'Mentalist', objectId: 4, capabilities: caps(true, true, true), ...at(-200, 100), ...over.Menta }),
        report('Encha', { role: 'nuker', className: 'Enchanter', objectId: 5, capabilities: caps(false, false, true), ...at(-200, -100), ...over.Encha }),
    ];
}

const ON = { pack: { ...PACK_OPTIONS, column: 3500 } };

function ctx(p: GroupPicture, settings: any = {}, memory: Record<string, any> = {}): CoordinatorContext<PackSettings> {
    return { picture: p, orders: p.orders, memory, now: p.at, windingDown: false, settings: mergeSettings(PACK_SETTINGS, { patrol: LOOP, ...settings }) };
}

const foe = (id: number, x: number, y = 10_000) => enemy(id, 'midgard', { regionId: R, x, y });
/** Three together: a group to stalk, not stragglers to hunt (prey). */
const three = (x: number) => [foe(101, x), foe(102, x + 200), foe(103, x + 100, 10_200)];

describe('decidePack: a column while travelling with nobody near', () => {
    test('off by default: the slots, as before', () => {
        const u = decidePack(ctx(picture(team())));
        expect(u.phase).toBe('travel');
        expect(u.column).toBeNull();
        expect(u.spread).toBe(false);
    });

    test('on: the Bard leads, the tank first behind him, the healer last', () => {
        const u = decidePack(ctx(picture(team()), ON));
        expect(u.phase).toBe('travel');
        expect(u.column).toEqual({ driver: 'Bard', order: ['Tank', 'Encha', 'Menta', 'Druid'], gap: 120, speed: 0.9 });
    });

    test('an enemy beyond pack.column leaves it a column, even stalking it', () => {
        const u = decidePack(ctx(picture(team(), three(14_500)), ON));
        expect(u.reason).toContain('stalk');
        expect(u.column?.driver).toBe('Bard');
        expect(u.spread).toBe(true);
    });

    test('the first enemy within pack.column spreads it into its slots, before the raid opens', () => {
        const u = decidePack(ctx(picture(team(), three(13_000)), ON));
        expect(u.phase).toBe('travel');
        expect(u.column).toBeNull();
    });

    test('pack.column 99999: the first enemy anyone sees spreads it, 4800 off too', () => {
        const u = decidePack(ctx(picture(team(), three(14_800)), { pack: { ...PACK_OPTIONS, column: 99_999 } }));
        expect(u.phase).toBe('travel');
        expect(u.column).toBeNull();
    });

    test('the slots stay columnCalmMs after the last enemy, so one gone stale strings nothing out', () => {
        const m: Record<string, any> = {};
        const t = Date.now();
        expect(decidePack(ctx(picture(team(), three(13_000), {}, t), ON, m)).column).toBeNull();
        const stale = three(13_000).map(c => ({ ...c, stale: true }));
        expect(decidePack(ctx(picture(team(), stale, {}, t + 1000), ON, m)).column).toBeNull();
        expect(decidePack(ctx(picture(team(), [], {}, t + 29_000), ON, m)).column).toBeNull();
        expect(decidePack(ctx(picture(team(), [], {}, t + 30_000), ON, m)).column?.driver).toBe('Bard');
    });

    test('a raid has none, and neither has a retreat', () => {
        const raid = decidePack(ctx(picture(team(), [foe(101, 11_000)]), ON));
        expect(raid.phase).toBe('engage');
        expect(raid.column).toBeNull();
        const m: any = { pack: 'pull', pullAt: Date.now() };
        const pull = decidePack(ctx(picture(team(), [foe(101, 11_000)], { phase: 'retreat', retreatTo: { x: 8000, y: 10_000, z: 0 } }), ON, m));
        expect(pull.column).toBeNull();
    });

    test('everyone dead: none, so no old one lingers in the merged orders', () => {
        const dead = team(Object.fromEntries(['Tank', 'Druid', 'Bard', 'Menta', 'Encha'].map(n => [n, { isDead: true, hp: 0 }])));
        expect(decidePack(ctx(picture(dead), ON)).column).toBeNull();
    });
});

describe('columnOrder: who drives', () => {
    const without = (...names: string[]) => team().filter(m => !names.includes(m.name));
    test('a support with a mezz, else a nuker with one, else anyone with one, else the tank', () => {
        expect(columnOrder(team())!.driver).toBe('Bard');
        expect(columnOrder(without('Bard'))!.driver).toBe('Menta');
        expect(columnOrder(without('Bard', 'Menta'))!.driver).toBe('Druid');
        expect(columnOrder(without('Bard', 'Menta', 'Druid'))!.driver).toBe('Tank');
    });
    test('nobody to follow: none', () => {
        expect(columnOrder(team().slice(0, 1))).toBeNull();
    });
});

describe('isMaterialChange: into a column and out of it', () => {
    const base = picture(team(), [], { phase: 'travel', anchor: { x: 11_000, y: 10_000, z: 0 } }).orders;
    const col: ColumnOrder = { driver: 'Bard', order: ['Tank'], gap: 120, speed: 0.9 };
    test('a driver coming or going is; a new order behind the same driver is not', () => {
        expect(isMaterialChange(base, { ...base, column: col })).toBe(true);
        expect(isMaterialChange({ ...base, column: col }, { ...base, column: null })).toBe(true);
        expect(isMaterialChange({ ...base, column: col }, { ...base, column: { ...col, order: ['Tank', 'Druid'] } })).toBe(false);
    });
});

describe('columnSpot', () => {
    test('behind the driver, away from the leg\'s end', () => {
        expect(columnSpot({ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 50, y: 300 }, 240)).toEqual({ x: -240, y: 0 });
    });
    test('at the leg\'s end: on our own side of him', () => {
        expect(columnSpot({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 500 }, 240)).toEqual({ x: 0, y: 240 });
    });
});

describe('columnPace: past its place, at the speed that keeps it there', () => {
    const v = { x: 172, y: 0 };
    test('in its place: the driver\'s speed, aimed COLUMN_LEAD beyond it', () => {
        expect(columnPace({ x: -120, y: 0 }, { x: -120, y: 0 }, v)).toEqual({ to: { x: -120 + COLUMN_LEAD, y: 0 }, speedFactor: 0.9 });
    });
    test('behind it runs faster, up to full speed; ahead of it slower, down to a walk', () => {
        expect(columnPace({ x: -140, y: 0 }, { x: -120, y: 0 }, v).speedFactor).toBe(1);
        expect(columnPace({ x: -400, y: 0 }, { x: -120, y: 0 }, v).speedFactor).toBe(1);
        expect(columnPace({ x: -80, y: 0 }, { x: -120, y: 0 }, v).speedFactor).toBe(0.69);
        expect(columnPace({ x: 200, y: 0 }, { x: -120, y: 0 }, v).speedFactor).toBe(0.3);
    });
    test('beside its place: the driver\'s speed, and the aim brings it onto his line', () => {
        const p = columnPace({ x: -120, y: 150 }, { x: -120, y: 0 }, v);
        expect(p.speedFactor).toBe(0.9);
        expect(p.to.y).toBe(0);
    });
});

// ── holdFormation on a stub member ──

const ANCHOR = { x: 11_500, y: 10_000, z: 0 };
const DRIVER = { x: 10_000, y: 10_000 };
const COLUMN: ColumnOrder = { driver: 'Bard', order: ['Tank', 'Druid'], gap: 120, speed: 0.9 };

function member(o: { name: string; at: Point; orders?: Partial<Orders>; driver?: Partial<MemberReport> | null; moving?: boolean }) {
    const calls = { walkTo: [] as { x: number; y: number; opts: any }[], moveTo: [] as (Point & { speedFactor?: number })[], stop: 0 };
    const others = o.driver === null ? [] : [report('Bard', { role: 'support', regionId: R, x: DRIVER.x, y: DRIVER.y, objectId: 3, ...o.driver })];
    const pic = picture([report(o.name, { role: 'tank', regionId: R, x: o.at.x, y: o.at.y, objectId: 1 }), ...others], [], { phase: 'travel', anchor: ANCHOR, facing: ANCHOR, column: COLUMN, ...o.orders });
    const state = { moving: o.moving ?? false };
    const ctx = {
        name: o.name, role: 'tank', settings: PACK_SETTINGS as TacticsSettings, memory: new Map<string, any>(),
        me: () => ({ name: o.name, objectId: 1, regionId: R, x: o.at.x, y: o.at.y, z: 0, level: 24 }),
        orders: () => pic.orders, picture: () => pic, members: () => pic.members, member: (n: string) => pic.members.find(m => m.name === n),
        doing: () => {}, skip: () => false, result: () => {},
        bot: { walkTo: async (x: number, y: number, opts: any) => { calls.walkTo.push({ x, y, opts }); return { success: true, message: 'arrived' }; } },
        sdk: {
            getMovement: () => ({ moving: state.moving }),
            sendMoveTo: async (x: number, y: number, _z?: number, opts: { speedFactor?: number } = {}) => { calls.moveTo.push({ x, y, ...(opts.speedFactor !== undefined ? { speedFactor: opts.speedFactor } : {}) }); state.moving = true; return { success: true, message: '' }; },
            sendStop: async () => { calls.stop++; state.moving = false; return { success: true, message: '' }; },
        },
    } as unknown as MemberContext<TacticsSettings>;
    return { ctx, calls, pic, state };
}

describe('holdFormation in a column', () => {
    test('the driver walks the leg, at the column\'s speed', async () => {
        const s = member({ name: 'Bard', at: DRIVER, driver: null });
        expect(await holdFormation().run(s.ctx)).toBe(true);
        expect(s.calls.walkTo).toHaveLength(1);
        expect(s.calls.walkTo[0]).toMatchObject({ x: ANCHOR.x, y: ANCHOR.y, opts: { speedFactor: 0.9 } });
    });

    test('at the leg\'s end the driver waits for the next', async () => {
        const s = member({ name: 'Bard', at: { x: ANCHOR.x - 100, y: ANCHOR.y }, driver: null });
        expect(await holdFormation().run(s.ctx)).toBe(false);
        expect(s.calls.walkTo).toHaveLength(0);
    });

    test('a follower moves straight to its place, (rank + 1) × gap behind, with no walk to wait out', async () => {
        const s = member({ name: 'Tank', at: { x: 9_600, y: 10_300 } });
        expect(await holdFormation().run(s.ctx)).toBe(true);
        expect(s.calls.walkTo).toHaveLength(0);
        expect(s.calls.moveTo).toEqual([{ x: DRIVER.x - 120, y: DRIVER.y }]);
        const second = member({ name: 'Druid', at: { x: 9_600, y: 10_300 } });
        await holdFormation().run(second.ctx);
        expect(second.calls.moveTo).toEqual([{ x: DRIVER.x - 240, y: DRIVER.y }]);
    });

    test('the same place while moving is not sent again; the driver moving on is', async () => {
        const s = member({ name: 'Tank', at: { x: 9_600, y: 10_300 } });
        await holdFormation().run(s.ctx);
        await holdFormation().run(s.ctx);
        expect(s.calls.moveTo).toHaveLength(1);
        s.pic.members.find(m => m.name === 'Bard')!.x += 200;
        await holdFormation().run(s.ctx);
        expect(s.calls.moveTo).toHaveLength(2);
        expect(s.calls.moveTo[1]).toEqual({ x: DRIVER.x + 200 - 120, y: DRIVER.y });
    });

    test('the driver moving: past its place at his pace, and in its place it keeps going', async () => {
        const now = Date.now();
        // One report: standing as far as it knows, so to its place, 103 short of where his next one puts it.
        const s = member({ name: 'Tank', at: { x: DRIVER.x - 120, y: DRIVER.y }, driver: { x: DRIVER.x - 103, at: now - 600 } });
        await holdFormation().run(s.ctx);
        expect(s.calls.moveTo).toEqual([{ x: DRIVER.x - 103 - 120, y: DRIVER.y }]);
        // His next, 103 on in 0.6 s: in its place exactly, at his speed (172 a second, 0.9), aimed COLUMN_LEAD on toward the anchor.
        const bard = s.pic.members.find(m => m.name === 'Bard')!;
        bard.x = DRIVER.x; bard.at = now;
        expect(await holdFormation().run(s.ctx)).toBe(true);
        expect(s.calls.moveTo).toHaveLength(2);
        expect(s.calls.moveTo[1]!.x).toBeGreaterThan(DRIVER.x - 120 + COLUMN_LEAD - 10);
        expect(s.calls.moveTo[1]!.y).toBe(DRIVER.y);
        expect(s.calls.moveTo[1]!.speedFactor).toBeCloseTo(0.9, 1);
        // Falling behind: faster (full speed, no factor), sent again at once.
        bard.x = DRIVER.x + 80; bard.at = now + 300;
        await holdFormation().run(s.ctx);
        expect(s.calls.moveTo).toHaveLength(3);
        expect(s.calls.moveTo[2]!.speedFactor ?? 1).toBe(1);
    });

    test('the driver stopping: back to its place, where it stops', async () => {
        const now = Date.now();
        const s = member({ name: 'Tank', at: { x: DRIVER.x - 300, y: DRIVER.y }, driver: { x: DRIVER.x - 103, at: now - 1600 } });
        await holdFormation().run(s.ctx);
        const bard = s.pic.members.find(m => m.name === 'Bard')!;
        bard.x = DRIVER.x; bard.at = now - 1000;
        await holdFormation().run(s.ctx);
        bard.at = now;
        await holdFormation().run(s.ctx);
        expect(s.calls.moveTo.at(-1)).toEqual({ x: DRIVER.x - 120, y: DRIVER.y });
    });

    test('in its place it stays, and the turn goes on down the list', async () => {
        const s = member({ name: 'Tank', at: { x: DRIVER.x - 120 + COLUMN_BAND - 10, y: DRIVER.y } });
        expect(await holdFormation().run(s.ctx)).toBe(false);
        expect(s.calls.moveTo).toHaveLength(0);
    });

    test('far behind it walks by the navmesh, not a straight move', async () => {
        const s = member({ name: 'Tank', at: { x: DRIVER.x - 120 - COLUMN_FAR - 200, y: DRIVER.y } });
        expect(await holdFormation().run(s.ctx)).toBe(true);
        expect(s.calls.moveTo).toHaveLength(0);
        expect(s.calls.walkTo).toHaveLength(1);
    });

    test('not in the order, or the driver gone: its slot round the anchor', async () => {
        const stranger = member({ name: 'Menta', at: { x: 9_000, y: 10_000 } });
        expect(await holdFormation().run(stranger.ctx)).toBe(true);
        expect(stranger.calls.moveTo).toHaveLength(0);
        expect(dist(stranger.calls.walkTo[0]!, ANCHOR)).toBeLessThan(1000);
        const orphan = member({ name: 'Tank', at: { x: 9_000, y: 10_000 }, driver: { isDead: true } });
        await holdFormation().run(orphan.ctx);
        expect(orphan.calls.moveTo).toHaveLength(0);
        expect(orphan.calls.walkTo).toHaveLength(1);
    });

    test('out of the column with its move still going: stopped once, then the slot', async () => {
        const s = member({ name: 'Tank', at: { x: 9_600, y: 10_300 } });
        await holdFormation().run(s.ctx);
        s.pic.orders = { ...s.pic.orders, column: null };
        await holdFormation().run(s.ctx);
        expect(s.calls.stop).toBe(1);
        expect(s.calls.walkTo).toHaveLength(1);
        await holdFormation().run(s.ctx);
        expect(s.calls.stop).toBe(1);
    });
});

describe('GroupObserver: travelling', () => {
    test('time in a column, the spread, and who walked in front', () => {
        const T0 = 1_000_000;
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        const line = (bardX: number) => team({ Bard: { x: bardX, y: 10_000 }, Tank: { x: 9_880, y: 10_000 }, Encha: { x: 9_760, y: 10_000 }, Menta: { x: 9_640, y: 10_000 }, Druid: { x: 9_520, y: 10_000 } });
        const col: ColumnOrder = { driver: 'Bard', order: ['Tank', 'Encha', 'Menta', 'Druid'], gap: 120, speed: 0.9 };
        const far: Contact = enemy(101, 'midgard', { regionId: R, x: 20_000, y: 10_000 });
        // 10 s in a column with the Bard in front, then 10 s in slots with the tank nearest the leg's end.
        for (let i = 1; i <= 10; i++) o.sample(picture(line(10_000), [far], { seq: 1, phase: 'travel', anchor: { x: 11_500, y: 10_000, z: 0 }, column: col }, T0 + i * 1000));
        for (let i = 11; i <= 20; i++) o.sample(picture(line(9_000), [far], { seq: 2, phase: 'travel', anchor: { x: 11_500, y: 10_000, z: 0 }, column: null }, T0 + i * 1000));
        const r = o.report();
        expect(r.totals.columnPct).toBe(50);
        expect(r.totals.ccFrontPct).toBe(50);
        expect(r.totals.travelSpreadAvg).toBeGreaterThan(100);
        expect(formatReport(r)).toContain('Travelling: 50% of it in a column');
        // Each in its place while in the column.
        expect(r.totals.columnOffAvg).toBe(0);
    });

    test('how far the followers stood from their places in the column', () => {
        const T0 = 1_000_000;
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        const col: ColumnOrder = { driver: 'Bard', order: ['Tank', 'Encha', 'Menta', 'Druid'], gap: 120, speed: 0.9 };
        // The line as on 2026-11-09: the gaps right, all 140 too far back; the Druid out of it (beyond COLUMN_FAR) counts for nothing.
        const members = team({ Bard: { x: 10_000, y: 10_000 }, Tank: { x: 9_740, y: 10_000 }, Encha: { x: 9_620, y: 10_000 }, Menta: { x: 9_500, y: 10_000 }, Druid: { x: 8_000, y: 10_000 } });
        for (let i = 1; i <= 5; i++) o.sample(picture(members, [enemy(101, 'midgard', { regionId: R, x: 20_000, y: 10_000 })], { seq: 1, phase: 'travel', anchor: { x: 11_500, y: 10_000, z: 0 }, column: col }, T0 + i * 1000));
        const r = o.report();
        expect(r.totals.columnOffAvg).toBe(140);
        expect(r.totals.columnTrailAvg).toBe(140);
        expect(formatReport(r)).toContain('a follower stood 140 off its place on average (140 too far back overall)');
    });
});
