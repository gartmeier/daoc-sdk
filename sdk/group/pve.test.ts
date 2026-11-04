import { describe, expect, test } from 'bun:test';
import type { BasePlan } from './baseplan';
import { GroupObserver } from './observer';
import { assignCc, decidePve, pickFocus, pickPullTarget, PVE_SETTINGS, pveLeveling, rejectPull, type PveSettings } from './pve';
import { defineStrategy, mergeSettings, type CoordinatorContext } from './strategy';
import { contact, picture, report } from './fixtures';
import type { Contact, GroupPicture, MemberReport, Orders } from './types';

// Region 9999 has no spawns: no danger zones or aggro data get in the way.
const R = 9999;
const BASE = { x: 10_000, y: 10_000, z: 0 };
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [], buffSpells: [] });

function team(over: Partial<Record<string, Partial<MemberReport>>> = {}): MemberReport[] {
    const at = (dx: number) => ({ regionId: R, x: BASE.x + dx, y: BASE.y });
    return [
        report('Tank', { role: 'tank', objectId: 1, mana: 0, capabilities: caps(false, false, false), ...at(0), ...over.Tank }),
        report('Druid', { role: 'healer', objectId: 2, capabilities: caps(true, false, false), ...at(500), ...over.Druid }),
        report('Bard', { role: 'support', objectId: 3, capabilities: caps(true, true, true), ...at(-500), ...over.Bard }),
        report('Menta', { role: 'nuker', objectId: 4, capabilities: caps(true, true, true), ...at(800), ...over.Menta }),
    ];
}

function ctx(p: GroupPicture, opts: { orders?: Partial<Orders>; memory?: Record<string, any>; settings?: Partial<PveSettings>; now?: number; windingDown?: boolean } = {}): CoordinatorContext<PveSettings> {
    const memory = opts.memory ?? { camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE };
    return {
        picture: p, orders: { ...p.orders, ...opts.orders }, memory, now: opts.now ?? p.at, windingDown: opts.windingDown ?? false,
        settings: mergeSettings(PVE_SETTINGS, { avoidAggressive: false, ...opts.settings } as any),
    };
}

