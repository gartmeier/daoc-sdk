// A character's look: the appearance bytes of 0xFF CharacterCreateRequest, picked from the
// character's name so one character always looks the same and two rarely look alike.
//
// Ranges come from the retail client's tables (gamedata.mpk): morph sliders 0..8
// (pregame/character_customize.xml), 8 eye colours and skin tones, 16 hair colours
// (fig3tofighaircolor.csv), 7 faces, and the hair styles per race and gender (fig3descriptions.csv).
// Which index the wire uses isn't documented, so faces and hair stay in ranges valid for 0- and
// 1-based alike. Vue, made with the real client, has hair 1 on model 330, index 0 of Lurikeen female.

/** Model id per hair style, [male, female], per eRace id (fig3tofigmain.csv, first face; race there is eRace - 1). */
const HAIR_MODELS: Record<number, [number[], number[]]> = {
    1: [[471, 473, 472, 14, 257, 474, 474, 473], [258, 35, 259, 36, 38, 258]], // Briton
    2: [[64, 278, 281, 495, 62, 281, 495, 498], [282, 283, 65, 66, 68, 502]], // Avalonian
    3: [[265, 263, 264, 488, 488, 488, 488, 488], [43, 266, 267, 269]], // Highlander
    4: [[48, 479, 270, 51, 48, 270, 481, 51], [52, 54, 483, 485]], // Saracen
    5: [[153, 505, 156, 160], [161, 165, 162, 166]], // Norseman
    6: [[140, 511, 141, 143], [152, 517, 145, 147]], // Troll
    7: [[185, 521, 522, 192, 520, 522], [193, 194, 197, 198]], // Dwarf
    8: [[529, 530, 176, 528, 169], [177, 181, 182, 183]], // Kobold
    9: [[535, 304, 305, 303, 303, 303, 309, 537], [310, 314, 315, 311, 314]], // Celt
    10: [[288, 286, 290, 292, 287, 553, 291, 292], [294, 298, 299, 295]], // Firbolg
    11: [[338, 340, 334, 562], [565, 566, 563, 564]], // Elf
    12: [[544, 322, 321, 319, 546, 321, 325, 322], [330, 331, 332, 326]], // Lurikeen
    13: [[716, 717, 718, 719, 716, 718, 718, 718], [724, 726, 725, 727, 727]], // Inconnu
    14: [[777, 773, 779, 774], [782, 783, 836, 784]], // Valkyn
    15: [[700, 702, 703, 706], [714, 855, 708, 853]], // Sylvan
    16: [[1012, 1008, 1014, 1018, 1011, 1010, 1009], [1020, 1022, 1024, 1025]], // Half_ogre
    17: [[1061, 1055, 1053, 1056], [1072, 1071, 1073, 1063]], // Frostalf
    18: [[1079, 1086, 1077, 1084, 1081], [1096, 1089, 1087, 1095]], // Shar
};

/** eSize in bits 11-12 of the model: 1 short, 2 average, 3 tall. Never 0: the customize path treats that as a hack (CharacterCreateRequestHandler.cs:802). */
const SIZE_SHIFT = 11;
/** Set on the one real-client character here (Vue, 0x914A); the server doesn't read it on players. */
const CREATED_BY_CLIENT = 0x8000;

export interface Look {
    /** High nibble eyes, low nibble nose. */
    eyeSize: number;
    /** High nibble lips, low nibble jaw. */
    lipSize: number;
    /** High nibble eye colour, low nibble skin tone. */
    eyeColor: number;
    hairColor: number;
    /** High nibble. */
    faceType: number;
    /** High nibble. */
    hairStyle: number;
    /** Model id, size and flag, as CreationModel. */
    model: number;
}

function fnv1a(s: string): number {
    let h = 0x811C9DC5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
}

/** The look of a character, or null for a race the client tables don't list. */
export function lookFor(name: string, raceId: number, gender: number): Look | null {
    const hairs = HAIR_MODELS[raceId]?.[gender ? 1 : 0];
    if (!hairs || hairs.length < 2) return null;
    let h = fnv1a(name.toLowerCase());
    const pick = (min: number, max: number) => {
        // xorshift32: the name's hash alone would tie the fields together.
        h ^= h << 13; h >>>= 0;
        h ^= h >>> 17;
        h ^= h << 5; h >>>= 0;
        return min + h % (max - min + 1);
    };
    // Morphs stay off the slider ends, where faces get odd.
    const morph = () => pick(1, 7);
    const eyeSize = (morph() << 4) | morph();
    const lipSize = (morph() << 4) | morph();
    const eyeColor = (pick(0, 7) << 4) | pick(0, 7);
    const hairColor = pick(0, 15);
    const face = pick(1, 5);
    const hair = pick(1, hairs.length - 1);
    const size = pick(1, 3);
    return {
        eyeSize, lipSize, eyeColor, hairColor,
        faceType: face << 4,
        hairStyle: hair << 4,
        model: hairs[hair - 1]! | (size << SIZE_SHIFT) | CREATED_BY_CLIENT,
    };
}

/** All six face bytes zero: a character made before looks existed (or with CustomMode 0). */
export function hasNoLook(c: { eyeSize: number; lipSize: number; eyeColor: number; hairColor: number; faceType: number; hairStyle: number }): boolean {
    return !(c.eyeSize || c.lipSize || c.eyeColor || c.hairColor || c.faceType || c.hairStyle);
}
