// Live MCP check: spawn `bun mcp/server.ts`, speak MCP over stdio, run
// execute_code against a bot whose client is not running (BotManager starts the
// gateway if needed and spawns client/runner.ts), then disconnect_bot, which
// must stop that client cleanly.
//   bun client/dev/mcp-e2e.ts <bot>

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';

const bot = process.argv[2] ?? 'run2';
const root = join(import.meta.dir, '..', '..');
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'mcp', 'server.ts')], cwd: root, stderr: 'inherit' });
const client = new Client({ name: 'mcp-e2e', version: '0.0.1' });
await client.connect(transport);
const tools = (await client.listTools()).tools.map(t => t.name);
console.log('tools:', tools.join(', '));

const before = await fetch('http://localhost:7780/status').then(r => r.json()).catch(() => null) as any;
console.log(`gateway before: ${before ? 'up' : 'down'}; ${bot} registered: ${!!before?.bots?.[bot]?.clientId && before.bots[bot].status !== 'dead'}`);

let t = Date.now();
const r1 = await client.callTool({
    name: 'execute_code',
    arguments: {
        bot_name: bot,
        timeout: 0.5, // 30 s for the code itself; client start-up must not count against it
        world: 'none',
        code: `const p = sdk.getPlayer();
await sdk.sendSay('mcp e2e hello');
const echoed = await sdk.waitForCondition(s => s.gameMessages.some(m => m.text.includes('mcp e2e hello')), 5000).then(() => true, () => false);
return { name: p?.name, level: p?.level, inGame: sdk.getState()?.inGame, maxConcentration: p?.maxConcentration, echoed };`,
    },
}, undefined, { timeout: 300_000 });
const s1 = r1.structuredContent as any;
console.log(`execute_code #1 (${Date.now() - t} ms): ok=${s1?.ok} result=${JSON.stringify(s1?.result)} error=${JSON.stringify(s1?.error)}`);
if (s1?.logs?.length) console.log('logs:', s1.logs);

t = Date.now();
const r2 = await client.callTool({ name: 'execute_code', arguments: { bot_name: bot, world: 'brief', code: 'return sdk.getPosition();' } }, undefined, { timeout: 120_000 });
const s2 = r2.structuredContent as any;
console.log(`execute_code #2 (${Date.now() - t} ms, client reused): ok=${s2?.ok} result=${JSON.stringify(s2?.result)} world.player=${s2?.world?.player?.name}`);

const listed = JSON.parse(((await client.callTool({ name: 'list_bots', arguments: {} })).content as any)[0].text);
const pid = listed.bots[0]?.clientPid as number | null;
console.log('list_bots:', JSON.stringify(listed.bots));

t = Date.now();
const d = await client.callTool({ name: 'disconnect_bot', arguments: { name: bot } }, undefined, { timeout: 200_000 });
console.log(`disconnect_bot (${Date.now() - t} ms):`, (d.content as any)[0].text.replace(/\s+/g, ' '));
let alive = false;
if (pid) try { process.kill(pid, 0); alive = true; } catch {}
console.log(`spawned client pid ${pid} still alive: ${alive}`);
await client.close();

const ok = s1?.ok && s1.result?.inGame && s1.result?.echoed && s2?.ok && !alive && /quit and exited/.test((d.content as any)[0].text);
console.log(ok ? 'MCP E2E PASS' : 'MCP E2E FAIL');
process.exit(ok ? 0 : 1);
