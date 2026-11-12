import { describe, expect, test } from 'bun:test';
import { getSpell, getSpellLines, getSpells } from '../../data/index';
import type { BotActions } from '../actions';
import { effectiveSpellRange, worstPowerCost } from '../actions-helpers';
import type { BotSDK } from '../index';
import { makePlayer } from '../test/fixtures';
import type { PlayerState, Spell } from '../types';
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
    test('root(): the root with a mezz ready too, and capabilities say who holds one (assignCc reads it: an NPC under 75 % takes no mezz)', () => {
        const hrafna = book([['Hold Spirit', 10], ['Lessen Movement', 4]]);
        expect(hrafna.cc()).toMatchObject({ kind: 'mezz' });
        expect(hrafna.root()).toMatchObject({ kind: 'root', spell: { name: 'Lessen Movement' } });
        expect(hrafna.capabilities()).toMatchObject({ cc: true, root: true });
        const merlin = book([['Major Mesmerization', 18]]);
        expect(merlin.root()).toBeNull();
        expect(merlin.capabilities().cc).toBe(true);
        expect('root' in merlin.capabilities()).toBe(false);
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

describe('Spellbook: pets (real spell rows)', () => {
    // Every spell of the named lines up to a level, as a member of that spec knows them.
    function book(lines: Record<string, number>, player: Partial<PlayerState> = {}, cooldowns: Record<string, number> = {}): Spellbook {
        const spells = known(lines).map(s => ({ ...s.spell, cooldownRemaining: cooldowns[s.spell.name] ?? 0 }));
        const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana: 500, maxHealth: 400, ...player }) } as unknown as BotSDK;
        const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
        return new Spellbook(sdk, bot);
    }

    test('toPick carries the icon, which is how a pet buff is seen on the pet', () => {
        const info = getSpell(2860)!;
        expect(toPick({ name: info.name, level: 7 } as Spell, info).icon).toBe(2860);
    });

    describe('summon(): the window pets the group summons by itself', () => {
        test('the top rank each class knows, whatever it costs or its timer says: the behaviour weighs that', () => {
            expect(name(book({ Summoning: 20 }).summon())).toBe('Summon Spirit Warrior');
            expect(name(book({ Summoning: 19 }).summon())).toBe('Summon Spirit Swordsman');
            expect(name(book({ 'Spirit Animation': 20 }).summon())).toBe('Emerald Simulacrum');
            expect(name(book({ Enchantment: 20 }).summon())).toBe('Underhill Compatriot');
            expect(name(book({ 'Druid Nature Spec': 12 }).summon())).toBe('Call Nature Spirit');
            expect(name(book({ Beastcraft: 13 }).summon())).toBe('Hunter\'s Ally');
            expect(name(book({ 'Bone Army': 15 }).summon())).toBe('Summon Bone Chieftan');
            expect(name(book({ Summoning: 20 }, { mana: 0 }, { 'Summon Spirit Warrior': 30 }).summon())).toBe('Summon Spirit Warrior');
        });

        describe('a pet capped far below us is no pet to keep up: its level is a percent of ours up to its value (GameSummonedPet.cs:34-52)', () => {
            test('a Heal druid at Nature 1: L7 from Call Minor Nature Spirit, fine at 14, and not at 15 for 25 % of her power each time', () => {
                expect(name(book({ 'Druid Nature Spec': 1 }, { level: 10 }).summon())).toBe('Call Minor Nature Spirit');
                expect(name(book({ 'Druid Nature Spec': 1 }, { level: 14 }).summon())).toBe('Call Minor Nature Spirit');
                expect(book({ 'Druid Nature Spec': 1 }, { level: 15 }).summon()).toBeNull();
                expect(book({ 'Druid Nature Spec': 1 }, { level: 24 }).summon()).toBeNull();
            });

            test('so nothing else counts on it: no pet in its capabilities', () => {
                expect(book({ 'Druid Nature Spec': 1 }, { level: 24 }).capabilities().pet).toBeNull();
                expect(book({ 'Druid Nature Spec': 1 }, { level: 10 }).capabilities().pet).toBe('main');
            });

            test('the Nature Druids at 24 keep theirs, at L18', () => {
                expect(name(book({ 'Druid Nature Spec': 12 }, { level: 24 }).summon())).toBe('Call Nature Spirit');
                expect(name(book({ 'Druid Nature Spec': 20 }, { level: 24 }).summon())).toBe('Call Major Nature Spirit');
            });

            test('a stealth Hunter on Beastcraft 1 likewise; the classes whose pet comes with level keep it at any spec', () => {
                expect(book({ Beastcraft: 1 }, { level: 24 }).summon()).toBeNull();
                expect(name(book({ Summoning: 20 }, { level: 24 }).summon())).toBe('Summon Spirit Warrior');
                expect(name(book({ 'Spirit Animation': 20 }, { level: 24 }).summon())).toBe('Emerald Simulacrum');
                expect(name(book({ Enchantment: 20 }, { level: 24 }).summon())).toBe('Underhill Compatriot');
                expect(name(book({ 'Bone Army': 15 }, { level: 24 }).summon())).toBe('Summon Bone Chieftan');
            });
        });

        test('never a Necromancer\'s servant, an Animist\'s turret, a Theurgist\'s or nothing', () => {
            expect(book({ 'Death Servant': 20 }).summon()).toBeNull();
            expect(book({ 'Creeping Path': 20 }).summon()).toBeNull();
            expect(book({ 'Arboreal Mastery': 21 }).summon()).toBeNull();
            expect(book({ Abrasion: 20 }).summon()).toBeNull();
            expect(book({ Mentalism: 20 }).summon()).toBeNull();
        });
    });

    describe('fnf(): a Theurgist\'s', () => {
        test('the top rank over all its lines', () => {
            expect(name(book({ Abrasion: 20 }).fnf())).toBe('Call Potent Earth Elemental');
            expect(name(book({ Abrasion: 12, Refrigeration: 18, Vapormancy: 12 }).fnf())).toBe('Summon Aged Ice Spirit');
        });

        test('an Animist\'s fire-and-forget turret is of that kind and stays out, as does a main pet', () => {
            expect(book({ 'Arboreal Mastery': 21 }).fnf()).toBeNull();
            expect(book({ 'Creeping Path': 20 }).fnf()).toBeNull();
            expect(book({ Summoning: 20 }).fnf()).toBeNull();
        });
    });

    test('knowsTurret: an Animist\'s main pets, and nobody else\'s', () => {
        expect(book({ 'Arboreal Mastery': 21 }).knowsTurret()).toBe(true);
        expect(book({ 'Creeping Path Spec': 21 }).knowsTurret()).toBe(true);
        expect(book({ 'Spirit Animation': 20 }).knowsTurret()).toBe(false);
        expect(book({ Abrasion: 20 }).knowsTurret()).toBe(false);
        expect(book({ 'Death Servant': 20 }).knowsTurret()).toBe(false);
    });

    describe('capabilities', () => {
        test('pet says which, and a pet heal is no heal', () => {
            expect(book({ 'Spirit Animation': 20 }).capabilities()).toMatchObject({ pet: 'main', heal: false });
            expect(book({ Summoning: 20 }).capabilities().pet).toBe('main');
            expect(book({ Abrasion: 20 }).capabilities().pet).toBe('fnf');
            expect(book({ Mentalism: 20 }).capabilities().pet).toBeNull();
            expect(book({ 'Death Servant': 20 }).capabilities().pet).toBeNull();
            expect(book({ 'Creeping Path': 20 }).capabilities().pet).toBeNull();
        });

        test('the pet is known whatever the power', () => {
            expect(book({ Abrasion: 20 }, { mana: 0 }).capabilities().pet).toBe('fnf');
        });

        test('a heal on friends still counts', () => {
            expect(book({ Mentalism: 20 }).capabilities().heal).toBe(true);
            expect(book({ Regrowth: 20 }).capabilities().heal).toBe(true);
        });
    });

    describe('petHeal', () => {
        const cabalist = { 'Spirit Animation': 20 };
        test('the cheapest that covers what the pet misses, else the one restoring most, among what we can pay for', () => {
            expect(name(book(cabalist).petHeal(25))).toBe('Mend Simulacrum');
            expect(name(book(cabalist).petHeal(40))).toBe('Patch Simulacrum');
            expect(name(book(cabalist).petHeal())).toBe('Restore Simulacrum');
            expect(name(book(cabalist).petHeal(9999))).toBe('Restore Simulacrum');
            expect(name(book(cabalist, { mana: 4 }).petHeal(40))).toBe('Mend Simulacrum');
            expect(book(cabalist, { mana: 3 }).petHeal()).toBeNull();
        });

        test('heal() none on the pet; with no Pet-target heal it takes one on friends, at the pet\'s id (petHeal in pets.ts): a Druid\'s', () => {
            expect(book(cabalist).heal()).toBeNull();
            expect(book({ Regrowth: 20 }).petHeal()?.target).toBe('Realm');
        });

        describe('a heal on friends with a timer stays for the friends', () => {
            const DRUID = { maxHealth: 575, mana: 300 };
            const HEAL_DRUID = { Regrowth: 24, 'Regrowth Druid Spec': 22 };

            test('Heal druid: Greater Regrowth, not Nature\'s Blessing, 15 minutes between uses, which `heal` counts on past 263', () => {
                expect(name(book(HEAL_DRUID, DRUID).petHeal())).toBe('Greater Regrowth');
                expect(name(book(HEAL_DRUID, DRUID).heal(300))).toBe('Nature\'s Blessing');
            });

            test('with no power for the others, none at all: a free one is no reason', () => {
                expect(book(HEAL_DRUID, { ...DRUID, mana: 0 }).petHeal()).toBeNull();
            });

            test('at no spec of the line', () => {
                for (let level = 1; level <= 50; level++) expect(book({ Regrowth: 24, 'Regrowth Druid Spec': level }, DRUID).petHeal()?.recast ?? 0).toBe(0);
            });

            test('by what the pet misses: a level-7 pet\'s 41 takes Minor Regrowth at 8 power', () => {
                const heal = book(HEAL_DRUID, DRUID).petHeal(41)!;
                expect(name(heal)).toBe('Minor Regrowth');
                expect(heal.power).toBe(8);
            });
        });
    });

    describe('petBuffs', () => {
        const spiritmaster = { 'Spirit Enhancement': 16 };
        const buffs = (lines: Record<string, number>) => book(lines).petBuffs().map(s => [s.slot, s.spell.name]).sort();

        test('the top rank per slot, with its icon', () => {
            expect(buffs(spiritmaster)).toEqual([['dexqui', 'Valkyrie\'s Vivacity'], ['haste', 'Spirit of Attack'], ['strcon', 'Zest of Valhalla']]);
            expect(book(spiritmaster).petBuffs().find(s => s.slot === 'strcon')!.icon).toBe(2861);
        });

        test('never the 5-8 s pulsing damage shield, a conversion or a type with no slot', () => {
            const lines = { 'Spirit Animation': 50, 'Spirit Enhancement': 50, Vivification: 50 };
            const pets = known(lines).filter(s => s.target === 'Pet');
            // They are in those lines: a Spiritmaster's damage shield is 5 s, Convert Spirit has no slot.
            expect(pets.find(s => s.spell.name === 'Spirit\'s Revenge')).toMatchObject({ type: 'DamageShield', duration: 5, pulse: true });
            expect(pets.map(s => s.type)).toContain('PetConversion');
            const got = book(lines).petBuffs();
            expect(got.length).toBeGreaterThan(0);
            for (const s of got) expect([s.target, s.pulse, s.duration >= 60]).toEqual(['Pet', false, true]);
            expect(got.map(s => s.type)).not.toContain('DamageShield');
            expect(got.map(s => s.type)).not.toContain('PetConversion');
        });

        test('buffs() keeps them out of the group\'s plan', () => {
            expect(book(spiritmaster).buffs().map(s => s.target)).not.toContain('Pet');
        });

        test('none for a member with no pet line', () => {
            expect(book({ Mentalism: 20 }).petBuffs()).toEqual([]);
        });
    });

    describe('powerOf: the most it can cost (worstPowerCost)', () => {
        const stats = { strength: 0, dexterity: 0, constitution: 0, quickness: 0, intelligence: 100, piety: 0, empathy: 100, charisma: 0 };
        const summon = () => toPick({ name: 'x', level: 1 } as Spell, getSpell(804)!);

        test('a percent of the pool without items; a focus caster with no focus pays 1.2 ×', () => {
            const p = makePlayer({ className: 'Cabalist', realm: 'albion', level: 20, statsWithoutItems: stats });
            // 20 * (100 + 145) / 41 + 5 = 124 of it, 25 %: 31, and 1.2 × that.
            expect(book({}, p).powerOf(summon())).toBe(37);
            expect(book({}, p).powerOf(summon())).toBe(worstPowerCost(-25, p));
        });

        test('a flat cost as the server takes it', () => {
            const p = makePlayer({ className: 'Cabalist', realm: 'albion', level: 20, statsWithoutItems: stats });
            expect(book({}, p).powerOf({ power: 10 })).toBe(12);
            expect(book({}, makePlayer({ className: 'Hunter', realm: 'midgard', level: 20 })).powerOf({ power: 10 })).toBe(10);
        });

        test('with no player yet: nothing we can say beyond the flat cost', () => {
            const sdk = { getSkills: () => ({ spells: [] }), getPlayer: () => null } as unknown as BotSDK;
            const empty = new Spellbook(sdk, { getSpellInfo: () => null } as unknown as BotActions);
            expect(empty.powerOf({ power: 10 })).toBe(10);
            expect(empty.powerOf({ power: -25 })).toBe(0);
        });
    });
});

