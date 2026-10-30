#!/usr/bin/env bun
// Writes exact outdoor terrain grids (server/navmesh/zoneNNN.terrain) from a local DAoC client, for
// the SDK's ground height (sdk/terrain.ts, sdk/ground.ts). navmesh:build runs this too; run it alone
// to add grids next to meshes built before it existed. Takes a few seconds for 42 zones.
//
//   bun run terrain:build                          # every zone with a zoneNNN.nav in server/navmesh
//   bun run terrain:build --zones=0,1,200          # specific zones
//   bun run terrain:build --daoc="D:\Games\DAoC"   # client dir (default: $DAOC_DIR or C:\Program Files (x86)\OpenDAoC)
//
// The grids are what buildnav exports as terrain (server/buildnav/Client/ZoneExporter/Heightmap.cs,
// World/Zone2.cs): terrain.pcx * scalefactor + offset.pcx * offsetfactor from zones/zoneNNN/datNNN.mpk,
// with the water.pcx river index and the sector.dat [riverNN] heights. Only outdoor zones (type 0)
// have a heightmap. Like the meshes, the output is derived from client assets and gitignored.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAVMESH_DIR, parseIni, readMpkEntry } from './build-navmesh';
import { encodeTerrain, NO_WATER, terrainName, type TerrainGrid } from '../sdk/terrain';

const DEFAULT_DAOC = 'C:\\Program Files (x86)\\OpenDAoC';
/** zones.dat offsets and sizes are in units of 8192. */
const ZONE_UNIT = 8192;

export interface ZoneGeometry {
    id: number;
    regionId: number;
    xoff: number;
    yoff: number;
    width: number;
    height: number;
    /** 0 = outdoor terrain; cities, dungeons and housing have no heightmap (Zone2.HasHeightmap). */
    type: number;
    /** Client subfolder of the region's addon ('frontiers', 'phousing', 'tutorial') or '' (World/Region.cs). */
    addon: string;
}

const num = (v: string | undefined) => {
    const n = Number(v ?? NaN);
    return Number.isFinite(n) ? n : 0;
};

/** Region placement of every enabled zone in zones.dat. */
export function parseZoneGeometry(text: string): ZoneGeometry[] {
    const ini = parseIni(text);
    const addon = (regionId: number) => {
        const r = ini.get(`region${String(regionId).padStart(3, '0')}`);
        return (['phousing', 'frontiers', 'tutorial'] as const).find(k => r?.has(k)) ?? '';
    };
    const out: ZoneGeometry[] = [];
    for (const [name, it] of ini) {
        const m = /^zone(\d+)/.exec(name);
        if (!m || it.get('enabled') === '0') continue;
        out.push({
            id: Number(m[1]), regionId: num(it.get('region')), type: num(it.get('type')),
            xoff: num(it.get('region_offset_x')) * ZONE_UNIT, yoff: num(it.get('region_offset_y')) * ZONE_UNIT,
            width: num(it.get('width')) * ZONE_UNIT, height: num(it.get('height')) * ZONE_UNIT,
            addon: addon(num(it.get('region'))),
        });
    }
    return out;
}

/** 8-bit PCX (RLE), pixels row-major by y: px[y * w + x]. */
export function readPcx(buf: Buffer): { w: number; h: number; px: Uint8Array } {
    if (buf.length < 128 || buf[0] !== 0x0a) throw new Error('not a PCX image');
    const w = buf.readUInt16LE(8) - buf.readUInt16LE(4) + 1;
    const h = buf.readUInt16LE(10) - buf.readUInt16LE(6) + 1;
    const lineBytes = buf.readUInt16LE(66) * buf[65]!;
    const px = new Uint8Array(w * h);
    let p = 128;
    for (let y = 0; y < h; y++) {
        for (let i = 0; i < lineBytes && p < buf.length;) {
            const b = buf[p++]!;
            const [count, value] = (b & 0xc0) === 0xc0 ? [b & 0x3f, buf[p++]!] : [1, b];
            for (let c = 0; c < count; c++, i++) if (i < w) px[y * w + i] = value;
        }
    }
    return { w, h, px };
}

/**
 * One file of a zone's datNNN.mpk, looked up like buildnav's ClientData.OpenFirst over AddonPaths:
 * newtowns/zones, then <addon>/zones, then zones; the first archive that has the file wins. Null if none.
 */
export function zoneFileReader(daoc: string, zone: Pick<ZoneGeometry, 'id' | 'addon'>): (name: string) => Buffer | null {
    const id3 = String(zone.id).padStart(3, '0');
    const paths = ['newtowns', 'Newtowns', zone.addon, ''].map(dir => join(daoc, dir, 'zones', `zone${id3}`, `dat${id3}.mpk`));
    // Windows matches newtowns and Newtowns to the same folder: read it once.
    const archives = [...new Map(paths.filter(f => existsSync(f)).map(f => [f.toLowerCase(), f])).values()].map(f => readFileSync(f));
    return name => {
        for (const mpk of archives) {
            try {
                return readMpkEntry(mpk, name);
            } catch {
                // not in this archive
            }
        }
        return null;
    };
}

