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
//
// Also weapons: wearing and buying a better one for the character's trained line (learnings/merchants.md
// "Better weapons").

import { findItemTemplates, findNpcSpawns, getClass, getItemTemplate, getMerchantItems, realmId, type ClassInfo, type MerchantEntry, type NpcSpawnMatch } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { parseWeaponDelve } from '../delve';
import { EquipmentSlot, isArmor, isWeapon, ItemHand, ObjectType, type InventoryItem, type ItemBonus, type MerchantItem, type PlayerState, type Specialization, type WeaponDelve } from '../types';
import { armorGain, armorSwing, armorValue, statScore, tooHighLevel, WEAPON_STAT_SWING, weaponScore, weaponValue } from './gear-score';
import { DUAL_LINES, WEAPON_LINES } from './styles';

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

// ── Weapons ─────────────────────────────────────────────────────────────────
//
// What a character's lines allow comes from its own specs, what's on offer from the shop window, and
// what an item does at this level from its delve.

const { RightHand, LeftHand, TwoHand } = EquipmentSlot;

/** A trained line is above the 1 every class starts with. */
const TRAINED = 2;
/** Lines with nothing but two-handers: a shield or a left hand can't stop these. */
const TWO_HANDED_LINES = new Set(['Two Handed', 'Polearm', 'Staff', 'Spear', 'Large Weapons', 'Celtic Spear', 'Scythe']);
/** The wire calls the line Shield, the DB Shields. */
const SHIELD_LINE = /^Shields?$/;
const WEAPON_LINE_NAMES = new Set(Object.values(WEAPON_LINES));

export interface WeaponNeeds {
    /** The highest trained weapon line: the one styles, weapon skill and variance reward. */
    line: string;
    level: number;
    /** The character trains a left hand, Dual Wield, Left Axe, Celtic Dual or Hand to Hand, over any shield. */
    left: boolean;
    /** Nothing depends on the left hand, so a two-hander of the line may compete. */
    twoHanded: boolean;
}

/** What a character's specs ask of its hands; null without a trained weapon line (a Healer's hammer stays). */
export function weaponNeeds(specs: readonly Pick<Specialization, 'name' | 'level'>[]): WeaponNeeds | null {
    const top = specs.filter(s => WEAPON_LINE_NAMES.has(s.name) && s.level >= TRAINED).sort((a, b) => b.level - a.level)[0];
    if (!top) return null;
    const levelOf = (matches: (name: string) => boolean) => Math.max(0, ...specs.filter(s => matches(s.name)).map(s => s.level));
    const dual = levelOf(n => DUAL_LINES.has(n)), shield = specs.some(s => SHIELD_LINE.test(s.name));
    // A class with both goes by which it trains: a Blademaster at Shields 20, Celtic Dual 5 keeps the shield.
    const left = dual >= TRAINED && dual >= levelOf(n => SHIELD_LINE.test(n));
    return { line: top.name, level: top.level, left, twoHanded: TWO_HANDED_LINES.has(top.name) || (dual < TRAINED && !shield) };
}

/** The slots a weapon could go in for this character: none off its line, or a two-hander the left hand forbids. */
export function weaponSlots(w: { objectType: number; hand: number }, needs: WeaponNeeds): number[] {
    if (!isWeapon(w.objectType) || WEAPON_LINES[w.objectType] !== needs.line) return [];
    if (w.hand === ItemHand.TwoHanded) return needs.twoHanded ? [TwoHand] : [];
    return w.hand === ItemHand.FitsLeft && needs.left ? [RightHand, LeftHand] : [RightHand];
}

/** Right hand and two-hander compete: one of them is out at a time, and putting either on brings it out (GamePlayerInventory.cs:547-560). */
const handsOf = (slot: number): number[] => (slot === LeftHand ? [LeftHand] : [RightHand, TwoHand]);
const handsFor = (needs: WeaponNeeds) => (needs.left ? [RightHand, LeftHand] : [RightHand]);

/** Refusals one hand takes from the backpack before it gives up: a weapon another realm's or one the class can't use, and the next best tried. */
const MAX_WEAPON_TRIES = 4;
/** How much better a weapon must be to pay for it: the record says it matters most, but not for a few percent. */
export const WEAPON_STEP = 1.1;
/** How much better a weapon from the backpack must be to swap: it's free, but rounding shouldn't trade places. */
export const WEAPON_SWAP = 1.02;
/** Scores this close count as equal, and the cheaper one wins: above the level clamp, price buys nothing. */
const WEAPON_TIE = 1.01;
/** How far a town visit walks for a weapon, as for a cloak. */
export const WEAPON_RADIUS = CLOAK_RADIUS;
/** Copper a weapon purchase leaves in the purse. */
export const WEAPON_RESERVE = CLOAK_RESERVE;

