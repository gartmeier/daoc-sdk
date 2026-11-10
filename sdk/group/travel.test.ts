// Travelling in legs without stopping at each one (travel.ts): the legs say where the trip goes on (rvr.ts legAnchor),
// and a member walking to its slot aims past it that way (holdFormation). Region 9999 has no spawns, keeps or water.
import { describe, expect, test } from 'bun:test';
import { formationOffset, holdFormation, type TacticsSettings } from './behaviors';
import { picture, report } from './fixtures';
import type { MemberContext } from './member';
import { decideRvr, RVR_SETTINGS, stepLeg, type RvrSettings } from './rvr';
import { mergeSettings, type CoordinatorContext } from './strategy';
import { keepsTravelling, ONWARD_MIN, onwardWay, TRAVEL_LEAD, travelAim } from './travel';
import type { GroupPicture, MemberReport, Orders, Point, Role } from './types';
import { isDry, isWet } from './water';

const R = 9999;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const travel = (anchor: Orders['anchor'], over: Partial<Orders> = {}) => ({ phase: 'travel' as const, anchor, column: null, ...over });

describe('travelAim: past the slot toward where the trip goes on', () => {
    const anchor = { x: 10_000, y: 10_000, z: 0, onward: { x: 12_000, y: 10_000 } };
    const slot = { x: 9_300, y: 10_200 };

    test('TRAVEL_LEAD past the slot, along the anchor\'s way on', () => {
        expect(travelAim(R, slot, travel(anchor))).toEqual({ x: slot.x + TRAVEL_LEAD, y: slot.y });
    });

    test('never farther than the onward point lies beyond the anchor', () => {
        expect(travelAim(R, slot, travel({ ...anchor, onward: { x: 10_350, y: 10_000 } }))).toEqual({ x: slot.x + 350, y: slot.y });
    });

    test('the slot itself: no way on, one too near to say anything, a column, or any phase but travel', () => {
        expect(travelAim(R, slot, travel({ x: 10_000, y: 10_000, z: 0 }))).toBeNull();
        expect(travelAim(R, slot, travel({ ...anchor, onward: null }))).toBeNull();
        expect(travelAim(R, slot, travel({ ...anchor, onward: { x: 10_000 + ONWARD_MIN - 1, y: 10_000 } }))).toBeNull();
        expect(travelAim(R, slot, travel(anchor, { column: { driver: 'Bard', order: [], gap: 120, speed: 0.9 } }))).toBeNull();
        for (const phase of ['engage', 'gather', 'recover', 'retreat', 'pull', 'idle'] as const) expect(travelAim(R, slot, travel(anchor, { phase }))).toBeNull();
        expect(travelAim(R, slot, travel(null))).toBeNull();
    });

    test('keepsTravelling: only orders that still travel on', () => {
        expect(keepsTravelling(travel(anchor))).toBe(true);
        expect(keepsTravelling(travel({ x: 1, y: 1, z: 0 }))).toBe(false);
        expect(keepsTravelling(travel(anchor, { phase: 'engage' }))).toBe(false);
        expect(onwardWay(travel(anchor))).toEqual({ u: { x: 1, y: 0 }, reach: 2000 });
    });

    // Thidranki's river west of the Faste: a dry slot whose lead ends in the water aims shorter, or at the slot.
    describe.skipIf(!isWet(252, { x: 41_069, y: 26_768 }))('by a river', () => {
        test('a dry slot never aims into the water', () => {
            const bank = { x: 38_500, y: 26_768 };
            expect(isDry(252, bank)).toBe(true);
            // Find a dry spot within TRAVEL_LEAD of the water on the way east.
            let p = { ...bank };
            while (!isWet(252, { x: p.x + TRAVEL_LEAD, y: p.y }) && p.x < 41_069) p = { x: p.x + 20, y: p.y };
            expect(isWet(252, p)).toBe(false);
            const a = { x: p.x, y: p.y, z: 0, onward: { x: 45_000, y: p.y } };
            const aim = travelAim(252, p, travel(a));
            if (aim) expect(isWet(252, aim)).toBe(false);
        });
    });
});

// ── The coordinator: legs carry their way on ──

const LINE = [{ x: 10_000, y: 10_000, z: 0 }, { x: 16_000, y: 10_000, z: 0 }, { x: 16_000, y: 16_000, z: 0 }];
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [], buffSpells: [] });

