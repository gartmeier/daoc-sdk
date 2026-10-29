import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { buildEnv, clientZones, discardPending, ensureJunction, failedZones, newZoneLog, parseArgs, parseLogLine, parseZonesDat, readMpkEntry, recordLine, seenZones, zoneOutcome } from './build-navmesh';

const zone = (id: number, regionId: number) => ({ id, regionId });
const TABLE = [zone(0, 1), zone(1, 1), zone(27, 10), zone(100, 100), zone(200, 200)];
const CLIENT_MPK = 'C:\\Program Files (x86)\\OpenDAoC\\zones\\zones.mpk';

describe('navmesh:build args', () => {
    test('defaults to the three home regions, the OpenDAoC client dir and 8 jobs', () => {
        expect(parseArgs([], {}, TABLE)).toEqual({ daoc: 'C:\\Program Files (x86)\\OpenDAoC', regions: [1, 100, 200], zones: [], all: false, skipExisting: false, jobs: 8 });
    });

    test('explicit zones replace the default regions; DAOC_DIR and flags apply', () => {
        expect(parseArgs(['--zones=0, 27', '--skip-existing', '--jobs=2'], { DAOC_DIR: 'D:\\DAoC' }, TABLE))
            .toEqual({ daoc: 'D:\\DAoC', regions: [], zones: [0, 27], all: false, skipExisting: true, jobs: 2 });
        expect(parseArgs(['--all', '--daoc=E:\\x'], { DAOC_DIR: 'D:\\DAoC' }, TABLE)).toMatchObject({ daoc: 'E:\\x', regions: [], all: true });
    });

    test('rejects non-numeric ids', () => {
        expect(() => parseArgs(['--regions=1,abc'], {}, TABLE)).toThrow('bad id');
        for (const id of ['0x10', '1e2', '-1', '1.0']) expect(() => parseArgs([`--zones=${id}`], {}, TABLE)).toThrow(`bad id in --zones=: "${id}"`);
    });

    test('rejects an empty id list instead of starting the default build', () => {
        for (const arg of ['--zones=', '--zones=,', '--regions=', '--regions= , ']) expect(() => parseArgs([arg], {}, TABLE)).toThrow('needs at least one id');
        expect(() => parseArgs(['--daoc='], {}, TABLE)).toThrow('--daoc= needs a directory');
    });

    test('rejects a flag given twice', () => {
        expect(() => parseArgs(['--zones=1', '--zones=27'], {}, TABLE)).toThrow('--zones given more than once');
        expect(() => parseArgs(['--all', '--all'], {}, TABLE)).toThrow('--all given more than once');
    });

    test('rejects unknown and space-separated flags instead of starting the default build', () => {
        expect(() => parseArgs(['--zone=0'], {}, TABLE)).toThrow('unknown argument "--zone=0"');
        expect(() => parseArgs(['--zones', '0'], {}, TABLE)).toThrow('use --zones=<value>');
        expect(() => parseArgs(['0'], {}, TABLE)).toThrow('unknown argument "0"');
        expect(() => parseArgs(['--all=true'], {}, TABLE)).toThrow('unknown argument');
    });

    test('rejects a non-positive-integer --jobs', () => {
        for (const j of ['0', '-1', '1.5', 'x', '']) expect(() => parseArgs([`--jobs=${j}`], {}, TABLE)).toThrow('--jobs must be a positive integer');
    });

    test('rejects zones and regions that the zone table does not know', () => {
        expect(() => parseArgs(['--zones=0,999'], {}, TABLE)).toThrow('unknown zone id(s) 999');
        expect(() => parseArgs(['--regions=1,42'], {}, TABLE)).toThrow('region(s) 42 have no zones');
    });

    test('loads the zone table of the chosen client dir', () => {
        const dirs: string[] = [];
        parseArgs(['--daoc=D:\\x'], { DAOC_DIR: 'E:\\y' }, d => (dirs.push(d), TABLE));
        expect(dirs).toEqual(['D:\\x']);
        expect(() => parseArgs(['--daoc=C:\\no\\such\\client'], {})).toThrow('no zones/zones.mpk in the DAoC client dir C:\\no\\such\\client');
    });

    test.if(existsSync(CLIENT_MPK))("checks against the real client's zones.dat by default", () => {
        expect(parseArgs(['--regions=1'], {}).regions).toEqual([1]);
        expect(() => parseArgs(['--zones=65000'], {})).toThrow('unknown zone id');
        // 166 is in data/zones (the server DB) but not in the client, so buildnav would get a null zone.
        expect(() => parseArgs(['--zones=166'], {})).toThrow('unknown zone id(s) 166');
    });
});

