// Looking after gear in town, for every realm's town visit: repairing what wears at a smith, and
// keeping what's too high to wear in the vault instead of selling it. See learnings/gear-care.md.
//
// What's worth repairing and what's too high is in gear-score.ts (pure). Game failures come back as
// log strings, as with buyCloak; no smith or keeper within reach is a line when something waits for one.

import { findNpcSpawns, getClass, getSpecialization, realmId, type NpcSpawnMatch } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { isArmor, isWeapon, ObjectType, type InventoryItem, type PlayerState } from '../types';
import { accessorySlots, CLOAK_RADIUS, CLOAK_RESERVE, CLOAK_TOWN_RANGE } from './gear';
import { REPAIR_BELOW, tooHighLevel, wornDown } from './gear-score';

/** How far a town visit walks to a smith or vault keeper, as for a cloak. */
export const CARE_RADIUS = CLOAK_RADIUS;
/** Copper a repair leaves in the purse, as a cloak does. */
export const REPAIR_RESERVE = CLOAK_RESERVE;

type CareActions = Pick<BotActions, 'repairItem' | 'repairAll' | 'openVault' | 'depositItem' | 'withdrawItem' | 'walkTo'>;
/** A group member (`actions`) or a party member (`bot`), as GearMember. */
export type CareMember = { sdk: Pick<BotSDK, 'getEquipment' | 'getInventory' | 'getPlayer' | 'getVault' | 'getFreeInventorySlots' | 'getState'> } & ({ actions: CareActions } | { bot: CareActions });

const actionsOf = (m: CareMember) => ('actions' in m ? m.actions : m.bot);
const backpackOf = (m: Pick<CareMember, 'sdk'>) => m.sdk.getInventory().filter(i => i.slot >= 40 && i.slot <= 79);

/** Weapons, armour and shields a smith takes in hand, where wear shows and matters (Blacksmith.cs:116-126). */
const givable = (i: Pick<InventoryItem, 'objectType'>) => isWeapon(i.objectType) || isArmor(i.objectType) || i.objectType === ObjectType.Shield;
/** Everything with a level that goes on the character: what a level limit can apply to. */
const wearable = (i: Pick<InventoryItem, 'name' | 'objectType'>) => givable(i) || i.objectType === ObjectType.Instrument || accessorySlots(i).length > 0;

export interface CareOptions {
    /** Worn below this reading gets repaired (default REPAIR_BELOW). */
    repairBelow?: number;
    /** Too high above this con (default GEAR_MAX_CON). */
    maxCon?: number;
    /** How far to walk (default CARE_RADIUS). */
    radius?: number;
    /** Copper left in the purse (default REPAIR_RESERVE). */
    reserve?: number;
    /** The landing point of a teleport that can fail: outside CLOAK_TOWN_RANGE of it, nothing happens. */
    town?: { x: number; y: number };
}

