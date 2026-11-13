#!/usr/bin/env bun
// Writes each zone's fixtures for line of sight (server/navmesh/zoneNNN.occluders, sdk/occluders.ts) from the
// zoneNNN.obj buildnav leaves in its output for Recast: the collision meshes of keep walls, buildings and the other
// fixtures, without the terrain, buildnav's tree cylinders and its ladder pads. navmesh:build runs this too; run it
// alone to add occluders next to meshes built before it existed. Like the meshes, the output is derived from client
// assets and gitignored.
//
//   bun run occluders:build                     # every zone with a zoneNNN.obj in buildnav's output
//   bun run occluders:build --zones=252         # specific zones
//   bun run occluders:build --from=<dir> --out=<dir>   # another buildnav zones dir / output dir (default server/navmesh)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeOccluders, fixtureTriangles, occludersName } from '../sdk/occluders';
import { BUILDNAV_OUT, NAVMESH_DIR } from './build-navmesh';

export const OBJ_DIR = join(BUILDNAV_OUT, 'base', 'zones');

export interface OccluderArgs {
    from: string;
    out: string;
    zones: number[] | null;
}

export function parseOccluderArgs(argv: string[]): OccluderArgs {
    const a: OccluderArgs = { from: OBJ_DIR, out: NAVMESH_DIR, zones: null };
    for (const arg of argv) {
        const m = /^--(from|out|zones)=(.+)$/.exec(arg);
        if (!m) throw new Error(`unknown argument ${arg} (expected --zones=<id,...>, --from=<dir> or --out=<dir>)`);
        if (m[1] === 'zones') {
            const parts = m[2]!.split(',');
            if (!parts.every(p => /^\d+$/.test(p.trim()))) throw new Error(`--zones expects comma-separated zone ids, got ${m[2]}`);
            a.zones = parts.map(p => Number(p.trim()));
        } else {
            a[m[1] as 'from' | 'out'] = m[2]!;
        }
    }
    return a;
}

/** One .occluders per zone with a zoneNNN.obj in `from`; zones without one are listed in `none`. */
export function writeOccluders(zoneIds: number[], from: string = OBJ_DIR, out: string = NAVMESH_DIR): { written: { zone: number; triangles: number }[]; none: number[] } {
    mkdirSync(out, { recursive: true });
    const written: { zone: number; triangles: number }[] = [];
    const none: number[] = [];
    for (const id of zoneIds) {
        const obj = join(from, `zone${String(id).padStart(3, '0')}.obj`);
        if (!existsSync(obj)) {
            none.push(id);
            continue;
        }
        const tris = fixtureTriangles(readFileSync(obj, 'utf8'));
        writeFileSync(join(out, occludersName(id)), encodeOccluders(tris));
        written.push({ zone: id, triangles: tris.length / 9 });
    }
    return { written, none };
}

export function main(argv: string[]): void {
    const a = parseOccluderArgs(argv);
    const zones = a.zones ?? (existsSync(a.from) ? readdirSync(a.from).flatMap(f => /^zone(\d{3,})\.obj$/.exec(f)?.[1] ?? []).map(Number) : []);
    if (zones.length === 0) {
        console.log(`no zoneNNN.obj in ${a.from}: run bun run navmesh:build first, or pass --from=<buildnav zones dir>`);
        return;
    }
    const { written, none } = writeOccluders(zones, a.from, a.out);
    const tris = written.reduce((s, w) => s + w.triangles, 0);
    console.log(`${written.length} occluder file(s), ${tris} triangles, in ${a.out}`);
    if (none.length) console.log(`no zoneNNN.obj for zone(s) ${none.join(', ')} in ${a.from}`);
}

if (import.meta.main) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}
