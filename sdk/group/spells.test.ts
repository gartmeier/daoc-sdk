import { describe, expect, test } from 'bun:test';
import { getSpell, getSpellLines, getSpells } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import type { Spell } from '../types';
import { dotFamily, healAmount, pickHeal, pickNuke, Spellbook, toPick, type SpellPick } from './spells';

// The spells of each line up to a level, with their real DB rows (as spellsOf builds them).
function known(lines: Record<string, number>): SpellPick[] {
    return Object.entries(lines).flatMap(([key, upTo]) => {
        const line = getSpellLines().find(l => l.keyName === key)!;
        return line.spells.filter(s => s.level <= upTo).map((s, i) => {
            const info = getSpell(s.spellId)!;
            const spell: Spell = { name: info.name, level: s.level, internalId: info.id, lineName: line.name, lineIndex: 0, spellIndex: i, cooldownRemaining: 0 };
            return toPick(spell, info);
        });
    });
}

// Niamh, the hibernia Mentalist at 13: Mentalism and Way of the Sun (baseline) to 13, Holism to 4.
const NIAMH = known({ Mentalism: 13, Holism: 4, 'Way of the Sun': 13 });
const byName = (name: string) => NIAMH.find(s => s.spell.name === name)!;
const name = (s: SpellPick | null) => s?.spell.name ?? null;
const ILLUSORY = 'f50';
const MIND_FADE = 'f40';

describe('pickNuke (Niamh, Mentalist 13, real spell rows)', () => {
    test('the data: the Illusory ranks share one group, Minor Mind Fade has its own', () => {
        const row = (n: string) => [byName(n).spellGroup, byName(n).damage, byName(n).type];
        expect(row('Illusory Anguish')).toEqual([4611, 19, 'DamageOverTime']);
        expect(row('Illusory Cramps')).toEqual([4611, 15, 'DamageOverTime']);
        expect(row('Illusory Pains')).toEqual([4611, 9, 'DamageOverTime']);
        expect(row('Illusory Ache')).toEqual([4611, 2, 'DamageOverTime']);
        expect(row('Minor Mind Fade')).toEqual([4421, 2, 'DamageOverTime']);
        expect(row('Moon Blast')).toEqual([4101, 49, 'DirectDamage']);
        expect(dotFamily(byName('Illusory Anguish'))).toBe(ILLUSORY);
        expect(dotFamily(byName('Illusory Ache'))).toBe(ILLUSORY);
        expect(dotFamily(byName('Minor Mind Fade'))).toBe(MIND_FADE);
    });

    test('a fresh target gets Illusory Anguish', () => {
        expect(name(pickNuke(NIAMH, { dotted: new Set() }))).toBe('Illusory Anguish');
        expect(name(pickNuke(NIAMH))).toBe('Illusory Anguish');
    });

    test('with the Illusory family on it: Moon Blast, never Cramps, Pains or Ache', () => {
        const dotted = new Set([dotFamily(byName('Illusory Anguish'))]);
        expect(name(pickNuke(NIAMH, { dotted, targetHp: 100 }))).toBe('Moon Blast');
    });

    test('Minor Mind Fade and the weaker Illusory ranks are never picked', () => {
        const families = [[], [ILLUSORY], [MIND_FADE], [ILLUSORY, MIND_FADE]];
        const allowed: (string | null)[] = ['Illusory Anguish', 'Moon Blast'];
        for (const f of families) {
            for (const targetHp of [100, 60, 41, 40, 10]) {
                expect(allowed).toContain(name(pickNuke(NIAMH, { dotted: new Set(f), targetHp })));
            }
        }
    });

    test('at or below dotAbove only direct damage', () => {
        expect(name(pickNuke(NIAMH, { targetHp: 40 }))).toBe('Moon Blast');
        expect(name(pickNuke(NIAMH, { targetHp: 30, dotAbove: 20 }))).toBe('Illusory Anguish');
    });

    test('an effect group, when a DoT has one, is its family (the server matches on it first)', () => {
        const grouped = { ...byName('Illusory Anguish'), effectGroup: 99 };
        expect(dotFamily(grouped)).toBe('e99');
        expect(name(pickNuke([grouped, byName('Moon Blast')], { dotted: new Set(['e99']) }))).toBe('Moon Blast');
        expect(name(pickNuke([grouped, byName('Moon Blast')], { dotted: new Set([ILLUSORY]) }))).toBe('Illusory Anguish');
    });

    test('low power: the bar stays at the best direct damage we know', () => {
        const upTo = (power: number) => (s: SpellPick) => s.power <= power;
        expect(name(pickNuke(NIAMH, { ready: upTo(7) }))).toBe('Illusory Anguish');
        expect(name(pickNuke(NIAMH, { dotted: new Set([ILLUSORY]), ready: upTo(7) }))).toBe('Moon Streak');
        // 3 power: Pains (9) clears a quarter of Gleam Blast (13), the best we can afford, but not of Moon Blast (49).
        expect(name(pickNuke(NIAMH, { ready: upTo(3) }))).toBe('Gleam Blast');
        // 1 power: Ache is all we could afford, and not worth a cast.
        expect(pickNuke(NIAMH, { ready: upTo(1) })).toBeNull();
    });

    test('without direct damage every DoT qualifies, one per family', () => {
        const dots = known({ Mentalism: 13, Holism: 4 });
        expect(name(pickNuke(dots))).toBe('Illusory Anguish');
        expect(name(pickNuke(dots, { dotted: new Set([ILLUSORY]) }))).toBe('Minor Mind Fade');
        expect(pickNuke(dots, { dotted: new Set([ILLUSORY, MIND_FADE]) })).toBeNull();
    });

    test('area DoTs only with aoe (Holism 17: Shroud of Madness, radius 350)', () => {
        const mana17 = known({ Holism: 17, 'Way of the Sun': 17 });
        expect(name(pickNuke(mana17))).toBe('Mind Dissolution');
        expect(name(pickNuke(mana17, { aoe: true }))).toBe('Shroud of Madness');
    });
});

