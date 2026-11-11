// DaocClient.execute against a session with a fake connection (no server).

import type { BotAction, PetCommand, PetState } from '../sdk/types';
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

describe('DaocClient petCommand', () => {
    const PET = 600;
    const MOB = 7;
    const npc = (objectId: number, over: object = {}) => ({ objectId, name: 'x', realm: 0, isPet: false, x: ME.x, y: ME.y, z: ME.z, ...over }) as never;
    const window: PetState = { objectId: PET, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null };
    const BYTES: Record<PetCommand, string> = {
        aggressive: '01 00 00', defensive: '02 00 00', passive: '03 00 00',
        follow: '00 01 00', stay: '00 02 00', goTarget: '00 03 00', comeHere: '00 04 00',
        attack: '00 00 01', release: '00 00 02',
    };
    const COMMANDS = Object.keys(BYTES) as PetCommand[];
    /** A pet up and a mob in view. */
    const withPet = () => {
        const c = playingClient();
        c.s.model.pet = window;
        c.s.model.npcs.set(PET, npc(PET, { isPet: true }));
        c.s.model.npcs.set(MOB, npc(MOB));
        return c;
    };

    test('one 0x8A per order, with its bytes', async () => {
        for (const command of COMMANDS) {
            const { client, s, sent, payloads } = withPet();
            s.model.setSelfTarget(MOB);
            expect(await client.execute({ type: 'petCommand', command })).toMatchObject({ success: true, phase: 'dispatch' });
            expect(sent).toEqual([ClientOp.PetWindow]);
            expect(payloads).toEqual([BYTES[command]]);
        }
    });

    test('an unknown command is bad_args, also one that is a property of every object', async () => {
        const { client, sent } = withPet();
        for (const command of ['fetch', 'constructor', 'toString', '', undefined]) {
            expect(await client.execute({ type: 'petCommand', command: command as never })).toMatchObject({ success: false, reason: 'bad_args' });
        }
        expect(sent).toEqual([]);
    });

    test('without a window: no_pet, and nothing goes out, not even the target', async () => {
        const { client, s, sent } = withPet();
        s.model.pet = null;
        for (const command of COMMANDS) {
            expect(await client.execute({ type: 'petCommand', command })).toMatchObject({ success: false, reason: 'no_pet' });
            expect(await client.execute({ type: 'petCommand', command, targetObjectId: MOB })).toMatchObject({ success: false, reason: 'no_pet' });
        }
        expect(sent).toEqual([]);
        expect(s.model.self.targetObjectId).toBeNull();
    });

    test('with a target given it is selected first, in the same call', async () => {
        const { client, s, sent, payloads } = withPet();
        expect((await client.execute({ type: 'petCommand', command: 'attack', targetObjectId: MOB })).success).toBe(true);
        expect(sent).toEqual([ClientOp.PlayerTarget, ClientOp.PetWindow]);
        expect(payloads).toEqual(['00 07 60 00', '00 00 01']);
        expect(s.model.self.targetObjectId).toBe(MOB);
    });

    test('we can be the destination, though no entry in the world holds us', async () => {
        const { client, sent } = withPet();
        expect((await client.execute({ type: 'petCommand', command: 'goTarget', targetObjectId: 1 })).success).toBe(true);
        expect(sent).toEqual([ClientOp.PlayerTarget, ClientOp.PetWindow]);
    });

    test('a target given that we do not know sends nothing', async () => {
        const { client, s, sent } = withPet();
        for (const targetObjectId of [999, 0, -1, 1.5]) {
            expect(await client.execute({ type: 'petCommand', command: 'attack', targetObjectId })).toMatchObject({ success: false, reason: 'unknown_object' });
        }
        expect(sent).toEqual([]);
        expect(s.model.self.targetObjectId).toBeNull();
    });

    test('attack and goTarget with no target at all: no_target; the rest need none', async () => {
        const { client, sent } = withPet();
        for (const command of ['attack', 'goTarget'] as const) {
            expect(await client.execute({ type: 'petCommand', command })).toMatchObject({ success: false, reason: 'no_target' });
        }
        expect(sent).toEqual([]);
        for (const command of COMMANDS.filter(c => c !== 'attack' && c !== 'goTarget')) {
            expect((await client.execute({ type: 'petCommand', command })).success).toBe(true);
        }
        expect(sent).toHaveLength(COMMANDS.length - 2);
    });

    test('release without a window goes through for a targeted pet of our realm (CharacterClassBase.cs:332-339), and for nothing else', async () => {
        const { client, s, sent, payloads } = withPet();
        s.model.pet = null;
        s.model.self.realm = 1;
        s.model.npcs.set(PET, npc(PET, { isPet: true, realm: 1 }));
        s.model.npcs.set(601, npc(601, { isPet: true, realm: 2 }));
        expect(await client.execute({ type: 'petCommand', command: 'release' })).toMatchObject({ success: false, reason: 'no_pet' });
        s.model.setSelfTarget(MOB);
        expect(await client.execute({ type: 'petCommand', command: 'release' })).toMatchObject({ success: false, reason: 'no_pet' });
        s.model.setSelfTarget(601);
        expect(await client.execute({ type: 'petCommand', command: 'release' })).toMatchObject({ success: false, reason: 'no_pet' });
        expect(sent).toEqual([]);
        s.model.setSelfTarget(PET);
        expect(await client.execute({ type: 'petCommand', command: 'stay' })).toMatchObject({ success: false, reason: 'no_pet' });
        expect((await client.execute({ type: 'petCommand', command: 'release' })).success).toBe(true);
        expect(sent).toEqual([ClientOp.PetWindow]);
        expect(payloads).toEqual(['00 00 02']);
        s.model.setSelfTarget(null);
        sent.length = 0;
        expect((await client.execute({ type: 'petCommand', command: 'release', targetObjectId: PET })).success).toBe(true);
        expect(sent).toEqual([ClientOp.PlayerTarget, ClientOp.PetWindow]);
    });

    test('not in game: refused like any action', async () => {
        const { client, s, sent } = withPet();
        s.phase = 'quitting';
        expect(await client.execute({ type: 'petCommand', command: 'stay' })).toMatchObject({ success: false, reason: 'not_in_game' });
        expect(sent).toEqual([]);
    });

    describe('the answer line names what the attack named', () => {
        const line = (text: string) => new PacketWriter().u8(0).cString(text).toBytes();
        const KILL = 'You command the amber simulacrum to kill your target!';

        test('a raw attack during a melee fight: our target moves back before the line comes', async () => {
            const { client, s } = withPet();
            s.model.npcs.set(8, npc(8));
            s.model.setSelfTarget(8);
            expect((await client.execute({ type: 'petCommand', command: 'attack', targetObjectId: MOB })).success).toBe(true);
            await client.execute({ type: 'setTarget', objectId: 8 });
            s.model.handle(ServerOp.Message, line(KILL));
            expect(s.model.pet!.targetObjectId).toBe(MOB);
        });

        test('with no id passed it is our target at the order', async () => {
            const { client, s } = withPet();
            s.model.npcs.set(8, npc(8));
            s.model.setSelfTarget(MOB);
            await client.execute({ type: 'petCommand', command: 'attack' });
            await client.execute({ type: 'setTarget', objectId: 8 });
            s.model.handle(ServerOp.Message, line(KILL));
            expect(s.model.pet!.targetObjectId).toBe(MOB);
        });

        test('only an attack: a line after another order goes by our target', async () => {
            const { client, s } = withPet();
            s.model.setSelfTarget(MOB);
            await client.execute({ type: 'petCommand', command: 'goTarget', targetObjectId: 1 });
            s.model.handle(ServerOp.Message, line(KILL));
            expect(s.model.pet!.targetObjectId).toBe(1);
        });
    });

    test('the summons and the shade reach the snapshot', () => {
        const { client, s } = playingClient();
        s.model.self.realm = 1;
        expect(client.collectState().summons).toEqual([]);
        expect(client.collectState().player?.isShade).toBe(false);
        // 0xDA for a pet of our realm, then our 0x1B on it.
        s.model.handle(ServerOp.NPCCreate, new PacketWriter().u16(610).u16(0).u16(0).u16(ME.z).u32(ME.x + 60).u32(ME.y).u16(0).u16(100).u8(50).u8(5).u8(1 << 6).u8(0).u8(0x80).u8(0).u16(0).pascal('air spirit').pascal('').toBytes());
        s.model.handle(ServerOp.SpellEffectAnimation, new PacketWriter().u16(1).u16(101).u16(610).u16(0).u8(0).u8(1).toBytes());
        s.model.handle(ServerOp.UpdateIcons, new PacketWriter().u8(1).u8(0).u8(0).u8(0).u8(0).u8(0xFF).u8(0).u16(403).u16(0).u16(0).u8(1).pascal('Shade').toBytes());
        const state = client.collectState();
        expect(state.summons).toEqual([610]);
        expect(state.freshSummons).toEqual([610]);
        expect(state.pet).toBeNull();
        expect(state.player?.isShade).toBe(true);
    });

    test('the stats without items reach the snapshot, as a copy', () => {
        const { client, s } = playingClient();
        expect(client.collectState().player?.statsWithoutItems).toBeNull();
        const bare = { strength: 50, dexterity: 60, constitution: 50, quickness: 50, intelligence: 60, piety: 50, empathy: 50, charisma: 50 };
        s.model.self.statsWithoutItems = bare;
        const seen = client.collectState().player?.statsWithoutItems;
        expect(seen).toEqual(bare);
        expect(seen).not.toBe(bare);
    });

    test('the window and the last loss reach the snapshot', () => {
        const { client, s } = playingClient();
        expect(client.collectState()).toMatchObject({ pet: null, lastPetLoss: null });
        s.model.handle(ServerOp.PetWindow, Uint8Array.of(2, 0x58, 0, 0, 2, 3, 2, 0, 0));
        expect(client.collectState().pet).toEqual({ objectId: PET, aggression: 'passive', walk: 'stay', icons: [], targetObjectId: null });
        s.model.handle(ServerOp.PetWindow, Uint8Array.of(0, 0, 0, 0, 0, 1, 1, 0, 0));
        const state = client.collectState();
        expect(state.pet).toBeNull();
        expect(state.lastPetLoss).toMatchObject({ objectId: PET, name: null, cause: 'released' });
    });
});

