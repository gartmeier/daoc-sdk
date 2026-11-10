// The inside of a battleground: its keeps, where each realm arrives, and the circles round
// the keeps whose guards attack us. Shared by the RvR policy (rvr.ts) and the behaviours,
// which keep tank and melee out of those circles.
//
// Keep guards take the realm of the keep whose area they stand in and attack enemy players
// within 2000 (portal keeps, level 255) or 1000 (other keeps), with the LoS check sent to the
// target's own client, which always answers clear (GameKeepGuard.cs:88-95, 454-482, 803-806;
// KeepGuardBrain.cs:47). Keeps load without walls here (keepcomponent is empty), so nothing
// gives cover.

import type { Realm } from '../types';
import type { Danger } from './terrain';
import type { Point, Point3 } from './types';

export type PlayerRealm = Exclude<Realm, 'none'>;

export interface Keep extends Point3 {
    name: string;
    /** Owner in the DB dump (keep.sql); settings.keepOwners overrides it once a keep changes hands. */
    owner: Realm;
    /** A portal keep (BaseLevel ≥ 100, AbstractGameKeep.IsPortalKeep): level-255 guards, never changes hands. */
    portal: boolean;
    /** Level its guards con at. */
    guardLevel: number;
}

/** The inside of a battleground: its keeps, where each realm arrives, where patrols meet (the way in is battleground.ts). */
export interface BattlegroundLayout {
    name: string;
    /** Levels it takes (battleground.sql). */
    levels: [number, number];
    keeps: Keep[];
    /** Where the medallion teleport lands each realm (OFTeleporters.cs). */
    arrival: Record<PlayerRealm, Point3>;
    /** Neutral ground about as far from every portal keep: the default patrols ring it. */
    meet: Point3;
    /** Where two realms meet in a pair round (settings.opponent), by pairKey: their patrols ring it, one each way. */
    pairs?: Record<string, Point>;
}

/** The key of two realms in BattlegroundLayout.pairs: their names in alphabetical order. */
export const pairKey = (a: PlayerRealm, b: PlayerRealm) => [a, b].sort().join('|');

/** Where `realm` and `opponent` meet in a pair round in this region; null without one. */
export function pairMeet(regionId: number, realm: PlayerRealm, opponent: PlayerRealm): Point | null {
    return BATTLEGROUND_LAYOUTS[regionId]?.pairs?.[pairKey(realm, opponent)] ?? null;
}

export const THIDRANKI = 252;

