// World object packets: NPCs, static objects, other players.

import { PacketReader } from '../buffer';

/** 0xDA NPCCreate (PacketLib1124.cs:121-279). */
export interface NpcCreate {
    objectId: number;
    speed: number;
    heading: number;
    z: number;
    x: number;
    y: number;
    speedZ: number;
    model: number;
    size: number;
    level: number;
    isStatue: boolean;
    /** Realm byte (0 none, 1 alb, 2 mid, 3 hib) relative to the viewer (GetLivingRealm). */
    realm: number;
    isGhost: boolean;
    hasInventory: boolean;
    hasTorch: boolean;
    isPeaceful: boolean;
    isFlying: boolean;
    cantTarget: boolean;
    dontShowName: boolean;
    isStealthed: boolean;
    questAvailable: boolean;
    questFinish: boolean;
    isPet: boolean;
    flags3: number;
    name: string;
    guildName: string;
}

export function decodeNpcCreate(p: Uint8Array): NpcCreate {
    const r = new PacketReader(p);
    const objectId = r.u16();
    const speed = r.u16();
    const heading = r.u16() & 0xFFF;
    const z = r.u16();
    const x = r.u32();
    const y = r.u32();
    const speedZ = r.u16();
    const model = r.u16();
    const size = r.u8();
    const lvl = r.u8();
    const flags = r.u8();
    r.u8(); // max stick
    const flags2 = r.u8();
    const flags3 = r.u8();
    r.u16();
    const name = r.pascal();
    const guildName = r.remaining > 0 ? r.pascal() : '';
    return {
        objectId, speed, heading, z, x, y, speedZ, model, size,
        level: lvl & 0x7F,
        isStatue: (lvl & 0x80) !== 0,
        realm: (flags >> 6) & 0x03,
        isGhost: (flags & 0x01) !== 0,
        hasInventory: (flags & 0x02) !== 0,
        hasTorch: (flags & 0x04) !== 0,
        isPeaceful: (flags & 0x10) !== 0,
        isFlying: (flags & 0x20) !== 0,
        cantTarget: (flags2 & 0x01) !== 0,
        dontShowName: (flags2 & 0x02) !== 0,
        isStealthed: (flags2 & 0x04) !== 0,
        questAvailable: (flags2 & 0x08) !== 0,
        questFinish: (flags2 & 0x10) !== 0,
        isPet: (flags2 & 0x80) !== 0,
        flags3,
        name,
        guildName,
    };
}

/** 0xA1 ObjectUpdate (PacketLib168.cs:724-862), 24 bytes. X/Y are offsets in the zone with the given skin id. */
export interface ObjectUpdate {
    speed: number;
    zSpeedNegative: boolean;
    heading: number;
    xOffset: number;
    destXOffset: number;
    yOffset: number;
    destYOffset: number;
    z: number;
    destZ: number;
    objectId: number;
    /** Non-zero = attack state; 65535 = dummy (attacking but not in range). */
    targetId: number;
    healthPercent: number;
    realm: number;
    cantTarget: boolean;
    dontShowName: boolean;
    underwater: boolean;
    flying: boolean;
    zoneSkinId: number;
    destZoneSkinId: number;
}

export function decodeObjectUpdate(p: Uint8Array): ObjectUpdate {
    const r = new PacketReader(p);
    const rawSpeed = r.u16();
    const rawHeading = r.u16();
    const xOffset = r.u16();
    const destXOffset = r.u16();
    const yOffset = r.u16();
    const destYOffset = r.u16();
    const z = r.u16();
    const destZ = r.u16();
    const objectId = r.u16();
    const targetId = r.u16();
    const healthPercent = r.u8();
    const flags = r.u8();
    const zoneLo = r.u8();
    const destZoneLo = r.u8();
    return {
        speed: rawSpeed & 0x0FFF,
        zSpeedNegative: (rawSpeed & 0x8000) !== 0,
        heading: rawHeading & 0x0FFF,
        xOffset, destXOffset, yOffset, destYOffset, z, destZ, objectId, targetId, healthPercent,
        realm: (flags >> 6) & 0x03,
        cantTarget: (flags & 0x01) !== 0,
        dontShowName: (flags & 0x02) !== 0,
        underwater: (flags & 0x10) !== 0,
        flying: (flags & 0x20) !== 0,
        zoneSkinId: zoneLo | ((flags & 0x04) << 6),
        destZoneSkinId: destZoneLo | ((flags & 0x08) << 5),
    };
}

