// A full gear template for one level: custom ItemTemplate rows, one set per class, that reach the
// server's item caps. See learnings/gear-template.md.
//
// What a member wears comes from its class and the trained lines of its build target, so the rows
// are a pure function of those. They reach the shared DB through a SQL file beside the group's script;
// a GM makes the items and trades them over, since Thidranki has no merchant.
//
// ItemTemplate is precached at server start and FindObjectByKey reads only that cache
// (ObjectDatabase.cs:738-739), so a new row needs `/item loadpackage` (item.cs "loadpackage") before
// `/item create` can see it. No restart.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { getClass, realmId } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { parseWeaponDelve } from '../delve';
import { EquipmentSlot, isArmor, ObjectType, type InventoryItem, type ItemBonus, type Realm } from '../types';
import { bonusCap, isTemplatePiece, TEMPLATE_PREFIX } from './gear-score';
import { connectBot } from './roster';

export { isTemplatePiece, TEMPLATE_PREFIX };

/** PackageID on every row: `/item loadpackage` takes them all at once. */
export const TEMPLATE_PACKAGE = 'thidranki24';
/** The GM account's bot, kept at PrivLevel 1 between uses. */
export const GM_BOT = 'gmlevel';

// eProperty.cs
const STAT = { STR: 1, DEX: 2, CON: 3, QUI: 4, INT: 5, PIE: 6, EMP: 7, CHA: 8 } as const;
type Stat = keyof typeof STAT;
const MAX_MANA = 9, MAX_HEALTH = 10, ARMOR_FACTOR = 148, ALL_FOCUS_LEVELS = 165, POWER_POOL = 196;
const RESISTS = { Body: 11, Cold: 12, Crush: 13, Energy: 14, Heat: 15, Matter: 16, Slash: 17, Spirit: 18, Thrust: 19 } as const;
/** A build's line name to its skill property, for the classes in CLASS_KITS. */
export const SKILL_PROPERTY: Record<string, number> = {
    Axe: 54, Shields: 43, Parry: 40, Mending: 57, Augmentation: 58, Pacification: 94, Subterranean: 85, Battlesongs: 69,
    Darkness: 60, Suppression: 61, Summoning: 98, Chants: 22, Slash: 44, Enhancement: 30, Rejuvenation: 42,
    'Mind Magic': 38, 'Body Magic': 21, 'Matter Magic': 37, 'Spirit Magic': 47, 'Cold Magic': 34, 'Earth Magic': 29, 'Wind Magic': 51,
    Blades: 72, Regrowth: 77, Nurture: 78, Music: 80, Light: 65, Mentalism: 76, Mana: 67,
    // The bench classes (2026-11-10): eProperty.cs Skill_*.
    Polearm: 41, 'Two Handed': 20, Staff: 48, Hammer: 53, 'Left Axe': 55, Stormcalling: 63, Runecarving: 62,
    'Celtic Dual': 81, Blunt: 73, 'Fire Magic': 32,
};
/** A skill bonus is wasted on a line left at 1. */
const TRAINED = 2;

/** The most that counts at this level: bonusCap's, plus what caps an armour piece and a weapon. */
export function levelCaps(level: number) {
    return {
        stat: bonusCap({ category: 'stat' }, level),
        hits: bonusCap({ category: 'hits' }, level),
        resist: bonusCap({ category: 'resist' }, level),
        skill: bonusCap({ category: 'skill' }, level),
        power: bonusCap({ category: 'power' }, level),
        powerPool: bonusCap({ category: 'powerPool' }, level),
        armorFactor: bonusCap({ category: 'armorFactor' }, level),
        /** Item AF, before quality: GamePlayer.GetArmorFactorCap. */
        itemAf: level * 2,
        clothAf: level,
        /** DPS x 10, as DPS_AF holds it, before quality: GamePlayer.GetWeaponDpsCap. */
        dpsAf: Math.round((1.2 + 0.3 * level) * 10),
    };
}

