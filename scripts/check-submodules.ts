#!/usr/bin/env bun
// Fails fast when the git submodules the server and data/ need are not checked out,
// and warns when server/db is on another commit than this repo pins.
//
//   bun scripts/check-submodules.ts     (run by `bun run server:up` before docker compose)
//
// server/docker/docker-compose.yml builds the gameserver from ../core and seeds
// MariaDB from ../db/opendaoc-db-core; data/build.ts reads both. After a plain
// `git clone` (without --recurse-submodules) those directories are empty. After a
// merge that moves the server/db pin, the old dump stays checked out until
// `git submodule update`, and an empty db-data volume is seeded from it.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIRED: { path: string; probe: string }[] = [
    { path: 'server/core', probe: 'server/core/GameServer' },
    { path: 'server/db', probe: 'server/db/opendaoc-db-core' },
];

const nonEmptyDir = (p: string) => existsSync(p) && readdirSync(p).length > 0;

/** Submodule paths whose probe directory is missing or empty. */
export function missingSubmodules(root: string): string[] {
    return REQUIRED.filter(r => !nonEmptyDir(join(root, r.probe))).map(r => r.path);
}

/** The trimmed output of a git command in `cwd`; null if it fails or git isn't installed. */
function git(cwd: string, ...args: string[]): string | null {
    try {
        const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' });
        return r.exitCode === 0 ? r.stdout.toString().trim() : null;
    } catch {
        return null;   // not installed
    }
}

/** The commit `root` pins a submodule to; null if git can't say. */
export const pinnedCommit = (root: string, path: string): string | null => git(root, 'rev-parse', `HEAD:./${path}`);

/**
 * The warning for a server/db on another commit than `root` pins; null when they match or
 * git can't say. Only server/db: server/core is edited on purpose (docs/SERVER.md). A
 * different dump can be deliberate too, so this warns and never refuses.
 */
export function dbPinWarning(root: string): string | null {
    const db = join(root, 'server', 'db');
    // A non-empty prefix means server/db is no repo of its own (not initialised, or a plain
    // copy), and `rev-parse HEAD` there would answer with the parent's HEAD.
    if (git(db, 'rev-parse', '--show-prefix') !== '') return null;
    const checkedOut = git(db, 'rev-parse', 'HEAD');
    const pinned = pinnedCommit(root, 'server/db');
    if (!checkedOut || !pinned || checkedOut === pinned) return null;
    return [
        `warning: server/db is checked out at ${checkedOut.slice(0, 7)}, but this repo pins ${pinned.slice(0, 7)}`,
        'MariaDB seeds an empty db-data volume from the checkout; a volume that is already seeded is not affected.',
        'fix: git submodule update server/db   (leave it if you want this dump on purpose)',
    ].join('\n');
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..');
    const missing = missingSubmodules(root);
    if (missing.length) {
        console.error(`missing git submodule(s): ${missing.join(', ')}`);
        console.error(`run: git submodule update --init ${missing.join(' ')}`);
        console.error('(or clone with: git clone --recurse-submodules <url>)');
        process.exit(1);
    }
    const warning = dbPinWarning(root);
    if (warning) console.warn(warning);
}
