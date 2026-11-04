import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureLine, TrainerWindowFixture } from '../scripts/trainer-window-decode';
import { pinnedCommit } from '../scripts/check-submodules';
import { buildStyles, clearTableCache, parseAutotrain, parseSpecConstants } from './build';
import {
    abilityName, getBaselineSkills, getClass, getClasses, getClassSkills, getSpell, getStyleProcs, getStyles, getTrainableLines, type ClassSkillLine,
} from './index';

const ROOT = join(import.meta.dir, '..');
const RECAPTURE = 'bun scripts/capture-trainer-windows.ts';
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'trainer-windows.json'), 'utf8')) as TrainerWindowFixture;

const compact = (line: ClassSkillLine): string[] => line.skills.map(s => `${s.kind}|${s.specLevel}|${s.name}|${s.id}`);

/** What differs between data and the window of one line, as sentences; empty when they are equal in content and order. */
function lineDiff(path: string, data: string[], window: string[]): string[] {
    if (data.join('\n') === window.join('\n')) return [];
    const onlyData = data.filter(s => !window.includes(s));
    const onlyWindow = window.filter(s => !data.includes(s));
    const out = [
        ...onlyData.map(s => `${path}: data has ${s}, the window doesn't`),
        ...onlyWindow.map(s => `${path}: the window has ${s}, data doesn't`),
    ];
    if (out.length) return out;
    const at = data.findIndex((s, i) => s !== window[i]);
    return [`${path}: same skills in another order, from position ${at}: data ${data[at]}, window ${window[at]}`];
}

/** Every difference between data and the fixture for one class, line by line. */
function classDiff(key: string, lines: FixtureLine[]): string[] {
    const data = getClassSkills(key);
    const names = (ls: { name?: string; displayName?: string }[]) => ls.map(l => l.displayName ?? l.name).join(', ');
    if (names(data) !== names(lines)) return [`${key}: lines differ. Data: ${names(data)}. Window: ${names(lines)}`];
    const autotrain = getClass(key)!.autotrainSpecs;
    return lines.flatMap((line, i) => {
        const mine = data[i]!;
        const flag = autotrain.includes(mine.specKey);
        return [
            ...(flag === line.autotrain ? [] : [`${key} / ${line.name}: autotrain is ${flag} in data and ${line.autotrain} in the window`]),
            ...lineDiff(`${key} / ${line.name}`, compact(mine), line.skills),
        ];
    });
}

/** Fails with every difference, readable, and what to do about it. */
function expectNoDiffs(diffs: string[]): void {
    if (!diffs.length) return;
    const shown = diffs.slice(0, 40).join('\n  ');
    throw new Error(`data/skills.ts and the captured trainer windows disagree, ${diffs.length} difference(s):\n  ${shown}${diffs.length > 40 ? `\n  ... and ${diffs.length - 40} more` : ''}\n`
        + `If data/build.ts or data/skills.ts changed, this is a bug there. If the server really changed (server/core or server/db moved), run: ${RECAPTURE}`);
}

