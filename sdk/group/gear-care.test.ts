// Gear care: the level rule against the server's table, and the town passes on a fake member whose
// smith and vault keeper change a snapshot the way the server would. The spawns are real.
import { describe, expect, test } from 'bun:test';
import { findNpcSpawns, getAbilities } from '../../data/index';
import { ObjectType, type InventoryItem, type PlayerState } from '../types';
import { armorValue, GEAR_MAX_CON, GEAR_MIN_GAP, REPAIR_BELOW, tooHighLevel, wearPerEvent, wornDown } from './gear-score';
import { upgradeGains, GearDelves, type GearMember } from './gear';
import { careDue, classCouldUse, keepForLater, nearestSmith, nearestVaultKeeper, needsRepair, repairGear, stashInVault, takeFromVault, vaultDue, type CareMember } from './gear-care';

const item = (slot: number, name: string, over: Partial<InventoryItem> = {}): InventoryItem => ({
    slot, name, level: 20, count: 1, model: 1, objectType: 35, condition: 100, durability: 100, quality: 90, weight: 10, value1: 40, value2: 27, ...over,
});

describe('how fast gear wears', () => {
    test.each([
        // Character level, item level, points per event: ConLevelGrid.cs, rows 10, 20, 22 and 50.
        [20, 13, 1], [20, 15, 2], [20, 18, 3], [20, 20, 4], [20, 22, 5], [20, 25, 6], [20, 26, 7],
        [22, 22, 4], [22, 25, 5], [22, 26, 6], [22, 29, 7], [22, 51, 7],
        [10, 10, 4], [10, 11, 5], [10, 13, 6], [10, 14, 7],
        [50, 50, 4], [50, 51, 5], [50, 56, 6],
    ])('at level %i, a level %i item loses %i', (level, itemLevel, points) => {
        expect(wearPerEvent(level, itemLevel)).toBe(points);
    });

    test('far above the character it stops getting worse: 7 against 4 at its own level', () => {
        expect(wearPerEvent(20, 26)).toBe(wearPerEvent(20, 51));
        expect(wearPerEvent(20, 51) / wearPerEvent(20, 20)).toBe(1.75);
    });
});

describe('tooHighLevel', () => {
    test.each([
        // Red's first level, once that's four above: at low levels a level or two is already red.
        [5, 8, 9], [10, 13, 14], [15, 18, 19], [20, 23, 24], [22, 25, 26], [30, 33, 34], [35, 39, 40], [40, 45, 46], [50, 55, 56],
    ])('at level %i, %i still fits and %i does not', (level, fits, high) => {
        expect(tooHighLevel({ level: fits }, level)).toBeFalse();
        expect(tooHighLevel({ level: high }, level)).toBeTrue();
    });

    test('a level or two up never counts, however red: the character is there within the hour', () => {
        expect(GEAR_MIN_GAP).toBe(4);
        expect(tooHighLevel({ level: 9 }, 7)).toBeFalse();
        expect(tooHighLevel({ level: 3 }, 1)).toBeFalse();
    });

    test('the limit can be moved', () => {
        expect(GEAR_MAX_CON).toBe(1);
        expect(tooHighLevel({ level: 51 }, 22, 3)).toBeFalse();
        expect(tooHighLevel({ level: 26 }, 22, 0)).toBeTrue();
        expect(tooHighLevel({ level: 25 }, 22, 0)).toBeFalse();
    });
});

describe('wornDown', () => {
    test('below the line with durability left', () => {
        expect(REPAIR_BELOW).toBeGreaterThan(91);
        expect(wornDown({ condition: 92, durability: 100 })).toBeTrue();
        expect(wornDown({ condition: REPAIR_BELOW, durability: 100 })).toBeFalse();
        expect(wornDown({ condition: 100, durability: 100 })).toBeFalse();
    });

    test('never what a smith can\'t help, or a trigger would come back for ever', () => {
        expect(wornDown({ condition: 70, durability: 0 })).toBeFalse();
        expect(wornDown({ condition: 0, durability: 0 })).toBeFalse();
    });
});

