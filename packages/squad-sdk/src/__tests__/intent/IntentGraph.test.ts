/**
 * Tests for IntentGraph
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IntentGraph } from '../../intent/IntentGraph.js';
import { IntentNode } from '../../intent/types.js';

describe('IntentGraph', () => {
  let graph: IntentGraph;

  beforeEach(() => {
    graph = new IntentGraph();
  });

  describe('node operations', () => {
    it('should add and retrieve nodes', () => {
      const node: IntentNode = {
        id: 'task-1',
        type: 'task',
        description: 'Implement feature X',
        status: 'pending',
      };

      graph.addNode(node);
      expect(graph.getNode('task-1')).toEqual(node);
    });

    it('should update existing nodes', () => {
      const node: IntentNode = {
        id: 'task-1',
        type: 'task',
        description: 'Implement feature X',
        status: 'pending',
      };

      graph.addNode(node);
      graph.updateNode('task-1', { status: 'in_progress', assignedTo: 'fenster' });

      const updated = graph.getNode('task-1');
      expect(updated?.status).toBe('in_progress');
      expect(updated?.assignedTo).toBe('fenster');
    });

    it('should filter nodes by type', () => {
      graph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Main goal',
        status: 'pending',
      });
      graph.addNode({
        id: 'task-1',
        type: 'task',
        description: 'Task 1',
        status: 'pending',
      });
      graph.addNode({
        id: 'task-2',
        type: 'task',
        description: 'Task 2',
        status: 'pending',
      });

      const tasks = graph.getNodesByType('task');
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.type === 'task')).toBe(true);
    });

    it('should filter nodes by agent', () => {
      graph.addNode({
        id: 'task-1',
        type: 'task',
        description: 'UI work',
        status: 'pending',
        assignedTo: 'fenster',
      });
      graph.addNode({
        id: 'task-2',
        type: 'task',
        description: 'Data work',
        status: 'pending',
        assignedTo: 'mcmanus',
      });

      const fensterTasks = graph.getNodesByAgent('fenster');
      expect(fensterTasks).toHaveLength(1);
      expect(fensterTasks[0]?.id).toBe('task-1');
    });
  });

  describe('edge operations', () => {
    it('should add and retrieve edges', () => {
      graph.addEdge({ from: 'task-1', to: 'task-2', type: 'depends_on' });

      const outgoing = graph.getEdges('task-1', 'outgoing');
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]?.to).toBe('task-2');

      const incoming = graph.getEdges('task-2', 'incoming');
      expect(incoming).toHaveLength(1);
      expect(incoming[0]?.from).toBe('task-1');
    });

    it('should retrieve edges in both directions', () => {
      graph.addEdge({ from: 'task-1', to: 'task-2', type: 'depends_on' });
      graph.addEdge({ from: 'task-2', to: 'task-3', type: 'enables' });

      const both = graph.getEdges('task-2', 'both');
      expect(both).toHaveLength(2);
    });
  });

  describe('root goal', () => {
    it('should set and retrieve root goal', () => {
      const goal: IntentNode = {
        id: 'goal-1',
        type: 'goal',
        description: 'Migrate to React',
        status: 'in_progress',
      };

      graph.addNode(goal);
      graph.setRootGoal('goal-1');

      const root = graph.getRootGoal();
      expect(root?.id).toBe('goal-1');
    });

    it('should find root goal without explicit setting', () => {
      graph.addNode({
        id: 'goal-1',
        type: 'goal',
        description: 'Main goal',
        status: 'pending',
      });
      graph.addNode({
        id: 'goal-2',
        type: 'goal',
        description: 'Sub-goal',
        status: 'pending',
        parentId: 'goal-1',
      });

      const root = graph.getRootGoal();
      expect(root?.id).toBe('goal-1');
    });
  });

  describe('serialization', () => {
    it('should serialize and deserialize', () => {
      graph.addNode({
        id: 'task-1',
        type: 'task',
        description: 'Test task',
        status: 'pending',
      });
      graph.addEdge({ from: 'task-1', to: 'task-2', type: 'enables' });

      const data = graph.serialize();
      expect(data.nodes).toHaveLength(1);
      expect(data.edges).toHaveLength(1);

      const restored = new IntentGraph(data);
      expect(restored.getNode('task-1')).toBeDefined();
      expect(restored.getEdges('task-1', 'outgoing')).toHaveLength(1);
    });

    it('should track metadata timestamps', () => {
      const data = graph.serialize();
      expect(data.metadata?.created).toBeDefined();
      expect(data.metadata?.updated).toBeDefined();
    });
  });
});
