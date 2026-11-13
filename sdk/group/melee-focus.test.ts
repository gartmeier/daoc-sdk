import { afterEach, describe, expect, test } from 'bun:test';
import { BotActions } from '../actions';
import { FakeWorld } from '../test/fake-world';
import { makePlayer } from '../test/fixtures';
import { Blackboard } from './blackboard';
import { MemberAgent } from './member';
import { MELEE_FOCUS_ROLES, ordersForRole } from './melee-focus';
import { RVR_SETTINGS } from './rvr';
import type { Orders, Role } from './types';

const base = (o: Partial<Orders> = {}): Orders => ({
    seq: 1, issuedAt: 0, phase: 'engage', anchor: null, facing: null, focus: 302, puller: null, cc: [], retreatTo: null, waiting: [], reason: 'test', ...o,
} as Orders);

describe('meleeFocus: the tanks\' and melee\'s own focus (live 08:36: midgard-2\'s melee walked up the wall to a Wizard)', () => {
    test('a tank or melee reads meleeFocus as its focus; the others keep the unit\'s', () => {
        const o = base({ meleeFocus: null });
        for (const role of ['tank', 'melee'] as Role[]) expect(ordersForRole(o, role).focus).toBeNull();
        for (const role of ['healer', 'support', 'nuker'] as Role[]) expect(ordersForRole(o, role)).toBe(o);
        expect(ordersForRole(base({ meleeFocus: 400 }), 'melee').focus).toBe(400);
        expect([...MELEE_FOCUS_ROLES].sort()).toEqual(['melee', 'tank']);
    });

    test('absent, or the same as focus: the orders as they are', () => {
        const o = base();
        expect(ordersForRole(o, 'tank')).toBe(o);
        const same = base({ meleeFocus: 302 });
        expect(ordersForRole(same, 'melee')).toBe(same);
    });

    test('the board: a change of it alone is material; an update that doesn\'t name it drops it', () => {
        const b = new Blackboard();
        b.setOrders({ phase: 'engage', focus: 302, reason: 'raid' }, 1000);
        expect(b.setOrders({ phase: 'engage', focus: 302, meleeFocus: null, reason: 'raid' }, 1001)).toBe(true);
        expect(b.getOrders().meleeFocus).toBeNull();
        expect(b.setOrders({ phase: 'engage', focus: 302, meleeFocus: null, reason: 'raid' }, 1002)).toBe(false);
        // The raid over (or a fight with players): the decide names no meleeFocus, so the melee go with focus again.
        expect(b.setOrders({ phase: 'engage', focus: 77, reason: 'fight' }, 1003)).toBe(true);
        expect('meleeFocus' in b.getOrders()).toBe(false);
    });
});

describe('meleeFocus in a member: MemberContext.orders() by its role', () => {
    let end: (() => void)[] = [];
    afterEach(() => { for (const e of end) e(); end = []; });
    const agentOf = (role: Role, board: Blackboard) => {
        const w = new FakeWorld({ player: makePlayer({ level: 24 }), nearbyNpcs: [], nearbyPlayers: [], nearbyObjects: [], effects: [], combatEvents: [] });
        const agent = new MemberAgent({ bot: 'testbot', role, sdk: w.sdk, actions: new BotActions(w.sdk) }, board, [], { ...RVR_SETTINGS }, { sightRadius: 40_000 });
        end.push(() => { agent.dispose(); w.dispose(); });
        return agent;
    };

    test('the same orders: the melee hold (no focus), the healer keeps the wall caster', () => {
        const board = new Blackboard();
        board.setOrders({ phase: 'engage', focus: 302, meleeFocus: null, reason: 'raid assault: rank 2: ranged: wall-e-n; melee hold' });
        expect(agentOf('melee', board).ctx.orders().focus).toBeNull();
        expect(agentOf('tank', board).ctx.orders().focus).toBeNull();
        expect(agentOf('healer', board).ctx.orders().focus).toBe(302);
        board.setOrders({ phase: 'engage', focus: 302, reason: 'fight' });
        expect(agentOf('melee', board).ctx.orders().focus).toBe(302);
    });
});

describe('meleeSplit: one wall caster each (the user, 18:0x: "tanks go in. up the stairs. one for each runi")', () => {
    test('a tank or melee named in meleeSplit takes its own; one not named takes meleeFocus; the others the unit\'s focus', () => {
        const o = base({ focus: null, meleeFocus: 401, meleeSplit: { Gareth: 401, Percival: 402 } });
        expect(ordersForRole(o, 'tank', 'Gareth').focus).toBe(401);
        expect(ordersForRole(o, 'melee', 'Percival').focus).toBe(402);
        expect(ordersForRole(o, 'melee', 'Lancelot').focus).toBe(401);
        expect(ordersForRole(o, 'melee').focus).toBe(401);
        expect(ordersForRole(o, 'nuker', 'Percival')).toBe(o);
    });
    test('the split lasts one decide, as meleeFocus; a new split is a material change', () => {
        const b = new Blackboard();
        b.setOrders({ phase: 'engage', focus: null, meleeFocus: 401, meleeSplit: { Gareth: 401, Percival: 402 } } as any);
        expect(b.getOrders().meleeSplit).toEqual({ Gareth: 401, Percival: 402 });
        expect(b.setOrders({ phase: 'engage', focus: null, meleeFocus: 401, meleeSplit: { Gareth: 402, Percival: 401 } } as any)).toBe(true);
        b.setOrders({ phase: 'engage', focus: null, meleeFocus: 401 } as any);
        expect(b.getOrders().meleeSplit).toBeUndefined();
    });
});
