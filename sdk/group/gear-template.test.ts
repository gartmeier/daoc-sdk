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
    const realms: Record<string, 'albion' | 'midgard' | 'hibernia'> = { Warrior: 'midgard', Skald: 'midgard', Healer: 'midgard', Shaman: 'midgard', Spiritmaster: 'midgard', Paladin: 'albion', Cleric: 'albion', Sorcerer: 'albion', Cabalist: 'albion', Theurgist: 'albion', Hero: 'hibernia', Druid: 'hibernia', Bard: 'hibernia', Mentalist: 'hibernia', Enchanter: 'hibernia',
        Armsman: 'albion', Friar: 'albion', Wizard: 'albion', Blademaster: 'hibernia', Warden: 'hibernia', Eldritch: 'hibernia', Berserker: 'midgard', Thane: 'midgard', Runemaster: 'midgard',
        Infiltrator: 'albion', Scout: 'albion', Nightshade: 'hibernia', Ranger: 'hibernia', Shadowblade: 'midgard', Hunter: 'midgard' };

    test('every class fills the 14 slots and every row fits', () => {
        for (const className of Object.keys(CLASS_KITS)) {
            const pieces = templateFor(className, realms[className]!, 24, {});
            for (const s of [21, 22, 23, 25, 27, 28, 24, 26, 29, 32, 33, 34, 35, 36]) expect(pieces.some(p => p.slot === s)).toBe(true);
            for (const p of pieces) expect(p.bonuses.length).toBeLessThanOrEqual(MAX_BONUSES);
            expect(new Set(pieces.map(p => p.id)).size).toBe(pieces.length);
        }
    });

    test('the stealthers and archers: their build lines take a skill bonus, the archers a bow before the melee weapon', () => {
        const builds: [string, Record<string, number>][] = [
            ['Infiltrator', { 'Critical Strike': 21, Thrust: 18, Envenom: 15, Stealth: 19, 'Dual Wield': 7 }],
            ['Scout', { Longbows: 24, Stealth: 16, Shields: 13, Thrust: 12 }],
            ['Nightshade', { 'Critical Strike': 21, Piercing: 17, Envenom: 15, Stealth: 16, 'Celtic Dual': 4 }],
            ['Ranger', { Pathfinding: 21, 'Recurve Bow': 21, Piercing: 12, Stealth: 9, 'Celtic Dual': 4 }],
            ['Shadowblade', { 'Critical Strike': 21, Stealth: 19, Envenom: 17, Axe: 12, 'Left Axe': 3 }],
            ['Hunter', { Beastcraft: 21, Spear: 18, 'Composite Bow': 15, Stealth: 11 }],
        ];
        for (const [className, specs] of builds) {
            const pieces = templateFor(className, realms[className]!, 24, specs);
            for (const p of pieces) expect(p.bonuses.length).toBeLessThanOrEqual(MAX_BONUSES);
            expect(templateTotals(pieces).get(49)).toBe(5); // Stealth
            const bow = pieces.findIndex(p => p.slot === EquipmentSlot.Ranged);
            const melee = pieces.findIndex(p => p.slot === EquipmentSlot.RightHand || p.slot === EquipmentSlot.TwoHand);
            if (['Scout', 'Ranger', 'Hunter'].includes(className)) expect(bow).toBeGreaterThanOrEqual(0);
            else expect(bow).toBe(-1);
            if (bow >= 0) expect(bow).toBeLessThan(melee);
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

    test('the bench classes: their armour, their weapons, and a bonus on every trained line', async () => {
        const { getBuild } = await import('../../data/builds/index');
        const bench: [string, string, number, number[]][] = [
            ['Armsman', 'Polearm hybrid', ObjectType.Plate, [ObjectType.SlashingWeapon, ObjectType.Shield, ObjectType.PolearmWeapon]],
            ['Friar', 'Group support', ObjectType.Leather, [ObjectType.Staff]],
            ['Wizard', 'Ice', ObjectType.Cloth, [ObjectType.Staff]],
            ['Blademaster', 'Group damage with Slam', ObjectType.Reinforced, [ObjectType.Blades, ObjectType.Blades]],
            ['Warden', 'Support', ObjectType.Scale, [ObjectType.Blades, ObjectType.Shield]],
            ['Eldritch', 'Light nuker', ObjectType.Cloth, [ObjectType.Staff]],
            ['Berserker', 'Left Axe, Hammer, high Parry', ObjectType.Studded, [ObjectType.Hammer, ObjectType.LeftAxe]],
            ['Thane', 'Even hybrid with Parry', ObjectType.Chain, [ObjectType.Hammer, ObjectType.Shield]],
            ['Runemaster', 'Darkness nuker', ObjectType.Cloth, [ObjectType.Staff]],
        ];
        for (const [className, buildName, armor, weapons] of bench) {
            const specs = getBuild(className, buildName)!.targets.find(t => t.level >= 24)!.specs;
            const pieces = templateFor(className, realms[className]!, 24, specs);
            expect(pieces.find(p => p.slot === EquipmentSlot.Torso)!.objectType).toBe(armor);
            expect(pieces.filter(p => p.slot >= 10 && p.slot <= 13).map(p => p.objectType)).toEqual(weapons);
            const totals = templateTotals(pieces);
            const trained = Object.values(specs).filter(v => v >= 2).length;
            expect([...totals].filter(([, v]) => v === 5).length).toBeGreaterThanOrEqual(trained);
        }
        const offHand = templateFor('Berserker', 'midgard', 24, {}).find(p => p.slot === EquipmentSlot.LeftHand)!;
        expect(offHand.hand).toBe(2);
        // A Friar swings his staff: no focus on it. A Wizard's is a focus.
        expect(templateTotals(templateFor('Friar', 'albion', 24, {})).has(165)).toBe(false);
        expect(templateTotals(templateFor('Wizard', 'albion', 24, {})).get(165)).toBe(24);
    });

    test('a female class name finds its kit', () => {
        expect(templateFor('Armswoman', 'albion', 24, {}).map(p => p.id)).toEqual(templateFor('Armsman', 'albion', 24, {}).map(p => p.id));
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
