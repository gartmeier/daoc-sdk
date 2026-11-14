// The first blow on a mezzed or stunned enemy (cc-opener.ts). Styles as the live Hero and Blademasters have them at 24
// (Cuchulainn, Laoghaire, Fionn, read from the gateway on 2026-11-14), procs in the server's words.
import { describe, expect, test } from 'bun:test';
import { EquipmentSlot, ObjectType, type Style } from '../types';
import { ANYTIME_STYLE } from './styles';
import { angleOff, openerFor, openerOf, openSpot, procKind, standsAt } from './cc-opener';
import type { Contact, MemberReport } from './types';

const STUN4 = 'The target is stunned and cannot take any actions for 4 seconds.';
const STUN2 = 'The target is stunned and cannot take any actions for 2 seconds.';
const SNARE = 'The target is slowed by 60% for 12 seconds.';
const TAUNT = 'Taunts the target, increasing your threat against it by 17.';
const DETAUNT = 'Detaunts the target, decreases your threat against it by 19.';

let ids = 1;
function st(name: string, weapon: string, fatigue: number, dmg: number, o: { opening?: 'offensive' | 'defensive' | 'positional'; position?: 'side' | 'back' | 'front'; result?: 'block' | 'parry' | 'evade' | 'styledHit'; follows?: string; proc?: string } = {}): Style {
    const opening = o.opening ?? (o.position ? 'positional' : o.result && o.result !== 'styledHit' ? 'defensive' : 'offensive');
    const id = ids++;
    return {
        name, internalId: id, specLevel: 1, specName: weapon, skillIndex: id,
        prerequisite: opening === 'offensive' && !o.result ? ANYTIME_STYLE : 0,
        details: {
            fatigue, attackMod: 0, defensiveMod: 0, openingDamage: dmg, opening, result: o.result ?? null, position: o.position ?? null,
            openingStyle: o.follows ?? null, followUps: [], weapon, stealth: false, procSpellId: o.proc ? id + 1000 : null,
            ...(o.proc ? { procSpell: { description: o.proc } as never } : {}),
        },
    };
}

const BLADES = [
    st('Shining Blade', 'Blades', 15, 8), st('Return Blade', 'Blades', 5, 174, { result: 'parry' }), st('Taunting Blade', 'Blades', 10, 116, { proc: TAUNT }),
    st('Enervating Blade', 'Blades', 10, 0, { proc: DETAUNT }), st('Glowing Blade', 'Blades', 10, 128, { position: 'side', proc: 'The target is slowed by 60% for 14 seconds.' }),
    st('Lunging Blade', 'Blades', 10, 174, { result: 'styledHit', follows: 'Glowing Blade' }), st('Fire Blade', 'Blades', 15, 92), st('Horizon Blade', 'Blades', 5, 176, { result: 'block', proc: STUN4 }),
];
const SHIELD = [
    st('Numb', 'Shield', 15, 9.4, { proc: STUN2 }), st('Stun', 'Shield', 15, 168, { result: 'block', proc: STUN4 }),
    st('Disable', 'Shield', 15, 129, { position: 'side', proc: STUN4 }), st('Incapacitate', 'Shield', 20, 171.8, { result: 'block', proc: STUN4 }),
];
const CELTIC = [
    st('Misty Gloom', 'Celtic Dual', 15, 7), st('Squall', 'Celtic Dual', 10, 114.8, { proc: TAUNT }), st('Snow Shower', 'Celtic Dual', 10, 128.8, { position: 'back', proc: SNARE }),
    st('Ice Storm', 'Celtic Dual', 10, 154, { position: 'side', proc: STUN4 }), st('Hurricane', 'Celtic Dual', 15, 96.6),
];
const w = (slot: number, objectType: number) => ({ slot, objectType });
const HERO_HANDS = [w(EquipmentSlot.RightHand, ObjectType.Blades), w(EquipmentSlot.LeftHand, ObjectType.Shield)];
const BM_HANDS = [w(EquipmentSlot.RightHand, ObjectType.Blades), w(EquipmentSlot.LeftHand, ObjectType.Blades)];

describe('procKind', () => {
    test('stun, snare or neither, from the server\'s words', () => {
        expect(procKind(SHIELD[0]!)).toBe('stun');
        expect(procKind(CELTIC[2]!)).toBe('snare');
        expect(procKind(BLADES[2]!)).toBeNull();
        expect(procKind(BLADES[6]!)).toBeNull();
    });
});