describe('decidePve', () => {
    test('rests until everyone is ready; a tank without power does not count as low on mana', () => {
        let d = decidePve(ctx(picture(team({ Druid: { mana: 30 } }))));
        expect(d.phase).toBe('recover');
        expect(d.waiting).toEqual([{ name: 'Druid', why: 'power' }]);
        d = decidePve(ctx(picture(team())));
        expect(d.phase).not.toBe('recover');
    });

    test('pulls the highest con in the window near the base, with the tank as puller', () => {
        const mobs = [
            contact(50, { regionId: R, level: 6, x: BASE.x + 800, y: BASE.y }),
            contact(51, { regionId: R, level: 7, x: BASE.x + 1200, y: BASE.y }),
            contact(52, { regionId: R, level: 9, x: BASE.x + 600, y: BASE.y }),   // con 3: out of the window
            contact(53, { regionId: R, level: 7, x: BASE.x + 5000, y: BASE.y }),  // too far
        ];
        const d = decidePve(ctx(picture(team(), mobs)));
        expect(d.phase).toBe('pull');
        expect(d.focus).toBe(51);
        expect(d.puller).toBe('Tank');
    });

    describe('roaming', () => {
        const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y });
        const settings = { roam: true };

        test('a passive mob is a fight for everyone at once: no puller, no carrying it home', () => {
            const d = decidePve(ctx(picture(team(), [mob]), { settings }));
            expect(d.phase).toBe('engage');
            expect(d.focus).toBe(51);
            expect(d.puller).toBeNull();
            expect(d.anchor).toMatchObject({ x: mob.x, y: mob.y });
        });

        test('the walk there stays the fight until the mob is dead or the time is up', () => {
            const now = Date.now();
            const walking = { orders: { phase: 'engage', focus: 51, reason: 'together' } as Partial<Orders>, settings, now };
            const memory = () => ({ camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE, pullStart: now - 1000 });
            expect(decidePve(ctx(picture(team(), [mob]), { ...walking, memory: memory() }))).toEqual({ phase: 'engage', reason: 'together' });
            const late = { ...memory(), pullStart: now - 60_000 };
            expect(decidePve(ctx(picture(team(), [mob]), { ...walking, memory: late })).focus).not.toBe(51);
            expect((late as { exclude?: Set<number> }).exclude?.has(51)).toBeTrue();
        });

        test('they rest where they stand: the base comes to the leader', () => {
            const at = { x: BASE.x + 700, y: BASE.y + 300 };
            const d = decidePve(ctx(picture(team({ Tank: at, Druid: { ...at, mana: 30 }, Bard: at, Menta: at })), { settings }));
            expect(d.phase).toBe('recover');
            expect(d.anchor).toMatchObject(at);
        });

        test('on the way to a new camp the base stays there; after a chase it comes along', () => {
            const far = { x: BASE.x + 9000, y: BASE.y };
            const together = team({ Tank: far, Druid: far, Bard: far, Menta: far });
            const memory = (heading: boolean) => ({ camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE, heading });
            expect(decidePve(ctx(picture(together), { settings, memory: memory(true) })).phase).toBe('travel');
            const chased = memory(false);
            expect(decidePve(ctx(picture(together), { settings, memory: chased })).phase).not.toBe('travel');
            expect(chased.base).toMatchObject(far);
        });

        test('a walk to a passive mob stays clear of aggressive mobs, even ones it would pull', () => {
            // Real spawns in region 200: aggroAt reads the static data. A trapper stands halfway to the eirebug.
            const trapper = contact(61, { regionId: 200, level: 12, x: 323284, y: 538834, name: 'curmudgeon trapper' });
            const eirebug = contact(60, { regionId: 200, level: 11, x: 326250, y: 535210, name: 'large eirebug' });
            const base = { x: 320318, y: 542458 };
            const opts = (roam: boolean) => ({ base, regionId: 200, level: 12, exclude: new Set<number>(), settings: mergeSettings(PVE_SETTINGS, { roam, aggroTolerance: 1, minCon: -3, maxCon: 3, huntRadius: 20_000 } as any) });
            expect(rejectPull(eirebug, [eirebug, trapper], opts(true))).toContain('aggressive on the way');
            expect(rejectPull(eirebug, [eirebug, trapper], opts(false))).toBeNull();
            // The trapper itself is still a target, so it goes first.
            expect(rejectPull(trapper, [eirebug, trapper], opts(true))).toBeNull();
        });

        test('split up, they gather first and the base stays', () => {
            const d = decidePve(ctx(picture(team({ Druid: { x: BASE.x + 4000 } })), { settings }));
            expect(d.phase).toBe('gather');
            expect(d.anchor).toMatchObject({ x: BASE.x, y: BASE.y });
        });
    });

    test('says why nothing was pulled', () => {
        const d = decidePve(ctx(picture(team(), [contact(52, { regionId: R, level: 9, x: BASE.x + 600, y: BASE.y })])));
        expect(d.phase).toBe('idle');
        expect(d.reason).toContain('con 3');
    });

    test('a body pull stays a pull until the mob is near the base, then the fight starts', () => {
        const now = Date.now();
        const memory = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE, pullStart: now - 5000 };
        const far = contact(51, { regionId: R, level: 7, x: BASE.x + 1500, y: BASE.y, target: 'Tank', targetId: 1, threat: true, hostileSince: now - 2000 });
        const orders = { phase: 'pull' as const, focus: 51, puller: 'Tank', anchor: BASE };
        let d = decidePve(ctx(picture(team({ Tank: { x: BASE.x + 1400 } }), [far], orders, now), { memory }));
        expect(d.phase).toBe('pull');
        const near = { ...far, x: BASE.x + 300 };
        d = decidePve(ctx(picture(team(), [near], orders, now), { memory }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
    });

    test('engage keeps the focus and gives an add to a mezzer (the support first)', () => {
        const now = Date.now();
        const focus = contact(51, { regionId: R, target: 'Tank', targetId: 1, threat: true, hostileSince: now - 9000, hp: 40, x: BASE.x, y: BASE.y });
        const add = contact(60, { regionId: R, target: 'Druid', targetId: 2, threat: true, hostileSince: now - 1000, hp: 100, x: BASE.x + 400, y: BASE.y });
        const d = decidePve(ctx(picture(team({ Tank: { targetId: 51 } }), [focus, add], { phase: 'engage', focus: 51 }, now)));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        expect(d.cc).toEqual([{ targetId: 60, by: 'Bard' }]);
    });

    test('the add count for a retreat leaves out the focus and adds with a mezz ordered', () => {
        const now = Date.now();
        const settings = { retreat: { ...PVE_SETTINGS.retreat, enabled: true, maxAdds: 2 } };
        const mob = (id: number) => contact(id, { regionId: R, target: 'Tank', targetId: 1, threat: true, hostileSince: now - 3000, hp: 90, x: BASE.x + 100, y: BASE.y });
        // The focus plus two adds the Bard and the Mentalist are mezzing: under control.
        let d = decidePve(ctx(picture(team(), [mob(51), mob(52), mob(53)], { phase: 'engage', focus: 51, cc: [{ targetId: 52, by: 'Bard' }, { targetId: 53, by: 'Menta' }] }, now), { settings }));
        expect(d.phase).toBe('engage');
        // A third add nobody can take: two adds loose (52 kept by the Bard, 53 and 54 have no mezzer left).
        d = decidePve(ctx(picture(team({ Menta: { capabilities: caps(true, false, true) } }), [mob(51), mob(52), mob(53), mob(54)], { phase: 'engage', focus: 51, cc: [{ targetId: 52, by: 'Bard' }] }, now), { settings }));
        expect(d.phase).toBe('retreat');
        expect(d.reason).toContain('2 adds not under control');
    });

    test('retreat is off by default; when on: retreats when the tank is dead, keeps running while followed', () => {
        const now = Date.now();
        const mob = contact(51, { regionId: R, target: 'Druid', targetId: 2, threat: true, hostileSince: now - 9000, hp: 90, x: BASE.x + 200, y: BASE.y });
        const memory: Record<string, any> = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE };
        const members = team({ Tank: { isDead: true, hp: 0 } });
        const settings = { retreat: { ...PVE_SETTINGS.retreat, enabled: true } };
        expect(decidePve(ctx(picture(members, [mob], { phase: 'engage', focus: 51 }, now), { memory: { ...memory } })).phase).toBe('engage');
        let d = decidePve(ctx(picture(members, [mob], { phase: 'engage', focus: 51 }, now), { memory, settings }));
        expect(d.phase).toBe('retreat');
        expect(d.retreatTo).toBeTruthy();
        expect(d.reason).toContain('tank is dead');
        d = decidePve(ctx(picture(members, [mob], { phase: 'retreat', reason: d.reason }, now + 5000), { memory, now: now + 5000, settings }));
        expect(d.phase).toBe('retreat');
        d = decidePve(ctx(picture(members, [mob], { phase: 'retreat', reason: d.reason }, now + 30_000), { memory, now: now + 30_000, settings }));
        expect(d.phase).toBe('retreat');   // still lost: the tank is dead, so it starts running again
    });

    test('travels in legs when most of the group is far away, gathers for a single straggler', () => {
        const far = (dx: number) => ({ x: BASE.x + dx, y: BASE.y });
        let d = decidePve(ctx(picture(team({ Tank: far(9000), Druid: far(9100), Bard: far(8900), Menta: far(9000) }))));
        expect(d.phase).toBe('travel');
        expect(Math.hypot(d.anchor!.x - (BASE.x + 9000), d.anchor!.y - BASE.y)).toBeLessThanOrEqual(PVE_SETTINGS.travelLeg + 1);
        // Next leg once the group stands at this one, even with casters trailing ~900 behind it.
        const memory: Record<string, any> = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE };
        const first = decidePve(ctx(picture(team({ Tank: far(9000), Druid: far(9100), Bard: far(8900), Menta: far(9000) })), { memory })).anchor!;
        const leg = (dx: number) => ({ x: first.x + dx, y: first.y });
        const second = decidePve(ctx(picture(team({ Tank: leg(0), Druid: leg(550), Bard: leg(550), Menta: leg(900) })), { memory })).anchor!;
        expect(first.x - second.x).toBeCloseTo(PVE_SETTINGS.travelLeg, -1);
        d = decidePve(ctx(picture(team({ Menta: far(5000) }))));
        expect(d.phase).toBe('gather');
        expect(d.reason).toContain('Menta');
    });

    describe('a far member doesn\'t steer the group', () => {
        // a4: Petcab released to his bind, '16:08:00 » travel: to the base, 10098 away', Pettan 7700 north of the base, toward him. 20261103-161617: 42998 away.
        const released = { x: BASE.x, y: BASE.y - 25_000 };
        const nearBy = (dx: number) => ({ x: BASE.x + dx, y: BASE.y });

        test('three of four beyond gatherRadius after a fight and one of them 25000 off: the legs go home from the two, not toward him', () => {
            const d = decidePve(ctx(picture(team({ Tank: nearBy(1500), Druid: nearBy(1600), Bard: nearBy(0), Menta: released }))));
            expect(d.phase).toBe('travel');
            expect(d.anchor).toMatchObject({ x: BASE.x + 50, y: BASE.y });
            expect(d.journey).toBe(1550);
            expect(d.reason).toBe('to the base, 1550 away; Menta far off, not waited for');
        });

        test('one of them beside the base and the far one left out: a gather for the one, as before', () => {
            const d = decidePve(ctx(picture(team({ Tank: nearBy(1500), Menta: released }))));
            expect(d.phase).toBe('gather');
            expect(d.waiting).toEqual([{ name: 'Tank', why: 'away' }]);
        });

        test('it holds no gather: "gather: waiting for Pethun" 82 % of the run, 180000 away. It holds the ready gate as a member in another region does: by its health and power, and the pull goes on', () => {
            const far = { x: BASE.x + 180_000, y: BASE.y };
            const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y });
            const d = decidePve(ctx(picture(team({ Menta: far }), [mob])));
            expect(d.phase).toBe('pull');
            expect(d.reason).toContain('Menta far off');
            const low = decidePve(ctx(picture(team({ Menta: { ...far, mana: 10 } }), [mob])));
            expect(low.phase).toBe('recover');
            expect(low.waiting).toEqual([{ name: 'Menta', why: 'power' }]);
            const elsewhere = decidePve(ctx(picture(team({ Menta: { regionId: 1, mana: 10 } }), [mob])));
            expect(elsewhere.waiting).toEqual(low.waiting);
        });

        test('a leg starts from the group, never the centroid of something with him in it', () => {
            const group = { x: BASE.x + 9000, y: BASE.y };
            const members = team({ Tank: group, Druid: { ...group, x: group.x + 100 }, Bard: { ...group, x: group.x - 100 }, Menta: released });
            const d = decidePve(ctx(picture(members)));
            expect(d.phase).toBe('travel');
            expect(Math.hypot(d.anchor!.x - group.x, d.anchor!.y - group.y)).toBeLessThanOrEqual(PVE_SETTINGS.travelLeg + 1);
            expect(d.journey).toBe(9000);
            expect(d.reason).toContain('Menta far off');
        });

        test('the tank is never left out: nothing can be pulled without him, and the others wait at the base', () => {
            const d = decidePve(ctx(picture(team({ Tank: released }))));
            expect(d.phase).toBe('gather');
            expect(d.waiting).toEqual([{ name: 'Tank', why: 'away' }]);
        });

        test('nobody far: the reason says nothing', () => {
            const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y });
            expect(decidePve(ctx(picture(team(), [mob]))).reason).not.toContain('far off');
        });

        test('the note doesn\'t pile up on a reason carried over', () => {
            const far = { x: BASE.x + 180_000, y: BASE.y };
            const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y });
            const memory: Record<string, any> = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE };
            const first = decidePve(ctx(picture(team({ Menta: far }), [mob]), { memory }));
            const next = decidePve(ctx(picture(team({ Menta: far }), [mob], { phase: 'pull', focus: 51, reason: first.reason }), { memory }));
            expect(next.reason.match(/far off/g)?.length).toBe(1);
        });

        test('a retreat runs from those near, with him out of the centre', () => {
            const now = Date.now();
            const threat = contact(51, { regionId: R, target: 'Tank', targetId: 1, threat: true, hostileSince: now - 9000, hp: 90, x: BASE.x + 200, y: BASE.y });
            const settings = { retreat: { ...PVE_SETTINGS.retreat, enabled: true, tankHp: 90 } };
            const d = decidePve(ctx(picture(team({ Tank: { hp: 50 }, Menta: released }), [threat], { phase: 'engage', focus: 51 }, now), { settings }));
            expect(d.phase).toBe('retreat');
            // Straight away from the mob, along x: nothing of the 25000 in y.
            expect(Math.abs(d.retreatTo!.y - BASE.y)).toBeLessThan(10);
        });
    });

    describe('a far tank', () => {
        const away = (dx: number, dy = 0) => ({ x: BASE.x + dx, y: BASE.y + dy });
        const BIND = away(60_000);
        const hunting = () => ({ camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE }) as Record<string, any>;

        // a2 04:36:34 '» travel: to the base, 33628 away; Petbon far off, not waited for', then 'Petspi: walk: died (Died en route to (771322, 758349))'. m3b (2 members) 'to the base, 60318 away; Petbon far off'.
        test('two members: the one at the base waits there, and nothing heads for the bind', () => {
            const d = decidePve(ctx(picture(team({ Tank: BIND, Druid: away(100) }).slice(0, 2))));
            expect(d.phase).toBe('gather');
            expect(d.anchor).toMatchObject(BASE);
            expect(d.waiting).toEqual([{ name: 'Tank', why: 'away' }]);
            expect(d.reason).toBe('waiting for Tank');
        });

        test('the others split: the median leaves him out, the one at the base isn\'t far, and there is no leg', () => {
            const memory = hunting();
            const d = decidePve(ctx(picture(team({ Tank: BIND, Druid: away(100), Bard: away(20_000) }).slice(0, 3)), { memory }));
            expect(d.phase).toBe('gather');
            expect(d.anchor).toMatchObject(BASE);
            expect(d.waiting).toEqual([{ name: 'Tank', why: 'away' }]);
            expect(d.reason).toBe('waiting for Tank; Bard far off, not waited for');
            expect(memory.leg).toBeFalsy();
        });

        test('all of them away from the base: a gather at the base all the same, and no leg goes off it', () => {
            const memory = hunting();
            const d = decidePve(ctx(picture(team({ Tank: BIND, Druid: away(9000, 9000), Bard: away(9100, 9000), Menta: away(9000, 9100) })), { memory }));
            expect(d.phase).toBe('gather');
            expect(d.anchor).toMatchObject(BASE);
            expect(d.waiting?.map(w => w.name).sort()).toEqual(['Bard', 'Druid', 'Menta', 'Tank']);
            expect(memory.leg).toBeFalsy();
        });

        test('near the base he is no far tank, whoever is off: a far member stays one, and doesn\'t hold the group', () => {
            const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y });
            const d = decidePve(ctx(picture(team({ Druid: away(180_000) }).slice(0, 2), [mob])));
            expect(d.phase).toBe('pull');
            expect(d.reason).toContain('Druid far off');
        });

        test('with someone beside him and someone at the base: that one holds there, and no leg sets out from the bind to walk it off', () => {
            const memory = hunting();
            const d = decidePve(ctx(picture(team({ Tank: BIND, Druid: away(60_100), Bard: away(0) }).slice(0, 3)), { memory }));
            expect(d.phase).toBe('gather');
            expect(d.anchor).toMatchObject(BASE);
            expect(d.waiting?.map(w => w.name)).toEqual(['Tank', 'Druid']);
            expect(d.reason).toBe('waiting for Tank, Druid');
            expect(memory.leg).toBeFalsy();
        });

        test('with nobody at the base the legs go home from where the group is, as ever', () => {
            const d = decidePve(ctx(picture(team({ Tank: BIND, Druid: away(60_100), Bard: away(59_900) }).slice(0, 3))));
            expect(d.phase).toBe('travel');
            expect(d.journey).toBe(60_000);
            expect(Math.hypot(d.anchor!.x - BIND.x, d.anchor!.y - BIND.y)).toBeLessThanOrEqual(PVE_SETTINGS.travelLeg + 1);
        });

        // Tank at the base, two released to a bind: the leg from their median walked him out, at 4800 he read far, the gather walked him back, and over: 50 phase changes in 700 s, and the group not home. 'Petspi: walk: died (Died en route ...)' is that walk.
        test('the tank at the base and the others at a bind, walked to their orders: nobody is led off it, and they all come home', () => {
            const memory = hunting();
            const at: Record<string, { x: number; y: number }> = { Tank: away(0), Druid: BIND, Bard: away(60_100) };
            const phases: string[] = [];
            let farthest = 0;
            const t0 = Date.now();
            for (let t = 0; t < 500; t++) {
                const now = t0 + t * 1000;
                const d = decidePve(ctx(picture(team({ Tank: at.Tank, Druid: at.Druid, Bard: at.Bard }).slice(0, 3), [], {}, now), { memory, now }));
                if (phases.at(-1) !== d.phase) phases.push(d.phase!);
                if (d.phase !== 'travel' && d.phase !== 'gather') break;
                for (const m of Object.values(at)) {
                    const dx = d.anchor!.x - m.x, dy = d.anchor!.y - m.y, gap = Math.hypot(dx, dy);
                    const f = Math.min(1, 191 / Math.max(1, gap));
                    m.x += dx * f;
                    m.y += dy * f;
                }
                farthest = Math.max(farthest, Math.hypot(at.Tank!.x - BASE.x, at.Tank!.y - BASE.y));
            }
            expect(farthest).toBeLessThan(PVE_SETTINGS.gatherRadius * 4);
            expect(phases.length).toBeLessThanOrEqual(4);
            for (const m of Object.values(at)) expect(Math.hypot(m.x - BASE.x, m.y - BASE.y)).toBeLessThan(PVE_SETTINGS.gatherRadius);
        });

        test('coming back: inside the limit he is one to gather for, as ever', () => {
            const d = decidePve(ctx(picture(team({ Tank: away(3000), Druid: away(0) }).slice(0, 2))));
            expect(d.phase).toBe('gather');
            expect(d.waiting).toEqual([{ name: 'Tank', why: 'away' }]);
        });

        test('a retreat with him far off runs from those near: nothing of the 60000 in where it goes', () => {
            const now = Date.now();
            const threat = contact(51, { regionId: R, target: 'Druid', targetId: 2, threat: true, hostileSince: now - 9000, hp: 90, x: BASE.x, y: BASE.y + 200 });
            const settings = { retreat: { ...PVE_SETTINGS.retreat, enabled: true, deaths: 1 } };
            const d = decidePve(ctx(picture([...team({ Tank: BIND, Druid: away(0), Bard: away(100) }), report('Gone', { isDead: true, regionId: R })], [threat], { phase: 'engage', focus: 51 }, now), { settings }));
            expect(d.phase).toBe('retreat');
            expect(Math.hypot(d.retreatTo!.x - BASE.x, d.retreatTo!.y - BASE.y)).toBeLessThan(PVE_SETTINGS.retreat.distance + 500);
        });
    });

    // 20261104-045702: '01:20 [orders] travel: to the base, 27472 away; Petsor, Petcab, Petthe far off, not waited for', with Petcab and Petsor at the base, Pettan at his bind.
    describe('a member at the base is never far', () => {
        test('with the group off elsewhere: the reason doesn\'t name it, and it waits there: no leg walks it out to them', () => {
            const at = (dx: number, dy = 0) => ({ x: BASE.x + dx, y: BASE.y + dy });
            const d = decidePve(ctx(picture([
                ...team({ Tank: at(20_000), Druid: at(20_100), Bard: at(300), Menta: at(-300) }),
                report('Cleric', { role: 'healer', regionId: R, ...at(20_200) }),
            ])));
            expect(d.phase).toBe('gather');
            expect(d.anchor).toMatchObject(BASE);
            expect(d.reason).toBe('waiting for Tank, Druid, Cleric');
        });

        test('a member well off the base and the group both is far, as ever', () => {
            const at = (dx: number) => ({ x: BASE.x + dx, y: BASE.y });
            const d = decidePve(ctx(picture(team({ Menta: at(25_000) }))));
            expect(d.reason).toContain('Menta far off');
        });
    });

    test('"pet power" where the ready gate waits on the power for a summon, and "power" otherwise', () => {
        const saving = { activity: { kind: 'rest', targetId: null, detail: 'pet: saving power', since: 0 }, mana: 10 };
        const d = decidePve(ctx(picture(team({ Druid: saving }))));
        expect(d.phase).toBe('recover');
        expect(d.waiting).toEqual([{ name: 'Druid', why: 'pet power' }]);
        expect(d.reason).toContain("Druid's pet power");
        expect(decidePve(ctx(picture(team({ Druid: { mana: 10 } })))).waiting).toEqual([{ name: 'Druid', why: 'power' }]);
    });

    describe('a pull and the tank\'s own pet', () => {
        const now = Date.now();
        const memory = () => ({ camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE, pullStart: now });
        const carried = (over: Partial<Contact>) => contact(51, { regionId: R, level: 7, x: BASE.x + 1500, y: BASE.y, threat: true, hostileSince: now - 2000, ...over });
        const orders = { phase: 'pull' as const, focus: 51, puller: 'Tank', anchor: BASE };

        test('passive doing its work, the mob on the tank: the pull goes on home', () => {
            const d = decidePve(ctx(picture(team({ Tank: { x: BASE.x + 1400 } }), [carried({ target: 'Tank', targetId: 1 })], orders, now), { memory: memory(), now }));
            expect(d.phase).toBe('pull');
        });

        test('a mob on the pet all the same (it took it before the passive, or aggro on a pet): the fight starts where it stands', () => {
            const d = decidePve(ctx(picture(team({ Tank: { x: BASE.x + 1400 } }), [carried({ target: null, targetPet: 'Tank', targetId: 900, targetSince: now - 1000 })], orders, now), { memory: memory(), now }));
            expect(d.phase).toBe('engage');
        });

        test('a reading on the pet not yet a snapshot old: the pull goes on. It may be a groupmate\'s client naming the pet for a blow it took, with the owner\'s line a snapshot behind; one coordinator tick on that would end the pull for good', () => {
            const d = decidePve(ctx(picture(team({ Tank: { x: BASE.x + 1400 } }), [carried({ target: null, targetPet: 'Tank', targetId: 900, targetSince: now - 100 })], orders, now), { memory: memory(), now }));
            expect(d.phase).toBe('pull');
        });
    });

    test('waits for dead members and starts nothing new when winding down', () => {
        let d = decidePve(ctx(picture(team({ Bard: { isDead: true } }))));
        expect(d.phase).toBe('recover');
        expect(d.reason).toContain('Bard');
        d = decidePve(ctx(picture(team(), [contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y })]), { windingDown: true }));
        expect(d.phase).toBe('recover');
    });

    test('a pull under way is finished when time is up (a mob already hit would follow the tank)', () => {
        const now = Date.now();
        const memory = { camp: { ...BASE, zone: '', count: 0, names: '' }, campLevel: 6, base: BASE, pullStart: now - 3000, exclude: new Set<number>() };
        const mob = contact(51, { regionId: R, level: 7, x: BASE.x + 1500, y: BASE.y });
        const d = decidePve(ctx(picture(team(), [mob], { phase: 'pull', focus: 51, puller: 'Tank', anchor: BASE }, now), { memory, windingDown: true }));
        expect(d.phase).toBe('pull');
    });

    test('with a base plan: no pulls from unsafe spawns, the group faces the targets, the objective names them', () => {
        const spawn = (x: number) => ({ name: 'water beetle', x, y: BASE.y, z: 0, level: 7, aggroLevel: 0, aggroRange: 0, flags: 0 });
        const plan: BasePlan = {
            base: BASE, facing: { x: BASE.x + 800, y: BASE.y }, score: 800, margin: 400,
            targets: [{ ...spawn(BASE.x + 800), d: 800 }], unsafe: [{ ...spawn(BASE.x - 900), why: 'stand: wild lucradan 700' }],
        };
        const memory = { camp: { ...BASE, zone: '', count: 0, names: 'beetles' }, campLevel: 6, base: BASE, plan, facing: plan.facing };
        // The beetle from the unsafe spawn cons higher and would win without the plan.
        const mobs = [contact(51, { regionId: R, level: 7, x: BASE.x + 800, y: BASE.y }), contact(52, { regionId: R, level: 8, x: BASE.x - 950, y: BASE.y + 50 })];
        const d = decidePve(ctx(picture(team(), mobs), { memory }));
        expect(d.phase).toBe('pull');
        expect(d.focus).toBe(51);
        expect(d.facing).toEqual(plan.facing);
        expect(d.objective).toContain('1 targets 800-800 away');
        expect(d.reason).toContain('800 away');
    });
});

