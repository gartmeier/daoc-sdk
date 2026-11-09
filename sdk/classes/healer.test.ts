import { describe, expect, test } from 'bun:test';
import { executionContext } from '../execution-context';
import type { Behavior } from '../group/member';
import { guarded } from './healer';

const throwing: Behavior<any> = { name: 'cureMezz', async run() { throw new Error('RANGE_MARGIN_3D is not defined'); } };
const ctx = () => {
    const skips: string[] = [];
    return { skips, ctx: { skip: (r: string) => { skips.push(r); return false as const; } } as any };
};

describe('guarded', () => {
    test('a behaviour that throws is a skip, so the list goes on to heal', async () => {
        const { skips, ctx: c } = ctx();
        expect(await guarded(throwing).run(c)).toBe(false);
        expect(skips).toEqual(['cureMezz threw: RANGE_MARGIN_3D is not defined']);
    });

    test('a cancel still throws', async () => {
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));
        const { ctx: c } = ctx();
        await expect(executionContext.run({ signal: controller.signal } as any, () => guarded(throwing).run(c))).rejects.toThrow('RANGE_MARGIN_3D');
    });

    test('what it returns passes through', async () => {
        const ok: Behavior<any> = { name: 'x', async run() { return true; } };
        expect(await guarded(ok).run(ctx().ctx)).toBe(true);
        expect(guarded(ok).name).toBe('x');
    });
});
