// Static world data for bots: typed lazy loaders + query helpers over
// data/generated/*.json (built by `bun run data:build`, or on first use here).
//
// Everything is DB-derived (server/db dumps) or C#-derived (classes/races).
// There is no terrain in the DB, so estimateZ() interpolates from known
// ground positions (mob spawns, bind points, startup locations, ...).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Realm, Stats } from '../sdk/types';
import {
    buildGenerated, GENERATED_DIR, GENERATED_FILES, isStale,
    type AbilityInfo, type BindPoint, type ClassesFile, type ClassInfo, type CompactTable, type ItemTemplate,
    type MerchantEntry, type MerchantsFile, type NpcSpawn, type RaceInfo, type SpecializationInfo, type SpellInfo,
    type SpellLineInfo, type StarterEquipment, type StartupLocation, type StatName, type StyleInfo, type Teleport, type ZonePoint,
} from './build';

export * from './zones';
export type {
    AbilityInfo, BindPoint, ClassesFile, ClassInfo, ItemTemplate, MerchantEntry, NpcSpawn, RaceInfo,
    SpecializationInfo, SpellInfo, SpellLineInfo, StarterEquipment, StartupLocation, StatName, StyleInfo, Teleport, ZonePoint,
};

// ── Loading ─────────────────────────────────────────────────────────────────

const cache = new Map<string, unknown>();

/** Read data/generated/<file>, (re)building and writing it if missing or older than its sources. */
export function loadGenerated<T>(file: string): T {
    let v = cache.get(file) as T | undefined;
    if (v !== undefined) return v;
    const p = join(GENERATED_DIR, file);
    const g = GENERATED_FILES.find(x => x.file === file);
    if (existsSync(p) && !(g && isStale(g))) {
        try {
            v = JSON.parse(readFileSync(p, 'utf8')) as T;
        } catch {
            v = undefined;
        }
    }
    if (v === undefined) v = buildGenerated(file) as T;
    cache.set(file, v);
    return v;
}

function expand<T>(t: CompactTable): T[] {
    const cols = t.columns;
    return t.rows.map(r => {
        const o: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) o[cols[i]!] = r[i];
        return o as T;
    });
}

function memo<T>(fn: () => T): () => T {
    let v: T | undefined;
    return () => (v ??= fn());
}

export const getNpcSpawns = memo(() => expand<NpcSpawn>(loadGenerated<CompactTable>('npcs.json')));
export const getItemTemplates = memo(() => expand<ItemTemplate>(loadGenerated<CompactTable>('items.json')));
export const getZonePoints = memo(() => loadGenerated<ZonePoint[]>('zonepoints.json'));
export const getBindpoints = memo(() => loadGenerated<BindPoint[]>('bindpoints.json'));
export const getTeleports = memo(() => loadGenerated<Teleport[]>('teleports.json'));
export const getStartupLocations = memo(() => loadGenerated<StartupLocation[]>('startuplocations.json'));
export const getStarterEquipmentRows = memo(() => loadGenerated<StarterEquipment[]>('starterequipment.json'));
export const getSpells = memo(() => loadGenerated<SpellInfo[]>('spells.json'));
export const getSpellLines = memo(() => loadGenerated<SpellLineInfo[]>('spelllines.json'));
export const getStyles = memo(() => loadGenerated<StyleInfo[]>('styles.json'));
export const getSpecializations = memo(() => loadGenerated<SpecializationInfo[]>('specializations.json'));
export const getAbilities = memo(() => loadGenerated<AbilityInfo[]>('abilities.json'));
const classesFile = memo(() => loadGenerated<ClassesFile>('classes.json'));

const lowerIndex = <T>(list: T[], key: (t: T) => string) => {
    const m = new Map<string, T>();
    for (const t of list) {
        const k = key(t).toLowerCase();
        if (!m.has(k)) m.set(k, t);
    }
    return m;
};

// ── Realms ──────────────────────────────────────────────────────────────────

const REALM_IDS: Record<string, number> = { none: 0, albion: 1, alb: 1, midgard: 2, mid: 2, hibernia: 3, hib: 3 };
const REALM_NAMES: Realm[] = ['none', 'albion', 'midgard', 'hibernia'];

