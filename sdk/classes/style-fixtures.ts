// Test fixtures: a class's styles at a build's levels as the server describes them (the 0xD8 tooltip's details), built
// from the static data as hero.test.ts does, with follow-ups named and every proc described the way the delve words it
// (StyleTaunt.cs: "increasing your threat", "decreases your threat"). Used by the R7 kits' tests.

import { getBuild } from '../../data/builds';
import { getClass, getSpell, getStylesFor } from '../../data/index';
import { ANYTIME_STYLE } from '../group/styles';
import { EquipmentSlot, ObjectType, type CombatEvent, type CombatResult, type Style } from '../types';
import { reachOfBuild } from './reach';

const RESULTS: Record<number, CombatResult> = { 3: 'parry', 4: 'block', 5: 'evade' };
const OPENINGS = ['offensive', 'defensive', 'positional'] as const;
const POSITIONS = ['back', 'side', 'front'] as const;

function describe(spellId: number): string {
    const sp = getSpell(spellId);
    if (!sp) return '';
    if (/taunt/i.test(sp.type)) return `${(sp.value ?? 0) < 0 ? 'Detaunts the target, decreases' : 'Taunts the target, increasing'} your threat against it by ${Math.abs(sp.value ?? 0)}.`;
    return `${sp.type}.`;
}

/** The styles `className` knows at `level` on the build `buildName`, with their details. */
export function kitStyles(className: string, buildName: string, level = 24): Style[] {
    const cls = getClass(className)!;
    const byId = new Map(getStylesFor(cls.id).map(s => [s.id, s.name]));
    return reachOfBuild(getBuild(className, buildName)!, level).styles.map(s => {
        const follows = s.openingRequirementType === 0 && s.openingRequirementValue ? byId.get(s.openingRequirementValue) ?? null : null;
        const proc = s.procs?.[0]?.spellId ?? null;
        return {
            name: s.name, internalId: s.id, specLevel: s.specLevelRequirement, specName: s.specKeyName, skillIndex: s.id,
            prerequisite: s.openingRequirementType === 0 && !s.attackResultRequirement && !follows ? ANYTIME_STYLE : 0,
            details: {
                fatigue: s.enduranceCost, attackMod: 0, defensiveMod: 0, openingDamage: s.growthRate * 200, opening: OPENINGS[s.openingRequirementType]!,
                result: follows ? 'styledHit' : RESULTS[s.attackResultRequirement] ?? (s.attackResultRequirement ? 'other' : null),
                position: s.openingRequirementType === 2 ? POSITIONS[s.openingRequirementValue] ?? null : null,
                openingStyle: follows, followUps: [],
                weapon: s.specKeyName === 'Shields' ? 'Shield' : s.specKeyName, stealth: false, procSpellId: proc,
                ...(proc ? { procSpell: { description: describe(proc) } } : {}),
            },
        } as Style;
    });
}

const w = (slot: number, objectType: number) => ({ slot, objectType });
/** What the gear template puts in each hand (sdk/group/gear-template.ts, the nine new classes). */
export const KIT_WEAPONS = {
    Mercenary: [w(EquipmentSlot.RightHand, ObjectType.SlashingWeapon), w(EquipmentSlot.LeftHand, ObjectType.SlashingWeapon)],
    Reaver: [w(EquipmentSlot.RightHand, ObjectType.Flexible), w(EquipmentSlot.LeftHand, ObjectType.Shield)],
    Savage: [w(EquipmentSlot.RightHand, ObjectType.HandToHand), w(EquipmentSlot.LeftHand, ObjectType.HandToHand)],
    Champion: [w(EquipmentSlot.TwoHand, ObjectType.LargeWeapons)],
    Valewalker: [w(EquipmentSlot.TwoHand, ObjectType.Scythe)],
    Minstrel: [w(EquipmentSlot.RightHand, ObjectType.ThrustWeapon), w(EquipmentSlot.LeftHand, ObjectType.Shield), w(EquipmentSlot.TwoHand, ObjectType.Instrument)],
} as const;

export const ME = 1;
export const FOE = 2;
export const swing = (by: number, on: number, result: CombatResult, at: number, id = at): CombatEvent => ({ id, kind: 'melee', attackerObjectId: by, targetObjectId: on, result, receivedAt: at } as CombatEvent);

/** The `seen` a StylePick gets. */
export function seenBy(styles: Style[], equipment: readonly { slot: number; objectType: number }[], o: { events?: CombatEvent[]; messages?: string[]; endurance?: number; kind?: 'player' | 'npc'; targetOn?: number } = {}) {
    return {
        target: { objectId: FOE, kind: o.kind ?? 'player', ...(o.targetOn !== undefined ? { targetObjectId: o.targetOn } : {}) } as never,
        player: { objectId: ME, endurancePercent: o.endurance ?? 100 } as never,
        state: { equipment, combatEvents: o.events ?? [], gameMessages: (o.messages ?? []).map(text => ({ text })) } as never,
        styles,
    };
}
