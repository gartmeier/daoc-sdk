// A fighter's styles, from what the server says about them (sdk.getSkills().styles[].details): which
// ones its weapons allow, what they do to threat, and which to queue for the next swing. The server
// keeps a first style and a backup and decides between them when the swing happens (learnings/combat.md),
// so a style with an opening goes first and a plain one behind it.

import { DUAL_LINES, WEAPON_LINES } from '../actions-helpers';
import { EquipmentSlot, ObjectType, type BotWorldState, type CombatResult, type InventoryItem, type Style } from '../types';
import type { StylePick } from './behaviors';

/** `Style.prerequisite` of a style with no opening. */
export const ANYTIME_STYLE = 0x100;

type Worn = Pick<InventoryItem, 'slot' | 'objectType'>;

/**
 * Whether what we wear can swing this style (StyleProcessor.CheckWeaponType). A style the server hasn't described
 * yet: no. The state doesn't say which weapon is out, so a one-hander and a two-hander both count.
 */
export function canWield(style: Style, equipment: readonly Worn[]): boolean {
    const need = style.details?.weapon;
    if (!need || style.details!.stealth) return false;
    const inSlot = (slot: number) => equipment.find(i => i.slot === slot);
    const left = inSlot(EquipmentSlot.LeftHand);
    const weapons = [inSlot(EquipmentSlot.RightHand), inSlot(EquipmentSlot.TwoHand)].filter((w): w is Worn => !!w);
    if (!weapons.length) return false;
    if (need === 'Any') return true;
    if (need === 'Shield') return left?.objectType === ObjectType.Shield;
    if (need === 'Hand to Hand') return left?.objectType === ObjectType.HandToHand && weapons.some(w => w.objectType === ObjectType.HandToHand);
    if (DUAL_LINES.has(need)) return !!left && left.objectType !== ObjectType.Shield;
    return weapons.some(w => WEAPON_LINES[w.objectType] === need);
}

/** "Taunts the target, increasing your threat against it by 17." (StyleTaunt.cs) */
export const raisesThreat = (s: Style) => /increas\w* your threat/i.test(s.details?.procSpell?.description ?? '');
/** "Detaunts the target, decreases your threat against it by 19." (StyleTaunt.cs) */
export const shedsThreat = (s: Style) => /decreas\w* your threat/i.test(s.details?.procSpell?.description ?? '');
/** Has a proc the server hasn't described: it could be a detaunt. */
export const procUnknown = (s: Style) => !!s.details && s.details.procSpellId !== null && !s.details.procSpell;
/** Damage growth per endurance. */
export const styleValue = (s: Style) => (s.details?.fatigue ? s.details.openingDamage / s.details.fatigue : 0);

/** The style our last swing landed, or null when that swing was plain. Combat events don't name it; "You perform your X perfectly!" does. */
export function lastStyleLanded(state: BotWorldState, me: number): string | null {
    const swing = state.combatEvents.filter(e => e.kind === 'melee' && e.attackerObjectId === me).at(-1);
    if (swing?.result !== 'styledHit') return null;
    const performed = state.gameMessages.filter(m => /^You perform your /.test(m.text)).at(-1);
    return performed ? /^You perform your (.+?) perfectly/.exec(performed.text)?.[1] ?? null : null;
}

/** What the enemy's last swing at us came to. */
export function foeLastResult(state: BotWorldState, foe: number, me: number): CombatResult | null {
    return state.combatEvents.filter(e => e.kind === 'melee' && e.attackerObjectId === foe && e.targetObjectId === me).at(-1)?.result ?? null;
}

export interface StyleSeen {
    last: string | null;
    foeDid: CombatResult | null;
    endurancePercent: number;
    /** The mob is on someone else: no reaction can fire, a positional can, and our threat isn't wanted. */
    held?: boolean;
}

export interface StyleRules {
    /** Below this endurance percent only what is certain to fire. */
    saveEndurance: number;
    /** A plain style must give this much damage growth per endurance. */
    minValue: number;
}

