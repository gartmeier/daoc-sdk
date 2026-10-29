#!/usr/bin/env bun
// Builds Detour navmeshes (zoneNNN.nav) from a local DAoC client install with
// server/buildnav, plus the native Detour library the SDK loads through Bun FFI.
// Windows only: buildnav is a WinForms app and RecastDemo.exe a Win64 binary.
//
//   bun run navmesh:build                              # regions 1, 100, 200 (the classic home realms)
//   bun run navmesh:build --regions=1,10 --zones=27    # specific regions / zones
//   bun run navmesh:build --all                        # every zone (hours, several GB)
//   bun run navmesh:build --skip-existing              # leave zones that already have a .nav
//   bun run navmesh:build --jobs=4                     # zones built in parallel (default 8)
//   bun run navmesh:build --daoc="D:\Games\DAoC"       # client dir (default: $DAOC_DIR or C:\Program Files (x86)\OpenDAoC)
//
// Output (gitignored; navmeshes are derived from client assets and must not be redistributed):
//   server/navmesh/zoneNNN.nav       one mesh per zone, region-global game coordinates
//   server/navmesh/lib/Detour.dll    64-bit-polyref Detour from server/core/Pathing/Detour
//
// Steps:
//   1. CMake-build server/core/Pathing/Detour (Visual Studio 2022 / Build Tools).
//   2. Link server/OpenDAoC-Core -> server/core: the buildnav project references ..\OpenDAoC-Core.
//   3. dotnet build buildnav (needs a .NET 10 SDK; ~/.dotnet is tried when the PATH one is older,
//      and DOTNET_ROOT points at the one picked so buildnav's apphost runs on the same runtime).
//   4. Run it with base/ on PATH (it starts RecastDemo.exe by bare name) and stop it after
//      "All done.": it ends with Console.ReadKey(), which throws without a console and then
//      blocks on an error dialog.
//   5. Drop the meshes of zones that failed or never finished (a zoneNNN.nav.pending marker next
//      to the mesh outlives a crashed run), then copy the rest to server/navmesh.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

const ROOT = join(import.meta.dir, '..');
const DETOUR_SRC = join(ROOT, 'server', 'core', 'Pathing', 'Detour');
const DETOUR_DLL = join(DETOUR_SRC, 'Build', 'Release', 'Detour.dll');
const CORE_LINK = join(ROOT, 'server', 'OpenDAoC-Core');
const BUILDNAV = join(ROOT, 'server', 'buildnav');
const BUILDNAV_OUT = join(BUILDNAV, 'bin', 'Release', 'net10.0-windows7.0');
export const NAVMESH_DIR = join(ROOT, 'server', 'navmesh');

export interface BuildArgs {
    daoc: string;
    regions: number[];
    zones: number[];
    all: boolean;
    skipExisting: boolean;
    /** Zones built in parallel (each RecastDemo run takes 0.5-2 GB; 23 at once ran out of file handles). */
    jobs: number;
}

/** A zone as buildnav sees it. */
export interface ZoneRef {
    id: number;
    regionId: number;
}

/** One file of a DAoC .mpk archive (TinyMPK's layout: XOR-masked header, zlib directory of 0x11C-byte entries, zlib files). */
export function readMpkEntry(mpk: Buffer, name: string): Buffer {
    if (mpk.length < 21 || mpk.toString('latin1', 0, 4) !== 'MPAK') throw new Error('not an MPAK archive');
    const header = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) header[i] = mpk[5 + i]! ^ i;
    const dirStart = 21 + header.readUInt32LE(8);
    const dataStart = dirStart + header.readUInt32LE(4);
    const dir = inflateSync(mpk.subarray(dirStart, dataStart));
    for (let i = 0; i < header.readUInt32LE(12); i++) {
        const e = dir.subarray(i * 0x11c, (i + 1) * 0x11c);
        const nul = e.indexOf(0);
        if (e.toString('latin1', 0, nul >= 0 && nul < 256 ? nul : 256).toLowerCase() !== name.toLowerCase()) continue;
        const offset = dataStart + e.readUInt32LE(272);
        return inflateSync(mpk.subarray(offset, offset + e.readUInt32LE(276)));
    }
    throw new Error(`no ${name} in the archive`);
}