export interface WeaponOptions {
    /**
     * Also take what the server says needs a higher level. The requirement only gates the item's
     * proc (GameLiving.cs:853-855), so at level 20 a level 51 axe still gives its Strength and Axe
     * bonuses. Leaving these out is the default, so that a town visit doesn't hand endgame gear to
     * a level 5 character; a bot that wants them says so. It also lifts the level limit below.
     */
    overLevel?: boolean;
    /** Too high above this con (default GEAR_MAX_CON): tooHighLevel, as for armour. */
    maxCon?: number;
}

/** The server's word on a delved item: its Level Requirement isn't above this character's. */
const levelAllows = (required: number | null | undefined, level: number, opts: WeaponOptions) => !!opts.overLevel || !required || required <= level;
/** Within the level limit: above it a weapon wears faster, and its DPS is clamped to the level anyway. One already held stays held. */
const withinLimit = (item: { level: number }, level: number, opts: WeaponOptions) => !!opts.overLevel || !tooHighLevel(item, level, opts.maxCon);

export interface WeaponRow<T> {
    item: T;
    slot: number;
    score: number;
    price: number;
}

/** The row worth having over `current`: the best by score, the cheapest of those about equal; null when it's no step of `step`. */
export function bestWeapon<T>(rows: readonly WeaponRow<T>[], current: number, step: number): WeaponRow<T> | null {
    if (!rows.length) return null;
    const top = Math.max(...rows.map(r => r.score));
    if (top <= 0 || top < current * step) return null;
    return rows.filter(r => r.score * WEAPON_TIE >= top).sort((a, b) => a.price - b.price || b.score - a.score)[0]!;
}

/** The most a shop item can score before its delve: the window's DPS at full quality, under the cap once a delve has shown one, with the best bonuses. */
function ceiling(i: Pick<MerchantItem, 'value1' | 'spdAbs' | 'hand'>, needs: WeaponNeeds, cap: number): number {
    const value = weaponValue({ clampedDps: Math.min(i.value1 / 10, cap), speed: i.spdAbs / 10, quality: 100, condition: 100 }, i.hand === ItemHand.TwoHanded ? needs.level : null);
    return value * (1 + WEAPON_STAT_SWING);
}

type WeaponActions = Pick<BotActions, 'equipItem' | 'buyItem' | 'closeMerchant' | 'walkTo' | 'delveItem' | 'delveMerchantItem' | 'openMerchant'>;
/** A group member or party member (see GearMember) that can also shop and read its specs. */
export type WeaponMember = { sdk: Pick<BotSDK, 'getEquipment' | 'getInventory' | 'getPlayer' | 'getSkills' | 'getMerchant'> } & ({ actions: WeaponActions } | { bot: WeaponActions });

const weaponActions = (m: WeaponMember) => ('actions' in m ? m.actions : m.bot);

function scoreOf(m: WeaponMember, needs: WeaponNeeds, slot: number, w: WeaponDelve, bonuses: readonly ItemBonus[]): number {
    const p = m.sdk.getPlayer()!;
    const c = getClass(p.className, p.realm);
    return weaponScore(weaponValue(w, slot === TwoHand ? needs.level : null), c ? statScore(bonuses, c, p.level) : null);
}

/**
 * What's worn in these hands is worth, by its delve. Off the line it's 0: it swings at spec 1 with no
 * styles, so anything on the line replaces it. A shield is not a weapon here. A worn weapon that
 * won't delve is Infinity: nothing replaces what can't be compared.
 */
async function wornScore(m: WeaponMember, needs: WeaponNeeds, slot: number, out: string[]): Promise<number> {
    let best = 0;
    for (const w of m.sdk.getEquipment().filter(e => handsOf(slot).includes(e.slot))) {
        if (WEAPON_LINES[w.objectType] !== needs.line) continue;
        const r = await weaponActions(m).delveItem(w);
        const facts = r.success ? parseWeaponDelve(r.lines) : null;
        if (!facts) {
            out.push(`delve ${w.name}: ${r.reason ?? 'no weapon lines'}; keeping it`);
            return Infinity;
        }
        best = Math.max(best, scoreOf(m, needs, w.slot, facts, r.bonuses));
    }
    return best;
}

