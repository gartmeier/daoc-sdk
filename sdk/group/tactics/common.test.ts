import { describe, expect, test } from 'bun:test';
import { decidePack, PACK_SETTINGS } from '../pack';
import { anchorFor, clockAt, clockPair, retarget, tacticOn } from './common';
import { boards, canonical, compareDecides, rng } from './compare';
import { ctx, engage, foe } from './fixtures';
import { CC_HEALER_CASTER, focusByRole } from './focus-role';

describe('tacticOn', () => {
    test('on unless set false, also as a flag string', () => {
        expect(tacticOn({}, 'peel')).toBe(true);
        expect(tacticOn({ tactics: { peel: 'false' } }, 'peel')).toBe(false);
        expect(tacticOn({ tactics: { peel: false, focusHold: 0 } }, 'focusHold')).toBe(false);
        expect(tacticOn({ tactics: { peel: 'true' } }, 'peel')).toBe(true);
        expect(tacticOn(undefined, 'makeUp')).toBe(true);
    });
});

describe('clocks', () => {
    test('one key or two', () => {
        const m: Record<string, any> = {};
        clockAt('k', 'at').set(m, 5, 100);
        expect(m).toEqual({ k: { id: 5, at: 100 } });
        expect(clockAt('k', 'at').get(m)).toEqual({ id: 5, since: 100 });
        clockPair('i', 's').set(m, 6, 200);
        expect(clockPair('i', 's').get(m)).toEqual({ id: 6, since: 200 });
        clockPair('i', 's').clear(m);
        expect(m).toEqual({ k: { id: 5, at: 100 } });
    });
});

describe('anchors', () => {
    test('grid only with an anchor in the update; grid-always without; kept near the one in force', () => {
        const c = ctx([foe(1, 1290)], { orders: { anchor: { x: 11_000, y: 10_000, z: 7 } } });
        const f = c.picture.contacts[0]!;
        expect(anchorFor('grid', c, engage(1, { anchor: null }), f)).toBeNull();
        expect(anchorFor('grid-always', c, engage(1, { anchor: null }), f)).toEqual({ x: 11_200, y: 10_000, z: 0 });
        expect(anchorFor('kept', c, engage(1), f)).toEqual({ x: 11_000, y: 10_000, z: 7 });
        expect(retarget(c, engage(2, { cc: [{ targetId: 1, by: 'Bard' }] }), f, 'focus-only')).toEqual(engage(1, { cc: [{ targetId: 1, by: 'Bard' }] }));
    });
});

describe('compareDecides', () => {
    const roster = [{ name: 'Tank', role: 'tank' as const, className: 'Hero' }, { name: 'Heals', role: 'healer' as const, className: 'Druid' }, { name: 'Menta', role: 'nuker' as const, className: 'Mentalist' }];
    const base = { roster, regionId: 200, origin: { x: 10_000, y: 10_000 }, settings: { ...PACK_SETTINGS, patrol: [{ x: 10_000, y: 10_000, z: 0 }], realm: 'hibernia' } as any, seeds: [1, 2, 3, 4, 5, 6, 7, 8] };
    test('the same boards for the same seed', () => {
        const o = { roster, regionId: 200, origin: { x: 0, y: 0 }, ticks: 5 };
        expect(canonical(boards(rng(9), o, 0))).toBe(canonical(boards(rng(9), o, 0)));
    });
    test('a decide against itself: no difference, with generated updates and with the pack', () => {
        const wrap = (inner: any) => (c: any) => focusByRole(c, inner(c), CC_HEALER_CASTER);
        const r = compareDecides({ ...base, a: wrap, b: wrap, inner: decidePack });
        expect(r.differences).toEqual([]);
        expect(r.ticks).toBe(8 * 2 * 40);
    });
    test('two variants: the first tick each run disagrees', () => {
        const r = compareDecides({ ...base, a: inner => c => focusByRole(c, inner(c), CC_HEALER_CASTER), b: inner => c => focusByRole(c, inner(c), { ...CC_HEALER_CASTER, order: ['caster', 'healer', 'cc'] }) });
        expect(r.differences.length).toBeGreaterThan(0);
        expect(r.differences[0]!.a.focus).not.toBe(r.differences[0]!.b.focus);
    });
});
