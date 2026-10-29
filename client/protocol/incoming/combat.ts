// Combat, spell and effect packets.

import type { CombatResult } from '../../../sdk/types';
import { PacketReader } from '../buffer';

/** 0xBC CombatAnimation (PacketLib186.cs:54-100), 14 bytes. */
export interface CombatAnimation {
    attackerId: number;
    defenderId: number;
    weaponModel: number;
    shieldModel: number;
    style: number;
    stance: number;
    resultCode: number;
    result: CombatResult;
    targetHealthPercent: number;
}

/** Result byte values (ECS-Components/Actions/WeaponAction.cs:280-330). */
export function combatResultName(code: number): CombatResult {
    switch (code) {
        case 0: return 'miss';
        case 1: return 'parry';
        case 2: return 'block';
        case 3: return 'evade';
        case 4: return 'fumble';
        case 10: return 'hit';
        case 11: return 'styledHit';
        default: return 'other';
    }
}

export function decodeCombatAnimation(p: Uint8Array): CombatAnimation {
    const r = new PacketReader(p);
    const attackerId = r.u16();
    const defenderId = r.u16();
    const weaponModel = r.u16();
    const shieldModel = r.u16();
    const style = r.u16le();
    const stance = r.u8();
    const resultCode = r.u8();
    const targetHealthPercent = r.remaining > 0 ? r.u8() : 0;
    return { attackerId, defenderId, weaponModel, shieldModel, style, stance, resultCode, result: combatResultName(resultCode), targetHealthPercent };
}

/** 0x72 SpellCastAnimation (PacketLib168.cs:1276-1286): u16 caster, u16 effect, u16 castTime (100 ms units), u16 0. */
export function decodeSpellCastAnimation(p: Uint8Array): { casterId: number; effect: number; castTimeMs: number } {
    const r = new PacketReader(p);
    return { casterId: r.u16(), effect: r.u16(), castTimeMs: r.u16() * 100 };
}

/** 0x73 InterruptSpellCast (PacketLib168.cs:2654): u16 oid, u16 1. */
export function decodeInterrupt(p: Uint8Array): { objectId: number } {
    return { objectId: new PacketReader(p).u16() };
}

/** 0x1B SpellEffectAnimation (PacketLib174.cs:410-470): u16 caster, u16 effect, u16 target, u16 boltTime, u8 noSound, u8 success. */
export function decodeSpellEffect(p: Uint8Array): { casterId: number; effect: number; targetId: number; boltTime: number; success: number } {
    const r = new PacketReader(p);
    const casterId = r.u16();
    const effect = r.u16();
    const targetId = r.u16();
    const boltTime = r.u16();
    r.u8();
    const success = r.remaining > 0 ? r.u8() : 0;
    return { casterId, effect, targetId, boltTime, success };
}

/** 0xAE PlayerDeath (PacketLib168.cs:1988-1999): u16 victim, u16 killer, 4×0. */
export function decodePlayerDeath(p: Uint8Array): { victimId: number; killerId: number } {
    const r = new PacketReader(p);
    return { victimId: r.u16(), killerId: r.u16() };
}

/** 0x89 PlayerRevive (PacketLib168.cs:2002-2010): u16 oid, u16 0. */
export function decodeRevive(p: Uint8Array): { objectId: number } {
    return { objectId: new PacketReader(p).u16() };
}

/** 0x74 AttackMode (PacketLib168.cs:371-383): u8 on, 3×0. */
export function decodeAttackMode(p: Uint8Array): { on: boolean } {
    return { on: (p[0] ?? 0) !== 0 };
}

/** 0xF6 ChangeTarget (PacketLib168.cs:2924-2932): u16 oid, u16 0. */
export function decodeChangeTarget(p: Uint8Array): { objectId: number } {
    return { objectId: new PacketReader(p).u16() };
}

/** 0xEC ChangeGroundTarget (PacketLib168.cs:2934): u32 x, y, z. */
export function decodeChangeGroundTarget(p: Uint8Array): { x: number; y: number; z: number } {
    const r = new PacketReader(p);
    return { x: r.u32(), y: r.u32(), z: r.u32() };
}

/** 0xD6 DisableSkills (PacketLib168.cs:2664-2760). */
export type DisableSkills =
    | { kind: 'skills'; entries: Array<{ skillIndex: number; seconds: number }> }
    | { kind: 'spells'; seconds: number; entries: Array<{ lineIndex: number; spellIndex: number }> }
    | { kind: 'other' };

export function decodeDisableSkills(p: Uint8Array): DisableSkills {
    const r = new PacketReader(p);
    const duration = r.u16();
    const count = r.u8();
    const code = r.u8();
    if (code === 1) {
        const entries: Array<{ skillIndex: number; seconds: number }> = [];
        for (let i = 0; i < count; i++) entries.push({ skillIndex: r.u16(), seconds: r.u16() });
        return { kind: 'skills', entries };
    }
    if (code === 2) {
        const entries: Array<{ lineIndex: number; spellIndex: number }> = [];
        for (let i = 0; i < count; i++) entries.push({ lineIndex: r.u8(), spellIndex: r.u8() });
        return { kind: 'spells', seconds: duration, entries };
    }
    return { kind: 'other' };
}

/** 0x7F UpdateIcons, delta packet (PacketLib1110.cs:51-140). A removed slot is index + 10 zero bytes. */
export interface IconEntry {
    index: number;
    iconSource: number;
    immune: boolean;
    icon: number;
    remainingSeconds: number;
    tooltipId: number;
    isNegative: boolean;
    name: string;
    removed: boolean;
}

export function decodeUpdateIcons(p: Uint8Array): { entries: IconEntry[] } {
    const r = new PacketReader(p);
    const count = r.u8();
    r.skip(3);
    const entries: IconEntry[] = [];
    for (let i = 0; i < count && r.remaining > 0; i++) {
        const index = r.u8();
        const iconSource = r.u8();
        const immune = r.u8() !== 0;
        const icon = r.u16();
        const remainingSeconds = r.u16();
        const tooltipId = r.u16();
        const isNegative = r.u8() !== 0;
        const name = r.pascal();
        entries.push({ index, iconSource, immune, icon, remainingSeconds, tooltipId, isNegative, name, removed: icon === 0 && name === '' });
    }
    return { entries };
}

/** 0x75 ConcentrationList (PacketLib191.cs:83-125). */
export interface ConcentrationEntry {
    index: number;
    concentration: number;
    icon: number;
    name: string;
    ownerName: string;
}

export function decodeConcentrationList(p: Uint8Array): { entries: ConcentrationEntry[] } {
    const r = new PacketReader(p);
    const count = r.u8();
    r.skip(3);
    const entries: ConcentrationEntry[] = [];
    for (let i = 0; i < count; i++) {
        const index = r.u8();
        r.u8();
        const concentration = r.u8();
        const icon = r.u16();
        const name = r.pascal();
        const ownerName = r.pascal();
        entries.push({ index, concentration, icon, name, ownerName });
    }
    return { entries };
}
