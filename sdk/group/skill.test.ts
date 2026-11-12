// The skill setting (skill.ts): its resolution, the lens on its own, and a whole member on a FakeWorld with it off and on.
// Off must be the member as before: the same objects, the same orders, the same picture, the same interrupts.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { BotActions, getNavmeshStore, type NavmeshStore } from '../actions';
import { abortable } from '../execution-context';
import { setDefaultPathProvider, StraightLinePathProvider } from '../pathfinding';
import { FakeWorld } from '../test/fake-world';
import { makePlayer, makePlayerObj } from '../test/fixtures';
import type { NearbyPlayer } from '../types';
import { Blackboard } from './blackboard';
import { enemy, picture, report } from './fixtures';
import { MemberAgent, type Behavior, type MemberAgentOptions } from './member';
import { RVR_SETTINGS } from './rvr';
import { abSlot, checkSkillSetting, describeSkill, LATE_HEAL_BELOW, REACTION_GRACE_MS, resolveSkill, SKILL_PRESETS, SkillLens, type Skill } from './skill';
import type { GroupPicture, Orders, OrdersUpdate } from './types';

describe('resolveSkill', () => {
    test('off: nothing, off, false', () => {
        expect(resolveSkill(undefined, 'a')).toBeNull();
        expect(resolveSkill('off', 'a')).toBeNull();
        expect(resolveSkill(false, 'a')).toBeNull();
        expect(resolveSkill({ preset: 'off' }, 'a')).toBeNull();
        expect(resolveSkill({ realms: { midgard: 'sharp' } }, 'a', 'albion')).toBeNull();
    });

    test('a preset, numbers over average, numbers over a preset', () => {
        expect(resolveSkill('novice', 'a')).toEqual(SKILL_PRESETS.novice);
        expect(resolveSkill({ reactionMs: 300 }, 'a')).toEqual({ ...SKILL_PRESETS.average, reactionMs: 300 });
        expect(resolveSkill({ preset: 'sharp', mistakeRate: 0 }, 'a')).toEqual({ ...SKILL_PRESETS.sharp, mistakeRate: 0 });
    });

    test('a member beats its realm, which beats the group', () => {
        const s = { preset: 'novice', realms: { midgard: 'sharp' }, members: { Thorgrim: 'off', ulfgar: { reactionMs: 100 } } };
        expect(resolveSkill(s, 'thorgrim', 'midgard')).toBeNull();
        expect(resolveSkill(s, 'Ulfgar', 'midgard')).toEqual({ ...SKILL_PRESETS.average, reactionMs: 100 });
        expect(resolveSkill(s, 'other', 'midgard')).toEqual(SKILL_PRESETS.sharp);
        expect(resolveSkill(s, 'other', 'hibernia')).toEqual(SKILL_PRESETS.novice);
    });

    test('a bad value stops the run at its start', () => {
        expect(() => checkSkillSetting('pro')).toThrow(/novice, average, sharp or off/);
        expect(() => checkSkillSetting({ mistakeRate: 2 })).toThrow(/mistakeRate/);
        expect(() => checkSkillSetting({ members: { x: { reactionMs: -1 } } })).toThrow(/members\.x\.reactionMs/);
        expect(() => checkSkillSetting({ realms: { midgard: 'average' } })).not.toThrow();
    });

    test('a realm by the name of its group: camelot is Albion; an unknown realm stops the run', () => {
        expect(resolveSkill({ realms: { camelot: 'average' } }, 'merlin', 'albion')).toEqual(SKILL_PRESETS.average);
        expect(resolveSkill({ realms: { camelot: 'average' } }, 'sigrid', 'midgard')).toBeNull();
        expect(resolveSkill({ realms: { Albion: 'sharp' } }, 'merlin', 'albion')).toEqual(SKILL_PRESETS.sharp);
        expect(() => checkSkillSetting({ realms: { camelot: 'average' } })).not.toThrow();
        expect(() => checkSkillSetting({ realms: { avalon: 'average' } })).toThrow(/realms\.avalon/);
    });

    test('a typo in a key stops the run too', () => {
        expect(() => checkSkillSetting({ reactionms: 300 })).toThrow(/unknown reactionms/);
        expect(() => checkSkillSetting({ realms: { midgard: { switchMS: 1 } } })).toThrow(/realms\.midgard: unknown switchMS/);
    });

    test('an A/B: on in the odd slots of ab minutes, off in the even ones; ab alone turns nobody on', () => {
        const slot = 20 * 60_000;
        const s = { realms: { midgard: 'average' }, ab: 20 };
        expect(abSlot(s, 0)).toBe('off');
        expect(abSlot(s, slot)).toBe('on');
        expect(abSlot(s, 2 * slot - 1)).toBe('on');
        expect(abSlot(s, 2 * slot)).toBe('off');
        expect(abSlot({ realms: { midgard: 'average' } }, slot)).toBeNull();
        expect(resolveSkill(s, 'x', 'midgard', slot)).toEqual(SKILL_PRESETS.average);
        expect(resolveSkill(s, 'x', 'midgard', 0)).toBeNull();
        expect(resolveSkill(s, 'x', 'albion', slot)).toBeNull();
        expect(resolveSkill({ ab: 20 }, 'x', 'albion', slot)).toBeNull();
        expect(() => checkSkillSetting({ ab: 0 })).toThrow(/ab/);
        expect(() => checkSkillSetting(s)).not.toThrow();
    });

    test('describeSkill', () => {
        expect(describeSkill(SKILL_PRESETS.average)).toBe('reaction 350 ms, switch 750 ms, mistakes 4 %');
        expect(describeSkill(null)).toBe('off');
    });
});

