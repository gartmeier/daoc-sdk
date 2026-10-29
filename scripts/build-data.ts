#!/usr/bin/env bun
// Builds data/generated/*.json from the OpenDAoC DB dumps and GameServer C# source.
//
//   bun run data:build            # rebuild only stale/missing files
//   bun run data:build --force    # rebuild everything
//   bun run data:build npcs.json  # rebuild specific files

import { join } from 'node:path';
import { clearTableCache, GENERATED_DIR, GENERATED_FILES, isStale, writeGenerated } from '../data/build';

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const only = args.filter(a => !a.startsWith('-')).map(a => (a.endsWith('.json') ? a : `${a}.json`));

const unknown = only.filter(f => !GENERATED_FILES.some(g => g.file === f));
if (unknown.length) {
    console.error(`unknown file(s): ${unknown.join(', ')}\navailable: ${GENERATED_FILES.map(g => g.file).join(', ')}`);
    process.exit(1);
}

const t0 = performance.now();
let built = 0;
for (const g of GENERATED_FILES) {
    if (only.length && !only.includes(g.file)) continue;
    if (!force && !only.length && !isStale(g)) {
        console.log(`  ${g.file.padEnd(24)} up to date`);
        continue;
    }
    const t = performance.now();
    const data = g.build();
    const bytes = writeGenerated(g.file, data);
    built++;
    console.log(`  ${g.file.padEnd(24)} ${String(g.count(data)).padStart(7)} entries  ${(bytes / 1024 / 1024).toFixed(2).padStart(6)} MB  ${Math.round(performance.now() - t)} ms`);
}
clearTableCache();
console.log(`built ${built} file(s) into ${join(GENERATED_DIR)} in ${Math.round(performance.now() - t0)} ms`);
