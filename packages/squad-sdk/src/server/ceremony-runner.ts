/**
 * Ceremony Runner — Executes ceremony content when triggered.
 *
 * Replaces the simple dispatch in CeremonyTriggerEngine.fireCeremony()
 * with structured retrospective execution:
 *   1. Collect ceremony inputs (pulses, proposals, session summaries)
 *   2. Format structured prompt for each participant
 *   3. Dispatch with role-appropriate context
 *   4. Save ceremony output to `.squad/ceremonies/retros/{timestamp}.md`
 *
 * Designed to work with the Proposal Pipeline — retrospectives review
 * which proposals were applied and their effectiveness.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CeremonyConfig } from '../config/schema.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CeremonyType = 'retrospective' | 'custom';

export interface CeremonyConfigExtended extends CeremonyConfig {
  /** Ceremony type — determines the runner behavior. Defaults to 'custom'. */
  type?: CeremonyType;
  /** Trigger condition: 'all-sessions-closed' | 'pipeline-idle' | 'manual'. */
  trigger?: 'all-sessions-closed' | 'pipeline-idle' | 'manual';
  /** Idle timeout in milliseconds (for pipeline-idle trigger). */
  idleTimeoutMs?: number;
}

/**
 * Minimal pulse shape for ceremony inputs.
 * Matches the Pulse interface from pulse/pulse.ts without importing compiled code.
 */
export interface CeremonyPulse {
  agent: string;
  phase: string;
  status: string;
  progressPct: number;
  summary: string;
  blockers: string[];
  questionsForUser: string[];
  artifacts: string[];
  nextStep: string;
  timestamp: string;
}

/**
 * Summary of an applied proposal for retrospective review.
 */
export interface AppliedProposalSummary {
  id: string;
  title: string;
  category: string;
  targetFile: string;
  appliedAt: string;
  effective?: boolean;
}

/**
 * Context passed to the CeremonyRunner when a ceremony fires.
 */
export interface CeremonyContext {
  /** Which trigger caused this ceremony to fire. */
  trigger: 'all-sessions-closed' | 'pipeline-idle' | 'manual';
  /** Timestamp when the trigger fired. */
  triggeredAt: string;
  /** All pulses recorded during the run. */
  pulses: readonly CeremonyPulse[];
  /** Summary of proposals applied during this run (from proposal pipeline). */
  appliedProposals: readonly AppliedProposalSummary[];
  /** Error summaries from the run. */
  errors: string[];
  /** Blocker summaries from the run. */
  blockers: string[];
}

/**
 * Result of running a ceremony.
 */
export interface CeremonyResult {
  /** Ceremony name. */
  ceremonyName: string;
  /** Whether the ceremony executed successfully. */
  success: boolean;
  /** Participants who were dispatched to. */
  participantsDispatched: string[];
  /** Participants who failed to receive dispatch. */
  participantsFailed: string[];
  /** Path to the saved ceremony report, if any. */
  reportPath?: string;
  /** Error message if the ceremony failed entirely. */
  error?: string;
}

/** Function that dispatches a message to a named agent. */
export type CeremonyDispatchFn = (
  agentName: string,
  message: string,
  context?: string,
) => Promise<{ response?: string }>;

// ─── Retrospective Template ─────────────────────────────────────────────────

/**
 * Build a structured retrospective prompt from ceremony context.
 *
 * The retrospective follows the classic format:
 *   - What went well?
 *   - What didn't go well?
 *   - What should we change?
 *
 * Enhanced with pipeline data (applied proposals, effectiveness, errors).
 */
