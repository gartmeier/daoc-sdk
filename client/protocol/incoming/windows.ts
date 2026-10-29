// Merchant, trainer and group windows.

import { PacketReader } from '../buffer';

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
        const objectType = r.u8() & 0x3F;
        const usable = r.u8() !== 0;
        const value2 = r.u16le();
        const price = r.u32le();
        const model = r.u16le();
        const name = r.intLePascal();
        items.push({ index, level, value1, spdAbs, hand, objectType, usable, value2, price, model, name });
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
