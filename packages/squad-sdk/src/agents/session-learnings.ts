/**
 * Session Learnings Extractor
 *
 * Extracts learnings, decisions, patterns, and issues from agent session
 * messages using heuristic pattern matching. Called at session close to
 * persist cross-session knowledge via history shadows.
 *
 * Design: Simple heuristic extraction — no LLM calls. Scans assistant
 * messages for signal phrases and captures surrounding context.
 */

import type { HistorySection } from './history-shadow.js';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface ExtractedLearning {
  section: HistorySection;
  content: string;
}

export interface ExtractionResult {
  /** Extracted learnings grouped by section */
  learnings: ExtractedLearning[];
  /** Number of messages analyzed */
  messagesAnalyzed: number;
  /** Whether extraction found anything worth persisting */
  hasContent: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum message length to consider for extraction */
const MIN_MESSAGE_LENGTH = 50;

/** Maximum characters to extract per learning entry */
const MAX_ENTRY_LENGTH = 500;

/** Maximum total entries per section per session */
const MAX_ENTRIES_PER_SECTION = 5;

/** Placeholder text from tool-call-only responses — skip these */
const TOOL_CALL_PLACEHOLDER = '[Agent completed turn — work performed via tool calls]';

/**
 * Signal phrases that indicate a decision was made.
 * Matched case-insensitively against sentence boundaries.
 */
const DECISION_SIGNALS = [
  /\bdecided\s+to\b/i,
  /\bdecision[:\s]/i,
  /\bgoing\s+with\b/i,
  /\bchose\s+to\b/i,
  /\bwill\s+use\b/i,
  /\bapproach[:\s].*\bwill\b/i,
  /\binstead\s+of\b/i,
  /\bswitching\s+to\b/i,
  /\bwe\s+should\b/i,
  /\bi['']ll\s+(implement|use|create|add|fix|change)\b/i,
];

/**
 * Signal phrases that indicate an issue or error was encountered.
 */
const ISSUE_SIGNALS = [
  /\b(error|exception|failure|failed)\b.*\b(because|due\s+to|caused\s+by)\b/i,
  /\bbug\b/i,
  /\bworkaround\b/i,
  /\bfixed\s+by\b/i,
  /\broot\s+cause\b/i,
  /\bbreaking\s+change\b/i,
  /\bregression\b/i,
  /\btype\s*error\b/i,
  /\bmodule\s+not\s+found\b/i,
  /\btest.*fail/i,
];

/**
 * Signal phrases that indicate a pattern or convention.
 */
const PATTERN_SIGNALS = [
  /\bpattern[:\s]/i,
  /\bconvention[:\s]/i,
  /\balways\s+(use|do|ensure|check)\b/i,
  /\bnever\s+(use|do|allow)\b/i,
  /\bbest\s+practice\b/i,
  /\bconsistent\s+with\b/i,
  /\bfollowing\s+the\b.*\bpattern\b/i,
  /\bidiom(atic)?\b/i,
];

// ============================================================================
// Core Extraction
// ============================================================================

/**
 * Extract learnings from a session's messages.
 *
 * Scans assistant messages for decision, issue, pattern, and learning
 * signals. Returns categorized extracts ready for `appendToHistory()`.
 *
 * @param messages - Session messages (user + assistant + system)
 * @param agentName - Agent name (for context in extracts)
 * @returns Extraction result with categorized learnings
 */
export function extractSessionLearnings(
  messages: readonly SessionMessage[],
  agentName: string,
): ExtractionResult {
  const assistantMessages = messages.filter(
    m =>
      m.role === 'assistant' &&
      m.content !== TOOL_CALL_PLACEHOLDER &&
      m.content.length >= MIN_MESSAGE_LENGTH,
  );

  if (assistantMessages.length === 0) {
    return { learnings: [], messagesAnalyzed: 0, hasContent: false };
  }

  const decisions: string[] = [];
  const issues: string[] = [];
  const patterns: string[] = [];
  const learnings: string[] = [];

  for (const msg of assistantMessages) {
    const sentences = splitIntoSentences(msg.content);

    for (const sentence of sentences) {
      if (sentence.length < 20) continue;

      // Check decisions
      if (decisions.length < MAX_ENTRIES_PER_SECTION && matchesAny(sentence, DECISION_SIGNALS)) {
        decisions.push(truncate(sentence));
        continue;
      }

      // Check issues
      if (issues.length < MAX_ENTRIES_PER_SECTION && matchesAny(sentence, ISSUE_SIGNALS)) {
        issues.push(truncate(sentence));
        continue;
      }

      // Check patterns
      if (patterns.length < MAX_ENTRIES_PER_SECTION && matchesAny(sentence, PATTERN_SIGNALS)) {
        patterns.push(truncate(sentence));
        continue;
      }
    }
  }

  // If we found specific signals but no general learnings yet, extract a session summary
  // from the last substantial assistant message as a general learning.
  if (assistantMessages.length > 0 && learnings.length === 0) {
    const lastSubstantial = findLastSubstantialMessage(assistantMessages);
    if (lastSubstantial) {
      const summary = extractSummary(lastSubstantial.content);
      if (summary) {
        learnings.push(summary);
      }
    }
  }

  const extracted: ExtractedLearning[] = [];

  if (decisions.length > 0) {
    extracted.push({
      section: 'Decisions',
      content: decisions.map(d => `- ${d}`).join('\n'),
    });
  }

  if (issues.length > 0) {
    extracted.push({
      section: 'Issues',
      content: issues.map(i => `- ${i}`).join('\n'),
    });
  }

  if (patterns.length > 0) {
    extracted.push({
      section: 'Patterns',
      content: patterns.map(p => `- ${p}`).join('\n'),
    });
  }

  if (learnings.length > 0) {
    extracted.push({
      section: 'Learnings',
      content: learnings.map(l => `- ${l}`).join('\n'),
    });
  }

  return {
    learnings: extracted,
    messagesAnalyzed: assistantMessages.length,
    hasContent: extracted.length > 0,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Split text into sentence-like chunks.
 * Handles common sentence-ending punctuation and markdown list items.
 */
function splitIntoSentences(text: string): string[] {
  // First, split by line breaks to handle markdown lists
  const lines = text.split(/\n+/);
  const sentences: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Handle markdown list items as individual sentences
    if (/^[-*•]\s/.test(trimmed)) {
      sentences.push(trimmed.replace(/^[-*•]\s+/, ''));
      continue;
    }

    // Handle numbered list items
    if (/^\d+\.\s/.test(trimmed)) {
      sentences.push(trimmed.replace(/^\d+\.\s+/, ''));
      continue;
    }

    // Split on sentence boundaries
    const parts = trimmed.split(/(?<=[.!?])\s+(?=[A-Z])/);
    sentences.push(...parts);
  }

  return sentences;
}

/**
 * Check if text matches any of the provided regex patterns.
 */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

/**
 * Truncate text to MAX_ENTRY_LENGTH, ending at a word boundary.
 */
function truncate(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= MAX_ENTRY_LENGTH) return cleaned;

  const truncated = cleaned.slice(0, MAX_ENTRY_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');

  return (lastSpace > MAX_ENTRY_LENGTH * 0.7 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

/**
 * Find the last substantial (non-trivial) assistant message.
 */
function findLastSubstantialMessage(messages: SessionMessage[]): SessionMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.content.length >= 100) return msg;
  }
  return null;
}

/**
 * Extract a brief summary from message content.
 * Takes the first 1-2 substantial sentences.
 */
function extractSummary(content: string): string | null {
  const sentences = splitIntoSentences(content);
  const substantial = sentences.filter(s => s.length >= 30);

  if (substantial.length === 0) return null;

  // Take first 1-2 sentences, up to MAX_ENTRY_LENGTH
  let summary = substantial[0]!;
  if (substantial.length > 1 && summary.length + substantial[1]!.length + 2 <= MAX_ENTRY_LENGTH) {
    summary += '. ' + substantial[1];
  }

  return truncate(summary);
}
