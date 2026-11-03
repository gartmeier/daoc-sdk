import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'setup-worktree.ts');
const root = mkdtempSync(join(tmpdir(), 'setup-worktree-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
    const config = ['user.name=test', 'user.email=test@example.com', 'commit.gpgsign=false', 'protocol.file.allow=always'];
    const r = Bun.spawnSync(['git', ...config.flatMap(c => ['-c', c]), ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.toString().trim();
}

function commitFile(repo: string, path: string, content: string) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', content);
    return git(repo, 'rev-parse', 'HEAD');
}

/** A main checkout with server/core and server/db as real submodules, a dependency to install and a data build. */
function mainCheckout() {
    const dir = mkdtempSync(join(root, 'repo-'));
    const [coreOrigin, dbOrigin, parent] = [join(dir, 'core'), join(dir, 'db'), join(dir, 'parent')];
    for (const r of [coreOrigin, dbOrigin, parent]) {
        mkdirSync(r);
        git(r, 'init', '-q');
    }
    commitFile(coreOrigin, 'GameServer/x.cs', 'core');
    const old = commitFile(dbOrigin, 'opendaoc-db-core/mob.sql', 'old');
    const pinned = commitFile(dbOrigin, 'opendaoc-db-core/mob.sql', 'pinned');
    writeFileSync(join(parent, '.gitignore'), 'node_modules/\ndata/generated/\nbun.lock\n');
    writeFileSync(join(parent, 'package.json'), JSON.stringify({
        name: 'fixture', dependencies: { dep: 'file:./dep' }, scripts: { 'data:build': 'bun write-data.ts' },
    }));
    mkdirSync(join(parent, 'dep'));
    writeFileSync(join(parent, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
    writeFileSync(join(parent, 'write-data.ts'), [
        `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';`,
        `mkdirSync('data/generated', { recursive: true });`,
        `writeFileSync('data/generated/mobs.json', readFileSync('server/db/opendaoc-db-core/mob.sql', 'utf8'));`,
    ].join('\n'));
    git(parent, 'submodule', 'add', '-q', coreOrigin, 'server/core');
    git(parent, 'submodule', 'add', '-q', dbOrigin, 'server/db');
    git(parent, 'add', '.');
    git(parent, 'commit', '-q', '-m', 'pin both');
    return { parent, dbOrigin, old, pinned };
}

const newWorktree = (parent: string) => {
    const wt = mkdtempSync(join(root, 'wt-'));
    git(parent, 'worktree', 'add', '-q', '--detach', wt);
    return wt;
};

/** Without its objects in the main checkout, the submodule can only come from its URL. */
function forgetSubmodule(parent: string, path: string) {
    git(parent, 'submodule', 'deinit', '-q', '-f', path);
    rmSync(join(parent, '.git', 'modules', path), { recursive: true, force: true });
}

function runScript(args: string[], cwd: string, stdin: Buffer | 'ignore') {
    const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
    const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd, env, stdin, stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: r.exitCode, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
}

/** As the SessionStart hook runs it: from anywhere, with the session's directory in the JSON on stdin. */
const hook = (stdin: string) => runScript(['--hook'], root, Buffer.from(stdin));
const hookIn = (cwd: string) => hook(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }));
/** As `bun run setup:worktree` runs it: on the current directory. */
const manual = (cwd: string) => runScript([], cwd, 'ignore');

const data = (wt: string) => readFileSync(join(wt, 'data', 'generated', 'mobs.json'), 'utf8');
const alternates = (submodule: string) => git(submodule, 'rev-parse', '--path-format=absolute', '--git-path', 'objects/info/alternates');

/** A test that spawns git and bun many times, which is slow on Windows. */
const gitTest = (name: string, fn: () => void) => test(name, fn, 60_000);

describe('a linked worktree', () => {
    let main: ReturnType<typeof mainCheckout>;
    beforeAll(() => {
        main = mainCheckout();
        git(join(main.parent, 'server', 'db'), 'checkout', '-q', main.old);   // the pin decides, not what main has out
    }, 60_000);

    gitTest('the hook fills everything from the pins, sharing objects with the main checkout, and a second run is silent', () => {
        const wt = newWorktree(main.parent);
        const first = hookIn(wt);
        expect(first.exitCode).toBe(0);
        for (const part of ['server/core', 'server/db', 'node_modules', 'data/generated']) expect(first.stdout).toContain(part);
        expect(git(join(wt, 'server', 'db'), 'rev-parse', 'HEAD')).toBe(main.pinned);
        expect(existsSync(join(wt, 'server', 'core', 'GameServer', 'x.cs'))).toBe(true);
        expect(existsSync(join(wt, 'node_modules', 'dep'))).toBe(true);
        expect(data(wt)).toBe('pinned');
        expect(readFileSync(alternates(join(wt, 'server', 'db')), 'utf8')).toContain('modules/server/db');
        expect(git(wt, 'status', '--short')).toBe('');
        expect(hookIn(wt)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    });

    gitTest('run by hand it works on the current directory', () => {
        const wt = newWorktree(main.parent);
        const r = manual(wt);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain('server/db');
        expect(data(wt)).toBe('pinned');
    });

    gitTest('data copied in before the submodules is rebuilt from them', () => {
        const wt = newWorktree(main.parent);
        mkdirSync(join(wt, 'data', 'generated'), { recursive: true });
        writeFileSync(join(wt, 'data', 'generated', 'mobs.json'), 'copied');
        expect(hookIn(wt).exitCode).toBe(0);
        expect(data(wt)).toBe('pinned');
    });

    gitTest('a submodule already checked out stays where it is', () => {
        const wt = newWorktree(main.parent);
        expect(hookIn(wt).exitCode).toBe(0);
        const db = join(wt, 'server', 'db');
        git(db, 'checkout', '-q', main.old);
        expect(hookIn(wt)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
        expect(git(db, 'rev-parse', 'HEAD')).toBe(main.old);
    });

    gitTest('without objects in the main checkout it clones from the URL in .gitmodules, whatever the shared config says', () => {
        const { parent, pinned } = mainCheckout();
        forgetSubmodule(parent, 'server/core');
        forgetSubmodule(parent, 'server/db');
        git(parent, 'config', 'submodule.server/db.url', join(root, 'nowhere'));
        const wt = newWorktree(parent);
        expect(hookIn(wt).exitCode).toBe(0);
        const db = join(wt, 'server', 'db');
        expect(git(db, 'rev-parse', 'HEAD')).toBe(pinned);
        expect(existsSync(alternates(db))).toBe(false);
        expect(git(parent, 'config', 'submodule.server/db.url')).toBe(join(root, 'nowhere'));
    });

    gitTest('a submodule it cannot fetch: named in the output, no data built, the hook exits 0 and by hand exits 1', () => {
        const { parent, dbOrigin } = mainCheckout();
        forgetSubmodule(parent, 'server/db');
        rmSync(dbOrigin, { recursive: true, force: true });
        const wt = newWorktree(parent);
        const r = hookIn(wt);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain('server/db');
        expect(r.stdout).toContain('bun run setup:worktree');
        expect(existsSync(join(wt, 'data', 'generated'))).toBe(false);
        expect(existsSync(join(wt, 'server', 'core', 'GameServer', 'x.cs'))).toBe(true);
        const byHand = manual(wt);
        expect(byHand.exitCode).toBe(1);
        expect(byHand.stdout).toContain('server/db');
    });
});

describe('the hook elsewhere', () => {
    gitTest('the main checkout is left alone, even with something missing', () => {
        const { parent } = mainCheckout();
        forgetSubmodule(parent, 'server/db');
        expect(hookIn(parent)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
        expect(existsSync(join(parent, 'node_modules'))).toBe(false);
        expect(existsSync(join(parent, 'data', 'generated'))).toBe(false);
        expect(existsSync(join(parent, 'server', 'db', 'opendaoc-db-core'))).toBe(false);
    });

    gitTest('a directory outside any repo, or one that is gone: quiet', () => {
        const quiet = { exitCode: 0, stdout: '', stderr: '' };
        expect(hookIn(mkdtempSync(join(tmpdir(), 'no-repo-')))).toEqual(quiet);
        expect(hookIn(join(root, 'gone'))).toEqual(quiet);
    });

    gitTest('input it cannot read: says so, and still exits 0', () => {
        for (const stdin of ['not json', '{}', 'null', '{"cwd":"C:\\Users"}']) {
            const r = hook(stdin);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain('bun run setup:worktree');
        }
    });
});
