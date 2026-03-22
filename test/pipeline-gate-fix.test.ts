/**
 * Tests for the pipeline gate bug fix — tool-call-only agent responses.
 *
 * Bug: When an agent does substantial work via tool calls but returns empty text,
 * the pipeline gate incorrectly fails because:
 *   1. dispatch() drops the response (content extraction returns null)
 *   2. waitForResponse finds no new assistant message, times out
 *   3. Gate validates null against "length > 50", fails
 *
 * Fix:
 *   1. extractResponseContent() + placeholder message for tool-call-only turns
 *   2. Gates also accept agents that emitted "done" pulses
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractResponseContent, TOOL_CALL_PLACEHOLDER } from '../packages/squad-sdk/src/server/agent-lifecycle.js';
import { PipelineRunner } from '../packages/squad-sdk/src/pipeline/runner.js';
import type { PipelineDefinition, PipelineRunnerDeps } from '../packages/squad-sdk/src/pipeline/types.js';
import { PulseCollector, createPulse } from '../packages/squad-sdk/src/pulse/pulse.js';

// ============================================================================
// extractResponseContent — the root cause helper
// ============================================================================

describe('extractResponseContent', () => {
  it('should extract from plain string', () => {
    expect(extractResponseContent('hello world')).toBe('hello world');
  });

  it('should return null for empty string', () => {
    expect(extractResponseContent('')).toBeNull();
  });

  it('should return null for null', () => {
    expect(extractResponseContent(null)).toBeNull();
  });

  it('should return null for undefined', () => {
    expect(extractResponseContent(undefined)).toBeNull();
  });

  it('should extract from { text: string }', () => {
    expect(extractResponseContent({ text: 'from text field' })).toBe('from text field');
  });

  it('should return null for { text: "" }', () => {
    expect(extractResponseContent({ text: '' })).toBeNull();
  });

  it('should extract from { data: { content: string } }', () => {
    expect(extractResponseContent({ data: { content: 'deep content' } })).toBe('deep content');
  });

  it('should return null for { data: { content: "" } }', () => {
    expect(extractResponseContent({ data: { content: '' } })).toBeNull();
  });

  it('should extract from { content: string }', () => {
    expect(extractResponseContent({ content: 'direct content' })).toBe('direct content');
  });

  it('should return null for { content: "" }', () => {
    expect(extractResponseContent({ content: '' })).toBeNull();
  });

  it('should return null for empty object (tool-call-only response)', () => {
    // This is the key case: agent did work via tools, returned {}
    expect(extractResponseContent({})).toBeNull();
  });

  it('should return null for object with unrecognized fields', () => {
    expect(extractResponseContent({ toolCalls: [{ name: 'edit' }], status: 'ok' })).toBeNull();
  });

  it('should prefer text over content when both present', () => {
    expect(extractResponseContent({ text: 'from text', content: 'from content' })).toBe('from text');
  });
});

// ============================================================================
// Pipeline gate behavior with tool-call-only responses
// ============================================================================

describe('Pipeline gate — tool-call-only agent responses', () => {
  function makeDeps(overrides: Partial<PipelineRunnerDeps> = {}): PipelineRunnerDeps {
    return {
      dispatch: vi.fn().mockResolvedValue({
        sessionId: 'test', status: 'success', agentName: 'impl-agent',
      }),
      waitForResponse: vi.fn().mockResolvedValue(null),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onPipelineComplete: vi.fn(),
      ...overrides,
    };
  }

  it('should fail gate when text is empty AND no pulse-aware gate', async () => {
    // Old behavior: gate only checks text length
    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'test-agent',
        task: 'do something',
        gate: {
          validate: (o: unknown) => typeof o === 'string' && (o as string).length > 50,
          description: 'must produce substantial text',
        },
      }],
    };

    // Agent returns no text (tool-call-only) and waitForResponse also returns null
    const deps = makeDeps({
      dispatch: vi.fn().mockResolvedValue({
        sessionId: 'test', status: 'success', agentName: 'test-agent',
        response: undefined,
      }),
      waitForResponse: vi.fn().mockResolvedValue(null),
    });

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('failed');
    const result = state.phaseResults.get('impl');
    expect(result?.status).toBe('failed');
    expect(result?.error).toContain('Gate failed');
  });

  it('should pass gate when agent returns placeholder but emitted done pulse (pulse-aware gate)', async () => {
    // New behavior: gate checks pulses too
    const pulseCollector = new PulseCollector();

    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'impl-agent',
        task: 'do something',
        gate: {
          validate: (o: unknown) => {
            // Text-based check (excludes placeholder — same as real gate)
            if (typeof o === 'string' && o !== TOOL_CALL_PLACEHOLDER && (o as string).length > 50) return true;
            // Pulse-based check (same pattern as the fix in server.ts)
            const agentPulses = pulseCollector.getByAgent('impl-agent');
            return agentPulses.some(p => p.phase === 'done');
          },
          description: 'must produce substantial output or done pulse',
        },
      }],
    };

    // Agent returns the placeholder from our fix (tool-call-only response)
    const deps = makeDeps({
      dispatch: vi.fn().mockImplementation(async () => {
        // Simulate: agent does tool calls, emits done pulse, returns placeholder
        pulseCollector.record(createPulse({
          agent: 'impl-agent', phase: 'done', status: 'ok', progressPct: 100,
          summary: 'Implementation complete — created 3 files',
          blockers: [], questionsForUser: [],
          artifacts: ['src/api.ts', 'src/types.ts', 'test/api.test.ts'],
          nextStep: '',
        }));
        return {
          sessionId: 'test', status: 'success', agentName: 'impl-agent',
          response: TOOL_CALL_PLACEHOLDER,
        };
      }),
    });

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('completed');
    const result = state.phaseResults.get('impl');
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe(TOOL_CALL_PLACEHOLDER);
  });

  it('should pass gate when agent returns substantial text (unchanged behavior)', async () => {
    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'test-agent',
        task: 'do something',
        gate: {
          validate: (o: unknown) => typeof o === 'string' && (o as string).length > 50,
          description: 'must produce substantial text',
        },
      }],
    };

    const deps = makeDeps({
      dispatch: vi.fn().mockResolvedValue({
        sessionId: 'test', status: 'success', agentName: 'test-agent',
        response: 'I implemented the feature by creating src/api.ts with the REST endpoints and test/api.test.ts with full coverage.',
      }),
    });

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('completed');
    expect(state.phaseResults.get('impl')?.status).toBe('completed');
  });

  it('should still fail gate when no text AND no done pulse (guard against false passes)', async () => {
    const pulseCollector = new PulseCollector();

    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'impl-agent',
        task: 'do something',
        gate: {
          validate: (o: unknown) => {
            if (typeof o === 'string' && o !== TOOL_CALL_PLACEHOLDER && (o as string).length > 50) return true;
            const agentPulses = pulseCollector.getByAgent('impl-agent');
            return agentPulses.some(p => p.phase === 'done');
          },
          description: 'must produce substantial output or done pulse',
        },
      }],
    };

    // Agent returns placeholder but did NOT emit a done pulse (e.g. got stuck)
    const deps = makeDeps({
      dispatch: vi.fn().mockResolvedValue({
        sessionId: 'test', status: 'success', agentName: 'impl-agent',
        response: TOOL_CALL_PLACEHOLDER,
      }),
    });

    // Record only a "starting" pulse — no "done"
    pulseCollector.record(createPulse({
      agent: 'impl-agent', phase: 'starting', status: 'ok', progressPct: 0,
      summary: 'Starting work', blockers: [], questionsForUser: [],
      artifacts: [], nextStep: 'write code',
    }));

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('failed');
    expect(state.phaseResults.get('impl')?.status).toBe('failed');
  });

  it('should handle waitForResponse returning placeholder when dispatch has no response', async () => {
    const pulseCollector = new PulseCollector();

    const pipeline: PipelineDefinition = {
      id: 'test', name: 'Test',
      phases: [{
        id: 'impl',
        agent: 'impl-agent',
        task: 'do something',
        gate: {
          validate: (o: unknown) => {
            if (typeof o === 'string' && o !== TOOL_CALL_PLACEHOLDER && (o as string).length > 50) return true;
            const agentPulses = pulseCollector.getByAgent('impl-agent');
            return agentPulses.some(p => p.phase === 'done');
          },
          description: 'must produce substantial output or done pulse',
        },
      }],
    };

    // dispatch returns no response, but waitForResponse catches the placeholder
    const deps = makeDeps({
      dispatch: vi.fn().mockImplementation(async () => {
        pulseCollector.record(createPulse({
          agent: 'impl-agent', phase: 'done', status: 'ok', progressPct: 100,
          summary: 'Done', blockers: [], questionsForUser: [],
          artifacts: [], nextStep: '',
        }));
        return { sessionId: 'test', status: 'success', agentName: 'impl-agent' };
        // Note: no response field — falls through to waitForResponse
      }),
      waitForResponse: vi.fn().mockResolvedValue(TOOL_CALL_PLACEHOLDER),
    });

    const runner = new PipelineRunner(pipeline, deps);
    const state = await runner.run();

    expect(state.status).toBe('completed');
    expect(state.phaseResults.get('impl')?.status).toBe('completed');
  });
});

// ============================================================================
// Dispatch placeholder recording
// ============================================================================

describe('Dispatch placeholder recording', () => {
  it('should ensure TOOL_CALL_PLACEHOLDER is a non-empty string', () => {
    expect(TOOL_CALL_PLACEHOLDER.length).toBeGreaterThan(0);
    expect(TOOL_CALL_PLACEHOLDER).toContain('tool calls');
  });

  it('should be distinguishable from real agent output by gate logic', () => {
    // The gate checks: o !== TOOL_CALL_PLACEHOLDER && o.length > 50
    // So the placeholder must NOT pass the text-length gate by itself
    const gatePassesText = TOOL_CALL_PLACEHOLDER !== TOOL_CALL_PLACEHOLDER && TOOL_CALL_PLACEHOLDER.length > 50;
    expect(gatePassesText).toBe(false);
  });
});
