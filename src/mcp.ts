#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolModules } from './tools/registry.js';
import { getConfig } from './lib/config.js';

// ask_user blocks on stdin (MCP owns stdin for protocol messages)
const tools = toolModules.filter((m) => m.definition.function.name !== 'ask_user');

const server = new Server(
  { name: 'techunter', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((m) => ({
    name: m.definition.function.name,
    description: m.definition.function.description,
    inputSchema: m.definition.function.parameters,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const mod = tools.find((m) => m.definition.function.name === request.params.name);
  if (!mod) {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  try {
    const config = getConfig();
    const result = await mod.execute(request.params.arguments ?? {}, config);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
