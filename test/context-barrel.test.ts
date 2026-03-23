/**
 * Tests for context barrel exports (index.ts).
 *
 * Verifies that all required symbols are re-exported through the barrel:
 *   - ContextWindowConfig (type)
 *   - ContextWindowState (type)
 *   - WindowResult (type)
 *   - DEFAULT_CONTEXT_WINDOW_CONFIG (const)
 *   - createContextWindowState (function)
 *   - applyContextWindow (function)
 *   - extractiveSummarize (function)
 */
import { describe, it, expect } from 'vitest';
import {
  applyContextWindow,
  extractiveSummarize,
  createContextWindowState,
  DEFAULT_CONTEXT_WINDOW_CONFIG,
} from '../packages/squad-sdk/src/context/index.js';
import type {
  ContextWindowConfig,
  ContextWindowState,
  WindowResult,
} from '../packages/squad-sdk/src/context/index.js';
import type { SessionMessage } from '../packages/squad-sdk/src/server/agent-lifecycle.js';

describe('Context barrel exports', () => {
  it('exports DEFAULT_CONTEXT_WINDOW_CONFIG with expected shape', () => {
    expect(DEFAULT_CONTEXT_WINDOW_CONFIG).toBeDefined();
    expect(typeof DEFAULT_CONTEXT_WINDOW_CONFIG.maxMessages).toBe('number');
    expect(typeof DEFAULT_CONTEXT_WINDOW_CONFIG.keepRecent).toBe('number');
    expect(typeof DEFAULT_CONTEXT_WINDOW_CONFIG.maxSummaryLength).toBe('number');
  });

  it('exports createContextWindowState as a function', () => {
    expect(createContextWindowState).toBeDefined();
    expect(typeof createContextWindowState).toBe('function');
  });

  it('exports applyContextWindow as a function', () => {
    expect(applyContextWindow).toBeDefined();
    expect(typeof applyContextWindow).toBe('function');
  });

  it('exports extractiveSummarize as a function', () => {
    expect(extractiveSummarize).toBeDefined();
    expect(typeof extractiveSummarize).toBe('function');
  });

  it('type ContextWindowConfig is usable from barrel', () => {
    const config: ContextWindowConfig = {
      maxMessages: 100,
      keepRecent: 20,
      maxSummaryLength: 3000,
    };
    expect(config.maxMessages).toBe(100);
    expect(config.keepRecent).toBe(20);
    expect(config.maxSummaryLength).toBe(3000);
  });

  it('type ContextWindowState is usable from barrel', () => {
    const state: ContextWindowState = createContextWindowState();
    expect(state.summarizationCount).toBe(0);
    expect(state.summary).toBe('');
    expect(state.summarizedUpTo).toBeNull();
    expect(state.totalSummarizedMessages).toBe(0);
  });

  it('type WindowResult is usable from barrel', async () => {
    const msgs: SessionMessage[] = [
      { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
    ];
    const state = createContextWindowState();
    const result: WindowResult = await applyContextWindow(msgs, state);

    expect(result.messages).toBeDefined();
    expect(typeof result.summarized).toBe('boolean');
    expect(typeof result.compressedCount).toBe('number');
    expect(result.state).toBeDefined();
  });

  it('all runtime exports match the direct module exports', async () => {
    const barrel = await import('../packages/squad-sdk/src/context/index.js');
    const direct = await import('../packages/squad-sdk/src/context/context-window.js');

    // Runtime exports (functions + const)
    expect(barrel.applyContextWindow).toBe(direct.applyContextWindow);
    expect(barrel.extractiveSummarize).toBe(direct.extractiveSummarize);
    expect(barrel.createContextWindowState).toBe(direct.createContextWindowState);
    expect(barrel.DEFAULT_CONTEXT_WINDOW_CONFIG).toBe(direct.DEFAULT_CONTEXT_WINDOW_CONFIG);
  });
});