/** The ability a weapon or shield asks of a class (AbstractServerRules.cs CheckAbilityToUseItem, with allow_cross_realm_items off); any one of a list will do. */
const ABILITY_FOR: Partial<Record<number, readonly string[]>> = {
    [ObjectType.CrushingWeapon]: ['Weaponry: Crushing'], [ObjectType.SlashingWeapon]: ['Weaponry: Slashing'], [ObjectType.ThrustWeapon]: ['Weaponry: Thrusting'],
    [ObjectType.Fired]: ['Weaponry: Shortbows'], [ObjectType.TwoHandedWeapon]: ['Weaponry: Two Handed'], [ObjectType.PolearmWeapon]: ['Weaponry: Polearms'],
    [ObjectType.Staff]: ['Weaponry: Staves'], [ObjectType.Longbow]: ['Weaponry: Longbows', 'Weaponry: Archery'], [ObjectType.Crossbow]: ['Weaponry: Crossbow'], [ObjectType.Flexible]: ['Weaponry: Flexible'],
    [ObjectType.Sword]: ['Weaponry: Swords'], [ObjectType.Hammer]: ['Weaponry: Hammers'], [ObjectType.Axe]: ['Weaponry: Axes'], [ObjectType.LeftAxe]: ['Weaponry: Axes'],
    [ObjectType.Spear]: ['Weaponry: Spears'], [ObjectType.CompositeBow]: ['Weaponry: Composite Bows', 'Weaponry: Archery'], [ObjectType.Thrown]: ['Weaponry: Thrown'], [ObjectType.HandToHand]: ['Weaponry: Hand to Hand'],
    [ObjectType.RecurvedBow]: ['Weaponry: Recurved Bows', 'Weaponry: Archery'], [ObjectType.Blades]: ['Weaponry: Blades'], [ObjectType.Blunt]: ['Weaponry: Blunt'], [ObjectType.Piercing]: ['Weaponry: Piercing'],
    [ObjectType.LargeWeapons]: ['Weaponry: Large Weapons'], [ObjectType.CelticSpear]: ['Weaponry: Celtic Spears'], [ObjectType.Scythe]: ['Weaponry: Scythe'],
    [ObjectType.FistWraps]: ['Weaponry: Fist Wraps'], [ObjectType.MaulerStaff]: ['Weaponry: Mauler Staff'], [ObjectType.Shield]: ['Shield'], [ObjectType.Instrument]: ['Weaponry: Instruments'],
};
/** ArmorLevel: the realm's armour ability must reach this. A character's realm decides which ability that is, so any of the three in the class's own data. */
const ARMOR_LEVEL: Partial<Record<number, number>> = {
    [ObjectType.Cloth]: 1, [ObjectType.Leather]: 2, [ObjectType.Studded]: 3, [ObjectType.Reinforced]: 3, [ObjectType.Chain]: 4, [ObjectType.Scale]: 4, [ObjectType.Plate]: 5,
};
const ARMOR_ABILITY = /^(Alb|Hib|Mid)Armor$/;

const classAbilities = new Map<string, Map<string, number> | null>();
/** Every ability a class gets at any level, with a base class's advanced classes, because it may yet promote; null without class data. */
function abilitiesOf(p: Pick<PlayerState, 'className' | 'realm'>): Map<string, number> | null {
    const key = `${p.realm}:${p.className}`;
    if (classAbilities.has(key)) return classAbilities.get(key)!;
    const c = getClass(p.className, p.realm);
    let out: Map<string, number> | null = null;
    if (c) {
        out = new Map();
        for (const cls of [c, ...c.advancedClassIds.map(id => getClass(id)).filter(a => !!a)]) {
            for (const s of cls!.specializations) {
                for (const a of getSpecialization(s.spec)?.abilities ?? []) out.set(a.abilityKey, Math.max(out.get(a.abilityKey) ?? 0, a.abilityLevel));
            }
        }
    }
    classAbilities.set(key, out);
    return out;
}

/** Whether this class could ever use the item, going by its type alone, as the server does. Without class data, yes: the server still has the last word. */
export function classCouldUse(item: Pick<InventoryItem, 'objectType'>, p: Pick<PlayerState, 'className' | 'realm'>): boolean {
    const abilities = abilitiesOf(p);
    if (!abilities) return true;
    const armor = ARMOR_LEVEL[item.objectType];
    if (armor !== undefined) return [...abilities].some(([key, level]) => ARMOR_ABILITY.test(key) && level >= armor);
    const needs = ABILITY_FOR[item.objectType];
    return !needs || needs.some(a => abilities.has(a));
}

/**
 * Gear to keep for later rather than sell: this character will wear it one day, but not yet. Half a
 * sell filter: being in the vault can't be the only protection, because a keeper may be out of reach and a
 * restart can undo a move. What the class can never use isn't kept: it sells, as loot should.
 */
export const keepForLater = (item: Pick<InventoryItem, 'name' | 'objectType' | 'level'>, p: Pick<PlayerState, 'level' | 'className' | 'realm'>, opts: Pick<CareOptions, 'maxCon'> = {}) =>
    wearable(item) && tooHighLevel(item, p.level, opts.maxCon) && classCouldUse(item, p);

/** What's worn that a smith should see: the lowest reading first. */
export function needsRepair(m: Pick<CareMember, 'sdk'>, opts: Pick<CareOptions, 'repairBelow'> = {}): InventoryItem[] {
    return m.sdk.getEquipment().filter(i => wornDown(i, opts.repairBelow ?? REPAIR_BELOW)).sort((a, b) => a.condition - b.condition);
}

