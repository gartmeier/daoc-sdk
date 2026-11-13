import { describe, expect, test } from 'bun:test';
import { makePlayer, makePlayerObj, makeState } from '../test/fixtures';
import type { CombatEvent } from '../types';
import { Blackboard, observeState } from './blackboard';
import { contact, enemy, picture, report } from './fixtures';
import type { RunReport } from './observer';
import { memoryView } from './publish';
import { BATTLEGROUND_LAYOUTS, decideRvr, defaultPatrol, holdObservedFar, homeOf, keepDangers, pickRvrFocus, realmCalls, RVR_SETTINGS, rvrFindings, rvrRoaming, stepLeg, type RvrSettings } from './rvr';
import type { RealmCall } from './tactics/help';
import { countFor } from './size';
import { mergeSettings, type CoordinatorContext } from './strategy';
import { aggroZones, safePath } from './terrain';
import { getTerrainStore } from '../terrain';
import { isDry, isWet } from './water';
import type { Contact, GroupPicture, MemberReport, Orders, Point, Role } from './types';

// Region 9999 has no spawns and no battleground: no aggro zones, keeps or home get in the way.
const R = 9999;
const BASE = { x: 10_000, y: 10_000, z: 0 };
const LOOP = [{ x: 10_000, y: 10_000, z: 0 }, { x: 13_000, y: 10_000, z: 0 }, { x: 13_000, y: 13_000, z: 0 }];
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [], buffSpells: [] });

/** A Hibernian group of five round `base` (Tank on it, the others up to 500 behind): centre (base.x - 320, base.y). */
function team(over: Partial<Record<string, Partial<MemberReport>>> = {}, base: Point = BASE, regionId = R): MemberReport[] {
    const at = (dx: number, dy: number) => ({ regionId, x: base.x + dx, y: base.y + dy, level: 20 });
    return [
        report('Tank', { role: 'tank', className: 'Hero', objectId: 1, mana: 0, capabilities: caps(false, false, false), ...at(0, 0), ...over.Tank }),
        report('Druid', { role: 'healer', className: 'Druid', objectId: 2, capabilities: caps(true, false, false), ...at(-300, 200), ...over.Druid }),
        report('Bard', { role: 'support', className: 'Bard', objectId: 3, capabilities: caps(true, true, true), ...at(-300, -200), ...over.Bard }),
        report('Menta', { role: 'nuker', className: 'Mentalist', objectId: 4, capabilities: caps(true, true, true), ...at(-500, 300), ...over.Menta }),
        report('Encha', { role: 'nuker', className: 'Enchanter', objectId: 5, capabilities: caps(false, true, true), ...at(-500, -300), ...over.Encha }),
    ];
}

/** The tests exercise the retreat mechanics at margin 2 (seven enemies against five); the tuned default is pinned in its own test. */
const MARGIN_2 = { margin: 2 };

function ctx(p: GroupPicture, opts: { orders?: Partial<Orders>; memory?: Record<string, any>; settings?: Record<string, unknown>; now?: number; windingDown?: boolean } = {}): CoordinatorContext<RvrSettings> {
    const over = opts.settings ?? {};
    return {
        picture: p, orders: { ...p.orders, ...opts.orders }, memory: opts.memory ?? {}, now: opts.now ?? p.at, windingDown: opts.windingDown ?? false,
        settings: mergeSettings(RVR_SETTINGS, { patrol: LOOP, ...over, retreat: { ...MARGIN_2, ...(over.retreat as object | undefined) } } as any),
    };
}

const foe = (id: number, over: Parameters<typeof enemy>[2] = {}) => enemy(id, 'midgard', { regionId: R, x: 11_000, y: 10_000, ...over });

