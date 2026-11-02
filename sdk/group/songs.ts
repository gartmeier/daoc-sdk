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

import type { MemberReport } from './types';

export type SongKind = 'speed' | 'endurance' | 'power' | 'health' | 'damage';

/** The kind of a friendly song (a pulsing Group/Self spell), or null for anything else. */
export function songKind(s: { type: string; target: string; pulse: boolean }): SongKind | null {
    if (!s.pulse || (s.target !== 'Group' && s.target !== 'Self')) return null;
    switch (s.type) {
        case 'SpeedEnhancement': return 'speed';
        case 'EnduranceRegenBuff': return 'endurance';
        case 'PowerRegenBuff': return 'power';
        case 'HealthRegenBuff': return 'health';
        case 'DamageAdd': return 'damage';
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
}

export const SONG_SETTINGS: SongSettings = { powerBelow: 70, healthBelow: 80, holdMs: 30_000 };

const usesPower = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc;

/** Song kinds for this phase and the group's state, best first. */
export function wantedSongs(phase: string, members: MemberReport[], s: SongSettings = SONG_SETTINGS): SongKind[] {
    if (phase === 'travel' || phase === 'retreat') return ['speed', 'endurance'];
    if (phase === 'engage' || phase === 'pull') return ['endurance', 'damage'];
    const alive = members.filter(m => !m.isDead);
    const out: SongKind[] = [];
    if (alive.some(m => usesPower(m) && m.mana < s.powerBelow)) out.push('power');
    if (alive.some(m => m.hp < s.healthBelow)) out.push('health');
    return [...out, 'endurance'];
}

/** The song to play: the first wanted kind we have, or null when we have none of them. */
export function chooseSong(have: SongKind[], phase: string, members: MemberReport[], s: SongSettings = SONG_SETTINGS): SongKind | null {
    return wantedSongs(phase, members, s).find(k => have.includes(k)) ?? null;
}