/** The lens with dice that land at the middle (draws at base) and never slip, unless told. */
const lensOf = (skill: Partial<Skill> = {}, dice: number[] = []) => {
    const queue = [...dice];
    return new SkillLens({ reactionMs: 400, switchMs: 800, mistakeRate: 0, ...skill }, () => queue.length ? queue.shift()! : 0.5);
};
const A = 501, B = 502, C = 503;
const pic = (ids: number[], focus: number | null, extra: Partial<Orders> = {}): GroupPicture =>
    picture([report('Tank')], ids.map(id => enemy(id, 'midgard', { threat: true })), { phase: focus === null ? 'idle' : 'engage', focus, ...extra });
const look = (lens: SkillLens, p: GroupPicture, now: number) => lens.view(p, p.orders, now);

describe('SkillLens', () => {
    test('a new contact is acted on reactionMs after it first shows', () => {
        const lens = lensOf();
        expect(look(lens, pic([A], null), 0).picture.contacts).toEqual([]);
        expect(look(lens, pic([A], null), 399).picture.contacts).toEqual([]);
        expect(look(lens, pic([A], null), 400).picture.contacts.map(c => c.objectId)).toEqual([A]);
    });

    test('one back within the grace of its last sighting is still known; one gone longer is new again', () => {
        const lens = lensOf();
        look(lens, pic([A], null), 0);
        look(lens, pic([], null), 1000);
        expect(look(lens, pic([A], null), REACTION_GRACE_MS - 100).picture.contacts.length).toBe(1);
        look(lens, pic([], null), 5000);
        expect(look(lens, pic([A], null), REACTION_GRACE_MS - 100 + REACTION_GRACE_MS + 1).picture.contacts.length).toBe(0);
    });

    test('a first focus waits only for the reaction', () => {
        const lens = lensOf();
        expect(look(lens, pic([A], A), 0).orders.focus).toBeNull();
        expect(look(lens, pic([A], A), 400).orders.focus).toBe(A);
    });

    test('a switch keeps the old focus for switchMs, then takes the new one', () => {
        const lens = lensOf();
        look(lens, pic([A, B], A), 0);
        expect(look(lens, pic([A, B], A), 500).orders.focus).toBe(A);
        expect(look(lens, pic([A, B], B), 1000).orders.focus).toBe(A);
        expect(look(lens, pic([A, B], B), 1799).orders.focus).toBe(A);
        const now = look(lens, pic([A, B], B), 1800);
        expect(now.orders.focus).toBe(B);
        expect(now.picture.orders.focus).toBe(B);
    });

    test('the old focus dead: nothing until the switch is done', () => {
        const lens = lensOf();
        look(lens, pic([A, B], A), 0);
        look(lens, pic([A, B], A), 500);
        const deadA = (focus: number) => { const p = pic([A, B], focus); p.contacts[0] = { ...p.contacts[0]!, kind: 'npc', hp: 0 }; return p; };
        expect(look(lens, deadA(B), 1000).orders.focus).toBeNull();
        expect(look(lens, deadA(B), 1800).orders.focus).toBe(B);
    });

    test('no focus ordered: dropped at once, and the orders otherwise as given', () => {
        const lens = lensOf();
        look(lens, pic([A], A), 0);
        expect(look(lens, pic([A], A), 400).orders.focus).toBe(A);
        const p = pic([A], null, { phase: 'retreat' });
        const seen = look(lens, p, 450);
        expect(seen.orders).toBe(p.orders);
        expect(seen.picture).toBe(p);
    });

    test('nothing to hide: the same objects back', () => {
        const lens = lensOf();
        look(lens, pic([A], A), 0);
        const p = pic([A], A);
        const seen = look(lens, p, 500);
        expect(seen.picture).toBe(p);
        expect(seen.orders).toBe(p.orders);
    });

    test('a wrong target on a slipped switch, then the right one a switch later', () => {
        // Draws: A's, B's and C's reactions (0.5: 400), the switch (0.5: 800), the slip (0), the pick (0.99: the last other, C), the hold (0.5: 2600), the correction's switch (800).
        const lens = lensOf({ mistakeRate: 0.5 }, [0.5, 0.5, 0.5, 0.5, 0, 0.99, 0.5, 0.5]);
        look(lens, pic([A, B, C], A), 0);
        expect(look(lens, pic([A, B, C], A), 500).orders.focus).toBe(A);
        expect(look(lens, pic([A, B, C], B), 1300).orders.focus).toBe(A);
        expect(look(lens, pic([A, B, C], B), 2100).orders.focus).toBe(C);
        expect(lens.takeSlips().map(s => s.kind)).toEqual(['wrong target']);
        // Held for 2 * 800 + 1000 ms, then a switch's time to B, with no slip on the way back.
        expect(look(lens, pic([A, B, C], B), 2100 + 2599).orders.focus).toBe(C);
        expect(look(lens, pic([A, B, C], B), 2100 + 2600).orders.focus).toBe(C);
        expect(look(lens, pic([A, B, C], B), 2100 + 2600 + 799).orders.focus).toBe(C);
        expect(look(lens, pic([A, B, C], B), 2100 + 2600 + 800).orders.focus).toBe(B);
        expect(lens.takeSlips()).toEqual([]);
    });

    test('a late heal: a groupmate newly under the line holds the heals back, not the rest', () => {
        const lens = lensOf({ mistakeRate: 0.5 }, [0, 0.5]);
        lens.watchHealth([{ name: 'Tank', isDead: false, hp: 100 }], 0);
        lens.watchHealth([{ name: 'Tank', isDead: false, hp: LATE_HEAL_BELOW - 1 }], 100);
        expect(lens.holdBack('healer', 100)).toBe(true);
        expect(lens.holdBack('backupHeal', 1000)).toBe(true);
        expect(lens.holdBack('assist', 1000)).toBe(false);
        // switchMs + 1000 at the middle draw.
        expect(lens.holdBack('healer', 100 + 1800)).toBe(false);
        expect(lens.takeSlips().map(s => s.kind)).toEqual(['late heal']);
        // Still under the line: no new need, no new roll.
        lens.watchHealth([{ name: 'Tank', isDead: false, hp: 10 }], 3000);
        expect(lens.holdBack('healer', 3000)).toBe(false);
    });

    test('a style slip is rolled at most once a swing, however often the choice is asked for', () => {
        let rolls = 0;
        const lens = new SkillLens({ reactionMs: 0, switchMs: 0, mistakeRate: 0.5 }, () => { rolls++; return 0.9; });
        for (let t = 0; t < 3000; t += 250) lens.styleSlip(['Taunt'], ['Backstab'], t);
        expect(rolls).toBe(1);
        lens.styleSlip(['Taunt'], ['Backstab'], 3000);
        expect(rolls).toBe(2);
        // No positional to slip to: no roll.
        lens.styleSlip(['Taunt'], [], 9000);
        expect(rolls).toBe(2);
    });

    test('a style slip swaps the first of the queue for a positional', () => {
        expect(lensOf({ mistakeRate: 0.5 }, [0]).styleSlip(['Taunt', 'Slam'], ['Backstab'])).toEqual(['Backstab', 'Slam']);
        expect(lensOf({ mistakeRate: 0.5 }, [0.9]).styleSlip(['Taunt', 'Slam'], ['Backstab'])).toEqual(['Taunt', 'Slam']);
        expect(lensOf({ mistakeRate: 1 }).styleSlip('Taunt', [])).toBe('Taunt');
        expect(lensOf({ mistakeRate: 1 }).styleSlip(null, ['Backstab'])).toBeNull();
    });
});