/** The zones buildnav loads from zones.dat: [zoneNNN] sections whose enabled is not 0 (IniFile: first section/key wins). */
export function parseZonesDat(text: string): ZoneRef[] {
    const sections = new Map<string, Map<string, string>>();
    let cur: Map<string, string> | undefined;
    for (const line of text.split(/\r?\n/)) {
        if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
            const name = line.split(/[[\]]/)[1] ?? '';
            cur = sections.get(name) ?? new Map();
            sections.set(name, cur);
            continue;
        }
        const eq = line.indexOf('=');
        if (cur && eq >= 0 && !cur.has(line.slice(0, eq))) cur.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const zones: ZoneRef[] = [];
    for (const [name, items] of sections) {
        const m = /^zone(\d+)/.exec(name);
        if (m && items.get('enabled') !== '0') zones.push({ id: Number(m[1]), regionId: Number(items.get('region')) });
    }
    return zones;
}

/** The zone table of the client in `daoc` (zones/zones.mpk/zones.dat), the one buildnav's --zones, --regions and --all use. */
export function clientZones(daoc: string): ZoneRef[] {
    const mpk = join(daoc, 'zones', 'zones.mpk');
    if (!existsSync(mpk)) throw new Error(`no zones/zones.mpk in the DAoC client dir ${daoc} (pass --daoc=<dir>)`);
    return parseZonesDat(readMpkEntry(readFileSync(mpk), 'zones.dat').toString('latin1'));
}

const VALUE_FLAGS = ['daoc', 'regions', 'zones', 'jobs'];
const BOOL_FLAGS = ['all', 'skip-existing'];

/** Requested zones and regions are checked against `zoneTable` (by default the client's zones.dat, see clientZones). */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env, zoneTable: ZoneRef[] | ((daoc: string) => ZoneRef[]) = clientZones): BuildArgs {
    const seen = new Set<string>();
    for (const arg of argv) {
        const [, name = '', eq] = /^--([a-z-]+)(=|$)/.exec(arg) ?? [];
        if ((eq ? VALUE_FLAGS : BOOL_FLAGS).includes(name)) {
            if (seen.has(name)) throw new Error(`--${name} given more than once`);
            seen.add(name);
            continue;
        }
        const hint = VALUE_FLAGS.includes(name) ? ` (use --${name}=<value>)` : '';
        const usage = [...VALUE_FLAGS.map(f => `--${f}=`), ...BOOL_FLAGS.map(f => `--${f}`)].join(' ');
        throw new Error(`unknown argument "${arg}"${hint}; flags: ${usage}`);
    }
    const get = (k: string) => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
    // An empty list (--zones=$IDS with IDS unset) must not fall back to the default build.
    const ids = (k: string) => {
        const s = get(k);
        if (s === undefined) return [];
        const parts = s.split(',').map(v => v.trim()).filter(Boolean);
        if (!parts.length) throw new Error(`--${k}= needs at least one id`);
        const bad = parts.find(p => !/^\d+$/.test(p));
        if (bad !== undefined) throw new Error(`bad id in --${k}=: "${bad}"`);
        return parts.map(Number);
    };
    const regions = ids('regions');
    const zones = ids('zones');
    if (get('daoc') === '') throw new Error('--daoc= needs a directory');
    const daoc = get('daoc') ?? env.DAOC_DIR ?? 'C:\\Program Files (x86)\\OpenDAoC';
    const table = typeof zoneTable === 'function' ? zoneTable(daoc) : zoneTable;
    const unknown = zones.filter(id => !table.some(z => z.id === id));
    if (unknown.length) throw new Error(`unknown zone id(s) ${unknown.join(', ')} (not enabled in the client's zones.dat)`);
    const empty = regions.filter(id => !table.some(z => z.regionId === id));
    if (empty.length) throw new Error(`region(s) ${empty.join(', ')} have no zones in the client's zones.dat`);
    const jobs = get('jobs') ?? '8';
    if (!/^\d+$/.test(jobs) || Number(jobs) < 1) throw new Error(`--jobs must be a positive integer, got "${jobs}"`);
    const all = argv.includes('--all');
    return {
        daoc,
        regions: regions.length || zones.length || all ? regions : [1, 100, 200],
        zones,
        all,
        skipExisting: argv.includes('--skip-existing'),
        jobs: Number(jobs),
    };
}

/**
 * The environment for dotnet build and buildnav: one PATH with base/ first (Windows often names the
 * inherited one 'Path', and adding 'PATH' next to it gives the child both) and DOTNET_ROOT at `dotnet`'s folder.
 */
