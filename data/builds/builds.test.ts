import { describe, expect, test } from 'bun:test';
import { getClass, getClasses, getClassSkills } from '../index';
import {
    allClassBuilds, buildPath, buildProblems, currentTarget, earnedSpecPoints, freeLevels, getBuild, getClassBuilds, linesOverTarget,
    nextBuildStep, specCost, type Build, type BuildState, type BuildTarget, type CatalogBuild,
} from './index';

const build = (className: string, ...targets: BuildTarget[]): Build => ({ className, name: 'test', targets });
const target = (level: number, specs: Record<string, number>): BuildTarget => ({ level, specs });
const state = (level: number, points: number, specs: Record<string, number>, autotrain?: string[]): BuildState => ({
    level, points, autotrain, specs: Object.entries(specs).map(([name, at]) => ({ name, level: at })),
});
const everyBuild = (): { className: string; entry: CatalogBuild; build: Build }[] => allClassBuilds().flatMap(c => c.builds.map(entry => ({
    className: c.className, entry, build: { className: c.className, name: entry.name, targets: entry.targets },
})));

describe('what points come and what they cost', () => {
    test.each([
        [10, 299, 1494], [15, 437, 2223], [20, 584, 2979], [22, 633, 3253], [25, 722, 3706],
    ])('multiplier %i earns %i by 24 and %i by 50', (multiplier, at24, at50) => {
        expect(earnedSpecPoints(multiplier, 24)).toBe(at24);
        expect(earnedSpecPoints(multiplier, 50)).toBe(at50);
    });

    test('checked on a real server: a multiplier 10 caster has 252 at level 22, a Hero 490', () => {
        expect(earnedSpecPoints(10, 22)).toBe(252);
        expect(earnedSpecPoints(20, 22)).toBe(490);
    });

    test('levels 2 to 5 give their own number whatever the class', () => {
        expect(earnedSpecPoints(10, 5)).toBe(14);
        expect(earnedSpecPoints(25, 5)).toBe(14);
        expect(earnedSpecPoints(25, 1)).toBe(0);
    });

    test('from 6 on a level gives multiplier * level / 10, rounded down', () => {
        expect(earnedSpecPoints(15, 6) - earnedSpecPoints(15, 5)).toBe(9);
        expect(earnedSpecPoints(15, 7) - earnedSpecPoints(15, 6)).toBe(10);
    });

    test('half levels run 40.5 to 49.5, each at the level it is in', () => {
        expect(earnedSpecPoints(10, 39, { halfLevel: true })).toBe(earnedSpecPoints(10, 39));
        expect(earnedSpecPoints(10, 40, { halfLevel: true })).toBe(earnedSpecPoints(10, 40) + 20);
        expect(earnedSpecPoints(10, 41)).toBe(earnedSpecPoints(10, 40, { halfLevel: true }) + 41);
        expect(earnedSpecPoints(15, 41, { halfLevel: true })).toBe(earnedSpecPoints(15, 41) + 30);
        expect(earnedSpecPoints(10, 50, { halfLevel: true })).toBe(1494);
    });

    test('each level costs its own number, and free levels nothing', () => {
        expect(specCost(1, 5)).toBe(14);
        expect(specCost(5, 8)).toBe(21);
        expect(specCost(3, 3)).toBe(0);
        expect(specCost(1, 6, 6)).toBe(0);
        expect(specCost(5, 8, 6)).toBe(15);
        expect(specCost(1, 12, 12)).toBe(0);
        expect(specCost(1, 12)).toBe(77);
    });

    test.each([[1, 1], [7, 1], [8, 2], [23, 5], [24, 6], [50, 12]])('at level %i autotrain reaches %i', (level, free) => {
        expect(freeLevels(level)).toBe(free);
    });
});

describe('the current target', () => {
    const b = build('Armsman', target(10, { Slash: 10 }), target(24, { Slash: 18 }), target(50, { Slash: 39 }));

    test.each([[1, 10], [10, 10], [11, 24], [24, 24], [25, 50], [50, 50]])('at level %i it is target %i', (level, wanted) => {
        expect(currentTarget(b, level).level).toBe(wanted);
    });

    test('past the last target it stays the last', () => {
        expect(currentTarget(build('Armsman', target(24, { Slash: 18 })), 30).level).toBe(24);
        expect(nextBuildStep(build('Armsman', target(24, { Slash: 18 })), state(30, 100, { Slash: 18 }))).toEqual({ kind: 'done' });
    });
});

