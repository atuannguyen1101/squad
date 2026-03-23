/**
 * Tests for metrics tracking module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetricsTracker } from '@bradygaster/squad-sdk/coordinator/metrics';
import type { SquadEvent } from '@bradygaster/squad-sdk/runtime/event-bus';
import type { SessionDestroyedPayload, SessionErrorPayload } from '@bradygaster/squad-sdk/runtime/event-payloads';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('MetricsTracker', () => {
  let tracker: MetricsTracker;
  let testRoot: string;

  beforeEach(async () => {
    // Create temp directory for test metrics
    testRoot = path.join(tmpdir(), `squad-test-metrics-${Date.now()}`);
    await fs.mkdir(testRoot, { recursive: true });
    tracker = new MetricsTracker(testRoot);
  });

  afterEach(async () => {
    await tracker.shutdown();
    // Clean up test directory
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('session lifecycle tracking', () => {
    it('tracks session creation', () => {
      const event: SquadEvent = {
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', priority: 'normal' },
        timestamp: new Date()
      };

      tracker.handleEvent(event);
      
      const metrics = tracker.getMetrics('TestAgent');
      expect(metrics).toBeDefined();
      expect(metrics?.agentName).toBe('TestAgent');
      expect(metrics?.totalTasks).toBe(0); // Not counted until destroyed
    });

    it('tracks successful session completion', () => {
      // Create session
      tracker.handleEvent({
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', priority: 'normal' },
        timestamp: new Date()
      });

      // Complete session
      const destroyPayload: SessionDestroyedPayload = {
        agentName: 'TestAgent',
        reason: 'complete'
      };
      
      tracker.handleEvent({
        type: 'session:destroyed',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: destroyPayload,
        timestamp: new Date()
      });

      const metrics = tracker.getMetrics('TestAgent');
      expect(metrics?.totalTasks).toBe(1);
      expect(metrics?.completedTasks).toBe(1);
      expect(metrics?.erroredTasks).toBe(0);
      expect(metrics?.recentOutcomes[0]?.result).toBe('success');
    });

    it('tracks failed session', () => {
      tracker.handleEvent({
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', priority: 'normal' },
        timestamp: new Date()
      });

      const destroyPayload: SessionDestroyedPayload = {
        agentName: 'TestAgent',
        reason: 'error'
      };
      
      tracker.handleEvent({
        type: 'session:destroyed',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: destroyPayload,
        timestamp: new Date()
      });

      const metrics = tracker.getMetrics('TestAgent');
      expect(metrics?.totalTasks).toBe(1);
      expect(metrics?.completedTasks).toBe(0);
      expect(metrics?.erroredTasks).toBe(1);
      expect(metrics?.recentOutcomes[0]?.result).toBe('error');
    });

    it('tracks session errors', () => {
      const errorPayload: SessionErrorPayload = {
        agentName: 'TestAgent',
        error: 'Connection timeout'
      };

      tracker.handleEvent({
        type: 'session:error',
        agentName: 'TestAgent',
        payload: errorPayload,
        timestamp: new Date()
      });

      const metrics = tracker.getMetrics('TestAgent');
      expect(metrics?.lastError).toBe('Connection timeout');
    });
  });

  describe('success rate calculation', () => {
    it('returns neutral rate for new agent', () => {
      const rate = tracker.getSuccessRate('NewAgent');
      expect(rate).toBe(0.5);
    });

    it('calculates all-time success rate', () => {
      // Simulate 3 successes and 1 failure
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

      const rate = tracker.getSuccessRate('TestAgent');
      expect(rate).toBe(0.75); // 3/4
    });

    it('calculates recent success rate', () => {
      // 10 successes followed by 2 failures
      for (let i = 0; i < 12; i++) {
        tracker.handleEvent({
          type: 'session:created',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', priority: 'normal' },
          timestamp: new Date()
        });

        const reason = i >= 10 ? 'error' : 'complete';
        tracker.handleEvent({
          type: 'session:destroyed',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', reason },
          timestamp: new Date()
        });
      }

      const metrics = tracker.getMetrics('TestAgent');
      // Recent outcomes only keeps last 10
      expect(metrics?.recentOutcomes.length).toBe(10);
      
      // Recent: 8 successes (indices 2-9) + 2 failures (10-11) = 8/10
      const recentRate = tracker.getRecentSuccessRate('TestAgent');
      expect(recentRate).toBe(0.8);

      // All-time: 10/12
      const allTimeRate = tracker.getSuccessRate('TestAgent');
      expect(allTimeRate).toBeCloseTo(0.833, 2);
    });
  });

  describe('duration tracking', () => {
    it('calculates average duration', async () => {
      const durations = [100, 200, 300]; // 100ms, 200ms, 300ms

      for (let i = 0; i < durations.length; i++) {
        const startTime = Date.now();
        
        tracker.handleEvent({
          type: 'session:created',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', priority: 'normal' },
          timestamp: new Date()
        });

        // Simulate task duration
        await new Promise(resolve => setTimeout(resolve, durations[i]!));

        tracker.handleEvent({
          type: 'session:destroyed',
          sessionId: `session-${i}`,
          agentName: 'TestAgent',
          payload: { agentName: 'TestAgent', reason: 'complete' },
          timestamp: new Date()
        });
      }

      const avgDuration = tracker.getAverageDuration('TestAgent');
      // Should be around 200ms (average of 100, 200, 300)
      expect(avgDuration).toBeGreaterThan(150);
      expect(avgDuration).toBeLessThan(350);
    });
  });

  describe('persistence', () => {
    it('saves metrics to disk', async () => {
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

      await tracker.save();

      const metricsPath = path.join(testRoot, '.squad', 'metrics', 'agent-metrics.json');
      const exists = await fs.access(metricsPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      const content = await fs.readFile(metricsPath, 'utf-8');
      const snapshot = JSON.parse(content);
      
      expect(snapshot.agents.TestAgent).toBeDefined();
      expect(snapshot.agents.TestAgent.totalTasks).toBe(1);
    });

    it('loads metrics from disk', async () => {
      // Save metrics
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

      await tracker.save();
      await tracker.shutdown();

      // Create new tracker and load
      const newTracker = new MetricsTracker(testRoot);
      await newTracker.load();

      const metrics = newTracker.getMetrics('TestAgent');
      expect(metrics?.totalTasks).toBe(1);
      expect(metrics?.completedTasks).toBe(1);

      await newTracker.shutdown();
    });
  });

  describe('getAllMetrics', () => {
    it('returns metrics for all agents', () => {
      const agents = ['Agent1', 'Agent2', 'Agent3'];

      for (const agent of agents) {
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

      const allMetrics = tracker.getAllMetrics();
      expect(allMetrics.length).toBe(3);
      
      const agentNames = allMetrics.map(m => m.agentName).sort();
      expect(agentNames).toEqual(['Agent1', 'Agent2', 'Agent3']);
    });
  });
});
