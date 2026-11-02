// Decoder tests. Fixtures are built with PacketWriter in the same write order as
// the C# PacketLib methods cited on each decoder (BE unless marked LE).

import { describe, expect, test } from 'bun:test';
import { PacketWriter, decodeCp1252, encodeCp1252, PacketReader } from '../buffer';
import { decodeCharacterOverview, decodeCryptKey, decodeDupNameCheckReply, decodeLoginDenied, decodeLoginGranted, decodePingReply, decodeRealm, decodeSessionId } from './login';
import { decodeCharacterJump, decodeEncumbrance, decodeLosRequest, decodeMaxSpeed, decodePositionAndObjectId, decodeQuit, decodeRegionChanged, decodeTime } from './world';
import { decodeNpcCreate, decodeObjectCreate, decodeObjectDataUpdate, decodeObjectDelete, decodeObjectUpdate, decodePlayerCreate, decodePlayerHeading, decodePlayerPosition, decodeRemoveObject } from './objects';
import { decodeInventoryUpdate, decodeMoney, decodePointsUpdate, decodeStatsUpdate, decodeStatusUpdate, decodeVariousUpdate } from './player';
import { decodeDialog, decodeMessage, decodeTextWindow, extractKeywords, parseSpeech, chatTypeName } from './chat';
import { decodeAttackMode, decodeChangeGroundTarget, decodeChangeTarget, decodeCombatAnimation, decodeConcentrationList, decodeDisableSkills, decodeInterrupt, decodePlayerDeath, decodeSpellCastAnimation, decodeSpellEffect, decodeUpdateIcons } from './combat';
import { decodeGroupMemberUpdate, decodeMerchantWindow, decodeTradeWindow, decodeTrainerWindow } from './windows';
import { ObjectType } from '../../../sdk/types';

const W = () => new PacketWriter();

describe('buffer', () => {
    test('CP1252 round trip incl. 0x80-0x9F', () => {
        const s = 'Ærøskøbing €5 – “quote” Œ';
        const b = encodeCp1252(s);
        expect(b[b.indexOf(0x80)]).toBe(0x80);
        expect(decodeCp1252(b)).toBe(s);
        expect(encodeCp1252('日')[0]).toBe(0x3F);
    });

    test('pascal variants', () => {
        const b = W().pascal('ab').intLePascal('').intLePascal('cd').fixedString('xy', 4).cString('z').toBytes();
        const r = new PacketReader(b);
        expect(r.pascal()).toBe('ab');
        expect(r.intLePascal()).toBe('');
        expect(r.intLePascal()).toBe('cd');
        expect(r.fixedString(4)).toBe('xy');
        expect(r.cString()).toBe('z');
        expect(r.remaining).toBe(0);
    });

    test('i16 reads the (ushort) cast of a negative int back as negative', () => {
        const r = new PacketReader(W().u16(0xFFF1).u16(0x7FFF).u16(0x8000).toBytes());
        expect([r.i16(), r.i16(), r.i16()]).toEqual([-15, 32767, -32768]);
    });

    test('reads past the end throw RangeError', () => {
        expect(() => new PacketReader(Uint8Array.of(1)).u16()).toThrow(RangeError);
    });
});

