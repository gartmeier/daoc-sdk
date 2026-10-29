import { describe, expect, test } from 'bun:test';
import { logStamp } from './log-stamp';

describe('logStamp', () => {
    test('uses local time like the viewer, not UTC', () => {
        const d = new Date(2026, 9, 29, 13, 51, 7, 42); // local 13:51:07.042
        expect(logStamp(d)).toBe('13:51:07.042');
    });
});