function team(at: Point): MemberReport[] {
    const p = (dx: number, dy: number) => ({ regionId: R, x: at.x + dx, y: at.y + dy, level: 24 });
    return [
        report('Tank', { role: 'tank', className: 'Armsman', objectId: 1, mana: 0, capabilities: caps(false, false, false), ...p(0, 0) }),
        report('Cleric', { role: 'healer', className: 'Cleric', objectId: 2, capabilities: caps(true, false, false), ...p(-300, 200) }),
        report('Sorc', { role: 'support', className: 'Sorcerer', objectId: 3, capabilities: caps(false, true, true), ...p(-300, -200) }),
        report('Wiz', { role: 'nuker', className: 'Wizard', objectId: 4, capabilities: caps(false, false, true), ...p(-500, 300) }),
        report('Friar', { role: 'healer', className: 'Friar', objectId: 5, capabilities: caps(true, false, false), ...p(-500, -300) }),
    ];
}

function rvrCtx(p: GroupPicture, memory: Record<string, any>, over: Record<string, unknown> = {}): CoordinatorContext<RvrSettings> {
    return { picture: p, orders: p.orders, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, { patrol: LINE, retreat: { ...RVR_SETTINGS.retreat, enabled: false }, ...over } as any) };
}

describe('decideRvr: each patrol leg says where the trip goes on', () => {
    test('a leg on the way to a waypoint points on along the route; the one ending at it, to the next waypoint', () => {
        const memory: Record<string, any> = {};
        const step = (at: Point) => decideRvr(rvrCtx(picture(team(at)), memory));
        let d = step(LINE[0]!);
        expect(d.anchor).toMatchObject({ x: 10_000, y: 10_000, onward: { x: 16_000, y: 10_000 } });   // at waypoint 1: on to 2
        d = step(LINE[0]!);
        expect(d.anchor).toMatchObject({ x: 11_500, y: 10_000, onward: { x: 16_000, y: 10_000 } });
        for (const x of [11_500, 13_000, 14_500]) d = step({ x, y: 10_000 });
        expect(d.anchor).toMatchObject({ x: 16_000, y: 10_000, onward: { x: 16_000, y: 16_000 } });   // the leg at waypoint 2: on to 3
        d = step({ x: 16_000, y: 10_000 });
        expect(d.anchor).toMatchObject({ x: 16_000, y: 11_500, onward: { x: 16_000, y: 16_000 } });
    });

    test('a leg that ends a trip has none, and waiting where the last leg was carries none', () => {
        const mem: Record<string, any> = {};
        const trip = { mem, now: 0, regionId: R, level: 24, avoid: [], travelLeg: 1500, zAt: () => 0 };
        stepLeg(trip, 'hunt', { x: 11_000, y: 10_000 }, { from: { x: 10_000, y: 10_000 }, movers: [], replan: 800 });
        expect(mem.leg).toMatchObject({ x: 11_000, y: 10_000 });
        expect(mem.legOnward).toBeNull();
        stepLeg(trip, 'hunt', { x: 14_000, y: 10_000 }, { from: { x: 10_000, y: 10_000 }, movers: [], replan: 800 });
        expect(mem.legOnward).toEqual({ x: 14_000, y: 10_000 });
        // Waiting for power where the last leg was: recover, at a plain point.
        const memory: Record<string, any> = {};
        const low = team({ x: 12_000, y: 10_000 }).map(m => m.name === 'Wiz' ? { ...m, mana: 5 } : m);
        const r = decideRvr(rvrCtx(picture(low, [], { anchor: { x: 12_000, y: 10_000, z: 0, onward: { x: 16_000, y: 10_000 } } }), memory));
        expect(r.phase).toBe('recover');
        expect(r.anchor).toEqual({ x: 12_000, y: 10_000, z: 0 });
    });
});

// ── holdFormation on a stub member ──

function member(o: { at: Point; orders: Partial<Orders>; role?: Role }) {
    const calls = { walkTo: [] as { x: number; y: number; opts: any }[], stop: 0 };
    const pic = picture([report('Wiz', { role: o.role ?? 'nuker', regionId: R, x: o.at.x, y: o.at.y, objectId: 4 })], [], { phase: 'travel', ...o.orders });
    const ctx = {
        name: 'Wiz', role: o.role ?? 'nuker', settings: { ...RVR_SETTINGS } as unknown as TacticsSettings, memory: new Map<string, any>(),
        me: () => ({ name: 'Wiz', objectId: 4, regionId: R, x: o.at.x, y: o.at.y, z: 0, level: 24 }),
        orders: () => pic.orders, picture: () => pic, members: () => pic.members, member: (n: string) => pic.members.find(m => m.name === n),
        doing: () => {}, skip: () => false, result: () => {},
        bot: { walkTo: async (x: number, y: number, opts: any) => { calls.walkTo.push({ x, y, opts }); return { success: true, message: 'arrived' }; } },
        sdk: { getMovement: () => ({ moving: false }), sendStop: async () => { calls.stop++; return { success: true, message: '' }; } },
    } as unknown as MemberContext<TacticsSettings>;
    return { ctx, calls, pic };
}

