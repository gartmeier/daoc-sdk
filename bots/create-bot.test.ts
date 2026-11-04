import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildProblems } from '../data/builds';
import { parseEnvFile } from '../sdk/index';

const SCRIPT = join(import.meta.dir, 'create-bot.ts');
const dir = mkdtempSync(join(tmpdir(), 'create-bot-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]): { code: number; out: string; err: string } {
    const p = Bun.spawnSync(['bun', SCRIPT, ...args], { env: { ...process.env, DAOC_BOTS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const env = (name: string) => parseEnvFile(readFileSync(join(dir, name, 'bot.env'), 'utf-8'));

describe('create-bot', () => {
    test('a base class with --build: the hint names an advanced class its --race can become, and following it works', () => {
        const celt = run('cbhint1', '--class=Magician', '--race=Celt', '--build=Foo');
        expect(celt.code).toBe(1);
        expect(celt.err).toContain('--class=Mentalist --build=.. starts as a Magician.');
        expect(celt.err).not.toContain('--class=Eldritch --build=..');
        expect(run('cbhint2', '--class=Mentalist', '--race=Celt', '--build=Light nuker').code).toBe(0);
    });

    test('with no --race the hint names the first advanced class: create-bot picks a race it takes', () => {
        const r = run('cbhint3', '--class=Magician', '--build=Foo');
        expect(r.code).toBe(1);
        expect(r.err).toContain('--class=Eldritch --build=.. starts as a Magician.');
        expect(run('cbhint4', '--class=Eldritch', '--build=Light nuker').code).toBe(0);
    });

    test('writes bot.env with the validated character', () => {
        const r = run('cbalpha', '--class=Mage');
        expect(r.code).toBe(0);
        const e = env('cbalpha');
        expect(e).toMatchObject({ BOT_USERNAME: 'cbalpha', CHAR_NAME: 'Cbalpha', REALM: 'albion', CLASS: 'Mage', SHOW_CHAT: 'true' });
        expect(e.PASSWORD).toMatch(/^[A-Za-z0-9]{12}$/);
        expect(readFileSync(join(dir, 'cbalpha', 'script.ts'), 'utf-8')).not.toContain('{{');
    });

    test('accepts space-separated flag values', () => {
        const r = run('--realm', 'midgard', 'cbmid', '--class', 'Viking');
        expect(r.code).toBe(0);
        expect(existsSync(join(dir, 'midgard'))).toBe(false);
        expect(env('cbmid')).toMatchObject({ REALM: 'midgard', CLASS: 'Viking' });
    });

    test('a value flag without a value is an error, not a bot name', () => {
        const r = run('--realm');
        expect(r.code).toBe(1);
        expect(r.err).toContain('--realm needs a value');
        const empty = run('cbempty', '--realm=');
        expect(empty.code).toBe(1);
        expect(existsSync(join(dir, 'cbempty'))).toBe(false);
    });

    test('infers the realm from a unique class name', () => {
        expect(run('cbhib', '--class=Guardian').code).toBe(0);
        expect(env('cbhib').REALM).toBe('hibernia');
    });

    test('the Hibernia default starts armoured', () => {
        const r = run('cbhibdef', '--realm=hibernia');
        expect(r.code).toBe(0);
        expect(env('cbhibdef')).toMatchObject({ REALM: 'hibernia', CLASS: 'Naturalist', RACE: 'Celt' });
        expect(r.out).not.toContain('warning');
        // Blademaster, Hero and Champion start as Guardian, which has its armour in the pinned dump.
        const g = run('cbguard', '--class=Blademaster', '--no-build');
        expect(g.code).toBe(0);
        expect(g.out).not.toContain('no starter armour');
    });

    test('--list offers only races create-bot accepts', () => {
        const r = run('--list');
        expect(r.code).toBe(0);
        const line = (cls: string) => r.out.split('\n').find(l => l.trim().startsWith(`${cls} `)) ?? '';
        expect(line('Acolyte')).not.toContain('Inconnu');
        expect(line('Disciple')).not.toContain('Saracen');
        expect(line('Necromancer')).not.toContain('Saracen'); // starts as a Disciple
        expect(line('Fighter')).toContain('Inconnu');
        expect(line('Guardian')).not.toContain('[no starter armour]');
        expect(line('Naturalist')).not.toContain('[no starter armour]');
        // Every listed pair is one createBot accepts.
        expect(run('cbaco', '--class=Acolyte').code).toBe(0);
        expect(env('cbaco').RACE).toBe('Briton');
    });

    test('refuses the pairs with no start location, an advanced class by its base class', () => {
        for (const cls of ['Necromancer', 'Disciple']) {
            const r = run('cbsaracen', `--class=${cls}`, '--race=Saracen');
            expect(r.code).toBe(1);
            expect(r.err).toContain('no startuplocation row for Saracen Disciple');
            expect(existsSync(join(dir, 'cbsaracen'))).toBe(false);
        }
        expect(run('cbnecro', '--class=Necromancer', '--race=Inconnu', '--no-build').code).toBe(0);
    });

    test('refuses a character name another local bot already uses', () => {
        // cbalpha → Cbalpha; cbother --char=Cbalpha collides.
        const r = run('cbother', '--char=Cbalpha');
        expect(r.code).toBe(1);
        expect(r.err).toContain('bots/cbalpha/');
        expect(existsSync(join(dir, 'cbother'))).toBe(false);
        // Digits map to letters: cb1 → Cbb, and cbb → Cbb.
        expect(run('cb1').code).toBe(0);
        expect(run('cbb').err).toContain('bots/cb1/');
    });

    test('rejects bad names and invalid characters', () => {
        expect(run('examples').err).toContain('reserved');
        expect(run('has_under').err).toContain('letters and digits');
        expect(run('thirteenchars').err).toContain('12 characters');
        expect(run('cbbad', '--realm=albion', '--class=Viking').err).toContain('--realm=midgard');
        expect(run('cbbad', '--class=Nope').err).toContain('unknown class');
    });
});

describe('create-bot builds', () => {
    test('--build writes the build and the summary says so', async () => {
        const r = run('cbbuild', '--class=Enchanter', '--build=Mana nuker');
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
        expect(r.out).toContain('build.ts');
        expect(r.out).toContain('build     Mana nuker, from data/builds/enchanter.ts');
        expect(r.out).toContain('level 50: Mana 49, Light 22, Enchantments 5');
        expect(r.out).toContain('bun bots/examples/train-build.ts cbbuild');
        const file = join(dir, 'cbbuild', 'build.ts');
        expect(readFileSync(file, 'utf-8')).toStartWith("// Cbbuild's spec points: Mana nuker, copied from data/builds/enchanter.ts.");
        const written = (await import(file)).default;
        expect(written.className).toBe('Enchanter');
        expect(buildProblems(written)).toEqual([]);
    });

    test('--build takes any case, and a space before its value', () => {
        expect(run('cbcase', '--class=Enchanter', '--build', 'mana NUKER').code).toBe(0);
        expect(readFileSync(join(dir, 'cbcase', 'build.ts'), 'utf-8')).toContain("name: 'Mana nuker'");
    });

    test('a class with builds needs one: it stops with the list and how to choose, and creates nothing', () => {
        const r = run('cbnochoice', '--class=Enchanter');
        expect(r.code).toBe(1);
        expect(r.err).toContain('Mana nuker [adapted]');
        expect(r.err).toContain('--build="Mana nuker"');
        expect(r.err).toContain('--no-build');
        expect(existsSync(join(dir, 'cbnochoice'))).toBe(false);
    });

    test('--no-build is for test characters: no file, and the summary says how to choose', () => {
        const r = run('cbtest', '--class=Enchanter', '--no-build');
        expect(r.code).toBe(0);
        expect(existsSync(join(dir, 'cbtest', 'build.ts'))).toBe(false);
        expect(r.out).toContain('(--no-build): bun bots/choose-build.ts cbtest');
        expect(r.out).not.toContain('train-build');
    });

    test('an unknown build lists the valid ones and creates nothing', () => {
        const r = run('cbunknown', '--class=Enchanter', '--build=Nope');
        expect(r.code).toBe(1);
        expect(r.err).toContain('Mana nuker, Light nuker, Pet buffer');
        expect(existsSync(join(dir, 'cbunknown'))).toBe(false);
    });

    test('a base class needs no build, and hears when to choose one, with the command', () => {
        for (const [name, args, cls, promoted] of [
            ['cbfight', [], 'Fighter', 'Armsman'],
            ['cbvik', ['--realm=midgard'], 'Viking', 'Thane'],
            ['cbnat', ['--realm=hibernia'], 'Naturalist', 'Warden'],
        ] as const) {
            const r = run(name, ...args);
            expect(r.code).toBe(0);
            expect(existsSync(join(dir, name, 'build.ts'))).toBe(false);
            expect(r.out).toContain(`${cls} has no builds of its own`);
            expect(r.out).toContain(promoted);
            expect(r.out).toContain(`bun bots/choose-build.ts ${name} --class=`);
        }
    });

    test('what a base class hears follows its race: it takes races its advanced classes refuse', () => {
        const celt = run('cbcelt', '--realm=hibernia', '--class=Magician', '--race=Celt');
        expect(celt.code).toBe(0);
        expect(celt.out).toContain('Choose one when promoting to Mentalist');
        expect(celt.out).toContain('bun bots/choose-build.ts cbcelt --class=Mentalist');
        expect(celt.out).not.toContain('Enchanter');
    });

    test('a base class refuses --build, and says how to have one from the start', () => {
        const r = run('cbbasebuild', '--build=Polearm hybrid');
        expect(r.code).toBe(1);
        expect(r.err).toContain('no builds of its own');
        expect(r.err).toContain('--class=Paladin --build=');
        expect(existsSync(join(dir, 'cbbasebuild'))).toBe(false);
    });

    test('--build and --no-build contradict each other', () => {
        const r = run('cbboth', '--class=Enchanter', '--build=Mana nuker', '--no-build');
        expect(r.code).toBe(1);
        expect(r.err).toContain('contradict');
    });

    test('--builds lists an overview and exits, creating nothing', () => {
        const r = run('--builds');
        expect(r.code).toBe(0);
        expect(r.out).toContain('hibernia:');
        expect(r.out).toContain('from Magician:');
        expect(r.out).toContain('Enchanter');
        expect(r.out).toContain('Mana nuker');
    });

    test('--builds=<class>, --builds <class> and --class with --builds show that class', () => {
        for (const args of [['--builds=Enchanter'], ['--builds', 'Enchanter'], ['--class=Enchanter', '--builds'], ['--builds', '--class=Enchanter']]) {
            const r = run(...args);
            expect(r.code).toBe(0);
            expect(r.out).toContain('Mana nuker [adapted]');
            expect(r.out).toContain('data/builds/enchanter.ts');
            expect(r.out).not.toContain('albion:');
        }
    });

    test('--builds takes a base class, a realm and a wrong name', () => {
        const fighter = run('--builds=Fighter');
        expect(fighter.code).toBe(0);
        expect(fighter.out).toContain('no builds of its own');
        expect(fighter.out).toContain('Armsman');
        const rogue = run('--builds=Rogue', '--realm=midgard');
        expect(rogue.out).toContain('Shadowblade');
        expect(rogue.out).not.toContain('Infiltrator');
        expect(run('--builds=Nope').err).toContain("unknown class 'Nope'");
        expect(run('--builds=Rogue', '--realm=nowhere').err).toContain("unknown realm 'nowhere'");
    });

    test('--help names the new flags', () => {
        const r = run('--help');
        for (const flag of ['--build=', '--no-build', '--builds[=']) expect(r.out).toContain(flag);
    });
});
