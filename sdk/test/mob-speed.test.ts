// How much room a cast needs before a mob on its way gets there.
import { describe, expect, test } from 'bun:test';
import { castRoom } from '../mob-speed';

describe('castRoom', () => {
    // A mob swings from 200 (GameLiving.cs:304, WeaponAction.cs:399-408), and a running one on arrival: an out-of-range tick retries every 100 ms (AttackAction.cs:426-432). Its swing stops the cast at the half way (SpellHandler.cs:356-372).
    // mob.sql, realm 0: 46585 of 92093 spawns above 190 (191: 21132, 200: 15049, 210: 982, 220: 1095, 250: 797, 335: 263, 400: 179).
    const halfWay = (castSeconds: number) => castSeconds / 2;
    const reachesBy = (d: number, speed: number) => (d - 200) / speed;

    for (const speed of [150, 190, 191, 200, 210, 220]) {
        test(`a mob at ${speed} from just outside a 5.9 s Simulacrum's room doesn't swing before the half way`, () => {
            expect(reachesBy(castRoom(5.9) + 1, speed)).toBeGreaterThan(halfWay(5.9));
        });
    }

    test('one seen running faster goes by what it runs at: 335 and 400 are in the DB', () => {
        for (const speed of [250, 335, 400]) {
            expect(reachesBy(castRoom(5.9) + 1, speed)).toBeLessThan(halfWay(5.9));
            expect(reachesBy(castRoom(5.9, speed) + 1, speed)).toBeGreaterThan(halfWay(5.9));
        }
    });

    test('one seen running slower still gets the fast room: a speed reading can come from a walk', () => {
        expect(castRoom(5.9, 100)).toBe(castRoom(5.9));
    });

    test('an instant cast needs none', () => {
        expect(castRoom(0)).toBe(0);
        expect(castRoom(0, 400)).toBe(0);
    });
});
