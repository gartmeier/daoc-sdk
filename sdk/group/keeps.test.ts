import { describe, expect, test } from 'bun:test';
import { CAPTURE_GRACE_MS, KEEP_CLEARANCE, keepAt, keepDangers, KeepOwnerRead, parseCapture, THIDRANKI } from './keeps';

const FASTE = { x: 33089, y: 38271 };

describe('keepDangers and the raid setting', () => {
    test('the Faste has its circle for every realm but its owner, by default', () => {
        expect(keepDangers(THIDRANKI, 'midgard').map(d => d.name)).toContain('Thidranki Faste');
        expect(keepDangers(THIDRANKI, 'albion').map(d => d.name)).not.toContain('Thidranki Faste');
        expect(keepDangers(THIDRANKI, 'midgard').find(d => d.name === 'Thidranki Faste')!.r).toBe(KEEP_CLEARANCE.keep);
    });

    test('a raid lifts the circle of its own keep only', () => {
        const d = keepDangers(THIDRANKI, 'midgard', { raid: 'Thidranki Faste' }).map(x => x.name);
        expect(d).not.toContain('Thidranki Faste');
        expect(d).toEqual(expect.arrayContaining(['Albion Portal Keep', 'Hibernia Portal Keep']));
    });

    test('a raid never lifts a portal keep, and null or absent is off', () => {
        expect(keepDangers(THIDRANKI, 'midgard', { raid: 'Albion Portal Keep' }).map(x => x.name)).toContain('Albion Portal Keep');
        expect(keepDangers(THIDRANKI, 'midgard', { raid: null }).map(x => x.name)).toContain('Thidranki Faste');
    });

    test('keepOwners still decides whose keep it is', () => {
        expect(keepDangers(THIDRANKI, 'midgard', { keepOwners: { 'Thidranki Faste': 'midgard' } }).map(x => x.name)).not.toContain('Thidranki Faste');
        expect(keepDangers(THIDRANKI, 'albion', { keepOwners: { 'Thidranki Faste': 'midgard' } }).map(x => x.name)).toContain('Thidranki Faste');
    });
});

describe('parseCapture', () => {
    test('the broadcast as seen live', () => {
        expect(parseCapture('The forces of Midgard have captured Thidranki Faste!')).toEqual({ realm: 'midgard', keep: 'Thidranki Faste' });
        expect(parseCapture('The forces of Hibernia have captured Thidranki Faste!')).toEqual({ realm: 'hibernia', keep: 'Thidranki Faste' });
    });
    test('anything else', () => {
        expect(parseCapture('Thidranki Faste has been captured!')).toBeNull();
        expect(parseCapture('Lady Thidranki dies!')).toBeNull();
    });
});

describe('keepAt', () => {
    test('inside the Faste\'s area (3000) and a portal keep\'s (4000)', () => {
        expect(keepAt(THIDRANKI, { x: 32296, y: 38267 })?.name).toBe('Thidranki Faste');
        expect(keepAt(THIDRANKI, { x: FASTE.x + 2900, y: FASTE.y })?.name).toBe('Thidranki Faste');
        expect(keepAt(THIDRANKI, { x: FASTE.x + 3100, y: FASTE.y })).toBeNull();
        expect(keepAt(THIDRANKI, { x: 37301, y: 52362 - 3900 })?.name).toBe('Albion Portal Keep');
        expect(keepAt(1, FASTE)).toBeNull();
    });
});

describe('KeepOwnerRead', () => {
    const lord = (realm: string) => ({ realm, x: 32296, y: 38267, kind: 'npc' });

    test('the DB owner until something is read', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        expect(r.owner('Thidranki Faste')).toBe('albion');
        expect(r.reading('Thidranki Faste')).toBeNull();
        expect(r.owners()).toEqual({});
    });

    test('a capture broadcast changes it, once for its two copies', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        const text = 'The forces of Midgard have captured Thidranki Faste!';
        expect(r.seeMessages([{ id: 1, type: 'important', text, receivedAt: 1000 }, { id: 2, type: 'screenCenter', text, receivedAt: 1000 }])).toEqual(['Thidranki Faste']);
        expect(r.owner('Thidranki Faste')).toBe('midgard');
        expect(r.reading('Thidranki Faste')).toEqual({ realm: 'midgard', at: 1000, how: 'capture' });
        expect(r.owners()).toEqual({ 'Thidranki Faste': 'midgard' });
        // Ids already read are skipped.
        expect(r.seeMessages([{ id: 2, text: 'The forces of Hibernia have captured Thidranki Faste!' }])).toEqual([]);
        expect(r.owner('Thidranki Faste')).toBe('midgard');
    });

    test('a broadcast for a keep not in this region is left alone', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        expect(r.seeMessages([{ text: 'The forces of Midgard have captured Caer Benowyc!' }])).toEqual([]);
        expect(r.owners()).toEqual({});
    });

    test('the lord or any guard in the area gives the realm; pets, the dead and NPCs elsewhere do not', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        expect(r.seeNpcs([lord('albion')], 5000)).toEqual(['Thidranki Faste']);
        expect(r.reading('Thidranki Faste')).toMatchObject({ realm: 'albion', how: 'guard' });
        expect(r.seeNpcs([{ ...lord('hibernia'), isPet: true }, { ...lord('hibernia'), isDead: true }, { realm: 'hibernia', x: 10000, y: 10000 }], 6000)).toEqual([]);
        expect(r.owner('Thidranki Faste')).toBe('albion');
        expect(r.seeNpcs([lord('none'), { ...lord('hibernia'), regionId: 1 }], 6000)).toEqual([]);
        expect(r.seeNpcs([lord('hibernia')], 7000)).toEqual(['Thidranki Faste']);
        expect(r.owner('Thidranki Faste')).toBe('hibernia');
    });

    test('portal keeps are never read', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        expect(r.seeNpcs([{ realm: 'midgard', x: 37301, y: 52362 }], 1)).toEqual([]);
    });

    test('a stale old-realm guard just after a capture does not flip it back', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        r.seeMessages([{ text: 'The forces of Midgard have captured Thidranki Faste!', receivedAt: 10_000 }]);
        expect(r.seeNpcs([lord('albion')], 10_000 + CAPTURE_GRACE_MS - 1)).toEqual([]);
        expect(r.owner('Thidranki Faste')).toBe('midgard');
        // Long after, a guard of another realm means it changed hands again (a capture we missed).
        expect(r.seeNpcs([lord('albion')], 10_000 + CAPTURE_GRACE_MS + 1)).toEqual(['Thidranki Faste']);
        expect(r.owner('Thidranki Faste')).toBe('albion');
    });

    test('toJSON round-trips', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        r.seeMessages([{ text: 'The forces of Hibernia have captured Thidranki Faste!', receivedAt: 42 }]);
        const again = new KeepOwnerRead(THIDRANKI, JSON.parse(JSON.stringify(r)));
        expect(again.owner('Thidranki Faste')).toBe('hibernia');
        expect(again.reading('Thidranki Faste')).toEqual({ realm: 'hibernia', at: 42, how: 'capture' });
    });
});
