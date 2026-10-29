// Zone and region tables. The client needs these to fill the zoneId field of
// position updates (0xA9) and to convert zone-relative coordinates in 0xA1
// object updates back to global coordinates.
//
// Offsets/sizes in the DB are in 8192-unit blocks (WorldMgr.cs:608-611).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTable } from './sql';

export interface ZoneInfo {
    id: number;
    regionId: number;
    name: string;
    /** Global offsets / sizes in world units. */
    xOffset: number;
    yOffset: number;
    width: number;
    height: number;
    waterLevel: number;
    isLava: boolean;
    realm: number;
}

export interface RegionInfo {
    id: number;
    name: string;
    description: string;
    expansion: number;
    divingEnabled: boolean;
    waterLevel: number;
    isFrontier: boolean;
}

const GENERATED = join(import.meta.dir, 'generated');

let zones: ZoneInfo[] | null = null;
let regions: RegionInfo[] | null = null;
const zonesById = new Map<number, ZoneInfo>();
const zonesByRegion = new Map<number, ZoneInfo[]>();

function loadJsonOr<T>(file: string, build: () => T): T {
    const p = join(GENERATED, file);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as T;
    return build();
}

export function buildZones(): ZoneInfo[] {
    return loadTable('zones').map(r => ({
        id: Number(r.ZoneID),
        regionId: Number(r.RegionID),
        name: String(r.Name ?? ''),
        xOffset: Number(r.OffsetX) * 8192,
        yOffset: Number(r.OffsetY) * 8192,
        width: Number(r.Width) * 8192,
        height: Number(r.Height) * 8192,
        waterLevel: Number(r.WaterLevel),
        isLava: Number(r.IsLava) !== 0,
        realm: Number(r.Realm),
    }));
}

export function buildRegions(): RegionInfo[] {
    return loadTable('regions').map(r => ({
        id: Number(r.RegionID),
        name: String(r.Name ?? ''),
        description: String(r.Description ?? ''),
        expansion: Number(r.Expansion),
        divingEnabled: Number(r.DivingEnabled) !== 0,
        waterLevel: Number(r.WaterLevel),
        isFrontier: Number(r.IsFrontier) !== 0,
    }));
}

function ensureLoaded(): void {
    if (zones) return;
    zones = loadJsonOr('zones.json', buildZones);
    regions = loadJsonOr('regions.json', buildRegions);
    for (const z of zones) {
        zonesById.set(z.id, z);
        let list = zonesByRegion.get(z.regionId);
        if (!list) zonesByRegion.set(z.regionId, list = []);
        list.push(z);
    }
}

export function getZones(): ZoneInfo[] {
    ensureLoaded();
    return zones!;
}

export function getRegions(): RegionInfo[] {
    ensureLoaded();
    return regions!;
}

export function getZone(zoneId: number): ZoneInfo | undefined {
    ensureLoaded();
    return zonesById.get(zoneId);
}

export function getRegion(regionId: number): RegionInfo | undefined {
    ensureLoaded();
    return regions!.find(r => r.id === regionId);
}

/** The zone containing global (x, y) in a region, mirroring Region.GetZone. */
export function getZoneAt(regionId: number, x: number, y: number): ZoneInfo | undefined {
    ensureLoaded();
    const list = zonesByRegion.get(regionId);
    if (!list) return undefined;
    for (const z of list) {
        if (x >= z.xOffset && x < z.xOffset + z.width && y >= z.yOffset && y < z.yOffset + z.height) return z;
    }
    return undefined;
}

export function getZonesInRegion(regionId: number): ZoneInfo[] {
    ensureLoaded();
    return zonesByRegion.get(regionId) ?? [];
}
