#!/usr/bin/env bun
// Makes a git worktree ready to test: the server submodules, node_modules and data/generated.
// A new worktree has none of them, and most tests then fail for reasons unrelated to the code.
//
//   bun run setup:worktree                 (the current directory)
//   bun scripts/setup-worktree.ts --hook   (the SessionStart hook in .claude/settings.json)
//
// The hook takes the session's directory from the JSON on stdin and acts only in a linked
// worktree. It prints nothing when there is nothing to do; what it does print reaches the agent
// as context. It always exits 0, so a failed setup can't stop a session.
//
// This only fills in what is missing and never moves a submodule that is checked out. Submodule
// objects are shared with the main checkout when it has them, which on Windows takes 7 s and
// 2 MB instead of 22 s and 383 MB. The docs say a hook starts in the main checkout, so this copy
// may belong to another commit than its target: what it runs there comes from the target.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { missingSubmodules } from './check-submodules';

const nonEmptyDir = (p: string) => existsSync(p) && readdirSync(p).length > 0;

function run(cwd: string, ...cmd: string[]): { ok: boolean; stdout: string; stderr: string } {
    try {
        // No credential prompt: nobody can answer one from a hook, and it would hold up the session.
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        const r = Bun.spawnSync(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        return { ok: r.exitCode === 0, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
    } catch (e) {
        return { ok: false, stdout: '', stderr: String(e) };   // no such directory, or git isn't installed
    }
}

interface Checkout { top: string; commonDir: string; linked: boolean }

/** The checkout `dir` is in; null outside a repo. Only a linked worktree has a git dir of its own. */
function checkoutOf(dir: string): Checkout | null {
    const r = run(dir, 'git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir');
    if (!r.ok) return null;
    const [top, gitDir, commonDir] = r.stdout.split(/\r?\n/) as [string, string, string];
    return { top, commonDir, linked: gitDir !== commonDir };
}

function submoduleUpdate({ top, commonDir, linked }: Checkout, path: string): string[] {
    // The URL this commit names: .git/config is shared between worktrees and may hold an older one.
    const url = run(top, 'git', 'config', '-f', '.gitmodules', '--get', `submodule.${path}.url`);
    const reference = `${commonDir}/modules/${path}`;
    return [
        'git', ...(url.ok ? ['-c', `submodule.${path}.url=${url.stdout}`] : []),
        'submodule', 'update', '--init', ...(linked && existsSync(`${reference}/objects`) ? ['--reference', reference] : []), path,
    ];
}

/** Fills in what's missing, one line of output per step. False if anything is still missing. */
function setUp(checkout: Checkout): boolean {
    const { top } = checkout;
    let steps = 0;
    const step = (what: string, cmd: string[]) => {
        steps++;
        const t0 = performance.now();
        const r = run(top, ...cmd);
        if (r.ok) console.log(`${what}: done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        else console.log(`${what}: failed\n${r.stderr.split(/\r?\n/).slice(-5).join('\n')}`);
        return r.ok;
    };

    const missing = missingSubmodules(top);
    const submodules = missing.map(path => step(path, submoduleUpdate(checkout, path))).every(Boolean);
    const installed = nonEmptyDir(join(top, 'node_modules')) || step('node_modules', [process.execPath, 'install']);
    // After new submodules as well: data already here was copied in, and may predate the pin.
    const needsData = missing.length > 0 || !nonEmptyDir(join(top, 'data', 'generated'));
    const built = submodules && (!needsData || step('data/generated', [process.execPath, 'run', 'data:build']));

    const ok = installed && submodules && built;
    if (!ok) console.log('This worktree is not ready: tests that read server/ or data/ will fail here until it is. Retry with: bun run setup:worktree');
    else if (steps) console.log('This worktree is ready to test (scripts/setup-worktree.ts).');
    return ok;
}

/** `cwd` from the JSON a SessionStart hook gets on stdin. */
async function sessionDir(): Promise<string | null> {
    try {
        const { cwd } = JSON.parse(await Bun.stdin.text()) as { cwd?: unknown };
        return typeof cwd === 'string' ? cwd : null;
    } catch {
        return null;
    }
}

if (import.meta.main) {
    if (process.argv.includes('--hook')) {
        const dir = await sessionDir();
        // Said out loud: staying quiet here would turn the setup off with no sign of it.
        if (dir === null) console.log('setup-worktree: no session directory in the hook input. If this is a worktree, run: bun run setup:worktree');
        const checkout = dir === null ? null : checkoutOf(dir);
        if (checkout?.linked) setUp(checkout);
        process.exit(0);
    }
    const checkout = checkoutOf(process.cwd());
    if (!checkout) {
        console.error('setup-worktree: not in a git checkout');
        process.exit(1);
    }
    process.exit(setUp(checkout) ? 0 : 1);
}
