/**
 * Tests for Intent Graph pipeline wiring — parse phase outputs and
 * verify updateIntentGraph is called correctly at milestones.
 */
import { describe, it, expect } from 'vitest';
import {
  createEmptyIntentGraph,
  updateIntentGraph,
  serializeIntentGraph,
} from '../packages/squad-sdk/src/intent/intent-graph.js';
import {
  parseUnderstandPhaseOutput,
  parseRoutePhaseOutput,
} from '../packages/squad-sdk/src/intent/parse-phase-output.js';
import type { IntentGraph } from '../packages/squad-sdk/src/intent/intent-graph.js';

// ---------------------------------------------------------------------------
// parseUnderstandPhaseOutput
// ---------------------------------------------------------------------------
describe('parseUnderstandPhaseOutput', () => {
  it('should extract constraints from a markdown section', () => {
    const text = [
      '## Understanding',
      'The user wants to build a REST API with authentication.',
      '',
      '## Constraints',
      '- Must use TypeScript',
      '- No external dependencies',
      '',
      '## Acceptance Criteria',
      '- All tests pass',
      '- Build succeeds',
    ].join('\n');

    const result = parseUnderstandPhaseOutput(text);

    expect(result.constraints).toEqual(['Must use TypeScript', 'No external dependencies']);
    expect(result.acceptanceCriteria).toEqual(['All tests pass', 'Build succeeds']);
    expect(result.currentStatus).toBe('ready');
  });

  it('should extract goal from first substantive paragraph', () => {
    const text = [
      '## Summary',
      'The user wants to implement a new feature that adds caching to the data layer.',
      '',
      '## Constraints',
      '- Keep it simple',
    ].join('\n');

    const result = parseUnderstandPhaseOutput(text);

    expect(result.goal).toBe(
      'The user wants to implement a new feature that adds caching to the data layer.',
    );
  });

  it('should return ready status even with minimal text', () => {
    const result = parseUnderstandPhaseOutput('Short note.');
    expect(result.currentStatus).toBe('ready');
  });

  it('should handle text with no structured sections', () => {
    const text = 'The user just wants a quick fix to the login page styling.';
    const result = parseUnderstandPhaseOutput(text);

    expect(result.goal).toBe(text);
    expect(result.constraints).toBeUndefined();
    expect(result.acceptanceCriteria).toBeUndefined();
    expect(result.currentStatus).toBe('ready');
  });

  it('should handle numbered list items as bullets', () => {
    const text = [
      '## Constraints',
      '1. Must use ESM',
      '2. Node 20+',
    ].join('\n');

    const result = parseUnderstandPhaseOutput(text);
    expect(result.constraints).toEqual(['Must use ESM', 'Node 20+']);
  });

  it('should stop collecting when a new heading appears', () => {
    const text = [
      '## Constraints',
      '- TypeScript only',
      '## Notes',
      '- This is a note, not a constraint',
    ].join('\n');

    const result = parseUnderstandPhaseOutput(text);
    expect(result.constraints).toEqual(['TypeScript only']);
  });
});