describe('decideRvr: patrol, hunt, regroup', () => {
    test('patrols the loop in legs, on to the next waypoint once everyone stands at it, and round again', () => {
        const memory: Record<string, any> = {};
        const step = (base: Point) => decideRvr(ctx(picture(team({}, base)), { memory }));
        let d = step(BASE);
        expect(d.phase).toBe('travel');
        expect(d.anchor).toMatchObject({ x: 10_000, y: 10_000 });   // the nearest waypoint first
        d = step(BASE);
        expect(d.anchor).toMatchObject({ x: 11_500, y: 10_000 });   // there: a leg of travelLeg toward the next one
        expect(d.reason).toContain('waypoint 2/3');
        expect(step(BASE).anchor).toMatchObject({ x: 11_500, y: 10_000 });   // a leg is kept until the group reached it
        expect(step({ x: 11_500, y: 10_000 }).anchor).toMatchObject({ x: 13_000, y: 10_000 });
        expect(step({ x: 13_000, y: 10_000 }).anchor).toMatchObject({ x: 13_000, y: 11_500 });
        expect(step({ x: 13_000, y: 11_500 }).anchor).toMatchObject({ x: 13_000, y: 13_000 });
        d = step({ x: 13_000, y: 13_000 });
        expect(d.reason).toContain('waypoint 1/3');
        expect(d.anchor).toMatchObject({ x: 11_939, y: 11_939 });
        // The viewer draws the leg, the remaining route and the waypoint.
        const view = memoryView(memory);
        expect(view?.leg).toMatchObject({ x: 11_939, y: 11_939 });
        expect(view?.route.at(-1)).toMatchObject({ x: 10_000, y: 10_000 });
        expect(view?.camp?.names).toBe('patrol waypoint 1/3');
    });

    test('hunts enemy players beyond engageRadius in legs, re-planned when they move', () => {
        const memory: Record<string, any> = {};
        // Centre (9680, 10000); the enemy 4000 east.
        let d = decideRvr(ctx(picture(team(), [foe(51, { x: 13_680 })]), { memory }));
        expect(d.phase).toBe('travel');
        expect(d.objective).toContain('hunt 1 enemy');
        expect(d.anchor).toMatchObject({ x: 11_180, y: 10_000 });
        d = decideRvr(ctx(picture(team(), [foe(51, { x: 13_680, y: 10_400 })]), { memory }));
        expect(d.anchor).toMatchObject({ x: 11_180, y: 10_000 });   // moved 400: the leg holds
        d = decideRvr(ctx(picture(team(), [foe(51, { x: 13_680, y: 11_000 })]), { memory }));
        expect(d.anchor!.y).toBeGreaterThan(10_200);                // moved 1000: toward where it is now
    });

    test('no hunt while two members are not ready, and a fall-back when the group in sight is larger', () => {
        let d = decideRvr(ctx(picture(team({ Druid: { hp: 50 }, Menta: { mana: 20 } }), [foe(51, { x: 13_680 })])));
        expect(d.phase).toBe('recover');
        expect(d.waiting).toEqual([{ name: 'Druid', why: 'health' }, { name: 'Menta', why: 'power' }]);
        const seven = [60, 61, 62, 63, 64, 65, 66].map(id => foe(id, { x: 13_680 }));
        d = decideRvr(ctx(picture(team(), seven)));
        expect(d.phase).toBe('travel');
        expect(d.objective).toContain('fall back');
        expect(d.anchor!.x).toBeLessThan(9680);
    });

    test('waits for a dead member to release, then meets a far one halfway in legs', () => {
        let d = decideRvr(ctx(picture(team({ Bard: { isDead: true, hp: 0 } }))));
        expect(d.phase).toBe('recover');
        expect(d.waiting).toEqual([{ name: 'Bard', why: 'dead' }]);
        // Released at the portal keep, 8000 east of the others (their centre (9725, 10075)).
        const memory: Record<string, any> = {};
        d = decideRvr(ctx(picture(team({ Encha: { x: 18_000, y: 10_000 } })), { memory }));
        expect(d.phase).toBe('gather');
        expect(d.waiting).toEqual([{ name: 'Encha', why: 'away' }]);
        expect(d.anchor!.x).toBeCloseTo(11_225, -1);
        const first = d.anchor!;
        // The others reached the leg, Encha walked 2000 toward them: the next leg goes on from this one.
        d = decideRvr(ctx(picture(team({ Encha: { x: 16_000, y: 10_000 } }, first)), { memory }));
        expect(d.phase).toBe('gather');
        expect(Math.hypot(d.anchor!.x - first.x, d.anchor!.y - first.y)).toBeCloseTo(1500, -1);
        // Under two legs apart (2875 from the others' centre): the leg stops halfway, both sides meet there.
        d = decideRvr(ctx(picture(team({ Encha: { x: 14_500, y: 10_000 } }, { x: 11_900, y: 10_000 }))));
        expect(d.phase).toBe('gather');
        expect(d.anchor!.x).toBeCloseTo(13_062, -1);
        d = decideRvr(ctx(picture(team({ Encha: { x: 13_500, y: 10_000 } }, d.anchor!)), { memory }));
        expect(d.phase).toBe('travel');
    });

    test('a member in another region (released to its bind point) never holds the group up', () => {
        const d = decideRvr(ctx(picture(team({ Encha: { regionId: 1, x: 500_000, hp: 30 } }))));
        expect(d.phase).toBe('travel');
        expect(d.objective).toContain('missing Encha (region 1)');
    });

    test('a still observed member (a human) just past the gather radius: the group goes all the way to it, and does not flip between gather and patrol', () => {
        // Live 2026-11-11 18:41: Galahad stood at the portal keep 2700 off. The group switched between "gather: meeting Galahad" and
        // "patrol" every second (60 times in 2.5 min): half a leg toward him put him inside the radius, and the patrol walked it out again.
        const human = report('Vue', { role: 'melee', className: 'Paladin', objectId: 9, regionId: R, x: 10_000, y: 13_100, level: 20, bot: '', observed: true });
        const memory: Record<string, any> = {};
        let base: Point = BASE;
        const phases: string[] = [];
        let metAt: number | null = null;
        for (let i = 0; i < 12; i++) {
            const d = decideRvr(ctx(picture([...team({}, base), human]), { memory }));
            phases.push(d.phase);
            if (d.phase === 'travel' && metAt === null) metAt = Math.hypot(base.x - 320 - human.x, base.y - human.y);
            if (d.anchor) base = { x: d.anchor.x + 320, y: d.anchor.y };   // the bots reach each leg (centre 320 behind the tank)
        }
        expect(phases[0]).toBe('gather');
        expect(metAt).not.toBeNull();
        expect(metAt!).toBeLessThanOrEqual(2500 * 0.5 + 1);
        // Never back to gather the tick after a patrol: once met, the patrol goes on until the group is really away again.
        for (let i = 2; i < phases.length; i++) expect(`${phases[i - 2]}>${phases[i - 1]}>${phases[i]}`).not.toBe('gather>travel>gather');
        expect(memory.gatherObserved).toBeUndefined();
    });

    test('no observed member: holdObservedFar returns the split as it is and leaves the memory alone', () => {
        const members = team({ Encha: { x: 18_000, y: 10_000 } });
        const split = { main: members.slice(0, 4), far: members.slice(4) };
        const memory: Record<string, any> = {};
        expect(holdObservedFar(split, 2500, memory)).toBe(split);
        expect(memory).toEqual({});
    });

    test('winding down: nothing new (no patrol, no fresh enemy), but a fight with an attacker goes on', () => {
        let d = decideRvr(ctx(picture(team(), [foe(51)]), { windingDown: true }));
        expect(d.phase).toBe('recover');
        expect(d.reason).toContain('time is up');
        d = decideRvr(ctx(picture(team(), [foe(51, { threat: true, target: 'Tank', targetId: 1 })]), { windingDown: true }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
    });
});

describe('decideRvr: fights', () => {
    test('engages an enemy player within engageRadius of the group, says whom and the odds', () => {
        const d = decideRvr(ctx(picture(team(), [foe(51, { x: 11_500, hp: 60, level: 21 })])));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        expect(d.puller).toBeNull();
        expect(d.anchor).toMatchObject({ x: 9680, y: 10_000 });
        expect(d.reason).toBe('fight Norseman#51 (midgard L21, 60%): 1 enemy vs 5');
    });

    test('a focus whose health stands still 20 s is a phantom: left alone for 2 minutes (arena round 33: 70 s on a Norseman nobody saw)', () => {
        const memory: Record<string, any> = {};
        const ghost = foe(51, { x: 11_500, hp: 100 });
        const at = (t: number, orders: Partial<Orders> = { phase: 'engage', focus: 51 }) => decideRvr(ctx(picture(team(), [ghost]), { memory, orders, now: t }));
        expect(at(1000).focus).toBe(51);
        expect(at(15_000).focus).toBe(51);
        expect(at(21_500).phase).not.toBe('engage');
        expect(at(60_000, { phase: 'travel', focus: null }).phase).not.toBe('engage');
        // A real one loses health: it stays the focus.
        const m2: Record<string, any> = {};
        expect(decideRvr(ctx(picture(team(), [ghost]), { memory: m2, orders: { phase: 'engage', focus: 51 }, now: 1000 })).focus).toBe(51);
        expect(decideRvr(ctx(picture(team(), [{ ...ghost, hp: 80 }]), { memory: m2, orders: { phase: 'engage', focus: 51 }, now: 22_000 })).focus).toBe(51);
    });

    test('focus: a healer before a caster before a hurt fighter', () => {
        const healer = foe(51, { healer: true }), caster = foe(52, { caster: true }), hurt = foe(53, { hp: 40 });
        expect(decideRvr(ctx(picture(team(), [hurt, caster, healer]))).focus).toBe(51);
        expect(decideRvr(ctx(picture(team(), [hurt, caster]))).focus).toBe(52);
        expect(decideRvr(ctx(picture(team(), [hurt, foe(54)]))).focus).toBe(53);
    });

    test('keeps the focus, but switches to an enemy below switchBelow while the focus is above it + 20', () => {
        const orders = { phase: 'engage' as const, focus: 53 };
        expect(decideRvr(ctx(picture(team(), [foe(51, { healer: true }), foe(53, { hp: 80 })], orders))).focus).toBe(53);
        expect(decideRvr(ctx(picture(team(), [foe(53, { hp: 80 }), foe(54, { hp: 20 })], orders))).focus).toBe(54);
        expect(decideRvr(ctx(picture(team(), [foe(53, { hp: 40 }), foe(54, { hp: 20 })], orders))).focus).toBe(53);
    });

    test('mezzes the other enemies (the support first), never one already controlled', () => {
        let d = decideRvr(ctx(picture(team(), [foe(51, { healer: true }), foe(52)])));
        expect(d.focus).toBe(51);
        expect(d.cc).toEqual([{ targetId: 52, by: 'Bard' }]);
        d = decideRvr(ctx(picture(team(), [foe(51, { healer: true }), foe(52, { cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 20_000 } })])));
        expect(d.cc).toEqual([]);
        // Immune to crowd control for now (a member's mezz got "immune to this effect"): nobody is sent at it.
        d = decideRvr(ctx(picture(team(), [foe(51, { healer: true }), foe(52, { ccImmune: { mezz: Date.now() + 30_000, root: Date.now() + 30_000 } })])));
        expect(d.cc).toEqual([]);
    });

    test('the default margin is 3 at five (round 6): seven against five is a fight, eight a retreat', () => {
        expect(countFor(RVR_SETTINGS.retreat.margin, 5)).toBe(3);
        for (const margin of [3, RVR_SETTINGS.retreat.margin]) {
            const tuned = (n: number) => decideRvr(ctx(picture(team(), Array.from({ length: n }, (_, i) => foe(60 + i))), { settings: { retreat: { margin } } }));
            expect(tuned(7).phase).toBe('engage');
            expect(tuned(8).phase).toBe('retreat');
        }
    });

    test('the margin grows with the group (size.ts): at eight, 12 against 8 is a fight, 13 a retreat; a number stays that number', () => {
        const eight = [...team(), ...team().slice(0, 3).map((m, i) => ({ ...m, name: `${m.name}${i}`, objectId: 10 + i }))];
        const run = (n: number, margin?: number) => decideRvr(ctx(picture(eight, Array.from({ length: n }, (_, i) => foe(60 + i))), { settings: { retreat: { margin: margin ?? RVR_SETTINGS.retreat.margin } } }));
        expect(run(12).phase).toBe('engage');
        expect(run(13).phase).toBe('retreat');
        expect(run(11, 3).phase).toBe('retreat');
    });

    test('retreats when outnumbered by retreat.margin, not while the focus is nearly dead; caught after maxMs, it fights', () => {
        const now = Date.now();
        const seven = (hp0: number) => [60, 61, 62, 63, 64, 65, 66].map(id => foe(id, { x: 11_500, hp: id === 60 ? hp0 : 100 }));
        const memory: Record<string, any> = {};
        let d = decideRvr(ctx(picture(team(), seven(100), {}, now), { memory }));
        expect(d.phase).toBe('retreat');
        expect(d.reason).toBe('retreat: 7 enemies vs 5');
        expect(d.retreatTo).toMatchObject({ x: 6680, y: 10_000 });   // away from them: no home outside a battleground
        expect(decideRvr(ctx(picture(team(), seven(15), { phase: 'engage', focus: 60 }, now))).phase).toBe('engage');
        // Six of them still within engageRadius: keep running until maxMs, then stand.
        const orders = { phase: 'retreat' as const, retreatTo: d.retreatTo!, reason: d.reason };
        d = decideRvr(ctx(picture(team(), seven(100), orders, now + 5000), { memory, orders, now: now + 5000 }));
        expect(d.phase).toBe('retreat');
        d = decideRvr(ctx(picture(team(), seven(100), orders, now + 25_000), { memory, orders, now: now + 25_000 }));
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain('caught: ');
    });

    test('fights a monster attacking us only while no enemy player is a candidate; ignores one fighting someone else', () => {
        const boar = contact(70, { regionId: R, name: 'mature boar', level: 24, x: 10_200, y: 10_000, threat: true, target: 'Tank', targetId: 1 });
        let d = decideRvr(ctx(picture(team(), [boar])));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(70);
        expect(d.reason).toContain('1 attacking');
        expect(decideRvr(ctx(picture(team(), [boar, foe(51)]))).focus).toBe(51);
        d = decideRvr(ctx(picture(team(), [{ ...boar, target: null, targetId: 999 }])));
        expect(d.phase).toBe('travel');
    });

    test('measures from the main body: a member walking back from the portal keep moves neither the fight nor the hunt', () => {
        // Encha 15k west; the other four's centre is (9725, 10075), all five's (6780, 10060).
        const memory: Record<string, any> = {};
        const far = { Encha: { x: -5000, y: 10_000 } };
        let d = decideRvr(ctx(picture(team(far), [foe(51, { x: 11_200 })]), { memory }));   // 1500 from the Tank
        expect(d.phase).toBe('engage');
        expect(d.anchor).toMatchObject({ x: 9725, y: 10_075 });
        expect(d.reason).toContain('1 enemy vs 4');
        // A fight under way when a member releases keeps its anchor.
        const orders = { phase: 'engage' as const, focus: 51 };
        decideRvr(ctx(picture(team(), [foe(51, { x: 11_200 })], orders), { memory }));
        d = decideRvr(ctx(picture(team(far), [foe(51, { x: 11_200 })], orders), { memory }));
        expect(d.anchor).toMatchObject({ x: 9725, y: 10_075 });
        // The far member gets no mezz to cast.
        d = decideRvr(ctx(picture(team({ Bard: { x: -5000, y: 10_000 } }), [foe(51, { healer: true }), foe(52)])));
        expect(d.cc).toEqual([{ targetId: 52, by: 'Menta' }]);
        // The hunt is planned from the main body, and its legs don't wait for the far member.
        const hunt: Record<string, any> = {};
        const prey = foe(51, { x: 14_600, y: 10_075 });
        d = decideRvr(ctx(picture(team(far), [prey]), { memory: hunt }));
        expect(d.objective).toContain('hunt 1 enemy');
        expect(d.anchor).toMatchObject({ x: 11_225, y: 10_075 });
        d = decideRvr(ctx(picture(team(far, { x: 11_500, y: 10_000 }), [prey]), { memory: hunt }));
        expect(d.anchor).toMatchObject({ x: 12_725, y: 10_075 });
    });

    test('the main body is where the fight is: two members under attack outrank three released to the portal keep', () => {
        // Live run 20261101-084333: the three at the keep got the mezzes on enemies 16k away (cc: not_found, 59x).
        const keep = { x: -6000, y: 10_000 };
        const released = { Druid: keep, Bard: { x: -6100, y: 10_000 }, Menta: { x: -6000, y: 10_100 } };
        const onTank = foe(51, { x: 10_150, target: 'Tank', targetId: 1, threat: true });
        const onEncha = foe(52, { x: 9_700, y: 9_700, target: 'Encha', targetId: 5, threat: true });
        const d = decideRvr(ctx(picture(team(released), [onTank, onEncha])));
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain('vs 2');
        expect(d.anchor).toMatchObject({ x: 9750, y: 9850 });
        expect(d.cc).toEqual([{ targetId: d.focus === 51 ? 52 : 51, by: 'Encha' }]);
    });

    test('counts the enemies against us per realm: two realms fighting each other are not one group, a mezzed enemy does not count', () => {
        const alb = (id: number, over: Parameters<typeof enemy>[2] = {}) => enemy(id, 'albion', { regionId: R, x: 11_500, y: 10_000, ...over });
        const albs = [10, 11, 12, 13, 14].map(id => alb(id));
        const mids = [20, 21, 22, 23, 24].map(id => foe(id, { x: 11_700 }));
        let d = decideRvr(ctx(picture(team(), [...albs, ...mids])));
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain(': 5 of 10 enemies vs 5');
        d = decideRvr(ctx(picture(team(), [...albs.map(c => ({ ...c, x: 13_600 })), ...mids.map(c => ({ ...c, x: 13_800 }))])));
        expect(d.objective).toContain('hunt 10 enemies');
        // Seven Albions hitting Midgard players are busy; two free Midgard players are what we face.
        const busy = [10, 11, 12, 13, 14, 15, 16].map(id => alb(id, { targetId: 20 }));
        d = decideRvr(ctx(picture(team(), [...busy, ...mids.slice(0, 2)])));
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain(': 2 of 9 enemies vs 5');
        // Five free Albions and two Midgard players on us: seven against us.
        d = decideRvr(ctx(picture(team(), [...albs, foe(20, { target: 'Tank', targetId: 1 }), foe(21, { target: 'Druid', targetId: 2 })])));
        expect(d.reason).toBe('retreat: 7 enemies vs 5');
        // Seven, three of them mezzed: four against us.
        const mezz = { by: 'Bard', kind: 'mezz', until: Date.now() + 20_000 };
        d = decideRvr(ctx(picture(team(), [60, 61, 62, 63, 64, 65, 66].map(id => foe(id, { x: 11_500, cc: id < 63 ? mezz : null })))));
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain(': 4 of 7 enemies vs 5');
    });
});

const albion = (id: number, over: Parameters<typeof enemy>[2] = {}) => enemy(id, 'albion', { regionId: R, x: 11_500, y: 10_000, ...over });
const gap = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('decideRvr: the chase leash', () => {
    const LEASH = RVR_SETTINGS.chaseLeash!;

    test('a focus beyond chaseLeash of the anchor moves the anchor toward it, only once it crosses the leash', () => {
        // Centre (9680, 10000); the Norseman 2320 east of it, beyond the leash: tank and melee would stand idle.
        const memory: Record<string, any> = {};
        let d = decideRvr(ctx(picture(team(), [foe(51, { x: 12_000 })]), { memory }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        expect(d.anchor).toMatchObject({ x: 10_800, y: 10_000 });   // leaves it 1200 away (LEASH_FIT)
        const orders = { phase: 'engage' as const, focus: 51, anchor: d.anchor! };
        // 500 farther, still within the leash: the anchor stays.
        d = decideRvr(ctx(picture(team(), [foe(51, { x: 12_500 })], orders), { memory }));
        expect(d.anchor).toEqual(orders.anchor);
        // Beyond it again: on toward it, but at most FIGHT_DRIFT (1500) from the centre.
        d = decideRvr(ctx(picture(team(), [foe(51, { x: 13_100 })], orders), { memory }));
        expect(d.focus).toBe(51);
        expect(d.anchor).toMatchObject({ x: 11_180, y: 10_000 });
        expect(13_100 - d.anchor!.x).toBeLessThanOrEqual(LEASH);
    });

    test('a healer beyond the leash is still the focus, within reach of the new anchor; backing off, it is let go for the enemy on our tank', () => {
        const onTank = foe(51, { x: 10_150, target: 'Tank', targetId: 1, threat: true });
        const healer = foe(52, { x: 11_980, healer: true });
        const memory: Record<string, any> = {};
        let d = decideRvr(ctx(picture(team(), [onTank, healer]), { memory }));
        expect(d.focus).toBe(52);
        expect(gap(d.anchor!, healer)).toBeLessThanOrEqual(LEASH);
        const orders = { phase: 'engage' as const, focus: 52, anchor: d.anchor! };
        // 2120 from the anchor while the other one hits our tank: tank and melee get that one instead of nothing.
        d = decideRvr(ctx(picture(team(), [onTank, { ...healer, x: 12_900 }], orders), { memory }));
        expect(d.focus).toBe(51);
        expect(d.anchor).toEqual(orders.anchor);
    });

    test('with the default settings, every focus the fight keeps lies within chaseLeash of the anchor it issues', () => {
        const centre = { x: 9680, y: 10_000 };
        for (let a = 0; a < 8; a++) {
            const u = { x: Math.cos(a * Math.PI / 4), y: Math.sin(a * Math.PI / 4) };
            // The anchor on the centre, or left behind on the far side (it moves back only past FIGHT_DRIFT).
            for (const lag of [0, 1400]) {
                const anchor = { x: Math.round(centre.x - u.x * lag), y: Math.round(centre.y - u.y * lag), z: 0 };
                for (let r = 500; r <= RVR_SETTINGS.engageRadius + 1000; r += 250) {
                    const it = foe(51, { x: centre.x + u.x * r, y: centre.y + u.y * r });
                    const d = decideRvr(ctx(picture(team(), [it], { phase: 'engage', focus: 51, anchor }), { memory: { fightAnchor: anchor } }));
                    expect(d.focus).toBe(51);
                    expect(gap(d.anchor!, it)).toBeLessThanOrEqual(LEASH + 1);
                    expect(gap(d.anchor!, centre)).toBeLessThanOrEqual(1501);
                }
            }
        }
    });

    test('pickRvrFocus: an enemy within reach before an equal one beyond it, a healer beyond it before a fighter within', () => {
        const centre = { x: 9680, y: 10_000 };
        const opts = { centre, members: team(), settings: RVR_SETTINGS };
        const near = foe(51, { x: 10_000 }), far = foe(52, { x: 11_500 });
        expect(pickRvrFocus([near, far], opts)?.objectId).toBe(51);
        expect(pickRvrFocus([near, far], { ...opts, reach: (c: Contact) => c.objectId === 52 })?.objectId).toBe(52);
        expect(pickRvrFocus([near, { ...far, healer: true }], { ...opts, reach: (c: Contact) => c.objectId === 51 })?.objectId).toBe(52);
    });
});

describe('decideRvr: softFocus', () => {
    const soft = { softFocus: { reach: 1500, healedBy: 30, droppedMs: 15_000 } };

    test('off: a healer goes first; on: the nearest other enemy does', () => {
        const foes = [foe(51, { x: 10_400, healer: true }), foe(52, { x: 10_800 })];
        expect(decideRvr(ctx(picture(team(), foes))).focus).toBe(51);
        expect(decideRvr(ctx(picture(team(), foes), { settings: soft })).focus).toBe(52);
    });

    test('on: the mezz goes on a known healer before a fighter', () => {
        const foes = [foe(51, { x: 10_300 }), foe(52, { x: 10_900 }), foe(53, { x: 10_900, y: 10_300, healer: true })];
        const one = team({ Bard: { capabilities: caps(true, false, true) }, Encha: { capabilities: caps(false, false, true) } });
        expect(decideRvr(ctx(picture(one, foes), { settings: soft })).cc).toEqual([{ targetId: 53, by: 'Menta' }]);
    });

    test('a focus healed 30 above its lowest is given up for droppedMs, then may come back', () => {
        const memory: Record<string, any> = { lowHp: { 51: 20 } };
        const foes = [foe(51, { x: 10_400, hp: 60 }), foe(52, { x: 10_800, hp: 100 })];
        const orders = { phase: 'engage', focus: 51 } as Partial<Orders>;
        const now = picture(team(), foes).at;
        expect(decideRvr(ctx(picture(team(), foes), { settings: soft, memory, orders, now })).focus).toBe(52);
        expect(memory.dropped[51]).toBe(now + 15_000);
        expect(decideRvr(ctx(picture(team(), foes), { memory: { lowHp: { 51: 20 } }, orders, now })).focus).toBe(51);
    });
});

describe('decideRvr: a member attacked away from the main body', () => {
    // Encha 15k west, walking back from the portal keep; the other four's centre is (9725, 10075).
    const far = { Encha: { x: -5000, y: 10_000 } };

    test('it fights or flees by itself: the four stay the main body and fight the enemy near them', () => {
        const boar = contact(70, { regionId: R, name: 'mature boar', level: 24, x: -4900, y: 10_000, threat: true, target: 'Encha', targetId: 5 });
        const d = decideRvr(ctx(picture(team(far), [boar, foe(51, { x: 11_500 })])));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        expect(d.anchor).toMatchObject({ x: 9725, y: 10_075 });
        expect(d.reason).toContain('1 enemy vs 4');
    });

    test('a gank on it moves none of the others\' orders 15k off, nor makes them run: they come to meet it, and hunt the gank once in sight', () => {
        const gank = (n: number, x: number) => [80, 81, 82, 83, 84, 85].slice(0, n).map(id => albion(id, { x, threat: true, target: 'Encha', targetId: 5 }));
        let d = decideRvr(ctx(picture(team(far), gank(3, -4800))));
        expect(d.phase).toBe('gather');
        expect(d.anchor!.x).toBeLessThan(9725);
        expect(d.anchor!.x).toBeGreaterThan(8000);
        expect(decideRvr(ctx(picture(team(far), gank(6, -4800)))).phase).toBe('gather');
        d = decideRvr(ctx(picture(team({ Encha: { x: 5500, y: 10_000 } }), gank(3, 5300))));
        expect(d.objective).toContain('hunt 3 enemies');
    });
});

describe('decideRvr: the regroup\'s objective', () => {
    // 'regroup with Bardundefined', 'regroup with Tank[object Object]': on the group page and the region page, every round after a release.
    test('who, and who is missing, in plain words', () => {
        const far = { x: 16_000, y: 10_000 };
        expect(decideRvr(ctx(picture(team({ Encha: far })))).objective).toBe('regroup with Encha');
        const d = decideRvr(ctx(picture(team({ Encha: far, Menta: { regionId: 1, x: 500_000 } }))));
        expect(d.phase).toBe('gather');
        expect(d.objective).toBe('regroup with Encha; missing Menta (region 1)');
    });

    test('with the tank the far one, by any distance', () => {
        expect(decideRvr(ctx(picture(team({ Tank: { x: 18_000, y: 10_000 } })))).objective).toBe('regroup with Tank');
        expect(decideRvr(ctx(picture(team({ Tank: { x: 40_000, y: 10_000 }, Menta: { regionId: 1, x: 500_000 } })))).objective).toBe('regroup with Tank; missing Menta (region 1)');
    });
});

describe('decideRvr: a far tank', () => {
    const at = (x: number, y = BASE.y) => ({ x, y });
    const KEEP = at(BASE.x + 21_000);

    test('no tie goes to him: the legs start from those here, and not at the keep he released to', () => {
        const memory: Record<string, any> = { realm: 'albion', gatherLead: 'Tank' };
        const d = decideRvr(ctx(picture(team({ Tank: KEEP, Druid: at(BASE.x), Bard: at(BASE.x, BASE.y + 3000) }).slice(0, 3)), { memory }));
        expect(d.phase).toBe('gather');
        expect(memory.gatherLead).not.toBe('Tank');
        expect(Math.hypot(d.anchor!.x - BASE.x, d.anchor!.y - BASE.y)).toBeLessThanOrEqual(RVR_SETTINGS.travelLeg + 3000);
        expect(d.waiting?.map(w => w.name)).toContain('Tank');
    });

    test('a leg to meet the others leaves him out of where it goes', () => {
        const memory: Record<string, any> = { realm: 'albion' };
        const d = decideRvr(ctx(picture(team({ Tank: KEEP, Druid: at(BASE.x), Bard: at(BASE.x, BASE.y + 6000) }).slice(0, 3)), { memory }));
        expect(d.phase).toBe('gather');
        expect(Math.abs(d.anchor!.x - BASE.x)).toBeLessThan(300);
    });

    test('with only him to meet, the others go to meet him as ever: there is no base to wait at', () => {
        const memory: Record<string, any> = { realm: 'albion' };
        const d = decideRvr(ctx(picture(team({ Tank: KEEP, Druid: at(BASE.x), Bard: at(BASE.x + 100), Menta: at(BASE.x + 200) }).slice(0, 4)), { memory }));
        expect(d.phase).toBe('gather');
        expect(d.reason).toContain('meeting Tank');
        expect(d.anchor!.x).toBeGreaterThan(BASE.x);
    });

    test('a fight where he is goes on: attacked with a member beside him, that cluster is the main body', () => {
        const memory: Record<string, any> = { realm: 'albion' };
        const onHim = foe(51, { x: KEEP.x + 100, y: KEEP.y, target: 'Tank', threat: true });
        const d = decideRvr(ctx(picture(team({ Tank: KEEP, Druid: at(KEEP.x + 200), Bard: at(BASE.x), Menta: at(BASE.x, BASE.y + 200) }), [onHim]), { memory }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
    });
});

describe('decideRvr: retreat among three realms', () => {
    const now = Date.now();
    const seven = [10, 11, 12, 13, 14, 15, 16].map(id => albion(id));

    test('two other realms fighting each other near us don\'t follow us; the seven we ran from coming back is a new retreat', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, contacts: Contact[], orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team(), contacts, orders, now + ms), { memory, now: now + ms }));
        let d = step(0, seven);
        expect(d.reason).toBe('retreat: 7 enemies vs 5');
        const retreating = { phase: 'retreat' as const, retreatTo: d.retreatTo!, reason: d.reason };
        // The seven stay 5000 off; four Albions and four Midgard players fight each other 1500 from us.
        const brawl = [...[20, 21, 22, 23].map(id => albion(id, { x: 11_180, targetId: 30 })), ...[30, 31, 32, 33].map(id => foe(id, { x: 11_180, targetId: 20 }))];
        const off = seven.map(c => ({ ...c, x: 15_000 }));
        d = step(5000, [...off, ...brawl], retreating);
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain(': 0 of 8 enemies vs 5');
        const fighting = { phase: 'engage' as const, focus: d.focus!, anchor: d.anchor! };
        d = step(21_000, [...off, ...brawl], fighting);
        expect(d.reason).not.toContain('caught');
        // More than RETREAT_COMMIT_MS after we turned on the brawl, never outnumbered since: a new retreat.
        d = step(26_000, [...seven, ...brawl], fighting);
        expect(d.phase).toBe('retreat');
        expect(d.reason).toBe('retreat: 7 of 15 enemies vs 5');
    });

    // Field 2026-11-12 (the freeze and the human-vision hour): caught ended on the first tick one of them was mezzed, and the
    // next full count was a new retreat; Camelot's orders turned between engage and retreat within 20 s 72 times in 136 turns.
    test('caught: fights on while they outnumber us, a mezz between, and runs again only after 20 s without being outnumbered', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, contacts: Contact[], orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team(), contacts, orders, now + ms), { memory, now: now + ms }));
        let d = step(0, seven);
        d = step(25_000, seven, { phase: 'retreat', retreatTo: d.retreatTo!, reason: d.reason });
        expect(d.reason).toContain('caught: ');
        const fighting = { phase: 'engage' as const, focus: d.focus!, anchor: d.anchor! };
        expect(step(26_000, seven, fighting).reason).toContain('caught: ');
        // Three of them mezzed: four against us, below the margin. Still the fight we were caught in.
        const mezz = { by: 'Bard', kind: 'mezz', until: now + 120_000 };
        const mezzed = seven.map(c => (c.objectId > 13 ? { ...c, cc: mezz } : c));
        d = step(27_000, mezzed, fighting);
        expect(d.phase).toBe('engage');
        expect(d.reason).not.toContain('caught');
        // Awake again 8 s later: fought on, not run again.
        d = step(35_000, seven, fighting);
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain('caught: ');
        // Mezzed again for 20 s: the next seven against five is a new retreat.
        expect(step(40_000, mezzed, fighting).phase).toBe('engage');
        expect(step(56_000, mezzed, fighting).phase).toBe('engage');
        // (One of the seven, its health still 20 s, is a phantom by then: an eighth comes up with them.)
        expect(step(57_000, [...seven, albion(17)], fighting).phase).toBe('retreat');
    });

    test('back at them soon after a retreat: committed, the rest of them coming up is no new retreat', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, contacts: Contact[], orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team(), contacts, orders, now + ms), { memory, now: now + ms }));
        let d = step(0, seven);
        const off = seven.map(c => ({ ...c, x: 13_000 }));
        // Nobody follows: the retreat ends, and the seven in sight are too many to hunt.
        d = step(5000, off, { phase: 'retreat', retreatTo: d.retreatTo!, reason: d.reason });
        expect(d.phase).toBe('travel');
        expect(d.reason).toContain('fall back');
        // Two of them come on: a fight of two against five.
        const two = off.map(c => (c.objectId <= 11 ? { ...c, x: 11_500 } : c));
        d = step(8000, two, { phase: 'travel', anchor: d.anchor });
        expect(d.phase).toBe('engage');
        // The other five come up behind them: committed, fight it out.
        d = step(10_000, seven, { phase: 'engage', focus: d.focus!, anchor: d.anchor! });
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain('caught: ');
    });

    test('a retreat runs on past those of them we mezzed, instead of turning on them', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, contacts: Contact[], orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team(), contacts, orders, now + ms), { memory, now: now + ms }));
        let d = step(0, seven);
        const retreating = { phase: 'retreat' as const, retreatTo: d.retreatTo!, reason: d.reason };
        const mezz = { by: 'Bard', kind: 'mezz', until: now + 60_000 };
        // Three mezzed near us, the other four 5000 off.
        const left = seven.map(c => (c.objectId <= 12 ? { ...c, cc: mezz } : { ...c, x: 15_000 }));
        d = step(5000, left, retreating);
        expect(d.phase).toBe('retreat');
        // retreat.maxMs on: the retreat ends there, and what is near is a fight we are committed to.
        d = step(21_000, left, retreating);
        expect(d.phase).toBe('engage');
    });

    // With human vision the pursuers drop out of the members' cones behind them (the human-vision hour, 2026-11-12).
    test('a retreat runs on while those we ran from are out of view, seen within 30 s; not on those seen longer ago', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, contacts: Contact[], orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team(), contacts, orders, now + ms), { memory, now: now + ms }));
        let d = step(0, seven);
        const retreating = { phase: 'retreat' as const, retreatTo: d.retreatTo!, reason: d.reason };
        const unseen = (seenAt: number) => seven.map(c => ({ ...c, stale: true, lastSeen: now + seenAt }));
        d = step(5000, unseen(1000), retreating);
        expect(d.phase).toBe('retreat');
        expect(d.reason).toBe('retreat: 7 enemies vs 5');
        // Last seen 31 s ago: nobody follows any more.
        d = step(8000, unseen(8000 - 31_000), retreating);
        expect(d.phase).not.toBe('retreat');
    });

    test('after a retreat the group we ran from counts whole, mezzed and out of view, and no patrol leg walks back at it', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, contacts: Contact[], orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team(), contacts, orders, now + ms), { memory, now: now + ms }));
        let d = step(0, seven);
        const retreating = { phase: 'retreat' as const, retreatTo: d.retreatTo!, reason: d.reason };
        // Out of view behind us all the way: the retreat runs to maxMs and ends there with nobody to fight.
        const unseen = seven.map(c => ({ ...c, stale: true, lastSeen: now + 19_000 }));
        expect(step(19_000, unseen, retreating).phase).toBe('retreat');
        d = step(21_000, unseen, retreating);
        // The nearest waypoint (10000, 10000) lies toward where they were (11500, 10000): wait instead.
        expect(d.phase).toBe('recover');
        expect(d.reason).toContain('keep off: the 7 enemies we ran from');
        // Four of them come into view 3300 off, three still out of view: seven, not four to hunt.
        const four = seven.map(c => (c.objectId <= 13 ? { ...c, x: 13_000 } : { ...c, stale: true, lastSeen: now + 19_000 }));
        d = step(25_000, four, { phase: 'recover', anchor: d.anchor });
        expect(d.phase).toBe('travel');
        expect(d.reason).toContain('fall back: 4 enemies and 3 more we ran from (mezzed or out of view)');
        // All seven in view, three of them mezzed: still seven.
        const mezz = { by: 'Bard', kind: 'mezz', until: now + 120_000 };
        const mezzed = seven.map(c => ({ ...c, x: 13_000, ...(c.objectId > 13 ? { cc: mezz } : {}) }));
        d = step(30_000, mezzed, { phase: 'travel', anchor: d.anchor });
        expect(d.reason).toContain('fall back: 4 of 7 enemies and 3 more we ran from');
        // A minute after the retreat ended they are anyone again: four free of seven are hunted, and the patrol goes on.
        d = step(82_000, mezzed, { phase: 'travel', anchor: d.anchor });
        expect(d.reason).toContain('hunt 7 enemies');
        expect(step(83_000, [], { phase: 'travel', anchor: d.anchor }).reason).toContain('patrol to waypoint');
    });

    test('a group we never ran from is hunted as before, mezzed ones left out', () => {
        const memory: Record<string, any> = {};
        const mezz = { by: 'Bard', kind: 'mezz', until: now + 120_000 };
        const mezzed = seven.map(c => ({ ...c, x: 13_000, ...(c.objectId > 13 ? { cc: mezz } : {}) }));
        const d = decideRvr(ctx(picture(team(), mezzed, {}, now), { memory, now }));
        expect(d.reason).toContain('hunt 7 enemies');
    });
});

