import { describe, expect, test } from 'bun:test';
import { makeMessage, makeNpc, makePlayer, makeState } from '../../test/fixtures';
import type { NearbyObject } from '../../types';
import { Blackboard, doorsBrokenNear, observeState, type MemberSelf } from '../blackboard';
import { contact, obs, picture, report } from '../fixtures';
import { decideRvr, realmCalls, RVR_SETTINGS, type RvrSettings } from '../rvr';
import { FASTE, raidPlan } from '../siege';
import { mergeSettings, type CoordinatorContext } from '../strategy';
import type { Behavior } from '../member';
import type { Contact, GroupPicture, MemberReport, Orders, Point3 } from '../types';
import type { RealmCall } from './help';
import { breakDoor, RAID_FOE_REACH, raidMembers, raidPatch, raidRez, raidStep, squadHold, squadWait, withBreakDoor, withRaid, type RaidDoor } from './raid';
import { raidCorpses, raidRezzerNear } from '../behaviors';
import { decidePack, rvrPack } from '../pack';
import { getNavmeshStore } from '../../navmesh';

const TH = FASTE.regionId;
const plan = raidPlan('midgard')!;
const T = 1_800_000_000_000;
const caps = { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [] };
const self: MemberSelf = { bot: 'tank', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: caps };

/** Five Midgard members round `at`. */
function five(at: Point3, over: Partial<MemberReport> = {}): MemberReport[] {
    const roles = ['tank', 'melee', 'healer', 'nuker', 'nuker'] as const;
    return roles.map((role, i) => report(`M${i}`, { role, className: 'Warrior', objectId: 10 + i, regionId: TH, x: at.x + i * 40, y: at.y, z: at.z, level: 24, ...over }));
}
const guard = (id: number, at: Point3, over: Partial<Contact> = {}): Contact =>
    contact(id, { kind: 'npc', name: 'Huscarl', realm: 'albion', level: 28, regionId: TH, x: at.x, y: at.y, z: at.z, keepGuard: true, ...over });
const go: RealmCall = { id: 'muster-1', kind: 'muster', from: 'director', why: 'raid', at: plan.rally, stage: 'go', target: plan.target, foes: 0, ours: 0, want: 0, asked: [] };
const mustered = () => ({ realm: 'midgard', realmCalls: [go], help: { id: go.id, kind: 'muster', state: 'arrived', since: 0, stage: 'go' } });

describe('raid: the board takes in keep guards', () => {
    const state = (npcs = [makeNpc({ objectId: 300, name: 'Huscarl', realm: 'albion', level: 28, x: 34_687, y: 38_050, z: 3716, distance2d: 900 })]) => makeState({
        timestamp: T, inGame: true, player: makePlayer({ objectId: 10, name: 'M0', realm: 'midgard', regionId: TH, x: 35_500, y: 38_250, z: 3570 }), nearbyNpcs: npcs, nearbyPlayers: [], combatEvents: [], gameMessages: [],
    });

    test('an enemy realm NPC that is no pet is a sighting marked keepGuard; one of our realm or a peace NPC is none', () => {
        const o = observeState(state(), self)!;
        expect(o.sightings.map(s => [s.objectId, s.keepGuard])).toEqual([[300, true]]);
        const ours = makeNpc({ objectId: 301, name: 'Huscarl', realm: 'midgard', level: 28, distance2d: 900 });
        const peace = makeNpc({ objectId: 302, name: 'Hastener', realm: 'albion', level: 50, isPeaceful: true, distance2d: 900 });
        expect(observeState(state([ours, peace]), self)!.sightings).toEqual([]);
    });

    test('the picture shows them only while the orders carry a raid', () => {
        const b = new Blackboard();
        b.publish(observeState(state(), self)!, T);
        expect(b.picture(T).contacts).toEqual([]);
        b.setOrders({ phase: 'travel', settings: { raid: FASTE.keep, raidDoor: null }, reason: 'raid' }, T);
        expect(b.picture(T).contacts.map(c => [c.objectId, c.keepGuard])).toEqual([[300, true]]);
        b.setOrders({ phase: 'travel', settings: null, reason: 'over' }, T);
        expect(b.picture(T).contacts).toEqual([]);
    });

    test('a broken door: the line by the door nearest the member, an object in view or the layout\'s', () => {
        const line = [{ text: 'The Keep Door is broken!', receivedAt: T - 2000 }];
        const gate = FASTE.targets.find(t => t.label === 'gate')!;
        const obj = [{ doorId: 777, x: 34_333, y: 38_275 }];
        expect(doorsBrokenNear(line, obj, { x: 34_420, y: 38_275, regionId: TH }, T)).toEqual([777]);
        expect(doorsBrokenNear(line, [], { x: 34_420, y: 38_275, regionId: TH }, T)).toEqual([gate.doorId!]);
        expect(doorsBrokenNear(line, [], { x: 36_300, y: 38_300, regionId: TH }, T)).toEqual([]);
        expect(doorsBrokenNear([{ ...line[0]!, receivedAt: T - 120_000 }], obj, { x: 34_420, y: 38_275, regionId: TH }, T)).toEqual([]);
        const st = makeState({ timestamp: T, inGame: true, player: makePlayer({ objectId: 10, name: 'M0', realm: 'midgard', regionId: TH, x: 34_420, y: 38_275, z: 3720 }), nearbyNpcs: [], nearbyPlayers: [], combatEvents: [], gameMessages: [makeMessage(1, 'The Keep Door is broken!', { receivedAt: T - 500 })] });
        expect(observeState(st, self)!.report.doorsBroken).toEqual([gate.doorId!]);
    });
});