describe('the rule', () => {
    const polearmThenSlash = build('Armsman', target(50, { Polearm: 10, Slash: 5 }));

    test('raises the first listed line, as far as its target', () => {
        expect(nextBuildStep(polearmThenSlash, state(20, 100, { Polearm: 1, Slash: 1 })))
            .toEqual({ kind: 'train', spec: 'Polearm', from: 1, to: 10, cost: 54 });
    });

    test('goes to the next line once the first is at its target', () => {
        expect(nextBuildStep(polearmThenSlash, state(20, 100, { Polearm: 10, Slash: 1 })))
            .toEqual({ kind: 'train', spec: 'Slash', from: 1, to: 5, cost: 14 });
    });

    test('the listed order decides, not the numbers', () => {
        const slashFirst = build('Armsman', target(50, { Slash: 5, Polearm: 10 }));
        expect(nextBuildStep(slashFirst, state(20, 100, { Polearm: 1, Slash: 1 }))).toMatchObject({ kind: 'train', spec: 'Slash' });
    });

    test('raises as far as the points reach', () => {
        expect(nextBuildStep(polearmThenSlash, state(20, 10, { Polearm: 1, Slash: 1 })))
            .toEqual({ kind: 'train', spec: 'Polearm', from: 1, to: 4, cost: 9 });
    });

    test('waits when the next level costs too much, and does not fall through to a cheaper line', () => {
        expect(nextBuildStep(polearmThenSlash, state(20, 5, { Polearm: 5, Slash: 1 })))
            .toEqual({ kind: 'wait', spec: 'Polearm', from: 5, cost: 6, points: 5 });
    });

    test('caps a line at the character level', () => {
        expect(nextBuildStep(polearmThenSlash, state(3, 100, { Polearm: 1, Slash: 1 })))
            .toEqual({ kind: 'train', spec: 'Polearm', from: 1, to: 3, cost: 5 });
    });

    test('a line at the character level lets the next one go', () => {
        expect(nextBuildStep(polearmThenSlash, state(3, 100, { Polearm: 3, Slash: 1 })))
            .toEqual({ kind: 'train', spec: 'Slash', from: 1, to: 3, cost: 5 });
    });

    test('skips a line not learned yet: a base class, or one acquired later', () => {
        expect(nextBuildStep(polearmThenSlash, state(4, 9, { Crush: 1, Slash: 1, Thrust: 1 })))
            .toEqual({ kind: 'train', spec: 'Slash', from: 1, to: 4, cost: 9 });
        expect(nextBuildStep(build('Armsman', target(24, { Parry: 5 })), state(9, 100, { Slash: 1 }))).toEqual({ kind: 'done' });
    });

    test('maps display names from the skill list, and answers with the KeyName', () => {
        expect(nextBuildStep(build('Armsman', target(24, { Shields: 5 })), state(24, 100, { Shield: 1 })))
            .toEqual({ kind: 'train', spec: 'Shields', from: 1, to: 5, cost: 14 });
        expect(nextBuildStep(build('Enchanter', target(24, { Light: 5 })), state(24, 100, { 'Light Magic': 1, 'Mana Magic': 1 })))
            .toEqual({ kind: 'train', spec: 'Light', from: 1, to: 5, cost: 14 });
        expect(nextBuildStep(build('Enchanter', target(24, { Light: 5 })), state(24, 100, { 'Light Magic': 5 }))).toEqual({ kind: 'done' });
    });

    test('done when every line is at its target, with points to spare', () => {
        expect(nextBuildStep(polearmThenSlash, state(20, 100, { Polearm: 10, Slash: 5 }))).toEqual({ kind: 'done' });
    });

    test('a line above its target is no step', () => {
        expect(nextBuildStep(polearmThenSlash, state(20, 100, { Polearm: 15, Slash: 5 }))).toEqual({ kind: 'done' });
    });
});

