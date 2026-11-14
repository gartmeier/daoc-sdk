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