describe('raid: the orders, step by step', () => {
    const step = (members: MemberReport[], guards: Contact[] = [], mem: Record<string, any> = { raid: { callId: 'x', staged: false, broken: [] } }) => ({ mem, ...raidStep({ plan, mem, members, guards }) });

    test('approach: over our own bridge, the next waypoint, the raid patch set', () => {
        const { update } = step(five(plan.rally));
        expect(update.phase).toBe('travel');
        expect(update.anchor).toMatchObject({ x: plan.route[0]!.x, y: plan.route[0]!.y });
        expect(update.settings).toEqual({ raid: FASTE.keep, raidDoor: null });
    });

    test('assault: the outer guards are the focus; then the gate alone, the ranged waiting out of sight of the walls', () => {
        const outer = FASTE.targets.find(t => t.label === 'outer-armswoman')!;
        const a = step(five(plan.stage), [guard(301, outer.at)]);
        expect(a.update).toMatchObject({ phase: 'engage', focus: 301 });
        expect(a.mem.raid.staged).toBe(true);
        // Rank 1 done (nothing at the outer posts, seen from GATE_OUT): the gate, melee only (R5's ranks by the walls'
        // line of sight, 11:13). A wall caster in view is rank 3's: no focus for anyone, the melee on the door.
        const wall = FASTE.targets.find(t => t.label === 'wall-e-n')!;
        const gateOut = { x: 34_650, y: 38_250, z: 3722 };
        const b = step(five(gateOut), [guard(302, wall.at, { name: 'Sorcerer' })], a.mem);
        expect(b.update).toMatchObject({ phase: 'recover', focus: null });
        expect(b.orders.ranged.step).toBeNull();
        expect((b.update.settings as any).raidDoor).toMatchObject({ doorId: 252000301, label: 'gate' });
        // The same object while the door stays.
        expect(step(five(gateOut), [guard(302, wall.at, { name: 'Sorcerer' })], a.mem).update.settings).toBe(b.update.settings);
    });

    test('a member read the gate broken: the melee leave it', () => {
        const wall = FASTE.targets.find(t => t.label === 'wall-e-n')!;
        const mem = { raid: { callId: 'x', staged: true, broken: [] as number[] } };
        const members = five({ x: 34_420, y: 38_275, z: 3720 });
        members[1] = { ...members[1]!, doorsBroken: [252000301] };
        const { update } = step(members, [guard(302, wall.at, { name: 'Sorcerer' })], mem);
        expect(mem.raid.broken).toEqual([252000301]);
        expect((update.settings as any).raidDoor).toBeNull();
    });

    test('the melee\'s own focus: the same on a fighter, none named at the gate (breakDoor\'s), none on the walls (they hold)', () => {
        const outer = FASTE.targets.find(t => t.label === 'outer-armswoman')!;
        const wall = FASTE.targets.find(t => t.label === 'wall-e-n')!;
        // Rank 1, a fighter for all: one focus.
        const a = step(five(plan.stage), [guard(301, outer.at)]);
        expect(a.update).toMatchObject({ focus: 301, meleeFocus: undefined });
        // Rank 2, the gate standing: nothing to engage; the melee are breakDoor's, and no meleeFocus is named.
        const b = step(five({ x: 34_650, y: 38_250, z: 3722 }), [guard(302, wall.at, { name: 'Sorcerer' })], a.mem);
        expect(b.update).toMatchObject({ phase: 'recover', focus: null });
        expect('meleeFocus' in b.update).toBe(false);
        // The gate broken (rank 3), the yard pair gone, the walls left: the melee go up the wall-walk stair for the wall casters
        // with the ranged (the user, 2026-11-13 17:25: "tanks need to go in. up the walls and kill the runemasters"; S2's siege.ts
        // gives the courtyard-side wall casters to all). Before 17:25 they held (live 08:36 they had climbed the wall's side).
        const members = five({ x: 34_420, y: 38_275, z: 3720 });
        members[1] = { ...members[1]!, doorsBroken: [252000301] };
        const c = step(members, [guard(302, wall.at, { name: 'Sorcerer' })], { raid: { callId: 'x', staged: true, broken: [] as number[] } });
        expect(c.update).toMatchObject({ phase: 'engage', focus: 302, meleeFocus: undefined });
        expect(c.update.reason).not.toContain('melee hold');
        // Travelling: no meleeFocus named, so the board drops it.
        expect('meleeFocus' in step(five(plan.rally)).update).toBe(false);
    });

    const store = getNavmeshStore();
    const meshReady = store.available() && store.at(TH, 33_089, 38_271) !== null;
    test.skipIf(!meshReady)('a wall Wizard on us at the shut gate: the casters take it, the melee hold (R5 meleeReach, live 08:36 the climb); through the broken gate they may', () => {
        const wallSe = FASTE.targets.find(t => t.label === 'wall-se')!;
        const gateOut = { x: 34_650, y: 38_250, z: 3722 };
        const wizard = guard(303, wallSe.at, { name: 'Wizard', target: 'M0', targetId: 10 });
        const shut = step(five(gateOut), [wizard], { raid: { callId: 'x', staged: true, broken: [] as number[] } });
        expect(shut.orders.why).toBe('Wizard is on us');
        expect(shut.orders.ranged.focus?.id).toBe(303);
        expect(shut.update).toMatchObject({ phase: 'engage', focus: 303, meleeFocus: null });
        const open = step(five(gateOut), [wizard], { raid: { callId: 'x', staged: true, broken: [252000301] } });
        expect(open.update).toMatchObject({ phase: 'engage', focus: 303 });
        expect(open.update.meleeFocus).toBeUndefined();
    });
});

