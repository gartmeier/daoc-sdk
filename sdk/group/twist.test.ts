import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { rvrBehaviors } from './rvr';
import { paladin } from '../classes/paladin';
import { withCharacter } from './character';
import type { Behavior, MemberContext } from './member';
import { nextTwist, type SongKind, type TwistSong } from './songs';
import { twisting, twistTurn } from './twist';

const start = new Date('2026-11-04T12:00:00Z').getTime();
const pick = (name: string, kind: SongKind, skillIndex: number, frequency = 60, castTime = 0, cooldownRemaining = 0) =>
    ({ kind, castTime, frequency, spell: { name, skillIndex, lineIndex: -1, spellIndex: -1, cooldownRemaining } });
const armor = pick('Defense', 'armor', 1), fury = pick('Fury', 'damage', 2), heal = pick('Refreshment', 'combatHeal', 3), persist = pick('Persistence', 'endurance', 4, 50);
const twist = { order: ['armor', 'damage', 'combatHeal'] as SongKind[], everyMs: 2000 };

describe('nextTwist', () => {
    const sent = (o: Record<string, number> = {}) => new Map(Object.entries(o));
    const name = (s: TwistSong | null) => s?.spell.name ?? null;

    test('first through the order', () => {
        expect(name(nextTwist([armor, fury, heal], null, sent(), start, twist.order))).toBe('Defense');
    });

    test('never the running one: sending it again stops it', () => {
        expect(name(nextTwist([armor], 'Defense', sent(), start, twist.order))).toBeNull();
        expect(name(nextTwist([armor, fury], 'Defense', sent({ Defense: start }), start + 2000, twist.order))).toBe('Fury');
    });

    test('of those due, the longest unsent', () => {
        const at = start + 10_000;
        expect(name(nextTwist([armor, fury, heal], 'Refreshment', sent({ Defense: at - 7000, Fury: at - 9000, Refreshment: at - 5000 }), at, twist.order))).toBe('Fury');
    });

    test('one whose effect is still fresh, or whose recast runs, waits', () => {
        const at = start + 10_000;
        expect(name(nextTwist([armor, fury], 'Fury', sent({ Defense: at - 3000 }), at, twist.order))).toBeNull();
        expect(name(nextTwist([{ ...armor, spell: { ...armor.spell, cooldownRemaining: 1000 } }], null, sent(), at, twist.order))).toBeNull();
    });

    test('one with a cast time never goes in: it would stop the swing', () => {
        expect(name(nextTwist([pick('Rhythm', 'armor', 9, 50, 3)], null, sent(), start, twist.order))).toBeNull();
    });

    test('low on endurance, the endurance chant goes first, though it is not in the order', () => {
        const at = start + 20_000;
        const have = [armor, fury, persist];
        expect(name(nextTwist(have, null, sent(), at, twist.order))).toBe('Defense');
        expect(name(nextTwist(have, null, sent(), at, twist.order, true))).toBe('Persistence');
        expect(name(nextTwist(have, 'Persistence', sent({ Persistence: at }), at + 2000, twist.order, true))).toBe('Defense');
    });
});

describe('twisting', () => {
    afterEach(() => { setSystemTime(); });

    function setup(phase = 'engage', attacking = true, endurancePercent = 100) {
        const used: number[] = [];
        const state = { phase, attacking, endurancePercent, dead: false };
        const ctx = {
            memory: new Map<string, unknown>(),
            spells: { songs: () => [armor, fury, heal, persist] },
            bot: { isDead: () => state.dead },
            sdk: { sendUseSkill: async (i: number) => { used.push(i); return { success: true }; }, sendCastSpell: async () => ({ success: true }) },
            orders: () => ({ phase: state.phase }),
            me: () => ({ attacking: state.attacking, endurancePercent: state.endurancePercent }),
            settings: {},
        } as unknown as MemberContext<any>;
        const at = (ms: number) => { setSystemTime(new Date(start + ms)); twistTurn(ctx, twist); };
        return { used, state, ctx, at };
    }

    test('three chants in turn, everyMs apart, then each as its recast allows, leaving out endurance', () => {
        const s = setup();
        for (let t = 0; t <= 12_000; t += 250) s.at(t);
        expect(s.used.slice(0, 3)).toEqual([1, 2, 3]);
        expect(s.used).not.toContain(4);
        expect(new Set(s.used.slice(0, 6)).size).toBe(3);
        // Never the same one twice in a row: that would stop it.
        for (let i = 1; i < s.used.length; i++) expect(s.used[i]).not.toBe(s.used[i - 1]);
    });

    test('nothing unless engaged, swinging and alive', () => {
        for (const change of [{ phase: 'travel' }, { attacking: false }, { dead: true }]) {
            const s = setup();
            Object.assign(s.state, change);
            s.at(0);
            expect(s.used).toEqual([]);
        }
    });

    test('low on endurance he sends Chant of Persistence', () => {
        const s = setup('engage', true, 20);
        s.at(0);
        expect(s.used).toEqual([4]);
    });

    test('what song() cast counts as running: it is not sent again', () => {
        const s = setup();
        s.ctx.memory.set('songCast', { name: 'Defense', at: start - 10_000 });
        s.at(0);
        expect(s.used).toEqual([2]);
    });

    test('its clock ends with the fight, and it returns what the fight returned', async () => {
        const used: number[] = [];
        const s = setup();
        (s.ctx.sdk as unknown as { sendUseSkill: (i: number) => Promise<unknown> }).sendUseSkill = async i => { used.push(i); return {}; };
        const fight: Behavior<any> = { name: 'tank', run: async () => { await Bun.sleep(600); return true; } };
        const b = twisting(fight, twist);
        expect(b.name).toBe('tank');
        expect(await b.run(s.ctx)).toBe(true);
        expect(used.length).toBeGreaterThan(0);
        const after = used.length;
        await Bun.sleep(600);
        expect(used.length).toBe(after);
    });

    test('a throwing fight still ends the clock', async () => {
        const used: number[] = [];
        const s = setup();
        (s.ctx.sdk as unknown as { sendUseSkill: (i: number) => Promise<unknown> }).sendUseSkill = async i => { used.push(i); return {}; };
        const b = twisting({ name: 'tank', run: async () => { throw new Error('no'); } }, twist);
        await expect(b.run(s.ctx)).rejects.toThrow('no');
        await Bun.sleep(400);
        expect(used).toEqual([]);
    });
});

describe('the Paladin kit', () => {
    const tank = () => rvrBehaviors().tank;

    test('no twist unless asked: the role keeps its own fight', () => {
        const list = tank();
        const fight = list.find(b => b.name === 'tank');
        expect(withCharacter(list, paladin()).find(b => b.name === 'tank')).toBe(fight!);
    });

    test('with a twist, its fight stands in the role list where the tank was', () => {
        const list = tank();
        const kit = paladin({ twist });
        const out = withCharacter(list, kit);
        expect(out.filter(b => b.name === 'tank').length).toBe(1);
        expect(out.find(b => b.name === 'tank')).toBe(kit.fight![0]!);
        expect(out.findIndex(b => b.name === 'tank')).toBe(list.findIndex(b => b.name === 'tank') + 1);
    });
});
