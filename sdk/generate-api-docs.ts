#!/usr/bin/env bun
// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
/**
 * Generate sdk/API.md from the TypeScript syntax tree.
 *
 * Usage:
 *   bun sdk/generate-api-docs.ts
 *   bun sdk/generate-api-docs.ts --check
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

interface MethodDoc {
    name: string;
    signature: string;
    description: string;
}

interface PropertyDoc {
    signature: string;
    description: string;
}

interface TypeDoc {
    name: string;
    description: string;
    properties: PropertyDoc[];
}

interface ApiModel {
    botActionsMethods: MethodDoc[];
    sdkMethods: MethodDoc[];
    resultTypes: TypeDoc[];
}

function sourceFile(path: string, source: string): ts.SourceFile {
    return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some(modifier => modifier.kind === kind));
}

function isPublic(node: ts.Node): boolean {
    return !hasModifier(node, ts.SyntaxKind.PrivateKeyword) &&
        !hasModifier(node, ts.SyntaxKind.ProtectedKeyword);
}

function normalizeCode(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function descriptionFor(node: ts.Node): string {
    const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
    const comment = docs.at(-1)?.comment;
    return normalizeCode(ts.getTextOfJSDocComment(comment) ?? '');
}

function methodName(node: ts.MethodDeclaration, file: ts.SourceFile): string {
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
        return node.name.text;
    }
    return normalizeCode(node.name.getText(file));
}

function methodSignature(node: ts.MethodDeclaration, file: ts.SourceFile): string {
    const asyncPrefix = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
    const typeParameters = node.typeParameters?.length
        ? `<${node.typeParameters.map(parameter => normalizeCode(parameter.getText(file))).join(', ')}>`
        : '';
    const parameters = node.parameters
        .map(parameter => normalizeCode(parameter.getText(file)))
        .join(', ');
    const returnType = node.type ? normalizeCode(node.type.getText(file)) : 'unknown';
    return `${asyncPrefix}${methodName(node, file)}${typeParameters}(${parameters}): ${returnType}`;
}

function extractPublicClassMethods(
    path: string,
    source: string,
    className: string
): MethodDoc[] {
    const file = sourceFile(path, source);
    const classNode = file.statements.find(
        (statement): statement is ts.ClassDeclaration =>
            ts.isClassDeclaration(statement) && statement.name?.text === className
    );
    if (!classNode) {
        throw new Error(`Class ${className} was not found in ${path}`);
    }

    return classNode.members
        .filter((member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) && isPublic(member)
        )
        .map(method => ({
            name: methodName(method, file),
            signature: methodSignature(method, file),
            description: descriptionFor(method),
        }));
}

function extractResultTypes(path: string, source: string, filter: (name: string) => boolean = () => true): TypeDoc[] {
    const file = sourceFile(path, source);

    return file.statements
        .filter((statement): statement is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(statement) &&
            hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
            filter(statement.name.text)
        )
        .map(statement => ({
            name: statement.name.text,
            description: descriptionFor(statement),
            properties: statement.members
                .filter((member): member is ts.PropertySignature =>
                    ts.isPropertySignature(member) && Boolean(member.name)
                )
                .map(property => ({
                    signature: normalizeCode(property.getText(file)).replace(/;$/, ''),
                    description: descriptionFor(property),
                })),
        }));
}

function markdownCell(text: string): string {
    return text
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ');
}

const CONNECTION_METHODS = new Set([
    'connect', 'disconnect', 'isConnected', 'isAuthenticated', 'getConnectionState', 'getReconnectAttempt',
    'onConnectionStateChange', 'getConnectionMode', 'waitForConnection', 'checkBotStatus', 'isBotConnected',
    'launchClient', 'waitForBotConnection', 'onStateUpdate', 'getStateReceivedAt', 'getStateAge',
]);
const CHAT_METHODS = new Set(['getChat', 'getNewChat', 'getChatFrom', 'waitForChat', 'say', 'send', 'getGameMessages']);

function methodCategory(name: string, surface: 'actions' | 'sdk'): string {
    const lower = name.toLowerCase();

    if (surface === 'actions') {
        if (lower.includes('dialog') || lower.includes('blocking') || lower.includes('whisper') || lower.includes('talk')) return 'NPC Dialog & UI';
        if (lower.includes('walk') || lower.includes('move') || lower.includes('follow') || lower.includes('face') || lower.includes('stop')) return 'Movement';
        if (lower.includes('attack') || lower.includes('kill') || lower.includes('cast') || lower.includes('style') || lower.includes('target') || lower.includes('pull')) return 'Combat';
        if (lower.includes('rest') || lower.includes('sit') || lower.includes('release') || lower.includes('bind') || lower.includes('quit')) return 'Status & Recovery';
        if (lower.includes('equip') || lower.includes('pickup') || lower.includes('loot') || lower.includes('drop') || lower.includes('item') || lower.includes('destroy')) return 'Items & Equipment';
        if (lower.includes('merchant') || lower.includes('shop') || lower.includes('buy') || lower.includes('sell')) return 'Merchants';
        if (lower.includes('train') || lower.includes('spec')) return 'Training';
        if (lower.includes('group') || lower.includes('invite')) return 'Group';
        if (lower.includes('vault')) return 'Vault';
        if (lower.includes('wait')) return 'Condition Waiting';
        return 'Other';
    }

    if (CONNECTION_METHODS.has(name)) return 'Connection & Subscriptions';
    if (CHAT_METHODS.has(name)) return 'Chat';
    if (name === 'distanceTo' || name === 'headingTo') return 'Geometry';
    if (lower.startsWith('get') || lower.startsWith('find') || lower.startsWith('count') || lower.startsWith('is')) return 'State Access';
    if (lower.startsWith('send')) return 'Raw Actions';
    if (lower.includes('wait')) return 'Condition Waiting';
    return 'Other';
}

function renderMethodGroups(
    lines: string[],
    methods: MethodDoc[],
    surface: 'actions' | 'sdk'
): void {
    const groups = new Map<string, MethodDoc[]>();
    for (const method of methods) {
        const category = methodCategory(method.name, surface);
        const group = groups.get(category) ?? [];
        group.push(method);
        groups.set(category, group);
    }

    for (const [category, group] of groups) {
        lines.push(`### ${category}`, '', '| Signature | Description |', '|---|---|');
        for (const method of group) {
            const description = method.description || '_No description provided._';
            lines.push(`| \`${markdownCell(method.signature)}\` | ${markdownCell(description)} |`);
        }
        lines.push('');
    }
}

function renderApiMarkdown(model: ApiModel): string {
    const lines: string[] = [
        '# SDK API Reference',
        '',
        '> Auto-generated from TypeScript source. Do not edit directly.',
        '> Run `bun run docs:api` to regenerate or `bun run docs:api:check` to verify it.',
        '',
        '## Execution model',
        '',
        '- `bot.*` methods are high-level helpers. They observe evidence (position, HP, inventory, messages, dialogs) before reporting success. Inspect `success` and any `reason` or `message` on the result.',
        '- `sdk.send*` methods are low-level dispatches. A successful `ActionResult` means the headless client accepted and dispatched the action (packets written); it does **not** prove that the DAoC server applied it.',
        '- Methods whose signature returns `Promise<...>` are asynchronous and must be awaited. State reads (`get*`, `find*`) are synchronous reads of the last snapshot.',
        '- Coordinates are DAoC global region coordinates: `x`/`y` on the ground plane, `z` is height. Headings are 0..4095 (0 = +Y, clockwise). Distances are world units (~191 units/s at full run speed).',
        '- Backpack slots are 40-79, equipment slots 10-37 (`EquipmentSlot`). `getInventory()` lists occupied slots only: pass `item.slot`, never an array index.',
        '- `state.tick` is the client publish counter, not a server tick; `waitForTicks(n)` waits for n more published snapshots.',
        '',
        '## BotActions (high-level)',
        '',
    ];

    if (model.botActionsMethods.length === 0) lines.push('_No high-level methods yet._', '');
    renderMethodGroups(lines, model.botActionsMethods, 'actions');

    lines.push('---', '', '## BotSDK (low-level)', '');
    renderMethodGroups(lines, model.sdkMethods, 'sdk');

    lines.push('---', '', '## Types', '');
    for (const type of model.resultTypes) {
        lines.push(`### ${type.name}`, '');
        if (type.description) lines.push(type.description, '');
        lines.push('```typescript', `interface ${type.name} {`);
        for (const property of type.properties) {
            if (property.description) {
                lines.push(`  /** ${property.description.replace(/\*\//g, '*\\/')} */`);
            }
            lines.push(`  ${property.signature};`);
        }
        lines.push('}', '```', '');
    }

    return `${lines.join('\n').trimEnd()}\n`;
}

