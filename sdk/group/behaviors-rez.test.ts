// Corpses waiting for a rez and the members who bring them back, on a stub MemberContext.
// Region 9999 has no spawns, so safeSpot and safePath see no danger.
import { describe, expect, test } from 'bun:test';
import { awaitingRez, healer, release, rez, rezzerNear, REZ_SETTINGS, type TacticsSettings } from './behaviors';
import { Blackboard } from './blackboard';
import { contact, enemy, picture, report } from './fixtures';
import { MemberAgent, type MemberContext } from './member';
import { PVE_SETTINGS } from './pve';
import { RVR_SETTINGS } from './rvr';
import type { MemberReport, Orders, Point } from './types';

const R = 9999;
const rezCaps = { heal: true, cc: false, nuke: false, rez: true, buffs: [], buffSpells: [] };
const cleric = (over: Partial<MemberReport> = {}) => report('Cleric', { role: 'healer', regionId: R, x: 0, y: 0, level: 20, objectId: 2, capabilities: rezCaps, ...over });
const body = (name: string, over: Partial<MemberReport> = {}) => report(name, { regionId: R, x: 500, y: 0, level: 20, objectId: name.length * 10, isDead: true, ...over });

interface StubOptions {
    name?: string;
    at?: Point;
    dead?: boolean;
    diedAgoMs?: number;
    offer?: boolean;
    members?: MemberReport[];
    orders?: Partial<Orders>;
    settings?: TacticsSettings;
    threats?: boolean;
    mana?: number;
    /** Corpses our client doesn't see. */
    outOfView?: number[];
    effects?: string[];
    resurrect?: Record<string, unknown>;
    rest?: Record<string, unknown>;
    spell?: boolean;
    /** Enemy players on the board, not fighting us yet. */
    foes?: Point[];
}

function stub(o: StubOptions = {}) {
    const at = o.at ?? { x: 0, y: 0 };
    const name = o.name ?? 'Self';
    const calls = { accept: 0, release: 0, resurrect: [] as number[], walkTo: [] as Point[], rest: [] as Record<string, unknown>[] };
    const results: { kind: string; success: boolean; reason?: string }[] = [];
    const notes: string[] = [];
    const skips: string[] = [];
    const doing: { kind: string; targetId: number | null }[] = [];
    const foes = o.foes ?? [];
    const me = { name, objectId: 1, regionId: R, x: at.x, y: at.y, z: 0, level: 20, mana: o.mana ?? 1000, maxMana: 1000, manaPercent: (o.mana ?? 1000) / 10, healthPercent: 100, attacking: false, lastDeathAt: o.dead ? Date.now() - (o.diedAgoMs ?? 1000) : null, constitutionLost: 0, isDead: !!o.dead };
    const contacts = [...(o.threats ? [contact(900, { threat: true, regionId: R })] : []), ...foes.map((f, i) => enemy(800 + i, 'midgard', { regionId: R, x: f.x, y: f.y }))];
    const pic = picture(o.members ?? [], contacts, { phase: 'recover', ...o.orders });
    const ctx = {
        name, role: 'healer', settings: o.settings ?? PVE_SETTINGS, memory: new Map<string, any>(),
        sdk: {
            getResurrectionOffer: () => (o.offer ? { caster: 'Cleric', healthPercent: 10 } : null),
            getObject: (id: number) => (o.outOfView?.includes(id) ? null : { objectId: id }),
            getState: () => ({ effects: (o.effects ?? []).map(n => ({ name: n })) }),
        },
        bot: {
            isDead: () => !!o.dead,
            acceptResurrection: async () => { calls.accept++; return { success: true, message: 'back', offer: { caster: 'Cleric', healthPercent: 10 } }; },
            releaseAndRespawn: async () => { calls.release++; return { success: true, message: 'released' }; },
            resurrect: async (id: number) => { calls.resurrect.push(id); return { success: true, message: 'back', ...o.resurrect }; },
            walkTo: async (x: number, y: number) => { calls.walkTo.push({ x, y }); return { success: true, message: 'arrived' }; },
            rest: async (r: Record<string, unknown>) => { calls.rest.push(r); return { success: true, message: 'rested', ...o.rest }; },
            getAttackers: () => [],
            getPlayerAttackers: () => [],
        },
        spells: { rez: () => (o.spell === false ? null : { spell: { name: 'Revive' }, range: 1500 }) },
        me: () => me,
        picture: () => pic,
        orders: () => pic.orders,
        members: () => pic.members,
        threats: () => pic.contacts.filter(c => c.threat),
        doing: (kind: string, targetId: number | null = null) => { doing.push({ kind, targetId }); },
        skip: (reason: string) => { skips.push(reason); return false as const; },
        result: (kind: string, r: { success: boolean; reason?: string }) => { results.push({ kind, success: r.success, reason: r.reason }); },
        note: (t: string) => { notes.push(t); },
    } as unknown as MemberContext<TacticsSettings>;
    return { ctx, calls, results, notes, skips, doing };
}