describe('login packets', () => {
    test('0x22 CryptKey 1126 layout', () => {
        const p = W().u32le(0).fixedString('1.127', 5).u8(0).u8(0).u8(0).toBytes();
        expect(p.length).toBe(12);
        expect(decodeCryptKey(p)).toEqual({ keyLength: 0, version: '1.127' });
    });

    test('0x2A LoginGranted 1127', () => {
        const p = W().pascal('smoke1').pascal('DAOCSDK').u8(5).u8(7).u8(0).toBytes();
        expect(decodeLoginGranted(p)).toEqual({ accountName: 'smoke1', serverName: 'DAOCSDK', serverId: 5, colorType: 7 });
    });

    test('0x2C LoginDenied / 0x28 SessionID (LE) / 0x29 PingReply', () => {
        expect(decodeLoginDenied(Uint8Array.of(0x11, 1, 1, 12, 0)).code).toBe(0x11);
        expect(decodeSessionId(Uint8Array.of(0x08, 0x01)).sessionId).toBe(0x0108);
        expect(decodePingReply(W().u32(99).fill(0, 4).u16(3).fill(0, 6).toBytes())).toEqual({ timestamp: 99, sequence: 3 });
    });

    test('0xFC CharacterOverview: empty account is 16 bytes', () => {
        expect(decodeCharacterOverview(new Uint8Array(16)).slots).toEqual([]);
    });

    test('0xFC CharacterOverview1126 with one character in slot 1', () => {
        const w = W().u32le(0).u32le(0).u32le(0).u32le(0);
        w.u8(0); // slot 0 empty
        w.u8(1).intLePascal('Smoke').u32le(0x18).u8(1).fill(0, 6).fill(0, 4).fill(0, 13);
        w.intLePascal('Camelot Hills').intLePascal('Fighter').intLePascal('Briton');
        w.u16le(32).u8(1).u8(0).fill(0, 16 + 16 + 8);
        for (const s of [70, 60, 70, 60, 60, 60, 60, 60]) w.u8(s);
        w.u8(14).u8(1).u8(1 | (1 << 7)).u8(0).u8(0xFF).u8(0).u8(70).u8(0);
        for (let i = 2; i < 10; i++) w.u8(0);
        const ov = decodeCharacterOverview(w.toBytes());
        expect(ov.slots).toHaveLength(10);
        expect(ov.slots[0]).toBeNull();
        const c = ov.slots[1]!;
        expect(c).toMatchObject({ slot: 1, level: 1, name: 'Smoke', className: 'Fighter', raceName: 'Briton', classId: 14, realm: 1, raceId: 1, gender: 1, model: 32 });
        expect(c.stats).toEqual([70, 60, 70, 60, 60, 60, 60, 60]);
    });

    test('0xFC race byte carries race bit 0x10 at 0x40', () => {
        const w = W().fill(0, 16);
        w.u8(5).intLePascal('X').fill(0, 4 + 1 + 6 + 4 + 13).intLePascal('').intLePascal('').intLePascal('');
        w.fill(0, 4 + 40).fill(60, 8).u8(1).u8(1).u8(0x40 | 0x01).fill(0, 5);
        expect(decodeCharacterOverview(w.toBytes()).slots[0]!.raceId).toBe(17);
    });
});

describe('world packets', () => {
    test('0x20 PositionAndObjectID', () => {
        const p = W().f32le(574797).f32le(530161).f32le(2896).u16(19380).u16(3116).u16(0).u16(0).u16(1).u8(0x80).u8(0).fill(0, 4).toBytes();
        expect(decodePositionAndObjectId(p)).toEqual({ x: 574797, y: 530161, z: 2896, objectId: 19380, heading: 3116, zoneXOffset: 0, zoneYOffset: 0, regionId: 1, flags: 0x80 });
    });

    test('0x04 CharacterJump and heading-only form', () => {
        expect(decodeCharacterJump(W().u32(100).u32(200).u16(7).u16(30).u16(1024).u16(0).toBytes())).toMatchObject({ x: 100, y: 200, z: 30, heading: 1024, headingOnly: false });
        expect(decodeCharacterJump(W().u32(0).u32(0).u16(7).u16(0).u16(5).u16(0).toBytes()).headingOnly).toBe(true);
    });

    test('0xB7 RegionChanged, 0xB6 MaxSpeed, 0xD0 LoS request', () => {
        expect(decodeRegionChanged(W().u16(51).u16(50).u16(0).u16(1).u8(12).u8(0).u16(0xFFBF).toBytes())).toEqual({ regionId: 51, zoneId: 50 });
        expect(decodeMaxSpeed(W().u16(125).u8(0).u8(0).toBytes()).percent).toBe(125);
        expect(decodeLosRequest(W().u16(10).u16(20).u16(0).u16(0).toBytes())).toEqual({ sourceId: 10, targetId: 20 });
    });
});

