import { describe, expect, test } from 'bun:test';
import { aggroAt, safePath } from './terrain';

describe('terrain (static data, Shannon Estuary)', () => {
    test('aggro comes from the nearest spawn: the same name is aggressive in one camp and passive in another', () => {
        expect(aggroAt(200, 'mudman', { x: 303753, y: 461624 })?.range).toBe(500);
        expect(aggroAt(200, 'mudman', { x: 288913, y: 457729 })).toBeNull();
        // The lugradan whelp camp east of Mag Mell: passive, though "feccan" is aggressive elsewhere.
        expect(aggroAt(200, 'feccan', { x: 307784, y: 634226 })).toBeNull();
        expect(aggroAt(200, 'no such mob', { x: 0, y: 0 })).toBeNull();
    });

    test('safePath is a straight line where nothing dangerous is in the way', () => {
        expect(safePath(9999, 5, { x: 0, y: 0 }, { x: 5000, y: 0 })).toEqual([{ x: 5000, y: 0 }]);
    });
});
