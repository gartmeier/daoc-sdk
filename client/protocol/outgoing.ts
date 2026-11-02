// Client → server payload encoders (pure). Each returns the payload only;
// framing is done by net/framing.ts. Layouts are for client 1.127 and cite the
// handler in server/core/GameServer/packets/Client/168/.

import type { Look } from '../model/look';
import { PacketWriter } from './buffer';

// ── Login / character screen ────────────────────────────────────────────────

export interface CryptKeyOptions {
    clientType?: number;
    major?: number;
    minor?: number;
    build?: number;
    revision?: number;
}

/** 0xF4 CryptKeyRequest, exactly 7 bytes (CryptKeyRequestHandler.cs:31-61; >7 bytes = RC4 key, no reply). */
export function encodeCryptKeyRequest(o: CryptKeyOptions = {}): Uint8Array {
    return new PacketWriter(7)
        .u8(o.clientType ?? 0x06)
        .u8(o.major ?? 1)
        .u8(o.minor ?? 1)
        .u8(o.build ?? 0x1B)
        .u8(o.revision ?? 0x61)
        .u16(0)
        .toBytes();
}

/** 0xA7 LoginRequest (LoginRequestHandler.cs:149-153, >=1126: two intLE-pascal strings). */
export function encodeLoginRequest(username: string, password: string): Uint8Array {
    return new PacketWriter().intLePascal(username).intLePascal(password).toBytes();
}

/** 0xFC CharacterOverviewRequest (CharacterOverviewRequestHandler.cs:87-143). realm 0 = ask. */
export function encodeCharacterOverviewRequest(realm: number): Uint8Array {
    return Uint8Array.of(realm & 0xFF);
}

/** 0x10 CharacterSelectRequest; payload ignored (CharacterSelectRequestHandler.cs:8-16). */
export function encodeCharacterSelectRequest(): Uint8Array {
    return Uint8Array.of(0);
}

/** 0xCB DuplicateNameCheck (DupNameCheckRequestHandler.cs, >=1126: ReadString(24)). */
export function encodeDupNameCheck(name: string): Uint8Array {
    return new PacketWriter().fixedString(name, 24).toBytes();
}

export interface CharacterCreateData {
    /** Slot 0..9 within the realm. */
    slot: number;
    name: string;
    realm: number;
    classId: number;
    raceId: number;
    /** 0 male, 1 female. */
    gender: number;
    model: number;
    /** STR, DEX, CON, QUI, INT, PIE, EMP, CHA (absolute values). */
    stats: [number, number, number, number, number, number, number, number];
    /** 1 = create, 2 = customize, 3 = delete. */
    operation?: number;
    /** Sets the face fields and takes over from `model`. Without it the face stays at zeros. */
    look?: Look;
}

/**
 * 0xFF CharacterCreateRequest, 1.126+ CreationCharacterData
 * (CharacterCreateRequestHandler.cs:263-326). Total = 1 + (4+name+1) + 100.
 * The three strings are consumed as Skip(5) each, so they are sent as 01 00 00 00 00.
 */
export function encodeCharacterCreateRequest(d: CharacterCreateData): Uint8Array {
    const w = new PacketWriter(160);
    w.u8((d.realm - 1) * 10 + d.slot); // server subtracts (Realm-1)*10
    w.intLePascal(d.name);
    w.u32le(0x18);
    const customize = d.operation === 2;
    // CustomMode: 0 keeps the zeros, 1 applies the face at creation, 2 in a customize, which also
    // ends the configuration (CustomisationStep 2, CharacterCreateRequestHandler.cs:814).
    w.u8(!d.look ? 0 : customize ? 2 : 1);
    const k = d.look;
    for (const v of [k?.eyeSize, k?.lipSize, k?.eyeColor, k?.hairColor, k?.faceType, k?.hairStyle]) w.u8(v ?? 0);
    w.fill(0, 3);
    w.u8(0); // mood
    w.fill(0, 9);
    w.u8(d.operation ?? 1);
    w.u8(customize ? 1 : 0); // customize type: 1 = face only, the stats stay
    w.fill(0, 2);
    for (let i = 0; i < 3; i++) w.u32le(1).u8(0); // location/class/race strings: Skip(5) each
    w.u8(d.classId);
    w.u8(d.realm);
    w.u8((d.raceId & 0x1F) | ((d.gender & 1) << 7));
    w.u16le(d.look?.model ?? d.model);
    for (const s of d.stats) w.u8(s);
    w.fill(0, 43);
    w.u8(d.stats[2]); // NewConstitution
    return w.toBytes();
}

/** 0xD4 WorldInitRequest: u8 charIndex = (realm-1)*10 + slot (WorldInitRequestHandler.cs:154-160). */
export function encodeWorldInitRequest(charIndex: number): Uint8Array {
    return Uint8Array.of(charIndex & 0xFF);
}

