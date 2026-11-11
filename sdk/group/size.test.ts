import { describe, expect, test } from 'bun:test';
import { decidePack, PACK_SETTINGS, sizedPack } from './pack';
import { decideRvr, RVR_SETTINGS } from './rvr';
import { countFor, describeCount, groupSize } from './size';
import { mergeSettings } from './strategy';
import { compareDecides, type RosterMember } from './tactics/compare';

describe('countFor', () => {
    test('a share of the size, rounded, at least min; a number is that number, also as a flag string', () => {
        expect([3, 4, 5, 6, 7, 8].map(n => countFor({ share: 0.6 }, n))).toEqual([2, 2, 3, 4, 4, 5]);
        expect(countFor({ share: 0.1 }, 3)).toBe(1);
        expect(countFor({ share: 0.1, min: 2 }, 3)).toBe(2);
        expect(countFor(99, 8)).toBe(99);
        expect(countFor('1' as never, 8)).toBe(1);
        expect(describeCount({ share: 0.6 }, 8)).toBe('5 (0.6 of 8)');
        expect(describeCount(3, 8)).toBe('3');
    });

    test('the group size is the most members seen at once, never below five: a report that drops out, or one still logging in, does not shrink it', () => {
        const mem: Record<string, any> = {};
        const names = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `M${i}` }));
        expect(groupSize(mem, names(2))).toBe(5);
        expect(groupSize(mem, names(8))).toBe(8);
        expect(groupSize(mem, names(6))).toBe(8);
    });

    test('at five every default count is what it was before the shares (3), and a fixed flag wins over a share', () => {
        const k = sizedPack(PACK_SETTINGS.pack, 5);
        expect([k.minPack, k.minTogether, k.closeCount, countFor(RVR_SETTINGS.retreat.margin, 5)]).toEqual([3, 3, 3, 3]);
        const e = sizedPack(PACK_SETTINGS.pack, 8);
        // minTogether 0.55 (night 2026-11-11, W2's candidate): 4 of eight keep the pack out, 3 of five as before, 3 of six.
        expect([e.minPack, e.minTogether, e.closeCount, countFor(RVR_SETTINGS.retreat.margin, 8)]).toEqual([5, 4, 5, 5]);
        expect(sizedPack(PACK_SETTINGS.pack, 6).minTogether).toBe(3);
        const flagged = mergeSettings(PACK_SETTINGS, { pack: { minPack: 1, minTogether: 1 }, retreat: { margin: 99 } } as any);
        expect([sizedPack(flagged.pack, 8).minPack, sizedPack(flagged.pack, 8).minTogether, countFor(flagged.retreat.margin, 8)]).toEqual([1, 1, 99]);
    });
});

// The equivalence the change was made under: at five, the decides with the shares give the same orders on every tick as
// with the fixed 3s they had before. Checked once against main's unchanged decides too (2026-11-11, 0 of 400 runs differed).
describe('equivalence at five', () => {
    const FIVE: RosterMember[] = [
        { name: 'Tank', role: 'tank', className: 'Warrior' },
        { name: 'Heals', role: 'healer', className: 'Healer', capabilities: { heal: true, cc: true, ccKinds: ['mezz'] } },
        { name: 'Skald', role: 'support', className: 'Skald' },
        { name: 'Rune', role: 'nuker', className: 'Runemaster', capabilities: { nuke: true } },
        { name: 'Spirit', role: 'nuker', className: 'Spiritmaster', capabilities: { nuke: true } },
    ];
    const EIGHT: RosterMember[] = [...FIVE, { name: 'Thane', role: 'tank', className: 'Thane' }, { name: 'Shaman', role: 'healer', className: 'Shaman', capabilities: { heal: true } }, { name: 'Zerk', role: 'melee', className: 'Berserker' }];
    const patrol = [{ x: 10_000, y: 10_000, z: 0 }];
    const fixed = <S extends { retreat: unknown }>(s: S): S => mergeSettings(s as any, { retreat: { margin: 3 }, ...('pack' in (s as object) ? { pack: { minPack: 3, minTogether: 3, closeCount: 3 } } : {}) }) as S;
    const seeds = Array.from({ length: 120 }, (_, i) => i + 1);
    const run = (roster: RosterMember[], decide: (c: any) => any, s: any) => compareDecides<any>({
        roster, regionId: 9999, origin: { x: 10_000, y: 10_000 }, foes: [1, 12], seeds, ticks: 50, settings: {},
        a: () => c => decide({ ...c, settings: { ...s, patrol } }),
        b: () => c => decide({ ...c, settings: { ...fixed(s), patrol } }),
    });

    test('the pack: the same orders with the shares as with 3, on every tick', () => {
        const r = run(FIVE, decidePack, PACK_SETTINGS);
        expect(r.ticks).toBe(120 * 50);
        expect(r.differences).toEqual([]);
    });

    test('roaming: the same orders with the share as with margin 3, on every tick', () => {
        const r = run(FIVE, decideRvr, RVR_SETTINGS);
        expect(r.ticks).toBe(120 * 50);
        expect(r.differences).toEqual([]);
    });

    test('at eight the shares are live: the same boards give other orders than the 3s', () => {
        expect(run(EIGHT, decidePack, PACK_SETTINGS).differences.length).toBeGreaterThan(0);
        expect(run(EIGHT, decideRvr, RVR_SETTINGS).differences.length).toBeGreaterThan(0);
    });
});
