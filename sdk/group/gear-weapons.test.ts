// Better weapons: the rules from specs, the window and the delve. The fake answers delves as
// GameInventoryItem.cs:1156-1197 does, level clamp included; the shop lines come from Gymir and Saga in
// Jordheim, and the static merchant data is real.
import { describe, expect, test } from 'bun:test';
import { getClasses, specDisplayName } from '../../data/index';
import { ALL_FOCUS, parseDelve, parseWeaponDelve } from '../delve';
import { ItemHand, ObjectType, type InventoryItem, type MerchantItem, type PlayerState } from '../types';
import { bestWeapon, buyWeapons, wearWeapons, weaponNeeds, weaponSellers, weaponSlots, weaponUpgrades, type WeaponMember, type WeaponRow } from './gear';
import { focusCover, isFocusCaster, weaponScore, weaponValue } from './gear-score';

const WARRIOR = [['Axe', 20], ['Hammer', 1], ['Sword', 1], ['Shield', 1], ['Parry', 20], ['Thrown Weapons', 1]] as const;
const SKALD = [['Axe', 15], ['Hammer', 1], ['Sword', 1], ['Parry', 7], ['Battlesongs', 17]] as const;
const specs = (rows: readonly (readonly [string, number])[]) => rows.map(([name, level]) => ({ name, level }));

describe('weaponNeeds', () => {
    test('the highest trained line decides, and a class that trains shields keeps its left hand', () => {
        expect(weaponNeeds(specs(WARRIOR))).toEqual({ line: 'Axe', level: 20, left: false, twoHanded: false });
    });

    test('a class with no shield line may take a two-hander', () => {
        expect(weaponNeeds(specs(SKALD))).toEqual({ line: 'Axe', level: 15, left: false, twoHanded: true });
    });

    test('no trained weapon line, no needs: a Healer, a Spiritmaster, or a new Viking with everything at 1', () => {
        expect(weaponNeeds(specs([['Mending', 16], ['Pacification', 8], ['Augmentation', 8]]))).toBeNull();
        expect(weaponNeeds(specs([['Darkness', 15], ['Suppression', 9], ['Summoning', 6]]))).toBeNull();
        expect(weaponNeeds(specs([['Axe', 1], ['Hammer', 1], ['Sword', 1]]))).toBeNull();
    });

    test('a left hand line asks for a left hand and forbids two-handers, in each realm', () => {
        expect(weaponNeeds(specs([['Axe', 18], ['Left Axe', 14], ['Parry', 5]]))).toMatchObject({ line: 'Axe', left: true, twoHanded: false });
        expect(weaponNeeds(specs([['Slash', 18], ['Dual Wield', 14]]))).toMatchObject({ line: 'Slash', left: true, twoHanded: false });
        expect(weaponNeeds(specs([['Blades', 18], ['Celtic Dual', 14], ['Shields', 1]]))).toMatchObject({ line: 'Blades', left: true, twoHanded: false });
    });

    test('a class with both a shield and a left hand goes by which it trains; neither way a two-hander', () => {
        expect(weaponNeeds(specs([['Blades', 18], ['Celtic Dual', 5], ['Shields', 20]]))).toMatchObject({ left: false, twoHanded: false });
        expect(weaponNeeds(specs([['Blades', 18], ['Celtic Dual', 20], ['Shields', 5]]))).toMatchObject({ left: true, twoHanded: false });
    });

    test('a left hand line at 1 is not trained', () => {
        expect(weaponNeeds(specs([['Axe', 18], ['Left Axe', 1]]))).toMatchObject({ left: false, twoHanded: true });
    });

    test('a line of nothing but two-handers takes them, shields trained or not', () => {
        expect(weaponNeeds(specs([['Polearm', 20], ['Shields', 5]]))).toMatchObject({ line: 'Polearm', twoHanded: true });
        expect(weaponNeeds(specs([['Celtic Spear', 20], ['Blades', 5], ['Shields', 5]]))).toMatchObject({ line: 'Celtic Spear', twoHanded: true });
    });
});

describe('weaponSlots', () => {
    const warrior = weaponNeeds(specs(WARRIOR))!, skald = weaponNeeds(specs(SKALD))!, berserker = weaponNeeds(specs([['Axe', 18], ['Left Axe', 14]]))!;

    test('only its own line: a level 1 hammer spec buys no hammer', () => {
        expect(weaponSlots({ objectType: ObjectType.Hammer, hand: 0 }, warrior)).toEqual([]);
        expect(weaponSlots({ objectType: ObjectType.Sword, hand: 0 }, warrior)).toEqual([]);
        expect(weaponSlots({ objectType: ObjectType.Axe, hand: 0 }, warrior)).toEqual([10]);
    });

    test('a weapon that fits left goes right too, and left only for who trains it', () => {
        expect(weaponSlots({ objectType: ObjectType.Axe, hand: 2 }, warrior)).toEqual([10]);
        expect(weaponSlots({ objectType: ObjectType.LeftAxe, hand: 2 }, warrior)).toEqual([10]);
        expect(weaponSlots({ objectType: ObjectType.LeftAxe, hand: 2 }, berserker)).toEqual([10, 11]);
        expect(weaponSlots({ objectType: ObjectType.Axe, hand: 0 }, berserker)).toEqual([10]);
    });

    test('a two-hander only where nothing needs the left hand', () => {
        expect(weaponSlots({ objectType: ObjectType.Axe, hand: 1 }, warrior)).toEqual([]);
        expect(weaponSlots({ objectType: ObjectType.Axe, hand: 1 }, berserker)).toEqual([]);
        expect(weaponSlots({ objectType: ObjectType.Axe, hand: 1 }, skald)).toEqual([12]);
    });

    test('not a weapon, whatever its object type maps to', () => {
        expect(weaponSlots({ objectType: ObjectType.Shield, hand: 0 }, warrior)).toEqual([]);
        expect(weaponSlots({ objectType: ObjectType.Plate, hand: 0 }, warrior)).toEqual([]);
    });
});

describe('parseWeaponDelve', () => {
    test('a worn weapon, as the server wrote it', () => {
        expect(parseWeaponDelve(['Total utility: 0.00', ' ', ' ', 'Damage Modifiers:', '- 1.2 Base DPS', '- 1.2 Clamped DPS', '- 2.5 Weapon Speed', '- 90% Quality', '- 99% Condition', '- Damage Type: Slash', ' ', 'Effective Damage:', '- 1.1 DPS']))
            .toEqual({ baseDps: 1.2, clampedDps: 1.2, speed: 2.5, quality: 90, condition: 99 });
    });

    test('above the level clamp the two figures differ', () => {
        expect(parseWeaponDelve(['- 8.7 Base DPS', '- 7.2 Clamped DPS', '- 4.2 Weapon Speed', '- 85% Quality', '- 100% Condition'])).toMatchObject({ baseDps: 8.7, clampedDps: 7.2 });
    });

    test('at condition 0 the server leaves its line out', () => {
        expect(parseWeaponDelve(['Damage Modifiers:', '- 7.2 Base DPS', '- 7.2 Clamped DPS', '- 4.2 Weapon Speed', '- 85% Quality', '- Damage Type: Slash'])).toMatchObject({ quality: 85, condition: 0 });
    });

    test('a shield is no weapon, and neither is anything else', () => {
        expect(parseWeaponDelve(['Damage Modifiers (when used with shield styles):', '- 1.2 Base DPS', '- 1.2 Clamped DPS', '- 4.0 Shield Speed', ' ', '- Shield Size : Small'])).toBeNull();
        expect(parseWeaponDelve(['Armor Modifiers:', '- 40 Base Factor', '- 40 Clamped Factor', '- 27% Absorption', '- 90% Quality', '- 100% Condition'])).toBeNull();
        expect(parseWeaponDelve([])).toBeNull();
    });
});

