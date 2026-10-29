// Character creation for 0xFF packets. The class/race/gender/stat rules come
// from data/index.ts (parsed from the C#: STARTING_CLASSES_DICT, EligibleRaces,
// STARTING_STATS_DICT, gender constraints; mirrors IsCharacterValid,
// CharacterCreateRequestHandler.cs:920). This file only adds what the data
// module does not carry: the creation models per race.

import type { Realm } from '../../sdk/types';
import {
    defaultStats, getClass, getRace, getStartingClasses, realmId, realmName as dataRealmName, STAT_ORDER,
    statPointCost, validateCharacter,
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
