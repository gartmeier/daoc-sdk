// Login / character-screen packets (server → client).

import { PacketReader } from '../buffer';

/** 0x22 CryptKey (PacketLib1126.cs:52-76): u32LE 0, "1.127" (5 bytes), 3×0. */
export interface CryptKey {
    keyLength: number;
    version: string;
}

export function decodeCryptKey(p: Uint8Array): CryptKey {
    const r = new PacketReader(p);
    const keyLength = r.u32le();
    const version = r.remaining >= 5 ? r.fixedString(5) : '';
    return { keyLength, version };
}

/** 0x2A LoginGranted (PacketLib1127.cs:13-27). */
export interface LoginGranted {
    accountName: string;
    serverName: string;
    serverId: number;
    colorType: number;
}

export function decodeLoginGranted(p: Uint8Array): LoginGranted {
    const r = new PacketReader(p);
    const accountName = r.pascal();
    const serverName = r.pascal();
    const serverId = r.remaining > 0 ? r.u8() : 0;
    const colorType = r.remaining > 0 ? r.u8() : 0;
    return { accountName, serverName, serverId, colorType };
}

/** 0x2C LoginDenied (PacketLib168.cs:84-101): u8 eLoginError, ... */
export function decodeLoginDenied(p: Uint8Array): { code: number } {
    return { code: p.length > 0 ? p[0]! : 0 };
}

/** 0x28 SessionID: u16 LE (PacketLib168.cs:133-140). */
export function decodeSessionId(p: Uint8Array): { sessionId: number } {
    return { sessionId: new PacketReader(p).u16le() };
}

/** 0x29 PingReply (PacketLib168.cs:142-151): u32BE timestamp, 4×0, u16BE seq+1. */
export function decodePingReply(p: Uint8Array): { timestamp: number; sequence: number } {
    const r = new PacketReader(p);
    const timestamp = r.u32();
    r.skip(4);
    const sequence = r.remaining >= 2 ? r.u16() : 0;
    return { timestamp, sequence };
}

/** 0xFE Realm (PacketLib1125.cs:61-69): u8 realm + 12×0. */
export function decodeRealm(p: Uint8Array): { realm: number } {
    return { realm: p[0] ?? 0 };
}

/** 0xCC DupNameCheckReply (PacketLib1126.cs:35-46): FillString(name,24), u8 result (0 ok, 1 invalid, 2 taken). */
export function decodeDupNameCheckReply(p: Uint8Array): { name: string; result: number } {
    const r = new PacketReader(p);
    const name = r.fixedString(24);
    return { name, result: r.remaining > 0 ? r.u8() : 0 };
}

export interface OverviewCharacter {
    /** Slot 0..9 within the realm. */
    slot: number;
    level: number;
    name: string;
    location: string;
    className: string;
    raceName: string;
    eyeSize: number;
    lipSize: number;
    eyeColor: number;
    hairColor: number;
    faceType: number;
    hairStyle: number;
    model: number;
    region: number;
    stats: number[];
    classId: number;
    realm: number;
    raceId: number;
    gender: number;
}

export interface CharacterOverview {
    flags: number;
    /** 10 entries; null = empty slot. Empty when the account has no characters at all (16-byte form). */
    slots: (OverviewCharacter | null)[];
}

/** 0xFC CharacterOverview1126 (PacketLib1126.cs:78-298). */
export function decodeCharacterOverview(p: Uint8Array): CharacterOverview {
    const r = new PacketReader(p);
    const flags = r.u32le();
    r.skip(12);
    const slots: (OverviewCharacter | null)[] = [];
    if (r.remaining === 0) return { flags, slots };
    for (let slot = 0; slot < 10 && r.remaining > 0; slot++) {
        const level = r.u8();
        if (level === 0) {
            slots.push(null);
            continue;
        }
        const name = r.intLePascal();
        r.skip(4); // 0x18
        r.skip(1); // always 1
        const eyeSize = r.u8();
        const lipSize = r.u8();
        const eyeColor = r.u8();
        const hairColor = r.u8();
        const faceType = r.u8();
        const hairStyle = r.u8();
        r.skip(4); // ext boots/gloves, ext torso/hood, customisation step, mood
        r.skip(13);
        const location = r.intLePascal();
        const className = r.intLePascal();
        const raceName = r.intLePascal();
        const model = r.u16le();
        const region = r.u8();
        r.skip(1); // expansion
        r.skip(16 + 16 + 8); // armor models, colors, weapon models
        const stats: number[] = [];
        for (let i = 0; i < 8; i++) stats.push(r.u8());
        const classId = r.u8();
        const realm = r.u8();
        const rg = r.u8();
        const raceId = ((rg >> 2) & 0x10) | (rg & 0x0F);
        const gender = (rg >> 7) & 1;
        r.skip(2 + 1 + 1 + 1); // active weapons, SI flag, con, 0
        slots.push({ slot, level, name, location, className, raceName, eyeSize, lipSize, eyeColor, hairColor, faceType, hairStyle, model, region, stats, classId, realm, raceId, gender });
    }
    return { flags, slots };
}
