// Item delve lines to structured bonuses (pure). See learnings/looting.md "Delve".
//
// The handler's own WriteBonusLine (DetailDisplayHandler.cs:1737) is dead code for items: DelveItem
// always answers (GamePlayer.cs:13734-13756), so the lines come from GameInventoryItem.Delve
// (GameInventoryItem.cs:357). There a bonus is "<utility> | <name>: <value> <unit>" (:855-895), the
// value written as "15 " or "-5 " ("0 ;-0 ;0 "), which makes a resist "Heat: 7 %", and only the
// listed properties are percentages, so casting speed and AF end in "pts" too, whatever the comments
// at :872-875 show. The "- <name>: <value> <unit>" forms of the old handler are understood as well,
// inside a bonus section only: elsewhere "- 20 Base Factor" and "- Paladin" look much the same.
//
// Names are the English ones of SkillBase.RegisterPropertyNames (language/EN/SkillHandler.txt). A
// name or unit not listed here goes to `unknown`, never into a nearby category.

import { specKey } from '../data/spec-names';
import type { ItemBonus, ParsedDelve, SkillGroup, WeaponDelve } from './types';

const STATS: Record<string, NonNullable<ItemBonus['stat']>> = {
    Strength: 'STR', Dexterity: 'DEX', Constitution: 'CON', Quickness: 'QUI', Intelligence: 'INT',
    Piety: 'PIE', Empathy: 'EMP', Charisma: 'CHR', Acuity: 'ACU',
};

/** Resist_First..Resist_Last: written with "%" (GameInventoryItem.cs:881). Crush, Slash and Thrust are skills too: "pts". */
const RESISTS = new Set(['Body', 'Cold', 'Crush', 'Energy', 'Heat', 'Matter', 'Slash', 'Spirit', 'Thrust']);
/** Resist_Natural (249) is outside that range (eProperty.cs:30,40,301), so it reads "Essence: 5 pts". */
const ESSENCE = 'Essence';

/** Every Skill_* name by its ePropertyType (SkillBase.InitPropertyTypes), 94 in all. */
export const SKILLS: Record<SkillGroup, readonly string[]> = {
    melee: ['Two Handed', 'Crush', 'Flexible', 'Polearm', 'Slash', 'Staff', 'Thrust', 'Sword', 'Hammer', 'Axe', 'Spear', 'Blades', 'Blunt', 'Piercing', 'Large Weapons', 'Celtic Spear', 'Scythe', 'Hand to Hand', 'Fist Wraps', 'Mauler Staff'],
    dual: ['Dual Wield', 'Left Axe', 'Celtic Dual'],
    archery: ['Longbow', 'Composite Bow', 'Recurved Bow', 'Archery'],
    magic: [
        'Body Magic', 'Chants', 'Death Servant', 'Deathsight', 'Earth Magic', 'Enhancement', 'Fire Magic', 'Cold Magic', 'Instruments', 'Matter Magic',
        'Mind Magic', 'Painworking', 'Rejuvenation', 'Smiting', 'Soulrending', 'Spirit Magic', 'Wind Magic', 'Mending', 'Augmentation', 'Darkness',
        'Suppression', 'Runecarving', 'Stormcalling', 'Beastcraft', 'Light Magic', 'Void Magic', 'Mana Magic', 'Battlesongs', 'Enchantment', 'Mentalism',
        'Regrowth', 'Nurture', 'Nature', 'Music', 'Valor', 'Cave Magic', 'Bone Army', 'Verdant Path', 'Creeping Path', 'Arboreal Path',
        'Pacification', 'Savagery', 'Nightshade Magic', 'Pathfinding', 'Summoning', 'Power Strikes', 'Magnetism', 'Aura Manipulation', 'Dementia', 'Shadow Mastery',
        'Vampiiric Embrace', 'Ethereal Shriek', 'Phantasmal Wail', 'Spectral Force', 'Spectral Guard', "Odin's Will", 'Cursing', 'Hexing', 'Witchcraft',
    ],
    other: ['Critical Strike', 'Crossbow', 'Envenom', 'Parry', 'Shields', 'Stealth', 'Throwing', 'Short Bow'],
};
const SKILL_GROUP = new Map<string, SkillGroup>(Object.entries(SKILLS).flatMap(([group, names]) => names.map(n => [n, group as SkillGroup] as const)));

/** Named skills no class in classes.json trains. */
const NO_SPEC = new Set(['Archery', 'Short Bow', 'Spectral Force']);
/** The specialization a skill or focus name belongs to. */
export const specOf = (name: string): string | null => NO_SPEC.has(name) ? null : specKey(name);

