// groups/create-group.ts as a user runs it: bots and groups in a temp root, the script from the repo.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPO_ROOT } from '../index';

const roots: string[] = [];

afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function create(classes: Record<string, string>, ...flags: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'daoc-create-group-'));
    roots.push(root);
    for (const [bot, cls] of Object.entries(classes)) {
        mkdirSync(join(root, 'bots', bot), { recursive: true });
        writeFileSync(join(root, 'bots', bot, 'bot.env'), `CLASS=${cls}\nREALM=midgard\nCHAR_NAME=${bot}\n`);
    }
    const run = Bun.spawnSync([process.execPath, join(REPO_ROOT, 'groups', 'create-group.ts'), 'mid', ...Object.keys(classes), ...flags], {
        cwd: root, env: { ...process.env, DAOC_GROUPS_DIR: join(root, 'groups') },
    });
    return { exitCode: run.exitCode, stderr: run.stderr.toString(), stdout: run.stdout.toString(), created: existsSync(join(root, 'groups', 'mid', 'group.json')) };
}

describe('create-group: no tank', () => {
    // "bun groups/create-group.ts mid petbon petspi pethun gives nuker, nuker, melee. Run 20261103-154125: '» recover: no living tank to pull' for all 30 s".
    test('warns, and creates the group all the same', () => {
        const r = create({ petbon: 'Bonedancer', petspi: 'Spiritmaster', pethun: 'Hunter' });
        expect(r.exitCode).toBe(0);
        expect(r.created).toBe(true);
        expect(r.stderr).toContain('no member is a tank');
        expect(r.stderr).toContain('--role=<bot>:tank');
    });

    test('a member with the role, by flag or by class: no word of it', () => {
        expect(create({ petbon: 'Bonedancer', pethun: 'Hunter' }, '--role=pethun:tank').stderr).not.toContain('no member is a tank');
        expect(create({ petbon: 'Bonedancer', petwar: 'Warrior' }).stderr).not.toContain('no member is a tank');
    });
});