/** What's in the vault and fits now, as far as this client has seen the vault. */
const fitsNow = (m: Pick<CareMember, 'sdk'>, level: number, opts: Pick<CareOptions, 'maxCon'>) => m.sdk.getVault().filter(i => wearable(i) && !tooHighLevel(i, level, opts.maxCon));

/**
 * Whether a keeper is worth a trip: gear in the backpack to put away, or gear in the vault that fits
 * now. A client that hasn't opened the vault since it started doesn't know the second.
 */
export function vaultDue(m: Pick<CareMember, 'sdk'>, opts: Pick<CareOptions, 'maxCon'> = {}): boolean {
    const p = m.sdk.getPlayer();
    return !!p && (backpackOf(m).some(i => keepForLater(i, p, opts)) || fitsNow(m, p.level, opts).length > 0);
}

/** Whether a town visit is due for gear: a keeper is worth a trip, or something worn needs a smith and the purse can pay one. */
export function careDue(m: Pick<CareMember, 'sdk'>, opts: Pick<CareOptions, 'repairBelow' | 'maxCon' | 'reserve'> = {}): boolean {
    const p = m.sdk.getPlayer();
    return !!p && (vaultDue(m, opts) || (needsRepair(m, opts).length > 0 && p.money.totalCopper > (opts.reserve ?? REPAIR_RESERVE)));
}

/** Nearest spawn of this class, of our realm or none: region 165 has them for all three. */
function nearest(p: Pick<PlayerState, 'regionId' | 'x' | 'y' | 'realm'>, classType: RegExp, radius: number): NpcSpawnMatch | null {
    const realm = realmId(p.realm);
    return findNpcSpawns({ regionId: p.regionId, near: p, radius, classType }).find(s => s.realm === 0 || s.realm === realm) ?? null;
}
export const nearestSmith = (p: Pick<PlayerState, 'regionId' | 'x' | 'y' | 'realm'>, radius = CARE_RADIUS) => nearest(p, /^Blacksmith$/, radius);
/** The personal vault's keeper; an AccountVaultKeeper has another store, with another window. */
export const nearestVaultKeeper = (p: Pick<PlayerState, 'regionId' | 'x' | 'y' | 'realm'>, radius = CARE_RADIUS) => nearest(p, /^GameVaultKeeper$/, radius);

const outOfTown = (p: Pick<PlayerState, 'x' | 'y'>, opts: CareOptions) => !!opts.town && Math.hypot(p.x - opts.town.x, p.y - opts.town.y) > CLOAK_TOWN_RANGE;

/** Walk to a spawn unless we stand near it already; a failure comes back as its line. */
async function goTo(m: CareMember, s: NpcSpawnMatch): Promise<string | null> {
    const p = m.sdk.getPlayer()!;
    if (Math.hypot(p.x - s.x, p.y - s.y) <= 300) return null;
    const w = await actionsOf(m).walkTo(s.x, s.y, { z: s.z, tolerance: 100 });
    return w.success ? null : `walk to ${s.name}: ${w.reason} ${w.message}`;
}

/**
 * Repair what's worn below `repairBelow`, the lowest first, one at a time, each within what the purse
 * can spare: "repair all" costs 20 % more and takes spares along. An instrument is the exception,
 * which only "repair all" takes, and then at that price for anything else still worn, the vault's
 * included. Run it last in a visit: with `town` set, a far smith can leave the next step out of town
 * (Jordheim's nearest is 5,732 from the landing).
 */