/** The terrain grid of one zone from its datNNN.mpk, or null for zones without a heightmap. */
export function zoneTerrain(daoc: string, zone: ZoneGeometry): TerrainGrid | null {
    if (zone.type !== 0) return null;
    const read = zoneFileReader(daoc, zone);
    const sectorDat = read('sector.dat');
    const terrainPcx = read('terrain.pcx');
    const offsetPcx = read('offset.pcx');
    if (!sectorDat || !terrainPcx || !offsetPcx) return null;
    const sector = new Map([...parseIni(sectorDat.toString('latin1'))].map(([k, v]) => [k.toLowerCase(), v]));
    const scale = num(sector.get('terrain')?.get('scalefactor'));
    const offsetFactor = num(sector.get('terrain')?.get('offsetfactor'));
    const terrain = readPcx(terrainPcx);
    const offset = readPcx(offsetPcx);
    const size = terrain.w;
    if (terrain.h !== size || offset.w !== size || offset.h !== size) throw new Error(`zone ${zone.id}: terrain.pcx/offset.pcx are not both ${size}x${size}`);
    let water: Uint8Array = new Uint8Array(size * size).fill(NO_WATER);
    const waterPcx = read('water.pcx'); // zones without rivers have none
    if (waterPcx) {
        const w = readPcx(waterPcx);
        if (w.w !== size || w.h !== size) throw new Error(`zone ${zone.id}: water.pcx is not ${size}x${size}`);
        water = w.px;
    }
    const rivers = num(sector.get('waterdefs')?.get('num'));
    const waterHeights = Int32Array.from({ length: rivers }, (_, i) => num(sector.get(`river${String(i).padStart(2, '0')}`)?.get('height')));
    const heights = new Uint16Array(size * size);
    for (let k = 0; k < heights.length; k++) {
        const h = terrain.px[k]! * scale + offset.px[k]! * offsetFactor;
        if (h > 0xffff) throw new Error(`zone ${zone.id}: terrain height ${h} does not fit 16 bits`);
        heights[k] = h;
    }
    return { zoneId: zone.id, regionId: zone.regionId, xoff: zone.xoff, yoff: zone.yoff, width: zone.width, height: zone.height, size, heights, water, waterHeights };
}

/** Write zoneNNN.terrain for each zone id that has a heightmap; returns the ids written and those without one. */
export function writeTerrainGrids(daoc: string, zoneIds: number[], outDir: string = NAVMESH_DIR): { written: number[]; none: number[] } {
    const mpk = join(daoc, 'zones', 'zones.mpk');
    if (!existsSync(mpk)) throw new Error(`no zones/zones.mpk in the DAoC client dir ${daoc} (pass --daoc=<dir>)`);
    const table = new Map(parseZoneGeometry(readMpkEntry(readFileSync(mpk), 'zones.dat').toString('latin1')).map(z => [z.id, z]));
    mkdirSync(outDir, { recursive: true });
    const written: number[] = [];
    const none: number[] = [];
    for (const id of zoneIds) {
        const zone = table.get(id);
        const grid = zone ? zoneTerrain(daoc, zone) : null;
        if (!grid) {
            none.push(id);
            continue;
        }
        writeFileSync(join(outDir, terrainName(id)), encodeTerrain(grid));
        written.push(id);
    }
    return { written, none };
}

export function parseTerrainArgs(argv: string[], env: Record<string, string | undefined> = process.env): { daoc: string; zones: number[] | null } {
    let daoc = env.DAOC_DIR || DEFAULT_DAOC;
    let zones: number[] | null = null;
    for (const arg of argv) {
        const m = /^--(daoc|zones)=(.+)$/.exec(arg);
        if (!m) throw new Error(`unknown argument ${arg} (expected --daoc=<dir> or --zones=<id,...>)`);
        if (m[1] === 'daoc') {
            daoc = m[2]!;
        } else {
            const parts = m[2]!.split(',');
            if (!parts.every(p => /^\d+$/.test(p.trim()))) throw new Error(`--zones expects comma-separated zone ids, got ${m[2]}`);
            zones = parts.map(p => Number(p.trim()));
        }
    }
    return { daoc, zones };
}

export function main(argv: string[]): void {
    const a = parseTerrainArgs(argv);
    const zones = a.zones ?? (existsSync(NAVMESH_DIR) ? readdirSync(NAVMESH_DIR).flatMap(f => /^zone(\d{3,})\.nav$/.exec(f)?.[1] ?? []).map(Number) : []);
    if (zones.length === 0) {
        console.log(`no zoneNNN.nav in ${NAVMESH_DIR}: pass --zones=<id,...> or run bun run navmesh:build`);
        return;
    }
    const { written, none } = writeTerrainGrids(a.daoc, zones);
    console.log(`${written.length} terrain grid(s) in ${NAVMESH_DIR}`);
    if (none.length) console.log(`no heightmap for zone(s) ${none.join(', ')} (cities, dungeons and unknown zones keep navmesh z)`);
}

if (import.meta.main) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}
