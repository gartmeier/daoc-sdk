import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { song } from './behaviors';
import { report } from './fixtures';
import type { MemberContext } from './member';
import { rvrBehaviors } from './rvr';
import { chooseSong, instrumentToBringOut, SONG_SETTINGS, songKind, type SongKind } from './songs';
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

    test('a Skald, with no endurance song, plays added damage in a fight and nothing else for it', () => {
        expect(songKind({ type: 'DamageAdd', target: 'Group', pulse: true })).toBe('damage');
        const skald: SongKind[] = ['health', 'speed', 'damage'];
        expect(chooseSong(skald, 'engage', group())).toBe('damage');
        expect(chooseSong(skald, 'pull', group())).toBe('damage');
        expect(chooseSong(skald, 'travel', group())).toBe('speed');
        expect(chooseSong([...skald, 'endurance'], 'engage', group())).toBe('endurance');
    });

    test('speed while travelling, endurance while pulling and fighting', () => {
        expect(chooseSong(OISIN, 'travel', group())).toBe('speed');
        expect(chooseSong(OISIN, 'pull', group())).toBe('endurance');
        expect(chooseSong(OISIN, 'engage', group({ Niamh: { mana: 5 } }))).toBe('endurance');
    });

    test('in a fight: power while a caster spends it, endurance first only when the singer or a fighter runs low', () => {
        expect(chooseSong(WITH_POWER, 'engage', group({ Niamh: { mana: 60 } }))).toBe('power');
        expect(chooseSong(WITH_POWER, 'engage', group())).toBe('endurance');
        expect(chooseSong(WITH_POWER, 'engage', group({ Niamh: { mana: 60 } }), SONG_SETTINGS, 20)).toBe('endurance');
        expect(chooseSong(WITH_POWER, 'pull', group({ Niamh: { mana: 60 }, Cuchulainn: { endurance: 10 } }))).toBe('endurance');
        // An observed member (a human: no capabilities) counts by its role.
        const human = (role: Role) => [...group(), report('Vue', { role, mana: 50, observed: true, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } })];
        expect(chooseSong(WITH_POWER, 'engage', human('nuker'))).toBe('power');
        expect(chooseSong(WITH_POWER, 'recover', human('nuker'))).toBe('power');
        expect(chooseSong(WITH_POWER, 'engage', human('melee'))).toBe('endurance');
    });

    test('between fights: power for low casters, else health for the hurt, else endurance', () => {
        expect(chooseSong(WITH_POWER, 'recover', group({ Niamh: { mana: 40 }, Cuchulainn: { hp: 50 } }))).toBe('power');
        expect(chooseSong(WITH_POWER, 'recover', group({ Cuchulainn: { hp: 50 } }))).toBe('health');
        expect(chooseSong(WITH_POWER, 'idle', group(), SONG_SETTINGS, 50)).toBe('endurance');
        // The tank's 0 power doesn't count; a dead caster's doesn't either.
        expect(chooseSong(WITH_POWER, 'idle', group({ Ciaran: { mana: 0, isDead: true } }), SONG_SETTINGS, 50)).toBe('endurance');
        // No power song yet (Oisin at 9): low casters fall through to health or endurance.
        expect(chooseSong(OISIN, 'recover', group({ Niamh: { mana: 20 } }), SONG_SETTINGS, 50)).toBe('endurance');
    });

    test('a Paladin: armor in a fight, endurance when he runs low, his heal chant in a fight only', () => {
        expect(songKind({ type: 'SpecArmorFactorBuff', target: 'Group', pulse: true })).toBe('armor');
        expect(songKind({ type: 'SpecArmorFactorBuff', target: 'Realm', pulse: false })).toBeNull();   // a Cleric's concentration buff
        expect(songKind({ type: 'CombatHeal', target: 'Group', pulse: true })).toBe('combatHeal');
        const galahad: SongKind[] = ['endurance', 'damage', 'armor', 'combatHeal'];
        expect(chooseSong(galahad, 'engage', group())).toBe('armor');
        expect(chooseSong(galahad, 'engage', group(), SONG_SETTINGS, 29)).toBe('endurance');
        expect(chooseSong(galahad, 'engage', group(), SONG_SETTINGS, 30)).toBe('armor');
        // Out of a fight the heal chant heals nobody and armor is the buffs' slot.
        expect(chooseSong(galahad, 'recover', group({ Niamh: { hp: 20 } }), SONG_SETTINGS, 50)).toBe('endurance');
        expect(chooseSong(galahad, 'travel', group(), SONG_SETTINGS, 50)).toBe('endurance');
        // At 90 % endurance or more, out of a fight: no chant at all, it only costs power (arena round 26: 69 waits for his power).
        expect(chooseSong(galahad, 'recover', group({ Niamh: { hp: 20 } }))).toBeNull();
        expect(chooseSong(galahad, 'travel', group())).toBeNull();
        expect(chooseSong(galahad, 'retreat', group())).toBe('endurance');
        expect(chooseSong(OISIN, 'idle', group())).toBeNull();
        // Below Chants 4 he has only these: the heal chant still beats nothing, and goes before added damage.
        expect(chooseSong(['combatHeal', 'damage'], 'engage', group())).toBe('combatHeal');
    });

    test('whoever has no armor chant sings in a fight as before, however low its endurance', () => {
        expect(chooseSong(OISIN, 'engage', group(), SONG_SETTINGS, 5)).toBe('endurance');
        expect(chooseSong(OISIN, 'engage', group(), SONG_SETTINGS, 100)).toBe('endurance');
        expect(chooseSong(['health', 'speed', 'damage'], 'engage', group(), SONG_SETTINGS, 5)).toBe('damage');
    });

    test('nothing to play without songs', () => {
        expect(chooseSong([], 'travel', group())).toBeNull();
    });
});