export const BATTLEGROUND_LAYOUTS: Record<number, BattlegroundLayout> = {
    // Keeps: keep.sql ids 11-14. Arrivals: OFTeleporters.cs:244, 402, 558. The meeting point is
    // 20.6-21.3k from each portal keep and 6.3k from the Faste, with no spawn point within 7.6k
    // (its z: estimateZ with radius 8000).
    [THIDRANKI]: {
        name: 'Thidranki', levels: [20, 24],
        keeps: [
            // OriginalRealm 0, Albion's in the dump. Guards L28, lord L33 (AbstractGameKeep.cs:837-886), up to ~1700 from the centre.
            { name: 'Thidranki Faste', x: 33089, y: 38271, z: 3720, owner: 'albion', portal: false, guardLevel: 28 },
            { name: 'Hibernia Portal Keep', x: 18362, y: 18257, z: 4320, owner: 'hibernia', portal: true, guardLevel: 255 },
            { name: 'Midgard Portal Keep', x: 54053, y: 24680, z: 4320, owner: 'midgard', portal: true, guardLevel: 255 },
            { name: 'Albion Portal Keep', x: 37301, y: 52362, z: 3944, owner: 'albion', portal: true, guardLevel: 255 },
        ],
        arrival: { albion: { x: 38113, y: 53507, z: 4160 }, midgard: { x: 53568, y: 23643, z: 4530 }, hibernia: { x: 17367, y: 18248, z: 4320 } },
        meet: { x: 34000, y: 32000, z: 3836 },
        // Three rivers run out from the Faste, one between each two realms' halves; the only dry ways over are its three
        // bridges, inside its guards (the halves also meet over cliffs round the rivers' far ends). Each pair meets on one
        // realm's bank, on open ground: the whole ring of 4000 dry, level (no slope over 35° within 300, slope.ts) and clear
        // of camps, the river at least 2900 from it, so a group that swam over comes ashore out of the other's sight. Found
        // by a search over the terrain (learnings/rvr.md "Water and pair rounds"). Each realm swims across in one of its two
        // pairings: Midgard to Hibernia's bank, Hibernia to Albion's, Albion to Midgard's, and that one has the longer walk.
        // Distances from the arrivals in the order of the key. Until 2026-11-09 the Albion pairs met on the river's middle
        // (Camelot swam 43-52 % of fight time against Hibernia), Hibernia and Midgard 800 from it.
        pairs: {
            // 17.0k / 20.6k, the river 2900 east of the ring.
            'hibernia|midgard': { x: 33000, y: 25000 },
            // 19.1k / 27.0k, the river 3000 north of the ring.
            'albion|hibernia': { x: 21000, y: 45000 },
            // 24.3k / 11.9k, the river 2900 south of the ring; 500 east and north of (54000, 35000), where Camelot's first
            // round stood on the broken hillside west of the ring 12 % of its fight time.
            'albion|midgard': { x: 54500, y: 35500 },
        },
    },
};

export interface KeepSettings {
    /** Stay this far from the centre of an enemy portal keep (guards aggro at 2000, level 255) and of any other keep not ours. */
    keepClearance: { portal: number; keep: number };
    /** Owner by keep name over the DB's, for a keep that changed hands: { 'Thidranki Faste': 'midgard' }. */
    keepOwners: Record<string, Realm>;
}

/**
 * The Faste's guards stand up to ~1700 from its centre and aggro at 1000 (static archers at 2100), and come out after
 * what they aggroed on. 3000 until 2026-11-10: Hibernia rested 3900 from the centre, an Armswoman (1613 out in the DB)
 * attacked, and three died healing (arena round 26). Keep guards are realm NPCs, never on the board (isKillable), so the
 * group can't see them coming: rvr.ts moves off when attacked near a keep by nothing it sees.
 */
export const KEEP_CLEARANCE: KeepSettings['keepClearance'] = { portal: 4500, keep: 4500 };

/** Our portal keep and where we arrive (and land after a release) in a battleground; null elsewhere. */
export function homeOf(regionId: number, realm: Realm): { keep: Keep; arrival: Point3 } | null {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    if (!bg || realm === 'none') return null;
    const keep = bg.keeps.find(k => k.portal && k.owner === realm);
    return keep ? { keep, arrival: bg.arrival[realm] } : null;
}

/**
 * Circles round every keep whose guards attack us: enemy portal keeps at keepClearance.portal, other
 * keeps not ours at keepClearance.keep. Empty outside a known battleground. Settings missing either
 * field (strategies other than RvR) use KEEP_CLEARANCE and the DB's owners.
 */
export function keepDangers(regionId: number, realm: Realm, settings: Partial<KeepSettings> = {}): Danger[] {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    if (!bg) return [];
    const clearance = settings.keepClearance ?? KEEP_CLEARANCE;
    const owners = settings.keepOwners ?? {};
    return bg.keeps
        .filter(k => (owners[k.name] ?? k.owner) !== realm)
        .map(k => ({ x: k.x, y: k.y, r: k.portal ? clearance.portal : clearance.keep, name: k.name, level: k.guardLevel }));
}

/** Outside every circle (by `margin` more). */
export const clearOf = (p: Point, circles: readonly Danger[], margin = 0) => circles.every(c => Math.hypot(c.x - p.x, c.y - p.y) >= c.r + margin);
