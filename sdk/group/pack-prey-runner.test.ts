import { describe, expect, test } from 'bun:test';
import { enemy, picture, report } from './fixtures';
import { decidePack, PACK_SETTINGS, PREY_CHASE_MS, PREY_LEFT_MS, type PackSettings } from './pack';
import { mergeSettings, type CoordinatorContext } from './strategy';
import type { GroupPicture, MemberReport, Orders } from './types';

// The user, playing Niamh on 11-14 at 10:19 UTC: "we now followed a solo one forever. not sure a "full" group would do that".
// A pack chasing one straggler that keeps running lets it go after PREY_CHASE_MS; one that stands and fights it kills.
const R = 9999;
const caps = { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [] };
const team = (x: number): MemberReport[] => ['Tank', 'Druid', 'Bard', 'Menta', 'Encha', 'Champ'].map((n, i) =>
    report(n, { role: i ? 'nuker' : 'tank', className: i ? 'Eldritch' : 'Hero', objectId: i + 1, regionId: R, x: x - i * 50, y: 10_000, level: 24, capabilities: caps }));
const ctx = (p: GroupPicture, memory: Record<string, any>, orders: Partial<Orders> = {}): CoordinatorContext<PackSettings> =>
    ({ picture: p, orders: { ...p.orders, ...orders }, memory, now: p.at, windingDown: false, settings: mergeSettings(PACK_SETTINGS, { patrol: [{ x: 10_000, y: 10_000, z: 0 }, { x: 30_000, y: 10_000, z: 0 }] } as any) });

describe('decidePack: a straggler that runs is let go (S3, the user at 10:19 UTC)', () => {
    test('chased 25 s and 1500 on, not on us: let go, and no hunt of it after', () => {
        const mem: Record<string, any> = {};
        const t0 = 1_000_000;
        // The Thane 1000 ahead of us, running east; we follow at the same pace.
        let out = decidePack(ctx(picture(team(10_000), [enemy(478, 'midgard', { regionId: R, x: 11_000, y: 10_000 })], {}, t0), mem));
        expect(out.reason).toMatch(/Norseman#478/);
        for (let s = 5; s <= 25; s += 5) out = decidePack(ctx(picture(team(10_000 + s * 80), [enemy(478, 'midgard', { regionId: R, x: 11_000 + s * 80, y: 10_000 })], {}, t0 + s * 1000), mem));
        expect(out.reason).not.toMatch(/^let go/);
        out = decidePack(ctx(picture(team(12_160), [enemy(478, 'midgard', { regionId: R, x: 13_160, y: 10_000 })], {}, t0 + PREY_CHASE_MS + 2000), mem));
        expect(out.reason).toMatch(/^let go of Norseman#478/);
        out = decidePack(ctx(picture(team(12_160), [enemy(478, 'midgard', { regionId: R, x: 13_160, y: 10_000 })], {}, t0 + PREY_CHASE_MS + 4000), mem));
        expect(out.reason).not.toMatch(/Norseman#478/);
        expect(mem.runners[478].until).toBe(t0 + PREY_CHASE_MS + 2000 + PREY_LEFT_MS);
    });

    test('one standing in one spot past 25 s is not let go', () => {
        const mem: Record<string, any> = {};
        const t0 = 1_000_000;
        let out = decidePack(ctx(picture(team(10_000), [enemy(478, 'midgard', { regionId: R, x: 11_000, y: 10_000 })], {}, t0), mem));
        for (let s = 5; s <= 40; s += 5) out = decidePack(ctx(picture(team(10_000), [enemy(478, 'midgard', { regionId: R, x: 11_000, y: 10_000 })], {}, t0 + s * 1000), mem));
        expect(out.reason).toMatch(/Norseman#478/);
        expect(out.reason).not.toMatch(/^let go/);
    });
});