export function buildEnv(env: Record<string, string | undefined>, o: { dotnet: string; base: string; jobs: number }): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    let path: string | undefined;
    for (const [k, v] of Object.entries(env)) {
        if (k.toLowerCase() === 'path') path ??= v;
        else out[k] = v;
    }
    out.DOTNET_ROOT = dirname(o.dotnet);
    out.PATH = path ? `${o.base};${path}` : o.base;
    // buildnav runs ProcessorCount - 1 zones at once; .NET reads ProcessorCount from here.
    out.DOTNET_PROCESSOR_COUNT = String(o.jobs + 1);
    return out;
}

/** What one line of buildnav output says. */
export type LogEvent =
    | { kind: 'start' | 'finish' | 'skip' | 'empty' | 'nogen' | 'error'; zone: number }
    | { kind: 'done' }
    | { kind: 'fatal'; line: string };

const ZONE_TAG = /\[Z(\d+)\/R\d+\]/;
const ZONE_FILE = /\bzone(\d+)\.(?:nav|obj|gset|ladders\.json)\b/;

export function parseLogLine(line: string): LogEvent | null {
    if (line.startsWith('All done.')) return { kind: 'done' };
    if (line.includes('[FATAL]')) return { kind: 'fatal', line };
    const tag = ZONE_TAG.exec(line);
    if (tag) {
        const zone = Number(tag[1]);
        if (line.startsWith('Building navmesh for zone ')) return { kind: 'start', zone };
        if (line.startsWith('Zone ') && line.includes(`${tag[0]} finished in `)) return { kind: 'finish', zone };
        if (line.startsWith('Skipping zone ')) return { kind: 'skip', zone };
    }
    const file = ZONE_FILE.exec(line);
    if (file) {
        const zone = Number(file[1]);
        // NavmeshMgr logs "{nav} was empty :(" (and deletes it), "Did not generate navmesh for file {nav}"
        // when RecastDemo crashed (a negative exit code passes its check), and an exception naming a zone file.
        if (line.includes(' was empty')) return { kind: 'empty', zone };
        if (line.includes('Did not generate navmesh')) return { kind: 'nogen', zone };
        if (line.startsWith('[Error]') && /\w+Exception\b/.test(line)) return { kind: 'error', zone };
    }
    return null;
}

/** Zone ids per buildnav log event, collected over one run. */
export interface ZoneLog {
    started: Set<number>;
    finished: Set<number>;
    skipped: Set<number>;
    empty: Set<number>;
    nogen: Set<number>;
    errors: Set<number>;
    done: boolean;
    fatal: string;
}

export function newZoneLog(): ZoneLog {
    return { started: new Set(), finished: new Set(), skipped: new Set(), empty: new Set(), nogen: new Set(), errors: new Set(), done: false, fatal: '' };
}

export function recordLine(log: ZoneLog, line: string): LogEvent | null {
    const e = parseLogLine(line);
    if (!e) return null;
    if (e.kind === 'done') log.done = true;
    else if (e.kind === 'fatal') log.fatal = line;
    else ({ start: log.started, finish: log.finished, skip: log.skipped, empty: log.empty, nogen: log.nogen, error: log.errors })[e.kind].add(e.zone);
    return e;
}

const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);

/** Zones whose mesh must not ship: started without finishing, RecastDemo produced nothing, or an exception named their files. */
export function failedZones(log: ZoneLog): number[] {
    return sorted([...[...log.started].filter(id => !log.finished.has(id)), ...log.nogen, ...log.errors]);
}

/** Every zone the log mentions (what an --all run attempted). */
export function seenZones(log: ZoneLog): number[] {
    return sorted([...log.started, ...log.skipped, ...log.empty, ...log.nogen, ...log.errors]);
}

/** Only skipped (proxy) and empty zones legitimately end without a mesh; any other zone without one failed. */
export function zoneOutcome(id: number, log: ZoneLog, hasNav: boolean): 'built' | 'skipped' | 'empty' | 'failed' {
    if (failedZones(log).includes(id)) return 'failed';
    if (hasNav) return 'built';
    if (log.skipped.has(id)) return 'skipped';
    if (log.empty.has(id)) return 'empty';
    return 'failed';
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): void {
    console.log(`> ${cmd.join(' ')}`);
    const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: opts.env ?? process.env, stdout: 'inherit', stderr: 'inherit' });
    if (r.exitCode !== 0) throw new Error(`${cmd[0]} exited with ${r.exitCode}`);
}