describe('autotrain in the rule', () => {
    const slash = build('Armsman', target(24, { Slash: 8 }));
    const auto = ['Slash', 'Thrust'];

    test('levels at or below level / 4 cost nothing, and points are not needed for them', () => {
        expect(nextBuildStep(build('Armsman', target(24, { Slash: 6 })), state(24, 0, { Slash: 1 }, auto)))
            .toEqual({ kind: 'train', spec: 'Slash', from: 1, to: 6, cost: 0 });
    });

    test('above them each level costs its own number', () => {
        expect(nextBuildStep(slash, state(24, 7, { Slash: 1 }, auto))).toEqual({ kind: 'train', spec: 'Slash', from: 1, to: 7, cost: 7 });
        expect(nextBuildStep(slash, state(24, 15, { Slash: 1 }, auto))).toEqual({ kind: 'train', spec: 'Slash', from: 1, to: 8, cost: 15 });
        expect(nextBuildStep(slash, state(24, 6, { Slash: 6 }, auto))).toEqual({ kind: 'wait', spec: 'Slash', from: 6, cost: 7, points: 6 });
    });

    test('a line off the list pays for every level', () => {
        expect(nextBuildStep(build('Armsman', target(24, { Crush: 6 })), state(24, 0, { Crush: 1 }, auto)))
            .toEqual({ kind: 'wait', spec: 'Crush', from: 1, cost: 2, points: 0 });
    });

    test('the list is the current class: a base class has none', () => {
        expect(nextBuildStep(build('Armsman', target(24, { Slash: 6 })), state(4, 0, { Slash: 1 })))
            .toEqual({ kind: 'wait', spec: 'Slash', from: 1, cost: 2, points: 0 });
    });

    test('a level paid early comes back once the free levels pass it', () => {
        const path = buildPath(build('Warrior', target(40, { Sword: 10 })));
        const row = (level: number) => path[level - 1]!;
        expect(row(20).specs.Sword).toBe(10);
        expect(row(20).points).toBe(earnedSpecPoints(20, 20) - specCost(1, 10, 5));
        expect(row(40).specs.Sword).toBe(10);
        expect(row(40).points).toBe(earnedSpecPoints(20, 40));
    });
});

describe('lines over the target', () => {
    const b = build('Armsman', target(24, { Polearm: 10 }), target(50, { Polearm: 20 }));

    test('a line beyond its target', () => {
        expect(linesOverTarget(b, state(20, 0, { Polearm: 12 }))).toEqual([{ spec: 'Polearm', level: 12, target: 10 }]);
    });

    test('a line not in the target has target 1, by KeyName', () => {
        expect(linesOverTarget(b, state(20, 0, { Polearm: 10, Shield: 3, Crush: 1 }))).toEqual([{ spec: 'Shields', level: 3, target: 1 }]);
    });

    test('it reads the current target', () => {
        expect(linesOverTarget(b, state(30, 0, { Polearm: 12 }))).toEqual([]);
    });

    test('free levels are not spent: a respec leaves an autotrain line at them', () => {
        expect(linesOverTarget(b, state(24, 0, { Slash: 6 }, ['Slash']))).toEqual([]);
        expect(linesOverTarget(b, state(24, 0, { Slash: 7 }, ['Slash']))).toEqual([{ spec: 'Slash', level: 7, target: 1 }]);
        expect(linesOverTarget(b, state(24, 0, { Slash: 6 }))).toEqual([{ spec: 'Slash', level: 6, target: 1 }]);
    });
});