describe('holdFormation while travelling', () => {
    const anchor = { x: 11_500, y: 10_000, z: 0 };
    const facing = { x: 16_000, y: 10_000 };
    // The nuker's slot with the formation facing east (RVR_SETTINGS' nuker: 700 back, 0.3 off the line).
    const off = formationOffset(RVR_SETTINGS.formation as any, 'nuker', 0, Math.PI);
    const slot = { x: Math.round(anchor.x + off.x), y: Math.round(anchor.y + off.y) };

    test('the trip goes on: it walks TRAVEL_LEAD past its slot, and a new leg doesn\'t brake the walk', async () => {
        const s = member({ at: { x: 9_000, y: 10_000 }, orders: { anchor: { ...anchor, onward: facing }, facing } });
        expect(await holdFormation().run(s.ctx)).toBe(true);
        expect(s.calls.walkTo).toHaveLength(1);
        const w = s.calls.walkTo[0]!;
        expect(w.x).toBeCloseTo(slot.x + TRAVEL_LEAD, -1);
        expect(w.y).toBeCloseTo(slot.y, -1);
        // Cut off by the next leg, travelling on: the mover keeps running. By a fight, or the last leg: it brakes.
        expect(w.opts.stopOnAbort()).toBe(false);
        s.pic.orders = { ...s.pic.orders, phase: 'engage' };
        expect(w.opts.stopOnAbort()).toBe(true);
        s.pic.orders = { ...s.pic.orders, phase: 'travel', anchor: { x: 13_000, y: 10_000, z: 0 } };
        expect(w.opts.stopOnAbort()).toBe(true);
    });

    test('the trip\'s last leg: to the slot, as before', async () => {
        const s = member({ at: { x: 9_000, y: 10_000 }, orders: { anchor, facing } });
        await holdFormation().run(s.ctx);
        expect(s.calls.walkTo[0]).toMatchObject({ x: slot.x, y: slot.y });
        expect(s.calls.walkTo[0]!.opts.stopOnAbort).toBeUndefined();
    });

    test('standing at its lead point it stays (the leg hasn\'t moved on): the turn goes down the list', async () => {
        const s = member({ at: { x: slot.x + TRAVEL_LEAD - 100, y: slot.y }, orders: { anchor: { ...anchor, onward: facing }, facing } });
        expect(await holdFormation().run(s.ctx)).toBe(false);
        expect(s.calls.walkTo).toHaveLength(0);
    });

    test('scoped to travel: a gather leg, or a fight, walks to the slot', async () => {
        const g = member({ at: { x: 9_000, y: 10_000 }, orders: { phase: 'gather', anchor: { ...anchor, onward: facing }, facing } });
        await holdFormation().run(g.ctx);
        expect(g.calls.walkTo[0]).toMatchObject({ x: slot.x, y: slot.y });
        const e = member({ at: { x: 5_000, y: 10_000 }, orders: { phase: 'engage', anchor: { ...anchor, onward: facing }, facing } });
        await holdFormation().run(e.ctx);
        expect(e.calls.walkTo[0]!.opts.stopOnAbort).toBeUndefined();
    });
});

// ── Stepped walks as members walk them: the coordinator's legs, each member's turns, and the mover's ramp ──

/**
 * A patrol on a straight 12,000 line, five members in a deep formation (the support 1150 back, as Camelot's Merlin
 * stood on 2026-11-10), simulated in 50 ms steps:
 * - Coordinator: decideRvr every 250 ms, on member positions as published (a turn old).
 * - Member: a turn every 250 ms (holdFormation's choice of target, needsSlot's 250, walkTowardSlot's tolerance 80). A new
 *   anchor interrupts the walk: it brakes unless stopOnAbort says not to, and the next walk starts a turn later.
 * - Mover (client/movement.ts): +250 units/s² from rest to 191, −500 to stop; a move slows to its rest point,
 *   tolerance / 2 short of the end, and a re-issued move keeps its speed.
 * Counts the times a member's speed fell to 0 while the patrol went on.
 */
