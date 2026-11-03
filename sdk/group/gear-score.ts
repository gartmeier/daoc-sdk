// What an item's delved bonuses are worth to a class, and how that weighs against armour (pure).
// See learnings/looting.md "Delve".
//
// The weights are a judgement, not a fact. The scale is the server's own item utility
// (ItemUtilityCalculator.cs:54-75): hits 0.25, resist 2 and flat power 2 per point, skills 5 per
// level. Its stats at 2/3 are raised to 1 for a class's primary stat, so that on generated loot,
// which rolls a stat up to level/3, resist up to (level/2+1)/4 and hits up to level
// (GeneratedUniqueItem.cs:4665-4705), a class's main stat beats a resist of the same roll: at level
// 20 the top rolls are +7 = 7, 3 % = 6 and 20 hits = 5.

import { getClass, type ClassInfo, type StatName } from '../../data/index';
import { ALL_FOCUS, SKILLS, specOf } from '../delve';
import { ObjectType, type InventoryItem, type ItemBonus, type SkillGroup, type Specialization, type WeaponDelve } from '../types';

/** Per stat point, by the class's data (classes.json): the higher applies when one stat holds two roles. */
export const STAT_WEIGHTS = { primary: 1, secondary: 0.6, tertiary: 0.3, mana: 0.8 };
/** A stat outside those roles that still does something: DEX shortens casts (GameLiving.cs:298), QUI swings (AttackComponent.cs:367-369). */
export const SIDE_STAT_WEIGHT = 0.15;
/** Per point. Only `hits`, `resist`, `power` and `skill` are the server's numbers; the rest are mine, in its scale. */
export const BONUS_WEIGHTS = {
    hits: 0.25, resist: 2, skill: 5,
    /** MaxMana: flat power. Only for a class with a mana stat, like powerPool and castingSpeed. */
    power: 2, powerPool: 1, castingSpeed: 2,
    /** Item AF adds to the total directly, up to the level (ArmorFactorCalculator.cs:46). */
    armorFactor: 1, absorption: 2,
    /** Percent of max endurance (FatigueCalculator.cs:24): only classes that swing use it. */
    fatigue: 0.5,
    /** Power cost of one line, from 120 % down to 80 % at a focus as high as the spell's level (SpellHandler.cs:1204-1222): far smaller than a skill point. */
    focus: 0.25,
};

/** Acuity raises the mana stat, except for these (StatCalculator.cs:188-194). */
const NO_ACUITY = new Set(['Scout', 'Hunter', 'Ranger', 'Nightshade']);
/** IsFocusCaster: these base classes and their subclasses (playerclasses/base/*.cs), but not the Valewalker (ClassValewalker.cs:24). Nothing else gets anything from a focus (FocusLevelCalculator.cs:28, SpellHandler.cs:1204). */
const FOCUS_CASTERS = new Set(['Disciple', 'Elementalist', 'Forester', 'Mage', 'Magician', 'Mystic']);
export const isFocusCaster = (c: ClassInfo) => c.name !== 'Valewalker' && FOCUS_CASTERS.has(c.baseClassName);
/** Whether the class fights in melee. The server's ListCaster flag says no, also for two that do: ClassForester.cs:41-44 for the Valewalker, ClassVampiir.cs:42-45. */
const swings = (c: ClassInfo) => c.classType !== 'ListCaster' || c.name === 'Valewalker' || c.name === 'Vampiir';

function mostCommon<T>(xs: T[]): T | null {
    const counts = new Map<T, number>();
    let best: T | null = null, n = 0;
    for (const x of xs) {
        const c = (counts.get(x) ?? 0) + 1;
        counts.set(x, c);
        if (c > n) { best = x; n = c; }
    }
    return best;
}

/** A class's stat of this role. Base classes have none of their own (classes.json): what their advanced classes mostly have, as data/index.ts defaultStats. */
function roleStat(c: ClassInfo, key: 'primaryStat' | 'secondaryStat' | 'tertiaryStat'): StatName | null {
    if (c[key] || !c.isBaseClass) return c[key];
    return mostCommon(c.advancedClassIds.map(id => getClass(id)?.[key]).filter((s): s is StatName => !!s));
}

