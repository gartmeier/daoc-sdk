// Golden-byte tests for every C→S encoder. Expected bytes are written out from
// the read order of the C# handlers in server/core/GameServer/packets/Client/168/.

import { describe, expect, test } from 'bun:test';
import { hex, PacketReader } from './buffer';
import * as o from './outgoing';

const H = (b: Uint8Array): string => hex(b);
const prefix = { x: 1, y: 2, z: 3, speed: 0, heading: 0x0123 };
// f32le 1.0 = 00 00 80 3F, 2.0 = 00 00 00 40, 3.0 = 00 00 40 40, 0 = 00 00 00 00
const PREFIX_HEX = '00 00 80 3F 00 00 00 40 00 00 40 40 00 00 00 00 01 23';

describe('login / character screen encoders', () => {
    test('0xF4 CryptKeyRequest is 7 bytes: type, 1.1.27, rev, u16', () => {
        expect(H(o.encodeCryptKeyRequest())).toBe('06 01 01 1B 61 00 00');
    });

    test('0xA7 LoginRequest: two intLE pascal strings with NUL', () => {
        expect(H(o.encodeLoginRequest('ab', 'c'))).toBe('03 00 00 00 61 62 00 02 00 00 00 63 00');
    });

    test('0xFC overview / 0x10 select / 0xD4 world init / 0xBF game open / 0xE8 player init', () => {
        expect(H(o.encodeCharacterOverviewRequest(3))).toBe('03');
        expect(H(o.encodeCharacterSelectRequest())).toBe('00');
        expect(H(o.encodeWorldInitRequest(12))).toBe('0C');
        expect(H(o.encodeGameOpenRequest())).toBe('00');
        expect(H(o.encodePlayerInitRequest())).toBe('00');
    });

    test('0xCB DuplicateNameCheck: FillString(24)', () => {
        const b = o.encodeDupNameCheck('Bob');
        expect(b.length).toBe(24);
        expect(H(b.subarray(0, 4))).toBe('42 6F 62 00');
    });

    const LOOK = { eyeSize: 0x12, lipSize: 0x34, eyeColor: 0x56, hairColor: 7, faceType: 0x20, hairStyle: 0x30, model: 0x914A };
    const DALTA = { slot: 0, name: 'Dalta', realm: 3, classId: 43, raceId: 11, gender: 1, model: 342, stats: [60, 60, 60, 60, 60, 60, 60, 60] as [number, number, number, number, number, number, number, number] };
    const faceBytes = (b: Uint8Array) => {
        const r = new PacketReader(b);
        r.u8();
        r.intLePascal();
        r.skip(4);
        const mode = r.u8();
        const face = H(r.bytes(6));
        r.skip(3 + 1 + 9);
        const operation = r.u8();
        const type = r.u8();
        r.skip(2 + 15 + 3);
        return { mode, face, operation, type, model: r.u16le() };
    };

    test('0xFF create with a look: CustomMode 1, the face bytes, its model', () => {
        expect(faceBytes(o.encodeCharacterCreateRequest({ ...DALTA, look: LOOK }))).toEqual({ mode: 1, face: '12 34 56 07 20 30', operation: 1, type: 0, model: 0x914A });
    });

    test('0xFF customize: CustomMode 2, face only', () => {
        expect(faceBytes(o.encodeCharacterCreateRequest({ ...DALTA, operation: 2, look: LOOK }))).toEqual({ mode: 2, face: '12 34 56 07 20 30', operation: 2, type: 1, model: 0x914A });
    });

    test('0xFF customize attributes: CustomMode 1, type 2, the stats and NewConstitution', () => {
        const b = o.encodeCharacterCreateRequest({ ...DALTA, operation: 2, customizeType: 2, stats: [40, 105, 41, 87, 89, 60, 60, 60] });
        expect(faceBytes(b)).toMatchObject({ mode: 1, face: '00 00 00 00 00 00', operation: 2, type: 2 });
        const r = new PacketReader(b.subarray(b.length - 52));
        expect([...r.bytes(8)]).toEqual([40, 105, 41, 87, 89, 60, 60, 60]);
        r.skip(43);
        expect(r.u8()).toBe(41); // NewConstitution, what the server sets CON from
    });

    test('0xFF CharacterCreateRequest layout matches CreationCharacterData (1.126+)', () => {
        const b = o.encodeCharacterCreateRequest({
            slot: 2, name: 'Smoke', realm: 2, classId: 35, raceId: 6, gender: 1, model: 145,
            stats: [110, 45, 80, 35, 60, 60, 60, 60],
        });
        // total = 1 + (4 + name + 1) + 100
        expect(b.length).toBe(1 + 4 + 6 + 100);
        // Replay the server's read order (CharacterCreateRequestHandler.cs:263-326).
        const r = new PacketReader(b);
        expect(r.u8()).toBe(12); // (realm-1)*10 + slot
        expect(r.intLePascal()).toBe('Smoke');
        r.skip(4);
        expect(r.u8()).toBe(0); // CustomMode
        r.skip(6 + 3);
        r.u8(); // mood
        r.skip(9);
        expect(r.u8()).toBe(1); // Operation create
        r.u8(); // CustomizeType
        r.skip(2);
        expect(H(r.bytes(15))).toBe('01 00 00 00 00 01 00 00 00 00 01 00 00 00 00');
        expect(r.u8()).toBe(35); // class
        expect(r.u8()).toBe(2); // realm
        const rg = r.u8();
        expect(rg & 0x1F).toBe(6);
        expect((rg >> 7) & 1).toBe(1);
        expect(r.u16le()).toBe(145);
        expect(Array.from(r.bytes(8))).toEqual([110, 45, 80, 35, 60, 60, 60, 60]);
        r.skip(43);
        expect(r.u8()).toBe(80); // NewConstitution
        expect(r.remaining).toBe(0);
    });

    test('0xA3 Ping: 4 skipped bytes then u32BE timestamp', () => {
        expect(H(o.encodePing(0x01020304))).toBe('00 00 00 00 01 02 03 04 00 00 00 00');
    });
});

