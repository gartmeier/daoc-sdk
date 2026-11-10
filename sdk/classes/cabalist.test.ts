import { describe, expect, test } from 'bun:test';
import { withCharacter } from '../group/character';
import { withPets } from '../group/pets';
import { rvrBehaviors } from '../group/rvr';
import type { Contact } from '../group/types';
import { getBuild } from '../../data/builds';
import { Spellbook } from '../group/spells';
import { getSpell } from '../../data/index';
import { cabalist, meleeDebuffTarget, nearsightTarget, nextMeleeDebuff, offFocusTarget, quickcastWaitMs, underFire } from './cabalist';
import { reachOfBuild } from './reach';
import { sorcerer } from './sorcerer';
import { theurgist } from './theurgist';

const me = { x: 0, y: 0, regionId: 238 };
const foe = (id: number, x: number, over: Partial<Contact> = {}): Contact => ({ objectId: id, name: `Norseman${id}`, kind: 'player', regionId: 238, x, y: 0, hp: 100, target: null, stale: false, cc: null, ...over } as Contact);
const orders = (focus: number, cc: { targetId: number; by: string }[] = []) => ({ focus, cc });

describe('offFocus', () => {
    test('nothing while the focus is in reach and free: that is assist', () => {
        const focus = foe(1, 1200);
        expect(offFocusTarget(me, focus, [focus, foe(2, 800)], orders(1), 1500, false)).toBeNull();
    });

    test('the nearest free enemy in reach while the focus is out of it, or held', () => {
        const focus = foe(1, 2400);
        expect(offFocusTarget(me, focus, [focus, foe(2, 1400), foe(3, 900)], orders(1), 1500, false)?.objectId).toBe(3);
        const near = foe(1, 1000);
        expect(offFocusTarget(me, near, [near, foe(2, 1400)], orders(1), 1500, true)?.objectId).toBe(2);
    });

    test('never one mezzed, assigned or claimed for crowd control, a pet, stale or out of reach', () => {
        const focus = foe(1, 2400);
        const t = (over: Partial<Contact>) => offFocusTarget(me, focus, [focus, foe(2, 900, over)], orders(1), 1500, false);
        expect(t({ cc: { by: 'Merlin', kind: 'mezz', until: Date.now() + 9000 } })).toBeNull();
        expect(t({ isPet: true })).toBeNull();
        expect(t({ stale: true })).toBeNull();
        expect(t({ x: 1600 })).toBeNull();
        expect(t({ regionId: 1 })).toBeNull();
        expect(offFocusTarget(me, focus, [focus, foe(2, 900)], orders(1, [{ targetId: 2, by: 'Merlin' }]), 1500, false)).toBeNull();
        expect(offFocusTarget(me, focus, [focus, foe(2, 900)], orders(1), 1500, false, id => id === 2)).toBeNull();
    });

    test('it goes right below assist in the three nukers, and can be turned off', () => {
        const noCc = rvrBehaviors().nuker.filter(b => b.name !== 'crowdControl');
        for (const kit of [cabalist(), sorcerer({ saveBelow: 0 }), theurgist({ saveBelow: 0 })]) {
            const list = withPets(withCharacter(noCc, kit), { fnf: true }).map(b => b.name);
            expect(list.indexOf('offFocus')).toBe(list.indexOf('assist') + 1);
        }
        expect(cabalist({ offFocus: false }).fight!.map(b => b.name)).toEqual(['assist']);
        expect(sorcerer({ offFocus: false }).fight!.map(b => b.name)).toEqual(['assist']);
    });
});

/** The picks a member of `className` on `build` has at 24, as its Spellbook reads them. */
function picksOf(className: string, build: string) {
    const known = reachOfBuild(getBuild(className, build)!, 24).known;
    const spells = known.map(k => ({ name: k.name, level: k.level, internalId: k.info.id, lineName: k.line, lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 }));
    const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana: 999, maxHealth: 600, level: 24 }) } as any;
    return new Spellbook(sdk, { getSpellInfo: (s: { internalId: number }) => getSpell(s.internalId) ?? null } as any).all();
}

