import { describe, expect, test } from 'bun:test';
import { EquipmentSlot, ObjectType, type SpellDetails, type Style, type StyleDetails } from '../types';
import { canWield, foeLastResult, heldElsewhere, lastStyleLanded, lastSwungAt, pickStyle, procUnknown, raisesThreat, shedsThreat, tankStyles } from './styles';
import { defaultBehaviors } from './behaviors';

const details = (d: Partial<StyleDetails>): StyleDetails => ({
    fatigue: 10, attackMod: 0, defensiveMod: 0, openingDamage: 0, opening: 'offensive', result: null, position: null,
    openingStyle: null, followUps: [], weapon: 'Blades', stealth: false, procSpellId: null, ...d,
});
const style = (name: string, d: Partial<StyleDetails>, more: Partial<Style> = {}): Style => ({
    name, internalId: 0, specLevel: 1, specName: 'Blades', skillIndex: 0, prerequisite: 0x100, details: details(d), ...more,
});
const proc = (description: string, id = 20000) => ({ procSpellId: id, procSpell: { description } as SpellDetails });
// The server's words, read live from a level-15 Blademaster's styles.
const TAUNT = proc('Taunts the target, increasing your threat against it by 17.');
const DETAUNT = proc('Detaunts the target, decreases your threat against it by 19.', 20001);

const wearing = (right: number | null, left: number | null = null) => [
    ...(right === null ? [] : [{ slot: EquipmentSlot.RightHand, objectType: right }]),
    ...(left === null ? [] : [{ slot: EquipmentSlot.LeftHand, objectType: left }]),
];

describe('threat in the server\'s words', () => {
    test('a taunt raises it and a detaunt sheds it, whatever the name says', () => {
        const taunting = style('Taunting Call', DETAUNT);
        expect(shedsThreat(taunting)).toBe(true);
        expect(raisesThreat(taunting)).toBe(false);
        const plague = style('Plague', TAUNT);
        expect(raisesThreat(plague)).toBe(true);
        expect(shedsThreat(plague)).toBe(false);
    });

    test('other procs move no threat', () => {
        const bleed = style('Gale', proc('The target bleeds for 5 body damage every 4 seconds for 30 seconds.', 20200));
        expect(raisesThreat(bleed)).toBe(false);
        expect(shedsThreat(bleed)).toBe(false);
        expect(procUnknown(bleed)).toBe(false);
    });

    test('a proc the server hasn\'t described is unknown, not harmless', () => {
        expect(procUnknown(style('Hoarfrost', { procSpellId: 20001 }))).toBe(true);
        expect(procUnknown(style('Cleave', {}))).toBe(false);
    });
});

describe('canWield', () => {
    test('a weapon style takes its own line in either realm\'s words', () => {
        expect(canWield(style('a', { weapon: 'Blades' }), wearing(ObjectType.Blades))).toBe(true);
        expect(canWield(style('a', { weapon: 'Blades' }), wearing(ObjectType.Blunt))).toBe(false);
        expect(canWield(style('a', { weapon: 'Axe' }), wearing(ObjectType.Axe))).toBe(true);
        expect(canWield(style('a', { weapon: 'Slash' }), wearing(ObjectType.SlashingWeapon))).toBe(true);
    });

    test('a two-hander counts from its own slot', () => {
        const worn = [{ slot: EquipmentSlot.TwoHand, objectType: ObjectType.LargeWeapons }];
        expect(canWield(style('a', { weapon: 'Large Weapons' }), worn)).toBe(true);
    });

    test('a shield style needs a shield and a weapon', () => {
        // The tooltip reads "Shield" where the style's spec reads "Shields" (live, a Paladin's Numb).
        const numb = style('Numb', { weapon: 'Shield' }, { specName: 'Shields' });
        expect(canWield(numb, wearing(ObjectType.Blades, ObjectType.Shield))).toBe(true);
        expect(canWield(numb, wearing(ObjectType.Blades))).toBe(false);
        expect(canWield(numb, wearing(null, ObjectType.Shield))).toBe(false);
    });

    test('a dual style needs a weapon in each hand, and a shield is none', () => {
        const rain = style('Blinding Rain', { weapon: 'Celtic Dual' });
        expect(canWield(rain, wearing(ObjectType.Blades, ObjectType.Blades))).toBe(true);
        expect(canWield(rain, wearing(ObjectType.Blades, ObjectType.Shield))).toBe(false);
        expect(canWield(rain, wearing(ObjectType.Blades))).toBe(false);
    });

    test('Hand to Hand needs that weapon in both hands', () => {
        const claw = style('Claw', { weapon: 'Hand to Hand' });
        expect(canWield(claw, wearing(ObjectType.HandToHand, ObjectType.HandToHand))).toBe(true);
        expect(canWield(claw, wearing(ObjectType.Sword, ObjectType.Sword))).toBe(false);
    });

    test('no details or a stealth style: no', () => {
        expect(canWield({ ...style('a', {}), details: undefined }, wearing(ObjectType.Blades))).toBe(false);
        expect(canWield(style('a', { stealth: true }), wearing(ObjectType.Blades))).toBe(false);
    });
});

