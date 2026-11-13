import { describe, expect, test } from 'bun:test';
import { report } from './fixtures';
import { FAR_KEEP, mainBody } from './rvr';

describe('mainBody: one far stays far until well inside (live 22:02:55-22:03:04: meeting Deirdre and the trail in turn every 1-2 s)', () => {
    const at = (name: string, x: number, role: 'tank' | 'healer' | 'nuker' = 'nuker', y = 30_000) => report(name, { role, regionId: 252, x, y });
    const team = (deirdreX: number) => [at('Tank', 30_000, 'tank'), at('Druid', 30_000, 'healer', 30_100), at('Menta', 30_000, 'nuker', 29_900), at('Deirdre', deirdreX)];
    const farNames = (deirdreX: number, mem: Record<string, any>) => mainBody(team(deirdreX), 2500, mem).far.map(m => m.name);

    test('at the edge she flips no more: far until FAR_KEEP inside, then in, and in up to the radius again', () => {
        const mem: Record<string, any> = {};
        expect(farNames(32_400, mem)).toEqual([]);
        expect(farNames(32_600, mem)).toEqual(['Deirdre']);
        expect(farNames(32_400, mem)).toEqual(['Deirdre']);
        expect(farNames(30_000 + 2500 - FAR_KEEP + 100, mem)).toEqual(['Deirdre']);
        expect(farNames(30_000 + 2500 - FAR_KEEP - 100, mem)).toEqual([]);
        expect(farNames(32_400, mem)).toEqual([]);
    });
});
