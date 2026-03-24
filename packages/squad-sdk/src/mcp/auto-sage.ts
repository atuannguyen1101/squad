// Auto-Sage trigger — runs after pipeline completion when autoAnalyze is enabled
/**
 * Auto-Sage — Post-pipeline automatic Sage analysis trigger.
 *
 * After a squad_run pipeline completes, this module:
 * 1. Gathers pulse history and session snapshots
 * 2. Runs the analysis engine (analyzeRun)
 * 3. Dispatches the formatted report to Sage for interpretation
 * 4. Emits a pulse with Sage's analysis results
 *
 * The auto-trigger runs as fire-and-forget post-processing — it does NOT
 * block the "Pipeline complete" pulse or the pipeline's .finally() cleanup.
 */

import { analyzeRun, formatAnalysisReport, type SessionSnapshot } from './analyze-run.js';
import { createPulse, type PulseCollector } from '../pulse/index.js';
import type { Pulse } from '../pulse/pulse.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AutoSageDeps {
  /** Pulse collector for reading pulse history and recording new pulses. */
  pulseCollector: PulseCollector;
  /** Function to list active sessions — returns array of { agentName }. */
  listActiveSessions: () => Array<{ agentName: string }>;
  /** Function to get messages for a specific agent session. */
  getMessages: (agentName: string) => Array<{ role: string; content: string; timestamp: string }>;
  /** Dispatch a message to an agent and get a response. */
  dispatch: (agentName: string, message: string, context?: string) => Promise<{ response?: string }>;
  /** Squad root directory path (for analysis context). */
  squadRoot: string;
}

export interface AutoSageResult {
  /** The formatted analysis report sent to Sage. */
  report: string;
  /** Sage's interpretation/response, if any. */
  sageResponse: string | null;
  /** Whether the analysis was successfully dispatched to Sage. */
  dispatched: boolean;
}

// ─── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Collect session snapshots from active sessions.
 * Truncates long messages to keep payloads manageable.
 */
export function collectSessionSnapshots(deps: Pick<AutoSageDeps, 'listActiveSessions' | 'getMessages'>): SessionSnapshot[] {
  const activeSessions = deps.listActiveSessions();
  return activeSessions.map(info => {
    const messages = deps.getMessages(info.agentName);
    return {
      agentName: info.agentName,
      messageCount: messages.length,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content.length > 2000 ? m.content.slice(0, 2000) + '…(truncated)' : m.content,
        timestamp: m.timestamp,
      })),
    };
  });
}

/**
 * Build the analysis report from current pulse history and sessions.
 * Returns the formatted report string, or null if there's no data to analyze.
 */
export function buildAnalysisReport(
  pulses: readonly Pulse[],
  sessions: readonly SessionSnapshot[],
  squadRoot: string,
): string | null {
  if (pulses.length === 0 && sessions.length === 0) {
    return null;
  }

  const report = analyzeRun({ pulses, sessions, squadRoot });
  return formatAnalysisReport(report);
}

/**
 * Run the full auto-Sage analysis pipeline:
 * 1. Collect pulse history and session snapshots
 * 2. Generate analysis report
 * 3. Dispatch to Sage with the report
 * 4. Emit a pulse with Sage's response
 *
 * This function is designed to be called fire-and-forget after
 * the main pipeline emits its "done" pulse.
 */
export async function triggerAutoSageAnalysis(deps: AutoSageDeps): Promise<AutoSageResult> {
  // 1. Gather data
  const pulses = [...deps.pulseCollector.getAll()];
  const sessions = collectSessionSnapshots(deps);

  // 2. Build report
  const report = buildAnalysisReport(pulses, sessions, deps.squadRoot);
  if (!report) {
    return { report: '', sageResponse: null, dispatched: false };
  }

  // 3. Dispatch to Sage
  let sageResponse: string | null = null;
  let dispatched = false;

  try {
    const sageTask = [
      'Analyze this completed Squad run report and provide your interpretation.',
      'Focus on: improvement proposals, pattern observations, and actionable recommendations.',
      'Use squad_proposals (operation: "create") to write improvement proposals.',
      'Use squad_decide to record any decisions, and squad_memory to save learnings.',
      '',
      '--- Analysis Report ---',
      report,
    ].join('\n');

    const result = await deps.dispatch('sage', sageTask);
    sageResponse = result.response ?? null;
    dispatched = true;
  } catch {
    // Sage dispatch failed — record the error but don't crash
    dispatched = false;
  }

  // 4. Emit pulse with results — include Sage's actual findings so squad_wait surfaces them
  const sageSummary = sageResponse
    ? truncateSageResponse(sageResponse)
    : 'Sage dispatch failed — no analysis available.';

  deps.pulseCollector.record(createPulse({
    agent: 'sage',
    phase: dispatched ? 'done' : 'blocked',
    status: dispatched ? 'ok' : 'warning',
    progressPct: 100,
    summary: dispatched
      ? `Post-run analysis:\n${sageSummary}`
      : 'Auto-analysis report generated but Sage dispatch failed.',
    blockers: dispatched ? [] : ['Sage dispatch failed'],
    questionsForUser: [],
    artifacts: [],
    nextStep: '',
  }));

  return { report, sageResponse, dispatched };
}

/**
 * Truncate Sage's response to fit in a pulse summary.
 * Keeps the first ~500 chars to surface key findings without overwhelming.
 */
function truncateSageResponse(response: string): string {
  const maxLength = 500;
  if (response.length <= maxLength) return response;
  return response.slice(0, maxLength) + '\n...(use squad_analyze_run for full report)';
}