describe('a group with no tank', () => {
    // bun groups/create-group.ts mid petbon petspi pethun gives nuker, nuker, melee. Run 20261103-154125: "» recover: no living tank to pull" for all 30 s, Downtime 100 %, and the only finding was the wait for Pethun's power.
    const T0 = 1_800_000_000_000;
    const noTank = () => [report('Petbon', { role: 'nuker', bot: 'petbon', regionId: R, ...BASE }), report('Petspi', { role: 'nuker', bot: 'petspi', regionId: R, ...BASE }), report('Pethun', { role: 'melee', bot: 'pethun', regionId: R, ...BASE })];
    const run = (ms: MemberReport[], phase: Orders['phase'] = 'recover') => {
        const o = new GroupObserver(null, { group: 'mid', strategy: 'mid-pve', startedAt: T0, findings: r => pveLeveling.findings!(r, PVE_SETTINGS) });
        for (let i = 1; i <= 30; i++) o.sample(picture(ms, [], { seq: 1, phase, reason: 'no living tank to pull' }, T0 + i * 1000));
        return o.report().findings.filter(f => f.topic === 'no-tank');
    };

    test('the coordinator\'s reason stays, and no one else pulls: a fallback puller is a strategy\'s to decide', () => {
        const u = decidePve(ctx(picture(noTank(), [], {})));
        expect(u).toMatchObject({ phase: 'recover', reason: 'no living tank to pull' });
        expect(u.puller ?? null).toBeNull();
    });

    test('a finding with --role=<bot>:tank as the advice: the melee member first', () => {
        const [f] = run(noTank());
        expect(f).toMatchObject({ severity: 'high', topic: 'no-tank' });
        expect(f!.issue).toContain('no tank');
        expect(f!.evidence).toContain('Petbon nuker, Petspi nuker, Pethun melee');
        expect(f!.suggestion).toContain('--role=pethun:tank');
        expect(f!.suggestion).toContain('group.json');
    });

    test('with no melee member, whoever comes first', () => {
        expect(run([report('Petbon', { role: 'nuker', bot: 'petbon' })])[0]!.suggestion).toContain('--role=petbon:tank');
    });

    test('a member with the role: none, also when it is dead', () => {
        expect(run(team())).toEqual([]);
        expect(run(team({ Tank: { isDead: true, hp: 0 } }))).toEqual([]);
    });

    test('a strategy of its own that pulls with someone else: none', () => {
        expect(run(noTank(), 'pull')).toEqual([]);
    });

    test('a strategy from defineStrategy keeps the rule', () => {
        expect(defineStrategy(pveLeveling, { name: 'mid-pve' }).findings).toBe(pveLeveling.findings);
    });
});