describe('openerFor', () => {
    test('the Hero: Disable from the side, Numb behind it (a stun wherever he stands)', () => {
        expect(openerFor([...BLADES, ...SHIELD], HERO_HANDS, 100)).toEqual({ queue: ['Disable', 'Numb'], position: 'side', proc: 'stun' });
    });

    test('a Blademaster: Ice Storm from the side, behind it the best plain style, never a taunt', () => {
        expect(openerFor([...BLADES, ...SHIELD, ...CELTIC], BM_HANDS, 100)).toEqual({ queue: ['Ice Storm', 'Hurricane'], position: 'side', proc: 'stun' });
    });

    test('immune to a stun: the snare from behind', () => {
        expect(openerFor([...BLADES, ...CELTIC], BM_HANDS, 100, { stunImmune: true })).toMatchObject({ queue: ['Snow Shower', 'Hurricane'], position: 'back', proc: 'snare' });
    });

    test('a reaction, a follow-up or a detaunt never opens', () => {
        const op = openerFor([BLADES[1]!, BLADES[3]!, BLADES[5]!, BLADES[7]!], HERO_HANDS, 100);
        expect(op).toBeNull();
    });

    test('no anytime style to back it: no positional either, since a spot missed would swing plain', () => {
        expect(openerFor([SHIELD[2]!], HERO_HANDS, 100)).toBeNull();
        expect(openerFor([SHIELD[2]!, SHIELD[0]!], HERO_HANDS, 100)?.queue).toEqual(['Disable', 'Numb']);
    });

    test('what the endurance pays for', () => {
        // At 12 % the only anytime styles are taunts: one of them backs the stun all the same.
        expect(openerFor([...BLADES, ...CELTIC], BM_HANDS, 12)?.queue).toEqual(['Ice Storm', 'Taunting Blade']);
        expect(openerFor([...BLADES, ...CELTIC], BM_HANDS, 5)).toBeNull();
    });

    test('a weapon not in hand: not its styles', () => {
        expect(openerFor([...BLADES, ...SHIELD], BM_HANDS, 100)).toEqual({ queue: ['Glowing Blade', 'Fire Blade'], position: 'side', proc: 'snare' });
    });
});

describe('openSpot', () => {
    const foe = { x: 10_000, y: 20_000, heading: 1234 };
    test('each spot meets its cone, OPEN_REACH out', () => {
        for (const where of ['side', 'back', 'front'] as const) {
            const p = openSpot(foe, where, { x: 9000, y: 20_000 });
            expect(standsAt(angleOff(foe, p))).toBe(where);
            expect(Math.round(Math.hypot(p.x - foe.x, p.y - foe.y))).toBe(80);
        }
    });

    test('the nearer side', () => {
        const facingNorth = { x: 0, y: 0, heading: 2048 };
        const a = openSpot(facingNorth, 'side', { x: 500, y: 0 });
        const b = openSpot(facingNorth, 'side', { x: -500, y: 0 });
        expect(Math.sign(a.x)).toBe(1);
        expect(Math.sign(b.x)).toBe(-1);
    });
});

describe('openerOf', () => {
    const now = 1_000_000;
    const m = (name: string, x: number, o: Partial<MemberReport> = {}): MemberReport => ({
        name, bot: name.toLowerCase(), role: 'melee', className: 'Blademaster', level: 24, experience: 0, objectId: ids++, regionId: 1, x, y: 0, z: 0, hp: 100, mana: 0, endurance: 100,
        load: 0, isDead: false, isSitting: false, inCombat: false, attacking: false, targetId: null, effects: [], capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] },
        activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, at: now, ...o,
    });
    const briton = { objectId: 437, regionId: 1, x: 0, y: 0, cc: { by: 'Fiacra', kind: 'mezz', until: now + 30_000 } } as Contact;

    test('the nearest melee bot, tank or melee; no healer, no human, no dead', () => {
        const team = [m('Laoghaire', 600), m('Fionn', 400), m('Cuchulainn', 500, { role: 'tank', className: 'Hero' }), m('Amergin', 100, { role: 'healer' }), m('Niamh', 50, { observed: true, role: 'nuker' }), m('Conall', 60, { isDead: true })];
        expect(openerOf(team, briton, now)).toBe('Fionn');
    });

    test('a claim holds over the nearest, the earliest of two', () => {
        const team = [m('Fionn', 400), m('Laoghaire', 600, { activity: { kind: 'open', targetId: 437, detail: '', since: now - 2000 } }), m('Cuchulainn', 900, { role: 'tank', activity: { kind: 'open', targetId: 437, detail: '', since: now - 1000 } })];
        expect(openerOf(team, briton, now)).toBe('Laoghaire');
    });

    test('a stale claim, or one on another target, holds nobody', () => {
        const team = [m('Fionn', 400), m('Laoghaire', 600, { activity: { kind: 'open', targetId: 437, detail: '', since: now - 20_000 } }), m('Cuchulainn', 300, { role: 'tank', activity: { kind: 'open', targetId: 438, detail: '', since: now - 1000 } })];
        expect(openerOf(team, briton, now)).toBe('Cuchulainn');
    });

    test('nobody within reach of it: none', () => {
        expect(openerOf([m('Fionn', 4000)], briton, now)).toBeNull();
    });
});