describe('Spellbook.nuke', () => {
    function book(mana: number, cooldowns: Record<string, number> = {}): Spellbook {
        const spells = NIAMH.map(p => ({ ...p.spell, cooldownRemaining: cooldowns[p.spell.name] ?? 0 }));
        const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana }) } as unknown as BotSDK;
        const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
        return new Spellbook(sdk, bot);
    }

    test('picks by family over the spells castable now', () => {
        expect(name(book(100).nuke({ dotted: new Set() }))).toBe('Illusory Anguish');
        expect(name(book(100).nuke({ dotted: new Set([ILLUSORY]) }))).toBe('Moon Blast');
        expect(name(book(7).nuke({ dotted: new Set([ILLUSORY]) }))).toBe('Moon Streak');
        expect(name(book(100, { 'Moon Blast': 5 }).nuke({ dotted: new Set([ILLUSORY]) }))).toBe('Moon Streak');
        expect(book(1).nuke()).toBeNull();
    });
});

describe('Spellbook.mezz and cc: what can be cast at an add', () => {
    // Real spell rows at made-up levels, the point-blank and area mezzes highest (as Hrafna's and Merlin's are).
    function book(spells: [string, number][]): Spellbook {
        const known = spells.map(([n, level], i) => {
            const info = getSpells().find(s => s.name === n)!;
            return { name: n, level, internalId: info.id, lineName: 'test', lineIndex: 0, spellIndex: i, cooldownRemaining: 0 } as Spell;
        });
        const sdk = { getSkills: () => ({ spells: known }), getPlayer: () => ({ mana: 100 }) } as unknown as BotSDK;
        const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
        return new Spellbook(sdk, bot);
    }
    test('a point-blank mezz (range 0) is never picked: the single-target one is', () => {
        const hrafna = book([['Dark Wave', 20], ['Hold Spirit', 10], ['Lessen Movement', 4]]);
        expect(name(hrafna.mezz())).toBe('Hold Spirit');
        expect(hrafna.cc()).toMatchObject({ kind: 'mezz', spell: { name: 'Hold Spirit' } });
        expect(name(book([['Dark Wave', 20], ['Lessen Movement', 4]]).cc())).toBe('Lessen Movement');
        expect(book([['Heavenly Visions', 20]]).capabilities().cc).toBe(false);
    });
    test('an area mezz only with aoe, and only after the single-target ones', () => {
        const merlin = book([['Fog of Senility', 20], ['Major Mesmerization', 18]]);
        expect(name(merlin.mezz())).toBe('Major Mesmerization');
        expect(name(book([['Fog of Senility', 20]]).mezz())).toBeNull();
        expect(name(book([['Fog of Senility', 20]]).mezz({ aoe: true }))).toBe('Fog of Senility');
    });
});

describe('pickHeal', () => {
    // A Healer at level 20, from the real lines: Minor Recovery (48) and Major Reparation (172) are both level 18.
    const heals = known({ Mending: 20, 'Healer Mending Spec': 20 }).filter(s => s.type === 'Heal' && s.target === 'Realm' && s.radius === 0);
    const named = (n: string) => heals.find(s => s.spell.name === n)!;

    test('the cheapest that covers what the target misses', () => {
        expect(pickHeal(heals, { missing: 40, casterMaxHp: 500 })!.value).toBeGreaterThanOrEqual(40);
        expect(pickHeal(heals, { missing: 40, casterMaxHp: 500 })!.power).toBeLessThanOrEqual(8);
        expect(name(pickHeal(heals, { missing: 170, casterMaxHp: 500 }))).toBe('Major Reparation');
    });

    test('nothing covers it: the one restoring most, whatever its level', () => {
        expect(named('Greater Recovery').spell.level).toBeLessThan(named('Minor Recovery').spell.level);
        expect(name(pickHeal(heals.filter(s => !s.recast), { missing: 400, casterMaxHp: 500 }))).toBe('Greater Recovery');
    });

    test('without a need: the one restoring most', () => {
        expect(name(pickHeal(heals.filter(s => !s.recast), { casterMaxHp: 500 }))).toBe('Greater Recovery');
    });

    test('a negative value is a percent of the caster, not of the one it lands on', () => {
        const pct = { ...named('Minor Recovery'), value: -50, power: 1 };
        expect(healAmount(pct, 400)).toBe(200);
        expect(pickHeal([named('Minor Recovery'), named('Major Reparation'), pct], { missing: 180, casterMaxHp: 400 })).toBe(pct);
        expect(pickHeal([named('Minor Recovery'), pct], { missing: 180, casterMaxHp: 200 })).toBe(pct);   // restoring most, at 100
        expect(pickHeal([named('Major Reparation'), pct], { missing: 180, casterMaxHp: 200 })).toBe(named('Major Reparation'));
    });

    test('one on a timer waits until nothing else covers the need', () => {
        const eir = heals.find(s => s.value < 0)!;
        expect(eir.recast).toBeGreaterThan(0);
        const few = [named('Minor Recovery'), named('Major Reparation'), eir];
        expect(pickHeal(few, { missing: 100, casterMaxHp: 1000 })).toBe(named('Major Reparation'));
        expect(pickHeal(few, { missing: 300, casterMaxHp: 1000 })).toBe(eir);
    });

    test('nothing to pick from', () => {
        expect(pickHeal([], { casterMaxHp: 100 })).toBeNull();
    });
});
