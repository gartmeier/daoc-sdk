import { describe, expect, test } from 'bun:test';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import { enemy } from '../group/fixtures';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { pickStyle, STYLE_RULES } from '../group/styles';
import type { SpellDetails, Style } from '../types';
import { berserker, berserkNow, BERSERK_REUSE_MS, chainOpener, withChain } from './berserker';
import { stylesFor } from './skald';

/** Ragnar's styles at Left Axe 24, Hammer 21 (data/class-sheet.ts Berserker): growth x 200, endurance, opening. */
const style = (name: string, line: string, growth: number, fatigue: number, over: Partial<NonNullable<Style['details']>> = {}, proc: string | null = null): Style => ({
    name, internalId: 0, specLevel: 1, specName: line, skillIndex: 0, prerequisite: 0x100,
    details: {
        fatigue, attackMod: 0, defensiveMod: 0, openingDamage: growth, opening: 'offensive', result: null, position: null, openingStyle: null, followUps: [],
        weapon: line === 'Left Axe' ? 'Left Axe' : 'Hammer', stealth: false, procSpellId: proc ? 1 : null, ...(proc ? { procSpell: { description: proc } as SpellDetails } : {}), ...over,
    },
} as Style);
const TAUNT = 'Taunts the target, increasing your threat against it by 17.';
const DETAUNT = 'Detaunts the target, decreases your threat against it by 19.';
const RAGNAR = [
    style('Ravager', 'Left Axe', 70, 10),
    style('Atrophy', 'Left Axe', 132, 10, { result: 'styledHit', openingStyle: 'Ravager' }, 'Snares the target.'),
    style('Scathing Blade', 'Left Axe', 194, 10, { result: 'styledHit', openingStyle: 'Atrophy' }, 'Slows the target.'),
    style('Snowblind', 'Left Axe', 114, 10, {}, TAUNT),
    style('Polar Light', 'Left Axe', 175, 5, { opening: 'defensive', result: 'parry' }, 'Slows the target.'),
    style('Ruiner', 'Hammer', 80, 10),
    style('Placate', 'Hammer', 40, 10, {}, DETAUNT),
    style('Provoke', 'Hammer', 115, 5, {}, TAUNT),
    style('Frost Hammer', 'Hammer', 134, 10, { opening: 'positional', position: 'side' }, 'Snares the target.'),
];

describe('berserker kit', () => {
    test('a melee whose fight is assistMelee, with Berserk above flee, in every list', () => {
        expect(berserker().role).toBe('melee');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.melee as Behavior<any>[], berserker()).map(b => b.name);
            expect(list.filter(n => n === 'assistMelee')).toHaveLength(1);
            expect(list.indexOf('berserk')).toBeLessThan(list.indexOf('assistMelee'));
        }
    });

    test('the chain opener is Ravager (Atrophy follows it), never a taunt', () => {
        expect(chainOpener(RAGNAR)?.name).toBe('Ravager');
        expect(chainOpener(RAGNAR.filter(s => s.name !== 'Atrophy'))).toBeNull();
    });

    test('the plain swing becomes Ravager; reactions, positionals and follow-ups stay first', () => {
        const players = stylesFor(RAGNAR, true);
        // fighterStyle alone takes Ruiner (8.0 per endurance) over Ravager (7.0): the chain never starts.
        const plain = pickStyle(players, { last: null, foeDid: null, endurancePercent: 100 }, STYLE_RULES);
        expect(plain).toEqual(['Polar Light', 'Ruiner']);
        expect(withChain(plain, players)).toEqual(['Polar Light', 'Ravager']);
        const held = pickStyle(players, { last: null, foeDid: null, endurancePercent: 100, held: true }, STYLE_RULES);
        expect(withChain(held, players)).toEqual(['Frost Hammer', 'Ravager']);
        const after = pickStyle(players, { last: 'Ravager', foeDid: null, endurancePercent: 100 }, STYLE_RULES);
        expect(withChain(after, players)[0]).toBe('Atrophy');
        // Low endurance: only what is certain, nothing added.
        expect(withChain(pickStyle(players, { last: null, foeDid: null, endurancePercent: 20 }, STYLE_RULES), players)).toEqual([]);
    });

    test('no taunt at a player: Provoke and Snowblind are left out', () => {
        expect(stylesFor(RAGNAR, true).map(s => s.name)).not.toContain('Provoke');
        expect(stylesFor(RAGNAR, true).map(s => s.name)).not.toContain('Snowblind');
    });

    test('Berserk on a near focus going down, with him healthy and at most one on him; then not for 7 minutes', () => {
        const now = 1_000_000;
        const hurt = enemy(1, 'hibernia', { hp: 55 });
        const base = { focus: hurt, distance: 200, myHp: 80, onMe: 1, readyAt: 0, now };
        expect(berserkNow(base)).toBe(true);
        expect(berserkNow({ ...base, focus: enemy(1, 'hibernia', { hp: 70 }) })).toBe(false);
        expect(berserkNow({ ...base, focus: enemy(1, 'hibernia', { hp: 70, healer: true }) })).toBe(true);
        expect(berserkNow({ ...base, distance: 400 })).toBe(false);
        expect(berserkNow({ ...base, myHp: 45 })).toBe(false);
        expect(berserkNow({ ...base, onMe: 2 })).toBe(false);
        expect(berserkNow({ ...base, readyAt: now + BERSERK_REUSE_MS })).toBe(false);
        expect(berserkNow({ ...base, focus: enemy(1, 'hibernia', { hp: 40, cc: { by: 'x', kind: 'mezz', until: now + 5000 } }) })).toBe(false);
        expect(berserkNow({ ...base, focus: { ...hurt, kind: 'npc' } })).toBe(false);
    });
});