describe('DaocClient ground target flags', () => {
    /** Bytes of the last packet with this opcode. */
    const lastPayload = (sent: number[], payloads: string[], code: number): string[] => payloads[sent.lastIndexOf(code)]!.split(' ');
    /** A client that knows one spell, one skill and one item, its last 0xA9 recent. */
    const armed = () => {
        const c = playingClient();
        c.s.model.spellLines.set(0, { lineIndex: 0, lineName: 'Path', spells: [{ kind: 'spell', name: 'Summon', level: 5, internalId: 9 }] } as never);
        c.s.model.usableSkills = [{ skillType: 5, level: 1, internalId: 1, special: 0, bonus: 0, icon: 0, name: 'Sprint' }];
        c.s.mover.sendUpdate();
        return c;
    };
    const flagsOf = async (c: ReturnType<typeof armed>) => {
        await c.client.execute({ type: 'castSpell', lineIndex: 0, spellIndex: 0 });
        await c.client.execute({ type: 'useSkill', skillIndex: 0 });
        await c.client.execute({ type: 'useItem', slot: 10 });
        await c.client.execute({ type: 'jump' });
        return {
            // After the 18-byte prefix (UseSpellHandler.cs:26-38).
            cast: lastPayload(c.sent, c.payloads, ClientOp.UseSpell).slice(18, 20).join(' '),
            skill: lastPayload(c.sent, c.payloads, ClientOp.UseSkill).slice(18, 20).join(' '),
            slot: lastPayload(c.sent, c.payloads, ClientOp.UseSlot).slice(18, 20).join(' '),
            // The action byte of a 0xA9 (PlayerPositionUpdateHandler.cs:58-82): the jump, then the heartbeat.
            jump: lastPayload(c.sent, c.payloads, ClientOp.PositionUpdate)[32],
        };
    };
    const off = { cast: '20 00', skill: '20 00', slot: '20 00', jump: '30' };
    const on = { cast: '30 00', skill: '30 00', slot: '30 00', jump: '38' };

    test('without a ground target every packet says only that the target is in view', async () => {
        expect(await flagsOf(armed())).toEqual(off);
    });

    test('with one, spell, skill, item and position packets all keep it in view: each overwrites the server\'s flag', async () => {
        const c = armed();
        expect((await c.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y, z: ME.z })).success).toBe(true);
        expect(await flagsOf(c)).toEqual(on);
        c.s.mover.sendUpdate();
        expect(lastPayload(c.sent, c.payloads, ClientOp.PositionUpdate)[32]).toBe('38');
    });

    describe('a ground target with no z', () => {
        /** The x, y and z of the last 0xEC (PlayerGroundTargetHandler.cs:11-14). */
        const spotSent = (c: ReturnType<typeof playingClient>) => {
            const bytes = lastPayload(c.sent, c.payloads, ClientOp.PlayerGroundTarget).map(b => parseInt(b, 16));
            const u32 = (at: number) => (bytes[at]! * 2 ** 24) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
            return { x: u32(0), y: u32(4), z: u32(8) };
        };
        const withGround = (z: number | null) => {
            const c = playingClient();
            let asked: unknown[] = [];
            (c.client as unknown as { opts: { ground: unknown } }).opts.ground = (...args: unknown[]) => { asked = args; return z === null ? null : { z, swimming: false }; };
            return { ...c, asked: () => asked };
        };

        test('takes the ground the mover walks on, with our height as the layer hint', async () => {
            const c = withGround(5293);
            expect((await c.client.execute({ type: 'setGroundTarget', x: ME.x + 300, y: ME.y })).success).toBe(true);
            expect(c.asked()).toEqual([1, ME.x + 300, ME.y, ME.z]);
            expect(spotSent(c)).toEqual({ x: ME.x + 300, y: ME.y, z: 5293 });
            expect(c.s.model.groundTarget).toEqual({ x: ME.x + 300, y: ME.y, z: 5293 });
        });

        test('with no terrain there, or none at all: our own height', async () => {
            const noneThere = withGround(null);
            await noneThere.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y });
            expect(spotSent(noneThere).z).toBe(ME.z);
            const none = playingClient();
            await none.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y });
            expect(spotSent(none).z).toBe(ME.z);
        });

        test('in deep water, the mesh\'s plane and not the swimming height: 24 off it, the server drops that (PlayerGroundTargetHandler.cs:63-85, seen live in Shannon Estuary)', async () => {
            const c = playingClient();
            (c.client as unknown as { opts: { ground: unknown } }).opts.ground = () => ({ z: 4573, swimming: true });
            expect((await c.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y })).success).toBe(true);
            expect(spotSent(c).z).toBe(4597);
            expect(c.s.model.groundTarget).toEqual({ x: ME.x, y: ME.y, z: 4597 });
        });

        test('in shallower water as well: the bed is up to 23 off the plane (live: depth 36, no z dropped, z 4597 kept)', async () => {
            const c = playingClient();
            (c.client as unknown as { opts: { ground: unknown } }).opts.ground = () => ({ z: 4577, swimming: false, waterZ: 4613 });
            await c.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y });
            expect(spotSent(c).z).toBe(4597);
        });

        test('a z passed goes out as given, in deep water too', async () => {
            const wet = playingClient();
            (wet.client as unknown as { opts: { ground: unknown } }).opts.ground = () => ({ z: 4573, swimming: true });
            await wet.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y, z: 4573 });
            expect(spotSent(wet).z).toBe(4573);
            const c = withGround(5293);
            await c.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y, z: 6264 });
            expect(spotSent(c).z).toBe(6264);
            expect(c.asked()).toEqual([]);
        });

        test('a z that is no number is bad_args', async () => {
            const c = playingClient();
            expect(await c.client.execute({ type: 'setGroundTarget', x: ME.x, y: ME.y, z: Number.NaN })).toMatchObject({ success: false, reason: 'bad_args' });
            expect(await c.client.execute({ type: 'setGroundTarget', x: Number.NaN, y: ME.y })).toMatchObject({ success: false, reason: 'bad_args' });
        });
    });

    test('a ground target from the server counts, and the server clearing it turns the flags off', async () => {
        const c = armed();
        c.s.model.handle(ServerOp.ChangeGroundTarget, new PacketWriter().u32(ME.x).u32(ME.y).u32(ME.z).toBytes());
        expect(await flagsOf(c)).toEqual(on);
        c.s.model.handle(ServerOp.ChangeGroundTarget, new PacketWriter().u32(0).u32(0).u32(0).toBytes());
        expect(await flagsOf(c)).toEqual(off);
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

describe('DaocClient useSpec', () => {
    test('a spec click is 0xBB with type 0 and the index among the specs (UseSkillHandler.cs:57-64)', async () => {
        const { client, s, sent, payloads } = playingClient();
        s.model.usableSkills = [
            { skillType: 0, level: 21, internalId: 1, special: 0, bonus: 0, icon: 0, name: 'Critical Strike' },
            { skillType: 0, level: 19, internalId: 2, special: 0, bonus: 0, icon: 0, name: 'Stealth' },
            { skillType: 5, level: 1, internalId: 3, special: 0, bonus: 0, icon: 0, name: 'Sprint' },
        ];
        s.mover.sendUpdate();
        sent.length = 0;
        payloads.length = 0;
        const r = await client.execute({ type: 'useSpec', specIndex: 1 });
        expect(r).toMatchObject({ success: true, message: 'used spec Stealth' });
        const p = payloads[sent.lastIndexOf(ClientOp.UseSkill)]!.split(' ');
        expect(p.slice(20, 22)).toEqual(["01", "00"]);
        // Sprint is no spec: out of range, nothing sent.
        sent.length = 0;
        expect(await client.execute({ type: 'useSpec', specIndex: 2 })).toMatchObject({ success: false, reason: 'bad_args' });
        expect(sent).not.toContain(ClientOp.UseSkill);
    });

    test('our stealth reaches the snapshot from 0x8D', () => {
        const { client, s } = playingClient();
        expect(client.collectState().player?.stealthed).toBe(false);
        s.model.handle(ServerOp.PlayerModelTypeChange, new PacketWriter().u16(1).u8(3).u8(8).toBytes());
        expect(client.collectState().player?.stealthed).toBe(true);
        s.model.handle(ServerOp.PlayerModelTypeChange, new PacketWriter().u16(1).u8(2).u8(0).toBytes());
        expect(client.collectState().player?.stealthed).toBe(false);
    });
});