describe('movement encoders', () => {
    test('0xA9 PositionUpdate is the 40-byte 1.127 layout', () => {
        const b = o.encodePositionUpdate({
            x: 1, y: 2, z: 3, speed: 4, zSpeed: 0, sessionId: 0x0102, objectId: 0x0304, zoneId: 0x0010,
            stateFlags: 0x10, heading: 0x1ABC, actionFlags: 0x30, healthPercent: 99,
        });
        expect(b.length).toBe(40);
        expect(H(b)).toBe(
            '00 00 80 3F 00 00 00 40 00 00 40 40 00 00 80 40 00 00 00 00 ' + // x y z speed zSpeed
            '01 02 03 04 00 10 10 00 80 00 0A BC 30 00 00 63 00 00 00 00', // sess oid zone state unk fall heading(&0xFFF) action 2 hp 4
        );
    });

    test('0xBA HeadingUpdate 1.127', () => {
        expect(H(o.encodeHeadingUpdate(0x0102, 0x0234, 0x30, 0x10))).toBe('01 02 00 00 02 34 00 30 00 04');
    });

    test('0xBB UseSkill: prefix, flag, index, type (22 bytes)', () => {
        const b = o.encodeUseSkill(prefix, 5, 1);
        expect(b.length).toBe(22);
        expect(H(b)).toBe(`${PREFIX_HEX} 20 00 05 01`);
    });

    test('0x7D UseSpell: prefix, flag, level, line, 2 trailing (24 bytes)', () => {
        const b = o.encodeUseSpell(prefix, 7, 2);
        expect(b.length).toBe(24);
        expect(H(b)).toBe(`${PREFIX_HEX} 20 00 07 02 00 00`);
    });

    test('0x71 UseSlot: prefix, flag, slot, type', () => {
        expect(H(o.encodeUseSlot(prefix, 40, 1))).toBe(`${PREFIX_HEX} 20 00 28 01`);
    });
});