describe('rejectPull (static data, Lough Derg)', () => {
    test('maxLevelAbove rejects a mob far above the group that con still calls purple', () => {
        // camelot run 20261031-004507: Granddaddy Longlegs L24 at group level 11 conned 3 (purple).
        const longlegs = contact(53, { regionId: 200, name: 'red wolfhound', level: 24, x: 348300, y: 520700 });
        const at = (maxLevelAbove: number) => rejectPull(longlegs, [longlegs], { base: { x: 348800, y: 520300 }, regionId: 200, level: 11, exclude: new Set<number>(), settings: mergeSettings(PVE_SETTINGS, { huntRadius: 3500, maxCon: 3, maxLevelAbove } as any) });
        expect(at(4)).toBe('13 levels above');
        expect(at(99)).not.toBe('13 levels above');
    });

    test('a wolf whose pull walks past a live aggressive lucradan is rejected', () => {
        // Hunt 195452 / 201202: wolves west of the clearance base were pulled past a wild lucradan, which joined.
        const settings = mergeSettings(PVE_SETTINGS, { huntRadius: 3500, pullAggressive: false } as any);
        const base = { x: 350439, y: 521657 };
        const wolf = contact(51, { regionId: 200, name: 'red wolfhound', level: 12, x: 347046, y: 521117 });
        const lucradan = contact(52, { regionId: 200, name: 'wild lucradan', level: 10, x: 347965, y: 520638 });
        const opts = { base, regionId: 200, level: 12, exclude: new Set<number>(), settings };
        expect(rejectPull(wolf, [wolf, lucradan], opts)).toBe('aggressive on the way: wild lucradan');
        expect(rejectPull(wolf, [wolf], opts)).toBeNull();
    });

    test('with pullAggressive, aggressive mobs are pulled up to aggroTolerance; grey and tolerated ones block nothing', () => {
        // A level-13 wild lucradan at a lucradan spawn: aggressive (aggroAt goes by name and place), yellow to L13.
        const lucradan = contact(52, { regionId: 200, name: 'wild lucradan', level: 13, x: 347965, y: 520638 });
        const settings = (over: Partial<PveSettings>) => mergeSettings(PVE_SETTINGS, { huntRadius: 3500, maxCon: 3, ...over } as any);
        const at = (level: number, over: Partial<PveSettings>) => rejectPull(lucradan, [lucradan], { base: { x: 348800, y: 520300 }, regionId: 200, level, exclude: new Set<number>(), settings: settings(over) });
        expect(at(13, { pullAggressive: false, aggroTolerance: 0 })).toBe('aggressive');
        expect(at(13, { pullAggressive: true, aggroTolerance: 0 })).toBeNull();            // yellow: pulled
        expect(at(12, { pullAggressive: true, aggroTolerance: 0 })).toBe('aggressive');    // orange to L12: not
        // A tolerated (here blue) aggressive mob next to a wolf doesn't make the wolf "near aggressive mobs".
        const wolf = contact(51, { regionId: 200, name: 'red wolfhound', level: 12, x: 348300, y: 520700 });
        const blue = { ...lucradan, level: 10 };   // blue to L12
        const near = (tol: number) => rejectPull(wolf, [wolf, blue], { base: { x: 348800, y: 520300 }, regionId: 200, level: 12, exclude: new Set<number>(), settings: settings({ aggroTolerance: tol }) });
        expect(near(-3)).toBe('near aggressive wild lucradan');
        expect(near(-1)).toBeNull();
    });
});

