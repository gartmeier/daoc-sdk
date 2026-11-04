import { describe, expect, test } from 'bun:test';
import { makePlayer, makePlayerObj, makeState } from '../test/fixtures';
import type { CombatEvent } from '../types';
import { Blackboard, observeState } from './blackboard';
import { contact, enemy, picture, report } from './fixtures';
import type { RunReport } from './observer';
import { memoryView } from './publish';
import { BATTLEGROUND_LAYOUTS, decideRvr, defaultPatrol, homeOf, keepDangers, pickRvrFocus, RVR_SETTINGS, rvrFindings, rvrRoaming, type RvrSettings } from './rvr';
import { mergeSettings, type CoordinatorContext } from './strategy';
import { aggroZones, safePath } from './terrain';
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

    test('the default margin is 3 (round 6): seven against five is a fight, eight a retreat', () => {
        expect(RVR_SETTINGS.retreat.margin).toBe(3);
        const tuned = (n: number) => decideRvr(ctx(picture(team(), Array.from({ length: n }, (_, i) => foe(60 + i))), { settings: { retreat: { margin: 3 } } }));
        expect(tuned(7).phase).toBe('engage');
        expect(tuned(8).phase).toBe('retreat');
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
        d = step(25_000, [...seven, ...brawl], fighting);
        expect(d.phase).toBe('retreat');
        expect(d.reason).toBe('retreat: 7 of 15 enemies vs 5');
    });

    test('caught: fights on while they outnumber us, and runs again once the odds evened out in between', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, contacts: Contact[], orders: Partial<Orders> = {}) => decideRvr(ctx(picture(team(), contacts, orders, now + ms), { memory, now: now + ms }));
        let d = step(0, seven);
        d = step(25_000, seven, { phase: 'retreat', retreatTo: d.retreatTo!, reason: d.reason });
        expect(d.reason).toContain('caught: ');
        const fighting = { phase: 'engage' as const, focus: d.focus!, anchor: d.anchor! };
        expect(step(26_000, seven, fighting).reason).toContain('caught: ');
        // Three of them mezzed: four against us, below the margin.
        const mezz = { by: 'Bard', kind: 'mezz', until: now + 40_000 };
        d = step(27_000, seven.map(c => (c.objectId > 13 ? { ...c, cc: mezz } : c)), fighting);
        expect(d.phase).toBe('engage');
        expect(d.reason).not.toContain('caught');
        // Awake again: seven against five is a new retreat, not a fight we were caught in.
        expect(step(35_000, seven, fighting).phase).toBe('retreat');
    });
});

describe('decideRvr: crowd control assignments', () => {
    const now = Date.now();
    const foes = [foe(51, { healer: true }), foe(52)];

    test('a mezz not landed in 8 s goes to another mezzer (ours may be mezzed itself), who keeps it; the first gets none for a while', () => {
        const memory: Record<string, any> = {};
        const step = (ms: number, cc: Orders['cc'], contacts = foes) => decideRvr(ctx(picture(team(), contacts, { phase: 'engage', focus: 51, cc }, now + ms), { memory, now: now + ms }));
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
            decideRvr(ctx(picture(team({ Bard: bard }), foes, { phase: 'engage', focus: 51, cc }, now + ms), { memory, now: now + ms })).cc;

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
        expect(of('hibernia')).toEqual(['Thidranki Faste 3000', 'Midgard Portal Keep 4500', 'Albion Portal Keep 4500']);
        expect(of('albion')).toEqual(['Hibernia Portal Keep 4500', 'Midgard Portal Keep 4500']);
        expect(of('albion', { keepOwners: { 'Thidranki Faste': 'midgard' } })).toContain('Thidranki Faste 3000');
        expect(of('midgard', { keepOwners: { 'Thidranki Faste': 'midgard' } })).not.toContain('Thidranki Faste 3000');
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

describe('rvrRoaming', () => {
    test('role lists without a town healer visit; tank list as specified', () => {
        expect(rvrRoaming.behaviors.tank.map(b => b.name)).toEqual(['release', 'hand', 'sprint', 'retreat', 'rejoinFight', 'rez', 'tank', 'guard', 'shedLoad', 'holdFormation', 'buff', 'rest']);
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
