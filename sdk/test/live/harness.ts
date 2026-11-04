// In-process live harness: real DaocClient <-> in-process gateway <-> real BotSDK + BotActions.
// Used by the live scripts in this folder until/alongside client/runner.ts.
//
//   const gw = startGateway();
//   const a = await startLiveBot({ username: 'act1', className: 'Fighter' }, gw);
//   ... a.bot.walkTo(...)
//   await a.stop(); await gw.stop();

import { createGateway, type Gateway } from '../../../gateway/gateway';
import { DaocClient } from '../../../client/client';
import { BotSDK } from '../../index';
import { BotActions } from '../../actions';
import type { BotWorldState } from '../../types';

const t0 = Date.now();
export const log = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

export function startGateway(): Gateway {
    return createGateway({ port: 0, hostname: '127.0.0.1', quiet: true });
}

export interface LiveBotOptions {
    username: string;
    password?: string;
    realm?: string;
    className?: string;
    raceName?: string;
    /** Print every new game message (default true). */
    showMessages?: boolean;
    clientLog?: boolean;
}

export interface LiveBot {
    username: string;
    client: DaocClient;
    sdk: BotSDK;
    bot: BotActions;
    state(): BotWorldState;
    /** Release if dead, then quit cleanly (avoids the 60 s link-death lockout). */
    stop(): Promise<void>;
}

export async function startLiveBot(opts: LiveBotOptions, gateway: Gateway): Promise<LiveBot> {
    const { username } = opts;
    const password = opts.password ?? `${username}pw`;
    // LIVE_SERVER=host:port points the check at a throwaway stack.
    const [host, port] = (process.env.LIVE_SERVER ?? '').split(':');
    const client = new DaocClient({
        ...(host ? { host, port: Number(port) } : {}),
        username, password,
        realm: opts.realm ?? 'albion',
        className: opts.className ?? 'Fighter',
        raceName: opts.raceName ?? 'Briton',
        log: opts.clientLog ? m => log(`  [${username}/client] ${m}`) : undefined,
    });
    const ws = new WebSocket(gateway.url);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('gateway ws error')); });
    ws.onmessage = async ev => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'action') {
            const result = await client.execute(msg.action);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'actionResult', actionId: msg.actionId, result }));
        } else if (msg.type === 'save_and_disconnect') {
            await client.quit().catch(() => {});
            ws.close();
        }
    };
    ws.send(JSON.stringify({ type: 'connected', username, password, clientId: `harness-${username}`, maxMessageLength: 200 }));
    let lastMsg = 0;
    client.onStateChange(state => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', state }));
        if (opts.showMessages !== false) {
            for (const m of state.gameMessages) {
                if (m.id <= lastMsg) continue;
                lastMsg = m.id;
                log(`  [${username}] msg[${m.type}/${m.rawType}${m.popup ? ',popup' : ''}] ${m.text.replace(/\n/g, ' | ').slice(0, 220)}`);
            }
        }
    });
    log(`[${username}] logging in`);
    const sdk = new BotSDK({ botUsername: username, gatewayUrl: gateway.url, readyTimeout: 15_000, actionTimeout: 15_000, autoReconnect: false });
    try {
        await client.connect();
        log(`[${username}] in game as ${client.charName}`);
        await sdk.connect();
        await sdk.waitForReady(15_000);
    } catch (error) {
        // In game but the SDK side failed: quit cleanly, or the account is locked out for 60 s.
        await sdk.disconnect().catch(() => {});
        await client.quit().catch(() => {});
        ws.close();
        throw error;
    }
    const bot = new BotActions(sdk);

    return {
        username, client, sdk, bot,
        state: () => sdk.getState()!,
        async stop() {
            try {
                if (sdk.getPlayer()?.isDead) {
                    await sdk.sendRelease();
                    await sdk.waitForCondition(s => !s.player?.isDead, 20_000).catch(() => {});
                }
                await sdk.sendStop().catch(() => null);
            } catch { /* ignore */ }
            await sdk.disconnect().catch(() => {});
            log(`[${username}] quitting`);
            await client.quit().catch(e => log(`[${username}] quit failed: ${e}`));
            ws.close();
            log(`[${username}] quit done (phase ${client.phase})`);
        },
    };
}

/** Start several bots in order; if one fails, quit the ones already in game before rethrowing. */
export async function startLiveBots(list: LiveBotOptions[], gateway: Gateway): Promise<LiveBot[]> {
    const started: LiveBot[] = [];
    try {
        for (const opts of list) started.push(await startLiveBot(opts, gateway));
        return started;
    } catch (error) {
        await Promise.all(started.map(b => b.stop()));
        await gateway.stop();
        throw error;
    }
}

/** Run `fn` with cleanup on success, error and SIGINT. */
export async function withBots<T>(bots: LiveBot[], gateway: Gateway, fn: () => Promise<T>): Promise<T | undefined> {
    let stopping = false;
    const cleanup = async () => {
        if (stopping) return;
        stopping = true;
        await Promise.all(bots.map(b => b.stop()));
        await gateway.stop();
    };
    process.on('SIGINT', () => { void cleanup().then(() => process.exit(130)); });
    try {
        return await fn();
    } catch (e) {
        log(`ERROR ${(e as Error).stack ?? e}`);
        return undefined;
    } finally {
        await cleanup();
    }
}
