import { describe, expect, test } from 'bun:test';
import { measure, type AliveRow } from './alive';

const row = (t: number, unit: string, realm: string, size: number, living: number, fighting: boolean, x: number, y: number): AliveRow =>
    ({ t, unit, realm, size, inZone: living, living, fighting, x, y });

describe('alive measures', () => {
    const base = new Date('2026-11-13T14:00:30').getTime();
    const portals = [{ realm: 'albion', x: 0, y: 0 }];

    test('distance to the nearest fight, and its share within 15000', () => {
        const rows = [
            row(base, 'camelot', 'albion', 6, 6, true, 3000, 4000),
            row(base, 'midgard', 'midgard', 6, 6, false, 100, 100),
            row(base + 60_000, 'camelot', 'albion', 6, 6, true, 30000, 40000),
            row(base + 60_000, 'midgard', 'midgard', 6, 6, false, 100, 100),
        ];
        const [h] = measure(rows, portals);
        expect(h!.nearShare.albion).toBeGreaterThan(0);
        expect(h!.nearShare.albion).toBeLessThan(1);
    });

    test('uneven minutes count when one realm has more than 1.5 times another', () => {
        const rows = [0, 1, 2].flatMap(i => [
            row(base + i * 60_000, 'camelot', 'albion', 6, 6, false, 0, 0),
            row(base + i * 60_000, 'midgard', 'midgard', 3, 3, false, 0, 0),
        ]);
        const [h] = measure(rows, portals);
        expect(h!.unevenMin).toBeGreaterThanOrEqual(3);
        expect(h!.longestUneven).toBeGreaterThanOrEqual(3);
    });

    test('a window with solos, small-man and groups all fighting counts once', () => {
        const rows = [
            row(base, 'camelot', 'albion', 6, 6, true, 0, 0),
            row(base, 'camelot-s1', 'albion', 2, 2, true, 0, 0),
            row(base, 'camelot-s4', 'albion', 1, 1, true, 0, 0),
        ];
        const [h] = measure(rows, portals);
        expect(h!.sizesAll).toBe(1);
    });
});
