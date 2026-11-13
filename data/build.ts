// Builders for the static world data in data/generated/*.json.
//
// Sources: the OpenDAoC-Database dumps (server/db/opendaoc-db-core/*.sql) and,
// for classes/races, the GameServer C# source (server/core/GameServer), which
// is the ground truth for eCharacterClass/eRace ids and creation rules.
//
// Each builder is pure (returns JSON-able data); writeGenerated() persists it.
// data/index.ts calls these lazily when a generated file is missing.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_DIR, loadTable, type SqlRow } from './sql';
import { buildRegions, buildZones } from './zones';

export const GENERATED_DIR = join(import.meta.dir, 'generated');
export const GAMESERVER_DIR = join(import.meta.dir, '..', 'server', 'core', 'GameServer');

// ── Shapes ──────────────────────────────────────────────────────────────────

/** Compact table: one header row of column names + rows of values. */
export interface CompactTable<T extends readonly string[] = readonly string[]> {
    columns: T;
    rows: unknown[][];
}

export interface ZonePoint {
    id: number;
    sourceRegion: number;
    sourceX: number;
    sourceY: number;
    sourceZ: number;
    targetRegion: number;
    targetX: number;
    targetY: number;
    targetZ: number;
    targetHeading: number;
    realm: number;
    classType: string;
}

export interface BindPoint {
    regionId: number;
    x: number;
    y: number;
    z: number;
    radius: number;
    /** 0 = any realm. */
    realm: number;
}

export interface Teleport {
    /** Teleporter type (e.g. "Castle Sauvage Emissary"), often empty. */
    type: string;
    /** Destination keyword whispered to the teleporter. */
    teleportId: string;
    realm: number;
    regionId: number;
    x: number;
    y: number;
    z: number;
    heading: number;
}

export interface StartupLocation {
    id: number;
    regionId: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    minVersion: number;
    realm: number;
    raceId: number;
    classId: number;
    clientRegionId: number;
}

/**
 * One starterequipment row: the items a new character of these classes gets
 * (StartupEquipment.cs:51-88). A row whose template is missing from
 * itemtemplate is skipped by the server with a "Cannot Find Item Template"
 * warning (StartupEquipment.cs:58, :82-86), so the character never gets it.
 */
export interface StarterEquipment {
    id: number;
    /** eCharacterClass ids from the `Class` column; 0 = every class that has rows of its own. */
    classIds: number[];
    templateId: string;
}

export const NPC_COLUMNS = [
    'id', 'name', 'guild', 'classType', 'regionId', 'x', 'y', 'z', 'heading', 'level', 'realm', 'model',
    'flags', 'itemsListTemplateId', 'aggroLevel', 'aggroRange', 'respawn', 'npcTemplateId', 'factionId',
] as const;

export interface NpcSpawn {
    /** mob.Mob_ID (GUID string). */
    id: string;
    name: string;
    guild: string;
    /** C# class with the "DOL.GS." prefix stripped, e.g. "GameNPC", "GameMerchant", "Trainer.MageTrainer". */
    classType: string;
    regionId: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    level: number;
    realm: number;
    model: number;
    /** GameNPC.eFlags (GHOST 0x01, STEALTH 0x02, DONTSHOWNAME 0x04, CANTTARGET 0x08, PEACE 0x10, FLYING 0x20, ...). */
    flags: number;
    /** Merchant item list id (merchants.json key), or '' if none. */
    itemsListTemplateId: string;
    aggroLevel: number;
    aggroRange: number;
    /** RespawnInterval in seconds (0/-1 = server default / no respawn). */
    respawn: number;
    npcTemplateId: number;
    /** The mob row's FactionID, 0 for none. Only a mob with a faction brings friends when attacked (StandardMobBrain.BringFriends). */
    factionId: number;
}

export interface MerchantEntry {
    page: number;
    slot: number;
    /** Buy packet itemSlot = page * 30 + slot (MerchantTradeItems.cs:34). */
    itemSlot: number;
    itemTemplateId: string;
    name: string;
    level: number;
    /** Price in copper. */
    price: number;
    model: number;
}

export const ITEM_COLUMNS = [
    'id', 'name', 'level', 'price', 'objectType', 'itemType', 'dpsAf', 'spdAbs', 'weight', 'model',
    'realm', 'hand', 'typeDamage', 'allowedClasses', 'levelRequirement', 'packSize', 'maxCount', 'quality',
] as const;

export interface ItemTemplate {
    /** Id_nb: the key used by merchant lists and /item create. */
    id: string;
    name: string;
    level: number;
    price: number;
    objectType: number;
    itemType: number;
    dpsAf: number;
    spdAbs: number;
    weight: number;
    model: number;
    realm: number;
    hand: number;
    typeDamage: number;
    /** Semicolon list of eCharacterClass ids, '' or '0' = all. */
    allowedClasses: string;
    levelRequirement: number;
    packSize: number;
    maxCount: number;
    quality: number;
}

export interface SpellInfo {
    id: number;
    name: string;
    description: string;
    type: string;
    target: string;
    range: number;
    radius: number;
    power: number;
    castTime: number;
    recastDelay: number;
    damage: number;
    damageType: number;
    duration: number;
    frequency: number;
    pulse: number;
    value: number;
    concentration: number;
    icon: number;
    clientEffect: number;
    spellGroup: number;
    effectGroup: number;
    subSpellId: number;
    sharedTimerGroup: number;
    moveCast: boolean;
    uninterruptible: boolean;
    isFocus: boolean;
    /** What the trainer window and delves call this spell (Spell.cs:365). Rows can share one, within a class they don't. */
    tooltipId: number;
    /** Not 0: a song, on the songs page (Spell.cs:249). */
    instrumentRequirement: number;
    /** What others read when its effect lands ("{0} is entranced!"): Message2, sent to the caster and to the area (ECSGameEffect.cs SendMessages). */
    effectStarts: string;
    /** What the area reads when the effect ends ("{0} is no longer entranced."): Message4; empty for most roots. */
    effectEnds: string;
}