const SKILL_GROUPS: Record<string, SkillGroup | null> = {
    'ALL Magic Skills': 'magic', 'ALL Melee Weapon Skills': 'melee', 'ALL Dual Wielding Skills': 'dual', 'ALL Archery Skills': 'archery', 'All Skills': null,
};

/** The focus name meaning every line (eProperty.AllFocusLevels); the rest are "<line> Focus". */
export const ALL_FOCUS = 'ALL Spell Lines';

const OTHER = new Set([
    'Body cap', 'Cold cap', 'Crush cap', 'Energy cap', 'Heat cap', 'Matter cap', 'Slash cap', 'Spirit cap', 'Thrust cap',
    'Mythical Safe Fall', 'Mythical Discumbering', 'Mythical Coin', 'Spell Focus', 'Conversion', 'Extra Health Points', 'Style Absorb', 'Arcane Syphon',
    'Realm Points', 'Bounty Points', 'Experience Points', 'Maximum Speed', 'Concentration', 'Health Regeneration', 'Power Regeneration', 'Endurance Regeneration',
    'Spell Range', 'Archery Range', 'Effective level', 'Evade chance', 'Block chance', 'Parry chance', 'Fumble Chance', 'Bonus to melee damage', 'all Ranged Damage',
    'Mesmerize Duration', 'Stun Duration', 'Speed Decrease Duration', 'Archery Speed', 'Arrow Recovery', 'all Stat Buff Spells', 'Debuff Effectiveness',
    'Bonus to healing effectiveness', 'Resist Pierce', 'Bonus to magic damage', 'Spell Duration', 'Bonus to style damage', 'Bonus to melee combat speed',
    'Bonus to Strength attribute bonus cap', 'Bonus to Dexterity attribute bonus cap', 'Bonus to Constitution attribute bonus cap', 'Bonus to Quickness attribute bonus cap',
    'Bonus to Intelligence attribute bonus cap', 'Bonus to Piety attribute bonus cap', 'Bonus to Charisma attribute bonus cap', 'Bonus to Empathy attribute bonus cap',
    'Bonus to Acuity attribute bonus cap', 'Bonus to hit points bonus cap', 'Bonus to power bonus cap', 'Bonus to Weaponskill',
    'Bonus to critical archery hit chance', 'Bonus to critical melee hit chance', 'Bonus to critical spell hit chance', 'Bonus to critical heal hit chance',
    'Mythical Stat Cap (Strength)', 'Mythical Stat Cap (Dexterity)', 'Mythical Stat Cap (Constitution)', 'Mythical Stat Cap (Quickness)', 'Mythical Stat Cap (Intelligence)',
    'Mythical Stat Cap (Piety)', 'Mythical Stat Cap (Charisma)', 'Mythical Stat Cap (Empathy)', 'Mythical Stat Cap (Acuity)',
]);

/** What the rest of a delve looks like (language/EN/GameObjects/GameObject.txt; GameInventoryItem.cs:839, :1121-1250). */
const LAYOUT: RegExp[] = [
    /^(Armor Modifiers|Effective Armor|Damage Modifiers|Damage Modifiers \(when used with shield styles\)|Effective Damage|Magical Ability|Charged Magic Ability|Level Requirement|Offensive Proc Ability):?$/,
    /^Total utility: /, /^\| Total Uti: /, /^Can use (item every|again in): /, /^Cannot be /, /^Crafter : /,
    /^- -?[\d.,]+%? (Base Factor|Clamped Factor|Factor|Absorption|Quality|Condition|Base DPS|Clamped DPS|DPS|Weapon Speed|Shield Speed|Charges|Max|Level)$/,
    /^- Damage Type: /, /^- Shield Size : /, /^- Spell has a chance of casting when /, /^- This spell is cast when the item is used\.$/,
];

const PVE_LINE = /^(?:-\s*)?(.+?):\s*(-?\d+)\s*(%|pts)\s*\(PvE Only\)$/i;
const UTILITY_LINE = /^-?\d+(?:[.,]\d+)?\s*\|\s*(.+?):\s*(-?\d+)\s*(.*)$/;
const PLAIN_LINE = /^(?:-\s*)?(.+?):\s*(-?\d+)\s*(.*)$/;

