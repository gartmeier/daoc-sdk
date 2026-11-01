// Accessories: names from the loot generator (GeneratedUniqueItem.cs:7014-7091, prefixes :10985-)
// and real item templates; a fake member whose equipItem and buyItem change a snapshot the way the
// server would. The merchant data is real too.
import { describe, expect, test } from 'bun:test';
import type { InventoryItem, PlayerState, Realm } from '../types';
import { accessorySlots, buyCloak, CLOAK_RESERVE, CLOAK_TOWN_RANGE, holdsCloak, nearestCloakSeller, nextAccessory, wearAccessories, type GearMember } from './gear';

const MAGICAL = 41;
const slotsOf = (name: string, objectType = MAGICAL) => accessorySlots({ name, objectType });
const acc = (slot: number, name: string, level: number) => ({ slot, name, level, count: 1, objectType: MAGICAL, value1: 0, value2: 0 }) as InventoryItem;

describe('accessorySlots', () => {
    test.each([
        ['Edgebender Cloak', [26]], ['Heatbender Mantle', [26]], ['Icebender Belt', [32]], ['Bluntbender Girdle', [32]],
        ['Energybender Choker', [29]], ['Matterbender Pendant', [29]], ['Spiritbender Gem', [24]], ['Thrustbender Jewel', [24]],
        ['Battering Bracelet', [33, 34]], ['Sundering Bracer', [33, 34]], ['Empowering Ring', [35, 36]], ['Withering Wrap', [35, 36]],
        // No bonus landed: the base name in lowercase (GeneratedUniqueItem.cs:727).
        ['mantle', [26]], ['girdle', [32]], ['pendant', [29]], ['jewel', [24]], ['bracelet', [33, 34]], ['ring', [35, 36]],
    ])('random loot by its base name: %s', (name, slots) => {
        expect(slotsOf(name)).toEqual(slots);
    });

    test.each([
        ['cloak', [26]], ['hooded cloak', [26]], ["Zahur's Cloak", [26]], ["Zeypher's Commanding Stone", [24]],
        ["Abaddon's Necklace of Anger", [29]], ["Zogg's Belt of Zeal", [32]], ['Acid Scorched Bracer', [33, 34]],
        ['Bracer of Eternal Screams', [33, 34]], ['Bladeblocker Bracelet', [33, 34]], ["Zahur's Ring", [35, 36]], ['Frosted Silver Band', [35, 36]],
    ])('a named item by its template, whatever the name says: %s', (name, slots) => {
        expect(slotsOf(name)).toEqual(slots);
    });

    test.each([
        'Arachite Potion', 'Zombie Potion', 'Battlegrounds Medallion of Passage', 'Albion Medallion of Passage',
        'Alb Basic Saddle', 'White Standard Mount', 'Blanket Barding - Full Trim', 'Left Front Saddlebag',
        // Personal Bind Recall Stone is 41/40; the others are named like loot, but their templates say otherwise.
        'Personal Bind Recall Stone', 'Cunnart Gem', 'Siabra Charm Ring', 'Enchanter Belt', 'Necklace of the Elements',
        // Templates of this name exist with Item_Type 24 and 37: mythical, not a jewel.
        'Average Protection Mythirian',
    ])('never a Magical item that goes elsewhere: %s', name => {
        expect(slotsOf(name)).toEqual([]);
    });

    test('never another object type: food, crafting materials, armour, task items', () => {
        for (const name of ['air elemental essence', 'boar in a blanket', 'buttered biscuit']) expect(slotsOf(name, 0)).toEqual([]);
        expect(slotsOf('Studded Belt', 34)).toEqual([]);
        expect(slotsOf('task item ring', 0)).toEqual([]);
    });

    test('a base name is the last word: no name containing one by accident', () => {
        for (const name of ['Spring Water', 'Ring of Unknown Origin', 'Beltane Token', 'Gemstone', 'Wrapped Parcel']) expect(slotsOf(name)).toEqual([]);
    });
});

