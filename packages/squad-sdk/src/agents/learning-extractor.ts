/**
 * Learning Extractor — Extracts structured learnings from session message history.
 *
 * Takes a session's message history and optional pulse data, categorizes
 * key information into history sections (Learnings, Decisions, Patterns, Issues),
 * and returns a structured extraction suitable for persisting to history.md.
 *
 * Reuses regex patterns from extractiveSummarize() but produces categorized output
 * instead of a single summary string.
 */

// Type imports from missing source files
export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface Pulse {
  agent: string;
  summary: string;
  blockers: string[];
  artifacts: string[];
}

export interface LearningExtraction {
  /** Key things discovered during the session */
  learnings: string | null;
  /** Decisions made during the session */
  decisions: string | null;
  /** Recurring patterns observed */
  patterns: string | null;
  /** Problems encountered */
  issues: string | null;
  /** Files/outputs produced */
  artifacts: string[];
  /** One-line session summary */
  sessionSummary: string;
}

export interface LearningExtractionOptions {
  /** Maximum character length for each section. Default: 500 */
  maxLength?: number;
  /** Minimum messages required to extract learnings. Default: 5 */
  minMessages?: number;
}

// ============================================================================
// Extraction Patterns
// ============================================================================

const PATTERNS = {
  decisions: /\b(?:decided|decision|agreed|confirmed|approved|rejected|chose|chosen|selected)\b|\bwent with\b|\bopted for\b/i,
  errors: /\b(?:error|failed|failure|exception|bug|crash|broken|fix|fixed|resolved|issue|problem|workaround)\b/i,
  artifacts: /\b(?:created|wrote|generated|built|deployed|published|committed|implemented|added|produced)\b/i,
  patterns: /\b(?:pattern|convention|approach|always|never|prefer|standard|rule|practice|recurring|consistently)\b/i,
  learnings: /\b(?:learned|discovered|realized|found out|turns out|important|note|remember|key insight|takeaway|TIL)\b/i,
};

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an empty LearningExtraction with no content.
 */
function emptyExtraction(summary: string): LearningExtraction {
  return {
    learnings: null,
    decisions: null,
    patterns: null,
    issues: null,
    artifacts: [],
    sessionSummary: summary,
  };
}

/**
 * Truncate content to a maximum length, appending "..." if truncated.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Generate a one-line session summary from messages.
 */
function generateSummary(messages: SessionMessage[], pulses?: Pulse[]): string {
  // Try to use the latest pulse summary if available
  if (pulses && pulses.length > 0) {
    const lastPulse = pulses[pulses.length - 1];
    if (lastPulse && lastPulse.summary) {
      return lastPulse.summary;
    }
  }

  // Fall back to message-based summary
  const userMessages = messages.filter(m => m.role === 'user');
  const firstUser = userMessages[0];
  if (firstUser) {
    const firstLine = firstUser.content.split('\n')[0] ?? '';
    return truncate(firstLine.trim(), 120) || 'Session with no clear topic';
  }

  return 'Session with no user messages';
}

/**
 * Extract structured learnings from a session's message history.
 *
 * Scans messages for high-signal content patterns and categorizes them
 * into appropriate history sections. Also pulls blockers and artifacts
 * from pulse data if available.
 *
 * @param messages - Session message history
 * @param pulses - Optional pulse data from PulseCollector
 * @param options - Extraction options (maxLength, minMessages)
 * @returns Structured learning extraction
 */
export function extractLearnings(
  messages: SessionMessage[],
  pulses?: Pulse[],
  options?: LearningExtractionOptions,
): LearningExtraction {
  const maxLength = options?.maxLength ?? 500;
  const minMessages = options?.minMessages ?? 5;

  const summary = generateSummary(messages, pulses);

  // Skip sessions that are too short to learn from
  if (messages.length < minMessages) {
    return emptyExtraction(summary);
  }

  const extracted = {
    learnings: [] as string[],
    decisions: [] as string[],
    patterns: [] as string[],
    issues: [] as string[],
  };
  const artifacts: string[] = [];

  // Scan messages for high-signal content
  for (const msg of messages) {
    const lines = msg.content.split('\n').filter((l: string) => l.trim().length > 0);

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip lines that are too short or too long to be meaningful
      if (trimmed.length < 10 || trimmed.length > 500) continue;

      // Categorize into sections based on pattern matching
      if (PATTERNS.decisions.test(trimmed) && extracted['decisions'].length < 5) {
        extracted['decisions'].push(`- ${trimmed.slice(0, 200)}`);
      }

      if (PATTERNS.errors.test(trimmed) && extracted['issues'].length < 5) {
        extracted['issues'].push(`- ${trimmed.slice(0, 200)}`);
      }

      if (PATTERNS.patterns.test(trimmed) && extracted['patterns'].length < 5) {
        extracted['patterns'].push(`- ${trimmed.slice(0, 200)}`);
      }

      if (PATTERNS.learnings.test(trimmed) && extracted['learnings'].length < 5) {
        extracted['learnings'].push(`- ${trimmed.slice(0, 200)}`);
      }

      if (PATTERNS.artifacts.test(trimmed) && artifacts.length < 10) {
        artifacts.push(trimmed.slice(0, 200));
      }
    }
  }

  // Pull additional artifacts and issues from pulse data
  if (pulses && pulses.length > 0) {
    for (const pulse of pulses) {
      for (const artifact of pulse.artifacts) {
        if (!artifacts.includes(artifact) && artifacts.length < 10) {
          artifacts.push(artifact);
        }
      }

      for (const blocker of pulse.blockers) {
        if (extracted['issues'].length < 5) {
          extracted['issues'].push(`- Blocker: ${blocker.slice(0, 200)}`);
        }
      }
    }
  }

  // Build the extraction result
  return {
    learnings: extracted['learnings'].length > 0
      ? truncate(extracted['learnings'].join('\n'), maxLength)
      : null,
    decisions: extracted['decisions'].length > 0
      ? truncate(extracted['decisions'].join('\n'), maxLength)
      : null,
    patterns: extracted['patterns'].length > 0
      ? truncate(extracted['patterns'].join('\n'), maxLength)
      : null,
    issues: extracted['issues'].length > 0
      ? truncate(extracted['issues'].join('\n'), maxLength)
      : null,
    artifacts,
    sessionSummary: summary,
  };
}
