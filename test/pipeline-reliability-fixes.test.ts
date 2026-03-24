/**
 * Tests for pipeline reliability bug fixes (#perf-test-failures)
 * 
 * Bug 1: Coordinator gate resilience - extract JSON from markdown, ignore prose
 * Bug 2: Planner role gates - accept planning output not just code
 * Bug 3: Partial failure resilience - continue to review with partial completion
 */

import { describe, it, expect } from 'vitest';
import {
  isValidRoutingResponse,
  parseRoutingDecision,
  generateImplPhases,
} from '../packages/squad-sdk/src/pipeline/routing-parser.js';

describe('Bug 1: Coordinator Gate Resilience', () => {
  it('should extract JSON from markdown code blocks', () => {
    const wrappedJson = `Here's the routing decision:
\`\`\`json
{"implementer": "fenster", "reviewer": "hockney"}
\`\`\`
Hope this helps!`;

    expect(isValidRoutingResponse(wrappedJson)).toBe(true);
    const decision = parseRoutingDecision(wrappedJson);
    expect(decision).toEqual({
      kind: 'single',
      implementer: 'fenster',
      reviewer: 'hockney',
    });
  });

  it('should extract JSON from markdown without json tag', () => {
    const wrappedJson = `I've analyzed the task. Here's my routing:
\`\`\`
{"implementer": "fenster", "reviewer": null}
\`\`\``;

    expect(isValidRoutingResponse(wrappedJson)).toBe(true);
    const decision = parseRoutingDecision(wrappedJson);
    expect(decision).toEqual({
      kind: 'single',
      implementer: 'fenster',
      reviewer: null,
    });
  });

  it('should extract JSON surrounded by prose', () => {
    const wrappedJson = `Let me route this task properly.
    
{"implementer": "mcmanus", "reviewer": "hockney"}

This should work well!`;

    expect(isValidRoutingResponse(wrappedJson)).toBe(true);
    const decision = parseRoutingDecision(wrappedJson);
    expect(decision).toEqual({
      kind: 'single',
      implementer: 'mcmanus',
      reviewer: 'hockney',
    });
  });

  it('should handle multi-subtask routing in markdown', () => {
    const wrappedJson = `\`\`\`json
{
  "subtasks": [
    {"agent": "fenster", "task": "Build backend"},
    {"agent": "mcmanus", "task": "Write docs"}
  ],
  "reviewer": "hockney"
}
\`\`\``;

    expect(isValidRoutingResponse(wrappedJson)).toBe(true);
    const decision = parseRoutingDecision(wrappedJson);
    expect(decision?.kind).toBe('multi');
    if (decision?.kind === 'multi') {
      expect(decision.subtasks).toHaveLength(2);
      expect(decision.subtasks[0]).toEqual({ agent: 'fenster', task: 'Build backend' });
      expect(decision.reviewer).toBe('hockney');
    }
  });

  it('should reject invalid JSON even when wrapped', () => {
    const invalid = `\`\`\`json
{"implementer": "fenster", invalid json here
\`\`\``;

    expect(isValidRoutingResponse(invalid)).toBe(false);
    expect(parseRoutingDecision(invalid)).toBeNull();
  });

  it('should reject JSON without required fields', () => {
    const noImplementer = `\`\`\`json
{"reviewer": "hockney"}
\`\`\``;

    expect(isValidRoutingResponse(noImplementer)).toBe(false);
    expect(parseRoutingDecision(noImplementer)).toBeNull();
  });
});

