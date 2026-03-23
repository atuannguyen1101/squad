/**
 * Tests for metrics MCP tool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMetricsTool } from '@bradygaster/squad-sdk/tools/metrics-tool';
import { MetricsTracker } from '@bradygaster/squad-sdk/coordinator/metrics';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

describe('squad_metrics tool', () => {
  let tracker: MetricsTracker;
  let testRoot: string;
  let tool: ReturnType<typeof createMetricsTool>;

  beforeEach(() => {
    testRoot = path.join(tmpdir(), `squad-test-metrics-tool-${Date.now()}`);
    tracker = new MetricsTracker(testRoot);
    tool = createMetricsTool(tracker);
  });

  it('has correct tool definition', () => {
    expect(tool.name).toBe('squad_metrics');
    expect(tool.description).toContain('performance metrics');
    expect(tool.parameters).toBeDefined();
    expect((tool.parameters as any).properties?.agentName).toBeDefined();
  });

  describe('querying metrics', () => {
    it('returns empty state for no metrics', async () => {
      const result = await tool.handler({});
      
      expect(result.resultType).toBe('success');
      expect(result.textResultForLlm).toContain('No agent metrics');
    });

    it('returns all agent metrics', async () => {
      // Create metrics for 2 agents
      for (const agent of ['AgentA', 'AgentB']) {
        tracker.handleEvent({
          type: 'session:created',
          sessionId: `session-${agent}`,
          agentName: agent,
          payload: { agentName: agent, priority: 'normal' },
          timestamp: new Date()
        });

        tracker.handleEvent({
          type: 'session:destroyed',
          sessionId: `session-${agent}`,
          agentName: agent,
          payload: { agentName: agent, reason: 'complete' },
          timestamp: new Date()
        });
      }

      const result = await tool.handler({});
      
      expect(result.resultType).toBe('success');
      expect(result.textResultForLlm).toContain('AgentA');
      expect(result.textResultForLlm).toContain('AgentB');
      expect(result.textResultForLlm).toContain('Total tasks: 1');
      expect(result.textResultForLlm).toContain('Success rate:');
      expect(result.toolTelemetry?.agentsQueried).toBe(2);
    });

    it('filters by agent name', async () => {
      // Create metrics for 2 agents
      for (const agent of ['AgentA', 'AgentB']) {
        tracker.handleEvent({
          type: 'session:created',
          sessionId: `session-${agent}`,
          agentName: agent,
          payload: { agentName: agent, priority: 'normal' },
          timestamp: new Date()
        });

        tracker.handleEvent({
          type: 'session:destroyed',
          sessionId: `session-${agent}`,
          agentName: agent,
          payload: { agentName: agent, reason: 'complete' },
          timestamp: new Date()
        });
      }

      const result = await tool.handler({ agentName: 'AgentA' });
      
      expect(result.resultType).toBe('success');
      expect(result.textResultForLlm).toContain('AgentA');
      expect(result.textResultForLlm).not.toContain('AgentB');
      expect(result.toolTelemetry?.agentsQueried).toBe(1);
    });

    it('returns not found for unknown agent', async () => {
      const result = await tool.handler({ agentName: 'UnknownAgent' });
      
      expect(result.resultType).toBe('success');
      expect(result.textResultForLlm).toContain('No metrics found');
      expect(result.textResultForLlm).toContain('UnknownAgent');
      expect(result.toolTelemetry?.metricsCount).toBe(0);
    });
  });

  describe('metrics display', () => {
    it('shows success rate', async () => {
      // 3 successes, 1 failure
      for (let i = 0; i < 4; i++) {
        tracker.handleEvent({
          type: 'session:created',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', priority: 'normal' },
          timestamp: new Date()
        });

        const reason = i === 3 ? 'error' : 'complete';
        tracker.handleEvent({
          type: 'session:destroyed',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', reason },
          timestamp: new Date()
        });
      }

      const result = await tool.handler({ agentName: 'TestAgent' });
      
      expect(result.textResultForLlm).toContain('Success rate: 75.0%');
      expect(result.textResultForLlm).toContain('Total tasks: 4');
      expect(result.textResultForLlm).toContain('Errors: 1');
    });

    it('shows last error', async () => {
      tracker.handleEvent({
        type: 'session:error',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', error: 'Connection timeout occurred' },
        timestamp: new Date()
      });

      // Create a session to initialize metrics
      tracker.handleEvent({
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', priority: 'normal' },
        timestamp: new Date()
      });

      const result = await tool.handler({ agentName: 'TestAgent' });
      
      expect(result.textResultForLlm).toContain('Last error:');
      expect(result.textResultForLlm).toContain('Connection timeout');
    });

    it('shows average duration', async () => {
      tracker.handleEvent({
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', priority: 'normal' },
        timestamp: new Date()
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      tracker.handleEvent({
        type: 'session:destroyed',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', reason: 'complete' },
        timestamp: new Date()
      });

      const result = await tool.handler({ agentName: 'TestAgent' });
      
      expect(result.textResultForLlm).toContain('Avg duration:');
      expect(result.textResultForLlm).toMatch(/\d+\.\d+s/); // e.g., "0.5s"
    });
  });

  describe('recent outcomes', () => {
    it('includes recent outcomes when requested', async () => {
      // Create 3 tasks
      for (let i = 0; i < 3; i++) {
        tracker.handleEvent({
          type: 'session:created',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', priority: 'normal' },
          timestamp: new Date()
        });

        const reason = i === 2 ? 'error' : 'complete';
        tracker.handleEvent({
          type: 'session:destroyed',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', reason },
          timestamp: new Date()
        });
      }

      const result = await tool.handler({ 
        agentName: 'TestAgent',
        includeOutcomes: true 
      });
      
      expect(result.textResultForLlm).toContain('Recent outcomes');
      expect(result.textResultForLlm).toContain('✓ success');
      expect(result.textResultForLlm).toContain('✗ error');
      expect(result.toolTelemetry?.includeOutcomes).toBe(true);
    });

    it('does not include outcomes by default', async () => {
      tracker.handleEvent({
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', priority: 'normal' },
        timestamp: new Date()
      });

      tracker.handleEvent({
        type: 'session:destroyed',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', reason: 'complete' },
        timestamp: new Date()
      });

      const result = await tool.handler({ agentName: 'TestAgent' });
      
      expect(result.textResultForLlm).not.toContain('Recent outcomes');
      expect(result.toolTelemetry?.includeOutcomes).toBe(false);
    });

    it('limits outcome display to 5 most recent', async () => {
      // Create 8 tasks
      for (let i = 0; i < 8; i++) {
        tracker.handleEvent({
          type: 'session:created',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', priority: 'normal' },
          timestamp: new Date()
        });

        tracker.handleEvent({
          type: 'session:destroyed',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', reason: 'complete' },
          timestamp: new Date()
        });
      }

      const result = await tool.handler({ 
        agentName: 'TestAgent',
        includeOutcomes: true 
      });
      
      // Should show "last 8" but only display 5 items
      expect(result.textResultForLlm).toContain('Recent outcomes (last 8)');
      
      // Count outcome lines (look for checkmarks)
      const outcomeCount = (result.textResultForLlm.match(/✓ success/g) || []).length;
      expect(outcomeCount).toBeLessThanOrEqual(5);
    });
  });

  describe('error handling', () => {
    it('handles tool errors gracefully', async () => {
      // Create a tool with broken tracker
      const brokenTracker = {
        getAllMetrics: () => { throw new Error('Database error'); }
      } as any;
      
      const brokenTool = createMetricsTool(brokenTracker);
      
      const result = await brokenTool.handler({});
      
      expect(result.resultType).toBe('failure');
      expect(result.textResultForLlm).toContain('Failed to query metrics');
      expect(result.error).toBeDefined();
    });
  });
});
