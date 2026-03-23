/**
 * Escalation Chain Protocol (Sprint 3, #10)
 * 
 * Configurable escalation chain for handling stuck agents.
 * When an agent makes no progress for N seconds, auto-escalate
 * to the next level: agent -> peer -> lead -> human.
 * 
 * @module coordinator/escalation
 */

import type { SquadEvent } from '../runtime/event-bus.js';

// ============================================================================
// Types
// ============================================================================

export type EscalationLevel = 'agent' | 'peer' | 'lead' | 'human';

export interface EscalationConfig {
  /** Timeout per level in seconds */
  timeouts: Record<EscalationLevel, number>;
  
  /** Escalation chain definition */
  chain: EscalationLevel[];
  
  /** Peer mapping: agent -> peer agent */
  peerMap?: Record<string, string>;
  
  /** Lead agent name */
  leadAgent?: string;
  
  /** Human notification callback */
  onHumanEscalation?: (context: EscalationContext) => void | Promise<void>;
}

export interface EscalationContext {
  /** Session ID being escalated */
  sessionId: string;
  
  /** Agent name */
  agentName: string;
  
  /** Current escalation level */
  level: EscalationLevel;
  
  /** Next level to escalate to */
  nextLevel?: EscalationLevel;
  
  /** Time stuck (ms) */
  stuckDuration: number;
  
  /** Original task description */
  task?: string;
  
  /** Escalation reason */
  reason: string;
}

export interface EscalationState {
  /** Session ID */
  sessionId: string;
  
  /** Agent name */
  agentName: string;
  
  /** Current level */
  level: EscalationLevel;
  
  /** Last activity timestamp */
  lastActivity: number;
  
  /** Escalation start time */
  escalationStartTime: number;
  
  /** Timer handle */
  timer?: NodeJS.Timeout;
}

export type EscalationEventType = 'escalated' | 'resolved' | 'timeout';

export interface EscalationEvent {
  type: EscalationEventType;
  context: EscalationContext;
  timestamp: Date;
}

const DEFAULT_TIMEOUTS: Record<EscalationLevel, number> = {
  agent: 300,    // 5 minutes
  peer: 180,     // 3 minutes  
  lead: 120,     // 2 minutes
  human: 60      // 1 minute (before alerting)
};

// ============================================================================
// Escalation Manager
// ============================================================================

export class EscalationManager {
  private config: EscalationConfig;
  private sessions: Map<string, EscalationState> = new Map();
  private listeners: Array<(event: EscalationEvent) => void | Promise<void>> = [];

  constructor(config: Partial<EscalationConfig> = {}) {
    this.config = {
      timeouts: { ...DEFAULT_TIMEOUTS, ...config.timeouts },
      chain: config.chain || ['agent', 'peer', 'lead', 'human'],
      peerMap: config.peerMap || {},
      leadAgent: config.leadAgent || '@coordinator',
      onHumanEscalation: config.onHumanEscalation
    };
  }

  /**
   * Track a session for escalation monitoring.
   */
  trackSession(sessionId: string, agentName: string, task?: string): void {
    if (this.sessions.has(sessionId)) {
      return; // Already tracking
    }

    const state: EscalationState = {
      sessionId,
      agentName,
      level: 'agent',
      lastActivity: Date.now(),
      escalationStartTime: Date.now()
    };

    this.sessions.set(sessionId, state);
    this.scheduleEscalation(state);
  }

  /**
   * Update activity for a session (resets escalation timer).
   */
  updateActivity(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.lastActivity = Date.now();
    
    // If we've escalated, reset to agent level on activity
    if (state.level !== 'agent') {
      this.resolveEscalation(sessionId, 'Agent resumed progress');
    } else {
      // Just reschedule the timer
      this.clearTimer(state);
      this.scheduleEscalation(state);
    }
  }

