// The stealthers' and archers' guides (learnings/classes/): their build tables are what the buying rule gives, and
// each bot's character loads its class kit. As guides.test.ts holds the other classes'.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPath, earnedSpecPoints, getBuild, getClassBuilds } from '../../data/builds';
import { getClass } from '../../data/index';

const guide = (name: string) => readFileSync(join(import.meta.dir, `../../learnings/classes/${name}.md`), 'utf-8').replaceAll('\r\n', '\n');

describe('stealther and archer guides', () => {
    for (const className of ['Infiltrator', 'Nightshade', 'Shadowblade', 'Scout', 'Ranger', 'Hunter']) {
        test(`${className}: every build's table is what the rule gives`, () => {
            const text = guide(className.toLowerCase());
            const multiplier = getClass(className)!.specializationMultiplier;
            const builds = getClassBuilds(className)!.builds.map(b => b.name);
            for (const level of [10, 20, 24, 30, 40, 50]) {
                const cells = builds.map(name => {
                    const build = getBuild(className, name)!;
                    const specs = buildPath(build)[level - 1]!.specs;
                    return Object.keys(build.targets.at(-1)!.specs).map(line => specs[line] ?? 1).join(' / ');
                });
                expect(text).toContain(`| ${level} | ${earnedSpecPoints(multiplier, level)} | ${cells.join(' | ')} |`);
            }
        });
    }
});