const round = (n: number) => String(Number(n.toFixed(2)));

/**
 * Wear the weapons in the backpack that beat what's worn, on the character's trained line. What the
 * server refuses stays there and isn't tried again in this call, and the next best gets its turn.
 */
export async function wearWeapons(m: WeaponMember, opts: WeaponOptions = {}): Promise<string[]> {
    const p = m.sdk.getPlayer();
    const needs = weaponNeeds(m.sdk.getSkills().specializations);
    if (!p || p.isDead || !needs) return [];
    const out: string[] = [];
    const act = weaponActions(m);
    const settled = new Set<number>();
    for (const hand of handsFor(needs)) {
        for (let tries = 0; tries < MAX_WEAPON_TRIES; tries++) {
            const rows: WeaponRow<InventoryItem>[] = [];
            for (const item of m.sdk.getInventory().filter(i => i.slot >= 40 && i.slot <= 79 && !settled.has(i.slot) && withinLimit(i, p.level, opts))) {
                const to = weaponSlots(item, needs).find(s => handsOf(hand).includes(s));
                if (to === undefined) continue;
                const r = await act.delveItem(item);
                const facts = r.success ? parseWeaponDelve(r.lines) : null;
                if (facts && levelAllows(r.levelRequirement, p.level, opts)) rows.push({ item, slot: to, score: scoreOf(m, needs, to, facts, r.bonuses), price: 0 });
            }
            const current = await wornScore(m, needs, hand, out);
            const pick = bestWeapon(rows, current, WEAPON_SWAP);
            if (!pick) break;
            const r = await act.equipItem(pick.item, { slot: pick.slot });
            settled.add(pick.item.slot);
            if (r.success) {
                out.push(`wield ${pick.item.name}, score ${round(pick.score)} over ${round(current)}`);
                break;
            }
            out.push(`can't wield ${pick.item.name}: ${r.message}`);
        }
    }
    return out;
}

export interface WeaponSeller {
    spawn: NpcSpawnMatch;
    /** What it sells that fits, from static data: this says where to walk. What to buy comes from the window there. */
    weapons: MerchantEntry[];
}

/** The nearest seller of each list with something for these needs, nearest first. Our realm's or none, and only GameMerchant, as nearestCloakSeller. */
export function weaponSellers(p: Pick<PlayerState, 'regionId' | 'x' | 'y' | 'realm' | 'level'>, needs: WeaponNeeds, radius = WEAPON_RADIUS, opts: WeaponOptions = {}): WeaponSeller[] {
    const realm = realmId(p.realm);
    const lists = new Set<string>();
    const out: WeaponSeller[] = [];
    for (const spawn of findNpcSpawns({ regionId: p.regionId, near: p, radius, classType: /^GameMerchant$/ })) {
        const list = spawn.itemsListTemplateId;
        if (!list || lists.has(list) || (spawn.realm !== 0 && spawn.realm !== realm)) continue;
        lists.add(list);
        const weapons = getMerchantItems(list).filter(e => {
            const t = getItemTemplate(e.itemTemplateId);
            return !!t && weaponSlots(t, needs).length > 0 && levelAllows(t.levelRequirement, p.level, opts) && withinLimit(t, p.level, opts) && !foreignTo(realm, list, e);
        });
        if (weapons.length) out.push({ spawn, weapons });
    }
    return out;
}

/**
 * Whether a shop's item is another realm's, which the server won't let on ("You cannot equip an item
 * from another realm!"): 449 of 5,852 weapons on realm merchants, among them Midgard's great axes and
 * war axes, whose templates are Albion's. The window calls them usable and doesn't say the realm, so
 * only the item template can.
 */
function foreignTo(realm: number, list: string, item: Pick<MerchantItem, 'page' | 'slot'>): boolean {
    const entry = getMerchantItems(list).find(e => e.page === item.page && e.slot === item.slot);
    const t = entry && getItemTemplate(entry.itemTemplateId);
    return !!t && t.realm !== 0 && t.realm !== realm;
}

/** Sellers one call walks to. */
const MAX_WEAPON_SELLERS = 3;

/**
 * Buy what beats what's worn by WEAPON_STEP, and wield it. The trained line picks the goods
 * (weaponNeeds), the window says what's usable and what it costs, and each delve what it's worth at
 * this level, so a weapon above the level clamp costs more for nothing and loses to the cheaper one.
 * Game failures come back as log strings; no line, no seller or no step is no purchase. As buyCloak,
 * a caller whose teleport can fail passes `town`: outside CLOAK_TOWN_RANGE it buys nothing.
 */
