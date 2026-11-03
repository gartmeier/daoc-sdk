// Cloaks and jewellery, for every realm's town visit: which slot an accessory goes in, which
// ones to wear, and buying a plain cloak. See learnings/looting.md "Cloaks and jewellery". Also the
// per-call delve cache behind choosing gear by bonuses (scoring: gear-score.ts).
//
// An accessory is object type 41 (Magical), which also covers potions (Item_Type 40), mounts (9),
// saddles (7), barding (8), medallions and mythirians (37) and saddlebags (96-99). The inventory
// doesn't carry Item_Type, so the slot comes from the item template of that name; random loot has
// no template (GeneratedUniqueItem isn't in the DB), so its slot comes from the generator's base
// name (GeneratedUniqueItem.cs:7014-7091), the last word of the name (:7417 sets it, :6380 prefixes
// it, :727 lowercases it when no bonus landed).
//
// Accessories have no value1 (their AF/DPS field), so a delve's bonuses are the score. When a delve
// fails, the item level decides that one comparison: GeneratedUniqueItem scales bonuses with Level,
// and a plain merchant cloak is level 0.

import { findItemTemplates, findNpcSpawns, getClass, getMerchantItems, realmId, type ClassInfo, type MerchantEntry, type NpcSpawnMatch } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { EquipmentSlot, isArmor, ObjectType, type InventoryItem, type PlayerState } from '../types';
import { armorGain, armorSwing, armorValue, statScore, tooHighLevel } from './gear-score';

const { Jewelry, Cloak, Neck, Waist, LeftBracer, RightBracer, LeftRing, RightRing } = EquipmentSlot;
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
        types = findItemTemplates(new RegExp(`^${escapeRe(name)}$`, 'i'), 200).filter(t => t.objectType === ObjectType.Magical).map(t => t.itemType);
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
    if (item.objectType !== ObjectType.Magical) return [];
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

/** An item's delved score, or null when it has none: then its comparisons go by level. */
export type GearScore = (item: InventoryItem) => number | null;

/**
 * The next accessory to put on, best first: an empty slot is filled unless the item is a net
 * negative, a worn one replaced only by a strictly higher score; of a pair, the lower of the two.
 * Where either side has no score, level decides that comparison, and without `scoreOf` all of them.
 * Repeating this on the new state ends with the best of each slot worn.
 */
export function nextAccessory(backpack: InventoryItem[], worn: InventoryItem[], scoreOf: GearScore = () => null): AccessoryMove | null {
    const compare = (a: InventoryItem, b: InventoryItem) => {
        const x = scoreOf(a), y = scoreOf(b);
        return x !== null && y !== null ? x - y : a.level - b.level;
    };
    const ranked = backpack.filter(i => accessorySlots(i).length).sort((a, b) => compare(b, a) || a.slot - b.slot);
    for (const item of ranked) {
        const slots = accessorySlots(item);
        const empty = slots.find(s => !worn.some(w => w.slot === s));
        if (empty !== undefined) {
            if ((scoreOf(item) ?? 0) < 0) continue;
            return { item, slot: empty, replaces: null };
        }
        const lowest = worn.filter(w => slots.includes(w.slot)).sort(compare)[0]!;
        if (compare(item, lowest) > 0) return { item, slot: lowest.slot, replaces: lowest };
    }
    return null;
}

/** Delves in one GearDelves. A town visit holds 8 worn accessories, 6 armour pieces and some loot; past this, the old rules. */
export const MAX_DELVES = 24;
/** Delves failing in a row before the rest of the call goes without: a client that can't delve costs 3 s each otherwise. */
const MAX_DELVE_FAILURES = 3;

type GearActions = Pick<BotActions, 'equipItem' | 'buyItem' | 'closeMerchant' | 'walkTo'> & Partial<Pick<BotActions, 'delveItem'>>;
/** A group member (`actions`) or a party member (`bot`, groups/hibernia, midgard's party(m)). */
export type GearMember = { sdk: Pick<BotSDK, 'getEquipment' | 'getInventory' | 'getPlayer'> } & ({ actions: GearActions } | { bot: GearActions });

const actionsOf = (m: GearMember) => ('actions' in m ? m.actions : m.bot);
const backpackOf = (m: GearMember) => m.sdk.getInventory().filter(i => i.slot >= 40 && i.slot <= 79);

const delveKey = (item: Pick<InventoryItem, 'slot' | 'name'>) => `${item.slot}:${item.name}`;

/**
 * The stat scores of one equip pass, each item delved once by slot and name, one at a time. Items
 * that can't be scored are null, for the caller's old rule to decide; flush() hands over the lines
 * saying so, so a delve problem shows in the town report. A caller that equips between scores
 * reports it with moved().
 */
export class GearDelves {
    private readonly scores = new Map<string, number | null>();
    private lines: string[] = [];
    private count = 0;
    private failures = 0;
    private stopped = false;
    private readonly classInfo: ClassInfo | undefined;
    private readonly level: number;

    constructor(private readonly m: GearMember) {
        const p = m.sdk.getPlayer();
        this.level = p?.level ?? 1;
        this.classInfo = p?.className ? getClass(p.className, p.realm) : undefined;
    }

    /** A score delved already, without asking. */
    known: GearScore = item => this.scores.get(delveKey(item)) ?? null;

    /** The item's stat score, delving it if this pass hasn't yet. */
    async score(item: InventoryItem): Promise<number | null> {
        const key = delveKey(item);
        const seen = this.scores.get(key);
        if (seen !== undefined) return seen;
        const score = await this.delve(item);
        this.scores.set(key, score);
        return score;
    }