describe('raid: decideRvr at the muster\'s go', () => {
    const ctx = (p: GroupPicture, memory: Record<string, any>, orders: Partial<Orders> = {}): CoordinatorContext<RvrSettings> =>
        ({ picture: p, orders: { ...p.orders, ...orders }, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, {} as any) });

    test('at the rally: the raid walks our bridge, not straight at the lord', () => {
        const d = decideRvr(ctx(picture(five(plan.rally)), mustered()));
        expect(d.phase).toBe('travel');
        expect(d.anchor).toMatchObject({ x: plan.route[0]!.x, y: plan.route[0]!.y });
        expect(d.reason).toContain('raid approach');
        expect((d.settings as any)?.raid).toBe(FASTE.keep);
    });

    test('a guard on the board, the raid patch on: engaged by the raid, not walked away from', () => {
        const outer = FASTE.targets.find(t => t.label === 'outer-ne')!;
        const members = five(plan.stage, { inCombat: true });
        const d = decideRvr(ctx(picture(members, [guard(303, outer.at, { targetId: 10, target: 'M0', threat: true })]), mustered(), { settings: { raid: FASTE.keep } }));
        expect(d).toMatchObject({ phase: 'engage', focus: 303 });
    });

    test('no go: no raid, and realmCalls clears the patch', () => {
        const { strategy } = realmCalls({ ...rvrRoamingLike(), decide: decideRvr } as any, 'midgard', { calls: () => [], answer: () => {} });
        const d = strategy.decide(ctx(picture(five(plan.rally)), { realm: 'midgard' }, { settings: { raid: FASTE.keep } }));
        expect(d.settings).toBeNull();
        expect(d.reason).not.toContain('raid');
    });
});

