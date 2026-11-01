// Cloaks and jewellery, for every realm's town visit: which slot an accessory goes in, which
// ones to wear, and buying a plain cloak. See learnings/looting.md "Cloaks and jewellery".
//
// An accessory is object type 41 (Magical), which also covers potions (Item_Type 40), mounts (9),
// saddles (7), barding (8), medallions and mythirians (37) and saddlebags (96-99). The inventory
// doesn't carry Item_Type and the SDK has no delve, so the slot comes from the item template of
// that name; random loot has no template (GeneratedUniqueItem isn't in the DB), so its slot comes
// from the generator's base name (GeneratedUniqueItem.cs:7014-7091), the last word of the name
// (:7417 sets it, :6380 prefixes it, :727 lowercases it when no bonus landed).
//
// Accessories have no value1 (their AF/DPS field) and loot stats can't be read, so the item level
// is the score: GeneratedUniqueItem scales bonuses with Level, and a plain merchant cloak is level 0.

import { findItemTemplates, findNpcSpawns, getMerchantItems, realmId, type MerchantEntry, type NpcSpawnMatch } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { EquipmentSlot, type InventoryItem, type PlayerState } from '../types';

const { Jewelry, Cloak, Neck, Waist, LeftBracer, RightBracer, LeftRing, RightRing } = EquipmentSlot;
const MAGICAL = 41;
const BRACERS = [LeftBracer, RightBracer] as const;
const RINGS = [LeftRing, RightRing] as const;

/** Item_Type → the slots the server takes it in: either wrist or finger (GamePlayerInventory.cs CheckItemSlotRestriction). */
const SLOTS_BY_TYPE: Record<number, readonly number[]> = {
    [Jewelry]: [Jewelry], [Cloak]: [Cloak], [Neck]: [Neck], [Waist]: [Waist],
    [LeftBracer]: BRACERS, [RightBracer]: BRACERS, [LeftRing]: RINGS, [RightRing]: RINGS,
};

/** Every base name the loot generator gives a magical item (GeneratedUniqueItem.cs:7018-7086). */
const LOOT_NAMES: [RegExp, readonly number[]][] = [
    [/\b(cloak|mantle)$/i, [Cloak]],
    [/\b(belt|girdle)$/i, [Waist]],
    [/\b(choker|pendant)$/i, [Neck]],
    [/\b(gem|jewel)$/i, [Jewelry]],
    [/\b(bracelet|bracer)$/i, BRACERS],
    [/\b(ring|wrap)$/i, RINGS],
];

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateTypes = new Map<string, number[]>();
/** Item_Types of the Magical templates with exactly this name (the scan is over the whole item table: remembered). */
function magicalTemplateTypes(name: string): number[] {
    const key = name.toLowerCase();
    let types = templateTypes.get(key);
    if (!types) {
        types = findItemTemplates(new RegExp(`^${escapeRe(name)}$`, 'i'), 200).filter(t => t.objectType === MAGICAL).map(t => t.itemType);
        templateTypes.set(key, types);
    }
    return types;
}

/**
 * The slot(s) an accessory goes in, or none. A template decides when one has this name, and only
 * when all of that name are accessories: "Cunnart Gem" is a potion (40), "Enchanter Belt" a type 0 oddity,
 * "Average Protection Mythirian" exists as both 24 and 37, and a medallion (37) stays with
 * battleground.ts. Without a template (random loot) the name decides.
 */
export function accessorySlots(item: Pick<InventoryItem, 'name' | 'objectType'>): readonly number[] {
    if (item.objectType !== MAGICAL) return [];
    const types = magicalTemplateTypes(item.name);
    if (types.length) return types.every(t => SLOTS_BY_TYPE[t]) ? SLOTS_BY_TYPE[types[0]!]! : [];
    return LOOT_NAMES.find(([re]) => re.test(item.name))?.[1] ?? [];
}

export interface AccessoryMove {
    item: InventoryItem;
    slot: number;
    /** What the slot holds now; the server swaps it into the item's backpack slot. */
    replaces: InventoryItem | null;
}

/**
 * The next accessory to put on, highest level first: an empty slot is always filled, a worn one
 * replaced only by a strictly higher level; of a pair, the lower of the two. Every move raises the
 * worn levels, so repeating this on the new state ends with the best of each slot worn.
 */
export function nextAccessory(backpack: InventoryItem[], worn: InventoryItem[]): AccessoryMove | null {
    const ranked = backpack.filter(i => accessorySlots(i).length).sort((a, b) => b.level - a.level || a.slot - b.slot);
    for (const item of ranked) {
        const slots = accessorySlots(item);
        const empty = slots.find(s => !worn.some(w => w.slot === s));
        if (empty !== undefined) return { item, slot: empty, replaces: null };
        const lowest = worn.filter(w => slots.includes(w.slot)).sort((a, b) => a.level - b.level)[0]!;
        if (item.level > lowest.level) return { item, slot: lowest.slot, replaces: lowest };
    }
    return null;
}

type GearActions = Pick<BotActions, 'equipItem' | 'buyItem' | 'closeMerchant' | 'walkTo'>;
/** A group member (`actions`) or a party member (`bot`, groups/hibernia, midgard's party(m)). */
export type GearMember = { sdk: Pick<BotSDK, 'getEquipment' | 'getInventory' | 'getPlayer'> } & ({ actions: GearActions } | { bot: GearActions });

