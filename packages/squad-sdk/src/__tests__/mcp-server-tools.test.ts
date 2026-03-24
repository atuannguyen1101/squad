/**
 * Tests for MCP Server tool visibility, message threshold wiring,
 * and pulse collector integration patterns.
 *
 * Validates:
 *   1. publicTools Set: exactly 7 tools exposed on MCP surface
 *   2. Internal tools: NOT registered via mcp.addTool
 *   3. trackMessage() wired into dispatch paths (via structural assertion)
 *   4. setOnProgressRegression() wired into server initialization
 *   5. clear() resets ALL state (including message counts)
 *   6. PulseCollector threshold/regression accessors
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PulseCollector, createPulse } from '../pulse/pulse.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ────────────────────────────────────────────────────────────────
// 1. publicTools Set — structural assertions against server.ts source
// ────────────────────────────────────────────────────────────────

describe('MCP Server — publicTools Set (structural)', () => {
  const serverSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'mcp', 'server.ts'),
    'utf-8',
  );

  // Extract the publicTools set from source
  const publicToolsMatch = serverSource.match(
    /const publicTools\s*=\s*new Set\(\[\s*([\s\S]*?)\]\)/,
  );
  const publicToolsBlock = publicToolsMatch?.[1] ?? '';
  const publicToolNames = publicToolsBlock
    .split('\n')
    .map(line => line.match(/'([^']+)'/)?.[1])
    .filter(Boolean) as string[];

  it('should define exactly 7 public tools', () => {
    expect(publicToolNames).toHaveLength(7);
  });

  it('should include all user-facing tools', () => {
    const expected = [
      'squad_run',
      'squad_ask',
      'squad_respond',
      'squad_wait',
      'squad_status',
      'squad_cancel',
      'squad_analyze_run',
    ];
    for (const tool of expected) {
      expect(publicToolNames).toContain(tool);
    }
  });

  it('should NOT include internal tools in the public set', () => {
    const internalTools = [
      'squad_dispatch',
      'squad_send',
      'squad_read_session',
      'squad_close_session',
      'squad_pulse',
      'squad_roster',
      'squad_list_agents',
      'squad_monitor',
      'squad_memory',
      'squad_decide',
      'squad_intent',
      'squad_wait_for_idle',
    ];
    for (const tool of internalTools) {
      expect(publicToolNames).not.toContain(tool);
    }
  });

  it('should define all expected internal tools via registerTool', () => {
    // Verify internal tools are defined (have registerTool calls) even if not public
    const internalTools = [
      'squad_dispatch',
      'squad_send',
      'squad_read_session',
      'squad_close_session',
      'squad_pulse',
      'squad_roster',
      'squad_list_agents',
      'squad_monitor',
      'squad_memory',
      'squad_decide',
      'squad_intent',
      'squad_wait_for_idle',
    ];
    for (const tool of internalTools) {
      expect(serverSource).toContain(`name: '${tool}'`);
    }
  });

  it('should filter tools via publicTools.has() in registerTool', () => {
    // The registerTool helper must gate on publicTools.has(schema.name)
    expect(serverSource).toContain('publicTools.has(schema.name)');
    expect(serverSource).toContain('mcp.addTool(schema, handler)');
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Message threshold wiring — structural assertions
// ────────────────────────────────────────────────────────────────

describe('MCP Server — trackMessage wiring (structural)', () => {
  const serverSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'mcp', 'server.ts'),
    'utf-8',
  );

  it('should call trackMessage in squad_dispatch handler', () => {
    // Find the squad_dispatch tool definition and verify trackAgentMessage call
    expect(serverSource).toContain('trackAgentMessage(args.agentName)');
  });

  it('should wire trackMessage into pipeline dispatch', () => {
    // pipelineDeps.dispatch should call trackAgentMessage
    const pipelineDispatchPattern = /pipelineDeps[\s\S]*?dispatch[\s\S]*?trackAgentMessage/;
    expect(serverSource).toMatch(pipelineDispatchPattern);
  });

  it('should wire trackMessage into impl pipeline dispatch', () => {
    // implPipelineDeps.dispatch should call trackAgentMessage
    const implDispatchPattern = /implPipelineDeps[\s\S]*?dispatch[\s\S]*?trackAgentMessage/;
    expect(serverSource).toMatch(implDispatchPattern);
  });

  it('should wire setOnProgressRegression', () => {
    expect(serverSource).toContain('pulseCollector.setOnProgressRegression');
  });

  it('should wire trackMessage into squad_send handler', () => {
    // The squad_send tool handler should call trackAgentMessage
    // Verify the pattern: squad_send definition followed by trackAgentMessage call
    const sendToolIndex = serverSource.indexOf("name: 'squad_send'");
    const nextToolIndex = serverSource.indexOf("name: 'squad_read_session'");
    const sendBlock = serverSource.slice(sendToolIndex, nextToolIndex);
    expect(sendBlock).toContain('trackAgentMessage');
  });
});

// ────────────────────────────────────────────────────────────────
// 3. PulseCollector.clear() resets ALL state
// ────────────────────────────────────────────────────────────────

describe('PulseCollector — clear() resets message tracking', () => {
  let collector: PulseCollector;

  beforeEach(() => {
    collector = new PulseCollector();
  });

  it('should reset messageCountsByAgent on clear()', () => {
    collector.trackMessage('agent-a');
    collector.trackMessage('agent-a');
    collector.trackMessage('agent-b');

    expect(collector.getMessageCount('agent-a')).toBe(2);
    expect(collector.getMessageCount('agent-b')).toBe(1);

    collector.clear();

    expect(collector.getMessageCount('agent-a')).toBe(0);
    expect(collector.getMessageCount('agent-b')).toBe(0);
  });

  it('should reset messageCountWarningsEmitted on clear()', () => {
    // Exceed threshold for an agent
    for (let i = 0; i < 25; i++) {
      collector.trackMessage('runaway-agent');
    }

    const warningsBefore = collector.getAll().filter(
      p => p.agent === 'System' && p.summary.includes('Message count threshold'),
    );
    expect(warningsBefore).toHaveLength(1);

    collector.clear();

    // After clear, threshold tracking is reset — exceeding again should emit new warning
    for (let i = 0; i < 25; i++) {
      collector.trackMessage('runaway-agent');
    }

    const warningsAfter = collector.getAll().filter(
      p => p.agent === 'System' && p.summary.includes('Message count threshold'),
    );
    expect(warningsAfter).toHaveLength(1);
  });

  it('should still clear pulses and userQueue', () => {
    const pulse = createPulse({
      agent: 'test',
      phase: 'done',
      status: 'ok',
      progressPct: 100,
      summary: 'Complete',
      blockers: [],
      questionsForUser: ['How did it go?'],
      artifacts: [],
      nextStep: '',
    });

    collector.record(pulse);
    expect(collector.getAll()).toHaveLength(1);
    expect(collector.hasUserRelevantPulses()).toBe(true);

    collector.clear();

    expect(collector.getAll()).toHaveLength(0);
    expect(collector.hasUserRelevantPulses()).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. PulseCollector — configurable threshold and getMessageCount
// ────────────────────────────────────────────────────────────────

describe('PulseCollector — threshold configuration', () => {
  let collector: PulseCollector;

  beforeEach(() => {
    collector = new PulseCollector();
  });

  it('should allow setting a custom message count threshold', () => {
    collector.setMessageCountWarningThreshold(5);

    for (let i = 0; i < 5; i++) {
      collector.trackMessage('fast-agent');
    }

    const warnings = collector.getAll().filter(
      p => p.agent === 'System' && p.summary.includes('Message count threshold'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.summary).toContain('fast-agent');
    expect(warnings[0]!.summary).toContain('5');
  });

  it('should not emit warning below custom threshold', () => {
    collector.setMessageCountWarningThreshold(10);

    for (let i = 0; i < 9; i++) {
      collector.trackMessage('moderate-agent');
    }

    const warnings = collector.getAll().filter(
      p => p.agent === 'System' && p.summary.includes('Message count threshold'),
    );
    expect(warnings).toHaveLength(0);
  });

  it('should report message count via getMessageCount', () => {
    collector.trackMessage('a');
    collector.trackMessage('a');
    collector.trackMessage('a');
    collector.trackMessage('b');

    expect(collector.getMessageCount('a')).toBe(3);
    expect(collector.getMessageCount('b')).toBe(1);
    expect(collector.getMessageCount('nonexistent')).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. PulseCollector — progress regression generates warning
// ────────────────────────────────────────────────────────────────

describe('PulseCollector — progress regression with callback', () => {
  let collector: PulseCollector;
  let regressionSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    collector = new PulseCollector();
    regressionSpy = vi.fn();
    collector.setOnProgressRegression(regressionSpy);
  });

  it('should fire callback AND emit warning pulse on regression >10%', () => {
    collector.record(createPulse({
      agent: 'agent-x',
      phase: 'implementing',
      status: 'ok',
      progressPct: 70,
      summary: 'Making progress',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    }));

    collector.record(createPulse({
      agent: 'agent-x',
      phase: 'implementing',
      status: 'ok',
      progressPct: 20,
      summary: 'Went backward',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    }));

    expect(regressionSpy).toHaveBeenCalledWith('agent-x', 70, 20);

    // Warning pulse should be in the all-pulses list
    const warnings = collector.getAll().filter(
      p => p.agent === 'System' && p.summary.includes('Progress regression'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.summary).toContain('70%');
    expect(warnings[0]!.summary).toContain('20%');
  });

  it('should not fire for forward progress', () => {
    collector.record(createPulse({
      agent: 'agent-y',
      phase: 'implementing',
      status: 'ok',
      progressPct: 30,
      summary: 'Started',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    }));

    collector.record(createPulse({
      agent: 'agent-y',
      phase: 'implementing',
      status: 'ok',
      progressPct: 80,
      summary: 'Almost done',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    }));

    expect(regressionSpy).not.toHaveBeenCalled();
  });

  it('should ignore regressions of 10% or less', () => {
    collector.record(createPulse({
      agent: 'agent-z',
      phase: 'testing',
      status: 'ok',
      progressPct: 60,
      summary: 'Testing',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    }));

    collector.record(createPulse({
      agent: 'agent-z',
      phase: 'testing',
      status: 'ok',
      progressPct: 50,
      summary: 'Adjusting',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    }));

    // 60 → 50 = 10% difference, exactly at boundary — should NOT trigger
    expect(regressionSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// 6. MCP tool comment annotation consistency
// ────────────────────────────────────────────────────────────────

describe('MCP Server — internal tool annotations', () => {
  const serverSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'mcp', 'server.ts'),
    'utf-8',
  );

  it('should annotate every internal tool with [INTERNAL - Not exposed on MCP]', () => {
    const internalTools = [
      'squad_dispatch',
      'squad_list_agents',
      'squad_close_session',
      'squad_monitor',
      'squad_roster',
      'squad_send',
      'squad_read_session',
      'squad_decide',
      'squad_memory',
      'squad_pulse',
      'squad_intent',
      'squad_wait_for_idle',
    ];

    for (const tool of internalTools) {
      // Each internal tool should have a comment like:
      // // squad_xxx: Description [INTERNAL - Not exposed on MCP]
      const toolIndex = serverSource.indexOf(`name: '${tool}'`);
      expect(toolIndex).toBeGreaterThan(-1);

      // Look backward from the tool definition for the INTERNAL annotation
      const precedingBlock = serverSource.slice(Math.max(0, toolIndex - 300), toolIndex);
      expect(precedingBlock).toContain('INTERNAL');
    }
  });

  it('should NOT annotate public tools as INTERNAL', () => {
    const publicTools = [
      'squad_run',
      'squad_ask',
      'squad_respond',
      'squad_wait',
      'squad_status',
      'squad_cancel',
      'squad_analyze_run',
    ];

    for (const tool of publicTools) {
      const toolIndex = serverSource.indexOf(`name: '${tool}'`);
      expect(toolIndex).toBeGreaterThan(-1);

      // In the 200 chars before the tool name, there should be no INTERNAL tag
      const precedingBlock = serverSource.slice(Math.max(0, toolIndex - 200), toolIndex);
      expect(precedingBlock).not.toContain('[INTERNAL');
    }
  });
});
