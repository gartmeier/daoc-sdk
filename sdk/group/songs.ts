// Which song a Bard (or a Minstrel/Skald) plays. The server lets one song play
// at a time: a new song ends the running one, and casting the running song again
// stops it ("You stop playing your song.", SpellHandler.cs:501 and
// EffectListComponent.CancelIncompatiblePulseEffects). So this picks one song for
// the moment instead of keeping several up like buffs.
//
// The choice (from a Hibernia player, session 2 of groups/hibernia):
//  - travelling: speed;
//  - pulling and fighting: endurance, for the tank's styles, or else added damage
//    (a Skald's Battlesongs have no endurance song);
//  - between fights: power when a caster runs low, health when someone is hurt,
//    else endurance.
//
// A Paladin's chants follow the same rule (one pulse at a time, CancelIncompatiblePulseEffects), and
// have two kinds of their own, for a fight only: armor (Crusader's Defense and its ranks) and
// combatHeal (the Refreshments), which heals nobody out of combat (CombatHealSpellHandler.StartSpell).

import { ObjectType, type InventoryItem } from '../types';
import type { MemberReport } from './types';

export type SongKind = 'speed' | 'endurance' | 'power' | 'health' | 'damage' | 'armor' | 'combatHeal';

/** The kind of a friendly song (a pulsing Group/Self spell), or null for anything else. */
export function songKind(s: { type: string; target: string; pulse: boolean }): SongKind | null {
    if (!s.pulse || (s.target !== 'Group' && s.target !== 'Self')) return null;
    switch (s.type) {
        case 'SpeedEnhancement': return 'speed';
        case 'EnduranceRegenBuff': return 'endurance';
        case 'PowerRegenBuff': return 'power';
        case 'HealthRegenBuff': return 'health';
        case 'DamageAdd': return 'damage';
        case 'SpecArmorFactorBuff': return 'armor';
        case 'CombatHeal': return 'combatHeal';
    }
    return null;
}

export interface SongSettings {
    /** Between fights, play power when a living caster is below this power %. */
    powerBelow: number;
    /** ... else health when a living member is below this health %. */
    healthBelow: number;
    /** Keep a song we started at least this long before switching (except into a fight). */
    holdMs: number;
    /** In a fight, endurance goes before armor when the singer is below this % (styles stop silently below 15 %). */
    enduranceBelow: number;
    /**
     * In a fight, no song change while the singer has a crowd-control assignment open (Orders.cc): the mezz goes first.
     * User, live 2026-11-09: the Bard changed to the fight song as the raid opened, ahead of his opening mezz, and who
     * mezzes the other group first decides most group fights. Off until pair rounds have it (--songs.ccFirst=true).
     */
    ccFirst?: boolean;
}

export const SONG_SETTINGS: SongSettings = { powerBelow: 70, healthBelow: 80, holdMs: 30_000, enduranceBelow: 30, ccFirst: false };

/** A caster: by its spells, an observed member (no capabilities: a human) by its role. */
const usesPower = (m: MemberReport) => (m.observed ? m.role !== 'tank' && m.role !== 'melee' : m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc);
/** In a fight a living caster below this power % asks for the power song ahead of endurance: casting drains it all fight. */
export const FIGHT_POWER_BELOW = 95;

/** Song kinds for this phase and the group's state, best first. */
export function wantedSongs(phase: string, members: MemberReport[], s: SongSettings = SONG_SETTINGS, endurance = 100): SongKind[] {
    // Out of a fight, an endurance song at full endurance only costs power: a Paladin's Chant of Persistence pulsed through
    // rest and travel at ~7 power a pulse, more than his regen (arena round 26, 2026-11-10: 69 waits for Galahad's power).
    const tired: SongKind[] = endurance < ENDURANCE_REST_FULL ? ['endurance'] : [];
    if (phase === 'retreat') return ['speed', 'endurance'];
    if (phase === 'travel') return ['speed', ...tired];
    const alive = members.filter(m => !m.isDead);
    if (phase === 'engage' || phase === 'pull') {
        // Endurance first only when the singer or a fighter runs low; else power while a caster spends it (the user, playing
        // Niamh: "need mana song, endu is full": Rhythm of Nature at 100 % endurance every fight, 2026-11-13).
        const tiredFight = endurance < s.enduranceBelow || alive.some(m => (m.role === 'tank' || m.role === 'melee') && m.endurance < s.enduranceBelow);
        const power: SongKind[] = alive.some(m => usesPower(m) && m.mana < FIGHT_POWER_BELOW) ? ['power'] : [];
        return tiredFight ? ['endurance', 'armor', ...power, 'combatHeal', 'damage'] : ['armor', ...power, 'endurance', 'combatHeal', 'damage'];
    }
    const out: SongKind[] = [];
    if (alive.some(m => usesPower(m) && m.mana < s.powerBelow)) out.push('power');
    if (alive.some(m => m.hp < s.healthBelow)) out.push('health');
    return [...out, ...tired];
}