describe('capabilities.rez', () => {
    const agent = (behaviors: { name: string; run: () => boolean }[], type: string) => new MemberAgent({
        bot: 'x', role: 'healer',
        sdk: { getGameMessages: () => [], onStateUpdate: () => () => {}, getState: () => null, getSkills: () => ({ spells: [{ name: 'S', level: 10 }] }), getPlayer: () => null },
        actions: { getSpellInfo: () => ({ type, target: 'Corpse', range: 1500, radius: 0, power: -25, castTime: 4, recastDelay: 0, duration: 0, concentration: 0, pulse: 0, value: 0, damage: 0, spellGroup: 0, effectGroup: 0, frequency: 0 }) },
    } as never, new Blackboard(), behaviors, PVE_SETTINGS);
    const caps = (a: MemberAgent) => (a as unknown as { capabilities: { rez?: boolean } }).capabilities;
    const listed = [{ name: 'rez', run: () => false }];

    test('needs the spell and the behaviour: a corpse must not wait for a member whose list never casts', () => {
        expect(caps(agent(listed, 'Resurrect')).rez).toBe(true);
        expect(caps(agent([{ name: 'heal', run: () => false }], 'Resurrect')).rez).toBe(false);
        expect(caps(agent(listed, 'Heal')).rez).toBe(false);
    });
});

describe('rezzerNear and awaitingRez', () => {
    const corpse = body('Tank');

    test('a living member who knows a rez, in the region and within the radius', () => {
        expect(rezzerNear([cleric(), corpse], corpse, 4000)?.name).toBe('Cleric');
        expect(rezzerNear([cleric({ isDead: true }), corpse], corpse, 4000)).toBeUndefined();
        expect(rezzerNear([cleric({ regionId: 1 }), corpse], corpse, 4000)).toBeUndefined();
        expect(rezzerNear([cleric({ x: 5000 }), corpse], corpse, 4000)).toBeUndefined();
        expect(rezzerNear([report('Mage', { regionId: R }), corpse], corpse, 4000)).toBeUndefined();
    });

    test('not one whose whole pool the level gap outprices (ResurrectSpellHandler.cs:68)', () => {
        expect(rezzerNear([cleric({ level: 12 }), body('Tank', { level: 18 })], body('Tank', { level: 18 }), 4000)?.name).toBe('Cleric');
        expect(rezzerNear([cleric({ level: 12 }), body('Tank', { level: 19 })], body('Tank', { level: 19 }), 4000)).toBeUndefined();
    });

    test('a dead rezzer does not wait for itself', () => {
        const dead = cleric({ isDead: true });
        expect(rezzerNear([dead], dead, 4000)).toBeUndefined();
    });

    test('a corpse with a rezzer near keeps an ending run waiting, unless holding is off', () => {
        expect(awaitingRez([cleric(), corpse], {})).toBe(true);
        expect(awaitingRez([cleric()], {})).toBe(false);
        expect(awaitingRez([cleric({ isDead: true }), corpse], {})).toBe(false);
        expect(awaitingRez([cleric(), corpse], { rez: { holdMs: 0 } })).toBe(false);
    });
});

