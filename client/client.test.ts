// DaocClient.execute against a session with a fake connection (no server).

import type { BotAction } from '../sdk/types';
import { describe, expect, test } from 'bun:test';
import { DaocClient } from './client';
import { DaocSession } from './session';
import { hex, PacketWriter } from './protocol/buffer';
import { ClientOp, ServerOp } from './protocol/opcodes';

const ME = { x: 574797, y: 530161, z: 2896 }; // Camelot Hills, region 1

interface MoverInternals {
    enabled: boolean;
    lastSentAt: number;
}

/** A client whose session is 'playing' on a fake socket; `sent` records every opcode written, `payloads` its bytes as hex. */
function playingClient(regionId = 1) {
    const client = new DaocClient({ username: 'fxcl0', password: 'x' });
    const s = new DaocSession({ host: '127.0.0.1', port: 1, username: 'fxcl0', password: 'x', charName: 'Fxcla', realm: 'albion' });
    const sent: number[] = [];
    const payloads: string[] = [];
    (s as unknown as { connection: unknown }).connection = {
        isOpen: true,
        send: (code: number, payload: Uint8Array) => { sent.push(code); payloads.push(hex(payload)); return true; },
        close: () => {},
    };
    s.phase = 'playing';
    s.model.self.objectId = 1;
    s.mover.objectId = 1;
    s.mover.snap(regionId, ME.x, ME.y, ME.z, 0, null);
    (s.mover as unknown as MoverInternals).enabled = true; // streaming, without the 100 ms timer
    client.session = s;
    return { client, s, sent, payloads };
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

describe('DaocClient delve', () => {
    test('a merchant item is asked for by page * 30 + slot, and only from an open window', async () => {
        const { client, s, sent } = playingClient();
        expect(await client.execute({ type: 'delveMerchantItem', page: 0, slot: 3 })).toMatchObject({ success: false, reason: 'merchant_not_open' });
        s.model.merchant.isOpen = true;
        s.model.merchant.items = [{ page: 1, slot: 3, name: 'long sword' } as never];
        expect(await client.execute({ type: 'delveMerchantItem', page: 0, slot: 3 })).toMatchObject({ success: false, reason: 'bad_args' });
        expect(sent).toEqual([]);
        expect((await client.execute({ type: 'delveMerchantItem', page: 1, slot: 3 })).success).toBe(true);
        expect(sent).toEqual([ClientOp.DetailRequest]);
    });

    const ring = { slot: 40, name: 'Arcane Ring' } as never;

    test('asks only about a slot holding something: an empty one gets no reply', async () => {
        const { client, s, sent } = playingClient();
        expect(await client.execute({ type: 'delve', slot: 40 })).toMatchObject({ success: false, reason: 'empty_slot' });
        expect(sent).toEqual([]);
        s.model.items.set(40, ring);
        expect((await client.execute({ type: 'delve', slot: 40 })).success).toBe(true);
        expect(sent).toEqual([ClientOp.DetailRequest]);
    });

    test('the answer reaches the snapshot, blank lines included', () => {
        const { client, s } = playingClient();
        const w = new PacketWriter().u8(0).u8(0).pascal('Arcane Ring').u8(1).pascal(' ').u8(2).pascal('Magical Bonuses:').u8(3).pascal('4.67 | Intelligence: 7 pts').u8(0);
        s.model.handle(ServerOp.DetailWindow, w.toBytes());
        expect(client.collectState().textWindow).toMatchObject({ caption: 'Arcane Ring', lines: [' ', 'Magical Bonuses:', '4.67 | Intelligence: 7 pts'] });
    });
});

describe('DaocClient trade', () => {
    const OID = 7;
    const zeros = (n: number): string[] => Array<string>(n).fill('00');
    const CLOSE = zeros(26).join(' ');
    const ACCEPT = ['02', ...zeros(25)].join(' ');
    const sword = { slot: 40, name: 'short sword' } as never;
    const tradeState = (over: object = {}) => ({ id: 1, revision: 3, partnerName: 'Aine', mySlots: [], myMoney: 0, partnerItems: [], partnerMoney: 0, ...over });

    test('an item offer is a 0xDD to 1000 + objectId', async () => {
        const { client, s, sent, payloads } = playingClient();
        s.model.items.set(40, sword);
        expect((await client.execute({ type: 'tradeOfferItem', partnerObjectId: OID, slot: 40 })).success).toBe(true);
        expect(sent).toEqual([ClientOp.PlayerMoveItem]);
        expect(payloads).toEqual(['00 00 03 EF 00 28 00 00']);
    });

    test('a bad slot, an empty slot and a bad objectId send nothing', async () => {
        const { client, s, sent } = playingClient();
        s.model.items.set(40, sword);
        s.model.items.set(10, sword);
        for (const slot of [10, 39, 80, 40.5]) {
            expect(await client.execute({ type: 'tradeOfferItem', partnerObjectId: OID, slot })).toMatchObject({ success: false, reason: 'bad_args' });
        }
        expect(await client.execute({ type: 'tradeOfferItem', partnerObjectId: OID, slot: 41 })).toMatchObject({ success: false, reason: 'empty_slot' });
        for (const partnerObjectId of [0, -1, 1.5, 0xFFFF - 999]) {
            expect(await client.execute({ type: 'tradeOfferItem', partnerObjectId, slot: 40 })).toMatchObject({ success: false, reason: 'bad_args' });
            expect(await client.execute({ type: 'tradeOfferMoney', partnerObjectId, copper: 5 })).toMatchObject({ success: false, reason: 'bad_args' });
        }
        expect(sent).toEqual([]);
    });

    test('the largest objectId that fits the u16 goes out', async () => {
        const { client, payloads } = playingClient();
        expect((await client.execute({ type: 'tradeOfferMoney', partnerObjectId: 0xFFFF - 1000, copper: 1 })).success).toBe(true);
        expect(payloads).toEqual(['00 00 FF FF 01 F8 00 01']);
    });

    test('money is one 0xDD per nonzero coin, and needs no item in the slot', async () => {
        const { client, sent, payloads } = playingClient();
        expect((await client.execute({ type: 'tradeOfferMoney', partnerObjectId: OID, copper: 10_000_030_405 })).success).toBe(true);
        expect(sent).toEqual(Array<number>(4).fill(ClientOp.PlayerMoveItem));
        expect(payloads).toEqual(['00 00 03 EF 01 F4 00 01', '00 00 03 EF 01 F6 00 03', '00 00 03 EF 01 F7 00 04', '00 00 03 EF 01 F8 00 05']);
    });

    test('an amount that is no coin count, or more mithril than a u16 holds, sends nothing', async () => {
        const { client, sent } = playingClient();
        for (const copper of [0, -5, 1.5, Number.NaN, 0x10000 * 10_000_000_000]) {
            expect(await client.execute({ type: 'tradeOfferMoney', partnerObjectId: OID, copper })).toMatchObject({ success: false, reason: 'bad_args' });
        }
        expect(sent).toEqual([]);
    });

    test('an accept needs a window with a partner, at the revision it was decided on', async () => {
        const { client, s, sent, payloads } = playingClient();
        expect(await client.execute({ type: 'tradeAccept' })).toMatchObject({ success: false, reason: 'no_trade' });
        s.model.trade = tradeState({ partnerName: null });
        expect(await client.execute({ type: 'tradeAccept' })).toMatchObject({ success: false, reason: 'no_trade' });
        s.model.trade = tradeState();
        expect(await client.execute({ type: 'tradeAccept', revision: 2 })).toMatchObject({ success: false, reason: 'trade_changed' });
        expect(sent).toEqual([]);
        expect((await client.execute({ type: 'tradeAccept', revision: 3 })).success).toBe(true);
        expect((await client.execute({ type: 'tradeAccept' })).success).toBe(true);
        expect(sent).toEqual([ClientOp.ModifyTrade, ClientOp.ModifyTrade]);
        expect(payloads).toEqual([ACCEPT, ACCEPT]);
    });

    test('with our accept standing, nothing goes out that changes what we accepted, until a new revision or a cancel', async () => {
        const { client, s, sent } = playingClient();
        s.model.items.set(40, { slot: 40, name: 'Arcane Ring' } as never);
        s.model.trade = tradeState({ id: 2 });
        expect((await client.execute({ type: 'tradeAccept', revision: 3, windowId: 2 })).success).toBe(true);
        const before = sent.length;
        for (const action of [
            { type: 'tradeOfferItem', partnerObjectId: 5, slot: 40 },
            { type: 'tradeOfferMoney', partnerObjectId: 5, copper: 10 },
            { type: 'dropItem', slot: 40 },
            { type: 'moveItem', fromSlot: 40, toSlot: 1005 },
        ] as BotAction[]) expect(await client.execute(action)).toMatchObject({ success: false, reason: 'trade_accepted' });
        expect(sent.length).toBe(before);
        expect((await client.execute({ type: 'moveItem', fromSlot: 40, toSlot: 45 })).success).toBe(true);
        s.model.trade = tradeState({ id: 2, revision: 4 });
        expect((await client.execute({ type: 'tradeOfferItem', partnerObjectId: 5, slot: 40 })).success).toBe(true);
        s.model.trade = tradeState({ id: 2 });
        await client.execute({ type: 'tradeAccept', revision: 3, windowId: 2 });
        await client.execute({ type: 'tradeCancel' });
        expect((await client.execute({ type: 'tradeOfferItem', partnerObjectId: 5, slot: 40 })).success).toBe(true);
    });

    test('an accept decided on one window sends nothing to the next, though the revision is the same', async () => {
        const { client, s, sent, payloads } = playingClient();
        s.model.trade = tradeState({ id: 2 });
        expect(await client.execute({ type: 'tradeAccept', revision: 3, windowId: 1 })).toMatchObject({ success: false, reason: 'trade_changed' });
        expect(sent).toEqual([]);
        expect((await client.execute({ type: 'tradeAccept', revision: 3, windowId: 2 })).success).toBe(true);
        expect(payloads).toEqual([ACCEPT]);
    });

    test('a cancel goes out without a window too, and the window stays until the server closes it', async () => {
        const { client, s, sent, payloads } = playingClient();
        expect((await client.execute({ type: 'tradeCancel' })).success).toBe(true);
        expect(sent).toEqual([ClientOp.ModifyTrade]);
        expect(payloads).toEqual([CLOSE]);
        const open = tradeState();
        s.model.trade = open;
        expect((await client.execute({ type: 'tradeCancel' })).success).toBe(true);
        expect(s.model.trade).toBe(open);
    });

    test('the window reaches the snapshot', () => {
        const { client, s } = playingClient();
        expect(client.collectState().trade).toBeNull();
        const open = new PacketWriter().u8(40).fill(0, 9).fill(0, 26).u8(0).u8(1).u8(0).u8(0).pascal('Trading with Aine').toBytes();
        s.model.handle(ServerOp.TradeWindow, open);
        expect(client.collectState().trade).toMatchObject({ revision: 1, partnerName: 'Aine', mySlots: [40] });
        s.model.handle(ServerOp.TradeWindow, new Uint8Array(40));
        expect(client.collectState().trade).toBeNull();
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
