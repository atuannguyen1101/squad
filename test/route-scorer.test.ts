/**
 * Tests for performance-aware route scorer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RouteScorer } from '@bradygaster/squad-sdk/coordinator/route-scorer';
import { MetricsTracker } from '@bradygaster/squad-sdk/coordinator/metrics';
import { compileRoutingRules } from '@bradygaster/squad-sdk/config/routing';
import type { RoutingConfig } from '@bradygaster/squad-sdk/runtime/config';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

describe('RouteScorer', () => {
  let scorer: RouteScorer;
  let metrics: MetricsTracker;
  let testRoot: string;

  beforeEach(() => {
    scorer = new RouteScorer();
    testRoot = path.join(tmpdir(), `squad-test-scorer-${Date.now()}`);
    metrics = new MetricsTracker(testRoot);
  });

  describe('pattern-only scoring', () => {
    it('scores high-confidence patterns higher', () => {
      const config: RoutingConfig = {
        rules: [
          { workType: 'bug-fix', agents: ['Developer'], confidence: 'high', examples: ['fix bug', 'patch'] },
          { workType: 'feature', agents: ['Lead'], confidence: 'low', examples: ['new feature'] }
        ]
      };

      const router = compileRoutingRules(config);
      
      // Match bug-fix
      const result = scorer.scoreRoutes('fix a bug in authentication', router, metrics);
      
      expect(result.agentName).toBe('Developer');
      expect(result.patternScore).toBeGreaterThan(0.7); // High confidence
    });

    it('returns fallback for no matches', () => {
      const config: RoutingConfig = {
        rules: [
          { workType: 'testing', agents: ['Tester'], examples: ['write tests'] }
        ]
      };

      const router = compileRoutingRules(config);
      
      const result = scorer.scoreRoutes('unrelated task', router, metrics);
      
      expect(result.agentName).toBe('@coordinator'); // Default fallback
      expect(result.reason).toContain('No pattern match');
    });
  });

  describe('performance-aware scoring', () => {
    it('prefers agent with better success rate', () => {
      // Set up two agents that both match the pattern
      const config: RoutingConfig = {
        rules: [
          { workType: 'development', agents: ['DevA', 'DevB'], confidence: 'high', examples: ['code', 'implement'] }
        ]
      };

      const router = compileRoutingRules(config);

      // DevA: 4/4 successes
      for (let i = 0; i < 4; i++) {
        metrics.handleEvent({
          type: 'session:created',
          sessionId: `devA-${i}`,
          agentName: 'DevA',
          payload: { agentName: 'DevA', priority: 'normal' },
          timestamp: new Date()
        });

        metrics.handleEvent({
          type: 'session:destroyed',
          sessionId: `devA-${i}`,
          agentName: 'DevA',
          payload: { agentName: 'DevA', reason: 'complete' },
          timestamp: new Date()
        });
      }

      // DevB: 2/4 successes
      for (let i = 0; i < 4; i++) {
        metrics.handleEvent({
          type: 'session:created',
          sessionId: `devB-${i}`,
          agentName: 'DevB',
          payload: { agentName: 'DevB', priority: 'normal' },
          timestamp: new Date()
        });

        metrics.handleEvent({
          type: 'session:destroyed',
          sessionId: `devB-${i}`,
          agentName: 'DevB',
          payload: { agentName: 'DevB', reason: i < 2 ? 'complete' : 'error' },
          timestamp: new Date()
        });
      }

      const result = scorer.scoreRoutes('implement new feature', router, metrics);
      
      // DevA should score higher due to better success rate
      expect(result.agentName).toBe('DevA');
      // Performance score can be less than 0.5 due to speed component being 0 when duration is 0
      expect(result.performanceScore).toBeGreaterThan(0.4);
    });

    it('considers recent performance over all-time', () => {
      const config: RoutingConfig = {
        rules: [
          { workType: 'task', agents: ['AgentX'], confidence: 'high', examples: ['do task'] }
        ]
      };

      const router = compileRoutingRules(config);

      // AgentX: 10 old successes
      for (let i = 0; i < 10; i++) {
        metrics.handleEvent({
          type: 'session:created',
          sessionId: `old-${i}`,
          agentName: 'AgentX',
          payload: { agentName: 'AgentX', priority: 'normal' },
          timestamp: new Date()
        });

        metrics.handleEvent({
          type: 'session:destroyed',
          sessionId: `old-${i}`,
          agentName: 'AgentX',
          payload: { agentName: 'AgentX', reason: 'complete' },
          timestamp: new Date()
        });
      }

      // AgentX: 5 recent failures
      for (let i = 0; i < 5; i++) {
        metrics.handleEvent({
          type: 'session:created',
          sessionId: `recent-${i}`,
          agentName: 'AgentX',
          payload: { agentName: 'AgentX', priority: 'normal' },
          timestamp: new Date()
        });

        metrics.handleEvent({
          type: 'session:destroyed',
          sessionId: `recent-${i}`,
          agentName: 'AgentX',
          payload: { agentName: 'AgentX', reason: 'error' },
          timestamp: new Date()
        });
      }

      const result = scorer.scoreRoutes('do a task', router, metrics);
      
      // Recent outcomes should heavily influence the score
      // Last 10 tasks: 5 successes + 5 failures = 50% recent rate
      const recentRate = metrics.getRecentSuccessRate('AgentX');
      expect(recentRate).toBe(0.5);

      // Performance score should be lowered by recent failures
      expect(result.performanceScore).toBeLessThan(0.7);
    });

    it('penalizes recent errors', () => {
      const config: RoutingConfig = {
        rules: [
          { workType: 'task', agents: ['AgentY'], confidence: 'high', examples: ['task'] }
        ]
      };

      const router = compileRoutingRules(config);

      // Create a successful task
      metrics.handleEvent({
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'AgentY',
        payload: { agentName: 'AgentY', priority: 'normal' },
        timestamp: new Date()
      });

      metrics.handleEvent({
        type: 'session:destroyed',
        sessionId: 'session-1',
        agentName: 'AgentY',
        payload: { agentName: 'AgentY', reason: 'complete' },
        timestamp: new Date()
      });

      // Record an error
      metrics.handleEvent({
        type: 'session:error',
        agentName: 'AgentY',
        payload: { agentName: 'AgentY', error: 'Recent error occurred' },
        timestamp: new Date()
      });

      // Create a failed task
      metrics.handleEvent({
        type: 'session:created',
        sessionId: 'session-2',
        agentName: 'AgentY',
        payload: { agentName: 'AgentY', priority: 'normal' },
        timestamp: new Date()
      });

      metrics.handleEvent({
        type: 'session:destroyed',
        sessionId: 'session-2',
        agentName: 'AgentY',
        payload: { agentName: 'AgentY', reason: 'error' },
        timestamp: new Date()
      });

      const result = scorer.scoreRoutes('do task', router, metrics);
      
      // Should have error penalty applied
      const metricsData = metrics.getMetrics('AgentY');
      expect(metricsData?.lastError).toBeDefined();
      
      // Performance score should be reduced
      expect(result.performanceScore).toBeLessThan(0.8);
    });
  });

  describe('speed scoring', () => {
    it('scores faster agents higher', async () => {
      const config: RoutingConfig = {
        rules: [
          { workType: 'task', agents: ['FastAgent', 'SlowAgent'], confidence: 'high', examples: ['task'] }
        ]
      };

      const router = compileRoutingRules(config);

      // FastAgent: completes in 100ms
      const fastStart = Date.now();
      metrics.handleEvent({
        type: 'session:created',
        sessionId: 'fast-1',
        agentName: 'FastAgent',
        payload: { agentName: 'FastAgent', priority: 'normal' },
        timestamp: new Date()
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      metrics.handleEvent({
        type: 'session:destroyed',
        sessionId: 'fast-1',
        agentName: 'FastAgent',
        payload: { agentName: 'FastAgent', reason: 'complete' },
        timestamp: new Date()
      });

      // SlowAgent: completes in 3000ms
      metrics.handleEvent({
        type: 'session:created',
        sessionId: 'slow-1',
        agentName: 'SlowAgent',
        payload: { agentName: 'SlowAgent', priority: 'normal' },
        timestamp: new Date()
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      metrics.handleEvent({
        type: 'session:destroyed',
        sessionId: 'slow-1',
        agentName: 'SlowAgent',
        payload: { agentName: 'SlowAgent', reason: 'complete' },
        timestamp: new Date()
      });

      const result = scorer.scoreRoutes('do task', router, metrics);
      
      // FastAgent should be preferred
      expect(result.agentName).toBe('FastAgent');
      
      const fastAvg = metrics.getAverageDuration('FastAgent');
      const slowAvg = metrics.getAverageDuration('SlowAgent');
      
      expect(fastAvg).toBeLessThan(slowAvg);
    });
  });

  describe('weight configuration', () => {
    it('allows custom weight configuration', () => {
      const customScorer = new RouteScorer({
        patternWeight: 0.9,
        successRateWeight: 0.05,
        speedWeight: 0.03,
        errorPenalty: 0.02
      });

      expect(customScorer).toBeDefined();
    });

    it('can update weights at runtime', () => {
      scorer.updateConfig({
        patternWeight: 0.7,
        successRateWeight: 0.2
      });

      // Config updated - no error thrown
      expect(scorer).toBeDefined();
    });
  });

  describe('scoring reason', () => {
    it('provides detailed scoring reason', () => {
      const config: RoutingConfig = {
        rules: [
          { workType: 'feature-dev', agents: ['Developer'], confidence: 'high', examples: ['feature', 'develop'] }
        ]
      };

      const router = compileRoutingRules(config);

      // Add some metrics
      metrics.handleEvent({
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'Developer',
        payload: { agentName: 'Developer', priority: 'normal' },
        timestamp: new Date()
      });

      metrics.handleEvent({
        type: 'session:destroyed',
        sessionId: 'session-1',
        agentName: 'Developer',
        payload: { agentName: 'Developer', reason: 'complete' },
        timestamp: new Date()
      });

      const result = scorer.scoreRoutes('develop new feature', router, metrics);
      
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('Pattern');
      expect(result.reason).toContain('Success');
      expect(result.reason).toContain('%');
    });

    it('handles agents with no history', () => {
      const config: RoutingConfig = {
        rules: [
          { workType: 'task', agents: ['NewAgent'], confidence: 'high', examples: ['task'] }
        ]
      };

      const router = compileRoutingRules(config);
      
      const result = scorer.scoreRoutes('do task', router, metrics);
      
      expect(result.agentName).toBe('NewAgent');
      expect(result.reason).toContain('No history');
      expect(result.performanceScore).toBe(0.5); // Neutral for no history
    });
  });
});