describe('decideRvr: realm calls (tactics/help.ts)', () => {
    const now = Date.now();
    const help = (over: Partial<RealmCall> = {}): RealmCall => ({ id: 'hib-1', kind: 'help', from: 'hibernia-s1', why: 'outnumbered', at: { x: 14_680, y: 10_000, z: 0 }, foes: 4, ours: 2, want: 3, asked: ['hibernia'], coming: [], since: now, updatedAt: now, ...over });
    const run = (memory: Record<string, any>, ms: number, members = team(), contacts: Contact[] = [], orders: Partial<Orders> = {}) =>
        decideRvr(ctx(picture(members, contacts, orders, now + ms), { memory, now: now + ms }));

    test('free, a call naming us 5000 off: the group walks there in legs, instead of its patrol', () => {
        const memory: Record<string, any> = { realmUnit: 'hibernia', realmCalls: [help()] };
        const d = run(memory, 0);
        expect(d.phase).toBe('travel');
        expect(d.reason).toBe('call hib-1: hibernia-s1 (outnumbered, 4 vs 2), 5000 away');
        expect(d.anchor).toMatchObject({ x: 11_180, y: 10_000 });
        expect(memory.helpOut).toEqual([{ id: 'hib-1', answer: 'coming' }]);
        // Without calls: the patrol, as before.
        expect(run({}, 0).reason).toContain('patrol to waypoint');
    });

    test('not free: a member dead, or two short of ready, the call waits', () => {
        const memory: Record<string, any> = { realmUnit: 'hibernia', realmCalls: [help()] };
        expect(run(memory, 0, team({ Druid: { isDead: true } })).reason).toContain('waiting for Druid');
        expect(run(memory, 0, team({ Druid: { mana: 10 }, Menta: { mana: 10 } })).reason).toContain('waiting for');
        // One short goes.
        expect(run(memory, 0, team({ Druid: { mana: 10 } })).reason).toContain('call hib-1');
    });

    test('near the call, those of ours fighting there count: seven against five and three is a fight, not a retreat', () => {
        // The director counts our three within 2000 of the call in its `ours` (R2): six there is three of theirs.
        const memory: Record<string, any> = { realmUnit: 'hibernia', realmCalls: [help({ ours: 6, at: { x: 11_500, y: 10_000, z: 0 } })] };
        run(memory, 0);
        const seven = [10, 11, 12, 13, 14, 15, 16].map(id => albion(id));
        const d = run(memory, 1000, team(), seven);
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain('7 enemies vs 5 + 3 of ours');
        // The call closed: they are seven against five again.
        memory.realmCalls = [];
        expect(run(memory, 2000, team(), seven, { phase: 'engage', focus: d.focus!, anchor: d.anchor! }).phase).toBe('retreat');
    });

    test('realmCalls: the source feeds the calls and gets the answers, our own unit name in memory', () => {
        const answers: string[] = [];
        const source = { calls: () => [help()], answer: (id: string, a: string) => { answers.push(`${id}:${a}`); } };
        const live = realmCalls(rvrRoaming, 'hibernia', source);
        const memory: Record<string, any> = {};
        const d = live.strategy.decide(ctx(picture(team(), [], {}, now), { memory, now }));
        expect(d.reason).toContain('call hib-1');
        expect(answers).toEqual(['hib-1:coming']);
        expect(memory.realmUnit).toBe('hibernia');
        live.stop();
        // No director (the module missing or not started yet): no calls, the patrol.
        const none = realmCalls(rvrRoaming, 'hibernia', null);
        expect(none.strategy.decide(ctx(picture(team(), [], {}, now), { memory: {}, now })).reason).toContain('patrol to waypoint');
    });
});

