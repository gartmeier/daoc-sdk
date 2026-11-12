import { describe, expect, test } from 'bun:test';
import { EquipmentSlot, ObjectType } from '../types';
import { afterShot, archer, bowOf, CLOSE, shotPlan } from './archer';

describe('afterShot', () => {
    const hit = 'Tristram is attacking you and your shot is interrupted!';
    test('two draws in a row interrupted by an attacker: the bow rests (Diarmuid against Tristram, 7 draws, no shot)', () => {
        expect(afterShot(0, hit)).toEqual({ interrupts: 1, rest: false });
        expect(afterShot(1, hit)).toEqual({ interrupts: 0, rest: true });
    });
    test('a shot that flies resets the run; other refusals leave it', () => {
        expect(afterShot(1, 'You shoot Celt with your bow and hit for 98 damage!')).toEqual({ interrupts: 0, rest: false });
        expect(afterShot(1, 'You move and interrupt your shot!')).toEqual({ interrupts: 1, rest: false });
        expect(afterShot(1, undefined)).toEqual({ interrupts: 1, rest: false });
    });
});

describe('bowOf', () => {
    test('the bow in the ranged slot, its reach less the margin', () => {
        expect(bowOf([{ slot: EquipmentSlot.Ranged, objectType: ObjectType.Longbow }])).toEqual({ objectType: ObjectType.Longbow, reach: 1460 });
        expect(bowOf([{ slot: EquipmentSlot.Ranged, objectType: ObjectType.CompositeBow }])?.reach).toBe(1300);
        expect(bowOf([{ slot: EquipmentSlot.Ranged, objectType: ObjectType.RecurvedBow }])?.reach).toBe(1380);
        // No bow, or a bow elsewhere: none.
        expect(bowOf([{ slot: EquipmentSlot.RightHand, objectType: ObjectType.ThrustWeapon }])).toBeNull();
        expect(bowOf([{ slot: 45, objectType: ObjectType.Longbow }])).toBeNull();
    });
});

describe('shotPlan', () => {
    test('shoot in reach, walk in beyond it', () => {
        expect(shotPlan(1200, 1610, 1200, 600)).toBe('shoot');
        expect(shotPlan(2000, 1610, 2000, 600)).toBe('close');
    });
    test('melee with an enemy close or no arrows', () => {
        expect(shotPlan(1200, 1610, CLOSE, 600)).toBe('melee');
        expect(shotPlan(200, 1610, 200, 600)).toBe('melee');
        expect(shotPlan(1200, 1610, 1200, 0)).toBe('melee');
    });
});

test('the kit: nuker, hide as an instant, a monster on us swatted, the shot ahead of the melee fight', () => {
    const c = archer();
    expect(c.role).toBe('nuker');
    expect(c.instant!.map(b => b.name)).toEqual(['hide']);
    expect(c.fight!.map(b => b.name)).toEqual(['swat', 'shoot', 'assistMelee']);
});
