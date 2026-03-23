/**
 * Routing Parser — Parses Coordinator responses and generates implementation phases.
 *
 * Supports two formats:
 * 1. Single-agent: {"implementer": "name", "reviewer": "name", "architect": null}
 * 2. Multi-subtask: {"subtasks": [{"agent": "name", "task": "desc"}, ...], "reviewer": "name"}
 *
 * The multi-subtask format generates parallel implement phases (implement-0, implement-1, ...)
 * with no dependencies between them, plus a single review phase that depends on all of them.
 */

import type { PhaseDefinition } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SubtaskEntry {
  agent: string;
  task: string;
}

export type RoutingDecision =
  | { kind: 'single'; implementer: string; reviewer: string }
  | { kind: 'multi'; subtasks: SubtaskEntry[]; reviewer: string };

export interface PhaseGeneratorOptions {
  /** The original user message / task description */
  message: string;
  /** Additional context addendum (e.g., from context files) */
  contextAddendum: string;
  /**
   * Called to check if an agent has emitted a "done" pulse.
   * Used in gate validation. Return true if the agent's done pulse exists.
   */
  hasDonePulse: (agentName: string) => boolean;
  /**
   * Sentinel string for tool-call placeholder responses.
   * Outputs matching this string are not considered substantial.
   */
  toolCallPlaceholder: string;
  /** Per-phase timeout in ms (default: 300_000) */
  timeout?: number;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Validate whether a Coordinator response string is a valid routing decision.
 * Accepts both single-agent and multi-subtask formats.
 */
export function isValidRoutingResponse(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  try {
    const parsed = JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] ?? '');
    // Single-agent format
    if (parsed.implementer && parsed.reviewer) return true;
    // Multi-subtask format
    if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0 && parsed.reviewer) {
      return parsed.subtasks.every((s: Record<string, unknown>) => s.agent && s.task);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse a Coordinator response string into a typed RoutingDecision.
 * Returns null if the response is not valid.
 */
export function parseRoutingDecision(output: string): RoutingDecision | null {
  try {
    const jsonStr = output.match(/\{[\s\S]*\}/)?.[0] ?? '';
    const parsed = JSON.parse(jsonStr);

    if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0 && parsed.reviewer) {
      return {
        kind: 'multi',
        subtasks: parsed.subtasks.map((s: Record<string, unknown>) => ({
          agent: String(s.agent).toLowerCase(),
          task: String(s.task),
        })),
        reviewer: String(parsed.reviewer).toLowerCase(),
      };
    }

    if (parsed.implementer && parsed.reviewer) {
      return {
        kind: 'single',
        implementer: String(parsed.implementer).toLowerCase(),
        reviewer: String(parsed.reviewer).toLowerCase(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Phase Generation ───────────────────────────────────────────────────────

/**
 * Generate implementation + review phases from a routing decision.
 *
 * Single-agent decisions produce:
 *   implement → review
 *
 * Multi-subtask decisions produce:
 *   implement-0, implement-1, ... (parallel) → review (depends on all)
 */
export function generateImplPhases(
  decision: RoutingDecision,
  opts: PhaseGeneratorOptions,
): PhaseDefinition[] {
  const timeout = opts.timeout ?? 300_000;
  const phases: PhaseDefinition[] = [];

  if (decision.kind === 'single') {
    const implName = decision.implementer;
    const revName = decision.reviewer;

    phases.push({
      id: 'implement',
      agent: implName,
      task: [
        `Implement the following request:`,
        `${opts.message}${opts.contextAddendum}`,
        '',
        'Write code, add tests, and verify the build passes.',
        'Use squad_pulse to report progress at milestones.',
        'When done, emit squad_pulse with phase "done" listing the files you created or modified.',
      ].join('\n'),
      gate: {
        validate: (o: unknown) => {
          if (typeof o === 'string' && o !== opts.toolCallPlaceholder && o.length > 50) return true;
          return opts.hasDonePulse(implName);
        },
        description: 'Implementer must produce substantial output or emit a done pulse',
      },
      timeout,
    });

    phases.push({
      id: 'review',
      agent: revName,
      task: [
        `Review the implementation for: ${opts.message}`,
        '',
        `Use squad_read_session to read ${implName}'s session and see what was built.`,
        'Check: code quality, test coverage, pattern consistency, type safety.',
        'Emit squad_pulse with phase "done" if approved or "blocked" with specific issues.',
      ].join('\n'),
      dependsOn: ['implement'],
      gate: {
        validate: (o: unknown) => {
          if (typeof o === 'string' && o !== opts.toolCallPlaceholder && o.length > 20) return true;
          return opts.hasDonePulse(revName);
        },
        description: 'Reviewer must produce a substantive review or emit a done pulse',
      },
      timeout,
    });
  } else {
    // Multi-subtask: parallel implement phases + single review phase
    const implementPhaseIds: string[] = [];
    const subtaskAgents: string[] = [];

    for (let i = 0; i < decision.subtasks.length; i++) {
      const subtask = decision.subtasks[i]!;
      const phaseId = `implement-${i}`;
      implementPhaseIds.push(phaseId);
      subtaskAgents.push(subtask.agent);

      phases.push({
        id: phaseId,
        agent: subtask.agent,
        // No dependsOn between implement phases — they run in parallel
        task: [
          `Implement the following subtask:`,
          `${subtask.task}`,
          '',
          `This is part of a larger task: ${opts.message}${opts.contextAddendum}`,
          '',
          `You are working in parallel with other agents. Use squad_scratchpad_write to coordinate shared state.`,
          `Avoid modifying files that other agents may also be editing.`,
          '',
          'Write code, add tests, and verify the build passes.',
          'Use squad_pulse to report progress at milestones.',
          'When done, emit squad_pulse with phase "done" listing the files you created or modified.',
        ].join('\n'),
        gate: {
          validate: ((agentName: string) => (o: unknown) => {
            if (typeof o === 'string' && o !== opts.toolCallPlaceholder && o.length > 50) return true;
            return opts.hasDonePulse(agentName);
          })(subtask.agent),
          description: `Subtask implementer (${subtask.agent}) must produce substantial output or emit a done pulse`,
        },
        timeout,
      });
    }

    // Review phase depends on ALL implement phases
    const sessionReadInstructions = subtaskAgents
      .map(a => `- Use squad_read_session to read ${a}'s session`)
      .join('\n');

    const revName = decision.reviewer;
    phases.push({
      id: 'review',
      agent: revName,
      task: [
        `Review the parallel implementation for: ${opts.message}`,
        '',
        `${subtaskAgents.length} agents worked in parallel on subtasks:`,
        ...decision.subtasks.map(s => `- ${s.agent}: ${s.task}`),
        '',
        sessionReadInstructions,
        '',
        'Check: code quality, test coverage, pattern consistency, type safety.',
        'IMPORTANT: Check for file conflicts between parallel agents — look for overlapping edits to the same files.',
        'Emit squad_pulse with phase "done" if approved or "blocked" with specific issues.',
      ].join('\n'),
      dependsOn: implementPhaseIds,
      gate: {
        validate: (o: unknown) => {
          if (typeof o === 'string' && o !== opts.toolCallPlaceholder && o.length > 20) return true;
          return opts.hasDonePulse(revName);
        },
        description: 'Reviewer must produce a substantive review or emit a done pulse',
      },
      timeout,
    });
  }

  return phases;
}