describe('decideRvr: crowd control assignments', () => {
    const now = Date.now();
    const foes = [foe(51, { healer: true }), foe(52)];
    // The focus takes damage as a real one does: a focus whose health stands still 20 s is a phantom (rvrPhantom).
    const hurt = (contacts: Contact[], ms: number) => contacts.map(c => (c.objectId === 51 ? { ...c, hp: 100 - ms / 1000 } : c));

    test('a mezz not landed in 8 s goes to another mezzer (ours may be mezzed itself), who keeps it; the first gets none for a while', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, cc: Orders['cc'], contacts = foes) => decideRvr(ctx(picture(team(), hurt(contacts, ms), { phase: 'engage', focus: 51, cc }, now + ms), { memory, now: now + ms }));
        expect(step(0, []).cc).toEqual([{ targetId: 52, by: 'Bard' }]);
        expect(step(5000, [{ targetId: 52, by: 'Bard' }]).cc).toEqual([{ targetId: 52, by: 'Bard' }]);
        expect(step(9000, [{ targetId: 52, by: 'Bard' }]).cc).toEqual([{ targetId: 52, by: 'Menta' }]);
        expect(step(12_000, [{ targetId: 52, by: 'Menta' }]).cc).toEqual([{ targetId: 52, by: 'Menta' }]);
        // A new add while the Bard is benched goes to the next mezzer; after the bench, the Bard is one again.
        expect(step(13_000, [{ targetId: 52, by: 'Menta' }], [...foes, foe(53)]).cc).toEqual([{ targetId: 52, by: 'Menta' }, { targetId: 53, by: 'Encha' }]);
        expect(step(20_000, [], [foes[0]!, foe(53)]).cc).toEqual([{ targetId: 53, by: 'Bard' }]);
    });

    describe('a mezzer on its way to the target (crowdControl walks in steps, announced as a walk)', () => {
        // r8on, Rbspi: cc turn from +2 to +17, one uninterrupted walk then. In steps with the clock running, every walker over 8 s was benched with no cast: '+0.0s cc=[{51,Spi}]', '+8.5s cc=[{51,Cab}]', '+17.0s cc=[]'.
        const walk = { kind: 'move', targetId: 52, detail: 'cc: into range for Hold Spirit', since: 0 };
        const given = (memory: Record<string, any>, over: Parameters<typeof team>[0] = {}) => decideRvr(ctx(picture(team(over), foes, { phase: 'engage', focus: 51, cc: [] }, now), { memory, now })).cc;
        const tick = (memory: Record<string, any>, ms: number, bard: Partial<MemberReport>, cc: Orders['cc'] = [{ targetId: 52, by: 'Bard' }]) =>
            decideRvr(ctx(picture(team({ Bard: bard }), hurt(foes, ms), { phase: 'engage', focus: 51, cc }, now + ms), { memory, now: now + ms })).cc;

        test('getting somewhere it keeps the assignment past the 8 s, on a walk of any length a sighting gives', () => {
            const memory: Record<string, any> = {};
            expect(given(memory)).toEqual([{ targetId: 52, by: 'Bard' }]);
            for (let ms = 500; ms <= 20_000; ms += 500) {
                expect(tick(memory, ms, { x: 9700 + ms * 0.1, activity: walk })).toEqual([{ targetId: 52, by: 'Bard' }]);
            }
            // At the end of it, casting: its 8 s are from the last step, for a mezzer held there.
            expect(tick(memory, 27_000, { x: 9700 + 2000, activity: { ...walk, kind: 'cc' } })).toEqual([{ targetId: 52, by: 'Bard' }]);
            expect(tick(memory, 29_000, { x: 9700 + 2000, activity: { ...walk, kind: 'cc' } })).toEqual([{ targetId: 52, by: 'Menta' }]);
        });

        test('saying so and getting nowhere it is held: on to the next mezzer at 8 s, as ever', () => {
            const memory: Record<string, any> = {};
            expect(given(memory)).toEqual([{ targetId: 52, by: 'Bard' }]);
            for (let ms = 500; ms <= 8000; ms += 500) expect(tick(memory, ms, { activity: walk })).toEqual([{ targetId: 52, by: 'Bard' }]);
            expect(tick(memory, 8500, { activity: walk })).toEqual([{ targetId: 52, by: 'Menta' }]);
        });

        test('there is an end to it: a target it never reaches goes on to the next mezzer', () => {
            const memory: Record<string, any> = {};
            expect(given(memory)).toEqual([{ targetId: 52, by: 'Bard' }]);
            let on: Orders['cc'] = [{ targetId: 52, by: 'Bard' }];
            let at = 0;
            for (let ms = 500; ms <= 45_000 && on[0]?.by === 'Bard'; ms += 500) {
                at = ms;
                on = tick(memory, ms, { x: 9700 + ms * 0.1, activity: walk }, on) ?? [];
            }
            expect(on).toEqual([{ targetId: 52, by: 'Menta' }]);
            expect(at).toBeGreaterThan(30_000);
            expect(at).toBeLessThanOrEqual(39_000);
        });

        test('past the cluster radius on that walk it stays the mezzer: the group\'s centre is no reason to drop it', () => {
            const memory: Record<string, any> = {};
            expect(given(memory)).toEqual([{ targetId: 52, by: 'Bard' }]);
            expect(tick(memory, 500, { x: 13_000, activity: walk })).toEqual([{ targetId: 52, by: 'Bard' }]);
            expect(tick(memory, 1000, { x: 13_100, activity: walk })).toEqual([{ targetId: 52, by: 'Bard' }]);
        });

        test('out there on another errand it isn\'t: the assignment goes to one with the group', () => {
            const memory: Record<string, any> = {};
            expect(given(memory)).toEqual([{ targetId: 52, by: 'Bard' }]);
            expect(tick(memory, 500, { x: 13_000 })).toEqual([{ targetId: 52, by: 'Menta' }]);
        });
    });

    test('a mezz that landed and broke starts its time over', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, cc: Orders['cc'], contacts = foes) => decideRvr(ctx(picture(team(), contacts, { phase: 'engage', focus: 51, cc }, now + ms), { memory, now: now + ms }));
        expect(step(0, []).cc).toEqual([{ targetId: 52, by: 'Bard' }]);
        const mezzed = [foes[0]!, { ...foes[1]!, cc: { by: 'Bard', kind: 'mezz', until: now + 10_000 } }];
        expect(step(3000, [{ targetId: 52, by: 'Bard' }], mezzed).cc).toEqual([]);
        expect(step(10_000, []).cc).toEqual([{ targetId: 52, by: 'Bard' }]);
        expect(step(15_000, [{ targetId: 52, by: 'Bard' }]).cc).toEqual([{ targetId: 52, by: 'Bard' }]);
    });
});

