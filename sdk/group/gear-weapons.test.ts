// Better weapons: the rules from specs, the window and the delve. The fake answers delves as
// GameInventoryItem.cs:1156-1197 does, level clamp included; the shop lines come from Gymir and Saga in
// Jordheim, and the static merchant data is real.
import { describe, expect, test } from 'bun:test';
import { parseWeaponDelve } from '../delve';
import { ObjectType, type InventoryItem, type MerchantItem, type PlayerState } from '../types';
import { bestWeapon, buyWeapons, wearWeapons, weaponNeeds, weaponSellers, weaponSlots, weaponUpgrades, type WeaponMember, type WeaponRow } from './gear';
import { weaponScore, weaponValue } from './gear-score';

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
    equipment?: InventoryItem[];
    inventory?: InventoryItem[];
    copper?: number;
    shops?: Record<string, MerchantItem[]>;
    /** Item name → extra delve lines (bonuses). */
    bonus?: Record<string, string[]>;
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
        'Total utility: 0.00', ' ', 'Damage Modifiers:', `- ${dps.toFixed(1)} Base DPS`, `- ${Math.min(dps, 1.2 + 0.3 * level).toFixed(1)} Clamped DPS`, `- ${speed.toFixed(1)} Weapon Speed`, `- ${quality}% Quality`, `- ${condition}% Condition`, '- Damage Type: Slash',
    ];
    const answer = (lines: string[], name = '') => ({ success: true, message: 'ok', lines, levelRequirement: o.required?.[name] ?? null, bonuses: o.bonus && lines.some(l => /Strength/.test(l)) ? [{ category: 'stat', stat: 'STR', name: 'Strength', value: 7, unit: 'pts', text: '' }] : [], unknown: [], bonusLevel: null, item: null });
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
        name: 'Thorgrim', level, realm: 'midgard', className: o.className ?? 'Warrior', isDead: false, regionId: 101,
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

    test('nothing to compare and a shield in the bag: no line and no equip', async () => {
        const f = world({ inventory: [{ ...worn(44, 'Matterbender Large Shield', ObjectType.Shield, 1.2, 4), value1: 3 }] });
        expect(await wearWeapons(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });
});
