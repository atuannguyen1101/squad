/**
 * Tests for the premature gate evaluation fix.
 *
 * Bug: Pipeline declares phases "done" while the agent is still actively working.
 * sendAndWait returns on the first response turn, but agents doing multi-step work
 * keep executing for minutes after. The pipeline evaluates the gate on that early
 * partial response and advances, causing Ben to report "Pipeline complete" while
 * agents are still working.
 *
 * Fix: PulseCollector.waitForDonePulse() + impl pipeline dispatch wrapper waits
 * for the agent's "done" pulse before returning the response to the runner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PulseCollector,
  createPulse,
} from '../packages/squad-sdk/src/pulse/pulse.js';
import type { Pulse, PulsePhase } from '../packages/squad-sdk/src/pulse/pulse.js';
import { PipelineRunner } from '../packages/squad-sdk/src/pipeline/runner.js';
import type {
  PipelineDefinition,
  PipelineRunnerDeps,
} from '../packages/squad-sdk/src/pipeline/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makePulse(agent: string, phase: PulsePhase, overrides: Partial<Pulse> = {}): Pulse {
  return createPulse({
    agent,
    phase,
    status: 'ok',
    progressPct: phase === 'done' ? 100 : 50,
    summary: `${agent} ${phase}`,
    blockers: [],
    questionsForUser: [],
    artifacts: [],
    nextStep: '',
    ...overrides,
  });
}

// ============================================================================
// PulseCollector.onPulse
// ============================================================================

describe('PulseCollector.onPulse', () => {
  let collector: PulseCollector;

  beforeEach(() => {
    collector = new PulseCollector();
  });

  it('should notify listeners on every recorded pulse', () => {
    const listener = vi.fn();
    collector.onPulse(listener);

    collector.record(makePulse('agent1', 'starting'));
    collector.record(makePulse('agent1', 'implementing'));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].phase).toBe('starting');
    expect(listener.mock.calls[1][0].phase).toBe('implementing');
  });

  it('should support unsubscribe', () => {
    const listener = vi.fn();
    const unsub = collector.onPulse(listener);

    collector.record(makePulse('agent1', 'starting'));
    unsub();
    collector.record(makePulse('agent1', 'done'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('should not break if listener throws', () => {
    const bad = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const good = vi.fn();
    collector.onPulse(bad);
    collector.onPulse(good);

    collector.record(makePulse('agent1', 'done'));

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// PulseCollector.waitForDonePulse
// ============================================================================

describe('PulseCollector.waitForDonePulse', () => {
  let collector: PulseCollector;

  beforeEach(() => {
    collector = new PulseCollector();
  });

  it('should resolve immediately if done pulse already exists', async () => {
    collector.record(makePulse('impl-agent', 'starting'));
    collector.record(makePulse('impl-agent', 'done'));

    const result = await collector.waitForDonePulse('impl-agent', 5000);

    expect(result).not.toBeNull();
    expect(result!.phase).toBe('done');
    expect(result!.agent).toBe('impl-agent');
  });

  it('should resolve when done pulse arrives after subscribing', async () => {
    const promise = collector.waitForDonePulse('impl-agent', 5000);

    // Simulate: agent works for a bit, then emits done
    setTimeout(() => {
      collector.record(makePulse('impl-agent', 'implementing'));
    }, 10);
    setTimeout(() => {
      collector.record(makePulse('impl-agent', 'done'));
    }, 30);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.phase).toBe('done');
  });

  it('should return null on timeout if no done pulse arrives', async () => {
    const result = await collector.waitForDonePulse('impl-agent', 50);

    expect(result).toBeNull();
  });

  it('should ignore pulses from other agents', async () => {
    const promise = collector.waitForDonePulse('impl-agent', 200);

    // Different agent emits done — should NOT resolve
    setTimeout(() => {
      collector.record(makePulse('other-agent', 'done'));
    }, 10);

    // Our agent emits done later
    setTimeout(() => {
      collector.record(makePulse('impl-agent', 'done'));
    }, 50);

    const result = await promise;
    expect(result!.agent).toBe('impl-agent');
  });

  it('should resolve early on error pulse', async () => {
    const promise = collector.waitForDonePulse('impl-agent', 5000);

    setTimeout(() => {
      collector.record(makePulse('impl-agent', 'implementing', { status: 'error' }));
    }, 10);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.status).toBe('error');
  });

  it('should resolve early on blocked pulse', async () => {
    const promise = collector.waitForDonePulse('impl-agent', 5000);

    setTimeout(() => {
      collector.record(makePulse('impl-agent', 'blocked'));
    }, 10);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.phase).toBe('blocked');
  });

  it('should resolve immediately if error pulse already exists', async () => {
    collector.record(makePulse('impl-agent', 'implementing', { status: 'error' }));

    const result = await collector.waitForDonePulse('impl-agent', 5000);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('error');
  });

  it('should clean up listener on resolution', async () => {
    const initialCount = (collector as any).pulseListeners?.length ?? 0;

    const promise = collector.waitForDonePulse('impl-agent', 5000);

    // Listener should be registered now
    setTimeout(() => {
      collector.record(makePulse('impl-agent', 'done'));
    }, 10);

    await promise;

    // Listener should be cleaned up
    const finalCount = (collector as any).pulseListeners?.length ?? 0;
    expect(finalCount).toBe(initialCount);
  });

  it('should clean up listener on timeout', async () => {
    const initialCount = (collector as any).pulseListeners?.length ?? 0;

    await collector.waitForDonePulse('impl-agent', 50);

    const finalCount = (collector as any).pulseListeners?.length ?? 0;
    expect(finalCount).toBe(initialCount);
  });

  it('should accept custom target phase', async () => {
    collector.record(makePulse('reviewer', 'reviewing'));

    const promise = collector.waitForDonePulse('reviewer', 5000, 'reviewing');
    const result = await promise;

    expect(result).not.toBeNull();
    expect(result!.phase).toBe('reviewing');
  });
});

// ============================================================================
// Pipeline integration — premature gate evaluation fix
// ============================================================================

describe('Pipeline — wait for done pulse before gate', () => {
  function makeDeps(overrides: Partial<PipelineRunnerDeps> = {}): PipelineRunnerDeps {
    return {
      dispatch: vi.fn().mockResolvedValue({
        sessionId: 'test', status: 'success', agentName: 'test',
      }),
      waitForResponse: vi.fn().mockResolvedValue(null),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onPipelineComplete: vi.fn(),
      ...overrides,
    };
  }

  it('should wait for done pulse before evaluating gate (simulates real impl dispatch)', async () => {
    const pulseCollector = new PulseCollector();

    // Simulate the impl pipeline dispatch wrapper that waits for done pulse
    const dispatchWithDoneWait = vi.fn().mockImplementation(
      async (agentName: string, _task: string) => {
        // Step 1: sendAndWait returns immediately (first turn)
        // (simulated — in reality this is server.dispatch)

        // Step 2: Wait for done pulse before returning
        const donePulse = await pulseCollector.waitForDonePulse(agentName, 5000);

        // Step 3: Return the response (gate evaluates AFTER this)
        return {
          sessionId: 'test', status: 'success', agentName,
          response: donePulse?.summary ?? 'no pulse',
        };
      },
    );

    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'impl-agent',
        task: 'implement something',
        gate: {
          validate: (o: unknown) => {
            // Gate checks for done pulse
            const pulses = pulseCollector.getByAgent('impl-agent');
            return pulses.some(p => p.phase === 'done');
          },
          description: 'agent must emit done pulse',
        },
        timeout: 10_000,
      }],
    };

    const deps = makeDeps({ dispatch: dispatchWithDoneWait });

    // Simulate: agent emits done pulse after 50ms of "work"
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'starting'));
    }, 10);
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'implementing'));
    }, 20);
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'done', {
        summary: 'Created 3 files, all tests pass',
        artifacts: ['src/api.ts', 'test/api.test.ts'],
      }));
    }, 50);

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('completed');
    expect(state.phaseResults.get('impl')?.status).toBe('completed');
    // Verify dispatch was called
    expect(dispatchWithDoneWait).toHaveBeenCalledOnce();
  });

  it('should NOT evaluate gate on early partial response (the bug scenario)', async () => {
    const pulseCollector = new PulseCollector();
    const gateCallTimes: number[] = [];

    // Without the fix: dispatch returns immediately, gate evaluates early
    // With the fix: dispatch waits for done pulse, gate evaluates at right time
    const dispatchWithDoneWait = vi.fn().mockImplementation(
      async (agentName: string) => {
        // sendAndWait returns at t=0 with partial response
        const earlyResponse = 'Starting to implement...'; // partial first turn

        // But we wait for done pulse before returning
        await pulseCollector.waitForDonePulse(agentName, 5000);

        return {
          sessionId: 'test', status: 'success', agentName,
          response: earlyResponse,
        };
      },
    );

    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'impl-agent',
        task: 'implement something',
        gate: {
          validate: () => {
            gateCallTimes.push(Date.now());
            const pulses = pulseCollector.getByAgent('impl-agent');
            return pulses.some(p => p.phase === 'done');
          },
          description: 'must have done pulse',
        },
      }],
    };

    const deps = makeDeps({ dispatch: dispatchWithDoneWait });
    const startTime = Date.now();

    // Agent does work for 80ms, then emits done
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'implementing'));
    }, 20);
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'testing'));
    }, 40);
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'done'));
    }, 80);

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('completed');
    // Gate should only have been called AFTER the done pulse (>= 80ms after start)
    expect(gateCallTimes.length).toBeGreaterThanOrEqual(1);
    expect(gateCallTimes[0]! - startTime).toBeGreaterThanOrEqual(70); // with some margin
  });

  it('should time out and let gate fail if agent never emits done', async () => {
    const pulseCollector = new PulseCollector();

    const dispatchWithDoneWait = vi.fn().mockImplementation(
      async (agentName: string) => {
        // Wait for done pulse with short timeout
        await pulseCollector.waitForDonePulse(agentName, 100);

        return {
          sessionId: 'test', status: 'success', agentName,
          response: 'partial response',
        };
      },
    );

    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'impl-agent',
        task: 'implement something',
        gate: {
          validate: () => {
            // No done pulse was emitted, so this should fail
            const pulses = pulseCollector.getByAgent('impl-agent');
            return pulses.some(p => p.phase === 'done');
          },
          description: 'must have done pulse',
        },
      }],
    };

    const deps = makeDeps({ dispatch: dispatchWithDoneWait });

    // Agent never emits done — just keeps reporting progress
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'implementing'));
    }, 10);

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('failed');
    expect(state.phaseResults.get('impl')?.status).toBe('failed');
    expect(state.phaseResults.get('impl')?.error).toContain('Gate failed');
  });

  it('should handle agent error pulse without waiting for done', async () => {
    const pulseCollector = new PulseCollector();

    const dispatchWithDoneWait = vi.fn().mockImplementation(
      async (agentName: string) => {
        await pulseCollector.waitForDonePulse(agentName, 5000);

        return {
          sessionId: 'test', status: 'success', agentName,
          response: 'error occurred',
        };
      },
    );

    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'impl-agent',
        task: 'implement something',
        gate: {
          validate: () => {
            const pulses = pulseCollector.getByAgent('impl-agent');
            return pulses.some(p => p.phase === 'done');
          },
          description: 'must have done pulse',
        },
      }],
    };

    const deps = makeDeps({ dispatch: dispatchWithDoneWait });

    // Agent hits an error — waitForDonePulse should resolve early
    setTimeout(() => {
      pulseCollector.record(makePulse('impl-agent', 'implementing', {
        status: 'error',
        summary: 'Build failed with 3 errors',
      }));
    }, 20);

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    // Error pulse resolves waitForDonePulse, but gate still requires done phase
    expect(state.status).toBe('failed');
  });
});
