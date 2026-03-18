/**
 * Integration tests for Squad Orchestration Server (SquadServer, AgentSessionManager, squad_route dispatch/mailbox)
 *
 * Covers:
 * - SquadServer construction and pre-start state
 * - AgentSessionManager charter compilation
 * - squad_route mailbox fallback when no dispatch available
 * - squad_route dispatch path with mock dispatch function
 * - EventBus emit/subscribe round-trip
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SquadServer } from '@bradygaster/squad-sdk/server';
import { ToolRegistry } from '@bradygaster/squad-sdk/tools';
import { EventBus } from '@bradygaster/squad-sdk/runtime/event-bus';
import { DEFAULT_CONFIG } from '@bradygaster/squad-sdk/runtime';

// ============================================================================
// 1. SquadServer Construction
// ============================================================================

describe('SquadServer', () => {
  it('should construct with minimal config', () => {
    const server = new SquadServer({
      squadConfig: DEFAULT_CONFIG,
    });
    expect(server).toBeDefined();
  });

  it('should expose EventBus before start', () => {
    const server = new SquadServer({
      squadConfig: DEFAULT_CONFIG,
    });
    const bus = server.getEventBus();
    expect(bus).toBeDefined();
    expect(bus).toBeInstanceOf(EventBus);
  });

  it('should expose ToolRegistry before start', () => {
    const server = new SquadServer({
      squadConfig: DEFAULT_CONFIG,
    });
    const registry = server.getToolRegistry();
    expect(registry).toBeDefined();
    expect(registry).toBeInstanceOf(ToolRegistry);
  });

  it('should report not running before start', () => {
    const server = new SquadServer({
      squadConfig: DEFAULT_CONFIG,
    });
    const status = server.getStatus();
    expect(status.running).toBe(false);
    expect(server.isRunning).toBe(false);
  });

  it('should throw if dispatch called before start', async () => {
    const server = new SquadServer({
      squadConfig: DEFAULT_CONFIG,
    });
    await expect(server.dispatch('fenster', 'Build the API'))
      .rejects.toThrow(/not running/i);
  });
});

// ============================================================================
// 2. AgentSessionManager
// ============================================================================

describe('AgentSessionManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `squad-server-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper: dynamically import AgentSessionManager so we can pass mocks
  async function createManager(squadRoot: string) {
    const { AgentSessionManager } = await import('@bradygaster/squad-sdk/server');

    const mockClient = {
      pool: {
        findByAgent: vi.fn().mockReturnValue(null),
        remove: vi.fn(),
      },
      createSession: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };
    const eventBus = new EventBus();

    const manager = new AgentSessionManager({
      client: mockClient as any,
      eventBus,
      squadRoot,
      tools: [],
      defaultModel: 'claude-sonnet-4.5',
    });

    return { manager, mockClient, eventBus };
  }

  it('should construct with required config', async () => {
    const { manager } = await createManager(tempDir);
    expect(manager).toBeDefined();
  });

  it('should compile charter from file when available', async () => {
    // Create a charter.md under .squad/agents/testbot/
    const charterDir = path.join(tempDir, '.squad', 'agents', 'testbot');
    fs.mkdirSync(charterDir, { recursive: true });
    fs.writeFileSync(
      path.join(charterDir, 'charter.md'),
      `# TestBot — QA Engineer

## Identity

**Name:** TestBot
**Role:** QA Engineer
**Expertise:** testing, automation
**Style:** Thorough and methodical

## What I Own

All integration and unit testing.
`,
      'utf-8',
    );

    const { manager } = await createManager(tempDir);
    const charter = await manager.compileCharter('testbot');

    expect(charter).toBeDefined();
    expect(charter.name).toBe('testbot');
    expect(charter.role).toBe('QA Engineer');
    expect(charter.prompt).toContain('TestBot');
  });

  it('should use default charter when file missing', async () => {
    const { manager } = await createManager(tempDir);
    const charter = await manager.compileCharter('nonexistent');

    expect(charter).toBeDefined();
    expect(charter.name).toBe('nonexistent');
    expect(charter.role).toBe('general-purpose agent');
    expect(charter.prompt).toContain('nonexistent');
  });

  it('should return empty list when no sessions active', async () => {
    const { manager } = await createManager(tempDir);
    const sessions = manager.listActiveSessions();
    expect(sessions).toEqual([]);
  });
});

// ============================================================================
// 3. squad_route with Mailbox Fallback
// ============================================================================

describe('squad_route mailbox fallback', () => {
  let registry: ToolRegistry;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `squad-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    registry = new ToolRegistry(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write to mailbox when no dispatch available', async () => {
    const tool = registry.getTool('squad_route')!;
    const result = await tool.handler({
      targetAgent: 'fenster',
      task: 'Review the auth module',
      priority: 'high',
    });

    // Verify result is success
    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('mailbox');
    expect(result.textResultForLlm).toContain('fenster');

    // Verify mailbox file was created
    const mailboxDir = path.join(tempDir, 'mailbox', 'fenster');
    expect(fs.existsSync(mailboxDir)).toBe(true);
    const files = fs.readdirSync(mailboxDir);
    expect(files.length).toBe(1);

    // Verify file content
    const content = fs.readFileSync(path.join(mailboxDir, files[0]), 'utf-8');
    expect(content).toContain('Review the auth module');
    expect(content).toContain('high');
  });

  it('should include routeRequest in telemetry for mailbox fallback', async () => {
    const tool = registry.getTool('squad_route')!;
    const result = await tool.handler({
      targetAgent: 'brady',
      task: 'Check the docs',
    });

    expect(result.toolTelemetry.routeRequest).toBeDefined();
    expect(result.toolTelemetry.routeRequest.targetAgent).toBe('brady');
    expect(result.toolTelemetry.routeRequest.priority).toBe('normal');
    expect(result.toolTelemetry.fallback).toBe('mailbox');
  });
});

// ============================================================================
// 4. squad_route with Dispatch
// ============================================================================

describe('squad_route with dispatch', () => {
  it('should call dispatch function when available', async () => {
    const mockDispatch = vi.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      status: 'created_and_sent',
    });

    const registry = new ToolRegistry(
      '.test-dispatch',
      undefined,
      () => mockDispatch,
    );

    const tool = registry.getTool('squad_route')!;
    const result = await tool.handler({
      targetAgent: 'fenster',
      task: 'Build the API',
      priority: 'high',
      context: 'From PRD-2',
    });

    expect(mockDispatch).toHaveBeenCalledWith('fenster', 'Build the API', 'From PRD-2');
    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('test-session-123');
    expect(result.toolTelemetry.sessionId).toBe('test-session-123');
  });

  it('should handle dispatch errors gracefully', async () => {
    const mockDispatch = vi.fn().mockRejectedValue(new Error('Connection lost'));

    const registry = new ToolRegistry(
      '.test-dispatch-error',
      undefined,
      () => mockDispatch,
    );

    const tool = registry.getTool('squad_route')!;
    const result = await tool.handler({
      targetAgent: 'fenster',
      task: 'Build the API',
    });

    expect(result.resultType).toBe('failure');
    expect(result.textResultForLlm).toContain('Connection lost');
  });
});

// ============================================================================
// 5. Event Aggregation
// ============================================================================

describe('Event aggregation', () => {
  it('EventBus should emit and receive events', async () => {
    const bus = new EventBus();

    const events: any[] = [];
    bus.subscribeAll(async (event) => {
      events.push(event);
    });

    await bus.emit({
      type: 'session:created',
      sessionId: 'test-1',
      agentName: 'fenster',
      payload: { task: 'test' },
      timestamp: new Date(),
    });

    expect(events.length).toBe(1);
    expect(events[0].agentName).toBe('fenster');
  });
});
