/**
 * Tests for parallel task decomposition — routing parser and phase generation.
 *
 * Covers:
 * - isValidRoutingResponse: validates both single-agent and multi-subtask formats
 * - parseRoutingDecision: parses coordinator output into typed decisions
 * - generateImplPhases: generates correct phase DAGs for both routing kinds
 * - PipelineRunner integration: verifies parallel layers via topological sort
 * - COORDINATOR_CHARTER: verifies charter content supports both formats
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isValidRoutingResponse,
  parseRoutingDecision,
  generateImplPhases,
  type RoutingDecision,
  type PhaseGeneratorOptions,
} from '../packages/squad-sdk/src/pipeline/routing-parser.js';
import { PipelineRunner } from '../packages/squad-sdk/src/pipeline/runner.js';
import type { PipelineDefinition, PipelineRunnerDeps } from '../packages/squad-sdk/src/pipeline/types.js';
import { getBuiltInActor } from '../packages/squad-sdk/src/agents/built-in-actors.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<PhaseGeneratorOptions> = {}): PhaseGeneratorOptions {
  return {
    message: 'Add auth and logging features',
    contextAddendum: '',
    toolCallPlaceholder: '__TOOL_CALL__',
    hasDonePulse: () => false,
    timeout: 60_000,
    ...overrides,
  };
}

function makePipelineDeps(): PipelineRunnerDeps {
  return {
    dispatch: vi.fn().mockResolvedValue({ sessionId: 's', status: 'success', agentName: 'test' }),
    waitForResponse: vi.fn().mockResolvedValue('done — substantial output here'),
    onPhaseStart: vi.fn(),
    onPhaseComplete: vi.fn(),
    onPipelineComplete: vi.fn(),
  };
}

// ─── isValidRoutingResponse ─────────────────────────────────────────────────

describe('isValidRoutingResponse', () => {
  describe('single-agent format', () => {
    it('accepts valid single-agent JSON', () => {
      const input = '{"implementer": "fenster", "reviewer": "hockney", "architect": null}';
      expect(isValidRoutingResponse(input)).toBe(true);
    });

    it('accepts JSON embedded in prose', () => {
      const input = 'Here is my decision:\n{"implementer": "fenster", "reviewer": "hockney"}';
      expect(isValidRoutingResponse(input)).toBe(true);
    });

    it('rejects missing implementer', () => {
      const input = '{"reviewer": "hockney"}';
      expect(isValidRoutingResponse(input)).toBe(false);
    });

    it('accepts single-agent without reviewer', () => {
      const input = '{"implementer": "fenster"}';
      expect(isValidRoutingResponse(input)).toBe(true);
    });

    it('accepts single-agent with explicit null reviewer', () => {
      const input = '{"implementer": "fenster", "reviewer": null}';
      expect(isValidRoutingResponse(input)).toBe(true);
    });
  });

  describe('multi-subtask format', () => {
    it('accepts valid multi-subtask JSON', () => {
      const input = JSON.stringify({
        subtasks: [
          { agent: 'fenster', task: 'context windowing' },
          { agent: 'eecom', task: 'scratchpad' },
        ],
        reviewer: 'hockney',
      });
      expect(isValidRoutingResponse(input)).toBe(true);
    });

    it('accepts JSON with extra whitespace and surrounding text', () => {
      const input = `Routing:\n${JSON.stringify({
        subtasks: [{ agent: 'a', task: 'x' }],
        reviewer: 'b',
      })}\nDone.`;
      expect(isValidRoutingResponse(input)).toBe(true);
    });

    it('rejects empty subtasks array', () => {
      const input = JSON.stringify({ subtasks: [], reviewer: 'hockney' });
      expect(isValidRoutingResponse(input)).toBe(false);
    });

    it('rejects subtask missing agent', () => {
      const input = JSON.stringify({
        subtasks: [{ task: 'something' }],
        reviewer: 'hockney',
      });
      expect(isValidRoutingResponse(input)).toBe(false);
    });

    it('rejects subtask missing task', () => {
      const input = JSON.stringify({
        subtasks: [{ agent: 'fenster' }],
        reviewer: 'hockney',
      });
      expect(isValidRoutingResponse(input)).toBe(false);
    });

    it('accepts subtasks without reviewer', () => {
      const input = JSON.stringify({
        subtasks: [{ agent: 'fenster', task: 'thing' }],
      });
      expect(isValidRoutingResponse(input)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('rejects non-string input', () => {
      expect(isValidRoutingResponse(42)).toBe(false);
      expect(isValidRoutingResponse(null)).toBe(false);
      expect(isValidRoutingResponse(undefined)).toBe(false);
    });

    it('rejects invalid JSON', () => {
      expect(isValidRoutingResponse('not json at all')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidRoutingResponse('')).toBe(false);
    });

    it('rejects object with neither format', () => {
      expect(isValidRoutingResponse('{"foo": "bar"}')).toBe(false);
    });
  });
});

// ─── parseRoutingDecision ───────────────────────────────────────────────────

describe('parseRoutingDecision', () => {
  describe('single-agent format', () => {
    it('parses standard single-agent response', () => {
      const input = '{"implementer": "Fenster", "reviewer": "Hockney", "architect": null}';
      const result = parseRoutingDecision(input);
      expect(result).toEqual({
        kind: 'single',
        implementer: 'fenster',
        reviewer: 'hockney',
      });
    });

    it('lowercases agent names', () => {
      const input = '{"implementer": "EECOM", "reviewer": "FIDO"}';
      const result = parseRoutingDecision(input);
      expect(result?.kind).toBe('single');
      if (result?.kind === 'single') {
        expect(result.implementer).toBe('eecom');
        expect(result.reviewer).toBe('fido');
      }
    });

    it('parses implementer-only routing (no reviewer field)', () => {
      const input = '{"implementer": "fenster"}';
      const result = parseRoutingDecision(input);
      expect(result).toEqual({
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      });
    });

    it('parses implementer-only routing (explicit null reviewer)', () => {
      const input = '{"implementer": "fenster", "reviewer": null}';
      const result = parseRoutingDecision(input);
      expect(result).toEqual({
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      });
    });
  });

  describe('multi-subtask format', () => {
    it('parses multi-subtask response', () => {
      const input = JSON.stringify({
        subtasks: [
          { agent: 'Fenster', task: 'Build auth module' },
          { agent: 'EECOM', task: 'Build logging' },
        ],
        reviewer: 'Hockney',
      });
      const result = parseRoutingDecision(input);
      expect(result).toEqual({
        kind: 'multi',
        subtasks: [
          { agent: 'fenster', task: 'Build auth module' },
          { agent: 'eecom', task: 'Build logging' },
        ],
        reviewer: 'hockney',
      });
    });

    it('preserves task text as-is (no lowercasing)', () => {
      const input = JSON.stringify({
        subtasks: [{ agent: 'a', task: 'Build the AUTH Module' }],
        reviewer: 'b',
      });
      const result = parseRoutingDecision(input);
      if (result?.kind === 'multi') {
        expect(result.subtasks[0]?.task).toBe('Build the AUTH Module');
      }
    });

    it('parses multi-subtask without reviewer', () => {
      const input = JSON.stringify({
        subtasks: [
          { agent: 'fenster', task: 'Build auth module' },
          { agent: 'eecom', task: 'Build logging' },
        ],
      });
      const result = parseRoutingDecision(input);
      expect(result).toEqual({
        kind: 'multi',
        subtasks: [
          { agent: 'fenster', task: 'Build auth module' },
          { agent: 'eecom', task: 'Build logging' },
        ],
        reviewer: null,
      });
    });

    it('prefers multi-subtask format when both keys present', () => {
      // If the Coordinator responds with both subtasks AND implementer,
      // subtasks takes priority (checked first)
      const input = JSON.stringify({
        subtasks: [{ agent: 'a', task: 'x' }],
        implementer: 'b',
        reviewer: 'c',
      });
      const result = parseRoutingDecision(input);
      expect(result?.kind).toBe('multi');
    });
  });

  describe('error handling', () => {
    it('returns null for invalid JSON', () => {
      expect(parseRoutingDecision('not json')).toBeNull();
    });

    it('returns null for unrecognized format', () => {
      expect(parseRoutingDecision('{"foo": "bar"}')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseRoutingDecision('')).toBeNull();
    });
  });
});

// ─── generateImplPhases — single-agent ──────────────────────────────────────

describe('generateImplPhases — single-agent', () => {
  const singleDecision: RoutingDecision = {
    kind: 'single',
    implementer: 'fenster',
    reviewer: 'hockney',
  };

  it('generates exactly 2 phases (implement + review)', () => {
    const phases = generateImplPhases(singleDecision, makeOpts());
    expect(phases).toHaveLength(2);
    expect(phases.map(p => p.id)).toEqual(['implement', 'review']);
  });

  it('generates exactly 1 phase when reviewer is null (no review)', () => {
    const noReviewDecision: RoutingDecision = {
      kind: 'single',
      implementer: 'fenster',
      reviewer: null,
    };
    const phases = generateImplPhases(noReviewDecision, makeOpts());
    expect(phases).toHaveLength(1);
    expect(phases[0]?.id).toBe('implement');
    expect(phases[0]?.agent).toBe('fenster');
  });

  it('implement phase has no dependsOn', () => {
    const phases = generateImplPhases(singleDecision, makeOpts());
    expect(phases[0]?.dependsOn).toBeUndefined();
  });

  it('review phase dependsOn implement', () => {
    const phases = generateImplPhases(singleDecision, makeOpts());
    expect(phases[1]?.dependsOn).toEqual(['implement']);
  });

  it('assigns correct agents', () => {
    const phases = generateImplPhases(singleDecision, makeOpts());
    expect(phases[0]?.agent).toBe('fenster');
    expect(phases[1]?.agent).toBe('hockney');
  });

  it('implement task includes the original message', () => {
    const phases = generateImplPhases(singleDecision, makeOpts({ message: 'fix the auth bug' }));
    expect(phases[0]?.task).toContain('fix the auth bug');
  });

  it('review task references implementer agent for session reading', () => {
    const phases = generateImplPhases(singleDecision, makeOpts());
    expect(phases[1]?.task).toContain('fenster');
    expect(phases[1]?.task).toContain('squad_read_session');
  });

  describe('gate validation', () => {
    it('implement gate accepts substantial text output', () => {
      const phases = generateImplPhases(singleDecision, makeOpts());
      const gate = phases[0]!.gate;
      expect(gate.validate('x'.repeat(51))).toBe(true);
    });

    it('implement gate rejects tool call placeholder', () => {
      const phases = generateImplPhases(singleDecision, makeOpts());
      const gate = phases[0]!.gate;
      expect(gate.validate('__TOOL_CALL__')).toBe(false);
    });

    it('implement gate accepts done pulse', () => {
      const phases = generateImplPhases(singleDecision, makeOpts({
        hasDonePulse: (name) => name === 'fenster',
      }));
      const gate = phases[0]!.gate;
      expect(gate.validate('short')).toBe(true);
    });

    it('review gate accepts substantive text', () => {
      const phases = generateImplPhases(singleDecision, makeOpts());
      const gate = phases[1]!.gate;
      expect(gate.validate('Approved. Looks good.')).toBe(true);
    });
  });

  it('produces linear topological sort: [implement] → [review]', () => {
    const phases = generateImplPhases(singleDecision, makeOpts());
    const pipeline: PipelineDefinition = { id: 'test', name: 'test', phases };
    const runner = new PipelineRunner(pipeline, makePipelineDeps());
    const layers = runner.topologicalSort();

    expect(layers).toEqual([['implement'], ['review']]);
  });
});

// ─── generateImplPhases — multi-subtask ─────────────────────────────────────

describe('generateImplPhases — multi-subtask', () => {
  const multiDecision: RoutingDecision = {
    kind: 'multi',
    subtasks: [
      { agent: 'fenster', task: 'Build auth module' },
      { agent: 'eecom', task: 'Build logging system' },
    ],
    reviewer: 'hockney',
  };

  it('generates N+1 phases (N implement + 1 review)', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    expect(phases).toHaveLength(3);
  });

  it('generates N phases when reviewer is null (no review)', () => {
    const noReviewDecision: RoutingDecision = {
      kind: 'multi',
      subtasks: [
        { agent: 'fenster', task: 'Build auth module' },
        { agent: 'eecom', task: 'Build logging system' },
      ],
      reviewer: null,
    };
    const phases = generateImplPhases(noReviewDecision, makeOpts());
    expect(phases).toHaveLength(2);
    expect(phases.map(p => p.id)).toEqual(['implement-0', 'implement-1']);
    expect(phases.every(p => p.dependsOn === undefined)).toBe(true);
  });

  it('implement phase IDs are implement-0, implement-1, ...', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    expect(phases[0]?.id).toBe('implement-0');
    expect(phases[1]?.id).toBe('implement-1');
    expect(phases[2]?.id).toBe('review');
  });

  it('implement phases have no dependsOn (enables parallel execution)', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    expect(phases[0]?.dependsOn).toBeUndefined();
    expect(phases[1]?.dependsOn).toBeUndefined();
  });

  it('review phase dependsOn all implement phases', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    const review = phases.find(p => p.id === 'review');
    expect(review?.dependsOn).toEqual(['implement-0', 'implement-1']);
  });

  it('assigns correct agents to subtask phases', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    expect(phases[0]?.agent).toBe('fenster');
    expect(phases[1]?.agent).toBe('eecom');
    expect(phases[2]?.agent).toBe('hockney');
  });

  it('each subtask phase includes its specific task description', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    expect(phases[0]?.task).toContain('Build auth module');
    expect(phases[1]?.task).toContain('Build logging system');
  });

  it('each subtask phase includes the original message as context', () => {
    const phases = generateImplPhases(multiDecision, makeOpts({ message: 'Add auth and logging' }));
    expect(phases[0]?.task).toContain('Add auth and logging');
    expect(phases[1]?.task).toContain('Add auth and logging');
  });

  it('subtask phases include parallel coordination instructions', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    expect(phases[0]?.task).toContain('working in parallel');
    expect(phases[0]?.task).toContain('squad_scratchpad_write');
    expect(phases[1]?.task).toContain('Avoid modifying files');
  });

  it('review phase references all subtask agents for session reading', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    const review = phases.find(p => p.id === 'review');
    expect(review?.task).toContain('fenster');
    expect(review?.task).toContain('eecom');
    expect(review?.task).toContain('squad_read_session');
  });

  it('review phase instructs checking for file conflicts', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    const review = phases.find(p => p.id === 'review');
    expect(review?.task).toContain('file conflicts');
    expect(review?.task).toContain('overlapping edits');
  });

  it('review phase lists all subtask descriptions', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    const review = phases.find(p => p.id === 'review');
    expect(review?.task).toContain('Build auth module');
    expect(review?.task).toContain('Build logging system');
  });

  describe('gate validation', () => {
    it('each subtask gate checks its own agent for done pulse', () => {
      const donePulses = new Set(['fenster']);
      const phases = generateImplPhases(multiDecision, makeOpts({
        hasDonePulse: (name) => donePulses.has(name),
      }));
      // fenster (implement-0) has a done pulse → gate passes on short text
      expect(phases[0]!.gate.validate('short')).toBe(true);
      // eecom (implement-1) does NOT have a done pulse → gate fails on short text
      expect(phases[1]!.gate.validate('short')).toBe(false);
    });

    it('subtask gate accepts substantial text regardless of pulse', () => {
      const phases = generateImplPhases(multiDecision, makeOpts());
      expect(phases[0]!.gate.validate('x'.repeat(51))).toBe(true);
      expect(phases[1]!.gate.validate('x'.repeat(51))).toBe(true);
    });

    it('subtask gate rejects tool call placeholder', () => {
      const phases = generateImplPhases(multiDecision, makeOpts());
      expect(phases[0]!.gate.validate('__TOOL_CALL__')).toBe(false);
    });
  });

  it('produces parallel topological sort: [implement-0, implement-1] → [review]', () => {
    const phases = generateImplPhases(multiDecision, makeOpts());
    const pipeline: PipelineDefinition = { id: 'test', name: 'test', phases };
    const runner = new PipelineRunner(pipeline, makePipelineDeps());
    const layers = runner.topologicalSort();

    expect(layers).toHaveLength(2);
    expect(layers[0]).toEqual(expect.arrayContaining(['implement-0', 'implement-1']));
    expect(layers[0]).toHaveLength(2);
    expect(layers[1]).toEqual(['review']);
  });

  it('PipelineRunner executes parallel subtasks via Promise.allSettled', async () => {
    const phases = generateImplPhases(multiDecision, makeOpts({
      hasDonePulse: () => true, // Simulate all agents have emitted done pulses
    }));
    const dispatchOrder: string[] = [];
    const deps = makePipelineDeps();
    (deps.dispatch as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      dispatchOrder.push(name);
      return { sessionId: 's', status: 'success', agentName: name };
    });

    const pipeline: PipelineDefinition = { id: 'test', name: 'test', phases };
    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('completed');
    // Both implement agents dispatched before reviewer
    const fensterIdx = dispatchOrder.indexOf('fenster');
    const eecomIdx = dispatchOrder.indexOf('eecom');
    const hockneyIdx = dispatchOrder.indexOf('hockney');
    expect(fensterIdx).toBeLessThan(hockneyIdx);
    expect(eecomIdx).toBeLessThan(hockneyIdx);
    // All three dispatched
    expect(deps.dispatch).toHaveBeenCalledTimes(3);
  });
});

// ─── generateImplPhases — 3+ subtasks ───────────────────────────────────────

describe('generateImplPhases — many subtasks', () => {
  it('handles 3 parallel subtasks correctly', () => {
    const decision: RoutingDecision = {
      kind: 'multi',
      subtasks: [
        { agent: 'alpha', task: 'Part A' },
        { agent: 'bravo', task: 'Part B' },
        { agent: 'charlie', task: 'Part C' },
      ],
      reviewer: 'delta',
    };
    const phases = generateImplPhases(decision, makeOpts());

    expect(phases).toHaveLength(4);
    expect(phases.map(p => p.id)).toEqual(['implement-0', 'implement-1', 'implement-2', 'review']);

    const review = phases.find(p => p.id === 'review')!;
    expect(review.dependsOn).toEqual(['implement-0', 'implement-1', 'implement-2']);
    expect(review.agent).toBe('delta');

    // Topological sort should put all 3 implement phases in one layer
    const pipeline: PipelineDefinition = { id: 'test', name: 'test', phases };
    const runner = new PipelineRunner(pipeline, makePipelineDeps());
    const layers = runner.topologicalSort();
    expect(layers).toHaveLength(2);
    expect(layers[0]).toHaveLength(3);
    expect(layers[1]).toEqual(['review']);
  });

  it('handles single subtask (degenerate multi)', () => {
    const decision: RoutingDecision = {
      kind: 'multi',
      subtasks: [{ agent: 'fenster', task: 'only task' }],
      reviewer: 'hockney',
    };
    const phases = generateImplPhases(decision, makeOpts());

    expect(phases).toHaveLength(2);
    expect(phases[0]?.id).toBe('implement-0');
    expect(phases[1]?.id).toBe('review');
    expect(phases[1]?.dependsOn).toEqual(['implement-0']);
  });
});

// ─── End-to-end: parse + generate ───────────────────────────────────────────

describe('end-to-end: parse coordinator response → generate phases', () => {
  it('single-agent response → linear pipeline', () => {
    const output = '{"implementer": "fenster", "reviewer": "hockney", "architect": null}';
    const decision = parseRoutingDecision(output);
    expect(decision).not.toBeNull();

    const phases = generateImplPhases(decision!, makeOpts());
    expect(phases).toHaveLength(2);
    expect(phases[0]?.id).toBe('implement');
    expect(phases[1]?.dependsOn).toEqual(['implement']);
  });

  it('multi-subtask response → parallel pipeline', () => {
    const output = JSON.stringify({
      subtasks: [
        { agent: 'fenster', task: 'context windowing' },
        { agent: 'eecom', task: 'scratchpad integration' },
      ],
      reviewer: 'hockney',
    });
    const decision = parseRoutingDecision(output);
    expect(decision).not.toBeNull();

    const phases = generateImplPhases(decision!, makeOpts());
    expect(phases).toHaveLength(3);

    // Verify parallel layer structure
    const pipeline: PipelineDefinition = { id: 'e2e', name: 'e2e', phases };
    const runner = new PipelineRunner(pipeline, makePipelineDeps());
    const layers = runner.topologicalSort();
    expect(layers[0]).toEqual(expect.arrayContaining(['implement-0', 'implement-1']));
    expect(layers[1]).toEqual(['review']);
  });
});

// ─── Coordinator charter content ────────────────────────────────────────────

describe('Coordinator charter — parallel decomposition support', () => {
  const coordinator = getBuiltInActor('coordinator');

  it('charter exists', () => {
    expect(coordinator).toBeDefined();
  });

  it('charter mentions task decomposition', () => {
    expect(coordinator!.charter).toContain('task decomposition');
  });

  it('charter describes single-agent response format', () => {
    expect(coordinator!.charter).toContain('"implementer"');
    expect(coordinator!.charter).toContain('"reviewer"');
  });

  it('charter describes multi-subtask response format', () => {
    expect(coordinator!.charter).toContain('"subtasks"');
    expect(coordinator!.charter).toContain('"agent"');
    expect(coordinator!.charter).toContain('"task"');
  });

  it('charter explains when to decompose', () => {
    expect(coordinator!.charter).toContain('When to decompose');
    expect(coordinator!.charter).toContain('independent');
  });

  it('charter explains when NOT to decompose', () => {
    expect(coordinator!.charter).toContain('When NOT to decompose');
    expect(coordinator!.charter).toContain('tightly coupled');
  });

  it('charter mentions parallel execution', () => {
    expect(coordinator!.charter).toContain('parallel');
  });

  it('charter still contains backward-compatible single-agent format', () => {
    // Backward compat: the old format with architect field is still shown
    expect(coordinator!.charter).toContain('"architect"');
  });
});
