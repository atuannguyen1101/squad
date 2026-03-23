/**
 * Agent-to-Agent Handoff Protocol (Sprint 3, Item #7)
 *
 * Enables agents to delegate sub-tasks to peer agents during their session.
 * All handoffs route through the coordinator for observability and governance.
 *
 * Key features:
 * - Circular delegation detection (max depth configurable)
 * - Wait-for-result or fire-and-forget modes
 * - Handoff chain tracking for debugging
 * - Event emission for observability
 */

import { randomUUID } from 'node:crypto';
import { trace, SpanStatusCode } from '../runtime/otel-api.js';

const tracer = trace.getTracer('squad-sdk');

// --- Types ---

export interface HandoffRequest {
  /** Agent making the handoff request */
  fromAgent: string;
  /** Target agent to handle the sub-task */
  toAgent: string;
  /** Sub-task description */
  task: string;
  /** Additional context */
  context?: string;
  /** Wait for result or fire-and-forget */
  waitForResult?: boolean;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high' | 'critical';
}

export interface HandoffResult {
  /** Handoff ID for tracking */
  handoffId: string;
  /** Success status */
  success: boolean;
  /** Result message */
  message: string;
  /** Target agent session ID (if spawned) */
  sessionId?: string;
  /** Result from target agent (if waitForResult=true) */
  result?: unknown;
  /** Handoff chain depth */
  depth: number;
}

export interface HandoffChainNode {
  /** Agent name */
  agent: string;
  /** Session ID */
  sessionId?: string;
  /** Task description */
  task: string;
  /** Timestamp */
  timestamp: Date;
}

export interface HandoffConfig {
  /** Maximum delegation chain depth (prevents infinite loops) */
  maxDepth: number;
  /** Enable handoff telemetry */
  enableTelemetry?: boolean;
}

// --- Handoff Manager ---

/**
 * Manages agent-to-agent handoff requests.
 * Tracks delegation chains and prevents circular delegation.
 */
export class HandoffManager {
  private chains = new Map<string, HandoffChainNode[]>();
  private config: HandoffConfig;

  constructor(config: Partial<HandoffConfig> = {}) {
    this.config = {
      maxDepth: config.maxDepth ?? 5,
      enableTelemetry: config.enableTelemetry ?? true,
    };
  }

  /**
   * Validate a handoff request.
   * Checks for circular delegation and depth limits.
   */
  validateHandoff(
    request: HandoffRequest,
    currentChainId?: string,
  ): { valid: boolean; reason?: string; depth: number } {
    const span = tracer.startSpan('squad.handoff.validate');
    span.setAttribute('from.agent', request.fromAgent);
    span.setAttribute('to.agent', request.toAgent);

    try {
      // Get current chain or create new one
      const chain = currentChainId ? this.chains.get(currentChainId) ?? [] : [];
      const depth = chain.length;

      span.setAttribute('chain.depth', depth);

      // Check depth limit
      if (depth >= this.config.maxDepth) {
        return {
          valid: false,
          reason: `Maximum delegation depth (${this.config.maxDepth}) exceeded. Chain: ${this.formatChain(chain)}`,
          depth,
        };
      }

      // Check for circular delegation
      const agentsInChain = new Set(chain.map((n) => n.agent));
      if (agentsInChain.has(request.toAgent)) {
        return {
          valid: false,
          reason: `Circular delegation detected: ${request.toAgent} is already in the chain. Chain: ${this.formatChain(chain)}`,
          depth,
        };
      }

      // Self-delegation check
      if (request.fromAgent === request.toAgent) {
        return {
          valid: false,
          reason: `Agent cannot delegate to itself: ${request.fromAgent}`,
          depth,
        };
      }

      return { valid: true, depth };
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Record a handoff in the chain.
   * Returns a new chain ID for the delegated task.
   */
  recordHandoff(
    request: HandoffRequest,
    sessionId: string,
    parentChainId?: string,
  ): string {
    const span = tracer.startSpan('squad.handoff.record');
    span.setAttribute('from.agent', request.fromAgent);
    span.setAttribute('to.agent', request.toAgent);

    try {
      const chainId = randomUUID();
      const parentChain = parentChainId ? this.chains.get(parentChainId) ?? [] : [];

      // Create new chain with parent nodes + new node
      const newChain: HandoffChainNode[] = [
        ...parentChain,
        {
          agent: request.toAgent,
          sessionId,
          task: request.task,
          timestamp: new Date(),
        },
      ];

      this.chains.set(chainId, newChain);
      span.setAttribute('chain.id', chainId);
      span.setAttribute('chain.depth', newChain.length);

      return chainId;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Get the handoff chain for a given chain ID.
   */
  getChain(chainId: string): HandoffChainNode[] | undefined {
    return this.chains.get(chainId);
  }

  /**
   * Clear a completed handoff chain.
   */
  clearChain(chainId: string): void {
    this.chains.delete(chainId);
  }

  /**
   * Format a chain for display.
   */
  private formatChain(chain: HandoffChainNode[]): string {
    return chain.map((n) => n.agent).join(' → ');
  }

  /**
   * Get all active chains (for debugging/observability).
   */
  getAllChains(): Array<{ chainId: string; chain: HandoffChainNode[] }> {
    return Array.from(this.chains.entries()).map(([chainId, chain]) => ({
      chainId,
      chain,
    }));
  }

  /**
   * Clear all chains (useful for testing).
   */
  clearAll(): void {
    this.chains.clear();
  }
}