describe('song(): a running pulse is never sent again', () => {
    afterEach(() => { setSystemTime(); });
    const start = new Date('2026-11-02T12:00:00Z').getTime();
    const pick = (name: string, kind: SongKind, castTime = 0) => ({ kind, castTime, frequency: 50, spell: { name, lineIndex: 2, spellIndex: 7, cooldownRemaining: 0 } });
    const charge = pick('Chant of the Charge', 'damage');

    function setup(songs: ReturnType<typeof pick>[], phase = 'engage', attacking = true) {
        const sent: string[] = [];
        const cast: string[] = [];
        const state = { effects: [] as { name: string }[] };
        const orders = { phase };
        const me = { attacking, endurancePercent: 100 };
        const ctx = {
            memory: new Map<string, unknown>(),
            spells: { songs: () => songs },
            bot: { isDead: () => false, castSpell: async (s: { name: string }) => { cast.push(s.name); return { success: true }; } },
            sdk: { getState: () => state, sendCastSpell: async (line: number, index: number) => { sent.push(`${line}:${index}`); return { success: true }; }, sendUseSkill: async () => ({ success: true }) },
            orders: () => orders,
            members: () => group(),
            settings: {},
            me: () => me,
            doing: () => {},
            result: () => {},
        } as unknown as MemberContext<any>;
        const b = song();
        return { sent, cast, state, orders, me, ctx, run: (at: number) => { setSystemTime(new Date(start + at)); return b.run(ctx); } };
    }

    test('nothing goes out until one pulse has had time to show: a run can begin in the gap between two', async () => {
        const s = setup([charge]);
        expect(await s.run(0)).toBe(false);
        expect(await s.run(5900)).toBe(false);
        expect(s.sent).toEqual([]);
        await s.run(6000);
        expect(s.sent).toEqual(['2:7']);
    });

    test('nothing wanted and our own chant still pulsing out of a fight: one cast stops it, once; in a fight it runs on', async () => {
        const persistence = pick('Chant of Persistence', 'endurance');
        const s = setup([persistence], 'engage', false);
        (s.me as any).endurancePercent = 20;
        await s.run(0);
        await s.run(6000);
        expect(s.cast).toEqual(['Chant of Persistence']);
        s.state.effects = [{ name: 'Chant of Persistence' }];
        (s.me as any).endurancePercent = 100;
        s.orders.phase = 'engage';
        await s.run(20_000);
        expect(s.cast).toEqual(['Chant of Persistence']);
        s.orders.phase = 'recover';
        expect(await s.run(30_000)).toBe(true);
        expect(s.cast).toEqual(['Chant of Persistence', 'Chant of Persistence']);
        expect(await s.run(31_000)).toBe(false);
        expect(s.cast).toHaveLength(2);
    });

    test('songs.ccFirst: no song change in a fight while our mezz is still to cast; then it goes', async () => {
        const s = setup([charge], 'engage', false);
        const c = s.ctx as any;
        c.name = 'Oisin';
        c.settings = { songs: { ...SONG_SETTINGS, ccFirst: true } };
        (s.orders as any).cc = [{ targetId: 501, by: 'Oisin' }];
        await s.run(0);
        expect(await s.run(6000)).toBe(false);
        expect(s.cast).toEqual([]);
        (s.orders as any).cc = [{ targetId: 501, by: 'Brigid' }];
        await s.run(6100);
        expect(s.cast).toEqual(['Chant of the Charge']);
    });

    test('one already playing at the start is left alone, through a gap between pulses', async () => {
        const s = setup([charge]);
        s.state.effects = [{ name: 'Chant of the Charge' }];
        await s.run(0);
        s.state.effects = [];
        await s.run(5900);
        expect(s.sent).toEqual([]);
    });

    test('swinging, an instant one goes out raw and the turn goes on to the swing', async () => {
        const s = setup([charge]);
        await s.run(0);
        expect(await s.run(6000)).toBe(false);
        expect(s.sent).toEqual(['2:7']);
        expect(s.cast).toEqual([]);
    });

    test('sent once, it isn\'t sent again while the effect has yet to show', async () => {
        const s = setup([charge]);
        await s.run(0);
        await s.run(6000);
        await s.run(15_900);
        expect(s.sent).toEqual(['2:7']);
    });

    test('not swinging, it goes through castSpell', async () => {
        const s = setup([charge], 'engage', false);
        await s.run(0);
        expect(await s.run(6000)).toBe(true);
        expect(s.cast).toEqual(['Chant of the Charge']);
    });

    test('swinging, one with a cast time waits', async () => {
        const s = setup([pick('Rhythm', 'endurance', 3)]);
        await s.run(0);
        expect(await s.run(6000)).toBe(false);
        expect(s.sent).toEqual([]);
        expect(s.cast).toEqual([]);
    });

    test('the RvR tank list sings before it fights, and a second song() from a kit sends nothing twice', async () => {
        const list = rvrBehaviors().tank.map(b => b.name);
        expect(list.indexOf('song')).toBeGreaterThanOrEqual(0);
        expect(list.indexOf('song')).toBeLessThan(list.indexOf('tank'));
        const s = setup([charge]);
        const kit = song();
        await s.run(0);
        await s.run(6000);
        await kit.run(s.ctx);
        expect(s.sent).toEqual(['2:7']);
    });

    test('in a fight he changes chant when his endurance runs low: an instant one, raw, so the swing goes on', async () => {
        const armor = pick("Crusader's Defense", 'armor');
        const endurance = pick('Chant of Persistence', 'endurance');
        const s = setup([{ ...armor, spell: { ...armor.spell, spellIndex: 1 } }, { ...endurance, spell: { ...endurance.spell, spellIndex: 2 } }]);
        await s.run(0);
        expect(await s.run(6000)).toBe(false);
        expect(s.sent).toEqual(['2:1']);
        s.state.effects = [{ name: "Crusader's Defense" }];
        s.me.endurancePercent = 20;
        expect(await s.run(12_000)).toBe(false);
        expect(s.sent).toEqual(['2:1', '2:2']);
        expect(s.cast).toEqual([]);
    });

    test('a song held while another is wanted is still known to play when it\'s wanted again', async () => {
        const speed = pick('Song of Travel', 'speed');
        const health = pick('Song of Rest', 'health');
        const s = setup([speed, health], 'travel', false);
        s.state.effects = [{ name: 'Song of Travel' }];
        await s.run(0);
        // Between fights someone is hurt, so health is wanted while speed keeps playing.
        s.orders.phase = 'recover';
        await s.run(5000);
        // Back to travelling, in a gap between two pulses: it must not be sent, which would stop it.
        s.orders.phase = 'travel';
        s.state.effects = [];
        await s.run(5900);
        expect(s.cast).toEqual([]);
    });
});

describe('instrumentToBringOut', () => {
    const flute = { slot: 58, name: 'Arcane Flute', objectType: 45, level: 29 };
    const club = { slot: 10, name: 'Club', objectType: 20, level: 24 };
    test('one worn in a hand slot first, else the backpack one, else none', () => {
        expect(instrumentToBringOut([club, { ...flute, slot: 12, name: 'Lute' }], [flute])).toEqual({ item: { ...flute, slot: 12, name: 'Lute' }, worn: true });
        expect(instrumentToBringOut([club], [flute, { ...flute, slot: 60, name: 'Drum', level: 10 }])).toEqual({ item: flute, worn: false });
        expect(instrumentToBringOut([club], [{ ...flute, slot: 81 }])).toBeNull();
        expect(instrumentToBringOut([club], [])).toBeNull();
    });
});
