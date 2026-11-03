import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getClasses, getPlayableRacesForClass } from '../data/index';
import { allClassBuilds, buildPath, buildProblems, getBuild, type Build } from '../data/builds';
import { buildFileText, buildSourceFile, classBuildsLines, buildsOverviewLines, promotionsWithBuilds, writeBuildFile } from './choose-build';

const CHOOSE = join(import.meta.dir, 'choose-build.ts');
const CREATE = join(import.meta.dir, 'create-bot.ts');
const dir = mkdtempSync(join(tmpdir(), 'choose-build-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function spawn(script: string, ...args: string[]): { code: number; out: string; err: string } {
    const p = Bun.spawnSync(['bun', script, ...args], { env: { ...process.env, DAOC_BOTS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const choose = (...args: string[]) => spawn(CHOOSE, ...args);
function create(...args: string[]) {
    const r = spawn(CREATE, ...args);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
}
const buildFile = (bot: string) => join(dir, bot, 'build.ts');
/** Each import is new, because a test can write the same path twice. */
const load = async (path: string): Promise<Build> => (await import(`${path}?t=${Bun.nanoseconds()}`)).default;

describe('the file it writes', () => {
    test('reads as the character\'s own copy of the catalogue build', () => {
        expect(buildFileText('Mybot', getBuild('Enchanter', 'Mana nuker')!)).toBe(`// Mybot's spec points: Mana nuker, copied from data/builds/enchanter.ts. This copy is the character's own: change it
// freely. bot.trainBuild(trainer) reads it and buys the lines in the order listed (learnings/builds.md).
import type { Build } from '../../data/builds';

export default {
    className: 'Enchanter',
    name: 'Mana nuker',
    targets: [
        { level: 24, specs: { Mana: 24 } },
        { level: 50, specs: { Mana: 49, Light: 22, Enchantments: 5 } },
    ],
} satisfies Build;
`);
    });

    test('every build in the catalogue comes back from its file valid and the same, buying order intact', async () => {
        const out = mkdtempSync(join(dir, 'all-'));
        for (const { className, builds } of allClassBuilds()) {
            expect(existsSync(join(import.meta.dir, '..', buildSourceFile(className)))).toBeTrue();
            for (const b of builds) {
                const botDir = mkdtempSync(join(out, 'b-'));
                const written = await load(await writeBuildFile(botDir, 'Test', { className, name: b.name, targets: b.targets }));
                expect(buildProblems(written)).toEqual([]);
                expect(written).toEqual({ className, name: b.name, targets: b.targets });
                expect(written.targets.map(t => Object.keys(t.specs))).toEqual(b.targets.map(t => Object.keys(t.specs)));
            }
        }
    });

    test('a line of two words is quoted, and a name with an apostrophe stays a string', async () => {
        const botDir = mkdtempSync(join(dir, 'q-'));
        const build: Build = { className: 'Cabalist', name: "Tom's Matter", targets: [{ level: 24, specs: { 'Matter Magic': 23, 'Body Magic': 5 } }] };
        const path = await writeBuildFile(botDir, 'Test', build);
        expect(readFileSync(path, 'utf-8')).toContain("{ 'Matter Magic': 23, 'Body Magic': 5 }");
        expect(await load(path)).toEqual(build);
    });

    test('an empty target stays an empty target: it banks the points up to its level', async () => {
        const pet = getBuild('Enchanter', 'Pet buffer')!;
        const botDir = mkdtempSync(join(dir, 'e-'));
        const written = await load(await writeBuildFile(botDir, 'Test', pet));
        expect(written.targets[0]).toEqual({ level: 4, specs: {} });
        expect(buildPath(written).length).toBe(50);
    });

    test('an existing file stays unless forced', async () => {
        const botDir = mkdtempSync(join(dir, 'f-'));
        const path = join(botDir, 'build.ts');
        writeFileSync(path, '// mine\n');
        const build = getBuild('Enchanter', 'Mana nuker')!;
        await expect(writeBuildFile(botDir, 'Test', build)).rejects.toMatchObject({ code: 'EEXIST' });
        expect(readFileSync(path, 'utf-8')).toBe('// mine\n');
        await writeBuildFile(botDir, 'Test', build, { force: true });
        expect(readFileSync(path, 'utf-8')).toContain('Mana nuker');
    });
});

describe('the listings', () => {
    test('a class in full: name, role, targets, basis and file', () => {
        const text = classBuildsLines('Enchanter')!.join('\n');
        expect(text).toContain('Mana nuker [adapted]');
        expect(text).toContain('Light nuker [derived]');
        expect(text).toContain('Main-assist debuffer');
        expect(text).toContain('level 24: Mana 24');
        expect(text).toContain('level 50: Mana 49, Light 22, Enchantments 5');
        expect(text).toContain('data/builds/enchanter.ts');
    });

    test('any name of the class will do', () => {
        expect(classBuildsLines('enchantress')!.join('\n')).toContain('Mana nuker');
    });

    test('a base class has none of its own and names what it promotes to, not what it can\'t', () => {
        const text = classBuildsLines('Fighter')!.join('\n');
        expect(text).toContain('no builds of its own');
        for (const name of ['Armsman', 'Mercenary', 'Paladin', 'Reaver']) expect(text).toContain(name);
        expect(text).not.toContain('Mauler');
    });

    test('Rogue is a class in two realms, unless the realm says which', () => {
        const both = classBuildsLines('Rogue')!.join('\n');
        expect(both).toContain('Infiltrator');
        expect(both).toContain('Shadowblade');
        const mid = classBuildsLines('Rogue', 'midgard')!.join('\n');
        expect(mid).toContain('Shadowblade');
        expect(mid).not.toContain('Infiltrator');
    });

    test('a name no class answers to is null', () => {
        expect(classBuildsLines('Nope')).toBeNull();
        expect(classBuildsLines('Enchanter', 'albion')).toBeNull();
    });

    test('the overview has every realm and every class with builds', () => {
        const text = buildsOverviewLines().join('\n');
        for (const realm of ['albion:', 'midgard:', 'hibernia:']) expect(text).toContain(realm);
        for (const { className, builds } of allClassBuilds()) {
            expect(text).toContain(className);
            for (const b of builds) expect(text).toContain(b.name);
        }
    });
});

describe('bun bots/choose-build.ts', () => {
    test('with only a bot, the builds of its class from bot.env', () => {
        create('cbench', '--class=Enchanter', '--no-build');
        const r = choose('cbench');
        expect(r.code).toBe(0);
        expect(r.out).toContain('Mana nuker');
        expect(r.out).toContain('bun bots/choose-build.ts cbench "Mana nuker"');
        expect(existsSync(buildFile('cbench'))).toBeFalse();
    });

    test('with a build name, writes a valid file with the character\'s name', async () => {
        create('cbwrite', '--class=Enchanter', '--no-build', '--char=Oscarx');
        const r = choose('cbwrite', 'mana NUKER');
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
        expect(r.out).toContain('Wrote bots/cbwrite/build.ts');
        expect(readFileSync(buildFile('cbwrite'), 'utf-8')).toStartWith("// Oscarx's spec points: Mana nuker,");
        const written = await load(buildFile('cbwrite'));
        expect(buildProblems(written)).toEqual([]);
        expect(written.name).toBe('Mana nuker');
    });

    test('the name needs no quotes', () => {
        create('cbwords', '--class=Enchanter', '--no-build');
        expect(choose('cbwords', 'Mana', 'nuker').code).toBe(0);
        expect(readFileSync(buildFile('cbwords'), 'utf-8')).toContain("name: 'Mana nuker'");
    });

    test('refuses to overwrite without --force', () => {
        create('cbforce', '--class=Enchanter', '--no-build');
        expect(choose('cbforce', 'Mana nuker').code).toBe(0);
        writeFileSync(buildFile('cbforce'), '// mine\n');
        const r = choose('cbforce', 'Light nuker');
        expect(r.code).toBe(1);
        expect(r.err).toContain('--force');
        expect(readFileSync(buildFile('cbforce'), 'utf-8')).toBe('// mine\n');
        expect(choose('cbforce', 'Light nuker', '--force').code).toBe(0);
        expect(readFileSync(buildFile('cbforce'), 'utf-8')).toContain("name: 'Light nuker'");
    });

    test('an unknown build lists the valid ones and writes nothing', () => {
        create('cbunk', '--class=Enchanter', '--no-build');
        const r = choose('cbunk', 'Nope');
        expect(r.code).toBe(1);
        expect(r.err).toContain('Mana nuker, Light nuker, Pet buffer');
        expect(existsSync(buildFile('cbunk'))).toBeFalse();
    });

    test('a base-class bot has none of its own, and --class says what it promotes to', async () => {
        create('cbbase');
        const look = choose('cbbase');
        expect(look.code).toBe(0);
        expect(look.out).toContain('no builds of its own');
        expect(look.out).toContain('bun bots/choose-build.ts cbbase --class=');
        const refused = choose('cbbase', 'Polearm hybrid');
        expect(refused.code).toBe(1);
        expect(refused.err).toContain('Armsman');

        const listed = choose('cbbase', '--class=Armsman');
        expect(listed.code).toBe(0);
        expect(listed.out).toContain('Polearm hybrid');
        expect(listed.out).toContain('--class=Armsman');

        expect(choose('cbbase', 'Polearm hybrid', '--class', 'Armsman').code).toBe(0);
        const written = await load(buildFile('cbbase'));
        expect(written.className).toBe('Armsman');
        expect(buildProblems(written)).toEqual([]);
    });

    test('--class is held to what the character can become', () => {
        create('cbpromo');
        const other = choose('cbpromo', '--class=Wizard');
        expect(other.code).toBe(1);
        expect(other.err).toContain('Fighter promotes to');
        expect(choose('cbpromo', '--class=Thane').err).toContain("unknown class 'Thane' in albion");
        create('cbadv', '--class=Enchanter', '--no-build');
        expect(choose('cbadv', '--class=Eldritch').err).toContain("cbadv's class is Enchanter");
        expect(choose('cbadv', '--class=Enchanter').code).toBe(0);
    });

    test('--class is held to what the race can become: a base class takes races its advanced classes refuse', () => {
        create('cbcelt', '--class=Magician', '--race=Celt');
        const look = choose('cbcelt');
        expect(look.out).toContain('Its race, Celt, can promote to Mentalist.');
        expect(look.out).toContain('bun bots/choose-build.ts cbcelt --class=Mentalist');
        const refused = choose('cbcelt', 'Mana nuker', '--class=Enchanter');
        expect(refused.code).toBe(1);
        expect(refused.err).toContain("cbcelt's race, Celt, can't become Enchanter");
        expect(refused.err).toContain('It can promote to Mentalist');
        expect(existsSync(buildFile('cbcelt'))).toBeFalse();
        expect(choose('cbcelt', '--class=Mentalist').code).toBe(0);

        create('cbelf', '--class=Magician', '--race=Elf');
        expect(choose('cbelf', '--class=Enchanter').code).toBe(0);

        // create-bot refuses this one, so only a bot.env written by hand gets here.
        mkdirSync(join(dir, 'cbinc'), { recursive: true });
        writeFileSync(join(dir, 'cbinc', 'bot.env'), 'REALM=albion\nCLASS=Acolyte\nRACE=Inconnu\n');
        expect(choose('cbinc').out).toContain('Its race, Inconnu, can promote to no class with builds.');
        expect(choose('cbinc', '--class=Cleric').err).toContain('It can promote to no class with builds');
    });

    test('a bot made as a base class hears --class for before and after promoting, since bot.env keeps the base class', () => {
        create('cbkept', '--class=Fighter', '--race=Briton');
        const look = choose('cbkept');
        expect(look.out).toContain('Before or after promoting, name the class, because bot.env keeps Fighter: bun bots/choose-build.ts cbkept --class=Paladin');

        const named = choose('cbkept', 'Polearm hybrid');
        expect(named.code).toBe(1);
        expect(named.err).toContain('bun bots/choose-build.ts cbkept "Polearm hybrid" --class=Paladin');

        expect(choose('cbkept', 'Polearm hybrid', '--class=Armsman').code).toBe(0);
        expect(readFileSync(buildFile('cbkept'), 'utf-8')).toContain("className: 'Armsman'");
    });

    test('every base class and race create-bot takes can promote to a class with builds', () => {
        for (const base of getClasses().filter(c => c.creatable && c.isBaseClass)) {
            for (const race of getPlayableRacesForClass(base.id, base.realm)) {
                expect(promotionsWithBuilds(base, race.id).length, `${race.name} ${base.name}`).toBeGreaterThan(0);
            }
        }
    });

    test('a Midgard Rogue is the Rogue of its realm', () => {
        create('cbmrog', '--realm=midgard', '--class=Rogue');
        expect(choose('cbmrog', '--class=Shadowblade').code).toBe(0);
        expect(choose('cbmrog', '--class=Infiltrator').code).toBe(1);
    });

    test('any name of the class will do', async () => {
        create('cbfem', '--class=Enchanter', '--no-build');
        expect(choose('cbfem', 'Mana nuker', '--class=Enchantress').code).toBe(0);
        expect((await load(buildFile('cbfem'))).className).toBe('Enchanter');
    });

    test('a bot.env without a class asks for one', () => {
        mkdirSync(join(dir, 'cbbare'));
        writeFileSync(join(dir, 'cbbare', 'bot.env'), 'BOT_USERNAME=cbbare\n');
        expect(choose('cbbare').err).toContain('--class=<class>');
        expect(choose('cbbare', 'Mana nuker', '--class=Enchanter').code).toBe(0);
        expect(readFileSync(buildFile('cbbare'), 'utf-8')).toStartWith("// Cbbare's spec points");
    });

    test('no such bot, no bot, a stray flag', () => {
        expect(choose('cbnone').err).toContain('no bots/cbnone/bot.env');
        expect(choose().err).toContain('Usage');
        expect(choose('cbench', '--nope').err).toContain('unknown option --nope');
    });
});