/** Full path of a dotnet executable with a 10.x SDK: PATH first, then the user-level install. */
function findDotnet(): string {
    const candidates = [Bun.which('dotnet'), join(homedir(), '.dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')];
    for (const exe of candidates) {
        if (!exe) continue;
        try {
            const r = Bun.spawnSync([exe, '--list-sdks'], { stdout: 'pipe', stderr: 'ignore' });
            if (r.exitCode === 0 && /^10\./m.test(r.stdout.toString())) return exe;
        } catch { /* not installed */ }
    }
    throw new Error('no .NET 10 SDK found (dotnet --list-sdks); install it from https://dotnet.microsoft.com/download/dotnet/10.0');
}

function buildDetour(): void {
    if (existsSync(DETOUR_DLL)) return;
    run(['cmake', '-S', DETOUR_SRC, '-B', join(DETOUR_SRC, 'Build'), '-G', 'Visual Studio 17 2022', '-A', 'x64']);
    run(['cmake', '--build', join(DETOUR_SRC, 'Build'), '--config', 'Release']);
}

/** Makes `link` a junction to `target`; a dangling or misdirected link (a moved checkout) is recreated. */
export function ensureJunction(link: string, target: string): void {
    let isLink: boolean;
    try {
        isLink = lstatSync(link).isSymbolicLink();
    } catch {
        symlinkSync(target, link, 'junction');
        return;
    }
    // existsSync() is false for a dangling junction, and realpath throws on one.
    const real = (p: string) => {
        try { return realpathSync(p).toLowerCase(); } catch { return null; }
    };
    const resolved = real(link);
    if (resolved !== null && resolved === real(target)) return;
    if (!isLink) throw new Error(`${link} exists and is not a link to ${target}; move it out of the way`);
    unlinkSync(link);
    symlinkSync(target, link, 'junction');
}

function buildBuildnav(dotnet: string, env: Record<string, string | undefined>): void {
    ensureJunction(CORE_LINK, join(ROOT, 'server', 'core'));
    run([dotnet, 'build', join(BUILDNAV, 'OpenDAoC-BuildNav.csproj'), '-c', 'Release', '-v', 'q', '-nologo', '-clp:ErrorsOnly'], { env });
}

const navName = (id: number) => `zone${String(id).padStart(3, '0')}.nav`;
const pendingName = (id: number) => `${navName(id)}.pending`;

/**
 * Deletes each mesh whose .pending marker remains (its zone started and did not finish cleanly); returns those zone ids.
 * `keepMarkers` leaves the markers, so the next run also drops a mesh that an orphaned RecastDemo writes later.
 */
export function discardPending(zonesDir: string, o: { keepMarkers?: boolean } = {}): number[] {
    if (!existsSync(zonesDir)) return [];
    const ids: number[] = [];
    for (const f of readdirSync(zonesDir)) {
        const m = /^zone(\d+)\.nav\.pending$/.exec(f);
        if (!m) continue;
        ids.push(Number(m[1]));
        rmSync(join(zonesDir, navName(Number(m[1]))), { force: true });
        if (!o.keepMarkers) rmSync(join(zonesDir, f), { force: true });
    }
    return sorted(ids);
}

/**
 * Runs buildnav until it prints "All done." (then stops it, see header), recording zone events in `log`.
 * A zone has a .pending marker in `zonesDir` from "Building navmesh" until it finishes cleanly.
 */