describe('release', () => {
    test('the living do nothing', async () => {
        const { ctx, calls } = stub();
        expect(await release().run(ctx)).toBe(false);
        expect(calls.release).toBe(0);
    });

    test('nobody to rez us: release at once', async () => {
        const { ctx, calls } = stub({ dead: true, members: [report('Mage', { regionId: R })] });
        expect(await release().run(ctx)).toBe(true);
        expect(calls.release).toBe(1);
    });

    test('a rezzer near: the corpse waits, and stays out of the rest of the list', async () => {
        const { ctx, calls, doing } = stub({ dead: true, members: [cleric()] });
        expect(await release().run(ctx)).toBe(true);
        expect(calls.release).toBe(0);
        expect(doing.at(-1)?.kind).toBe('await_rez');
    });

    test('it waits only holdMs, then releases', async () => {
        const { ctx, calls } = stub({ dead: true, diedAgoMs: REZ_SETTINGS.holdMs + 1, members: [cleric()] });
        await release().run(ctx);
        expect(calls.release).toBe(1);
    });

    test('a rez being cast on us holds the release past holdMs', async () => {
        const casting = cleric({ activity: { kind: 'rez', targetId: 1, detail: '', since: Date.now() - 2000 } });
        const { ctx, calls } = stub({ dead: true, diedAgoMs: REZ_SETTINGS.holdMs + 1, members: [casting] });
        await release().run(ctx);
        expect(calls.release).toBe(0);
    });

    test('holding can be turned off', async () => {
        const { ctx, calls } = stub({ dead: true, members: [cleric()], settings: { ...PVE_SETTINGS, rez: { holdMs: 0 } } });
        await release().run(ctx);
        expect(calls.release).toBe(1);
    });

    test('an offer is said yes to, and the visit to a town healer is off while the illness runs', async () => {
        const { ctx, calls, results } = stub({ dead: true, offer: true, members: [cleric()] });
        await release().run(ctx);
        expect(calls.accept).toBe(1);
        expect(calls.release).toBe(0);
        expect(results).toEqual([{ kind: 'accept_rez', success: true, reason: undefined }]);
        expect(ctx.memory.get('rezzedAt')).toBeGreaterThan(0);
    });

    test('RvR waits less: no XP is at stake, only the walk back', () => {
        expect(RVR_SETTINGS.rez?.holdMs).toBeLessThan(REZ_SETTINGS.holdMs);
    });
});

describe('healer after a rez', () => {
    test('the illness alone is not worth leaving the group for after a rez', async () => {
        const { ctx, calls } = stub({ effects: ['Resurrection Illness'] });
        ctx.memory.set('rezzedAt', Date.now());
        expect(await healer().run(ctx)).toBe(false);
        expect(calls.walkTo).toEqual([]);
    });
});

