import { describe, expect, test } from 'bun:test';
import { getSpell, getSpellLines } from '../../data/index';
import { enchanter } from '../classes/enchanter';
import type { Spell } from '../types';
import { debuffPays, matchingDebuff, resistDebuff } from './debuff';
import { contact } from './fixtures';
import { defaultBehaviors, withCharacter } from './index';
import { pickNuke, toPick, type SpellPick } from './spells';

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

// An Enchanter with the Light baseline at its level and Empowering, the Mana line's specialist half, at its spec.
const ench = (level: number, mana: number) => known({ 'Way of the Sun': level, Empowering: mana });
const nukeOf = (picks: SpellPick[]) => pickNuke(picks, { targetHp: 0 })!;
const name = (s: SpellPick | null) => s?.spell.name ?? null;

describe('matchingDebuff (Enchanter, real spell rows)', () => {
    test('Mana 24 has Cold and Matter, and neither lowers what Sun Streak is checked against', () => {
        const picks = ench(24, 24);
        expect(name(nukeOf(picks))).toBe('Sun Streak');
        expect(picks.map(s => s.spell.name)).toContain('Amplify Cold');
        expect(matchingDebuff(picks, nukeOf(picks))).toBeNull();
    });

    test('Mana 27 finds Amplify Heat, and higher ranks win', () => {
        expect(name(matchingDebuff(ench(27, 27), nukeOf(ench(27, 27))))).toBe('Amplify Heat');
        expect(name(matchingDebuff(ench(36, 36), nukeOf(ench(36, 36))))).toBe('Endow Heat');
        expect(name(matchingDebuff(ench(50, 49), nukeOf(ench(50, 49))))).toBe('Empower Heat');
    });
});

describe('debuffPays', () => {
    const at = (level: number, mana: number) => { const p = ench(level, mana); const n = nukeOf(p); return [matchingDebuff(p, n)!, n] as const; };

    test('Amplify Heat alone does not pay for its cast', () => {
        const [d, n] = at(27, 27);
        expect(d.duration).toBe(8);
        expect(debuffPays(d, n, { player: false })).toBe(false);
        expect(debuffPays(d, n, { player: true })).toBe(false);
    });

    test('Endow Heat alone does not either: -12 % measured', () => {
        const [d, n] = at(36, 36);
        expect(debuffPays(d, n, { player: false })).toBe(false);
    });

    test('Empower Heat pays on a monster and, halved, not on a player', () => {
        const [d, n] = at(50, 49);
        expect(debuffPays(d, n, { player: false })).toBe(true);
        expect(debuffPays(d, n, { player: true })).toBe(false);
    });

    test('a second heat caster makes the bigger ranks pay; Amplify Heat is about even on a monster, and short on a player', () => {
        expect(debuffPays(...at(27, 27), { player: true, allies: 1.7 })).toBe(false);
        expect(debuffPays(...at(36, 36), { player: false, allies: 1.7 })).toBe(true);
        expect(debuffPays(...at(50, 49), { player: true, allies: 1.7 })).toBe(true);
    });
});

describe('resistDebuff', () => {
    const FOCUS = 7;
    function scene(o: { picks?: SpellPick[]; mob?: Parameters<typeof contact>[1]; mana?: number; castSpell?: () => object } = {}) {
        const picks = o.picks ?? ench(50, 49);
        const mob = contact(FOCUS, { hp: 100, ...o.mob });
        const casts: string[] = [];
        const memory = new Map<string, any>();
        const messages: { id: number; text: string }[] = [];
        const seen = { kind: 'npc', objectId: FOCUS, healthPercent: mob.hp };
        const ctx = {
            memory, settings: { holdMs: 0, assistAfterMs: 0 },
            orders: () => ({ phase: 'engage', focus: FOCUS }),
            focus: () => mob, picture: () => ({ contacts: [mob] }), tank: () => undefined,
            sdk: { getNearbyNpc: () => seen, getNearbyPlayers: () => [], sendAttack: async () => ({}), getGameMessages: () => messages },
            me: () => ({ mana: o.mana ?? 500, attacking: false }),
            spells: { all: () => picks, nuke: (n: { targetHp: number }) => pickNuke(picks, n) },
            bot: { castSpell: async (s: Spell) => { casts.push(s.name); return { success: true, resisted: false, ...o.castSpell?.() }; } },
            doing: () => {}, result: () => {},
        };
        return { run: () => resistDebuff().run(ctx as never), casts, memory, messages, mob };
    }

    test('debuffs first, then leaves the turn to the nukes while it lasts', async () => {
        const s = scene();
        expect(await s.run()).toBe(true);
        expect(s.casts).toEqual(['Empower Heat']);
        expect(await s.run()).toBe(false);
        expect(s.casts).toHaveLength(1);
    });

    test('again when the next nuke would land after it ran out', async () => {
        const s = scene();
        await s.run();
        const key = [...s.memory.keys()][0]!;
        s.memory.set(key, { ...s.memory.get(key), until: Date.now() + 1000 });
        expect(await s.run()).toBe(true);
        expect(s.casts).toHaveLength(2);
    });

    test('again when the server says it faded early, and not for another target', async () => {
        const s = scene();
        await s.run();
        s.messages.push({ id: 1, text: "The goblin's heat vulnerability fades." });
        expect(await s.run()).toBe(false);
        s.messages.push({ id: 2, text: `The ${s.mob.name}'s heat vulnerability fades.` });
        expect(await s.run()).toBe(true);
    });

    test('a resisted one is not on: a nuke goes first, then it tries again', async () => {
        const s = scene({ castSpell: () => ({ resisted: true }) });
        await s.run();
        expect(await s.run()).toBe(false);
        s.memory.set([...s.memory.keys()][0]!, { until: 0, since: 0 });
        expect(await s.run()).toBe(true);
    });

    test('a target nearly dead gets the nuke at once', async () => {
        const s = scene({ mob: { hp: 30 } });
        expect(await s.run()).toBe(false);
        expect(s.casts).toEqual([]);
    });

    test('a crowd-controlled focus, or too little power for it and a nuke, leaves it alone', async () => {
        expect(await scene({ mob: { cc: { kind: 'mezz', by: 'x', until: Date.now() + 5000 } as never } }).run()).toBe(false);
        expect(await scene({ mana: 40 }).run()).toBe(false);
    });

    test('nothing to do at Mana 24, and where it does not pay', async () => {
        expect(await scene({ picks: ench(24, 24) }).run()).toBe(false);
        expect(await scene({ picks: ench(27, 27) }).run()).toBe(false);
    });

    test('a target that left the picture is forgotten', async () => {
        const s = scene();
        s.memory.set('debuff:99:1', { until: Date.now() + 60_000, since: 0 });
        await s.run();
        expect(s.memory.has('debuff:99:1')).toBe(false);
    });
});

describe('enchanter kit', () => {
    test('the debuff sits right above assist in a nuker\'s list', () => {
        const list = withCharacter(defaultBehaviors().nuker, enchanter({ heatAllies: 1 })).map(b => b.name);
        expect(list.indexOf('resistDebuff')).toBe(list.indexOf('assist') - 1);
        expect(list.indexOf('position')).toBeLessThan(list.indexOf('resistDebuff'));
    });
});
