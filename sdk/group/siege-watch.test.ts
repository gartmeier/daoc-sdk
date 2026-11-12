import { describe, expect, test } from 'bun:test';
import { KeepOwnerRead, THIDRANKI } from './keeps';
import { describe as describeOwners, parseArgs, pickListeners, WATCH_DEFAULTS } from './siege-watch';

describe('siege-watch', () => {
    test('listeners: one per realm first, then the rest in order', () => {
        const bots = [
            { name: 'galahad', realm: 'albion' }, { name: 'merlin', realm: 'albion' },
            { name: 'sigurd', realm: 'midgard' }, { name: 'aine', realm: 'hibernia' },
        ];
        expect(pickListeners(bots, 3)).toEqual(['galahad', 'sigurd', 'aine']);
        expect(pickListeners(bots, 4)).toEqual(['galahad', 'sigurd', 'aine', 'merlin']);
        expect(pickListeners(bots, 1)).toEqual(['galahad']);
        expect(pickListeners([{ name: 'gudrun', realm: 'midgard' }, { name: 'hrafna', realm: 'midgard' }], 3)).toEqual(['gudrun', 'hrafna']);
    });

    test('flags', () => {
        expect(parseArgs([])).toMatchObject({ everyS: WATCH_DEFAULTS.everyS, sweepS: 300, listen: 3, watchS: 0, stateFile: null });
        expect(parseArgs(['--gateway=http://localhost:7795/', '--watch=60', '--listen=1', '--every=1', '--state=x.json']))
            .toMatchObject({ gateway: 'http://localhost:7795', watchS: 60, listen: 1, everyS: 2, stateFile: 'x.json' });
    });

    test('describe names the source of each reading', () => {
        const r = new KeepOwnerRead(THIDRANKI);
        expect(describeOwners(r)).toEqual(['Thidranki Faste: albion (by the DB (nothing seen yet))']);
        r.seeMessages([{ text: 'The forces of Midgard have captured Thidranki Faste!', receivedAt: Date.now() }]);
        expect(describeOwners(r)[0]).toMatch(/^Thidranki Faste: midgard \(by capture broadcast at /);
    });
});
