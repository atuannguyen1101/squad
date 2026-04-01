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

describe('MCP server run status helpers', () => {
  it('formats run-scoped status with sessions, pulses, and questions', async () => {
    const { formatRunStatusSummary } = await import('../packages/squad-sdk/src/mcp/server.js');
    const { createRunContext } = await import('../packages/squad-sdk/src/mcp/run-context.js');
    const { createPulse } = await import('../packages/squad-sdk/src/pulse/pulse.js');

    const context = createRunContext('run-123', 'Validate MCP inspection');
    context.pendingUserQuestions.push({
      questionId: 'q1',
      agentName: 'ben',
      question: 'Need clarification?',
      timestamp: new Date().toISOString(),
    });
    context.pulseCollector.record(createPulse({
      agent: 'fido',
      phase: 'reviewing',
      status: 'ok',
      progressPct: 80,
      summary: 'Checking handoff artifacts',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    }));

    const summary = formatRunStatusSummary(
      context,
      [
        {
          agentName: 'fido',
          sessionId: '12345678-1234-1234-1234-123456789abc',
          runId: 'run-123',
          createdAt: new Date('2026-03-31T00:00:00.000Z'),
          lastActiveAt: new Date('2026-03-31T00:01:00.000Z'),
          charterRole: 'Quality Owner',
          messageCount: 4,
        },
      ],
      'http://localhost:3850',
      '  - fido read handoff handoff-1\n  - eecom wrote scratchpad eecom:artifact',
    );

    expect(summary).toContain('Run: run-123');
    expect(summary).toContain('Status: active');
    expect(summary).toContain('Validate MCP inspection');
    expect(summary).toContain('fido: Quality Owner');
    expect(summary).toContain('fido: reviewing 80%');
    expect(summary).toContain('Communication trace:');
    expect(summary).toContain('fido read handoff handoff-1');
    expect(summary).toContain('Need clarification?');
    expect(summary).toContain('http://localhost:3850');
  });

  it('detects stale session errors for ask fallback', async () => {
    const { isSessionUnavailableError } = await import('../packages/squad-sdk/src/mcp/server.js');

    expect(isSessionUnavailableError(new Error('No active session for ben (runId: run-1)'))).toBe(true);
    expect(isSessionUnavailableError(new Error('Request session.send failed with message: Session not found: abc'))).toBe(true);
    expect(isSessionUnavailableError(new Error('Completely different error'))).toBe(false);
  });

  it('detects agents with pending follow-up replies before run close', async () => {
    const { getPendingRunFollowUpAgents } = await import('../packages/squad-sdk/src/mcp/server.js');

    const pending = getPendingRunFollowUpAgents(
      ['fenster', 'hockney', 'ben'],
      (agentName: string) => {
        if (agentName === 'fenster') {
          return [
            { role: 'assistant' },
            { role: 'user' },
          ];
        }
        if (agentName === 'hockney') {
          return [
            { role: 'assistant' },
            { role: 'assistant' },
          ];
        }
        return [];
      },
    );

    expect(pending).toEqual(['fenster']);
  });

  it('resolves a unique active run for dashboard follow-up delivery', async () => {
    const { resolveDashboardSendRunId } = await import('../packages/squad-sdk/src/mcp/server.js');

    const resolved = resolveDashboardSendRunId(
      [
        {
          agentName: 'hockney',
          sessionId: 'session-1',
          runId: 'run-123',
          createdAt: new Date('2026-03-31T00:00:00.000Z'),
          lastActiveAt: new Date('2026-03-31T00:01:00.000Z'),
          charterRole: 'Reviewer',
          messageCount: 5,
        },
      ],
      'hockney',
    );

    expect(resolved).toEqual({ runId: 'run-123' });
  });

  it('rejects ambiguous dashboard follow-up delivery without runId', async () => {
    const { resolveDashboardSendRunId } = await import('../packages/squad-sdk/src/mcp/server.js');

    const resolved = resolveDashboardSendRunId(
      [
        {
          agentName: 'hockney',
          sessionId: 'session-1',
          runId: 'run-123',
          createdAt: new Date('2026-03-31T00:00:00.000Z'),
          lastActiveAt: new Date('2026-03-31T00:01:00.000Z'),
          charterRole: 'Reviewer',
          messageCount: 5,
        },
        {
          agentName: 'hockney',
          sessionId: 'session-2',
          runId: 'run-456',
          createdAt: new Date('2026-03-31T00:02:00.000Z'),
          lastActiveAt: new Date('2026-03-31T00:03:00.000Z'),
          charterRole: 'Reviewer',
          messageCount: 2,
        },
      ],
      'hockney',
    );

    expect(resolved).toEqual({ error: 'Multiple active sessions found for hockney; provide runId', statusCode: 409 });
  });
});
