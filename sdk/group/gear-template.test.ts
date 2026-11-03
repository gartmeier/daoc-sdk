import { describe, expect, test } from 'bun:test';
import { EquipmentSlot, ObjectType, type InventoryItem } from '../types';
import { accessorySlots, nextAccessory, upgradeGains, type GearDelves } from './gear';
import { keepForLater } from './gear-care';
import { isTemplatePiece } from './gear-score';
import { CLASS_KITS, levelCaps, MAX_BONUSES, templateFor, templateGap, templateSql, templateTotals, wearOrder } from './gear-template';

const WARRIOR = { Axe: 24, Shields: 18, Parry: 16 };
const item = (over: Partial<InventoryItem>): InventoryItem => ({ slot: 40, name: 'x', level: 24, count: 1, model: 0, objectType: ObjectType.Magical, condition: 100, durability: 100, quality: 100, weight: 1, value1: 0, value2: 0, hand: 0, ...over });

describe('levelCaps', () => {
    test('level 24, as the calculators give it', () => {
        expect(levelCaps(24)).toEqual({ stat: 36, hits: 96, resist: 13, skill: 5, power: 13, powerPool: 12, armorFactor: 24, itemAf: 48, clothAf: 24, dpsAf: 84 });
    });
});

describe('templateFor', () => {
    const realms: Record<string, 'albion' | 'midgard' | 'hibernia'> = { Warrior: 'midgard', Skald: 'midgard', Healer: 'midgard', Shaman: 'midgard', Spiritmaster: 'midgard', Paladin: 'albion', Cleric: 'albion', Sorcerer: 'albion', Cabalist: 'albion', Theurgist: 'albion', Hero: 'hibernia', Druid: 'hibernia', Bard: 'hibernia', Mentalist: 'hibernia', Enchanter: 'hibernia' };

    test('every class fills the 14 slots and every row fits', () => {
        for (const className of Object.keys(CLASS_KITS)) {
            const pieces = templateFor(className, realms[className]!, 24, {});
            for (const s of [21, 22, 23, 25, 27, 28, 24, 26, 29, 32, 33, 34, 35, 36]) expect(pieces.some(p => p.slot === s)).toBe(true);
            for (const p of pieces) expect(p.bonuses.length).toBeLessThanOrEqual(MAX_BONUSES);
            expect(new Set(pieces.map(p => p.id)).size).toBe(pieces.length);
        }
    });

    test('adds up to the caps, exactly', () => {
        const totals = templateTotals(templateFor('Warrior', 'midgard', 24, WARRIOR));
        for (const stat of [1, 2, 3, 4]) expect(totals.get(stat)).toBe(36);
        expect(totals.get(10)).toBe(96);
        for (let resist = 11; resist <= 19; resist++) expect(totals.get(resist)).toBe(13);
        for (const skill of [54, 43, 40]) expect(totals.get(skill)).toBe(5);
        expect(totals.get(148)).toBe(24);
        expect(totals.has(9)).toBe(false); // No power on a class without it.
    });

    test('a caster gets power and a focus staff, cloth at its own AF', () => {
        const pieces = templateFor('Sorcerer', 'albion', 24, { 'Mind Magic': 16, 'Body Magic': 17, 'Matter Magic': 4 });
        const totals = templateTotals(pieces);
        expect(totals.get(9)).toBe(13);
        expect(totals.get(196)).toBe(12);
        expect(totals.get(165)).toBe(24);
        expect(pieces.find(p => p.slot === EquipmentSlot.Torso)!.dpsAf).toBe(24);
        expect(pieces.find(p => p.slot === EquipmentSlot.TwoHand)!.objectType).toBe(ObjectType.Staff);
    });

    test('a line left at 1 gets no skill bonus, and an unknown trained line throws', () => {
        expect(templateTotals(templateFor('Cleric', 'albion', 24, { Rejuvenation: 19, Smite: 1 })).get(42)).toBe(5);
        expect(() => templateFor('Cleric', 'albion', 24, { Smite: 3 })).toThrow(/Smite/);
    });

    test('accessories are known by name, on either side', () => {
        const pieces = templateFor('Warrior', 'midgard', 24, WARRIOR);
        expect(accessorySlots(item({ name: pieces.find(p => p.slot === EquipmentSlot.RightRing)!.name }))).toEqual([35, 36]);
        expect(accessorySlots(item({ name: pieces.find(p => p.slot === EquipmentSlot.Neck)!.name }))).toEqual([29]);
    });

    test('the two-hander goes on last, so it ends up held', () => {
        expect(wearOrder(templateFor('Skald', 'midgard', 24, { Axe: 18 })).at(-1)!.slot).toBe(EquipmentSlot.TwoHand);
    });
});

describe('templateSql', () => {
    test('touches only its own ids', () => {
        const sql = templateSql(templateFor('Warrior', 'midgard', 24, WARRIOR));
        expect(sql).toContain("'t24_warrior_25'");
        expect(sql).toContain('ON DUPLICATE KEY UPDATE');
        expect(sql).not.toMatch(/^\s*(UPDATE|DELETE)/m);
    });
});

describe('templateGap', () => {
    const pieces = templateFor('Warrior', 'midgard', 24, WARRIOR);
    test('a full set needs nothing', () => {
        expect(templateGap(pieces, pieces.map(p => ({ slot: p.slot, name: p.name })), [])).toEqual({ worn: pieces.length, missing: [], toMake: [] });
    });
    test('in the backpack is not to make', () => {
        const [first, ...rest] = pieces;
        const gap = templateGap(pieces, rest.map(p => ({ slot: p.slot, name: p.name })), [{ slot: 41, name: first!.name }]);
        expect(gap.missing).toEqual([first!]);
        expect(gap.toMake).toEqual([]);
    });
});

describe('the gear passes leave a template alone', () => {
    const ring = item({ slot: EquipmentSlot.LeftRing, name: 'Thidranki Warrior Left Ring' });
    const other = item({ slot: EquipmentSlot.RightRing, name: 'Thidranki Warrior Right Ring' });
    const better = item({ slot: 41, name: 'Dragonmight Ring', level: 50 });

    test('a higher ring in the bag replaces nothing', () => {
        expect(nextAccessory([better], [ring, other])).toBeNull();
    });
    test('but fills what is empty', () => {
        expect(nextAccessory([better], [ring])?.slot).toBe(EquipmentSlot.RightRing);
    });
    test('upgradeGains has no row for a worn piece', async () => {
        const cur = item({ slot: 25, objectType: ObjectType.Chain, name: 'Thidranki Warrior Hauberk', value1: 48, value2: 27 });
        const candidate = item({ slot: 41, objectType: ObjectType.Chain, name: 'Better Hauberk', value1: 500, value2: 90 });
        const delves = { score: async () => 0 } as unknown as GearDelves;
        expect(await upgradeGains(delves, [{ item: candidate, cur }], 24, () => 0)).toEqual([]);
    });
    test('a spare piece is kept from a sale', () => {
        expect(keepForLater(item({ name: 'Thidranki Warrior Left Ring' }), { level: 24, className: 'Warrior', realm: 'midgard' })).toBe(true);
    });
    test('isTemplatePiece goes by the prefix', () => {
        expect(isTemplatePiece({ name: 'Thidranki Warrior Axe' })).toBe(true);
        expect(isTemplatePiece({ name: 'fine alloy axe' })).toBe(false);
    });
});