describe('armorValue', () => {
    const chest = { objectType: 35, value1: 40, value2: 27, quality: 90 };

    test('a piece a smith can restore is worth what it will be: no swap or shop copy over a few silver', () => {
        const whole = armorValue(chest, 20);
        expect(armorValue({ ...chest, condition: 100, durability: 100 }, 20)).toBe(whole);
        expect(armorValue({ ...chest, condition: 70, durability: 40 }, 20)).toBe(whole);
    });

    test("one that can't be restored counts what's left, as the server does", () => {
        expect(armorValue({ ...chest, condition: 70, durability: 0 }, 20)).toBeCloseTo((40 * 0.9 * 0.7 + 10) * 1.27);
        // MaxCondition 0 templates read 0 on both.
        expect(armorValue({ ...chest, condition: 0, durability: 0 }, 20)).toBeCloseTo(10 * 1.27);
    });
});

describe('upgradeGains', () => {
    const member = (level: number, equipped: InventoryItem[]): GearMember => ({
        sdk: { getEquipment: () => equipped, getInventory: () => [], getPlayer: () => ({ level, className: 'Armsman', realm: 'albion' }) as PlayerState },
        bot: { equipItem: async () => ({ success: true }), buyItem: async () => ({ success: true }), closeMerchant: async () => ({ success: true }), walkTo: async () => ({ success: true }) } as any,
    });
    const score = (i: InventoryItem) => i.value1;

    test('gear too high for the level is no candidate, however good', async () => {
        const worn = item(25, 'alloy hauberk', { level: 20 });
        const rows = [
            { item: item(40, 'Vue\'s Hauberk', { level: 51, value1: 102 }), cur: worn },
            { item: item(41, 'Adroit Hauberk', { level: 22, value1: 44 }), cur: worn },
        ];
        const gains = await upgradeGains(new GearDelves(member(20, [worn])), rows, 20, score);
        expect(gains.map(g => g.item.name)).toEqual(['Adroit Hauberk']);
    });

    test('a bot that wants it anyway moves the limit', async () => {
        const worn = item(25, 'alloy hauberk', { level: 20 });
        const rows = [{ item: item(40, 'Vue\'s Hauberk', { level: 51, value1: 102 }), cur: worn }];
        expect(await upgradeGains(new GearDelves(member(20, [worn])), rows, 20, score, { maxCon: 3 })).toHaveLength(1);
    });
});

describe('classCouldUse', () => {
    const warrior = { className: 'Warrior', realm: 'midgard' } as const;
    const spiritmaster = { className: 'Spiritmaster', realm: 'midgard' } as const;

    test('armour by the highest the class ever gets', () => {
        expect(classCouldUse({ objectType: ObjectType.Chain }, warrior)).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Plate }, warrior)).toBeFalse();
        expect(classCouldUse({ objectType: ObjectType.Cloth }, spiritmaster)).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Leather }, spiritmaster)).toBeFalse();
        expect(classCouldUse({ objectType: ObjectType.Chain }, spiritmaster)).toBeFalse();
        expect(classCouldUse({ objectType: ObjectType.Plate }, { className: 'Armsman', realm: 'albion' })).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Reinforced }, { className: 'Bard', realm: 'hibernia' })).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Scale }, { className: 'Bard', realm: 'hibernia' })).toBeFalse();
    });

    test('weapons, shields and instruments by the ability', () => {
        expect(classCouldUse({ objectType: ObjectType.Axe }, warrior)).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Shield }, warrior)).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Axe }, spiritmaster)).toBeFalse();
        expect(classCouldUse({ objectType: ObjectType.Shield }, spiritmaster)).toBeFalse();
        expect(classCouldUse({ objectType: ObjectType.Staff }, spiritmaster)).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Instrument }, { className: 'Bard', realm: 'hibernia' })).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Instrument }, { className: 'Hero', realm: 'hibernia' })).toBeFalse();
    });

    test('a base class counts what it may become: a Fighter at level 4 could be an Armsman', () => {
        expect(classCouldUse({ objectType: ObjectType.Plate }, { className: 'Fighter', realm: 'albion' })).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Chain }, { className: 'Mystic', realm: 'midgard' })).toBeFalse();
    });

    test('jewellery goes on anyone, and no class data is a yes', () => {
        expect(classCouldUse({ objectType: ObjectType.Magical }, spiritmaster)).toBeTrue();
        expect(classCouldUse({ objectType: ObjectType.Plate }, { className: 'Nobody', realm: 'midgard' })).toBeTrue();
    });

    test('every ability named exists in the data: a typo would read as "never"', () => {
        const known = new Set(getAbilities().map(a => a.keyName));
        for (const objectType of Object.values(ObjectType)) {
            for (const className of ['Warrior', 'Skald', 'Savage', 'Thane', 'Hunter', 'Berserker']) classCouldUse({ objectType }, { className, realm: 'midgard' });
        }
        for (const name of ['Weaponry: Crushing', 'Weaponry: Slashing', 'Weaponry: Thrusting', 'Weaponry: Shortbows', 'Weaponry: Two Handed', 'Weaponry: Polearms', 'Weaponry: Staves', 'Weaponry: Longbows', 'Weaponry: Archery', 'Weaponry: Crossbow', 'Weaponry: Flexible', 'Weaponry: Swords', 'Weaponry: Hammers', 'Weaponry: Axes', 'Weaponry: Spears', 'Weaponry: Composite Bows', 'Weaponry: Thrown', 'Weaponry: Hand to Hand', 'Weaponry: Recurved Bows', 'Weaponry: Blades', 'Weaponry: Blunt', 'Weaponry: Piercing', 'Weaponry: Large Weapons', 'Weaponry: Celtic Spears', 'Weaponry: Scythe', 'Weaponry: Fist Wraps', 'Weaponry: Mauler Staff', 'Shield', 'Weaponry: Instruments', 'MidArmor', 'AlbArmor', 'HibArmor']) expect(known.has(name)).toBeTrue();
    });
});