/** Out of a fight (not a retreat), no endurance song for a singer at least this full. */
export const ENDURANCE_REST_FULL = 90;

/** The song to play: the first wanted kind we have, or null when we have none of them. */
export function chooseSong(have: SongKind[], phase: string, members: MemberReport[], s: SongSettings = SONG_SETTINGS, endurance = 100): SongKind | null {
    return wantedSongs(phase, members, s, endurance).find(k => have.includes(k)) ?? null;
}

/**
 * A twist: instant songs in turn during a fight, so several effects stay up at once. A new song ends the running
 * pulse, but what the old one put on the group runs out by itself (learnings/classes/paladin.md for what it costs and gives).
 */
export interface TwistSettings {
    /** The kinds to keep up, first in the order on a tie. Endurance joins them, first of all, while the singer is below songs.enduranceBelow. */
    order: SongKind[];
    /** Least time between two songs. */
    everyMs: number;
}

/** An instant song a twist can send: what a Spellbook pick holds. */
export interface TwistSong { kind: SongKind; castTime: number; frequency: number; spell: { name: string; cooldownRemaining: number } }

/**
 * The song to send now, or null to leave the running one. Never the running one: sending it again stops it. A song is due
 * once its last effect is near its end (its pulse time, less `marginMs`) and its recast is over; of those, the longest unsent.
 */
export function nextTwist<T extends TwistSong>(have: T[], running: string | null, sentAt: ReadonlyMap<string, number>, now: number, order: SongKind[], lowEndurance = false, marginMs = 1500): T | null {
    const kinds = lowEndurance ? ['endurance' as const, ...order.filter(k => k !== 'endurance')] : order;
    const due = kinds.flatMap(k => have.filter(s => s.kind === k && s.castTime === 0 && s.spell.name !== running && s.spell.cooldownRemaining <= 0
        && now - (sentAt.get(s.spell.name) ?? 0) >= s.frequency * 100 - marginMs));
    if (lowEndurance && due[0]?.kind === 'endurance') return due[0];
    return due.reduce<T | null>((best, s) => (!best || (sentAt.get(s.spell.name) ?? 0) < (sentAt.get(best.spell.name) ?? 0) ? s : best), null);
}

/**
 * The Paladin's twist, as measured at Chants 24: added damage and the group heal, one after each pulse. Waiting for the pulse keeps
 * a chant up for 12 s on one cast, and each cast costs 5 endurance (SpellHandler.CalculateEnduranceCost).
 */
export const CHANT_TWIST: TwistSettings = { order: ['damage', 'combatHeal'], everyMs: 6100 };

/** A hand slot (10 right, 11 left, 12 two-hand, 13 ranged) and the backpack (40-79). */
const HAND_SLOTS = [10, 11, 12, 13];
const inBackpack = (i: Pick<InventoryItem, 'slot'>) => i.slot >= 40 && i.slot <= 79;

/**
 * The instrument to bring out after "You are not wielding the right type of instrument!": one worn in a hand slot (put
 * away by a weapon: taking it off and on again brings it out, GamePlayerInventory.cs:547-560), else one in the backpack
 * (put on where the server takes it). Any instrument plays any song (SpellHandler.cs CheckInstrument). Null with none.
 * Fiacra sang no song in any run: her only instrument, an Arcane Flute drop, sat in the backpack (S5, 2026-11-13).
 */
export function instrumentToBringOut(equipment: readonly Pick<InventoryItem, 'slot' | 'name' | 'objectType' | 'level'>[], inventory: readonly Pick<InventoryItem, 'slot' | 'name' | 'objectType' | 'level'>[]): { item: Pick<InventoryItem, 'slot' | 'name' | 'objectType' | 'level'>; worn: boolean } | null {
    const worn = equipment.find(i => i.objectType === ObjectType.Instrument && HAND_SLOTS.includes(i.slot));
    if (worn) return { item: worn, worn: true };
    const bag = inventory.filter(i => i.objectType === ObjectType.Instrument && inBackpack(i)).sort((a, b) => b.level - a.level)[0];
    return bag ? { item: bag, worn: false } : null;
}