describe('rez', () => {
    const tank = body('Tank');

    test('casts on a corpse in range and tells the group', async () => {
        const { ctx, calls, results, notes, doing } = stub({ members: [tank] });
        expect(await rez().run(ctx)).toBe(true);
        expect(calls.resurrect).toEqual([tank.objectId]);
        expect(results).toEqual([{ kind: 'rez', success: true, reason: undefined }]);
        expect(notes).toEqual(['Self resurrected Tank']);
        expect(doing[0]).toEqual({ kind: 'rez', targetId: tank.objectId });
    });

    test('someone without a rez falls through', async () => {
        const { ctx, calls } = stub({ members: [tank], spell: false });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test.each(['engage', 'retreat', 'pull', 'travel'] as const)('not during %s', async phase => {
        const { ctx, calls } = stub({ members: [tank], orders: { phase } });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test('not while anything fights the group', async () => {
        const { ctx, calls } = stub({ members: [tank], threats: true });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test('not on a corpse beyond the radius or in another region', async () => {
        const { ctx, calls } = stub({ members: [body('Far', { x: REZ_SETTINGS.radius + 1 }), body('Other', { regionId: 1 })] });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test('another rezzer comes back first, then the tank', async () => {
        // A melee role, so only knowing a rez can put it before the tank.
        const rezzerBody = cleric({ name: 'Warden', role: 'melee', objectId: 77, isDead: true, x: 900 });
        const melee = body('Melee', { role: 'melee', x: 100 });
        const tankBody = body('Tank', { role: 'tank', x: 400 });
        const first = stub({ members: [melee, tankBody, rezzerBody] });
        await rez().run(first.ctx);
        expect(first.calls.resurrect).toEqual([77]);
        const second = stub({ members: [melee, tankBody] });
        await rez().run(second.ctx);
        expect(second.calls.resurrect).toEqual([tankBody.objectId]);
    });

    test('a corpse another member is rezzing is left to it', async () => {
        const busy = cleric({ name: 'Other', activity: { kind: 'rez', targetId: tank.objectId, detail: '', since: Date.now() - 1000 } });
        const { ctx, calls } = stub({ members: [tank, busy] });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test('short of power it sits for what the rez costs, not for a full bar', async () => {
        const { ctx, calls, doing } = stub({ members: [tank], mana: 300 });
        expect(await rez().run(ctx)).toBe(true);
        expect(calls.resurrect).toEqual([]);
        expect(calls.rest).toEqual([expect.objectContaining({ manaPercent: 51 })]);
        // Claimed while it sits: a second rezzer takes the next corpse.
        expect(doing[0]).toEqual({ kind: 'rez_prep', targetId: tank.objectId });
    });

    test('a long sit keeps the claim; only the cast holds a release past holdMs', async () => {
        const sitting = cleric({ name: 'Other', activity: { kind: 'rez_prep', targetId: tank.objectId, detail: '', since: Date.now() - 60_000 } });
        const second = stub({ members: [tank, sitting] });
        expect(await rez().run(second.ctx)).toBe(false);
        const corpse = stub({ dead: true, diedAgoMs: REZ_SETTINGS.holdMs + 1, members: [cleric({ activity: { kind: 'rez_prep', targetId: 1, detail: '', since: Date.now() - 1000 } })] });
        await release().run(corpse.ctx);
        expect(corpse.calls.release).toBe(1);
    });

    test('a corpse already releasing is left alone: it would not answer, and the power would be gone', async () => {
        const { ctx, calls } = stub({ members: [body('Tank', { activity: { kind: 'release', targetId: null, detail: '', since: Date.now() } })] });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test('with holding off nobody casts: every corpse is releasing', async () => {
        const { ctx, calls } = stub({ members: [tank], settings: { ...PVE_SETTINGS, rez: { holdMs: 0 } } });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test('does not walk up to enemy players, though it casts from where it stands', async () => {
        const far = body('Far', { x: 3000 });
        const walking = stub({ members: [far], foes: [{ x: 2000, y: 0 }] });
        expect(await rez().run(walking.ctx)).toBe(false);
        expect(walking.calls.walkTo).toEqual([]);
        const standing = stub({ members: [tank], foes: [{ x: 600, y: 0 }] });
        await rez().run(standing.ctx);
        expect(standing.calls.resurrect).toEqual([tank.objectId]);
    });

    test('a corpse it could never pay for is skipped', async () => {
        const { ctx, calls } = stub({ members: [body('Elder', { level: 40 })] });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.rest).toEqual([]);
    });

    test('out of range it walks to the edge of the range, not to the corpse', async () => {
        const { ctx, calls } = stub({ members: [body('Far', { x: 3000 })] });
        expect(await rez().run(ctx)).toBe(true);
        expect(calls.resurrect).toEqual([]);
        const to = calls.walkTo[0]!;
        expect(to.x).toBeGreaterThan(3000 - 1500);
        expect(to.x).toBeLessThan(3000 - 1000);
    });

    test('a corpse in range but not in view: it walks closer', async () => {
        const { ctx, calls } = stub({ members: [tank], outOfView: [tank.objectId] });
        expect(await rez().run(ctx)).toBe(true);
        expect(calls.resurrect).toEqual([]);
    });

    test('dead on the board but not yet in our view: waits a moment, no failed cast', async () => {
        const { ctx, calls, results } = stub({ members: [tank] });
        (ctx.sdk as unknown as { getObject: unknown }).getObject = () => ({ objectId: tank.objectId, kind: 'player', isDead: false });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
        expect(results).toEqual([]);
    });

    test('no answer: leaves the corpse alone until its question has expired', async () => {
        const { ctx, calls, results } = stub({ members: [tank], resurrect: { success: false, reason: 'no_answer' } });
        await rez().run(ctx);
        expect(results[0]).toMatchObject({ kind: 'rez', success: false, reason: 'no_answer' });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toHaveLength(1);
    });
});
