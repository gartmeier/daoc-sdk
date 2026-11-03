import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { COMPOSE_FILE } from './setup-server';
import {
    accountProperties, composePorts, dataVolume, firstFreeSlot, generateCompose, imagePinWarning, isPortConflict, listeningLine, parseArgs, projectName, publishedPorts,
    seedVolumeName, slotPorts, staleSeeds,
} from './throwaway-server';

const SOURCE = readFileSync(COMPOSE_FILE, 'utf8');
const PORTS = { game: 10340, udp: 10440, db: 13346 };
const DB_INIT_DIR = 'C:\\repo\\server\\db\\opendaoc-db-core';
const generate = (source = SOURCE) => generateCompose(source, { project: 'daoc-throwaway-x', ports: PORTS, dbInitDir: DB_INIT_DIR });
const parsed = () => Bun.YAML.parse(generate()) as {
    name: string;
    volumes: Record<string, unknown>;
    services: Record<string, Record<string, any>>;
};

describe('generateCompose', () => {
    test('has its own project name, so its containers and volume are its own', () => {
        const doc = parsed();
        expect(doc.name).toBe('daoc-throwaway-x');
        expect(Object.keys(doc.volumes)).toEqual(['db-data']);
        expect(doc.volumes['db-data']).toBeNull();   // no `name:` that would escape the project
        expect(doc.services.db!.volumes[0]).toBe('db-data:/var/lib/mysql');
    });

    test('the gameserver runs the image, with no build and no navmesh mount', () => {
        const game = parsed().services.gameserver!;
        expect(game.image).toBe('daoc-sdk-gameserver:latest');
        expect(game.build).toBeUndefined();
        expect(game.volumes).toBeUndefined();
    });

    test('moves the ports through the env as well as the mapping', () => {
        const { db, gameserver } = parsed().services;
        expect(gameserver!.ports).toEqual(['10340:10340', '10440:10440/udp']);
        expect(gameserver!.environment).toMatchObject({ SERVER_PORT: '10340', UDP_PORT: '10440', REGION_PORT: '10440' });
        expect(db!.ports).toEqual(['13346:3306']);
    });

    test('none of the shared ports or relative paths are left', () => {
        const text = generate();
        for (const leftover of ['10300', '10400', '13306', '../', 'name: daoc-sdk\n']) expect(text).not.toContain(leftover);
    });

    test('the DB init mount is an absolute bind of the dump, read-only', () => {
        expect(parsed().services.db!.volumes[1]).toEqual({
            type: 'bind', source: DB_INIT_DIR, target: '/docker-entrypoint-initdb.d', read_only: true,
        });
    });

    test('keeps the rest of the shared file: the env, the DB settings and the health dependency', () => {
        const shared = Bun.YAML.parse(SOURCE) as { services: Record<string, Record<string, any>> };
        const { db, gameserver } = parsed().services;
        expect(db!.command).toBe(shared.services.db!.command);
        expect(db!.environment).toEqual(shared.services.db!.environment);
        expect(db!.healthcheck).toEqual(shared.services.db!.healthcheck);
        expect(gameserver!.depends_on).toEqual(shared.services.gameserver!.depends_on);
        expect(gameserver!.environment.DB_CONNECTION_STRING).toBe(shared.services.gameserver!.environment.DB_CONNECTION_STRING);
    });

    test('a crash fails instead of restarting, and the stack is the first to go in a memory shortage', () => {
        for (const service of Object.values(parsed().services)) {
            expect(service.restart).toBe('no');
            expect(service.oom_score_adj).toBeGreaterThan(0);
        }
    });

    test('env values stay strings for compose, whatever they look like', () => {
        const text = generate();
        expect(text).toContain('SERVER_PORT: "10340"');
        expect(text).toContain('AUTO_ACCOUNT_CREATION: "True"');
    });

    test('a service it does not know about fails rather than keep the shared ports', () => {
        expect(() => generate(`${SOURCE.trimEnd()}\n  extra:\n    image: x\n    ports:\n      - "10300:10300"\n`)).toThrow(/extra/);
        expect(() => generate('services:\n  db:\n    image: x\n')).toThrow(/gameserver/);
    });

    test('composePorts reads back what it wrote', () => {
        expect(composePorts(generate())).toEqual(PORTS);
        expect(() => composePorts(SOURCE.replace(/SERVER_PORT: .*/, ''))).toThrow(/not a generated/);
    });
});

describe('project names', () => {
    test('every name gets the prefix, so none can be the shared project', () => {
        expect(projectName('elated-clarke-d6b72a')).toBe('daoc-throwaway-elated-clarke-d6b72a');
        expect(projectName('daoc-sdk')).toBe('daoc-throwaway-daoc-sdk');
    });

    test('names are made valid for compose and safe as a folder', () => {
        expect(projectName('My Check!')).toBe('daoc-throwaway-my-check');
        expect(projectName('../../x')).toBe('daoc-throwaway-x');
        expect(() => projectName('...')).toThrow();
    });
});

