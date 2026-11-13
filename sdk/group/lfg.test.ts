// "lfg" (lfg.ts): reading a human's ask, the unit that takes them and who steps out.
import { describe, expect, test } from 'bun:test';
import { classOf, placeHuman, readLfg, stepOutOf, type LfgUnit } from './lfg';

describe('the words', () => {
    test('an ask for a group', () => {
        for (const t of ['lfg', 'LFG ment', 'hi, any room?', 'can i join', 'inv pls', 'looking for a group']) expect(readLfg(t).ask).toBe(true);
        for (const t of ['hi', 'nice fight', 'where is the faste']) expect(readLfg(t).ask).toBe(false);
    });
    test('a class, by name, alias or a prefix only one class has', () => {
        expect(classOf('lfg ment')).toBe('Mentalist');
        expect(classOf("I'm a druid")).toBe('Druid');
        expect(classOf('menta')).toBe('Mentalist');
        expect(classOf('lfg zerk 24')).toBe('Berserker');
        expect(classOf('lfg')).toBeNull();
        // "war" is too short and two classes start "war": none.
        expect(classOf('war')).toBeNull();
    });
});

const hib = (unit: string, over: Partial<LfgUnit> = {}): LfgUnit => ({
    unit, leader: 'cian', running: true, squad: false, observed: [], requires: ['Druid', 'Bard'],
    members: [
        { bot: 'cian', className: 'Hero', role: 'tank' },
        { bot: 'aine', className: 'Druid', role: 'healer' },
        { bot: 'fiacra', className: 'Bard', role: 'support' },
        { bot: 'oisin', className: 'Enchanter', role: 'nuker' },
        { bot: 'niall', className: 'Blademaster', role: 'melee' },
        { bot: 'deirdre', className: 'Mentalist', role: 'nuker' },
    ],
    ...over,
});

describe('placing a human', () => {
    test('the unit missing their role first', () => {
        const a = hib('hibernia');
        const b = hib('hibernia-2', { members: hib('x').members.filter(m => m.role !== 'nuker') });
        expect(placeHuman([a, b], 'Mentalist')).toMatchObject({ unit: 'hibernia-2' });
    });
    test('a nuker replaces a nuker; never the leader nor the only Druid or Bard', () => {
        const u = hib('hibernia');
        expect(stepOutOf(u, 'nuker')?.bot).toBe('deirdre');
        expect(stepOutOf(u, 'healer')?.bot).not.toBe('aine');
        // The most doubled role steps out for a role the unit lacks.
        const noMelee = hib('h', { members: u.members.filter(m => m.bot !== 'niall') });
        expect(stepOutOf(noMelee, 'melee')?.bot).toBe('deirdre');
    });
    test('squads, units not running and a unit with a human already are skipped', () => {
        expect(placeHuman([hib('hibernia-s1', { squad: true }), hib('hibernia', { running: false }), hib('hibernia-2', { observed: ['Ana'] })], 'Mentalist')).toBeNull();
    });
    test('a tank class reads as melee', () => {
        expect(placeHuman([hib('hibernia')], 'Guardian')).toMatchObject({ unit: 'hibernia', stepOut: 'niall' });
    });
});

describe('what the watcher hears', () => {
    test("a sortie change is no leaving: absence counts only in a live, formed run", async () => {
        const { absenceCounts, FORMING_MS } = await import('./lfg-watch');
        const now = 1_000_000;
        expect(absenceCounts(null, now)).toBe(false);
        expect(absenceCounts({ state: 'ending', firstAt: 0 }, now)).toBe(false);
        expect(absenceCounts({ state: 'starting', firstAt: now - 1000 }, now)).toBe(false);
        expect(absenceCounts({ state: 'live', firstAt: now - 2000 }, now)).toBe(false);
        expect(absenceCounts({ state: 'live', firstAt: 0, timing: { windingDown: true } }, now)).toBe(false);
        expect(absenceCounts({ state: 'live', firstAt: now - FORMING_MS, timing: { windingDown: false } }, now)).toBe(true);
    });
    test('a whisper and a /region line, never our own', async () => {
        const { heardLine } = await import('./lfg-watch');
        expect(heardLine({ type: 'send', text: 'Eimearx sends, "lfg"', sender: 'Eimearx' })).toEqual({ from: 'Eimearx', text: 'lfg' });
        expect(heardLine({ type: 'broadcast', text: '[Region] Eimearx: lfg magician', sender: null })).toEqual({ from: 'Eimearx', text: 'lfg magician' });
        expect(heardLine({ type: 'send', text: 'You send, "sure, what class are you?" to Eimearx.', sender: null })).toBeNull();
    });
});