  /**
   * Untrack a session (completed or destroyed).
   */
  untrackSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    this.clearTimer(state);
    this.sessions.delete(sessionId);
  }

  /**
   * Handle event bus events.
   */
  handleEvent(event: SquadEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) {
      return;
    }

    switch (event.type) {
      case 'session:created':
        if (event.agentName) {
          this.trackSession(sessionId, event.agentName);
        }
        break;

      case 'session:message':
      case 'session:tool_call':
        this.updateActivity(sessionId);
        break;

      case 'session:destroyed':
        this.untrackSession(sessionId);
        break;
    }
  }

  /**
   * Subscribe to escalation events.
   */
  subscribe(listener: (event: EscalationEvent) => void | Promise<void>): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Emit an escalation event.
   */
  private emit(event: EscalationEvent): void {
    for (const listener of this.listeners) {
      try {
        void listener(event);
      } catch (err) {
        console.error('Escalation listener error:', err);
      }
    }
  }

  /**
   * Schedule escalation check for a session.
   */
  private scheduleEscalation(state: EscalationState): void {
    const timeout = this.config.timeouts[state.level]! * 1000; // Convert to ms

    state.timer = setTimeout(() => {
      this.checkEscalation(state.sessionId);
    }, timeout);
  }

  /**
   * Clear escalation timer.
   */
  private clearTimer(state: EscalationState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  /**
   * Check if session should be escalated.
   */
  private checkEscalation(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    const stuckDuration = Date.now() - state.lastActivity;
    const timeoutMs = this.config.timeouts[state.level]! * 1000;

    // Still stuck?
    if (stuckDuration >= timeoutMs) {
      this.escalate(state, stuckDuration);
    }
  }

  /**
   * Escalate to the next level.
   */
  private escalate(state: EscalationState, stuckDuration: number): void {
    const currentIndex = this.config.chain.indexOf(state.level);
    const nextLevel = this.config.chain[currentIndex + 1];

    if (!nextLevel) {
      // Already at highest level - emit timeout event
      this.emit({
        type: 'timeout',
        context: {
          sessionId: state.sessionId,
          agentName: state.agentName,
          level: state.level,
          stuckDuration,
          reason: `Stuck at ${state.level} level for ${(stuckDuration / 1000).toFixed(0)}s`
        },
        timestamp: new Date()
      });
      return;
    }

    // Update state
    const previousLevel = state.level;
    state.level = nextLevel;

    // Build escalation context
    const context: EscalationContext = {
      sessionId: state.sessionId,
      agentName: state.agentName,
      level: nextLevel,
      stuckDuration,
      reason: `No progress at ${previousLevel} level for ${(stuckDuration / 1000).toFixed(0)}s`
    };

    // Emit escalation event
    this.emit({
      type: 'escalated',
      context,
      timestamp: new Date()
    });

    // Handle human escalation
    if (nextLevel === 'human' && this.config.onHumanEscalation) {
      void this.config.onHumanEscalation(context);
    }

    // Schedule next escalation check
    this.scheduleEscalation(state);
  }

  /**
   * Resolve escalation (agent resumed progress).
   */
  private resolveEscalation(sessionId: string, reason: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.level === 'agent') {
      return;
    }

    const context: EscalationContext = {
      sessionId: state.sessionId,
      agentName: state.agentName,
      level: state.level,
      stuckDuration: Date.now() - state.lastActivity,
      reason
    };

    // Reset to agent level
    state.level = 'agent';
    state.escalationStartTime = Date.now();

    this.emit({
      type: 'resolved',
      context,
      timestamp: new Date()
    });

    // Reschedule from agent level
    this.clearTimer(state);
    this.scheduleEscalation(state);
  }

  /**
   * Get escalation target agent for a session.
   * Returns the agent name to route work to at current escalation level.
   */
  getEscalationTarget(sessionId: string, originalAgent: string): string | undefined {
    const state = this.sessions.get(sessionId);
    if (!state || state.level === 'agent') {
      return undefined; // No escalation
    }

    switch (state.level) {
      case 'peer':
        return this.config.peerMap?.[originalAgent];
      
      case 'lead':
        return this.config.leadAgent;
      
      case 'human':
        return undefined; // Human intervention needed
      
      default:
        return undefined;
    }
  }

  /**
   * Get current escalation state for a session.
   */
  getState(sessionId: string): EscalationState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<EscalationConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      timeouts: { ...this.config.timeouts, ...config.timeouts }
    };
  }

  /**
   * Cleanup on shutdown.
   */
  shutdown(): void {
    for (const state of this.sessions.values()) {
      this.clearTimer(state);
    }
    this.sessions.clear();
    this.listeners.length = 0;
  }
}