    /**
     * `item` went into `slot`, and what was there (`replaces`) into the item's old slot
     * (GamePlayerInventory.cs:432): their scores go with them. Otherwise an item of the same name
     * answers for the one that left: the DB has a character with two "Bodymender Studded Sleeves" of different bonuses.
     */
    moved(item: InventoryItem, slot: number, replaces?: InventoryItem): void {
        const to = delveKey({ slot, name: item.name }), back = replaces ? delveKey({ slot: item.slot, name: replaces.name }) : null;
        const score = this.scores.get(delveKey(item)), old = replaces ? this.scores.get(delveKey(replaces)) : undefined;
        for (const key of [delveKey(item), to, ...(replaces ? [delveKey(replaces), back!] : [])]) this.scores.delete(key);
        if (score !== undefined) this.scores.set(to, score);
        if (back && old !== undefined) this.scores.set(back, old);
    }

    private stop(why: string): null {
        if (!this.stopped) this.lines.push(`no more delves: ${why}`);
        this.stopped = true;
        return null;
    }

    private async delve(item: InventoryItem): Promise<number | null> {
        const actions = actionsOf(this.m);
        if (!actions.delveItem || this.stopped) return null;
        if (!this.classInfo) return this.stop(`no class data for ${this.m.sdk.getPlayer()?.className}`);
        if (this.count >= MAX_DELVES) return this.stop(`${MAX_DELVES} this pass`);
        this.count++;
        const r = await actions.delveItem(item);
        if (!r.success) {
            this.lines.push(`delve ${item.name}: ${r.reason} ${r.message}; old rule for it`);
            if (++this.failures >= MAX_DELVE_FAILURES) this.stop(`${MAX_DELVE_FAILURES} failures in a row`);
            return null;
        }
        this.failures = 0;
        return statScore(r.bonuses, this.classInfo, this.level);
    }

    /** The lines since the last flush. */
    flush(): string[] {
        const out = this.lines;
        this.lines = [];
        return out;
    }
}

/** A gain below this isn't worth the swap: the town scripts' threshold. */
export const UPGRADE_MARGIN = 0.5;

/** Armour gain of a backpack piece over what the slot holds. A piece AF and absorb rule out however good its bonuses isn't delved. */
export async function armorUpgradeGain(delves: GearDelves, item: InventoryItem, cur: InventoryItem | undefined, level: number): Promise<number> {
    const candidate = armorValue(item, level);
    const current = cur ? armorValue(cur, level) : 0;
    if (candidate - current + armorSwing(candidate, current) <= UPGRADE_MARGIN) return candidate - current;
    const candidateStat = await delves.score(item);
    const currentStat = cur ? await delves.score(cur) : 0;
    return armorGain(candidate, current, candidateStat, currentStat);
}


/**
 * Each candidate's gain over what its slot holds. Armour counts its bonuses (armorUpgradeGain);
 * weapons and shields stay on the caller's `score`, by DPS or block alone: their bonuses aren't weighed yet.
 * A candidate too high for this level (tooHighLevel, `maxCon`) isn't one, however good: it wears too fast.
 */
export async function upgradeGains<T extends { item: InventoryItem; cur?: InventoryItem }>(delves: GearDelves, rows: T[], level: number, score: (i: InventoryItem, level: number) => number, opts: { maxCon?: number } = {}): Promise<(T & { gain: number })[]> {
    const out: (T & { gain: number })[] = [];
    for (const row of rows) {
        if (tooHighLevel(row.item, level, opts.maxCon)) continue;
        const gain = isArmor(row.item.objectType)
            ? await armorUpgradeGain(delves, row.item, row.cur, level)
            : score(row.item, level) - (row.cur ? score(row.cur, level) : 0);
        out.push({ ...row, gain });
    }
    return out;
}

const num = (n: number) => String(Number(n.toFixed(1)));

/**
 * Wear the accessories in the backpack that beat what is worn by delved bonuses for this class.
 * Always names the slot: the paper doll takes a third ring to the right finger even when the left
 * one is the weaker (PlayerMoveItemRequestHandler.cs ConvertPaperDollDestinationSlot). What the
 * server refuses stays in the backpack, and isn't tried again in this call; nor is what a swap took
 * off, which lands in the slot of the item put on, so a level comparison after a failed delve can't
 * go in circles.
 */
export async function wearAccessories(m: GearMember): Promise<string[]> {
    const out: string[] = [];
    const delves = new GearDelves(m);
    const settled = new Set<number>();
    for (let n = 0; n < 16; n++) {
        const pack = backpackOf(m).filter(i => !settled.has(i.slot));
        const worn = m.sdk.getEquipment();
        for (const item of pack) {
            const slots = accessorySlots(item);
            if (!slots.length) continue;
            await delves.score(item);
            for (const w of worn) if (slots.includes(w.slot)) await delves.score(w);
        }
        out.push(...delves.flush());
        const move = nextAccessory(pack, worn, delves.known);
        if (!move) break;
        const r = await actionsOf(m).equipItem(move.item, { slot: move.slot });
        settled.add(move.item.slot);
        if (r.success) {
            const score = delves.known(move.item), old = move.replaces ? delves.known(move.replaces) : null;
            const why = score === null ? '' : old === null ? `, score ${num(score)}` : `, score ${num(score)} over ${num(old)}`;
            out.push(`wear ${move.item.name} (was ${move.replaces?.name ?? 'nothing'}${why})`);
            delves.moved(move.item, move.slot, move.replaces ?? undefined);
        } else out.push(`can't wear ${move.item.name}: ${r.message}`);
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
