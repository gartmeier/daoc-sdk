// Con colours for the viewer, port of CharacterConLevelGrid
// (server/core/GameServer/gameutils/ConLevelGrid.cs:66-131). Shared by the
// browser bundle and the tests, so it must stay dependency-free.

export type ConColor = 'grey' | 'green' | 'blue' | 'yellow' | 'orange' | 'red' | 'purple';

const CON_COLORS: ConColor[] = ['grey', 'green', 'blue', 'yellow', 'orange', 'red', 'purple'];

export const CON_HEX: Record<ConColor, string> = {
    grey: '#9a9a9a',
    green: '#3fbf4f',
    blue: '#4a8cff',
    yellow: '#f2d43a',
    orange: '#ff9330',
    red: '#ff4a4a',
    purple: '#c45cff',
};

// Spans of NPC levels per con level, ending at +2 (purple fills the rest).
// Row 0 starts at con 0, row 1 at -1, row 2 at -2, rows 3+ at -3.
const SPANS: number[][] = [
    [1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1], [2, 1, 1, 1, 1, 1], [3, 1, 1, 1, 1, 1], [4, 1, 1, 1, 1, 1], [5, 1, 1, 1, 1, 1],
    [6, 1, 1, 1, 1, 1], [7, 1, 1, 1, 1, 1], [7, 1, 2, 1, 1, 2], [7, 1, 2, 2, 2, 2], [7, 2, 2, 2, 2, 2],
    [8, 2, 2, 2, 2, 2], [9, 2, 2, 2, 2, 2], [10, 2, 2, 2, 2, 2], [11, 2, 2, 2, 2, 2], [12, 2, 2, 2, 2, 2],
    [13, 2, 2, 2, 2, 2], [14, 2, 2, 2, 2, 2], [14, 2, 3, 2, 2, 3], [14, 2, 3, 3, 3, 3], [14, 3, 3, 3, 3, 3],
    [15, 3, 3, 3, 3, 3], [16, 3, 3, 3, 3, 3], [17, 3, 3, 3, 3, 3], [18, 3, 3, 3, 3, 3], [19, 3, 3, 3, 3, 3],
    [20, 3, 3, 3, 3, 3], [21, 3, 3, 3, 3, 3], [22, 3, 3, 3, 3, 3], [23, 3, 3, 3, 3, 3], [24, 3, 3, 3, 3, 3],
    [25, 3, 3, 3, 3, 3], [26, 3, 3, 3, 3, 3], [26, 3, 3, 4, 4, 3], [26, 3, 3, 5, 5, 4], [26, 4, 3, 5, 5, 5],
    [26, 4, 4, 5, 5, 5], [26, 4, 5, 5, 5, 5], [26, 5, 5, 5, 5, 5], [27, 5, 5, 5, 5, 5], [28, 5, 5, 5, 5, 5],
    [29, 5, 5, 5, 5, 5], [30, 5, 5, 5, 5, 5], [31, 5, 5, 5, 5, 5], [32, 5, 5, 5, 5, 5], [33, 5, 5, 5, 5, 5],
    [34, 5, 5, 5, 5, 5], [35, 5, 5, 5, 5, 5], [36, 5, 5, 5, 5, 5],
];
const MAX_LEVEL = 127;

/** Con level -3 (grey) .. +3 (purple) of a target as seen by a player of `userLevel`. */
export function conLevel(userLevel: number, targetLevel: number): number {
    const user = Math.floor(userLevel);
    const target = Math.floor(targetLevel);
    if (!Number.isFinite(user) || !Number.isFinite(target)) return 0;
    if (user < 0 || user > MAX_LEVEL || target < 0 || target > MAX_LEVEL) return 0;
    let spans = SPANS[user];
    if (!spans) {
        // Levels past 50: level 50's grey span grows by one per level (ConLevelUtility.BuildGrid).
        const last = SPANS[SPANS.length - 1]!;
        spans = [last[0]! + (user - (SPANS.length - 1)), ...last.slice(1)];
    }
    let con = 2 - (spans.length - 1);
    let index = 0;
    for (const span of spans) {
        index += span;
        if (target < index) return con;
        con++;
    }
    return 3;
}

export function conColor(userLevel: number, targetLevel: number): ConColor {
    return CON_COLORS[conLevel(userLevel, targetLevel) + 3] ?? 'yellow';
}
