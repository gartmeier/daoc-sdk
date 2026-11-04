import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dbPinWarning, missingSubmodules } from './check-submodules';

const root = mkdtempSync(join(tmpdir(), 'submodules-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function addProbes(dir: string) {
    mkdirSync(join(dir, 'server', 'core', 'GameServer'), { recursive: true });
    writeFileSync(join(dir, 'server', 'core', 'GameServer', 'x.cs'), '');
    mkdirSync(join(dir, 'server', 'db', 'opendaoc-db-core'), { recursive: true });
    writeFileSync(join(dir, 'server', 'db', 'opendaoc-db-core', 'mob.sql'), '');
}

describe('missingSubmodules', () => {
    test('empty clone: both submodules missing', () => {
        mkdirSync(join(root, 'server', 'core'), { recursive: true });   // git leaves an empty dir
        expect(missingSubmodules(root)).toEqual(['server/core', 'server/db']);
    });

    test('checked out: nothing missing', () => {
        addProbes(root);
        expect(missingSubmodules(root)).toEqual([]);
    });

    test('this checkout has them', () => {
        expect(missingSubmodules(join(import.meta.dir, '..'))).toEqual([]);
    });
});

function git(cwd: string, ...args: string[]): string {
    const config = ['user.name=test', 'user.email=test@example.com', 'commit.gpgsign=false', 'protocol.file.allow=always'];
    const r = Bun.spawnSync(['git', ...config.flatMap(c => ['-c', c]), ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.toString().trim();
}

/** A repo with server/db as a real submodule, pinned to and checked out at the dump's newest commit. */
function repoWithDb() {
    const dir = mkdtempSync(join(root, 'repo-'));
    const dump = join(dir, 'dump');
    const parent = join(dir, 'parent');
    mkdirSync(dump);
    mkdirSync(parent);
    git(dump, 'init', '-q');
    git(dump, 'commit', '-q', '--allow-empty', '-m', 'old dump');
    const old = git(dump, 'rev-parse', 'HEAD');
    git(dump, 'commit', '-q', '--allow-empty', '-m', 'new dump');
    const pinned = git(dump, 'rev-parse', 'HEAD');
    git(parent, 'init', '-q');
    git(parent, 'submodule', 'add', '-q', dump, 'server/db');
    git(parent, 'commit', '-q', '-m', 'pin the dump');
    return { dump, parent, db: join(parent, 'server', 'db'), old, pinned };
}

/** check-submodules.ts as `server:up` runs it: a copy in `repo` takes that for its checkout. */
function runScript(repo: string, env: Record<string, string | undefined> = process.env) {
    const script = join(repo, 'scripts', 'check-submodules.ts');
    mkdirSync(join(repo, 'scripts'));
    cpSync(join(import.meta.dir, 'check-submodules.ts'), script);
    const r = Bun.spawnSync([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: r.exitCode, stderr: r.stderr.toString() };
}

/** A test that spawns git and bun many times, which is slow on Windows. */
const gitTest = (name: string, fn: () => void) => test(name, fn, 30_000);

describe('dbPinWarning', () => {
    gitTest('checkout on the pinned commit: no warning', () => {
        expect(dbPinWarning(repoWithDb().parent)).toBeNull();
    });

    gitTest('checkout left behind by a merge: names both commits and the fix', () => {
        const { parent, db, old, pinned } = repoWithDb();
        git(db, 'checkout', '-q', old);
        expect(dbPinWarning(parent)).toContain(`checked out at ${old.slice(0, 7)}, but this repo pins ${pinned.slice(0, 7)}`);
        expect(dbPinWarning(parent)).toContain('git submodule update server/db');
    });

    gitTest('the fix it names clears it', () => {
        const { parent, db, old } = repoWithDb();
        git(db, 'checkout', '-q', old);
        git(parent, 'submodule', 'update', '-q', 'server/db');
        expect(dbPinWarning(parent)).toBeNull();
    });

    gitTest('plain directories, no git repo: no warning', () => {
        const dir = mkdtempSync(join(root, 'plain-'));
        addProbes(dir);
        expect(dbPinWarning(dir)).toBeNull();
    });

    gitTest('server/db missing: no warning', () => {
        expect(dbPinWarning(mkdtempSync(join(root, 'bare-')))).toBeNull();
    });

    gitTest('submodule not initialised: the parent HEAD is not taken for its commit', () => {
        const { parent, db } = repoWithDb();
        git(parent, 'submodule', 'deinit', '-q', '-f', 'server/db');
        expect(git(db, 'rev-parse', 'HEAD')).toBe(git(parent, 'rev-parse', 'HEAD'));   // the trap
        expect(dbPinWarning(parent)).toBeNull();
    });

    gitTest('server/db a plain copy in a git repo that pins nothing: no warning', () => {
        const dir = mkdtempSync(join(root, 'unpinned-'));
        git(dir, 'init', '-q');
        git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
        addProbes(dir);
        expect(dbPinWarning(dir)).toBeNull();
    });

    gitTest('server/core off its pin: no warning', () => {
        const { dump, parent, old } = repoWithDb();
        git(parent, 'submodule', 'add', '-q', dump, 'server/core');
        git(parent, 'commit', '-q', '-m', 'pin core');
        git(join(parent, 'server', 'core'), 'checkout', '-q', old);
        expect(dbPinWarning(parent)).toBeNull();
    });
});

describe('check-submodules.ts', () => {
    gitTest('off the pin: warns on stderr and exits 0, so server:up goes on', () => {
        const { parent, db, old, pinned } = repoWithDb();
        git(db, 'checkout', '-q', old);
        addProbes(parent);
        const { exitCode, stderr } = runScript(parent);
        expect(exitCode).toBe(0);
        expect(stderr).toContain(`checked out at ${old.slice(0, 7)}, but this repo pins ${pinned.slice(0, 7)}`);
    });

    gitTest('on the pin: quiet', () => {
        const { parent } = repoWithDb();
        addProbes(parent);
        expect(runScript(parent)).toEqual({ exitCode: 0, stderr: '' });
    });

    gitTest('off the pin with git not installed: quiet', () => {
        const { parent, db, old } = repoWithDb();
        git(db, 'checkout', '-q', old);
        addProbes(parent);
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
        expect(runScript(parent, { ...env, PATH: mkdtempSync(join(root, 'no-git-')) })).toEqual({ exitCode: 0, stderr: '' });
    });

    gitTest('a missing submodule still refuses', () => {
        const { exitCode, stderr } = runScript(mkdtempSync(join(root, 'missing-')));
        expect(exitCode).toBe(1);
        expect(stderr).toContain('missing git submodule(s): server/core, server/db');
    });
});
