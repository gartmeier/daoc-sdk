// Corpses waiting for a rez and the members who bring them back, on a stub MemberContext.
// Region 9999 has no spawns, so safeSpot and safePath see no danger.
import { describe, expect, test } from 'bun:test';
import { AWAIT_FIGHT, awaitingRez, fightGoesOn, healer, release, rez, rezPressure, rezzerNear, REZ_SETTINGS, type TacticsSettings } from './behaviors';
import { PACK_SETTINGS } from './pack';
import { Blackboard } from './blackboard';
import { contact, enemy, picture, report } from './fixtures';
import { MemberAgent, type MemberContext } from './member';
import { executionContext } from '../execution-context';
import { PVE_SETTINGS } from './pve';
import { RVR_SETTINGS } from './rvr';
import type { Contact, MemberReport, Orders, Point } from './types';

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
    /** Anything else on the board. */
    contacts?: Contact[];
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
    const contacts = [...(o.threats ? [contact(900, { threat: true, regionId: R })] : []), ...foes.map((f, i) => enemy(800 + i, 'midgard', { regionId: R, x: f.x, y: f.y })), ...(o.contacts ?? [])];
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
        finishTurn: () => {},
        skip: (reason: string) => { skips.push(reason); return false as const; },
        result: (kind: string, r: { success: boolean; reason?: string }) => { results.push({ kind, success: r.success, reason: r.reason }); },
        note: (t: string) => { notes.push(t); },
    } as unknown as MemberContext<TacticsSettings>;
    return { ctx, calls, results, notes, skips, doing };
}

describe('finishTurn', () => {
    test('an orders change no longer aborts the rest of the turn; before it, it does', async () => {
        const run = async (finish: boolean) => {
            let aborted: boolean | undefined;
            let reached!: () => void;
            const inTurn = new Promise<void>(r => { reached = r; });
            const agent = new MemberAgent({
                bot: 'x', role: 'healer',
                sdk: { getGameMessages: () => [], onStateUpdate: () => () => {}, getState: () => null, getSkills: () => ({ spells: [] }), getPlayer: () => ({}), isConnected: () => true },
                actions: {},
            } as never, new Blackboard(), [{
                name: 'cast',
                run: async c => {
                    if (aborted !== undefined) return false;
                    if (finish) c.finishTurn();
                    reached();
                    await Bun.sleep(30);
                    aborted = executionContext.getStore()?.signal?.aborted ?? false;
                    return true;
                },
            }], PVE_SETTINGS, { idleMs: 5 });
            const stop = new AbortController();
            const loop = agent.run(stop.signal).catch(() => {});
            await inTurn;
            agent.interrupt('orders');
            await Bun.sleep(60);
            stop.abort(new Error('done'));
            await loop;
            agent.dispose();
            return aborted;
        };
        expect(await run(true)).toBe(false);
        expect(await run(false)).toBe(true);
    });
});