describe('weaponValue', () => {
    const w = (clampedDps: number, speed: number, quality = 100, condition = 100) => ({ clampedDps, speed, quality, condition });

    test('clamped DPS, quality and condition multiply; at 2.0 s there is no slow bonus', () => {
        expect(weaponValue(w(7.2, 2))).toBeCloseTo(7.2);
        expect(weaponValue(w(7.2, 2, 85))).toBeCloseTo(6.12);
        expect(weaponValue(w(7.2, 2, 85, 50))).toBeCloseTo(3.06);
    });

    test('the slower of two with the same DPS is a little better: 0.3 % per 0.1 s', () => {
        expect(weaponValue(w(7.2, 4.2))).toBeCloseTo(7.2 * 1.066);
        expect(weaponValue(w(7.2, 3.1))).toBeCloseTo(7.2 * 1.033);
    });

    test('a two-hander gets 1.1 + 0.5 % per spec level', () => {
        expect(weaponValue(w(7.2, 5.5), 15)).toBeCloseTo(7.2 * 1.105 * 1.175);
    });

    test('bonuses move the score by the rate, and at most 10 %', () => {
        expect(weaponScore(10, null)).toBe(10);
        expect(weaponScore(10, 7)).toBeCloseTo(10.35);
        expect(weaponScore(10, 100)).toBeCloseTo(11);
        expect(weaponScore(10, -100)).toBeCloseTo(9);
    });
});

describe('bestWeapon', () => {
    const row = (score: number, price: number): WeaponRow<string> => ({ item: `${score}@${price}`, slot: 10, score, price });

    test('nothing on offer, or no step over what is worn: none', () => {
        expect(bestWeapon([], 1, 1.1)).toBeNull();
        expect(bestWeapon([row(5, 100)], 5, 1.1)).toBeNull();
        expect(bestWeapon([row(5.4, 100)], 5, 1.1)).toBeNull();
        expect(bestWeapon([row(5.5, 100)], 5, 1.1)?.item).toBe('5.5@100');
    });

    test('of two about equal the cheaper; a real difference stays with the better', () => {
        expect(bestWeapon([row(6.5, 900), row(6.48, 100)], 1, 1.1)?.item).toBe('6.48@100');
        expect(bestWeapon([row(6.5, 900), row(6, 100)], 1, 1.1)?.item).toBe('6.5@900');
    });

    test('a weapon that scores nothing never counts as a step over nothing', () => {
        expect(bestWeapon([row(0, 0)], 0, 1.02)).toBeNull();
    });
});

describe('weaponSellers (real merchant data)', () => {
    const JORDHEIM = { regionId: 101, x: 30000, y: 34700, realm: 'midgard' as const, level: 20 };

    test("a Warrior's axes come from one list: two-handers and other lines are no reason to walk", () => {
        const found = weaponSellers(JORDHEIM, weaponNeeds(specs(WARRIOR))!, 1500);
        expect(found.map(s => s.spawn.itemsListTemplateId)).toEqual(['MidAxesClaws']);
    });

    test("a Skald's two-handers add the large weapon shop", () => {
        const found = weaponSellers(JORDHEIM, weaponNeeds(specs(SKALD))!, 1500);
        expect(found.map(s => s.spawn.itemsListTemplateId).sort()).toEqual(['MidAxesClaws', 'MidLargeWeapons']);
    });

    test("the capital's Item Merchants are not on the way, as a copper shop or a bounty one", () => {
        expect(weaponSellers({ ...JORDHEIM, x: 32435, y: 29214 }, weaponNeeds(specs(WARRIOR))!, 1000)).toEqual([]);
    });

    test('a Level Requirement above ours is off the list unless asked for: big shillelagh, level 2, needs 27', () => {
        const near = { regionId: 201, x: 28867, y: 29515, realm: 'hibernia' as const, level: 20 };
        const needs = weaponNeeds(specs([['Large Weapons', 20], ['Shields', 5]]))!;
        const sold = (p: typeof near, opts = {}) => weaponSellers(p, needs, 300, opts).flatMap(s => s.weapons.map(w => w.name));
        expect(sold(near)).not.toContain('big shillelagh');
        expect(sold(near, { overLevel: true })).toContain('big shillelagh');
        expect(sold({ ...near, level: 27 })).toContain('big shillelagh');
    });

    test('above the level limit is off the list unless asked for: fine alloy spiked axe, level 24, no Level Requirement', () => {
        const sold = (p: typeof JORDHEIM, opts = {}) => weaponSellers(p, weaponNeeds(specs(WARRIOR))!, 1500, opts).flatMap(s => s.weapons.map(w => w.name));
        expect(sold(JORDHEIM)).toContain('alloy double-bladed axe');
        expect(sold(JORDHEIM)).not.toContain('fine alloy spiked axe');
        expect(sold(JORDHEIM, { overLevel: true })).toContain('fine alloy spiked axe');
        expect(sold({ ...JORDHEIM, level: 21 })).toContain('fine alloy spiked axe');
    });

    test('nothing near, nothing found', () => {
        expect(weaponSellers({ ...JORDHEIM, x: 1, y: 1 }, weaponNeeds(specs(WARRIOR))!, 100)).toEqual([]);
    });
});

// ── The whole pass, against a fake that answers like the server ─────────────

const shopItem = (page: number, slot: number, name: string, objectType: number, hand: number, dps: number, speed: number, price: number, extra: Partial<MerchantItem> = {}): MerchantItem =>
    ({ page, slot, name, level: 20, price, model: 1, usable: true, objectType, hand, damageType: 'slash', value1: dps * 10, spdAbs: speed * 10, ...extra });