/** What one point of a stat is worth to this class at this level. */
export function statWeight(stat: StatName | 'ACU', c: ClassInfo, level: number): number {
    // The class's own, never its advanced classes': ClassFighter.cs:26-33 sets none, and without one
    // there is no power (MaxManaCalculator.cs:26-46) and Acuity raises nothing (StatCalculator.cs:117-121).
    const mana = c.manaStat;
    if (stat === 'ACU') return mana && !NO_ACUITY.has(c.name) ? statWeight(mana, c, level) : 0;
    const role = Math.max(
        roleStat(c, 'primaryStat') === stat ? STAT_WEIGHTS.primary : 0,
        roleStat(c, 'secondaryStat') === stat ? STAT_WEIGHTS.secondary : 0,
        roleStat(c, 'tertiaryStat') === stat ? STAT_WEIGHTS.tertiary : 0,
        mana === stat ? STAT_WEIGHTS.mana : 0,
    );
    // CON gives everyone hits: hp2 = BaseHP * level * con / 10000 (GamePlayer.cs:2461-2462).
    if (stat === 'CON') return Math.max(role, c.baseHP * level / 10_000 * BONUS_WEIGHTS.hits);
    if (role > 0) return role;
    if (stat === 'DEX' && mana) return SIDE_STAT_WEIGHT;
    if (stat === 'QUI' && swings(c)) return SIDE_STAT_WEIGHT;
    return 0;
}

/**
 * The most of a bonus that counts at this level: the server caps the sum over everything worn at
 * these (StatCalculator.cs:131, MaxHealthCalculator.cs:130, ResistCalculator.cs:103,
 * SkillLevelCalculator.cs:35, MaxManaCalculator.cs:48-49, ArmorFactorCalculator.cs:46,
 * AttackSpeedPercentCalculator.cs:26, FatigueCalculator.cs:24, FocusLevelCalculator.cs:34). At level
 * 20: stat 30, hits 80, resist 11, skill 5, power 11, power pool 10, AF 20. Applied per item only, so
 * the score doesn't see several items adding up past a cap.
 * No level gate exists beyond these and a skill's spec (hasSpec): a bonus applies from the moment the
 * item is worn at any level (GamePlayer.cs:8910-8912), and BonusLevel is display only.
 */
export function bonusCap(b: Pick<ItemBonus, 'category'>, level: number): number {
    switch (b.category) {
        case 'stat': return Math.floor(level * 1.5);
        case 'hits': return level * 4;
        case 'resist': return Math.floor(level / 2) + 1;
        case 'skill': case 'skillGroup': return Math.floor(level / 5) + 1;
        case 'power': return Math.floor(level / 2) + 1;
        case 'powerPool': return Math.floor(level / 2);
        case 'armorFactor': return level;
        case 'castingSpeed': return 10;
        case 'fatigue': return 15;
        case 'focus': return 50;
        default: return Infinity;
    }
}

/** Whether the class has this spec yet: from its levelAcquired (GamePlayer.cs:9932-9941), and a skill bonus adds nothing to a spec the player lacks (GamePlayer.cs:3264-3290). */
const hasSpec = (c: ClassInfo, spec: string | null | undefined, level: number) => !!spec && c.specializations.some(s => s.spec === spec && s.levelAcquired <= level);
/** Whether the class trains anything an "ALL ..." bonus raises (SkillLevelCalculator.cs:39-51). */
const hasGroup = (c: ClassInfo, group: SkillGroup, level: number) => SKILLS[group].some(name => hasSpec(c, specOf(name), level));

/** What one point of this bonus is worth to this class; 0 for what it can't use. */
function bonusWeight(b: ItemBonus, c: ClassInfo, level: number): number {
    switch (b.category) {
        case 'stat': return statWeight(b.stat!, c, level);
        case 'hits': return BONUS_WEIGHTS.hits;
        case 'resist': return BONUS_WEIGHTS.resist;
        case 'armorFactor': return BONUS_WEIGHTS.armorFactor;
        case 'absorption': return BONUS_WEIGHTS.absorption;
        case 'skill': return hasSpec(c, b.spec, level) ? BONUS_WEIGHTS.skill : 0;
        case 'skillGroup': return !b.group || hasGroup(c, b.group, level) ? BONUS_WEIGHTS.skill : 0;
        case 'focus': return isFocusCaster(c) && (b.name === ALL_FOCUS ? hasGroup(c, 'magic', level) : hasSpec(c, b.spec, level)) ? BONUS_WEIGHTS.focus : 0;
        case 'power': return c.manaStat ? BONUS_WEIGHTS.power : 0;
        case 'powerPool': return c.manaStat ? BONUS_WEIGHTS.powerPool : 0;
        case 'castingSpeed': return c.manaStat ? BONUS_WEIGHTS.castingSpeed : 0;
        case 'fatigue': return swings(c) ? BONUS_WEIGHTS.fatigue : 0;
        default: return 0; // 'pve' and 'other': regeneration, chances, caps, nothing weighed yet.
    }
}

/** What these bonuses are worth to this class at this level. A plain item is 0, a penalty negative. */
export function statScore(bonuses: readonly ItemBonus[], classInfo: ClassInfo, level: number): number {
    return bonuses.reduce((sum, b) => sum + Math.min(b.value, bonusCap(b, level)) * bonusWeight(b, classInfo, level), 0);
}

const MAGIC_SPECS = new Set(SKILLS.magic.map(specOf));

