/**
 * Integration tests for ToolRegistry (M1-1, M1-2, Issues #88 #92)
 * 
 * Tests tool registration, lookup, filtering, and handler execution for:
 * - squad_route: Routing tasks to agents
 * - squad_decide: Writing decisions to inbox
 * - squad_memory: Appending to agent history
 * - squad_status: Querying session state
 * - squad_skill: Reading/writing skills
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolRegistry, defineTool, type RouteRequest, type DecisionRecord, type MemoryEntry, type ProposalActionRequest } from '@bradygaster/squad-sdk/tools';
import { SessionPool } from '@bradygaster/squad-sdk/client';
import { HandoffStore } from '../packages/squad-sdk/src/handoff/index.js';
import { Scratchpad } from '../packages/squad-sdk/src/scratchpad/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

describe('defineTool', () => {
  it('should create a typed SquadTool', () => {
    const tool = defineTool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
      },
      handler: async (args: { input: string }) => {
        return `Received: ${args.input}`;
      },
    });

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('A test tool');
    expect(tool.parameters).toBeDefined();
    expect(tool.handler).toBeInstanceOf(Function);
  });

  it('should execute handler and return result', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'Echo tool',
      parameters: { type: 'object' },
      handler: async (args: { message: string }) => {
        return { textResultForLlm: args.message, resultType: 'success' as const };
      },
    });

    const result = await tool.handler({ message: 'hello' }, {
      sessionId: 'test-session',
      toolCallId: 'test-call',
      toolName: 'echo',
      arguments: { message: 'hello' },
    });

    expect(result).toEqual({
      textResultForLlm: 'hello',
      resultType: 'success',
    });
  });

  it('should forward invocation metadata to handlers', async () => {
    const seen: Array<{ sessionId: string; toolCallId: string }> = [];
    const tool = defineTool({
      name: 'capture_invocation',
      description: 'Capture invocation metadata',
      parameters: { type: 'object' },
      handler: async (_args: { message: string }, invocation) => {
        seen.push({ sessionId: invocation.sessionId, toolCallId: invocation.toolCallId });
        return { textResultForLlm: 'ok', resultType: 'success' as const };
      },
    });

    await tool.handler({ message: 'hello' }, {
      sessionId: 'session-123',
      toolCallId: 'call-456',
      toolName: 'capture_invocation',
      arguments: { message: 'hello' },
    });

    expect(seen).toEqual([{ sessionId: 'session-123', toolCallId: 'call-456' }]);
  });
});

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  let testRoot: string;

  beforeEach(() => {
    testRoot = path.join('.', '.test-squad-' + randomUUID());
    registry = new ToolRegistry(testRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('registration', () => {
    it('should register all squad tools', () => {
      const tools = registry.getTools();
      expect(tools.length).toBe(16);

      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('squad_route');
      expect(toolNames).toContain('squad_send');
      expect(toolNames).toContain('squad_read_session');
      expect(toolNames).toContain('squad_decide');
      expect(toolNames).toContain('squad_memory');
      expect(toolNames).toContain('squad_status');
      expect(toolNames).toContain('squad_skill');
      expect(toolNames).toContain('squad_pulse');
      expect(toolNames).toContain('squad_scratchpad_write');
      expect(toolNames).toContain('squad_scratchpad_read');
      expect(toolNames).toContain('squad_scratchpad_list');
      expect(toolNames).toContain('squad_publish_handoff');
      expect(toolNames).toContain('squad_read_handoff');
      expect(toolNames).toContain('squad_list_handoffs');
      expect(toolNames).toContain('squad_proposals');
      expect(toolNames).toContain('squad_mcp_call');
    });

    it('should register tools with descriptions and parameters', () => {
      const routeTool = registry.getTool('squad_route');
      expect(routeTool).toBeDefined();
      expect(routeTool!.name).toBe('squad_route');
      expect(routeTool!.description).toContain('Route a task');
      expect(routeTool!.parameters).toBeDefined();
    });
  });

  describe('getTools', () => {
    it('should return all registered tools', () => {
      const tools = registry.getTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(16);
    });

    it('should return tools with handler functions', () => {
      const tools = registry.getTools();
      tools.forEach(tool => {
        expect(tool.handler).toBeInstanceOf(Function);
      });
    });
  });

  describe('getToolsForAgent', () => {
    it('should return all tools when no filter provided', () => {
      const tools = registry.getToolsForAgent();
      expect(tools.length).toBe(16);
    });

    it('should filter tools by allowed list', () => {
      const tools = registry.getToolsForAgent(['squad_route', 'squad_decide']);
      expect(tools.length).toBe(2);
      expect(tools.map(t => t.name)).toEqual(['squad_route', 'squad_decide']);
    });

    it('should handle empty allowed list', () => {
      const tools = registry.getToolsForAgent([]);
      expect(tools.length).toBe(0);
    });

    it('should filter out non-existent tools', () => {
      const tools = registry.getToolsForAgent(['squad_route', 'nonexistent_tool', 'squad_decide']);
      expect(tools.length).toBe(2);
      expect(tools.map(t => t.name)).toEqual(['squad_route', 'squad_decide']);
    });
  });

  describe('getTool', () => {
    it('should retrieve tool by name', () => {
      const tool = registry.getTool('squad_route');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('squad_route');
    });

    it('should return undefined for non-existent tool', () => {
      const tool = registry.getTool('nonexistent');
      expect(tool).toBeUndefined();
    });
  });
});

describe('squad_route handler', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry('.test-squad-route');
  });

  it('should validate target agent is required', async () => {
    const tool = registry.getTool('squad_route')!;
    const result = await tool.handler(
      { targetAgent: '', task: 'Do something' } as RouteRequest,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_route',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'failure',
      error: 'Invalid target agent',
    });
  });

  it('should create route request with valid inputs', async () => {
    const tool = registry.getTool('squad_route')!;
    const result = await tool.handler(
      {
        targetAgent: 'fenster',
        task: 'Implement feature X',
        priority: 'high',
        context: 'Related to PRD-2',
      } as RouteRequest,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_route',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).textResultForLlm).toContain('fenster');
    expect((result as any).textResultForLlm).toContain('high');
  });

  it('should default priority to normal', async () => {
    const tool = registry.getTool('squad_route')!;
    const result = await tool.handler(
      {
        targetAgent: 'brady',
        task: 'Review code',
      } as RouteRequest,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_route',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).toolTelemetry.routeRequest.priority).toBe('normal');
  });

  it('should route within the caller run when session context is available', async () => {
    const mockDispatch = vi.fn().mockResolvedValue({
      sessionId: 'target-session',
      status: 'created_and_sent',
    });

    registry = new ToolRegistry(
      '.test-squad-route-run-aware',
      undefined,
      () => mockDispatch,
      undefined,
      undefined,
      undefined,
      undefined,
      () => (_sessionId: string) => ({ agentName: 'ben', runId: 'run-123' }),
    );

    const tool = registry.getTool('squad_route')!;
    await tool.handler(
      { targetAgent: 'fenster', task: 'Implement feature X' } as RouteRequest,
      {
        sessionId: 'source-session',
        toolCallId: 'test-call',
        toolName: 'squad_route',
        arguments: {},
      }
    );

    expect(mockDispatch).toHaveBeenCalledWith('fenster', 'Implement feature X', undefined, 'run-123');
  });

  it('should include handoff and artifact references in routed context', async () => {
    const mockDispatch = vi.fn().mockResolvedValue({
      sessionId: 'target-session',
      status: 'created_and_sent',
    });

    registry = new ToolRegistry(
      '.test-squad-route-handoffs',
      undefined,
      () => mockDispatch,
      undefined,
      undefined,
      undefined,
      undefined,
      () => (_sessionId: string) => ({ agentName: 'ben', runId: 'run-123' }),
    );

    const tool = registry.getTool('squad_route')!;
    await tool.handler(
      {
        targetAgent: 'fenster',
        task: 'Review the patch',
        handoffIds: ['handoff-1'],
        artifactKeys: ['builder:patch'],
      } as RouteRequest,
      {
        sessionId: 'source-session',
        toolCallId: 'test-call',
        toolName: 'squad_route',
        arguments: {},
      }
    );

    expect(mockDispatch).toHaveBeenCalledWith(
      'fenster',
      'Review the patch',
      expect.stringContaining('handoff-1'),
      'run-123',
    );
    expect(mockDispatch.mock.calls[0]?.[2]).toContain('builder:patch');
  });
});

describe('run-aware coordination tools', () => {
  it('squad_send should stay within the caller run when session context is available', async () => {
    const mockSend = vi.fn().mockResolvedValue('done');
    const registry = new ToolRegistry(
      '.test-squad-send-run-aware',
      undefined,
      undefined,
      () => mockSend,
      undefined,
      undefined,
      undefined,
      () => (_sessionId: string) => ({ agentName: 'ben', runId: 'run-456' }),
    );

    const tool = registry.getTool('squad_send')!;
    const result = await tool.handler(
      { agentName: 'fenster', message: 'Status?' },
      {
        sessionId: 'source-session',
        toolCallId: 'test-call',
        toolName: 'squad_send',
        arguments: {},
      }
    );

    expect(mockSend).toHaveBeenCalledWith('fenster', 'Status?', 'run-456', 'ben');
    expect(result).toMatchObject({ resultType: 'success', textResultForLlm: 'done' });
  });

  it('squad_read_session should stay within the caller run when session context is available', async () => {
    const mockGetMessages = vi.fn().mockReturnValue([
      { role: 'assistant', content: 'done', timestamp: '2026-03-31T12:00:00.000Z' },
    ]);
    const registry = new ToolRegistry(
      '.test-squad-read-run-aware',
      undefined,
      undefined,
      undefined,
      () => mockGetMessages,
      undefined,
      undefined,
      () => (_sessionId: string) => ({ agentName: 'ben', runId: 'run-789' }),
    );

    const tool = registry.getTool('squad_read_session')!;
    const result = await tool.handler(
      { agentName: 'fenster' },
      {
        sessionId: 'source-session',
        toolCallId: 'test-call',
        toolName: 'squad_read_session',
        arguments: {},
      }
    );

    expect(mockGetMessages).toHaveBeenCalledWith('fenster', 'run-789');
    expect(result).toMatchObject({ resultType: 'success' });
    expect((result as any).textResultForLlm).toContain('Session history for fenster');
  });

  it('scratchpad tools should isolate entries by caller run when session context is available', async () => {
    const runPads = new Map<string, Scratchpad>([
      ['run-a', new Scratchpad()],
      ['run-b', new Scratchpad()],
    ]);
    const registry = new ToolRegistry(
      '.test-scratchpad-run-aware',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => (sessionId: string) => ({ agentName: 'ben', runId: sessionId === 'session-a' ? 'run-a' : 'run-b' }),
      () => (runId?: string) => (runId ? runPads.get(runId) ?? null : null),
    );

    const writeTool = registry.getTool('squad_scratchpad_write')!;
    const listTool = registry.getTool('squad_scratchpad_list')!;

    await writeTool.handler(
      { key: 'ben:summary', value: 'run-a artifact', producer: 'ben' },
      {
        sessionId: 'session-a',
        toolCallId: 'call-write',
        toolName: 'squad_scratchpad_write',
        arguments: {},
      }
    );

    const runAList = await listTool.handler(
      {},
      {
        sessionId: 'session-a',
        toolCallId: 'call-list-a',
        toolName: 'squad_scratchpad_list',
        arguments: {},
      }
    );

    const runBList = await listTool.handler(
      {},
      {
        sessionId: 'session-b',
        toolCallId: 'call-list-b',
        toolName: 'squad_scratchpad_list',
        arguments: {},
      }
    );

    expect((runAList as any).textResultForLlm).toContain('ben:summary');
    expect((runBList as any).textResultForLlm).toContain('Scratchpad is empty');
  });

  it('handoff tools should publish, list, and read entries within the caller run', async () => {
    const runStores = new Map<string, HandoffStore>([
      ['run-a', new HandoffStore()],
      ['run-b', new HandoffStore()],
    ]);
    const registry = new ToolRegistry(
      '.test-handoff-run-aware',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => (sessionId: string) => ({ agentName: sessionId === 'session-a' ? 'builder' : 'reviewer', runId: sessionId === 'session-a' ? 'run-a' : 'run-b' }),
      undefined,
      () => (runId?: string) => (runId ? runStores.get(runId) ?? null : null),
    );

    const publishTool = registry.getTool('squad_publish_handoff')!;
    const listTool = registry.getTool('squad_list_handoffs')!;
    const readTool = registry.getTool('squad_read_handoff')!;

    const publishResult = await publishTool.handler(
      {
        toAgent: 'reviewer',
        kind: 'patch',
        summary: 'Patch ready for review',
        details: 'Read the patch and focus on auth edge cases.',
        artifactKeys: ['builder:patch'],
      },
      {
        sessionId: 'session-a',
        toolCallId: 'call-publish',
        toolName: 'squad_publish_handoff',
        arguments: {},
      }
    );

    const handoffId = (publishResult as any).toolTelemetry.handoffId as string;

    const runAList = await listTool.handler(
      { toAgent: 'reviewer' },
      {
        sessionId: 'session-a',
        toolCallId: 'call-list-a',
        toolName: 'squad_list_handoffs',
        arguments: {},
      }
    );

    const runBList = await listTool.handler(
      { toAgent: 'reviewer' },
      {
        sessionId: 'session-b',
        toolCallId: 'call-list-b',
        toolName: 'squad_list_handoffs',
        arguments: {},
      }
    );

    const readResult = await readTool.handler(
      { handoffId },
      {
        sessionId: 'session-a',
        toolCallId: 'call-read-a',
        toolName: 'squad_read_handoff',
        arguments: {},
      }
    );

    expect((runAList as any).textResultForLlm).toContain(handoffId);
    expect((runBList as any).textResultForLlm).toContain('No handoffs found');
    expect((readResult as any).textResultForLlm).toContain('Patch ready for review');
    expect((readResult as any).textResultForLlm).toContain('builder:patch');
  });

  it('squad_status should inspect a target run for built-in actors', async () => {
    const runPads = new Map<string, Scratchpad>([['run-123', new Scratchpad()]]);
    runPads.get('run-123')!.write('eecom:artifact', 'expected-value', 'eecom');
    const runStores = new Map<string, HandoffStore>([['run-123', new HandoffStore()]]);
    runStores.get('run-123')!.publish({
      runId: 'run-123',
      fromAgent: 'eecom',
      toAgent: 'hockney',
      kind: 'patch',
      summary: 'Patch ready',
      details: 'Review the patch',
      artifactKeys: ['eecom:artifact'],
    });

    const registry = new ToolRegistry(
      '.test-run-inspection',
      undefined,
      undefined,
      undefined,
      () => (agentName: string, runId?: string) => runId === 'run-123'
        ? [{ role: 'assistant', content: `${agentName} output`, timestamp: '2026-03-31T00:00:00.000Z' }]
        : [],
      undefined,
      undefined,
      () => (_sessionId: string) => ({ agentName: 'ben', runId: 'inspection-run' }),
      () => (runId?: string) => (runId ? runPads.get(runId) ?? null : null),
      () => (runId?: string) => (runId ? runStores.get(runId) ?? null : null),
      () => (runId: string) => runId === 'run-123'
        ? [
            { agentName: 'eecom', sessionId: 'session-1-12345678' },
            { agentName: 'hockney', sessionId: 'session-2-12345678' },
          ]
        : [],
      undefined,
      () => (runId: string) => runId === 'run-123'
        ? [
            { summary: 'eecom routed work to hockney', type: 'session:tool_call', agentName: 'eecom' },
            { summary: 'hockney read handoff handoff-1', type: 'session:tool_call', agentName: 'hockney' },
          ]
        : [],
    );

    const tool = registry.getTool('squad_status')!;
    const result = await tool.handler(
      { runId: 'run-123', verbose: true },
      {
        sessionId: 'inspector-session',
        toolCallId: 'call-status',
        toolName: 'squad_status',
        arguments: {},
      },
    );

    expect((result as any).resultType).toBe('success');
    expect((result as any).textResultForLlm).toContain('Run run-123 inspection');
    expect((result as any).textResultForLlm).toContain('eecom:artifact');
    expect((result as any).textResultForLlm).toContain('Patch ready');
    expect((result as any).textResultForLlm).toContain('last assistant message: eecom output');
    expect((result as any).textResultForLlm).toContain('Communication trace:');
    expect((result as any).textResultForLlm).toContain('eecom routed work to hockney');
  });

  it('squad_status should reject cross-run inspection for non-built-in agents', async () => {
    const registry = new ToolRegistry(
      '.test-run-inspection-restricted',
      undefined,
      undefined,
      undefined,
      () => () => [],
      undefined,
      undefined,
      () => (_sessionId: string) => ({ agentName: 'fenster', runId: 'run-a' }),
      () => () => null,
      () => () => null,
      () => () => [],
    );

    const tool = registry.getTool('squad_status')!;
    const result = await tool.handler(
      { runId: 'run-b' },
      {
        sessionId: 'source-session',
        toolCallId: 'call-status',
        toolName: 'squad_status',
        arguments: {},
      },
    );

    expect((result as any).resultType).toBe('failure');
    expect((result as any).textResultForLlm).toContain('Cross-run inspection is restricted');
  });

  it('should record communication events for collaboration tools', async () => {
    const recordedEvents: Array<{ toolName: string; runId?: string }> = [];
    const runPads = new Map<string, Scratchpad>([['run-1', new Scratchpad()]]);
    const runStores = new Map<string, HandoffStore>([['run-1', new HandoffStore()]]);
    const mockDispatch = vi.fn().mockResolvedValue({
      sessionId: 'target-session',
      status: 'created_and_sent',
    });

    const registry = new ToolRegistry(
      '.test-communication-events',
      undefined,
      () => mockDispatch,
      undefined,
      undefined,
      undefined,
      undefined,
      () => (_sessionId: string) => ({ agentName: 'eecom', runId: 'run-1' }),
      () => (runId?: string) => (runId ? runPads.get(runId) ?? null : null),
      () => (runId?: string) => (runId ? runStores.get(runId) ?? null : null),
      () => () => [{ agentName: 'eecom', sessionId: 'session-1' }],
      () => async (event) => { recordedEvents.push({ toolName: event.toolName, runId: event.runId }); },
      () => () => [],
    );

    const routeTool = registry.getTool('squad_route')!;
    const publishTool = registry.getTool('squad_publish_handoff')!;
    const readTool = registry.getTool('squad_read_handoff')!;
    const scratchpadWrite = registry.getTool('squad_scratchpad_write')!;

    await routeTool.handler(
      { targetAgent: 'hockney', task: 'Review patch', handoffIds: ['handoff-1'], artifactKeys: ['eecom:artifact'] },
      {
        sessionId: 'source-session',
        toolCallId: 'call-route',
        toolName: 'squad_route',
        arguments: {},
      },
    );

    const publishResult = await publishTool.handler(
      {
        toAgent: 'hockney',
        kind: 'patch',
        summary: 'Patch ready',
        details: 'Read the patch and verify auth behavior.',
        artifactKeys: ['eecom:artifact'],
      },
      {
        sessionId: 'source-session',
        toolCallId: 'call-publish',
        toolName: 'squad_publish_handoff',
        arguments: {},
      },
    );

    await scratchpadWrite.handler(
      { key: 'eecom:artifact', value: 'patch-data', producer: 'eecom' },
      {
        sessionId: 'source-session',
        toolCallId: 'call-write',
        toolName: 'squad_scratchpad_write',
        arguments: {},
      },
    );

    await readTool.handler(
      { handoffId: (publishResult as any).toolTelemetry.handoffId },
      {
        sessionId: 'source-session',
        toolCallId: 'call-read',
        toolName: 'squad_read_handoff',
        arguments: {},
      },
    );

    expect(recordedEvents).toEqual(expect.arrayContaining([
      { toolName: 'squad_route', runId: 'run-1' },
      { toolName: 'squad_publish_handoff', runId: 'run-1' },
      { toolName: 'squad_scratchpad_write', runId: 'run-1' },
      { toolName: 'squad_read_handoff', runId: 'run-1' },
    ]));
  });
});

describe('squad_decide handler', () => {
  let registry: ToolRegistry;
  let testRoot: string;

  beforeEach(() => {
    testRoot = path.join('.', '.test-squad-decide-' + randomUUID());
    registry = new ToolRegistry(testRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('should write decision to inbox directory', async () => {
    const tool = registry.getTool('squad_decide')!;
    const result = await tool.handler(
      {
        author: 'fenster',
        summary: 'Use TypeScript for all new code',
        body: 'TypeScript provides better type safety and developer experience.',
        references: ['PRD-2', 'Issue #88'],
      } as DecisionRecord,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_decide',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });

    const inboxDir = path.join(testRoot, '.squad', 'decisions', 'inbox');
    expect(fs.existsSync(inboxDir)).toBe(true);

    const files = fs.readdirSync(inboxDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^fenster-use-typescript-for-all-new-code\.md$/);

    const content = fs.readFileSync(path.join(inboxDir, files[0]!), 'utf-8');
    expect(content).toContain('Use TypeScript for all new code');
    expect(content).toContain('**By:** fenster');
    expect(content).toContain('**What:**');
    expect(content).toContain('**Why:**');
    expect(content).toContain('**References:** PRD-2, Issue #88');
    expect(content).toContain('TypeScript provides better type safety');
  });

  it('should handle decision without references', async () => {
    const tool = registry.getTool('squad_decide')!;
    const result = await tool.handler(
      {
        author: 'brady',
        summary: 'Short decision',
        body: 'Decision details here.',
      } as DecisionRecord,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_decide',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });

    const inboxDir = path.join(testRoot, '.squad', 'decisions', 'inbox');
    const files = fs.readdirSync(inboxDir);
    const content = fs.readFileSync(path.join(inboxDir, files[0]!), 'utf-8');
    
    expect(content).toContain('Short decision');
    expect(content).toContain('**By:** brady');
    expect(content).not.toContain('**References:**');
  });
});

describe('squad_memory handler', () => {
  let registry: ToolRegistry;
  let testRoot: string;

  beforeEach(() => {
    testRoot = path.join('.', '.test-squad-memory-' + randomUUID());
    registry = new ToolRegistry(testRoot);

    // Create test agent history file — handler expects .squad/agents/{name}/history.md
    const agentDir = path.join(testRoot, '.squad', 'agents', 'fenster');
    fs.mkdirSync(agentDir, { recursive: true });
    
    const historyContent = `# Fenster's History

## Learnings

### 2024-01-01T00:00:00.000Z
Initial learning entry.

## Updates

### 2024-01-01T00:00:00.000Z
Initial update entry.

## Sessions

### 2024-01-01T00:00:00.000Z
Initial session entry.
`;
    fs.writeFileSync(path.join(agentDir, 'history.md'), historyContent, 'utf-8');
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('should append to existing section', async () => {
    const tool = registry.getTool('squad_memory')!;
    const result = await tool.handler(
      {
        agent: 'fenster',
        section: 'learnings',
        content: 'Learned how to implement ToolRegistry.',
      } as MemoryEntry,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_memory',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });

    const historyFile = path.join(testRoot, '.squad', 'agents', 'fenster', 'history.md');
    const content = fs.readFileSync(historyFile, 'utf-8');
    
    expect(content).toContain('Learned how to implement ToolRegistry');
    expect(content).toContain('## Learnings');
    
    // Check it's in the right section
    const learningsIndex = content.indexOf('## Learnings');
    const updatesIndex = content.indexOf('## Updates');
    const newEntryIndex = content.indexOf('Learned how to implement ToolRegistry');
    
    expect(newEntryIndex).toBeGreaterThan(learningsIndex);
    expect(newEntryIndex).toBeLessThan(updatesIndex);
  });

  it('should create section if it does not exist', async () => {
    // Create a history file without Sessions section
    const agentDir = path.join(testRoot, '.squad', 'agents', 'brady');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'history.md'), '# Brady History\n\n## Learnings\n', 'utf-8');

    const tool = registry.getTool('squad_memory')!;
    const result = await tool.handler(
      {
        agent: 'brady',
        section: 'sessions',
        content: 'Session on M1-1 implementation.',
      } as MemoryEntry,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_memory',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });

    const historyFile = path.join(testRoot, '.squad', 'agents', 'brady', 'history.md');
    const content = fs.readFileSync(historyFile, 'utf-8');
    
    expect(content).toContain('## Sessions');
    expect(content).toContain('Session on M1-1 implementation');
  });

  it('should fail if agent history does not exist', async () => {
    const tool = registry.getTool('squad_memory')!;
    const result = await tool.handler(
      {
        agent: 'nonexistent',
        section: 'learnings',
        content: 'Some content.',
      } as MemoryEntry,
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_memory',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'failure',
      error: 'History file does not exist',
    });
  });
});

describe('squad_status handler', () => {
  let registry: ToolRegistry;
  let sessionPool: SessionPool;

  beforeEach(() => {
    sessionPool = new SessionPool({ maxConcurrent: 5, idleTimeout: 60000, healthCheckInterval: 30000 });
    registry = new ToolRegistry('.test-squad-status', () => sessionPool);
  });

  it('should return pool status with no sessions', async () => {
    const tool = registry.getTool('squad_status')!;
    const result = await tool.handler(
      {},
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_status',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).textResultForLlm).toContain('0/5 sessions');
    expect((result as any).toolTelemetry.poolInfo.poolSize).toBe(0);
  });

  it('should return pool status with active sessions', async () => {
    // Add some sessions to the pool
    sessionPool.add({
      id: 'session-1',
      agentName: 'fenster',
      status: 'active',
      createdAt: new Date(),
    });
    sessionPool.add({
      id: 'session-2',
      agentName: 'verbal',
      status: 'active',
      createdAt: new Date(),
    });

    const tool = registry.getTool('squad_status')!;
    const result = await tool.handler(
      {},
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_status',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).textResultForLlm).toContain('2/5 sessions');
    expect((result as any).toolTelemetry.poolInfo.poolSize).toBe(2);
    expect((result as any).toolTelemetry.poolInfo.activeSessions).toBe(2);
  });

  it('should filter by agent name', async () => {
    sessionPool.add({
      id: 'session-1',
      agentName: 'fenster',
      status: 'active',
      createdAt: new Date(),
    });
    sessionPool.add({
      id: 'session-2',
      agentName: 'verbal',
      status: 'active',
      createdAt: new Date(),
    });

    const tool = registry.getTool('squad_status')!;
    const result = await tool.handler(
      { agentName: 'fenster' },
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_status',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).textResultForLlm).toContain('Filtered results: 1 sessions');
    expect((result as any).toolTelemetry.poolInfo.filteredCount).toBe(1);
  });

  it('should include verbose session details', async () => {
    sessionPool.add({
      id: 'session-123',
      agentName: 'fenster',
      status: 'active',
      createdAt: new Date(Date.now() - 5000), // 5 seconds ago
    });

    const tool = registry.getTool('squad_status')!;
    const result = await tool.handler(
      { verbose: true },
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_status',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).textResultForLlm).toContain('Sessions:');
    expect((result as any).textResultForLlm).toContain('fenster');
    expect((result as any).textResultForLlm).toContain('active');
  });

  it('should handle query without pool', async () => {
    const registryNoPool = new ToolRegistry('.test-squad-status');
    const tool = registryNoPool.getTool('squad_status')!;
    const result = await tool.handler(
      {},
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_status',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).textResultForLlm).toContain('Pool size: 0');
    expect((result as any).toolTelemetry.poolAvailable).toBe(false);
  });
});

describe('squad_skill handler', () => {
  let registry: ToolRegistry;
  let testRoot: string;

  beforeEach(() => {
    testRoot = path.join('.', '.test-squad-skill-' + randomUUID());
    registry = new ToolRegistry(testRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('should write skill file', async () => {
    const tool = registry.getTool('squad_skill')!;
    const result = await tool.handler(
      {
        skillName: 'typescript-refactoring',
        operation: 'write',
        content: 'Expert at refactoring TypeScript code for better maintainability.',
        confidence: 'high',
      },
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_skill',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });

    const skillFile = path.join(testRoot, 'skills', 'typescript-refactoring', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);

    const content = fs.readFileSync(skillFile, 'utf-8');
    expect(content).toContain('# typescript-refactoring');
    expect(content).toContain('**Confidence:** high');
    expect(content).toContain('Expert at refactoring TypeScript');
  });

  it('should read existing skill file', async () => {
    // Create a skill file first
    const skillDir = path.join(testRoot, 'skills', 'debugging');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillContent = '# debugging\n\n**Confidence:** medium\n\nExpert at debugging Node.js applications.';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');

    const tool = registry.getTool('squad_skill')!;
    const result = await tool.handler(
      {
        skillName: 'debugging',
        operation: 'read',
      },
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_skill',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'success',
    });
    expect((result as any).textResultForLlm).toContain('debugging');
    expect((result as any).textResultForLlm).toContain('Expert at debugging Node.js');
  });

  it('should fail to read non-existent skill', async () => {
    const tool = registry.getTool('squad_skill')!;
    const result = await tool.handler(
      {
        skillName: 'nonexistent',
        operation: 'read',
      },
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_skill',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'failure',
      error: 'Skill file does not exist',
    });
  });

  it('should fail to write without content', async () => {
    const tool = registry.getTool('squad_skill')!;
    const result = await tool.handler(
      {
        skillName: 'test-skill',
        operation: 'write',
      },
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_skill',
        arguments: {},
      }
    );

    expect(result).toMatchObject({
      resultType: 'failure',
      error: 'Missing required field: content',
    });
  });

  it('should default confidence to medium', async () => {
    const tool = registry.getTool('squad_skill')!;
    await tool.handler(
      {
        skillName: 'test-skill',
        operation: 'write',
        content: 'Test skill content',
      },
      {
        sessionId: 'test-session',
        toolCallId: 'test-call',
        toolName: 'squad_skill',
        arguments: {},
      }
    );

    const skillFile = path.join(testRoot, 'skills', 'test-skill', 'SKILL.md');
    const content = fs.readFileSync(skillFile, 'utf-8');
    expect(content).toContain('**Confidence:** medium');
  });
});

// --- squad_proposals tests ---

describe('squad_proposals handler', () => {
  let registry: ToolRegistry;
  let testRoot: string;
  const invocation = {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    toolName: 'squad_proposals',
    arguments: {},
  };

  beforeEach(() => {
    testRoot = path.join('.', '.test-squad-proposals-' + randomUUID());
    registry = new ToolRegistry(testRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('create operation', () => {
    it('should create a proposal markdown file', async () => {
      const tool = registry.getTool('squad_proposals')!;
      const result = await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Add caching layer',
            category: 'performance',
            targetFile: 'src/runtime/coordinator.ts',
            description: 'Add an LRU cache to reduce redundant file reads during casting.',
            evidence: 'Profiling shows 40% of time spent in repeated fs.readFileSync calls.',
            priority: 'high',
          },
        } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'success' });
      expect((result as any).textResultForLlm).toContain('Add caching layer');
      expect((result as any).textResultForLlm).toContain('high');

      const proposalsDir = path.join(testRoot, '.squad', 'proposals');
      expect(fs.existsSync(proposalsDir)).toBe(true);

      const files = fs.readdirSync(proposalsDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/add-caching-layer\.md$/);

      const content = fs.readFileSync(path.join(proposalsDir, files[0]!), 'utf-8');
      expect(content).toContain('# Add caching layer');
      expect(content).toContain('| **Status** | pending |');
      expect(content).toContain('| **Category** | performance |');
      expect(content).toContain('| **Priority** | high |');
      expect(content).toContain('| **Target File** | src/runtime/coordinator.ts |');
      expect(content).toContain('| **Author** | Sage |');
      expect(content).toContain('## Description');
      expect(content).toContain('LRU cache');
      expect(content).toContain('## Evidence');
      expect(content).toContain('40% of time');
    });

    it('should use custom author when provided', async () => {
      const tool = registry.getTool('squad_proposals')!;
      await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Refactor tests',
            category: 'testing',
            targetFile: 'test/tools.test.ts',
            description: 'Split test file into per-tool test modules.',
            evidence: 'Test file exceeds 700 lines and is hard to navigate.',
            priority: 'medium',
            author: 'FIDO',
          },
        } as ProposalActionRequest,
        invocation,
      );

      const proposalsDir = path.join(testRoot, '.squad', 'proposals');
      const files = fs.readdirSync(proposalsDir);
      const content = fs.readFileSync(path.join(proposalsDir, files[0]!), 'utf-8');
      expect(content).toContain('| **Author** | FIDO |');
    });

    it('should fail when proposal data is missing', async () => {
      const tool = registry.getTool('squad_proposals')!;
      const result = await tool.handler(
        { operation: 'create' } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'failure' });
      expect((result as any).error).toBe('Missing proposal data');
    });

    it('should fail when proposal fields are incomplete', async () => {
      const tool = registry.getTool('squad_proposals')!;
      const result = await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Incomplete proposal',
            category: 'testing',
            targetFile: '',
            description: '',
            evidence: '',
            priority: 'low',
          },
        } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'failure' });
      expect((result as any).error).toBe('Incomplete proposal data');
    });
  });

  describe('list operation', () => {
    it('should return empty when no proposals directory exists', async () => {
      const tool = registry.getTool('squad_proposals')!;
      const result = await tool.handler(
        { operation: 'list' } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'success' });
      expect((result as any).textResultForLlm).toContain('does not exist');
    });

    it('should list pending proposals by default', async () => {
      const tool = registry.getTool('squad_proposals')!;

      // Create two proposals
      await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'First proposal',
            category: 'architecture',
            targetFile: 'src/index.ts',
            description: 'First improvement.',
            evidence: 'Evidence one.',
            priority: 'high',
          },
        } as ProposalActionRequest,
        invocation,
      );
      await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Second proposal',
            category: 'documentation',
            targetFile: 'docs/guide.md',
            description: 'Second improvement.',
            evidence: 'Evidence two.',
            priority: 'low',
          },
        } as ProposalActionRequest,
        invocation,
      );

      const result = await tool.handler(
        { operation: 'list' } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'success' });
      expect((result as any).textResultForLlm).toContain('2 pending proposal(s)');
      expect((result as any).textResultForLlm).toContain('First proposal');
      expect((result as any).textResultForLlm).toContain('Second proposal');
    });

    it('should filter proposals by status', async () => {
      const tool = registry.getTool('squad_proposals')!;

      // Create and approve one proposal
      await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Approved proposal',
            category: 'testing',
            targetFile: 'test/foo.test.ts',
            description: 'Will be approved.',
            evidence: 'Evidence.',
            priority: 'medium',
          },
        } as ProposalActionRequest,
        invocation,
      );

      const proposalsDir = path.join(testRoot, '.squad', 'proposals');
      const files = fs.readdirSync(proposalsDir);

      await tool.handler(
        {
          operation: 'update',
          proposalFile: files[0],
          newStatus: 'approved',
        } as ProposalActionRequest,
        invocation,
      );

      // List approved — should find 1
      const approvedResult = await tool.handler(
        { operation: 'list', statusFilter: 'approved' } as ProposalActionRequest,
        invocation,
      );
      expect((approvedResult as any).textResultForLlm).toContain('1 approved proposal(s)');

      // List pending — should find 0
      const pendingResult = await tool.handler(
        { operation: 'list', statusFilter: 'pending' } as ProposalActionRequest,
        invocation,
      );
      expect((pendingResult as any).textResultForLlm).toContain('No pending proposals');
    });
  });

  describe('update operation', () => {
    it('should approve a pending proposal', async () => {
      const tool = registry.getTool('squad_proposals')!;

      // Create a proposal first
      await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Proposal to approve',
            category: 'performance',
            targetFile: 'src/casting.ts',
            description: 'Optimize casting.',
            evidence: 'Benchmarks show 2x improvement.',
            priority: 'high',
          },
        } as ProposalActionRequest,
        invocation,
      );

      const proposalsDir = path.join(testRoot, '.squad', 'proposals');
      const files = fs.readdirSync(proposalsDir);

      const result = await tool.handler(
        {
          operation: 'update',
          proposalFile: files[0],
          newStatus: 'approved',
          reviewComment: 'Looks good, ship it!',
        } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'success' });
      expect((result as any).textResultForLlm).toContain('approved');
      expect((result as any).textResultForLlm).toContain('Looks good, ship it!');

      const content = fs.readFileSync(path.join(proposalsDir, files[0]!), 'utf-8');
      expect(content).toContain('| **Status** | approved |');
      expect(content).toContain('## Review');
      expect(content).toContain('| **Decision** | approved |');
      expect(content).toContain('| **Comment** | Looks good, ship it! |');
    });

    it('should reject a pending proposal', async () => {
      const tool = registry.getTool('squad_proposals')!;

      await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Proposal to reject',
            category: 'architecture',
            targetFile: 'src/tools/index.ts',
            description: 'Split tools into separate files.',
            evidence: 'File is large.',
            priority: 'low',
          },
        } as ProposalActionRequest,
        invocation,
      );

      const proposalsDir = path.join(testRoot, '.squad', 'proposals');
      const files = fs.readdirSync(proposalsDir);

      const result = await tool.handler(
        {
          operation: 'update',
          proposalFile: files[0],
          newStatus: 'rejected',
          reviewComment: 'Not a priority right now.',
        } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'success' });
      expect((result as any).textResultForLlm).toContain('rejected');

      const content = fs.readFileSync(path.join(proposalsDir, files[0]!), 'utf-8');
      expect(content).toContain('| **Status** | rejected |');
      expect(content).toContain('| **Decision** | rejected |');
    });

    it('should fail when proposalFile is missing', async () => {
      const tool = registry.getTool('squad_proposals')!;
      const result = await tool.handler(
        {
          operation: 'update',
          newStatus: 'approved',
        } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'failure' });
      expect((result as any).error).toBe('Missing proposalFile');
    });

    it('should fail when newStatus is invalid', async () => {
      const tool = registry.getTool('squad_proposals')!;
      const result = await tool.handler(
        {
          operation: 'update',
          proposalFile: 'some-file.md',
        } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'failure' });
      expect((result as any).error).toBe('Invalid newStatus');
    });

    it('should fail when proposal file does not exist', async () => {
      const tool = registry.getTool('squad_proposals')!;

      // Ensure proposals dir exists
      const proposalsDir = path.join(testRoot, '.squad', 'proposals');
      fs.mkdirSync(proposalsDir, { recursive: true });

      const result = await tool.handler(
        {
          operation: 'update',
          proposalFile: 'nonexistent.md',
          newStatus: 'approved',
        } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'failure' });
      expect((result as any).error).toBe('Proposal file not found');
    });

    it('should handle approval without review comment', async () => {
      const tool = registry.getTool('squad_proposals')!;

      await tool.handler(
        {
          operation: 'create',
          proposal: {
            title: 'Silent approval',
            category: 'testing',
            targetFile: 'test/something.ts',
            description: 'A small fix.',
            evidence: 'Clear improvement.',
            priority: 'low',
          },
        } as ProposalActionRequest,
        invocation,
      );

      const proposalsDir = path.join(testRoot, '.squad', 'proposals');
      const files = fs.readdirSync(proposalsDir);

      await tool.handler(
        {
          operation: 'update',
          proposalFile: files[0],
          newStatus: 'approved',
        } as ProposalActionRequest,
        invocation,
      );

      const content = fs.readFileSync(path.join(proposalsDir, files[0]!), 'utf-8');
      expect(content).toContain('| **Status** | approved |');
      expect(content).toContain('| **Decision** | approved |');
      expect(content).not.toContain('| **Comment**');
    });
  });

  describe('unknown operation', () => {
    it('should fail with unknown operation error', async () => {
      const tool = registry.getTool('squad_proposals')!;
      const result = await tool.handler(
        { operation: 'delete' as any } as ProposalActionRequest,
        invocation,
      );

      expect(result).toMatchObject({ resultType: 'failure' });
      expect((result as any).error).toContain('Unknown operation');
    });
  });
});
