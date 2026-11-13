// Every line-of-sight answer (0xD0) a client sent, from a tcpdump capture: what a real client answers to the server's
// LoS checks, to compare with ours (sdk/vision.ts clientLineOfSight).
//
//   docker exec <gameserver> sh -c "apk add -q tcpdump; tcpdump -i any -nn -U -w /tmp/los.pcap tcp port <game port>"
//   docker cp <gameserver>:/tmp/los.pcap .
//   bun client/dev/los-capture.ts los.pcap [--port=10300]
//
// Prints one line per answer: time, the client's address, checker and target object ids, clear or blocked. The ids are
// the server's; a bot logged in nearby at the same time sees the same ids (sdk.getNearbyNpcs objectId).
// Reads classic pcap (not pcapng), Ethernet or Linux cooked (tcpdump -i any) captures of IPv4 TCP.

import { readFileSync } from 'node:fs';

export interface LosAnswer {
    /** Seconds since the first packet of the capture. */
    t: number;
    client: string;
    checker: number;
    target: number;
    clear: boolean;
}

/** TCP payloads sent to `port`, per client address, in capture order (loopback captures arrive in order). */
export function clientStreams(pcap: Uint8Array, port: number): Map<string, { t: number; data: Uint8Array }[]> {
    const dv = new DataView(pcap.buffer, pcap.byteOffset, pcap.byteLength);
    const magic = dv.getUint32(0, true);
    const le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d;
    if (!le && dv.getUint32(0, false) !== 0xa1b2c3d4 && dv.getUint32(0, false) !== 0xa1b23c4d) throw new Error('not a pcap file (pcapng is not read: tcpdump -w writes pcap)');
    const nano = (le ? magic : dv.getUint32(0, false)) === 0xa1b23c4d;
    const linkType = dv.getUint32(20, le);
    const out = new Map<string, { t: number; data: Uint8Array }[]>();
    const seen = new Map<string, Set<number>>();
    let off = 24;
    let t0: number | null = null;
    while (off + 16 <= pcap.byteLength) {
        const t = dv.getUint32(off, le) + dv.getUint32(off + 4, le) / (nano ? 1e9 : 1e6);
        const incl = dv.getUint32(off + 8, le);
        const pkt = pcap.subarray(off + 16, off + 16 + incl);
        off += 16 + incl;
        t0 ??= t;
        let ip: number;
        if (linkType === 1) ip = 14; // Ethernet
        else if (linkType === 113) ip = 16; // Linux cooked v1
        else if (linkType === 276) ip = 20; // Linux cooked v2
        else if (linkType === 0) ip = 4; // BSD loopback
        else throw new Error(`link type ${linkType} not read`);
        if (pkt.length < ip + 20 || pkt[ip]! >> 4 !== 4 || pkt[ip + 9] !== 6) continue;
        const ihl = (pkt[ip]! & 15) * 4;
        const tcp = ip + ihl;
        const totalLen = (pkt[ip + 2]! << 8) | pkt[ip + 3]!;
        const dport = (pkt[tcp + 2]! << 8) | pkt[tcp + 3]!;
        if (dport !== port) continue;
        const sport = (pkt[tcp]! << 8) | pkt[tcp + 1]!;
        const seq = ((pkt[tcp + 4]! << 24) | (pkt[tcp + 5]! << 16) | (pkt[tcp + 6]! << 8) | pkt[tcp + 7]!) >>> 0;
        const dataOff = (pkt[tcp + 12]! >> 4) * 4;
        const data = pkt.subarray(tcp + dataOff, ip + totalLen);
        if (data.length === 0) continue;
        const key = `${pkt[ip + 12]}.${pkt[ip + 13]}.${pkt[ip + 14]}.${pkt[ip + 15]}:${sport}`;
        // tcpdump -i any can see a packet twice (two interfaces): keep the first of each sequence number.
        const s = seen.get(key) ?? new Set<number>();
        seen.set(key, s);
        if (s.has(seq)) continue;
        s.add(seq);
        const list = out.get(key) ?? [];
        list.push({ t: t - t0, data });
        out.set(key, list);
    }
    return out;
}

/** The 0xD0 answers in one client's stream: frames are u16 length, u16 seq, u16 session, u16 param, u8 0, u8 code, payload, u16 checksum. */
export function losAnswers(client: string, chunks: { t: number; data: Uint8Array }[]): LosAnswer[] {
    const out: LosAnswer[] = [];
    let buf = new Uint8Array(0);
    let bufT = 0;
    for (const c of chunks) {
        const next = new Uint8Array(buf.length + c.data.length);
        next.set(buf);
        next.set(c.data, buf.length);
        buf = next;
        bufT = c.t;
        while (buf.length >= 12) {
            const n = (buf[0]! << 8) | buf[1]!;
            if (buf.length < n + 12) break;
            const code = buf[9]!;
            if (code === 0xd0 && n >= 6) {
                const p = buf.subarray(10, 10 + n);
                out.push({ t: bufT, client, checker: (p[0]! << 8) | p[1]!, target: (p[2]! << 8) | p[3]!, clear: (((p[4]! << 8) | p[5]!) & 0x100) === 0x100 });
            }
            buf = buf.subarray(n + 12);
        }
    }
    return out;
}

if (import.meta.main) {
    const file = process.argv.slice(2).find(a => !a.startsWith('--'));
    const port = Number(/^--port=(\d+)$/.exec(process.argv.find(a => a.startsWith('--port=')) ?? '')?.[1] ?? 10300);
    if (!file) {
        console.error('usage: bun client/dev/los-capture.ts <capture.pcap> [--port=10300]');
        process.exit(1);
    }
    let n = 0;
    for (const [client, chunks] of clientStreams(readFileSync(file), port)) {
        for (const a of losAnswers(client, chunks)) {
            n++;
            console.log(`${a.t.toFixed(1).padStart(7)}s  ${a.client}  checker ${a.checker}  target ${a.target}  ${a.clear ? 'clear' : 'BLOCKED'}`);
        }
    }
    console.log(`${n} LoS answer(s)`);
}
