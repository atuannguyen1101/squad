/**
 * Tests for Learning Persistence — event-driven learning extraction and storage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enableLearningPersistence, type LearningPersistenceConfig } from '../packages/squad-sdk/src/agents/learning-persistence.js';
import { EventBus } from '../packages/squad-sdk/src/runtime/event-bus.js';
import { PulseCollector } from '../packages/squad-sdk/src/pulse/pulse.js';
import type { SessionMessage } from '../packages/squad-sdk/src/server/agent-lifecycle.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock history-shadow module so we don't touch the file system
vi.mock('../packages/squad-sdk/src/agents/history-shadow.js', () => ({
  appendToHistory: vi.fn().mockResolvedValue(undefined),
  shadowExists: vi.fn().mockResolvedValue(true),
  createHistoryShadow: vi.fn().mockResolvedValue('/tmp/history.md'),
}));

import { appendToHistory, shadowExists, createHistoryShadow } from '../packages/squad-sdk/src/agents/history-shadow.js';

const mockAppendToHistory = vi.mocked(appendToHistory);
const mockShadowExists = vi.mocked(shadowExists);
const mockCreateHistoryShadow = vi.mocked(createHistoryShadow);

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

function makeSessionMessages(): SessionMessage[] {
  return [
    makeMessage('user', 'Fix the authentication module for JWT token refresh', 0),
    makeMessage('assistant', 'I will look into the auth module and fix the JWT refresh logic', 1),
    makeMessage('user', 'The error occurs when the token expires after 30 minutes', 2),
    makeMessage('assistant', 'I found the bug and fixed the token refresh mechanism', 3),
    makeMessage('user', 'We decided to use a sliding window approach for token renewal', 4),
    makeMessage('assistant', 'I created the new token manager at src/auth/token-manager.ts', 5),
    makeMessage('user', 'I learned that the API gateway caches tokens for 5 minutes', 6),
  ];
}

function defaultConfig(): LearningPersistenceConfig {
  return {
    enabled: true,
    minMessages: 5,
    maxSectionLength: 500,
    squadRoot: '/tmp/test-squad',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Learning Persistence', () => {
  let eventBus: EventBus;
  let pulseCollector: PulseCollector;

  beforeEach(() => {
    eventBus = new EventBus();
    pulseCollector = new PulseCollector();
    vi.clearAllMocks();
    mockShadowExists.mockResolvedValue(true);
  });

  afterEach(() => {
    eventBus.clear();
  });

  describe('enableLearningPersistence()', () => {
    it('should subscribe to session:destroyed events', () => {
      const unsubscribe = enableLearningPersistence(eventBus, pulseCollector, defaultConfig());
      expect(eventBus.getHandlerCount('session:destroyed')).toBe(1);
      unsubscribe();
    });

    it('should return a working unsubscribe function', () => {
      const unsubscribe = enableLearningPersistence(eventBus, pulseCollector, defaultConfig());
      expect(eventBus.getHandlerCount('session:destroyed')).toBe(1);
      unsubscribe();
      expect(eventBus.getHandlerCount('session:destroyed')).toBe(0);
    });

    it('should not subscribe when disabled', () => {
      const config = defaultConfig();
      config.enabled = false;
      const unsubscribe = enableLearningPersistence(eventBus, pulseCollector, config);
      expect(eventBus.getHandlerCount('session:destroyed')).toBe(0);
      unsubscribe();
    });

    it('should extract and persist learnings on session:destroyed', async () => {
      enableLearningPersistence(eventBus, pulseCollector, defaultConfig());

      await eventBus.emit({
        type: 'session:destroyed',
        sessionId: 'session-123',
        agentName: 'fenster',
        payload: {
          durationMs: 60000,
          messages: makeSessionMessages(),
          messageCount: 7,
        },
        timestamp: new Date(),
      });

      // appendToHistory should be called for sections that had content
      expect(mockAppendToHistory).toHaveBeenCalled();
      const calls = mockAppendToHistory.mock.calls;
      // Verify the squadRoot and agentName are correct
      for (const call of calls) {
        expect(call[0]).toBe('/tmp/test-squad');
        expect(call[1]).toBe('fenster');
      }
    });

    it('should skip sessions with no messages in payload', async () => {
      enableLearningPersistence(eventBus, pulseCollector, defaultConfig());

      await eventBus.emit({
        type: 'session:destroyed',
        sessionId: 'session-123',
        agentName: 'fenster',
        payload: {
          durationMs: 60000,
        },
        timestamp: new Date(),
      });

      expect(mockAppendToHistory).not.toHaveBeenCalled();
    });

    it('should skip sessions with too few messages', async () => {
      enableLearningPersistence(eventBus, pulseCollector, defaultConfig());

      await eventBus.emit({
        type: 'session:destroyed',
        sessionId: 'session-123',
        agentName: 'fenster',
        payload: {
          durationMs: 5000,
          messages: [
            makeMessage('user', 'Hello', 0),
            makeMessage('assistant', 'Hi', 1),
          ],
          messageCount: 2,
        },
        timestamp: new Date(),
      });

      expect(mockAppendToHistory).not.toHaveBeenCalled();
    });

    it('should skip events without agentName', async () => {
      enableLearningPersistence(eventBus, pulseCollector, defaultConfig());

      await eventBus.emit({
        type: 'session:destroyed',
        sessionId: 'session-123',
        payload: {
          durationMs: 60000,
          messages: makeSessionMessages(),
          messageCount: 7,
        },
        timestamp: new Date(),
      });

      expect(mockAppendToHistory).not.toHaveBeenCalled();
    });

    it('should create history shadow if it does not exist', async () => {
      mockShadowExists.mockResolvedValue(false);
      enableLearningPersistence(eventBus, pulseCollector, defaultConfig());

      await eventBus.emit({
        type: 'session:destroyed',
        sessionId: 'session-123',
        agentName: 'fenster',
        payload: {
          durationMs: 60000,
          messages: makeSessionMessages(),
          messageCount: 7,
        },
        timestamp: new Date(),
      });

      expect(mockCreateHistoryShadow).toHaveBeenCalledWith(
        '/tmp/test-squad',
        'fenster',
        expect.any(String),
      );
    });

    it('should not crash on persistence errors', async () => {
      mockAppendToHistory.mockRejectedValue(new Error('disk full'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      enableLearningPersistence(eventBus, pulseCollector, defaultConfig());

      // Should not throw
      await eventBus.emit({
        type: 'session:destroyed',
        sessionId: 'session-123',
        agentName: 'fenster',
        payload: {
          durationMs: 60000,
          messages: makeSessionMessages(),
          messageCount: 7,
        },
        timestamp: new Date(),
      });

      // Error should be logged to stderr
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('[learning-persistence]'),
      );

      stderrSpy.mockRestore();
    });

    it('should call appendToHistory with correct section names', async () => {
      enableLearningPersistence(eventBus, pulseCollector, defaultConfig());

      await eventBus.emit({
        type: 'session:destroyed',
        sessionId: 'session-123',
        agentName: 'fenster',
        payload: {
          durationMs: 60000,
          messages: makeSessionMessages(),
          messageCount: 7,
        },
        timestamp: new Date(),
      });

      const sectionNames = mockAppendToHistory.mock.calls.map(c => c[2]);
      // All sections used should be valid HistorySection values
      const validSections = ['Learnings', 'Decisions', 'Patterns', 'Issues', 'References'];
      for (const section of sectionNames) {
        expect(validSections).toContain(section);
      }
    });
  });
});