describe('object packets', () => {
    test('0xDA NPCCreate (PacketLib1124.cs:121)', () => {
        const p = W().u16(500).u16(0).u16(2048).u16(2900).u32(575000).u32(531000).u16(0).u16(400).u8(50).u8(3)
            .u8((0 << 6) | 0x10 | 0x02).u8(0x20).u8(0x08 | 0x80).u8(0).u16(0).pascal('spirit hound').pascal('Armor Merchant').u8(0).toBytes();
        expect(decodeNpcCreate(p)).toMatchObject({
            objectId: 500, heading: 2048, z: 2900, x: 575000, y: 531000, model: 400, level: 3, realm: 0,
            isPeaceful: true, hasInventory: true, questAvailable: true, isPet: true, cantTarget: false, name: 'spirit hound', guildName: 'Armor Merchant',
        });
    });

    test('0xA1 ObjectUpdate: 9-bit zone skin and masked heading', () => {
        const p = W().u16(0x8000 | 120).u16(0x3000 | 0x0ABC).u16(100).u16(200).u16(300).u16(400).u16(50).u16(60).u16(500).u16(0xFFFF)
            .u8(77).u8((1 << 6) | 0x04).u8(0x05).u8(0).toBytes();
        const d = decodeObjectUpdate(p);
        expect(d).toMatchObject({ speed: 120, zSpeedNegative: true, heading: 0x0ABC, xOffset: 100, destXOffset: 200, yOffset: 300, destYOffset: 400, z: 50, destZ: 60, objectId: 500, targetId: 0xFFFF, healthPercent: 77, realm: 1 });
        expect(d.zoneSkinId).toBe(0x105);
    });

    test('0xA2 RemoveObject', () => {
        expect(decodeRemoveObject(Uint8Array.of(1, 2, 0, 0))).toEqual({ objectId: 0x0102, type: 0 });
    });

    test('0xD9 ObjectCreate: loot owned by us, and a door', () => {
        const loot = W().u16(9).u16(0).u16(0).u16(10).u32(1000).u32(2000).u16(488).u16((1 << 4) | 0x04).u32(0).pascal('bag of coins').u8(0).toBytes();
        expect(decodeObjectCreate(loot)).toMatchObject({ objectId: 9, x: 1000, y: 2000, z: 10, model: 488, realm: 1, ownedByUs: true, name: 'bag of coins', doorId: null });
        const door = W().u16(10).u16(0).u16(0).u16(0).u32(1).u32(2).u16(3).u16(0).u32(0).pascal('door').u8(4).u32(123456789).toBytes();
        expect(decodeObjectCreate(door).doorId).toBe(123456789);
    });

    test('0x4B PlayerCreate (PacketLib1124.cs:333)', () => {
        const p = W().f32le(10).f32le(20).f32le(30).u16(3).u16(400).u16(100).u16(32).u8(5).u8((2 << 2) | 0x01)
            .fill(0, 7).fill(0, 3).pascal('Bob').pascal('Guild').pascal('Smith').pascal('').pascal('').u8(0).toBytes();
        expect(decodePlayerCreate(p)).toMatchObject({ x: 10, y: 20, z: 30, sessionId: 3, objectId: 400, level: 5, realm: 2, isDead: true, name: 'Bob', guildName: 'Guild', lastName: 'Smith' });
    });

    test('0xA9 relayed PlayerPosition 1.127 (PlayerPositionUpdateHandler.cs:690)', () => {
        const p = W().f32le(1).f32le(2).f32le(3).f32le(150).f32le(0).u16(7).u16(400).u16(0).u8(0x10).u8(0).u16(0).u16(0x1234)
            .u8(0x30).u8(0).u8(0).u8(0x80 | 55).u8(40).u8(30).u16(0).toBytes();
        expect(p.length).toBe(40);
        expect(decodePlayerPosition(p)).toMatchObject({ sessionId: 7, objectId: 400, speed: 150, heading: 0x234, healthPercent: 55, inCombat: true, isSitting: true, manaPercent: 40, endurancePercent: 30 });
    });

    test('0xBA relayed PlayerHeading 1.127', () => {
        const p = W().u16(7).u16(0).u16(1000).u8(0).u8(0x30).u8(0).u8(0x04).u8(90).u8(80).u8(70).u8(0).toBytes();
        expect(decodePlayerHeading(p)).toMatchObject({ sessionId: 7, heading: 1000, healthPercent: 90, manaPercent: 80, stateFlags: 0x10 });
    });
});