describe('defineStrategy', () => {
    test('merges settings deeply and adds per-member behaviour lists', async () => {
        const { defineStrategy } = await import('./strategy');
        const { pveLeveling } = await import('./pve');
        const { assist, release } = await import('./behaviors');
        const s = defineStrategy(pveLeveling, { settings: { ready: { mana: 35 } }, memberBehaviors: { ciaran: [release(), assist({ holdMs: 4000 })] } });
        expect(s.settings.ready).toEqual({ hp: 80, mana: 35 });
        expect(s.settings.holdMs).toBe(PVE_SETTINGS.holdMs);
        expect(s.memberBehaviors?.ciaran?.map(b => b.name)).toEqual(['release', 'assist']);
        expect(s.behaviors.nuker).toBe(pveLeveling.behaviors.nuker);
    });
});

describe('focus and crowd control', () => {
    test('pickFocus: what the tank hits, else whoever is on a non-tank, never a mezzed mob if another is free', () => {
        const a = contact(1, { target: 'Tank', hp: 80, threat: true });
        const b = contact(2, { target: 'Druid', hp: 90, threat: true });
        const m = contact(3, { target: 'Druid', hp: 10, threat: true, cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 5000 } });
        const tank = report('Tank', { role: 'tank', targetId: 1 });
        expect(pickFocus([a, b, m], tank)?.objectId).toBe(1);
        expect(pickFocus([a, b, m], report('Tank', { role: 'tank' }))?.objectId).toBe(2);
    });

    test('assignCc keeps standing assignments and gives each add one mezzer', () => {
        const members = [
            report('Bard', { role: 'support', capabilities: caps(true, true, true) }),
            report('Menta', { role: 'nuker', capabilities: caps(true, true, true) }),
            report('Druid', { role: 'healer', capabilities: caps(true, false, false) }),
        ];
        const adds = [contact(7), contact(8), contact(9)];
        expect(assignCc(adds, members, [{ targetId: 8, by: 'Menta' }])).toEqual([{ targetId: 8, by: 'Menta' }, { targetId: 7, by: 'Bard' }]);
    });

    test('a root has no floor, so an NPC under 75 % goes to a member who holds one: the Midgard group\'s only cc is the Bonedancer\'s root (MesmerizeSpellHandler alone checks, CCSpellHandler.cs:174)', () => {
        const mezzer = report('Bard', { role: 'support', capabilities: caps(true, true, true) });
        const rooter = report('Bone', { role: 'nuker', capabilities: { ...caps(false, true, true), root: true } });
        const hurt = contact(7, { hp: 70 }), whole = contact(8, { hp: 90 });
        expect(assignCc([hurt], [rooter], [])).toEqual([{ targetId: 7, by: 'Bone' }]);
        // The mezzer comes first by role, and takes what it can take.
        expect(assignCc([hurt, whole], [mezzer, rooter], [])).toEqual([{ targetId: 7, by: 'Bone' }, { targetId: 8, by: 'Bard' }]);
        // An assignment stands while its member can carry it out.
        expect(assignCc([hurt], [mezzer, rooter], [{ targetId: 7, by: 'Bone' }])).toEqual([{ targetId: 7, by: 'Bone' }]);
        expect(assignCc([hurt], [mezzer, rooter], [{ targetId: 7, by: 'Bard' }])).toEqual([{ targetId: 7, by: 'Bone' }]);
    });

    test('so it is under control for retreat.maxAdds, as a root would hold it', () => {
        const members = team({ Menta: { capabilities: { ...caps(false, true, true), root: true } }, Bard: { capabilities: caps(false, false, false) } });
        const d = decidePve(ctx(picture(members, [contact(51, { regionId: R, threat: true, target: 'Tank', x: BASE.x, y: BASE.y }), contact(52, { regionId: R, threat: true, target: 'Tank', hp: 70, x: BASE.x, y: BASE.y })], { phase: 'engage', focus: 51 })));
        expect(d.cc).toEqual([{ targetId: 52, by: 'Menta' }]);
    });

    test('assignCc leaves an NPC under 75 % alone: a mezz can\'t take it (CCSpellHandler.cs:174-178), "Your target is enraged and resists the spell!" six times at 68-63 %', () => {
        const members = [report('Bard', { role: 'support', capabilities: caps(true, true, true) }), report('Menta', { role: 'nuker', capabilities: caps(true, true, true) })];
        const hurt = contact(7, { hp: 74 }), whole = contact(8, { hp: 75 });
        expect(assignCc([hurt, whole], members, [])).toEqual([{ targetId: 8, by: 'Bard' }]);
        // An assignment that stands goes with it, and leaves its mezzer free.
        expect(assignCc([hurt, whole], members, [{ targetId: 7, by: 'Bard' }])).toEqual([{ targetId: 8, by: 'Bard' }]);
        // Only an NPC: a player has no such floor.
        expect(assignCc([contact(9, { kind: 'player', hp: 20 })], members, [])).toEqual([{ targetId: 9, by: 'Bard' }]);
    });
});