/**
 * How much of a focus caster's training a staff's focus reaches, 0 to 1: line by line, up to the
 * line's spec, which is as high as its spells go. A spell costs 120 % of base with no focus and 80 %
 * at a focus as high as its level (SpellHandler.cs:1204-1222). A line's own focus and ALL Spell
 * Lines don't add up: the higher counts (FocusLevelCalculator.cs:30-31).
 */
export function focusCover(bonuses: readonly ItemBonus[], specs: readonly Pick<Specialization, 'name' | 'level'>[]): number {
    const focus = (line: string) => Math.max(0, ...bonuses.filter(b => b.category === 'focus' && (b.name === ALL_FOCUS || b.spec === line)).map(b => b.value));
    const lines = specs.filter(s => MAGIC_SPECS.has(s.name));
    const total = lines.reduce((sum, s) => sum + s.level, 0);
    return total ? lines.reduce((sum, s) => sum + Math.min(focus(s.name), s.level), 0) / total : 0;
}

// ── Armour ──────────────────────────────────────────────────────────────────

/**
 * Armour by AF and absorb. Absorb applies to the whole armour factor, not just the item's AF, so a
 * base of 10 AF stands for the rest. Without it, Galahad (L4) swapped bronze studded arms (AF 4,
 * 19 % absorb, 85 %) for cloth sleeves (AF 5, 0 %, 95 %): 4.05 vs 4.75. Caps as
 * GamePlayer.GetArmorFactorCap (GameInventoryItem.cs:1204-1214): item AF at level (cloth) or 2x
 * level, applied before quality.
 */
export function armorValue(i: Pick<InventoryItem, 'objectType' | 'value1' | 'value2' | 'quality'>, level: number): number {
    return (Math.min(i.value1, i.objectType === ObjectType.Cloth ? level : level * 2) * (i.quality / 100) + 10) * (1 + i.value2 / 100);
}

/**
 * How stat score converts to armour value, again a judgement. One stat score point is worth a
 * quarter of a value point, and however good the bonuses, they move a comparison by at most 10 % of
 * the better piece's value. So at level 20 a caster's cloth (AF 20, value 30) gives up at most 3 AF
 * for bonuses and a tank's plate (AF 36 after quality, 34 % absorb, value 62) under 5; a top
 * generated roll (+7 main stat and 20 hits, 12 points here) buys 3 value, under 3 AF on either.
 */
export const ARMOR_STAT_RATE = 0.25;
export const ARMOR_STAT_SWING = 0.1;

/** The most bonuses can move a comparison of these two armour values. */
export const armorSwing = (candidate: number, current: number) => ARMOR_STAT_SWING * Math.max(candidate, current);

/** Armour gain of a candidate over what is worn (value 0: nothing). A stat score of null (no delve) leaves AF and absorb alone. */
export function armorGain(candidate: number, current: number, candidateStat: number | null, currentStat: number | null): number {
    const base = candidate - current;
    if (candidateStat === null || currentStat === null) return base;
    const swing = armorSwing(candidate, current);
    return base + Math.max(-swing, Math.min(swing, (candidateStat - currentStat) * ARMOR_STAT_RATE));
}

// ── Weapons ─────────────────────────────────────────────────────────────────

/**
 * A weapon's unstyled damage per second: the delve's clamped DPS, quality and condition, with the
 * slow weapon bonus (AttackComponent.cs:2133-2137, 0.3 % per 0.1 s over 2.0 s). A swing's damage is
 * DPS x speed and swings come at that speed, so speed adds nothing else. A two-hander also gets
 * 1.1 + 0.5 % per spec level (:2139-2142): pass that line's level as `twoHandedSpec`.
 *
 * A style's growth doesn't scale with DPS (StyleProcessor.cs:360-364: unstyled damage over its cap,
 * and the cap is that damage before quality), so this ranks weapons rather than predicting a fight.
 */
export function weaponValue(w: Pick<WeaponDelve, 'clampedDps' | 'speed' | 'quality' | 'condition'>, twoHandedSpec: number | null = null): number {
    const slow = 1 + (w.speed * 10 - 20) * 0.003;
    const twoHanded = twoHandedSpec === null ? 1 : 1.1 + twoHandedSpec * 0.005;
    return w.clampedDps * slow * twoHanded * (w.quality / 100) * (w.condition / 100);
}

/** One stat score point moves a weapon's score this much: a point of weapon stat is 0.5 % of weapon skill (GamePlayer.cs:5476). */
export const WEAPON_STAT_RATE = 0.005;
/** However good the bonuses, they move a weapon's score by at most this share, as ARMOR_STAT_SWING does. */
export const WEAPON_STAT_SWING = 0.1;

/** A weapon's value with its delved bonuses. A stat score of null (no delve) leaves the value alone. */
export function weaponScore(value: number, stat: number | null): number {
    return value * (1 + Math.max(-WEAPON_STAT_SWING, Math.min(WEAPON_STAT_SWING, (stat ?? 0) * WEAPON_STAT_RATE)));
}