describe('raid: a strategy that sets Orders.settings itself (Hibernia withMakeUp, Camelot withOurMakeUp)', () => {
    const ctx = (p: GroupPicture, memory: Record<string, any>, orders: Partial<Orders> = {}): CoordinatorContext<RvrSettings> =>
        ({ picture: p, orders: { ...p.orders, ...orders }, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, {} as any) });
    const makeUp = { heal: { tank: 90 } };
    const wrapped = (patch: object | null) => ({ ...rvrRoamingLike(), decide: (c: any) => ({ ...decideRvr(c), settings: patch }) });

    test('the raid patch goes on top of theirs, the same object tick to tick; after the go, theirs alone', () => {
        const mem = mustered();
        const { strategy } = realmCalls(wrapped(makeUp) as any, 'hibernia', { calls: () => [go], answer: () => {} });
        const a = strategy.decide(ctx(picture(five(plan.rally)), mem));
        expect(a.settings).toMatchObject({ raid: FASTE.keep, raidDoor: null, heal: { tank: 90 } });
        expect(strategy.decide(ctx(picture(five(plan.rally)), mem)).settings).toBe(a.settings);
        const { strategy: nulled } = realmCalls(wrapped(null) as any, 'hibernia', { calls: () => [go], answer: () => {} });
        expect(nulled.decide(ctx(picture(five(plan.rally)), mustered())).settings).toMatchObject({ raid: FASTE.keep });
        const { strategy: over } = realmCalls(wrapped(makeUp) as any, 'hibernia', { calls: () => [], answer: () => {} });
        expect(over.decide(ctx(picture(five(plan.rally)), { realm: 'midgard' }, { settings: a.settings })).settings).toBe(makeUp);
    });
});

describe('raid: the whole raid from the muster call (run D 04:19: midgard went in alone)', () => {
    const others = (n: number, dx: number) => Array.from({ length: n }, (_, i) => ({ unit: 'midgard-2', x: plan.stage.x + dx + i * 30, y: plan.stage.y, z: plan.stage.z, alive: true }));

    test('raidMembers: ours as they stand, the others from the call; none without the field', () => {
        const ours = five(plan.stage);
        const w = raidMembers({ raid: [...others(3, 8000), { unit: 'midgard', x: 0, y: 0, z: 0, alive: true }] }, 'midgard', ours)!;
        expect(w.length).toBe(8);
        expect(w.filter(m => m.x === 0)).toEqual([]);
        expect(raidMembers({}, 'midgard', ours)).toBeUndefined();
        expect(raidMembers(null, 'midgard', ours)).toBeUndefined();
    });

    test('at the stage with the rest of the raid 8000 out: wait; with it there, or no field: in', () => {
        const outer = FASTE.targets.find(t => t.label === 'outer-armswoman')!;
        const mem = () => ({ raid: { callId: 'x', staged: false, broken: [] as number[] } });
        const run = (call: any) => raidStep({ plan, mem: mem(), members: five(plan.stage), guards: [guard(301, outer.at)], call, unit: 'midgard' }).update;
        expect(run({ raid: others(10, 8000) })).toMatchObject({ phase: 'travel' });
        expect(run({ raid: others(10, 8000) }).reason).toContain('of the raid at the stage');
        expect(run({ raid: others(10, 100) })).toMatchObject({ phase: 'engage', focus: 301 });
        expect(run(undefined)).toMatchObject({ phase: 'engage', focus: 301 });
    });
});

describe('raid: enemy players at the go (attempt 6: the main groups dropped the muster at the first one in sight)', () => {
    const enemyAt = (id: number, dx: number) => contact(id, { kind: 'player', name: 'Briton', realm: 'albion', level: 24, regionId: TH, x: plan.stage.x + dx, y: plan.stage.y, z: plan.stage.z, hp: 90 });
    const rvr = (contacts: Contact[]) => decideRvr({ picture: picture(five(plan.stage), contacts), orders: picture([]).orders, memory: mustered(), now: Date.now(), windingDown: false, settings: mergeSettings(RVR_SETTINGS, {} as any) } as any);
    const pk = (contacts: Contact[]) => decidePack({ picture: picture(five(plan.stage), contacts), orders: picture([]).orders, memory: mustered(), now: Date.now(), windingDown: false, settings: mergeSettings(rvrPack.settings, {} as any) } as any);

    test('decideRvr: one in sight 3000 off is no hunt; the raid goes on. One within RAID_FOE_REACH is fought', () => {
        expect(rvr([enemyAt(901, 3000)]).reason).toContain('raid');
        expect(rvr([enemyAt(901, RAID_FOE_REACH - 300)])).toMatchObject({ phase: 'engage', focus: 901 });
    });

    test('decidePack: the same', () => {
        expect(pk([enemyAt(901, 3000)]).reason).toContain('raid');
        expect(pk([enemyAt(901, RAID_FOE_REACH - 300)]).reason).not.toContain('raid');
    });
});