describe('meleeDebuff', () => {
    test('Morgana: Inflict Malaise, then Enfeeble Body, then Magical Web, each once', () => {
        const all = picksOf('Cabalist', 'Matter');
        expect(nextMeleeDebuff(all, 999, new Set())?.spell.name).toBe('Inflict Malaise');
        expect(nextMeleeDebuff(all, 999, new Set(['CombatSpeedDebuff']))?.spell.name).toBe('Enfeeble Body');
        expect(nextMeleeDebuff(all, 999, new Set(['CombatSpeedDebuff', 'StrengthDebuff']))?.spell.name).toBe('Magical Web');
        expect(nextMeleeDebuff(all, 999, new Set(['CombatSpeedDebuff', 'StrengthDebuff', 'DexterityDebuff']))).toBeNull();
    });

    test('Merlin never an area one (Imbalance, Banish Conviction): Enfeeble Body, then Mesh of Force', () => {
        const all = picksOf('Sorcerer', 'Balanced body and mind');
        expect(nextMeleeDebuff(all, 999, new Set())?.spell.name).toBe('Enfeeble Body');
        expect(nextMeleeDebuff(all, 999, new Set(['StrengthDebuff']))?.spell.name).toBe('Minor Mesh of Force');
    });

    test('Taliesin: Friction', () => {
        expect(nextMeleeDebuff(picksOf('Theurgist', 'Ice and earth'), 999, new Set())?.spell.name).toBe('Friction');
    });

    test('the melee on us first, else on a caster; never one mezzed or out of reach', () => {
        const members = [
            { name: 'Galahad', role: 'tank', isDead: false, x: 0, y: 900 },
            { name: 'Morgana', role: 'nuker', isDead: false, x: 0, y: 0 },
            { name: 'Merlin', role: 'nuker', isDead: false, x: 600, y: 0 },
        ] as any[];
        const onMerlin = foe(1, 650, { target: 'Merlin' }), onMe = foe(2, 50, { target: 'Morgana' }), onTank = foe(3, 0, { y: 950, target: 'Galahad' } as any);
        const d = (id: number) => ({ 1: 650, 2: 50, 3: 950 } as Record<number, number>)[id]!;
        expect(meleeDebuffTarget(members[1], members, [onMerlin, onMe], d, 1500)?.objectId).toBe(2);
        expect(meleeDebuffTarget(members[1], members, [onMerlin, onTank], d, 1500)?.objectId).toBe(1);
        expect(meleeDebuffTarget(members[1], members, [onTank], d, 1500)).toBeNull();
        expect(meleeDebuffTarget(members[1], members, [{ ...onMe, cc: { by: 'Merlin', kind: 'mezz', until: Date.now() + 9000 } }], d, 1500)).toBeNull();
        expect(meleeDebuffTarget(members[1], members, [onMerlin], () => 1600, 1500)).toBeNull();
    });

    test('it goes above flee in all three nukers', () => {
        for (const kit of [cabalist(), sorcerer({ saveBelow: 0 }), theurgist({ saveBelow: 0 })]) {
            const list = withCharacter(rvrBehaviors().nuker, kit).map(b => b.name);
            expect(list.indexOf('meleeDebuff')).toBe(list.indexOf('flee') - 1);
            expect(list.indexOf('quickcast')).toBe(list.indexOf('flee') - 2);
        }
        expect(cabalist({ meleeDebuff: false }).instant!.map(b => b.name)).toEqual(['quickcast']);
    });

    test('a refused quickcast waits what the server says, not the 30 s lock', () => {
        expect(quickcastWaitMs('You must wait 1 second to use this ability.')).toBe(1500);
        expect(quickcastWaitMs('You must wait 12 more second to attempt to quick cast!')).toBe(12_500);
        expect(quickcastWaitMs('You can not cast when your are in melee combat.')).toBeNull();
    });

    test('quickcast only under fire: a melee on us, or a cast cut in the last 5 s', () => {
        expect(underFire(true, undefined, 10_000)).toBe(true);
        expect(underFire(false, 7000, 10_000)).toBe(true);
        expect(underFire(false, 4000, 10_000)).toBe(false);
        expect(underFire(false, undefined, 10_000)).toBe(false);
    });
});