/** 'albion' | 'alb' | 1 -> 1, etc. Returns 0 for none/unknown. */
export function realmId(realm: Realm | string | number): number {
    if (typeof realm === 'number') return realm >= 0 && realm <= 3 ? realm : 0;
    return REALM_IDS[realm.toLowerCase()] ?? 0;
}

export function realmName(realm: number): Realm {
    return REALM_NAMES[realm] ?? 'none';
}

// ── NPC spawns ──────────────────────────────────────────────────────────────

export interface NpcSpawnQuery {
    /** String = case-insensitive substring; RegExp tested against the name. */
    name?: string | RegExp;
    guild?: string | RegExp;
    /** Matched against classType without the "DOL.GS." prefix, e.g. 'GameMerchant', /Trainer/. */
    classType?: string | RegExp;
    regionId?: number;
    /** Sort by 2D distance from here (and filter by radius when given). */
    near?: { x: number; y: number };
    radius?: number;
    /** Inclusive [min, max]. */
    levelRange?: [number, number];
    realm?: Realm | number;
    limit?: number;
}

export type NpcSpawnMatch = NpcSpawn & { /** 2D distance from query.near, or null without near. */ distance: number | null };

const textMatch = (v: string, q: string | RegExp | undefined) =>
    q === undefined || (typeof q === 'string' ? v.toLowerCase().includes(q.toLowerCase()) : q.test(v));

/** Mob spawn points from the DB (`mob` table). Sorted by distance when `near` is given. */
export function findNpcSpawns(q: NpcSpawnQuery = {}): NpcSpawnMatch[] {
    const realm = q.realm === undefined ? undefined : realmId(q.realm);
    const r2 = q.radius !== undefined ? q.radius * q.radius : Infinity;
    const out: NpcSpawnMatch[] = [];
    for (const n of getNpcSpawns()) {
        if (q.regionId !== undefined && n.regionId !== q.regionId) continue;
        if (realm !== undefined && n.realm !== realm) continue;
        if (q.levelRange && (n.level < q.levelRange[0] || n.level > q.levelRange[1])) continue;
        let distance: number | null = null;
        if (q.near) {
            const dx = n.x - q.near.x, dy = n.y - q.near.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            distance = Math.sqrt(d2);
        }
        if (!textMatch(n.name, q.name) || !textMatch(n.guild, q.guild) || !textMatch(n.classType, q.classType)) continue;
        out.push({ ...n, distance });
    }
    if (q.near) out.sort((a, b) => a.distance! - b.distance!);
    return q.limit !== undefined ? out.slice(0, q.limit) : out;
}

// ── Bind points, zone points, teleports, startup locations ─────────────────

/** Nearest bind point in a region; realm-specific points only match that realm (realm 0 points match all). */
export function nearestBindpoint(regionId: number, x: number, y: number, realm?: Realm | number): (BindPoint & { distance: number }) | undefined {
    const r = realm === undefined ? undefined : realmId(realm);
    let best: (BindPoint & { distance: number }) | undefined;
    for (const b of getBindpoints()) {
        if (b.regionId !== regionId) continue;
        if (r !== undefined && r !== 0 && b.realm !== 0 && b.realm !== r) continue;
        const d = Math.hypot(b.x - x, b.y - y);
        if (!best || d < best.distance) best = { ...b, distance: d };
    }
    return best;
}

/** Zone points (region-change portals) whose source is in this region. Use `id` in the 0x90 RegionChange packet. */
export function getZonePointsFrom(regionId: number): ZonePoint[] {
    return getZonePoints().filter(z => z.sourceRegion === regionId);
}

/**
 * A zone point by id. 20 ids have a row per realm, and the server takes the row of the player's
 * realm or of realm 0 (RegionChangeRequestHandler.cs:33-39). With `realm`, that row; without one,
 * or with no such row, the id's first.
 */
export function getZonePoint(id: number, realm?: Realm | number): ZonePoint | undefined {
    const rows = getZonePoints().filter(z => z.id === id);
    const mine = realmId(realm ?? 0);
    return rows.find(z => z.realm === 0 || z.realm === mine) ?? rows[0];
}

