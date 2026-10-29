// Chat and UI text packets.

import type { ChatType } from '../../../sdk/types';
import { PacketReader } from '../buffer';

/** 0xAF Message, 1.127 (PacketLib1127.cs:39-58): u8 eChatType, optional "@@" / "##", C string. */
export interface ChatMessage {
    rawType: number;
    /** '##' prefix = CL_PopupWindow. */
    popup: boolean;
    /** '@@' prefix = CT_Send (send reply marker). */
    sendReply: boolean;
    text: string;
}

export function decodeMessage(p: Uint8Array): ChatMessage {
    const r = new PacketReader(p);
    const rawType = r.u8();
    let popup = false;
    let sendReply = false;
    if (p.length >= 3 && p[1] === 0x40 && p[2] === 0x40) {
        sendReply = true;
        r.skip(2);
    } else if (p.length >= 3 && p[1] === 0x23 && p[2] === 0x23) {
        popup = true;
        r.skip(2);
    }
    return { rawType, popup, sendReply, text: r.cString() };
}

/** eChatType (IPacketLib.cs:265-317) → ChatType. */
export function chatTypeName(raw: number): ChatType {
    switch (raw) {
        case 0x01: return 'say';
        case 0x02: return 'send';
        case 0x03: return 'group';
        case 0x04: return 'guild';
        case 0x05: return 'broadcast';
        case 0x06: return 'emote';
        case 0x07: return 'help';
        case 0x08: return 'chat';
        case 0x09: return 'system'; // CT_Advise
        case 0x0A: return 'officer';
        case 0x0B: return 'alliance';
        case 0x10: return 'spell';
        case 0x11: return 'youHit';
        case 0x12: return 'system';
        case 0x13: return 'items';
        case 0x14: return 'merchant';
        case 0x15: return 'yourDeath';
        case 0x16: return 'otherDeath';
        case 0x17: return 'otherCombat';
        case 0x18: return 'system';
        case 0x19: return 'spellExpires';
        case 0x1A: return 'loot';
        case 0x1B: return 'resisted';
        case 0x1C: return 'important';
        case 0x1D: return 'damaged';
        case 0x1E: return 'action';
        case 0x1F: return 'spellPulse';
        case 0x23: return 'lfg';
        case 0x24: return 'trade';
        case 0xC8: case 0xC9: case 0xCA: case 0xCB: return 'screenCenter';
        default: return 'other';
    }
}

/**
 * Best-effort sender extraction for player/NPC speech:
 * `Bob says, "hi"` / `Bob sends, "hi"` / `[Party] Bob: "hi"` / `[Guild] Bob: "hi"`
 * (GameNPC.SayTo.Says = `{0} says, "{1}"`, language/EN/GameObjects/GameNPC.txt:20).
 */
export function parseSpeech(text: string): { sender: string; body: string } | null {
    let m = /^(.+?) (says|sends|shouts|yells|whispers|tells you|asks|replies|wishes), "([\s\S]*)"$/.exec(text);
    if (m) return { sender: m[1]!, body: m[3]! };
    m = /^\[[^\]]+\] (.+?): "([\s\S]*)"$/.exec(text);
    if (m) return { sender: m[1]!, body: m[2]! };
    return null;
}

/** [keyword] tokens in NPC dialog text. */
export function extractKeywords(text: string): string[] {
    const out: string[] = [];
    const re = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const k = m[1]!.trim();
        if (k && !out.includes(k)) out.push(k);
    }
    return out;
}

/** 0x81 Dialog (PacketLib168.cs:1484-1530): u8 0, u8 code, u16 d1..d4, u8 type, u8 autowrap, text, 0. */
export interface DialogPacket {
    code: number;
    data: [number, number, number, number];
    type: number;
    autoWrap: boolean;
    text: string;
}

export function decodeDialog(p: Uint8Array): DialogPacket {
    const r = new PacketReader(p);
    r.u8();
    const code = r.u8();
    const data: [number, number, number, number] = [r.u16(), r.u16(), r.u16(), r.u16()];
    const type = r.u8();
    const autoWrap = r.u8() !== 0;
    return { code, data, type, autoWrap, text: r.cString() };
}

/** 0xC4 DetailWindow / custom text window (PacketLib181.cs:40-60): u8 0, u8 0, pascal caption, (u8 line, pascal text)*, 0. */
export interface TextWindowPacket {
    caption: string;
    lines: string[];
}

export function decodeTextWindow(p: Uint8Array): TextWindowPacket {
    const r = new PacketReader(p);
    r.u8();
    r.u8();
    const caption = r.pascal();
    const byLine = new Map<number, string>();
    while (r.remaining > 0) {
        const lineNo = r.u8();
        if (lineNo === 0 || r.remaining === 0) break;
        const text = r.pascal();
        byLine.set(lineNo, (byLine.get(lineNo) ?? '') + text);
    }
    const lines = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    return { caption, lines };
}
