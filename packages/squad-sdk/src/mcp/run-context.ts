/**
 * RunContext - Per-Run State Container
 *
 * Isolates state for each squad_run invocation to enable concurrent multi-run execution.
 * Each RunContext contains its own pulse collector, intent graph, pending questions,
 * wait resolvers, and pipeline state.
 *
 * Design principles:
 * 1. Zero shared mutable state between runs
 * 2. Session keys include runId for isolation (agentName::runId)
 * 3. All tools accept optional runId parameter
 * 4. Auto-cleanup on pipeline completion
 */

import type { PipelineRunner } from '../pipeline/index.js';
import type { IntentGraph } from '../intent/index.js';
import { PulseCollector } from '../pulse/pulse.js';

export interface PendingUserQuestion {
  questionId: string;
  agentName: string;
  question: string;
  timestamp: string;
}

export interface RunContext {
  /** Unique identifier for this run */
  runId: string;

  /** User's initial task/question that started this run */
  initialMessage: string;

  /** When this run was created */
  createdAt: Date;

  /** Current run status */
  status: 'active' | 'completed' | 'cancelled' | 'failed';

  /** Pulse collector for this run */
  pulseCollector: PulseCollector;

  /** Intent graph tracking routing decisions */
  intentGraph: IntentGraph;

  /** Pending user questions awaiting squad_respond */
  pendingUserQuestions: PendingUserQuestion[];

  /** Active pipeline runners for this run */
  activePipelines: PipelineRunner[];

  /** Resolvers waiting for squad_wait completion */
  waitResolvers: Array<(value: string) => void>;

  /** Last activity timestamp for staleness detection */
  lastActivityAt: Date;
}

/**
 * Create a new RunContext for a squad_run invocation.
 */
export function createRunContext(runId: string, initialMessage: string): RunContext {
  return {
    runId,
    initialMessage,
    createdAt: new Date(),
    status: 'active',
    pulseCollector: new PulseCollector(),
    intentGraph: {
      goal: initialMessage,
      constraints: [],
      preferences: [],
      acceptanceCriteria: [],
      openQuestions: [],
      currentStatus: 'clarifying',
      tasks: [],
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clarificationRounds: 0,
        version: 1,
      },
    },
    pendingUserQuestions: [],
    activePipelines: [],
    waitResolvers: [],
    lastActivityAt: new Date(),
  };
}

/**
 * Manager for all active RunContexts.
 * Provides lookup, creation, and cleanup operations.
 */
export class RunContextManager {
  private contexts: Map<string, RunContext> = new Map();

  /**
   * Create a new run context.
   * @throws Error if runId already exists
   */
  create(runId: string, initialMessage: string): RunContext {
    if (this.contexts.has(runId)) {
      throw new Error(`Run ${runId} already exists`);
    }

    const context = createRunContext(runId, initialMessage);
    this.contexts.set(runId, context);
    return context;
  }

  /**
   * Get an existing run context.
   * @returns RunContext if found, undefined otherwise
   */
  get(runId: string): RunContext | undefined {
    return this.contexts.get(runId);
  }

  /**
   * Get all active run contexts.
   */
  getAll(): RunContext[] {
    return Array.from(this.contexts.values());
  }

  /**
   * Get the most recent active run context.
   * Used as fallback when no runId is provided to tools.
   */
  getMostRecent(): RunContext | undefined {
    const activeContexts = this.getAll()
      .filter(ctx => ctx.status === 'active')
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
    
    return activeContexts[0];
  }

  /**
   * Mark a run as completed and trigger cleanup.
   */
  complete(runId: string): void {
    const context = this.contexts.get(runId);
    if (context) {
      context.status = 'completed';
      context.lastActivityAt = new Date();
      
      // Resolve any pending wait resolvers
      for (const resolver of context.waitResolvers) {
        resolver(`Run ${runId} completed`);
      }
      context.waitResolvers = [];
    }
  }

  /**
   * Cancel a run and clean up its state.
   */
  cancel(runId: string): void {
    const context = this.contexts.get(runId);
    if (context) {
      context.status = 'cancelled';
      context.lastActivityAt = new Date();
      
      // Resolve any pending wait resolvers
      for (const resolver of context.waitResolvers) {
        resolver(`Run ${runId} cancelled`);
      }
      context.waitResolvers = [];
    }
  }

  /**
   * Delete a run context entirely.
   * Use after cleanup is complete.
   */
  delete(runId: string): boolean {
    return this.contexts.delete(runId);
  }

  /**
   * Get count of active runs.
   */
  getActiveCount(): number {
    return this.getAll().filter(ctx => ctx.status === 'active').length;
  }

  /**
   * Touch a run's lastActivityAt timestamp.
   */
  touch(runId: string): void {
    const context = this.contexts.get(runId);
    if (context) {
      context.lastActivityAt = new Date();
    }
  }
}