describe('Nearsight on us: every spell range as the server judges it (arena round 35)', () => {
    test('effectiveSpellRange: Obscuring Dust (-35 %) takes 2300 to 1495, 1500 to 975; the strongest counts, 32 is the floor', () => {
        const dust = { spellId: 587, isNegative: true };
        expect(effectiveSpellRange(2300, [dust])).toBe(1495);
        expect(effectiveSpellRange(1500, [dust])).toBe(975);
        expect(effectiveSpellRange(1500, [{ spellId: 586, isNegative: true }, dust])).toBe(975);
        expect(effectiveSpellRange(1500, [])).toBe(1500);
        expect(effectiveSpellRange(0, [dust])).toBe(0);
    });

    test('the Spellbook reads them cut while it is on us', () => {
        const spells = NIAMH.map(p => ({ ...p.spell, cooldownRemaining: 0 }));
        const effects: { spellId: number; isNegative: boolean }[] = [];
        const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana: 100 }), getState: () => ({ effects }) } as unknown as BotSDK;
        const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
        const book = new Spellbook(sdk, bot);
        const full = book.nuke({ dotted: new Set() })!.range;
        effects.push({ spellId: 587, isNegative: true });
        expect(book.nuke({ dotted: new Set() })!.range).toBe(Math.floor(full * 0.65));
    });
});

describe("Spellbook.buffs: a fight's buffs are not kept up", () => {
    const book = (lines: Record<string, number>) => {
        const spells = known(lines).map(s => s.spell);
        const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana: 500, maxHealth: 400 }) } as unknown as BotSDK;
        const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
        return new Spellbook(sdk, bot);
    };
    const names = (b: Spellbook) => b.buffs().map(s => s.spell.name);

    test("a self buff on a timer longer than it lasts is left to the kit: the Valewalker's haste, the Reaver's Surge", () => {
        const vale = names(book({ 'Valewalker Arboreal Path Base': 24, 'Arboreal Path': 16 }));
        expect(vale).toContain("Grove's Armor");
        expect(vale.some(n => /Kudzu/.test(n))).toBe(false);
        const reaver = names(book({ Soulrending: 22 }));
        expect(reaver.some(n => /^Surge of/.test(n))).toBe(false);
    });

    test("a Savage's buffs cost health and last 15 s: none is kept up", () => {
        expect(names(book({ Savagery: 16 }))).toEqual([]);
    });

    test("a long self buff stays: the Champion's strength and constitution", () => {
        expect(names(book({ Valor: 24 }))).toContain('Focus of the Champion');
    });
});
