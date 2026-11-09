import { describe, expect, test } from 'bun:test';
import { withCharacter } from '../group/character';
import { withPets } from '../group/pets';
import { rvrBehaviors } from '../group/rvr';
import type { Contact } from '../group/types';
import { getBuild } from '../../data/builds';
import { Spellbook } from '../group/spells';
import { getSpell } from '../../data/index';
import { cabalist, meleeDebuffTarget, nextMeleeDebuff, offFocusTarget } from './cabalist';
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
        }
        expect(cabalist({ meleeDebuff: false }).instant).toBeUndefined();
    });
});