describe('own-character packets', () => {
    test('0xAD StatusUpdate (PacketLib190.cs:53)', () => {
        const p = W().u8(90).u8(50).u8(0x02).u8(100).u8(0).u8(0).u16(10).u16(100).u16(0).u16(38).u16(34).u16(100).u16(5).u16(0).toBytes();
        expect(p.length).toBe(22);
        expect(decodeStatusUpdate(p)).toMatchObject({ healthPercent: 90, sittingFlag: 2, maxHealth: 38, health: 34, maxMana: 10, mana: 5, maxEndurance: 100 });
    });

    test('0x91 PointsUpdate: XP fields are u64 LE', () => {
        const p = W().u32(1).u16(250).u16(3).u32(4).u16(5).u16(0).u32le(34).u32le(0).u32le(200).u32le(0).fill(0, 16).toBytes();
        expect(decodePointsUpdate(p)).toEqual({ realmPoints: 1, levelPermill: 250, specPoints: 3, bountyPoints: 4, realmSpecPoints: 5, championLevelPermill: 0, experience: 34, experienceForNextLevel: 200 });
    });

    test('0xFA Money', () => {
        expect(decodeMoney(W().u8(3).u8(2).u16(1).u16(0).u16(0).toBytes())).toEqual({ copper: 3, silver: 2, gold: 1, mithril: 0, platinum: 0 });
    });

    test('0xFB stats vs resists (byte 72)', () => {
        const w = W();
        for (const v of [70, 60, 70, 60, 60, 60, 60, 60]) w.u16(v);
        w.u16(0).fill(0, 18).fill(0, 18).fill(0, 9).fill(0, 9).u8(0).u8(4).u16(38).u16(0);
        const p = w.toBytes();
        expect(p.length).toBe(78);
        const d = decodeStatsUpdate(p);
        expect(d.kind).toBe('stats');
        expect(d.base).toEqual([70, 60, 70, 60, 60, 60, 60, 60]);
        expect(d.maxHealth).toBe(38);
        // Byte 73: Constitution lost to deaths (PacketLib175.cs:323).
        expect(d.constitutionLost).toBe(4);
        const res = W().fill(0, 72).u8(0xFF).u8(0).u16(0).u16(0).toBytes();
        expect(decodeStatsUpdate(res).kind).toBe('resists');
    });

    test('0xFB buff column is signed: a debuff is written as (ushort) buff (PacketLib175.cs:254-275)', () => {
        const w = W();
        for (let i = 0; i < 8; i++) w.u16(60);
        w.u16(0);
        for (const v of [-10, 5, 0, 0, 0, 0, 0, -1]) w.u16(v & 0xFFFF);
        w.u16(0).fill(0, 18).fill(0, 9).fill(0, 9).u8(0).u8(0).u16(38).u16(0);
        const d = decodeStatsUpdate(w.toBytes());
        expect(d.buff).toEqual([-10, 5, 0, 0, 0, 0, 0, -1]);
        expect(d.base[0]).toBe(60);
        // Resists variant (PacketLib175.cs:368-372): 9 racial, 9 buff (GetModifiedFromBuffs, (ushort)), 9 item, ...
        const r = W();
        for (let i = 0; i < 9; i++) r.u16(2);
        for (let i = 0; i < 9; i++) r.u16(i === 0 ? 0xFFEC : 0);
        r.fill(0, 72 - 36).u8(0xFF).u8(0).u16(0).u16(0);
        expect(decodeStatsUpdate(r.toBytes()).buff[0]).toBe(-20);
    });

    test('0x02 InventoryUpdate with an item and an empty slot (ItemData 1124:836)', () => {
        const w = W().u8(2).u8(0).u8(0).u8(0).u8(0x00).u8(2);
        w.u8(40);
        w.u16(0).u8(1).u8(12).u8(37).u8(0).u8((2 << 6) | 3).u8(0).u16(25).u8(100).u8(100).u8(85).u8(0).u8(0).u16(3).u8(0).u16(0).u8(0x02).u16(0).pascal('practice sword');
        w.u8(41).fill(0, 24);
        const d = decodeInventoryUpdate(w.toBytes());
        expect(d.windowType).toBe(2);
        expect(d.items).toHaveLength(2);
        expect(d.items[0]!.item).toMatchObject({ level: 1, value1: 12, value2: 37, objectType: 3, damageType: 2, weight: 25, condition: 100, quality: 85, model: 3, name: 'practice sword', count: 1, empty: false });
        expect(d.items[1]!.item.empty).toBe(true);
    });

    test('ItemData with spell blocks and a stack prefix', () => {
        const w = W().u8(1).u8(0).u8(0).u8(0).u8(0).u8(2).u8(45);
        w.u16(0).u8(5).u8(3).u8(0).u8(0).u8(0).u8(0).u16(5).u8(100).u8(100).u8(100).u8(0).u8(0).u16(99).u8(0).u16(0).u8(0x02 | 0x08 | 0x10)
            .u16(1).pascal('Heal').u16(2).pascal('Buff').u16(0).pascal('3 minor healing potion');
        const it = decodeInventoryUpdate(w.toBytes()).items[0]!.item;
        expect(it).toMatchObject({ spell1: 'Heal', spell2: 'Buff', name: 'minor healing potion', count: 3 });
    });

    test('0x16/01 usable skills page', () => {
        const p = W().u8(1).u8(2).u8(3).u8(0)
            .u8(1).u16(10).u8(0).u16(0).u8(0).u16(5).pascal('Slash')
            .u8(1).u16(20).u8(2).u16(0x100).u8(3).u16(6).pascal('Slam').toBytes();
        const d = decodeVariousUpdate(p);
        expect(d.sub).toBe(1);
        if (!('entries' in d)) throw new Error('expected skills page');
        expect(d.firstIndex).toBe(0);
        expect(d.entries.map(e => [e.name, e.skillType, e.special])).toEqual([['Slash', 0, 0], ['Slam', 2, 0x100]]);
    });

    test('0x16/02 spell line page and footer', () => {
        const p = W().u8(2).u8(3).u8(2).u8(1).u16le(0).u16(77).u16(0).pascal('Rejuvenation')
            .u16le(1).u16(100).u16(5).pascal('Minor Heal').u16le(512 + 4).u16(101).u16(6).pascal('Some Style').toBytes();
        const d = decodeVariousUpdate(p);
        if (!('spells' in d)) throw new Error('expected line');
        expect(d.lineIndex).toBe(1);
        expect(d.lineName).toBe('Rejuvenation');
        expect(d.spells.map(s => [s.name, s.level, s.kind])).toEqual([['Minor Heal', 1, 'spell'], ['Some Style', 4, 'style']]);
        const f = decodeVariousUpdate(Uint8Array.of(2, 0, 99, 0));
        expect('footer' in f && f.footer).toBe(true);
    });

    test('0x16/03 UpdatePlayer (PacketLib179.cs:23)', () => {
        const w = W().u8(3).u8(0x0F).u8(0).u8(0).u8(5).pascal('Smoke').u8(0).pascal('Fighter').u8(38).pascal('None').u8(0).pascal('Fighter')
            .u8(0).pascal('Guardian').u8(1).pascal('Fighter').u8(0).pascal('None').u8(0).pascal('None').u8(1).pascal('Briton');
        const d = decodeVariousUpdate(w.toBytes());
        expect(d).toMatchObject({ sub: 3, level: 5, name: 'Smoke', className: 'Fighter', profession: '', baseClass: 'Fighter', guildName: '', raceName: 'Briton', maxHealth: 38 });
    });

    test('0x16/06 group window, including the bare 06 00 form', () => {
        expect(decodeVariousUpdate(Uint8Array.of(6, 0))).toEqual({ sub: 6, members: [] });
        const d = decodeVariousUpdate(W().u8(6).u8(1).pascal('Bob').pascal('Fighter').u16(400).u8(5).toBytes());
        expect(d).toEqual({ sub: 6, members: [{ name: 'Bob', className: 'Fighter', objectId: 400, level: 5 }] });
    });
});