describe('targeting / combat / interaction encoders', () => {
    test('0xB0 PlayerTarget: u16 oid, u16 flags (0x6000 in view)', () => {
        expect(H(o.encodeTarget(0x1234))).toBe('12 34 60 00');
        expect(H(o.encodeTarget(0, 0))).toBe('00 00 00 00');
    });

    test('0x7A Interact and 0xB5 PickUp: u32 x, u32 y, u16 session, u16 oid', () => {
        expect(H(o.encodeInteract(0x10000, 0x20000, 5, 0x0102))).toBe('00 01 00 00 00 02 00 00 00 05 01 02');
        expect(H(o.encodePickup(1, 2, 3, 4))).toBe('00 00 00 01 00 00 00 02 00 03 00 04');
    });

    test('0x74 Attack: u8 start, u8 0 (user action)', () => {
        expect(H(o.encodeAttack(true))).toBe('01 00');
        expect(H(o.encodeAttack(false))).toBe('00 00');
    });

    test('0xEC GroundTarget: u32 x, y, z, u16 0x0100, u16 0', () => {
        expect(H(o.encodeGroundTarget(1, 2, 3))).toBe('00 00 00 01 00 00 00 02 00 00 00 03 01 00 00 00');
    });

    test('0x90 RegionChangeRequest: u16 LE zone point id', () => {
        expect(H(o.encodeRegionChangeRequest(63))).toBe('3F 00');
        expect(H(o.encodeRegionChangeRequest(0x0102))).toBe('02 01');
    });

    test('0xC7 Sit', () => {
        expect(H(o.encodeSit(true))).toBe('01');
        expect(H(o.encodeSit(false))).toBe('00');
    });

    test('0x8A PetWindow: u8 aggro, u8 walk, u8 command, one order per packet', () => {
        expect(H(o.encodePetWindow(1, 0, 0))).toBe('01 00 00');
        expect(H(o.encodePetWindow(2, 0, 0))).toBe('02 00 00');
        expect(H(o.encodePetWindow(3, 0, 0))).toBe('03 00 00');
        expect(H(o.encodePetWindow(0, 1, 0))).toBe('00 01 00');
        expect(H(o.encodePetWindow(0, 2, 0))).toBe('00 02 00');
        expect(H(o.encodePetWindow(0, 3, 0))).toBe('00 03 00');
        expect(H(o.encodePetWindow(0, 4, 0))).toBe('00 04 00');
        expect(H(o.encodePetWindow(0, 0, 1))).toBe('00 00 01');
        expect(H(o.encodePetWindow(0, 0, 2))).toBe('00 00 02');
    });

    test('0xD0 LoS response: src, tgt, 0x0100 clear', () => {
        expect(H(o.encodeLosResponse(0x0102, 0x0304))).toBe('01 02 03 04 01 00 00 00');
        expect(H(o.encodeLosResponse(1, 2, false))).toBe('00 01 00 02 00 00 00 00');
    });

    test('0xD5 CreatePlayerRequest and 0xBE CreateObjectRequest are u16 LE (>=1126)', () => {
        expect(H(o.encodeCreatePlayerRequest(0x0102))).toBe('02 01');
        expect(H(o.encodeCreateObjectRequest(0x0A0B))).toBe('0B 0A');
    });
});

describe('item / merchant / trainer / ui encoders', () => {
    test('0xDD MoveItem: u16 ignored, u16 to, u16 from, u16 count', () => {
        expect(H(o.encodeMoveItem(41, 40, 3))).toBe('00 00 00 29 00 28 00 03');
    });

    test('0xDD to a player: toSlot is 1000 + objectId, money comes from slots 500..504 with its amount', () => {
        expect(H(o.encodeMoveItem(1000 + 7, 40, 0))).toBe('00 00 03 EF 00 28 00 00');
        expect(H(o.encodeMoveItem(1000 + 7, 503, 5))).toBe('00 00 03 EF 01 F7 00 05');
    });

    test('0xEB ModifyTrade: 26 bytes, the code first', () => {
        const zeros = (n: number): string[] => Array<string>(n).fill('00');
        expect(H(o.encodeModifyTrade(2))).toBe(['02', ...zeros(25)].join(' '));
        expect(H(o.encodeModifyTrade(0))).toBe(zeros(26).join(' '));
    });

    test('0x80 DestroyItem: 4 skipped, u16 slot', () => {
        expect(H(o.encodeDestroyItem(45))).toBe('00 00 00 00 00 2D');
        expect(H(o.encodeDetailRequest(1, 0, 40))).toBe('00 01 00 00 00 00 00 28');
    });

    test('0x78 Buy: x, y, id, itemSlot, count, menuId', () => {
        expect(H(o.encodeBuy(1, 2, 31, 2, 0))).toBe('00 00 00 01 00 00 00 02 00 00 00 1F 02 00');
    });

    test('0x79 Sell: x, y, id, slot', () => {
        expect(H(o.encodeSell(1, 2, 40))).toBe('00 00 00 01 00 00 00 02 00 00 00 28');
    });

    test('0x53 Train: 264 bytes, codes terminated by 0xFFFFFFFF, levels at +32, RA block at +64', () => {
        const b = o.encodeTrain([{ specIndex: 2, level: 5 }]);
        expect(b.length).toBe(264);
        const r = new PacketReader(b);
        expect(r.u32()).toBe(2);
        expect(r.u32()).toBe(0xFFFFFFFF);
        r.pos = 32;
        expect(r.u32()).toBe(5);
        expect(b.subarray(64).every(x => x === 0)).toBe(true);
    });

    test('0x7B TrainWindow', () => {
        expect(o.encodeTrainWindowRequest().length).toBe(1);
    });

    test('0x82 DialogResponse: d1, d2, d3, code, response', () => {
        expect(H(o.encodeDialogResponse(1, 2, 3, 5, true))).toBe('00 01 00 02 00 03 05 01');
    });

    test('0xAF Command: u8 0 then NUL-terminated text; / becomes &', () => {
        expect(H(o.encodeCommand('&say hi'))).toBe('00 26 73 61 79 20 68 69 00');
        expect(H(o.encodeCommand('/q'))).toBe('00 26 71 00');
    });
});
