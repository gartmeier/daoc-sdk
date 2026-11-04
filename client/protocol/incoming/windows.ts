// Merchant, trainer, trade and group windows.

import { PacketReader } from '../buffer';
import { readItemData, type ItemData } from './player';

/** 0x17 MerchantWindow, 1125d+ (PacketLib1125.cs:607-725). One packet per non-empty page. */
export interface MerchantPage {
    windowType: number;
    page: number;
    items: Array<{
        index: number;
        level: number;
        value1: number;
        spdAbs: number;
        hand: number;
        objectType: number;
        damageType: number;
        usable: boolean;
        value2: number;
        price: number;
        model: number;
        name: string;
    }>;
}

export function decodeMerchantWindow(p: Uint8Array): MerchantPage {
    const r = new PacketReader(p);
    const count = r.u8();
    const windowType = r.u8();
    const page = r.u8();
    const items: MerchantPage['items'] = [];
    if (count === 0) return { windowType, page, items };
    for (let i = 0; i < count; i++) {
        const index = r.u8();
        const level = r.u8();
        const value1 = r.u8();
        const spdAbs = r.u8();
        const hand = r.u8() >> 6;
        const typeByte = r.u8();
        const objectType = typeByte & 0x3F;
        const damageType = typeByte >> 6;
        const usable = r.u8() !== 0;
        const value2 = r.u16le();
        const price = r.u32le();
        const model = r.u16le();
        const name = r.intLePascal();
        items.push({ index, level, value1, spdAbs, hand, objectType, damageType, usable, value2, price, model, name });
    }
    return { windowType, page, items };
}

/** 0x7B TrainerWindow (PacketLib1105.cs:29-200). Only the spec list (code 0) is decoded. */
export type TrainerPacket =
    | { code: 0; specPoints: number; specs: Array<{ index: number; level: number; nextLevel: number; name: string }> }
    | { code: number; specPoints: number };

export function decodeTrainerWindow(p: Uint8Array): TrainerPacket {
    const r = new PacketReader(p);
    const count = r.u8();
    const specPoints = r.u8();
    const code = r.u8();
    r.u8();
    if (code !== 0) return { code, specPoints };
    const specs: Array<{ index: number; level: number; nextLevel: number; name: string }> = [];
    for (let i = 0; i < count; i++) {
        const index = r.u8();
        const level = r.u8();
        const nextLevel = r.u8();
        const name = r.pascal();
        specs.push({ index, level, nextLevel, name });
    }
    return { code: 0, specPoints, specs };
}

type Coins = { mithril: number; platinum: number; gold: number; silver: number; copper: number };

export interface TradePacket {
    mySlots: number[];
    myMoney: Coins;
    partnerMoney: Coins;
    /** slot is the partner's slot. */
    partnerItems: Array<{ slot: number; item: ItemData }>;
    /** Null for a self-craft window. */
    partnerName: string | null;
}

/**
 * 0xEA TradeWindow (PacketLib1109.cs:23-82). Null for the 40-zero-byte close (PacketLib168.cs:1979-1986):
 * an open is at least 41, the title's length byte being the 41st.
 */
export function decodeTradeWindow(p: Uint8Array): TradePacket | null {
    if (p.length <= 40) return null;
    const r = new PacketReader(p);
    const mySlots = [...r.bytes(10)].filter(s => s !== 0);
    const coins = (): Coins => {
        r.skip(2);
        return { mithril: r.u16(), platinum: r.u16(), gold: r.u16(), silver: r.u16(), copper: r.u16() };
    };
    const myMoney = coins();
    const partnerMoney = coins();
    r.skip(2);
    const count = r.u8();
    r.skip(3); // 0x01, repair, combine
    const partnerItems: TradePacket['partnerItems'] = [];
    for (let i = 0; i < count; i++) {
        const slot = r.u8();
        partnerItems.push({ slot, item: readItemData(r) });
    }
    return { mySlots, myMoney, partnerMoney, partnerItems, partnerName: /^Trading with (.+)$/.exec(r.pascal())?.[1] ?? null };
}

/** action: 2 open, 1 update, 0 close. aggro: 1 aggressive, 2 defensive, 3 passive. walk: 1 follow, 2 stay, 3 go to target, 4 come here. */
export interface PetWindowPacket {
    objectId: number;
    action: number;
    aggro: number;
    walk: number;
    icons: number[];
}

/**
 * 0x88 PetWindow (PacketLib181.cs:102-176; no later lib overrides it): u16 pet, 2 x 0, u8 action, u8 aggro, u8 walk,
 * u8 0, u8 n, n x u16 icon. A close is sent as (null, Close, 0, 0), and enum 0 is Aggressive and Follow
 * (CharacterClassBase.cs:305, IControlledBrain.cs:8-30): it names no pet and its aggro and walk read 1, 1. Never read them from one.
 */
export function decodePetWindow(p: Uint8Array): PetWindowPacket {
    const r = new PacketReader(p);
    const objectId = r.u16();
    r.skip(2);
    const action = r.u8();
    const aggro = r.u8();
    const walk = r.u8();
    r.skip(1);
    const count = r.u8();
    const icons: number[] = [];
    for (let i = 0; i < count; i++) icons.push(r.u16());
    return { objectId, action, aggro, walk, icons };
}

/** 0x70 GroupMemberUpdate (PacketLib168.cs:1644-1690, writers PacketLib1125.cs:418-480): records ending in 0x00. */
export type GroupRecord =
    | { kind: 'status'; groupIndex: number; healthPercent: number; manaPercent: number; endurancePercent: number; status: number }
    | { kind: 'icons'; groupIndex: number; icons: number[] };

export function decodeGroupMemberUpdate(p: Uint8Array): { records: GroupRecord[] } {
    const r = new PacketReader(p);
    const records: GroupRecord[] = [];
    while (r.remaining > 0) {
        const head = r.u8();
        if (head === 0) break;
        if ((head & 0x80) !== 0) {
            const n = r.u8();
            const icons: number[] = [];
            for (let i = 0; i < n; i++) {
                r.u8();
                icons.push(r.u16());
            }
            records.push({ kind: 'icons', groupIndex: head & 0x1F, icons });
        } else if ((head & 0x20) !== 0) {
            records.push({
                kind: 'status',
                groupIndex: head & 0x1F,
                healthPercent: r.u8(),
                manaPercent: r.u8(),
                endurancePercent: r.u8(),
                status: r.u8(),
            });
        } else {
            break; // unknown record type
        }
    }
    return { records };
}
