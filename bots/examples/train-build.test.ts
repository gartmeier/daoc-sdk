import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findNpcSpawns } from '../../data/index';
import { getBuild } from '../../data/builds';
import { writeBuildFile } from '../choose-build';
import main from './train-build';

// The script with a bot's own build.ts, the way bots/choose-build.ts writes it. The walk and its failures are in
// sdk/group/train.test.ts.
describe('train-build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'train-build-'));
    const cwd = process.cwd();
    const trainer = findNpcSpawns({ regionId: 200, realm: 'hibernia', guild: 'Enchanter Trainer' })[0]!;

    beforeAll(async () => {
        const botDir = join(dir, 'bots', 'tbowner');
        mkdirSync(botDir, { recursive: true });
        writeFileSync(join(botDir, 'bot.env'), 'BOT_USERNAME=tbowner\n');
        await writeBuildFile(botDir, 'Tbowner', getBuild('Enchanter', 'Mana nuker')!);
        // findBotEnv looks in the working directory first.
        process.chdir(dir);
    });

    afterAll(() => {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
    });

    function ctx(botUsername: string, args?: { respec?: boolean; radius?: number }) {
        const log: string[] = [];
        const trains = [
            { success: true, message: 'Mana 5 → 7. Over target: Light 8 (target 1)', over: [{ spec: 'Light', level: 8, target: 1 }] },
            { success: true, message: 'Mana 1 → 10, on target for level 10', over: [] },
        ];
        return {
            log,
            context: {
                args,
                sdk: {
                    config: { botUsername },
                    getPlayer: () => ({ className: 'Enchanter', realm: 'hibernia', regionId: trainer.regionId, x: trainer.x + 100, y: trainer.y, level: 10, specPoints: 7, isDead: false }),
                    getSkills: () => ({ specializations: [{ name: 'Mana Magic', level: 5 }, { name: 'Light Magic', level: 8 }] }),
                },
                bot: {
                    walkTo: async () => { log.push('walk'); return { success: true, message: 'there' }; },
                    trainBuild: async (at: string, build: { name: string }) => { log.push(`train ${build.name} at ${at}`); return trains.shift(); },
                    respec: async (at: string) => { log.push(`respec at ${at}`); return { success: true, message: 'Regained 54 points' }; },
                },
            } as any,
        };
    }

    test('a bot without a build hears how to choose one, and its specs', async () => {
        const { log, context } = ctx('nosuchbot');
        expect(await main(context)).toMatchObject({ success: false, reason: 'no_build', specs: ['Mana Magic 5', 'Light Magic 8'], specPoints: 7 });
        expect(log).toEqual([]);
    });

    test('a bot spends by its own build.ts, and without --respec keeps what is over', async () => {
        const { log, context } = ctx('tbowner');
        const r = await main(context);
        expect(log).toEqual([`train Mana nuker at ${trainer.name}`]);
        expect(r.success).toBeTrue();
        expect(r.lines.at(-1)).toContain('--respec');
    });

    test('args.respec, the flag and MCP alike, reaches the respec', async () => {
        const { log, context } = ctx('tbowner', { respec: true });
        const r = await main(context);
        expect(log).toEqual([`train Mana nuker at ${trainer.name}`, `respec at ${trainer.name}`, `train Mana nuker at ${trainer.name}`]);
        expect(r.lines.at(-1)).toContain('on target');
    });

    test('args.radius, the flag and MCP alike, reaches the walk', async () => {
        const { log, context } = ctx('tbowner', { respec: true, radius: 50 });
        const r = await main(context);
        expect(r).toMatchObject({ success: false, reason: 'too_far' });
        expect(r.lines[0]).toContain('limit 50');
        expect(log).toEqual([]);
    });

    test.each([
        [['tdead', '--respek']], [['tdead', '--respec=false']], [['tdead', '--respec=true']], [['tdead', 'respec']], [['tdead', '--radius=far']],
    ])('%j gets the usage line, before it connects', async args => {
        const script = join(import.meta.dir, 'train-build.ts');
        const p = Bun.spawn(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BOT_USERNAME: '', PASSWORD: '', GATEWAY_URL: 'ws://localhost:59999' } });
        const said = await new Response(p.stderr).text();
        expect(await p.exited).toBe(2);
        expect(said).toContain('Usage:');
    });
});