describe('battleground data (static, Thidranki)', () => {
    const T = 252;
    // The client's terrain (bun run terrain:build): without it nothing is water.
    const terrain = getTerrainStore().available();
    const realms = ['albion', 'midgard', 'hibernia'] as const;

    test('homeOf: our portal keep and arrival point; nothing outside a battleground', () => {
        expect(homeOf(T, 'albion')).toMatchObject({ keep: { name: 'Albion Portal Keep' }, arrival: { x: 38_113, y: 53_507, z: 4160 } });
        expect(homeOf(T, 'midgard')?.keep.name).toBe('Midgard Portal Keep');
        expect(homeOf(T, 'hibernia')?.arrival).toEqual({ x: 17_367, y: 18_248, z: 4320 });
        expect(homeOf(T, 'none')).toBeNull();
        expect(homeOf(R, 'albion')).toBeNull();
    });

    test('keepDangers: every keep not ours, the Faste by its owner (keepOwners overrides the DB)', () => {
        const of = (realm: (typeof realms)[number], over: Partial<RvrSettings> = {}) => keepDangers(T, realm, { ...RVR_SETTINGS, ...over }).map(d => `${d.name} ${d.r}`);
        expect(of('hibernia')).toEqual(['Thidranki Faste 4500', 'Midgard Portal Keep 4500', 'Albion Portal Keep 4500']);
        expect(of('albion')).toEqual(['Hibernia Portal Keep 4500', 'Midgard Portal Keep 4500']);
        expect(of('albion', { keepOwners: { 'Thidranki Faste': 'midgard' } })).toContain('Thidranki Faste 4500');
        expect(of('midgard', { keepOwners: { 'Thidranki Faste': 'midgard' } })).not.toContain('Thidranki Faste 4500');
    });

    test('defaultPatrol: waypoints clear of aggro zones and keep circles, from the one nearest home, Albion and Midgard going opposite ways', () => {
        const meet = BATTLEGROUND_LAYOUTS[T]!.meet;
        const zones = aggroZones(T, 20);
        const turn: Record<string, number> = {};
        for (const realm of realms) {
            const loop = defaultPatrol(T, realm, 20);
            expect(loop.length).toBeGreaterThanOrEqual(4);
            const blocked = [...zones, ...keepDangers(T, realm)];
            for (const w of loop) {
                expect(blocked.every(c => Math.hypot(c.x - w.x, c.y - w.y) >= c.r + 900)).toBe(true);
                expect(Math.hypot(w.x - meet.x, w.y - meet.y)).toBeGreaterThan(4000);
            }
            const home = homeOf(T, realm)!.arrival;
            const d = loop.map(w => Math.hypot(w.x - home.x, w.y - home.y));
            expect(d[0]).toBe(Math.min(...d));
            const angle = (w: Point) => Math.atan2(w.y - meet.y, w.x - meet.x);
            turn[realm] = Math.sign(Math.sin(angle(loop[1]!) - angle(loop[0]!)));
        }
        expect(turn.albion).toBe(-turn.midgard!);
        expect(turn.hibernia).toBe(turn.albion!);
    });

    // Three of the default waypoints stood in a river before stayDry (Midgard's two, Hibernia's two, Albion's one).
    test.skipIf(!terrain)('defaultPatrol: with stayDry (the default) every waypoint is dry, and no realm loses one; off, the river ones come back', () => {
        for (const realm of realms) {
            const loop = defaultPatrol(T, realm, 20);
            expect(loop.every(w => isDry(T, w))).toBe(true);
            expect(loop.length).toBe(defaultPatrol(T, realm, 20, { stayDry: false }).length);
        }
        // Off, a river one comes back (the other stood on a steep bank, and level ground moved it out: slope.ts).
        expect(defaultPatrol(T, 'midgard', 20, { stayDry: false }).filter(w => isWet(T, w)).length).toBe(1);
    });

    test.skipIf(!terrain)('a fight that starts in a river is anchored on the bank; with stayDry off, where the group swims', () => {
        // The group in the river between Hibernia and Midgard (its middle 320 west of the tank), a Midgard player on it.
        const river = { x: 41_069, y: 26_768 };
        const members = team({}, { x: river.x + 320, y: river.y }, T);
        const on = enemy(61, 'midgard', { regionId: T, x: river.x + 900, y: river.y, threat: true, target: 'Tank', targetId: 1 });
        const anchor = (stayDry: boolean) => decideRvr(ctx(picture(members, [on]), { settings: { stayDry, patrol: null } })).anchor!;
        expect(isDry(T, anchor(true))).toBe(true);
        expect(isWet(T, anchor(false))).toBe(true);
    });

    test('a focus beyond the leash on the far side of a monster camp does not draw the fight\'s anchor into the camp', () => {
        // South of Hibernia's portal keep: the group out of every aggro zone, a Norseman 2900 east of its centre (beyond the 2000 leash),
        // and a camp where the anchor would drift to (1500 toward him). Found by a search over aggroZones(252, 24).
        const zones = aggroZones(T, 24);
        const members = team({}, { x: 16_000, y: 24_600 }, T);
        const norseman = enemy(61, 'midgard', { regionId: T, x: 18_580, y: 24_600, threat: true, target: 'Druid', targetId: 2 });
        expect(zones.some(z => Math.hypot(z.x - 17_180, z.y - 24_600) < z.r)).toBe(true);
        const d = decideRvr(ctx(picture(members, [norseman]), { settings: { patrol: null } }));
        expect(d).toMatchObject({ phase: 'engage', focus: 61 });
        expect(zones.every(z => Math.hypot(z.x - d.anchor!.x, z.y - d.anchor!.y) >= z.r)).toBe(true);
    });

    test('defaultPatrol with an opponent: a ring round the pair\'s spot, from the waypoint nearest home, the two going round opposite ways', () => {
        const pairs = [['albion', 'hibernia'], ['albion', 'midgard'], ['hibernia', 'midgard']] as const;
        for (const [a, b] of pairs) {
            const spot = BATTLEGROUND_LAYOUTS[T]!.pairs![`${a}|${b}`]!;
            const turn = (realm: (typeof realms)[number], opponent: (typeof realms)[number]) => {
                const loop = defaultPatrol(T, realm, 24, { opponent });
                expect(loop.length).toBeGreaterThanOrEqual(4);
                for (const w of loop) {
                    expect(Math.hypot(w.x - spot.x, w.y - spot.y)).toBeGreaterThan(2500);
                    expect(Math.hypot(w.x - spot.x, w.y - spot.y)).toBeLessThan(5500);
                    if (terrain) expect(isDry(T, w)).toBe(true);
                }
                const home = homeOf(T, realm)!.arrival;
                const d = loop.map(w => Math.hypot(w.x - home.x, w.y - home.y));
                expect(d[0]).toBe(Math.min(...d));
                const angle = (w: Point) => Math.atan2(w.y - spot.y, w.x - spot.x);
                return Math.sign(Math.sin(angle(loop[1]!) - angle(loop[0]!)));
            };
            expect(turn(a, b)).toBe(-turn(b, a));
        }
    });

    test('falls back away from a larger group standing between us and our portal keep, toward the keep when they stand aside', () => {
        // A Hibernian group (centre (26680, 26000)), seven Albions 4500 from it, toward the Hibernia arrival or off to the side.
        const home = homeOf(T, 'hibernia')!.arrival;
        const c0 = { x: 26_680, y: 26_000 };
        const l = Math.hypot(home.x - c0.x, home.y - c0.y);
        const u = { x: (home.x - c0.x) / l, y: (home.y - c0.y) / l };
        const seven = (p: Point) => [60, 61, 62, 63, 64, 65, 66].map(id => enemy(id, 'albion', { regionId: T, ...p }));
        const between = seven({ x: c0.x + u.x * 4500, y: c0.y + u.y * 4500 });
        const memory: Record<string, any> = {};
        let base: Point = { x: c0.x + 320, y: c0.y };
        for (let leg = 0; leg < 3; leg++) {
            const gap = Math.hypot(base.x - 320 - between[0]!.x, base.y - between[0]!.y);
            const d = decideRvr(ctx(picture(team({}, base, T), between), { memory, settings: { patrol: null } }));
            expect(d.phase).toBe('travel');
            expect(d.objective).toContain('fall back away from them');
            expect(Math.hypot(d.anchor!.x - between[0]!.x, d.anchor!.y - between[0]!.y)).toBeGreaterThan(gap);
            base = d.anchor!;
        }
        const aside = seven({ x: c0.x + u.y * 4500, y: c0.y - u.x * 4500 });
        const d = decideRvr(ctx(picture(team({}, { x: c0.x + 320, y: c0.y }, T), aside), { settings: { patrol: null } }));
        expect(d.objective).toContain('fall back toward our portal keep');
        expect(Math.hypot(d.anchor!.x - home.x, d.anchor!.y - home.y)).toBeLessThan(l);
    });

    test('enemy players under an enemy keep\'s guards are left alone unless they attack us', () => {
        // A Hibernian group 5800 west of the Midgard portal keep; a Norseman 4000 from it (inside 4500), 2100 from us.
        const keep = BATTLEGROUND_LAYOUTS[T]!.keeps.find(k => k.name === 'Midgard Portal Keep')!;
        const members = team({}, { x: keep.x - 5800, y: keep.y }, T);
        const guarded = enemy(51, 'midgard', { regionId: T, x: keep.x - 4000, y: keep.y });
        let d = decideRvr(ctx(picture(members, [guarded]), { settings: { patrol: null } }));
        expect(d.phase).not.toBe('engage');
        expect(d.focus).toBeNull();
        d = decideRvr(ctx(picture(members, [{ ...guarded, target: 'Druid', targetId: 2, threat: true }]), { settings: { patrol: null } }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
    });

    test('a retreat toward home picks a way whose whole length is clear of aggro zones (round 7: through the bwca camp)', () => {
        // The perturbed bwca camp (~27500, 25600) lies on the straight line from here to the Hibernia arrival.
        const members = team({}, { x: 29_820, y: 27_000 }, T);
        const albs = [60, 61, 62, 63, 64, 65, 66].map(id => enemy(id, 'albion', { regionId: T, x: 31_500, y: 28_200 }));
        const d = decideRvr(ctx(picture(members, albs), { settings: { patrol: null } }));
        expect(d.phase).toBe('retreat');
        const from = { x: members.reduce((a, m) => a + m.x, 0) / 5, y: members.reduce((a, m) => a + m.y, 0) / 5 };
        const zones = aggroZones(T, 20);
        for (let i = 1; i <= 20; i++) {
            const p = { x: from.x + (d.retreatTo!.x - from.x) * i / 20, y: from.y + (d.retreatTo!.y - from.y) * i / 20 };
            expect(zones.some(z => Math.hypot(z.x - p.x, z.y - p.y) < z.r)).toBe(false);
        }
    });

    test('an attacker under the Faste\'s guards is answered without moving the fight into its circle (final review)', () => {
        // A Hibernian group 3800 west of the Faste (Albion's, circle 3000); an Albion caster 1700 from its centre nukes the Druid.
        const faste = BATTLEGROUND_LAYOUTS[T]!.keeps.find(k => k.name === 'Thidranki Faste')!;
        const members = team({}, { x: faste.x - 3800, y: faste.y }, T);
        const caster = enemy(51, 'albion', { regionId: T, x: faste.x - 1700, y: faste.y, target: 'Druid', targetId: 2, threat: true, caster: true });
        const d = decideRvr(ctx(picture(members, [caster]), { settings: { patrol: null } }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        expect(Math.hypot(d.anchor!.x - faste.x, d.anchor!.y - faste.y)).toBeGreaterThanOrEqual(3000);
        // With a fighter outside the circle on the Tank, the casters keep the caster (healers and casters first);
        // tank and melee take the fighter (beyondLeash, leashFallback), and the anchor still stays out.
        const fighter = enemy(52, 'albion', { regionId: T, x: faste.x - 3700, y: faste.y + 300, target: 'Tank', targetId: 1, threat: true });
        const e = decideRvr(ctx(picture(members, [caster, fighter]), { settings: { patrol: null } }));
        expect(e.focus).toBe(51);
        expect(Math.hypot(e.anchor!.x - faste.x, e.anchor!.y - faste.y)).toBeGreaterThanOrEqual(3000);
    });
});

describe('safePath avoid circles', () => {
    test('routes round an extra circle; without it the straight line stays', () => {
        const from = { x: 0, y: 0 }, to = { x: 10_000, y: 0 };
        const keep = { x: 5000, y: 0, r: 1500, name: 'keep', level: 255 };
        expect(safePath(R, 20, from, to)).toEqual([to]);
        const path = safePath(R, 20, from, to, [keep]);
        expect(path.length).toBeGreaterThan(1);
        expect(path.at(-1)).toEqual(to);
        let a: Point = from;
        for (const b of path) {
            for (let i = 0; i <= 50; i++) expect(Math.hypot(a.x + (b.x - a.x) * i / 50 - keep.x, a.y + (b.y - a.y) * i / 50 - keep.y)).toBeGreaterThanOrEqual(keep.r);
            a = b;
        }
        expect(safePath(R, 20, from, to)).toEqual([to]);
    });
});

describe('decideRvr: monsters in a player fight', () => {
    // A Norseman on the tank (the focus), a free Dwarf, a black wolf on the Druid and one on the tank.
    const fightWith = (wolves: Contact[]) => decideRvr(ctx(picture(team(), [
        foe(51, { threat: true, target: 'Tank', targetId: 1 }), foe(52, { name: 'Dwarf', x: 11_200 }), ...wolves,
    ])));
    const wolf = (id: number, target: string) => contact(id, { regionId: R, x: 9_800, y: 10_100, name: 'black wolf', level: 22, threat: true, target });

    test('a monster on a healer is mezzed before a free player; one on the tank after; the player stays the focus', () => {
        const d = fightWith([wolf(70, 'Druid'), wolf(71, 'Tank')]);
        expect(d).toMatchObject({ phase: 'engage', focus: 51 });
        // Mezzers in assignCc's order (support, then nukers): the Bard, Menta, Encha.
        expect(d.cc).toEqual([{ targetId: 70, by: 'Bard' }, { targetId: 52, by: 'Menta' }, { targetId: 71, by: 'Encha' }]);
    });

    test('a monster already mezzed, or a player\'s pet, gets no mezz', () => {
        const d = fightWith([wolf(70, 'Druid'), { ...wolf(72, 'Druid'), cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 30_000 } }, contact(73, { regionId: R, x: 9_800, y: 10_100, isPet: true, threat: true, target: 'Druid', realm: 'midgard' })]);
        expect(d.cc!.map(a => a.targetId).sort()).toEqual([52, 70]);
    });
});

describe('rvrRoaming', () => {
    test('role lists without a town healer visit; tank list as specified', () => {
        expect(rvrRoaming.behaviors.tank.map(b => b.name)).toEqual(['release', 'hand', 'sprint', 'retreat', 'rejoinFight', 'rez', 'song', 'tank', 'guard', 'shedLoad', 'hasten', 'holdFormation', 'buff', 'rest', 'loiter']);
        expect(Object.values(rvrRoaming.behaviors).flat().some(b => b.name === 'healer')).toBe(false);
        expect(rvrRoaming.board).toEqual({ staleAfterMs: 4000, forgetAfterMs: 30_000, hostileMs: 6000 });
    });

    test('findings: no contact, outnumbered, bad trades, a member at the level cap', () => {
        const run = (totals: Partial<RunReport['totals']>, level = '20'): RunReport => ({
            group: 'hibernia', strategy: 'rvr-roam', startedAt: '', durationMs: 600_000, phases: { travel: 80, engage: 20 }, fights: [], findings: [], timeline: [],
            totals: { kills: 0, deaths: 0, wipes: 0, retreats: 0, fights: 4, killsPerHour: 0, xpPerHour: 0, avgFightMs: 0, downtime: 80, tankHold: null, enemiesSeen: 12, engagements: 4, ...totals },
            members: { Tank: { role: 'tank', level, killedBy: { 'player:midgard': 3, 'npc:mature boar': 1 } } as any },
        });
        const topics = (r: RunReport) => rvrFindings(r, RVR_SETTINGS).map(f => f.topic);
        expect(topics(run({}))).toEqual([]);
        expect(topics(run({ enemiesSeen: undefined }))).toEqual(['no-contact']);
        expect(topics(run({ retreats: 3 }))).toEqual(['outnumbered']);
        const trades = rvrFindings(run({ deathsToPlayers: 4, playerKills: 1 }), RVR_SETTINGS);
        expect(trades.map(f => f.topic)).toEqual(['trades']);
        expect(trades[0]!.evidence).toBe('killed by player:midgard 3, npc:mature boar 1');
        expect(topics(run({}, '23→24'))).toEqual(['level']);
        expect(topics(run({ wetInFights: 35, enemiesWetInFights: 40 }))).toEqual(['water']);
        expect(topics(run({ wetInFights: 10 }))).toEqual([]);
        // Where the wet time was picks the advice.
        expect(rvrFindings(run({ wetInFights: 35, wetWhere: { travel: 70, away: 30 } }), RVR_SETTINGS)[0]!.suggestion).toContain('crossing');
        expect(rvrFindings(run({ wetInFights: 35, wetWhere: { away: 80, near: 20 } }), RVR_SETTINGS)[0]!.suggestion).toContain('chaseLeash');
        expect(topics(run({ steepInFights: 20, steepInTravel: 5 }))).toEqual(['slope']);
        expect(topics(run({ steepInFights: 5, steepInTravel: 10 }))).toEqual([]);
        // Slow contact counts in a pair round only.
        expect(topics(run({ firstFightS: 300, quietMaxS: 300 }))).toEqual([]);
        expect(rvrFindings(run({ firstFightS: 300, quietMaxS: 300 }), { ...RVR_SETTINGS, opponent: 'midgard' }).map(f => f.topic)).toEqual(['contact']);
        expect(rvrFindings(run({ firstFightS: 100, quietMaxS: 200 }), { ...RVR_SETTINGS, opponent: 'midgard' }).map(f => f.topic)).toEqual([]);
        // A third realm in a fight matters only in a pair round.
        expect(topics(run({ threeWay: 2 }))).toEqual([]);
        expect(rvrFindings(run({ threeWay: 2 }), { ...RVR_SETTINGS, opponent: 'midgard' }).map(f => f.topic)).toEqual(['pair']);
    });
});

describe('decideRvr: pets', () => {
    const mob = (over: Partial<Contact> = {}) => contact(60, { regionId: R, x: 11_000, y: 10_000, threat: true, ...over });

    test('a monster on a member\'s pet is a monster on us: the group fights it', () => {
        const d = decideRvr(ctx(picture(team(), [mob({ target: null, targetId: 500, targetPet: 'Menta' })])));
        expect(d).toMatchObject({ phase: 'engage', focus: 60 });
    });

    test('a monster on nobody of ours is left alone, as before', () => {
        const d = decideRvr(ctx(picture(team(), [mob({ target: null, targetId: 500, targetPet: null })])));
        expect(d.phase).not.toBe('engage');
    });

    test('on the pet of a member far from the main body it counts only near that body, as on the member', () => {
        const far = { x: 40_000, y: 10_000 };
        const d = decideRvr(ctx(picture(team({ Menta: far }), [mob({ ...far, target: null, targetId: 500, targetPet: 'Menta' })])));
        expect(d.phase).not.toBe('engage');
    });

    test('an enemy pet on a member is fought only when no player is about, and is never mezzed or the focus over a player', () => {
        const pet = (over: Partial<Contact> = {}) => enemy(70, 'midgard', { kind: 'npc', name: 'spirit soldier', isPet: true, regionId: R, x: 10_500, y: 10_000, threat: true, target: 'Tank', ...over });
        expect(decideRvr(ctx(picture(team(), [pet()])))).toMatchObject({ phase: 'engage', focus: 70, cc: [] });
        const withPlayers = decideRvr(ctx(picture(team(), [pet(), foe(71, { x: 10_600 }), foe(72, { x: 10_700 })])));
        expect(withPlayers.focus).not.toBe(70);
        expect((withPlayers.cc ?? []).map(a => a.targetId)).not.toContain(70);
    });

    test('an enemy pet nobody fights is no fight', () => {
        const pet = enemy(70, 'midgard', { kind: 'npc', name: 'spirit soldier', isPet: true, regionId: R, x: 10_500, y: 10_000 });
        expect(decideRvr(ctx(picture(team(), [pet]))).phase).not.toBe('engage');
    });

    test('power: a member whose only spell is its pet counts, one with none does not', () => {
        const waiting = (over: Partial<MemberReport>) => decideRvr(ctx(picture(team({ Tank: over })))).waiting ?? [];
        expect(waiting({ capabilities: { ...caps(false, false, false), pet: 'fnf' }, mana: 10 })).toContainEqual({ name: 'Tank', why: 'power' });
        expect(waiting({ capabilities: { ...caps(false, false, false), pet: null }, mana: 10 })).not.toContainEqual({ name: 'Tank', why: 'power' });
    });
});

describe('decideRvr: a Necromancer in shade (AbstractServerRules.cs:449-455)', () => {
    // Run 20261103-174011: Orders held "fight Briton#427 (albion L20, 100%)" for 25 s, "nuke:refused (16)", Damage dealt 0 and 0.
    const shade = (over: Partial<Contact> = {}) => foe(51, { name: 'Briton', realm: 'albion', isShade: true, threat: false, ...over });
    const servant = (over: Partial<Contact> = {}) => enemy(52, 'albion', { kind: 'npc', name: 'necroservant', level: 17, isPet: true, regionId: R, x: 10_500, y: 10_000, threat: true, target: 'Tank', ...over });

    test('it is no focus: with its servant on us the servant is, like any enemy pet', () => {
        expect(decideRvr(ctx(picture(team(), [shade(), servant()])))).toMatchObject({ phase: 'engage', focus: 52 });
    });

    test('the focus moves off it at once, to an enemy player beside it', () => {
        const d = decideRvr(ctx(picture(team(), [shade(), foe(53, { x: 10_900 })], { phase: 'engage', focus: 51 })));
        expect(d).toMatchObject({ phase: 'engage', focus: 53 });
    });

    test('alone it is no fight: no engage, no hunt', () => {
        expect(decideRvr(ctx(picture(team(), [shade()], { phase: 'engage', focus: 51 })))).toMatchObject({ focus: null });
        expect(decideRvr(ctx(picture(team(), [shade()], { phase: 'engage', focus: 51 }))).phase).not.toBe('engage');
        const far = decideRvr(ctx(picture(team(), [shade({ x: 13_680 })])));
        expect(far.objective ?? '').not.toContain('hunt');
    });

    test('it is left out of crowd control and of the count', () => {
        const d = decideRvr(ctx(picture(team(), [shade(), foe(53, { x: 10_900 }), foe(54, { x: 10_950 })])));
        expect((d.cc ?? []).map(a => a.targetId)).not.toContain(51);
        expect(d.reason).toContain('2 enemies vs 5');
        // Seven with it: six to retreat from at margin 2 is under seven.
        const six = [53, 54, 55, 56, 57, 58].map(id => foe(id, { x: 10_900 }));
        expect(decideRvr(ctx(picture(team(), [shade(), ...six]))).phase).toBe('engage');
    });

    test('marked by a refused attack it counts the same while the mark holds', () => {
        const now = Date.now();
        const marked = foe(51, { x: 10_900, target: 'Tank', unattackableUntil: now + 30_000 });
        expect(decideRvr(ctx(picture(team(), [marked], { phase: 'engage', focus: 51 }, now), { now })).phase).not.toBe('engage');
        expect(decideRvr(ctx(picture(team(), [marked, foe(53, { x: 10_900 })], { phase: 'engage', focus: 51 }, now), { now })).focus).toBe(53);
    });
});

describe('decideRvr: an enemy pet\'s fire', () => {
    // Run 20261103-175746: "00:00 travel", "00:16 recover: waiting for Pethun's health", "00:36 engage on grove's hunter", "00:37 recover", "00:38 engage", "00:39 Pethun died".
    const turret = (over: Partial<Contact> = {}) => enemy(70, 'hibernia', { kind: 'npc', name: "grove's hunter", level: 17, isPet: true, regionId: R, x: 10_700, y: 10_000, threat: true, target: null, targetId: null, ...over });

    test('with its target unknown for the moment, a threat near the main body is a fight all the same', () => {
        expect(decideRvr(ctx(picture(team(), [turret()])))).toMatchObject({ phase: 'engage', focus: 70 });
    });

    test('not one that is no threat, nor one far off', () => {
        expect(decideRvr(ctx(picture(team(), [turret({ threat: false })]))).phase).not.toBe('engage');
        expect(decideRvr(ctx(picture(team(), [turret({ x: 14_000 })]))).phase).not.toBe('engage');
    });

    test('an enemy player in the fight still goes first', () => {
        expect(decideRvr(ctx(picture(team(), [turret(), foe(71, { x: 10_600 })]))).focus).toBe(71);
    });

    test('it stays the fight when winding down, as anything fighting us does', () => {
        expect(decideRvr(ctx(picture(team(), [turret()]), { windingDown: true }))).toMatchObject({ phase: 'engage', focus: 70 });
    });
});

describe('decideRvr: a rooted enemy', () => {
    const rooted = { cc: { by: 'Druid', kind: 'root', until: Date.now() + 20_000 } };
    const onUs = (over: Partial<Contact> = {}) => enemy(70, 'hibernia', { kind: 'npc', name: "grove's hunter", level: 17, isPet: true, regionId: R, x: 10_700, y: 10_000, threat: true, target: 'Druid', ...over });

    // Run 20261103-174453: "00:08 engage on Celt: fight Celt#428 (hibernia L20, 100%): 0 of 1 enemy vs 2", "idle assist: focus is crowd-controlled"; Petbon 72 % at +9.4 to dead at +29 from turret hits.
    test('with every player cc\'d a free candidate on us comes before the cc\'d player', () => {
        const d = decideRvr(ctx(picture(team(), [foe(51, rooted), onUs()], { phase: 'engage', focus: 51 })));
        expect(d).toMatchObject({ phase: 'engage', focus: 70 });
        expect(pickRvrFocus([foe(51, rooted), onUs()], { centre: BASE, members: team(), settings: RVR_SETTINGS })?.objectId).toBe(70);
    });

    test('a free player beside them is still first', () => {
        expect(decideRvr(ctx(picture(team(), [foe(51, rooted), onUs(), foe(53, { x: 10_900 })]))).focus).toBe(53);
    });

    test('with nothing else it stays the focus: that\'s for the members to hit (behaviors.ts ccHolds)', () => {
        expect(decideRvr(ctx(picture(team(), [foe(51, rooted)])))).toMatchObject({ phase: 'engage', focus: 51 });
    });
});

describe('decideRvr: every enemy mezzed, picked off one at a time', () => {
    // User, live in Thidranki: with every enemy mezzed the group left them all alone. The members break the focus (behaviors.ts ccHolds).
    const mezz = { cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 60_000 } };
    const three = () => [foe(51, { ...mezz }), foe(52, { ...mezz, x: 11_200, caster: true, hp: 50 }), foe(53, { ...mezz, x: 11_400 })];

    test('it engages one of them, the picker\'s choice (a caster nearer dying), and no mezz goes back on it', () => {
        const d = decideRvr(ctx(picture(team(), three())));
        expect(d).toMatchObject({ phase: 'engage', focus: 52 });
        expect((d.cc ?? []).map(a => a.targetId)).not.toContain(52);
    });

    test('with softFocus as well (the pack\'s picker)', () => {
        const soft = { softFocus: { reach: 1500, healedBy: 30, droppedMs: 15_000 } };
        expect(decideRvr(ctx(picture(team(), three()), { settings: soft }))).toMatchObject({ phase: 'engage', focus: 52 });
    });

    test('a mezzed focus stays the one chosen, though another scores higher now: no flipping before the first blow', () => {
        expect(decideRvr(ctx(picture(team(), three(), { phase: 'engage', focus: 51 }))).focus).toBe(51);
    });

    test('once broken it is held, and the mezzer who put it under isn\'t sent back at it', () => {
        const broken = [foe(51, { hp: 80 }), foe(52, { ...mezz, x: 11_200, caster: true, hp: 50 }), foe(53, { ...mezz, x: 11_400 })];
        const d = decideRvr(ctx(picture(team(), broken, { phase: 'engage', focus: 51, cc: [{ targetId: 51, by: 'Bard' }] })));
        expect(d).toMatchObject({ phase: 'engage', focus: 51 });
        expect((d.cc ?? []).map(a => a.targetId)).not.toContain(51);
    });

    test('then the next, until none is left', () => {
        const left = [foe(51, { ...mezz }), foe(53, { ...mezz, x: 11_400, healer: true })];
        expect(decideRvr(ctx(picture(team(), left, { phase: 'engage', focus: 52 }))).focus).toBe(53);
        expect(decideRvr(ctx(picture(team(), [foe(51, { ...mezz })], { phase: 'engage', focus: 53 }))).focus).toBe(51);
    });

    test('a free one beside them is still first', () => {
        expect(decideRvr(ctx(picture(team(), [...three(), foe(54, { x: 11_600 })]))).focus).toBe(54);
    });
});

describe('decideRvr: a player under the enemy keep\'s guards', () => {
    // Run r8: Celt under the keep at (35930,38271), 2841 from Thidranki Faste's centre, 5 s spell cooldown: "00:06 travel", "00:07 engage", "to defend you!" at +6.8, "disengage from combat!" at +7.3.
    const THIDRANKI_ID = 252;
    const under = (over: Partial<Contact> = {}) => enemy(51, 'albion', { regionId: THIDRANKI_ID, x: 35_930, y: 38_271, ...over });
    const decide = (c: Contact, orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team({}, { x: 37_500, y: 38_271 }, THIDRANKI_ID), [c], orders)));

    test('the focus goes from the fight with its 6 s aim lapsed, threat or no: our own nukes keep it a threat, and a fight on it would feed itself (petControl holds the stance)', () => {
        expect(decide(under({ threat: true, target: null }), { phase: 'engage', focus: 51 }).phase).not.toBe('engage');
        expect(decide(under({ threat: false, target: null }), { phase: 'engage', focus: 51 }).phase).not.toBe('engage');
    });

    test('on the real board: a nuke every 3 s for a minute doesn\'t hold a fight it stopped answering', () => {
        // Hit the tank once at t 0, and never again. Each landed nuke is in the nuker's obs.hits for 6 s, which refreshes lastHostile (blackboard.ts), so threat lasted hostileMs past every landed spell.
        const T = 1_800_000_000_000;
        const THE_TANK = 500, NUKER = 501, CELT = 51;
        const board = new Blackboard({ hostileMs: 6000 });
        const self = (role: Role) => ({ bot: role, role, activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [] } });
        const celt = makePlayerObj({ objectId: CELT, name: 'Celt', realm: 'hibernia', x: 35_930, y: 38_271, level: 20 });
        const events: CombatEvent[] = [{ id: 1, kind: 'melee', attackerObjectId: CELT, targetObjectId: THE_TANK, result: 'hit', receivedAt: T }];
        const look = (now: number, objectId: number, name: string, role: Role, x: number) => observeState(makeState({
            timestamp: now, inGame: true, player: makePlayer({ objectId, name, realm: 'midgard', className: 'Warrior', regionId: THIDRANKI_ID, x, y: 38_271, level: 20 }), nearbyNpcs: [], nearbyPlayers: [celt], combatEvents: events.filter(e => now - e.receivedAt < 15_000),
        }), self(role), 5000)!;
        const memory: Record<string, any> = {};
        const settings = { ...RVR_SETTINGS, patrol: [{ x: 37_500, y: 38_271, z: 0 }], keepOwners: {}, retreat: { ...RVR_SETTINGS.retreat, enabled: false } };
        const phases: string[] = [];
        for (let at = 0; at <= 60_000; at += 250) {
            const now = T + at;
            if (at > 0 && at % 3000 === 0) events.push({ id: 100 + at, kind: 'spellEffect', attackerObjectId: NUKER, targetObjectId: CELT, receivedAt: now });
            board.publish(look(now, THE_TANK, 'Tank', 'tank', 37_500), now);
            board.publish(look(now, NUKER, 'Nuker', 'nuker', 37_300), now);
            const d = decideRvr({ picture: board.picture(now), orders: board.getOrders(), memory, settings, now, windingDown: false });
            board.setOrders(d, now);
            phases.push(d.phase ?? '');
            if (at === 0) expect(d).toMatchObject({ phase: 'engage', focus: CELT });
        }
        // Its aim lapsed at 6 s (PLAYER_TARGET_MS), and there the fight ends: HEAD's rule.
        expect(phases.slice(Math.round(8000 / 250))).not.toContain('engage');
    });

    test('one that fights someone else near us doesn\'t pull us in: threat by a swing is no attack on us', () => {
        expect(decide(under({ threat: true, target: null })).phase).not.toBe('engage');
    });

    test('one attacking us, as before', () => {
        expect(decide(under({ threat: true, target: 'Tank' }))).toMatchObject({ phase: 'engage', focus: 51 });
    });
});

