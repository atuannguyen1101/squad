/**
 * Tests for RunContext and RunContextManager
 * 
 * Multi-run isolation requires:
 * - Each run has isolated state (pulseCollector, intentGraph, questions, waitResolvers)
 * - Session keys use agentName::runId format
 * - RunContextManager provides create/get/complete/cancel/delete lifecycle
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RunContextManager } from '../packages/squad-sdk/src/mcp/run-context.js';
import { createEmptyIntentGraph } from '../packages/squad-sdk/src/intent/index.js';

describe('RunContext', () => {
  let manager: RunContextManager;

  beforeEach(() => {
    manager = new RunContextManager();
  });

  it('creates a new run context with unique runId', () => {
    const context1 = manager.create('run-1', 'First task');
    const context2 = manager.create('run-2', 'Second task');

    expect(context1.runId).toBe('run-1');
    expect(context2.runId).toBe('run-2');
    expect(context1.status).toBe('active');
    expect(context2.status).toBe('active');
  });

  it('creates isolated pulse collectors per run', () => {
    const context1 = manager.create('run-1', 'Task 1');
    const context2 = manager.create('run-2', 'Task 2');

    // Each run should have its own pulse collector
    expect(context1.pulseCollector).toBeDefined();
    expect(context2.pulseCollector).toBeDefined();
    expect(context1.pulseCollector).not.toBe(context2.pulseCollector);
  });

  it('creates isolated intent graphs per run', () => {
    const context1 = manager.create('run-1', 'Build feature X');
    const context2 = manager.create('run-2', 'Fix bug Y');

    expect(context1.intentGraph.goal).toBe('Build feature X');
    expect(context2.intentGraph.goal).toBe('Fix bug Y');
  });

  it('retrieves run context by ID', () => {
    manager.create('run-123', 'Test task');
    
    const context = manager.get('run-123');
    expect(context).toBeDefined();
    expect(context?.runId).toBe('run-123');
  });

  it('returns undefined for non-existent run', () => {
    const context = manager.get('non-existent');
    expect(context).toBeUndefined();
  });

  it('getMostRecent returns the most recently active run', async () => {
    manager.create('run-1', 'First');
    await new Promise(resolve => setTimeout(resolve, 10));
    manager.create('run-2', 'Second');
    await new Promise(resolve => setTimeout(resolve, 10));
    manager.create('run-3', 'Third');

    const mostRecent = manager.getMostRecent();
    expect(mostRecent?.runId).toBe('run-3');
  });

  it('getMostRecent returns undefined when no runs exist', () => {
    const mostRecent = manager.getMostRecent();
    expect(mostRecent).toBeUndefined();
  });

  it('completes a run and changes status', () => {
    const context = manager.create('run-1', 'Task');
    expect(context.status).toBe('active');

    manager.complete('run-1');
    
    const retrieved = manager.get('run-1');
    expect(retrieved?.status).toBe('completed');
  });

  it('cancels a run and changes status', () => {
    const context = manager.create('run-1', 'Task');
    expect(context.status).toBe('active');

    manager.cancel('run-1');
    
    const retrieved = manager.get('run-1');
    expect(retrieved?.status).toBe('cancelled');
  });

  it('deletes a run context', () => {
    manager.create('run-1', 'Task');
    expect(manager.get('run-1')).toBeDefined();

    manager.delete('run-1');
    expect(manager.get('run-1')).toBeUndefined();
  });

  it('touch updates lastActivityAt timestamp', async () => {
    const context = manager.create('run-1', 'Task');
    const originalTime = context.lastActivityAt.getTime();

    // Wait a bit to ensure timestamp changes
    await new Promise(resolve => setTimeout(resolve, 10));
    
    manager.touch('run-1');
    const updated = manager.get('run-1');
    
    expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(originalTime);
  });

  it('getActiveCount returns number of active runs', () => {
    expect(manager.getActiveCount()).toBe(0);

    manager.create('run-1', 'Task 1');
    expect(manager.getActiveCount()).toBe(1);

    manager.create('run-2', 'Task 2');
    expect(manager.getActiveCount()).toBe(2);

    manager.complete('run-1');
    expect(manager.getActiveCount()).toBe(1);

    manager.cancel('run-2');
    expect(manager.getActiveCount()).toBe(0);
  });

  it('getAll returns all run contexts', () => {
    manager.create('run-1', 'Task 1');
    manager.create('run-2', 'Task 2');
    manager.create('run-3', 'Task 3');

    const all = manager.getAll();
    expect(all.length).toBe(3);
    expect(all.map(c => c.runId).sort()).toEqual(['run-1', 'run-2', 'run-3']);
  });

  it('maintains separate activePipelines per run', () => {
    const context1 = manager.create('run-1', 'Task 1');
    const context2 = manager.create('run-2', 'Task 2');

    expect(context1.activePipelines).toEqual([]);
    expect(context2.activePipelines).toEqual([]);
    expect(context1.activePipelines).not.toBe(context2.activePipelines);
  });

  it('maintains separate pendingUserQuestions per run', () => {
    const context1 = manager.create('run-1', 'Task 1');
    const context2 = manager.create('run-2', 'Task 2');

    context1.pendingUserQuestions.push({
      id: 'q1',
      question: 'Question for run 1',
      agent: 'fenster',
      askedAt: new Date(),
    });

    context2.pendingUserQuestions.push({
      id: 'q2',
      question: 'Question for run 2',
      agent: 'kobayashi',
      askedAt: new Date(),
    });

    expect(context1.pendingUserQuestions.length).toBe(1);
    expect(context2.pendingUserQuestions.length).toBe(1);
    expect(context1.pendingUserQuestions[0].question).toBe('Question for run 1');
    expect(context2.pendingUserQuestions[0].question).toBe('Question for run 2');
  });

  it('maintains separate waitResolvers per run', () => {
    const context1 = manager.create('run-1', 'Task 1');
    const context2 = manager.create('run-2', 'Task 2');

    const resolver1 = (result: string) => {};
    const resolver2 = (result: string) => {};

    context1.waitResolvers.push(resolver1);
    context2.waitResolvers.push(resolver2);

    expect(context1.waitResolvers.length).toBe(1);
    expect(context2.waitResolvers.length).toBe(1);
    expect(context1.waitResolvers[0]).toBe(resolver1);
    expect(context2.waitResolvers[0]).toBe(resolver2);
  });

  it('handles concurrent run creation correctly', () => {
    const runs = Array.from({ length: 5 }, (_, i) => 
      manager.create(`run-${i}`, `Task ${i}`)
    );

    expect(manager.getActiveCount()).toBe(5);
    
    // Each run should have unique ID and isolated state
    const runIds = runs.map(r => r.runId);
    const uniqueIds = new Set(runIds);
    expect(uniqueIds.size).toBe(5);
  });
});
