import { describe, expect, test } from 'bun:test';
import { report } from './fixtures';
import { chooseSong, songKind, type SongKind } from './songs';
import type { MemberReport, Role } from './types';

const caster = { heal: true, cc: false, nuke: true, buffs: [], buffSpells: [] };
const fighter = { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] };
const m = (name: string, role: Role, over: Partial<MemberReport> = {}) =>
    report(name, { role, capabilities: role === 'tank' ? fighter : caster, ...over });
const group = (over: Record<string, Partial<MemberReport>> = {}) => [
    m('Cuchulainn', 'tank', { mana: 0, ...over.Cuchulainn }), m('Brigid', 'healer', over.Brigid), m('Oisin', 'support', over.Oisin),
    m('Niamh', 'nuker', over.Niamh), m('Ciaran', 'nuker', over.Ciaran),
];
// Oisin at level 9: Chant of Healing, Rhythm of Hibernia, Clear Path; a power song comes later.
const OISIN: SongKind[] = ['health', 'endurance', 'speed'];
const WITH_POWER: SongKind[] = [...OISIN, 'power'];

describe('song choice', () => {
    test('songs are pulsing Group/Self spells of four kinds', () => {
        expect(songKind({ type: 'SpeedEnhancement', target: 'Group', pulse: true })).toBe('speed');
        expect(songKind({ type: 'PowerRegenBuff', target: 'Group', pulse: true })).toBe('power');
        expect(songKind({ type: 'EnduranceRegenBuff', target: 'Group', pulse: false })).toBeNull();   // a timed buff
        expect(songKind({ type: 'Mesmerize', target: 'Enemy', pulse: true })).toBeNull();
    });

    test('speed while travelling, endurance while pulling and fighting', () => {
        expect(chooseSong(OISIN, 'travel', group())).toBe('speed');
        expect(chooseSong(OISIN, 'pull', group())).toBe('endurance');
        expect(chooseSong(OISIN, 'engage', group({ Niamh: { mana: 5 } }))).toBe('endurance');
    });

    test('between fights: power for low casters, else health for the hurt, else endurance', () => {
        expect(chooseSong(WITH_POWER, 'recover', group({ Niamh: { mana: 40 }, Cuchulainn: { hp: 50 } }))).toBe('power');
        expect(chooseSong(WITH_POWER, 'recover', group({ Cuchulainn: { hp: 50 } }))).toBe('health');
        expect(chooseSong(WITH_POWER, 'idle', group())).toBe('endurance');
        // The tank's 0 power doesn't count; a dead caster's doesn't either.
        expect(chooseSong(WITH_POWER, 'idle', group({ Ciaran: { mana: 0, isDead: true } }))).toBe('endurance');
        // No power song yet (Oisin at 9): low casters fall through to health or endurance.
        expect(chooseSong(OISIN, 'recover', group({ Niamh: { mana: 20 } }))).toBe('endurance');
    });

    test('nothing to play without songs', () => {
        expect(chooseSong([], 'travel', group())).toBeNull();
    });
});
