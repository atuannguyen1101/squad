/**
 * Tests for IntentSummarizer
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IntentGraph } from '../../intent/IntentGraph.js';
import { IntentSummarizer } from '../../intent/IntentSummarizer.js';

describe('IntentSummarizer', () => {
  let graph: IntentGraph;

  beforeEach(() => {
    graph = new IntentGraph();

    // Set up a typical intent graph
    graph.addNode({
      id: 'goal-1',
      type: 'goal',
      description: 'Migrate Products blade to React',
      status: 'in_progress',
    });

    graph.addNode({
      id: 'constraint-1',
      type: 'constraint',
      description: 'Keep files under 200 lines',
      status: 'pending',
    });

    graph.addNode({
      id: 'ac-1',
      type: 'acceptance_criterion',
      description: 'All existing tests must pass',
      status: 'pending',
    });

    graph.addNode({
      id: 'task-ui',
      type: 'task',
      description: 'Implement React UI components',
      status: 'in_progress',
      assignedTo: 'fenster',
    });

    graph.addNode({
      id: 'task-data',
      type: 'task',
      description: 'Create data layer hooks',
      status: 'pending',
      assignedTo: 'mcmanus',
    });

    graph.setRootGoal('goal-1');
    graph.addEdge({ from: 'task-data', to: 'task-ui', type: 'enables' });
  });

  describe('summarizeForAgent', () => {
    it('should extract overall goal', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
      expect(summary.overallGoal).toBe('Migrate Products blade to React');
    });

    it('should find agent assignment', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
      expect(summary.agentAssignment).toBeDefined();
      expect(summary.agentAssignment?.taskId).toBe('task-ui');
      expect(summary.agentAssignment?.description).toBe('Implement React UI components');
      expect(summary.agentAssignment?.status).toBe('in_progress');
    });

    it('should return undefined assignment if agent has no tasks', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'keaton');
      expect(summary.agentAssignment).toBeUndefined();
    });

    it('should include all constraints', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
      expect(summary.relevantConstraints).toHaveLength(1);
      expect(summary.relevantConstraints[0]).toBe('Keep files under 200 lines');
    });

    it('should include all acceptance criteria', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
      expect(summary.relevantAcceptanceCriteria).toHaveLength(1);
      expect(summary.relevantAcceptanceCriteria[0]).toBe('All existing tests must pass');
    });

    it('should describe context in pipeline', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
      expect(summary.contextInPipeline).toContain('depends on');
    });
  });

  describe('toMarkdown', () => {
    it('should render complete markdown summary', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
      const markdown = IntentSummarizer.toMarkdown(summary);

      expect(markdown).toContain('# Intent Context');
      expect(markdown).toContain('**Overall Goal:** Migrate Products blade to React');
      expect(markdown).toContain('## Your Assignment');
      expect(markdown).toContain('**Task:** Implement React UI components');
      expect(markdown).toContain('## Constraints');
      expect(markdown).toContain('- Keep files under 200 lines');
      expect(markdown).toContain('## Acceptance Criteria');
      expect(markdown).toContain('- All existing tests must pass');
    });

    it('should handle agent with no assignment', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'keaton');
      const markdown = IntentSummarizer.toMarkdown(summary);

      expect(markdown).toContain('# Intent Context');
      expect(markdown).not.toContain('## Your Assignment');
    });

    it('should handle empty constraints and criteria', () => {
      const emptyGraph = new IntentGraph();
      emptyGraph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Test goal',
        status: 'pending',
      });
      emptyGraph.setRootGoal('goal-1');

      const summary = IntentSummarizer.summarizeForAgent(emptyGraph, 'test-agent');
      const markdown = IntentSummarizer.toMarkdown(summary);

      expect(markdown).toContain('# Intent Context');
      expect(markdown).not.toContain('## Constraints');
      expect(markdown).not.toContain('## Acceptance Criteria');
    });
  });

  describe('context building', () => {
    it('should show what task depends on', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
      expect(summary.contextInPipeline).toContain('Create data layer hooks');
    });

    it('should show what task enables', () => {
      const summary = IntentSummarizer.summarizeForAgent(graph, 'mcmanus');
      expect(summary.contextInPipeline).toContain('enables');
      expect(summary.contextInPipeline).toContain('Implement React UI components');
    });

    it('should indicate independent tasks', () => {
      graph.addNode({
        id: 'task-standalone',
        type: 'task',
        description: 'Independent work',
        status: 'pending',
        assignedTo: 'standalone',
      });

      const summary = IntentSummarizer.summarizeForAgent(graph, 'standalone');
      expect(summary.contextInPipeline).toContain('independent');
    });
  });
});