/** What each class wears and swings. Its bonuses follow from this and its build. */
interface ClassKit {
    armor: number;
    /** Stats worth the cap: what drives its damage or casting, DEX a caster's speed, CON everyone's hits. */
    stats: readonly Stat[];
    mainHand?: number;
    twoHand?: number;
    /** Type_Damage on a shield is its size. */
    shield?: 1 | 2 | 3;
    /** A weapon for the left hand, for a dual wielder (instead of a shield). */
    offHand?: number;
    /** A staff is a focus, unless the class swings it (a Friar). */
    focus?: false;
}
const { Chain, Plate, Scale, Reinforced, Studded, Leather, Cloth, Axe, Hammer, SlashingWeapon, CrushingWeapon, Blades, Blunt, Staff, PolearmWeapon, LeftAxe } = ObjectType;
const MELEE = ['STR', 'DEX', 'CON', 'QUI'] as const;
const SMALL = 1, MEDIUM = 2, LARGE = 3;
export const CLASS_KITS: Record<string, ClassKit> = {
    Warrior: { armor: Chain, stats: MELEE, mainHand: Axe, shield: LARGE },
    Skald: { armor: Chain, stats: [...MELEE, 'CHA'], mainHand: Axe, twoHand: Axe, shield: SMALL },
    Healer: { armor: Chain, stats: ['PIE', 'DEX', 'CON'], mainHand: Hammer, shield: SMALL },
    Shaman: { armor: Chain, stats: ['PIE', 'DEX', 'CON'], mainHand: Hammer, shield: SMALL },
    Spiritmaster: { armor: Cloth, stats: ['PIE', 'DEX', 'CON'], twoHand: Staff },
    Paladin: { armor: Plate, stats: [...MELEE, 'PIE'], mainHand: SlashingWeapon, shield: LARGE },
    Cleric: { armor: Chain, stats: ['PIE', 'DEX', 'CON'], mainHand: CrushingWeapon, shield: MEDIUM },
    Sorcerer: { armor: Cloth, stats: ['INT', 'DEX', 'CON'], twoHand: Staff },
    Cabalist: { armor: Cloth, stats: ['INT', 'DEX', 'CON'], twoHand: Staff },
    Theurgist: { armor: Cloth, stats: ['INT', 'DEX', 'CON'], twoHand: Staff },
    Hero: { armor: Scale, stats: MELEE, mainHand: Blades, shield: LARGE },
    Druid: { armor: Scale, stats: ['EMP', 'DEX', 'CON'], mainHand: Blunt, shield: SMALL },
    Bard: { armor: Reinforced, stats: ['CHA', 'DEX', 'CON'], mainHand: Blunt, shield: SMALL },
    Mentalist: { armor: Cloth, stats: ['INT', 'DEX', 'CON'], twoHand: Staff },
    Enchanter: { armor: Cloth, stats: ['INT', 'DEX', 'CON'], twoHand: Staff },
    // The bench classes (2026-11-10). Armour: the best the class's AlbArmor/HibArmor/MidArmor ability reaches by 24
    // (data/generated/specializations.json): Armsman plate at 15, Friar the Acolyte's leather, Blademaster the Guardian's
    // reinforced, Warden scale at 20, Berserker the Viking's studded, Thane chain at 12. Shield sizes from the Shield ability.
    // Armsman: a slash polearm held (its floor reads Slash, data/builds/armsman.ts), sword and large shield in the bag.
    Armsman: { armor: Plate, stats: MELEE, mainHand: SlashingWeapon, twoHand: PolearmWeapon, shield: LARGE },
    Friar: { armor: Leather, stats: [...MELEE, 'PIE'], twoHand: Staff, focus: false },
    Wizard: { armor: Cloth, stats: ['INT', 'DEX', 'CON'], twoHand: Staff },
    // Celtic Dual 21 is the build's damage; its Shields 13 has no Slam yet (42), so a second blade over a shield.
    Blademaster: { armor: Reinforced, stats: MELEE, mainHand: Blades, offHand: Blades },
    Warden: { armor: Scale, stats: ['EMP', 'DEX', 'CON'], mainHand: Blades, shield: MEDIUM },
    Eldritch: { armor: Cloth, stats: ['INT', 'DEX', 'CON'], twoHand: Staff },
    Berserker: { armor: Studded, stats: MELEE, mainHand: Hammer, offHand: LeftAxe },
    Thane: { armor: Chain, stats: [...MELEE, 'PIE'], mainHand: Hammer, shield: MEDIUM },
    Runemaster: { armor: Cloth, stats: ['PIE', 'DEX', 'CON'], twoHand: Staff },
};