describe.skipIf(!isWet(252, { x: 41_069, y: 26_768 }))('decideRvr with stayDry: enemies swimming', () => {
    // A Hibernian group on its bank, three Midgard players in the river 2400 east (inside engageRadius), then ashore.
    const T = 252;
    const bank = { x: 38_500, y: 26_768 };
    const swim = (x: number, over: Partial<Contact> = {}) => [101, 102, 103].map((id, i) => enemy(id, 'midgard', { regionId: T, x: x + i * 100, y: 26_768, ...over }));
    const decide = (contacts: Contact[], o: { stayDry?: boolean; memory?: Record<string, any>; now?: number } = {}) =>
        decideRvr(ctx(picture(team({}, bank, T), contacts), { memory: o.memory ?? { realm: 'hibernia' }, now: o.now, settings: { patrol: null, stayDry: o.stayDry ?? true } }));

    test('no fight with those swimming: the group waits for them on dry ground, facing them; with stayDry off, it fights', () => {
        const u = decide(swim(40_900));
        expect(u.phase).toBe('travel');
        expect(u.reason).toMatch(/wait ashore: 3 enemies swimming/);
        expect(isDry(T, u.anchor!)).toBe(true);
        expect(u.facing!.x).toBeGreaterThan(40_900);
        expect(decide(swim(40_900), { stayDry: false }).reason).toMatch(/^(fight|hunt)/);
    });

    test('those swimming still count against us: eight of them and the group falls back instead of waiting', () => {
        const eight = [...swim(40_900), ...[104, 105, 106, 107, 108].map((id, i) => enemy(id, 'midgard', { regionId: T, x: 40_900 + i * 100, y: 26_868 }))];
        expect(eight.every(c => isWet(T, c))).toBe(true);
        expect(decide(eight).reason).toMatch(/^fall back/);
    });

    test('one on us is fought in the water; once ashore they are fought', () => {
        expect(decide(swim(40_900, { target: 'Tank', targetId: 1, threat: true })).phase).toBe('engage');
        expect(decide(swim(39_400)).phase).toBe('engage');
    });

    test('the wait ends after ASHORE_WAIT_MS with them still swimming, and starts again after they were gone', () => {
        const memory: Record<string, any> = { realm: 'hibernia' };
        expect(decide(swim(40_900), { memory, now: 1000 }).reason).toMatch(/wait ashore/);
        expect(decide(swim(40_900), { memory, now: 40_000 }).reason).toMatch(/wait ashore/);
        expect(decide(swim(40_900), { memory, now: 47_000 }).reason).not.toMatch(/wait ashore/);
        // Gone for a tick (a contact flickering at the edge of sight): no new wait.
        decide([], { memory, now: 50_000 });
        expect(decide(swim(40_900), { memory, now: 51_000 }).reason).not.toMatch(/wait ashore/);
        // Gone for ASHORE_GONE_MS: the next ones start a new wait.
        decide([], { memory, now: 62_000 });
        expect(decide(swim(40_900), { memory, now: 63_000 }).reason).toMatch(/wait ashore/);
    });

    test('swimmers flickering out of sight every other tick: the wait still ends after ASHORE_WAIT_MS', () => {
        // Field mode, 2026-11-11: Midgard switched between waiting and patrolling every second for 5 minutes.
        const memory: Record<string, any> = { realm: 'hibernia' };
        let waited = 0;
        for (let t = 1000; t < 120_000; t += 1000) {
            const d = decide(t % 2000 ? swim(40_900) : [], { memory, now: t });
            if (/wait ashore/.test(d.reason)) waited = t;
        }
        expect(waited).toBeLessThan(1000 + 45_000 + 1000);
    });
});