/** Teleport destinations (whisper `teleportId` to a teleporter of that realm). */
export function getTeleportsForRealm(realm: Realm | number): Teleport[] {
    const r = realmId(realm);
    return getTeleports().filter(t => t.realm === r || t.realm === 0);
}

/**
 * The class a new character has once the server has created it. With start_as_base_class on, the
 * server's default, an advanced class is reverted to its base class (StartAsBaseClass.cs:84).
 */
export function classAfterCreation(classId: number, startAsBaseClass = true): number {
    return startAsBaseClass ? getClass(classId)?.baseClassId ?? classId : classId;
}

/**
 * Where a freshly created character spawns, mirroring
 * StartupLocations.GetAllStartupLocationForCharacter (scripts/gameevents/StartupLocations.cs:142).
 * classId is the class sent at creation, but the server looks up classAfterCreation: its handler chain
 * runs the newest handler first (DOLEventHandlerChain.cs), and StartAsBaseClass registers its
 * CharacterCreated handler on GameServerStartedEvent (StartAsBaseClass.cs:46), after StartupLocations
 * does on ScriptLoadedEvent (StartupLocations.cs:30). Every DB row has ClassID and RaceID set, so the
 * class matters. Pass startAsBaseClass: false for a server with that property off.
 */
export function getStartupLocation(opts: {
    realm: Realm | number; raceId: number; classId: number; clientVersion?: number; clientRegionId?: number; startAsBaseClass?: boolean;
}): StartupLocation | undefined {
    const realm = realmId(opts.realm);
    const ver = opts.clientVersion ?? 1127;
    const region = opts.clientRegionId ?? 0;
    const classId = classAfterCreation(opts.classId, opts.startAsBaseClass);
    const list = getStartupLocations().filter(s => s.minVersion <= ver
        && (s.classId === 0 || s.classId === classId)
        && (s.raceId === 0 || s.raceId === opts.raceId)
        && (s.realm === 0 || s.realm === realm)
        && (s.clientRegionId === 0 || s.clientRegionId === region));
    list.sort((a, b) => b.minVersion - a.minVersion || b.clientRegionId - a.clientRegionId
        || b.realm - a.realm || b.classId - a.classId || b.raceId - a.raceId);
    return list[0];
}

// ── Items and merchants ─────────────────────────────────────────────────────

const itemIndex = memo(() => lowerIndex(getItemTemplates(), i => i.id));
const merchantIndex = memo(() => {
    const f = loadGenerated<MerchantsFile>('merchants.json');
    const m = new Map<string, unknown[][]>();
    for (const [k, v] of Object.entries(f.lists)) m.set(k.toLowerCase(), v);
    return { cols: f.columns, lists: m };
});

/** Item template by Id_nb (case-insensitive, like the server's precache). */
export function getItemTemplate(id: string): ItemTemplate | undefined {
    return itemIndex().get(id.toLowerCase());
}

export function findItemTemplates(name: string | RegExp, limit = 50): ItemTemplate[] {
    const out: ItemTemplate[] = [];
    for (const it of getItemTemplates()) {
        if (!textMatch(it.name, name)) continue;
        out.push(it);
        if (out.length >= limit) break;
    }
    return out;
}

/** Items sold by a merchant list (NpcSpawn.itemsListTemplateId), sorted by itemSlot = page*30+slot. */
export function getMerchantItems(itemListId: string): MerchantEntry[] {
    const { lists } = merchantIndex();
    const rows = lists.get(itemListId.toLowerCase());
    if (!rows) return [];
    return rows.map(([page, slot, itemTemplateId, name, level, price, model]) => ({
        page: page as number, slot: slot as number, itemSlot: (page as number) * 30 + (slot as number),
        itemTemplateId: itemTemplateId as string, name: name as string, level: level as number,
        price: price as number, model: model as number,
    }));
}

/** An item a new character is given, and whether the server can actually hand it out. */
export interface StarterItem {
    rowId: number;
    templateId: string;
    /** undefined: the template is missing, so the server skips the row (StartupEquipment.cs:82-86). */
    item: ItemTemplate | undefined;
}

