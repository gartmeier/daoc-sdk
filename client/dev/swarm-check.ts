// Watch bots through the gateway for N seconds and report anything that looks
// like a link-death (state not in game, stale state, server teleports), then
// optionally quit them cleanly (a quit action makes the runner/swarm bot exit).
//   bun client/dev/swarm-check.ts run3 run4 run5 [--seconds=60] [--quit] [--walk]

import { BotSDK, deriveGatewayUrl, findBotEnv, parseEnvFile } from '../../sdk/index';
import { readFileSync } from 'node:fs';

const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
const seconds = Number(process.argv.find(a => a.startsWith('--seconds='))?.split('=')[1] ?? 60);
const quit = process.argv.includes('--quit');
const walk = process.argv.includes('--walk');

interface Watch { name: string; sdk: BotSDK; notInGame: number; maxAgeMs: number; teleports: number; samples: number; ticks: Set<number> }
const watches: Watch[] = [];
for (const name of names) {
    const path = findBotEnv(name);
    if (!path) throw new Error(`no bots/${name}/bot.env`);
    const env = parseEnvFile(readFileSync(path, 'utf-8'));
    const sdk = new BotSDK({ botUsername: env.BOT_USERNAME || name, password: env.PASSWORD!, gatewayUrl: deriveGatewayUrl(env.GATEWAY_URL), connectionMode: 'control', autoLaunchClient: false, showChat: false });
    await sdk.connect();
    await sdk.waitForReady(120_000);
    watches.push({ name, sdk, notInGame: 0, maxAgeMs: 0, teleports: 0, samples: 0, ticks: new Set() });
}
console.log(`watching ${names.join(', ')} for ${seconds} s${walk ? ' (walking back and forth)' : ''}`);
const started = Date.now();
let leg = 0;
while (Date.now() - started < seconds * 1000) {
    await Bun.sleep(1000);
    for (const w of watches) {
        const s = w.sdk.getState();
        w.samples++;
        if (!s?.inGame) w.notInGame++;
        if (s) w.ticks.add(s.tick);
        w.maxAgeMs = Math.max(w.maxAgeMs, w.sdk.getStateAge());
        if (s?.movement.lastStopReason === 'teleported') w.teleports++;
    }
    if (walk && (++leg % 8) === 0) {
        for (const w of watches) {
            const p = w.sdk.getPlayer();
            if (p) void w.sdk.sendMoveTo(p.x + ((leg / 8) % 2 ? 150 : -150), p.y);
        }
    }
}
let ok = true;
for (const w of watches) {
    const p = w.sdk.getPlayer();
    const bad = w.notInGame > 0 || w.maxAgeMs > 5000 || w.teleports > 0;
    if (bad) ok = false;
    console.log(`${w.name}: ${bad ? 'FAIL' : 'ok'} samples ${w.samples}, notInGame ${w.notInGame}, max state age ${w.maxAgeMs} ms, teleports ${w.teleports}, distinct ticks ${w.ticks.size}, corrections ${w.sdk.getMovement()?.correctionCount}, at ${p?.x},${p?.y}`);
}
if (quit) {
    for (const w of watches) console.log(`${w.name} quit: ${(await w.sdk.sendQuit()).message}`);
}
for (const w of watches) await w.sdk.disconnect();
console.log(ok ? 'SWARM CHECK PASS' : 'SWARM CHECK FAIL');
process.exit(ok ? 0 : 1);
