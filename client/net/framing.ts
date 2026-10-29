// Wire framing.
//
// C→S (GSPacketIn.cs:101-114, HDR_SIZE 12):
//   u16BE payloadLen | u16BE seq | u16BE session | u16BE param | u8 0 | u8 code | payload | u16BE checksum
// The checksum covers [0, 10+len) (PacketProcessor.cs:608-622). A bad TCP
// checksum disconnects (GameClient.cs:377-387).
//
// S→C TCP (GSTCPPacketOut.cs:21-25): u16BE payloadLen | u8 code | payload.
// No checksum, no encryption; many packets are concatenated per send.

export const CLIENT_HEADER_SIZE = 12;

export function checksum(buf: Uint8Array, off: number, len: number): number {
    let v1 = 0x7E;
    let v2 = 0x7E;
    for (let i = off; i < off + len; i++) {
        v1 = (v1 + buf[i]!) & 0xFF;
        v2 = (v2 + v1) & 0xFF;
    }
    return (v2 - ((v1 + v2) << 8)) & 0xFFFF;
}

export function encodeClientFrame(code: number, payload: Uint8Array, seq = 0, session = 0, param = 0): Uint8Array {
    const n = payload.length;
    const out = new Uint8Array(n + CLIENT_HEADER_SIZE);
    out[0] = (n >> 8) & 0xFF;
    out[1] = n & 0xFF;
    out[2] = (seq >> 8) & 0xFF;
    out[3] = seq & 0xFF;
    out[4] = (session >> 8) & 0xFF;
    out[5] = session & 0xFF;
    out[6] = (param >> 8) & 0xFF;
    out[7] = param & 0xFF;
    out[8] = 0;
    out[9] = code & 0xFF;
    out.set(payload, 10);
    const ck = checksum(out, 0, n + 10);
    out[n + 10] = (ck >> 8) & 0xFF;
    out[n + 11] = ck & 0xFF;
    return out;
}

export interface ServerPacket {
    code: number;
    payload: Uint8Array;
}

/** Streaming decoder for S→C frames. Feed it raw TCP chunks. */
export class ServerFrameDecoder {
    private buf = new Uint8Array(0);

    push(chunk: Uint8Array): ServerPacket[] {
        if (this.buf.length === 0) {
            this.buf = chunk.slice();
        } else {
            const next = new Uint8Array(this.buf.length + chunk.length);
            next.set(this.buf, 0);
            next.set(chunk, this.buf.length);
            this.buf = next;
        }
        const out: ServerPacket[] = [];
        let off = 0;
        while (this.buf.length - off >= 3) {
            const len = (this.buf[off]! << 8) | this.buf[off + 1]!;
            if (this.buf.length - off < len + 3) break;
            out.push({ code: this.buf[off + 2]!, payload: this.buf.slice(off + 3, off + 3 + len) });
            off += len + 3;
        }
        this.buf = off === 0 ? this.buf : this.buf.slice(off);
        return out;
    }

    get pendingBytes(): number {
        return this.buf.length;
    }
}

/** Decode one C→S frame (for tests and debugging). Returns null on checksum mismatch. */
export function decodeClientFrame(frame: Uint8Array): { code: number; seq: number; payload: Uint8Array } | null {
    if (frame.length < CLIENT_HEADER_SIZE) return null;
    const n = (frame[0]! << 8) | frame[1]!;
    if (frame.length < n + CLIENT_HEADER_SIZE) return null;
    const ck = (frame[n + 10]! << 8) | frame[n + 11]!;
    if (checksum(frame, 0, n + 10) !== ck) return null;
    return { code: frame[9]!, seq: (frame[2]! << 8) | frame[3]!, payload: frame.slice(10, 10 + n) };
}
