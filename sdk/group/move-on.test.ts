// The user, playing Niamh on 2026-11-14 09:36-09:42 (hibernia, field-20261114-091332.log): the pack chased a Midgard trio to
// Midgard's portal keep, re-engaged a healer it had let go 2 s before, turned to six Midgard at their keep and died to them and
// Albion. "Being a long time in the same place causes all sorts of trouble."
import { describe, expect, test } from 'bun:test';
import { enemy, picture, report } from './fixtures';
import { enemyPortalKeepAt, PK_APPROACH } from './keeps';
import { decidePack, PACK_SETTINGS } from './pack';
import { mergeSettings } from './strategy';
import { FIGHT_AREA, noteFight, ROAM_SETTINGS, roamStep, SPENT_MS, spentAreas, type RoamPlace } from './tactics/roam';
import { HOLD, holdFocus } from './tactics/focus-hold';
import { ctx as tctx, engage, foe as tfoe } from './tactics/fixtures';
import { isWet } from './water';
import type { Contact, MemberReport, Point } from './types';

const THID = 252;
const MID_PK = { x: 54_053, y: 24_680 };
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [], buffSpells: [] });
const team = (at: Point): MemberReport[] => [
    report('Tank', { role: 'tank', className: 'Hero', objectId: 1, mana: 0, capabilities: caps(false, false, false), regionId: THID, x: at.x, y: at.y, level: 24 }),
    report('Druid', { role: 'healer', className: 'Druid', objectId: 2, capabilities: caps(true, true, false), regionId: THID, x: at.x - 100, y: at.y + 100, level: 24 }),
    report('Bard', { role: 'support', className: 'Bard', objectId: 3, capabilities: caps(true, true, false), regionId: THID, x: at.x - 100, y: at.y - 100, level: 24 }),
    report('Menta', { role: 'nuker', className: 'Mentalist', objectId: 4, capabilities: caps(true, true, true), regionId: THID, x: at.x - 200, y: at.y + 100, level: 24 }),
    report('Encha', { role: 'nuker', className: 'Enchanter', objectId: 5, capabilities: caps(false, false, true), regionId: THID, x: at.x - 200, y: at.y - 100, level: 24 }),
];
const decide = (at: Point, contacts: Contact[], memory: Record<string, any>, now = 1_000_000, phase: 'travel' | 'engage' = 'travel', focus: number | null = null) =>
    decidePack({ picture: picture(team(at), contacts, {}, now), orders: { ...picture([], [], {}, now).orders, phase, focus }, memory, now, windingDown: false, settings: mergeSettings(PACK_SETTINGS, { patrol: null }) } as any);
const mid = (id: number, p: Point, over: Partial<Contact> = {}) => enemy(id, 'midgard', { regionId: THID, x: p.x, y: p.y, ...over });

describe('an enemy portal keep\'s approach', () => {
    test('within PK_APPROACH of a keep not ours, not of our own; the roam\'s approach places at 7500 are outside', () => {
        expect(enemyPortalKeepAt(THID, 'hibernia', { x: 48_773, y: 26_866 })?.name).toBe('Midgard Portal Keep');
        expect(enemyPortalKeepAt(THID, 'midgard', { x: 48_773, y: 26_866 })).toBeNull();
        expect(enemyPortalKeepAt(THID, 'hibernia', { x: MID_PK.x - PK_APPROACH - 100, y: MID_PK.y })).toBeNull();
        expect(enemyPortalKeepAt(THID, 'hibernia', { x: 46_553, y: 24_680 })).toBeNull();
    });

    const us = { x: 45_500, y: 27_000 };
    const trio = [mid(480, { x: 48_200, y: 26_800 }, { healer: true }), mid(435, { x: 48_300, y: 26_900 }), mid(468, { x: 48_250, y: 26_700 })];
    test.skipIf(isWet(THID, us) || trio.some(c => isWet(THID, c)))('a group at its own keep is no hunt, stalk or raid; on us, it is fought', () => {
        expect(enemyPortalKeepAt(THID, 'hibernia', trio[0]!)).not.toBeNull();
        const u = decide(us, trio, { realm: 'hibernia', pack: 'stalk' });
        expect(u.phase).not.toBe('engage');
        expect(u.reason ?? '').not.toMatch(/^(hunt|stalk|raid|closing in|standing off)/);
        const on = trio.map(c => ({ ...c, target: 'Tank', targetId: 1, threat: true, x: c.x - 2000 }));
        expect(decide(us, on, { realm: 'hibernia', pack: 'stalk' }).phase).toBe('engage');
    });
});