describe('nextAccessory', () => {
    test('an empty slot is always filled, at any level', () => {
        expect(nextAccessory([acc(40, 'cloak', 0)], [])).toMatchObject({ slot: 26, replaces: null });
    });

    test('a worn accessory goes only for a strictly higher level', () => {
        const worn = [acc(26, 'Edgebender Cloak', 12)];
        expect(nextAccessory([acc(40, 'Heatbender Mantle', 12)], worn)).toBeNull();
        expect(nextAccessory([acc(40, 'Heatbender Mantle', 11)], worn)).toBeNull();
        expect(nextAccessory([acc(40, 'Heatbender Mantle', 13)], worn)).toMatchObject({ slot: 26, replaces: { name: 'Edgebender Cloak' } });
    });

    test('a plain merchant cloak (level 0) is replaced by any looted cloak, and never replaces one', () => {
        expect(nextAccessory([acc(40, 'Heatbender Mantle', 1)], [acc(26, 'cloak', 0)])).toMatchObject({ slot: 26 });
        expect(nextAccessory([acc(40, 'cloak', 0)], [acc(26, 'Heatbender Mantle', 1)])).toBeNull();
    });

    test('rings and bracers fill left, then right, then replace the lower one', () => {
        const ring = acc(40, 'Empowering Ring', 15);
        expect(nextAccessory([ring], [])).toMatchObject({ slot: 35 });
        expect(nextAccessory([ring], [acc(35, 'Withering Wrap', 20)])).toMatchObject({ slot: 36 });
        expect(nextAccessory([ring], [acc(36, 'Withering Wrap', 20)])).toMatchObject({ slot: 35 });
        // The left is the weaker: the paper doll would have taken the right.
        expect(nextAccessory([ring], [acc(35, 'a', 10), acc(36, 'b', 20)])).toMatchObject({ slot: 35, replaces: { name: 'a' } });
        expect(nextAccessory([ring], [acc(35, 'a', 20), acc(36, 'b', 10)])).toMatchObject({ slot: 36, replaces: { name: 'b' } });
        expect(nextAccessory([ring], [acc(35, 'a', 20), acc(36, 'b', 15)])).toBeNull();
        expect(nextAccessory([acc(40, 'Sundering Bracer', 9)], [acc(33, 'a', 8), acc(34, 'b', 3)])).toMatchObject({ slot: 34 });
    });

    test('the highest level goes first, so the weaker one finds no slot left', () => {
        const backpack = [acc(40, 'Edgebender Cloak', 5), acc(41, 'Heatbender Mantle', 9)];
        expect(nextAccessory(backpack, [])).toMatchObject({ item: { name: 'Heatbender Mantle' }, slot: 26 });
    });

    test('everything else in the backpack is no move', () => {
        expect(nextAccessory([acc(40, 'Arachite Potion', 30), { ...acc(41, 'Studded Boots', 30), objectType: 34 }], [])).toBeNull();
    });
});

// ── Fake member ─────────────────────────────────────────────────────────────

const CAMELOT_LANDING = { regionId: 10, x: 36039, y: 30870 };
const TIR_NA_MBEO = { regionId: 200, x: 345698, y: 528897 };
const FORT_ATLA = { regionId: 100, x: 749218, y: 817547 };
const CONNLA = { regionId: 200, x: 295765, y: 642599 };

type Result = { success: boolean; message: string; reason?: string; spent?: number };
interface Fake {
    inventory: InventoryItem[];
    equipment: InventoryItem[];
    player: PlayerState;
    calls: string[];
    member: GearMember;
}

interface FakeOptions {
    inventory?: InventoryItem[];
    equipment?: InventoryItem[];
    where?: { regionId: number; x: number; y: number };
    realm?: Realm;
    copper?: number;
    /** Names the server won't let on. */
    refuse?: RegExp;
    buy?: Result;
    walk?: Result;
    /** Whose member shape: a party's `bot` or a group's `actions`. */
    shape?: 'bot' | 'actions';
}