/** 0xA2 RemoveObject (PacketLib168.cs:877): u16 oid, u16 type (0 dead npc, 1 npc, 2 player). */
export function decodeRemoveObject(p: Uint8Array): { objectId: number; type: number } {
    const r = new PacketReader(p);
    return { objectId: r.u16(), type: r.remaining >= 2 ? r.u16() : 0 };
}

/** 0xDB ModelChange (PacketLib168.cs:990-998): u16 oid, u16 model, u32 LE size (a player's 0: :982). A player's goes out to all within view on any change of Model (GamePlayer.cs:2018-2022). */
export function decodeModelChange(p: Uint8Array): { objectId: number; model: number; size: number } {
    const r = new PacketReader(p);
    return { objectId: r.u16(), model: r.u16(), size: r.u32le() };
}

/**
 * 0x8D PlayerModelTypeChange (PacketLib168.cs:2853-2862): u16 oid, u8 type, u8 flag. Stealth sends it to the stealther alone:
 * type 3 on hiding, 2 on showing again (StealthECSEffect.cs:27, :54).
 */
export function decodeModelTypeChange(p: Uint8Array): { objectId: number; modelType: number } {
    const r = new PacketReader(p);
    return { objectId: r.u16(), modelType: r.u8() };
}

/** 0xE1 ObjectDelete (PacketLib168.cs:2864): u16 oid, u16 1. */
export function decodeObjectDelete(p: Uint8Array): { objectId: number } {
    return { objectId: new PacketReader(p).u16() };
}

/** 0xD9 ObjectCreate (PacketLib176.cs:73-149): static items, doors, loot. */
export interface ObjectCreate {
    objectId: number;
    emblem: number;
    heading: number;
    z: number;
    x: number;
    y: number;
    model: number;
    realm: number;
    underwater: boolean;
    /** You own this timed loot (GameStaticItemTimed.IsOwner). */
    ownedByUs: boolean;
    isKeepBanner: boolean;
    name: string;
    doorId: number | null;
}

export function decodeObjectCreate(p: Uint8Array): ObjectCreate {
    const r = new PacketReader(p);
    const objectId = r.u16();
    const emblem = r.u16();
    const heading = r.u16() & 0xFFF;
    const z = r.u16();
    const x = r.u32();
    const y = r.u32();
    const model = r.u16();
    const flag = r.u16();
    r.u32();
    const name = r.pascal();
    let doorId: number | null = null;
    if (r.remaining > 0) {
        const kind = r.u8();
        if (kind === 4 && r.remaining >= 4) doorId = r.u32();
    }
    return {
        objectId, emblem, heading, z, x, y,
        model: model & 0x7FFF,
        realm: (flag >> 4) & 0x03,
        underwater: (flag & 0x01) !== 0,
        ownedByUs: (flag & 0x04) !== 0,
        isKeepBanner: (flag & 0x08) !== 0,
        name,
        doorId,
    };
}

/** 0x4B PlayerCreate172 (PacketLib1124.cs:333-439). */
export interface PlayerCreate {
    x: number;
    y: number;
    z: number;
    sessionId: number;
    objectId: number;
    heading: number;
    model: number;
    level: number;
    realm: number;
    isDead: boolean;
    underwater: boolean;
    stealthed: boolean;
    name: string;
    guildName: string;
    lastName: string;
    prefix: string;
    title: string;
}

export function decodePlayerCreate(p: Uint8Array): PlayerCreate {
    const r = new PacketReader(p);
    const x = r.f32le();
    const y = r.f32le();
    const z = r.f32le();
    const sessionId = r.u16();
    const objectId = r.u16();
    const heading = r.u16() & 0xFFF;
    const model = r.u16();
    const level = r.u8();
    const flags = r.u8();
    r.skip(7 + 3);
    const name = r.pascal();
    const guildName = r.pascal();
    const lastName = r.pascal();
    const prefix = r.remaining > 0 ? r.pascal() : '';
    const title = r.remaining > 0 ? r.pascal() : '';
    return {
        x, y, z, sessionId, objectId, heading, model, level,
        realm: (flags >> 2) & 0x03,
        isDead: (flags & 0x01) !== 0,
        underwater: (flags & 0x02) !== 0,
        stealthed: (flags & 0x10) !== 0,
        name, guildName, lastName, prefix, title,
    };
}

/** 0xA9 PlayerPosition relayed for another player, 1.127 layout (PlayerPositionUpdateHandler.cs:611-635). */
export interface PlayerPosition {
    x: number;
    y: number;
    z: number;
    speed: number;
    fallSpeed: number;
    sessionId: number;
    objectId: number;
    zoneId: number;
    stateFlags: number;
    heading: number;
    actionFlags: number;
    healthPercent: number;
    inCombat: boolean;
    manaPercent: number;
    endurancePercent: number;
    isSitting: boolean;
    isDead: boolean;
}

