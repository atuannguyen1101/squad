/**
 * IntentSummarizer - produces focused markdown summaries of intent graphs for agents
 */
import { IntentGraph } from './IntentGraph.js';
import { IntentSummary, IntentNode } from './types.js';

export class IntentSummarizer {
  /**
   * Summarize the intent graph for a specific agent
   * @param graph The full intent graph
   * @param agentName The name of the agent to summarize for
   * @returns A focused summary relevant to this agent
   */
  static summarizeForAgent(graph: IntentGraph, agentName: string): IntentSummary {
    const rootGoal = graph.getRootGoal();
    const overallGoal = rootGoal?.description ?? 'No goal defined';

    // Find tasks assigned to this agent
    const assignedTasks = graph.getNodesByAgent(agentName);
    const primaryTask = assignedTasks.find((t) => t.type === 'task');

    const agentAssignment = primaryTask
      ? {
          taskId: primaryTask.id,
          description: primaryTask.description,
          status: primaryTask.status,
        }
      : undefined;

    // Get relevant constraints
    const constraints = graph.getNodesByType('constraint').map((c) => c.description);

    // Get relevant acceptance criteria
    const acceptanceCriteria = graph
      .getNodesByType('acceptance_criterion')
      .map((ac) => ac.description);

    // Determine context in pipeline
    const contextInPipeline = this.buildContext(graph, agentName, primaryTask);

    return {
      overallGoal,
      agentAssignment,
      relevantConstraints: constraints,
      relevantAcceptanceCriteria: acceptanceCriteria,
      contextInPipeline,
    };
  }

  /**
   * Render summary as markdown
   */
  static toMarkdown(summary: IntentSummary): string {
    const lines: string[] = [];

    lines.push('# Intent Context\n');
    lines.push(`**Overall Goal:** ${summary.overallGoal}\n`);

    if (summary.agentAssignment) {
      lines.push('## Your Assignment\n');
      lines.push(`**Task:** ${summary.agentAssignment.description}`);
      lines.push(`**Status:** ${summary.agentAssignment.status}\n`);
    }

    if (summary.contextInPipeline) {
      lines.push('## How This Fits\n');
      lines.push(summary.contextInPipeline + '\n');
    }

    if (summary.relevantConstraints.length > 0) {
      lines.push('## Constraints\n');
      summary.relevantConstraints.forEach((c) => {
        lines.push(`- ${c}`);
      });
      lines.push('');
    }

    if (summary.relevantAcceptanceCriteria.length > 0) {
      lines.push('## Acceptance Criteria\n');
      summary.relevantAcceptanceCriteria.forEach((ac) => {
        lines.push(`- ${ac}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  private static buildContext(
    graph: IntentGraph,
    agentName: string,
    primaryTask?: IntentNode
  ): string {
    if (!primaryTask) {
      return 'You are part of a larger effort. Coordinate with the team lead.';
    }

    // Find related tasks (dependencies, blockers)
    const outgoing = graph.getEdges(primaryTask.id, 'outgoing');
    const incoming = graph.getEdges(primaryTask.id, 'incoming');

    const parts: string[] = [];

    if (incoming.length > 0) {
      // Incoming edges that indicate this task depends on others
      const dependencies = incoming
        .filter((e) => e.type === 'depends_on' || e.type === 'blocks' || e.type === 'enables')
        .map((e) => graph.getNode(e.from))
        .filter((n): n is IntentNode => !!n);

      if (dependencies.length > 0) {
        parts.push(
          `This task depends on: ${dependencies.map((b) => b.description).join(', ')}`
        );
      }
    }

    if (outgoing.length > 0) {
      const enabled = outgoing
        .filter((e) => e.type === 'enables')
        .map((e) => graph.getNode(e.to))
        .filter((n): n is IntentNode => !!n);

      if (enabled.length > 0) {
        parts.push(
          `Your work enables: ${enabled.map((e) => e.description).join(', ')}`
        );
      }
    }

    return parts.length > 0
      ? parts.join('. ')
      : 'This is an independent task in the pipeline.';
  }
}
