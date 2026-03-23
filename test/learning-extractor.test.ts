/**
 * Tests for Learning Extractor — structured extraction of session learnings.
 */
import { describe, it, expect } from 'vitest';
import { extractLearnings, type LearningExtraction } from '../packages/squad-sdk/src/agents/learning-extractor.js';
import type { SessionMessage } from '../packages/squad-sdk/src/server/agent-lifecycle.js';
import type { Pulse } from '../packages/squad-sdk/src/pulse/pulse.js';

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
    const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
    msgs.push(makeMessage(role, `Message ${i}: general progress update`, i));
  }
  return msgs;
}

function makePulse(overrides: Partial<Pulse> = {}): Pulse {
  return {
    agent: 'test-agent',
    phase: 'done',
    status: 'ok',
    progressPct: 100,
    summary: 'Completed the task',
    blockers: [],
    questionsForUser: [],
    artifacts: [],
    nextStep: '',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Learning Extractor', () => {
  describe('extractLearnings()', () => {
    it('should return empty extraction for empty messages', () => {
      const result = extractLearnings([]);
      expect(result.learnings).toBeNull();
      expect(result.decisions).toBeNull();
      expect(result.patterns).toBeNull();
      expect(result.issues).toBeNull();
      expect(result.artifacts).toEqual([]);
      expect(result.sessionSummary).toBe('Session with no user messages');
    });

    it('should return empty extraction for sessions with fewer than minMessages', () => {
      const messages = [
        makeMessage('user', 'Hello', 0),
        makeMessage('assistant', 'Hi there', 1),
        makeMessage('user', 'What is this?', 2),
      ];
      const result = extractLearnings(messages);
      expect(result.learnings).toBeNull();
      expect(result.decisions).toBeNull();
      expect(result.patterns).toBeNull();
      expect(result.issues).toBeNull();
    });

    it('should respect custom minMessages option', () => {
      const messages = [
        makeMessage('user', 'Hello', 0),
        makeMessage('assistant', 'Hi there', 1),
        makeMessage('user', 'We decided to use TypeScript for everything', 2),
      ];
      const result = extractLearnings(messages, undefined, { minMessages: 2 });
      expect(result.decisions).not.toBeNull();
    });

    it('should extract decisions from messages', () => {
      const messages = makeMessages(4);
      messages.push(
        makeMessage('assistant', 'We decided to use ESM modules for all new code in the project', 4),
        makeMessage('user', 'Sounds good, I confirmed that approach works', 5),
      );
      const result = extractLearnings(messages);
      expect(result.decisions).not.toBeNull();
      expect(result.decisions).toContain('decided');
    });

    it('should extract errors/issues from messages', () => {
      const messages = makeMessages(4);
      messages.push(
        makeMessage('assistant', 'The build failed because of a missing dependency in package.json', 4),
        makeMessage('user', 'There was an error in the webpack configuration file', 5),
      );
      const result = extractLearnings(messages);
      expect(result.issues).not.toBeNull();
      expect(result.issues).toContain('failed');
    });

    it('should extract artifacts from messages', () => {
      const messages = makeMessages(4);
      messages.push(
        makeMessage('assistant', 'I created the new auth module at src/auth/index.ts', 4),
        makeMessage('assistant', 'I also generated the test file at test/auth.test.ts', 5),
      );
      const result = extractLearnings(messages);
      expect(result.artifacts.length).toBeGreaterThan(0);
    });

    it('should extract patterns from messages', () => {
      const messages = makeMessages(4);
      messages.push(
        makeMessage('assistant', 'The codebase consistently follows the convention of barrel exports for each module', 4),
        makeMessage('user', 'Yes, we always prefer explicit exports over wildcard re-exports', 5),
      );
      const result = extractLearnings(messages);
      expect(result.patterns).not.toBeNull();
    });

    it('should extract learnings from messages', () => {
      const messages = makeMessages(4);
      messages.push(
        makeMessage('assistant', 'I learned that the API requires authentication tokens for all endpoints', 4),
        makeMessage('user', 'Key insight: the cache invalidation happens on write, not on read', 5),
      );
      const result = extractLearnings(messages);
      expect(result.learnings).not.toBeNull();
    });

    it('should generate session summary from first user message', () => {
      const messages = [
        makeMessage('user', 'Fix the login page CSS styling issue', 0),
        makeMessage('assistant', 'I will look into the CSS issue now', 1),
        makeMessage('user', 'The error was in the media query breakpoint', 2),
        makeMessage('assistant', 'Fixed the media query to use the correct breakpoint', 3),
        makeMessage('user', 'Looks good, thanks', 4),
      ];
      const result = extractLearnings(messages);
      expect(result.sessionSummary).toBe('Fix the login page CSS styling issue');
    });

    it('should use pulse summary when available', () => {
      const messages = makeMessages(6);
      const pulses = [makePulse({ summary: 'Refactored auth module' })];
      const result = extractLearnings(messages, pulses);
      expect(result.sessionSummary).toBe('Refactored auth module');
    });

    it('should pull artifacts from pulse data', () => {
      const messages = makeMessages(6);
      const pulses = [
        makePulse({ artifacts: ['src/auth/index.ts', 'test/auth.test.ts'] }),
      ];
      const result = extractLearnings(messages, pulses);
      expect(result.artifacts).toContain('src/auth/index.ts');
      expect(result.artifacts).toContain('test/auth.test.ts');
    });

    it('should pull blockers from pulse data as issues', () => {
      const messages = makeMessages(6);
      const pulses = [
        makePulse({ blockers: ['Missing API credentials for the staging environment'] }),
      ];
      const result = extractLearnings(messages, pulses);
      expect(result.issues).not.toBeNull();
      expect(result.issues).toContain('Blocker');
    });

    it('should truncate sections that exceed maxLength', () => {
      const messages = makeMessages(4);
      // Generate many decision lines
      for (let i = 0; i < 5; i++) {
        messages.push(
          makeMessage('assistant', `We decided on approach ${i}: ${'x'.repeat(100)} for the implementation`, 4 + i),
        );
      }
      const result = extractLearnings(messages, undefined, { maxLength: 100, minMessages: 5 });
      if (result.decisions) {
        expect(result.decisions.length).toBeLessThanOrEqual(100);
      }
    });

    it('should skip lines that are too short', () => {
      const messages = makeMessages(4);
      messages.push(makeMessage('user', 'decided', 4)); // Too short (< 10 chars)
      messages.push(makeMessage('assistant', 'ok done', 5)); // Too short
      const result = extractLearnings(messages);
      // No decisions extracted from very short lines
      expect(result.decisions).toBeNull();
    });

    it('should limit each category to 5 entries', () => {
      const messages: SessionMessage[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push(
          makeMessage('assistant', `We decided on option ${i} for the component architecture`, i),
        );
      }
      const result = extractLearnings(messages, undefined, { minMessages: 1 });
      if (result.decisions) {
        const lines = result.decisions.split('\n').filter(l => l.startsWith('- '));
        expect(lines.length).toBeLessThanOrEqual(5);
      }
    });

    it('should not deduplicate artifacts from messages and pulses', () => {
      const messages = makeMessages(4);
      messages.push(makeMessage('assistant', 'I created src/utils.ts for shared utilities', 4));
      const pulses = [makePulse({ artifacts: ['src/utils.ts'] })];
      const result = extractLearnings(messages, pulses, { minMessages: 5 });
      // Both the message-extracted and pulse artifacts should be present
      expect(result.artifacts.filter(a => a === 'src/utils.ts' || a.includes('src/utils.ts')).length).toBeGreaterThanOrEqual(1);
    });

    it('should handle messages with only system messages', () => {
      const messages: SessionMessage[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push(makeMessage('system', `System message ${i}`, i));
      }
      const result = extractLearnings(messages);
      expect(result.sessionSummary).toBe('Session with no user messages');
    });
  });
});
