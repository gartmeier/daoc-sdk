// Character creation for 0xFF packets. The class/race/gender/stat rules come
// from data/index.ts (parsed from the C#: STARTING_CLASSES_DICT, EligibleRaces,
// STARTING_STATS_DICT, gender constraints; mirrors IsCharacterValid,
// CharacterCreateRequestHandler.cs:920). This file only adds what the data
// module does not carry: the creation models per race.

import type { Realm } from '../../sdk/types';
import {
    defaultStats, getClass, getRace, getStartingClasses, getStartingStats, optimizedStatPoints, realmId, realmName as dataRealmName,
    STAT_ORDER, statPointCost, validateCharacter,
} from '../../data/index';

/** eLivingModel male / female per eRace id (Enums/eLivingModel.cs; gameobjects/PlayerRace.cs:42-64). */
export const RACE_MODELS: Record<number, [number, number]> = {
    1: [32, 35], 2: [61, 65], 3: [39, 43], 4: [48, 52], 13: [716, 724],
    5: [503, 507], 6: [137, 145], 7: [185, 193], 8: [169, 177], 14: [773, 781],
    9: [302, 310], 10: [286, 294], 11: [334, 342], 12: [318, 326], 15: [700, 708],
};

export function realmNumber(realm: Realm | string | number): 1 | 2 | 3 {
    const n = realmId(realm);
    if (n === 1 || n === 2 || n === 3) return n;
    throw new Error(`invalid realm '${String(realm)}' (albion | midgard | hibernia)`);
}

export function realmName(n: number): Realm {
    return dataRealmName(n);
}

export interface CreationPlan {
    classId: number;
    raceId: number;
    realm: 1 | 2 | 3;
    /** 0 male, 1 female. */
    gender: number;
    model: number;
    /** STR, DEX, CON, QUI, INT, PIE, EMP, CHA (the 0xFF order). */
    stats: [number, number, number, number, number, number, number, number];
    /** Server-valid but questionable choices (e.g. no startup location). */
    warnings: string[];
}

/** Build a valid level-1 creation for (realm, class, race). Throws with a readable message when invalid. */
export function planCharacter(realmIn: Realm | string | number, className: string, raceName: string, gender?: number): CreationPlan {
    const realm = realmNumber(realmIn);
    if (!getClass(className, realm)) {
        const names = getStartingClasses(realm).map(c => c.name).join(', ');
        throw new Error(`class '${className}' is not a starting class in ${realmName(realm)} (${names})`);
    }
    const v = validateCharacter({
        realm, class: className, race: raceName,
        gender: gender === undefined ? undefined : gender === 1 ? 'female' : 'male',
    });
    if (!v.valid || !v.classInfo || !v.raceInfo) throw new Error(`invalid character: ${v.errors.join('; ')}`);
    const models = RACE_MODELS[v.raceInfo.id];
    if (!models) throw new Error(`no creation model known for race ${v.raceInfo.name}`);
    const g = v.gender === 'female' ? 1 : 0;
    const s = defaultStats(v.classInfo.id, v.raceInfo.id, realm);
    const stats = STAT_ORDER.map(k => s[k]) as CreationPlan['stats'];
    return { classId: v.classInfo.id, raceId: v.raceInfo.id, realm, gender: g, model: models[g], stats, warnings: v.warnings };
}

/** Points a level adds to each stat: from level 6, the class's primary every level, secondary every 2nd, tertiary every 3rd (GamePlayer.cs OnLevelUp, CharacterStatValidator.cs). */
export function levelStatGains(classId: number, level: number): number[] {
    const c = getClass(classId);
    return STAT_ORDER.map(s => {
        let gain = 0;
        for (let l = level; l > 5; l--) {
            if (c?.primaryStat === s) gain++;
            if (c?.secondaryStat === s && (l - 6) % 2 === 0) gain++;
            if (c?.tertiaryStat === s && (l - 6) % 3 === 0) gain++;
        }
        return gain;
    });
}

export type StatRespec =
    | { kind: 'same' }
    | { kind: 'skip'; why: string }
    | { kind: 'respec'; stats: CreationPlan['stats']; from: string; to: string };

const pointsText = (above: number[]) => STAT_ORDER.map((s, i) => above[i] ? `${s}+${above[i]}` : '').filter(Boolean).join(' ') || 'none';

/**
 * An existing character's starting points against the client's Optimize split (data/index.ts optimizedStatPoints).
 * `stats` are its base stats in the 0xFF order, as the character overview shows them. The new stats keep the level
 * gains, as the server's check takes them off again (CharacterStatValidator.cs). A character whose points don't
 * come to 30 has been changed some other way and is left alone.
 */
export function planStatRespec(classId: number, raceId: number, level: number, stats: number[]): StatRespec {
    const base = getStartingStats(raceId);
    const want = getClass(classId) ? optimizedStatPoints(classId) : null;
    if (!base || !want) return { kind: 'skip', why: `no Optimize split for class ${classId} race ${raceId}` };
    const gains = levelStatGains(classId, level);
    const above = STAT_ORDER.map((s, i) => (stats[i] ?? 0) - gains[i]! - base[s]);
    const cost = above.reduce((t, a) => t + a + Math.max(0, a - 10) + Math.max(0, a - 15), 0);
    if (above.some(a => a < 0) || cost !== 30) return { kind: 'skip', why: `starting points ${pointsText(above)} don't come to 30` };
    const to = STAT_ORDER.map(s => want[s] ?? 0);
    if (to.every((a, i) => a === above[i])) return { kind: 'same' };
    const next = STAT_ORDER.map((s, i) => base[s] + to[i]! + gains[i]!) as CreationPlan['stats'];
    return { kind: 'respec', stats: next, from: pointsText(above), to: pointsText(to) };
}

/** Sum of creation costs (CharacterStatValidator.cs); must equal 30. */
export function creationPoints(raceId: number, stats: number[]): number {
    const rec = Object.fromEntries(STAT_ORDER.map((k, i) => [k, stats[i]]));
    return statPointCost(rec, raceId) ?? Number.NaN;
}

export function className(_realm: number, classId: number): string {
    return getClass(classId)?.name ?? `Class${classId}`;
}

export function raceNameById(raceId: number): string {
    return getRace(raceId)?.name ?? `Race${raceId}`;
}