function fake(o: FakeOptions = {}): Fake {
    const where = o.where ?? CAMELOT_LANDING;
    const f: Fake = {
        inventory: o.inventory ?? [],
        equipment: o.equipment ?? [],
        player: { name: 'Galahad', level: 20, realm: o.realm ?? 'albion', className: 'Sorcerer', isDead: false, money: { totalCopper: o.copper ?? 10_000 }, ...where } as unknown as PlayerState,
        calls: [],
        member: null!,
    };
    const actions = {
        // As GamePlayerInventory.MoveItem: the target slot's item swaps into the backpack slot.
        equipItem: async (item: InventoryItem, opts: { slot?: number } = {}): Promise<Result> => {
            f.calls.push(`equip ${item.name} -> ${opts.slot}`);
            if (o.refuse?.test(item.name)) return { success: false, message: 'You cannot equip an item from another realm!', reason: 'refused' };
            const old = f.equipment.find(e => e.slot === opts.slot);
            f.equipment = [...f.equipment.filter(e => e !== old), { ...item, slot: opts.slot! }];
            f.inventory = [...f.inventory.filter(i => i.slot !== item.slot), ...(old ? [{ ...old, slot: item.slot }] : [])];
            return { success: true, message: 'ok' };
        },
        buyItem: async (merchant: string, what: { page: number; slot: number }): Promise<Result> => {
            f.calls.push(`buy ${merchant} ${what.page}/${what.slot}`);
            return o.buy ?? { success: true, message: 'ok', spent: 100 };
        },
        closeMerchant: async () => { f.calls.push('close'); return { success: true, message: 'ok' }; },
        walkTo: async (x: number, y: number): Promise<Result> => { f.calls.push(`walk ${x},${y}`); return o.walk ?? { success: true, message: 'ok' }; },
    };
    const sdk = { getEquipment: () => f.equipment, getInventory: () => f.inventory, getPlayer: () => f.player };
    f.member = (o.shape === 'bot' ? { sdk, bot: actions } : { sdk, actions }) as unknown as GearMember;
    return f;
}

