#!/usr/bin/env bun
// Headless bot runner: one DaocClient wired to the SDK gateway.
//
//   bun client/runner.ts <botname>          # reads bots/<botname>/bot.env
//
// Registers with the gateway, waits for its 'status' frame, logs into DAoC and
// then relays state/actions (client/bridge.ts). Exit codes: 0 clean (SIGINT,
// SIGTERM, save_and_disconnect, a quit action), 1 the DAoC session ended
// unexpectedly or login kept failing, 2 bad bot.env or a login the server
// refuses (wrong password, invalid character, realm lock).

import { BotConfigError, createBotBridge, loadBotConfig } from './bridge-config';
import { logStamp } from './log-stamp';

const botName = process.argv[2];
if (!botName || botName.startsWith('-')) {
    console.error('Usage: bun client/runner.ts <botname> [--trace]');
    process.exit(2);
}

let config;
try {
    config = loadBotConfig(botName);
} catch (e) {
    console.error(`[runner:${botName}] ${(e as Error).message}`);
    process.exit(e instanceof BotConfigError ? 2 : 1);
}

const stamp = logStamp; // local time, like the viewer (it was UTC, an hour off in CET)
const { bridge } = createBotBridge(config, {
    log: msg => console.log(`${stamp()} [runner:${botName}] ${msg}`),
    trace: process.argv.includes('--trace'),
});
console.log(`${stamp()} [runner:${botName}] ${config.username} → ${config.charName} (${config.realm} ${config.raceName} ${config.className}) on ${config.host}:${config.port}, gateway ${config.gatewayUrl}`);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
    try {
        process.on(signal, () => {
            if (bridge.isStopping) {
                console.log(`${stamp()} [runner:${botName}] ${signal} again while quitting; still waiting for the clean quit`);
                return;
            }
            console.log(`${stamp()} [runner:${botName}] ${signal}: quitting cleanly`);
            void bridge.stop(signal);
        });
    } catch {
        // signal not supported on this platform
    }
}
process.on('unhandledRejection', reason => console.error(`${stamp()} [runner:${botName}] unhandled rejection:`, reason));

const exit = await bridge.run();
console.log(`${stamp()} [runner:${botName}] exit ${exit.code}: ${exit.reason}`);
// Let the gateway close frame flush.
await Bun.sleep(100);
process.exit(exit.code);