describe('the problems of a build', () => {
    const ok = (b: Build) => expect(buildProblems(b)).toEqual([]);

    test('a valid build has none', () => {
        ok(build('Armsman', target(24, { Polearm: 24, Slash: 18, Shields: 15, Parry: 5 }), target(50, { Polearm: 50, Shields: 42, Slash: 39, Parry: 13 })));
    });

    test('an unknown class', () => {
        expect(buildProblems(build('Knight', target(24, { Slash: 5 })))).toEqual(['Unknown class "Knight".']);
    });

    test('no targets', () => {
        expect(buildProblems(build('Armsman'))).toEqual(['The build has no targets.']);
    });

    test.each([
        ['Armsman', 'Shield', 'Shields'],
        ['Armsman', 'shields', 'Shields'],
        ['Armsman', 'slash', 'Slash'],
        ['Armsman', 'Crossbow', 'Crossbows'],
        ['Enchanter', 'Light Magic', 'Light'],
        ['Enchanter', 'Enchantment', 'Enchantments'],
        ['Shaman', 'Cave Magic', 'Subterranean'],
    ])('%s: a display or item name, %s, names the KeyName %s', (className, given, key) => {
        expect(buildProblems(build(className, target(24, { [given]: 2 })))).toEqual([`${given}: use the KeyName ${key}`]);
    });

    test('a key that is no trainable line of the class, once per key', () => {
        const problems = buildProblems(build('Wizard', target(24, { Polearm: 5 }), target(50, { Polearm: 5 })));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toStartWith('Polearm is not a trainable line of Wizard. Its lines: ');
        expect(problems[0]).toContain('Fire Magic');
    });

    test('a career line is no trainable line', () => {
        expect(buildProblems(build('Nightshade', target(24, { 'Nightshade Magic': 5 })))[0]).toStartWith('Nightshade Magic is not a trainable line of Nightshade.');
    });

    test('a line above the level of its target', () => {
        expect(buildProblems(build('Armsman', target(10, { Polearm: 11 })))).toEqual(["Target 10: Polearm 11 is above the character's level."]);
    });

    test('a line acquired after its target', () => {
        expect(buildProblems(build('Armsman', target(8, { Parry: 2 })))).toEqual(['Target 8: Parry comes only at level 10.']);
        ok(build('Armsman', target(10, { Parry: 2 })));
    });

    test('a target over budget, at that level', () => {
        ok(build('Armsman', target(24, { Polearm: 24, Shields: 23, Crush: 4 })));
        expect(buildProblems(build('Armsman', target(24, { Polearm: 24, Shields: 23, Crush: 5 }))))
            .toEqual(['Target 24 costs 588 points, and Armsman has 584 by level 24.']);
    });

    test('autotrain is priced in the budget, at the level of the target', () => {
        ok(build('Armsman', target(24, { Polearm: 24, Shields: 23, Slash: 6 })));
        expect(buildProblems(build('Armsman', target(24, { Polearm: 24, Shields: 23, Crush: 6 }))))
            .toEqual(['Target 24 costs 594 points, and Armsman has 584 by level 24.']);
        // At 23 the free levels reach 5, so Slash 6 costs its 6.
        ok(build('Armsman', target(23, { Polearm: 23, Shields: 22, Crush: 4, Slash: 5 })));
        expect(buildProblems(build('Armsman', target(23, { Polearm: 23, Shields: 22, Crush: 4, Slash: 6 }))))
            .toEqual(['Target 23 costs 542 points, and Armsman has 536 by level 23.']);
    });

    test('targets must ascend', () => {
        expect(buildProblems(build('Armsman', target(50, { Slash: 5 }), target(24, { Slash: 5 })))).toEqual(['Target 24 comes after target 50: levels must ascend.']);
        expect(buildProblems(build('Armsman', target(24, { Slash: 5 }), target(24, { Slash: 5 })))).toEqual(['Target 24 comes after target 24: levels must ascend.']);
    });

    test('levels outside 1..50', () => {
        expect(buildProblems(build('Armsman', target(0, {})))).toEqual(['Target 0 is outside levels 1..50.']);
        expect(buildProblems(build('Armsman', target(51, {})))).toEqual(['Target 51 is outside levels 1..50.']);
    });

    test('spec levels below 1', () => {
        expect(buildProblems(build('Armsman', target(24, { Slash: 0 })))).toEqual(['Target 24: Slash 0 is not a spec level of 1 or more.']);
    });

    test('a later target lowering a line', () => {
        expect(buildProblems(build('Armsman', target(24, { Polearm: 20 }), target(50, { Polearm: 10 }))))
            .toEqual(['Target 50 lowers Polearm from 20 in target 24 to 10.']);
    });

    test('a later target leaving a line out lowers it to 1', () => {
        expect(buildProblems(build('Armsman', target(24, { Polearm: 20, Parry: 5 }), target(50, { Polearm: 20 }))))
            .toEqual(['Target 50 lowers Parry from 5 in target 24 to 1.']);
    });

    test('an autotrain line left out stays at its free levels, those of the first level its target governs', () => {
        ok(build('Armsman', target(24, { Slash: 6 }), target(50, { Polearm: 20 })));
        expect(buildProblems(build('Armsman', target(24, { Slash: 13 }), target(50, { Polearm: 20 }))))
            .toEqual(['Target 50 lowers Slash from 13 in target 24 to 6.']);
    });

    test('what buildProblems passes, linesOverTarget never calls over: free levels are fewer at 21 than at 24', () => {
        const fits = build('Reaver', target(20, { Flexible: 20, Slash: 5 }), target(24, { Flexible: 24 }));
        ok(fits);
        for (const level of [21, 22, 23, 24]) expect(linesOverTarget(fits, state(level, 0, { Flexible: level, Slash: 5 }, ['Slash']))).toEqual([]);
        const over = build('Reaver', target(20, { Flexible: 20, Slash: 6 }), target(24, { Flexible: 24 }));
        expect(buildProblems(over)).toEqual(['Target 24 lowers Slash from 6 in target 20 to 5.']);
        expect(linesOverTarget(over, state(21, 0, { Flexible: 21, Slash: 6 }, ['Slash']))).toEqual([{ spec: 'Slash', level: 6, target: 1 }]);
    });

    describe('a class name two realms share', () => {
        const sword = build('Rogue', target(4, { Sword: 4 }));

        test("with a realm, that realm's lines", () => {
            ok(build('Rogue', target(4, { Stealth: 4 })));
            expect(buildProblems(sword, 'midgard')).toEqual([]);
            expect(buildProblems(sword, 'albion')).toEqual(['Sword is not a trainable line of Rogue. Its lines: Stealth, Slash, Thrust.']);
        });

        test("with no realm it is Albion's, and the key names the other", () => {
            expect(buildProblems(sword)).toEqual(['Sword is not a trainable line of Rogue. Its lines: Stealth, Slash, Thrust.']);
            expect(buildProblems(build('MidgardRogue', target(4, { Sword: 4 })))).toEqual([]);
        });

        test("a realm that doesn't have the class leaves it to the class check", () => {
            expect(buildProblems(build('Armsman', target(24, { Polearm: 20 })), 'midgard')).toEqual([]);
        });
    });
});