describe('chat / ui packets', () => {
    test('0xAF Message plain, popup (##) and send (@@)', () => {
        expect(decodeMessage(W().u8(1).cString('You say, "hi"').toBytes())).toEqual({ rawType: 1, popup: false, sendReply: false, text: 'You say, "hi"' });
        expect(decodeMessage(W().u8(0x12).bytes(encodeCp1252('##')).cString('Master Graent says, "Hail! [train]"').toBytes())).toMatchObject({ rawType: 0x12, popup: true });
        expect(decodeMessage(W().u8(2).bytes(encodeCp1252('@@')).cString('Bob sends, "yo"').toBytes())).toMatchObject({ sendReply: true, text: 'Bob sends, "yo"' });
    });

    test('speech parsing and keywords', () => {
        expect(parseSpeech('Master Graent says, "Would you like to [train]?"')).toEqual({ sender: 'Master Graent', body: 'Would you like to [train]?' });
        expect(parseSpeech('[Party] Bob: "hi"')).toEqual({ sender: 'Bob', body: 'hi' });
        expect(parseSpeech('You hit the rat.')).toBeNull();
        expect(extractKeywords('Go [north] or [south], or [north].')).toEqual(['north', 'south']);
        expect(chatTypeName(0x11)).toBe('youHit');
    });

    test('0x81 Dialog (PacketLib168.cs:1484)', () => {
        const p = W().u8(0).u8(5).u16(8).u16(0).u16(0).u16(0).u8(1).u8(1).bytes(encodeCp1252('Join group?')).u8(0).toBytes();
        expect(decodeDialog(p)).toEqual({ code: 5, data: [8, 0, 0, 0], type: 1, autoWrap: true, text: 'Join group?' });
    });

    test('0xC4 text window joins split lines', () => {
        const p = W().u8(0).u8(0).pascal('Caption').u8(1).pascal('first ').u8(1).pascal('part').u8(2).pascal('second').u8(0).toBytes();
        expect(decodeTextWindow(p)).toEqual({ caption: 'Caption', lines: ['first part', 'second'] });
    });
});

