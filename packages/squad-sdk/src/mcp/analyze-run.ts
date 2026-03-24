/**
 * Run Analysis Engine — Sage's analytical core.
 *
 * Reads pulse history and session messages from a completed run,
 * then produces a structured analysis report with concrete improvement
 * proposals for charters, routing rules, and SDK config.
 *
 * Pure functions: no I/O, no side effects — easy to test.
 */

import type { Pulse } from '../pulse/pulse.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  agentName: string;
  messageCount: number;
  messages: ReadonlyArray<{ role: string; content: string; timestamp: string }>;
}

export interface RunAnalysisInput {
  /** All pulses recorded during the run. */
  pulses: readonly Pulse[];
  /** Per-agent session snapshots with conversation messages. */
  sessions: readonly SessionSnapshot[];
  /** Optional — squad root path for context in file references. */
  squadRoot?: string;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ProposalCategory = 'charter' | 'routing' | 'sdk-config' | 'skill' | 'workflow';
export type ProposalPriority = 'low' | 'medium' | 'high';

export interface ImprovementProposal {
  /** What category of change. */
  category: ProposalCategory;
  /** Which file to change (relative to squad root). */
  targetFile: string;
  /** Human-readable title of the change. */
  title: string;
  /** Detailed description of *what* to change and *why*. */
  description: string;
  /** Expected impact if applied. */
  expectedImpact: string;
  /** Priority based on evidence strength. */
  priority: ProposalPriority;
  /** Evidence that led to this proposal (pulse summaries, message excerpts). */
  evidence: string[];
}

export interface AgentRunSummary {
  agentName: string;
  totalPulses: number;
  finalPhase: string;
  finalStatus: string;
  progressArc: number[];
  errorCount: number;
  blockerCount: number;
  messageCount: number;
}

export interface RunAnalysisReport {
  /** ISO timestamp of when the analysis was produced. */
  analyzedAt: string;
  /** High-level narrative of the run. */
  summary: string;
  /** Per-agent breakdown. */
  agents: AgentRunSummary[];
  /** Concrete improvement proposals. */
  proposals: ImprovementProposal[];
  /** Run-level metrics. */
  metrics: {
    totalAgents: number;
    totalPulses: number;
    totalMessages: number;
    durationEstimate: string;
    errorRate: number;
    blockerRate: number;
  };
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function summarizeAgent(agentName: string, pulses: readonly Pulse[], session: SessionSnapshot | undefined): AgentRunSummary {
  const agentPulses = pulses.filter(p => p.agent === agentName);
  const last = agentPulses.at(-1);
  return {
    agentName,
    totalPulses: agentPulses.length,
    finalPhase: last?.phase ?? 'unknown',
    finalStatus: last?.status ?? 'unknown',
    progressArc: agentPulses.map(p => p.progressPct),
    errorCount: agentPulses.filter(p => p.status === 'error').length,
    blockerCount: agentPulses.filter(p => p.blockers.length > 0).length,
    messageCount: session?.messageCount ?? 0,
  };
}

function detectRoutingIssues(sessions: readonly SessionSnapshot[], pulses: readonly Pulse[]): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  // Detect agents that received messages but never pulsed (potential routing mismatches)
  const pulsedAgents = new Set(pulses.map(p => p.agent));
  for (const s of sessions) {
    if (s.messageCount > 0 && !pulsedAgents.has(s.agentName)) {
      proposals.push({
        category: 'routing',
        targetFile: '.squad/routing.md',
        title: `Agent "${s.agentName}" received work but never reported status`,
        description: `Agent "${s.agentName}" has ${s.messageCount} messages but emitted zero pulses. This may indicate a routing mismatch (work sent to wrong agent) or a missing squad_pulse call in the agent's charter instructions.`,
        expectedImpact: 'Better run observability and accurate progress tracking.',
        priority: 'medium',
        evidence: [`${s.messageCount} messages with 0 pulses for ${s.agentName}`],
      });
    }
  }

  return proposals;
}

function detectBlockerPatterns(pulses: readonly Pulse[]): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  // Group blockers by agent
  const blockersByAgent = new Map<string, string[]>();
  for (const p of pulses) {
    if (p.blockers.length > 0) {
      const existing = blockersByAgent.get(p.agent) ?? [];
      existing.push(...p.blockers);
      blockersByAgent.set(p.agent, existing);
    }
  }

  for (const [agent, blockers] of blockersByAgent) {
    if (blockers.length >= 2) {
      proposals.push({
        category: 'charter',
        targetFile: `.squad/agents/${agent}/charter.md`,
        title: `Agent "${agent}" was repeatedly blocked`,
        description: `Agent "${agent}" reported ${blockers.length} blockers during the run. Repeated blocks suggest the charter may need clearer boundaries, prerequisite checks, or dependency declarations.`,
        expectedImpact: 'Fewer blocks in future runs, smoother agent handoffs.',
        priority: 'high',
        evidence: blockers.slice(0, 5).map(b => `Blocker: ${b}`),
      });
    }
  }

  return proposals;
}

