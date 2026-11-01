import { describe, expect, test } from 'bun:test';
import { hasNoLook, lookFor } from './look';
import { RACE_MODELS } from './classes';

const nib = (v: number) => [v >> 4, v & 0xF];
const NAMES = ['Dalta', 'Cuchulainn', 'Brigid', 'Oisin', 'Niamh', 'Ciaran', 'Galahad', 'Nimue', 'Merlin', 'Morgana', 'Taliesin', 'Thorgrim', 'Sigrid', 'Ulfgar', 'Bragi', 'Hrafna'];

describe('lookFor', () => {
    test('stays inside the client tables for every race and gender', () => {
        for (const race of Object.keys(RACE_MODELS).map(Number)) {
            for (const gender of [0, 1]) {
                for (const name of NAMES) {
                    const k = lookFor(name, race, gender)!;
                    for (const m of [...nib(k.eyeSize), ...nib(k.lipSize)]) {
                        expect(m).toBeGreaterThanOrEqual(1);
                        expect(m).toBeLessThanOrEqual(7);
                    }
                    for (const c of nib(k.eyeColor)) expect(c).toBeLessThanOrEqual(7);
                    expect(k.hairColor).toBeLessThanOrEqual(15);
                    expect(k.faceType & 0xF).toBe(0);
                    expect(k.faceType >> 4).toBeGreaterThanOrEqual(1);
                    expect(k.faceType >> 4).toBeLessThanOrEqual(5);
                    expect(k.hairStyle >> 4).toBeGreaterThanOrEqual(1);
                    // Zero size is what the customize path bans for.
                    expect((k.model >> 11) & 3).toBeGreaterThanOrEqual(1);
                    expect(hasNoLook(k)).toBe(false);
                }
            }
        }
    });

    test('a name always gives the same look, whatever its case', () => {
        expect(lookFor('dalta', 11, 1)).toEqual(lookFor('Dalta', 11, 1));
    });

    test('characters of one race and gender come out different', () => {
        const looks = NAMES.map(n => lookFor(n, 1, 0)!);
        expect(new Set(looks.map(k => JSON.stringify(k))).size).toBe(NAMES.length);
        expect(new Set(looks.map(k => k.hairColor)).size).toBeGreaterThan(4);
        expect(new Set(looks.map(k => k.model & 0x7FF)).size).toBeGreaterThan(2);
    });

    test('hair picks the model the client maps it to', () => {
        // Lurikeen female hair 1..3 = 330, 331, 332 (fig3tofigmain.csv); Vue from the real client: hair 1, 330.
        const models = new Map<number, number>();
        for (let i = 0; i < 200; i++) {
            const k = lookFor(`Name${i}`, 12, 1)!;
            models.set(k.hairStyle >> 4, k.model & 0x7FF);
        }
        expect([...models.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, 330], [2, 331], [3, 332]]);
    });

    test('a race the tables lack has no look', () => {
        expect(lookFor('Dalta', 99, 0)).toBeNull();
    });
});