describe('pets', () => {
    const near = { regionId: R, level: 6, x: BASE.x + 800, y: BASE.y };
    const opts = () => ({ base: BASE, regionId: R, level: 6, exclude: new Set<number>(), settings: mergeSettings(PVE_SETTINGS, { avoidAggressive: false } as any) });
    const enemyPet = (id: number, over: Partial<Contact> = {}) => contact(id, { ...near, realm: 'midgard', isPet: true, ...over });

    test('an enemy pet is never pulled, and isn\'t even a rejection', () => {
        const { target, rejected } = pickPullTarget([enemyPet(50), contact(51, near)], opts());
        expect(target?.objectId).toBe(51);
        expect(rejected).toEqual({});
        expect(pickPullTarget([enemyPet(50)], opts())).toEqual({ target: null, rejected: {} });
        expect(rejectPull(enemyPet(50), [], opts())).toBe('pet');
    });

    test('a mob on a member\'s pet is no one else\'s; a mob on a stranger still is', () => {
        expect(rejectPull(contact(50, { ...near, targetId: 500, target: null, targetPet: 'Hrafna' }), [], opts())).toBeNull();
        expect(rejectPull(contact(50, { ...near, targetId: 500, target: null, targetPet: null }), [], opts())).toBe('fighting someone else');
        expect(rejectPull(contact(50, { ...near, targetId: 500, target: null }), [], opts())).toBe('fighting someone else');
    });

    test('pickFocus: an enemy pet only when nothing else fights us, whoever it stands on', () => {
        const mob = contact(1, { target: 'Druid', hp: 90, threat: true });
        const pet = enemyPet(2, { target: 'Druid', hp: 10, threat: true });
        const tank = report('Tank', { role: 'tank', targetId: 2 });
        expect(pickFocus([pet, mob], tank)?.objectId).toBe(1);
        expect(pickFocus([pet, mob], report('Tank', { role: 'tank' }))?.objectId).toBe(1);
        expect(pickFocus([pet], tank)?.objectId).toBe(2);
        // A mezzed mob and a free pet: the mezz holds, so the pet.
        const mezzed = contact(3, { target: 'Druid', hp: 50, threat: true, cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 5000 } });
        expect(pickFocus([mezzed, pet], tank)?.objectId).toBe(2);
    });

    test('decidePve: nobody is assigned to mezz an enemy pet', () => {
        const now = Date.now();
        const mob = contact(1, { regionId: R, x: BASE.x, y: BASE.y, target: 'Tank', hp: 90, threat: true });
        const pet = enemyPet(2, { x: BASE.x, y: BASE.y, target: 'Menta', threat: true });
        const add = contact(3, { regionId: R, x: BASE.x, y: BASE.y, target: 'Menta', threat: true });
        const d = decidePve(ctx(picture(team({ Tank: { targetId: 1 } }), [mob, pet, add], { phase: 'engage', focus: 1 }, now)));
        expect(d.cc).toEqual([{ targetId: 3, by: 'Bard' }]);
    });

    test('a pull goes on while the mob comes for the puller or nobody, not once it turns on a pet', () => {
        const now = Date.now();
        const memory = () => ({ camp: { ...BASE, zone: '', count: 0, names: 'test camp' }, campLevel: 6, base: BASE, pullStart: now });
        const orders = { phase: 'pull' as const, focus: 50, puller: 'Tank', anchor: BASE };
        const far = { regionId: R, x: BASE.x + 1500, y: BASE.y, threat: true };
        const pulled = decidePve(ctx(picture(team(), [contact(50, { ...far, target: 'Tank' })], orders, now), { memory: memory() }));
        expect(pulled.phase).toBe('pull');
        const noTarget = decidePve(ctx(picture(team(), [contact(50, { ...far, target: null })], orders, now), { memory: memory() }));
        expect(noTarget.phase).toBe('pull');
        const onPet = decidePve(ctx(picture(team(), [contact(50, { ...far, target: null, targetId: 500, targetPet: 'Menta', targetSince: now - 1000 })], orders, now), { memory: memory() }));
        expect(onPet).toMatchObject({ phase: 'engage', focus: 50 });
    });

    test('the group waits for the power of a member whose only spell is its pet', () => {
        const d = decidePve(ctx(picture(team({ Tank: { capabilities: { ...caps(false, false, false), pet: 'main' }, mana: 30 } }))));
        expect(d).toMatchObject({ phase: 'recover', waiting: [{ name: 'Tank', why: 'power' }] });
    });

    test('a member with no pet waits as before', () => {
        const d = decidePve(ctx(picture(team({ Tank: { capabilities: { ...caps(false, false, false), pet: null }, mana: 30 } }))));
        expect(d.phase).not.toBe('recover');
    });

    test('the reason names a pet as what the focus attacks', () => {
        const now = Date.now();
        const d = decidePve(ctx(picture(team(), [contact(50, { regionId: R, x: BASE.x, y: BASE.y, target: null, targetPet: 'Menta', threat: true })], {}, now)));
        expect(d.reason).toContain('attacks Menta\'s pet');
    });
});