describe("client's zones.dat", () => {
    test('parseZonesDat keeps enabled [zoneNNN] sections, IniFile style', () => {
        const text = [
            '; header comment',
            '[region001]', 'name=Albion',
            '[zone000]', 'region=1', 'name=Camelot Hills', 'enabled=1',
            '[zone031]', 'region=2', 'enabled=1', 'proxy_zone=30',
            '[zone166]', 'region=163', 'enabled=0',
            '[zone233]', 'region=233', 'enabled=1', 'region=999', // first key wins
            '# comment', '',
        ].join('\r\n');
        expect(parseZonesDat(text)).toEqual([zone(0, 1), zone(31, 2), zone(233, 233)]);
    });

    test('readMpkEntry unpacks one file of an MPAK archive', () => {
        // TinyMPK layout: "MPAK", 1 byte, 16 header bytes XOR their index, zlib name, zlib directory, zlib files.
        const files = [['other.dat', 'x'], ['zones.dat', '[zone000]\nregion=1\nenabled=1\n']] as const;
        const data = files.map(([, s]) => deflateSync(Buffer.from(s)));
        const dir = Buffer.alloc(0x11c * files.length);
        let offset = 0;
        files.forEach(([name], i) => {
            dir.write(name, i * 0x11c, 'latin1');
            dir.writeUInt32LE(offset, i * 0x11c + 272);
            dir.writeUInt32LE(data[i]!.length, i * 0x11c + 276);
            offset += data[i]!.length;
        });
        const name = deflateSync(Buffer.from('zones.mpk')), cdir = deflateSync(dir);
        const header = Buffer.alloc(16);
        header.writeUInt32LE(cdir.length, 4);
        header.writeUInt32LE(name.length, 8);
        header.writeUInt32LE(files.length, 12);
        for (let i = 0; i < 16; i++) header[i] = header[i]! ^ i;
        const mpk = Buffer.concat([Buffer.from('MPAK\x02', 'latin1'), header, name, cdir, ...data]);
        expect(readMpkEntry(mpk, 'ZONES.DAT').toString()).toBe(files[1][1]);
        expect(() => readMpkEntry(mpk, 'missing.dat')).toThrow('no missing.dat');
        expect(() => readMpkEntry(Buffer.from('nope'), 'zones.dat')).toThrow('not an MPAK');
    });

    test.if(existsSync(CLIENT_MPK))('the real client: the zones buildnav --all walks', () => {
        const zones = clientZones(join(CLIENT_MPK, '..', '..'));
        const ids = new Set(zones.map(z => z.id));
        expect(zones.filter(z => z.regionId === 1).map(z => z.id)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15]);
        // Client-only zones that data/zones lacks, and a data/zones zone the client lacks.
        for (const id of [233, 270, 271]) expect(ids.has(id)).toBe(true);
        expect(ids.has(166)).toBe(false);
    });
});