/**
 * Starter equipment for a class as CreationStartupEquipment hands it out:
 * the class's own rows plus the class-0 rows, but only when the class has rows
 * of its own (StartupEquipment.cs:125-128). Rows with a missing template are
 * returned with `item: undefined`; the character never gets them.
 */
export function getStarterEquipment(cls: number | string, realm?: Realm | number): StarterItem[] {
    const classId = typeof cls === 'number' ? cls : getClass(cls, realm)?.id;
    if (classId === undefined) return [];
    const rows = getStarterEquipmentRows();
    if (!rows.some(r => r.classIds.includes(classId))) return [];
    return rows.filter(r => r.classIds.includes(classId) || r.classIds.includes(0))
        .map(r => ({ rowId: r.id, templateId: r.templateId, item: getItemTemplate(r.templateId) }));
}

/** eInventorySlot of the armour pieces: head, hands, feet, torso, legs, arms (gameutils/IGameInventory.cs:38-46). */
const ARMOUR_SLOTS = new Set([21, 22, 23, 25, 27, 28]);

/**
 * What a new character of this class really starts with: the armour pieces it
 * gets, and the template ids the server skips because they are missing. An
 * empty `armour` with a non-empty `missing` means the class starts unarmoured,
 * as Guardian did in upstream's dump (learnings/classes-and-races.md).
 */
export function getStarterArmour(cls: number | string, realm?: Realm | number): { armour: ItemTemplate[]; missing: string[] } {
    const armour: ItemTemplate[] = [];
    const missing: string[] = [];
    for (const s of getStarterEquipment(cls, realm)) {
        if (!s.item) missing.push(s.templateId);
        else if (ARMOUR_SLOTS.has(s.item.itemType)) armour.push(s.item);
    }
    return { armour, missing };
}

// ── Spells / styles / specs / abilities ─────────────────────────────────────

const spellIndex = memo(() => new Map(getSpells().map(s => [s.id, s])));
const lineIndex = memo(() => lowerIndex(getSpellLines(), l => l.keyName));
const specIndex = memo(() => lowerIndex(getSpecializations(), s => s.keyName));
const abilityIndex = memo(() => lowerIndex(getAbilities(), a => a.keyName));

export function getSpell(spellId: number): SpellInfo | undefined {
    return spellIndex().get(spellId);
}

export function getSpellLine(keyName: string): SpellLineInfo | undefined {
    return lineIndex().get(keyName.toLowerCase());
}

/** Styles for a class (style.ClassId), optionally one spec line, sorted by spec level. */
export function getStylesFor(classId: number, specKeyName?: string): StyleInfo[] {
    const spec = specKeyName?.toLowerCase();
    return getStyles().filter(s => s.classId === classId && (spec === undefined || s.specKeyName.toLowerCase() === spec));
}

export function getSpecialization(keyName: string): SpecializationInfo | undefined {
    return specIndex().get(keyName.toLowerCase());
}

export function getAbility(keyName: string): AbilityInfo | undefined {
    return abilityIndex().get(keyName.toLowerCase());
}

// ── Classes and races ───────────────────────────────────────────────────────

export const STAT_ORDER: StatName[] = ['STR', 'DEX', 'CON', 'QUI', 'INT', 'PIE', 'EMP', 'CHR'];

export function getClasses(): ClassInfo[] {
    return classesFile().classes;
}

export function getRaces(): RaceInfo[] {
    return classesFile().races;
}

/**
 * Class by eCharacterClass id, enum key ("AlbionRogue"), or display name ("Armsman").
 * Display names shared across realms ("Rogue", "Mauler") need `realm` to disambiguate.
 */
export function getClass(cls: number | string, realm?: Realm | number): ClassInfo | undefined {
    const list = getClasses();
    if (typeof cls === 'number') return list.find(c => c.id === cls);
    const k = cls.toLowerCase().replace(/[\s_-]/g, '');
    const r = realm === undefined ? undefined : realmId(realm);
    const byKey = list.find(c => c.key.toLowerCase() === k);
    if (byKey && (r === undefined || byKey.realm === r)) return byKey;
    return list.find(c => (c.name.toLowerCase().replace(/\s/g, '') === k || c.femaleName?.toLowerCase() === k)
        && (r === undefined || c.realm === r));
}