const ARMOR_SLOTS = [EquipmentSlot.Head, EquipmentSlot.Hands, EquipmentSlot.Feet, EquipmentSlot.Torso, EquipmentSlot.Legs, EquipmentSlot.Arms] as const;
const ARMOR_NAMES = ['Helm', 'Gloves', 'Boots', 'Hauberk', 'Leggings', 'Sleeves'];
/** Each piece's resists, one piece to a resist so that a delve reads plainly. */
const ARMOR_RESISTS: (keyof typeof RESISTS)[][] = [['Crush', 'Slash'], ['Thrust', 'Heat'], ['Cold'], ['Matter', 'Body'], ['Spirit'], ['Energy']];
const ARMOR_ABS: Record<number, number> = { [Cloth]: 0, [Leather]: 10, [Studded]: 19, [Chain]: 27, [Scale]: 27, [Reinforced]: 19, [Plate]: 34 };
/** About half of real weights: a replaced set rides in the backpack until the next sale. */
const ARMOR_WEIGHT = [16, 16, 16, 40, 28, 24];
const CLOTH_WEIGHT = 10;
/** By armour type and realm, in ARMOR_SLOTS order, from the DB's own sets. */
const MODELS: Record<string, readonly number[]> = {
    [`${Cloth}/albion`]: [822, 142, 143, 378, 379, 380],
    [`${Cloth}/midgard`]: [825, 248, 249, 245, 246, 247],
    [`${Cloth}/hibernia`]: [826, 381, 382, 378, 379, 380],
    [`${Chain}/albion`]: [63, 44, 45, 41, 42, 43],
    [`${Chain}/midgard`]: [834, 278, 279, 275, 276, 277],
    [`${Plate}/albion`]: [93, 89, 90, 46, 87, 88],
    [`${Scale}/hibernia`]: [840, 431, 432, 428, 429, 430],
    [`${Reinforced}/hibernia`]: [835, 386, 387, 383, 384, 385],
    // The most common model per slot in data/generated/items.json.
    [`${Leather}/albion`]: [62, 137, 138, 134, 37, 136],
    [`${Studded}/midgard`]: [831, 273, 274, 270, 271, 272],
};
const MAIN_HANDS: Record<number, WeaponLook> = {
    [Axe]: { model: 319, speed: 38, weight: 30, damage: 2, name: 'Axe' },
    [Hammer]: { model: 320, speed: 40, weight: 35, damage: 1, name: 'Hammer' },
    [SlashingWeapon]: { model: 10, speed: 37, weight: 30, damage: 2, name: 'Sword' },
    [CrushingWeapon]: { model: 451, speed: 38, weight: 30, damage: 1, name: 'Mace' },
    [Blades]: { model: 473, speed: 37, weight: 30, damage: 2, name: 'Blade' },
    [Blunt]: { model: 461, speed: 35, weight: 30, damage: 1, name: 'Club' },
};
const TWO_HANDS: Record<number, WeaponLook> = {
    [Axe]: { model: 9, speed: 52, weight: 45, damage: 2, name: 'Greataxe' },
    [Staff]: { model: 19, speed: 46, weight: 45, damage: 1, name: 'Staff' },
    [PolearmWeapon]: { model: 68, speed: 48, weight: 50, damage: 2, name: 'Halberd' },
};
/** Left-hand weapons, Hand 2, from the DB's most common looks. */
const OFF_HANDS: Record<number, WeaponLook> = {
    [LeftAxe]: { model: 316, speed: 27, weight: 25, damage: 2, name: 'Left Axe' },
    [Blades]: { model: 444, speed: 27, weight: 18, damage: 2, name: 'Offhand Blade' },
};
interface WeaponLook { model: number; speed: number; weight: number; damage: number; name: string }
const SHIELDS = {
    [SMALL]: { model: 59, speed: 28, weight: 20, name: 'Small Shield' },
    [MEDIUM]: { model: 61, speed: 38, weight: 28, name: 'Medium Shield' },
    [LARGE]: { model: 60, speed: 48, weight: 35, name: 'Large Shield' },
};
/** The stats and side bonuses spread over these. A name's last word is what accessorySlots knows it by. */
const ACCESSORIES = [
    { slot: EquipmentSlot.Cloak, itemType: EquipmentSlot.Cloak, name: 'Cloak', model: 557, weight: 8 },
    { slot: EquipmentSlot.Neck, itemType: EquipmentSlot.Neck, name: 'Pendant', model: 101, weight: 2 },
    { slot: EquipmentSlot.Jewelry, itemType: EquipmentSlot.Jewelry, name: 'Jewel', model: 117, weight: 1 },
    { slot: EquipmentSlot.Waist, itemType: EquipmentSlot.Waist, name: 'Belt', model: 597, weight: 4 },
    { slot: EquipmentSlot.LeftBracer, itemType: EquipmentSlot.LeftBracer, name: 'Left Bracer', model: 598, weight: 4 },
    { slot: EquipmentSlot.RightBracer, itemType: EquipmentSlot.LeftBracer, name: 'Right Bracer', model: 598, weight: 4 },
    { slot: EquipmentSlot.LeftRing, itemType: EquipmentSlot.LeftRing, name: 'Left Ring', model: 103, weight: 1 },
    { slot: EquipmentSlot.RightRing, itemType: EquipmentSlot.LeftRing, name: 'Right Ring', model: 103, weight: 1 },
];
/** Bonus1..Bonus10 and ExtraBonus. */
export const MAX_BONUSES = 11;

