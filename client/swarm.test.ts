import { describe, expect, test } from 'bun:test';
import { controlRequests } from './swarm';

describe('controlRequests', () => {
    test('reads login and logout files, lower-cased, and ignores the rest', () => {
        expect(controlRequests(['niamh.logout', 'Brigid.LOGIN', 'state.json', 'state.json.tmp', 'x.y.login', 'oisin.login'])).toEqual({
            login: ['brigid', 'oisin'],
            logout: ['niamh'],
        });
    });

    test('an empty folder asks nothing', () => {
        expect(controlRequests([])).toEqual({ login: [], logout: [] });
    });
});
