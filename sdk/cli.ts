#!/usr/bin/env bun
// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// SDK CLI: bot state inspection.
//
//   bun sdk/cli.ts <botname>            one-shot state dump
//   bun sdk/cli.ts <botname> --json     raw BotWorldState JSON
//
// Primary path is one bounded HTTP GET /state/:bot on the gateway; the
// fallback is an observe-mode WebSocket (never 'control', which would
// pre-empt whatever script owns the bot).

import { BotSDK, deriveGatewayUrl, findBotEnv, gatewayHttpBase, parseEnvFile } from './index';
import { formatWorldState } from './formatter';
import type { BotWorldState } from './types';
import { readFileSync } from 'fs';

const STALE_THRESHOLD = 5000;

function noClientHelp(botName: string, username: string) {
    console.error(`  Nothing is publishing game state as '${username}'.`);
    console.error(`  Start the headless client and leave it running: bun client/runner.ts ${botName}`);
    console.error('  (scripts via sdk/runner.ts do NOT start a client; MCP execute_code does.)');
}

async function fetchStateViaHttp(gatewayUrl: string, botName: string, username: string, password: string, timeout: number): Promise<{ state: BotWorldState; stateAge: number } | null> {
    const params = new URLSearchParams();
    if (password) params.set('password', password);
    const qs = params.toString();
    const url = `${gatewayHttpBase(gatewayUrl)}/state/${encodeURIComponent(username)}${qs ? `?${qs}` : ''}`;
    let res: Response | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
        try {
            res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
        } catch (err) {
            lastErr = err;
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    if (!res) {
        console.error(`Error: Failed to reach gateway at ${gatewayHttpBase(gatewayUrl)}`);
        console.error(`  ${(lastErr as any)?.message ?? lastErr}`);
        console.error('  Start it with: bun gateway/gateway.ts');
        process.exit(1);
    }
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
    const body: any = await res.json().catch(() => null);
    if (res.status === 404 || !body?.state) {
        console.error(`Error: No game state for '${username}' (gateway answered OK)`);
        noClientHelp(botName, username);
        if (body?.error && res.status !== 404) console.error(`  ${body.error}`);
        process.exit(1);
    }
    return { state: body.state as BotWorldState, stateAge: Number(body.stateAge) || 0 };
}

async function fetchStateViaSocket(gatewayUrl: string, botName: string, username: string, password: string, timeout: number) {
    const sdk = new BotSDK({
        botUsername: username,
        password,
        gatewayUrl,
        connectionMode: 'observe',
        autoReconnect: false,
        autoLaunchClient: false,
        readyTimeout: 0,
        connectTimeout: timeout,
    });
    try {
        await sdk.connect();
    } catch (err: any) {
        console.error(`Error: Failed to connect to ${gatewayUrl}`);
        console.error(`  ${err.message}`);
        process.exit(1);
    }
    try {
        await sdk.waitForCondition(() => true, timeout);
    } catch {}
    const state = sdk.getState();
    if (!state) {
        console.error(`Error: No game state for '${username}' (gateway connection is fine)`);
        noClientHelp(botName, username);
        await sdk.disconnect();
        process.exit(1);
    }
    const stateAge = sdk.getStateAge();
    await sdk.disconnect();
    return { state, stateAge };
}

function printUsage() {
    console.log(`
SDK CLI - bot state inspection

Usage:
  bun sdk/cli.ts <botname>            One-shot state dump
  bun sdk/cli.ts <botname> --json     Raw JSON state

Options:
  --timeout <ms>   Budget per request (default: 5000)
  --json           Raw BotWorldState JSON
  --help           Show this help

Reads bots/<botname>/bot.env (BOT_USERNAME, PASSWORD, GATEWAY_URL).
To run code on a bot, use a script (bun bots/<name>/script.ts) or MCP execute_code.
`.trim());
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(args.length === 0 ? 1 : 0);
    }
    let timeout = 5000;
    let json = false;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--timeout' || arg === '-t') timeout = parseInt(args[++i] ?? '5000', 10) || 5000;
        else if (arg === '--json') json = true;
        else if (!arg.startsWith('-')) positional.push(arg);
    }
    const botName = positional[0];
    if (!botName) {
        console.error('Error: Bot name required');
        printUsage();
        process.exit(1);
    }

    let username = process.env.BOT_USERNAME || botName;
    let password = process.env.PASSWORD || '';
    const envPath = findBotEnv(botName);
    if (envPath) {
        const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
        username = env.BOT_USERNAME || botName;
        password = env.PASSWORD || '';
        if (env.GATEWAY_URL && !process.env.GATEWAY_URL) process.env.GATEWAY_URL = env.GATEWAY_URL;
    }
    const gatewayUrl = deriveGatewayUrl();

    const result = await fetchStateViaHttp(gatewayUrl, botName, username, password, timeout)
        ?? await fetchStateViaSocket(gatewayUrl, botName, username, password, timeout);
    const { state, stateAge } = result;

    if (json) {
        console.log(JSON.stringify(state, null, 2));
        process.exit(0);
    }
    if (stateAge > STALE_THRESHOLD) {
        console.log(`STALE DATA: state is ${Math.round(stateAge / 1000)}s old (the client may not be running)\n`);
    }
    if (!state.inGame) {
        console.log(`Note: '${username}' is not in game (phase ${state.connection?.phase ?? 'unknown'}, tick ${state.tick})\n`);
    }
    console.log(formatWorldState(state, stateAge));
    process.exit(0);
}

main().catch(err => {
    console.error(`Error: ${err?.message ?? err}`);
    process.exit(1);
});