export async function buyWeapons(m: WeaponMember, opts: WeaponOptions & { town?: { x: number; y: number }; radius?: number; reserve?: number } = {}): Promise<string[]> {
    const p = m.sdk.getPlayer();
    const needs = weaponNeeds(m.sdk.getSkills().specializations);
    if (!p || p.isDead || !needs) return [];
    const sellers = weaponSellers(p, needs, opts.radius, opts).slice(0, MAX_WEAPON_SELLERS);
    if (!sellers.length) return [];
    if (opts.town && Math.hypot(p.x - opts.town.x, p.y - opts.town.y) > CLOAK_TOWN_RANGE) return ['no weapon: not in town'];
    const act = weaponActions(m);
    const out: string[] = [];
    for (const hand of handsFor(needs)) {
        const current = await wornScore(m, needs, hand, out);
        const rows: WeaponRow<{ seller: string; item: MerchantItem }>[] = [];
        let cap = Infinity;
        for (const { spawn: s } of sellers) {
            const here = m.sdk.getPlayer()!;
            if (Math.hypot(here.x - s.x, here.y - s.y) > 300) {
                const w = await act.walkTo(s.x, s.y, { z: s.z, tolerance: 150 });
                if (!w.success) { out.push(`walk to ${s.name}: ${w.reason} ${w.message}`); continue; }
            }
            const shop = await act.openMerchant(s.name);
            if (!shop.success) { out.push(`${s.name}: ${shop.reason} ${shop.message}`); continue; }
            // Only eMerchantWindowType.Normal (0) charges copper. The static data that chose this seller can be older than the server's.
            if (m.sdk.getMerchant()?.windowType) { out.push(`${s.name}: doesn't take copper`); continue; }
            const budget = m.sdk.getPlayer()!.money.totalCopper - (opts.reserve ?? WEAPON_RESERVE);
            const fits = (i: MerchantItem) => weaponSlots(i, needs).find(to => handsOf(hand).includes(to));
            const goods = shop.items.filter(i => i.usable && i.price <= budget && fits(i) !== undefined && withinLimit(i, p.level, opts) && !foreignTo(realmId(p.realm), s.itemsListTemplateId!, i)).sort((a, b) => b.value1 - a.value1);
            let delves = 0;
            for (const item of goods) {
                // Under what's already found, however good: its delve couldn't change the answer.
                if (ceiling(item, needs, cap) * WEAPON_TIE < Math.max(current * WEAPON_STEP, ...rows.map(r => r.score))) continue;
                if (delves++ >= MAX_DELVES) break;
                const r = await act.delveMerchantItem(s.name, { page: item.page, slot: item.slot });
                const facts = r.success ? parseWeaponDelve(r.lines) : null;
                if (!facts) { out.push(`delve ${item.name}: ${r.reason ?? 'no weapon lines'}`); continue; }
                if (!levelAllows(r.levelRequirement, p.level, opts)) continue;
                if (facts.clampedDps < facts.baseDps) cap = Math.min(cap, facts.clampedDps);
                const to = fits(item)!;
                rows.push({ item: { seller: s.name, item }, slot: to, score: scoreOf(m, needs, to, facts, r.bonuses), price: item.price });
            }
        }
        const pick = bestWeapon(rows, current, WEAPON_STEP);
        if (!pick) {
            if (rows.length) out.push(`no weapon step: best ${round(Math.max(...rows.map(r => r.score)))}, worn ${round(current)}`);
            continue;
        }
        const { seller, item } = pick.item;
        const buy = await act.buyItem(seller, { page: item.page, slot: item.slot }, 1);
        if (!buy.success) { out.push(`buy ${item.name}: ${buy.reason} ${buy.message}`); continue; }
        const bought = buy.itemsGained[0];
        const r = bought ? await act.equipItem(bought, { slot: pick.slot }) : null;
        out.push(`bought ${item.name} from ${seller} ${buy.spent}c, score ${round(pick.score)} over ${round(current)}${r?.success ? `, wielded in slot ${pick.slot}` : `; not wielded: ${r?.message ?? 'not in the backpack'}`}`);
    }
    await act.closeMerchant().catch(() => null);
    return out;
}

/** Wear the best from the backpack, then buy what still beats it. */
export async function weaponUpgrades(m: WeaponMember, opts: Parameters<typeof buyWeapons>[1] = {}): Promise<string[]> {
    return [...await wearWeapons(m, opts), ...await buyWeapons(m, opts)];
}