function rvrRoamingLike() {
    const b = (name: string): Behavior => ({ name, run: () => false });
    return { name: 'x', settings: RVR_SETTINGS, behaviors: { tank: [b('tank'), b('rest')], melee: [b('meleeFight'), b('rest')], healer: [b('heal'), b('rest')], nuker: [b('assist'), b('rest')], support: [b('rest')] } };
}

describe('raid: breakDoor', () => {
    const b = (name: string): Behavior => ({ name, run: () => false });
    const names = (l: Behavior[]) => l.map(x => x.name);

    test('in the tanks\' and melee\'s lists, before their fight; once', () => {
        expect(names(withBreakDoor([b('release'), b('tank'), b('holdFormation')]))).toEqual(['release', 'breakDoor', 'tank', 'holdFormation']);
        expect(names(withBreakDoor(withBreakDoor([b('rest')])))).toEqual(['rest', 'breakDoor']);
        const s = withRaid(rvrRoamingLike() as any);
        expect(names(s.behaviors.melee)).toEqual(['breakDoor', 'meleeFight', 'rest']);
        expect(names(s.behaviors.nuker)).toEqual(['assist', 'rest']);
        expect(names(withRaid({ ...rvrRoamingLike(), memberBehaviors: { tristram: [b('heal'), b('assist')] } } as any).memberBehaviors!.tristram!)).toEqual(['heal', 'breakDoor', 'assist']);
    });

    const door: RaidDoor = { doorId: 252000301, label: 'gate', x: 34_333, y: 38_275, z: 3720, stand: { x: 34_420, y: 38_275, z: 3720 } };
    function fake(o: { role?: string; at?: { x: number; y: number }; door?: RaidDoor | null; objects?: Partial<NearbyObject>[]; onMe?: boolean; attacking?: boolean; target?: number | null } = {}) {
        const log: string[] = [];
        const memory = new Map<string, any>();
        const me = { isDead: false, x: o.at?.x ?? 34_420, y: o.at?.y ?? 38_275, z: 3720, attacking: o.attacking ?? false, targetObjectId: o.target ?? null };
        const ctx: any = {
            memory, name: 'M0', role: o.role ?? 'tank',
            settings: { raidDoor: o.door === undefined ? door : o.door },
            me: () => me,
            orders: () => ({ phase: 'engage' }),
            threats: () => (o.onMe ? [{ target: 'M0' }] : []),
            doing: (kind: string, id: number | null, detail: string) => log.push(`doing ${kind} ${id} ${detail}`),
            result: (kind: string, r: any) => log.push(`result ${kind} ${r.success}`),
            bot: { walkTo: async (x: number, y: number) => { log.push(`walk ${x} ${y}`); return { success: true }; } },
            sdk: {
                getNearbyObjects: () => o.objects ?? [{ objectId: 55, doorId: 252000301, x: 34_333, y: 38_275 }],
                sendSetTarget: async (id: number) => { log.push(`target ${id}`); },
                sendFaceObject: async () => {},
                sendAttack: async (on: boolean) => { log.push(`attack ${on}`); },
            },
        };
        return { ctx, log, memory };
    }

    test('far: walks to the stand; there: targets the door object and swings', async () => {
        const far = fake({ at: { x: 35_500, y: 38_250 } });
        expect(await breakDoor().run(far.ctx)).toBe(true);
        expect(far.log.filter(l => l.startsWith('walk'))).toEqual(['walk 34420 38275']);
        const near = fake();
        expect(await breakDoor().run(near.ctx)).toBe(true);
        expect(near.log.slice(1)).toEqual(['target 55', 'attack true']);
    });

    test('nothing without a door in the orders, or with something on us; a swing on the door stops when the orders drop it', async () => {
        expect(await breakDoor().run(fake({ door: null }).ctx)).toBe(false);
        expect(await breakDoor().run(fake({ onMe: true }).ctx)).toBe(false);
        expect(await breakDoor().run(fake({ role: 'nuker' }).ctx)).toBe(false);
        const f = fake({ door: null, attacking: true, target: 55 });
        f.memory.set('doorOn', 55);
        expect(await breakDoor().run(f.ctx)).toBe(false);
        expect(f.log).toEqual(['attack false']);
    });
});

