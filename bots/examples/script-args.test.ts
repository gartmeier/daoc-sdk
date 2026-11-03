import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { scriptArgs, scriptFlags } from './script-args';

const botEnvIn = (dir: string) => (p: string) => p === join(resolve(dir), 'bot.env');

describe('scriptArgs', () => {
    test('bots/examples/x.ts <bot> ...: drops the bot name', () => {
        const argv = ['bun', 'bots/examples/grinder.ts', 'mybot', '60', 'frog'];
        expect(scriptArgs({ argv, env: {}, exists: () => false })).toEqual(['60', 'frog']);
    });

    test('a copy next to bot.env: every positional is an argument', () => {
        const argv = ['bun', 'bots/mybot/grinder.ts', '60', 'frog'];
        expect(scriptArgs({ argv, env: {}, exists: botEnvIn('bots/mybot') })).toEqual(['60', 'frog']);
    });

    test('bun --env-file: credentials in the environment, nothing to drop', () => {
        const argv = ['bun', 'bots/examples/grinder.ts', '60'];
        expect(scriptArgs({ argv, env: { BOT_USERNAME: 'mybot', PASSWORD: 'x' }, exists: () => false })).toEqual(['60']);
    });

    test('flags are not positionals', () => {
        const argv = ['bun', 'bots/examples/caster.ts', '--trace', 'mybot', 'skeleton'];
        expect(scriptArgs({ argv, env: {}, exists: () => false })).toEqual(['skeleton']);
    });
});

describe('scriptFlags', () => {
    test('the flags anywhere after the script, as given, and no words', () => {
        expect(scriptFlags({ argv: ['bun', 'x.ts', 'mybot', '--respec', '60', '--radius=5'] })).toEqual(['--respec', '--radius=5']);
        expect(scriptFlags({ argv: ['bun', 'x.ts', 'respec'] })).toEqual([]);
    });
});

describe('examples and template', () => {
    const dir = import.meta.dir;
    const files = [
        ...readdirSync(dir).filter(f => f.endsWith('.ts') && !f.includes('.test.') && f !== 'script-args.ts').map(f => join(dir, f)),
        join(dir, '..', '_template', 'script.ts'),
    ];

    test.each(files)('%s works standalone and as an MCP execute_code script', file => {
        const src = readFileSync(file, 'utf-8');
        // mcp/execute-code.ts loadScript refuses a runScript() file without an import.meta.main guard.
        expect(src).toMatch(/export default main;/);
        expect(src).toMatch(/if \(import\.meta\.main\)/);
        // Positional arguments go through scriptArgs, never a fixed argv index.
        expect(src).not.toMatch(/process\.argv/);
    });

    test.each(files)('%s imports without side effects and default-exports its main', async file => {
        // What MCP script mode does; import.meta.main is false here, so nothing connects.
        const mod = await import(file);
        expect(typeof mod.default).toBe('function');
    });

    test.each(files.filter(f => !f.includes('_template')))('%s imports scriptArgs by a copy-safe path', file => {
        expect(readFileSync(file, 'utf-8')).toContain(`from '../examples/script-args'`);
    });
});