/** 0xBF GameOpenRequest: u8 udp flag, 0 for TCP-only (GameOpenRequestHandler.cs:6-20). */
export function encodeGameOpenRequest(udp = 0): Uint8Array {
    return Uint8Array.of(udp & 0xFF);
}

/** 0xE8 PlayerInitRequest; payload ignored (PlayerInitRequestHandler.cs:18). */
export function encodePlayerInitRequest(): Uint8Array {
    return Uint8Array.of(0);
}

/** 0xA3 PingRequest: 4 skipped bytes, u32BE timestamp (PingRequestHandler.cs:15-21). */
export function encodePing(timestamp: number): Uint8Array {
    return new PacketWriter(12).u32(0).u32(timestamp >>> 0).u32(0).toBytes();
}

// ── Movement ────────────────────────────────────────────────────────────────

export const StateFlags = {
    StrafeRight: 0x80,
    StrafeLeft: 0x40,
    StrafeFull: 0x20,
    Sitting: 0x10,
    Jumping: 0x08,
    Swimming: 0x04,
    /** SITTING|SWIMMING: lying dead. A real client's dead state, stripped from the living (PlayerPositionUpdateHandler.cs:640-643). */
    Dead: 0x14,
} as const;

export const ActionFlags = {
    Torch: 0x80,
    Teleport: 0x40,
    TargetInView: 0x30,
    GroundTargetInView: 0x08,
    PetInView: 0x04,
    Diving: 0x02,
    Wireframe: 0x01,
} as const;

export interface PositionUpdate {
    x: number;
    y: number;
    z: number;
    speed: number;
    zSpeed?: number;
    sessionId?: number;
    objectId?: number;
    zoneId: number;
    stateFlags?: number;
    /** Bit15 = on ground. Default 0x8000. */
    fallingDamage?: number;
    heading: number;
    actionFlags?: number;
    healthPercent?: number;
}

/** 0xA9 PositionUpdate, 40-byte 1.127 layout (PlayerPositionUpdateHandler.cs:58-82). */
export function encodePositionUpdate(p: PositionUpdate): Uint8Array {
    return new PacketWriter(40)
        .f32le(p.x)
        .f32le(p.y)
        .f32le(p.z)
        .f32le(p.speed)
        .f32le(p.zSpeed ?? 0)
        .u16(p.sessionId ?? 0)
        .u16(p.objectId ?? 0)
        .u16(p.zoneId)
        .u8(p.stateFlags ?? 0)
        .u8(0)
        .u16(p.fallingDamage ?? 0x8000)
        .u16(p.heading & 0xFFF)
        .u8(p.actionFlags ?? 0)
        .fill(0, 2)
        .u8(p.healthPercent ?? 100)
        .fill(0, 4)
        .toBytes();
}

/** 0xBA PlayerHeadingUpdate, 1.127 (PlayerHeadingUpdateHandler.cs:10-22). Does not refresh link-death. */
export function encodeHeadingUpdate(sessionId: number, heading: number, actionFlags = 0, stateFlags = 0): Uint8Array {
    return new PacketWriter(10)
        .u16(sessionId)
        .u16(0)
        .u16(heading & 0xFFF)
        .u8(0)
        .u8(actionFlags)
        .u8(0)
        .u8((stateFlags >> 2) & 0xFF)
        .toBytes();
}

/** 18-byte position prefix shared by 0xBB / 0x71 / 0x7D (>=1124). */
export interface PositionPrefix {
    x: number;
    y: number;
    z: number;
    speed: number;
    heading: number;
}

function writePrefix(w: PacketWriter, p: PositionPrefix): void {
    w.f32le(p.x).f32le(p.y).f32le(p.z).f32le(p.speed).u16(p.heading & 0xFFF);
}

/** flagSpeedData bits: 0xA000 target in view, 0x1000 GT in view, 0x4000 strafing. */
export const FLAG_TARGET_IN_VIEW = 0x2000;
export const FLAG_GT_IN_VIEW = 0x1000;

/** 0xBB UseSkill: prefix, u16 flagSpeedData, u8 index, u8 type (UseSkillHandler.cs:14-30). */
export function encodeUseSkill(p: PositionPrefix, index: number, type = 1, flagSpeedData = FLAG_TARGET_IN_VIEW): Uint8Array {
    const w = new PacketWriter(22);
    writePrefix(w, p);
    return w.u16(flagSpeedData).u8(index).u8(type).toBytes();
}

