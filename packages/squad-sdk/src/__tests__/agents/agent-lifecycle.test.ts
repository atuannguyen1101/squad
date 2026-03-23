/**
 * Tests for agent-lifecycle (system prompt building)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSystemPrompt, createSystemPromptWithConfig } from '../../agents/agent-lifecycle.js';
import { IntentGraph } from '../../intent/IntentGraph.js';

describe('agent-lifecycle', () => {
  describe('buildSystemPrompt', () => {
    it('should build basic prompt with name and role', () => {
      const prompt = buildSystemPrompt({
        agentName: 'fenster',
        role: 'UI Developer',
      });

      expect(prompt).toContain('# fenster — UI Developer');
    });

    it('should include charter if provided', () => {
      const prompt = buildSystemPrompt({
        agentName: 'fenster',
        role: 'UI Developer',
        charter: 'You are responsible for React components.',
      });

      expect(prompt).toContain('## Charter');
      expect(prompt).toContain('You are responsible for React components.');
    });

    it('should include history if provided', () => {
      const prompt = buildSystemPrompt({
        agentName: 'fenster',
        role: 'UI Developer',
        history: ['Previous task: Implemented login form', 'Recent: Fixed validation bug'],
      });

      expect(prompt).toContain('## Recent Context');
      expect(prompt).toContain('Previous task: Implemented login form');
      expect(prompt).toContain('Recent: Fixed validation bug');
    });

    it('should not include intent context by default', () => {
      const graph = new IntentGraph();
      graph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Test goal',
        status: 'pending',
      });

      const prompt = buildSystemPrompt({
        agentName: 'fenster',
        role: 'UI Developer',
        intentGraph: graph,
      });

      expect(prompt).not.toContain('Intent Context');
    });

    it('should include intent context when enabled', () => {
      const graph = new IntentGraph();
      graph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Migrate to React',
        status: 'pending',
      });
      graph.addNode({
        id: 'task-1',
        type: 'task',
        description: 'Build UI components',
        status: 'in_progress',
        assignedTo: 'fenster',
      });
      graph.setRootGoal('goal-1');

      const prompt = buildSystemPrompt({
        agentName: 'fenster',
        role: 'UI Developer',
        intentGraph: graph,
        includeIntentContext: true,
      });

      expect(prompt).toContain('# Intent Context');
      expect(prompt).toContain('**Overall Goal:** Migrate to React');
      expect(prompt).toContain('## Your Assignment');
      expect(prompt).toContain('Build UI components');
    });

    it('should build complete prompt with all sections', () => {
      const graph = new IntentGraph();
      graph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Migrate Products',
        status: 'in_progress',
      });
      graph.addNode({
        id: 'constraint-1',
        type: 'constraint',
        description: 'Keep files under 200 lines',
        status: 'pending',
      });
      graph.addNode({
        id: 'task-1',
        type: 'task',
        description: 'Implement ReactView',
        status: 'in_progress',
        assignedTo: 'fenster',
      });
      graph.setRootGoal('goal-1');

      const prompt = buildSystemPrompt({
        agentName: 'fenster',
        role: 'UI Developer',
        charter: 'Expert in React and Fluent UI',
        history: ['Completed Users migration'],
        intentGraph: graph,
        includeIntentContext: true,
      });

      expect(prompt).toContain('# fenster — UI Developer');
      expect(prompt).toContain('## Charter');
      expect(prompt).toContain('Expert in React and Fluent UI');
      expect(prompt).toContain('# Intent Context');
      expect(prompt).toContain('Migrate Products');
      expect(prompt).toContain('## Constraints');
      expect(prompt).toContain('Keep files under 200 lines');
      expect(prompt).toContain('## Recent Context');
      expect(prompt).toContain('Completed Users migration');
    });
  });

  describe('createSystemPromptWithConfig', () => {
    it('should respect config flag for intent context', () => {
      const graph = new IntentGraph();
      graph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Test goal',
        status: 'pending',
      });

      const promptWithIntent = createSystemPromptWithConfig(
        {
          agentName: 'fenster',
          role: 'UI Developer',
          intentGraph: graph,
        },
        { includeIntentContext: true }
      );

      expect(promptWithIntent).toContain('Intent Context');

      const promptWithoutIntent = createSystemPromptWithConfig(
        {
          agentName: 'fenster',
          role: 'UI Developer',
          intentGraph: graph,
        },
        { includeIntentContext: false }
      );

      expect(promptWithoutIntent).not.toContain('Intent Context');
    });

    it('should default to false when config flag is undefined', () => {
      const graph = new IntentGraph();
      graph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Test goal',
        status: 'pending',
      });

      const prompt = createSystemPromptWithConfig(
        {
          agentName: 'fenster',
          role: 'UI Developer',
          intentGraph: graph,
        },
        {}
      );

      expect(prompt).not.toContain('Intent Context');
    });
  });
});