describe('raid: units on their way, and squads that do not lead (S3, 2026-11-13)', () => {
    const unit = (name: string, n: number, at: { x: number; y: number }, over: object = {}) => Array.from({ length: n }, (_, i) => ({ unit: name, x: at.x + i * 30, y: at.y, z: 3000, alive: true, ...over }));
    const far = { x: plan.stage.x + 20_000, y: plan.stage.y };

    test('a unit on its way counts at any distance: at the stage, wait for it; one that stopped closing does not hold us', () => {
        const outer = FASTE.targets.find(t => t.label === 'outer-armswoman')!;
        const mem = () => ({ raid: { callId: 'x', staged: false, broken: [] as number[] } });
        const run = (raid: any[]) => raidStep({ plan, mem: mem(), members: five(plan.stage), guards: [guard(301, outer.at)], call: { raid }, unit: 'midgard' }).update;
        expect(run(unit('midgard-2', 6, far, { onWay: true })).reason).toContain('of the raid at the stage');
        expect(run(unit('midgard-2', 6, far))).toMatchObject({ phase: 'engage', focus: 301 });
        const w = raidMembers({ raid: unit('midgard-2', 1, far, { onWay: true }) }, 'midgard', [], plan.stage)!;
        expect(Math.hypot(w[0]!.x - plan.stage.x, w[0]!.y - plan.stage.y)).toBeLessThan(12_000);
    });

    test('squadHold: the last approach waypoint 3000 or more from the stage', () => {
        for (const realm of ['albion', 'midgard', 'hibernia'] as const) {
            const p = raidPlan(realm)!;
            const h = squadHold(p);
            expect(Math.hypot(h.x - p.stage.x, h.y - p.stage.y)).toBeGreaterThanOrEqual(3000);
        }
        expect(squadHold(raidPlan('hibernia')!)).toMatchObject({ x: 34500, y: 35200 });
    });

    test('a squad waits at the hold while a main group is on its way behind it; goes once one passed it, or with no main group coming', () => {
        const hold = squadHold(plan);
        const behind = unit('midgard', 6, { x: plan.rally.x + 3000, y: plan.rally.y }, { onWay: true });
        expect(squadWait(plan, { raid: behind }, 'midgard-s1')).toMatchObject({ hold });
        expect(squadWait(plan, { raid: unit('midgard', 6, plan.stage) }, 'midgard-s1')).toBeNull();
        expect(squadWait(plan, { raid: unit('midgard', 6, far) }, 'midgard-s1')).toBeNull();          // not on its way
        expect(squadWait(plan, { raid: unit('midgard-s2', 2, far, { onWay: true }) }, 'midgard-s1')).toBeNull();   // only squads
        // raidStep: a squad of two past the hold walks back to it and waits.
        const mem = { raid: { callId: 'x', staged: false, broken: [] as number[] } };
        const two = five(plan.stage).slice(0, 2);
        const u = raidStep({ plan, mem, members: two, guards: [], call: { raid: behind }, unit: 'midgard-s1' }).update;
        expect(u).toMatchObject({ phase: 'recover', anchor: { x: hold.x, y: hold.y } });
        expect(u.reason).toContain('squad waits for midgard');
    });
});

