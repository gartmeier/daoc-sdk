// What a client sees an enemy player wear and swing: 0x15 EquipmentUpdate and the style and weapon of 0xBC.

import { describe, expect, test } from 'bun:test';
import { PacketWriter } from '../protocol/buffer';
import { decodeEquipmentUpdate } from '../protocol/incoming/objects';
import { ServerOp } from '../protocol/opcodes';
import { WorldModel } from './world-model';

const W = () => new PacketWriter();
const ME = { x: 574797, y: 530161, z: 2896 };

const playerCreate = (oid: number, session: number, name: string, realm: number, model = 32) =>
    W().f32le(ME.x + 50).f32le(ME.y).f32le(ME.z).u16(session).u16(oid).u16(0).u16(model).u8(20).u8(realm << 2).fill(0, 10)
        .pascal(name).pascal('').pascal('').pascal('').pascal('').u8(0).toBytes();

/** 0x15 as PacketLib1124.cs:52-105 writes it: a mace (no extension), a shield with a u8 color and the emblem bit, a torso with a u16 texture and an effect. */
function equipment(oid: number): Uint8Array {
    return W().u16(oid).u8(0x10).u8(0).u8(0).u8(0).u8(3)
        .u8(10).u16(451)
        .u8(11 | 0x80).u16(60 | 0x4000).u8(5)
        .u8(25).u16(46 | 0x8000 | 0x2000).u8(0).u16(0x1234).u16(77)
        .toBytes();
}

describe('0x15 EquipmentUpdate', () => {
    test('slots and models, past each item\'s extension, texture and effect', () => {
        expect(decodeEquipmentUpdate(equipment(301))).toEqual({
            objectId: 301, activeWeapons: 0x10,
            items: [{ slot: 10, model: 451 }, { slot: 11, model: 60 }, { slot: 25, model: 46 }],
        });
    });

    test('a short packet keeps what it read', () => {
        const p = equipment(301);
        expect(decodeEquipmentUpdate(p.slice(0, p.length - 3)).items).toEqual([{ slot: 10, model: 451 }, { slot: 11, model: 60 }]);
        expect(decodeEquipmentUpdate(W().u16(5).u8(0xFF).u8(0).u8(0).u8(0).toBytes())).toEqual({ objectId: 5, activeWeapons: 0xFF, items: [] });
    });

    test('a player in view shows its gear, which goes with it', () => {
        let now = 1000;
        const m = new WorldModel({}, () => now);
        m.self.objectId = 123;
        m.handle(ServerOp.EquipmentUpdate, equipment(301)); // before the create: kept
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Norseman', 2));
        expect(m.nearbyPlayers(ME)[0]!.gear).toEqual({ activeWeapons: 0x10, items: [{ slot: 10, model: 451 }, { slot: 11, model: 60 }, { slot: 25, model: 46 }], at: 1000 });
        m.handle(ServerOp.EquipmentUpdate, equipment(123)); // our own: not a player in view
        expect(m.gear.has(123)).toBe(false);
        m.removeObject(301);
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Norseman', 2));
        expect(m.nearbyPlayers(ME)[0]!.gear).toBeUndefined();
        now = 2000;
        m.handle(ServerOp.EquipmentUpdate, equipment(301));
        m.handle(ServerOp.NPCCreate, W().u16(301).u16(0).u16(0).u16(ME.z).u32(ME.x).u32(ME.y).u16(0).u16(400).u8(50).u8(1).u8(0).u8(0x20).u8(0).u8(0).u16(0).pascal('rat').pascal('').u8(0).toBytes());
        expect(m.gear.has(301)).toBe(false);
    });
});

describe('0xBC style and weapon', () => {
    const swing = (style: number, weapon: number) => W().u16(301).u16(123).u16(weapon).u16(0).u16le(style).u8(0).u8(11).u8(90).u8(0).toBytes();

    test('a styled swing carries its animation and weapon model; a plain one neither', () => {
        const m = new WorldModel();
        m.self.objectId = 123;
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Norseman', 2));
        m.handle(ServerOp.CombatAnimation, swing(178, 319));
        m.handle(ServerOp.CombatAnimation, swing(0, 0));
        expect(m.combatEvents.map(e => [e.style, e.weaponModel])).toEqual([[178, 319], [undefined, undefined]]);
    });
});
