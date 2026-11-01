// DaocClient.execute against a session with a fake connection (no server).

import { describe, expect, test } from 'bun:test';
import { DaocClient } from './client';
import { DaocSession } from './session';
import { ClientOp } from './protocol/opcodes';

const ME = { x: 574797, y: 530161, z: 2896 }; // Camelot Hills, region 1

interface MoverInternals {
    enabled: boolean;
    lastSentAt: number;
}

/** A client whose session is 'playing' on a fake socket; `sent` records every opcode written. */
function playingClient(regionId = 1) {
    const client = new DaocClient({ username: 'fxcl0', password: 'x' });
    const s = new DaocSession({ host: '127.0.0.1', port: 1, username: 'fxcl0', password: 'x', charName: 'Fxcla', realm: 'albion' });
    const sent: number[] = [];
    (s as unknown as { connection: unknown }).connection = {
        isOpen: true,
        send: (code: number) => { sent.push(code); return true; },
        close: () => {},
    };
    s.phase = 'playing';
    s.model.self.objectId = 1;
    s.mover.objectId = 1;
    s.mover.snap(regionId, ME.x, ME.y, ME.z, 0, null);
    (s.mover as unknown as MoverInternals).enabled = true; // streaming, without the 100 ms timer
    client.session = s;
    return { client, s, sent };
}

describe('DaocClient sit', () => {
    test('sit(true) waits for the server 0xAD instead of setting the SITTING flag optimistically', async () => {
        const { client, s, sent } = playingClient();
        const r = await client.execute({ type: 'sit', sit: true });
        expect(r.success).toBe(true);
        expect(sent).toContain(ClientOp.PlayerSitRequest);
        // A refused sit (dead, stunned, mezzed, moving, mounted: GamePlayer.cs:8656-8697) sends no 0xAD.
        expect(s.mover.sitting).toBe(false);
        expect(client.collectState().player?.isSitting).toBe(false);
    });

    test('a corpse neither jumps nor turns', async () => {
        const { client, sent } = playingClient();
        const s = client.session!;
        s.model.self.isDead = true;
        const heading = s.mover.heading;
        for (const action of [{ type: 'jump' }, { type: 'face', heading: 1000 }, { type: 'faceObject', objectId: 2 }] as const) {
            expect(await client.execute(action)).toMatchObject({ success: false, reason: 'dead' });
        }
        expect(sent).not.toContain(ClientOp.PositionUpdate);
        expect(s.mover.heading).toBe(heading);
    });

    test('sit(false) clears the flags at once (standing is never wrong)', async () => {
        const { client, s } = playingClient();
        s.mover.sitting = true;
        s.model.self.isSitting = true;
        await client.execute({ type: 'sit', sit: false });
        expect(s.mover.sitting).toBe(false);
        expect(client.collectState().player?.isSitting).toBe(false);
    });
});

describe('DaocClient regionChangeRequest', () => {
    test('sends 0x90 and leaves the observing to the caller', async () => {
        const { client, sent } = playingClient();
        const r = await client.execute({ type: 'regionChangeRequest', zonePointId: 63 });
        expect(r.success).toBe(true);
        expect(sent).toEqual([ClientOp.PlayerRegionChangeRequest]);
    });

    test('an id that does not fit a u16 is refused before anything goes out', async () => {
        const { client, sent } = playingClient();
        for (const zonePointId of [-1, 65536, 1.5]) {
            expect(await client.execute({ type: 'regionChangeRequest', zonePointId })).toMatchObject({ success: false, reason: 'bad_args' });
        }
        expect(sent).toEqual([]);
    });
});

describe('DaocClient position-prefixed packets after a 0xA9 gap', () => {
    test('a fresh 0xA9 goes out before 0x71 UseSlot when the last one is > 4 s old', async () => {
        const { client, s, sent } = playingClient();
        s.mover.sendUpdate();
        sent.length = 0;
        let r = await client.execute({ type: 'useItem', slot: 10 });
        expect(r.success).toBe(true);
        expect(sent).toEqual([ClientOp.UseSlot]); // recent 0xA9: no extra update

        (s.mover as unknown as MoverInternals).lastSentAt = Date.now() - 6000;
        sent.length = 0;
        r = await client.execute({ type: 'useItem', slot: 10 });
        expect(r.success).toBe(true);
        expect(sent).toEqual([ClientOp.PositionUpdate, ClientOp.UseSlot]);
        expect(s.mover.msSinceLastSend()).toBeLessThan(1000);
    });

    test('UseSkill is refused (not misparsed) when no 0xA9 can be sent', async () => {
        const { client, s, sent } = playingClient(9999); // no zone table entry: sendUpdate never sends
        expect(s.mover.zoneId).toBeNull();
        s.model.usableSkills = [{ skillType: 5, level: 1, internalId: 1, special: 0, bonus: 0, icon: 0, name: 'Sprint' }];
        const r = await client.execute({ type: 'useSkill', skillIndex: 0 });
        expect(r).toMatchObject({ success: false, reason: 'no_zone' });
        expect(sent).not.toContain(ClientOp.UseSkill);
    });
});
