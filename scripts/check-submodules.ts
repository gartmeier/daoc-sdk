#!/usr/bin/env bun
// Fails fast when the git submodules the server and data/ need are not checked out.
//
//   bun scripts/check-submodules.ts     (run by `bun run server:up` before docker compose)
//
// server/docker/docker-compose.yml builds the gameserver from ../core and seeds
// MariaDB from ../db/opendaoc-db-core; data/build.ts reads both. After a plain
// `git clone` (without --recurse-submodules) those directories are empty.

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

if (import.meta.main) {
    const missing = missingSubmodules(join(import.meta.dir, '..'));
    if (missing.length) {
        console.error(`missing git submodule(s): ${missing.join(', ')}`);
        console.error(`run: git submodule update --init ${missing.join(' ')}`);
        console.error('(or clone with: git clone --recurse-submodules <url>)');
        process.exit(1);
    }
}
