import { describe, expect, test } from 'bun:test';
import { PacketWriter } from './protocol/buffer';
import { ClientOp, ServerOp } from './protocol/opcodes';
import { DaocSession } from './session';
import { resolveHost } from './net/connection';

const W = () => new PacketWriter();

function session(): { s: DaocSession; feed: (code: number, payload: Uint8Array) => void } {
    const s = new DaocSession({ host: '127.0.0.1', port: 1, username: 'x', password: 'x', charName: 'Xxx', realm: 'albion' });
    const feed = (code: number, payload: Uint8Array) => (s as unknown as { handlePacket(p: { code: number; payload: Uint8Array }): void }).handlePacket({ code, payload });
    return { s, feed };
}

/** 0xAD CharacterStatusUpdate (PacketLib190.cs:53-75). */
const status = (hpPct: number, sittingFlag: number) =>
    W().u8(hpPct).u8(0).u8(sittingFlag).u8(100).u8(0).u8(0).u16(0).u16(100).u16(0).u16(38).u16(38).u16(100).u16(0).u16(0).toBytes();

describe('DaocSession packet housekeeping', () => {
    test('0xB6 MaxSpeed 0 (rooted/stunned) is honoured, not replaced by 100%', () => {
        const { s, feed } = session();
        feed(ServerOp.MaxSpeed, W().u16(0).u8(0).u8(0).toBytes());
        expect(s.mover.maxSpeedPercent).toBe(0);
        expect(s.mover.maxSpeed).toBe(0);
        feed(ServerOp.MaxSpeed, W().u16(125).u8(0).u8(0).toBytes());
        expect(s.mover.maxSpeedPercent).toBe(125);
    });

    test('0xAD sitting flag keeps the mover SITTING state flag in sync', () => {
        const { s, feed } = session();
        s.mover.sitting = true;
        feed(ServerOp.CharacterStatusUpdate, status(90, 0x00)); // server stood us up (e.g. attacked)
        expect(s.mover.sitting).toBe(false);
        expect(s.mover.healthPercent).toBe(90);
        expect(s.model.self.isSitting).toBe(false);
        feed(ServerOp.CharacterStatusUpdate, status(90, 0x02)); // '&quit' sits us down (GamePlayer.Quit)
        expect(s.mover.sitting).toBe(true);
        expect(s.model.self.isSitting).toBe(true);
    });
});

/** A session that thinks it is connected; records the commands it sends. */
function connectedSession(phase: DaocSession['phase']) {
    const { s, feed } = session();
    const commands: string[] = [];
    let closed = 0;
    (s as unknown as { connection: unknown }).connection = {
        isOpen: true,
        send: (code: number, payload: Uint8Array) => {
            if (code === ClientOp.CommandHandler) commands.push(new TextDecoder('latin1').decode(payload).replace(/[^\x20-\x7e]/g, ''));
            return true;
        },
        close: () => { closed++; },
    };
    s.phase = phase;
    return { s, feed, commands, closes: () => closed };
}

describe('DaocSession.quit', () => {
    test('dead: releases first (a dead character cannot &quit), then quits once alive', async () => {
        const { s, feed, commands } = connectedSession('playing');
        s.model.self.isDead = true;
        s.model.self.lastDeathAt = Date.now() - 20_000; // past RELEASE_MINIMUM_WAIT
        const quitting = s.quit(5000);
        await Bun.sleep(30);
        expect(commands.some(c => c.includes('&release'))).toBe(true);
        expect(commands.some(c => c.includes('&quit'))).toBe(false);
        feed(ServerOp.CharacterStatusUpdate, status(100, 0)); // released at the bind point, alive
        await Bun.sleep(120);
        expect(commands.some(c => c.includes('&quit'))).toBe(true);
        s.close('quit');
        await quitting;
    });

    test('a second quit while one is under way waits for it instead of closing the socket', async () => {
        const { s, closes } = connectedSession('quitting');
        let done = false;
        const second = s.quit(5000).then(() => { done = true; });
        await Bun.sleep(150);
        expect(done).toBe(false);
        expect(closes()).toBe(0);
        s.close('quit'); // the first quit's 0xA4 → 0xFC finished
        await second;
        expect(s.endReason).toBe('quit');
    });

    test('during a region change it waits for the character to land, then sends &quit', async () => {
        const { s, commands, closes } = connectedSession('regionChange');
        const quitting = s.quit(5000);
        await Bun.sleep(120);
        expect(closes()).toBe(0);
        expect(commands).toHaveLength(0);
        s.phase = 'playing';
        await Bun.sleep(120);
        expect(commands.some(c => c.includes('&quit'))).toBe(true);
        s.close('quit');
        await quitting;
    });
});

describe('Connection host resolution', () => {
    test("'localhost' and IP literals resolve to one address (no happy-eyeballs ghost connection)", async () => {
        expect(await resolveHost('localhost')).toBe('127.0.0.1');
        expect(await resolveHost('LOCALHOST')).toBe('127.0.0.1');
        expect(await resolveHost('127.0.0.1')).toBe('127.0.0.1');
        expect(await resolveHost('::1')).toBe('::1');
    });
});

/** 0xFC CharacterOverview1126 with no characters (16 bytes). */
const emptyOverview = () => new Uint8Array(16);