export async function repairGear(m: CareMember, opts: CareOptions = {}): Promise<string[]> {
    const p = m.sdk.getPlayer();
    if (!p || p.isDead) return [];
    const due = needsRepair(m, opts);
    if (!due.length) return [];
    const smith = nearestSmith(p, opts.radius);
    const names = due.map(i => `${i.name} ${i.condition}%`).join(', ');
    if (!smith) return [`no smith within ${opts.radius ?? CARE_RADIUS}: ${names}`];
    if (outOfTown(p, opts)) return ['no repair: not in town'];
    const walked = await goTo(m, smith);
    if (walked) return [walked];

    const act = actionsOf(m);
    const budget = () => m.sdk.getPlayer()!.money.totalCopper - (opts.reserve ?? REPAIR_RESERVE);
    const out: string[] = [];
    let spent = 0;
    for (const item of due.filter(givable)) {
        const r = await act.repairItem(smith.name, item, { maxCost: Math.max(0, budget()) });
        spent += r.cost;
        if (r.success) out.push(`repaired ${item.name} ${item.condition}% -> ${r.repaired?.condition ?? '?'}% for ${r.cost}c (durability ${r.repaired?.durability ?? '?'}%)`);
        else out.push(`can't repair ${item.name}: ${r.reason} ${r.message}`);
    }
    if (due.some(i => !givable(i))) {
        const r = await act.repairAll(smith.name, { maxCost: Math.max(0, budget()) });
        spent += r.cost;
        out.push(r.success ? `repaired ${due.filter(i => !givable(i)).map(i => i.name).join(', ')} with "repair all" for ${r.cost}c` : `"repair all": ${r.reason} ${r.message}`);
    }
    if (spent) out.push(`repairs: ${spent}c at ${smith.name}`);
    return out;
}

/** To the nearest keeper and open the vault; the keeper's name, or the line saying why not. */
async function atVault(m: CareMember, opts: CareOptions, waiting: string): Promise<{ keeper: string } | { line: string | null }> {
    const p = m.sdk.getPlayer()!;
    const keeper = nearestVaultKeeper(p, opts.radius);
    if (!keeper) return { line: waiting && `no vault keeper within ${opts.radius ?? CARE_RADIUS}: ${waiting}` };
    if (outOfTown(p, opts)) return { line: 'no vault: not in town' };
    const walked = await goTo(m, keeper);
    if (walked) return { line: walked };
    const open = await actionsOf(m).openVault(keeper.name);
    return open.success ? { keeper: keeper.name } : { line: `vault at ${keeper.name}: ${open.reason} ${open.message}` };
}

/**
 * Take out of the vault what the character has grown into, for the gear pass and then the sale to
 * judge like any other loot. Call it before them. A vault not seen in this client session is worth
 * one look when a keeper is in reach: a client knows nothing of it until then.
 */
export async function takeFromVault(m: CareMember, opts: CareOptions = {}): Promise<string[]> {
    const p = m.sdk.getPlayer();
    if (!p || p.isDead) return [];
    const fits = () => fitsNow(m, p.level, opts);
    if (m.sdk.getState()?.vaultOpenedAt != null && !fits().length) return [];
    const at = await atVault(m, opts, fits().length ? `waiting in the vault: ${fits().map(i => i.name).join(', ')}` : '');
    if ('line' in at) return at.line ? [at.line] : [];
    const out: string[] = [];
    for (const item of fits()) {
        const r = await actionsOf(m).withdrawItem(at.keeper, item);
        out.push(r.success ? `took ${item.name} L${item.level} out of the vault` : `can't take ${item.name} out of the vault: ${r.reason} ${r.message}`);
        if (!r.success) break;
    }
    return out;
}

/**
 * Put what's too high to wear in the vault. Call it after the gear pass: it may take off a piece,
 * and jewellery, which doesn't wear, gets its chance to go on first. What's left in the backpack,
 * with no keeper in reach or a full vault, stays unsellable through keepForLater.
 */
export async function stashInVault(m: CareMember, opts: CareOptions = {}): Promise<string[]> {
    const p = m.sdk.getPlayer();
    if (!p || p.isDead) return [];
    const stash = backpackOf(m).filter(i => keepForLater(i, p, opts));
    if (!stash.length) return [];
    const at = await atVault(m, opts, `keeping ${stash.map(i => i.name).join(', ')}`);
    if ('line' in at) return at.line ? [at.line] : [];
    const out: string[] = [];
    for (const item of stash) {
        const r = await actionsOf(m).depositItem(at.keeper, item);
        out.push(r.success ? `put ${item.name} L${item.level} in the vault` : `can't put ${item.name} in the vault: ${r.reason} ${r.message}`);
        if (!r.success) break;
    }
    return out;
}