/** Race by eRace id or name ("Briton", "half ogre" -> HalfOgre). */
export function getRace(race: number | string): RaceInfo | undefined {
    const list = getRaces();
    if (typeof race === 'number') return list.find(r => r.id === race);
    const k = race.toLowerCase().replace(/[\s_-]/g, '');
    return list.find(r => r.name.toLowerCase() === k);
}

/** Classes that can actually be created for a realm (STARTING_CLASSES_DICT and at least one creatable race). */
export function getStartingClasses(realm: Realm | number): ClassInfo[] {
    const r = realmId(realm);
    return getClasses().filter(c => c.realm === r && c.creatable);
}

export function getRacesForClass(cls: number | string, realm?: Realm | number): RaceInfo[] {
    const c = getClass(cls, realm);
    if (!c) return [];
    return c.creatableRaceIds.map(id => getRace(id)!).filter(Boolean);
}

/**
 * Races a character of this class can be created as AND start with: the
 * server-valid races minus the pairs without a startuplocation row (Inconnu Acolyte,
 * Saracen Disciple, and Saracen Necromancer, which starts as a Disciple; see validateCharacter).
 */
export function getPlayableRacesForClass(cls: number | string, realm?: Realm | number, startAsBaseClass?: boolean): RaceInfo[] {
    const c = getClass(cls, realm);
    if (!c) return [];
    return getRacesForClass(c.id, c.realm).filter(r => validateCharacter({ realm: c.realm, class: c.id, race: r.id, startAsBaseClass }).warnings.length === 0);
}

/** Creatable races of a realm. */
export function getRacesForRealm(realm: Realm | number): RaceInfo[] {
    const r = realmId(realm);
    return getRaces().filter(x => x.realm === r && x.creatable);
}

export interface CharacterChoice {
    realm: Realm | number;
    class: number | string;
    race: number | string;
    gender?: 'male' | 'female';
    /** When given, also checks the 30-point budget (CharacterStatValidator.cs). */
    stats?: Partial<Record<StatName, number>>;
    /** The server's start_as_base_class property (default on); decides which start row the class gets. */
    startAsBaseClass?: boolean;
}

export interface CharacterValidation {
    valid: boolean;
    errors: string[];
    /** Server-valid but unplayable choices (e.g. no startup location: Inconnu Acolyte, Saracen Disciple, Saracen Necromancer). */
    warnings: string[];
    realmId: number;
    /** Gender to send (choice.gender, else what the race/class requires, else male). */
    gender: 'male' | 'female';
    classInfo?: ClassInfo;
    raceInfo?: RaceInfo;
}