describe('keepForLater', () => {
    const warrior = { level: 22, className: 'Warrior', realm: 'midgard' } as const;

    test.each([
        ['a weapon', { name: 'Dragonmight', objectType: ObjectType.LeftAxe, level: 51 }],
        ['armour', { name: 'Vue\'s Hauberk', objectType: ObjectType.Chain, level: 51 }],
        ['a shield', { name: 'tower shield', objectType: ObjectType.Shield, level: 51 }],
        ['jewellery', { name: 'Empowering Ring', objectType: ObjectType.Magical, level: 51 }],
    ])('keeps %s that\'s too high', (_what, i) => {
        expect(keepForLater(i, warrior)).toBeTrue();
    });

    test('an instrument too, for a class that plays', () => {
        const lute = { name: 'Lute of Ages', objectType: ObjectType.Instrument, level: 51 };
        expect(keepForLater(lute, { level: 22, className: 'Bard', realm: 'hibernia' })).toBeTrue();
        expect(keepForLater(lute, warrior)).toBeFalse();
    });

    test('what this class can never use sells: chain on a Spiritmaster is only weight', () => {
        const spiritmaster = { level: 22, className: 'Spiritmaster', realm: 'midgard' } as const;
        expect(keepForLater({ name: 'Adroit Chain Hauberk', objectType: ObjectType.Chain, level: 30 }, spiritmaster)).toBeFalse();
        expect(keepForLater({ name: 'Focus Staff', objectType: ObjectType.Staff, level: 30 }, spiritmaster)).toBeTrue();
    });

    test('what fits is for the usual rules, and only gear counts: loot and potions sell', () => {
        expect(keepForLater({ name: 'Dragonmight', objectType: ObjectType.LeftAxe, level: 25 }, warrior)).toBeFalse();
        expect(keepForLater({ name: 'wolf pelt', objectType: 0, level: 51 }, warrior)).toBeFalse();
        expect(keepForLater({ name: 'Arachite Potion', objectType: ObjectType.Magical, level: 51 }, warrior)).toBeFalse();
        expect(keepForLater({ name: 'arrows', objectType: ObjectType.Arrow, level: 51 }, warrior)).toBeFalse();
    });

    test('the limit is the caller\'s to move', () => {
        expect(keepForLater({ name: 'Dragonmight', objectType: ObjectType.LeftAxe, level: 51 }, warrior, { maxCon: 3 })).toBeFalse();
    });
});