export function buildRetrospectivePrompt(
  ceremony: CeremonyConfigExtended,
  context: CeremonyContext,
): string {
  const sections: string[] = [];

  sections.push(`# Retrospective: ${ceremony.name}`);
  sections.push('');
  sections.push(`Triggered by: ${context.trigger} at ${context.triggeredAt}`);
  sections.push('');

  // Custom agenda if provided
  if (ceremony.agenda) {
    sections.push('## Agenda');
    sections.push('');
    sections.push(ceremony.agenda);
    sections.push('');
  }

  // Default retrospective structure
  sections.push('## Discussion Framework');
  sections.push('');
  sections.push('### What went well?');
  sections.push('Review the pulse history and identify successful patterns.');
  sections.push('');
  sections.push('### What didn\'t go well?');
  sections.push('Review errors, blockers, and stalled progress.');
  sections.push('');
  sections.push('### What should we change?');
  sections.push('Review applied proposals and their effectiveness. Suggest new improvements.');
  sections.push('');

  // Pipeline data: pulse summary
  if (context.pulses.length > 0) {
    sections.push('## Run Summary');
    sections.push('');

    const agents = new Set(context.pulses.map(p => p.agent));
    const donePulses = context.pulses.filter(p => p.phase === 'done');
    const errorPulses = context.pulses.filter(p => p.status === 'error');

    sections.push(`- **Agents active:** ${agents.size} (${[...agents].join(', ')})`);
    sections.push(`- **Total pulses:** ${context.pulses.length}`);
    sections.push(`- **Completed:** ${donePulses.length}`);
    sections.push(`- **Errors:** ${errorPulses.length}`);
    sections.push('');
  }

  // Errors and blockers
  if (context.errors.length > 0) {
    sections.push('## Errors Encountered');
    sections.push('');
    for (const error of context.errors) {
      sections.push(`- ${error}`);
    }
    sections.push('');
  }

  if (context.blockers.length > 0) {
    sections.push('## Blockers');
    sections.push('');
    for (const blocker of context.blockers) {
      sections.push(`- ${blocker}`);
    }
    sections.push('');
  }

  // Applied proposals and effectiveness
  if (context.appliedProposals.length > 0) {
    sections.push('## Applied Proposals');
    sections.push('');
    for (const ap of context.appliedProposals) {
      const effectivenessLabel = ap.effective === true
        ? '✅ Effective'
        : ap.effective === false
          ? '❌ Same issue recurred'
          : '⏳ Not yet checked';
      sections.push(`- **${ap.title}** (${ap.category} → ${ap.targetFile})`);
      sections.push(`  Applied: ${ap.appliedAt} | ${effectivenessLabel}`);
    }
    sections.push('');
  }

  sections.push('## Your Task');
  sections.push('');
  sections.push('Based on the data above, provide a structured retrospective:');
  sections.push('1. Identify 1-3 things that went well (with evidence from pulses)');
  sections.push('2. Identify 1-3 things that need improvement (with evidence)');
  sections.push('3. Propose concrete changes using `squad_proposals` (operation: "create")');
  sections.push('4. Record key learnings using `squad_memory`');
  sections.push('');

  return sections.join('\n');
}

// ─── Ceremony Report ────────────────────────────────────────────────────────

/**
 * Format a ceremony report for persistence.
 */
export function formatCeremonyReport(
  ceremony: CeremonyConfigExtended,
  context: CeremonyContext,
  result: CeremonyResult,
  participantResponses: Map<string, string>,
): string {
  const sections: string[] = [];

  sections.push(`# Ceremony Report: ${ceremony.name}`);
  sections.push('');
  sections.push(`**Trigger:** ${context.trigger}`);
  sections.push(`**Triggered at:** ${context.triggeredAt}`);
  sections.push(`**Participants dispatched:** ${result.participantsDispatched.join(', ') || 'none'}`);
  if (result.participantsFailed.length > 0) {
    sections.push(`**Failed dispatches:** ${result.participantsFailed.join(', ')}`);
  }
  sections.push('');

  // Participant responses
  for (const [participant, response] of participantResponses) {
    sections.push(`## ${participant}`);
    sections.push('');
    sections.push(response);
    sections.push('');
  }

  // Run metrics summary
  if (context.pulses.length > 0) {
    sections.push('## Run Metrics');
    sections.push('');
    sections.push(`- Total pulses: ${context.pulses.length}`);
    sections.push(`- Errors: ${context.errors.length}`);
    sections.push(`- Blockers: ${context.blockers.length}`);
    sections.push(`- Applied proposals: ${context.appliedProposals.length}`);
    sections.push('');
  }

  return sections.join('\n') + '\n';
}

/**
 * Save a ceremony report to `.squad/ceremonies/retros/{timestamp}.md`.
 */
export function saveCeremonyReport(
  squadRoot: string,
  ceremony: CeremonyConfigExtended,
  report: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = ceremony.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const retroDir = path.join(squadRoot, '.squad', 'ceremonies', 'retros');
  fs.mkdirSync(retroDir, { recursive: true });

  const filename = `${timestamp}-${slug}.md`;
  const filePath = path.join(retroDir, filename);
  fs.writeFileSync(filePath, report, 'utf-8');

  return filePath;
}