function detectErrorPatterns(pulses: readonly Pulse[]): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  const errorPulses = pulses.filter(p => p.status === 'error');
  if (errorPulses.length === 0) return proposals;

  // Group errors by agent
  const errorsByAgent = new Map<string, Pulse[]>();
  for (const p of errorPulses) {
    const existing = errorsByAgent.get(p.agent) ?? [];
    existing.push(p);
    errorsByAgent.set(p.agent, existing);
  }

  for (const [agent, errors] of errorsByAgent) {
    proposals.push({
      category: 'charter',
      targetFile: `.squad/agents/${agent}/charter.md`,
      title: `Agent "${agent}" encountered ${errors.length} error(s)`,
      description: `Review the agent's charter for missing error handling guidance or unclear task boundaries that could cause failures.`,
      expectedImpact: 'Reduced error rate in future runs.',
      priority: errors.length >= 3 ? 'high' : 'medium',
      evidence: errors.map(e => `Error at ${e.phase} (${e.progressPct}%): ${e.summary}`),
    });
  }

  return proposals;
}

function detectProgressStalls(pulses: readonly Pulse[]): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  // Detect agents whose progress stalled (same progressPct in consecutive pulses)
  const byAgent = new Map<string, Pulse[]>();
  for (const p of pulses) {
    const existing = byAgent.get(p.agent) ?? [];
    existing.push(p);
    byAgent.set(p.agent, existing);
  }

  for (const [agent, agentPulses] of byAgent) {
    if (agentPulses.length < 3) continue;

    let stallCount = 0;
    for (let i = 1; i < agentPulses.length; i++) {
      if (agentPulses[i]?.progressPct === agentPulses[i - 1]?.progressPct) {
        stallCount++;
      }
    }

    if (stallCount >= 2) {
      proposals.push({
        category: 'sdk-config',
        targetFile: 'squad.config.ts',
        title: `Agent "${agent}" progress stalled ${stallCount} times`,
        description: `Agent "${agent}" reported the same progress percentage ${stallCount} times in a row. This may indicate the task was too large for a single agent, or the agent's model tier needs adjustment.`,
        expectedImpact: 'More predictable progress and better task decomposition.',
        priority: 'low',
        evidence: agentPulses.map(p => `${p.phase}: ${p.progressPct}%`),
      });
    }
  }

  return proposals;
}

function detectLongSessions(sessions: readonly SessionSnapshot[]): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  for (const s of sessions) {
    if (s.messageCount > 20) {
      proposals.push({
        category: 'routing',
        targetFile: '.squad/routing.md',
        title: `Agent "${s.agentName}" had an unusually long session (${s.messageCount} messages)`,
        description: `Sessions with more than 20 messages may indicate scope creep or a task that should be split across multiple agents. Consider adding routing rules to decompose large tasks.`,
        expectedImpact: 'Shorter, more focused agent sessions with better context utilization.',
        priority: 'medium',
        evidence: [`${s.messageCount} messages in session for ${s.agentName}`],
      });
    }
  }

  return proposals;
}

function estimateDuration(pulses: readonly Pulse[]): string {
  if (pulses.length < 2) return 'unknown';

  const timestamps = pulses
    .map(p => new Date(p.timestamp).getTime())
    .filter(t => !isNaN(t));

  if (timestamps.length < 2) return 'unknown';

  const minT = Math.min(...timestamps);
  const maxT = Math.max(...timestamps);
  const durationMs = maxT - minT;

  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  if (durationMs < 3_600_000) return `${Math.round(durationMs / 60_000)}m`;
  return `${(durationMs / 3_600_000).toFixed(1)}h`;
}

