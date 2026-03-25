/**
 * Integration test to verify review phases execute end-to-end
 * 
 * This test verifies that when a coordinator specifies a reviewer,
 * the review phase is not only created but also executed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PipelineRunner,
  generateImplPhases,
  parseRoutingDecision,
  type PhaseGeneratorOptions,
  type PipelineRunnerDeps,
} from '../packages/squad-sdk/src/pipeline/index.js';

describe('Review Phase Execution (Integration)', () => {
  let dispatchMock: ReturnType<typeof vi.fn>;
  let hasDonePulseMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchMock = vi.fn();
    hasDonePulseMock = vi.fn();
  });

  it('should execute review phase after implementation completes', async () => {
    // Parse coordinator's routing decision with a reviewer
    const routingDecision = parseRoutingDecision(
      '{"implementer": "fenster", "reviewer": "hockney"}'
    );
    expect(routingDecision).not.toBeNull();
    expect(routingDecision?.kind).toBe('single');

    // Track which agents were dispatched
    const dispatchedAgents: string[] = [];
    
    dispatchMock.mockImplementation(async (agentName: string, task: string) => {
      dispatchedAgents.push(agentName);
      return {
        sessionId: `session-${agentName}`,
        status: 'completed' as const,
        agentName,
        response: `${agentName} completed: ${task.substring(0, 50)}`,
      };
    });

    // Simulate done pulses for both agents
    hasDonePulseMock.mockImplementation((agentName: string) => {
      return dispatchedAgents.includes(agentName);
    });

    // Generate phases (should include implement + review)
    const opts: PhaseGeneratorOptions = {
      message: 'Fix the auth bug',
      contextAddendum: '',
      toolCallPlaceholder: '__TOOL_CALL__',
      hasDonePulse: hasDonePulseMock,
      timeout: 10_000,
    };
    
    const phases = generateImplPhases(routingDecision!, opts);
    
    // Verify phases were created correctly
    expect(phases).toHaveLength(2);
    expect(phases[0]?.id).toBe('implement');
    expect(phases[0]?.agent).toBe('fenster');
    expect(phases[1]?.id).toBe('review');
    expect(phases[1]?.agent).toBe('hockney');

    // Run the pipeline
    const deps: PipelineRunnerDeps = {
      dispatch: dispatchMock,
    };

    const pipeline = new PipelineRunner(
      { id: 'test-pipeline', name: 'Test Pipeline', phases },
      deps
    );

    const state = await pipeline.run();

    // Verify both phases executed
    expect(state.status).toBe('completed');
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    
    // Verify implementer was called first
    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      'fenster',
      expect.stringContaining('Implement the following request')
    );
    
    // Verify reviewer was called second
    expect(dispatchMock).toHaveBeenNthCalledWith(
      2,
      'hockney',
      expect.stringContaining('Review the implementation')
    );

    // Verify both agents were dispatched in order
    expect(dispatchedAgents).toEqual(['fenster', 'hockney']);

    // Verify phase results
    const implementResult = state.phaseResults.get('implement');
    const reviewResult = state.phaseResults.get('review');
    
    expect(implementResult?.status).toBe('completed');
    expect(implementResult?.agent).toBe('fenster');
    expect(reviewResult?.status).toBe('completed');
    expect(reviewResult?.agent).toBe('hockney');
  });

  it('should execute review phase for multi-subtask with reviewer', async () => {
    const routingDecision = parseRoutingDecision(
      '{"subtasks": [{"agent": "fenster", "task": "fix auth"}, {"agent": "eecom", "task": "add tests"}], "reviewer": "hockney"}'
    );
    expect(routingDecision).not.toBeNull();
    expect(routingDecision?.kind).toBe('multi');

    const dispatchedAgents: string[] = [];
    
    dispatchMock.mockImplementation(async (agentName: string) => {
      dispatchedAgents.push(agentName);
      return {
        sessionId: `session-${agentName}`,
        status: 'completed' as const,
        agentName,
        response: `${agentName} completed work`,
      };
    });

    hasDonePulseMock.mockImplementation((agentName: string) => {
      return dispatchedAgents.includes(agentName);
    });

    const opts: PhaseGeneratorOptions = {
      message: 'Fix auth and add tests',
      contextAddendum: '',
      toolCallPlaceholder: '__TOOL_CALL__',
      hasDonePulse: hasDonePulseMock,
      timeout: 10_000,
    };
    
    const phases = generateImplPhases(routingDecision!, opts);
    
    // Should have 3 phases: implement-0, implement-1, review
    expect(phases).toHaveLength(3);
    expect(phases[2]?.id).toBe('review');
    expect(phases[2]?.agent).toBe('hockney');

    const deps: PipelineRunnerDeps = {
      dispatch: dispatchMock,
    };

    const pipeline = new PipelineRunner(
      { id: 'test-pipeline', name: 'Test Pipeline', phases },
      deps
    );

    const state = await pipeline.run();

    // Verify all 3 phases executed (2 implementers + 1 reviewer)
    expect(state.status).toBe('completed');
    expect(dispatchMock).toHaveBeenCalledTimes(3);
    
    // Verify reviewer was called last
    expect(dispatchedAgents[2]).toBe('hockney');
    
    // Verify reviewer phase completed
    const reviewResult = state.phaseResults.get('review');
    expect(reviewResult?.status).toBe('completed');
    expect(reviewResult?.agent).toBe('hockney');
  });

  it('should NOT execute review phase when reviewer is null', async () => {
    const routingDecision = parseRoutingDecision(
      '{"implementer": "fenster", "reviewer": null}'
    );
    expect(routingDecision).not.toBeNull();

    const dispatchedAgents: string[] = [];
    
    dispatchMock.mockImplementation(async (agentName: string) => {
      dispatchedAgents.push(agentName);
      return {
        sessionId: `session-${agentName}`,
        status: 'completed' as const,
        agentName,
        response: `${agentName} completed work`,
      };
    });

    hasDonePulseMock.mockImplementation((agentName: string) => {
      return dispatchedAgents.includes(agentName);
    });

    const opts: PhaseGeneratorOptions = {
      message: 'Fix the auth bug',
      contextAddendum: '',
      toolCallPlaceholder: '__TOOL_CALL__',
      hasDonePulse: hasDonePulseMock,
      timeout: 10_000,
    };
    
    const phases = generateImplPhases(routingDecision!, opts);
    
    // Should have only 1 phase: implement
    expect(phases).toHaveLength(1);
    expect(phases[0]?.id).toBe('implement');

    const deps: PipelineRunnerDeps = {
      dispatch: dispatchMock,
    };

    const pipeline = new PipelineRunner(
      { id: 'test-pipeline', name: 'Test Pipeline', phases },
      deps
    );

    const state = await pipeline.run();

    // Verify only implementer executed (no reviewer)
    expect(state.status).toBe('completed');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchedAgents).toEqual(['fenster']);
    
    // Verify no review phase exists
    const reviewResult = state.phaseResults.get('review');
    expect(reviewResult).toBeUndefined();
  });
});