describe('who to walk to', () => {
    const inJordheim = { regionId: 101, x: 32000, y: 30000, realm: 'midgard' } as const;

    test('a smith by its class, not a craft master with smith in the guild', () => {
        expect(nearestSmith(inJordheim, 12_000)?.guild).toBe('Smith');
        for (const s of findNpcSpawns({ classType: /^Blacksmith$/ })) expect(s.guild).toBe('Smith');
    });

    test('a keeper of the personal vault, not of the account vault', () => {
        expect(nearestVaultKeeper(inJordheim, 12_000)).toMatchObject({ name: 'Jarl Yuliwyf', guild: 'Vault Keeper' });
    });

    test('nobody in range is nobody: Thidranki has neither', () => {
        const thidranki = { regionId: 252, x: 30000, y: 30000, realm: 'midgard' } as const;
        expect(nearestSmith(thidranki, 100_000)).toBeNull();
        expect(nearestVaultKeeper(thidranki, 100_000)).toBeNull();
    });

    test('another realm\'s doesn\'t count', () => {
        const here = findNpcSpawns({ regionId: 165, classType: /^Blacksmith$/ }).find(s => s.realm === 1)!;
        expect(nearestSmith({ regionId: 165, x: here.x, y: here.y, realm: 'midgard' }, 500)?.realm ?? 2).not.toBe(1);
    });
});

// In Jordheim, between its smith and its keeper. The smith and the keeper answer as the server does.
function town(over: { level?: number; copper?: number; worn?: InventoryItem[]; pack?: InventoryItem[]; vault?: InventoryItem[]; seen?: boolean; regionId?: number } = {}) {
    let player: PlayerState = { name: 'Thorgrim', level: over.level ?? 22, className: 'Warrior', realm: 'midgard', isDead: false, regionId: over.regionId ?? 101, x: 32000, y: 30000, z: 8000, money: { totalCopper: over.copper ?? 100_000 } } as PlayerState;
    let worn = over.worn ?? [];
    let pack = over.pack ?? [];
    let vault = over.vault ?? [];
    let seen = over.seen ?? false;
    const log: string[] = [];
    const price = (i: InventoryItem) => (100 - i.condition) * 100;
    const m: CareMember = {
        sdk: {
            getEquipment: () => worn, getInventory: () => pack, getVault: () => vault, getPlayer: () => player,
            getFreeInventorySlots: () => 40 - pack.length, getState: () => ({ vaultOpenedAt: seen ? 1 : null }) as any,
        } as any,
        bot: {
            walkTo: async (x: number, y: number) => { log.push(`walk ${x},${y}`); player = { ...player, x, y }; return { success: true }; },
            repairItem: async (smith: string, i: InventoryItem, o: { maxCost?: number }) => {
                log.push(`repair ${i.name} at ${smith} max ${o.maxCost}`);
                if (price(i) > (o.maxCost ?? Infinity)) return { success: false, reason: 'too_expensive', message: 'too much', cost: 0 };
                const repaired = { ...i, condition: 100, durability: 90 };
                worn = worn.map(w => (w.slot === i.slot ? repaired : w));
                player = { ...player, money: { totalCopper: player.money.totalCopper - price(i) } as any };
                return { success: true, cost: price(i), repaired };
            },
            repairAll: async (smith: string) => { log.push(`repair all at ${smith}`); worn = worn.map(w => ({ ...w, condition: 100 })); return { success: true, cost: 7 }; },
            openVault: async (k: string) => { log.push(`open ${k}`); seen = true; return { success: true, items: vault }; },
            depositItem: async (k: string, i: InventoryItem) => {
                log.push(`deposit ${i.name}`);
                if (vault.length >= 40) return { success: false, reason: 'vault_full', message: 'full' };
                pack = pack.filter(p => p.slot !== i.slot);
                vault = [...vault, { ...i, slot: 110 + vault.length }];
                return { success: true };
            },
            withdrawItem: async (k: string, i: InventoryItem) => {
                log.push(`withdraw ${i.name}`);
                vault = vault.filter(v => v.slot !== i.slot);
                pack = [...pack, { ...i, slot: 40 + pack.length }];
                return { success: true };
            },
        } as any,
    };
    return { m, log, get pack() { return pack; }, get vault() { return vault; }, get worn() { return worn; } };
}

describe('needsRepair', () => {
    test('the worst first, and only what a smith can still help', () => {
        const t = town({ worn: [item(21, 'helm', { condition: 91 }), item(10, 'axe', { condition: 75 }), item(25, 'hauberk'), item(28, 'sleeves', { condition: 70, durability: 0 })] });
        expect(needsRepair(t.m).map(i => i.name)).toEqual(['axe', 'helm']);
        expect(needsRepair(t.m, { repairBelow: 80 }).map(i => i.name)).toEqual(['axe']);
    });
});

