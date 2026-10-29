import { describe, expect, test } from 'bun:test';
import { chunkMessage } from '../chunking';
import { ChatHistory, isOwnMessage, isPlayerChat } from '../chat-history';
import { makeMessage } from './fixtures';

describe('chunkMessage', () => {
    test('short text is one chunk', () => {
        expect(chunkMessage('hello world', 200)).toEqual(['hello world']);
    });

    test('splits on word boundaries within the cap', () => {
        const chunks = chunkMessage('aaa bbb ccc ddd', 7);
        expect(chunks).toEqual(['aaa bbb', 'ccc ddd']);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(7);
    });

    test('hard-splits oversized words without dropping characters', () => {
        const word = 'x'.repeat(25);
        const chunks = chunkMessage(`hi ${word} yo`, 10);
        expect(chunks.join('')).toBe(`hi${word}yo`);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    });

    test('collapses whitespace and handles empty text', () => {
        expect(chunkMessage('  a \n\t b  ', 200)).toEqual(['a b']);
        expect(chunkMessage('   ', 200)).toEqual([]);
    });
});

describe('ChatHistory', () => {
    test('dedups overlapping snapshots by id', () => {
        const h = new ChatHistory();
        expect(h.record([makeMessage(1, 'a'), makeMessage(2, 'b')])).toHaveLength(2);
        expect(h.record([makeMessage(1, 'a'), makeMessage(2, 'b'), makeMessage(3, 'c')]).map(m => m.text)).toEqual(['c']);
        expect(h.all().map(m => m.id)).toEqual([1, 2, 3]);
        expect(h.seen).toBe(3);
    });

    test('a restarted client (ids went backwards) is all new', () => {
        const h = new ChatHistory();
        h.record([makeMessage(10, 'old'), makeMessage(11, 'old2')]);
        expect(h.record([makeMessage(1, 'new')]).map(m => m.text)).toEqual(['new']);
        expect(h.all()).toHaveLength(3);
    });

    test('since() returns what came after a cursor', () => {
        const h = new ChatHistory();
        h.record([makeMessage(1, 'a')]);
        const cursor = h.seen;
        h.record([makeMessage(1, 'a'), makeMessage(2, 'b'), makeMessage(3, 'c')]);
        expect(h.since(cursor).map(m => m.text)).toEqual(['b', 'c']);
        expect(h.since(h.seen)).toEqual([]);
    });

    test('trims to the limit but keeps counting', () => {
        const h = new ChatHistory(3);
        h.record([1, 2, 3, 4, 5].map(i => makeMessage(i, String(i))));
        expect(h.all().map(m => m.id)).toEqual([3, 4, 5]);
        expect(h.seen).toBe(5);
        expect(h.since(0).map(m => m.id)).toEqual([3, 4, 5]);
    });

    test('empty snapshots are no-ops', () => {
        const h = new ChatHistory();
        expect(h.record([])).toEqual([]);
        expect(h.seen).toBe(0);
    });
});

describe('chat classification', () => {
    test('player chat types', () => {
        expect(isPlayerChat('say')).toBe(true);
        expect(isPlayerChat('send')).toBe(true);
        expect(isPlayerChat('group')).toBe(true);
        expect(isPlayerChat('system')).toBe(false);
        expect(isPlayerChat('youHit')).toBe(false);
    });

    test('own messages', () => {
        expect(isOwnMessage(makeMessage(1, 'You say, "hi"'), 'Bob')).toBe(true);
        expect(isOwnMessage(makeMessage(1, 'Bob says, "hi"', { sender: 'Bob' }), 'Bob')).toBe(true);
        expect(isOwnMessage(makeMessage(1, 'Ann says, "hi"', { sender: 'Ann' }), 'Bob')).toBe(false);
        expect(isOwnMessage(makeMessage(1, 'You send, "x" to Ann.'), null)).toBe(true);
    });
});