// ---------------------------------------------------------------------------
// parseRoutePhaseOutput
// ---------------------------------------------------------------------------
describe('parseRoutePhaseOutput', () => {
  it('should extract implementer and reviewer tasks from JSON', () => {
    const text = '{"implementer": "fenster", "reviewer": "hockney", "architect": null}';
    const result = parseRoutePhaseOutput(text);

    expect(result.tasks).toHaveLength(2);
    expect(result.currentStatus).toBe('in-progress');

    const impl = result.tasks.find(t => t.id === 'implement');
    expect(impl).toBeDefined();
    expect(impl!.assignedAgent).toBe('fenster');
    expect(impl!.status).toBe('pending');

    const review = result.tasks.find(t => t.id === 'review');
    expect(review).toBeDefined();
    expect(review!.assignedAgent).toBe('hockney');
    expect(review!.dependencies).toEqual(['implement']);
  });

  it('should include architect task when provided', () => {
    const text = '{"implementer": "fenster", "reviewer": "hockney", "architect": "strausz"}';
    const result = parseRoutePhaseOutput(text);

    expect(result.tasks).toHaveLength(3);
    const arch = result.tasks.find(t => t.id === 'architect');
    expect(arch).toBeDefined();
    expect(arch!.assignedAgent).toBe('strausz');
  });

  it('should handle JSON embedded in prose', () => {
    const text = 'Based on the roster, I recommend:\n{"implementer": "fenster", "reviewer": "hockney", "architect": null}\nEnd.';
    const result = parseRoutePhaseOutput(text);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.assignedAgent).toBe('fenster');
  });

  it('should return empty tasks for invalid JSON', () => {
    const result = parseRoutePhaseOutput('not json at all');
    expect(result.tasks).toEqual([]);
    expect(result.currentStatus).toBe('in-progress');
  });

  it('should return empty tasks for JSON without expected fields', () => {
    const result = parseRoutePhaseOutput('{"foo": "bar"}');
    expect(result.tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: updateIntentGraph with parsed phase outputs
// ---------------------------------------------------------------------------
describe('Intent graph pipeline integration', () => {
  it('should update graph after understand phase', () => {
    const graph = createEmptyIntentGraph('Build a REST API');
    const benOutput = [
      '## Understanding',
      'The user wants to build a REST API with JWT authentication.',
      '',
      '## Constraints',
      '- Must use TypeScript',
      '- ESM only',
      '',
      '## Acceptance Criteria',
      '- All endpoints return JSON',
      '- Tests pass',
    ].join('\n');

    const updates = parseUnderstandPhaseOutput(benOutput);
    const updated = updateIntentGraph(graph, updates);

    expect(updated.goal).toBe(
      'The user wants to build a REST API with JWT authentication.',
    );
    expect(updated.constraints).toContain('Must use TypeScript');
    expect(updated.constraints).toContain('ESM only');
    expect(updated.acceptanceCriteria).toContain('All endpoints return JSON');
    expect(updated.acceptanceCriteria).toContain('Tests pass');
    expect(updated.currentStatus).toBe('ready');
    expect(updated.metadata.version).toBe(2);
  });

  it('should update graph after route phase', () => {
    const graph = createEmptyIntentGraph('Build a REST API');
    const readyGraph = updateIntentGraph(graph, { currentStatus: 'ready' });

    const coordOutput = '{"implementer": "fenster", "reviewer": "hockney", "architect": null}';
    const routeUpdates = parseRoutePhaseOutput(coordOutput);
    const routed = updateIntentGraph(readyGraph, routeUpdates);

    expect(routed.currentStatus).toBe('in-progress');
    expect(routed.tasks).toHaveLength(2);
    expect(routed.tasks[0]!.assignedAgent).toBe('fenster');
    expect(routed.tasks[1]!.assignedAgent).toBe('hockney');
    expect(routed.metadata.version).toBe(3);
  });

  it('should preserve constraints through route update', () => {
    let graph = createEmptyIntentGraph('Fix login');
    graph = updateIntentGraph(graph, {
      constraints: ['TypeScript', 'No deps'],
      currentStatus: 'ready',
    });
    graph = updateIntentGraph(graph, parseRoutePhaseOutput(
      '{"implementer": "fenster", "reviewer": "hockney", "architect": null}',
    ));

    expect(graph.constraints).toContain('TypeScript');
    expect(graph.constraints).toContain('No deps');
    expect(graph.tasks).toHaveLength(2);
    expect(graph.currentStatus).toBe('in-progress');
  });

  it('should produce valid serialized output after full pipeline', () => {
    let graph = createEmptyIntentGraph('Add caching');

    // After understand
    graph = updateIntentGraph(graph, parseUnderstandPhaseOutput(
      '## Understanding\nAdd Redis caching to the data layer.\n\n## Constraints\n- Use ioredis\n\n## Acceptance Criteria\n- Cache hit rate logged',
    ));

    // After route
    graph = updateIntentGraph(graph, parseRoutePhaseOutput(
      '{"implementer": "fenster", "reviewer": "hockney", "architect": null}',
    ));

    const json = serializeIntentGraph(graph);
    const parsed = JSON.parse(json) as IntentGraph;

    expect(parsed.goal).toBe('Add Redis caching to the data layer.');
    expect(parsed.constraints).toContain('Use ioredis');
    expect(parsed.acceptanceCriteria).toContain('Cache hit rate logged');
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.currentStatus).toBe('in-progress');
    expect(parsed.metadata.version).toBe(3);
  });
});