describe('combat packets', () => {
    test('0xBC CombatAnimation (PacketLib186.cs:54): style is LE', () => {
        const p = W().u16(100).u16(200).u16(3).u16(0).u16le(0x0102).u8(0).u8(10).u8(61).u8(0).toBytes();
        expect(decodeCombatAnimation(p)).toMatchObject({ attackerId: 100, defenderId: 200, style: 0x0102, resultCode: 10, result: 'hit', targetHealthPercent: 61 });
    });

    test('0x72 cast time is in 100 ms units; 0xAE death', () => {
        expect(decodeSpellCastAnimation(W().u16(1).u16(2).u16(30).u16(0).toBytes())).toEqual({ casterId: 1, effect: 2, castTimeMs: 3000 });
        expect(decodePlayerDeath(W().u16(5).u16(6).fill(0, 4).toBytes())).toEqual({ victimId: 5, killerId: 6 });
    });

    test('0xD6 DisableSkills both forms', () => {
        expect(decodeDisableSkills(W().u16(0).u8(1).u8(1).u16(4).u16(30).toBytes())).toEqual({ kind: 'skills', entries: [{ skillIndex: 4, seconds: 30 }] });
        expect(decodeDisableSkills(W().u16(10).u8(2).u8(2).u8(0).u8(1).u8(1).u8(3).toBytes())).toEqual({ kind: 'spells', seconds: 10, entries: [{ lineIndex: 0, spellIndex: 1 }, { lineIndex: 1, spellIndex: 3 }] });
    });

    test('0x7F UpdateIcons with a removed tail slot', () => {
        const p = W().u8(2).u8(0).u8(0).u8(0)
            .u8(0).u8(0).u8(0).u16(1234).u16(60).u16(555).u8(0).pascal('Strength')
            .u8(1).fill(0, 10).toBytes();
        const d = decodeUpdateIcons(p);
        expect(d.entries[0]).toMatchObject({ index: 0, icon: 1234, remainingSeconds: 60, tooltipId: 555, name: 'Strength', removed: false });
        expect(d.entries[1]).toMatchObject({ index: 1, removed: true });
    });

    test('0x75 ConcentrationList', () => {
        const p = W().u8(1).fill(0, 3).u8(0).u8(0).u8(5).u16(77).pascal('Chant').pascal('Smoke').toBytes();
        expect(decodeConcentrationList(p).entries).toEqual([{ index: 0, concentration: 5, icon: 77, name: 'Chant', ownerName: 'Smoke' }]);
    });
});