/** Mirrors CharacterCreateRequestHandler.IsCharacterValid (packets/Client/168/CharacterCreateRequestHandler.cs:920). */
export function validateCharacter(choice: CharacterChoice): CharacterValidation {
    const errors: string[] = [];
    const r = realmId(choice.realm);
    if (r < 1 || r > 3) errors.push(`invalid realm ${String(choice.realm)}`);
    const c = getClass(choice.class, r || undefined);
    const race = getRace(choice.race);
    if (!c) errors.push(`unknown class ${String(choice.class)}`);
    if (!race) errors.push(`unknown race ${String(choice.race)}`);
    if (c && r && !(classesFile().startingClasses[String(r)] ?? []).includes(c.id))
        errors.push(`${c.name} is not a starting class for ${realmName(r)}`);
    if (c && race && !c.eligibleRaceIds.includes(race.id)) errors.push(`${race.name} cannot be a ${c.name}`);
    if (race && !race.creatable) errors.push(`${race.name} is not creatable on this server (no STARTING_STATS_DICT entry)`);
    if (race && r && race.realm !== r) errors.push(`${race.name} is not a ${realmName(r)} race`);
    // Unspecified gender resolves to whatever the constraints require (male otherwise), so the
    // caller can send `gender` from the result; RACE_/CLASS_GENDER_CONSTRAINTS_DICT, GlobalConstants.cs:1017.
    const g = choice.gender ?? race?.gender ?? c?.gender ?? 'male';
    if (race?.gender && race.gender !== g) errors.push(`${race.name} must be ${race.gender}`);
    if (c?.gender && c.gender !== g) errors.push(`${c.name} must be ${c.gender}`);
    if (choice.stats && race?.startingStats) {
        const cost = statPointCost(choice.stats, race.id);
        if (cost === null) errors.push('a stat is below the race minimum or missing');
        else if (cost !== classesFile().statPointBudget) errors.push(`stat points used ${cost}, must be exactly ${classesFile().statPointBudget}`);
    }
    // The server accepts these, but StartupLocations.cs:88 then leaves the character at 0,0,0 in region 0,
    // and loading it throws (GuildMgr.cs:37), so the client never gets a position.
    const warnings: string[] = [];
    if (errors.length === 0 && c && race && !getStartupLocation({ realm: r, raceId: race.id, classId: c.id, startAsBaseClass: choice.startAsBaseClass })) {
        const startAs = getClass(classAfterCreation(c.id, choice.startAsBaseClass)) ?? c;
        const looked = startAs.id === c.id ? '' : ` (a ${c.name} starts as one)`;
        warnings.push(`no startuplocation row for ${race.name} ${startAs.name}${looked}: the character stays at 0,0,0 in region 0 and can't enter the world`);
    }
    return { valid: errors.length === 0, errors, warnings, realmId: r, gender: g, classInfo: c, raceInfo: race };
}

export function getStartingStats(race: number | string): Record<StatName, number> | null {
    return getRace(race)?.startingStats ?? null;
}

/** Points spent above race base at level 1 (CharacterStatValidator.cs), or null if a stat is below base / missing. */
export function statPointCost(stats: Partial<Record<StatName, number>>, race: number | string): number | null {
    const base = getStartingStats(race);
    if (!base) return null;
    let total = 0;
    for (const s of STAT_ORDER) {
        const v = stats[s];
        if (v === undefined) return null;
        const above = v - base[s];
        if (above < 0) return null;
        total += above + Math.max(0, above - 10) + Math.max(0, above - 15);
    }
    return total;
}

function mostCommon<T>(xs: (T | null)[]): T | null {
    const counts = new Map<T, number>();
    for (const x of xs) if (x !== null) counts.set(x, (counts.get(x) ?? 0) + 1);
    let best: T | null = null, n = 0;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    return best;
}

/**
 * A valid 30-point allocation: +10 to the class's primary, secondary and
 * tertiary stats (each costs exactly 10). Base classes have no stats of their
 * own, so the most common choice among their advanced classes is used.
 */
export function defaultStats(cls: number | string, race: number | string, realm?: Realm | number): Record<StatName, number> {
    const c = getClass(cls, realm);
    const base = getStartingStats(race);
    if (!c) throw new Error(`unknown class ${String(cls)}`);
    if (!base) throw new Error(`race ${String(race)} has no starting stats`);
    const adv = c.advancedClassIds.map(id => getClass(id)).filter((x): x is ClassInfo => !!x);
    const pick: StatName[] = [];
    for (const k of ['primaryStat', 'secondaryStat', 'tertiaryStat'] as const) {
        const s = c[k] ?? mostCommon(adv.map(a => a[k]).filter(x => x && !pick.includes(x)));
        if (s && !pick.includes(s)) pick.push(s);
    }
    for (const s of ['STR', 'CON', 'DEX', 'QUI'] as StatName[]) if (pick.length < 3 && !pick.includes(s)) pick.push(s);
    const out = { ...base };
    for (const s of pick) out[s] += 10;
    return out;
}

/** Convert a StatName record to the SDK's Stats shape. */
export function toStats(s: Record<StatName, number>): Stats {
    return {
        strength: s.STR, dexterity: s.DEX, constitution: s.CON, quickness: s.QUI,
        intelligence: s.INT, piety: s.PIE, empathy: s.EMP, charisma: s.CHR,
    };
}