// ---------------------------------------------------------------------------------------------------- a whole member

let navmeshAt: Mock<NavmeshStore['at']>;
beforeAll(() => {
    setDefaultPathProvider(new StraightLinePathProvider());
    navmeshAt = spyOn(getNavmeshStore(), 'at').mockReturnValue(null);
});
afterAll(() => {
    setDefaultPathProvider(null);
    navmeshAt.mockRestore();
});

const ME = { x: 560_000, y: 511_000, z: 2500 };
const foe = (objectId: number, dx: number, o: Partial<NearbyPlayer> = {}) => makePlayerObj({ objectId, name: 'Celt', level: 20, realm: 'hibernia', x: ME.x + dx, y: ME.y, z: ME.z, ...o });

let running: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const end of running) await end();
    running = [];
});

type Seen = { focus: number | null; contacts: number[] };
/** A member whose one behaviour writes down what it acts on, and sits until interrupted. */
function member(settings: object = {}, agent: MemberAgentOptions = {}) {
    const w = new FakeWorld({
        pet: null, nearbyObjects: [], nearbyNpcs: [], effects: [], combatEvents: [],
        nearbyPlayers: [foe(A, 900), foe(B, 1000)],
        player: makePlayer({ level: 20, realm: 'albion', mana: 500, maxMana: 500, manaPercent: 100, healthPercent: 100, health: 100, maxHealth: 100, x: ME.x, y: ME.y, z: ME.z }),
        skills: { specializations: [], abilities: [], styles: [], spells: [] },
    });
    const stamp = w.onTick;
    w.onTick = world => { world.state.timestamp = Date.now(); stamp?.(world); };
    const bot = new BotActions(w.sdk);
    const board = new Blackboard();
    const log: Seen[] = [];
    let interrupts = 0;
    const watch: Behavior = {
        name: 'watch',
        async run(ctx) {
            const o = ctx.orders();
            const s = { focus: o.focus, contacts: ctx.picture().contacts.map(c => c.objectId).sort() };
            const last = log.at(-1);
            if (!last || last.focus !== s.focus || last.contacts.join() !== s.contacts.join()) log.push(s);
            ctx.doing('watch', o.focus);
            try { await abortable(Bun.sleep(10_000)); } catch (e) { interrupts++; throw e; }
            return true;
        },
    };
    const a = new MemberAgent({ bot: 'testbot', role: 'nuker', sdk: w.sdk, actions: bot }, board, [watch], { ...RVR_SETTINGS, ...settings }, { minTurnMs: 10, idleMs: 10, sightRadius: 40_000, ...agent });
    const order = (u: Omit<OrdersUpdate, 'reason'>) => { board.setOrders({ reason: 'test', ...u }); };
    const stop = new AbortController();
    const run = a.run(stop.signal).catch(() => {});
    running.push(async () => { stop.abort(new Error('test over')); await run; a.dispose(); w.dispose(); });
    return { w, bot, board, agent: a, order, log, interrupts: () => interrupts };
}