function buildNarrativeSummary(agents: AgentRunSummary[], metrics: RunAnalysisReport['metrics']): string {
  const lines: string[] = [];

  lines.push(`Run involved ${metrics.totalAgents} agent(s) with ${metrics.totalPulses} pulse(s) and ${metrics.totalMessages} message(s).`);

  if (metrics.durationEstimate !== 'unknown') {
    lines.push(`Estimated duration: ${metrics.durationEstimate}.`);
  }

  const errorAgents = agents.filter(a => a.errorCount > 0);
  const blockedAgents = agents.filter(a => a.blockerCount > 0);
  const completedAgents = agents.filter(a => a.finalPhase === 'done');

  if (completedAgents.length === agents.length) {
    lines.push('All agents completed successfully.');
  } else if (completedAgents.length > 0) {
    lines.push(`${completedAgents.length}/${agents.length} agent(s) completed. Incomplete: ${agents.filter(a => a.finalPhase !== 'done').map(a => a.agentName).join(', ')}.`);
  }

  if (errorAgents.length > 0) {
    lines.push(`Errors reported by: ${errorAgents.map(a => `${a.agentName} (${a.errorCount})`).join(', ')}.`);
  }

  if (blockedAgents.length > 0) {
    lines.push(`Blockers reported by: ${blockedAgents.map(a => `${a.agentName} (${a.blockerCount})`).join(', ')}.`);
  }

  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

/**
 * Analyze a completed run and produce an improvement report.
 *
 * Pure function — takes data in, returns analysis out.
 * No I/O, no side effects, fully deterministic given the same input.
 */
export function analyzeRun(input: RunAnalysisInput): RunAnalysisReport {
  const { pulses, sessions } = input;

  // Collect unique agent names from both sources, excluding SDK internals
  const INTERNAL_PULSE_AGENTS = new Set(['System']);
  const agentNames = new Set<string>();
  for (const p of pulses) {
    if (!INTERNAL_PULSE_AGENTS.has(p.agent)) agentNames.add(p.agent);
  }
  for (const s of sessions) agentNames.add(s.agentName);

  // Build per-agent summaries
  const agents: AgentRunSummary[] = [];
  for (const name of agentNames) {
    const lowerName = name.toLowerCase();
    const session = sessions.find(s => s.agentName.toLowerCase() === lowerName);
    agents.push(summarizeAgent(name, pulses, session));
  }

  // Compute metrics
  const totalErrors = agents.reduce((sum, a) => sum + a.errorCount, 0);
  const totalBlockers = agents.reduce((sum, a) => sum + a.blockerCount, 0);

  const metrics: RunAnalysisReport['metrics'] = {
    totalAgents: agents.length,
    totalPulses: pulses.length,
    totalMessages: sessions.reduce((sum, s) => sum + s.messageCount, 0),
    durationEstimate: estimateDuration(pulses),
    errorRate: pulses.length > 0 ? totalErrors / pulses.length : 0,
    blockerRate: pulses.length > 0 ? totalBlockers / pulses.length : 0,
  };

  // Gather improvement proposals from all detectors
  const proposals: ImprovementProposal[] = [
    ...detectRoutingIssues(sessions, pulses),
    ...detectBlockerPatterns(pulses),
    ...detectErrorPatterns(pulses),
    ...detectProgressStalls(pulses),
    ...detectLongSessions(sessions),
  ];

  // Sort proposals: high → medium → low
  const priorityOrder: Record<ProposalPriority, number> = { high: 0, medium: 1, low: 2 };
  proposals.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const summary = buildNarrativeSummary(agents, metrics);

  return {
    analyzedAt: new Date().toISOString(),
    summary,
    agents,
    proposals,
    metrics,
  };
}

/**
 * Format a RunAnalysisReport as human-readable text for the MCP tool response.
 */
export function formatAnalysisReport(report: RunAnalysisReport): string {
  const lines: string[] = [];

  lines.push('# Run Analysis Report');
  lines.push('');
  lines.push(`_Analyzed at: ${report.analyzedAt}_`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  // Metrics
  lines.push('## Metrics');
  lines.push('');
  lines.push(`- Agents: ${report.metrics.totalAgents}`);
  lines.push(`- Pulses: ${report.metrics.totalPulses}`);
  lines.push(`- Messages: ${report.metrics.totalMessages}`);
  lines.push(`- Duration: ${report.metrics.durationEstimate}`);
  lines.push(`- Error rate: ${(report.metrics.errorRate * 100).toFixed(1)}%`);
  lines.push(`- Blocker rate: ${(report.metrics.blockerRate * 100).toFixed(1)}%`);
  lines.push('');

  // Per-agent breakdown
  lines.push('## Agent Breakdown');
  lines.push('');
  for (const agent of report.agents) {
    const statusIcon = agent.finalStatus === 'error' ? '❌' : agent.finalPhase === 'done' ? '✅' : '⏳';
    lines.push(`### ${statusIcon} ${agent.agentName}`);
    lines.push(`- Phase: ${agent.finalPhase} | Status: ${agent.finalStatus}`);
    lines.push(`- Pulses: ${agent.totalPulses} | Messages: ${agent.messageCount}`);
    lines.push(`- Errors: ${agent.errorCount} | Blockers: ${agent.blockerCount}`);
    if (agent.progressArc.length > 0) {
      lines.push(`- Progress: ${agent.progressArc.join(' → ')}%`);
    }
    lines.push('');
  }

  // Proposals
  if (report.proposals.length > 0) {
    lines.push('## Improvement Proposals');
    lines.push('');
    for (let i = 0; i < report.proposals.length; i++) {
      const p = report.proposals[i]!;
      const priorityLabel = p.priority === 'high' ? '🔴' : p.priority === 'medium' ? '🟡' : '🟢';
      lines.push(`### ${i + 1}. ${priorityLabel} ${p.title}`);
      lines.push(`- **Category:** ${p.category}`);
      lines.push(`- **Target:** \`${p.targetFile}\``);
      lines.push(`- **Priority:** ${p.priority}`);
      lines.push(`- **Description:** ${p.description}`);
      lines.push(`- **Expected impact:** ${p.expectedImpact}`);
      if (p.evidence.length > 0) {
        lines.push('- **Evidence:**');
        for (const e of p.evidence) {
          lines.push(`  - ${e}`);
        }
      }
      lines.push('');
    }
  } else {
    lines.push('## Improvement Proposals');
    lines.push('');
    lines.push('No issues detected. The run completed cleanly.');
    lines.push('');
  }

  return lines.join('\n');
}