export function decodePlayerPosition(p: Uint8Array): PlayerPosition {
    const r = new PacketReader(p);
    const x = r.f32le();
    const y = r.f32le();
    const z = r.f32le();
    const speed = r.f32le();
    const fallSpeed = r.f32le();
    const sessionId = r.u16();
    const objectId = r.u16();
    const zoneId = r.u16();
    const stateFlags = r.u8();
    r.u8();
    r.u16(); // steed seat
    const heading = r.u16() & 0xFFF;
    const actionFlags = r.u8();
    r.u8(); // RP flag
    r.u8();
    const hp = r.u8();
    const manaPercent = r.remaining > 0 ? r.u8() : 0;
    const endurancePercent = r.remaining > 0 ? r.u8() : 0;
    const state = stateFlags & 0x1C;
    return {
        x, y, z, speed, fallSpeed, sessionId, objectId, zoneId, stateFlags, heading, actionFlags,
        healthPercent: hp & 0x7F,
        inCombat: (hp & 0x80) !== 0,
        manaPercent, endurancePercent,
        isSitting: state === 0x10,
        isDead: state === 0x14,
    };
}

/** 0xBA PlayerHeading relayed, 1.127 (PlayerHeadingUpdateHandler.cs:69-83). */
export interface PlayerHeading {
    sessionId: number;
    heading: number;
    actionFlags: number;
    stateFlags: number;
    healthPercent: number;
    inCombat: boolean;
    manaPercent: number;
    endurancePercent: number;
}

export function decodePlayerHeading(p: Uint8Array): PlayerHeading {
    const r = new PacketReader(p);
    const sessionId = r.u16();
    r.u16();
    const heading = r.u16() & 0xFFF;
    r.u8(); // seat
    const actionFlags = r.u8();
    r.u8();
    const stateFlags = (r.u8() << 2) & 0xFF;
    const hp = r.remaining > 0 ? r.u8() : 0;
    const manaPercent = r.remaining > 0 ? r.u8() : 0;
    const endurancePercent = r.remaining > 0 ? r.u8() : 0;
    return { sessionId, heading, actionFlags, stateFlags, healthPercent: hp & 0x7F, inCombat: (hp & 0x80) !== 0, manaPercent, endurancePercent };
}

/** 0xEE ObjectDataUpdate (PacketLib171.cs:343): u16 oid, u8 0, u8 level, then strings or 0xFF. */
export function decodeObjectDataUpdate(p: Uint8Array): { objectId: number; level: number } {
    const r = new PacketReader(p);
    const objectId = r.u16();
    r.u8();
    return { objectId, level: r.u8() };
}

/** One item a living shows (0x15): its slot (eInventorySlot 10-37) and model. */
export interface VisibleItem {
    slot: number;
    model: number;
}

/** 0x15 EquipmentUpdate (PacketLib1124.cs:52-105): what every client in view sees a living wear. */
export interface EquipmentUpdate {
    objectId: number;
    /** VisibleActiveWeaponSlots: low nibble the right hand's slot, high nibble the left's, 0xF none (10 right, 11 left, 12 two-hand, 13 ranged, minus 10). */
    activeWeapons: number;
    items: VisibleItem[];
}

/**
 * Per item: u8 slot (0x80 a new-style emblem, left hand and cloak only), u16 model (low 13 bits; 0x8000 a u16
 * texture follows, 0x4000 a u8 one, 0x2000 a u16 effect), u8 extension unless a weapon slot (10-13), then the
 * texture and the effect. A short packet keeps what it read.
 */
export function decodeEquipmentUpdate(p: Uint8Array): EquipmentUpdate {
    const r = new PacketReader(p);
    const objectId = r.u16();
    const activeWeapons = r.u8();
    r.u8(); // speed
    r.u8(); // cloak/helm invisible
    r.u8(); // hood up, quiver
    const count = r.remaining > 0 ? r.u8() : 0;
    const items: VisibleItem[] = [];
    for (let i = 0; i < count && r.remaining >= 3; i++) {
        const slot = r.u8() & 0x7F;
        const raw = r.u16();
        let need = (slot < 10 || slot > 13 ? 1 : 0) + (raw & 0x8000 ? 2 : raw & 0x4000 ? 1 : 0) + (raw & 0x2000 ? 2 : 0);
        if (r.remaining < need) break;
        for (; need > 0; need--) r.u8();
        items.push({ slot, model: raw & 0x1FFF });
    }
    return { objectId, activeWeapons, items };
}
