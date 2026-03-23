/**
 * Learning Persistence — Subscribes to session lifecycle events and persists
 * extracted learnings to agent history shadows.
 *
 * Glue module that connects:
 *   session:destroyed events → extractLearnings() → appendToHistory()
 *
 * Learning persistence is fire-and-forget: errors are logged but never
 * propagate to the caller or crash the server.
 */

import { extractLearnings, type LearningExtraction, type LearningExtractionOptions } from './learning-extractor.js';
import { appendToHistory, shadowExists, createHistoryShadow, type HistorySection } from './history-shadow.js';
import type { EventBus, UnsubscribeFn, SquadEvent } from '../runtime/event-bus.js';
import type { PulseCollector } from '../pulse/pulse.js';
import type { SessionMessage } from '../server/agent-lifecycle.js';

// ============================================================================
// Types
// ============================================================================

export interface LearningPersistenceConfig {
  /** Whether learning persistence is enabled. Default: true */
  enabled: boolean;
  /** Minimum messages to bother extracting. Default: 5 */
  minMessages: number;
  /** Maximum characters per section. Default: 500 */
  maxSectionLength: number;
  /** Path to find .squad/agents/ (team root directory) */
  squadRoot: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Persist a learning extraction to an agent's history shadow.
 *
 * Writes each non-null section using appendToHistory(). Creates the
 * history shadow if it doesn't exist yet.
 */
async function persistExtraction(
  squadRoot: string,
  agentName: string,
  extraction: LearningExtraction,
): Promise<void> {
  // Ensure the history shadow exists before appending
  const exists = await shadowExists(squadRoot, agentName);
  if (!exists) {
    await createHistoryShadow(squadRoot, agentName, extraction.sessionSummary);
  }

  const sections: Array<{ section: HistorySection; content: string | null }> = [
    { section: 'Learnings', content: extraction.learnings },
    { section: 'Decisions', content: extraction.decisions },
    { section: 'Patterns', content: extraction.patterns },
    { section: 'Issues', content: extraction.issues },
  ];

  for (const { section, content } of sections) {
    if (content) {
      await appendToHistory(squadRoot, agentName, section, content);
    }
  }

  // Write artifacts as a reference entry if there are any
  if (extraction.artifacts.length > 0) {
    const artifactContent = extraction.artifacts.map(a => `- ${a}`).join('\n');
    await appendToHistory(squadRoot, agentName, 'References', `Session artifacts:\n${artifactContent}`);
  }
}

/**
 * Handle a session:destroyed event by extracting and persisting learnings.
 *
 * This is the core event handler wired by enableLearningPersistence().
 * All errors are caught and logged — learning persistence must never
 * crash the server.
 */
async function handleSessionDestroyed(
  event: SquadEvent,
  pulseCollector: PulseCollector,
  config: LearningPersistenceConfig,
): Promise<void> {
  const agentName = event.agentName;
  if (!agentName) return;

  const payload = event.payload as {
    durationMs?: number;
    messages?: SessionMessage[];
    messageCount?: number;
  } | undefined;

  const messages = payload?.messages;
  if (!messages || messages.length === 0) return;

  // Skip short sessions
  if (messages.length < config.minMessages) return;

  // Get pulse data for this agent
  const pulses = pulseCollector.getByAgent(agentName);

  const extractionOptions: LearningExtractionOptions = {
    maxLength: config.maxSectionLength,
    minMessages: config.minMessages,
  };

  const extraction = extractLearnings(messages, pulses, extractionOptions);

  // Skip if nothing was extracted
  if (!extraction.learnings && !extraction.decisions && !extraction.patterns && !extraction.issues && extraction.artifacts.length === 0) {
    return;
  }

  await persistExtraction(config.squadRoot, agentName, extraction);
}

/**
 * Enable automatic learning persistence on session close.
 *
 * Subscribes to `session:destroyed` events on the EventBus. When a session
 * closes, extracts learnings from its message history and persists them
 * to the agent's history shadow at `.squad/agents/{name}/history.md`.
 *
 * @param eventBus - EventBus to subscribe to
 * @param pulseCollector - PulseCollector for additional context
 * @param config - Persistence configuration
 * @returns Unsubscribe function to disable learning persistence
 */
export function enableLearningPersistence(
  eventBus: EventBus,
  pulseCollector: PulseCollector,
  config: LearningPersistenceConfig,
): UnsubscribeFn {
  if (!config.enabled) {
    return () => {};
  }

  const unsubscribe = eventBus.subscribe('session:destroyed', async (event: SquadEvent) => {
    try {
      await handleSessionDestroyed(event, pulseCollector, config);
    } catch (error) {
      // Learning persistence should never crash the server
      process.stderr.write(
        `[learning-persistence] Failed to persist learnings for ${event.agentName ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });

  return unsubscribe;
}
