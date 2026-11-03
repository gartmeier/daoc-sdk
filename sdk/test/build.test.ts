// loadBuild against a temp root: findBotEnv looks in the cwd first, so process.cwd answers that root for each
// test (no chdir of the shared test process, nothing in the repo's bots/).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { botFolder as folderOf, loadBuild } from '../build';

let root = '';
let cwd: { mockRestore(): void };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'daoc-build-'));
    cwd = spyOn(process, 'cwd').mockReturnValue(root);
});
afterEach(() => {
    cwd.mockRestore();
    rmSync(root, { recursive: true, force: true });
});

/** A bot folder, with this source as its build.ts unless there is none. Returns the path of that file. */
const botFolder = (bot: string, source?: string) => {
    const dir = join(root, 'bots', bot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.env'), '');
    const path = join(dir, 'build.ts');
    if (source !== undefined) writeFileSync(path, source);
    return path;
};
const build = (name: string, specs: string) => `export default { className: 'Enchanter', name: '${name}', targets: [{ level: 24, specs: ${specs} }] };`;
const failure = (bot: string): Promise<string> => loadBuild(bot).then(() => { throw new Error('it loaded'); }, (e: Error) => e.message);

describe('loadBuild', () => {
    test('null for a bot with no folder, and for one with no build.ts', async () => {
        expect(await loadBuild('nobodyhere')).toBeNull();
        botFolder('nobuild');
        expect(await loadBuild('nobuild')).toBeNull();
    });

    test('the default export, written the way a private file writes it', async () => {
        botFolder('mybot', `import type { Build } from '../../data/builds';\nexport default { className: 'Enchanter', name: 'Mana', targets: [{ level: 24, specs: { Mana: 16 } }] } satisfies Build;\n`);
        expect(await loadBuild('mybot')).toEqual({ className: 'Enchanter', name: 'Mana', targets: [{ level: 24, specs: { Mana: 16 } }] });
    });

    describe('a folder and a username that differ', () => {
        const named = (bot: string, env: string, name: string) => {
            botFolder(bot, build(name, '{ Mana: 16 }'));
            writeFileSync(join(root, 'bots', bot, 'bot.env'), env);
        };

        test('by username, the folder whose bot.env names it', async () => {
            named('alias', 'BOT_USERNAME=login\n', 'Mine');
            expect((await loadBuild('login'))!.name).toBe('Mine');
            expect(folderOf('login')).toBe('alias');
        });

        test('by folder too, as a group member names it', async () => {
            named('tank1', 'BOT_USERNAME=tankuser\n', 'Tank');
            expect((await loadBuild('tank1'))!.name).toBe('Tank');
            expect(folderOf('tank1')).toBe('tank1');
        });

        test('a folder of that name that plays another account gives way to the one that names it', async () => {
            named('other', 'BOT_USERNAME=someone\n', 'Theirs');
            named('mine', 'BOT_USERNAME=other\n', 'Mine');
            expect((await loadBuild('other'))!.name).toBe('Mine');
        });

        test('username and folder alike ignore case, as the gateway does', async () => {
            named('alias', 'BOT_USERNAME=Login\n', 'Mine');
            expect((await loadBuild('login'))!.name).toBe('Mine');
        });

        test('two folders that name one account: the folder of that name', async () => {
            named('other', 'BOT_USERNAME=other\n', 'Theirs');
            named('clone', 'BOT_USERNAME=other\n', 'Mine');
            expect((await loadBuild('other'))!.name).toBe('Theirs');
        });

        test('null when no folder has that name or names it', async () => {
            named('alias', 'BOT_USERNAME=login\n', 'Mine');
            expect(await loadBuild('nobody')).toBeNull();
            expect(folderOf('nobody')).toBe('nobody');
        });
    });

    describe('a class name two realms share', () => {
        const rogue = (realm: string) => {
            botFolder('k2', `export default { className: 'Rogue', name: 'K2', targets: [{ level: 4, specs: { Sword: 4 } }] };`);
            writeFileSync(join(root, 'bots', 'k2', 'bot.env'), `BOT_USERNAME=k2\nREALM=${realm}\n`);
        };

        test('a Midgard bot\'s Rogue is Midgard\'s', async () => {
            rogue('midgard');
            expect((await loadBuild('k2'))!.name).toBe('K2');
        });

        test('an Albion bot\'s is Albion\'s, which has no Sword', async () => {
            rogue('albion');
            expect(await failure('k2')).toContain('Sword is not a trainable line of Rogue');
        });
    });

    test('memoized until the file changes', async () => {
        const path = botFolder('memo', build('First', '{ Mana: 16 }'));
        const first = await loadBuild('memo');
        expect(await loadBuild('memo')).toBe(first!);
        writeFileSync(path, build('Second', '{ Mana: 12 }'));
        utimesSync(path, new Date(), new Date(Date.now() + 5000));
        expect((await loadBuild('memo'))!.name).toBe('Second');
    });

    test('a build removed from the folder is gone', async () => {
        const path = botFolder('gone', build('Here', '{ Mana: 16 }'));
        expect(await loadBuild('gone')).not.toBeNull();
        rmSync(path);
        expect(await loadBuild('gone')).toBeNull();
    });

    test.each([
        ['it throws while loading', `throw new Error('boom');`, 'boom'],
        ['it does not parse', `export default {`, 'failed to load'],
        ['it exports nothing as default', `export const build = 1;`, 'needs a default export'],
        ['the default is not an object', `export default 'Mana';`, 'needs a default export'],
        ['no class', `export default { name: 'x', targets: [] };`, 'className'],
        ['no name', `export default { className: 'Enchanter', targets: [] };`, 'name'],
        ['targets are not a list', `export default { className: 'Enchanter', name: 'x', targets: { level: 24 } };`, 'targets'],
        ['a target has no specs', `export default { className: 'Enchanter', name: 'x', targets: [{ level: 24 }] };`, 'each target'],
        ['an unknown class', `export default { className: 'Wizzard', name: 'x', targets: [{ level: 24, specs: {} }] };`, 'Unknown class "Wizzard"'],
        ['a display name', `export default { className: 'Enchanter', name: 'x', targets: [{ level: 24, specs: { 'Mana Magic': 16 } }] };`, 'Mana Magic: use the KeyName Mana'],
        ['a line above the level', build('x', '{ Mana: 25 }'), "above the character's level"],
        ['over the budget', `export default { className: 'Enchanter', name: 'x', targets: [{ level: 10, specs: { Mana: 10, Light: 10 } }] };`, 'costs'],
    ])('%s is an error naming the file', async (_what, source, says) => {
        const path = botFolder('broken', source);
        const message = await failure('broken');
        expect(message).toStartWith(`${path}: `);
        expect(message).toContain(says);
    });

    test('every problem is in the error', async () => {
        botFolder('many', `export default { className: 'Enchanter', name: 'x', targets: [{ level: 24, specs: { Shield: 3, Mana: 25 } }] };`);
        const message = await failure('many');
        expect(message).toContain('Shield');
        expect(message).toContain('Mana 25');
    });

    test('a file put right loads', async () => {
        const path = botFolder('fixed', build('x', '{ Mana: 25 }'));
        await failure('fixed');
        writeFileSync(path, build('x', '{ Mana: 24 }'));
        utimesSync(path, new Date(), new Date(Date.now() + 5000));
        expect((await loadBuild('fixed'))!.targets[0]!.specs).toEqual({ Mana: 24 });
    });
});