describe('rezPressure', () => {
    const heal = RVR_SETTINGS.heal;
    const me = { name: 'Cleric', regionId: R, x: 0, y: 0 };
    const team = () => [cleric(), report('Tank', { role: 'tank', regionId: R, x: 900, y: 0 }), report('Mage', { role: 'nuker', regionId: R, x: 500, y: 500 })];
    const foe = (id: number, over: Partial<Contact> = {}) => enemy(id, 'midgard', { regionId: R, x: 900, y: 0, threat: true, ...over });

    test('an even fight on the tank is none', () => {
        expect(rezPressure(me, team(), [foe(1, { target: 'Tank', x: 950 })], heal)).toBeNull();
    });

    test('someone within heal reach below the limit, by role', () => {
        const members = team();
        members[1]!.hp = heal.tank - 1;
        expect(rezPressure(me, members, [], heal)).toBe('Tank is hurt');
        members[1]!.hp = heal.tank;
        members[2]!.hp = heal.other - 1;
        expect(rezPressure(me, members, [], heal)).toBe('Mage is hurt');
        members[2]!.x = 5000;
        expect(rezPressure(me, members, [], heal)).toBeNull();
    });

    test('more free enemies than living members; a mezzed one does not count', () => {
        const three = [foe(1), foe(2), foe(3)];
        expect(rezPressure(me, team(), three, heal)).toBeNull();
        expect(rezPressure(me, team(), [...three, foe(4)], heal)).toBe('4 enemies on 3');
        expect(rezPressure(me, team(), [...three, foe(4, { cc: { kind: 'mezz', by: 'Mage', until: Date.now() + 9000 } as never })], heal)).toBeNull();
    });

    test('an enemy on a caster or healer', () => {
        expect(rezPressure(me, team(), [foe(1, { target: 'Mage', x: 550, y: 500 })], heal)).toBe('Mage is under attack');
    });

    test('an enemy on us, from range too, or next to us', () => {
        expect(rezPressure({ ...me, name: 'Warden' }, [report('Warden', { role: 'melee', regionId: R, x: 0, y: 0 })], [foe(1, { target: 'Warden', x: 1400 })], heal)).toBe('Norseman is on us');
        expect(rezPressure(me, team(), [foe(1, { target: 'Tank', x: 100 })], heal)).toBe('Norseman is on us');
    });
});

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
        expect(rezzerNear([cleric(), corpse], corpse, REZ_SETTINGS)?.name).toBe('Cleric');
        expect(rezzerNear([cleric({ isDead: true }), corpse], corpse, REZ_SETTINGS)).toBeUndefined();
        expect(rezzerNear([cleric({ regionId: 1 }), corpse], corpse, REZ_SETTINGS)).toBeUndefined();
        expect(rezzerNear([cleric({ x: 5000 }), corpse], corpse, REZ_SETTINGS)).toBeUndefined();
        expect(rezzerNear([report('Mage', { regionId: R }), corpse], corpse, REZ_SETTINGS)).toBeUndefined();
    });

    test('not one whose whole pool the level gap outprices (ResurrectSpellHandler.cs:68)', () => {
        expect(rezzerNear([cleric({ level: 12 }), body('Tank', { level: 18 })], body('Tank', { level: 18 }), REZ_SETTINGS)?.name).toBe('Cleric');
        expect(rezzerNear([cleric({ level: 12 }), body('Tank', { level: 19 })], body('Tank', { level: 19 }), REZ_SETTINGS)).toBeUndefined();
    });

    test('a dead rezzer does not wait for itself', () => {
        const dead = cleric({ isDead: true });
        expect(rezzerNear([dead], dead, REZ_SETTINGS)).toBeUndefined();
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

    test('RvR: nobody releases while the group fights, with or without a rezzer near', async () => {
        const mage = report('Mage', { regionId: R });
        for (const phase of ['engage', 'retreat'] as const) {
            const { ctx, calls, doing } = stub({ dead: true, members: [mage], settings: RVR_SETTINGS, orders: { phase } });
            expect(await release().run(ctx)).toBe(true);
            expect(calls.release).toBe(0);
            expect(doing.at(-1)?.kind).toBe(AWAIT_FIGHT);
        }
        // A threat on the board is a fight too, whatever the orders say yet.
        const threat = stub({ dead: true, members: [mage], settings: RVR_SETTINGS, threats: true });
        await release().run(threat.ctx);
        expect(threat.calls.release).toBe(0);
    });

    test('RvR: once the fight is over, a corpse with nobody to rez it releases', async () => {
        const { ctx, calls } = stub({ dead: true, members: [report('Mage', { regionId: R })], settings: RVR_SETTINGS, orders: { phase: 'recover' } });
        await release().run(ctx);
        expect(calls.release).toBe(1);
    });

    test('RvR: a wipe ends the fight for us: with nobody of ours alive here, release', async () => {
        const members = [report('Mage', { regionId: R, isDead: true }), report('Away', { regionId: R + 1 })];
        const { ctx, calls } = stub({ dead: true, members, settings: RVR_SETTINGS, orders: { phase: 'engage' }, threats: true });
        await release().run(ctx);
        expect(calls.release).toBe(1);
    });

    test('RvR: a fight that never seems to end holds only fightHoldMs', async () => {
        const { ctx, calls } = stub({ dead: true, diedAgoMs: RVR_SETTINGS.rez!.fightHoldMs! + 1, members: [report('Mage', { regionId: R })], settings: RVR_SETTINGS, orders: { phase: 'engage' } });
        await release().run(ctx);
        expect(calls.release).toBe(1);
    });

    test('RvR: after a long fight, the rezzer\'s wait counts from its end, not from the death', async () => {
        const long = RVR_SETTINGS.rez!.holdMs! + 10_000;
        const fight = stub({ dead: true, diedAgoMs: long, members: [cleric()], settings: RVR_SETTINGS, orders: { phase: 'engage' } });
        await release().run(fight.ctx);
        const over = stub({ dead: true, diedAgoMs: long, members: [cleric()], settings: RVR_SETTINGS, orders: { phase: 'recover' } });
        over.ctx.memory.set('fightHeldAt', fight.ctx.memory.get('fightHeldAt'));
        await release().run(over.ctx);
        expect(over.calls.release).toBe(0);
        expect(over.doing.at(-1)?.kind).toBe('await_rez');
        // Without that hold behind it, the same death is past holdMs.
        const plain = stub({ dead: true, diedAgoMs: long, members: [cleric()], settings: RVR_SETTINGS, orders: { phase: 'recover' } });
        await release().run(plain.ctx);
        expect(plain.calls.release).toBe(1);
    });

    test('RvR: an offer is still said yes to in a fight', async () => {
        const { ctx, calls } = stub({ dead: true, offer: true, members: [cleric()], settings: RVR_SETTINGS, orders: { phase: 'engage' } });
        await release().run(ctx);
        expect(calls.accept).toBe(1);
        expect(calls.release).toBe(0);
    });

    test('PvE releases in a fight as before, and the pack holds like rvr-roam', async () => {
        const { ctx, calls } = stub({ dead: true, members: [report('Mage', { regionId: R })], orders: { phase: 'engage' } });
        await release().run(ctx);
        expect(calls.release).toBe(1);
        expect(PACK_SETTINGS.rez?.fightHoldMs).toBe(RVR_SETTINGS.rez!.fightHoldMs!);
        expect(RVR_SETTINGS.rez!.fightHoldMs).toBeGreaterThan(0);
    });

    test('a run that is ending waits for a corpse still holding for the fight', () => {
        const corpse = body('Tank', { activity: { kind: AWAIT_FIGHT, targetId: null, detail: 'engage', since: Date.now() } });
        expect(awaitingRez([report('Mage', { regionId: R }), corpse], RVR_SETTINGS)).toBe(true);
        expect(awaitingRez([report('Mage', { regionId: R }), body('Tank')], RVR_SETTINGS)).toBe(false);
    });

    test('fightGoesOn: phases, live threats in our region, and nobody alive here', () => {
        const alive = [{ isDead: false, regionId: R }];
        expect(fightGoesOn('engage', [], alive, R)).toBe(true);
        expect(fightGoesOn('pull', [], alive, R)).toBe(true);
        expect(fightGoesOn('gather', [], alive, R)).toBe(false);
        expect(fightGoesOn('travel', [{ stale: false, regionId: R }], alive, R)).toBe(true);
        expect(fightGoesOn('travel', [{ stale: true, regionId: R }], alive, R)).toBe(false);
        expect(fightGoesOn('travel', [{ stale: false, regionId: R + 1 }], alive, R)).toBe(false);
        expect(fightGoesOn('engage', [], [{ isDead: true, regionId: R }, { isDead: false, regionId: R + 1 }], R)).toBe(false);
    });

    test('RvR: a corpse does not wait for a rezzer who can\'t pay now and keep its reserve', async () => {
        const low = stub({ dead: true, members: [cleric({ mana: 74 })], settings: RVR_SETTINGS });
        await release().run(low.ctx);
        expect(low.calls.release).toBe(1);
        const enough = stub({ dead: true, members: [cleric({ mana: 75 })], settings: RVR_SETTINGS });
        await release().run(enough.ctx);
        expect(enough.calls.release).toBe(0);
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

    describe('in RvR', () => {
        const fightOnTank = () => [enemy(801, 'midgard', { regionId: R, x: 900, y: 0, threat: true, target: 'Tank' })];
        const self = report('Self', { role: 'healer', regionId: R, x: 0, y: 0, level: 20, objectId: 1 });
        const stubbed = (over: StubOptions = {}) => stub({ members: [tank, self], settings: RVR_SETTINGS, contacts: fightOnTank(), orders: { phase: 'engage' }, ...over });

        test('rezzes mid-fight while the group is not under pressure', async () => {
            const { ctx, calls } = stubbed();
            expect(await rez().run(ctx)).toBe(true);
            expect(calls.resurrect).toEqual([tank.objectId]);
        });

        test('not under pressure only: an enemy on a caster stops it', async () => {
            const { ctx, calls, skips } = stubbed({ members: [tank, self, report('Mage', { role: 'nuker', regionId: R, x: 900, y: 0 })], contacts: [enemy(801, 'midgard', { regionId: R, x: 920, y: 0, threat: true, target: 'Mage' })] });
            expect(await rez().run(ctx)).toBe(false);
            expect(calls.resurrect).toEqual([]);
            expect(skips).toEqual(['rez: Mage is under attack']);
        });

        test('crowd control ordered on us comes first', async () => {
            const { ctx, calls } = stubbed({ orders: { phase: 'engage', cc: [{ targetId: 801, by: 'Self' }] as never } });
            expect(await rez().run(ctx)).toBe(false);
            expect(calls.resurrect).toEqual([]);
        });

        test('in a fight it casts only from where it stands', async () => {
            const { ctx, calls } = stubbed({ members: [body('Far', { x: 3000 }), self] });
            expect(await rez().run(ctx)).toBe(false);
            expect(calls.walkTo).toEqual([]);
        });

        test('never sits for it: short of its reserve it passes, and the rest of the list goes on', async () => {
            const { ctx, calls } = stub({ members: [tank], settings: RVR_SETTINGS, mana: 740 });
            expect(await rez().run(ctx)).toBe(false);
            expect(calls.rest).toEqual([]);
            expect(calls.resurrect).toEqual([]);
        });

        test('a 10 % rez is good enough, and between fights it walks as in PvE', async () => {
            const { ctx, calls } = stub({ members: [body('Far', { x: 3000 })], settings: RVR_SETTINGS });
            expect(await rez().run(ctx)).toBe(true);
            expect(calls.walkTo).toHaveLength(1);
        });

        test.each(['retreat', 'pull', 'travel'] as const)('not during %s', async phase => {
            const { ctx, calls } = stubbed({ orders: { phase } });
            expect(await rez().run(ctx)).toBe(false);
            expect(calls.resurrect).toEqual([]);
        });
    });

    test('in PvE a fight still stops it, whatever the pressure', async () => {
        const { ctx, calls } = stub({ members: [tank], orders: { phase: 'engage' } });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toEqual([]);
    });

    test('no answer: leaves the corpse alone until its question has expired', async () => {
        const { ctx, calls, results } = stub({ members: [tank], resurrect: { success: false, reason: 'no_answer' } });
        await rez().run(ctx);
        expect(results[0]).toMatchObject({ kind: 'rez', success: false, reason: 'no_answer' });
        expect(await rez().run(ctx)).toBe(false);
        expect(calls.resurrect).toHaveLength(1);
    });
});
