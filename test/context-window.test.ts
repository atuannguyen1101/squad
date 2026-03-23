/**
 * Tests for Context Windowing — auto-summarization of old session messages.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  applyContextWindow,
  extractiveSummarize,
  createContextWindowState,
  DEFAULT_CONTEXT_WINDOW_CONFIG,
} from '../packages/squad-sdk/src/context/context-window.js';
import type {
  ContextWindowConfig,
  ContextWindowState,
  WindowResult,
} from '../packages/squad-sdk/src/context/context-window.js';
import type { SessionMessage } from '../packages/squad-sdk/src/server/agent-lifecycle.js';

// ============================================================================
// Helpers
// ============================================================================

function makeMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  index = 0,
): SessionMessage {
  return {
    role,
    content,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
  };
}

function makeMessages(count: number): SessionMessage[] {
  const msgs: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    msgs.push(makeMessage(role as 'user' | 'assistant', `Message ${i}: ${role === 'user' ? 'Can you help?' : 'Sure, here is the answer.'}`, i));
  }
  return msgs;
}

// ============================================================================
// Tests
// ============================================================================

describe('Context Windowing', () => {
  describe('createContextWindowState', () => {
    it('should create a fresh state with zero counters', () => {
      const state = createContextWindowState();
      expect(state.summarizationCount).toBe(0);
      expect(state.summary).toBe('');
      expect(state.summarizedUpTo).toBeNull();
      expect(state.totalSummarizedMessages).toBe(0);
    });
  });

  describe('DEFAULT_CONTEXT_WINDOW_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_CONTEXT_WINDOW_CONFIG.maxMessages).toBe(50);
      expect(DEFAULT_CONTEXT_WINDOW_CONFIG.keepRecent).toBe(10);
      expect(DEFAULT_CONTEXT_WINDOW_CONFIG.maxSummaryLength).toBe(2000);
    });
  });

  describe('extractiveSummarize', () => {
    it('should return empty string for empty messages', () => {
      expect(extractiveSummarize([], 2000)).toBe('');
    });

    it('should include message count and time range', () => {
      const msgs = makeMessages(5);
      const summary = extractiveSummarize(msgs, 2000);

      expect(summary).toContain('5 messages');
      expect(summary).toContain('Exchanges:');
    });

    it('should extract decisions from message content', () => {
      const msgs: SessionMessage[] = [
        makeMessage('user', 'We decided to use PostgreSQL for the database.', 0),
        makeMessage('assistant', 'Good decision. I will proceed with that.', 1),
      ];
      const summary = extractiveSummarize(msgs, 2000);

      expect(summary).toContain('Decisions:');
      expect(summary).toContain('PostgreSQL');
    });

    it('should extract errors from message content', () => {
      const msgs: SessionMessage[] = [
        makeMessage('assistant', 'Error: The build failed with exit code 1.', 0),
      ];
      const summary = extractiveSummarize(msgs, 2000);

      expect(summary).toContain('Errors:');
      expect(summary).toContain('build failed');
    });

    it('should extract artifact references', () => {
      const msgs: SessionMessage[] = [
        makeMessage('assistant', 'I created the new API controller at src/api.ts', 0),
      ];
      const summary = extractiveSummarize(msgs, 2000);

      expect(summary).toContain('Artifacts:');
      expect(summary).toContain('API controller');
    });

    it('should respect maxLength and truncate', () => {
      const msgs = makeMessages(20);
      const summary = extractiveSummarize(msgs, 100);

      expect(summary.length).toBeLessThanOrEqual(100);
      expect(summary).toContain('...');
    });

    it('should skip very short and very long lines', () => {
      const msgs: SessionMessage[] = [
        makeMessage('user', 'ok', 0), // Too short (< 10 chars)
        makeMessage('assistant', 'A'.repeat(600), 1), // Too long (> 500 chars)
        makeMessage('user', 'We decided to use TypeScript for the project.', 2),
      ];
      const summary = extractiveSummarize(msgs, 2000);

      // Should still include the valid decision line
      expect(summary).toContain('TypeScript');
    });
  });

  describe('applyContextWindow', () => {
    it('should not trigger when below threshold', async () => {
      const msgs = makeMessages(10);
      const state = createContextWindowState();
      const result = await applyContextWindow(msgs, state, { maxMessages: 50 });

      expect(result.summarized).toBe(false);
      expect(result.messages).toHaveLength(10);
      expect(result.compressedCount).toBe(0);
      expect(result.state.summarizationCount).toBe(0);
    });

    it('should trigger when exceeding threshold', async () => {
      const msgs = makeMessages(60);
      const state = createContextWindowState();
      const result = await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
      });

      expect(result.summarized).toBe(true);
      // Should have: 1 summary message + 10 recent = 11
      expect(result.messages).toHaveLength(11);
      expect(result.compressedCount).toBe(50);
      expect(result.state.summarizationCount).toBe(1);
      expect(result.state.totalSummarizedMessages).toBe(50);
    });

    it('should keep the most recent messages verbatim', async () => {
      const msgs = makeMessages(60);
      const state = createContextWindowState();
      const result = await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
      });

      // The last 10 messages should be preserved exactly
      const keptMessages = result.messages.slice(1); // Skip summary
      for (let i = 0; i < 10; i++) {
        expect(keptMessages[i]!.content).toBe(msgs[50 + i]!.content);
      }
    });

    it('should prepend a system summary message', async () => {
      const msgs = makeMessages(60);
      const state = createContextWindowState();
      const result = await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
      });

      const summaryMsg = result.messages[0]!;
      expect(summaryMsg.role).toBe('system');
      expect(summaryMsg.content).toContain('Context Summary');
      expect(summaryMsg.content).toContain('1 pass');
      expect(summaryMsg.content).toContain('50 messages compressed');
    });

    it('should accumulate state across multiple passes', async () => {
      // First pass
      const msgs1 = makeMessages(60);
      const state1 = createContextWindowState();
      const result1 = await applyContextWindow(msgs1, state1, {
        maxMessages: 50,
        keepRecent: 10,
      });

      expect(result1.state.summarizationCount).toBe(1);
      expect(result1.state.totalSummarizedMessages).toBe(50);

      // Add more messages and trigger a second pass
      const extraMessages = makeMessages(50).map((m, i) =>
        makeMessage(m.role, `Extra ${i}: ${m.content}`, 100 + i),
      );
      const msgs2 = [...result1.messages, ...extraMessages];

      const result2 = await applyContextWindow(msgs2, result1.state, {
        maxMessages: 50,
        keepRecent: 10,
      });

      expect(result2.summarized).toBe(true);
      expect(result2.state.summarizationCount).toBe(2);
      expect(result2.state.totalSummarizedMessages).toBeGreaterThan(50);
    });

    it('should use custom summarizer when provided', async () => {
      const msgs = makeMessages(60);
      const state = createContextWindowState();
      const customSummarizer = vi.fn().mockResolvedValue('Custom LLM summary of the conversation.');

      const result = await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
        summarizer: customSummarizer,
      });

      expect(customSummarizer).toHaveBeenCalledTimes(1);
      expect(customSummarizer).toHaveBeenCalledWith(msgs.slice(0, 50));
      expect(result.messages[0]!.content).toContain('Custom LLM summary');
    });

    it('should fallback to extractive if custom summarizer throws', async () => {
      const msgs = makeMessages(60);
      const state = createContextWindowState();
      const failingSummarizer = vi.fn().mockRejectedValue(new Error('LLM timeout'));

      const result = await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
        summarizer: failingSummarizer,
      });

      expect(failingSummarizer).toHaveBeenCalledTimes(1);
      expect(result.summarized).toBe(true);
      // Should still have produced a summary from the extractive fallback
      expect(result.messages[0]!.content).toContain('Context Summary');
    });

    it('should not mutate the original messages array', async () => {
      const msgs = makeMessages(60);
      const originalLength = msgs.length;
      const state = createContextWindowState();

      await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
      });

      expect(msgs).toHaveLength(originalLength);
    });

    it('should handle exact threshold without triggering', async () => {
      const msgs = makeMessages(50);
      const state = createContextWindowState();
      const result = await applyContextWindow(msgs, state, { maxMessages: 50 });

      expect(result.summarized).toBe(false);
      expect(result.messages).toHaveLength(50);
    });

    it('should clamp keepRecent if >= maxMessages', async () => {
      const msgs = makeMessages(20);
      const state = createContextWindowState();
      // keepRecent 100 > maxMessages 15 — should be clamped
      const result = await applyContextWindow(msgs, state, {
        maxMessages: 15,
        keepRecent: 100,
      });

      expect(result.summarized).toBe(true);
      // keepRecent clamped to floor(15/2) = 7, so 20 - 7 = 13 compressed
      expect(result.compressedCount).toBe(13);
    });

    it('should update summarizedUpTo cursor', async () => {
      const msgs = makeMessages(60);
      const state = createContextWindowState();
      const result = await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
      });

      expect(result.state.summarizedUpTo).toBeTruthy();
      // The cursor should be the timestamp of message 49 (0-indexed)
      expect(result.state.summarizedUpTo).toBe(msgs[49]!.timestamp);
    });

    it('should enforce maxSummaryLength on the summary', async () => {
      const msgs = makeMessages(60);
      const state = createContextWindowState();
      const verboseSummarizer = vi.fn().mockResolvedValue('x'.repeat(5000));

      const result = await applyContextWindow(msgs, state, {
        maxMessages: 50,
        keepRecent: 10,
        maxSummaryLength: 100,
        summarizer: verboseSummarizer,
      });

      // The summary content should be truncated
      const summaryContent = result.state.summary;
      expect(summaryContent.length).toBeLessThanOrEqual(100);
      expect(summaryContent).toContain('...');
    });
  });
});