describe('wearAccessories', () => {
    test('fills every slot from the backpack and logs what it wore', async () => {
        const f = fake({ inventory: [acc(40, 'Edgebender Cloak', 12), acc(41, 'Icebender Belt', 10), acc(42, 'Arachite Potion', 30)] });
        expect(await wearAccessories(f.member)).toEqual(['wear Edgebender Cloak (was nothing)', 'wear Icebender Belt (was nothing)']);
        expect(f.equipment.map(e => [e.slot, e.name])).toEqual([[26, 'Edgebender Cloak'], [32, 'Icebender Belt']]);
        expect(f.inventory.map(i => i.name)).toEqual(['Arachite Potion']);
    });

    test('a third ring replaces the weaker left ring, and the old one stays out', async () => {
        const f = fake({ inventory: [acc(40, 'Empowering Ring', 15)], equipment: [acc(35, 'Withering Wrap', 10), acc(36, 'Battering Ring', 20)] });
        expect(await wearAccessories(f.member)).toEqual(['wear Empowering Ring (was Withering Wrap)']);
        expect(f.calls).toEqual(['equip Empowering Ring -> 35']);
        expect(f.inventory).toMatchObject([{ slot: 40, name: 'Withering Wrap', level: 10 }]);
    });

    test('three rings at once end with the best two worn, one spare for the merchant', async () => {
        const f = fake({ inventory: [acc(40, 'Empowering Ring', 5), acc(41, 'Withering Wrap', 15), acc(42, 'Battering Ring', 10)] });
        await wearAccessories(f.member);
        expect(f.equipment.map(e => [e.slot, e.level])).toEqual([[35, 15], [36, 10]]);
        expect(f.inventory.map(i => i.level)).toEqual([5]);
    });

    test('a refused item is reported, not tried again, and the next one still goes on', async () => {
        const f = fake({ inventory: [acc(40, 'Edgebender Cloak', 12), acc(41, 'Heatbender Mantle', 8)], refuse: /Edgebender/ });
        expect(await wearAccessories(f.member)).toEqual([
            "can't wear Edgebender Cloak: You cannot equip an item from another realm!",
            'wear Heatbender Mantle (was nothing)',
        ]);
        expect(f.calls.filter(c => c.includes('Edgebender'))).toHaveLength(1);
    });

    test('nothing to do is no line and no call', async () => {
        const f = fake({ inventory: [acc(40, 'Heatbender Mantle', 8)], equipment: [acc(26, 'Edgebender Cloak', 12)] });
        expect(await wearAccessories(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test("a party member's `bot` works like a group member's `actions`", async () => {
        const f = fake({ inventory: [acc(40, 'cloak', 0)], shape: 'bot' });
        expect(await wearAccessories(f.member)).toEqual(['wear cloak (was nothing)']);
    });
});

describe('nearestCloakSeller', () => {
    test('picks the nearest seller, and its plain cloak before the hooded one', () => {
        // Radek Silven lists hooded_cloak on 0/15 and cloak on 0/16.
        const s = nearestCloakSeller({ ...CAMELOT_LANDING, realm: 'albion' })!;
        expect(s.spawn.name).toBe('Radek Silven');
        expect(s.cloaks.map(e => [e.itemTemplateId, e.page, e.slot, e.price])).toEqual([['cloak', 0, 16, 100], ['hooded_cloak', 0, 15, 50]]);
    });

    test('cloak2 counts as a plain cloak, on any page', () => {
        const s = nearestCloakSeller({ ...TIR_NA_MBEO, realm: 'hibernia' })!;
        expect(s.spawn.name).toBe('Elith');
        expect(s.cloaks[0]).toMatchObject({ itemTemplateId: 'cloak2', page: 1, slot: 0 });
    });

    test('Fort Atla has one for midgard', () => {
        expect(nearestCloakSeller({ ...FORT_ATLA, realm: 'midgard' })?.spawn.name).toBe('Ullaria');
    });

    test('none within the radius', () => {
        expect(nearestCloakSeller({ ...CONNLA, realm: 'hibernia' })).toBeNull();
    });

    test('another realm\'s merchant is no seller', () => {
        expect(nearestCloakSeller({ ...CAMELOT_LANDING, realm: 'midgard' })).toBeNull();
    });
});

describe('buyCloak', () => {
    test('walks to the seller, buys by page and slot, closes the window', async () => {
        const f = fake();
        expect(await buyCloak(f.member)).toEqual(['bought cloak from Radek Silven 100c']);
        const s = nearestCloakSeller(f.player)!.spawn;
        expect(f.calls).toEqual([`walk ${s.x},${s.y}`, 'buy Radek Silven 0/16', 'close']);
    });

    test('standing next to the seller needs no walk', async () => {
        const s = nearestCloakSeller({ ...CAMELOT_LANDING, realm: 'albion' })!.spawn;
        const f = fake({ where: { regionId: 10, x: s.x + 100, y: s.y } });
        await buyCloak(f.member);
        expect(f.calls).toEqual(['buy Radek Silven 0/16', 'close']);
    });

    test('a cloak worn, or waiting in the backpack, is enough', async () => {
        for (const o of [{ equipment: [acc(26, 'Edgebender Cloak', 12)] }, { inventory: [acc(47, 'Heatbender Mantle', 3)] }]) {
            const f = fake(o);
            expect(await buyCloak(f.member)).toEqual([]);
            expect(f.calls).toEqual([]);
        }
    });

    test('holdsCloak: worn or in the backpack, not any accessory', () => {
        expect(holdsCloak(fake({ equipment: [acc(26, 'Edgebender Cloak', 12)] }).member)).toBe(true);
        expect(holdsCloak(fake({ inventory: [acc(47, 'Heatbender Mantle', 3)] }).member)).toBe(true);
        expect(holdsCloak(fake({ inventory: [acc(47, 'Icebender Belt', 3)] }).member)).toBe(false);
    });

    test('a wider radius finds what the default does not: Hyndla, 8,931 from the Jordheim landing', async () => {
        const f = fake({ where: { regionId: 101, x: 31746, y: 27429 }, realm: 'midgard' });
        expect(await buyCloak(f.member)).toEqual([]);
        expect(await buyCloak(f.member, { radius: 12_000 })).toEqual(['bought cloak from Hyndla Gunderson 100c']);
    });

    test('no seller nearby is a quiet no-op', async () => {
        const f = fake({ where: CONNLA, realm: 'hibernia' });
        expect(await buyCloak(f.member)).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    test('the reserve stays: the hooded one when only that fits, nothing when neither does', async () => {
        const hooded = fake({ copper: CLOAK_RESERVE + 99 });
        await buyCloak(hooded.member);
        expect(hooded.calls).toContain('buy Radek Silven 0/15');

        const broke = fake({ copper: CLOAK_RESERVE + 49 });
        expect(await buyCloak(broke.member)).toEqual([`no cloak: ${CLOAK_RESERVE + 49}c, keeping ${CLOAK_RESERVE}c`]);
        expect(broke.calls).toEqual([]);
    });

    test('game failures come back as a line, never a throw', async () => {
        const stuck = fake({ walk: { success: false, reason: 'stuck', message: 'no progress' } });
        expect(await buyCloak(stuck.member)).toEqual(['walk to Radek Silven: stuck no progress']);

        const full = fake({ buy: { success: false, reason: 'inventory_full', message: 'Backpack is full' } });
        expect(await buyCloak(full.member)).toEqual(['buy cloak: inventory_full Backpack is full']);
        expect(full.calls).toContain('close');
    });

    describe('with a town, only in it', () => {
        const hibernian = (where: { regionId: number; x: number; y: number }, o: FakeOptions = {}) => fake({ where, realm: 'hibernia', ...o });
        // A failed teleport's walk ended south of Tir na mBeo: Tangi is 5,689 away, past lunantishee.
        const STRANDED = { regionId: 200, x: 344500, y: 522800 };
        // The far camp: Dranna is 2,212 away, so a smaller radius wouldn't stop this one.
        const FAR_CAMP = { regionId: 200, x: 420500, y: 517000 };

        test('stranded outside it: no walk, no purchase, and a line saying why', async () => {
            for (const where of [STRANDED, FAR_CAMP]) {
                const f = hibernian(where);
                expect(await buyCloak(f.member, { town: TIR_NA_MBEO })).toEqual(['no cloak: not in town']);
                expect(f.calls).toEqual([]);
            }
        });

        test('the same spot without a town still walks: the seller is there', async () => {
            const f = hibernian(STRANDED);
            await buyCloak(f.member);
            expect(f.calls[0]).toStartWith('walk ');
            expect(f.calls).toContain('close');
        });

        test('at the landing point, and up to the range, it buys', async () => {
            for (const y of [TIR_NA_MBEO.y, TIR_NA_MBEO.y - CLOAK_TOWN_RANGE]) {
                const f = hibernian({ ...TIR_NA_MBEO, y });
                expect((await buyCloak(f.member, { town: TIR_NA_MBEO }))[0]).toStartWith('bought ');
            }
        });

        test('one unit past the range it does not', async () => {
            const f = hibernian({ ...TIR_NA_MBEO, y: TIR_NA_MBEO.y - CLOAK_TOWN_RANGE - 1 });
            expect(await buyCloak(f.member, { town: TIR_NA_MBEO })).toEqual(['no cloak: not in town']);
        });

        test('nothing to say when it wants no cloak or no seller is near', async () => {
            const worn = hibernian(STRANDED, { equipment: [acc(26, 'Edgebender Cloak', 12)] });
            expect(await buyCloak(worn.member, { town: TIR_NA_MBEO })).toEqual([]);
            const none = hibernian(CONNLA);
            expect(await buyCloak(none.member, { town: TIR_NA_MBEO })).toEqual([]);
        });
    });

    test('the dead buy nothing', async () => {
        const f = fake();
        f.player = { ...f.player, isDead: true };
        expect(await buyCloak(f.member)).toEqual([]);
    });

    test('bought, then worn: the cloak is out of the backpack before anything sells', async () => {
        const f = fake();
        const actions = (f.member as { actions: { buyItem: unknown } }).actions;
        actions.buyItem = async () => {
            f.inventory = [...f.inventory, acc(40, 'cloak', 0)];
            return { success: true, message: 'ok', spent: 100 };
        };
        await buyCloak(f.member);
        expect(await wearAccessories(f.member)).toEqual(['wear cloak (was nothing)']);
        expect(f.inventory).toEqual([]);
        expect(await buyCloak(f.member)).toEqual([]);
    });
});