describe('port slots', () => {
    test('slot 0 would be the shared ports, and is never handed out', () => {
        expect(slotPorts(0)).toEqual({ game: 10300, udp: 10400, db: 13306 });
        expect(firstFreeSlot(new Set())).toEqual(slotPorts(1));
    });

    test('publishedPorts reads docker ps, ranges and unpublished ports included', () => {
        const ps = [
            '0.0.0.0:10320->10320/tcp, [::]:10320->10320/tcp, 0.0.0.0:10420->10420/udp, [::]:10420->10420/udp',
            '3306/tcp',
            '0.0.0.0:13336->3306/tcp',
            '127.0.0.1:8000-8002->8000-8002/tcp',
        ].join('\n');
        expect([...publishedPorts(ps)].sort()).toEqual([10320, 10420, 13336, 8000, 8001, 8002].sort());
    });

    test('a slot is skipped when any one of its ports is taken', () => {
        expect(firstFreeSlot(new Set([10310]))).toEqual(slotPorts(2));
        expect(firstFreeSlot(new Set([10410]))).toEqual(slotPorts(2));
        expect(firstFreeSlot(new Set([13316, 13326]))).toEqual(slotPorts(3));
    });

    test('with every slot taken it says so', () => {
        const all = new Set(Array.from({ length: 10 }, (_, slot) => slotPorts(slot).game));
        expect(() => firstFreeSlot(all)).toThrow(/slots are taken/);
    });

    test('recognises the ways docker reports a taken port', () => {
        expect(isPortConflict('Bind for 0.0.0.0:10340 failed: port is already allocated')).toBe(true);
        expect(isPortConflict('ports are not available: exposing port TCP 0.0.0.0:13346')).toBe(true);
        expect(isPortConflict('listen tcp 0.0.0.0:10340: bind: address already in use')).toBe(true);
        expect(isPortConflict('dependency failed to start: container db exited (1)')).toBe(false);
    });
});

describe('readiness', () => {
    test('waits for the port this stack moved to', () => {
        const logged = '11:09:44 | INF | DOL.Network.BaseServer | Server is now listening for incoming connections on 0.0.0.0:10310';
        expect(logged).toContain(listeningLine(10310));
        expect(logged).not.toContain(listeningLine(10300));
    });
});

describe('imagePinWarning', () => {
    test('warns only for an image built before the pin moved', () => {
        expect(imagePinWarning('2026-10-29T20:42:15.5Z', '2026-10-29T08:54:10+01:00')).toBeNull();
        expect(imagePinWarning('2026-10-29T06:00:00Z', '2026-10-29T08:54:10+01:00')).toContain('may lack that code');
    });

    test('compares instants, not text: the offsets differ', () => {
        expect(imagePinWarning('2026-10-29T07:54:11Z', '2026-10-29T08:54:10+01:00')).toBeNull();
    });

    test('says nothing when a date is unreadable', () => {
        expect(imagePinWarning('', '2026-10-29T08:54:10+01:00')).toBeNull();
    });
});

describe('seed volumes', () => {
    const inputs = {
        dumpCommit: '54bc088',
        dumpChanges: '',
        gameImage: 'sha256:68b6',
        dbService: { image: 'mariadb:10.6', command: '--lower_case_table_names=1' },
        properties: [['total_accounts_allowed_sameip', '1000']] as [string, string][],
    };

    test('the same inputs find the same seed, from any checkout', () => {
        expect(seedVolumeName({ ...inputs })).toBe(seedVolumeName(inputs));
        expect(seedVolumeName(inputs)).toMatch(/^daoc-seed-[0-9a-f]{12}$/);
    });

    test('whatever would change the database gets a seed of its own', () => {
        const name = seedVolumeName(inputs);
        for (const changed of [
            { dumpCommit: 'f0aaa1e' },
            { dumpChanges: ' M account.sql\n' },
            { gameImage: 'sha256:ad9d' },
            { dbService: { image: 'mariadb:10.11', command: '--lower_case_table_names=1' } },
            { properties: [['total_accounts_allowed_sameip', '20']] as [string, string][] },
        ]) expect(seedVolumeName({ ...inputs, ...changed })).not.toBe(name);
    });

    test('a seed is not a project: no stack name can produce one', () => {
        expect(seedVolumeName(inputs).startsWith('daoc-throwaway-')).toBe(false);
        expect(dataVolume(projectName('x'))).toBe('daoc-throwaway-x_db-data');
    });

    test('only other seeds are stale: never the one in use, a stack volume or the shared one', () => {
        const keep = seedVolumeName(inputs);
        const old = seedVolumeName({ ...inputs, gameImage: 'old' });
        expect(staleSeeds([keep, old, 'daoc-sdk_db-data', 'daoc-seed-mine_db-data', 'daoc-throwaway-x_db-data', ''], keep)).toEqual([old]);
    });
});

describe('account limits', () => {
    test('the two values the recipe needs, taken from server:setup', () => {
        expect(accountProperties().map(p => [p.key, p.value])).toEqual([
            ['time_between_account_creation_sameip', '0'],
            ['total_accounts_allowed_sameip', '1000'],
        ]);
    });
});

describe('parseArgs', () => {
    test('the command, with defaults', () => {
        expect(parseArgs(['up'], 'tree')).toEqual({ command: 'up', name: 'tree', cold: false, timeoutMs: 600_000 });
        expect(parseArgs(['down'], 'tree').command).toBe('down');
    });

    test('options', () => {
        expect(parseArgs(['up', '--name=check', '--cold', '--timeout=90'], 'tree')).toEqual({ command: 'up', name: 'check', cold: true, timeoutMs: 90_000 });
    });

    test('anything else is refused with the usage', () => {
        expect(() => parseArgs([])).toThrow(/usage/);
        expect(() => parseArgs(['restart'])).toThrow(/usage/);
        expect(() => parseArgs(['up', '--force'])).toThrow(/unknown option/);
        expect(() => parseArgs(['up', '--timeout=soon'])).toThrow(/unknown option/);
        expect(() => parseArgs(['up', '--name='])).toThrow(/unknown option/);
    });
});