describe('a let-go runner stays let go for its time', () => {
    const us = { x: 34_000, y: 29_000 };
    test.skipIf(isWet(THID, us))('near and not on us: not the pack\'s focus; on us: it is', () => {
        const now = 1_000_000;
        const runner = mid(480, { x: us.x + 500, y: us.y }, { healer: true });
        const other = mid(435, { x: us.x + 1200, y: us.y });
        const memory = () => ({ realm: 'hibernia', pack: 'kill', killAt: now - 1000, runners: { 480: { outs: [], until: now + 50_000 } } });
        const u = decide(us, [runner, other], memory(), now, 'engage', 480);
        expect(u.focus).not.toBe(480);
        const onUs = { ...runner, target: 'Druid', targetId: 2 };
        expect(decide(us, [onUs], memory(), now, 'engage', 480).focus).toBe(480);
    });

    test('no hold keeps it', () => {
        const runners = { 1: { outs: [], until: 1_000_000 + 30_000 } };
        const c = tctx([tfoe(1, 1000), tfoe(2, 1100)], { orders: { phase: 'engage', focus: 1, anchor: { x: 11_000, y: 10_000, z: 0 } }, memory: { runners } });
        expect(holdFocus(c, engage(2), HOLD).focus).toBe(2);
        const later = tctx([tfoe(1, 1000), tfoe(2, 1100)], { orders: { phase: 'engage', focus: 1, anchor: { x: 11_000, y: 10_000, z: 0 } }, memory: { runners }, now: 1_000_000 + 31_000 });
        expect(holdFocus(later, engage(2), HOLD).focus).toBe(1);
    });
});

describe('moving on after fights in one area', () => {
    test('two fights within FIGHT_AREA make it spent for SPENT_MS; one long fight is one', () => {
        const mem: Record<string, any> = {};
        for (let t = 0; t <= 60_000; t += 1000) noteFight(mem, { x: 45_000, y: 27_000 }, t);
        expect(spentAreas(mem, 61_000)).toEqual([]);
        noteFight(mem, { x: 46_000, y: 27_500 }, 90_000);
        expect(spentAreas(mem, 91_000).length).toBe(2);
        noteFight(mem, { x: 45_000 + FIGHT_AREA + 2000, y: 27_000 }, 120_000);
        expect(spentAreas(mem, 121_000).length).toBe(2);
        expect(spentAreas(mem, 90_000 + SPENT_MS + 1)).toEqual([]);
    });

    test('the roam leaves a spent area and takes no place or sighting in it', () => {
        const near: RoamPlace = { key: 'a', what: 'place A', x: 45_500, y: 27_000 };
        const far: RoamPlace = { key: 'b', what: 'place B', x: 52_000, y: 32_000 };
        const mem: Record<string, any> = {};
        const centre = { x: 44_000, y: 27_000 };
        const s1 = roamStep(mem, { regionId: 0, centre, places: [near, far], now: 0 });
        expect(s1!.place.key).toBe('a');
        const spent = [{ x: 45_000, y: 27_000 }];
        const sightings = [{ x: 45_200, y: 27_100, n: 3, at: 1000 }];
        const s2 = roamStep(mem, { regionId: 0, centre, places: [near, far], sightings, now: 2000, spent });
        expect(s2!.place.key).toBe('b');
        expect(s2!.reason).toMatch(/^roam: moving on from where we fought, to place B/);
        expect(ROAM_SETTINGS.area).toBeLessThanOrEqual(FIGHT_AREA);
    });

    const us = { x: 34_000, y: 29_000 };
    test.skipIf(isWet(THID, us))('the pack notes its engages as fights', () => {
        const memory: Record<string, any> = { realm: 'hibernia', pack: 'stalk' };
        decide(us, [], memory, 1_000_000, 'engage', 480);
        decide(us, [], memory, 1_060_000, 'engage', 435);
        expect(spentAreas(memory, 1_061_000).length).toBe(2);
    });
});