describe('careDue and vaultDue', () => {
    const relic = item(40, 'Dragonmight', { level: 51, objectType: 17 });
    const worn = item(10, 'axe', { condition: 80 });

    test('nothing to do is no trip, and a sound worn piece too high stays out of it', () => {
        const t = town({ worn: [item(21, 'helm', { level: 40 })], pack: [item(41, 'loot axe', { level: 22, objectType: 13 })] });
        expect(careDue(t.m)).toBeFalse();
        expect(vaultDue(t.m)).toBeFalse();
    });

    test('kept gear in the bag wants a keeper', () => {
        const t = town({ pack: [relic] });
        expect(vaultDue(t.m)).toBeTrue();
        expect(careDue(t.m)).toBeTrue();
    });

    test('gear that has come to fit wants a keeper; gear still too high leaves it be', () => {
        expect(vaultDue(town({ vault: [item(110, 'axe', { level: 24, objectType: 17 })], seen: true }).m)).toBeTrue();
        expect(vaultDue(town({ vault: [{ ...relic, slot: 110 }], seen: true }).m)).toBeFalse();
    });

    test('wear wants a smith only with the money for one, and no keeper', () => {
        const t = town({ worn: [worn] });
        expect(careDue(t.m)).toBeTrue();
        expect(vaultDue(t.m)).toBeFalse();
        expect(careDue(town({ worn: [worn], copper: 100 }).m)).toBeFalse();
        expect(careDue(town({ worn: [worn], copper: 100 }).m, { reserve: 0 })).toBeTrue();
    });

    test('kept gear starts a trip even with an empty purse: a keeper is free', () => {
        expect(careDue(town({ pack: [relic], copper: 0 }).m)).toBeTrue();
    });
});

describe('repairGear', () => {
    test('nothing worn down is nothing at all: no walk, no line', async () => {
        const t = town({ worn: [item(10, 'axe')] });
        expect(await repairGear(t.m)).toEqual([]);
        expect(t.log).toEqual([]);
    });

    test('walks to the nearest smith and repairs the worst first, one at a time', async () => {
        const t = town({ worn: [item(21, 'helm', { condition: 90 }), item(10, 'axe', { condition: 80 }), item(25, 'hauberk')] });
        const lines = await repairGear(t.m, { radius: 12_000 });
        expect(t.log[0]).toMatch(/^walk /);
        expect(t.log.slice(1).map(l => l.split(' at ')[0])).toEqual(['repair axe', 'repair helm']);
        expect(t.worn.every(i => i.condition === 100)).toBeTrue();
        expect(lines.join(' | ')).toContain('repaired axe 80% -> 100% for 2000c');
        expect(lines.at(-1)).toMatch(/^repairs: 3000c at /);
    });

    test('the purse keeps its reserve, and one item too dear doesn\'t stop a cheaper one', async () => {
        const t = town({ copper: 1650, worn: [item(10, 'axe', { condition: 80 }), item(21, 'helm', { condition: 90 })] });
        const lines = await repairGear(t.m, { radius: 12_000 });
        expect(t.log.filter(l => l.startsWith('repair')).map(l => l.split(' max ')[1])).toEqual(['1500', '1500']);
        expect(t.worn.find(i => i.name === 'axe')?.condition).toBe(80);
        expect(t.worn.find(i => i.name === 'helm')?.condition).toBe(100);
        expect(lines.join(' | ')).toContain("can't repair axe: too_expensive");
    });

    test('an instrument goes through "repair all", after the rest', async () => {
        const t = town({ worn: [item(13, 'Lute', { objectType: 45, condition: 80 }), item(10, 'axe', { condition: 90 })] });
        await repairGear(t.m, { radius: 12_000 });
        expect(t.log.slice(1).map(l => l.split(' at ')[0])).toEqual(['repair axe', 'repair all']);
    });

    test('no smith in reach says so and walks nowhere; nor out of town', async () => {
        const worn = [item(10, 'axe', { condition: 80 })];
        const far = town({ worn, regionId: 252 });
        expect(await repairGear(far.m)).toEqual([expect.stringMatching(/^no smith within \d+: axe 80%/)]);
        expect(far.log).toEqual([]);
        const away = town({ worn });
        expect(await repairGear(away.m, { radius: 12_000, town: { x: 0, y: 0 } })).toEqual(['no repair: not in town']);
        expect(away.log).toEqual([]);
    });
});