describe('Bug 2: Planner Role Gates', () => {
  it('should accept planning output from planner roles', () => {
    const plannerOutput = 'Task breakdown:\n1. Design API\n2. Implement endpoints\n3. Write tests';
    
    const phases = generateImplPhases(
      { kind: 'single', implementer: 'keaton', reviewer: null },
      {
        message: 'Plan the API migration',
        contextAddendum: '',
        hasDonePulse: () => false,
        isPlannerRole: (name) => name === 'keaton',
        toolCallPlaceholder: '[tool_call_placeholder]',
      },
    );

    expect(phases).toHaveLength(1);
    const gate = phases[0]!.gate;
    expect(gate.validate(plannerOutput)).toBe(true);
  });

  it('should accept planning output from subtask planners', () => {
    const plannerOutput = 'Migration plan:\n- Phase 1: Assessment\n- Phase 2: Implementation';
    
    const phases = generateImplPhases(
      {
        kind: 'multi',
        subtasks: [
          { agent: 'keaton', task: 'Plan migration' },
          { agent: 'fenster', task: 'Implement API' },
        ],
        reviewer: 'hockney',
      },
      {
        message: 'Migrate APIM Portal',
        contextAddendum: '',
        hasDonePulse: () => false,
        isPlannerRole: (name) => name === 'keaton',
        toolCallPlaceholder: '[tool_call_placeholder]',
      },
    );

    expect(phases).toHaveLength(3); // 2 implement + 1 review
    const keatonGate = phases[0]!.gate;
    expect(keatonGate.validate(plannerOutput)).toBe(true);
  });

  it('should still require substantial output from non-planner implementers', () => {
    const shortOutput = 'done';
    
    const phases = generateImplPhases(
      { kind: 'single', implementer: 'fenster', reviewer: null },
      {
        message: 'Fix bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        isPlannerRole: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
      },
    );

    const gate = phases[0]!.gate;
    expect(gate.validate(shortOutput)).toBe(false);
  });

  it('should accept code output from implementers', () => {
    const codeOutput = 'Fixed the authentication bug by updating the token validation logic in auth.ts';
    
    const phases = generateImplPhases(
      { kind: 'single', implementer: 'fenster', reviewer: null },
      {
        message: 'Fix auth bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        isPlannerRole: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
      },
    );

    const gate = phases[0]!.gate;
    expect(gate.validate(codeOutput)).toBe(true);
  });
});

describe('Bug 3: Partial Failure Resilience', () => {
  it('should generate review phase with continueOnPartialFailure for multi-subtask', () => {
    const phases = generateImplPhases(
      {
        kind: 'multi',
        subtasks: [
          { agent: 'fenster', task: 'Backend' },
          { agent: 'mcmanus', task: 'Docs' },
          { agent: 'edie', task: 'Types' },
        ],
        reviewer: 'hockney',
      },
      {
        message: 'Build feature',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
      },
    );

    // Should have 3 implement phases + 1 review
    expect(phases).toHaveLength(4);
    
    const reviewPhase = phases.find(p => p.id === 'review');
    expect(reviewPhase).toBeDefined();
    expect(reviewPhase!.continueOnPartialFailure).toBe(true);
    expect(reviewPhase!.dependsOn).toEqual(['implement-0', 'implement-1', 'implement-2']);
  });

  it('should not set continueOnPartialFailure for single-implementer review', () => {
    const phases = generateImplPhases(
      { kind: 'single', implementer: 'fenster', reviewer: 'hockney' },
      {
        message: 'Build feature',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
      },
    );

    const reviewPhase = phases.find(p => p.id === 'review');
    expect(reviewPhase).toBeDefined();
    expect(reviewPhase!.continueOnPartialFailure).toBe(false);
  });

  it('should include note about partial failure in multi-subtask review task', () => {
    const phases = generateImplPhases(
      {
        kind: 'multi',
        subtasks: [
          { agent: 'fenster', task: 'Backend' },
          { agent: 'mcmanus', task: 'Docs' },
        ],
        reviewer: 'hockney',
      },
      {
        message: 'Build feature',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
      },
    );

    const reviewPhase = phases.find(p => p.id === 'review');
    expect(reviewPhase!.task).toContain('Some subtasks may have failed');
    expect(reviewPhase!.task).toContain('Review the work that was completed');
  });
});