function simulatePatrol(o: { lead: boolean; seconds: number }) {
    const FORMATION = { tank: { back: 0, angle: 0 }, healer: { back: 630, angle: 0.5 }, support: { back: 1150, angle: 0.15 }, nuker: { back: 950, angle: 0.2 }, melee: { back: 120, angle: 0.8 } };
    const roles: [string, Role][] = [['Tank', 'tank'], ['Cleric', 'healer'], ['Sorc', 'support'], ['Wiz', 'nuker'], ['Friar', 'healer']];
    const loop = [{ x: 10_000, y: 10_000, z: 0 }, { x: 22_000, y: 10_000, z: 0 }];
    const memory: Record<string, any> = {};
    let orders: any = { phase: 'travel', anchor: null, facing: null };
    const mv = roles.map(([name, role], i) => {
        const same = roles.filter(r => r[1] === role).map(r => r[0]);
        const off = formationOffset(FORMATION as any, role, same.indexOf(name), Math.PI);
        return { name, role, x: 10_000 + off.x, y: 10_000 + off.y, v: 0, to: null as Point | null, tol: 80, nextTurn: i * 50, stops: 0, braking: false, published: { x: 0, y: 0 } };
    });
    let anchorSeen = new Map<string, Point | null>();
    const dt = 0.05;
    for (let t = 0; t < o.seconds * 1000; t += 50) {
        if (t % 250 === 0) {
            const reports = mv.map(m => report(m.name, { role: m.role, regionId: R, x: m.published.x || m.x, y: m.published.y || m.y, objectId: 1, level: 24, mana: 100, hp: 100 }));
            const u = decideRvr({ picture: picture(reports, [], orders), orders, memory, now: 1_000_000 + t, windingDown: false, settings: mergeSettings(RVR_SETTINGS, { patrol: loop, formation: FORMATION, retreat: { ...RVR_SETTINGS.retreat, enabled: false } } as any) });
            orders = { ...orders, ...u };
            if (!o.lead && orders.anchor?.onward) orders = { ...orders, anchor: { x: orders.anchor.x, y: orders.anchor.y, z: orders.anchor.z } };
            for (const m of mv) m.published = { x: m.x, y: m.y };
        }
        for (const m of mv) {
            // The anchor moved (> 300): the walk is interrupted. It brakes unless the leg goes on (stopOnAbort).
            const seen = anchorSeen.get(m.name);
            if (orders.anchor && seen !== undefined && seen && dist(seen, orders.anchor) > 300 && m.to) {
                if (!keepsTravelling(orders)) { m.braking = true; m.to = null; }
                m.nextTurn = Math.max(m.nextTurn, t + 250);
            }
            anchorSeen.set(m.name, orders.anchor ? { x: orders.anchor.x, y: orders.anchor.y } : null);
            if (t >= m.nextTurn && orders.anchor) {
                m.nextTurn = t + 250;
                const same = roles.filter(r => r[1] === m.role).map(r => r[0]);
                const away = Math.atan2(orders.anchor.y - orders.facing.y, orders.anchor.x - orders.facing.x);
                const off = formationOffset(FORMATION as any, m.role, same.indexOf(m.name), away);
                const slot = { x: orders.anchor.x + off.x, y: orders.anchor.y + off.y };
                const target = travelAim(R, slot, orders) ?? slot;
                if (dist(m, target) >= 250) { m.to = target; m.braking = false; }
            }
            // Mover.
            const was = m.v;
            if (m.to && !m.braking) {
                const left = dist(m, m.to) - m.tol / 2;
                const stopDist = (m.v * m.v) / (2 * 500);
                if (left <= 0.5) { m.to = null; m.braking = true; }
                else if (left <= stopDist + 1) m.v = Math.max(0, m.v - 500 * dt);
                else m.v = Math.min(191, m.v + 250 * dt);
                if (m.to) { const step = Math.min(m.v * dt, Math.max(0, left)); const d = dist(m, m.to); m.x += (m.to.x - m.x) / d * step; m.y += (m.to.y - m.y) / d * step; }
            } else if (m.v > 0) m.v = Math.max(0, m.v - 500 * dt);
            if (was > 0 && m.v === 0 && t > 3000) m.stops++;
        }
    }
    return { stops: mv.reduce((n, m) => n + m.stops, 0), byMember: Object.fromEntries(mv.map(m => [m.name, m.stops])), tankX: mv[0]!.x, wp: memory.wp };
}

describe('a patrol in legs, walked in steps', () => {
    test('walking to the slots, every member stops at almost every leg (as measured live)', () => {
        const r = simulatePatrol({ lead: false, seconds: 50 });
        expect(r.stops).toBeGreaterThanOrEqual(10);
    });

    test('aiming past the slots, nobody stops on the way, and the group gets farther in the same time', () => {
        const before = simulatePatrol({ lead: false, seconds: 50 });
        const after = simulatePatrol({ lead: true, seconds: 50 });
        expect(after.stops).toBe(0);
        expect(after.tankX).toBeGreaterThan(before.tankX + 500);
    });
});