describe('DaocSession 0xA4 quit vs server kick', () => {
    test('an 0xA4 we did not ask for (KickPlayerToCharScreen) re-enters the char screen, then ends as kicked', async () => {
        const { s, feed } = connectedSession('playing');
        const sent: number[] = [];
        const conn = (s as unknown as { connection: { send: (c: number, p: Uint8Array) => boolean } }).connection;
        const orig = conn.send;
        conn.send = (c, p) => { sent.push(c); return orig(c, p); };
        const ended = new Promise<string>(resolve => s.onEnd(reason => resolve(reason)));
        feed(ServerOp.Quit, W().u8(0).u8(5).toBytes()); // SendPlayerQuit(false), PacketLib168.cs:864-875
        expect(sent).toContain(ClientOp.CharacterOverviewRequest);
        feed(ServerOp.CharacterOverview1126, emptyOverview());
        expect(await ended).toBe('kicked');
        expect(s.endReason).toBe('kicked');
        expect(s.lastError).toMatch(/kicked/);
    });

    test('after quit() sends &quit, the 0xA4 ends the session as a clean quit', async () => {
        const { s, feed, commands } = connectedSession('playing');
        const quitting = s.quit(5000);
        await Bun.sleep(20);
        expect(commands.some(c => c.includes('&quit'))).toBe(true);
        feed(ServerOp.Quit, W().u8(0).u8(5).toBytes());
        feed(ServerOp.CharacterOverview1126, emptyOverview());
        await quitting;
        expect(s.endReason).toBe('quit');
        expect(s.lastError).toBeNull();
    });

    test('a raw &quit noted by the client also counts as requested', async () => {
        const { s, feed } = connectedSession('playing');
        s.noteQuitRequested();
        const ended = new Promise<string>(resolve => s.onEnd(reason => resolve(reason)));
        feed(ServerOp.Quit, W().u8(0).u8(5).toBytes());
        feed(ServerOp.CharacterOverview1126, emptyOverview());
        expect(await ended).toBe('quit');
    });
});

describe('DaocSession sitting after a server move', () => {
    test('a non-heading 0x04 CharacterJump stands us up (GamePlayer.MoveTo sends no 0xAD)', () => {
        const { s, feed } = connectedSession('playing');
        feed(ServerOp.CharacterStatusUpdate, status(80, 0x02));
        expect(s.mover.sitting).toBe(true);
        expect(s.model.self.isSitting).toBe(true);
        // heading-only jump (x = y = 0) keeps us sitting
        feed(ServerOp.CharacterJump, W().u32(0).u32(0).u16(1).u16(0).u16(1024).u16(0).toBytes());
        expect(s.mover.sitting).toBe(true);
        // PacketLib168.cs:519-541: u32 x, u32 y, u16 oid, u16 z, u16 heading, u16 house
        feed(ServerOp.CharacterJump, W().u32(574_797).u32(530_161).u16(1).u16(2896).u16(1024).u16(0).toBytes());
        expect(s.mover.sitting).toBe(false);
        expect(s.model.self.isSitting).toBe(false);
    });

    /** Sitting at ME in region 1 with one 0xA9 sent from there (streaming without the timer). */
    function sittingAtMe() {
        const c = connectedSession('playing');
        c.s.objectId = 1;
        c.s.mover.objectId = 1;
        c.s.regionId = 1;
        c.s.mover.snap(1, 574_797.4, 530_161.6, 2896, 0, null);
        (c.s.mover as unknown as { enabled: boolean }).enabled = true;
        c.feed(ServerOp.CharacterStatusUpdate, status(80, 0x02));
        c.s.mover.sendUpdate();
        return c;
    }
    const jump = (x: number, y: number, z: number) => W().u32(x).u32(y).u16(1).u16(z).u16(1024).u16(0).toBytes();

    test('the IsDiving Z+1 nudge (same XY, one unit up) keeps us sitting and only adopts the height', () => {
        const { s, feed } = sittingAtMe();
        const sent = s.mover.sentCount;
        // GamePlayer.cs:8378-8384: Z += 1; SendPlayerJump(false), IsSitting untouched
        feed(ServerOp.CharacterJump, jump(574_797, 530_161, 2897));
        expect(s.mover.sitting).toBe(true);
        expect(s.model.self.isSitting).toBe(true);
        expect(s.mover.z).toBe(2897);
        expect(s.mover.x).toBeCloseTo(574_797.4);
        expect(s.mover.correctionCount).toBe(0);
        expect(s.mover.sentCount).toBe(sent); // no immediate 0xA9 (it would trigger the next nudge)
        // a real MoveTo to another spot still stands us up
        feed(ServerOp.CharacterJump, jump(560_000, 511_000, 2500));
        expect(s.mover.sitting).toBe(false);
        expect(s.model.self.isSitting).toBe(false);
    });

    test('the rider resync while mounted (0xC8) keeps the sit state; after a dismount a 0x04 is a MoveTo', () => {
        const { s, feed } = sittingAtMe();
        // 0xC8 Riding (PacketLib168.cs:1304-1322): rider, steed, 1 = mount, seat, 0
        feed(ServerOp.Riding, W().u16(2).u16(77).u8(1).u8(0).u16(0).toBytes()); // someone else mounting
        expect(s.steedId).toBeNull();
        feed(ServerOp.Riding, W().u16(1).u16(77).u8(1).u8(0).u16(0).toBytes());
        expect(s.steedId).toBe(77);
        // PlayerPositionUpdateHandler.cs:36-49: back to the steed with a bare SendPlayerJump
        feed(ServerOp.CharacterJump, jump(560_000, 511_000, 2500));
        expect(s.mover.x).toBe(560_000);
        expect(s.mover.sitting).toBe(true);
        expect(s.model.self.isSitting).toBe(true);
        feed(ServerOp.Riding, W().u16(1).u16(77).u8(0).u8(0).u16(0).toBytes());
        expect(s.steedId).toBeNull();
        feed(ServerOp.CharacterJump, jump(574_797, 530_161, 2896));
        expect(s.mover.sitting).toBe(false);
        expect(s.model.self.isSitting).toBe(false);
    });
});