const actionsOf = (m: GearMember) => ('actions' in m ? m.actions : m.bot);
const backpackOf = (m: GearMember) => m.sdk.getInventory().filter(i => i.slot >= 40 && i.slot <= 79);

/**
 * Wear the accessories in the backpack that beat what is worn. Always names the slot: the paper
 * doll takes a third ring to the right finger even when the left one is the weaker
 * (PlayerMoveItemRequestHandler.cs ConvertPaperDollDestinationSlot). What the server refuses stays
 * in the backpack, and isn't tried again in this call.
 */
export async function wearAccessories(m: GearMember): Promise<string[]> {
    const out: string[] = [];
    const refused = new Set<number>();
    for (let n = 0; n < 16; n++) {
        const move = nextAccessory(backpackOf(m).filter(i => !refused.has(i.slot)), m.sdk.getEquipment());
        if (!move) break;
        const r = await actionsOf(m).equipItem(move.item, { slot: move.slot });
        if (r.success) out.push(`wear ${move.item.name} (was ${move.replaces?.name ?? 'nothing'})`);
        else { refused.add(move.item.slot); out.push(`can't wear ${move.item.name}: ${r.message}`); }
    }
    return out;
}

/** How far a town visit walks for a cloak: Camelot's trainers stand up to 5,425 from the nearest seller (static data). */
export const CLOAK_RADIUS = 6000;
/** Copper a cloak purchase leaves in the purse: buyArmor's floor (groups/camelot/town.ts). */
export const CLOAK_RESERVE = 150;
/**
 * How far from its landing point a member still counts as in town, as groups/midgard/town.ts's guard.
 * Hibernia's trainers, bind stones and healers stand at most 2,447 from theirs, and straight lines
 * to a seller from within 5,000 enter no hostile's aggro range; from 6,000 they do (static data).
 */
export const CLOAK_TOWN_RANGE = 5000;

const PLAIN_CLOAK = /^cloak\d*$/i;
const HOODED_CLOAK = /^hooded_cloak$/i;

export interface CloakSeller {
    spawn: NpcSpawnMatch;
    /** The plain cloaks it sells: 'cloak' before 'hooded_cloak'. */
    cloaks: MerchantEntry[];
}

/**
 * The nearest merchant of our realm or none that sells a plain cloak, from static data. Region 165
 * has sellers of all three realms. Only GameMerchant: the others take other currencies, and all 88
 * sellers in the DB are one today.
 */
export function nearestCloakSeller(p: Pick<PlayerState, 'regionId' | 'x' | 'y' | 'realm'>, radius = CLOAK_RADIUS): CloakSeller | null {
    const realm = realmId(p.realm);
    for (const spawn of findNpcSpawns({ regionId: p.regionId, near: p, radius, classType: /^GameMerchant$/ })) {
        if (!spawn.itemsListTemplateId || (spawn.realm !== 0 && spawn.realm !== realm)) continue;
        const entries = getMerchantItems(spawn.itemsListTemplateId);
        const cloaks = [...entries.filter(e => PLAIN_CLOAK.test(e.itemTemplateId)), ...entries.filter(e => HOODED_CLOAK.test(e.itemTemplateId))];
        if (cloaks.length) return { spawn, cloaks };
    }
    return null;
}

/** A cloak worn, or in the backpack for wearAccessories to put on. */
export const holdsCloak = (m: GearMember) => m.sdk.getEquipment().some(w => w.slot === Cloak) || backpackOf(m).some(i => accessorySlots(i).includes(Cloak));

/**
 * Without a cloak worn or in the backpack: buy a plain one from the nearest seller within `radius`
 * (default CLOAK_RADIUS). wearAccessories (equipUpgrades) puts it on, so call that before anything
 * sells. Game failures come back as log strings; no seller nearby is no line at all. The walk alone
 * ignores danger zones, so a caller whose teleport can fail passes `town`, the landing point: outside
 * CLOAK_TOWN_RANGE it buys nothing, and the next visit retries.
 */
export async function buyCloak(m: GearMember, opts: { town?: { x: number; y: number }; radius?: number } = {}): Promise<string[]> {
    const p = m.sdk.getPlayer();
    if (!p || p.isDead) return [];
    if (holdsCloak(m)) return [];
    const seller = nearestCloakSeller(p, opts.radius);
    if (!seller) return [];
    if (opts.town && Math.hypot(p.x - opts.town.x, p.y - opts.town.y) > CLOAK_TOWN_RANGE) return ['no cloak: not in town'];
    const budget = p.money.totalCopper - CLOAK_RESERVE;
    const pick = seller.cloaks.find(e => e.price <= budget);
    if (!pick) return [`no cloak: ${p.money.totalCopper}c, keeping ${CLOAK_RESERVE}c`];
    const s = seller.spawn;
    const act = actionsOf(m);
    if (Math.hypot(p.x - s.x, p.y - s.y) > 300) {
        const w = await act.walkTo(s.x, s.y, { z: s.z, tolerance: 150 });
        if (!w.success) return [`walk to ${s.name}: ${w.reason} ${w.message}`];
    }
    const r = await act.buyItem(s.name, { page: pick.page, slot: pick.slot }, 1);
    await act.closeMerchant().catch(() => null);
    return [r.success ? `bought ${pick.name} from ${s.name} ${r.spent}c` : `buy ${pick.name}: ${r.reason} ${r.message}`];
}
