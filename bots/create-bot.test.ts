import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

    test('the Hibernia default starts armoured (Naturalist, not Guardian)', () => {
        const r = run('cbhibdef', '--realm=hibernia');
        expect(r.code).toBe(0);
        expect(env('cbhibdef')).toMatchObject({ REALM: 'hibernia', CLASS: 'Naturalist', RACE: 'Celt' });
        expect(r.out).not.toContain('warning');
        // Guardian (and Blademaster/Hero/Champion, which start as Guardian) is still allowed, with a warning.
        const g = run('cbguard', '--class=Blademaster');
        expect(g.code).toBe(0);
        expect(g.out).toContain('Guardian gets no starter armour');
    });

    test('--list offers only races create-bot accepts', () => {
        const r = run('--list');
        expect(r.code).toBe(0);
        const line = (cls: string) => r.out.split('\n').find(l => l.trim().startsWith(`${cls} `)) ?? '';
        expect(line('Acolyte')).not.toContain('Inconnu');
        expect(line('Disciple')).not.toContain('Saracen');
        expect(line('Fighter')).toContain('Inconnu');
        expect(line('Guardian')).toContain('[no starter armour]');
        expect(line('Naturalist')).not.toContain('[no starter armour]');
        // Every listed pair is one createBot accepts.
        expect(run('cbaco', '--class=Acolyte').code).toBe(0);
        expect(env('cbaco').RACE).toBe('Briton');
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
