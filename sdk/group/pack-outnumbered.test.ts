import { describe, expect, test } from 'bun:test';
import { enemy, picture, report } from './fixtures';
import { decidePack, PACK_SETTINGS, type PackSettings } from './pack';
import { mergeSettings, type CoordinatorContext } from './strategy';
import type { Contact, GroupPicture, MemberReport, Orders } from './types';

// The user, playing Niamh at 20:09 in a raid on the Faste: "5 free of 6 vs 3", "6 free of 7 vs 3", Albion and Midgard both, four
// of hibernia dead ("We were the sandwich"). Outnumbered by two or more free in reach, a pack's raid leaves, and none starts.
const R = 9999;
const caps = { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [] };
const team = (): MemberReport[] => ['Tank', 'Druid', 'Bard', 'Menta', 'Encha'].map((n, i) =>
    report(n, { role: i ? 'nuker' : 'tank', className: i ? 'Eldritch' : 'Hero', objectId: i + 1, regionId: R, x: 10_000 - i * 50, y: 10_000, level: 24, capabilities: caps }));
const ctx = (p: GroupPicture, memory: Record<string, any>, orders: Partial<Orders> = {}): CoordinatorContext<PackSettings> =>
    ({ picture: p, orders: { ...p.orders, ...orders }, memory, now: p.at, windingDown: false, settings: mergeSettings(PACK_SETTINGS, { patrol: [{ x: 10_000, y: 10_000, z: 0 }, { x: 13_000, y: 10_000, z: 0 }] } as any) });
const foes = (n: number, realm: 'midgard' | 'albion' = 'midgard', from = 0): Contact[] =>
    Array.from({ length: n }, (_, i) => enemy(200 + from + i, realm, { regionId: R, x: 11_200 + i * 40, y: 10_000 + (i % 2) * 80 }));

describe('decidePack outnumbered (S3, the user at 20:09)', () => {
    test('a raid going leaves at 7 free in reach (both realms) vs 5; 5 vs 5 fights on', () => {
        const raid = () => ({ pack: 'raid', raidAt: Date.now() - 2000, packAnchor: { x: 10_000, y: 10_000, z: 0 } });
        const many = decidePack(ctx(picture(team(), [...foes(4), ...foes(3, 'albion', 10)]), raid(), { phase: 'engage' }));
        expect(many.reason).toMatch(/^leave: outnumbered: 7 free in reach vs 5/);
        const even = decidePack(ctx(picture(team(), foes(5)), raid(), { phase: 'engage' }));
        expect(even.phase).toBe('engage');
    });
});
