import { describe, expect, test } from 'bun:test';
import { diverOn, leashTank, meleeOn, MEZZ_MELEE, mezzMelee, PEEL_CASTER, PEEL_MELEE, peelByMezz, peelFocus, ROOT_MELEE, rootMelee } from './peel';
import { ctx, engage, foe, guess, team } from './fixtures';

const NOW = 1_000_000;

describe('diverOn', () => {
    const healers = [{ name: 'Heals', x: 9700, y: 10_100 }];
    test('in melee on one of them a second, next to it, longest on first', () => {
        expect(diverOn([foe(7, -100, { target: 'Heals', targetSince: NOW - 3000 })], healers, NOW)?.objectId).toBe(7);
        expect(diverOn([foe(7, -100, { target: 'Heals', targetSince: NOW - 500 })], healers, NOW)).toBeNull();
        expect(diverOn([foe(7, -100, { target: 'Heals', targetSince: NOW - 3000, targetBySpell: true })], healers, NOW)).toBeNull();
        expect(diverOn([foe(7, 600, { target: 'Heals', targetSince: NOW - 3000 })], healers, NOW)).toBeNull();
        expect(diverOn([foe(7, -100, { target: 'Heals', targetSince: NOW - 1500 }), foe(8, -100, { target: 'Heals', targetSince: NOW - 4000 })], healers, NOW)?.objectId).toBe(8);
    });
});

describe('peelFocus', () => {
    test('melee: the diver on our healer becomes the focus, unless the focus is nearly dead', () => {
        const d = foe(7, -100, { target: 'Heals', targetSince: NOW - 3000 }, 100);
        const u = peelFocus(ctx([foe(1, 1000), d]), engage(1), PEEL_MELEE);
        expect(u.focus).toBe(7);
        expect(u.reason).toBe('raid (peel: 7 on Heals)');
        expect(peelFocus(ctx([foe(1, 1000, { hp: 20 }), d]), engage(1), PEEL_MELEE).focus).toBe(1);
    });
    test('cast: one casting at our Bard is the focus and stays 6 s after its last cast', () => {
        const memory: Record<string, any> = {};
        const caster = (castingAt: number) => foe(2, 1300, { caster: true, target: 'Bard', castingAt }, 300);
        expect(peelFocus(ctx([foe(1, 1000), caster(NOW - 1000)], { memory }), engage(1), PEEL_CASTER).focus).toBe(2);
        expect(peelFocus(ctx([foe(1, 1000), caster(NOW - 9000)], { memory, now: NOW + 3000 }), engage(1), PEEL_CASTER).focus).toBe(2);
        const u = engage(1);
        expect(peelFocus(ctx([foe(1, 1000), caster(NOW - 9000)], { memory, now: NOW + 8000 }), u, PEEL_CASTER)).toBe(u);
    });
});

describe('peel by crowd control', () => {
    test('meleeOn: swinging at a soft member within 350, not the focus', () => {
        const foes = [foe(3, -250, { target: 'Heals' }, 100), foe(4, 50, { target: 'Tank' }), foe(5, -250, { target: 'Heals', targetBySpell: true }, 100)];
        expect(meleeOn(ctx(foes), 1).map(c => c.objectId)).toEqual([3]);
        expect(meleeOn(ctx(foes), 3)).toEqual([]);
    });
    test('peelByMezz: the mezzer leaves its target for the diver, but not a reserved one', () => {
        const foes = [foe(1, 1000), foe(2, 1100, { healer: true }), foe(3, -250, { target: 'Heals' }, 100)];
        expect(peelByMezz(ctx(foes), engage(1, { cc: [{ targetId: 2, by: 'Bard' }] })).cc).toEqual([{ targetId: 3, by: 'Bard' }]);
        expect(peelByMezz(ctx(foes), engage(1, { cc: [{ targetId: 2, by: 'Bard' }] }), { protect: ['healer'], within: 350, reserved: [2] }).cc).toEqual([{ targetId: 2, by: 'Bard' }]);
    });
    test('mezzMelee: the support on their fighter on one of ours first', () => {
        const foes = [foe(1, 800, { healer: true }), foe(2, 600, { target: 'Menta' }), foe(3, 500, {}, 300), foe(4, 400, guess('caster'))];
        const u = mezzMelee(ctx(foes), engage(1, { cc: [{ targetId: 1, by: 'Bard' }, { targetId: 3, by: 'Menta' }] }), MEZZ_MELEE);
        expect(u.cc).toEqual([{ targetId: 3, by: 'Menta' }, { targetId: 2, by: 'Bard' }]);
    });
    test('rootMelee: the rooter off a caster onto the melee running at a soft member; a class kept on damage roots nothing', () => {
        const foes = [foe(1, 1000, { caster: true }), foe(2, 1200, { caster: true }), foe(3, 300, { target: 'Menta' }), foe(4, 900)];
        expect(rootMelee(ctx(foes), engage(1, { cc: [{ targetId: 2, by: 'Encha' }] }), ROOT_MELEE).cc).toEqual([{ targetId: 3, by: 'Encha' }]);
        expect(rootMelee(ctx(foes), engage(1, { cc: [] }), { ...ROOT_MELEE, stayOnDamage: ['Enchanter'] }).cc).toEqual([]);
        expect(rootMelee(ctx([foe(1, 1500), foe(2, 1600)]), engage(1, { cc: [] }), ROOT_MELEE).cc).toEqual([]);
    });
});

describe('leashTank', () => {
    test('the anchor within the leash of the others, on the line toward it', () => {
        const u = leashTank(ctx([]), engage(1, { anchor: { x: 14_000, y: 10_000, z: 0 } }), 800);
        expect(u.anchor!.x).toBeGreaterThan(10_400);
        expect(u.anchor!.x).toBeLessThan(10_500);
        const v = engage(1);
        expect(leashTank(ctx([], { members: team() }), v, 0)).toBe(v);
    });
});
