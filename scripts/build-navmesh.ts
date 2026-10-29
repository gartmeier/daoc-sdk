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
//   3. dotnet build buildnav (needs a .NET 10 SDK; ~/.dotnet is tried when the PATH one is older).
//   4. Run it with base/ on PATH (it starts RecastDemo.exe by bare name) and stop it after
//      "All done.": it ends with Console.ReadKey(), which throws without a console and then
//      blocks on an error dialog.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getZonesInRegion } from '../data/zones';

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

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): BuildArgs {
    const get = (k: string) => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
    const ids = (s: string | undefined) => (s ?? '').split(',').map(v => v.trim()).filter(Boolean).map(Number);
    const regions = ids(get('regions'));
    const zones = ids(get('zones'));
    for (const n of [...regions, ...zones]) if (!Number.isInteger(n) || n < 0) throw new Error(`bad id: ${n}`);
    const all = argv.includes('--all');
    return {
        daoc: get('daoc') ?? env.DAOC_DIR ?? 'C:\\Program Files (x86)\\OpenDAoC',
        regions: regions.length || zones.length || all ? regions : [1, 100, 200],
        zones,
        all,
        skipExisting: argv.includes('--skip-existing'),
        jobs: Math.max(1, Number(get('jobs') ?? 8) || 8),
    };
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): void {
    console.log(`> ${cmd.join(' ')}`);
    const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: opts.env ?? process.env, stdout: 'inherit', stderr: 'inherit' });
    if (r.exitCode !== 0) throw new Error(`${cmd[0]} exited with ${r.exitCode}`);
}

/** A dotnet executable with a 10.x SDK: PATH first, then the user-level install. */
function findDotnet(): string {
    const candidates = ['dotnet', join(homedir(), '.dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')];
    for (const exe of candidates) {
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

function buildBuildnav(dotnet: string, env: Record<string, string | undefined>): void {
    if (!existsSync(CORE_LINK)) symlinkSync(join(ROOT, 'server', 'core'), CORE_LINK, 'junction');
    run([dotnet, 'build', join(BUILDNAV, 'OpenDAoC-BuildNav.csproj'), '-c', 'Release', '-v', 'q', '-nologo', '-clp:ErrorsOnly'], { env });
}

/** Runs buildnav until it prints "All done." (then stops it, see header); returns the zone ids it started and finished. */
async function runBuildnav(args: string[], env: Record<string, string | undefined>): Promise<{ started: Set<number>; finished: Set<number> }> {
    const exe = join(BUILDNAV_OUT, 'OpenDAoC-BuildNav.exe');
    console.log(`> ${exe} ${args.join(' ')}`);
    const proc = Bun.spawn([exe, ...args], { cwd: BUILDNAV_OUT, env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
    let done = false;
    let fatal = '';
    let buf = '';
    const started = new Set<number>();
    const finished = new Set<number>();
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    read: for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trimEnd();
            buf = buf.slice(nl + 1);
            console.log(line);
            const zone = /\[Z(\d+)\/R\d+\]( finished)?/.exec(line);
            if (zone && line.startsWith('Building navmesh')) started.add(Number(zone[1]));
            if (zone?.[2]) finished.add(Number(zone[1]));
            if (line.startsWith('All done.')) done = true;
            else if (line.includes('[FATAL]')) fatal = line;
            if (done || fatal) break read;
        }
    }
    proc.kill();
    await proc.exited;
    if (fatal) throw new Error(`buildnav failed: ${fatal}`);
    if (!done) throw new Error(`buildnav exited with ${proc.exitCode} before "All done."`);
    return { started, finished };
}

const navName = (id: number) => `zone${String(id).padStart(3, '0')}.nav`;

/** Copy unless the target already has the same bytes (a loaded Detour.dll is locked on Windows). */
function copyIfChanged(from: string, to: string): void {
    if (existsSync(to) && statSync(to).size === statSync(from).size && Bun.hash(readFileSync(to)) === Bun.hash(readFileSync(from))) return;
    copyFileSync(from, to);
}

export async function main(argv: string[]): Promise<void> {
    if (process.platform !== 'win32') throw new Error('navmesh:build runs on Windows only (buildnav is a WinForms app, RecastDemo a Win64 exe)');
    const a = parseArgs(argv);
    if (!existsSync(join(a.daoc, 'zones'))) throw new Error(`no zones/ folder in the DAoC client dir ${a.daoc} (pass --daoc=<dir>)`);
    if (!existsSync(join(BUILDNAV, 'OpenDAoC-BuildNav.csproj'))) throw new Error('server/buildnav is empty: git submodule update --init server/buildnav');

    const dotnet = findDotnet();
    const base = join(BUILDNAV_OUT, 'base');
    const zonesDir = join(base, 'zones');
    const env = {
        ...process.env,
        ...(dotnet === 'dotnet' ? {} : { DOTNET_ROOT: dirname(dotnet) }),
        PATH: `${base};${process.env.PATH ?? ''}`,
        // buildnav runs ProcessorCount - 1 zones at once; .NET reads ProcessorCount from here.
        DOTNET_PROCESSOR_COUNT: String(a.jobs + 1),
    };
    buildDetour();
    buildBuildnav(dotnet, env);

    let zones = [...a.zones, ...a.regions.flatMap(r => getZonesInRegion(r).map(z => z.id))];
    // A .nav in buildnav's output only exists for zones that finished (failed ones are deleted below).
    if (a.skipExisting) zones = zones.filter(id => !existsSync(join(NAVMESH_DIR, navName(id))) && !existsSync(join(zonesDir, navName(id))));
    zones = [...new Set(zones)];
    const failed: number[] = [];
    if (!a.all && zones.length === 0) {
        console.log('nothing to build');
    } else {
        const r = await runBuildnav([`--daoc=${a.daoc}`, '--normal-priority=true', a.all ? '--all=true' : `--zones=${zones.join(',')}`], env);
        for (const id of r.started) {
            if (r.finished.has(id)) continue;
            // An exception mid-zone (logged above) can leave a pass-1 mesh behind: don't ship it.
            failed.push(id);
            rmSync(join(zonesDir, navName(id)), { force: true });
        }
    }

    mkdirSync(join(NAVMESH_DIR, 'lib'), { recursive: true });
    copyIfChanged(DETOUR_DLL, join(NAVMESH_DIR, 'lib', 'Detour.dll'));
    const navs = existsSync(zonesDir) ? readdirSync(zonesDir).filter(f => /^zone\d{3}\.nav$/.test(f)) : [];
    for (const f of navs) copyIfChanged(join(zonesDir, f), join(NAVMESH_DIR, f));
    const all = readdirSync(NAVMESH_DIR).filter(f => /^zone\d{3}\.nav$/.test(f));
    const mb = all.reduce((s, f) => s + statSync(join(NAVMESH_DIR, f)).size, 0) / 1e6;
    console.log(`\n${all.length} navmesh(es), ${mb.toFixed(1)} MB in ${NAVMESH_DIR}`);
    // Zones without geometry (proxy zones, empty instances) legitimately produce no mesh.
    const missing = a.all ? [] : zones.filter(id => !failed.includes(id) && !all.includes(navName(id)));
    if (missing.length) console.log(`no .nav for zone(s) ${missing.join(', ')} (proxy/empty zones produce none; see the log above)`);
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
