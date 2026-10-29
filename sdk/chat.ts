#!/usr/bin/env bun
// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// SDK chat CLI: send and read chat without taking control of the bot.
//
//   bun sdk/chat.ts <botname>                      recent chat
//   bun sdk/chat.ts <botname> <message...>         say
//   bun sdk/chat.ts <botname> --to <player> <msg>  private message (/send)
//   bun sdk/chat.ts <botname> --watch              tail live (Ctrl+C)
//
// Uses the gateway's HTTP endpoints (POST /say, POST /dm, GET /chat) so each
// call is one bounded request; --watch uses an observe-mode WebSocket.

import { BotSDK, deriveGatewayUrl, findBotEnv, gatewayHttpBase, parseEnvFile } from './index';
import type { ChatType, GameMessage } from './types';
import { readFileSync } from 'fs';

const HARD_DEADLINE_MS = 90_000;

function printUsage() {
    console.log(`
SDK chat CLI - send and read chat without stealing bot control

Usage:
  bun sdk/chat.ts <botname>                          Show recent chat
  bun sdk/chat.ts <botname> <message...>             Say a message
  bun sdk/chat.ts <botname> --to <player> <msg...>   Private message (/send)
  bun sdk/chat.ts <botname> --watch                  Tail chat live (Ctrl+C)

Options:
  --limit <n>      Messages of history to show (default: 20)
  --system         Include system/combat messages, not just player chat
  --timeout <ms>   Budget per request (default: 5000)
  --help           Show this help

Sending needs a running client for the bot (bun client/runner.ts <botname>);
chat is relayed through it.
`.trim());
}

function formatMessage(m: GameMessage): string {
    return `[${m.type}] ${m.text}`;
}

async function boundedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            lastErr = err;
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    throw lastErr;
}

interface Ctx { botName: string; username: string; password: string; gatewayUrl: string; timeout: number; limit: number; system: boolean }

async function sendViaHttp(ctx: Ctx, text: string, to?: string): Promise<number> {
    const base = gatewayHttpBase(ctx.gatewayUrl);
    const url = `${base}/${to ? 'dm' : 'say'}/${encodeURIComponent(ctx.username)}`;
    let res: Response;
    try {
        res = await boundedFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, to, password: ctx.password, timeoutMs: 10_000 }),
        }, 60_000);
    } catch (err: any) {
        console.error(`Error: Failed to reach gateway at ${base}`);
        console.error(`  ${err?.message ?? err}`);
        return 1;
    }
    const body: any = await res.json().catch(() => null);
    if (res.status === 409) {
        console.error(`Error: ${body?.error ?? 'Bot not connected'}`);
        console.error(`  Start the client: bun client/runner.ts ${ctx.botName}`);
        return 1;
    }
    if (!body || (!res.ok && !Array.isArray(body.results))) {
        console.error(`Error: Failed to send: ${body?.error ?? `gateway answered ${res.status}`}`);
        return 1;
    }
    let ok = true;
    for (const result of body.results ?? []) {
        if (result.success) console.log(`Sent${to ? ` [to ${to}]` : ''}: ${result.chunk}`);
        else { ok = false; console.error(`Error: Failed to send: ${result.message}`); }
    }
    return ok ? 0 : 1;
}

async function readViaHttp(ctx: Ctx): Promise<number> {
    const params = new URLSearchParams({ limit: String(ctx.limit) });
    if (ctx.system) params.set('system', '1');
    if (ctx.password) params.set('password', ctx.password);
    const url = `${gatewayHttpBase(ctx.gatewayUrl)}/chat/${encodeURIComponent(ctx.username)}?${params}`;
    let res: Response;
    try {
        res = await boundedFetch(url, {}, ctx.timeout);
    } catch (err: any) {
        console.error(`Error: Failed to reach gateway at ${gatewayHttpBase(ctx.gatewayUrl)}`);
        console.error(`  ${err?.message ?? err}`);
        return 1;
    }
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.messages)) {
        console.error(`Error: Failed to read chat: ${body?.error ?? `gateway answered ${res.status}`}`);
        return 1;
    }
    if (body.messages.length === 0) {
        console.log('(no chat in recent history)');
        if (body.botStatus && body.botStatus !== 'active') console.log(`(bot client is ${body.botStatus} - history only accumulates while it is connected)`);
    }
    for (const m of body.messages as GameMessage[]) console.log(formatMessage(m));
    return 0;
}

async function watch(ctx: Ctx): Promise<never> {
    const sdk = new BotSDK({
        botUsername: ctx.username,
        password: ctx.password,
        gatewayUrl: ctx.gatewayUrl,
        connectionMode: 'observe',
        autoReconnect: true,
        readyTimeout: 0,
        connectTimeout: ctx.timeout,
    });
    try {
        await sdk.connect();
    } catch (err: any) {
        console.error(`Error: Failed to connect to ${ctx.gatewayUrl}: ${err.message}`);
        process.exit(1);
    }
    const types: readonly ChatType[] | 'all' | undefined = ctx.system ? 'all' : undefined;
    try { await sdk.waitForCondition(() => true, ctx.timeout); } catch {}
    for (const m of sdk.getChat({ limit: ctx.limit, types, includeSelf: true })) console.log(formatMessage(m));
    sdk.getNewChat({ types, includeSelf: true });
    console.log(`--- watching chat for '${ctx.username}' (Ctrl+C to stop) ---`);
    setInterval(() => {
        for (const m of sdk.getNewChat({ types, includeSelf: true })) {
            console.log(`[${new Date().toTimeString().slice(0, 8)}] ${formatMessage(m)}`);
        }
    }, 500);
    return new Promise<never>(() => {});
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        process.exit(args.length === 0 ? 1 : 0);
    }
    let timeout = 5000;
    let limit = 20;
    let watching = false;
    let system = false;
    let to = '';
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
        else if (arg === '--watch') watching = true;
        else if (arg === '--system') system = true;
        else if (arg === '--to') to = args[++i] || '';
        else if (arg === '--timeout') timeout = parseInt(args[++i] || '', 10) || timeout;
        else if (arg === '--limit') limit = parseInt(args[++i] || '', 10) || limit;
        else positional.push(arg);
    }
    const botName = positional[0];
    if (!botName) {
        console.error('Error: Bot name required');
        process.exit(1);
    }
    const message = positional.slice(1).join(' ');
    if (to && !message) {
        console.error('Error: --to requires a message to send');
        process.exit(1);
    }

    let username = botName;
    let password = process.env.PASSWORD || '';
    const envPath = findBotEnv(botName);
    if (envPath) {
        const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
        username = env.BOT_USERNAME || botName;
        password = env.PASSWORD || '';
        if (env.GATEWAY_URL && !process.env.GATEWAY_URL) process.env.GATEWAY_URL = env.GATEWAY_URL;
    }
    const ctx: Ctx = { botName, username, password, gatewayUrl: deriveGatewayUrl(), timeout, limit, system };

    if (watching) await watch(ctx);
    const deadline = setTimeout(() => {
        console.error(`Error: chat CLI exceeded its ${HARD_DEADLINE_MS / 1000}s deadline - giving up`);
        process.exit(1);
    }, HARD_DEADLINE_MS);
    deadline.unref?.();
    process.exit(message ? await sendViaHttp(ctx, message, to || undefined) : await readViaHttp(ctx));
}

main();