describe('bun data/skills.ts <class> <line>', () => {
    const cli = (...args: string[]) => {
        const p = Bun.spawnSync(['bun', join(import.meta.dir, 'skills.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' });
        return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };

    test.each([['Two Handed'], ['two handed']])('%s lists what the line gives', line => {
        const r = cli('Armsman', line);
        expect(r.code).toBe(0);
        expect(r.out).toContain('key="Two Handed"');
    });

    test('a line it does not know names the lines there are, and fails', () => {
        const r = cli('Armsman', 'Two-Handed');
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
        expect(r.err).toContain('Armsman has no line "Two-Handed"');
        expect(r.err).toContain('Two Handed');
        expect(r.err).toContain('Polearm');
    });
});

describe('getClassSkills against real trainer windows', () => {
    test('the fixture holds one window per creatable class, captured at level 50', () => {
        expect(fixture.level).toBe(50);
        expect(Object.keys(fixture.classes).sort()).toEqual(getClasses().filter(c => c.creatable).map(c => c.key).sort());
        expect(Object.keys(fixture.classes).length).toBe(54);
    });

    test('the C# rules are only as fresh as the capture', () => {
        const pinned = pinnedCommit(ROOT, 'server/core');
        if (pinned && pinned !== fixture.serverCore)
            console.log(`server/core is pinned at ${pinned.slice(0, 7)} and the trainer windows were captured at ${fixture.serverCore.slice(0, 7)}, whose C# rules this test can't see: run ${RECAPTURE}`);
    });

    for (const key of Object.keys(fixture.classes)) {
        test(key, () => expectNoDiffs(classDiff(key, fixture.classes[key]!)));
    }

    test('every class together: 216 lines, 3539 skills, 43 of them songs', () => {
        const lines = Object.values(fixture.classes).flat();
        expect(lines.length).toBe(216);
        const skills = lines.flatMap(l => l.skills);
        expect(skills.length).toBe(3539);
        expect(skills.filter(s => s.startsWith('song|')).length).toBe(43);
    });
});

describe('getClassSkills', () => {
    test('a song is a song, with the id the window sends', () => {
        const regrowth = getClassSkills('Bard').find(l => l.specKey === 'Regrowth')!;
        expect(regrowth.skills.find(s => s.name === 'Chant of Healing')).toMatchObject({ kind: 'song', specLevel: 6, id: 4971 });
        expect(getSpell(regrowth.skills.find(s => s.name === 'Chant of Healing')!.dataId!)!.instrumentRequirement).not.toBe(0);
    });

    test('keys and display names: Mana is what /train takes, Mana Magic what the window shows', () => {
        const line = getClassSkills('Enchanter').find(l => l.specKey === 'Mana')!;
        expect(line.displayName).toBe('Mana Magic');
        expect(line.skills.length).toBe(25);
    });

    test('a base class has its lines and no skills before promotion', () => {
        const magician = getClassSkills('Magician');
        expect(magician.map(l => l.skills.length)).toEqual([0, 0]);
    });

    test('a line appears at the level it is acquired, and the skills of the others stay the same', () => {
        const at = (level: number) => getClassSkills('Armsman', { characterLevel: level });
        expect(at(9).length).toBe(5);
        expect(at(10).length).toBe(7);
        expect(at(14).length).toBe(7);
        expect(at(15).length).toBe(8);
        expect(at(1).map(compact)).toEqual(at(50).slice(0, 5).map(compact));
    });

    test('class names: a female name works, a shared display name needs the key', () => {
        expect(getClassSkills('Huntress')).toEqual(getClassSkills('Hunter'));
        expect(() => getClassSkills('Rogue')).toThrow('AlbionRogue or MidgardRogue');
        expect(getClassSkills('AlbionRogue').length).toBe(3);
        expect(() => getClassSkills('Plumber')).toThrow('unknown class "Plumber"');
    });
});

describe('getTrainableLines', () => {
    test('every line with the level it comes at, in window order', () => {
        const lines = getTrainableLines('Blademaster');
        expect(lines.map(l => l.specKey)).toEqual(getClassSkills('Blademaster').map(l => l.specKey));
        expect(lines.find(l => l.specKey === 'Celtic Dual')!.levelAcquired).toBe(5);
    });

    test('a character level leaves out what it has not acquired', () => {
        expect(getTrainableLines('Blademaster', { characterLevel: 4 }).map(l => l.specKey)).not.toContain('Celtic Dual');
        expect(getTrainableLines('Blademaster', { characterLevel: 5 }).map(l => l.specKey)).toContain('Celtic Dual');
    });

    test('a class row the trainer never shows is left out: the career lines (Specialization.cs:411-414)', () => {
        expect(getClass('Armsman')!.specializations.map(s => s.spec)).toContain('ArmsmanCareer');
        expect(getTrainableLines('Armsman').map(l => l.specKey)).not.toContain('ArmsmanCareer');
    });
});

describe('getBaselineSkills', () => {
    test('Enchanter: Aurora Blast is baseline, at character level 50', () => {
        const all = getBaselineSkills('Enchanter').flatMap(l => l.skills);
        const blast = all.filter(s => s.name === 'Aurora Blast');
        expect(blast.length).toBeGreaterThan(0);
        expect(blast.at(-1)).toMatchObject({ kind: 'spell', specLevel: 50 });
    });

    test('no baseline spell shows in the window of its class', () => {
        for (const key of Object.keys(fixture.classes)) {
            const window = new Set(getClassSkills(key).flatMap(l => l.skills).filter(s => s.dataId !== undefined && s.kind !== 'style').map(s => s.dataId));
            for (const s of getBaselineSkills(key).flatMap(l => l.skills)) expect(window.has(s.dataId)).toBe(false);
        }
    });

    test('a melee class has none, 29 classes have some, 1740 rows in all', () => {
        expect(getBaselineSkills('Warrior').flatMap(l => l.skills)).toEqual([]);
        const counts = Object.keys(fixture.classes).map(key => getBaselineSkills(key).flatMap(l => l.skills).length);
        expect(counts.filter(n => n > 0).length).toBe(29);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(1740);
    });
});

describe('abilityName', () => {
    test('a tier in roman numerals, the row for the level, and a raw column that does not parse', () => {
        expect(abilityName('Guard', 'Guard %n', 2)).toBe('Guard II');
        expect(abilityName('Evade', '1|Evade I;2|Evade II', 2)).toBe('Evade II');
        expect(abilityName('Odd', 'x|Broken', 1)).toBe('x|Broken');
    });
});

describe('style rows and procs', () => {
    const warrior = getClass('Warrior')!;

    test('the window id and the data id are two things', () => {
        const brutalize = getStyles().find(s => s.classId === warrior.id && s.name === 'Brutalize')!;
        expect(brutalize.styleId).toBe(513);
        expect(brutalize.id).not.toBe(513);
    });

    test('Slam on Shield procs the stun the delve reports', () => {
        const slam = getStyles().find(s => s.classId === warrior.id && s.styleId === 512)!;
        expect(slam.name).toBe('Slam');
        expect(getStyleProcs(slam, warrior.id).map(p => p.spellId)).toEqual([20407]);
    });

    test('a style without procs has no field and no procs', () => {
        const plain = getStyles().find(s => !s.procs)!;
        expect('procs' in plain).toBe(false);
        expect(getStyleProcs(plain, warrior.id)).toEqual([]);
    });

    test('the row for this class, else class 0, on the styles that have both', () => {
        const procs = (name: string, classId: number) =>
            getStyleProcs(getStyles().find(s => s.name === name && s.classId === classId)!, classId).map(p => p.spellId);
        expect(procs("Clan's Might", 32)).toEqual([991340]);
        expect(procs('Aurora Borealis', 23)).toEqual([20101]);
        expect(procs('Dark Tendrils', 11)).toEqual([20208]);
    });

    test('a proc joins on style.ID, so it reaches every class row of that ID, and needs a spell that exists', () => {
        const id = getStyles().find(s => s.classId !== 0)!.id;
        const styles = buildStyles([
            { StyleID: id, SpellID: 5, ClassID: 0, Chance: 100 },
            { StyleID: id, SpellID: 6, ClassID: 0, Chance: 100 },
        ], [{ SpellID: 5 }]);
        const withProcs = styles.filter(s => s.procs);
        expect(withProcs.map(s => s.id)).toEqual(styles.filter(s => s.id === id).map(s => s.id));
        for (const s of withProcs) expect(s.procs).toEqual([{ spellId: 5, chance: 100, classId: 0 }]);
        clearTableCache();
    });
});

describe('autotrain parsing', () => {
    const SPECS = parseSpecConstants(`
        public abstract class Abilities { public const string Sprint = "Sprint"; }
        public abstract class Specs { public const string Longbow = "Longbows"; public const string Chants        = "Chants"; }
    `);

    test('the Specs constants, and no others', () => {
        expect([...SPECS]).toEqual([['Longbow', 'Longbows'], ['Chants', 'Chants']]);
    });

    test('the array with its override', () => {
        expect(parseAutotrain(`class A { static readonly string[] AutotrainableSkills = new[] { Specs.Slash, Specs.Chants };
            public override IList<string> GetAutotrainableSkills() { return AutotrainableSkills; } }`)).toEqual(['Slash', 'Chants']);
    });

    test('the array without an override is none: ClassHunter.cs:9 with its override commented out', () => {
        expect(parseAutotrain('class A { static readonly string[] AutotrainableSkills = new[] { Specs.Slash }; }')).toBeUndefined();
        expect(parseAutotrain('class A { }')).toBeUndefined();
    });

    test('an override that does something else fails loudly', () => {
        expect(() => parseAutotrain('class A { public override IList<string> GetAutotrainableSkills() { return Compute(); } }')).toThrow('cannot parse GetAutotrainableSkills in A');
    });

    test('the classes that have it: 11, 17 rows, Hunter not among them', () => {
        const rows = getClasses().filter(c => c.autotrainSpecs.length).map(c => [c.key, c.autotrainSpecs]);
        expect(Object.fromEntries(rows)).toEqual({
            Armsman: ['Slash', 'Thrust'], Infiltrator: ['Stealth'], Mercenary: ['Slash', 'Thrust'], Minstrel: ['Instruments'], Nightshade: ['Stealth'],
            Paladin: ['Slash', 'Chants'], Ranger: ['Recurve Bow'], Reaver: ['Slash', 'Flexible'], Scout: ['Longbows'], Shadowblade: ['Stealth'], Warrior: ['Axe', 'Hammer', 'Sword'],
        });
    });

    test('a class autotrains only its own lines', () => {
        for (const c of getClasses()) for (const key of c.autotrainSpecs) expect(c.specializations.map(s => s.spec)).toContain(key);
    });
});
