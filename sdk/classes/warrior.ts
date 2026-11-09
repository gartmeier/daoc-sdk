// The standard Warrior: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's list
// already taunts and swings a damage style; what is the class's own is what a block, a parry or a position opens.
// learnings/classes/warrior.md says which on Axe, and what has been measured.
//
// Against a player the style pick learns whom it is fighting from its last swing (heldBySwing): the server never sends a
// player's target, so a player always read as "on us", and no positional (Disable, a 4 s stun from the side) was ever taken.

import { tank, type StylePick } from '../group/behaviors';
import type { Character } from '../group/character';
import type { BotWorldState } from '../types';
import { reactingStyle } from './reacting-tank';

/** A swing this recent still says whom a player is on: about two of a slow weapon's. */
export const SWING_WINDOW_MS = 8000;

/** Whom enemy player `foe` last swung at, within `windowMs`; null when it hasn't. */
export function lastSwungAt(state: Pick<BotWorldState, 'combatEvents'>, foe: number, now = Date.now(), windowMs = SWING_WINDOW_MS): number | null {
    const e = state.combatEvents.filter(e => e.kind === 'melee' && e.attackerObjectId === foe && now - e.receivedAt <= windowMs).at(-1);
    return e?.targetObjectId ?? null;
}

/**
 * `pick`, with a player's target filled from its last swing, as a monster's comes from the server: a player swinging
 * at someone else reads as held, and fighterStyle then takes a positional (and no reaction, which can't fire). A
 * player that swung at us, or at nobody lately, stays as it was.
 */
export const heldBySwing = (pick: StylePick): StylePick => seen => {
    if (seen.target.kind !== 'player') return pick(seen);
    const on = lastSwungAt(seen.state, seen.target.objectId);
    if (on === null || on === seen.player.objectId) return pick(seen);
    return pick({ ...seen, target: { ...seen.target, targetObjectId: on } as typeof seen.target });
};

export function warrior(): Character {
    return { role: 'tank', fight: [tank({ style: heldBySwing(reactingStyle) })] };
}