describe('stepLeg: a spread formation reaches its leg', () => {
    // Field mode, 2026-11-11: Albion's patrol stood 10 minutes 1000 short of waypoint 1 (35033, 37402): the leg was the
    // waypoint, the tank stood 431 from it, and the support and a nuker idled in their slots 1417 and 1307 off it.
    const leg = { x: 35_033, y: 37_402 };
    const movers = [{ x: 35_376, y: 37_141 }, { x: 35_973, y: 37_126 }, { x: 36_177, y: 37_452 }, { x: 36_433, y: 37_180 }, { x: 36_199, y: 36_811 }];
    const trip = (mem: Record<string, any>, now: number) => ({ mem, now, regionId: 252, level: 24, avoid: [], travelLeg: 1500, zAt: () => 0 });
    const fresh = () => ({ legKind: 'patrol', leg: { ...leg, z: 0 }, legAt: 0, goal: { x: 30_000, y: 30_000 }, route: [{ x: 30_000, y: 30_000 }] } as Record<string, any>);

    test('two in their slots beyond 1200: held for the leg timeout, then the next leg', () => {
        const early = fresh();
        stepLeg(trip(early, 10_000), 'patrol', { x: 30_000, y: 30_000 }, { from: leg, movers, replan: Infinity });
        expect(early.leg).toMatchObject(leg);
        const late = fresh();
        stepLeg(trip(late, 31_000), 'patrol', { x: 30_000, y: 30_000 }, { from: leg, movers, replan: Infinity });
        expect(late.leg).not.toMatchObject(leg);
    });

    test('two far behind (not in a slot): the leg holds', () => {
        const mem = fresh();
        const behind = [...movers.slice(0, 3), { x: 38_000, y: 37_400 }, { x: 38_200, y: 37_400 }];
        stepLeg(trip(mem, 60_000), 'patrol', { x: 30_000, y: 30_000 }, { from: leg, movers: behind, replan: Infinity });
        expect(mem.leg).toMatchObject(leg);
    });
});

