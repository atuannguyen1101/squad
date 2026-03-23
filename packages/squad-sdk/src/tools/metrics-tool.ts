/**
 * Metrics Tool - MCP tool for exposing agent performance metrics
 * 
 * Provides visibility into agent success rates, durations, and error patterns
 * for debugging and routing decisions.
 * 
 * @module tools/metrics-tool
 */

import type { SquadTool } from '../adapter/types.js';
import type { MetricsTracker } from '../coordinator/metrics.js';

export interface MetricsQuery {
  /** Agent name to query (optional, omit for all) */
  agentName?: string;
  
  /** Include detailed recent outcomes */
  includeOutcomes?: boolean;
}

/**
 * Create the squad_metrics MCP tool.
 * 
 * Usage from agents:
 * - squad_metrics() — get all agent metrics
 * - squad_metrics({ agentName: "Lead" }) — get specific agent metrics
 * - squad_metrics({ includeOutcomes: true }) — include recent task outcomes
 */
export function createMetricsTool(metricsTracker: MetricsTracker): SquadTool<MetricsQuery> {
  return {
    name: 'squad_metrics',
    description: 'Query agent performance metrics including success rates, average durations, and error patterns. Useful for debugging routing decisions and identifying struggling agents.',
    parameters: {
      type: 'object',
      properties: {
        agentName: {
          type: 'string',
          description: 'Agent name to query. Omit to get all agents.'
        },
        includeOutcomes: {
          type: 'boolean',
          description: 'Include recent task outcomes (last 10 tasks)',
          default: false
        }
      }
    },
    
    handler: async (args) => {
      try {
        // Get metrics
        const allMetrics = metricsTracker.getAllMetrics();
        
        // Filter by agent name if provided
        const filteredMetrics = args.agentName
          ? allMetrics.filter(m => m.agentName === args.agentName)
          : allMetrics;
        
        if (filteredMetrics.length === 0) {
          const msg = args.agentName
            ? `No metrics found for agent: ${args.agentName}`
            : 'No agent metrics available yet';
          
          return {
            textResultForLlm: msg,
            resultType: 'success',
            toolTelemetry: { metricsCount: 0 }
          };
        }
        
        // Format output
        const lines: string[] = [];
        lines.push(`Agent Performance Metrics (${filteredMetrics.length} agent${filteredMetrics.length > 1 ? 's' : ''}):\n`);
        
        for (const metrics of filteredMetrics) {
          const successRate = metricsTracker.getSuccessRate(metrics.agentName);
          const recentSuccessRate = metricsTracker.getRecentSuccessRate(metrics.agentName);
          const avgDuration = metricsTracker.getAverageDuration(metrics.agentName);
          
          lines.push(`**${metrics.agentName}**`);
          lines.push(`  Total tasks: ${metrics.totalTasks}`);
          lines.push(`  Success rate: ${(successRate * 100).toFixed(1)}% (recent: ${(recentSuccessRate * 100).toFixed(1)}%)`);
          lines.push(`  Avg duration: ${(avgDuration / 1000).toFixed(1)}s`);
          lines.push(`  Errors: ${metrics.erroredTasks}`);
          
          if (metrics.lastError) {
            lines.push(`  Last error: ${metrics.lastError.substring(0, 100)}`);
          }
          
          // Include recent outcomes if requested
          if (args.includeOutcomes && metrics.recentOutcomes.length > 0) {
            lines.push(`  Recent outcomes (last ${metrics.recentOutcomes.length}):`);
            for (const outcome of metrics.recentOutcomes.slice(0, 5)) {
              const icon = outcome.result === 'success' ? '✓' : '✗';
              const duration = (outcome.duration / 1000).toFixed(1);
              lines.push(`    ${icon} ${outcome.result} (${duration}s)`);
              if (outcome.error) {
                lines.push(`      ${outcome.error.substring(0, 80)}`);
              }
            }
          }
          
          lines.push('');
        }
        
        return {
          textResultForLlm: lines.join('\n'),
          resultType: 'success',
          toolTelemetry: {
            agentsQueried: filteredMetrics.length,
            includeOutcomes: args.includeOutcomes || false
          }
        };
        
      } catch (error) {
        return {
          textResultForLlm: `Failed to query metrics: ${error instanceof Error ? error.message : String(error)}`,
          resultType: 'failure',
          error: String(error)
        };
      }
    }
  };
}
