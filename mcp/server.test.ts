import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server';

async function connected() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);
    return { client, server };
}

describe('daoc-agent MCP server', () => {
    test('lists tools and serves sdk/API.md', async () => {
        const { client, server } = await connected();
        expect(client.getServerVersion()?.name).toBe('daoc-agent');
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).sort()).toEqual(['disconnect_bot', 'execute_code', 'list_bots']);
        const { resources } = await client.listResources();
        const doc = await client.readResource({ uri: resources[0]!.uri });
        expect((doc.contents[0] as any).text).toContain('# SDK API Reference');
        const list = await client.callTool({ name: 'list_bots', arguments: {} });
        expect(JSON.parse((list.content as any)[0].text)).toEqual({ bots: [], count: 0 });
        await server.close();
    });

    test('execute_code validates its input', async () => {
        const { client, server } = await connected();
        const both = await client.callTool({ name: 'execute_code', arguments: { bot_name: 'x', code: '1', script: 'y.ts' } });
        expect(both.isError).toBe(true);
        expect((both.structuredContent as any).error.kind).toBe('invalid_input');
        const none = await client.callTool({ name: 'execute_code', arguments: { code: '1' } });
        expect((none.structuredContent as any).error.message).toBe('bot_name is required');
        await server.close();
    });
});