describe('a member back with us owed buffs: the stop at once, the speed song, then on (the user, 2026-11-14 09:49: "they come. they buff. speed song. we go.")', () => {
    const us = { x: 34_000, y: 29_000 };
    const skin = { name: 'Stoutness of the Oak', slot: 'con' as any, target: 'Realm', concentration: 5 };
    const members = (menta: Partial<MemberReport>, mentaBuffed = false) => team(us).map(m => ({
        ...m,
        ...(m.name === 'Druid' ? { capabilities: { ...m.capabilities, buffSpells: [skin] } } : {}),
        effects: m.name !== 'Menta' || mentaBuffed ? [skin.name] : [],
        ...(m.name === 'Menta' ? menta : {}),
    }));
    const at = (ms: MemberReport[], memory: Record<string, any>, now: number) =>
        decidePack({ picture: picture(ms, [], {}, now), orders: { ...picture([], [], {}, now).orders, phase: 'travel' }, memory, now, windingDown: false, settings: mergeSettings(PACK_SETTINGS, { patrol: null }) } as any);

    test.skipIf(isWet(THID, us))('away in another region at the start, back: rebuff until it is on, 3 s on the road, then the roam', () => {
        const memory: Record<string, any> = { realm: 'hibernia', pack: 'stalk' };
        const t0 = 1_000_000;
        expect(at(members({ regionId: -1 }), memory, t0).reason).not.toMatch(/^rebuffing/);
        const back = at(members({}), memory, t0 + 1000);
        expect(back.phase).toBe('recover');
        expect(back.reason).toMatch(/^rebuffing: Menta back with us, 1 buff to go \((Stoutness of the Oak on Menta)\)/);
        expect(at(members({}), memory, t0 + 30_000).reason).toMatch(/^rebuffing: .*Stoutness of the Oak on Menta/);
        const speed = at(members({}, true), memory, t0 + 40_000);
        expect(speed.phase).toBe('travel');
        expect(speed.reason).toMatch(/^rebuffed: the speed song, then on/);
        expect(at(members({}, true), memory, t0 + 43_500).reason).toMatch(/^roam: /);
    });

    test.skipIf(isWet(THID, us))('a human asks for buffs: the stop once per ask; a joiner stop of the same meeting answers it', () => {
        const memory: Record<string, any> = { realm: 'hibernia', pack: 'stalk' };
        const t0 = 1_000_000;
        const human = (over: Partial<MemberReport> = {}, buffed = false) => members({ observed: true, bot: '', ...over }, buffed);
        expect(at(human(), memory, t0).reason).not.toMatch(/^rebuffing/);
        const asked = at(human({ buffAskedAt: t0 + 1000 }), memory, t0 + 1500);
        expect(asked.phase).toBe('recover');
        expect(asked.reason).toMatch(/^rebuffing: Menta asked for buffs/);
        // Buffed, the stop over: the same ask brings no second stop.
        let o = at(human({ buffAskedAt: t0 + 1000 }, true), memory, t0 + 20_000);
        for (let t = t0 + 24_000; t < t0 + 50_000; t += 2000) o = at(human({ buffAskedAt: t0 + 1000 }, true), memory, t);
        expect(o.reason).not.toMatch(/^rebuffing/);
        // Met after a pickup: back with us (the joiner stop) and the ask at once, one stop.
        const m2: Record<string, any> = { realm: 'hibernia', pack: 'stalk' };
        at(human({ regionId: -1 }), m2, t0);
        expect(at(human({ buffAskedAt: t0 + 1000 }), m2, t0 + 1000).reason).toMatch(/^rebuffing: Menta back with us/);
        for (let t = t0 + 3000; t < t0 + 40_000; t += 2000) at(human({ buffAskedAt: t0 + 1000 }, t > t0 + 10_000), m2, t);
        expect(at(human({ buffAskedAt: t0 + 1000 }, true), m2, t0 + 45_000).reason).not.toMatch(/^rebuffing/);
    });

    test.skipIf(isWet(THID, us))('back with nothing owed: no stop', () => {
        const memory: Record<string, any> = { realm: 'hibernia', pack: 'stalk' };
        at(members({ x: us.x + 6000 }, true), memory, 1_000_000);
        expect(at(members({}, true), memory, 1_001_000).reason).not.toMatch(/^rebuff/);
    });
});

