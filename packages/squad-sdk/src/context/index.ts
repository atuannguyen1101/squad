/**
 * Context module — auto-summarization and context management for agent sessions.
 */

export {
  applyContextWindow,
  extractiveSummarize,
  createContextWindowState,
  DEFAULT_CONTEXT_WINDOW_CONFIG,
} from './context-window.js';

export type {
  ContextWindowConfig,
  ContextWindowState,
  WindowResult,
} from './context-window.js';
