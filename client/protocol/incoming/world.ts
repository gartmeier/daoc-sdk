// World-entry / self-position packets (server → client).

import { PacketReader } from '../buffer';

/** 0x20 PositionAndObjectID (PacketLib1124.cs:441-487). */
export interface PositionAndObjectId {
    x: number;
    y: number;
    z: number;
    objectId: number;
    heading: number;
    /** Dungeon zone offsets / 0x2000, 0 outside dungeons. */
    zoneXOffset: number;
    zoneYOffset: number;
    /** Region skin (== region id outside instances). */
    regionId: number;
    flags: number;
}

export function decodePositionAndObjectId(p: Uint8Array): PositionAndObjectId {
    const r = new PacketReader(p);
    const x = r.f32le();
    const y = r.f32le();
    const z = r.f32le();
    const objectId = r.u16();
    const heading = r.u16() & 0xFFF;
    const zoneXOffset = r.u16();
    const zoneYOffset = r.u16();
    const regionId = r.u16();
    const flags = r.u8();
    return { x, y, z, objectId, heading, zoneXOffset, zoneYOffset, regionId, flags };
}

/** 0x04 CharacterJump (PacketLib168.cs:519-541): u32 x, u32 y, u16 oid, u16 z, u16 heading, u16 house. */
export interface CharacterJump {
    x: number;
    y: number;
    objectId: number;
    z: number;
    heading: number;
    house: number;
    /** x == y == 0: heading-only update. */
    headingOnly: boolean;
}

export function decodeCharacterJump(p: Uint8Array): CharacterJump {
    const r = new PacketReader(p);
    const x = r.u32();
    const y = r.u32();
    const objectId = r.u16();
    const z = r.u16();
    const heading = r.u16() & 0xFFF;
    const house = r.remaining >= 2 ? r.u16() : 0;
    return { x, y, objectId, z, heading, house, headingOnly: x === 0 && y === 0 };
}

/** 0xC8 Riding (PacketLib168.cs:1304-1322): u16 rider, u16 steed, u8 1 = mount / 0 = dismount, u8 seat, u16 0. */
export function decodeRiding(p: Uint8Array): { riderId: number; steedId: number; mounted: boolean; seat: number } {
    const r = new PacketReader(p);
    const riderId = r.u16();
    const steedId = r.u16();
    const mounted = r.u8() !== 0;
    const seat = r.remaining > 0 ? r.u8() : 0;
    return { riderId, steedId, mounted, seat };
}

/** 0xB7 RegionChanged (PacketLib174.cs:385-406): u16 regionSkin, u16 zoneSkin, ... */
export function decodeRegionChanged(p: Uint8Array): { regionId: number; zoneId: number } {
    const r = new PacketReader(p);
    return { regionId: r.u16(), zoneId: r.remaining >= 2 ? r.u16() : 0 };
}

/** 0xB6 MaxSpeed (PacketLib168.cs:1201-1213): u16 pct, u8 turningDisabled, u8 waterSpeed. */
export function decodeMaxSpeed(p: Uint8Array): { percent: number; turningDisabled: boolean; waterSpeed: number } {
    const r = new PacketReader(p);
    const percent = r.u16();
    const turningDisabled = r.remaining > 0 ? r.u8() !== 0 : false;
    const waterSpeed = r.remaining > 0 ? r.u8() : 0;
    return { percent, turningDisabled, waterSpeed };
}

/** 0xBD Encumberance (PacketLib168.cs:2339): u16 maxCarry, u16 currentWeight. */
export function decodeEncumbrance(p: Uint8Array): { max: number; current: number } {
    const r = new PacketReader(p);
    return { max: r.u16(), current: r.u16() };
}

/** 0xA4 Quit (PacketLib168.cs:864-875): u8 totalOut, u8 level. */
export function decodeQuit(p: Uint8Array): { totalOut: boolean; level: number } {
    return { totalOut: (p[0] ?? 0) !== 0, level: p[1] ?? 0 };
}

/** 0x7E Time (PacketLib168.cs:576): u32 gameTimeMs, u32 dayIncrement. */
export function decodeTime(p: Uint8Array): { gameTime: number; dayIncrement: number } {
    const r = new PacketReader(p);
    return { gameTime: r.u32(), dayIncrement: r.remaining >= 4 ? r.u32() : 0 };
}

/** 0xD0 CheckLOSRequest (gameutils/LosCheckHandler.cs:102-107): u16 source, u16 target, u16 0, u16 0. */
export function decodeLosRequest(p: Uint8Array): { sourceId: number; targetId: number } {
    const r = new PacketReader(p);
    return { sourceId: r.u16(), targetId: r.u16() };
}
