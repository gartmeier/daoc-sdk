import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detourLibraryCandidates, NavmeshStore, nativePath } from '../navmesh';

// Needs the native library and zone 0 (Camelot Hills) from `bun run navmesh:build`; skipped without them.
const real = new NavmeshStore();
const library = detourLibraryCandidates(real.dir).find(p => existsSync(p));
const ready = real.available() && real.hasZone(0);
const base = mkdtempSync(join(tmpdir(), 'navmesh-ffi-'));
const stores: NavmeshStore[] = [real];
afterAll(() => {
    for (const s of stores) s.dispose();
    rmSync(base, { recursive: true, force: true });
});

/** A store over a fresh folder `name` under the temp base. */
const storeIn = (name: string) => {
    const dir = join(base, name);
    mkdirSync(dir);
    const s = new NavmeshStore({ dir, library });
    stores.push(s);
    return { dir, store: s };
};
const spawn = { x: 548972, y: 493199, z: 2262 }; // bear cub in Camelot Hills

describe('nativePath', () => {
    test('stays UTF-8 off Windows and for ASCII paths', () => {
        expect(nativePath('/srv/navmesh-ü/zone000.nav', 'linux')).toEqual(Buffer.from('/srv/navmesh-ü/zone000.nav\0', 'utf8'));
        expect(nativePath('C:\\daoc\\zone000.nav', 'win32')).toEqual(Buffer.from('C:\\daoc\\zone000.nav\0', 'utf8'));
    });
});

describe.skipIf(!ready)('NavmeshStore under non-ASCII folders', () => {
    test('loads and paths from a folder whose name fits the ANSI code page', () => {
        const { dir, store } = storeIn('navmesh-ü');
        copyFileSync(join(real.dir, 'zone000.nav'), join(dir, 'zone000.nav'));
        const mesh = store.forZone(0);
        expect(store.loadError(0)).toBeNull();
        expect(mesh).not.toBeNull();
        const start = mesh!.closestPoint(spawn)!;
        const path = mesh!.findPath(start, mesh!.closestPoint({ x: spawn.x + 1500, y: spawn.y + 1500, z: spawn.z }, { x: 64, y: 64, z: 2000 })!);
        expect(path.status).toBe('found');
        expect(path.points.length).toBeGreaterThan(1);
    });

    test('loads from a folder outside the ANSI code page through its 8.3 short name', () => {
        const { dir, store } = storeIn('navmesh-ж');
        copyFileSync(join(real.dir, 'zone000.nav'), join(dir, 'zone000.nav'));
        // Volumes with short names disabled have no ASCII spelling for this path; nothing more to check there.
        if (process.platform === 'win32' && !/^[\x00-\x7f]*$/.test(nativePath(join(dir, 'zone000.nav')).toString('latin1'))) return;
        expect(store.forZone(0)).not.toBeNull();
        expect(store.loadError(0)).toBeNull();
    });
});

describe.skipIf(!library)('NavmeshStore.loadError', () => {
    test('names the missing file and retries once it appears', () => {
        const { dir, store } = storeIn('missing');
        expect(store.loadError(5)).toBeNull(); // never requested
        expect(store.forZone(5)).toBeNull();
        expect(store.loadError(5)).toContain(`no zone005.nav in ${dir}`);
        writeFileSync(join(dir, 'zone005.nav'), 'not a navmesh');
        expect(store.forZone(5)).toBeNull();
        expect(store.loadError(5)).toContain('cannot load');
        expect(store.loadError(5)).toContain('zone005.nav');
    });

    test.skipIf(!ready)('reports a corrupt file and retries after it changes', () => {
        const { dir, store } = storeIn('corrupt');
        const file = join(dir, 'zone000.nav');
        writeFileSync(file, 'garbage, not a TESM header');
        expect(store.forZone(0)).toBeNull();
        expect(store.loadError(0)).toBe(`cannot load ${file} (LoadNavMesh failed)`);
        expect(store.forZone(0)).toBeNull(); // unchanged file: cached failure
        copyFileSync(join(real.dir, 'zone000.nav'), file);
        expect(store.forZone(0)).not.toBeNull();
        expect(store.loadError(0)).toBeNull();
        expect(store.forZone(0)).toBe(store.forZone(0));
    });
});

describe.skipIf(!ready)('NavMesh.raycast', () => {
    test('returns end as the hit point when clear, a finite stop otherwise', () => {
        const mesh = real.forZone(0)!;
        const start = mesh.closestPoint(spawn)!;
        const end = mesh.closestPoint({ x: start.x + 64, y: start.y, z: start.z })!;
        const clear = mesh.raycast(start, end)!;
        expect(clear.clear).toBeTrue();
        expect(clear.hit).toEqual(end);
        // a ray across the whole zone runs into some mesh edge on the way
        const far = mesh.raycast(start, { x: start.x + 60000, y: start.y + 30000, z: start.z })!;
        expect(far.clear).toBeFalse();
        expect([far.hit.x, far.hit.y, far.hit.z].every(Number.isFinite)).toBeTrue();
    });
});
