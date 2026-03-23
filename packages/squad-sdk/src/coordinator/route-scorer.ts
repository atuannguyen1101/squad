/**
 * Performance-Aware Route Scorer (Sprint 3, #9)
 * 
 * Combines pattern matching scores with agent performance metrics
 * to select the best agent for a task. When multiple agents match,
 * prefer the one with better success rate and speed.
 * 
 * @module coordinator/route-scorer
 */

import type { CompiledRouter, CompiledWorkTypeRule, RoutingMatch } from '../config/routing.js';
import type { MetricsTracker } from './metrics.js';

// ============================================================================
// Types
// ============================================================================

export interface ScoredRoute {
  /** Agent name */
  agentName: string;
  
  /** Combined score (0-1, higher is better) */
  score: number;
  
  /** Pattern match score (0-1) */
  patternScore: number;
  
  /** Performance score (0-1) */
  performanceScore: number;
  
  /** Matched rule */
  rule?: CompiledWorkTypeRule;
  
  /** Scoring reason for debugging */
  reason: string;
}

export interface RouteScoreConfig {
  /** Weight for pattern matching (0-1) */
  patternWeight: number;
  
  /** Weight for success rate (0-1) */
  successRateWeight: number;
  
  /** Weight for speed (0-1) */
  speedWeight: number;
  
  /** Penalty for recent errors (0-1) */
  errorPenalty: number;
}

const DEFAULT_SCORE_CONFIG: RouteScoreConfig = {
  patternWeight: 0.5,
  successRateWeight: 0.3,
  speedWeight: 0.15,
  errorPenalty: 0.05
};

// ============================================================================
// Route Scorer
// ============================================================================

export class RouteScorer {
  private config: RouteScoreConfig;

  constructor(config: Partial<RouteScoreConfig> = {}) {
    this.config = { ...DEFAULT_SCORE_CONFIG, ...config };
  }

  /**
   * Score all matching routes and return the best one.
   * 
   * @param message - User message to route
   * @param router - Compiled routing rules
   * @param metrics - Agent metrics tracker
   * @returns Best scored route
   */
  scoreRoutes(
    message: string,
    router: CompiledRouter,
    metrics: MetricsTracker
  ): ScoredRoute {
    const lowerMessage = message.toLowerCase();
    const candidates: ScoredRoute[] = [];

    // Find all matching rules
    for (const rule of router.workTypeRules) {
      for (const pattern of rule.patterns) {
        if (pattern.test(lowerMessage)) {
          // Score each agent in this rule
          for (const agentName of rule.agents) {
            const scored = this.scoreAgent(agentName, rule, metrics);
            candidates.push(scored);
          }
          break; // Only count each rule once
        }
      }
    }

    // If no matches, return fallback
    if (candidates.length === 0) {
      const fallbackAgent = router.fallbackAgent || '@coordinator';
      return {
        agentName: fallbackAgent,
        score: 0.3,
        patternScore: 0,
        performanceScore: 0.5, // Neutral
        reason: 'No pattern match, using fallback'
      };
    }

    // Sort by score (highest first) and return best
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]!;
  }

  /**
   * Score a single agent based on pattern match + performance metrics.
   */
  private scoreAgent(
    agentName: string,
    rule: CompiledWorkTypeRule,
    metrics: MetricsTracker
  ): ScoredRoute {
    // Pattern score based on rule confidence and priority
    const patternScore = this.calculatePatternScore(rule);
    
    // Performance score based on success rate, speed, and recent errors
    const performanceScore = this.calculatePerformanceScore(agentName, metrics);
    
    // Combined weighted score
    const score = this.combineScores(patternScore, performanceScore);
    
    // Build reason string
    const agentMetrics = metrics.getMetrics(agentName);
    const successRate = metrics.getSuccessRate(agentName);
    const avgDuration = metrics.getAverageDuration(agentName);
    
    const reason = agentMetrics
      ? `Pattern: ${rule.workType} (${(patternScore * 100).toFixed(0)}%), ` +
        `Success: ${(successRate * 100).toFixed(0)}%, ` +
        `Avg: ${(avgDuration / 1000).toFixed(1)}s`
      : `Pattern: ${rule.workType} (${(patternScore * 100).toFixed(0)}%), No history`;

    return {
      agentName,
      score,
      patternScore,
      performanceScore,
      rule,
      reason
    };
  }

  /**
   * Calculate pattern match score from rule properties.
   */
  private calculatePatternScore(rule: CompiledWorkTypeRule): number {
    // Base score from confidence
    let score = 0.5;
    
    if (rule.confidence === 'high') {
      score = 0.8;
    } else if (rule.confidence === 'medium') {
      score = 0.6;
    } else if (rule.confidence === 'low') {
      score = 0.4;
    }
    
    // Boost for higher priority (more specific patterns)
    // Normalize priority to 0-1 range (assume max priority is ~100)
    const priorityBoost = Math.min(rule.priority / 100, 0.2);
    score += priorityBoost;
    
    return Math.min(score, 1.0);
  }

  /**
   * Calculate performance score from metrics.
   */
  private calculatePerformanceScore(
    agentName: string,
    metrics: MetricsTracker
  ): number {
    const agentMetrics = metrics.getMetrics(agentName);
    
    // No history = neutral score
    if (!agentMetrics || agentMetrics.totalTasks === 0) {
      return 0.5;
    }

    // Success rate component (prefer recent over all-time)
    const recentSuccessRate = metrics.getRecentSuccessRate(agentName);
    const allTimeSuccessRate = metrics.getSuccessRate(agentName);
    const successScore = (recentSuccessRate * 0.7) + (allTimeSuccessRate * 0.3);

    // Speed component (faster is better)
    // Normalize to 0-1 where 0 = very slow (>5min), 1 = very fast (<30s)
    const avgDuration = metrics.getAverageDuration(agentName);
    const speedScore = this.normalizeSpeed(avgDuration);

    // Error penalty (reduce score if last error is recent)
    let errorPenalty = 0;
    if (agentMetrics.lastError) {
      const lastOutcome = agentMetrics.recentOutcomes[0];
      if (lastOutcome && lastOutcome.result === 'error') {
        // Recent error = higher penalty
        const hoursSinceError = (Date.now() - lastOutcome.timestamp.getTime()) / (1000 * 60 * 60);
        errorPenalty = hoursSinceError < 1 ? 0.2 : (hoursSinceError < 24 ? 0.1 : 0.05);
      }
    }

    // Combine components
    const performanceScore = 
      (successScore * this.config.successRateWeight) +
      (speedScore * this.config.speedWeight) -
      (errorPenalty * this.config.errorPenalty);

    return Math.max(0, Math.min(performanceScore, 1.0));
  }

  /**
   * Normalize duration to speed score (0-1, higher is better).
   */
  private normalizeSpeed(durationMs: number): number {
    const seconds = durationMs / 1000;
    
    if (seconds < 30) return 1.0;
    if (seconds < 60) return 0.9;
    if (seconds < 120) return 0.8;
    if (seconds < 180) return 0.7;
    if (seconds < 300) return 0.6;
    
    return 0.5; // 5+ minutes = neutral
  }

  /**
   * Combine pattern and performance scores with configured weights.
   */
  private combineScores(patternScore: number, performanceScore: number): number {
    const combined = 
      (patternScore * this.config.patternWeight) +
      (performanceScore * (1 - this.config.patternWeight));
    
    return Math.max(0, Math.min(combined, 1.0));
  }

  /**
   * Update scoring weights at runtime.
   */
  updateConfig(config: Partial<RouteScoreConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
