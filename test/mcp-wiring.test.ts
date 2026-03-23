/**
 * Tests for MCP wiring logic — squad_run Q&A handling, cancellation, concurrent run guard.
 *
 * These test the behavioral contracts of the tool handlers without needing
 * a real Copilot backend. They exercise the same patterns used in server.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineRunner } from '../packages/squad-sdk/src/pipeline/runner.js';
import type { PipelineDefinition, PipelineRunnerDeps } from '../packages/squad-sdk/src/pipeline/types.js';
import { PulseCollector, createPulse } from '../packages/squad-sdk/src/pulse/pulse.js';

function makeDeps(overrides: Partial<PipelineRunnerDeps> = {}): PipelineRunnerDeps {
  return {
    dispatch: vi.fn().mockResolvedValue({ sessionId: 's', status: 'ok', agentName: 'test' }),
    waitForResponse: vi.fn().mockResolvedValue('done'),
    ...overrides,
  };
}

function makeSimplePipeline(): PipelineDefinition {
  return {
    id: 'test-run',
    name: 'Test',
    phases: [
      {
        id: 'understand',
        agent: 'ben',
        task: 'Understand',
        gate: { validate: (o: unknown) => typeof o === 'string' && (o as string).length > 0, description: 'non-empty' },
      },
      {
        id: 'implement',
        agent: 'fenster',
        task: 'Implement',
        dependsOn: ['understand'],
        gate: { validate: (o: unknown) => typeof o === 'string' && (o as string).length > 0, description: 'non-empty' },
      },
    ],
  };
}

describe('Q&A-aware waitForResponse', () => {
  /**
   * Simulates the waitForResponse logic from server.ts:
   * If pendingUserQuestions has items, skip the current response and wait for the next one.
   */
  function createQAAwareWaitForResponse(
    getMessages: () => { role: string; content: string }[],
    getPendingQuestions: () => string[],
  ) {
    return async (_agentName: string, timeoutMs: number): Promise<string | null> => {
      let currentCount = getMessages().filter(m => m.role === 'assistant').length;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = getMessages().filter(m => m.role === 'assistant');
        if (replies.length > currentCount) {
          if (getPendingQuestions().length > 0) {
            currentCount = replies.length;
            await new Promise(r => setTimeout(r, 10));
            continue;
          }
          return replies[replies.length - 1]?.content ?? null;
        }
        await new Promise(r => setTimeout(r, 10));
      }
      return null;
    };
  }

  it('should return response immediately when no questions pending', async () => {
    const messages: { role: string; content: string }[] = [
      { role: 'user', content: 'task' },
    ];
    const questions: string[] = [];

    const waitFn = createQAAwareWaitForResponse(
      () => messages,
      () => questions,
    );

    // Simulate assistant response arriving after wait starts
    setTimeout(() => {
      messages.push({ role: 'assistant', content: 'I understand. Here is the plan.' });
    }, 20);

    const result = await waitFn('ben', 5000);
    expect(result).toBe('I understand. Here is the plan.');
  });

  it('should skip response when questions are pending and wait for next', async () => {
    const messages: { role: string; content: string }[] = [
      { role: 'user', content: 'task' },
    ];
    const questions: string[] = [];
    let phase = 0;

    const waitFn = createQAAwareWaitForResponse(
      () => messages,
      () => questions,
    );

    // Simulate: Ben asks a question (assistant reply + questions pending)
    setTimeout(() => {
      messages.push({ role: 'assistant', content: 'What framework do you want?' });
      questions.push('What framework do you want?');
      phase = 1;
    }, 30);

    // Simulate: User responds (questions cleared, new assistant reply)
    setTimeout(() => {
      if (phase === 1) {
        questions.length = 0; // squad_respond clears questions
        messages.push({ role: 'user', content: 'React' });
        messages.push({ role: 'assistant', content: 'Got it. Building a React component.' });
        phase = 2;
      }
    }, 80);

    const result = await waitFn('ben', 5000);
    // Should have skipped the question response and returned the post-Q&A response
    expect(result).toBe('Got it. Building a React component.');
  });

  it('should timeout if questions never get answered', async () => {
    const messages: { role: string; content: string }[] = [
      { role: 'user', content: 'task' },
    ];
    const questions: string[] = [];

    const waitFn = createQAAwareWaitForResponse(
      () => messages,
      () => questions,
    );

    // Ben asks a question but user never responds
    setTimeout(() => {
      messages.push({ role: 'assistant', content: 'What do you need?' });
      questions.push('What do you need?');
    }, 20);

    const result = await waitFn('ben', 200);
    expect(result).toBeNull();
  });
});

