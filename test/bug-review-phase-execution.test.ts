/**
 * Test to verify Bug 2: Review phase generation and execution
 * 
 * Bug description: Coordinator specifies a reviewer but the pipeline never
 * creates a review phase for it — reviewer is ignored.
 */

import { describe, it, expect } from 'vitest';
import {
  generateImplPhases,
  parseRoutingDecision,
  type PhaseGeneratorOptions,
} from '../packages/squad-sdk/src/pipeline/routing-parser.js';

describe('Bug 2: Review phase generation', () => {
  const makeOpts = (overrides?: Partial<PhaseGeneratorOptions>): PhaseGeneratorOptions => ({
    message: 'Fix the auth bug',
    contextAddendum: '',
    toolCallPlaceholder: '__TOOL_CALL__',
    hasDonePulse: () => false,
    timeout: 300_000,
    ...overrides,
  });

  it('should generate review phase when reviewer is specified (single-agent)', () => {
    const routingDecision = parseRoutingDecision('{"implementer": "fenster", "reviewer": "hockney"}');
    expect(routingDecision).not.toBeNull();
    expect(routingDecision?.kind).toBe('single');

    const phases = generateImplPhases(routingDecision!, makeOpts());
    
    // Should have TWO phases: implement + review
    expect(phases).toHaveLength(2);
    expect(phases[0]?.id).toBe('implement');
    expect(phases[0]?.agent).toBe('fenster');
    expect(phases[1]?.id).toBe('review');
    expect(phases[1]?.agent).toBe('hockney');
    expect(phases[1]?.dependsOn).toEqual(['implement']);
  });

  it('should generate review phase when reviewer is specified (multi-subtask)', () => {
    const routingDecision = parseRoutingDecision(
      '{"subtasks": [{"agent": "fenster", "task": "fix auth"}, {"agent": "eecom", "task": "add tests"}], "reviewer": "hockney"}'
    );
    expect(routingDecision).not.toBeNull();
    expect(routingDecision?.kind).toBe('multi');

    const phases = generateImplPhases(routingDecision!, makeOpts());
    
    // Should have THREE phases: implement-0, implement-1, review
    expect(phases).toHaveLength(3);
    expect(phases[0]?.id).toBe('implement-0');
    expect(phases[0]?.agent).toBe('fenster');
    expect(phases[1]?.id).toBe('implement-1');
    expect(phases[1]?.agent).toBe('eecom');
    expect(phases[2]?.id).toBe('review');
    expect(phases[2]?.agent).toBe('hockney');
    expect(phases[2]?.dependsOn).toEqual(['implement-0', 'implement-1']);
  });

  it('should NOT generate review phase when reviewer is null (single-agent)', () => {
    const routingDecision = parseRoutingDecision('{"implementer": "fenster", "reviewer": null}');
    expect(routingDecision).not.toBeNull();

    const phases = generateImplPhases(routingDecision!, makeOpts());
    
    // Should have only ONE phase: implement
    expect(phases).toHaveLength(1);
    expect(phases[0]?.id).toBe('implement');
    expect(phases[0]?.agent).toBe('fenster');
  });

  it('should NOT generate review phase when reviewer is null (multi-subtask)', () => {
    const routingDecision = parseRoutingDecision(
      '{"subtasks": [{"agent": "fenster", "task": "fix auth"}, {"agent": "eecom", "task": "add tests"}], "reviewer": null}'
    );
    expect(routingDecision).not.toBeNull();

    const phases = generateImplPhases(routingDecision!, makeOpts());
    
    // Should have only TWO phases: implement-0, implement-1
    expect(phases).toHaveLength(2);
    expect(phases[0]?.id).toBe('implement-0');
    expect(phases[1]?.id).toBe('implement-1');
  });
});