describe('window packets', () => {
    test('0x17 MerchantWindow 1125d (PacketLib1125.cs:607)', () => {
        const p = W().u8(1).u8(0).u8(1).u8(3).u8(5).u8(12).u8(37).u8(0x40).u8(3).u8(1).u16le(25).u32le(150).u16le(3).intLePascal('short sword').toBytes();
        expect(decodeMerchantWindow(p)).toEqual({
            windowType: 0, page: 1,
            items: [{ index: 3, level: 5, value1: 12, spdAbs: 37, hand: 1, objectType: 3, damageType: 0, usable: true, value2: 25, price: 150, model: 3, name: 'short sword' }],
        });
        expect(decodeMerchantWindow(Uint8Array.of(0, 0, 0, 0)).items).toEqual([]);
    });

    test('0x7B TrainerWindow spec list (PacketLib1105.cs:29)', () => {
        const p = W().u8(2).u8(7).u8(0).u8(0).u8(0).u8(1).u8(2).pascal('Slash').u8(1).u8(3).u8(4).pascal('Shields').toBytes();
        expect(decodeTrainerWindow(p)).toEqual({ code: 0, specPoints: 7, specs: [{ index: 0, level: 1, nextLevel: 2, name: 'Slash' }, { index: 1, level: 3, nextLevel: 4, name: 'Shields' }] });
        expect(decodeTrainerWindow(Uint8Array.of(0, 7, 1, 0))).toEqual({ code: 1, specPoints: 7 });
    });

    /** 0xEA open up to its items (PacketLib1109.cs:34-71). Money is [mithril, platinum, gold, silver, copper]. */
    const tradeHead = (slots: number[], mine: number[], theirs: number[], itemCount: number): PacketWriter => {
        const w = W().bytes(slots).fill(0, 10 - slots.length).u16(0);
        for (const coin of mine) w.u16(coin);
        w.u16(0);
        for (const coin of theirs) w.u16(coin);
        return w.u16(0).u8(itemCount).u8(1).u8(0).u8(0);
    };
    /** WriteItemData up to its flag byte (PacketLib1124.cs:836), as in the 0x02 fixtures above: a generic item, with its count in the value bytes. */
    const itemHead = (w: PacketWriter, flag: number, count = 1): PacketWriter =>
        w.u16(0).u8(5).u8(count).u8(0).u8(0).u8(0).u8(0).u16(5).u8(100).u8(100).u8(100).u8(0).u8(0).u16(99).u8(0).u16(0).u8(flag);

    test('0xEA TradeWindow open (PacketLib1109.cs:34-78)', () => {
        const w = tradeHead([40, 41], [0, 0, 1, 2, 3], [0, 0, 0, 0, 50], 1).u8(45);
        itemHead(w, 0x02, 3).u16(0).pascal('3 minor healing potion').pascal('Trading with Aine');
        const p = w.toBytes();
        expect(p[36]).toBe(1); // item count
        expect(p[40]).toBe(45); // first item's slot
        const d = decodeTradeWindow(p)!;
        expect(d).toMatchObject({
            mySlots: [40, 41],
            myMoney: { mithril: 0, platinum: 0, gold: 1, silver: 2, copper: 3 },
            partnerMoney: { mithril: 0, platinum: 0, gold: 0, silver: 0, copper: 50 },
            partnerName: 'Aine',
        });
        expect(d.partnerItems).toHaveLength(1);
        expect(d.partnerItems[0]).toMatchObject({ slot: 45, item: { name: 'minor healing potion', count: 3, model: 99 } });
    });

    test('0xEA: one item whose name starts with a number keeps its name and its count', () => {
        const w = tradeHead([], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], 2).u8(45);
        itemHead(w, 0x02).u16(0).pascal('100 gold rent token').u8(46);
        itemHead(w, 0x02, 3).u16(0).pascal('3 100 gold rent token').pascal('Trading with Aine');
        const d = decodeTradeWindow(w.toBytes())!;
        expect(d.partnerItems.map(i => [i.item.name, i.item.count])).toEqual([['100 gold rent token', 1], ['100 gold rent token', 3]]);
    });

    test('a number in front of a name is a count only where the value bytes agree (PacketLib1124.cs:850-863, :978-979)', () => {
        const item = (objectType: number, value1: number, value2: number, name: string) => {
            const w = W().u8(1).u8(0).u8(0).u8(0).u8(0).u8(2).u8(45);
            w.u16(0).u8(5).u8(value1).u8(value2).u8(0).u8(objectType).u8(0).u16(5).u8(100).u8(100).u8(100).u8(0).u8(0).u16(99).u8(0).u16(0).u8(0x02).u16(0).pascal(name);
            const it = decodeInventoryUpdate(w.toBytes()).items[0]!.item;
            return [it.name, it.count];
        };
        expect(item(ObjectType.GenericItem, 1, 0, '100 yr old cheese')).toEqual(['100 yr old cheese', 1]);
        expect(item(ObjectType.GenericItem, 44, 1, '300 nails')).toEqual(['nails', 300]);
        expect(item(ObjectType.Arrow, 1, 0, '20 Elven Arrows')).toEqual(['20 Elven Arrows', 1]);
        expect(item(ObjectType.Arrow, 20, 0, '20 20 Elven Arrows')).toEqual(['20 Elven Arrows', 20]);
        expect(item(ObjectType.Arrow, 44, 0, '300 arrows')).toEqual(['arrows', 300]); // a byte holds only the low bits
        expect(item(ObjectType.Thrown, 12, 1, '20 Tomte Throwing Hammers')).toEqual(['20 Tomte Throwing Hammers', 1]);
        expect(item(ObjectType.Thrown, 12, 2, '2 20 Tomte Throwing Hammers')).toEqual(['20 Tomte Throwing Hammers', 2]);
        expect(item(ObjectType.Blades, 12, 37, '3 short swords')).toEqual(['short swords', 3]); // no count in these bytes: the prefix is all there is
    });

    test('0xEA with a spell block in a partner item stays aligned up to the title', () => {
        const w = tradeHead([], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], 2).u8(45);
        itemHead(w, 0x02 | 0x08 | 0x10, 2).u16(1).pascal('Heal').u16(2).pascal('Buff').u16(0).pascal('2 potion of life').u8(46);
        itemHead(w, 0x02).u16(0).pascal('short sword').pascal('Trading with Aine');
        const d = decodeTradeWindow(w.toBytes())!;
        expect(d.partnerItems.map(i => [i.slot, i.item.name, i.item.count, i.item.spell1])).toEqual([[45, 'potion of life', 2, 'Heal'], [46, 'short sword', 1, null]]);
        expect(d.partnerName).toBe('Aine');
    });

    test('0xEA money order, from the bytes as written out; Selfcrafting has no partner', () => {
        const title = encodeCp1252('Selfcrafting');
        const p = Uint8Array.of(
            40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 0,
            0, 6, 0, 7, 0, 8, 0, 9, 0, 10, 0, 0,
            0, 1, 0, 0,
            title.length, ...title,
        );
        expect(decodeTradeWindow(p)).toEqual({
            mySlots: [40],
            myMoney: { mithril: 1, platinum: 2, gold: 3, silver: 4, copper: 5 },
            partnerMoney: { mithril: 6, platinum: 7, gold: 8, silver: 9, copper: 10 },
            partnerItems: [],
            partnerName: null,
        });
    });

    test('0xEA close is 40 zero bytes (PacketLib168.cs:1983)', () => {
        expect(decodeTradeWindow(new Uint8Array(40))).toBeNull();
    });

    test('0x70 GroupMemberUpdate records', () => {
        const p = W().u8(0x20 | 1).u8(50).u8(40).u8(30).u8(0x01).u8(0x80 | 0).u8(1).u8(0).u16(99).u8(0).toBytes();
        expect(decodeGroupMemberUpdate(p).records).toEqual([
            { kind: 'status', groupIndex: 1, healthPercent: 50, manaPercent: 40, endurancePercent: 30, status: 1 },
            { kind: 'icons', groupIndex: 0, icons: [99] },
        ]);
    });
});

