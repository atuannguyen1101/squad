import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the MCP protocol handler
describe('MCPServer protocol', () => {
  let MCPServer: any;

  beforeEach(async () => {
    const mod = await import('../packages/squad-sdk/src/mcp/protocol.js');
    MCPServer = mod.MCPServer;
  });

  it('should construct with name and version', () => {
    const server = new MCPServer('test-server', '1.0.0');
    expect(server).toBeDefined();
  });

  it('should register tools', () => {
    const server = new MCPServer('test-server', '1.0.0');
    server.addTool(
      {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
      async (args: any) => ({ content: [{ type: 'text', text: `echo: ${args.msg}` }] }),
    );
    // Tool is registered (we'll test via handleRequest)
    expect(server).toBeDefined();
  });
});

// Test the MCP protocol message handling
describe('MCP handleRequest', () => {
  let MCPServer: any;
  let server: any;

  beforeEach(async () => {
    const mod = await import('../packages/squad-sdk/src/mcp/protocol.js');
    MCPServer = mod.MCPServer;
    server = new MCPServer('test-server', '1.0.0');

    server.addTool(
      {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
      async (args: any) => ({ content: [{ type: 'text', text: args.message }] }),
    );
  });

  it('should handle initialize', async () => {
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(response.id).toBe(1);
    expect(response.result.protocolVersion).toBe('2024-11-05');
    expect(response.result.capabilities.tools).toBeDefined();
    expect(response.result.serverInfo.name).toBe('test-server');
  });

  it('should handle tools/list', async () => {
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    expect(response.id).toBe(2);
    expect(response.result.tools).toHaveLength(1);
    expect(response.result.tools[0].name).toBe('echo');
  });

  it('should handle tools/call', async () => {
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'hello world' } },
    });

    expect(response.id).toBe(3);
    expect(response.result.content[0].text).toBe('hello world');
  });

  it('should return error for unknown tool', async () => {
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });

    expect(response.id).toBe(4);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Unknown tool');
  });

  it('should return error for unknown method', async () => {
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'unknown/method',
      params: {},
    });

    expect(response.id).toBe(5);
    expect(response.error.code).toBe(-32601);
  });

  it('should handle ping', async () => {
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'ping',
      params: {},
    });

    expect(response.id).toBe(6);
    expect(response.result).toEqual({});
  });

  it('should return null for notifications (no id)', async () => {
    const response = await (server as any).handleRequest({
      method: 'notifications/initialized',
      params: {},
    });

    expect(response).toBeNull();
  });

  it('should handle tool handler errors gracefully', async () => {
    server.addTool(
      {
        name: 'failing_tool',
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => { throw new Error('intentional failure'); },
    );

    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'failing_tool', arguments: {} },
    });

    expect(response.id).toBe(7);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('intentional failure');
  });
});