// ── Height estimation ───────────────────────────────────────────────────────

const CELL = 1024;
const NPC_FLAG_FLYING = 0x20;

interface RegionSamples {
    xs: number[];
    ys: number[];
    zs: number[];
    grid: Map<number, number[]>;
}

const cellKey = (cx: number, cy: number) => cx * 4096 + cy;

const zIndex = memo(() => {
    const regions = new Map<number, RegionSamples>();
    const add = (region: number, x: number, y: number, z: number) => {
        if (!x && !y) return;
        let r = regions.get(region);
        if (!r) regions.set(region, r = { xs: [], ys: [], zs: [], grid: new Map() });
        const i = r.xs.length;
        r.xs.push(x); r.ys.push(y); r.zs.push(z);
        const k = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
        let cell = r.grid.get(k);
        if (!cell) r.grid.set(k, cell = []);
        cell.push(i);
    };
    for (const n of getNpcSpawns()) if (!(n.flags & NPC_FLAG_FLYING)) add(n.regionId, n.x, n.y, n.z);
    for (const b of getBindpoints()) add(b.regionId, b.x, b.y, b.z);
    for (const s of getStartupLocations()) add(s.regionId, s.x, s.y, s.z);
    for (const t of getTeleports()) add(t.regionId, t.x, t.y, t.z);
    for (const z of getZonePoints()) {
        add(z.sourceRegion, z.sourceX, z.sourceY, z.sourceZ);
        add(z.targetRegion, z.targetX, z.targetY, z.targetZ);
    }
    return regions;
});

export interface EstimateZOptions {
    /** Search radius in world units (default 3000). */
    radius?: number;
    /** Max samples used (default 8). */
    k?: number;
    /** Ignore samples at exactly this position (leave-one-out testing). */
    exclude?: { x: number; y: number };
}

/**
 * Estimate ground height at (x, y): inverse-distance-weighted average of the
 * k nearest known ground positions within `radius`, after dropping samples far
 * from the local median (upper floors, cliffs). Returns `fallback` (or null)
 * when nothing is known nearby.
 */
export function estimateZ(regionId: number, x: number, y: number): number | null;
export function estimateZ(regionId: number, x: number, y: number, fallback: number, opts?: EstimateZOptions): number;
export function estimateZ(regionId: number, x: number, y: number, fallback?: number | null, opts?: EstimateZOptions): number | null;
export function estimateZ(regionId: number, x: number, y: number, fallback: number | null = null, opts: EstimateZOptions = {}): number | null {
    const r = zIndex().get(regionId);
    if (!r) return fallback;
    const radius = opts.radius ?? 3000;
    const k = opts.k ?? 8;
    const r2 = radius * radius;
    const span = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    const near: { d2: number; z: number }[] = [];
    for (let gx = cx - span; gx <= cx + span; gx++) {
        for (let gy = cy - span; gy <= cy + span; gy++) {
            const cell = r.grid.get(cellKey(gx, gy));
            if (!cell) continue;
            for (const i of cell) {
                const sx = r.xs[i]!, sy = r.ys[i]!;
                if (opts.exclude && sx === opts.exclude.x && sy === opts.exclude.y) continue;
                const dx = sx - x, dy = sy - y;
                const d2 = dx * dx + dy * dy;
                if (d2 <= r2) near.push({ d2, z: r.zs[i]! });
            }
        }
    }
    if (near.length === 0) return fallback;
    near.sort((a, b) => a.d2 - b.d2);
    let pts = near.slice(0, k);
    if (pts[0]!.d2 < 16 * 16) return pts[0]!.z;
    if (pts.length >= 4) {
        const zs = pts.map(p => p.z).sort((a, b) => a - b);
        const median = zs[zs.length >> 1]!;
        const kept = pts.filter(p => Math.abs(p.z - median) <= 400);
        if (kept.length) pts = kept;
    }
    let wsum = 0, zsum = 0;
    for (const p of pts) {
        const w = 1 / p.d2;
        wsum += w;
        zsum += w * p.z;
    }
    return Math.round(zsum / wsum);
}
