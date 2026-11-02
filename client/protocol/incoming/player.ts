// Own-character state packets: status, points, money, stats, skills, inventory.

import { ObjectType, type CombatResult, type SpellDetails, type StyleDetails } from '../../../sdk/types';
import { PacketReader } from '../buffer';

/**
 * 0xD8 DelveInfo (PacketLib1110.cs:36-43), one skill's tooltip: `(Kind (Key "value")(Key2 "value2"))`
 * (ClientDelve.cs). The server pushes one for each usable style, spell and ability right after the
 * skills list and again at most hourly (PacketLib1110.cs:159-212, GameClient.CanSendTooltip).
 * Elements whose value is 0 or empty are left out (ClientDelve.cs:15). Null for anything else.
 */
export function decodeDelveInfo(p: Uint8Array): { kind: string; fields: Record<string, string> } | null {
    const text = new TextDecoder('latin1').decode(p).split('\0')[0]!;
    const kind = /^\((\w+)/.exec(text)?.[1];
    if (!kind) return null;
    const fields: Record<string, string> = {};
    // Lazy up to `")`, since a spell's description can hold quotes and brackets of its own.
    for (const m of text.matchAll(/\((\w+) "(.*?)"\)/gs)) fields[m[1]!] = m[2]!;
    return { kind, fields };
}

const num = (fields: Record<string, string>, key: string): number => Number(fields[key] ?? 0) || 0;

/** eAttackResultRequirement (Style.cs). */
const STYLE_RESULTS: Record<number, CombatResult> = { 1: 'miss', 2: 'hit', 3: 'parry', 4: 'block', 5: 'evade', 6: 'fumble', 7: 'styledHit' };
const STYLE_OPENINGS = ['offensive', 'defensive', 'positional'] as const;
const STYLE_POSITIONS = ['back', 'side', 'front'] as const;

/** SpellDelve.GetStyleString. An absent opening type or position is the 0 the writer leaves out. */
export function toStyleDetails(fields: Record<string, string>): StyleDetails {
    const opening = STYLE_OPENINGS[num(fields, 'OpeningType')] ?? 'offensive';
    return {
        fatigue: num(fields, 'Fatigue'),
        attackMod: num(fields, 'AttackMod'),
        defensiveMod: num(fields, 'DefensiveMod'),
        openingDamage: num(fields, 'OpeningDamage'),
        opening,
        result: STYLE_RESULTS[num(fields, 'OpeningResult')] ?? null,
        position: opening === 'positional' ? STYLE_POSITIONS[num(fields, 'OpeningNumber')] ?? null : null,
        openingStyle: fields.OpeningStyle ?? null,
        followUps: fields.FollowupStyle?.split(', ') ?? [],
        weapon: fields.Weapon ?? null,
        stealth: num(fields, 'Hidden') !== 0,
        procSpellId: fields.SpecialNumber ? num(fields, 'SpecialNumber') & 0xffff : null,
    };
}

/** SpellDelve's _damageTypeToIdMap. */
const DAMAGE_TYPES: Record<number, string> = { 1: 'crush', 2: 'slash', 3: 'thrust', 10: 'heat', 11: 'spirit', 12: 'cold', 13: 'matter', 16: 'body', 20: 'energy' };
/** SpellDelve.GetSpellTargetType. */
const SPELL_TARGETS: Record<number, SpellDetails['target']> = { 0: 'self', 1: 'enemy', 3: 'group', 6: 'pet', 7: 'realm', 8: 'corpse', 9: 'area' };
/** SpellDelve.GetCostTypeId. */
const COST_TYPES: Record<number, SpellDetails['costType']> = { 0: 'power', 2: 'health', 3: 'endurance' };

/** SpellDelve.GetSpellString. A cast under 2 s has neither `cast_timer` nor `instant`, so its time is unknown. */
export function toSpellDetails(fields: Record<string, string>): SpellDetails {
    return {
        castTimeMs: fields.instant ? 0 : fields.cast_timer ? num(fields, 'cast_timer') + 2000 : null,
        damageType: DAMAGE_TYPES[num(fields, 'damage_type')] ?? null,
        powerCost: num(fields, 'power_cost'),
        costType: COST_TYPES[num(fields, 'cost_type')] ?? 'power',
        range: num(fields, 'range'),
        durationSeconds: num(fields, 'duration'),
        recastSeconds: num(fields, 'timer_value'),
        target: SPELL_TARGETS[num(fields, 'target')] ?? 'self',
        radius: num(fields, 'radius'),
        concentration: num(fields, 'concentration_points'),
        frequencyMs: num(fields, 'frequency'),
        description: fields.delve_string ?? '',
    };
}

/** 0xAD CharacterStatusUpdate (PacketLib190.cs:53-75), 22 bytes. */
export interface StatusUpdate {
    healthPercent: number;
    manaPercent: number;
    /** 0x02 = sitting (PacketLib168.cs:1252 / GamePlayer). */
    sittingFlag: number;
    endurancePercent: number;
    concentrationPercent: number;
    maxMana: number;
    maxEndurance: number;
    maxConcentration: number;
    maxHealth: number;
    health: number;
    endurance: number;
    mana: number;
    concentration: number;
}

export function decodeStatusUpdate(p: Uint8Array): StatusUpdate {
    const r = new PacketReader(p);
    const healthPercent = r.u8();
    const manaPercent = r.u8();
    const sittingFlag = r.u8();
    const endurancePercent = r.u8();
    const concentrationPercent = r.u8();
    r.u8();
    return {
        healthPercent, manaPercent, sittingFlag, endurancePercent, concentrationPercent,
        maxMana: r.u16(),
        maxEndurance: r.u16(),
        maxConcentration: r.u16(),
        maxHealth: r.u16(),
        health: r.u16(),
        endurance: r.u16(),
        mana: r.u16(),
        concentration: r.u16(),
    };
}

/** 0x91 CharacterPointsUpdate (PacketLib190.cs:33-50). XP fields are u64 LE. */
export interface PointsUpdate {
    realmPoints: number;
    levelPermill: number;
    specPoints: number;
    bountyPoints: number;
    realmSpecPoints: number;
    championLevelPermill: number;
    experience: number;
    experienceForNextLevel: number;
}

export function decodePointsUpdate(p: Uint8Array): PointsUpdate {
    const r = new PacketReader(p);
    return {
        realmPoints: r.u32(),
        levelPermill: r.u16(),
        specPoints: r.u16(),
        bountyPoints: r.u32(),
        realmSpecPoints: r.u16(),
        championLevelPermill: r.u16(),
        experience: r.u64le(),
        experienceForNextLevel: r.u64le(),
    };
}

/** 0xFA MoneyUpdate (PacketLib168.cs:1186-1199): u8 copper, u8 silver, u16 gold, u16 mithril, u16 platinum. */
export interface MoneyUpdate {
    copper: number;
    silver: number;
    gold: number;
    mithril: number;
    platinum: number;
}

export function decodeMoney(p: Uint8Array): MoneyUpdate {
    const r = new PacketReader(p);
    return { copper: r.u8(), silver: r.u8(), gold: r.u16(), mithril: r.u16(), platinum: r.u16() };
}

/** 0xFB StatsUpdate (PacketLib175.cs:188) or the resists variant (175:331); byte 72 is 0x00 / 0xFF. */
export interface StatsUpdate {
    kind: 'stats' | 'resists';
    /** Constitution lost to deaths (stats packets only); a healer restores it for money. */
    constitutionLost: number;
    base: number[];
    /**
     * Buffs minus debuffs, signed: the server writes `(ushort) buff` where buff = modified - base -
     * ability bonus - capped item bonus (PacketLib175.cs:254-275; resists: GetModifiedFromBuffs, 175:368-372),
     * so a debuff arrives as 0xFFxx.
     */
    buff: number[];
    item: number[];
    itemCap: number[];
    ra: number[];
    maxHealth: number;
}

export function decodeStatsUpdate(p: Uint8Array): StatsUpdate {
    const r = new PacketReader(p);
    const isResists = p[72] === 0xFF;
    const n = isResists ? 9 : 8;
    const readShorts = (signed = false): number[] => {
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(signed ? r.i16() : r.u16());
        if (!isResists) r.u16();
        return a;
    };
    const readBytes = (): number[] => {
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(r.u8());
        if (!isResists) r.u8();
        return a;
    };
    const base = readShorts();
    const buff = readShorts(true);
    const item = readShorts();
    const itemCap = readBytes();
    const ra = readBytes();
    let maxHealth = 0;
    // Byte 73: Constitution lost to deaths, not yet restored at a healer (PacketLib175.cs:323).
    const constitutionLost = !isResists && p.length > 73 ? p[73]! : 0;
    if (!isResists && p.length >= 76) {
        r.pos = 74;
        maxHealth = r.u16();
    }
    return { kind: isResists ? 'resists' : 'stats', base, buff, item, itemCap, ra, maxHealth, constitutionLost };
}

// ── Items ───────────────────────────────────────────────────────────────────

export interface ItemData {
    level: number;
    value1: number;
    value2: number;
    hand: number;
    damageType: number;
    objectType: number;
    weight: number;
    condition: number;
    durability: number;
    quality: number;
    bonus: number;
    bonusLevel: number;
    model: number;
    extension: number;
    color: number;
    flag: number;
    spell1: string | null;
    spell2: string | null;
    effect: number;
    name: string;
    /** Stack count recovered from value fields / "N name" prefix. */
    count: number;
    /** Empty slot (24 zero bytes). */
    empty: boolean;
}

/** WriteItemData (PacketLib1124.cs:836-990). An empty slot is 24 zero bytes, which also parses as this layout. */
export function readItemData(r: PacketReader): ItemData {
    r.u16(); // unique id
    const level = r.u8();
    const value1 = r.u8();
    const value2 = r.u8();
    const handByte = r.u8();
    const typeByte = r.u8();
    r.u8();
    const weight = r.u16();
    const condition = r.u8();
    const durability = r.u8();
    const quality = r.u8();
    const bonus = r.u8();
    const bonusLevel = r.u8();
    const model = r.u16();
    const extension = r.u8();
    const color = r.u16();
    const flag = r.u8();
    let spell1: string | null = null;
    let spell2: string | null = null;
    if (flag & 0x08) {
        r.u16();
        spell1 = r.pascal();
    }
    if (flag & 0x10) {
        r.u16();
        spell2 = r.pascal();
    }
    const effect = r.u16();
    let name = r.pascal();
    const objectType = typeByte & 0x3F;
    // These types also carry the count in the value bytes, its low bits only (PacketLib1124.cs:850-863).
    const generic = objectType === ObjectType.GenericItem;
    const held = generic ? value1 | (value2 << 8)
        : objectType === ObjectType.Arrow || objectType === ObjectType.Bolt || objectType === ObjectType.Poison ? value1
        : objectType === ObjectType.Thrown ? value2
        : null;
    let count = held === null ? 1 : Math.max(1, held);
    // The server writes "<count> <name>" only when Count > 1 (:978-979), and real templates start with a number
    // too ('100 gold rent token', '20 Elven Arrows'), so a prefix is a count only where those bytes agree.
    const m = /^(\d+) (.+)$/.exec(name);
    if (m) {
        const prefix = Number(m[1]);
        if (prefix > 1 && (held === null || (prefix & (generic ? 0xFFFF : 0xFF)) === held)) {
            count = prefix;
            name = m[2]!;
        }
    }
    return {
        level, value1, value2,
        hand: handByte >> 6,
        damageType: typeByte >> 6,
        objectType, weight, condition, durability, quality, bonus, bonusLevel, model, extension, color, flag,
        spell1, spell2, effect, name, count,
        empty: model === 0 && name === '',
    };
}

/** 0x02 InventoryUpdate (PacketLib189.cs:129-157 / 160-200). */
export interface InventoryUpdate {
    windowType: number;
    visibleActiveWeaponSlots: number;
    items: Array<{ slot: number; item: ItemData }>;
}

export function decodeInventoryUpdate(p: Uint8Array): InventoryUpdate {
    const r = new PacketReader(p);
    const count = r.u8();
    r.u8();
    r.u8();
    r.u8();
    const visibleActiveWeaponSlots = r.u8();
    const windowType = r.u8();
    const items: Array<{ slot: number; item: ItemData }> = [];
    for (let i = 0; i < count; i++) {
        const slot = r.u8();
        items.push({ slot, item: readItemData(r) });
    }
    return { windowType, visibleActiveWeaponSlots, items };
}

// ── 0x16 VariousUpdate ──────────────────────────────────────────────────────

export interface UsableSkillEntry {
    /** 0 Spec, 1 Ability, 2 Style, 3 Spell, 4 Song, 5 AbilitySpell, 6 RealmAbility (eSkillPage). */
    skillType: number;
    level: number;
    internalId: number;
    /** Style prereq, or spec index for spells. */
    special: number;
    bonus: number;
    icon: number;
    name: string;
}

export interface SkillsPage {
    sub: 0x01;
    firstIndex: number;
    /** 0x63 = more pages follow, 0x03 = last page. */
    subtype: number;
    entries: UsableSkillEntry[];
}

export interface SpellLinePage {
    sub: 0x02;
    /** True for the 02 00 63 00 footer. */
    footer: boolean;
    lineIndex: number;
    lineName: string;
    lineInternalId: number;
    spells: Array<{ level: number; internalId: number; icon: number; name: string; kind: 'spell' | 'style' | 'ability' }>;
}

export interface PlayerUpdate {
    sub: 0x03;
    level: number;
    name: string;
    className: string;
    profession: string;
    classTitle: string;
    realmLevel: number;
    realmTitle: string;
    realmSpecPoints: number;
    baseClass: string;
    guildName: string;
    lastName: string;
    raceName: string;
    maxHealth: number;
}

export interface GroupWindow {
    sub: 0x06;
    members: Array<{ name: string; className: string; objectId: number; level: number }>;
}

export interface OtherVarious {
    sub: number;
}

export type VariousUpdate = SkillsPage | SpellLinePage | PlayerUpdate | GroupWindow | OtherVarious;

const none = (s: string): string => (s === 'None' ? '' : s);

/** 0x16 VariousUpdate subcodes 0x01 (PacketLib1112.cs:21-180), 0x02 (1112.cs:189-260), 0x03 (179.cs:23-90), 0x06 (1125.cs:387-411). */
export function decodeVariousUpdate(p: Uint8Array): VariousUpdate {
    const r = new PacketReader(p);
    const sub = r.u8();
    const count = r.u8();
    if (sub === 0x06) {
        // Header is only 2 bytes here: [06][count] (a bare 06 00 is sent at login).
        const members: GroupWindow['members'] = [];
        for (let i = 0; i < count; i++) {
            const name = r.pascal();
            const className = r.pascal();
            const objectId = r.u16();
            const level = r.u8();
            members.push({ name, className, objectId, level });
        }
        return { sub: 0x06, members };
    }
    const subtype = r.remaining > 0 ? r.u8() : 0;
    const extra = r.remaining > 0 ? r.u8() : 0;
    if (sub === 0x01) {
        const entries: UsableSkillEntry[] = [];
        for (let i = 0; i < count; i++) {
            const level = r.u8();
            const internalId = r.u16();
            const skillType = r.u8();
            const special = r.u16();
            const bonus = r.u8();
            const icon = r.u16();
            const name = r.pascal();
            entries.push({ skillType, level, internalId, special, bonus, icon, name });
        }
        return { sub: 0x01, firstIndex: extra, subtype, entries };
    }
    if (sub === 0x02) {
        if (subtype === 99) return { sub: 0x02, footer: true, lineIndex: extra, lineName: '', lineInternalId: 0, spells: [] };
        r.u16le();
        const lineInternalId = r.u16();
        r.u16();
        const lineName = r.pascal();
        const spells: SpellLinePage['spells'] = [];
        for (let i = 1; i < count; i++) {
            const lv = r.u16le();
            const internalId = r.u16();
            const icon = r.u16();
            const name = r.pascal();
            const kind = lv >= 512 ? 'style' : lv >= 256 ? 'ability' : 'spell';
            spells.push({ level: lv & 0xFF, internalId, icon, name, kind });
        }
        return { sub: 0x02, footer: false, lineIndex: extra, lineName, lineInternalId, spells };
    }
    if (sub === 0x03) {
        const level = r.u8();
        const name = r.pascal();
        const hpHi = r.u8();
        const className = r.pascal();
        const hpLo = r.u8();
        const profession = r.pascal();
        r.u8();
        const classTitle = r.pascal();
        const realmLevel = r.u8();
        const realmTitle = r.pascal();
        const realmSpecPoints = r.u8();
        const baseClass = r.pascal();
        r.u8();
        const guildName = r.pascal();
        r.u8();
        const lastName = r.pascal();
        r.u8();
        const raceName = r.pascal();
        return {
            sub: 0x03, level, name: none(name), className: none(className), profession: none(profession),
            classTitle: none(classTitle), realmLevel, realmTitle: none(realmTitle), realmSpecPoints,
            baseClass: none(baseClass), guildName: none(guildName), lastName: none(lastName), raceName: none(raceName),
            maxHealth: (hpHi << 8) | hpLo,
        };
    }
    return { sub };
}