export interface TemplateBonus { property: number; value: number }
export interface TemplatePiece {
    /** Id_nb: t24_<class>_<slot>. */
    id: string;
    name: string;
    /** The worn slot it goes in. */
    slot: number;
    itemType: number;
    objectType: number;
    level: number;
    dpsAf: number;
    spdAbs: number;
    hand: number;
    damageType: number;
    weight: number;
    model: number;
    realm: number;
    bonuses: TemplateBonus[];
}

/** `total` over `n` pieces as evenly as whole numbers go. */
const evenly = (total: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));

/** A class's whole template at a level, for the lines its build target trains. */
export function templateFor(shownName: string, realm: Realm, level: number, specs: Record<string, number>): TemplatePiece[] {
    const classInfo = getClass(shownName, realm);
    // A female character's class shows under its female name (Armswoman, Sorceress): the kit goes by the class.
    const className = classInfo?.name ?? shownName;
    const kit = CLASS_KITS[className];
    if (!kit || !classInfo) throw new Error(`no gear template for ${className}`);
    const models = MODELS[`${kit.armor}/${realm}`];
    if (!models) throw new Error(`no armour models for type ${kit.armor} in ${realm}`);
    const caps = levelCaps(level);
    const base = { level, realm: realmId(realm), dpsAf: 0, spdAbs: 0, hand: 0, damageType: 0 };
    const id = (slot: number) => `t${level}_${className.toLowerCase()}_${slot}`;
    const label = `${TEMPLATE_PREFIX}${className}`;

    const hits = evenly(caps.hits, ARMOR_SLOTS.length);
    const armor: TemplatePiece[] = ARMOR_SLOTS.map((slot, i) => ({
        ...base, id: id(slot), slot, itemType: slot, objectType: kit.armor, name: `${label} ${ARMOR_NAMES[i]}`,
        dpsAf: kit.armor === Cloth ? caps.clothAf : caps.itemAf, spdAbs: ARMOR_ABS[kit.armor]!,
        weight: kit.armor === Cloth ? CLOTH_WEIGHT : ARMOR_WEIGHT[i]!, model: models[i]!,
        bonuses: [{ property: MAX_HEALTH, value: hits[i]! }, ...ARMOR_RESISTS[i]!.map(r => ({ property: RESISTS[r], value: caps.resist }))],
    }));

    const accessories: TemplatePiece[] = ACCESSORIES.map(a => ({
        ...base, id: id(a.slot), slot: a.slot, itemType: a.itemType, objectType: ObjectType.Magical, name: `${label} ${a.name}`, weight: a.weight, model: a.model, bonuses: [],
    }));
    // Dealt round the accessories, so none fills up first. Each stat in two halves.
    let next = 0;
    const deal = (property: number, value: number) => { accessories[next++ % accessories.length]!.bonuses.push({ property, value }); };
    for (const stat of kit.stats) for (const v of evenly(caps.stat, 2)) deal(STAT[stat], v);
    for (const [line, spec] of Object.entries(specs)) {
        if (spec < TRAINED) continue;
        const property = SKILL_PROPERTY[line];
        if (property === undefined) throw new Error(`no skill property for line ${line}`);
        deal(property, caps.skill);
    }
    deal(ARMOR_FACTOR, caps.armorFactor);
    if (classInfo.manaStat) { deal(MAX_MANA, caps.power); deal(POWER_POOL, caps.powerPool); }

    const weapons: TemplatePiece[] = [];
    if (kit.mainHand) {
        const w = MAIN_HANDS[kit.mainHand]!;
        weapons.push({ ...base, id: id(EquipmentSlot.RightHand), slot: EquipmentSlot.RightHand, itemType: EquipmentSlot.RightHand, objectType: kit.mainHand, name: `${label} ${w.name}`, dpsAf: caps.dpsAf, spdAbs: w.speed, damageType: w.damage, weight: w.weight, model: w.model, bonuses: [] });
    }
    if (kit.shield) {
        const s = SHIELDS[kit.shield];
        weapons.push({ ...base, id: id(EquipmentSlot.LeftHand), slot: EquipmentSlot.LeftHand, itemType: EquipmentSlot.LeftHand, objectType: ObjectType.Shield, name: `${label} ${s.name}`, dpsAf: caps.dpsAf, spdAbs: s.speed, hand: 2, damageType: kit.shield, weight: s.weight, model: s.model, bonuses: [] });
    }
    if (kit.offHand) {
        if (kit.shield) throw new Error(`${className}: a shield and an off-hand weapon share the left hand`);
        const w = OFF_HANDS[kit.offHand]!;
        weapons.push({ ...base, id: id(EquipmentSlot.LeftHand), slot: EquipmentSlot.LeftHand, itemType: EquipmentSlot.LeftHand, objectType: kit.offHand, name: `${label} ${w.name}`, dpsAf: caps.dpsAf, spdAbs: w.speed, hand: 2, damageType: w.damage, weight: w.weight, model: w.model, bonuses: [] });
    }
    if (kit.twoHand) {
        const w = TWO_HANDS[kit.twoHand]!;
        // A focus at a spell's level gives the full discount (SpellHandler.cs:1204-1222), and no spell of a line goes above the character's level.
        const focus = kit.twoHand === Staff && kit.focus !== false ? [{ property: ALL_FOCUS_LEVELS, value: level }] : [];
        weapons.push({ ...base, id: id(EquipmentSlot.TwoHand), slot: EquipmentSlot.TwoHand, itemType: EquipmentSlot.TwoHand, objectType: kit.twoHand, name: `${label} ${w.name}`, dpsAf: caps.dpsAf, spdAbs: w.speed, hand: 1, damageType: w.damage, weight: w.weight, model: w.model, bonuses: focus });
    }
    return [...armor, ...accessories, ...weapons];
}