const GYMIR = [
    shopItem(0, 14, 'steel double-bladed axe', ObjectType.Axe, 0, 5.7, 4.2, 28800),
    shopItem(0, 16, 'alloy bearded axe', ObjectType.LeftAxe, 2, 6.3, 2.7, 43200),
    // The real template is Albion's: the window lists it and the server won't let it on.
    shopItem(0, 17, 'alloy war axe', ObjectType.Axe, 2, 6.6, 3.1, 41760),
    shopItem(0, 19, 'alloy double-bladed axe', ObjectType.Axe, 0, 7.2, 4.2, 86400),
    shopItem(0, 23, 'fine alloy spiked axe', ObjectType.Axe, 0, 8.4, 3.7, 216000),
    shopItem(0, 24, 'fine alloy double-bladed axe', ObjectType.Axe, 0, 8.7, 4.2, 259200),
    shopItem(1, 15, 'alloy bladed moon claw', ObjectType.HandToHand, 2, 7.2, 3.2, 62400),
];
const SAGA = [
    // These two are Albion's as well; the large axes are Midgard's.
    shopItem(0, 21, 'alloy great axe', ObjectType.Axe, 1, 7.2, 5.5, 66240),
    shopItem(0, 27, 'fine alloy great axe', ObjectType.Axe, 1, 8.7, 5.5, 198720),
    shopItem(0, 20, 'alloy large axe', ObjectType.Axe, 1, 6.9, 4.7, 86400),
    shopItem(0, 26, 'fine alloy large axe', ObjectType.Axe, 1, 8.4, 4.7, 259200),
    shopItem(0, 19, 'alloy great sword', ObjectType.Sword, 1, 7.2, 5.4, 65280),
];

const worn = (slot: number, name: string, objectType: number, dps: number, speed: number, quality = 90, condition = 100): InventoryItem =>
    ({ slot, name, level: 0, count: 1, model: 1, objectType, condition, durability: 100, quality, weight: 20, value1: dps * 10, value2: speed * 10, hand: 0 });
const TRAINING_AXE = worn(10, 'training axe', ObjectType.Axe, 1.2, 2.5);
const SHIELD = { ...worn(11, 'small training shield', ObjectType.Shield, 1.2, 4), value1: 1 };

interface Opts {
    specs?: readonly (readonly [string, number])[];
    className?: string;
    realm?: string;
    equipment?: InventoryItem[];
    inventory?: InventoryItem[];
    copper?: number;
    shops?: Record<string, MerchantItem[]>;
    /** Item name → extra delve lines (bonuses). */
    bonus?: Record<string, string[]>;
    /** Item name → its focus: levels on ALL Spell Lines, or on one line. */
    focus?: Record<string, number | { line: string; value: number }>;
    /** Item name → other bonuses its delve reads as. */
    parsed?: Record<string, object[]>;
    /** Item name → its Level Requirement. */
    required?: Record<string, number>;
    /** Seller → its window type, for a shop that doesn't charge copper. */
    windowTypes?: Record<string, number>;
    refuse?: RegExp;
    /** Where the player stands: Jordheim's market by default. */
    at?: { x: number; y: number };
}

function world(o: Opts = {}) {
    const f = {
        equipment: o.equipment ?? [TRAINING_AXE, SHIELD],
        inventory: o.inventory ?? [] as InventoryItem[],
        calls: [] as string[],
        delves: [] as string[],
        copper: o.copper ?? 3_000_000,
        member: null as unknown as WeaponMember,
    };
    const level = 20;
    const delveLines = (name: string, dps: number, speed: number, quality: number, condition: number) => [
        ...(o.bonus?.[name]?.length ? ['Magical Bonuses:', ...o.bonus[name]!, ' '] : []),
        'Total utility: 0.00', ' ', 'Damage Modifiers:', `- ${dps.toFixed(1)} Base DPS`, `- ${Math.min(dps, 1.2 + 0.3 * level).toFixed(1)} Clamped DPS`, `- ${speed.toFixed(1)} Weapon Speed`, `- ${quality}% Quality`, ...(condition ? [`- ${condition}% Condition`] : []), '- Damage Type: Slash',
    ];
    const focusOf = (name: string) => {
        const fo = o.focus?.[name];
        if (fo === undefined) return [];
        return [typeof fo === 'number' ? { category: 'focus', name: ALL_FOCUS, spec: null, value: fo, unit: 'lvls', text: '' } : { category: 'focus', name: `${fo.line} Focus`, spec: fo.line, value: fo.value, unit: 'lvls', text: '' }];
    };
    const answer = (lines: string[], name = '') => ({ success: true, message: 'ok', lines, levelRequirement: o.required?.[name] ?? null, bonuses: [...(o.bonus && lines.some(l => /Strength/.test(l)) ? [{ category: 'stat', stat: 'STR', name: 'Strength', value: 7, unit: 'pts', text: '' }] : []), ...focusOf(name), ...(o.parsed?.[name] ?? [])], unknown: [], bonusLevel: null, item: null });
    const shops = o.shops ?? { Gymir: GYMIR, Saga: SAGA };
    let opened = '';
    const actions = {
        delveItem: async (item: InventoryItem) => {
            f.delves.push(item.name);
            return isShield(item) ? answer(['Damage Modifiers (when used with shield styles):', '- 1.2 Base DPS', '- 1.2 Clamped DPS', '- 4.0 Shield Speed']) : answer(delveLines(item.name, item.value1 / 10, item.value2 / 10, item.quality, item.condition), item.name);
        },
        delveMerchantItem: async (seller: string, at: { page: number; slot: number }) => {
            const item = shops[seller]!.find(i => i.page === at.page && i.slot === at.slot)!;
            f.delves.push(item.name);
            return answer(delveLines(item.name, item.value1 / 10, item.spdAbs / 10, 85, 100), item.name);
        },
        openMerchant: async (name: string) => {
            f.calls.push(`open ${name}`);
            opened = name;
            return { success: true, message: 'ok', merchant: { name }, items: shops[name] ?? [] };
        },
        buyItem: async (seller: string, at: { page: number; slot: number }) => {
            const item = shops[seller]!.find(i => i.page === at.page && i.slot === at.slot)!;
            f.calls.push(`buy ${item.name} from ${seller}`);
            if (item.price > f.copper) return { success: false, reason: 'insufficient_funds', message: 'too dear', itemsGained: [] };
            f.copper -= item.price;
            const bought: InventoryItem = { ...worn(60, item.name, item.objectType, item.value1 / 10, item.spdAbs / 10, 85), hand: item.hand };
            f.inventory = [...f.inventory, bought];
            return { success: true, message: 'ok', spent: item.price, itemsGained: [bought] };
        },
        equipItem: async (item: InventoryItem, opts: { slot: number }) => {
            f.calls.push(`equip ${item.name} -> ${opts.slot}`);
            if (o.refuse?.test(item.name)) return { success: false, reason: 'refused', message: 'You have no skill in using this weapon type!' };
            const old = f.equipment.find(e => e.slot === opts.slot);
            f.equipment = [...f.equipment.filter(e => e.slot !== opts.slot), { ...item, slot: opts.slot }];
            f.inventory = f.inventory.filter(i => i.slot !== item.slot);
            if (old) f.inventory = [...f.inventory, { ...old, slot: item.slot }];
            return { success: true, message: 'ok' };
        },
        closeMerchant: async () => ({ success: true, message: 'ok' }),
        walkTo: async (x: number, y: number) => {
            f.calls.push(`walk ${x},${y}`);
            player.x = x; player.y = y;
            return { success: true, message: 'ok' };
        },
    };
    const player = {
        name: 'Thorgrim', level, realm: o.realm ?? 'midgard', className: o.className ?? 'Warrior', isDead: false, regionId: 101,
        x: o.at?.x ?? 29823, y: o.at?.y ?? 34799, money: { get totalCopper() { return f.copper; } },
    } as unknown as PlayerState;
    const sdk = {
        getEquipment: () => f.equipment,
        getInventory: () => f.inventory,
        getPlayer: () => player,
        getSkills: () => ({ specializations: specs(o.specs ?? WARRIOR) }),
        getMerchant: () => ({ windowType: o.windowTypes?.[opened] ?? 0 }),
    };
    f.member = { sdk, actions } as unknown as WeaponMember;
    return f;
}
const isShield = (i: InventoryItem) => i.objectType === ObjectType.Shield;
const inHand = (f: ReturnType<typeof world>, slot: number) => f.equipment.find(e => e.slot === slot)?.name;
// Saga and Gymir are the real names at these lists, within a walk of the market.
const jordheim = { radius: 1500 };