/** 0x7D UseSpell: prefix, u16 flag, u8 spellLevel, u8 lineIndex, 2 trailing (UseSpellHandler.cs:24-40). */
export function encodeUseSpell(p: PositionPrefix, spellLevel: number, lineIndex: number, flagSpeedData = FLAG_TARGET_IN_VIEW): Uint8Array {
    const w = new PacketWriter(24);
    writePrefix(w, p);
    return w.u16(flagSpeedData).u8(spellLevel).u8(lineIndex).u16(0).toBytes();
}

/** 0x71 UseSlot: prefix, u16 flag, u8 slot, u8 type (UseSlotHandler.cs:14-40). */
export function encodeUseSlot(p: PositionPrefix, slot: number, type = 0, flagSpeedData = FLAG_TARGET_IN_VIEW): Uint8Array {
    const w = new PacketWriter(22);
    writePrefix(w, p);
    return w.u16(flagSpeedData).u8(slot).u8(type).toBytes();
}

// ── Targeting / interaction / combat ────────────────────────────────────────

export const TARGET_IN_VIEW_FLAGS = 0x6000;

/** 0xB0 PlayerTarget: u16 oid, u16 flags (PlayerTargetHandler.cs:8-18). */
export function encodeTarget(objectId: number, flags = TARGET_IN_VIEW_FLAGS): Uint8Array {
    return new PacketWriter(4).u16(objectId).u16(flags).toBytes();
}

/** 0x7A ObjectInteractRequest: u32 x, u32 y, u16 session, u16 oid (ObjectInteractRequestHandler.cs:9-12). */
export function encodeInteract(x: number, y: number, sessionId: number, objectId: number): Uint8Array {
    return new PacketWriter(12).u32(Math.max(0, Math.round(x))).u32(Math.max(0, Math.round(y))).u16(sessionId).u16(objectId).toBytes();
}

/** 0xB5 PickUpRequest: fields ignored, uses server TargetObject (PlayerPickUpRequestHandler.cs:12-29). */
export function encodePickup(x: number, y: number, sessionId: number, objectId: number): Uint8Array {
    return new PacketWriter(12).u32(Math.max(0, Math.round(x))).u32(Math.max(0, Math.round(y))).u16(sessionId).u16(objectId).toBytes();
}

/** 0x74 PlayerAttackRequest: u8 start, u8 clientAuto (0 = user action) (PlayerAttackRequestHandler.cs:8-9). */
export function encodeAttack(start: boolean): Uint8Array {
    return Uint8Array.of(start ? 1 : 0, 0);
}

/** 0xEC PlayerGroundTarget: u32 x, y, z, u16 flag (0x0100 in view), 2 unused (PlayerGroundTargetHandler.cs:12-17). */
export function encodeGroundTarget(x: number, y: number, z: number, inView = true): Uint8Array {
    return new PacketWriter(16)
        .u32(Math.max(0, Math.round(x)))
        .u32(Math.max(0, Math.round(y)))
        .u32(Math.max(0, Math.round(z)))
        .u16(inView ? 0x0100 : 0)
        .u16(0)
        .toBytes();
}

/** 0x76 RemoveConcentrationEffect: u8 index in our concentration list (RemoveConcentrationEffectHandler.cs:12). */
export function encodeRemoveConcentrationEffect(index: number): Uint8Array {
    return Uint8Array.of(index & 0xff);
}

/** 0x90 PlayerRegionChangeRequest: u16 LE zone point id for >=1126 (RegionChangeRequestHandler.cs:23). */
export function encodeRegionChangeRequest(zonePointId: number): Uint8Array {
    return new PacketWriter(2).u16le(zonePointId).toBytes();
}

/** 0xC7 PlayerSitRequest: u8 status (PlayerSitRequest.cs:8). */
export function encodeSit(sit: boolean): Uint8Array {
    return Uint8Array.of(sit ? 1 : 0);
}

/** 0xD0 CheckLos response: u16 checker, u16 target, u16 0x0100 = clear (CheckLosResponseHandler.cs:8-10). */
export function encodeLosResponse(checkerId: number, targetId: number, clear = true): Uint8Array {
    return new PacketWriter(8).u16(checkerId).u16(targetId).u16(clear ? 0x0100 : 0).u16(0).toBytes();
}

/** 0xD5 CreatePlayerRequest: u16 LE sessionId for >=1126 (PlayerCreationRequestHandler.cs:13). */
export function encodeCreatePlayerRequest(sessionId: number): Uint8Array {
    return new PacketWriter(2).u16le(sessionId).toBytes();
}

/** 0xBE CreateObjectRequest: u16 LE oid for >=1126 (CreateObjectRequestHandler.cs:18-28). */
export function encodeCreateObjectRequest(objectId: number): Uint8Array {
    return new PacketWriter(2).u16le(objectId).toBytes();
}