/** What a bonus's name and unit make of it; null when the two don't fit anything the server writes. */
function classify(name: string, rawUnit: string): Pick<ItemBonus, 'category' | 'unit' | 'stat' | 'spec' | 'group'> | null {
    const u = rawUnit.trim();
    // "Power Pool: 6 % of power pool." (the comment at GameInventoryItem.cs:875 calls it "Power").
    if (/^% of power pool\.?$/i.test(u)) return name === 'Power Pool' || name === 'Power' ? { category: 'powerPool', unit: '%' } : null;
    const unit = u === '' ? null : u === 'pts' ? 'pts' : u === '%' ? '%' : u === 'lvls' ? 'lvls' : undefined;
    if (unit === undefined) return null;
    if (unit === 'lvls') {
        if (name === ALL_FOCUS) return { category: 'focus', unit, spec: null };
        const line = name.match(/^(.+) Focus$/)?.[1];
        return line && name !== 'Spell Focus' ? { category: 'focus', unit, spec: specOf(line) } : null;
    }
    if (name === 'Bonus to armor factor (AF)') return { category: 'armorFactor', unit };
    if (name === 'Bonus to armor absorption (ABS)') return { category: 'absorption', unit };
    if (name === 'Bonus to casting speed') return { category: 'castingSpeed', unit };
    if (OTHER.has(name)) return { category: 'other', unit };
    if (unit === '%') return RESISTS.has(name) || name === ESSENCE ? { category: 'resist', unit } : null;
    if (unit === null) return null;
    if (STATS[name]) return { category: 'stat', unit, stat: STATS[name] };
    if (name === 'Hits') return { category: 'hits', unit };
    if (name === 'Power') return { category: 'power', unit };
    if (name === 'Fatigue') return { category: 'fatigue', unit };
    if (name === ESSENCE) return { category: 'resist', unit };
    const group = SKILL_GROUP.get(name);
    if (group) return { category: 'skill', unit, group, spec: specOf(name) };
    if (name in SKILL_GROUPS) return { category: 'skillGroup', unit, group: SKILL_GROUPS[name]! };
    return null;
}

function parseBonusLine(line: string, inSection: boolean): ItemBonus | null {
    const pve = line.match(PVE_LINE);
    if (pve) return { category: 'pve', name: pve[1]!, value: Number(pve[2]), unit: pve[3]!.toLowerCase() === 'pts' ? 'pts' : '%', text: line };
    const m = line.match(UTILITY_LINE) ?? (inSection ? line.match(PLAIN_LINE) : null);
    if (!m) return null;
    const name = m[1]!.replace(/\s+/g, ' ');
    const kind = classify(name, m[3]!);
    return kind && { ...kind, name, value: Number(m[2]), text: line };
}

/** Bonuses, requirements and whatever else a delve window's lines hold. */
export function parseDelve(lines: readonly string[]): ParsedDelve {
    const out: ParsedDelve = { bonuses: [], unknown: [], bonusLevel: null, levelRequirement: null };
    let section: 'bonus' | 'usable' | null = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { section = null; continue; }
        if (/^(Magical|Focus) Bonuses:$/.test(line)) { section = 'bonus'; continue; }
        if (line === 'Usable by:') { section = 'usable'; continue; }
        if (section === 'usable') {
            if (line.startsWith('- ')) continue;
            section = null;
        }
        const bonus = parseBonusLine(line, section === 'bonus');
        if (bonus) { out.bonuses.push(bonus); continue; }
        const bonusLevel = line.match(/^Bonus Level: (\d+)$/);
        if (bonusLevel) { out.bonusLevel = Number(bonusLevel[1]); continue; }
        const required = line.match(/^Level Requirement: (\d+) Level$/);
        if (required) { out.levelRequirement = Number(required[1]); continue; }
        if (LAYOUT.some(re => re.test(line))) continue;
        out.unknown.push(line);
    }
    return out;
}

/**
 * A weapon's damage lines (GameInventoryItem.cs:1156-1197, also through a shop's delve). The clamped
 * figure is the item's DPS at this character's level; a shield's lines have a "Shield Speed" and no
 * quality, so they are null here, as is anything with parts missing.
 */
export function parseWeaponDelve(lines: readonly string[]): WeaponDelve | null {
    const figure = (what: string) => {
        const hit = lines.map(l => new RegExp(`^- ([\\d.,]+)%? ${what}$`).exec(l.trim())).find(Boolean);
        return hit ? Number(hit[1]!.replace(',', '.')) : null;
    };
    const baseDps = figure('Base DPS'), clampedDps = figure('Clamped DPS'), speed = figure('Weapon Speed');
    const quality = figure('Quality'), condition = figure('Condition');
    if (baseDps === null || clampedDps === null || speed === null || quality === null || condition === null) return null;
    return { baseDps, clampedDps, speed, quality, condition };
}

/**
 * Whether a text window's caption names this item. The caption is the bare item name
 * (DetailDisplayHandler.cs:114); an inventory name has "<count> " in front of a stack and stops at
 * 55 characters (PacketLib1124.cs:977-985, PacketLib189.cs:205).
 */
export function isDelveOf(caption: string, itemName: string): boolean {
    const c = caption.toLowerCase();
    const n = itemName.toLowerCase();
    const bare = n.replace(/^\d+ /, '');
    return c === n || c === bare || (n.length >= 55 && c.startsWith(n));
}