describe('decoders without a model test (golden layouts)', () => {
    test('0xFE Realm (PacketLib1125.cs:61-69) and 0xCC DupNameCheckReply (PacketLib1126.cs:35-45)', () => {
        expect(decodeRealm(W().u8(2).fill(0, 12).toBytes())).toEqual({ realm: 2 });
        // Results: 0 ok, 1 invalid, 2 taken (DuplicateNameCheckRequestHandler.cs:17-24).
        expect(decodeDupNameCheckReply(W().fixedString('Fxclone', 24).u8(2).toBytes())).toEqual({ name: 'Fxclone', result: 2 });
        expect(decodeDupNameCheckReply(W().fixedString('Ok', 24).u8(0).toBytes()).result).toBe(0);
    });

    test('0xBD Encumberance (PacketLib168.cs:2339-2349): max carry first, then current weight', () => {
        expect(decodeEncumbrance(W().u16(150).u16(42).toBytes())).toEqual({ max: 150, current: 42 });
    });

    test('0xA4 Quit (PacketLib168.cs:864-875) and 0x7E Time (PacketLib168.cs:576-590)', () => {
        expect(decodeQuit(W().u8(0).u8(12).toBytes())).toEqual({ totalOut: false, level: 12 });
        expect(decodeQuit(W().u8(1).u8(0).toBytes())).toEqual({ totalOut: true, level: 0 });
        expect(decodeTime(W().u32(43_200_000).u32(24).toBytes())).toEqual({ gameTime: 43_200_000, dayIncrement: 24 });
    });

    test('0xE1 ObjectDelete (PacketLib168.cs:2869-2876) and 0xEE ObjectDataUpdate (PacketLib171.cs:345-349)', () => {
        expect(decodeObjectDelete(W().u16(0x1234).u16(1).toBytes())).toEqual({ objectId: 0x1234 });
        expect(decodeObjectDataUpdate(W().u16(500).u8(0).u8(17).u8(0).u8(0).toBytes())).toEqual({ objectId: 500, level: 17 });
    });

    test('0x74 AttackMode (PacketLib168.cs:371-383)', () => {
        expect(decodeAttackMode(W().u8(1).fill(0, 3).toBytes())).toEqual({ on: true });
        expect(decodeAttackMode(W().u8(0).fill(0, 3).toBytes())).toEqual({ on: false });
    });

    test('0xF6 ChangeTarget and 0xEC ChangeGroundTarget (PacketLib168.cs:2924-2956)', () => {
        expect(decodeChangeTarget(W().u16(321).u16(0).toBytes())).toEqual({ objectId: 321 });
        expect(decodeChangeTarget(W().u16(0).u16(0).toBytes())).toEqual({ objectId: 0 });
        expect(decodeChangeGroundTarget(W().u32(574_800).u32(530_200).u32(2900).toBytes())).toEqual({ x: 574_800, y: 530_200, z: 2900 });
    });

    test('0x73 InterruptSpellCast (PacketLib168.cs:2654-2661)', () => {
        expect(decodeInterrupt(W().u16(77).u16(1).toBytes())).toEqual({ objectId: 77 });
    });

    test('0x1B SpellEffectAnimation (PacketLib174.cs:458-470), with and without the success byte', () => {
        expect(decodeSpellEffect(W().u16(10).u16(5208).u16(20).u16(3).u8(1).u8(1).toBytes()))
            .toEqual({ casterId: 10, effect: 5208, targetId: 20, boltTime: 3, success: 1 });
        expect(decodeSpellEffect(W().u16(0).u16(1).u16(20).u16(0).u8(0).toBytes()))
            .toEqual({ casterId: 0, effect: 1, targetId: 20, boltTime: 0, success: 0 });
    });
});