/** Sum of each bonus property over a template. */
export function templateTotals(pieces: readonly Pick<TemplatePiece, 'bonuses'>[]): Map<number, number> {
    const totals = new Map<number, number>();
    for (const p of pieces) for (const b of p.bonuses) totals.set(b.property, (totals.get(b.property) ?? 0) + b.value);
    return totals;
}

const quote = (v: string | number) => (typeof v === 'number' ? String(v) : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
/** Condition and durability pool, as on the DB's own armour. */
const POOL = 50_000;
const QUALITY = 100;

/** INSERT for the rows. The ids are ours, so a second run updates only them. */
export function templateSql(pieces: readonly TemplatePiece[]): string {
    const numbered = (suffix: string) => [...Array.from({ length: 10 }, (_, i) => `Bonus${i + 1}${suffix}`), `ExtraBonus${suffix}`];
    const columns = ['Id_nb', 'ItemTemplate_ID', 'Name', 'Level', 'BonusLevel', 'Durability', 'MaxDurability', '`Condition`', 'MaxCondition', 'Quality', 'DPS_AF', 'SPD_ABS', 'Hand', 'Type_Damage', 'Object_Type', 'Item_Type', 'Weight', 'Model',
        ...numbered(''), ...numbered('Type'), 'IsPickable', 'IsDropable', 'IsTradable', 'MaxCount', 'PackSize', 'Realm', 'PackageID', 'AllowedClasses'];
    const rows = pieces.map(p => {
        if (p.bonuses.length > MAX_BONUSES) throw new Error(`${p.name}: ${p.bonuses.length} bonuses, a row holds ${MAX_BONUSES}`);
        const slots = Array.from({ length: MAX_BONUSES }, (_, i) => p.bonuses[i] ?? { property: 0, value: 0 });
        const values = [p.id, p.id, p.name, p.level, p.level, POOL, POOL, POOL, POOL, QUALITY, p.dpsAf, p.spdAbs, p.hand, p.damageType, p.objectType, p.itemType, p.weight, p.model,
            ...slots.map(s => s.value), ...slots.map(s => s.property), 1, 1, 1, 1, 1, p.realm, TEMPLATE_PACKAGE, ''];
        return `(${values.map(quote).join(', ')})`;
    });
    const update = columns.filter(c => c !== 'Id_nb' && c !== 'ItemTemplate_ID').map(c => `${c} = VALUES(${c})`).join(', ');
    return `INSERT INTO itemtemplate (${columns.join(', ')}) VALUES\n${rows.join(',\n')}\nON DUPLICATE KEY UPDATE ${update};\n`;
}

/** Armour and accessories first, two-hander last: wielding brings a hand out (GamePlayerInventory.cs:547-560), so that one ends up held. */
export const wearOrder = <T extends Pick<TemplatePiece, 'slot'>>(pieces: readonly T[]): T[] =>
    [...pieces].sort((a, b) => Number(a.slot === EquipmentSlot.TwoHand) - Number(b.slot === EquipmentSlot.TwoHand));

/** What's on already, what waits in the backpack, and what a GM has to make. */
export function templateGap(pieces: readonly TemplatePiece[], equipment: readonly Pick<InventoryItem, 'slot' | 'name'>[], backpack: readonly Pick<InventoryItem, 'slot' | 'name'>[]) {
    const missing = pieces.filter(p => equipment.find(e => e.slot === p.slot)?.name !== p.name);
    const toMake = missing.filter(p => !backpack.some(i => i.name === p.name));
    return { worn: pieces.length - missing.length, missing, toMake };
}

// ── Live ────────────────────────────────────────────────────────────────────

export type TemplateMember = { bot: string; sdk: BotSDK; actions: BotActions };
type Gm = Awaited<ReturnType<typeof connectBot>>;

const inBackpack = (i: InventoryItem) => i.slot >= EquipmentSlot.FirstBackpack && i.slot <= EquipmentSlot.LastBackpack;
/** A trade window's size. */
const WINDOW = 10;
const CREATE_MS = 5000;

/** The GM makes each piece, comes over and trades them across, a window at a time. The member stands still. */
async function deliver(m: TemplateMember, gm: Gm, pieces: readonly TemplatePiece[]): Promise<string[]> {
    const me = m.sdk.getPlayer()!;
    await gm.sdk.sendCommand(`/jump to ${me.x} ${me.y} ${me.z} ${me.regionId}`);
    await gm.sdk.waitForCondition(s => s.player?.regionId === me.regionId && Math.hypot(s.player.x - me.x, s.player.y - me.y) < 200, 25_000);
    await gm.sdk.waitForCondition(() => gm.sdk.getNearbyPlayers().some(p => p.name === me.name), 10_000);
    const out: string[] = [];
    for (let i = 0; i < pieces.length; i += WINDOW) {
        const batch = pieces.slice(i, i + WINDOW);
        for (const p of batch) {
            await gm.sdk.sendCommand(`/item create ${p.id}`);
            const made = () => gm.sdk.getInventory().some(it => inBackpack(it) && it.name === p.name);
            await gm.sdk.waitForCondition(made, CREATE_MS).catch(() => { throw new Error(`the GM couldn't make ${p.id}: is its row loaded? ${gm.sdk.getGameMessages().at(-1)?.text ?? ''}`); });
        }
        const give = gm.sdk.getInventory().filter(it => inBackpack(it) && batch.some(p => p.name === it.name));
        // By any name: an enemy realm's character may show under its race, and nobody else trades here.
        const [given, taken] = await Promise.all([gm.bot.trade(me.name, { give }), m.actions.trade(/./)]);
        if (!given.success || !taken.success) throw new Error(`trade with the GM: ${given.reason} ${given.message} / ${taken.reason} ${taken.message}`);
        out.push(`received ${taken.received.length} pieces`);
    }
    return out;
}

/** Puts on what's in the backpack, naming the slot. Returns what the server refused. */
async function wearPieces(m: TemplateMember, pieces: readonly TemplatePiece[]): Promise<string[]> {
    const out: string[] = [];
    for (const piece of wearOrder(pieces)) {
        const item = m.sdk.getInventory().find(i => inBackpack(i) && i.name === piece.name);
        if (!item) { out.push(`${piece.name}: not in the backpack`); continue; }
        const r = await m.actions.equipItem(item, { slot: piece.slot });
        if (m.sdk.getEquipment().find(e => e.slot === piece.slot)?.name !== piece.name) out.push(`${piece.name}: ${r.reason} ${r.message}`);
    }
    return out;
}

/**
 * A song needs the instrument out (SpellHandler.cs CheckInstrument: ActiveWeapon), wielding the club put it
 * away, and only putting it on brings it back (GamePlayerInventory.cs:547-560): bot.takeMeleeSlot takes melee weapons in hand, not an instrument.
 */
async function bringOutInstrument(m: TemplateMember): Promise<string[]> {
    const held = m.sdk.getEquipment().find(e => e.slot === EquipmentSlot.TwoHand && e.objectType === ObjectType.Instrument);
    if (!held) return [];
    const off = await m.actions.unequipItem(EquipmentSlot.TwoHand);
    const bag = m.sdk.getInventory().find(i => inBackpack(i) && i.name === held.name);
    if (!off.success || !bag) return [`${held.name}: ${off.reason} ${off.message}`];
    const on = await m.actions.equipItem(bag, { slot: EquipmentSlot.TwoHand });
    return m.sdk.getEquipment().some(e => e.slot === EquipmentSlot.TwoHand && e.name === held.name) ? [] : [`${held.name}: ${on.reason} ${on.message}`];
}

/** A delved bonus's total key: the line's name, under its category where two categories could share one. */
const bonusKey = (b: ItemBonus) => (b.category === 'hits' || b.category === 'power' || b.category === 'powerPool' || b.category === 'armorFactor' ? b.category : `${b.category}:${b.name}`);

export interface TemplateAudit {
    bot: string;
    className: string;
    worn: number;
    wanted: number;
    /** Delved totals by bonus, over the template's pieces. */
    totals: Record<string, number>;
    /** Slot, name, and the delve's own lines on factor or DPS. */
    pieces: { slot: number; name: string; dps: number | null; quality: number | null; lines: string[] }[];
    hp: number;
    load: number | null;
    stats: unknown;
    /** Anything short of the template, over a cap, or unread. */
    problems: string[];
    log: string[];
}

/** The server's word: a delve of every piece, added up against the caps. */
async function audit(m: TemplateMember, pieces: readonly TemplatePiece[], level: number): Promise<TemplateAudit> {
    const p = m.sdk.getPlayer()!;
    const caps = levelCaps(level);
    const out: TemplateAudit = { bot: m.bot, className: p.className, worn: 0, wanted: pieces.length, totals: {}, pieces: [], hp: p.maxHealth, stats: p.stats, load: p.encumbrance ? Math.round(100 * p.encumbrance.current / p.encumbrance.max) : null, problems: [], log: [] };
    for (const piece of pieces) {
        const worn = m.sdk.getEquipment().find(e => e.slot === piece.slot);
        if (worn?.name !== piece.name) { out.problems.push(`slot ${piece.slot}: ${worn?.name ?? 'empty'}, wanted ${piece.name}`); continue; }
        out.worn++;
        const r = await m.actions.delveItem(worn);
        if (!r.success) { out.problems.push(`delve ${piece.name}: ${r.reason}`); continue; }
        for (const b of r.bonuses) out.totals[bonusKey(b)] = (out.totals[bonusKey(b)] ?? 0) + b.value;
        const w = parseWeaponDelve(r.lines);
        out.pieces.push({ slot: piece.slot, name: piece.name, dps: w?.clampedDps ?? null, quality: w?.quality ?? null, lines: r.lines.filter(l => /factor|DPS|absorption|Quality/i.test(l)) });
        if (piece.objectType < ObjectType.GenericArmor && w && w.clampedDps !== caps.dpsAf / 10) out.problems.push(`${piece.name}: clamped DPS ${w.clampedDps}, cap ${caps.dpsAf / 10}`);
        if (r.bonuses.length < piece.bonuses.length) out.problems.push(`${piece.name}: delve shows ${r.bonuses.length} of ${piece.bonuses.length} bonuses`);
        if (isArmor(piece.objectType)) {
            const factor = Number(r.lines.map(l => /^- (\d+) Clamped Factor$/.exec(l.trim())?.[1]).find(Boolean));
            if (factor !== piece.dpsAf) out.problems.push(`${piece.name}: clamped factor ${factor}, wanted ${piece.dpsAf}`);
        }
    }
    for (const [key, value] of Object.entries(out.totals)) {
        const cap = bonusCap({ category: key.split(':')[0] as ItemBonus['category'] }, level);
        if (value > cap) out.problems.push(`${key}: ${value} over the cap ${cap}`);
    }
    return out;
}

/** The member's build target for its level. */
export async function buildSpecs(bot: string, level: number): Promise<Record<string, number>> {
    const build = (await import(join(process.cwd(), 'bots', bot, 'build.ts'))).default as { targets: { level: number; specs: Record<string, number> }[] };
    return (build.targets.find(t => t.level >= level) ?? build.targets.at(-1)!).specs;
}

async function applySql(sql: string): Promise<void> {
    const proc = Bun.spawn(['docker', 'compose', '-f', 'server/docker/docker-compose.yml', 'exec', '-T', 'db', 'mariadb', '-uroot', '-pdaoc-sdk', 'opendaoc'], { stdin: new Blob([sql]), stdout: 'pipe', stderr: 'pipe' });
    if (await proc.exited) throw new Error(`SQL failed: ${await new Response(proc.stderr).text()}`);
}

/**
 * Put every member in its template and report it. Whoever wears it already is left alone, and a run
 * with nothing to make needs no GM. `only` limits the wearing to those bots, for a first trial.
 */
export async function runGearTemplate(dir: string, members: readonly TemplateMember[], opts: { only?: readonly string[] } = {}): Promise<TemplateAudit[]> {
    const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
    const everyone = await Promise.all(members.map(async m => {
        const p = m.sdk.getPlayer()!;
        return { m, level: p.level, pieces: templateFor(p.className, p.realm, p.level, await buildSpecs(m.bot, p.level)) };
    }));
    const plans = everyone.filter(({ m }) => !opts.only?.length || opts.only.includes(m.bot));
    const needing = plans.flatMap(({ m, pieces }) => {
        const gap = templateGap(pieces, m.sdk.getEquipment(), m.sdk.getInventory().filter(inBackpack));
        return gap.toMake.length ? [{ m, toMake: gap.toMake }] : [];
    });
    const logs = new Map<string, string[]>();
    if (needing.length) {
        const sql = templateSql(everyone.flatMap(p => p.pieces));
        writeFileSync(join(dir, 'gear-template.sql'), sql);
        await applySql(sql);
        for (const { m } of needing) if (m.sdk.getPlayer()!.isDead) log(`${m.bot}: ${(await m.actions.releaseAndRespawn()).message}`);
        const gm = await connectBot(GM_BOT).catch(e => { throw new Error(`${e.message}\nThe GM's client must be in game: see learnings/gear-template.md "Running it"`); });
        try {
            await gm.sdk.sendCommand(`/item loadpackage ${TEMPLATE_PACKAGE}`);
            await Bun.sleep(1000);
            log(`GM: ${gm.sdk.getGameMessages().at(-1)?.text ?? 'no answer'}`);
            for (const { m, toMake } of needing) {
                await m.sdk.sendStop().catch(() => null);
                const lines = await deliver(m, gm, toMake);
                logs.set(m.bot, lines);
                log(`${m.bot}: ${lines.join(', ')}`);
            }
        } finally {
            await gm.sdk.disconnect();
        }
    }
    return Promise.all(plans.map(async ({ m, level, pieces }) => {
        const gap = templateGap(pieces, m.sdk.getEquipment(), m.sdk.getInventory().filter(inBackpack));
        await m.sdk.sendStop().catch(() => null);
        const refused = gap.missing.length ? [...await wearPieces(m, gap.missing), ...await bringOutInstrument(m)] : [];
        const lines = [...(logs.get(m.bot) ?? []), gap.missing.length ? `wore ${gap.missing.length - refused.length} of ${gap.missing.length}` : 'already wearing it'];
        for (const line of [...lines, ...refused]) log(`${m.bot}: ${line}`);
        const report = await audit(m, pieces, level);
        report.log = lines;
        report.problems.unshift(...refused);
        return report;
    }));
}

/** One member's row for the closing table. */
export function auditRow(a: TemplateAudit, level: number): string {
    const caps = levelCaps(level);
    const sum = (prefix: string) => Object.entries(a.totals).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    const at = (values: number[], cap: number) => `${values.filter(v => v === cap).length}/${values.length}`;
    return `| ${a.bot} | ${a.className} | ${a.worn}/${a.wanted} | ${at(sum('stat:'), caps.stat)} | ${a.totals.hits ?? 0}/${caps.hits} | ${at(sum('resist:'), caps.resist)} | ${at(sum('skill:'), caps.skill)} | ${a.totals.power === undefined ? '-' : `${a.totals.power}/${caps.power}`} | ${a.totals.armorFactor ?? 0}/${caps.armorFactor} | ${a.hp} | ${a.load ?? '?'}% | ${a.problems.length ? a.problems.join('; ') : 'none'} |`;
}