describe('an open call of ours beyond the director\'s reach is the roam\'s heading (the user, 2026-11-14 10:07: "the group ignored Aine\'s call")', () => {
    const circuit: RoamPlace = { key: 'ring0', what: 'the meeting ground', x: 40_000, y: 30_000 };
    const call = (over: Partial<RoamPlace> = {}): RoamPlace => ({ key: 'call:hibernia-66', what: "hibernia-s1's call (5 enemies)", x: 22_699, y: 38_908, at: 0, ...over });
    const centre = { x: 38_000, y: 32_000 };

    test('first, at any distance; it takes over a circuit place after the 10 s hold; closed: on from where we are', () => {
        const mem: Record<string, any> = {};
        expect(roamStep(mem, { regionId: 0, centre, places: [circuit], now: 0 })!.place.key).toBe('ring0');
        // Held under 10 s: the circuit place stays.
        expect(roamStep(mem, { regionId: 0, centre, places: [circuit], calls: [call()], now: 5000 })!.place.key).toBe('ring0');
        const turn = roamStep(mem, { regionId: 0, centre, places: [circuit], calls: [call()], now: 11_000 })!;
        expect(turn.place.key).toBe('call:hibernia-66');
        expect(turn.reason).toMatch(/^roam: turning for hibernia-s1's call \(5 enemies\) \(22699, 38908\)/);
        const closed = roamStep(mem, { regionId: 0, centre: { x: 30_000, y: 35_000 }, places: [circuit], now: 30_000 })!;
        expect(closed.place.key).toBe('ring0');
        expect(closed.reason).toMatch(/^roam: hibernia-s1's call \(5 enemies\) closed, on to the meeting ground/);
    });

    test('reached and still open: done with it, the roam goes on', () => {
        const mem: Record<string, any> = {};
        roamStep(mem, { regionId: 0, centre, places: [circuit], calls: [call()], now: 0 });
        const there = roamStep(mem, { regionId: 0, centre: { x: 22_700, y: 38_900 }, places: [circuit], calls: [call()], now: 120_000 })!;
        expect(there.place.key).toBe('ring0');
        expect(there.reason).toMatch(/^roam: past hibernia-s1's call/);
    });

    const us = { x: 38_000, y: 32_000 };
    test.skipIf(isWet(THID, us) || isWet(THID, { x: 22_699, y: 38_908 }))('the pack walks toward a call 19000 away that the director did not ask it to', () => {
        const help = { id: 'hibernia-66', kind: 'help', from: 'hibernia-s1', why: 'caught', at: { x: 22_699, y: 38_908, z: 0 }, foes: 5, ours: 3, foeRoles: {}, want: 3, asked: [], coming: [], since: 1_000_000, updatedAt: 1_000_000 };
        const memory: Record<string, any> = { realm: 'hibernia', pack: 'stalk', realmUnit: 'hibernia', realmCalls: [help] };
        const u = decide(us, [], memory, 1_000_000);
        expect(u.phase).toBe('travel');
        expect(u.reason).toMatch(/^roam: to hibernia-s1's call \(5 enemies\)/);
        const ahead = decide(us, [], memory, 1_002_000);
        expect(Math.hypot(ahead.anchor!.x - help.at.x, ahead.anchor!.y - help.at.y)).toBeLessThan(Math.hypot(us.x - help.at.x, us.y - help.at.y));
    });
});