describe.skipIf(!isWet(252, { x: 41_069, y: 26_768 }))('stepLeg with stayDry: a crossing waits for those still swimming', () => {
    const T = 252;
    const river = { x: 41_069, y: 26_768 };
    const bank = { x: 38_500, y: 26_768 }; // dry, west of it
    const trip = (mem: Record<string, any>, now: number, dry = true) => ({ mem, now, regionId: T, level: 24, avoid: [], travelLeg: 1500, zAt: () => 0, dry });
    const out = (n: number) => Array.from({ length: n }, (_, i) => ({ x: bank.x + i * 50, y: bank.y }));
    const swimmers = [{ x: river.x, y: river.y }, { x: river.x - 100, y: river.y }];

    test('the leg on the bank is not reached, and a hunt doesn\'t replace it, until they are out', () => {
        expect(isDry(T, bank) && isWet(T, swimmers[0]!)).toBe(true);
        const mem: Record<string, any> = { legKind: 'patrol', leg: { ...bank, z: 0 }, legAt: 0, goal: { x: 30_000, y: 26_768 }, route: [{ x: 30_000, y: 26_768 }] };
        // Three out, two in the river: a hunt the other way keeps the leg.
        stepLeg(trip(mem, 5000), 'hunt', { x: 34_000, y: 30_000 }, { from: bank, movers: [...out(3), ...swimmers], replan: 800 });
        expect(mem.leg).toMatchObject(bank);
        expect(mem.legKind).toBe('patrol');
        // All out: the hunt plans from the bank.
        stepLeg(trip(mem, 20_000), 'hunt', { x: 34_000, y: 30_000 }, { from: bank, movers: out(5), replan: 800 });
        expect(mem.legKind).toBe('hunt');
        expect(Math.hypot(mem.leg.x - bank.x, mem.leg.y - bank.y)).toBeGreaterThan(500);
    });

    test('one in the water by the leg (its slot) does not hold the group, and a new leg keeps 800 from water on every side', () => {
        // Live, 23:37-23:44: legs along the Faste's moat put Morgana's slot in the water 700 off, and the group stood 60 s at each.
        const mem: Record<string, any> = { legKind: 'patrol', leg: { ...bank, z: 0 }, legAt: 0, goal: { x: 30_000, y: 26_768 }, route: [{ x: 30_000, y: 26_768 }] };
        const bySlot = { x: bank.x, y: bank.y };
        stepLeg(trip(mem, 5000), 'hunt', { x: 34_000, y: 30_000 }, { from: bank, movers: [...out(4), bySlot], replan: 800 });
        expect(mem.legKind).toBe('hunt');
        // Along the moat south of the Faste, westward.
        const walk: Record<string, any> = {};
        let at: Point = { x: 46_784, y: 41_591 };
        for (let i = 0; i < 15; i++) {
            stepLeg(trip(walk, i * 20_000), 'patrol', { x: 24_333, y: 42_788 }, { from: at, movers: [at], replan: Infinity });
            for (let k = 0; k < 16; k++) expect(isWet(T, { x: walk.leg.x + Math.cos(k * Math.PI / 8) * 700, y: walk.leg.y + Math.sin(k * Math.PI / 8) * 700 })).toBe(false);
            at = { x: walk.leg.x, y: walk.leg.y };
        }
    });

    test('stuck swimming past LEG_SWIM_MS, or stayDry off: the group goes on', () => {
        const mem = () => ({ legKind: 'patrol', leg: { ...bank, z: 0 }, legAt: 0, goal: { x: 30_000, y: 26_768 }, route: [{ x: 30_000, y: 26_768 }] } as Record<string, any>);
        const late = mem();
        stepLeg(trip(late, 61_000), 'hunt', { x: 34_000, y: 30_000 }, { from: bank, movers: [...out(3), ...swimmers], replan: 800 });
        expect(late.legKind).toBe('hunt');
        const wet = mem();
        stepLeg(trip(wet, 5000, false), 'hunt', { x: 34_000, y: 30_000 }, { from: bank, movers: [...out(3), ...swimmers], replan: 800 });
        expect(wet.legKind).toBe('hunt');
    });
});

describe('decideRvr in a pair round: no regrouping on the way to the ring', () => {
    // Hibernia against Midgard: the ring round (33000, 25000). Three at Hibernia's arrival, two released and walking out from 9k off.
    const T = 252;
    const ring = BATTLEGROUND_LAYOUTS[T]!.pairs!['hibernia|midgard']!;
    const home = homeOf(T, 'hibernia')!.arrival;
    const run = (base: Point, over: Partial<Record<string, Partial<MemberReport>>>, opponent: 'midgard' | null = 'midgard') =>
        decideRvr(ctx(picture(team(over, base, T), []), { memory: { realm: 'hibernia' }, settings: { patrol: null, opponent } }));
    const away = { Menta: { x: home.x + 9000, y: home.y + 2000 }, Encha: { x: home.x + 9200, y: home.y + 2000 } };

    test('members away don\'t hold the group: it goes for the ring, and waits for them there', () => {
        const u = run(home, away);
        expect(u.phase).toBe('travel');
        expect(u.reason).toMatch(/^patrol/);
        const at = run({ x: ring.x - 4000, y: ring.y }, { Menta: { x: home.x, y: home.y }, Encha: { x: home.x + 100, y: home.y } });
        expect(at.phase).toBe('recover');
        expect(at.waiting).toEqual(expect.arrayContaining([{ name: 'Menta', why: 'away' }, { name: 'Encha', why: 'away' }]));
        // Not a pair round: they are met halfway, as before.
        expect(run(home, away, null).phase).toBe('gather');
    });

    test('one short of power sets out; two, or at the ring, rest first', () => {
        expect(run(home, { Menta: { mana: 20 } }).reason).toMatch(/^patrol/);
        expect(run(home, { Menta: { mana: 20 }, Encha: { mana: 20 } }).phase).toBe('recover');
        expect(run({ x: ring.x - 4000, y: ring.y }, { Menta: { mana: 20 } }).phase).toBe('recover');
        // Short of health is no power: rest first.
        expect(run(home, { Menta: { hp: 40 } }).phase).toBe('recover');
    });
});

describe('decideRvr: attacked by keep guards it cannot see', () => {
    // Arena round 26, 2026-11-10: Hibernia rested 3909 from the Faste (Albion's), an Armswoman attacked, three died healing.
    const T = 252;
    const faste = BATTLEGROUND_LAYOUTS[T]!.keeps.find(k => k.name === 'Thidranki Faste')!;
    const spot = { x: 29_571, y: 36_567 };
    const run = (over: Partial<Record<string, Partial<MemberReport>>>) =>
        decideRvr(ctx(picture(team(over, spot, T), []), { memory: { realm: 'hibernia' }, settings: { patrol: null, opponent: 'albion' } }));
    const from = (p: Point) => Math.hypot(p.x - faste.x, p.y - faste.y);

    test('in combat with nothing on the board, near an enemy keep: it walks off, away from the keep', () => {
        const u = run({ Bard: { inCombat: true }, Menta: { hp: 40 } });
        expect(u.phase).toBe('travel');
        expect(u.reason).toMatch(/unseen .* Thidranki Faste: moving off/);
        expect(from(u.anchor!)).toBeGreaterThan(from(spot));
    });

    test('out of combat it rests, outside the wider circle (4500) round the Faste', () => {
        const u = run({ Menta: { hp: 40 } });
        expect(u.phase).toBe('recover');
        expect(from(u.anchor!)).toBeGreaterThanOrEqual(4500);
    });
});

describe('decideRvr: a Necromancer in shade is its servant (blackboard.ts shadeBodies)', () => {
    const shade = (x: number) => albion(51, { x, isShade: true });
    const servant = (x: number, over: Partial<Contact> = {}) => albion(52, { kind: 'npc', name: 'necroservant', isPet: true, x, ...over });

    test('a shade and its servant out there, on nobody: hunted as one enemy, as the user would have', () => {
        const d = decideRvr(ctx(picture(team(), [shade(13_680), servant(13_900)])));
        expect(d.phase).toBe('travel');
        expect(d.objective).toContain('hunt 1 enemy');
        // The shade alone: nobody to hunt.
        expect(decideRvr(ctx(picture(team(), [shade(13_680)]))).objective).not.toContain('hunt');
    });

    test('close: the servant is the focus, never the shade', () => {
        const d = decideRvr(ctx(picture(team(), [shade(10_400), servant(10_600)])));
        expect(d).toMatchObject({ phase: 'engage', focus: 52 });
    });

    test('it counts as a head: six and a shade are seven, a fall-back at margin 2', () => {
        const six = [60, 61, 62, 63, 64, 65].map(id => albion(id, { x: 13_680 }));
        expect(decideRvr(ctx(picture(team(), six))).objective).toContain('hunt 6 enemies');
        const d = decideRvr(ctx(picture(team(), [...six, shade(13_680), servant(13_800)])));
        expect(d.objective).toContain('fall back');
    });
});

describe('decideRvr: help in time (S3, 2026-11-13)', () => {
    test('the caller falls back toward the helpers coming to its own call, and turns once they are with it', () => {
        const seven = [60, 61, 62, 63, 64, 65, 66].map(id => foe(id, { x: 14_000, y: 10_000 }));
        const spot = (x: number, alive: number) => ({ unit: 'hibernia-2', x, y: 10_000, z: 0, alive, size: 6, fight: false, phase: 'travel' });
        const own = (helperX: number, alive = 6) => [{ id: 'hibernia-3', kind: 'help', from: 'hibernia', why: 'sighted', at: { x: 9680, y: 10_000, z: 0 }, foes: 7, ours: 5, want: 3, asked: ['hibernia-2'], helpers: [spot(helperX, alive)] }];
        // Helpers 5000 west, the enemy east: fall back west, toward them.
        let d = decideRvr(ctx(picture(team(), seven), { memory: { ownCalls: own(4_700) } }));
        expect(d.objective).toContain('fall back toward hibernia-2 coming to help');
        expect(d.anchor!.x).toBeLessThan(9_700);
        // The helpers stand behind the enemy: away from them as before.
        d = decideRvr(ctx(picture(team(), seven), { memory: { ownCalls: own(18_000) } }));
        expect(d.objective).toContain('fall back away from them');
        // Four of them with us (within 2500): 7 against 5 + 4, no fall back.
        d = decideRvr(ctx(picture(team(), seven), { memory: { ownCalls: own(8_500, 4) } }));
        expect(d.reason).toMatch(/^hunt 7 enemies/);
    });

    test('roams within reach: farther than 4500 from the nearest friendly unit, it closes to 3000 first, then patrols', () => {
        const friend = (x: number, alive = 6) => ({ unit: 'hibernia-2', x, y: 10_000, z: 0, alive, size: 6, fight: false, phase: 'travel' });
        const memory: Record<string, any> = { realmUnits: [friend(20_000)] };
        const d = decideRvr(ctx(picture(team()), { memory }));
        expect(d.reason).toContain('roam near: hibernia-2');
        expect(d.anchor!.x).toBeGreaterThan(9_700);
        // Within 4500 but closing: on to 3000.
        memory.realmUnits = [friend(13_900)];
        expect(decideRvr(ctx(picture(team()), { memory })).reason).toContain('roam near');
        memory.realmUnits = [friend(12_500)];
        expect(decideRvr(ctx(picture(team()), { memory })).reason).toContain('patrol');
        // Not closing again until past 4500; a stealther alone (1 living) is no friend to roam by; roam: false is off.
        memory.realmUnits = [friend(13_900)];
        expect(decideRvr(ctx(picture(team()), { memory })).reason).toContain('patrol');
        expect(decideRvr(ctx(picture(team()), { memory: { realmUnits: [friend(20_000, 1)] } })).reason).toContain('patrol');
        expect(decideRvr(ctx(picture(team()), { memory: { realmUnits: [friend(20_000)] }, settings: { roam: false } })).reason).toContain('patrol');
    });
});

describe('decideRvr: roaming by a main group first (S3, live 13:24)', () => {
    test('a main group out is the friend to roam by, even farther than a trio', () => {
        const spot = (unit: string, x: number, size: number) => ({ unit, x, y: 10_000, z: 0, alive: size, size, fight: false, phase: 'travel' });
        const d = decideRvr(ctx(picture(team()), { memory: { realmUnits: [spot('hibernia-s1', 15_000, 3), spot('hibernia-2', 20_000, 6)] } }));
        expect(d.reason).toContain('roam near: hibernia-2');
        expect(decideRvr(ctx(picture(team()), { memory: { realmUnits: [spot('hibernia-s1', 15_000, 3)] } })).reason).toContain('roam near: hibernia-s1');
    });
});

describe('decideRvr: a keep guard on one of us is fought (S3, the user at 17:08: a Huscarl on Niamh, the group moved off)', () => {
    const guard = (id: number, x: number, target: string | null) => contact(id, { kind: 'npc', name: 'Huscarl', realm: 'midgard', level: 28, regionId: R, x, y: 10_000, z: 0, hp: 46, keepGuard: true, target, inCombat: true } as any);
    test('one on us is fought, alone or not (the user: no running from a guard once it has aggro); one on nobody is not', () => {
        expect(decideRvr(ctx(picture(team(), [guard(700, 9_900, 'Menta')]))).focus).toBe(700);
        expect([700, 701]).toContain(decideRvr(ctx(picture(team(), [guard(700, 9_900, 'Menta'), guard(701, 10_500, 'Tank')]))).focus ?? -1);
        expect(decideRvr(ctx(picture(team(), [guard(700, 9_900, null)]))).focus ?? null).toBeNull();
        // Raiding, the guards stay the raid's (raidStep).
        expect(decideRvr(ctx(picture(team(), [guard(700, 9_900, 'Menta')]), { memory: { raid: { callId: 'x' } } })).focus ?? null).toBeNull();
    });
});