describe('navmesh:build env', () => {
    test('one PATH with base/ first, whatever the inherited spelling', () => {
        const env = buildEnv({ Path: 'C:\\Windows', FOO: 'bar' }, { dotnet: 'C:\\Program Files\\dotnet\\dotnet.exe', base: 'C:\\b', jobs: 4 });
        expect(Object.keys(env).filter(k => k.toLowerCase() === 'path')).toEqual(['PATH']);
        expect(env).toEqual({ FOO: 'bar', PATH: 'C:\\b;C:\\Windows', DOTNET_ROOT: 'C:\\Program Files\\dotnet', DOTNET_PROCESSOR_COUNT: '5' });
        expect(buildEnv({}, { dotnet: 'C:\\d\\dotnet.exe', base: 'C:\\b', jobs: 1 }).PATH).toBe('C:\\b');
    });

    test('DOTNET_ROOT always names the chosen dotnet', () => {
        expect(buildEnv({ DOTNET_ROOT: 'C:\\old' }, { dotnet: 'C:\\Users\\me\\.dotnet\\dotnet.exe', base: 'b', jobs: 8 }).DOTNET_ROOT).toBe('C:\\Users\\me\\.dotnet');
    });
});

// Lines copied from server/navmesh/build.log and build2.log.
describe('buildnav log parsing', () => {
    test('zone progress lines', () => {
        expect(parseLogLine('Building navmesh for zone Lough Gur [Z204/R200]...')).toEqual({ kind: 'start', zone: 204 });
        expect(parseLogLine('Building navmesh for zone Cornwall [Z006/R001]...')).toEqual({ kind: 'start', zone: 6 });
        expect(parseLogLine('Zone Jamtland Mountains [Z113/R100] finished in 00:04:35.7055683')).toEqual({ kind: 'finish', zone: 113 });
        expect(parseLogLine('All done.')).toEqual({ kind: 'done' });
        expect(parseLogLine('[FATAL] Config file not found: cem.json')).toEqual({ kind: 'fatal', line: '[FATAL] Config file not found: cem.json' });
    });

    test('benign and failed zone results (NavmeshMgr wording)', () => {
        expect(parseLogLine('Skipping zone Foo [Z031/R002] because it has a proxy zone id 30')).toEqual({ kind: 'skip', zone: 31 });
        expect(parseLogLine('[Warn] zones\\zone113.nav was empty :(')).toEqual({ kind: 'empty', zone: 113 });
        expect(parseLogLine('[Error] Did not generate navmesh for file zones\\zone113.nav for unknown reasons')).toEqual({ kind: 'nogen', zone: 113 });
        expect(parseLogLine("[Error] System.IO.IOException: The process cannot access the file 'C:\\Users\\joshu\\Code\\daoc-sdk\\server\\buildnav\\bin\\Release\\net10.0-windows7.0\\base\\zones\\zone113.nav' because it is being used by another process."))
            .toEqual({ kind: 'error', zone: 113 });
    });

    test('noise is ignored', () => {
        for (const line of [
            "[Error] System.IO.IOException: Insufficient system resources exist to complete the requested service. : 'C:\\Program Files (x86)\\OpenDAoC\\zones\\nifs\\gob-hut2.nif'.",
            '   at CEM.World.NavmeshMgr.RunRecast(String gset, String nav, String zoneName, Int32 pass) in C:\\Users\\joshu\\Code\\daoc-sdk\\server\\buildnav\\World\\NavmeshMgr.cs:line 120',
            '[Error] VER_3_0 not supported. (File: N-Bed1.NIF)',
            'Wrote 7 ladder definition(s) to zones\\zone006.ladders.json',
            'Appended 52 ladder pad mesh(es) to zones\\zone113.obj',
            'Placing ladder off-mesh links for zone Jamtland Mountains [Z113/R100] (16 ladder(s))...',
            "[Warn] Ladder 'climb001@(341853,591047,5431)': free-side probe failed both sides; trying +/- thinAxis",
            'Zone Cornwall is a Normal',
            '---------------------------------------------------------------------------',
        ]) expect(parseLogLine(line)).toBeNull();
    });

    test('classifies the zones of a run', () => {
        const log = newZoneLog();
        for (const line of [
            'Building navmesh for zone Myrkwood Forest [Z105/R100]...',
            'Building navmesh for zone Jamtland Mountains [Z113/R100]...',
            'Building navmesh for zone Salisbury Plains [Z001/R001]...',
            'Building navmesh for zone Cornwall [Z006/R001]...',
            'Skipping zone Foo [Z031/R002] because it has a proxy zone id 30',
            // Cornwall: exception mid-export, so no "finished" line.
            "[Error] System.IO.IOException: Insufficient system resources exist to complete the requested service. : 'C:\\Program Files (x86)\\OpenDAoC\\zones\\nifs\\gob-hut2.nif'.",
            '[Error] Did not generate navmesh for file zones\\zone001.nav for unknown reasons',
            'Zone Salisbury Plains [Z001/R001] finished in 00:06:58.2295582',
            'Zone Myrkwood Forest [Z105/R100] finished in 00:02:36.8758981',
            '[Warn] zones\\zone113.nav was empty :(',
            'Zone Jamtland Mountains [Z113/R100] finished in 00:04:35.7055683',
            'All done.',
        ]) recordLine(log, line);
        expect(log.done).toBe(true);
        expect(failedZones(log)).toEqual([1, 6]);
        expect(seenZones(log)).toEqual([1, 6, 31, 105, 113]);
        expect(zoneOutcome(105, log, true)).toBe('built');
        expect(zoneOutcome(113, log, false)).toBe('empty');
        expect(zoneOutcome(31, log, false)).toBe('skipped');
        expect(zoneOutcome(1, log, false)).toBe('failed');
        expect(zoneOutcome(6, log, true)).toBe('failed');
        // Finished without complaint yet no mesh, or never mentioned at all (buildnav lost it).
        expect(zoneOutcome(105, log, false)).toBe('failed');
        expect(zoneOutcome(42, log, false)).toBe('failed');
    });
});