describe('the path of a build', () => {
    const polearm = getBuild('Armsman', 'Polearm hybrid')!;

    test('a row per level, up to the last target', () => {
        const path = buildPath(polearm);
        expect(path.map(r => r.level)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
        expect(buildPath(build('Armsman', target(12, { Slash: 3 })))).toHaveLength(12);
    });

    test('by default the character starts as its base class and promotes at 5', () => {
        const path = buildPath(polearm);
        expect(path[3]!.specs).toEqual({ Crush: 1, Slash: 4, Thrust: 1 });
        expect(path[4]!.specs.Polearm).toBeGreaterThan(1);
        const promoted = buildPath(polearm, { startAsBaseClass: false });
        expect(promoted[3]!.specs.Polearm).toBe(4);
        expect(promoted[3]!.specs.Slash).toBe(1);
    });

    test('a line comes at its levelAcquired, at 1', () => {
        const path = buildPath(polearm);
        expect(path[8]!.specs.Parry).toBeUndefined();
        expect(path[9]!.specs.Parry).toBe(1);
        expect(path[13]!.specs.Crossbows).toBeUndefined();
        expect(path[14]!.specs.Crossbows).toBe(1);
    });

    test('half levels buy too: a line at level leaves a multiplier 10 caster nothing else until 40.5', () => {
        const path = buildPath(getBuild('Animist', 'Arboreal group')!);
        expect(path[39]!.specs).toEqual({ 'Arboreal Path': 40, 'Creeping Path': 1, 'Verdant Path': 1 });
        expect(path[39]!.points).toBe(0);
        expect(path[40]!.specs).toEqual({ 'Arboreal Path': 41, 'Creeping Path': 6, 'Verdant Path': 1 });
    });

    test('it waits like the rule: points stay banked rather than going to the next line', () => {
        const path = buildPath(build('Enchanter', target(10, { Mana: 10, Light: 10 })));
        expect(path[9]!.specs).toEqual({ Light: 1, Mana: 10, Enchantments: 1 });
        expect(path[9]!.points).toBe(0);
    });

    test('an unknown class throws', () => {
        expect(() => buildPath(build('Knight', target(24, {})))).toThrow('unknown class "Knight"');
    });
});

describe('the catalogue', () => {
    test('39 classes in three realms, 118 builds', () => {
        const byRealm = [1, 2, 3].map(realm => allClassBuilds().filter(c => getClass(c.className)!.realm === realm).length);
        expect(byRealm).toEqual([14, 12, 13]);
        expect(everyBuild()).toHaveLength(118);
    });

    test('every creatable advanced class has builds', () => {
        const classes = getClasses().filter(c => c.creatable && !c.isBaseClass).map(c => c.name).sort();
        expect(allClassBuilds().map(c => c.className).sort()).toEqual(classes);
    });

    test.each(everyBuild().map(b => [`${b.className}: ${b.entry.name}`, b] as const))('%s has no problems', (_, { build: b }) => {
        expect(buildProblems(b)).toEqual([]);
    });

    test.each(everyBuild().map(b => [`${b.className}: ${b.entry.name}`, b] as const))('%s: the rule reaches every target at its level', (_, { build: b }) => {
        for (const startAsBaseClass of [true, false]) {
            const path = buildPath(b, { startAsBaseClass });
            for (const t of b.targets) {
                const row = path[t.level - 1]!;
                expect(Object.fromEntries(Object.keys(t.specs).map(spec => [spec, row.specs[spec]]))).toEqual(t.specs);
            }
            for (const row of path) {
                expect(row.points).toBeGreaterThanOrEqual(0);
                expect(Math.max(...Object.values(row.specs))).toBeLessThanOrEqual(row.level);
            }
        }
    });

    test('a build played by the rule never reads as over its own target: --respec would take those points back', () => {
        for (const { className, entry } of everyBuild()) {
            const cls = getClass(className)!;
            const build = { ...entry, className };
            for (const startAsBaseClass of [true, false]) {
                for (const { level, specs, points } of buildPath(build, { startAsBaseClass })) {
                    const autotrain = startAsBaseClass && level < 5 ? [] : cls.autotrainSpecs;
                    const state = { level, points, autotrain, specs: Object.entries(specs).map(([name, at]) => ({ name, level: at })) };
                    expect(linesOverTarget(build, state), `${className}: ${entry.name} at ${level}`).toEqual([]);
                }
            }
        }
    });

    test('every build has its fields, and sources to look at', () => {
        for (const { className, entry } of everyBuild()) {
            const where = `${className}: ${entry.name}`;
            for (const text of [entry.name, entry.role, entry.why, entry.order]) expect(text.trim().length, where).toBeGreaterThan(0);
            expect(['adapted', 'derived'], where).toContain(entry.basis);
            // 24 and 50 are what the research gives; a stop between them is what makes a plan alternate between lines.
            const levels = entry.targets.map(t => t.level);
            expect(levels, where).toContain(24);
            expect(levels, where).toContain(50);
            expect(entry.sources.length, where).toBeGreaterThan(0);
            for (const s of entry.sources) expect(s.url, where).toStartWith('http');
        }
        for (const c of allClassBuilds()) {
            expect(c.notes.trim().length, c.className).toBeGreaterThan(0);
            expect(new Set(c.builds.map(b => b.name.toLowerCase())).size, c.className).toBe(c.builds.length);
        }
    });

    test('a Runemaster order that buys Minor Raven Bolt at 4 says a Mystic cannot cast it yet', () => {
        expect(getClassSkills('Mystic').find(l => l.specKey === 'Darkness')!.skills).toEqual([]);
        const orders = getClassBuilds('Runemaster')!.builds.map(b => b.order).filter(o => o.includes('Minor Raven Bolt'));
        expect(orders.length).toBeGreaterThan(0);
        for (const order of orders) expect(order).toContain('Minor Raven Bolt, castable only from promotion');
    });

    test('the prose points at nothing private and at no plan that is gone', () => {
        const prose = [
            ...allClassBuilds().map(c => c.notes),
            ...everyBuild().flatMap(({ entry }) => [entry.role, entry.why, entry.order]),
        ];
        const stale = [/SPEC_PLAN/, /\bbots\/\w/, /\bgroups\/\w/, /scratchpad/i, /the owner's/i, /pointsUsed/, /free (full )?respecs? at/i, /LevelUpRespec/];
        for (const pattern of stale) expect(prose.filter(p => pattern.test(p)), String(pattern)).toEqual([]);
    });
});

describe('finding builds', () => {
    test.each(allClassBuilds().map(c => [c.className, getClass(c.className)!.key] as const))('%s under its enum key', (className, key) => {
        expect(getClassBuilds(key)?.className).toBe(className);
    });

    test.each([
        ['Armswoman', 'Armsman'], ['Sorceress', 'Sorcerer'], ['Huntress', 'Hunter'], ['Enchantress', 'Enchanter'], ['Heroine', 'Hero'],
        ['armsman', 'Armsman'], ['Spiritmaster', 'Spiritmaster'],
    ])('%s finds %s', (given, className) => {
        expect(getClassBuilds(given)?.className).toBe(className);
    });

    test('a base class or an unknown name has none', () => {
        expect(getClassBuilds('Fighter')).toBeUndefined();
        expect(getClassBuilds('Knight')).toBeUndefined();
    });

    test('one build by name in any case, carrying its class', () => {
        const b = getBuild('Armswoman', 'polearm HYBRID');
        expect(b?.name).toBe('Polearm hybrid');
        expect(b?.className).toBe('Armsman');
        expect(buildProblems(b!)).toEqual([]);
        expect(getBuild('Armsman', 'Nope')).toBeUndefined();
        expect(getBuild('Knight', 'Polearm hybrid')).toBeUndefined();
    });
});