async function runBuildnav(args: string[], env: Record<string, string | undefined>, log: ZoneLog, zonesDir: string): Promise<void> {
    const exe = join(BUILDNAV_OUT, 'OpenDAoC-BuildNav.exe');
    console.log(`> ${exe} ${args.join(' ')}`);
    mkdirSync(zonesDir, { recursive: true });
    const proc = Bun.spawn([exe, ...args], { cwd: BUILDNAV_OUT, env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
    let buf = '';
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    try {
        read: for (;;) {
            const { value, done: eof } = await reader.read();
            if (eof) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trimEnd();
                buf = buf.slice(nl + 1);
                console.log(line);
                const e = recordLine(log, line);
                if (e?.kind === 'start') writeFileSync(join(zonesDir, pendingName(e.zone)), '');
                if (e?.kind === 'finish' && !failedZones(log).includes(e.zone)) rmSync(join(zonesDir, pendingName(e.zone)), { force: true });
                if (log.done || log.fatal) break read;
            }
        }
    } finally {
        proc.kill();
        await proc.exited;
    }
    if (log.fatal) throw new Error(`buildnav failed: ${log.fatal}`);
    if (!log.done) throw new Error(`buildnav exited with ${proc.exitCode} before "All done."`);
}

/** Copy unless the target already has the same bytes (a loaded Detour.dll is locked on Windows). */
function copyIfChanged(from: string, to: string): void {
    if (existsSync(to) && statSync(to).size === statSync(from).size && Bun.hash(readFileSync(to)) === Bun.hash(readFileSync(from))) return;
    copyFileSync(from, to);
}

export async function main(argv: string[]): Promise<void> {
    if (process.platform !== 'win32') throw new Error('navmesh:build runs on Windows only (buildnav is a WinForms app, RecastDemo a Win64 exe)');
    let table: ZoneRef[] = [];
    const a = parseArgs(argv, process.env, daoc => (table = clientZones(daoc)));
    if (!existsSync(join(BUILDNAV, 'OpenDAoC-BuildNav.csproj'))) throw new Error('server/buildnav is empty: git submodule update --init server/buildnav');

    const dotnet = findDotnet();
    const base = join(BUILDNAV_OUT, 'base');
    const zonesDir = join(base, 'zones');
    const env = buildEnv(process.env, { dotnet, base, jobs: a.jobs });
    buildDetour();
    buildBuildnav(dotnet, env);

    // Partial meshes of an interrupted run must neither ship nor count as built for --skip-existing.
    const interrupted = discardPending(zonesDir);
    if (interrupted.length) console.log(`discarded the partial mesh(es) of zone(s) ${interrupted.join(', ')} from an interrupted run`);

    // --all leaves the zone list to buildnav, except with --skip-existing: then it is every zone of the
    // client's zones.dat, the table buildnav's --all walks (data/zones, the server DB, differs from it).
    const buildAll = a.all && !a.skipExisting;
    let zones = a.all
        ? table.map(z => z.id)
        : [...a.zones, ...a.regions.flatMap(r => table.filter(z => z.regionId === r).map(z => z.id))];
    // A .nav in buildnav's output only exists for zones that finished (failed ones are deleted below).
    if (a.skipExisting) zones = zones.filter(id => !existsSync(join(NAVMESH_DIR, navName(id))) && !existsSync(join(zonesDir, navName(id))));
    zones = [...new Set(zones)];
    const log = newZoneLog();
    if (!buildAll && zones.length === 0) {
        console.log('nothing to build');
    } else {
        try {
            await runBuildnav([`--daoc=${a.daoc}`, '--normal-priority=true', buildAll ? '--all=true' : `--zones=${zones.join(',')}`], env, log, zonesDir);
        } finally {
            // An exception mid-zone (logged above) can leave a pass-1 mesh behind: don't ship it. Markers stay:
            // if buildnav died, its RecastDemo children keep running and may still write their meshes.
            for (const id of failedZones(log)) rmSync(join(zonesDir, navName(id)), { force: true });
            discardPending(zonesDir, { keepMarkers: true });
        }
    }

    mkdirSync(join(NAVMESH_DIR, 'lib'), { recursive: true });
    const navs = existsSync(zonesDir) ? readdirSync(zonesDir).filter(f => /^zone\d{3,}\.nav$/.test(f) && !existsSync(join(zonesDir, `${f}.pending`))) : [];
    for (const f of navs) copyIfChanged(join(zonesDir, f), join(NAVMESH_DIR, f));
    const all = readdirSync(NAVMESH_DIR).filter(f => /^zone\d{3,}\.nav$/.test(f));
    const mb = all.reduce((s, f) => s + statSync(join(NAVMESH_DIR, f)).size, 0) / 1e6;
    console.log(`\n${all.length} navmesh(es), ${mb.toFixed(1)} MB in ${NAVMESH_DIR}`);
    const dll = join(NAVMESH_DIR, 'lib', 'Detour.dll');
    try {
        copyIfChanged(DETOUR_DLL, dll);
    } catch (e) {
        console.warn(`warning: ${dll} not updated (${e instanceof Error ? e.message : e}); a running bot may have it loaded`);
    }

    const requested = buildAll ? seenZones(log) : zones;
    const outcome = (id: number) => zoneOutcome(id, log, all.includes(navName(id)));
    const benign = requested.filter(id => outcome(id) === 'skipped' || outcome(id) === 'empty');
    if (benign.length) console.log(`no .nav for zone(s) ${benign.join(', ')} (proxy/empty zones produce none; see the log above)`);
    const failed = requested.filter(id => outcome(id) === 'failed');
    if (failed.length) {
        console.error(`zone(s) ${failed.join(', ')} failed (see the errors above); retry: bun run navmesh:build --zones=${failed.join(',')} --jobs=${Math.max(1, a.jobs >> 1)}`);
        process.exitCode = 1;
    }
}

if (import.meta.main) {
    main(process.argv.slice(2)).catch(e => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
}