describe('buyWeapons', () => {
    test('a Warrior buys the axe that tops the level clamp most cheaply, and keeps his shield', async () => {
        const f = world();
        const lines = await buyWeapons(f.member, jordheim);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^bought alloy double-bladed axe from Gymir 86400c, score 6\.52 over 1\.1\d?, wielded in slot 10$/);
        expect(inHand(f, 10)).toBe('alloy double-bladed axe');
        expect(inHand(f, 11)).toBe('small training shield');
        expect(f.copper).toBe(3_000_000 - 86400);
    });

    test('what came off goes to the backpack, for the town visit to sell', async () => {
        const f = world();
        await buyWeapons(f.member, jordheim);
        expect(f.inventory.map(i => i.name)).toEqual(['training axe']);
    });

    test('the purse limits it: a cheaper one when that is all he can pay, keeping a reserve', async () => {
        const f = world({ copper: 50_000 });
        const lines = await buyWeapons(f.member, jordheim);
        expect(lines[0]).toStartWith('bought alloy bearded axe');
        const poor = world({ copper: 100 });
        expect(await buyWeapons(poor.member, jordheim)).toEqual([]);
        expect(poor.calls.filter(c => c.startsWith('buy'))).toEqual([]);
    });

    test('a Skald with no shield line takes the two-hander of his realm, in its slot', async () => {
        const f = world({ specs: SKALD, className: 'Skald' });
        const lines = await buyWeapons(f.member, jordheim);
        expect(lines[0]).toStartWith('bought fine alloy large axe from Saga');
        expect(inHand(f, 12)).toBe('fine alloy large axe');
        expect(f.calls.at(-1)).toBe('equip fine alloy large axe -> 12');
    });

    test('Albion templates on a Midgard shelf are not bought, however good: the server would refuse them', async () => {
        const f = world({ specs: SKALD, className: 'Skald' });
        await buyWeapons(f.member, jordheim);
        expect(f.delves).not.toContain('alloy great axe');
        expect(f.delves).not.toContain('fine alloy great axe');
        expect(f.delves).not.toContain('alloy war axe');
    });

    test('a Healer has no trained line: no walk, no shop', async () => {
        const f = world({ specs: [['Mending', 16], ['Pacification', 8], ['Augmentation', 8]], className: 'Healer' });
        expect(await weaponUpgrades(f.member, jordheim)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test('what the window calls unusable is not bought, however good', async () => {
        const f = world({ shops: { Gymir: GYMIR.map(i => (i.value1 >= 72 && i.objectType === ObjectType.Axe ? { ...i, usable: false } : i)), Saga: [] } });
        const lines = await buyWeapons(f.member, jordheim);
        expect(lines[0]).toStartWith('bought alloy bearded axe');
    });

    test('no step, no purchase: the reason is in the log', async () => {
        const f = world({ equipment: [worn(10, 'Fine Axe', ObjectType.Axe, 7.2, 4.2, 99), SHIELD] });
        expect(await buyWeapons(f.member, jordheim)).toEqual(['no weapon step: best 6.52, worn 7.6']);
        expect(f.calls.filter(c => c.startsWith('buy'))).toEqual([]);
    });

    describe('a worn weapon against its own shop copy', () => {
        const copy = (condition: number, durability: number) => ({ ...worn(10, 'alloy double-bladed axe', ObjectType.Axe, 7.2, 4.2, 85, condition), durability });

        test('a smith can restore it, so its copy is no step: a repair costs a fraction of the price', async () => {
            for (const condition of [90, 80, 70]) {
                const f = world({ equipment: [copy(condition, 60), SHIELD] });
                expect(await buyWeapons(f.member, jordheim)).toEqual(['no weapon step: best 6.52, worn 6.52']);
                expect(f.copper).toBe(3_000_000);
            }
        });

        test("at durability 0 a smith can't, so what's left counts and the copy wins", async () => {
            const f = world({ equipment: [copy(80, 0), SHIELD] });
            const lines = await buyWeapons(f.member, jordheim);
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatch(/^bought alloy double-bladed axe from Gymir 86400c, score 6\.52 over 5\.2\d?, wielded in slot 10$/);
        });

        test('with no condition or durability left it scores nothing, not "keeping it"', async () => {
            const f = world({ equipment: [copy(0, 0), SHIELD] });
            expect((await buyWeapons(f.member, jordheim))[0]).toEndWith('score 6.52 over 0, wielded in slot 10');
        });
    });

    test('a weapon off the line counts as nothing: anything on it replaces that', async () => {
        const f = world({ equipment: [worn(10, 'Serrated Sword', ObjectType.Sword, 6.3, 2.7, 95), SHIELD] });
        expect((await buyWeapons(f.member, jordheim))[0]).toStartWith('bought alloy double-bladed axe');
    });

    test('only what could still win is delved: another line never, a low one not with best bonuses and quality', async () => {
        const f = world({ shops: { Gymir: [...GYMIR, shopItem(0, 2, 'bronze hand axe', ObjectType.Axe, 2, 3, 2.4, 900)], Saga: [] } });
        await buyWeapons(f.member, jordheim);
        expect(f.delves).toContain('alloy double-bladed axe');
        expect(f.delves).not.toContain('bronze hand axe');
        expect(f.delves).not.toContain('alloy bladed moon claw');
    });

    test('a magic weapon near the clamp beats plain by its bonuses, and the delve is what shows it', async () => {
        const shops = { Gymir: [shopItem(0, 19, 'alloy double-bladed axe', ObjectType.Axe, 0, 7.2, 4.2, 86400), shopItem(0, 20, 'Mighty Axe', ObjectType.Axe, 0, 7.2, 4.2, 120000)], Saga: [] };
        const f = world({ shops, bonus: { 'Mighty Axe': ['4.67 | Strength: 7 pts'] } });
        expect((await buyWeapons(f.member, jordheim))[0]).toStartWith('bought Mighty Axe');
    });

    test('a Level Requirement above ours keeps it on the shelf, unless the bot asks for it', async () => {
        const shops = { Gymir: [...GYMIR, shopItem(3, 7, 'Dragonmight', ObjectType.LeftAxe, 2, 16.5, 4.2, 15000)], Saga: [] };
        const required = { Dragonmight: 45 };
        const plain = world({ shops, required });
        expect((await buyWeapons(plain.member, jordheim))[0]).toStartWith('bought alloy double-bladed axe');
        const asked = world({ shops, required });
        expect((await buyWeapons(asked.member, { ...jordheim, overLevel: true }))[0]).toStartWith('bought Dragonmight');
    });

    test('above the level limit stays on the shelf, with no Level Requirement, unless the bot asks for it', async () => {
        const shops = { Gymir: [...GYMIR, shopItem(3, 7, 'Towering Axe', ObjectType.Axe, 0, 8.4, 4.6, 15000, { level: 24 })], Saga: [] };
        expect((await buyWeapons(world({ shops }).member, jordheim))[0]).toStartWith('bought alloy double-bladed axe');
        expect((await buyWeapons(world({ shops }).member, { ...jordheim, overLevel: true }))[0]).toStartWith('bought Towering Axe');
    });

    test("a window that doesn't charge copper is left alone, whatever the static data said, and the next seller gets its turn", async () => {
        const warrior = world({ windowTypes: { Gymir: 1 } });
        expect(await buyWeapons(warrior.member, jordheim)).toEqual(["Gymir: doesn't take copper"]);
        expect(warrior.delves).toEqual(['training axe']);
        const skald = world({ specs: SKALD, className: 'Skald', windowTypes: { Gymir: 1 } });
        const lines = await buyWeapons(skald.member, jordheim);
        expect(lines[0]).toBe("Gymir: doesn't take copper");
        expect(lines[1]).toStartWith('bought fine alloy large axe from Saga');
    });

    test('the server refuses the weapon: bought and said so, not worn', async () => {
        const f = world({ refuse: /double-bladed/ });
        expect((await buyWeapons(f.member, jordheim))[0]).toEndWith('not wielded: You have no skill in using this weapon type!');
        expect(inHand(f, 10)).toBe('training axe');
    });

    test('a caller whose teleport can fail stays out of the walk', async () => {
        const f = world();
        expect(await buyWeapons(f.member, { ...jordheim, town: { x: 0, y: 0 } })).toEqual(['no weapon: not in town']);
        expect(f.calls).toEqual([]);
    });

    test('a worn weapon that will not delve stays: nothing replaces what can\'t be compared', async () => {
        const f = world();
        const actions = (f.member as unknown as { actions: { delveItem: unknown } }).actions;
        actions.delveItem = async () => ({ success: false, reason: 'no_response', message: 'No delve answer', lines: [], bonuses: [] });
        expect(await buyWeapons(f.member, jordheim)).toEqual(['delve training axe: no_response; keeping it']);
    });

    test('a left hand trained: the off hand gets one that fits left, the shield slot is no weapon', async () => {
        const f = world({ specs: [['Axe', 18], ['Left Axe', 14]], className: 'Berserker', equipment: [TRAINING_AXE] });
        const lines = await buyWeapons(f.member, jordheim);
        expect(lines).toHaveLength(2);
        expect(inHand(f, 10)).toBe('alloy double-bladed axe');
        expect(inHand(f, 11)).toBe('alloy bearded axe');
    });
});

describe('wearWeapons', () => {
    const LOOT = { ...worn(45, 'Serrated Axe', ObjectType.Axe, 8.3, 2.7, 95), level: 23 };

    test('a looted axe on the line goes on, clamped by its delve', async () => {
        const f = world({ inventory: [LOOT] });
        const lines = await wearWeapons(f.member);
        expect(lines[0]).toStartWith('wield Serrated Axe, score');
        expect(inHand(f, 10)).toBe('Serrated Axe');
    });

    test('what is off the line stays in the bag, however good: Thorgrim has a level 23 hammer', async () => {
        const f = world({ inventory: [worn(52, 'Bodymender Great Hammer', ObjectType.Hammer, 8.1, 4.9, 97), worn(45, 'Serrated Sword', ObjectType.Sword, 6.3, 2.7, 95)] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test('a Level Requirement above ours stays in the bag, unless the bot asks for it', async () => {
        const required = { 'Serrated Axe': 45 };
        const f = world({ inventory: [LOOT], required });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect((await wearWeapons(world({ inventory: [LOOT], required }).member, { overLevel: true }))[0]).toStartWith('wield Serrated Axe');
    });

    test('above the level limit stays in the bag, with no Level Requirement, unless the bot asks for it', async () => {
        const high = { ...LOOT, level: 24 };
        const f = world({ inventory: [high] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
        expect((await wearWeapons(world({ inventory: [high] }).member, { overLevel: true }))[0]).toStartWith('wield Serrated Axe');
        expect((await wearWeapons(world({ inventory: [high] }).member, { maxCon: 2 }))[0]).toStartWith('wield Serrated Axe');
    });

    test('one above the limit already in hand stays there until something beats it', async () => {
        const held = { ...worn(10, 'Old Relic', ObjectType.Axe, 8.3, 2.7, 95), level: 40 };
        const f = world({ equipment: [held, SHIELD] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(inHand(f, 10)).toBe('Old Relic');
    });

    test('a refusal is reported and the bag keeps it', async () => {
        const f = world({ inventory: [LOOT], refuse: /Serrated/ });
        expect(await wearWeapons(f.member)).toEqual(["can't wield Serrated Axe: You have no skill in using this weapon type!"]);
        expect(inHand(f, 10)).toBe('training axe');
        expect(f.calls).toHaveLength(1);
    });

    test('after a refusal the next best gets its turn', async () => {
        const f = world({ inventory: [LOOT, worn(46, 'Plain Axe', ObjectType.Axe, 5, 3, 90)], refuse: /Serrated/ });
        const lines = await wearWeapons(f.member);
        expect(lines[0]).toStartWith("can't wield Serrated Axe");
        expect(lines[1]).toStartWith('wield Plain Axe');
        expect(inHand(f, 10)).toBe('Plain Axe');
    });

    test('a second pass changes nothing: the swapped-off axe is no step back', async () => {
        const f = world({ inventory: [LOOT] });
        await wearWeapons(f.member);
        expect(await wearWeapons(f.member)).toEqual([]);
    });

    describe('wear, as a smith would leave it', () => {
        const axe = (slot: number, name: string, dps: number, condition: number, durability: number) => ({ ...worn(slot, name, ObjectType.Axe, dps, 3, 90, condition), durability });

        test('a whole spare is no step over the same axe worn: it stays, for the smith', async () => {
            const f = world({ equipment: [axe(10, 'Worn Axe', 5, 75, 60), SHIELD], inventory: [axe(45, 'Spare Axe', 5, 100, 100)] });
            expect(await wearWeapons(f.member)).toEqual([]);
            expect(inHand(f, 10)).toBe('Worn Axe');
        });

        test('a worn spare that is better on points goes on, and a second pass changes nothing', async () => {
            const f = world({ equipment: [axe(10, 'Whole Axe', 5, 100, 100), SHIELD], inventory: [axe(45, 'Worn Axe', 6, 75, 60)] });
            expect((await wearWeapons(f.member))[0]).toStartWith('wield Worn Axe');
            expect(await wearWeapons(f.member)).toEqual([]);
        });

        test("at durability 0 the one worn gives way to the same axe whole, what's left being all it has", async () => {
            const f = world({ equipment: [axe(10, 'Spent Axe', 5, 75, 0), SHIELD], inventory: [axe(45, 'Spare Axe', 5, 100, 100)] });
            expect((await wearWeapons(f.member))[0]).toStartWith('wield Spare Axe');
        });

        test('a spare at durability 0 counts what it has left, and stays in the bag', async () => {
            const f = world({ equipment: [axe(10, 'Whole Axe', 5, 100, 100), SHIELD], inventory: [axe(45, 'Spent Axe', 6, 75, 0)] });
            expect(await wearWeapons(f.member)).toEqual([]);
        });

        test('one at 0 on both is worth nothing: anything replaces it, and it replaces nothing', async () => {
            const held = world({ equipment: [axe(10, 'Dead Axe', 5, 0, 0), SHIELD], inventory: [axe(45, 'Plain Axe', 3, 100, 100)] });
            expect((await wearWeapons(held.member))[0]).toStartWith('wield Plain Axe');
            const bag = world({ inventory: [axe(45, 'Dead Axe', 8, 0, 0)] });
            expect(await wearWeapons(bag.member)).toEqual([]);
        });
    });

    test('nothing to compare and a shield in the bag: no line and no equip', async () => {
        const f = world({ inventory: [{ ...worn(44, 'Matterbender Large Shield', ObjectType.Shield, 1.2, 4), value1: 3 }] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });
});

describe('wearWeapons, both hands', () => {
    // A Blademaster's specs and hands, as Vefoydheb's in the DB on 2026-11-03.
    const BLADEMASTER = [['Blades', 15], ['Blunt', 1], ['Piercing', 1], ['Parry', 6], ['Celtic Dual', 12], ['Shields', 1]] as const;
    const blade = (slot: number, name: string, dps: number, speed: number, hand: number, level = 14) => ({ ...worn(slot, name, ObjectType.Blades, dps, speed, 95), hand, level });
    const RIGHT = blade(10, 'Fortifying Sword', 3.3, 3.4, ItemHand.MainHand, 7), LEFT = blade(11, 'Razored Sword', 3.3, 2.9, ItemHand.FitsLeft, 7);
    const SPIRITBENDER = blade(52, 'Spiritbender Sword', 5.4, 3.5, ItemHand.MainHand);
    const blademaster = (o: Opts) => world({ specs: BLADEMASTER, className: 'Blademaster', realm: 'hibernia', equipment: [RIGHT, LEFT], ...o });

    test('his bag: the better blade goes right, and a stiletto, a training sword and a shield stay', async () => {
        const f = blademaster({ inventory: [{ ...worn(42, 'training sword', ObjectType.Blades, 1.2, 2.5), hand: ItemHand.FitsLeft }, { ...worn(43, 'Bluntbender Stiletto', ObjectType.Piercing, 6.3, 3.1, 95), level: 17 }, { ...worn(45, 'Heatbender Small Shield', ObjectType.Shield, 5.4, 3, 97), hand: ItemHand.FitsLeft }, SPIRITBENDER] });
        const lines = await wearWeapons(f.member);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toStartWith('wield Spiritbender Sword, score');
        expect(inHand(f, 10)).toBe('Spiritbender Sword');
        expect(inHand(f, 11)).toBe('Razored Sword');
        expect(f.inventory.find(i => i.slot === 52)?.name).toBe('Fortifying Sword');
        expect(await wearWeapons(f.member)).toEqual([]);
    });

    test('a worse blade stays in the bag, in either hand', async () => {
        const f = blademaster({ inventory: [blade(42, 'Dull Sword', 2.5, 3, ItemHand.FitsLeft)] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test('one that fits left and loses to the right hand goes left', async () => {
        const f = blademaster({ equipment: [{ ...SPIRITBENDER, slot: 10 }, LEFT], inventory: [blade(42, 'Keen Sword', 4.5, 3, ItemHand.FitsLeft)] });
        const lines = await wearWeapons(f.member);
        expect(f.calls).toEqual(['equip Keen Sword -> 11']);
        expect(lines[0]).toStartWith('wield Keen Sword, score');
        expect(inHand(f, 10)).toBe('Spiritbender Sword');
    });

    test('one that only fits right never goes left, however much it beats that hand', async () => {
        const f = blademaster({ equipment: [{ ...SPIRITBENDER, slot: 10 }, LEFT], inventory: [blade(42, 'Keen Sword', 5, 3, ItemHand.MainHand)] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test('what comes off the right hand can go left, in the same pass', async () => {
        const f = blademaster({ equipment: [{ ...SPIRITBENDER, slot: 10, hand: ItemHand.FitsLeft }, LEFT], inventory: [blade(42, 'Keen Sword', 7, 3.5, ItemHand.MainHand)] });
        expect(await wearWeapons(f.member)).toHaveLength(2);
        expect(f.calls).toEqual(['equip Keen Sword -> 10', 'equip Spiritbender Sword -> 11']);
        expect(inHand(f, 10)).toBe('Keen Sword');
        expect(inHand(f, 11)).toBe('Spiritbender Sword');
        expect(f.inventory.map(i => i.name)).toEqual(['Razored Sword']);
        expect(await wearWeapons(f.member)).toEqual([]);
    });

    test("what comes off the right hand stays off when it can't go left or loses there", async () => {
        const f = blademaster({ inventory: [{ ...SPIRITBENDER, hand: ItemHand.FitsLeft }] });
        expect(await wearWeapons(f.member)).toHaveLength(1);
        expect(f.calls).toEqual(['equip Spiritbender Sword -> 10']);
        const g = blademaster({ equipment: [{ ...RIGHT, value1: 30, hand: ItemHand.FitsLeft }, LEFT], inventory: [SPIRITBENDER] });
        await wearWeapons(g.member);
        expect(g.calls).toEqual(['equip Spiritbender Sword -> 10']);
    });

    test('two from the bag: the better right, the other left', async () => {
        const f = blademaster({ inventory: [blade(42, 'Keen Sword', 5, 3, ItemHand.FitsLeft), { ...SPIRITBENDER, hand: ItemHand.FitsLeft }] });
        await wearWeapons(f.member);
        expect(inHand(f, 10)).toBe('Spiritbender Sword');
        expect(inHand(f, 11)).toBe('Keen Sword');
    });

    test('a shield in the left hand gives way when Celtic Dual is what he trains, and stays when Shields is', async () => {
        const f = blademaster({ equipment: [RIGHT, SHIELD], inventory: [blade(42, 'Keen Sword', 3, 3, ItemHand.FitsLeft)] });
        await wearWeapons(f.member);
        expect(f.calls).toEqual(['equip Keen Sword -> 11']);
        const g = blademaster({ specs: [['Blades', 15], ['Celtic Dual', 5], ['Shields', 20]], equipment: [RIGHT, SHIELD], inventory: [blade(42, 'Keen Sword', 3, 3, ItemHand.FitsLeft)] });
        expect(await wearWeapons(g.member)).toEqual([]);
        expect(inHand(g, 11)).toBe('small training shield');
    });

    test('too high for his level stays in the bag', async () => {
        const f = blademaster({ inventory: [blade(42, 'High Sword', 6.3, 3, ItemHand.FitsLeft, 24)] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test('a refusal in the right hand is not tried again in the left', async () => {
        const f = blademaster({ inventory: [blade(42, 'Odd Sword', 7, 3, ItemHand.FitsLeft)], refuse: /Odd/ });
        expect(await wearWeapons(f.member)).toEqual(["can't wield Odd Sword: You have no skill in using this weapon type!"]);
        expect(f.calls).toHaveLength(1);
    });

    test('a refusal in the left hand gives the next best its turn: 5 Blades templates say they fit left and are not of the type', async () => {
        const f = blademaster({ equipment: [{ ...SPIRITBENDER, slot: 10 }, LEFT], inventory: [blade(42, 'Odd Sword', 5, 3, ItemHand.FitsLeft), blade(43, 'Keen Sword', 4, 3, ItemHand.FitsLeft)], refuse: /Odd/ });
        const lines = await wearWeapons(f.member);
        expect(lines[0]).toStartWith("can't wield Odd Sword");
        expect(lines[1]).toStartWith('wield Keen Sword');
        expect(inHand(f, 11)).toBe('Keen Sword');
    });
});

describe('wearWeapons, a focus caster', () => {
    const SPIRITMASTER = [['Darkness', 17], ['Suppression', 10], ['Summoning', 6]] as const;
    const staff = (slot: number, name: string): InventoryItem => ({ ...worn(slot, name, ObjectType.Staff, 1.2, 4.5), hand: ItemHand.TwoHanded });
    const BRANCH = staff(12, 'trimmed branch');
    const hrafna = (o: Opts) => world({ specs: SPIRITMASTER, className: 'Spiritmaster', equipment: [BRANCH], ...o });

    test('a looted Focus Staff replaces a plain one, in the two-hand slot', async () => {
        const f = hrafna({ inventory: [staff(45, 'Arcane Focus Staff')], focus: { 'Arcane Focus Staff': 20 } });
        expect(await wearWeapons(f.member)).toEqual(['wield Arcane Focus Staff, score 1 over 0']);
        expect(inHand(f, 12)).toBe('Arcane Focus Staff');
        expect(f.inventory.map(i => i.name)).toEqual(['trimmed branch']);
    });

    test('above the level limit stays in the bag, whatever its focus, unless the bot asks for it', async () => {
        const far = { ...staff(45, 'Far Focus Staff'), level: 24 };
        const f = hrafna({ inventory: [far], focus: { 'Far Focus Staff': 20 } });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
        expect((await wearWeapons(hrafna({ inventory: [far], focus: { 'Far Focus Staff': 20 } }).member, { overLevel: true }))[0]).toStartWith('wield Far Focus Staff');
    });

    test('a staff without a focus stays in the bag', async () => {
        const f = hrafna({ inventory: [staff(45, 'Mighty Staff')] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test('the staff that reaches further wins, and past the spec a higher focus buys nothing', async () => {
        const f = hrafna({ inventory: [staff(45, 'Low Focus Staff'), staff(46, 'High Focus Staff'), staff(47, 'Higher Focus Staff')], focus: { 'Low Focus Staff': 8, 'High Focus Staff': 17, 'Higher Focus Staff': 40 } });
        await wearWeapons(f.member);
        expect(inHand(f, 12)).toBe('High Focus Staff');
        expect(await wearWeapons(f.member)).toEqual([]);
    });

    test("one line's focus reaches less than the same on every line", async () => {
        const f = hrafna({ inventory: [staff(45, 'Dark Focus Staff'), staff(46, 'Arcane Focus Staff')], focus: { 'Dark Focus Staff': { line: 'Darkness', value: 17 }, 'Arcane Focus Staff': 17 } });
        await wearWeapons(f.member);
        expect(inHand(f, 12)).toBe('Arcane Focus Staff');
    });

    test('among staffs that reach as far the bonuses decide: live, Hits and Piety over Crush and Energy', async () => {
        const f = hrafna({
            inventory: [staff(45, 'Bluntbender Focus Staff'), staff(46, 'Willful Focus Staff')],
            focus: { 'Bluntbender Focus Staff': 21, 'Willful Focus Staff': 25 },
            parsed: {
                'Bluntbender Focus Staff': [{ category: 'resist', name: 'Crush', value: 3, unit: '%', text: '' }, { category: 'resist', name: 'Energy', value: 2, unit: '%', text: '' }],
                'Willful Focus Staff': [{ category: 'hits', name: 'Hits', value: 17, unit: 'pts', text: '' }, { category: 'stat', stat: 'PIE', name: 'Piety', value: 9, unit: 'pts', text: '' }],
            },
        });
        await wearWeapons(f.member);
        expect(inHand(f, 12)).toBe('Willful Focus Staff');
    });

    test('a worn staff gives way to one with better bonuses, and a second pass changes nothing: live, 1.05 to 1.07', async () => {
        const f = hrafna({
            equipment: [{ ...staff(12, 'Bluntbender Focus Staff') }],
            inventory: [staff(46, 'Willful Focus Staff')],
            focus: { 'Bluntbender Focus Staff': 21, 'Willful Focus Staff': 25 },
            parsed: {
                'Bluntbender Focus Staff': [{ category: 'resist', name: 'Crush', value: 3, unit: '%', text: '' }, { category: 'resist', name: 'Energy', value: 2, unit: '%', text: '' }],
                'Willful Focus Staff': [{ category: 'hits', name: 'Hits', value: 17, unit: 'pts', text: '' }, { category: 'stat', stat: 'PIE', name: 'Piety', value: 9, unit: 'pts', text: '' }],
            },
        });
        expect((await wearWeapons(f.member))[0]).toStartWith('wield Willful Focus Staff');
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(inHand(f, 12)).toBe('Willful Focus Staff');
    });

    test('after a refusal the next best gets its turn', async () => {
        const f = hrafna({ inventory: [staff(45, 'Arcane Focus Staff'), staff(46, 'Low Focus Staff')], focus: { 'Arcane Focus Staff': 20, 'Low Focus Staff': 8 }, refuse: /Arcane/ });
        const lines = await wearWeapons(f.member);
        expect(lines[0]).toStartWith("can't wield Arcane Focus Staff");
        expect(lines[1]).toStartWith('wield Low Focus Staff');
    });

    test('a Level Requirement above ours stays in the bag, unless the bot asks for it', async () => {
        const o = { inventory: [staff(45, 'Arcane Focus Staff')], focus: { 'Arcane Focus Staff': 45 }, required: { 'Arcane Focus Staff': 45 } };
        expect(await wearWeapons(hrafna(o).member)).toEqual([]);
        expect((await wearWeapons(hrafna(o).member, { overLevel: true }))[0]).toStartWith('wield Arcane Focus Staff');
    });

    test('a staff that will not delve is not replaced', async () => {
        const f = hrafna({ inventory: [staff(45, 'Arcane Focus Staff')], focus: { 'Arcane Focus Staff': 20 } });
        const { delveItem } = (f.member as any).actions;
        (f.member as any).actions.delveItem = async (i: InventoryItem) => i.slot === 12 ? { success: false, reason: 'no_response', message: 'no answer', lines: [], bonuses: [] } : delveItem(i);
        expect(await wearWeapons(f.member)).toEqual(['delve trimmed branch: no_response; keeping it']);
        expect(inHand(f, 12)).toBe('trimmed branch');
    });

    test('an Eldritch wears a looted Focus Staff, though each line it trains has a display name of its own', async () => {
        const f = world({ specs: [['Light Magic', 10], ['Mana Magic', 10], ['Void Magic', 20]], className: 'Eldritch', realm: 'hibernia', equipment: [BRANCH], inventory: [staff(45, 'Arcane Focus Staff')], focus: { 'Arcane Focus Staff': 20 } });
        expect(await wearWeapons(f.member)).toEqual(['wield Arcane Focus Staff, score 1 over 0']);
        expect(inHand(f, 12)).toBe('Arcane Focus Staff');
    });

    test('a Mentalist takes a lower focus on all lines over a higher one on Mentalism alone', async () => {
        const f = world({
            specs: [['Light Magic', 10], ['Mana Magic', 10], ['Mentalism', 20]], className: 'Mentalist', realm: 'hibernia', equipment: [BRANCH],
            inventory: [staff(45, 'Mind Focus Staff'), staff(46, 'Arcane Focus Staff')],
            focus: { 'Mind Focus Staff': { line: 'Mentalism', value: 20 }, 'Arcane Focus Staff': 12 },
        });
        expect(await wearWeapons(f.member)).toEqual(['wield Arcane Focus Staff, score 0.8 over 0']);
        expect(inHand(f, 12)).toBe('Arcane Focus Staff');
        expect(await wearWeapons(f.member)).toEqual([]);
    });

    test('a Healer and a Shaman get nothing from a focus and leave the bag alone', async () => {
        for (const [className, specList] of [['Healer', [['Mending', 17], ['Augmentation', 8]]], ['Shaman', [['Mending', 12], ['Augmentation', 17]]]] as const) {
            const f = world({ specs: specList, className, inventory: [staff(45, 'Arcane Focus Staff')], focus: { 'Arcane Focus Staff': 20 } });
            expect(await wearWeapons(f.member)).toEqual([]);
            expect(f.delves).toEqual([]);
        }
    });

    test('buying leaves a focus caster alone', async () => {
        const f = hrafna({ inventory: [staff(45, 'Arcane Focus Staff')], focus: { 'Arcane Focus Staff': 20 } });
        await weaponUpgrades(f.member, jordheim);
        expect(f.calls.filter(c => /^(open|walk|buy)/.test(c))).toEqual([]);
    });
});

describe('focusCover', () => {
    const SPECS = specs([['Darkness', 17], ['Suppression', 10], ['Summoning', 6], ['Axe', 3]]);
    const all = (value: number) => ({ category: 'focus' as const, name: ALL_FOCUS, spec: null, value, unit: 'lvls' as const, text: '' });
    const line = (spec: string, value: number) => ({ category: 'focus' as const, name: `${spec} Focus`, spec, value, unit: 'lvls' as const, text: '' });

    test('nothing without a focus', () => expect(focusCover([], SPECS)).toBe(0));
    test('all of it once the focus reaches the highest spec; weapon lines are no spell lines', () => expect(focusCover([all(17)], SPECS)).toBe(1));
    test('line by line up to each spec', () => expect(focusCover([all(10)], SPECS)).toBeCloseTo((10 + 10 + 6) / 33));
    test("one line's focus covers that line", () => expect(focusCover([line('Darkness', 17)], SPECS)).toBeCloseTo(17 / 33));
    test("a line's focus and all lines don't add up: the higher counts", () => expect(focusCover([all(6), line('Darkness', 10)], SPECS)).toBeCloseTo((10 + 6 + 6) / 33));
    test('no spell lines, no reach', () => expect(focusCover([all(20)], specs([['Axe', 20]]))).toBe(0));

    // As the game words them: the skill list says Light Magic where a bonus's spec is Light (data/spec-names.ts), and a delve says Enchantment Focus for the line the skill list calls Enchantments.
    const focusOn = (...lines: string[]) => parseDelve(['Focus Bonuses:', ...lines.map(l => `- ${l} lvls`), ' ']).bonuses;
    const MENTALIST = specs([['Light Magic', 10], ['Mana Magic', 10], ['Mentalism', 20]]);
    const ENCHANTER = specs([['Light Magic', 10], ['Mana Magic', 10], ['Enchantments', 20]]);
    const ELDRITCH = specs([['Light Magic', 10], ['Mana Magic', 10], ['Void Magic', 20]]);

    test('lines with a display name of their own count: all lines, up to each spec', () => expect(focusCover(focusOn('ALL Spell Lines: 12'), MENTALIST)).toBeCloseTo((10 + 10 + 12) / 40));
    test("such a line takes its own focus, and no other line's", () => expect(focusCover(focusOn('Light Magic Focus: 20'), MENTALIST)).toBeCloseTo(10 / 40));
    test("one line's focus covers that line's share, not all of it: a Mentalist", () => expect(focusCover(focusOn('Mentalism Focus: 20'), MENTALIST)).toBeCloseTo(20 / 40));
    test("one line's focus covers that line's share, not all of it: an Enchanter", () => expect(focusCover(focusOn('Enchantment Focus: 20'), ENCHANTER)).toBeCloseTo(20 / 40));
    test('an Eldritch, with no line under its key, is covered like anyone', () => expect(focusCover(focusOn('ALL Spell Lines: 20'), ELDRITCH)).toBe(1));

    test("every focus caster's every line counts, under the name the skill list gives it", () => {
        const lines = getClasses().filter(isFocusCaster).flatMap(c => c.specializations.filter(s => !s.spec.endsWith('Career')).map(s => [c.name, specDisplayName(s.spec)] as const));
        expect(lines.length).toBeGreaterThan(50);
        expect(lines.filter(([, name]) => focusCover([all(1)], specs([[name, 1]])) !== 1)).toEqual([]);
    });
});
