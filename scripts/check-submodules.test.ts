import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { missingSubmodules } from './check-submodules';

const root = mkdtempSync(join(tmpdir(), 'submodules-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('missingSubmodules', () => {
    test('empty clone: both submodules missing', () => {
        mkdirSync(join(root, 'server', 'core'), { recursive: true });   // git leaves an empty dir
        expect(missingSubmodules(root)).toEqual(['server/core', 'server/db']);
    });

    test('checked out: nothing missing', () => {
        mkdirSync(join(root, 'server', 'core', 'GameServer'), { recursive: true });
        writeFileSync(join(root, 'server', 'core', 'GameServer', 'x.cs'), '');
        mkdirSync(join(root, 'server', 'db', 'opendaoc-db-core'), { recursive: true });
        writeFileSync(join(root, 'server', 'db', 'opendaoc-db-core', 'mob.sql'), '');
        expect(missingSubmodules(root)).toEqual([]);
    });

    test('this checkout has them', () => {
        expect(missingSubmodules(join(import.meta.dir, '..'))).toEqual([]);
    });
});
