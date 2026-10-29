// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApiModel, generateApiMarkdown } from '../generate-api-docs';

const sdkDir = join(import.meta.dir, '..');

describe('generated API reference', () => {
    test('matches the checked-in sdk/API.md (regenerate with bun run docs:api)', async () => {
        const [generated, checkedIn] = await Promise.all([
            generateApiMarkdown(sdkDir),
            readFile(join(sdkDir, 'API.md'), 'utf8'),
        ]);
        expect(checkedIn).toBe(generated);
    });

    test('contains every public BotSDK method with full signatures', async () => {
        const model = await buildApiModel(sdkDir);
        const generated = await generateApiMarkdown(sdkDir);
        const methods = [...model.botActionsMethods, ...model.sdkMethods];
        expect(model.sdkMethods.length).toBeGreaterThan(60);
        for (const method of methods) {
            expect(generated).toContain(method.name);
            expect(method.signature).toContain(':');
        }
        for (const name of ['onConnectionStateChange', 'onStateUpdate', 'waitForCondition', 'findNearbyNpc', 'sendMoveTo', 'sendCastSpell', 'say']) {
            expect(model.sdkMethods.some(m => m.name === name)).toBeTrue();
        }
        expect(model.sdkMethods.some(m => m.name === 'transmit' || m.name === 'handleMessage')).toBeFalse();
    });

    test('preserves async markers, defaults and the DAoC types', async () => {
        const model = await buildApiModel(sdkDir);
        expect(model.sdkMethods.find(m => m.name === 'sendAttack')?.signature).toBe('async sendAttack(on: boolean = true): Promise<ActionResult>');
        expect(model.resultTypes.some(t => t.name === 'BotWorldState')).toBeTrue();
        expect(model.resultTypes.some(t => t.name === 'FindNpcOptions')).toBeTrue();
    });
});