export interface SpellLineInfo {
    keyName: string;
    name: string;
    spec: string;
    isBaseLine: boolean;
    classIdHint: number;
    spells: { spellId: number; level: number }[];
}

/** One stylexspell row, as Style.Procs holds it (StyleProcInfo, Style.cs:271). */
export interface StyleProc {
    spellId: number;
    /** Percent, rolled each time the style lands (StyleProcessor.cs:417). */
    chance: number;
    /** 0: every class, unless the character's class has a row of its own. getStyleProcs picks. */
    classId: number;
}

export interface StyleInfo {
    /** style.ID, which many class rows share. Openers name it and procs join on it (DbStyle.cs:335). */
    id: number;
    classId: number;
    name: string;
    specKeyName: string;
    specLevelRequirement: number;
    icon: number;
    enduranceCost: number;
    stealthRequirement: boolean;
    openingRequirementType: number;
    openingRequirementValue: number;
    attackResultRequirement: number;
    weaponTypeRequirement: number;
    growthRate: number;
    growthOffset: number;
    bonusToHit: number;
    bonusToDefense: number;
    /** style.StyleID, what the trainer window and delves call this style (Style.cs:232). */
    styleId: number;
    /** Only on a style that has any. */
    procs?: StyleProc[];
}

export interface SpecializationInfo {
    id: number;
    keyName: string;
    name: string;
    icon: number;
    description: string;
    implementation: string;
    /** Abilities granted by this spec (specxability). classId 0 = all classes. */
    abilities: { specLevel: number; abilityKey: string; abilityLevel: number; classId: number }[];
}

export interface AbilityInfo {
    id: number;
    keyName: string;
    name: string;
    internalId: number;
    description: string;
    iconId: number;
    implementation: string;
}

export type StatName = 'STR' | 'DEX' | 'CON' | 'QUI' | 'INT' | 'PIE' | 'EMP' | 'CHR';

export interface ClassInfo {
    /** eCharacterClass id (GameServer/Enums/eCharacterClass.cs). */
    id: number;
    /** eCharacterClass enum member, e.g. "AlbionRogue", "MaulerAlb". */
    key: string;
    /** Display name from [CharacterClass], e.g. "Rogue", "Mauler". */
    name: string;
    femaleName: string | null;
    /** 1 albion, 2 midgard, 3 hibernia. */
    realm: number;
    isBaseClass: boolean;
    baseClassId: number;
    baseClassName: string;
    /** Advanced classes that train from this base class (base classes only). */
    advancedClassIds: number[];
    /** In GlobalConstants.STARTING_CLASSES_DICT for its realm (can be chosen at creation). */
    startable: boolean;
    /** startable and at least one creatable race (e.g. Valkyrie has no EligibleRaces on this server). */
    creatable: boolean;
    /** EligibleRaces from the C# class (after inheritance). */
    eligibleRaceIds: number[];
    /** Eligible races that are also creatable (have STARTING_STATS_DICT entries). */
    creatableRaceIds: number[];
    /** 'male' | 'female' when CLASS_GENDER_CONSTRAINTS_DICT restricts it. */
    gender: 'male' | 'female' | null;
    primaryStat: StatName | null;
    secondaryStat: StatName | null;
    tertiaryStat: StatName | null;
    manaStat: StatName | null;
    specializationMultiplier: number;
    baseHP: number;
    wsBase: number;
    classType: string;
    /** classxspecialization rows for this class (LevelAcquired may be negative for career lines). */
    specializations: { spec: string; levelAcquired: number }[];
    /** KeyNames of its lines that train for free up to floor(level / 4), at least 1 (GamePlayer.cs:4833). */
    autotrainSpecs: string[];
}

export interface RaceInfo {
    /** eRace id (GameServer/Enums/eRace.cs). */
    id: number;
    name: string;
    realm: number;
    expansion: string;
    /** In STARTING_STATS_DICT: the server can validate (and thus create) this race. */
    creatable: boolean;
    startingStats: Record<StatName, number> | null;
    gender: 'male' | 'female' | null;
    resists: Record<string, number> | null;
}