describe('nearsight', () => {
    const NOW = 1_000_000;
    const none = new Map<number, number>();
    test('Morgana reaches Obscuring Dust: Nearsight 35, range 2300', () => {
        const dust = picksOf('Cabalist', 'Matter').filter(p => p.type === 'Nearsight').sort((a, b) => b.spell.level - a.spell.level)[0]!;
        expect([dust.spell.name, dust.value, dust.range]).toEqual(['Obscuring Dust', 35, 2300]);
    });

    test('the marked mezzer first, then the one seen casting last, then a healer, then the nearest', () => {
        const bard = foe(5, 2100, { caster: true, castingAt: NOW - 9000 });
        const ench = foe(6, 2000, { caster: true, castingAt: NOW - 1000 });
        const druid = foe(7, 1200, { healer: true });
        const hero = foe(8, 500);
        expect(nearsightTarget(me, [bard, ench, druid, hero], { cc: [] }, none, 2250, NOW, 5)?.objectId).toBe(5);
        expect(nearsightTarget(me, [bard, ench, druid, hero], { cc: [] }, none, 2250, NOW)?.objectId).toBe(6);
        expect(nearsightTarget(me, [druid, foe(9, 900, { caster: true })], { cc: [] }, none, 2250, NOW)?.objectId).toBe(7);
        expect(nearsightTarget(me, [hero], { cc: [] }, none, 2250, NOW)).toBeNull();
    });

    test('the group focus right after the marked mezzer, if it is a caster or healer', () => {
        const niamh = foe(11, 1900, { caster: true });
        const ench = foe(6, 2000, { caster: true, castingAt: NOW - 1000 });
        expect(nearsightTarget(me, [niamh, ench], { cc: [], focus: 11 }, none, 2250, NOW)?.objectId).toBe(11);
        expect(nearsightTarget(me, [niamh, ench], { cc: [], focus: 11 }, none, 2250, NOW, 6)?.objectId).toBe(6);
        expect(nearsightTarget(me, [foe(12, 900), ench], { cc: [], focus: 12 }, none, 2250, NOW)?.objectId).toBe(6);
    });

    test('never one mezzed, assigned, claimed, done lately or out of reach', () => {
        const ench = foe(6, 2000, { caster: true });
        expect(nearsightTarget(me, [{ ...ench, cc: { by: 'Merlin', kind: 'mezz', until: NOW + 9000 } }], { cc: [] }, none, 2250, NOW)).toBeNull();
        expect(nearsightTarget(me, [ench], { cc: [{ targetId: 6, by: 'Merlin' }] }, none, 2250, NOW)).toBeNull();
        expect(nearsightTarget(me, [ench], { cc: [] }, none, 2250, NOW, null, id => id === 6)).toBeNull();
        expect(nearsightTarget(me, [ench], { cc: [] }, new Map([[6, NOW + 1000]]), 2250, NOW)).toBeNull();
        expect(nearsightTarget(me, [foe(6, 2300, { caster: true })], { cc: [] }, none, 2250, NOW)).toBeNull();
    });

    test('Morgana casts it before her fight, after flee', () => {
        const list = withCharacter(rvrBehaviors().nuker, cabalist()).map(b => b.name);
        expect(list.indexOf('nearsight')).toBeGreaterThan(list.indexOf('flee'));
        expect(list.indexOf('nearsight')).toBeLessThan(list.indexOf('assist'));
        expect(withCharacter(rvrBehaviors().nuker, cabalist({ nearsight: false })).map(b => b.name)).not.toContain('nearsight');
    });
});