// ─── CeremonyRunner ─────────────────────────────────────────────────────────

/**
 * CeremonyRunner — Executes ceremony content when triggered.
 *
 * Replaces the simple agenda dispatch with structured ceremony execution:
 *   1. Builds role-appropriate prompts based on ceremony type
 *   2. Dispatches to each participant with full context
 *   3. Collects responses
 *   4. Saves structured ceremony report
 *
 * For retrospective ceremonies, uses the built-in retrospective template.
 * For custom ceremonies, uses the provided agenda string.
 */
export class CeremonyRunner {
  private readonly squadRoot: string;
  private readonly dispatch: CeremonyDispatchFn;

  constructor(squadRoot: string, dispatch: CeremonyDispatchFn) {
    this.squadRoot = squadRoot;
    this.dispatch = dispatch;
  }

  /**
   * Run a ceremony with the given context.
   */
  async run(
    ceremony: CeremonyConfigExtended,
    context: CeremonyContext,
  ): Promise<CeremonyResult> {
    const participants = ceremony.participants ?? [];
    const ceremonyType = ceremony.type ?? 'custom';

    // Build the prompt based on ceremony type
    const prompt = ceremonyType === 'retrospective'
      ? buildRetrospectivePrompt(ceremony, context)
      : ceremony.agenda ?? `Run ${ceremony.name} ceremony`;

    // Dispatch to each participant
    const dispatched: string[] = [];
    const failed: string[] = [];
    const responses = new Map<string, string>();

    for (const participant of participants) {
      const name = participant.replace(/^@/, '');
      try {
        const result = await this.dispatch(name, prompt, `Ceremony: ${ceremony.name}`);
        dispatched.push(name);
        if (result.response) {
          responses.set(name, result.response);
        }
      } catch (err) {
        failed.push(name);
        process.stderr.write(
          `[ceremony-runner] Failed to dispatch ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // Save ceremony report
    let reportPath: string | undefined;
    try {
      const report = formatCeremonyReport(ceremony, context, {
        ceremonyName: ceremony.name,
        success: dispatched.length > 0,
        participantsDispatched: dispatched,
        participantsFailed: failed,
      }, responses);
      reportPath = saveCeremonyReport(this.squadRoot, ceremony, report);
    } catch (err) {
      process.stderr.write(
        `[ceremony-runner] Failed to save report: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    return {
      ceremonyName: ceremony.name,
      success: dispatched.length > 0 || participants.length === 0,
      participantsDispatched: dispatched,
      participantsFailed: failed,
      reportPath,
    };
  }
}

// ─── Context Builder ────────────────────────────────────────────────────────

/**
 * Build a CeremonyContext from available pipeline data.
 */
export function buildCeremonyContext(
  trigger: CeremonyContext['trigger'],
  pulses: readonly CeremonyPulse[],
  appliedProposals?: readonly AppliedProposalSummary[],
): CeremonyContext {
  const errors: string[] = [];
  const blockers: string[] = [];

  for (const pulse of pulses) {
    if (pulse.status === 'error') {
      errors.push(`[${pulse.agent}] ${pulse.summary}`);
    }
    for (const blocker of pulse.blockers) {
      blockers.push(`[${pulse.agent}] ${blocker}`);
    }
  }

  return {
    trigger,
    triggeredAt: new Date().toISOString(),
    pulses,
    appliedProposals: appliedProposals ?? [],
    errors,
    blockers,
  };
}

// ─── Manual Trigger API ─────────────────────────────────────────────────────

/**
 * Manually trigger a ceremony by name.
 *
 * This function is designed to be called from the CLI/REPL:
 *   ```
 *   await triggerCeremonyManually(runner, ceremony, pulses);
 *   ```
 */
export async function triggerCeremonyManually(
  runner: CeremonyRunner,
  ceremony: CeremonyConfigExtended,
  pulses: readonly CeremonyPulse[] = [],
  appliedProposals: readonly AppliedProposalSummary[] = [],
): Promise<CeremonyResult> {
  const context = buildCeremonyContext('manual', pulses, appliedProposals);
  return runner.run(ceremony, context);
}
