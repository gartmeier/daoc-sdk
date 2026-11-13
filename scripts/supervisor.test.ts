import { describe, expect, test } from 'bun:test';
import { nextBackoff } from './supervisor';

describe('nextBackoff', () => {
    test('a process that ran a minute or more starts again after 10 s', () => {
        expect(nextBackoff(160_000, 60_000)).toBe(10_000);
    });

    test('quick ends double the wait, up to 5 min', () => {
        expect(nextBackoff(10_000, 2_000)).toBe(20_000);
        expect(nextBackoff(200_000, 2_000)).toBe(300_000);
    });
});
