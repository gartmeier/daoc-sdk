import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Files README.md's License section lists as derived from rs-sdk. */
function listedRsSdkFiles(): string[] {
    const section = read('README.md').split('## License')[1] ?? '';
    const lines = section.split('\n').filter(l => /^\s+- (copied verbatim|adapted)/.test(l));
    return lines.flatMap(l => [...l.matchAll(/`([^`]+\.ts)`/g)].map(m => m[1]!));
}

describe('third-party license notices', () => {
    test('license texts ship with the repo', () => {
        const mit = read('LICENSES/rs-sdk-MIT.txt');
        expect(mit).toContain('MIT License');
        expect(mit).toContain('Copyright (c) 2025 Lost City');
        expect(mit).toContain('The above copyright notice and this permission notice shall be included');
        expect(read('LICENSES/OpenDAoC-GPL-3.0.txt')).toContain('GNU GENERAL PUBLIC LICENSE');
    });

    test('README lists the rs-sdk-derived files, and each one carries the notice', () => {
        const files = listedRsSdkFiles();
        expect(files).toEqual(expect.arrayContaining(['sdk/execution-context.ts', 'sdk/redact.ts', 'mcp/console-capture.ts', 'sdk/index.ts']));
        for (const f of files) {
            expect(existsSync(join(ROOT, f)), f).toBe(true);
            // Within the first few lines (after a shebang).
            const head = read(f).split('\n').slice(0, 3).join('\n');
            expect(head, f).toContain('Copyright (c) 2025 Lost City');
            expect(head, f).toContain('LICENSES/rs-sdk-MIT.txt');
        }
    });
});
