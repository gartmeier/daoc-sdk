// The standard Hero: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's list
// already taunts and swings a damage style; what is the class's own is its shield stuns. Against a player he
// stuns the focus once per immunity: the block reaction when the foe was just blocked (Incapacitate, 5 s), else
// Disable from the side (4 s) with Numb (2 s, any time) behind it, so the swing stuns wherever he stands. A stun
// stops a cast for certain (OnHardCCStart), where a plain hit past a cast's half way doesn't. Between stuns, the
// reacting tank's pick (reactions, then Fire Blade). learnings/classes/hero.md says why, and what was measured.

import { tank, type StylePick } from '../group/behaviors';
import type { Character } from '../group/character';
import { canWield, foeLastResult, lastStyleLanded } from '../group/styles';
import type { BotWorldState, Style } from '../types';
import { reactingStyle } from './reacting-tank';

/** The Hero's stun styles in reach at 24, each with its stun's length (StyleStun spells 20400, 20401, 20403, 20404). */
export const HERO_STUNS: Readonly<Record<string, number>> = { Incapacitate: 5000, 'Horizon Blade': 4000, Disable: 4000, Stun: 3000, Numb: 2000 };
/** After a stun a player takes no other for immunity_timer_flat_length, 60 s by default (CrowdControlECSEffect.cs:20), counted from its end. */
export const STUN_IMMUNE_MS = 60_000;

/** When our stun last landed on each target, by object id. One per bot: the kit is made once per character. */
export type StunLog = Map<number, number>;

/** Record our last swing if it landed a stun: "You perform your X perfectly!" on a styled hit (lastStyleLanded), at the target that swing hit. */
export function noteStun(log: StunLog, state: BotWorldState, me: number): void {
    const name = lastStyleLanded(state, me);
    if (!name || !(name in HERO_STUNS)) return;
    const swing = state.combatEvents.filter(e => e.kind === 'melee' && e.attackerObjectId === me).at(-1);
    if (!swing?.targetObjectId) return;
    const ends = swing.receivedAt + HERO_STUNS[name]!;
    if ((log.get(swing.targetObjectId) ?? 0) < ends) log.set(swing.targetObjectId, ends);
}

/** It can take a stun of ours now: none landed, or that one's immunity is over. */
export const stunnable = (log: StunLog, target: number, now: number) => now >= (log.get(target) ?? -Infinity) + STUN_IMMUNE_MS;

/**
 * The stun queue for the next swing, or null to leave it to the damage pick. A block reaction is earned only while the
 * foe hasn't swung again by our swing (StyleProcessor Defensive: the target's last attack, on us, blocked), so a stun
 * that always fires sits behind it. Endurance first: a stun that can't be paid for is no stun.
 */
export function stunQueue(styles: readonly Style[], equipment: BotWorldState['equipment'], foeDid: string | null, endurancePercent: number): string[] | null {
    const have = (name: string) => styles.find(s => s.name === name && s.details && canWield(s, equipment));
    const affordable = (name: string) => { const s = have(name); return s && endurancePercent >= s.details!.fatigue ? s.name : null; };
    const sure = affordable('Disable') ? ['Disable', ...(affordable('Numb') ? ['Numb'] : [])] : affordable('Numb') ? ['Numb'] : [];
    if (foeDid === 'block') {
        const reaction = affordable('Incapacitate') ?? affordable('Horizon Blade') ?? affordable('Stun');
        if (reaction) return [reaction, sure.at(-1) ?? reaction].filter((n, i, a) => a.indexOf(n) === i);
    }
    // Two at most: the server keeps a first style and a backup.
    return sure.length ? sure.slice(0, 2) : null;
}

/** The Hero's style pick: a stun at a player once per immunity, else the reacting tank's. */
export function heroStyle(log: StunLog = new Map(), now: () => number = Date.now): StylePick {
    return seen => {
        const { target, player, state, styles } = seen;
        noteStun(log, state, player.objectId);
        if (target.kind === 'player' && stunnable(log, target.objectId, now())) {
            const q = stunQueue(styles, state.equipment, foeLastResult(state, target.objectId, player.objectId), player.endurancePercent);
            if (q) return q;
        }
        return reactingStyle(seen);
    };
}

export function hero(): Character {
    return { role: 'tank', fight: [tank({ style: heroStyle() })] };
}
