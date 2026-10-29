// Byte-level reader/writer for DAoC packets.
//
// Endianness is mixed per field: ReadShort/ReadInt in the C# PacketIn/PacketOut
// are big-endian, *LowEndian variants are little-endian, floats are f32 LE
// (CoreBase/Network/PacketIn.cs, PacketOut.cs). Strings are Windows-1252
// (BaseServer.DefaultEncoding, CoreBase/Network/BaseServer.cs:17).

// ── CP1252 ──────────────────────────────────────────────────────────────────

// 0x80..0x9F differ from Latin-1. Undefined bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D) map to themselves.
const CP1252_HIGH: number[] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];
const CP1252_REVERSE = new Map<number, number>();
CP1252_HIGH.forEach((cp, i) => CP1252_REVERSE.set(cp, 0x80 + i));

export function decodeCp1252(bytes: Uint8Array, start = 0, end = bytes.length): string {
    let s = '';
    for (let i = start; i < end; i++) {
        const b = bytes[i]!;
        s += String.fromCharCode(b >= 0x80 && b < 0xA0 ? CP1252_HIGH[b - 0x80]! : b);
    }
    return s;
}

export function encodeCp1252(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) out[i] = c;
        else out[i] = CP1252_REVERSE.get(c) ?? 0x3F; // '?'
    }
    return out;
}

// ── Reader ──────────────────────────────────────────────────────────────────

export class PacketReader {
    pos: number;
    private readonly view: DataView;

    constructor(readonly buf: Uint8Array, offset = 0) {
        this.pos = offset;
        this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    get remaining(): number {
        return this.buf.length - this.pos;
    }

    private need(n: number): void {
        if (this.pos + n > this.buf.length) {
            throw new RangeError(`read past end: need ${n} at ${this.pos}, length ${this.buf.length}`);
        }
    }

    u8(): number {
        this.need(1);
        return this.buf[this.pos++]!;
    }

    u16(): number {
        this.need(2);
        const v = this.view.getUint16(this.pos, false);
        this.pos += 2;
        return v;
    }

    /** Signed 16-bit BE: the C# `WriteShort((ushort) negativeInt)` two's-complement form. */
    i16(): number {
        const v = this.u16();
        return v >= 0x8000 ? v - 0x10000 : v;
    }

    u16le(): number {
        this.need(2);
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    u32(): number {
        this.need(4);
        const v = this.view.getUint32(this.pos, false);
        this.pos += 4;
        return v;
    }

    u32le(): number {
        this.need(4);
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    /** u64 LE as a JS number (exact up to 2^53). */
    u64le(): number {
        const lo = this.u32le();
        const hi = this.u32le();
        return hi * 0x1_0000_0000 + lo;
    }

    f32le(): number {
        this.need(4);
        const v = this.view.getFloat32(this.pos, true);
        this.pos += 4;
        return v;
    }

    skip(n: number): void {
        this.need(n);
        this.pos += n;
    }

    bytes(n: number): Uint8Array {
        this.need(n);
        const b = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return b;
    }

    /** Exactly n bytes, truncated at the first NUL (PacketIn.ReadString(n)). */
    fixedString(n: number): string {
        const b = this.bytes(n);
        const nul = b.indexOf(0);
        return decodeCp1252(b, 0, nul === -1 ? n : nul);
    }

    /** u8 length + bytes (PacketOut.WritePascalString). */
    pascal(): string {
        return this.fixedString(this.u8());
    }

    /** u32 LE length + bytes, NUL-truncated (WritePascalStringIntLE / ReadIntPascalStringLowEndian). */
    intLePascal(): string {
        return this.fixedString(this.u32le());
    }

    /** NUL-terminated string; consumes the terminator. Reads to end if none. */
    cString(): string {
        const start = this.pos;
        let end = start;
        while (end < this.buf.length && this.buf[end] !== 0) end++;
        const s = decodeCp1252(this.buf, start, end);
        this.pos = Math.min(this.buf.length, end + 1);
        return s;
    }
}

// ── Writer ──────────────────────────────────────────────────────────────────

export class PacketWriter {
    private buf: Uint8Array;
    private view: DataView;
    length = 0;

    constructor(initial = 64) {
        this.buf = new Uint8Array(initial);
        this.view = new DataView(this.buf.buffer);
    }

    private ensure(n: number): void {
        if (this.length + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.length + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    u8(v: number): this {
        this.ensure(1);
        this.buf[this.length++] = v & 0xFF;
        return this;
    }

    u16(v: number): this {
        this.ensure(2);
        this.view.setUint16(this.length, v & 0xFFFF, false);
        this.length += 2;
        return this;
    }

    u16le(v: number): this {
        this.ensure(2);
        this.view.setUint16(this.length, v & 0xFFFF, true);
        this.length += 2;
        return this;
    }

    u32(v: number): this {
        this.ensure(4);
        this.view.setUint32(this.length, v >>> 0, false);
        this.length += 4;
        return this;
    }

    u32le(v: number): this {
        this.ensure(4);
        this.view.setUint32(this.length, v >>> 0, true);
        this.length += 4;
        return this;
    }

    f32le(v: number): this {
        this.ensure(4);
        this.view.setFloat32(this.length, v, true);
        this.length += 4;
        return this;
    }

    bytes(b: ArrayLike<number>): this {
        this.ensure(b.length);
        this.buf.set(b, this.length);
        this.length += b.length;
        return this;
    }

    fill(v: number, n: number): this {
        this.ensure(n);
        this.buf.fill(v & 0xFF, this.length, this.length + n);
        this.length += n;
        return this;
    }

    /** u8 length + bytes, no NUL (max 255). */
    pascal(s: string): this {
        const b = encodeCp1252(s).subarray(0, 255);
        return this.u8(b.length).bytes(b);
    }

    /** u32 LE (len+1) + bytes + NUL; empty string is u32 0 (PacketOut.WritePascalStringIntLE). */
    intLePascal(s: string): this {
        if (s.length === 0) return this.u32le(0);
        const b = encodeCp1252(s);
        return this.u32le(b.length + 1).bytes(b).u8(0);
    }

    /** Exactly n bytes, truncated / NUL-padded (PacketOut.FillString). */
    fixedString(s: string, n: number): this {
        const b = encodeCp1252(s).subarray(0, n);
        this.bytes(b);
        return this.fill(0, n - b.length);
    }

    /** Bytes + NUL terminator. */
    cString(s: string): this {
        return this.bytes(encodeCp1252(s)).u8(0);
    }

    toBytes(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

export function hex(b: Uint8Array): string {
    return Array.from(b, x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function fromHex(s: string): Uint8Array {
    const parts = s.trim().split(/\s+/).filter(Boolean);
    return Uint8Array.from(parts, p => parseInt(p, 16));
}
