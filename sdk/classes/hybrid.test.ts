import { describe, expect, test } from 'bun:test';
import { enemy } from '../group/fixtures';
import { STYLE_RULES } from '../group/styles';
import { bestPlain, combatBuffNow, moreInterrupts, snareNow, withPlayerPlain } from './hybrid';
import { kitStyles } from './style-fixtures';
import type { SpellPick } from '../group/spells';

describe('the shared pieces of the melee and song kits', () => {
    const merc = kitStyles('Mercenary', 'Pure damage');

    test('at a player the best plain swing counts taunts (a taunt style\'s growth is damage), never a detaunt', () => {
        expect(['Inflame', 'Enrage']).toContain(bestPlain(merc)!.name);
        expect(bestPlain(merc.filter(s => !/taunt/i.test(s.details?.procSpell?.description ?? '')))!.name).toBe('Uppercut');
    });

    test('withPlayerPlain swaps a weaker plain swing, adds one behind a lone conditional, and adds nothing at low endurance', () => {
        expect(withPlayerPlain(["Shadow's Edge", 'Uppercut'], merc, 100)).toEqual(["Shadow's Edge", bestPlain(merc)!.name]);
        expect(withPlayerPlain(['Orbit'], merc, 100)).toEqual(['Orbit', bestPlain(merc)!.name]);
        expect(withPlayerPlain([], merc, 100)).toEqual([bestPlain(merc)!.name]);
        expect(withPlayerPlain(['Orbit'], merc, STYLE_RULES.saveEndurance - 1)).toEqual(['Orbit']);
    });

    test('a combat buff only in an engage, the focus in reach, above the health floor, and not already on', () => {
        const base = { engaged: true, distance: 200, reach: 350, hp: 90, minHp: 60, on: false, readyAt: 0, now: 1000 };
        expect(combatBuffNow(base)).toBe(true);
        expect(combatBuffNow({ ...base, engaged: false })).toBe(false);
        expect(combatBuffNow({ ...base, distance: 600 })).toBe(false);
        expect(combatBuffNow({ ...base, distance: null })).toBe(false);
        expect(combatBuffNow({ ...base, hp: 55 })).toBe(false);
        expect(combatBuffNow({ ...base, on: true })).toBe(false);
        expect(combatBuffNow({ ...base, readyAt: 2000 })).toBe(false);
    });

    test('a snare on a free focus player out of melee reach and in range, not again while ours holds', () => {
        const f = enemy(2, 'midgard');
        const base = { focus: f, distance: 800, range: 1500, until: 0, now: 1000 };
        expect(snareNow(base)).toBe(true);
        expect(snareNow({ ...base, distance: 300 })).toBe(false);
        expect(snareNow({ ...base, distance: 1600 })).toBe(false);
        expect(snareNow({ ...base, until: 5000 })).toBe(false);
        expect(snareNow({ ...base, focus: { ...f, kind: 'npc' } })).toBe(false);
        expect(snareNow({ ...base, focus: { ...f, cc: { by: 'x', kind: 'mezz', until: 9e12 } } })).toBe(false);
    });

    test('a lifedrain counts as an interrupt only as an instant single-target spell', () => {
        const pick = (o: Partial<SpellPick>) => ({ type: 'Lifedrain', target: 'Enemy', castTime: 0, range: 1000, radius: 0, spell: { name: 'x', level: 1, cooldownRemaining: 0 }, ...o }) as SpellPick;
        expect(moreInterrupts([pick({})], ['Lifedrain'], () => true)).toHaveLength(1);
        expect(moreInterrupts([pick({ castTime: 2.5 })], ['Lifedrain'], () => true)).toHaveLength(0);
        expect(moreInterrupts([pick({ radius: 350 })], ['Lifedrain'], () => true)).toHaveLength(0);
        expect(moreInterrupts([pick({})], ['Lifedrain'], () => false)).toHaveLength(0);
    });
});