export async function buildApiModel(sdkDir = import.meta.dir): Promise<ApiModel> {
    const actionsPath = join(sdkDir, 'actions.ts');
    const indexPath = join(sdkDir, 'index.ts');
    const typesPath = join(sdkDir, 'types.ts');
    const [actionsSource, indexSource, typesSource] = await Promise.all([
        readFile(actionsPath, 'utf8'),
        readFile(indexPath, 'utf8'),
        readFile(typesPath, 'utf8'),
    ]);

    return {
        botActionsMethods: extractPublicClassMethods(actionsPath, actionsSource, 'BotActions'),
        sdkMethods: extractPublicClassMethods(indexPath, indexSource, 'BotSDK'),
        resultTypes: [
            ...extractResultTypes(typesPath, typesSource),
            ...extractResultTypes(indexPath, indexSource),
            ...extractResultTypes(actionsPath, actionsSource, name => name.endsWith('Result') || name.endsWith('Options')),
        ],
    };
}

export async function generateApiMarkdown(sdkDir = import.meta.dir): Promise<string> {
    return renderApiMarkdown(await buildApiModel(sdkDir));
}

async function main(): Promise<void> {
    const check = process.argv.includes('--check');
    const sdkDir = import.meta.dir;
    const outputPath = join(sdkDir, 'API.md');
    const model = await buildApiModel(sdkDir);
    const markdown = renderApiMarkdown(model);

    if (check) {
        const current = await readFile(outputPath, 'utf8').catch(() => '');
        if (current !== markdown) {
            throw new Error('sdk/API.md is stale. Run `bun run docs:api` and commit the result.');
        }
        console.log(`Verified ${outputPath}`);
    } else {
        await writeFile(outputPath, markdown);
        console.log(`Generated ${outputPath}`);
    }

    console.log(`  - ${model.botActionsMethods.length} BotActions methods`);
    console.log(`  - ${model.sdkMethods.length} BotSDK methods`);
    console.log(`  - ${model.resultTypes.length} result/state types`);
}

if (import.meta.main) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
