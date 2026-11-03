// Which line to raise next, as one pure rule. nextBuildStep takes what the character has now and says what to
// do at the trainer:
//
//   Take the current target and go through its lines in the listed order. A line the character doesn't have
//   yet is skipped: a base class, or a line acquired later. The first line under min(target, character level) is
//   the one to raise, as far as the points reach. If they don't reach its next level the points stay banked,
//   with no falling through to a cheaper line further down, because the expensive one would then never come.
//
// What it rests on, C# refs relative to server/core/GameServer:
//
//   - A spec level costs its own number, and no line goes above the character's level (train.cs:82, :104-113).
//   - Autotrain is a price, not a raise: a level at or below Level / 4 on an autotrain line costs nothing, but
//     it still has to be trained (train.cs:115, GamePlayer.cs:4833).
//   - The server recomputes spent points on every read (GamePlayer.cs:3512, :9963-9968), so the path doesn't change
//     the price: a level paid early comes back once the free levels pass it. player.specPoints holds that already.

import type { Realm } from '../../sdk/types';
import { getClass, getSpecialization, getTrainableLines, type ClassInfo } from '../index';
import { specKey } from '../spec-names';
import type { Build, BuildTarget } from './types';

/** GamePlayer.MAX_LEVEL. */
const MAX_LEVEL = 50;
/** A base class promotes here (trainer/albion/FighterTrainer.cs:63-65 and the other base trainers). */
export const PROMOTION_LEVEL = 5;
/** Half levels exist from 40 to 49 (GamePlayer.cs:4296). */
const FIRST_HALF_LEVEL = 40;

export interface BuildState {
    level: number;
    /** What sdk.getSkills().specializations returns: display names are mapped through specKey. */
    specs: readonly { name: string; level: number }[];
    /** player.specPoints. */
    points: number;
    /** The autotrainSpecs of the character's CURRENT class: a base class has none. */
    autotrain?: readonly string[];
}

export type BuildStep =
    /** Raise this line, by KeyName, from one level to another for this many points. */
    | { kind: 'train'; spec: string; from: number; to: number; cost: number }
    /** This line is next and its next level costs more than the points: bank them. */
    | { kind: 'wait'; spec: string; from: number; cost: number; points: number }
    | { kind: 'done' };

/** The first target at or above this level, else the last. */
export function currentTarget(build: Build, level: number): BuildTarget {
    return build.targets.find(t => t.level >= level) ?? build.targets[build.targets.length - 1]!;
}

/** Autotrain's reach at this character level: GamePlayer.cs:4833. */
export function freeLevels(level: number): number {
    return Math.max(1, Math.floor(level / 4));
}

/** Points to raise a line: each level costs its own number, and levels at or below freeUpTo cost nothing. */
export function specCost(from: number, to: number, freeUpTo: number = 0): number {
    let cost = 0;
    for (let l = from + 1; l <= to; l++) if (l > freeUpTo) cost += l;
    return cost;
}

/** All the points a character of this multiplier has earned: VerifySpecPoints, GamePlayer.cs:9949-9960. */
export function earnedSpecPoints(multiplier: number, level: number, opts: { halfLevel?: boolean } = {}): number {
    let points = -1;
    for (let i = 1; i <= level; i++) {
        points += i <= 5 ? i : Math.trunc(multiplier * i / 10);
        if (i > 40) points += Math.trunc(multiplier * (i - 1) / 20);
    }
    if (opts.halfLevel && level >= FIRST_HALF_LEVEL && level < MAX_LEVEL) points += Math.trunc(multiplier * level / 20);
    return points;
}

const levelsOf = (state: BuildState): Map<string, number> => new Map(state.specs.map(s => [specKey(s.name), s.level]));
const autotrainOf = (state: BuildState): Set<string> => new Set((state.autotrain ?? []).map(specKey));

/** The one thing to do now: see the top of this file. */
export function nextBuildStep(build: Build, state: BuildState): BuildStep {
    const have = levelsOf(state);
    const autotrain = autotrainOf(state);
    for (const [name, wanted] of Object.entries(currentTarget(build, state.level).specs)) {
        const spec = specKey(name);
        const from = have.get(spec);
        if (from === undefined) continue;
        const cap = Math.min(wanted, state.level);
        if (from >= cap) continue;
        const free = autotrain.has(spec) ? freeLevels(state.level) : 0;
        let to = from;
        let cost = 0;
        while (to < cap) {
            const next = specCost(to, to + 1, free);
            if (cost + next > state.points) break;
            cost += next;
            to++;
        }
        if (to > from) return { kind: 'train', spec, from, to, cost };
        return { kind: 'wait', spec, from, cost: specCost(from, from + 1, free), points: state.points };
    }
    return { kind: 'done' };
}

/**
 * Lines with points spent beyond the current target; a line not in the target has target 1. Free levels aren't
 * spent, and after a respec an autotrain line sits at them anyway (RespecSingleLine, GamePlayer.cs:3052-3055).
 */
export function linesOverTarget(build: Build, state: BuildState): { spec: string; level: number; target: number }[] {
    const target = new Map(Object.entries(currentTarget(build, state.level).specs).map(([name, level]) => [specKey(name), level]));
    const autotrain = autotrainOf(state);
    const over: { spec: string; level: number; target: number }[] = [];
    for (const [spec, level] of levelsOf(state)) {
        const wanted = target.get(spec) ?? 1;
        if (level > Math.max(wanted, autotrain.has(spec) ? freeLevels(state.level) : 0)) over.push({ spec, level, target: wanted });
    }
    return over;
}