describe('tankStyles', () => {
    const blades = wearing(ObjectType.Blades, ObjectType.Shield);
    const taunting = style('Taunting Blade', { openingDamage: 116, ...TAUNT }, { specLevel: 6 });
    const shining = style('Shining Blade', { fatigue: 15, openingDamage: 8 }, { specLevel: 2 });
    const enervating = style('Enervating Blade', { ...DETAUNT }, { specLevel: 8 });
    const cleave = style('Cleave', { fatigue: 10, openingDamage: 174 }, { specLevel: 3 });

    test('the taunt highest in its line, and the best damage per endurance that moves no threat', () => {
        const higher = style('Slam Taunt', { openingDamage: 10, ...TAUNT }, { specLevel: 9 });
        expect(tankStyles([taunting, higher, shining, enervating, cleave], blades)).toEqual({ taunt: 'Slam Taunt', damage: 'Cleave' });
    });

    test('a detaunt is never the damage style, however high it comes in its line', () => {
        expect(tankStyles([enervating], blades)).toEqual({ taunt: null, damage: null });
    });

    test('a poor style isn\'t worth the endurance the taunt needs', () => {
        expect(tankStyles([shining], blades).damage).toBeNull();
    });

    test('Cuchulainn\'s Numb: a shield style at growth 9 for 15 loses to a weapon style', () => {
        const numb = style('Numb', { weapon: 'Shield', fatigue: 15, openingDamage: 9 }, { specLevel: 20 });
        expect(tankStyles([numb, cleave], blades).damage).toBe('Cleave');
    });

    test('a style for a weapon it doesn\'t hold is left out', () => {
        const axe = style('Axe Taunt', { weapon: 'Axe', openingDamage: 100, ...TAUNT });
        expect(tankStyles([axe], blades).taunt).toBeNull();
    });

    test('an undescribed proc counts as neither', () => {
        const unknown = style('Hoarfrost', { openingDamage: 200, procSpellId: 20001 });
        expect(tankStyles([unknown], blades)).toEqual({ taunt: null, damage: null });
    });

    test('only styles with no opening', () => {
        const reaction = style('Return Blade', { fatigue: 5, openingDamage: 174, opening: 'defensive', result: 'parry' }, { prerequisite: 103 });
        expect(tankStyles([reaction], blades).damage).toBeNull();
    });
});