describe('navmesh:build files', () => {
    const tmp = () => mkdtempSync(join(tmpdir(), 'navbuild-'));

    test('discardPending drops meshes whose marker survived and keeps finished ones', () => {
        const dir = tmp();
        try {
            for (const f of ['zone001.nav', 'zone001.nav.pending', 'zone002.nav', 'zone113.nav.pending']) writeFileSync(join(dir, f), '');
            expect(discardPending(dir)).toEqual([1, 113]);
            expect(['zone001.nav', 'zone001.nav.pending', 'zone002.nav', 'zone113.nav.pending'].map(f => existsSync(join(dir, f)))).toEqual([false, false, true, false]);
            expect(discardPending(join(dir, 'missing'))).toEqual([]);

            // End of a run: drop the meshes but keep the markers, so a mesh written later by an orphaned RecastDemo goes too.
            for (const f of ['zone001.nav', 'zone001.nav.pending']) writeFileSync(join(dir, f), '');
            expect(discardPending(dir, { keepMarkers: true })).toEqual([1]);
            expect(['zone001.nav', 'zone001.nav.pending'].map(f => existsSync(join(dir, f)))).toEqual([false, true]);
            writeFileSync(join(dir, 'zone001.nav'), 'late');
            expect(discardPending(dir)).toEqual([1]);
            expect(['zone001.nav', 'zone001.nav.pending', 'zone002.nav'].map(f => existsSync(join(dir, f)))).toEqual([false, false, true]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.if(process.platform === 'win32')('ensureJunction creates, keeps, and repairs dangling or misdirected links', () => {
        const dir = tmp();
        try {
            const target = join(dir, 'core'), other = join(dir, 'other'), link = join(dir, 'link');
            mkdirSync(target);
            mkdirSync(other);
            ensureJunction(link, target);
            expect(realpathSync(link)).toBe(realpathSync(target));
            ensureJunction(link, target);
            expect(realpathSync(link)).toBe(realpathSync(target));

            rmSync(link);
            symlinkSync(other, link, 'junction');
            ensureJunction(link, target);
            expect(realpathSync(link)).toBe(realpathSync(target));

            rmSync(link);
            symlinkSync(join(dir, 'gone'), link, 'junction');
            expect(existsSync(link)).toBe(false);
            ensureJunction(link, target);
            expect(readlinkSync(link).toLowerCase()).toContain('core');
            expect(realpathSync(link)).toBe(realpathSync(target));

            rmSync(link);
            mkdirSync(link);
            expect(() => ensureJunction(link, target)).toThrow('is not a link');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