// ── Items / merchants / trainers ────────────────────────────────────────────

/** 0xDD PlayerMoveItem: u16 (ignored), u16 toSlot, u16 fromSlot, u16 count (PlayerMoveItemRequestHandler.cs:15-18). */
export function encodeMoveItem(toSlot: number, fromSlot: number, count = 0, objectId = 0): Uint8Array {
    return new PacketWriter(8).u16(objectId).u16(toSlot).u16(fromSlot).u16(count).toBytes();
}

/**
 * 0xEB ModifyTrade: 0 closes the window, 2 accepts it (PlayerModifyTradeHandler.cs:11-14). The handler reads
 * only 4 bytes for these; 26 is the full layout it defines for code 1. Code 1 is left out on purpose: it
 * replaces our whole side (:28-41, :50) and a duplicate slot aborts the commit (PlayerTradeWindow.cs:541-565).
 */
export function encodeModifyTrade(code: 0 | 2): Uint8Array {
    return new PacketWriter(26).u8(code).fill(0, 25).toBytes();
}

/**
 * 0xD8 DetailRequest, delve (DetailDisplayHandler.cs:28-30): u16 objectType, u32 extraId, u16 objectId,
 * big-endian (PacketIn.cs:34,58). Type 1 is an inventory item with objectId = its slot (:63-69).
 */
export function encodeDetailRequest(objectType: number, extraId: number, objectId: number): Uint8Array {
    return new PacketWriter(8).u16(objectType).u32(extraId).u16(objectId).toBytes();
}

/** 0x80 DestroyItemRequest: 4 skipped, u16 slot (DestroyItemRequestHandler.cs:10-11). */
export function encodeDestroyItem(slot: number): Uint8Array {
    return new PacketWriter(6).u32(0).u16(slot).toBytes();
}

/** 0x78 BuyRequest: u32 x, u32 y, u16 id, u16 itemSlot (page*30+slot), u8 count, u8 menuId (PlayerBuyRequestHandler.cs:13-18). */
export function encodeBuy(x: number, y: number, itemSlot: number, count: number, menuId = 0, id = 0): Uint8Array {
    return new PacketWriter(14)
        .u32(Math.max(0, Math.round(x)))
        .u32(Math.max(0, Math.round(y)))
        .u16(id)
        .u16(itemSlot)
        .u8(count)
        .u8(menuId)
        .toBytes();
}

/** 0x79 SellRequest: u32 x, u32 y, u16 id, u16 invSlot (PlayerSellRequestHandler.cs:12-15). */
export function encodeSell(x: number, y: number, slot: number, id = 0): Uint8Array {
    return new PacketWriter(12).u32(Math.max(0, Math.round(x))).u32(Math.max(0, Math.round(y))).u16(id).u16(slot).toBytes();
}

/** 0x7B TrainWindowHandler: no payload (PlayerTrainRequestHandler.cs:233-243). */
export function encodeTrainWindowRequest(): Uint8Array {
    return Uint8Array.of(0);
}

/**
 * 0x53 TrainHandler, fixed 264 bytes (PlayerTrainRequestHandler.cs:84-145):
 * u32BE code[8] (0xFFFFFFFF terminates), u32BE level[n] per distinct code, then at +64 u32BE ra[50].
 * `specIndex` indexes GetSpecList().Where(Trainable) (the 0x7B spec order); `level` is the target level.
 */
export function encodeTrain(entries: Array<{ specIndex: number; level: number }>): Uint8Array {
    const w = new PacketWriter(264);
    const list = entries.slice(0, 7);
    for (let i = 0; i < 8; i++) w.u32(i < list.length ? list[i]!.specIndex : 0xFFFFFFFF);
    for (let i = 0; i < 8; i++) w.u32(i < list.length ? list[i]!.level : 0);
    w.fill(0, 200);
    return w.toBytes();
}

// ── UI / chat ───────────────────────────────────────────────────────────────

/** 0x82 DialogResponse: u16 d1, d2, d3, u8 code, u8 response (DialogResponseHandler.cs:15-19). */
export function encodeDialogResponse(d1: number, d2: number, d3: number, code: number, accept: boolean): Uint8Array {
    return new PacketWriter(8).u16(d1).u16(d2).u16(d3).u8(code).u8(accept ? 1 : 0).toBytes();
}

/** 0xAF CommandHandler, 1.127: u8 skip, NUL-terminated command, ReadString(255) (PlayerCommandHandler.cs:10-15). */
export function encodeCommand(command: string): Uint8Array {
    const text = command.startsWith('/') ? '&' + command.slice(1) : command;
    const w = new PacketWriter(text.length + 2).u8(0);
    w.cString(text.slice(0, 254));
    return w.toBytes();
}