/** Run the same orders on a member: A at once, B after 300 ms, none after 600 ms. */
async function script(m: ReturnType<typeof member>): Promise<Seen[]> {
    await Bun.sleep(50);
    m.order({ phase: 'engage', focus: A });
    await Bun.sleep(300);
    m.order({ phase: 'engage', focus: B });
    await Bun.sleep(300);
    m.order({ phase: 'idle', focus: null });
    await Bun.sleep(100);
    return m.log;
}

describe('a member with the skill off', () => {
    test('reads the board and its own objects directly', async () => {
        for (const settings of [{}, { skill: 'off' }, { skill: { realms: { midgard: 'novice' } } }, { skill: { members: { other: 'sharp' } } }]) {
            const m = member(settings);
            expect(m.agent.skilled).toBe(false);
            expect(m.agent.ctx.bot).toBe(m.bot);
            expect(m.agent.ctx.sdk).toBe(m.w.sdk);
            m.order({ phase: 'engage', focus: A });
            await Bun.sleep(30);
            expect(m.agent.ctx.orders()).toEqual(m.board.getOrders());
            const q = m.agent.ctx.picture(), p = m.board.picture();
            expect(q.contacts.map(c => c.objectId)).toEqual(p.contacts.map(c => c.objectId));
            expect(q.orders).toEqual(p.orders);
            expect(q.contacts.length).toBe(2);
        }
    });

    test('equivalence: the same focus, picture and interrupts as with no skill at all, and as a skill of zeros', async () => {
        const none = member();
        const off = member({ skill: 'off' });
        const zero = member({ skill: { reactionMs: 0, switchMs: 0, mistakeRate: 0 } });
        const [a, b, c] = await Promise.all([script(none), script(off), script(zero)]);
        expect(a.map(s => s.focus)).toEqual([null, A, B, null]);
        expect(b).toEqual(a);
        expect(c).toEqual(a);
        expect(off.interrupts()).toBe(none.interrupts());
        expect(zero.interrupts()).toBe(none.interrupts());
        expect(zero.agent.skilled).toBe(true);
        expect(zero.board.events().filter(e => e.text.startsWith('skill: ')).map(e => e.text)).toEqual(['skill: reaction 0 ms, switch 0 ms, mistakes 0 %']);
        expect(none.board.events().filter(e => e.text.startsWith('skill'))).toEqual([]);
    });
});