describe('takeFromVault', () => {
    test('what fits now comes out, and the rest stays', async () => {
        const later = item(110, 'Vue\'s Hauberk', { level: 51 });
        const now = item(111, 'Adroit Hauberk', { level: 25 });
        const t = town({ level: 25, vault: [later, now] });
        expect(await takeFromVault(t.m, { radius: 12_000 })).toEqual(['took Adroit Hauberk L25 out of the vault']);
        expect(t.pack.map(i => i.name)).toEqual(['Adroit Hauberk']);
        expect(t.vault.map(i => i.name)).toEqual(['Vue\'s Hauberk']);
    });

    test('a vault this session hasn\'t seen is worth one look, and then it isn\'t', async () => {
        const t = town({ seen: false });
        expect(await takeFromVault(t.m, { radius: 12_000 })).toEqual([]);
        expect(t.log.some(l => l.startsWith('open '))).toBeTrue();
        const walks = t.log.length;
        expect(await takeFromVault(t.m, { radius: 12_000 })).toEqual([]);
        expect(t.log.length).toBe(walks);
    });

    test('a keeper out of reach is nothing to report, when nothing is known to wait there', async () => {
        const t = town({ seen: false, regionId: 252 });
        expect(await takeFromVault(t.m)).toEqual([]);
        expect(t.log).toEqual([]);
    });

    test('when something is known to wait there, it says what', async () => {
        const t = town({ seen: true, regionId: 252, level: 25, vault: [item(110, 'Adroit Hauberk', { level: 25 })] });
        expect(await takeFromVault(t.m)).toEqual([expect.stringMatching(/^no vault keeper within \d+: waiting in the vault: Adroit Hauberk$/)]);
        expect(t.log).toEqual([]);
    });

    test('not in town: no walk', async () => {
        const t = town({ seen: false });
        expect(await takeFromVault(t.m, { radius: 12_000, town: { x: 0, y: 0 } })).toEqual(['no vault: not in town']);
        expect(t.log).toEqual([]);
    });
});

describe('stashInVault', () => {
    const relic = item(40, 'Dragonmight', { level: 51, objectType: 17 });

    test('too high goes in: nothing else moves', async () => {
        const pelt = item(41, 'wolf pelt', { level: 51, objectType: 0 });
        const t = town({ pack: [relic, pelt, item(42, 'loot axe', { level: 22, objectType: 13 })] });
        expect(await stashInVault(t.m, { radius: 12_000 })).toEqual(['put Dragonmight L51 in the vault']);
        expect(t.vault.map(i => i.name)).toEqual(['Dragonmight']);
        expect(t.pack.map(i => i.name)).toEqual(['wolf pelt', 'loot axe']);
    });

    test('jewellery that\'s worn stays worn: only the backpack is looked at', async () => {
        const t = town({ worn: [item(35, 'Tick', { level: 50, objectType: 41 })], pack: [item(40, 'Empowering Ring', { level: 50, objectType: 41 })] });
        await stashInVault(t.m, { radius: 12_000 });
        expect(t.vault.map(i => i.name)).toEqual(['Empowering Ring']);
        expect(t.worn.map(i => i.name)).toEqual(['Tick']);
    });

    test('nothing to put away is no walk, and a second call has nothing to do', async () => {
        const t = town({ pack: [relic] });
        await stashInVault(t.m, { radius: 12_000 });
        const before = t.log.length;
        expect(await stashInVault(t.m, { radius: 12_000 })).toEqual([]);
        expect(t.log.length).toBe(before);
    });

    test('a full vault says so and leaves the rest in the bag', async () => {
        const full = Array.from({ length: 40 }, (_, i) => item(110 + i, `relic ${i}`, { level: 51 }));
        const t = town({ vault: full, pack: [relic, item(41, 'Vue\'s Hauberk', { level: 51 })] });
        expect(await stashInVault(t.m, { radius: 12_000 })).toEqual(["can't put Dragonmight in the vault: vault_full full"]);
        expect(t.pack).toHaveLength(2);
    });

    test('no keeper in reach keeps it in the bag, and says what waits', async () => {
        const t = town({ pack: [relic], regionId: 252 });
        expect(await stashInVault(t.m)).toEqual([expect.stringMatching(/^no vault keeper within \d+: keeping Dragonmight$/)]);
        const away = town({ pack: [relic] });
        expect(await stashInVault(away.m, { radius: 12_000, town: { x: 0, y: 0 } })).toEqual(['no vault: not in town']);
        expect(away.log).toEqual([]);
    });
});
