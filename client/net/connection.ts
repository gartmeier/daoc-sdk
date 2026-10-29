// TCP connection to the game server (Bun.connect wrapper).
//
// The server's version check (GameClient.cs:285-345) reads the version bytes
// from the *first* receive and needs >= 17 bytes, so the first frame (0xF4) is
// written in a single write with Nagle disabled.

import type { Socket } from 'bun';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { encodeClientFrame, ServerFrameDecoder, type ServerPacket } from './framing';

/** Resolve to a single address, preferring IPv4 (a bare 'localhost' maps to 127.0.0.1). */
export async function resolveHost(host: string): Promise<string> {
    if (isIP(host)) return host;
    if (host.toLowerCase() === 'localhost') return '127.0.0.1';
    try {
        return (await lookup(host, { family: 4 })).address;
    } catch {
        try {
            return (await lookup(host)).address;
        } catch {
            return host;
        }
    }
}

export interface ConnectionHandlers {
    onPacket(packet: ServerPacket): void;
    onClose(reason: string): void;
}

export class Connection {
    private socket: Socket<undefined> | null = null;
    private readonly decoder = new ServerFrameDecoder();
    private pending: Uint8Array[] = [];
    private seq = 0;
    private closed = false;
    bytesIn = 0;
    bytesOut = 0;
    packetsIn = 0;
    packetsOut = 0;
    /** Optional tap for logging every outgoing packet. */
    onSend: ((code: number, payload: Uint8Array) => void) | null = null;

    constructor(private readonly handlers: ConnectionHandlers) {}

    async connect(host: string, port: number, timeoutMs = 10_000): Promise<void> {
        const self = this;
        // Connect to one resolved address. With a name like 'localhost' Bun races IPv6 and IPv4
        // (happy eyeballs); through Docker's port proxy both attempts reach the game server, which then
        // logs a ghost GameClient "Disconnecting client because of 0 bytes received" per login.
        const address = await resolveHost(host);
        const connectPromise = Bun.connect({
            hostname: address,
            port,
            socket: {
                open(socket) {
                    socket.setNoDelay(true);
                },
                data(_socket, data) {
                    self.bytesIn += data.length;
                    let packets: ServerPacket[];
                    try {
                        packets = self.decoder.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                    } catch (e) {
                        self.close(`framing error: ${(e as Error).message}`);
                        return;
                    }
                    for (const p of packets) {
                        self.packetsIn++;
                        self.handlers.onPacket(p);
                    }
                },
                drain(socket) {
                    self.flush(socket);
                },
                close() {
                    self.markClosed('socket closed by server');
                },
                error(_socket, err) {
                    self.markClosed(`socket error: ${err.message}`);
                },
                end() {
                    self.markClosed('socket ended by server');
                },
                connectError(_socket, err) {
                    self.markClosed(`connect error: ${err.message}`);
                },
            },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`connect timeout after ${timeoutMs} ms`)), timeoutMs);
        });
        try {
            this.socket = await Promise.race([connectPromise, timeout]);
        } finally {
            clearTimeout(timer);
        }
        this.socket.setNoDelay(true);
    }

    get isOpen(): boolean {
        return this.socket !== null && !this.closed;
    }

    /** Frame and send one packet. Returns false if the socket is closed. */
    send(code: number, payload: Uint8Array): boolean {
        if (!this.socket || this.closed) return false;
        const frame = encodeClientFrame(code, payload, this.seq);
        this.seq = (this.seq + 1) & 0xFFFF;
        this.packetsOut++;
        this.onSend?.(code, payload);
        this.writeRaw(frame);
        return true;
    }

    private writeRaw(frame: Uint8Array): void {
        const socket = this.socket!;
        this.bytesOut += frame.length;
        if (this.pending.length > 0) {
            this.pending.push(frame);
            return;
        }
        const written = socket.write(frame);
        if (written < frame.length) this.pending.push(frame.subarray(Math.max(0, written)));
    }

    private flush(socket: Socket<undefined>): void {
        while (this.pending.length > 0) {
            const head = this.pending[0]!;
            const written = socket.write(head);
            if (written < head.length) {
                this.pending[0] = head.subarray(Math.max(0, written));
                return;
            }
            this.pending.shift();
        }
    }

    close(reason = 'closed by client'): void {
        if (this.socket && !this.closed) {
            try {
                this.socket.end();
            } catch {
                // ignore
            }
        }
        this.markClosed(reason);
    }

    private markClosed(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        this.handlers.onClose(reason);
    }
}
