/**
 * Agent Performance Metrics (Sprint 3, #9)
 * 
 * Tracks per-agent success rates, average duration, and error patterns
 * to enable performance-aware routing. Persists metrics across server restarts.
 * 
 * @module coordinator/metrics
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SquadEvent } from '../runtime/event-bus.js';
import type { SessionDestroyedPayload, SessionErrorPayload } from '../runtime/event-payloads.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentMetrics {
  /** Agent name */
  agentName: string;
  
  /** Total tasks attempted */
  totalTasks: number;
  
  /** Tasks completed successfully */
  completedTasks: number;
  
  /** Tasks that ended with errors */
  erroredTasks: number;
  
  /** Total duration in milliseconds */
  totalDuration: number;
  
  /** Last N outcomes (max 10) */
  recentOutcomes: TaskOutcome[];
  
  /** Last error message (if any) */
  lastError?: string;
  
  /** Last update timestamp */
  lastUpdated: Date;
}

export interface TaskOutcome {
  /** Outcome type */
  result: 'success' | 'error' | 'timeout' | 'abort';
  
  /** Duration in milliseconds */
  duration: number;
  
  /** Timestamp */
  timestamp: Date;
  
  /** Error message if result is error */
  error?: string;
}

export interface MetricsSnapshot {
  /** All agent metrics */
  agents: Record<string, AgentMetrics>;
  
  /** Last save timestamp */
  lastSaved: Date;
}

// ============================================================================
// Metrics Tracker
// ============================================================================

const MAX_RECENT_OUTCOMES = 10;

export class MetricsTracker {
  private metrics: Map<string, AgentMetrics> = new Map();
  private sessionStartTimes: Map<string, number> = new Map();
  private metricsPath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(squadRoot: string) {
    this.metricsPath = path.join(squadRoot, '.squad', 'metrics', 'agent-metrics.json');
  }

  /**
   * Load metrics from disk.
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.metricsPath, 'utf-8');
      const snapshot: MetricsSnapshot = JSON.parse(data);
      
      // Restore metrics with Date objects
      for (const [agentName, metrics] of Object.entries(snapshot.agents)) {
        this.metrics.set(agentName, {
          ...metrics,
          lastUpdated: new Date(metrics.lastUpdated),
          recentOutcomes: metrics.recentOutcomes.map(outcome => ({
            ...outcome,
            timestamp: new Date(outcome.timestamp)
          }))
        });
      }
    } catch (err) {
      // File doesn't exist or is corrupted - start fresh
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to load metrics:', err);
      }
    }
  }

  /**
   * Save metrics to disk.
   */
  async save(): Promise<void> {
    const snapshot: MetricsSnapshot = {
      agents: Object.fromEntries(this.metrics.entries()),
      lastSaved: new Date()
    };

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.metricsPath), { recursive: true });
      await fs.writeFile(this.metricsPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('Failed to save metrics:', err);
    }
  }

  /**
   * Schedule a save (debounced).
   */
  private scheduleSave(): void {
    this.dirty = true;
    
    if (this.saveTimer) {
      return;
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        void this.save();
      }
    }, 5000); // Save 5 seconds after last change
  }

  /**
   * Handle an event bus event.
   */
  handleEvent(event: SquadEvent): void {
    if (!event.agentName) {
      return;
    }

    switch (event.type) {
      case 'session:created':
        this.onSessionCreated(event.sessionId!, event.agentName);
        break;
        
      case 'session:destroyed':
        this.onSessionDestroyed(event.sessionId!, event.agentName, event.payload as SessionDestroyedPayload);
        break;
        
      case 'session:error':
        this.onSessionError(event.agentName, event.payload as SessionErrorPayload);
        break;
    }
  }

  private onSessionCreated(sessionId: string, agentName: string): void {
    this.sessionStartTimes.set(sessionId, Date.now());
    
    // Ensure metrics object exists
    if (!this.metrics.has(agentName)) {
      this.metrics.set(agentName, {
        agentName,
        totalTasks: 0,
        completedTasks: 0,
        erroredTasks: 0,
        totalDuration: 0,
        recentOutcomes: [],
        lastUpdated: new Date()
      });
    }
  }

  private onSessionDestroyed(sessionId: string, agentName: string, payload: SessionDestroyedPayload): void {
    const startTime = this.sessionStartTimes.get(sessionId);
    if (!startTime) {
      return;
    }

    const duration = Date.now() - startTime;
    this.sessionStartTimes.delete(sessionId);

    const metrics = this.metrics.get(agentName);
    if (!metrics) {
      return;
    }

    // Record outcome
    const outcome: TaskOutcome = {
      result: payload.reason === 'complete' ? 'success' : (payload.reason || 'error') as TaskOutcome['result'],
      duration,
      timestamp: new Date()
    };

    // Update metrics
    metrics.totalTasks++;
    metrics.totalDuration += duration;
    
    if (outcome.result === 'success') {
      metrics.completedTasks++;
    } else {
      metrics.erroredTasks++;
    }

    // Add to recent outcomes (keep last N)
    metrics.recentOutcomes.unshift(outcome);
    if (metrics.recentOutcomes.length > MAX_RECENT_OUTCOMES) {
      metrics.recentOutcomes.pop();
    }

    metrics.lastUpdated = new Date();
    this.scheduleSave();
  }

  private onSessionError(agentName: string, payload: SessionErrorPayload): void {
    // Ensure metrics object exists
    if (!this.metrics.has(agentName)) {
      this.metrics.set(agentName, {
        agentName,
        totalTasks: 0,
        completedTasks: 0,
        erroredTasks: 0,
        totalDuration: 0,
        recentOutcomes: [],
        lastUpdated: new Date()
      });
    }
    
    const metrics = this.metrics.get(agentName)!;
    metrics.lastError = payload.error;
    metrics.lastUpdated = new Date();
    this.scheduleSave();
  }

  /**
   * Get metrics for an agent.
   */
  getMetrics(agentName: string): AgentMetrics | undefined {
    return this.metrics.get(agentName);
  }

  /**
   * Get all metrics.
   */
  getAllMetrics(): AgentMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Calculate success rate for an agent (0-1).
   */
  getSuccessRate(agentName: string): number {
    const metrics = this.metrics.get(agentName);
    if (!metrics || metrics.totalTasks === 0) {
      return 0.5; // Neutral default
    }
    
    return metrics.completedTasks / metrics.totalTasks;
  }

  /**
   * Calculate average duration for an agent (ms).
   */
  getAverageDuration(agentName: string): number {
    const metrics = this.metrics.get(agentName);
    if (!metrics || metrics.totalTasks === 0) {
      return 0;
    }
    
    return metrics.totalDuration / metrics.totalTasks;
  }

  /**
   * Get recent success rate (last N tasks, 0-1).
   */
  getRecentSuccessRate(agentName: string): number {
    const metrics = this.metrics.get(agentName);
    if (!metrics || metrics.recentOutcomes.length === 0) {
      return 0.5; // Neutral default
    }
    
    const successCount = metrics.recentOutcomes.filter(o => o.result === 'success').length;
    return successCount / metrics.recentOutcomes.length;
  }

  /**
   * Cleanup and save on shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    
    if (this.dirty) {
      await this.save();
    }
  }
}
