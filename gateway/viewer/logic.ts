// DOM-free decisions used by app.ts, kept separate so they can be unit-tested.

import type { BotWorldState, NearbyNpc, PetAggression, PetLossCause, PetWalk } from '../../sdk/types';

/** After a failed /zones fetch, wait this long before asking for the same region again. */
export const REGION_RETRY_MS = 10_000;

/** Whether the page should fetch zone data for `regionId` now. */
export function shouldLoadRegion(
    regionId: number,
    loadedRegionId: number | null,
    loadingRegionId: number | null,
    failure: { regionId: number; at: number } | null,
    now: number,
): boolean {
    if (loadedRegionId === regionId || loadingRegionId === regionId) return false;
    if (failure && failure.regionId === regionId && now - failure.at < REGION_RETRY_MS) return false;
    return true;
}

/** The Target line for an id nothing in view has: our own can be the target too, and we are no entity on the page. */
export function unseenTarget(targetId: number, selfId: number | undefined): string {
    return targetId === selfId ? 'self' : `#${targetId} (not in view)`;
}

/**
 * One of our own pets: the window's, whatever its entry says, or one with no window that has the pet flag.
 * An id in state.summons can be old: it lingers up to 30 s and the server hands it on.
 */
export function isOwnPet(state: Partial<Pick<BotWorldState, 'pet' | 'summons'>> | null | undefined, npc: Pick<NearbyNpc, 'objectId' | 'isPet'>): boolean {
    return state?.pet?.objectId === npc.objectId || (!!npc.isPet && !!state?.summons?.includes(npc.objectId));
}

const WALK_TEXT: Record<PetWalk, string> = { follow: 'follow', stay: 'stay', goTarget: 'go to target', comeHere: 'come here' };

/** A pet's stance and walk order, for the pages: "defensive · come here". */
export function petOrders(aggression: PetAggression, walk: PetWalk): string {
    return `${aggression} · ${WALK_TEXT[walk] ?? walk}`;
}

const LOSS_TEXT: Record<PetLossCause, string> = { died: 'died', released: 'released', owner_died: 'owner died', region_change: 'region change' };

/** The bot page's pet block. */
export interface PetPanel {
    /** The window pet. Level and health are its entry's, null while that is out of view; its target is the window's (a caster pet's entry reads 0 and 65535). */
    pet: { objectId: number; name: string; level: number | null; hp: number | null; inCombat: boolean; orders: string; target: string | null; icons: number } | null;
    /** Pets with no window: by name in view, by id out of it. */
    summons: string[];
    /** How the last window pet went, while no other is up. */
    lost: { name: string; cause: string; at: number } | null;
}

/** What the bot page says about its pets; null for a bot that has none and never lost one. */
export function petPanel(state: Partial<BotWorldState> | null | undefined, nameOf: (objectId: number) => string): PetPanel | null {
    if (!state) return null;
    const npcs = Array.isArray(state.nearbyNpcs) ? state.nearbyNpcs : [];
    const entry = (id: number) => npcs.find(n => n?.objectId === id);
    const w = state.pet;
    const n = w ? entry(w.objectId) : undefined;
    const pet = w ? {
        objectId: w.objectId, name: n?.name ?? w.name ?? `#${w.objectId}`, level: n?.level ?? null, hp: n?.healthPercent ?? null, inCombat: !!n?.inCombat,
        orders: petOrders(w.aggression, w.walk), target: w.targetObjectId !== null ? nameOf(w.targetObjectId) : null, icons: Array.isArray(w.icons) ? w.icons.length : 0,
    } : null;
    const summons = (Array.isArray(state.summons) ? state.summons : []).map(id => entry(id)?.name ?? `#${id}`);
    const loss = !pet ? state.lastPetLoss : null;
    const lost = loss ? { name: loss.name ?? `#${loss.objectId}`, cause: LOSS_TEXT[loss.cause] ?? loss.cause, at: loss.at } : null;
    return pet || summons.length || lost ? { pet, summons, lost } : null;
}

/** Headers for the gateway's authenticated HTTP routes (/state): the typed password as a bearer token. */
export function authHeaders(password: string): Record<string, string> {
    return password ? { Authorization: `Bearer ${password}` } : {};
}

/** What a region marker is, in words. */
export function enemyWord(e: { isPet?: boolean }): string {
    return e.isPet ? 'Enemy pet' : 'Enemy player';
}

/** The region's enemies in a line: players, and pets when there are any. */
export function enemyHeading(enemies: readonly { isPet?: boolean }[]): string {
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const pets = enemies.filter(e => e.isPet).length;
    return [count(enemies.length - pets, 'enemy player'), pets ? count(pets, 'enemy pet') : ''].filter(Boolean).join(', ');
}

/** A line per enemy pet whose aim stands on the map. */
export function enemyAims<E extends { isPet?: boolean; targetId?: number | null }, P>(enemies: readonly E[], at: (objectId: number) => P | null): { from: E; to: P }[] {
    return enemies.flatMap(e => {
        const to = e.isPet && e.targetId != null ? at(e.targetId) : null;
        return to ? [{ from: e, to }] : [];
    });
}