describe('raid: rez across the raid\'s units (S3, 2026-11-13)', () => {
    test('raidRez: other units\' rezzers alive and their dead, by id; none of ours; null without any', () => {
        const raid = [
            { unit: 'midgard', x: 0, y: 0, z: 0, alive: true, id: 1, rez: true, name: 'Ours', level: 24 },
            { unit: 'midgard-2', x: 0, y: 0, z: 0, alive: true, id: 7, rez: true, name: 'Eir', level: 24 },
            { unit: 'midgard-2', x: 0, y: 0, z: 0, alive: false, id: 5, rez: true, name: 'Groa', level: 24 },
            { unit: 'midgard-s1', x: 0, y: 0, z: 0, alive: false, id: 9, name: 'Leif', level: 23 },
        ];
        expect(raidRez({ raid }, 'midgard')).toEqual({ rezzers: [7], corpses: [{ id: 5, name: 'Groa', level: 24 }, { id: 9, name: 'Leif', level: 23 }] });
        expect(raidRez({ raid: raid.slice(0, 1) }, 'midgard')).toBeNull();
        // The patch keeps one object while the ids don't change.
        const r = { callId: 'x', staged: false, broken: [] as number[] };
        const o = { melee: { step: null } } as any;
        const a = raidPatch(r, FASTE.keep, o, raidRez({ raid }, 'midgard'));
        expect(raidPatch(r, FASTE.keep, o, raidRez({ raid: raid.map(m => ({ ...m, x: 100 })) }, 'midgard'))).toBe(a);
        expect(raidPatch(r, FASTE.keep, o, null)).not.toBe(a);
    });

    test('raidRezzerNear and raidCorpses read what our client sees', () => {
        const objs: Record<number, any> = { 7: { kind: 'player', isDead: false, x: 1000, y: 0, name: 'Eir' }, 5: { kind: 'player', isDead: true, x: 300, y: 0, z: 10 }, 9: null };
        const sdk = { getObject: (id: number) => objs[id] ?? null };
        const rr = { rezzers: [7], corpses: [{ id: 5, name: 'Groa', level: 24 }, { id: 9, name: 'Leif', level: 23 }] };
        expect(raidRezzerNear(sdk, rr, { x: 0, y: 0 }, 4000)).toBe('Eir');
        expect(raidRezzerNear(sdk, rr, { x: 0, y: 0 }, 500)).toBeUndefined();
        expect(raidRezzerNear(sdk, null, { x: 0, y: 0 }, 4000)).toBeUndefined();
        const cs = raidCorpses(sdk, rr, 252);
        expect(cs.map(c => [c.name, c.objectId, c.isDead, c.x])).toEqual([['Groa', 5, true, 300]]);
    });
});

describe('raid: the way on from the member furthest along (S3, live 15:18: a formation trailing its anchor never reached it)', () => {
    test('the tank at the waypoint and the casters 900 behind: on to the next waypoint', () => {
        const way = [plan.rally, ...plan.route];
        const wp = way[1]!, prev = way[0]!;
        const back = { x: wp.x + (prev.x - wp.x) * 0.9, y: wp.y + (prev.y - wp.y) * 0.9, z: wp.z };
        const members = five(back);
        members[0] = { ...members[0]!, x: wp.x + 20, y: wp.y };
        const mem = { raid: { callId: 'x', staged: false, broken: [] as number[] } };
        const u = raidStep({ plan, mem, members, guards: [], call: null, unit: 'midgard' }).update;
        expect(u.anchor).toMatchObject({ x: way[2]!.x, y: way[2]!.y });
    });
});

describe('raid: a pack fresh from its bind finishes its rebuff before the go (the user at 16:27: "running to the Faste without buffing first")', () => {
    const buffer = (members: MemberReport[]) => members.map((m, i) => i === 2 ? { ...m, capabilities: { ...m.capabilities, buffSpells: [{ name: 'Strength', slot: 'str' as any, target: 'Realm', concentration: 5 }] } } : m);
    const pk = (memory: Record<string, any>, members: MemberReport[], now: number) => decidePack({ picture: { ...picture(members, []), at: now }, orders: picture([]).orders, memory, now, windingDown: false, settings: mergeSettings(rvrPack.settings, {} as any) } as any);
    const home = { x: 21_000, y: 27_000, z: 3000 };
    test('within the rebuff\'s minimum, or with a buff owed (up to 60 s): rebuffing; then the raid', () => {
        const now = 1_000_000;
        expect(pk({ ...mustered(), pack: 'rebuff', rebuffAt: now - 5_000 }, five(home), now).reason).toMatch(/^rebuffing/);
        expect(pk({ ...mustered(), pack: 'rebuff', rebuffAt: now - 25_000 }, buffer(five(home)), now).reason).toMatch(/^rebuffing.*buffs? to go \(Strength/);
        expect(pk({ ...mustered(), pack: 'rebuff', rebuffAt: now - 25_000 }, five(home), now).reason).toMatch(/^raid/);
        expect(pk({ ...mustered(), pack: 'rebuff', rebuffAt: now - 70_000 }, buffer(five(home)), now).reason).toMatch(/^raid/);
    });
});
