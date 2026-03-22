/**
 * Tests for PipelineRunner — deterministic DAG execution
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineRunner } from '../packages/squad-sdk/src/pipeline/runner.js';
import type {
  PipelineDefinition,
  PipelineRunnerDeps,
  PhaseResult,
} from '../packages/squad-sdk/src/pipeline/types.js';

function makeDeps(overrides: Partial<PipelineRunnerDeps> = {}): PipelineRunnerDeps {
  return {
    dispatch: vi.fn().mockResolvedValue({ sessionId: 'test-session', status: 'success', agentName: 'test' }),
    waitForResponse: vi.fn().mockResolvedValue('task completed successfully'),
    onPhaseStart: vi.fn(),
    onPhaseComplete: vi.fn(),
    onPipelineComplete: vi.fn(),
    ...overrides,
  };
}

function makeLinearPipeline(): PipelineDefinition {
  return {
    id: 'test-linear',
    name: 'Linear Pipeline',
    phases: [
      {
        id: 'understand',
        agent: 'ben',
        task: 'Understand user intent',
        gate: { validate: (o: unknown) => typeof o === 'string' && (o as string).length > 0, description: 'non-empty response' },
      },
      {
        id: 'implement',
        agent: 'fenster',
        task: 'Implement the feature',
        dependsOn: ['understand'],
        gate: { validate: (o: unknown) => typeof o === 'string' && (o as string).length > 0, description: 'non-empty response' },
      },
      {
        id: 'review',
        agent: 'hockney',
        task: 'Review the implementation',
        dependsOn: ['implement'],
        gate: { validate: (o: unknown) => typeof o === 'string' && (o as string).includes('approve'), description: 'must include approve' },
      },
    ],
  };
}

function makeParallelPipeline(): PipelineDefinition {
  return {
    id: 'test-parallel',
    name: 'Parallel Pipeline',
    phases: [
      {
        id: 'plan',
        agent: 'ben',
        task: 'Plan the work',
        gate: { validate: () => true, description: 'always passes' },
      },
      {
        id: 'backend',
        agent: 'fenster',
        task: 'Build backend',
        dependsOn: ['plan'],
        gate: { validate: () => true, description: 'always passes' },
      },
      {
        id: 'frontend',
        agent: 'hockney',
        task: 'Build frontend',
        dependsOn: ['plan'],
        gate: { validate: () => true, description: 'always passes' },
      },
      {
        id: 'integrate',
        agent: 'ben',
        task: 'Integrate',
        dependsOn: ['backend', 'frontend'],
        gate: { validate: () => true, description: 'always passes' },
      },
    ],
  };
}

describe('PipelineRunner', () => {
  describe('topologicalSort', () => {
    it('should sort linear dependencies into sequential layers', () => {
      const deps = makeDeps();
      const runner = new PipelineRunner(makeLinearPipeline(), deps);
      const layers = runner.topologicalSort();

      expect(layers).toEqual([['understand'], ['implement'], ['review']]);
    });

    it('should group independent phases into the same layer', () => {
      const deps = makeDeps();
      const runner = new PipelineRunner(makeParallelPipeline(), deps);
      const layers = runner.topologicalSort();

      expect(layers[0]).toEqual(['plan']);
      expect(layers[1]).toEqual(expect.arrayContaining(['backend', 'frontend']));
      expect(layers[1]).toHaveLength(2);
      expect(layers[2]).toEqual(['integrate']);
    });

    it('should detect cycles', () => {
      const cyclicPipeline: PipelineDefinition = {
        id: 'cyclic',
        name: 'Cyclic',
        phases: [
          { id: 'a', agent: 'x', task: 'A', dependsOn: ['b'], gate: { validate: () => true, description: '' } },
          { id: 'b', agent: 'x', task: 'B', dependsOn: ['a'], gate: { validate: () => true, description: '' } },
        ],
      };
      const runner = new PipelineRunner(cyclicPipeline, makeDeps());
      expect(() => runner.topologicalSort()).toThrow(/cycle/i);
    });
  });

  describe('run', () => {
    it('should execute all phases in a linear pipeline', async () => {
      const deps = makeDeps({
        waitForResponse: vi.fn().mockResolvedValue('task completed, approve'),
      });
      const runner = new PipelineRunner(makeLinearPipeline(), deps);

      const state = await runner.run();

      expect(state.status).toBe('completed');
      expect(state.phaseResults.size).toBe(3);
      expect(deps.dispatch).toHaveBeenCalledTimes(3);
      expect(deps.onPhaseStart).toHaveBeenCalledTimes(3);
      expect(deps.onPhaseComplete).toHaveBeenCalledTimes(3);
      expect(deps.onPipelineComplete).toHaveBeenCalledTimes(1);
    });

    it('should pass when gate validates output', async () => {
      const deps = makeDeps({
        waitForResponse: vi.fn().mockResolvedValue('approved — looks good'),
      });
      const pipeline: PipelineDefinition = {
        id: 'gate-test',
        name: 'Gate Test',
        phases: [{
          id: 'check',
          agent: 'hockney',
          task: 'Review',
          gate: { validate: (o: unknown) => typeof o === 'string' && (o as string).includes('approved'), description: 'must include approved' },
        }],
      };

      const runner = new PipelineRunner(pipeline, deps);
      const state = await runner.run();

      expect(state.status).toBe('completed');
      expect(state.phaseResults.get('check')?.status).toBe('completed');
    });

    it('should fail when gate rejects output', async () => {
      const deps = makeDeps({
        waitForResponse: vi.fn().mockResolvedValue('rejected — needs changes'),
      });
      const pipeline: PipelineDefinition = {
        id: 'gate-fail',
        name: 'Gate Fail',
        phases: [{
          id: 'check',
          agent: 'hockney',
          task: 'Review',
          gate: { validate: (o: unknown) => typeof o === 'string' && (o as string).includes('approved'), description: 'must include approved' },
        }],
      };

      const runner = new PipelineRunner(pipeline, deps);
      const state = await runner.run();

      expect(state.status).toBe('failed');
      expect(state.phaseResults.get('check')?.status).toBe('failed');
      expect(state.phaseResults.get('check')?.error).toContain('Gate failed');
    });

    it('should skip downstream phases when a dependency fails', async () => {
      const deps = makeDeps({
        waitForResponse: vi.fn()
          .mockResolvedValueOnce('good')
          .mockResolvedValueOnce(null),
      });
      const runner = new PipelineRunner(makeLinearPipeline(), deps);

      const state = await runner.run();

      expect(state.status).toBe('failed');
      expect(state.phaseResults.get('understand')?.status).toBe('completed');
      expect(state.phaseResults.get('implement')?.status).toBe('failed');
      expect(state.phaseResults.has('review')).toBe(false);
    });

    it('should run independent phases in parallel', async () => {
      const callOrder: string[] = [];
      const deps = makeDeps({
        dispatch: vi.fn().mockImplementation(async (name: string) => {
          callOrder.push(`dispatch:${name}`);
          return { sessionId: 's', status: 'success', agentName: name };
        }),
        waitForResponse: vi.fn().mockResolvedValue('done'),
      });

      const runner = new PipelineRunner(makeParallelPipeline(), deps);
      await runner.run();

      expect(callOrder).toContain('dispatch:fenster');
      expect(callOrder).toContain('dispatch:hockney');
      expect(deps.dispatch).toHaveBeenCalledTimes(4);
    });

    it('should include tool restrictions in task message when allowedTools specified', async () => {
      const deps = makeDeps();
      const pipeline: PipelineDefinition = {
        id: 'tools-test',
        name: 'Tools Test',
        phases: [{
          id: 'scoped',
          agent: 'fenster',
          task: 'Do work',
          allowedTools: ['file_edit', 'shell_exec'],
          gate: { validate: () => true, description: 'ok' },
        }],
      };

      const runner = new PipelineRunner(pipeline, deps);
      await runner.run();

      const taskArg = (deps.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(taskArg).toContain('file_edit');
      expect(taskArg).toContain('shell_exec');
    });
  });
});