/**
 * Starting values from one Blademaster: Misty Gloom (growth 7 for 15 endurance, value 0.5) took 70 % of
 * his endurance a fight and won no faster. A character with other uses for its endurance sets its own.
 */
export const STYLE_RULES: StyleRules = { saveEndurance: 35, minValue: 2 };

/**
 * The queue for the next swing. First what only works under conditions: a follow-up, then what the mob
 * just did, then the likeliest reaction, or with the mob on someone else a positional. Behind it the best
 * plain style, while the endurance lasts. A conditional style alone would fail and still cost, so without
 * a plain style only what's certain goes.
 */
export function pickStyle(styles: readonly Style[], seen: StyleSeen, rules: StyleRules = STYLE_RULES): string[] {
    const known = styles.filter(s => s.details && !s.details.stealth && !procUnknown(s));
    const followUp = known.find(s => s.details!.openingStyle && s.details!.openingStyle === seen.last);
    const reactions = known.filter(s => s.details!.opening === 'defensive' && s.details!.result);
    const earned = seen.held ? undefined : reactions.find(s => s.details!.result === seen.foeDid);
    const certain = followUp ?? earned;
    if (seen.endurancePercent < rules.saveEndurance) return certain ? [certain.name] : [];
    const positional = known.filter(s => s.details!.opening === 'positional').sort((a, b) => b.details!.openingDamage - a.details!.openingDamage)[0];
    const likely = seen.held ? positional : reactions.find(s => s.details!.result === 'parry') ?? reactions[0];
    const plains = known
        .filter(s => s.details!.opening === 'offensive' && !s.details!.result && !shedsThreat(s) && !(seen.held && raisesThreat(s)))
        .sort((a, b) => styleValue(b) - styleValue(a));
    // Behind a positional even a weak one will do: the positional is the point of the swing.
    const plain = plains.find(s => styleValue(s) >= rules.minValue) ?? (seen.held && positional ? plains[0] : undefined);
    if (!plain) return certain ? [certain.name] : [];
    const first = certain ?? likely;
    return first ? [first.name, plain.name] : [plain.name];
}

/** A melee's style choice for assist() or a character: from its weapons and what just happened, with a backup. */
export const fighterStyle = (rules: Partial<StyleRules> = {}): StylePick => ({ target, player, state, styles }) => pickStyle(
    styles.filter(s => canWield(s, state.equipment)),
    {
        last: lastStyleLanded(state, player.objectId),
        foeDid: foeLastResult(state, target.objectId, player.objectId),
        endurancePercent: player.endurancePercent,
        held: 'targetObjectId' in target && !!target.targetObjectId && target.targetObjectId !== player.objectId,
    },
    { ...STYLE_RULES, ...rules },
);

/**
 * A tank's anytime styles: the taunt highest in its line, and the damage style worth most per endurance
 * that moves no threat. A proc the server hasn't described counts as neither, since it could be a detaunt.
 * Names don't tell: "Taunting Call" detaunts, and a Warrior's Hoarfrost cost run 20261031-072248 its hold
 * (31 %) when a name match took it for a damage style.
 */
export function tankStyles(styles: readonly Style[], equipment: readonly Worn[], rules: StyleRules = STYLE_RULES): { taunt: string | null; damage: string | null } {
    const anytime = styles.filter(s => s.prerequisite === ANYTIME_STYLE && canWield(s, equipment) && !procUnknown(s));
    const taunt = anytime.filter(raisesThreat).sort((a, b) => b.specLevel - a.specLevel)[0];
    const damage = anytime.filter(s => !raisesThreat(s) && !shedsThreat(s) && styleValue(s) >= rules.minValue).sort((a, b) => styleValue(b) - styleValue(a) || b.specLevel - a.specLevel)[0];
    return { taunt: taunt?.name ?? null, damage: damage?.name ?? null };
}