/**
 * Everything wrong with a build, each as a sentence; empty when it is valid. `realm` tells apart a class name two
 * realms share: "Rogue" with no realm is Albion's, and a Midgard one is also MidgardRogue.
 */
export function buildProblems(build: Build, realm?: Realm | number): string[] {
    const cls = getClass(build.className, realm) ?? getClass(build.className);
    if (!cls) return [`Unknown class "${build.className}".`];
    if (build.targets.length === 0) return ['The build has no targets.'];
    const lines = new Map(getTrainableLines(cls.key).map(l => [l.specKey, l]));
    const problems: string[] = [];
    const highest = new Map<string, { level: number; target: number }>();
    let previous: number | undefined;
    for (const target of build.targets) {
        const at = `Target ${target.level}`;
        const levelValid = Number.isInteger(target.level) && target.level >= 1 && target.level <= MAX_LEVEL;
        if (!levelValid) problems.push(`${at} is outside levels 1..${MAX_LEVEL}.`);
        if (previous !== undefined && target.level <= previous) problems.push(`${at} comes after target ${previous}: levels must ascend.`);
        const governedFrom = (previous ?? 0) + 1;
        previous = target.level;

        const specs = Object.entries(target.specs);
        for (const [spec, level] of specs) {
            const line = lines.get(spec);
            if (!line) {
                const key = getSpecialization(spec)?.keyName;
                problems.push(key && lines.has(key) ? `${spec}: use the KeyName ${key}` : `${spec} is not a trainable line of ${cls.name}. Its lines: ${[...lines.keys()].join(', ')}.`);
                continue;
            }
            if (!Number.isInteger(level) || level < 1) problems.push(`${at}: ${spec} ${level} is not a spec level of 1 or more.`);
            if (level > target.level) problems.push(`${at}: ${spec} ${level} is above the character's level.`);
            if (line.levelAcquired > target.level) problems.push(`${at}: ${spec} comes only at level ${line.levelAcquired}.`);
        }

        for (const [spec, was] of highest) {
            // A line left out falls to 1, as in linesOverTarget, or to the free levels of an autotrain line at the first level
            // this target governs: linesOverTarget reads the character's level, and those levels are fewer there than at its end.
            const now = target.specs[spec] ?? (cls.autotrainSpecs.includes(spec) ? freeLevels(governedFrom) : 1);
            if (now < was.level) problems.push(`${at} lowers ${spec} from ${was.level} in target ${was.target} to ${now}.`);
        }
        for (const [spec, level] of specs) {
            if (lines.has(spec) && level > (highest.get(spec)?.level ?? 0)) highest.set(spec, { level, target: target.level });
        }

        const cost = targetCost(cls, target, lines);
        const budget = earnedSpecPoints(cls.specializationMultiplier, target.level);
        if (levelValid && cost > budget) problems.push(`${at} costs ${cost} points, and ${cls.name} has ${budget} by level ${target.level}.`);
    }
    return [...new Set(problems)];
}

/** What the real lines of a target cost at its level, autotrain priced. */
function targetCost(cls: ClassInfo, target: BuildTarget, lines: ReadonlyMap<string, unknown>): number {
    let cost = 0;
    for (const [spec, level] of Object.entries(target.specs)) {
        if (lines.has(spec)) cost += specCost(1, level, cls.autotrainSpecs.includes(spec) ? freeLevels(target.level) : 0);
    }
    return cost;
}

export interface BuildPathLevel {
    level: number;
    /** Every line the character has at this level, by KeyName, after buying. */
    specs: Record<string, number>;
    /** What stays banked after buying. */
    points: number;
}

/**
 * The build played by the rule from level 1 to its last target: it buys at every level and half level, on the
 * lines the character has by then, with autotrain priced. A row shows a level as it dings, before its half level.
 * By default the character starts as its base class and promotes at 5, as the server does unless
 * start_as_base_class is off (docs/SERVER.md). For a person reading a build, and for its tests.
 */
export function buildPath(build: Build, opts: { startAsBaseClass?: boolean } = {}): BuildPathLevel[] {
    const cls = getClass(build.className);
    if (!cls) throw new Error(`unknown class "${build.className}"`);
    const start = (opts.startAsBaseClass ?? true) ? getClass(cls.baseClassId) ?? cls : cls;
    const specs = new Map<string, number>();

    const buy = (level: number, halfLevel: boolean): number => {
        const current = level >= PROMOTION_LEVEL ? cls : start;
        for (const line of getTrainableLines(current.key, { characterLevel: level })) {
            if (!specs.has(line.specKey)) specs.set(line.specKey, 1);
        }
        const earned = earnedSpecPoints(cls.specializationMultiplier, level, { halfLevel });
        for (;;) {
            let points = earned;
            for (const [spec, at] of specs) points -= specCost(1, at, current.autotrainSpecs.includes(spec) ? freeLevels(level) : 0);
            const step = nextBuildStep(build, {
                level, points, autotrain: current.autotrainSpecs, specs: [...specs].map(([name, at]) => ({ name, level: at })),
            });
            if (step.kind !== 'train') return points;
            specs.set(step.spec, step.to);
        }
    };

    const path: BuildPathLevel[] = [];
    const last = build.targets[build.targets.length - 1]?.level ?? 0;
    for (let level = 1; level <= last; level++) {
        const points = buy(level, false);
        path.push({ level, specs: Object.fromEntries(specs), points });
        if (level >= FIRST_HALF_LEVEL && level < last) buy(level, true);
    }
    return path;
}
