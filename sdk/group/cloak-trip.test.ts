// The round trip for a cloak against fake members whose stubs change a snapshot the way the server
// would: the zone point out, the town teleporter's whisper, the OFTeleporter's port for a worn
// medallion. The static data is real: zone points, sellers, teleporters, merchants.
import { afterAll, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { findNpcSpawns, getMerchantItems, getTeleportsForRealm, realmId, type ZonePoint } from '../../data/index';
import type { InventoryItem, PlayerState, Realm } from '../types';
import { CAPITALS, PORTAL_KEEPS } from './battleground';
import { CAPITAL_RADIUS, cloakTrip } from './cloak-trip';
import { nearestCloakSeller } from './gear';
import { BATTLEGROUND_LAYOUTS } from './keeps';
import type { Member } from './member';

// The trip's sleeps only let a new area's objects arrive; nothing arrives here.
let sleep: Mock<typeof Bun.sleep>;
beforeAll(() => { sleep = spyOn(Bun, 'sleep').mockImplementation(async () => {}); });
afterAll(() => sleep.mockRestore());

type R = Exclude<Realm, 'none'>;
const MAGICAL = 41;
const BG_MEDALLION = 'Battlegrounds Medallion of Passage';
const CITY_MEDALLION = 'Medallion of City Passage';
const MIDDLE = { regionId: 252, x: 31000, y: 33000 };
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

const thing = (slot: number, name: string) => ({ slot, name, level: 0, count: 1, objectType: MAGICAL }) as InventoryItem;
const ok = (extra: object = {}) => ({ success: true, message: 'ok', ...extra });

interface Fake {
    member: Member;
    player: PlayerState;
    inventory: InventoryItem[];
    equipment: InventoryItem[];
    calls: string[];
}

interface FakeOptions {
    realm?: R;
    where?: { regionId: number; x: number; y: number; isDead?: boolean; level?: number };
    inventory?: InventoryItem[];
    equipment?: InventoryItem[];
    /** Every call any member makes, in order. */
    order?: string[];
    copper?: number;
    /** Shared by a group: how many buy windows stand open, and the most at once. */
    merchant?: { open: number; most: number };
    /** The OFTeleporter's cast leaves this member behind. */
    missesPort?: boolean;
    zonePoint?: () => object | null;
}

function fake(name: string, o: FakeOptions = {}): Fake {
    const realm = o.realm ?? 'albion';
    const keep = PORTAL_KEEPS[realm], capital = CAPITALS[realm];
    const f: Fake = {
        member: null!,
        player: { name, realm, level: 20, realmPoints: 0, isDead: false, inCombat: false, healthPercent: 100, z: 0, money: { totalCopper: o.copper ?? 10_000 }, ...(o.where ?? MIDDLE) } as PlayerState,
        inventory: o.inventory ?? [],
        equipment: o.equipment ?? [],
        calls: [],
    };
    const call = (s: string) => { f.calls.push(s); o.order?.push(`${name} ${s}`); };
    const set = (change: Partial<PlayerState>) => { f.player = { ...f.player, ...change }; };
    // The cast: whoever stands by the OFTeleporter wearing a medallion goes where it says.
    const castBy = () => {
        const worn = f.equipment.find(i => i.slot === 37);
        if (!worn || o.missesPort || f.player.regionId !== keep.regionId || dist(f.player, keep.teleporter) > 500) return;
        f.equipment = f.equipment.filter(i => i !== worn);
        if (worn.name === CITY_MEDALLION) set({ regionId: capital.regionId, ...capital.landing });
        else set({ regionId: 252, ...BATTLEGROUND_LAYOUTS[252]!.arrival[realm] });
    };
    const actions = {
        walkTo: async (x: number, y: number) => { call(`walk ${x},${y}`); set({ x, y }); castBy(); return ok(); },
        followPath: async (points: { x: number; y: number }[]) => { call('path'); set({ ...points.at(-1)! }); return ok(); },
        walkToObject: async () => ok(),
        talkTo: async () => ok(),
        whisper: async (npc: string, keyword: string) => { call(`whisper ${npc} ${keyword}`); set({ regionId: keep.regionId, ...keep.landing }); return ok(); },
        buyItem: async (merchant: string, what: RegExp | { page: number; slot: number }) => {
            // Open across a real timer tick, so that buys side by side overlap here.
            if (o.merchant) {
                o.merchant.most = Math.max(o.merchant.most, ++o.merchant.open);
                await new Promise(done => setTimeout(done, 1));
                o.merchant.open--;
            }
            if (what instanceof RegExp) {
                const medallion = what.test(CITY_MEDALLION) ? CITY_MEDALLION : BG_MEDALLION;
                call(`buy ${medallion} from ${merchant}`);
                f.inventory.push(thing(40 + f.inventory.length, medallion));
                return ok();
            }
            call(`buy cloak from ${merchant}`);
            f.inventory.push(thing(40 + f.inventory.length, 'cloak'));
            return ok({ spent: 100 });
        },
        closeMerchant: async () => ok(),
        // A medallion by pattern to the Mythical slot; an accessory by item to its slot; the old one swaps out.
        equipItem: async (target: RegExp | InventoryItem, opts: { slot?: number } = {}) => {
            const item = f.inventory.find(i => (target instanceof RegExp ? target.test(i.name) : i.slot === target.slot))!;
            const slot = opts.slot ?? 37;
            call(`equip ${item.name}`);
            const old = f.equipment.find(i => i.slot === slot);
            f.equipment = [...f.equipment.filter(i => i !== old), { ...item, slot }];
            f.inventory = [...f.inventory.filter(i => i !== item), ...(old ? [{ ...old, slot: item.slot }] : [])];
            return ok();
        },
        unequipItem: async (slot: number) => {
            call('unequip');
            const worn = f.equipment.find(i => i.slot === slot)!;
            f.equipment = f.equipment.filter(i => i !== worn);
            f.inventory = [...f.inventory, { ...worn, slot: 40 + f.inventory.length }];
            return ok();
        },
        useZonePoint: async (zp: ZonePoint) => {
            call(`zone point ${zp.id}`);
            const refused = o.zonePoint?.();
            if (refused) return refused;
            set({ regionId: zp.targetRegion, x: zp.targetX, y: zp.targetY });
            return ok();
        },
        releaseAndRespawn: async () => { call('release'); set({ isDead: false, ...BATTLEGROUND_LAYOUTS[252]!.arrival[realm] }); return ok(); },
    };
    const sdk = {
        getPlayer: () => f.player,
        getInventory: () => f.inventory,
        getEquipment: () => f.equipment,
        getEquipmentItem: (slot: number) => f.equipment.find(i => i.slot === slot) ?? null,
        getGameMessages: () => [],
        sendCommand: async () => ok(),
        waitForCondition: async (pred: (s: object) => boolean) => {
            if (pred({ player: f.player, equipment: f.equipment, inventory: f.inventory })) return;
            throw new Error('waitForCondition timed out');
        },
    };
    f.member = { bot: name.toLowerCase(), role: 'nuker', sdk, actions } as unknown as Member;
    return f;
}

const members = (...fs: Fake[]) => fs.map(f => f.member);
const wearsCloak = (f: Fake) => f.equipment.some(i => i.slot === 26 && i.name === 'cloak');
const calledWith = (f: Fake, re: RegExp) => f.calls.filter(c => re.test(c));

describe('the way for each realm, from static data', () => {
    const REALMS: R[] = ['albion', 'midgard', 'hibernia'];

    test.each(REALMS)('%s: the keep merchant sells the city medallion', realm => {
        const m = PORTAL_KEEPS[realm].merchant;
        const spawn = findNpcSpawns({ regionId: PORTAL_KEEPS[realm].regionId, near: m, radius: 50, limit: 1 })[0]!;
        expect(spawn.name).toBe(m.name);
        const entry = getMerchantItems(spawn.itemsListTemplateId!).find(e => CAPITALS[realm].medallion.test(e.name));
        expect(entry).toMatchObject({ itemTemplateId: 'city_necklace', price: 0 });
    });

    test.each(REALMS)('%s: a seller in the capital, and a town teleporter that takes us to the portal keep', realm => {
        const { landing, regionId } = CAPITALS[realm];
        expect(nearestCloakSeller({ regionId, ...landing, realm }, CAPITAL_RADIUS)).not.toBeNull();
        expect(findNpcSpawns({ regionId, near: landing, radius: 4000, classType: /LiveTeleporter/, realm, limit: 1 })[0]).toBeDefined();
        expect(getTeleportsForRealm(realm).some(t => t.teleportId === PORTAL_KEEPS[realm].keyword)).toBe(true);
        expect(realmId(realm)).toBeGreaterThan(0);
    });
});

describe('cloakTrip', () => {
    test('all the way round: out, capital, cloak on, back in', async () => {
        const group = [fake('Galahad'), fake('Nimue', { where: { ...MIDDLE, x: MIDDLE.x + 200 } })];
        const r = await cloakTrip(members(...group), { bind: false });
        expect(r.success).toBe(true);
        for (const f of group) {
            expect(f.player.regionId).toBe(252);
            expect(wearsCloak(f)).toBe(true);
            expect(f.calls.filter(c => !c.startsWith('walk '))).toEqual([
                'zone point 63',
                `buy ${CITY_MEDALLION} from Sall Fadri`,
                `equip ${CITY_MEDALLION}`,
                'buy cloak from Radek Silven',
                'equip cloak',
                'whisper Master Visur Castle Sauvage',
                `buy ${BG_MEDALLION} from Sall Fadri`,
                `equip ${BG_MEDALLION}`,
            ]);
        }
        expect(r.report.Galahad).toContain('bought cloak from Radek Silven 100c');
        expect(r.report.Galahad).toContain('wear cloak (was nothing)');
        expect(r.report.Galahad!.at(-1)).toBe('in Thidranki');
    });

    test('every medallion is bought before anyone wears one, and no two buys overlap at a merchant', async () => {
        const order: string[] = [];
        const merchant = { open: 0, most: 0 };
        const group = [fake('Galahad', { order, merchant }), fake('Nimue', { order, merchant }), fake('Merlin', { order, merchant })];
        await cloakTrip(members(...group), { stay: true });
        expect(merchant).toEqual({ open: 0, most: 1 });
        const city = order.filter(c => c.includes(CITY_MEDALLION));
        expect(city.map(c => c.split(' ').slice(0, 2).join(' '))).toEqual(['Galahad buy', 'Nimue buy', 'Merlin buy', 'Galahad equip', 'Nimue equip', 'Merlin equip']);
        expect(order.filter(c => c.includes('buy cloak')).map(c => c.split(' ')[0])).toEqual(['Galahad', 'Nimue', 'Merlin']);
    });

    test('--stay ends in the capital, cloak on, with no way back asked for', async () => {
        const f = fake('Galahad');
        const r = await cloakTrip([f.member], { stay: true });
        expect(r.success).toBe(true);
        expect(f.player.regionId).toBe(10);
        expect(wearsCloak(f)).toBe(true);
        expect(calledWith(f, /whisper|Battlegrounds/)).toEqual([]);
    });

    test('a battleground medallion left on at the keep comes off before anyone buys', async () => {
        const order: string[] = [];
        const keep = { regionId: 1, x: PORTAL_KEEPS.albion.teleporter.x - 300, y: PORTAL_KEEPS.albion.teleporter.y };
        const group = [fake('Galahad', { where: keep, order, equipment: [thing(37, BG_MEDALLION)] }), fake('Nimue', { where: keep, order })];
        const r = await cloakTrip(members(...group), { stay: true });
        expect(r.success).toBe(true);
        expect(order[0]).toBe('Galahad unequip');
        expect(order.filter(c => c.includes(' buy ')).length).toBeGreaterThan(0);
        expect(r.report.Galahad).toContain('medallion for elsewhere taken off');
        expect(group.map(f => f.player.regionId)).toEqual([10, 10]);
    });

    test('--stay goes to the capital even with a cloak on', async () => {
        const f = fake('Galahad', { equipment: [thing(26, 'cloak')] });
        expect((await cloakTrip([f.member], { stay: true })).success).toBe(true);
        expect(f.player.regionId).toBe(10);
        expect(calledWith(f, /buy cloak/)).toEqual([]);
    });

    test('everyone in the battleground holding a cloak: nothing to do', async () => {
        const group = [fake('Galahad', { equipment: [thing(26, 'cloak')] }), fake('Nimue', { inventory: [thing(40, 'cloak')] })];
        const r = await cloakTrip(members(...group), { bind: false });
        expect(r.success).toBe(true);
        expect(group[0]!.calls).toEqual([]);
        // Only the backpack's cloak goes on.
        expect(group[1]!.calls).toEqual(['equip cloak']);
        expect(group.map(f => f.player.regionId)).toEqual([252, 252]);
    });

    test('a member holding a cloak stays in the battleground while the others go', async () => {
        const holder = fake('Galahad', { equipment: [thing(26, 'cloak')] }), bare = fake('Nimue');
        const r = await cloakTrip(members(holder, bare), { bind: false });
        expect(r.success).toBe(true);
        expect(holder.calls).toEqual([]);
        expect(wearsCloak(bare)).toBe(true);
    });

    test('a dead member holding a cloak in the battleground is released, and then puts it on', async () => {
        const holder = fake('Galahad', { where: { ...MIDDLE, isDead: true }, inventory: [thing(40, 'cloak')] }), bare = fake('Nimue');
        const r = await cloakTrip(members(holder, bare), { bind: false });
        expect(r.success).toBe(true);
        expect(holder.calls).toEqual(['release', 'equip cloak']);
        expect(holder.player).toMatchObject({ isDead: false, regionId: 252 });
    });

    test('a member still dead after the release stops the run before anyone leaves', async () => {
        const holder = fake('Galahad', { where: { ...MIDDLE, isDead: true }, equipment: [thing(26, 'cloak')] }), bare = fake('Nimue');
        Object.assign(holder.member.actions, { releaseAndRespawn: async () => ({ success: false, reason: 'timeout', message: 'Still dead' }) });
        const r = await cloakTrip(members(holder, bare), { bind: false });
        expect(r).toMatchObject({ success: false, message: 'still dead: Galahad r252 (31000, 33000)' });
        expect(r.report.Galahad).toEqual(['release: timeout Still dead']);
        expect(bare.calls).toEqual([]);
    });

    test('a member holding a cloak at the portal keep waits there for the others, then goes in with them', async () => {
        const keep = { regionId: 1, x: PORTAL_KEEPS.albion.teleporter.x - 300, y: PORTAL_KEEPS.albion.teleporter.y };
        const holder = fake('Galahad', { where: keep, equipment: [thing(26, 'cloak')] }), bare = fake('Nimue', { where: keep });
        const r = await cloakTrip(members(holder, bare), { bind: false });
        expect(r.success).toBe(true);
        expect(calledWith(holder, /City|whisper|cloak/)).toEqual([]);
        expect(calledWith(bare, /whisper/)).toHaveLength(1);
        expect([holder.player.regionId, bare.player.regionId]).toEqual([252, 252]);
    });

    test('a member holding a cloak but wearing the city medallion goes with it: the next cast would take it anyway', async () => {
        const keep = { regionId: 1, x: PORTAL_KEEPS.albion.teleporter.x - 300, y: PORTAL_KEEPS.albion.teleporter.y };
        const f = fake('Galahad', { where: keep, equipment: [thing(26, 'cloak'), thing(37, CITY_MEDALLION)] });
        const r = await cloakTrip([f.member], { bind: false });
        expect(r.success).toBe(true);
        expect(calledWith(f, /whisper/)).toEqual(['whisper Master Visur Castle Sauvage']);
        expect(f.player.regionId).toBe(252);
    });

    test('resumes from the capital: no zone point, no city medallion, the cloak bought only where it lacks', async () => {
        const camelot = { regionId: 10, ...CAPITALS.albion.landing };
        const holder = fake('Galahad', { where: camelot, equipment: [thing(26, 'cloak')] }), bare = fake('Nimue', { where: camelot });
        const r = await cloakTrip(members(holder, bare), { bind: false });
        expect(r.success).toBe(true);
        expect(calledWith(holder, /zone point|City|buy cloak/)).toEqual([]);
        expect(calledWith(bare, /zone point|City/)).toEqual([]);
        expect(calledWith(bare, /buy cloak/)).toHaveLength(1);
    });

    test('resumes with the group split: one still inside, one at the keep, one already in the capital', async () => {
        const keep = { regionId: 1, x: PORTAL_KEEPS.albion.teleporter.x - 300, y: PORTAL_KEEPS.albion.teleporter.y };
        const inside = fake('Galahad'), atKeep = fake('Nimue', { where: keep }), inCity = fake('Merlin', { where: { regionId: 10, ...CAPITALS.albion.landing } });
        const r = await cloakTrip(members(inside, atKeep, inCity), { bind: false });
        expect(r.success).toBe(true);
        expect(calledWith(inside, /zone point/)).toHaveLength(1);
        expect(calledWith(atKeep, /zone point/)).toEqual([]);
        expect(calledWith(inCity, /zone point|City/)).toEqual([]);
        expect([inside, atKeep, inCity].every(wearsCloak)).toBe(true);
    });

    test('a member who can\'t come back keeps everyone inside', async () => {
        const group = [fake('Galahad'), fake('Nimue', { where: { ...MIDDLE, level: 25 } })];
        const r = await cloakTrip(members(...group));
        expect(r).toMatchObject({ success: false, message: 'could not come back: Nimue: level 25: Thidranki takes 20-24' });
        expect(group.flatMap(f => f.calls)).toEqual([]);
    });

    test('--stay needs no way back', async () => {
        const f = fake('Nimue', { where: { ...MIDDLE, level: 25 } });
        expect((await cloakTrip([f.member], { stay: true })).success).toBe(true);
    });

    test('the dead are released; a zone point that won\'t work stops before the capital', async () => {
        const f = fake('Galahad', { where: { ...MIDDLE, isDead: true }, zonePoint: () => ({ success: false, reason: 'timeout', message: 'No jump' }) });
        const r = await cloakTrip([f.member]);
        expect(r.success).toBe(false);
        expect(r.report.Galahad).toContain('zone point 63: timeout No jump');
        expect(f.calls[0]).toBe('release');
        expect(calledWith(f, /City/)).toEqual([]);
    });

    test('a missed port after two casts stops the run, and the others wait in the capital', async () => {
        const group = [fake('Galahad'), fake('Nimue', { missesPort: true })];
        const r = await cloakTrip(members(...group));
        expect(r.success).toBe(false);
        expect(r.message).toStartWith('not ported to the capital: Nimue r1');
        expect(group[0]!.player.regionId).toBe(10);
        expect(calledWith(group[0]!, /buy cloak/)).toEqual([]);
    });

    test('no money for a cloak stops the group in the capital, with the reason in the report', async () => {
        const group = [fake('Galahad'), fake('Nimue', { copper: 160 })];
        const r = await cloakTrip(members(...group));
        expect(r.success).toBe(false);
        expect(r.message).toStartWith('no cloak: Nimue r10');
        expect(r.report.Nimue).toContain('no cloak: 160c, keeping 150c');
        expect(group.flatMap(f => calledWith(f, /whisper/))).toEqual([]);
        expect(group.map(f => f.player.regionId)).toEqual([10, 10]);
    });

    test('Tir na Nog: Dierdra stands beyond the teleporter\'s 4000, so the group walks back first', async () => {
        const f = fake('Cuchulainn', { realm: 'hibernia' });
        const r = await cloakTrip([f.member], { bind: false });
        expect(r.success).toBe(true);
        expect(r.report.Cuchulainn).toContain('bought cloak from Dierdra 100c');
        expect(r.report.Cuchulainn).toContain('walked to Channeler Glasny');
        expect(calledWith(f, /zone point|whisper/)).toEqual(['zone point 65', 'whisper Channeler Glasny Druim Ligen']);
    });

    test('Jordheim: Hyndla stands by the second Stor Gothi Annark, no walk back', async () => {
        const f = fake('Thorgrim', { realm: 'midgard' });
        const r = await cloakTrip([f.member], { bind: false });
        expect(r.success).toBe(true);
        expect(r.report.Thorgrim).toContain('bought cloak from Hyndla Gunderson 100c');
        expect(r.report.Thorgrim).not.toContain('walked to Stor Gothi Annark');
        expect(calledWith(f, /zone point|whisper/)).toEqual(['zone point 64', 'whisper Stor Gothi Annark Svasud Faste']);
    });
});