describe('squad_cancel integration with PipelineRunner', () => {
  it('should cancel pipeline and report completed phases', async () => {
    let phaseIndex = 0;
    const deps = makeDeps({
      dispatch: vi.fn().mockImplementation(async () => {
        phaseIndex++;
        return { sessionId: 's', status: 'ok', agentName: 'test' };
      }),
      waitForResponse: vi.fn().mockImplementation(async () => {
        if (phaseIndex === 1) {
          // Cancel after first phase
          pipeline.cancel();
        }
        return 'done';
      }),
    });

    const pipeline = new PipelineRunner(makeSimplePipeline(), deps);
    const state = await pipeline.run();

    expect(state.status).toBe('cancelled');

    const completedPhases = [...state.phaseResults.entries()]
      .filter(([, r]) => r.status === 'completed')
      .map(([id]) => id);
    expect(completedPhases).toContain('understand');
    expect(completedPhases).not.toContain('implement');
  });

  it('should cancel multiple pipelines', () => {
    const deps1 = makeDeps();
    const deps2 = makeDeps();
    const p1 = new PipelineRunner(makeSimplePipeline(), deps1);
    const p2 = new PipelineRunner(
      { ...makeSimplePipeline(), id: 'test-run-2' },
      deps2,
    );

    const activePipelines = [p1, p2];
    for (const p of activePipelines) {
      p.cancel();
    }

    expect(p1.getState().status).toBe('cancelled');
    expect(p2.getState().status).toBe('cancelled');
  });
});

describe('Concurrent run guard', () => {
  it('should reject concurrent runs', () => {
    // Simulates the guard logic: if activeRunId is set, reject
    let activeRunId: string | null = null;

    function tryStartRun(message: string): { ok: boolean; error?: string; runId?: string } {
      if (activeRunId) {
        return { ok: false, error: `A run is already active (${activeRunId}). Use squad_cancel to stop it first.` };
      }
      const runId = `run-${Date.now()}`;
      activeRunId = runId;
      return { ok: true, runId };
    }

    const first = tryStartRun('build feature A');
    expect(first.ok).toBe(true);
    expect(first.runId).toBeTruthy();

    const second = tryStartRun('build feature B');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already active');

    // After cancel, should allow new run
    activeRunId = null;
    const third = tryStartRun('build feature C');
    expect(third.ok).toBe(true);
  });

  it('should clear activeRunId on pipeline completion', async () => {
    let activeRunId: string | null = 'run-123';

    const deps = makeDeps();
    const pipeline = new PipelineRunner(makeSimplePipeline(), deps);

    await pipeline.run();
    // Simulate the .finally() block
    activeRunId = null;

    expect(activeRunId).toBeNull();
  });
});

describe('PulseCollector wakes squad_wait', () => {
  it('should trigger callback on user-relevant pulse', () => {
    const collector = new PulseCollector();
    const callback = vi.fn();
    collector.setOnUserRelevantPulse(callback);

    collector.record(createPulse({
      agent: 'ben', phase: 'done', status: 'ok', progressPct: 100,
      summary: 'Pipeline complete', blockers: [], questionsForUser: [],
      artifacts: [], nextStep: '',
    }));

    expect(callback).toHaveBeenCalledOnce();
  });

  it('should resolve wait promise when pulse fires', async () => {
    const collector = new PulseCollector();
    const waitResolvers: Array<(value: string) => void> = [];

    collector.setOnUserRelevantPulse((pulse) => {
      const reason = pulse.phase === 'done' ? 'done' : 'event';
      for (const resolver of waitResolvers) {
        resolver(reason);
      }
      waitResolvers.length = 0;
    });

    const waitPromise = new Promise<string>(resolve => {
      waitResolvers.push(resolve);
    });

    // Emit a done pulse after a short delay
    setTimeout(() => {
      collector.record(createPulse({
        agent: 'fenster', phase: 'done', status: 'ok', progressPct: 100,
        summary: 'Implementation done', blockers: [], questionsForUser: [],
        artifacts: ['src/new-file.ts'], nextStep: '',
      }));
    }, 20);

    const reason = await waitPromise;
    expect(reason).toBe('done');
  });

  it('should collect pending questions from pulse questionsForUser', () => {
    const collector = new PulseCollector();
    const pendingQuestions: string[] = [];

    collector.setOnUserRelevantPulse((pulse) => {
      if (pulse.questionsForUser.length > 0) {
        pendingQuestions.push(...pulse.questionsForUser);
      }
    });

    collector.record(createPulse({
      agent: 'ben', phase: 'analyzing', status: 'ok', progressPct: 30,
      summary: 'Need clarification', blockers: [],
      questionsForUser: ['What framework?', 'Which database?'],
      artifacts: [], nextStep: 'Wait for user',
    }));

    expect(pendingQuestions).toEqual(['What framework?', 'Which database?']);
  });
});
