#!/usr/bin/env bun
// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
/**
 * MCP server 'daoc-agent': run code against DAoC bots (port of rs-sdk mcp/server.ts).
 *
 * Tools: execute_code, list_bots, disconnect_bot. Resource: sdk/API.md.
 * stdout carries the MCP protocol, so all logging goes to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { join } from 'path';
import { botManager } from './api/index';
import { installExecutionConsoleCapture } from './console-capture';
import { executeCode, executionError, botExecutions, EXECUTE_CODE_OUTPUT_SCHEMA, type WorldOption } from './execute-code';

const API_DOC_URI = 'file://../sdk/API.md';

export const TOOLS = [
    {
        name: 'execute_code',
        description: 'Execute TypeScript on a DAoC bot: inline `code`, or a module file via `script`. Uses bots/{bot_name}/bot.env; starts the gateway and the headless client (bun client/runner.ts) if they are not running. Code runs in an async function with bot (BotActions), sdk (BotSDK), args (your `args` JSON) and EquipmentSlot in scope; `return` a JSON value. A new call for the same bot cancels the one still running. Returns structuredContent { ok, result, logs, error, elapsedMs, world }.',
        inputSchema: {
            type: 'object',
            properties: {
                bot_name: { type: 'string', description: 'Bot name (folder in bots/).' },
                code: {
                    type: 'string',
                    description: 'TypeScript function body (types are stripped). Globals: bot, sdk, args, EquipmentSlot. Example: "const npc = sdk.findNearbyNpc(/rat/i, { attackable: true }); return npc;". A world summary comes with every result. Provide exactly one of code or script.',
                },
                script: {
                    type: 'string',
                    description: 'Path (absolute or relative to the repo root) of a module whose default export is `async ({ bot, sdk, args }) => result`. Reloaded when the file changes. Provide exactly one of code or script.',
                },
                args: { description: 'Any JSON value, exposed as `args` (ctx.args for a script). Use it instead of interpolating values into `code`.' },
                world: { type: 'string', enum: ['none', 'brief', 'full'], description: 'World state with the result: brief (default; lists capped at 10), full (50), or none.' },
                timeout: { type: 'number', description: 'Execution timeout in minutes (default 2, max 60), counted from when the bot is in game: starting the client and logging in (up to 2 min) is not included.' },
            },
            required: ['bot_name'],
        },
        outputSchema: EXECUTE_CODE_OUTPUT_SCHEMA,
    },
    {
        name: 'disconnect_bot',
        description: 'Disconnect the SDK from a bot (cancels its running execution). A client that execute_code started is stopped cleanly (the character quits, then the process exits); a client started elsewhere keeps running.',
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Bot name to disconnect' } }, required: ['name'] },
    },
    {
        name: 'list_bots',
        description: 'List bots this server is connected to.',
        inputSchema: { type: 'object', properties: {} },
    },
];

export function createServer(): Server {
    const server = new Server(
        { name: 'daoc-agent', version: '0.1.0' },
        {
            capabilities: { resources: {}, tools: {} },
            instructions: [
                'Plays Dark Age of Camelot (OpenDAoC) through bots. execute_code runs TypeScript against one bot with `bot` (high-level actions) and `sdk` (state + low-level actions) in scope; the API is the SDK API Reference resource (sdk/API.md).',
                'Results carry structuredContent { ok, result, logs, error: { kind, message } | null, world }. error.kind is one of exception, timeout, superseded, cancelled, not_connected, invalid_input, unserializable_result.',
                'sdk.send* success means the client dispatched the action, not that the server applied it; check state (position, HP, inventory, messages) afterwards.',
                'Pass values through `args` instead of splicing them into `code`. Reusable routines belong in a module run via `script`.',
                'One execution per bot: a new call for the same bot cancels the running one ("superseded"), so never run two calls for one bot in parallel. Different bots run concurrently.',
                'Keep tight loops inside one execute_code call; set world: "none" when calling it in a loop. Coordinates are DAoC global x/y (ground) and z (height); headings are 0..4095.',
            ].join('\n'),
        },
    );

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [{
            uri: API_DOC_URI,
            name: 'SDK API Reference',
            description: 'Auto-generated reference for bot.* (high-level actions) and sdk.* (state reads, waits, send* actions).',
            mimeType: 'text/markdown',
        }],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async request => {
        const uri = request.params.uri;
        if (!uri.startsWith('file://')) throw new Error(`Unsupported URI scheme: ${uri}`);
        const filePath = join(import.meta.dir, uri.replace('file://', ''));
        const text = await Bun.file(filePath).text();
        return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case 'disconnect_bot': {
                    const botName = args?.name;
                    if (typeof botName !== 'string' || !botName) return errorResponse('Bot name is required');
                    const stopped = await botExecutions.run(botName, extra.signal, async () => botManager.disconnect(botName));
                    const note = stopped.stoppedClient ? (stopped.killed ? '; its client did not quit in time and was killed' : '; its client quit and exited') : '';
                    return successResponse({ message: `Disconnected bot "${botName}"${note}`, ...stopped });
                }
                case 'list_bots': {
                    const bots = botManager.list();
                    return successResponse({ bots, count: bots.length });
                }
                case 'execute_code': {
                    const botName = args?.bot_name;
                    const code = args?.code;
                    const script = args?.script;
                    const world = args?.world ?? 'brief';
                    if (typeof botName !== 'string' || !botName) return executionError('invalid_input', 'bot_name is required');
                    if ((code === undefined) === (script === undefined)) return executionError('invalid_input', 'Provide exactly one of code or script');
                    if (code !== undefined && (typeof code !== 'string' || !code)) return executionError('invalid_input', 'code must be a non-empty string');
                    if (script !== undefined && (typeof script !== 'string' || !script)) return executionError('invalid_input', 'script must be a non-empty path');
                    if (!['none', 'brief', 'full'].includes(world as string)) return executionError('invalid_input', 'world must be none, brief or full');
                    const timeoutMinutes = Math.min(Math.max(Number(args?.timeout) || 2, 0.1), 60);
                    return executeCode(botManager, botName, (code as string | undefined) ?? { script: script as string }, timeoutMinutes * 60_000, extra.signal, botExecutions,
                        { args: args?.args, world: world as WorldOption });
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            return { content: [{ type: 'text', text: `Error: ${error?.message ?? error}\n\nStack trace:\n${error?.stack ?? ''}` }], isError: true };
        }
    });

    return server;
}

function successResponse(data: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(message: string) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function main() {
    installExecutionConsoleCapture();
    console.error('[MCP Server] Starting daoc-agent MCP server...');
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    console.error('[MCP Server] Server running on stdio');
}

if (import.meta.main) {
    main().catch(error => {
        console.error('[MCP Server] Fatal error:', error);
        process.exit(1);
    });
}
