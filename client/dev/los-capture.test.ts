import { describe, expect, test } from 'bun:test';
import { encodeClientFrame } from '../net/framing';
import { encodeLosResponse } from '../protocol/outgoing';
import { clientStreams, losAnswers } from './los-capture';

/** A classic little-endian pcap with Linux cooked v1 frames: one IPv4 TCP packet per payload, to `port`. */
function pcapOf(port: number, payloads: { t: number; data: Uint8Array; seq: number }[]): Uint8Array {
    const parts: number[] = [];
    const u32 = (v: number) => parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    const u16 = (v: number) => parts.push(v & 255, (v >>> 8) & 255);
    u32(0xa1b2c3d4); u16(2); u16(4); u32(0); u32(0); u32(65535); u32(113);
    for (const p of payloads) {
        const ipLen = 20 + 20 + p.data.length;
        const pkt = new Uint8Array(16 + ipLen);
        const ip = 16;
        pkt[ip] = 0x45;
        pkt[ip + 2] = ipLen >> 8; pkt[ip + 3] = ipLen & 255;
        pkt[ip + 9] = 6;
        pkt.set([172, 20, 0, 1], ip + 12);
        pkt.set([172, 20, 0, 2], ip + 16);
        const tcp = ip + 20;
        pkt[tcp] = 40856 >> 8; pkt[tcp + 1] = 40856 & 255;
        pkt[tcp + 2] = port >> 8; pkt[tcp + 3] = port & 255;
        pkt[tcp + 4] = (p.seq >>> 24) & 255; pkt[tcp + 5] = (p.seq >>> 16) & 255; pkt[tcp + 6] = (p.seq >>> 8) & 255; pkt[tcp + 7] = p.seq & 255;
        pkt[tcp + 12] = 5 << 4;
        pkt.set(p.data, tcp + 20);
        u32(Math.floor(p.t)); u32(Math.round((p.t % 1) * 1e6)); u32(pkt.length); u32(pkt.length);
        parts.push(...pkt);
    }
    return new Uint8Array(parts);
}

describe('los-capture: a client\'s 0xD0 answers from a pcap', () => {
    test('frames split across packets, other packets skipped, a duplicate seen once', () => {
        const blocked = encodeClientFrame(0xd0, encodeLosResponse(41, 402, false), 7);
        const clear = encodeClientFrame(0xd0, encodeLosResponse(196, 402, true), 8);
        const other = encodeClientFrame(0xa9, new Uint8Array(20), 6);
        const stream = new Uint8Array([...other, ...blocked, ...clear]);
        const cut = other.length + 5;
        const pcap = pcapOf(10310, [
            { t: 100, data: stream.subarray(0, cut), seq: 1 },
            { t: 100, data: stream.subarray(0, cut), seq: 1 },
            { t: 101.5, data: stream.subarray(cut), seq: 1 + cut },
        ]);
        const streams = clientStreams(pcap, 10310);
        expect([...streams.keys()]).toEqual(['172.20.0.1:40856']);
        const answers = losAnswers('c', streams.get('172.20.0.1:40856')!);
        expect(answers.map(a => [a.checker, a.target, a.clear])).toEqual([[41, 402, false], [196, 402, true]]);
        expect(answers[0]!.t).toBeCloseTo(1.5);
        expect(clientStreams(pcap, 10300).size).toBe(0);
    });
});