describe('pickStyle', () => {
    const plain = style('Cleave', { openingDamage: 100 });
    const gloom = style('Misty Gloom', { fatigue: 15, openingDamage: 7 });
    const taunt = style('Taunting Blade', { openingDamage: 116, ...TAUNT });
    const detaunt = style('Enervating Blade', { openingDamage: 90, ...DETAUNT });
    const parry = style('Return Blade', { fatigue: 5, openingDamage: 174, opening: 'defensive', result: 'parry' });
    const evade = style('Blinding Rain', { fatigue: 5, openingDamage: 175, opening: 'defensive', result: 'evade' });
    const follow = style('Blizzard', { fatigue: 5, openingDamage: 100, result: 'styledHit', openingStyle: 'Blinding Rain' });
    const side = style('Glowing Blade', { openingDamage: 128, opening: 'positional', position: 'side' });
    const seen = { last: null, foeDid: null, endurancePercent: 100 };

    test('what needs an opening goes first, the best plain style behind it', () => {
        expect(pickStyle([plain, evade, follow], { ...seen, last: 'Blinding Rain' })).toEqual(['Blizzard', 'Cleave']);
        expect(pickStyle([plain, evade], { ...seen, foeDid: 'evade' })).toEqual(['Blinding Rain', 'Cleave']);
        expect(pickStyle([plain, evade, parry], seen)).toEqual(['Return Blade', 'Cleave']);
        expect(pickStyle([plain], seen)).toEqual(['Cleave']);
    });

    test('a detaunt never goes behind it, and poor value doesn\'t either', () => {
        expect(pickStyle([detaunt, gloom], seen)).toEqual([]);
    });

    test('a conditional style with nothing behind it goes only when certain', () => {
        expect(pickStyle([parry], seen)).toEqual([]);
        expect(pickStyle([parry], { ...seen, foeDid: 'parry' })).toEqual(['Return Blade']);
    });

    test('low on endurance only what is certain', () => {
        const low = { ...seen, endurancePercent: 20 };
        expect(pickStyle([plain, parry], low)).toEqual([]);
        expect(pickStyle([plain, parry], { ...low, foeDid: 'parry' })).toEqual(['Return Blade']);
        expect(pickStyle([plain, evade, follow], { ...low, last: 'Blinding Rain' })).toEqual(['Blizzard']);
    });

    test('with the mob on someone else: a positional, no reaction, no threat', () => {
        const held = { ...seen, held: true };
        expect(pickStyle([plain, taunt, side, parry], { ...held, foeDid: 'parry' })).toEqual(['Glowing Blade', 'Cleave']);
        expect(pickStyle([taunt], held)).toEqual([]);
        expect(pickStyle([taunt], seen)).toEqual(['Taunting Blade']);
    });

    test('behind a positional even a weak plain style will do', () => {
        expect(pickStyle([gloom, side], { ...seen, held: true })).toEqual(['Glowing Blade', 'Misty Gloom']);
    });

    test('its own rules', () => {
        expect(pickStyle([gloom], seen, { saveEndurance: 35, minValue: 0.1 })).toEqual(['Misty Gloom']);
        expect(pickStyle([plain], { ...seen, endurancePercent: 20 }, { saveEndurance: 10, minValue: 2 })).toEqual(['Cleave']);
    });

    test('an undescribed proc stays out', () => {
        expect(pickStyle([style('Hoarfrost', { openingDamage: 200, procSpellId: 20001 })], seen)).toEqual([]);
    });
});

describe('what the last swings came to', () => {
    const melee = (attackerObjectId: number, targetObjectId: number, result: string) => ({ kind: 'melee', attackerObjectId, targetObjectId, result });
    const state = (combatEvents: unknown[], texts: string[] = []) => ({ combatEvents, gameMessages: texts.map(text => ({ text })) }) as never;

    test('the style named by the message, while the last swing was a styled one', () => {
        expect(lastStyleLanded(state([melee(1, 2, 'styledHit')], ['You perform your Blinding Rain perfectly!']), 1)).toBe('Blinding Rain');
        expect(lastStyleLanded(state([melee(1, 2, 'styledHit'), melee(1, 2, 'hit')], ['You perform your Blinding Rain perfectly!']), 1)).toBeNull();
    });

    test('what the foe did to us, not to someone else', () => {
        expect(foeLastResult(state([melee(2, 1, 'parry'), melee(2, 3, 'hit')]), 2, 1)).toBe('parry');
        expect(foeLastResult(state([melee(2, 3, 'hit')]), 2, 1)).toBeNull();
    });
});

describe('default melee', () => {
    test('it fights with styles on the melee list', () => {
        expect(defaultBehaviors().melee.map(b => b.name)).toContain('assistMelee');
    });
});

describe('heldElsewhere: whom a player is on, from its last swing (the server never sends a player\'s target)', () => {
    const now = Date.now();
    const swing = (attacker: number, target: number, ago: number) => ({ id: ago, kind: 'melee' as const, attackerObjectId: attacker, targetObjectId: target, receivedAt: now - ago });
    const state = (events: ReturnType<typeof swing>[]) => ({ combatEvents: events as any });

    test('a player that last swung at someone else is held; at us, or at nobody lately, it is not', () => {
        expect(heldElsewhere({ objectId: 50, kind: 'player' }, state([swing(50, 7, 1000)]), 1)).toBe(true);
        expect(heldElsewhere({ objectId: 50, kind: 'player' }, state([swing(50, 7, 3000), swing(50, 1, 1000)]), 1)).toBe(false);
        expect(heldElsewhere({ objectId: 50, kind: 'player' }, state([swing(50, 7, 9000)]), 1)).toBe(false);
        expect(lastSwungAt(state([swing(50, 7, 9000)]), 50, now)).toBeNull();
    });

    test('a monster goes by the target the server gives it, as before', () => {
        expect(heldElsewhere({ objectId: 60, kind: 'npc', targetObjectId: 7 }, state([]), 1)).toBe(true);
        expect(heldElsewhere({ objectId: 60, kind: 'npc', targetObjectId: 1 }, state([swing(60, 7, 500)]), 1)).toBe(false);
    });
});
