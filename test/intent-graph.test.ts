/**
 * Tests for Intent Graph — structured user intent representation
 */
import { describe, it, expect } from 'vitest';
import {
  createEmptyIntentGraph,
  serializeIntentGraph,
  deserializeIntentGraph,
  updateIntentGraph,
} from '../packages/squad-sdk/src/intent/intent-graph.js';
import type { IntentGraph } from '../packages/squad-sdk/src/intent/intent-graph.js';

describe('IntentGraph', () => {
  describe('createEmptyIntentGraph', () => {
    it('should create a graph with the given goal', () => {
      const graph = createEmptyIntentGraph('Build a REST API');

      expect(graph.goal).toBe('Build a REST API');
      expect(graph.constraints).toEqual([]);
      expect(graph.preferences).toEqual([]);
      expect(graph.acceptanceCriteria).toEqual([]);
      expect(graph.openQuestions).toEqual([]);
      expect(graph.currentStatus).toBe('clarifying');
      expect(graph.tasks).toEqual([]);
      expect(graph.metadata.version).toBe(1);
      expect(graph.metadata.clarificationRounds).toBe(0);
    });
  });

  describe('serializeIntentGraph / deserializeIntentGraph', () => {
    it('should round-trip a graph through JSON', () => {
      const original = createEmptyIntentGraph('Test roundtrip');
      original.constraints = ['Must use TypeScript'];
      original.tasks = [{ id: 't1', description: 'Write code', status: 'pending' }];

      const json = serializeIntentGraph(original);
      const restored = deserializeIntentGraph(json);

      expect(restored.goal).toBe('Test roundtrip');
      expect(restored.constraints).toEqual(['Must use TypeScript']);
      expect(restored.tasks).toHaveLength(1);
      expect(restored.tasks[0].id).toBe('t1');
    });

    it('should throw on invalid JSON', () => {
      expect(() => deserializeIntentGraph('{}')).toThrow('Invalid IntentGraph');
    });

    it('should throw on malformed input', () => {
      expect(() => deserializeIntentGraph('not json')).toThrow();
    });
  });

  describe('updateIntentGraph', () => {
    it('should update goal and increment version', () => {
      const original = createEmptyIntentGraph('Original goal');
      const updated = updateIntentGraph(original, { goal: 'Revised goal' });

      expect(updated.goal).toBe('Revised goal');
      expect(updated.metadata.version).toBe(2);
    });

    it('should union array fields without duplicates', () => {
      const original = createEmptyIntentGraph('test');
      original.constraints = ['TypeScript', 'Node 20+'];

      const updated = updateIntentGraph(original, {
        constraints: ['Node 20+', 'No external deps'],
      });

      expect(updated.constraints).toContain('TypeScript');
      expect(updated.constraints).toContain('Node 20+');
      expect(updated.constraints).toContain('No external deps');
      expect(updated.constraints).toHaveLength(3);
    });

    it('should replace openQuestions entirely (not union)', () => {
      const original = createEmptyIntentGraph('test');
      original.openQuestions = ['Old question?'];

      const updated = updateIntentGraph(original, {
        openQuestions: ['New question?'],
      });

      expect(updated.openQuestions).toEqual(['New question?']);
    });

    it('should update status', () => {
      const original = createEmptyIntentGraph('test');
      const updated = updateIntentGraph(original, { currentStatus: 'ready' });

      expect(updated.currentStatus).toBe('ready');
    });

    it('should preserve fields not in updates', () => {
      const original = createEmptyIntentGraph('test');
      original.preferences = ['Use Vitest'];
      const updated = updateIntentGraph(original, { goal: 'new goal' });

      expect(updated.preferences).toEqual(['Use Vitest']);
    });
  });
});