describe('a member with a skill', () => {
    test('the realm entry turns it on for its realm only', () => {
        expect(member({ skill: { realms: { albion: 'average' } } }).agent.skilled).toBe(true);
        expect(member({ skill: { realms: { hibernia: 'average' } } }).agent.skilled).toBe(false);
        expect(member({}, { skill: 'sharp' }).agent.skilled).toBe(true);
        expect(member({ skill: 'off' }, { skill: 'sharp' }).agent.skilled).toBe(false);
    });

    test('reacts late and switches late, and the clock interrupts the turn for the switch', async () => {
        const m = member({ skill: { reactionMs: 150, switchMs: 250, mistakeRate: 0 } }, { skillRandom: () => 0.5 });
        await Bun.sleep(200);
        const t0 = Date.now();
        m.order({ phase: 'engage', focus: A });
        await Bun.sleep(80);
        // The contacts showed at the agent's start: reacted to by now, so the focus is taken up at once.
        expect(m.log.at(-1)!.focus).toBe(A);
        m.order({ phase: 'engage', focus: B });
        const switchAt = Date.now();
        await Bun.sleep(150);
        expect(m.log.at(-1)!.focus).toBe(A);
        await Bun.sleep(250);
        expect(m.log.at(-1)!.focus).toBe(B);
        expect(m.interrupts()).toBeGreaterThanOrEqual(1);
        expect(Date.now() - switchAt).toBeGreaterThanOrEqual(250);
        expect(t0).toBeGreaterThan(0);
    });

    test('a contact new in the fight shows only after the reaction', async () => {
        const m = member({ skill: { reactionMs: 300, switchMs: 0, mistakeRate: 0 } }, { skillRandom: () => 0.5 });
        await Bun.sleep(400);
        m.w.state.nearbyPlayers.push(foe(C, 800));
        m.order({ phase: 'engage', focus: A });
        await Bun.sleep(150);
        expect(m.agent.ctx.picture().contacts.map(c => c.objectId).sort()).toEqual([A, B]);
        await Bun.sleep(300);
        expect(m.agent.ctx.picture().contacts.map(c => c.objectId).sort()).toEqual([A, B, C]);
    });
});