export interface ClassesFile {
    classes: ClassInfo[];
    races: RaceInfo[];
    /** realm -> eCharacterClass ids allowed at creation (STARTING_CLASSES_DICT). */
    startingClasses: Record<string, number[]>;
    /** CharacterStatValidator.PointDistributionBudget. */
    statPointBudget: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

const STAT_NAMES: StatName[] = ['STR', 'DEX', 'CON', 'QUI', 'INT', 'PIE', 'EMP', 'CHR'];
const asStat = (s: string | undefined): StatName | null =>
    s && (STAT_NAMES as string[]).includes(s) ? (s as StatName) : null;

function stripCsComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function readCs(rel: string): string {
    const p = join(GAMESERVER_DIR, rel);
    if (!existsSync(p)) throw new Error(`build-data: missing C# source ${p} (is the server/core submodule checked out?)`);
    return stripCsComments(readFileSync(p, 'utf8'));
}

function parseEnum(src: string, name: string): Map<string, number> {
    const m = new RegExp(`enum\\s+${name}\\s*:\\s*\\w+\\s*\\{([\\s\\S]*?)\\}`).exec(src);
    if (!m) throw new Error(`build-data: enum ${name} not found`);
    const out = new Map<string, number>();
    for (const e of m[1]!.matchAll(/(\w+)\s*=\s*(\d+)/g)) out.set(e[1]!, Number(e[2]));
    return out;
}

function sliceBlock(src: string, marker: string): string {
    const start = src.indexOf(marker);
    if (start < 0) throw new Error(`build-data: ${marker} not found`);
    const end = src.indexOf('public static', start + marker.length);
    return src.slice(start, end < 0 ? undefined : end);
}

const realmIdByName: Record<string, number> = { Albion: 1, Midgard: 2, Hibernia: 3 };

// Parsed tables are memoised for the duration of a build (mob/itemtemplate are large).
const tableCache = new Map<string, SqlRow[]>();
function table(name: string): SqlRow[] {
    let rows = tableCache.get(name);
    if (!rows) tableCache.set(name, rows = loadTable(name));
    return rows;
}
export function clearTableCache(): void {
    tableCache.clear();
}

// ── Simple tables ───────────────────────────────────────────────────────────

export function buildZonePoints(): ZonePoint[] {
    return table('zonepoint').map(r => ({
        id: num(r.Id),
        sourceRegion: num(r.SourceRegion), sourceX: num(r.SourceX), sourceY: num(r.SourceY), sourceZ: num(r.SourceZ),
        targetRegion: num(r.TargetRegion), targetX: num(r.TargetX), targetY: num(r.TargetY), targetZ: num(r.TargetZ),
        targetHeading: num(r.TargetHeading),
        realm: num(r.Realm),
        classType: str(r.ClassType),
    })).sort((a, b) => a.id - b.id);
}

export function buildBindPoints(): BindPoint[] {
    return table('bindpoint').map(r => ({
        regionId: num(r.Region), x: num(r.X), y: num(r.Y), z: num(r.Z), radius: num(r.Radius), realm: num(r.Realm),
    })).sort((a, b) => a.regionId - b.regionId || a.x - b.x || a.y - b.y);
}

export function buildTeleports(): Teleport[] {
    return table('teleport').map(r => ({
        type: str(r.Type), teleportId: str(r.TeleportID), realm: num(r.Realm), regionId: num(r.RegionID),
        x: num(r.X), y: num(r.Y), z: num(r.Z), heading: num(r.Heading),
    })).sort((a, b) => a.realm - b.realm || a.type.localeCompare(b.type) || a.teleportId.localeCompare(b.teleportId));
}

export function buildStartupLocations(): StartupLocation[] {
    return table('startuplocation').map(r => ({
        id: num(r.StartupLoc_ID), regionId: num(r.Region), x: num(r.XPos), y: num(r.YPos), z: num(r.ZPos),
        heading: num(r.Heading), minVersion: num(r.MinVersion), realm: num(r.RealmID), raceId: num(r.RaceID),
        classId: num(r.ClassID), clientRegionId: num(r.ClientRegionID),
    })).sort((a, b) => a.id - b.id);
}

/** Util.SplitCSV(str, rangeCheck: true) (gameutils/Util.cs:86): ';'-separated, "a-b" ranges expanded. */
export function splitClassList(list: string): number[] {
    const out: number[] = [];
    for (const part of list.split(';').map(p => p.trim()).filter(Boolean)) {
        const range = /^(\d+)-(\d+)$/.exec(part);
        if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
        else if (/^\d+$/.test(part)) out.push(Number(part));
    }
    return out;
}

export function buildStarterEquipment(): StarterEquipment[] {
    return table('starterequipment').map(r => ({
        id: num(r.StarterEquipmentID), classIds: splitClassList(str(r.Class)), templateId: str(r.TemplateID),
    })).sort((a, b) => a.id - b.id);
}

export function buildNpcs(mobRows: SqlRow[] = table('mob'), templateRows: SqlRow[] = table('npctemplate')): CompactTable<typeof NPC_COLUMNS> {
    // GameNPC.LoadTemplate (HandleLevel, HandleBrain): a template with ReplaceMobValues replaces the
    // mob row's level (a random pick from its ';' list; we keep the highest) and the brain's aggro.
    // Many mob rows are stale: in Gotar, passive L2 wild hogs are also stored as aggressive L12 rows,
    // which made the camp finder see danger everywhere. A mob with its own Brain keeps its row's aggro.
    const tpl = new Map<number, SqlRow>();
    for (const t of templateRows) if (num(t.ReplaceMobValues) && !tpl.has(num(t.TemplateId))) tpl.set(num(t.TemplateId), t);
    const rows = mobRows.map(r => {
        const t = tpl.get(num(r.NPCTemplateID));
        const levels = t ? splitClassList(str(t.Level)) : [];
        const aggro = t && !str(r.Brain) ? t : r;
        return [
            str(r.Mob_ID), str(r.Name), str(r.Guild), str(r.ClassType).replace(/^DOL\.GS\./, ''),
            num(r.Region), Math.round(num(r.X)), Math.round(num(r.Y)), Math.round(num(r.Z)), num(r.Heading),
            levels.length ? Math.max(...levels) : num(r.Level), num(r.Realm), num(r.Model), num(r.Flags), str(r.ItemsListTemplateID),
            num(aggro.AggroLevel), num(aggro.AggroRange), num(r.RespawnInterval), num(r.NPCTemplateID), num(r.FactionID),
        ];
    });
    // Region, then x, then id: stable and diff-friendly.
    rows.sort((a, b) => (a[4] as number) - (b[4] as number) || (a[5] as number) - (b[5] as number)
        || (a[0] as string).localeCompare(b[0] as string));
    return { columns: NPC_COLUMNS, rows };
}

export function buildItems(itemRows: SqlRow[] = table('itemtemplate')): CompactTable<typeof ITEM_COLUMNS> {
    const rows = itemRows.map(r => [
        str(r.Id_nb), str(r.Name), num(r.Level), num(r.Price), num(r.Object_Type), num(r.Item_Type),
        num(r.DPS_AF), num(r.SPD_ABS), num(r.Weight), num(r.Model), num(r.Realm), num(r.Hand), num(r.Type_Damage),
        str(r.AllowedClasses), num(r.LevelRequirement), num(r.PackSize), num(r.MaxCount), num(r.Quality),
    ]);
    rows.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
    return { columns: ITEM_COLUMNS, rows };
}

export const MERCHANT_COLUMNS = ['page', 'slot', 'itemTemplateId', 'name', 'level', 'price', 'model'] as const;

/** merchants.json: ItemListID -> rows of MERCHANT_COLUMNS, sorted by page*30+slot. */
export interface MerchantsFile {
    columns: typeof MERCHANT_COLUMNS;
    lists: Record<string, unknown[][]>;
}

/**
 * ItemListID -> entries. Item templates are joined case-insensitively, like the
 * server's precache (CoreDatabase/DataTableHandler.cs:196,211); entries whose
 * template is missing are dropped, as MerchantTradeItems.cs:143 does.
 */
export function buildMerchants(itemRows: SqlRow[] = table('itemtemplate')): MerchantsFile {
    const items = new Map<string, SqlRow>();
    for (const r of itemRows) items.set(str(r.Id_nb).toLowerCase(), r);
    // ItemListID is matched by SQL with a case-insensitive collation ("Alb1HStaff" and "Alb1hStaff"
    // rows form one list), and rows come back in MerchantItem_ID order via I_MerchantItem_ItemListID.
    // Several rows can share a page/slot; GetItemsInPage keeps the first with a valid template
    // (MerchantTradeItems.cs:146-160), so do the same.
    const rows = [...table('merchantitem')].sort((a, b) => {
        const x = str(a.MerchantItem_ID).toLowerCase(), y = str(b.MerchantItem_ID).toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
    });
    const out = new Map<string, { name: string; slots: Map<number, unknown[]> }>();
    for (const r of rows) {
        const listId = str(r.ItemListID);
        if (!listId) continue;
        const it = items.get(str(r.ItemTemplateID).toLowerCase());
        if (!it) continue;
        let list = out.get(listId.toLowerCase());
        if (!list) out.set(listId.toLowerCase(), list = { name: listId, slots: new Map() });
        else if (listId < list.name) list.name = listId;
        const page = num(r.PageNumber), slot = num(r.SlotPosition);
        if (list.slots.has(page * 30 + slot)) continue;
        list.slots.set(page * 30 + slot, [page, slot, str(it.Id_nb), str(it.Name), num(it.Level), num(it.Price), num(it.Model)]);
    }
    const lists: Record<string, unknown[][]> = {};
    for (const l of [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
        lists[l.name] = [...l.slots].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
    return { columns: MERCHANT_COLUMNS, lists };
}

export function buildSpells(): SpellInfo[] {
    return table('spell').map(r => ({
        id: num(r.SpellID), name: str(r.Name), description: str(r.Description), type: str(r.Type), target: str(r.Target),
        range: num(r.Range), radius: num(r.Radius), power: num(r.Power), castTime: num(r.CastTime),
        recastDelay: num(r.RecastDelay), damage: num(r.Damage), damageType: num(r.DamageType), duration: num(r.Duration),
        frequency: num(r.Frequency), pulse: num(r.Pulse), value: num(r.Value), concentration: num(r.Concentration),
        icon: num(r.Icon), clientEffect: num(r.ClientEffect), spellGroup: num(r.SpellGroup), effectGroup: num(r.EffectGroup),
        subSpellId: num(r.SubSpellID), sharedTimerGroup: num(r.SharedTimerGroup),
        moveCast: num(r.MoveCast) !== 0, uninterruptible: num(r.Uninterruptible) !== 0, isFocus: num(r.IsFocus) !== 0,
        tooltipId: num(r.TooltipId), instrumentRequirement: num(r.InstrumentRequirement),
        effectStarts: str(r.Message2), effectEnds: str(r.Message4),
    })).sort((a, b) => a.id - b.id);
}

export function buildSpellLines(): SpellLineInfo[] {
    const byLine = new Map<string, { spellId: number; level: number }[]>();
    for (const r of table('linexspell')) {
        const k = str(r.LineName).toLowerCase();
        let list = byLine.get(k);
        if (!list) byLine.set(k, list = []);
        list.push({ spellId: num(r.SpellID), level: num(r.Level) });
    }
    return table('spellline').map(r => ({
        keyName: str(r.KeyName), name: str(r.Name), spec: str(r.Spec), isBaseLine: num(r.IsBaseLine) !== 0,
        classIdHint: num(r.ClassIDHint),
        spells: (byLine.get(str(r.KeyName).toLowerCase()) ?? []).sort((a, b) => a.level - b.level || a.spellId - b.spellId),
    })).sort((a, b) => a.keyName.localeCompare(b.keyName));
}

export function buildStyles(procRows: SqlRow[] = table('stylexspell'), spellRows: SqlRow[] = table('spell')): StyleInfo[] {
    // A row's StyleID is style.ID, so it reaches every class row with that ID (DbStyle.cs:335),
    // and a row whose spell doesn't exist is dropped at load (SkillBase.cs:630-634).
    const spells = new Set(spellRows.map(r => num(r.SpellID)));
    const procs = new Map<number, StyleProc[]>();
    for (const r of procRows) {
        if (!spells.has(num(r.SpellID))) continue;
        (procs.get(num(r.StyleID)) ?? procs.set(num(r.StyleID), []).get(num(r.StyleID))!)
            .push({ spellId: num(r.SpellID), chance: num(r.Chance), classId: num(r.ClassID) });
    }
    for (const list of procs.values()) list.sort((a, b) => a.classId - b.classId || a.spellId - b.spellId);
    return table('style').map(r => ({
        id: num(r.ID), classId: num(r.ClassId), name: str(r.Name), specKeyName: str(r.SpecKeyName),
        specLevelRequirement: num(r.SpecLevelRequirement), icon: num(r.Icon), enduranceCost: num(r.EnduranceCost),
        stealthRequirement: num(r.StealthRequirement) !== 0, openingRequirementType: num(r.OpeningRequirementType),
        openingRequirementValue: num(r.OpeningRequirementValue), attackResultRequirement: num(r.AttackResultRequirement),
        weaponTypeRequirement: num(r.WeaponTypeRequirement), growthRate: num(r.GrowthRate), growthOffset: num(r.GrowthOffset),
        bonusToHit: num(r.BonusToHit), bonusToDefense: num(r.BonusToDefense), styleId: num(r.StyleID),
        ...(procs.has(num(r.ID)) ? { procs: procs.get(num(r.ID))! } : {}),
    })).sort((a, b) => a.classId - b.classId || a.specKeyName.localeCompare(b.specKeyName)
        || a.specLevelRequirement - b.specLevelRequirement || a.id - b.id);
}

export function buildSpecializations(): SpecializationInfo[] {
    const abilities = new Map<string, SpecializationInfo['abilities']>();
    for (const r of table('specxability')) {
        const k = str(r.Spec).toLowerCase();
        let list = abilities.get(k);
        if (!list) abilities.set(k, list = []);
        list.push({ specLevel: num(r.SpecLevel), abilityKey: str(r.AbilityKey), abilityLevel: num(r.AbilityLevel), classId: num(r.ClassId) });
    }
    return table('specialization').map(r => ({
        id: num(r.SpecializationID), keyName: str(r.KeyName), name: str(r.Name), icon: num(r.Icon),
        description: str(r.Description), implementation: str(r.Implementation),
        abilities: (abilities.get(str(r.KeyName).toLowerCase()) ?? [])
            .sort((a, b) => a.specLevel - b.specLevel || a.abilityKey.localeCompare(b.abilityKey)),
    })).sort((a, b) => a.keyName.localeCompare(b.keyName));
}

export function buildAbilities(): AbilityInfo[] {
    return table('ability').map(r => ({
        id: num(r.AbilityID), keyName: str(r.KeyName), name: str(r.Name), internalId: num(r.InternalID),
        description: str(r.Description), iconId: num(r.IconID), implementation: str(r.Implementation),
    })).sort((a, b) => a.keyName.localeCompare(b.keyName));
}

// ── Classes and races (from C# source) ──────────────────────────────────────

interface RawClass {
    key: string;
    name: string;
    baseName: string;
    femaleName: string | null;
    cls: string;
    parent: string;
    dir: string;
    primary?: string;
    secondary?: string;
    tertiary?: string;
    mana?: string;
    specMult?: number;
    baseHP?: number;
    wsBase?: number;
    classType?: string;
    races?: string[];
    /** Members of `Specs`, from an override of GetAutotrainableSkills. */
    autotrain?: string[];
}

/** The `const string` members of `class Specs` (gameutils/SkillConstants.cs:467): member name -> KeyName. */
export function parseSpecConstants(src: string): Map<string, string> {
    const block = /abstract\s+class\s+Specs\b([\s\S]*?)(?=\babstract\s+class\b|$)/.exec(src)?.[1];
    if (!block) throw new Error('build-data: class Specs not found');
    return new Map([...block.matchAll(/const\s+string\s+(\w+)\s*=\s*"([^"]*)"/g)].map(m => [m[1]!, m[2]!]));
}

/**
 * The `Specs` members a class returns from GetAutotrainableSkills, undefined without an override. Only
 * the override counts: ClassHunter.cs:9 keeps the array with its override commented out (:23-26), so
 * `src` comes without comments. An override this can't read fails here, as EligibleRaces does.
 */
export function parseAutotrain(src: string): string[] | undefined {
    if (!/\bGetAutotrainableSkills\s*\(/.test(src)) return undefined;
    const returnsArray = /\bGetAutotrainableSkills\s*\(\s*\)\s*(?:\{\s*return\s+|=>\s*)AutotrainableSkills\s*;/.test(src);
    const array = /\bAutotrainableSkills\s*=\s*new\s*(?:string\s*)?\[\s*\]\s*\{([^}]*)\}/.exec(src);
    if (!returnsArray || !array) throw new Error(`build-data: cannot parse GetAutotrainableSkills in ${/class\s+(\w+)/.exec(src)?.[1]}`);
    return [...array[1]!.matchAll(/Specs\.(\w+)/g)].map(m => m[1]!);
}

function parseClassFile(src: string, dir: string): RawClass | null {
    const attr = /\[CharacterClass(?:Attribute)?\(\s*\(int\)\s*eCharacterClass\.(\w+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"(?:\s*,\s*"([^"]*)")?\s*\)\]/.exec(src);
    const decl = /class\s+(\w+)\s*:\s*(\w+)/.exec(src);
    if (!attr || !decl) return null;
    const field = (name: string) => new RegExp(`${name}\\s*=\\s*eStat\\.(\\w+)`).exec(src)?.[1];
    const int = (name: string) => {
        const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(src);
        return m ? Number(m[1]) : undefined;
    };
    // `=> new List<PlayerRace>() { ... }` or target-typed `=> new() { ... }` (ClassBainshee.cs:169).
    const racesBlock = /EligibleRaces\s*=>\s*new\s*(?:List<PlayerRace>\s*)?\(\s*\)\s*\{([^}]*)\}/.exec(src);
    // An unparsed override would silently inherit the parent's races: fail loudly instead.
    if (!racesBlock && /\bEligibleRaces\s*=>/.test(src)) throw new Error(`build-data: cannot parse EligibleRaces in ${decl[1]}`);
    const classType = /eClassType\s+ClassType[\s\S]*?eClassType\.(\w+)/.exec(src)?.[1];
    return {
        key: attr[1]!, name: attr[2]!, baseName: attr[3]!, femaleName: attr[4] ?? null,
        cls: decl[1]!, parent: decl[2]!, dir,
        primary: field('m_primaryStat'), secondary: field('m_secondaryStat'), tertiary: field('m_tertiaryStat'),
        mana: field('m_manaStat'), specMult: int('m_specializationMultiplier'), baseHP: int('m_baseHP'),
        wsBase: int('m_wsbase'), classType,
        races: racesBlock ? [...racesBlock[1]!.matchAll(/PlayerRace\.(\w+)/g)].map(m => m[1]!) : undefined,
        autotrain: parseAutotrain(src),
    };
}

export function buildClasses(): ClassesFile {
    const classEnum = parseEnum(readCs('Enums/eCharacterClass.cs'), 'eCharacterClass');
    const raceEnum = parseEnum(readCs('Enums/eRace.cs'), 'eRace');
    const globals = readCs('GlobalConstants.cs');
    const playerRace = readCs('gameobjects/PlayerRace.cs');

    // STARTING_STATS_DICT (GlobalConstants.cs:910)
    const startingStats = new Map<string, Record<StatName, number>>();
    for (const m of sliceBlock(globals, 'STARTING_STATS_DICT').matchAll(/\{\s*eRace\.(\w+)\s*,\s*new\s+Dictionary<eStat,\s*int>\s*\(\s*\)\s*\{([^\n]*?)\}\s*\}/g)) {
        const stats = {} as Record<StatName, number>;
        for (const s of m[2]!.matchAll(/eStat\.(\w+)\s*,\s*(\d+)/g)) stats[s[1] as StatName] = Number(s[2]);
        startingStats.set(m[1]!, stats);
    }
    // STARTING_CLASSES_DICT (GlobalConstants.cs:938)
    const startingClasses: Record<string, number[]> = {};
    for (const m of sliceBlock(globals, 'STARTING_CLASSES_DICT').matchAll(/eRealm\.(\w+)\s*,\s*new\s+List<eCharacterClass>\s*\(\s*\)\s*\{([^}]*)\}/g)) {
        const ids = [...m[2]!.matchAll(/eCharacterClass\.(\w+)/g)].map(c => classEnum.get(c[1]!)!).filter(x => x !== undefined);
        startingClasses[String(realmIdByName[m[1]!])] = [...new Set(ids)].sort((a, b) => a - b);
    }
    const genderOf = (block: string, prefix: string) => {
        const out = new Map<string, 'male' | 'female'>();
        for (const m of sliceBlock(globals, block).matchAll(new RegExp(`\\{\\s*${prefix}\\.(\\w+)\\s*,\\s*eGender\\.(\\w+)\\s*\\}`, 'g')))
            out.set(m[1]!, m[2] === 'Female' ? 'female' : 'male');
        return out;
    };
    const raceGender = genderOf('RACE_GENDER_CONSTRAINTS_DICT', 'eRace');
    const classGender = genderOf('CLASS_GENDER_CONSTRAINTS_DICT', 'eCharacterClass');

    // PlayerRace.cs: realm + expansion per race.
    const raceRealm = new Map<string, { realm: number; expansion: string }>();
    for (const m of playerRace.matchAll(/new\s+PlayerRace\(\s*eRace\.(\w+)\s*,\s*eRealm\.(\w+)\s*,\s*eDAoCExpansion\.(\w+)/g))
        raceRealm.set(m[1]!, { realm: realmIdByName[m[2]!] ?? 0, expansion: m[3]! });

    const raceResists = new Map<number, Record<string, number>>();
    for (const r of table('race')) {
        const res: Record<string, number> = {};
        for (const k of Object.keys(r)) if (k.startsWith('Resist')) res[k.slice(6).toLowerCase()] = num(r[k]);
        raceResists.set(num(r.ID), res);
    }

    // eRace has aliases (Korazh = AlbionMinotaur = 19); prefer the name PlayerRace.cs uses.
    const raceNameById = new Map<number, string>();
    for (const [name, id] of raceEnum) if (id > 0 && (!raceNameById.has(id) || raceRealm.has(name))) raceNameById.set(id, name);
    const races: RaceInfo[] = [...raceNameById].sort((a, b) => a[0] - b[0]).map(([id, name]) => {
        const aliases = [...raceEnum].filter(([, v]) => v === id).map(([k]) => k);
        const stats = aliases.map(a => startingStats.get(a)).find(Boolean) ?? null;
        const gender = aliases.map(a => raceGender.get(a)).find(Boolean) ?? null;
        return {
            id, name, realm: raceRealm.get(name)?.realm ?? 0, expansion: raceRealm.get(name)?.expansion ?? 'Unknown',
            creatable: stats !== null, startingStats: stats, gender, resists: raceResists.get(id) ?? null,
        };
    });
    const raceIdByName = new Map<string, number>();
    for (const [name, id] of raceEnum) raceIdByName.set(name, id);

    // playerclasses/{base,albion,midgard,hibernia}/Class*.cs
    const raw = new Map<string, RawClass>();
    const classesDir = join(GAMESERVER_DIR, 'playerclasses');
    for (const dir of readdirSync(classesDir)) {
        const sub = join(classesDir, dir);
        if (!statSync(sub).isDirectory()) continue;
        for (const f of readdirSync(sub).filter(f => f.endsWith('.cs'))) {
            const c = parseClassFile(stripCsComments(readFileSync(join(sub, f), 'utf8')), dir);
            if (c) raw.set(c.cls, c);
        }
    }
    const inherit = <K extends keyof RawClass>(c: RawClass, k: K): RawClass[K] | undefined => {
        for (let cur: RawClass | undefined = c; cur; cur = raw.get(cur.parent)) if (cur[k] !== undefined) return cur[k];
        return undefined;
    };
    const realmOf = (c: RawClass): number => {
        const id = classEnum.get(c.key);
        for (const [r, ids] of Object.entries(startingClasses)) if (id !== undefined && ids.includes(id)) return Number(r);
        return realmIdByName[c.dir[0]!.toUpperCase() + c.dir.slice(1)] ?? 0;
    };
    // Base classes by realm + display name ("Rogue" exists in Albion and Midgard).
    const baseByName = new Map<string, RawClass>();
    for (const c of raw.values()) if (c.dir === 'base') baseByName.set(`${realmOf(c)}:${c.name}`, c);

    const csc = new Map<number, { spec: string; levelAcquired: number }[]>();
    for (const r of table('classxspecialization')) {
        const id = num(r.ClassID);
        (csc.get(id) ?? csc.set(id, []).get(id)!).push({ spec: str(r.SpecKeyName), levelAcquired: num(r.LevelAcquired) });
    }

    const specConstants = parseSpecConstants(readCs('gameutils/SkillConstants.cs'));
    const autotrainOf = (c: RawClass, lines: { spec: string }[]): string[] => (inherit(c, 'autotrain') ?? []).map(member => {
        const spec = specConstants.get(member);
        if (spec === undefined) throw new Error(`build-data: ${c.cls} autotrains Specs.${member}, which SkillConstants.cs doesn't define`);
        return spec;
    }).filter(spec => lines.some(l => l.spec === spec));   // ClassRanger.cs:9 and ClassScout.cs:9 name Archery, no line of theirs

    const classes: ClassInfo[] = [];
    for (const c of raw.values()) {
        const id = classEnum.get(c.key);
        if (id === undefined) continue;
        const realm = realmOf(c);
        const isBase = c.dir === 'base';
        const base = isBase ? c : baseByName.get(`${realm}:${c.baseName}`);
        const eligible = (inherit(c, 'races') ?? []).map(r => raceIdByName.get(r)).filter((x): x is number => x !== undefined);
        const eligibleIds = [...new Set(eligible)].sort((a, b) => a - b);
        const creatableRaceIds = eligibleIds.filter(r => races.find(x => x.id === r)?.creatable);
        const startable = (startingClasses[String(realm)] ?? []).includes(id);
        const specializations = (csc.get(id) ?? []).sort((a, b) => a.levelAcquired - b.levelAcquired || a.spec.localeCompare(b.spec));
        classes.push({
            id, key: c.key, name: c.name, femaleName: c.femaleName, realm, isBaseClass: isBase,
            baseClassId: base ? classEnum.get(base.key) ?? id : id, baseClassName: c.baseName,
            advancedClassIds: [],
            startable, creatable: startable && creatableRaceIds.length > 0,
            eligibleRaceIds: eligibleIds, creatableRaceIds,
            gender: classGender.get(c.key) ?? null,
            primaryStat: asStat(inherit(c, 'primary')), secondaryStat: asStat(inherit(c, 'secondary')),
            tertiaryStat: asStat(inherit(c, 'tertiary')), manaStat: asStat(inherit(c, 'mana')),
            specializationMultiplier: inherit(c, 'specMult') ?? 10, baseHP: inherit(c, 'baseHP') ?? 700,
            wsBase: inherit(c, 'wsBase') ?? 400, classType: inherit(c, 'classType') ?? 'ListCaster',
            specializations, autotrainSpecs: autotrainOf(c, specializations),
        });
    }
    classes.sort((a, b) => a.id - b.id);
    for (const c of classes) {
        if (c.isBaseClass) continue;
        const base = classes.find(b => b.id === c.baseClassId && b.isBaseClass);
        if (base) base.advancedClassIds.push(c.id);
    }
    // Statement order in CharacterStatValidator.cs: PointDistributionBudget = 30.
    const validator = stripCsComments(readFileSync(join(GAMESERVER_DIR, 'gameutils', 'CharacterStatValidator.cs'), 'utf8'));
    const budget = Number(/PointDistributionBudget\s*=\s*(\d+)/.exec(validator)?.[1] ?? 30);
    return { classes, races, startingClasses, statPointBudget: budget };
}

// ── Output registry ─────────────────────────────────────────────────────────

export interface GeneratedFile {
    file: string;
    /** SQL tables (and C# files relative to GameServer/) the output depends on. */
    tables: string[];
    cs?: string[];
    build: () => unknown;
    count: (data: any) => number;
}

const len = (d: any) => (Array.isArray(d) ? d.length : Array.isArray(d?.rows) ? d.rows.length : Object.keys(d).length);

export const GENERATED_FILES: GeneratedFile[] = [
    { file: 'zones.json', tables: ['zones'], build: buildZones, count: len },
    { file: 'regions.json', tables: ['regions'], build: buildRegions, count: len },
    { file: 'zonepoints.json', tables: ['zonepoint'], build: buildZonePoints, count: len },
    { file: 'bindpoints.json', tables: ['bindpoint'], build: buildBindPoints, count: len },
    { file: 'teleports.json', tables: ['teleport'], build: buildTeleports, count: len },
    { file: 'startuplocations.json', tables: ['startuplocation'], build: buildStartupLocations, count: len },
    { file: 'starterequipment.json', tables: ['starterequipment'], build: buildStarterEquipment, count: len },
    { file: 'npcs.json', tables: ['mob', 'npctemplate'], build: () => buildNpcs(), count: len },
    { file: 'items.json', tables: ['itemtemplate'], build: () => buildItems(), count: len },
    { file: 'merchants.json', tables: ['merchantitem', 'itemtemplate'], build: () => buildMerchants(), count: (d: MerchantsFile) => Object.keys(d.lists).length },
    { file: 'spells.json', tables: ['spell'], build: buildSpells, count: len },
    { file: 'spelllines.json', tables: ['spellline', 'linexspell'], build: buildSpellLines, count: len },
    { file: 'styles.json', tables: ['style', 'stylexspell', 'spell'], build: () => buildStyles(), count: len },
    { file: 'specializations.json', tables: ['specialization', 'specxability'], build: buildSpecializations, count: len },
    { file: 'abilities.json', tables: ['ability'], build: buildAbilities, count: len },
    {
        file: 'classes.json', tables: ['race', 'classxspecialization'],
        cs: ['Enums/eCharacterClass.cs', 'Enums/eRace.cs', 'GlobalConstants.cs', 'gameobjects/PlayerRace.cs', 'gameutils/CharacterStatValidator.cs', 'gameutils/SkillConstants.cs', 'playerclasses'],
        build: buildClasses, count: (d: ClassesFile) => d.classes.length,
    },
];

function mtimeOf(p: string): number {
    if (!existsSync(p)) return 0;
    const s = statSync(p);
    if (!s.isDirectory()) return s.mtimeMs;
    let max = s.mtimeMs;
    for (const e of readdirSync(p)) max = Math.max(max, mtimeOf(join(p, e)));
    return max;
}

/** True if the output is missing or older than any source (or this builder). */
export function isStale(g: GeneratedFile): boolean {
    const out = mtimeOf(join(GENERATED_DIR, g.file));
    if (!out) return true;
    const sources = [
        ...g.tables.map(t => join(DB_DIR, `${t}.sql`)),
        ...(g.cs ?? []).map(c => join(GAMESERVER_DIR, c)),
        join(import.meta.dir, 'build.ts'), join(import.meta.dir, 'zones.ts'), join(import.meta.dir, 'sql.ts'),
    ];
    return sources.some(s => mtimeOf(s) > out);
}

// On Windows a rename over a file fails with EPERM while any process has it open, even a
// reader sharing it for delete. A read or another process's rename clears within ~100 ms.
// Keep the total short: a load blocks the event loop while it waits.
const RENAME_BUSY_CODES = ['EPERM', 'EBUSY'];
const RENAME_RETRY_MS = [20, 40, 80, 160];

function renameRetrying(from: string, to: string): void {
    for (const ms of RENAME_RETRY_MS) {
        try {
            renameSync(from, to);
            return;
        } catch (e) {
            if (!RENAME_BUSY_CODES.includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
            Bun.sleepSync(ms);
        }
    }
    renameSync(from, to);
}

/** Write a generated file and return its size. Throws if it can't be put in place. */
export function writeGenerated(file: string, data: unknown): number {
    mkdirSync(GENERATED_DIR, { recursive: true });
    const json = JSON.stringify(data);
    // Write-then-rename so concurrent bot processes never read a partial file.
    const tmp = join(GENERATED_DIR, `.${file}.${process.pid}.tmp`);
    try {
        writeFileSync(tmp, json);
        renameRetrying(tmp, join(GENERATED_DIR, file));
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            // Held open as well: leave it, and report why the write failed.
        }
        throw e;
    }
    return json.length;
}

/** Build one generated file by name, try to write it, and return its data. */
export function buildGenerated(file: string): unknown {
    const g = GENERATED_FILES.find(x => x.file === file);
    if (!g) throw new Error(`build-data: unknown generated file ${file}`);
    try {
        const data = g.build();
        try {
            writeGenerated(g.file, data);
        } catch (e) {
            // The load only needs the data. The file stays stale, so the next process rebuilds it.
            console.warn(`warning: ${g.file} not written (${e instanceof Error ? e.message : e}); using the data just built`);
        }
        return data;
    } finally {
        clearTableCache();
    }
}
