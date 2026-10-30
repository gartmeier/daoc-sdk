import { describe, expect, test } from 'bun:test';
import { assignCc, decidePve, pickFocus, PVE_SETTINGS, type PveSettings } from './pve';
import { mergeSettings, type CoordinatorContext } from './strategy';
import { contact, picture, report } from './fixtures';
import type { GroupPicture, MemberReport, Orders } from './types';

// Region 9999 has no spawns: no danger zones or aggro data get in the way.
const R = 9999;
const BASE = { x: 10_000, y: 10_000, z: 0 };
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [] });

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

    test('retreats when the tank is dead, keeps running while followed, fights again after maxMs', () => {
        const now = Date.now();
        const mob = contact(51, { regionId: R, target: 'Druid', targetId: 2, threat: true, hostileSince: now - 9000, hp: 90, x: BASE.x + 200, y: BASE.y });
        const memory: Record<string, any> = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE };
        const members = team({ Tank: { isDead: true, hp: 0 } });
        let d = decidePve(ctx(picture(members, [mob], { phase: 'engage', focus: 51 }, now), { memory }));
        expect(d.phase).toBe('retreat');
        expect(d.retreatTo).toBeTruthy();
        expect(d.reason).toContain('tank is dead');
        d = decidePve(ctx(picture(members, [mob], { phase: 'retreat', reason: d.reason }, now + 5000), { memory, now: now + 5000 }));
        expect(d.phase).toBe('retreat');
        d = decidePve(ctx(picture(members, [mob], { phase: 'retreat', reason: d.reason }, now + 30_000), { memory, now: now + 30_000 }));
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
