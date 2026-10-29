import { describe, expect, test } from 'bun:test';
import { fromHex, hex } from '../protocol/buffer';
import { encodeCryptKeyRequest, encodeLoginRequest, encodeCharacterOverviewRequest } from '../protocol/outgoing';
import { checksum, decodeClientFrame, encodeClientFrame, ServerFrameDecoder } from './framing';

// Golden frames from docs/research/critic.md §1.3 (port of PacketProcessor.cs:608-622).
// The F4 'a' frame was also accepted by the live server (client/dev/smoke.ts).
const GOLDEN = {
    f4a: '00 07 00 00 00 00 00 00 00 F4 06 01 01 1B 61 00 00 53 B0',
    f40: '00 07 00 00 00 00 00 00 00 F4 06 01 01 1B 00 00 00 D7 8D',
    a7: '00 14 00 01 00 00 00 00 00 A7 05 00 00 00 62 6F 74 31 00 07 00 00 00 73 65 63 72 65 74 00 F2 CC',
    fc: '00 01 00 02 00 00 00 00 00 FC 01 87 FB',
};

describe('client frame encoding', () => {
    test('0xF4 CryptKeyRequest, revision a', () => {
        expect(hex(encodeClientFrame(0xF4, encodeCryptKeyRequest({ revision: 0x61 }), 0))).toBe(GOLDEN.f4a);
    });

    test('0xF4 CryptKeyRequest, revision 0', () => {
        expect(hex(encodeClientFrame(0xF4, encodeCryptKeyRequest({ revision: 0 }), 0))).toBe(GOLDEN.f40);
    });

    test('0xA7 LoginRequest bot1/secret, seq 1', () => {
        expect(hex(encodeClientFrame(0xA7, encodeLoginRequest('bot1', 'secret'), 1))).toBe(GOLDEN.a7);
    });

    test('0xFC CharacterOverviewRequest realm 1, seq 2', () => {
        expect(hex(encodeClientFrame(0xFC, encodeCharacterOverviewRequest(1), 2))).toBe(GOLDEN.fc);
    });

    test('F4 frame is 19 bytes (>= 19 selects the 1.115+ version branch, GameClient.cs:285-345)', () => {
        expect(encodeClientFrame(0xF4, encodeCryptKeyRequest()).length).toBe(19);
    });

    test('checksum wraps both accumulators at 8 bits', () => {
        const buf = new Uint8Array(300).fill(0xFF);
        let v1 = 0x7E;
        let v2 = 0x7E;
        for (const b of buf) {
            v1 = (v1 + b) % 256;
            v2 = (v2 + v1) % 256;
        }
        expect(checksum(buf, 0, buf.length)).toBe(((v2 - ((v1 + v2) << 8)) % 65536 + 65536) % 65536);
    });

    test('decodeClientFrame round-trips and rejects bad checksums', () => {
        const f = fromHex(GOLDEN.a7);
        const d = decodeClientFrame(f)!;
        expect(d.code).toBe(0xA7);
        expect(d.seq).toBe(1);
        expect(d.payload.length).toBe(0x14);
        f[f.length - 1]! ^= 1;
        expect(decodeClientFrame(f)).toBeNull();
    });
});

describe('ServerFrameDecoder', () => {
    const p1 = Uint8Array.of(0x00, 0x01, 0x2D, 0x00); // 0x2D GameOpenReply, payload 00
    const p2 = Uint8Array.of(0x00, 0x04, 0x74, 0x01, 0x00, 0x00, 0x00); // 0x74 AttackMode on
    const p3 = Uint8Array.of(0x00, 0x00, 0x2B); // zero-length payload

    test('splits concatenated packets', () => {
        const d = new ServerFrameDecoder();
        const out = d.push(Uint8Array.from([...p1, ...p2, ...p3]));
        expect(out.map(p => p.code)).toEqual([0x2D, 0x74, 0x2B]);
        expect(Array.from(out[1]!.payload)).toEqual([1, 0, 0, 0]);
        expect(out[2]!.payload.length).toBe(0);
        expect(d.pendingBytes).toBe(0);
    });

    test('reassembles packets split across reads, byte by byte', () => {
        const d = new ServerFrameDecoder();
        const all = Uint8Array.from([...p2, ...p1]);
        const got: number[] = [];
        for (const b of all) for (const p of d.push(Uint8Array.of(b))) got.push(p.code);
        expect(got).toEqual([0x74, 0x2D]);
    });

    test('keeps a partial tail', () => {
        const d = new ServerFrameDecoder();
        expect(d.push(Uint8Array.from([...p1, 0x00, 0x04, 0x74, 0x01]))).toHaveLength(1);
        expect(d.pendingBytes).toBe(4);
        expect(d.push(Uint8Array.of(0, 0, 0)).map(p => p.code)).toEqual([0x74]);
    });

    test('handles big payloads (u16 BE length)', () => {
        const payload = new Uint8Array(0x0123).fill(7);
        const frame = Uint8Array.from([0x01, 0x23, 0x02, ...payload]);
        const d = new ServerFrameDecoder();
        const out = d.push(frame.subarray(0, 100)).concat(d.push(frame.subarray(100)));
        expect(out).toHaveLength(1);
        expect(out[0]!.payload.length).toBe(0x123);
    });
});
