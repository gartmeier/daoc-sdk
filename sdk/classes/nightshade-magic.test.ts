import { describe, expect, test } from 'bun:test';
import { bestOf, finishWithCast, finishWithInstant, NIGHT_CASTS, NIGHT_INSTANTS, nightCast, nightInstant } from './nightshade-magic';

describe('bestOf', () => {
    test('Scathach at 24: Knife of Night (38) over Arrow of Night (33), Lesser Nocturnal Strike for the cast', () => {
        const known = ['Lesser Dusk Strike', 'Dart of Night', 'Dagger of Night', 'Knife of Night', 'Stiletto of Night', 'Arrow of Night', 'Gloaming Strike', 'Lesser Nocturnal Strike'].map(name => ({ name }));
        expect(bestOf(known, NIGHT_INSTANTS)).toBe('Knife of Night');
        expect(bestOf(known, NIGHT_CASTS)).toBe('Lesser Nocturnal Strike');
        expect(bestOf([{ name: 'Backstab' }], NIGHT_INSTANTS)).toBeNull();
    });
});

describe('when to cast', () => {
    test('the instant finishes a runner or a low target just out of melee, inside 650', () => {
        expect(finishWithInstant({ distance: 400, hp: 80, fleeing: true })).toBe(true);
        expect(finishWithInstant({ distance: 400, hp: 40, fleeing: false })).toBe(true);
        expect(finishWithInstant({ distance: 400, hp: 80, fleeing: false })).toBe(false);
        expect(finishWithInstant({ distance: 120, hp: 30, fleeing: true })).toBe(false);
        expect(finishWithInstant({ distance: 690, hp: 30, fleeing: true })).toBe(false);
    });
    test('the 3 s cast only on a low runner past the instant, with nobody on us', () => {
        expect(finishWithCast({ distance: 1000, hp: 30, fleeing: true, onUs: 0 })).toBe(true);
        expect(finishWithCast({ distance: 1000, hp: 30, fleeing: true, onUs: 1 })).toBe(false);
        expect(finishWithCast({ distance: 1000, hp: 60, fleeing: true, onUs: 0 })).toBe(false);
        expect(finishWithCast({ distance: 500, hp: 30, fleeing: true, onUs: 0 })).toBe(false);
        expect(finishWithCast({ distance: 1450, hp: 30, fleeing: true, onUs: 0 })).toBe(false);
    });
});

test('the behaviours', () => {
    expect([nightInstant().name, nightCast().name]).toEqual(['nightInstant', 'nightCast']);
});
