/**
 * Routing Parser — Parses Coordinator responses and generates implementation phases.
 *
 * Supports two formats:
 * 1. Single-agent: {"implementer": "name", "reviewer": "name"} or {"implementer": "name", "reviewer": null}
 * 2. Multi-subtask: {"subtasks": [{"agent": "name", "task": "desc"}, ...], "reviewer": "name"} or with reviewer: null
 *
 * Reviewer is optional. When reviewer is null, only implementation phases are generated.
 * The multi-subtask format generates parallel implement phases (implement-0, implement-1, ...)
 * with no dependencies between them, plus an optional review phase if reviewer is present.
 */

import type { PhaseDefinition } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SubtaskEntry {
  agent: string;
  task: string;
}

export type RoutingDecision =
  | { kind: 'single'; implementer: string; reviewer: string | null }
  | { kind: 'multi'; subtasks: SubtaskEntry[]; reviewer: string | null };

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
   * Called to check if an agent's role is planner/lead/orchestrator.
   * Used for gate validation. Return true if the agent produces planning output, not code.
   */
  isPlannerRole?: (agentName: string) => boolean;
  /**
   * Called to check if an agent's role is doc writer (DevRel, technical writer, etc.).
   * Used for gate validation. Return true if the agent produces documentation, not code.
   */
  isDocWriterRole?: (agentName: string) => boolean;
  /**
   * Called to verify that claimed file changes actually exist.
   * Used for gate validation. Returns true if file content matches agent's claims.
   * If not provided, file verification is skipped.
   */
  verifyFileChanges?: (agentName: string, output: string) => Promise<boolean> | boolean;
  /**
   * Sentinel string for tool-call placeholder responses.
   * Outputs matching this string are not considered substantial.
   */
  toolCallPlaceholder: string;
  /** Per-phase timeout in ms (default: 300_000) */
  timeout?: number;
  /**
   * Whether this is "throwaway work" (no git commits).
   * Quality gates remain mandatory regardless of this flag.
   * Only affects git operations (commit, PR, ADO creation).
   */
  isThrowawayWork?: boolean;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Extract JSON from markdown code blocks or surrounding prose.
 * Returns the extracted JSON string or null if no JSON found.
 */
function extractJSON(text: string): string | null {
  // Try markdown code block first (```json ... ``` or ``` ... ```)
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1];
  }

  // Try bare JSON object
  const bareMatch = text.match(/\{[\s\S]*\}/);
  if (bareMatch?.[0]) {
    return bareMatch[0];
  }

  return null;
}

/**
 * Validate whether a Coordinator response string is a valid routing decision.
 * Accepts both single-agent and multi-subtask formats.
 * Reviewer is optional for simple tasks — implementer-only routing is valid.
 * 
 * Resilient parsing: extracts JSON from markdown code blocks, ignores surrounding prose.
 */
export function isValidRoutingResponse(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  
  const jsonStr = extractJSON(output);
  if (!jsonStr) return false;

  try {
    const parsed = JSON.parse(jsonStr);
    // Reject if coordinator picked itself as implementer
    if (parsed.implementer?.toLowerCase() === 'coordinator') return false;
    // Single-agent format: implementer required, reviewer optional
    if (parsed.implementer) return true;
    // Multi-subtask format: subtasks required, reviewer optional
    if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
      // Reject if any subtask is assigned to coordinator
      if (parsed.subtasks.some((s: Record<string, unknown>) => (s.agent as string)?.toLowerCase() === 'coordinator')) return false;
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
 * Reviewer is optional — if not present or null, no review phase will be generated.
 * 
 * Resilient parsing: extracts JSON from markdown code blocks, ignores surrounding prose.
 */
export function parseRoutingDecision(output: string): RoutingDecision | null {
  // Infrastructure agents that must never be routed as implementers or reviewers.
  // These agents have special roles in the pipeline (routing, understanding, analysis)
  // and get unrestricted VS Code tools when used as implementers — bypassing our
  // tool restrictions since Copilot injects file/terminal tools at the session level.
  const FORBIDDEN_IMPLEMENTERS = new Set(['coordinator', 'ben', 'sage', 'scribe']);

  const jsonStr = extractJSON(output);
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);

    if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
      const subtasks = parsed.subtasks
        .map((s: Record<string, unknown>) => ({
          agent: String(s.agent).toLowerCase(),
          task: String(s.task),
        }))
        .filter((s: { agent: string }) => !FORBIDDEN_IMPLEMENTERS.has(s.agent));

      if (subtasks.length === 0) return null; // All subtasks were forbidden agents

      const reviewer = parsed.reviewer ? String(parsed.reviewer).toLowerCase() : null;
      return {
        kind: 'multi',
        subtasks,
        reviewer: reviewer && !FORBIDDEN_IMPLEMENTERS.has(reviewer) ? reviewer : null,
      };
    }

    if (parsed.implementer) {
      const implementer = String(parsed.implementer).toLowerCase();
      if (FORBIDDEN_IMPLEMENTERS.has(implementer)) {
        process.stderr.write(`[squad] Routing rejected: coordinator tried to route to forbidden agent "${implementer}"\n`);
        return null; // Force re-route or fallback
      }

      const reviewer = parsed.reviewer ? String(parsed.reviewer).toLowerCase() : null;
      return {
        kind: 'single',
        implementer,
        reviewer: reviewer && !FORBIDDEN_IMPLEMENTERS.has(reviewer) ? reviewer : null,
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
 *   - implement only (if reviewer is null)
 *   - implement → review (if reviewer is present)
 *
 * Multi-subtask decisions produce:
 *   - implement-0, implement-1, ... (parallel) only (if reviewer is null)
 *   - implement-0, implement-1, ... (parallel) → review (if reviewer is present)
 * 
 * IMPORTANT: Review phases ARE created when a reviewer is specified. The review
 * phase will be executed after all implementation phases complete. The reviewer
 * is instructed to use squad_read_session to inspect the implementer's work.
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
        'IMPORTANT QUALITY REQUIREMENTS (always mandatory):',
        '- Read and understand all relevant sections before making changes',
        '- Verify the build passes after your changes',
        '- Test your changes to confirm they work',
        '- Document your changes clearly',
        '',
        opts.isThrowawayWork 
          ? '⚠️ THROWAWAY MODE: Do NOT commit to git, do NOT create PR or ADO items. This is a test/performance run.'
          : 'After completing the work, commit your changes to git if appropriate.',
        '',
        'Write code, add tests, and verify the build passes.',
        'Use squad_pulse to report progress at milestones.',
        'When done, emit squad_pulse with phase "done" listing the files you created or modified.',
      ].join('\n'),
      gate: {
        validate: async (o: unknown) => {
          // GATE FALLBACK CASCADE (resilient to missing pulses):
          // 1. Agent emitted "done" pulse? → Pass
          if (opts.hasDonePulse(implName)) return true;
          
          // 2. Agent produced non-empty assistant response? → Pass (fallback for agents that don't emit pulses)
          if (typeof o === 'string' && o !== opts.toolCallPlaceholder && o.trim().length > 0) {
            // Check if this is a planner/lead/orchestrator role - accept planning output
            const isPlanner = opts.isPlannerRole?.(implName) ?? false;
            if (isPlanner && o.length > 50) {
              return true;
            }
            
            // Check if this is a doc writer role - accept documentation output without code verification
            const isDocWriter = opts.isDocWriterRole?.(implName) ?? false;
            if (isDocWriter && o.length > 50) {
              return true;
            }
            
            // For code implementers, require substantial output (code/files) and verify changes
            if (!isPlanner && !isDocWriter && o.length > 50) {
              // Bug 5 fix: Verify file changes if agent claims changes
              if (opts.verifyFileChanges && o.match(/(?:fixed|changed|updated|modified|created|added|wrote)\s+.+?\.(ts|js|json|md|tsx|jsx|py|go|java|cs)/i)) {
                const verified = await opts.verifyFileChanges(implName, o);
                if (!verified) {
                  return false; // Agent claimed changes but verification failed
                }
              }
              return true;
            }
            
            // Non-empty response but doesn't meet role-specific criteria - still pass (lenient fallback)
            return o.length > 20;
          }
          
          // 3. No pulse + no response (or empty/placeholder) → Reject
          return false;
        },
        description: 'Implementer must emit a done pulse OR produce non-empty output. Code changes must be verified if claimed.',
      },
      timeout,
    });

    // Only add review phase if reviewer is present
    if (revName) {
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
        continueOnPartialFailure: false, // Single implementer - require it to succeed
        gate: {
          validate: (o: unknown) => {
            // GATE FALLBACK CASCADE for review:
            // 1. Agent emitted "done" pulse? → Pass
            if (opts.hasDonePulse(revName)) return true;
            // 2. Agent produced non-empty review? → Pass
            if (typeof o === 'string' && o !== opts.toolCallPlaceholder && o.trim().length > 20) return true;
            // 3. No pulse + no review → Reject
            return false;
          },
          description: 'Reviewer must emit a done pulse OR produce substantive review',
        },
        timeout,
      });
    }
  } else {
    // Multi-subtask: parallel implement phases + optional review phase
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
          'IMPORTANT QUALITY REQUIREMENTS (always mandatory):',
          '- Read and understand all relevant sections before making changes',
          '- Verify the build passes after your changes',
          '- Test your changes to confirm they work',
          '- Document your changes clearly',
          '',
          opts.isThrowawayWork 
            ? '⚠️ THROWAWAY MODE: Do NOT commit to git, do NOT create PR or ADO items. This is a test/performance run.'
            : 'After completing the work, commit your changes to git if appropriate.',
          '',
          'Write code, add tests, and verify the build passes.',
          'Use squad_pulse to report progress at milestones.',
          'When done, emit squad_pulse with phase "done" listing the files you created or modified.',
        ].join('\n'),
        gate: {
          validate: ((agentName: string) => async (o: unknown) => {
            // GATE FALLBACK CASCADE (resilient to missing pulses):
            // 1. Agent emitted "done" pulse? → Pass
            if (opts.hasDonePulse(agentName)) return true;
            
            // 2. Agent produced non-empty assistant response? → Pass (fallback for agents that don't emit pulses)
            if (typeof o === 'string' && o !== opts.toolCallPlaceholder && o.trim().length > 0) {
              // Check if this is a planner/lead/orchestrator role - accept planning output
              const isPlanner = opts.isPlannerRole?.(agentName) ?? false;
              if (isPlanner && o.length > 50) {
                return true;
              }
              
              // Check if this is a doc writer role - accept documentation output without code verification
              const isDocWriter = opts.isDocWriterRole?.(agentName) ?? false;
              if (isDocWriter && o.length > 50) {
                return true;
              }
              
              // For code implementers, require substantial output (code/files) and verify changes
              if (!isPlanner && !isDocWriter && o.length > 50) {
                // Bug 5 fix: Verify file changes if agent claims changes
                if (opts.verifyFileChanges && o.match(/(?:fixed|changed|updated|modified|created|added|wrote)\s+.+?\.(ts|js|json|md|tsx|jsx|py|go|java|cs)/i)) {
                  const verified = await opts.verifyFileChanges(agentName, o);
                  if (!verified) {
                    return false; // Agent claimed changes but verification failed
                  }
                }
                return true;
              }
              
              // Non-empty response but doesn't meet role-specific criteria - still pass (lenient fallback)
              return o.length > 20;
            }
            
            // 3. No pulse + no response (or empty/placeholder) → Reject
            return false;
          })(subtask.agent),
          description: `Subtask implementer (${subtask.agent}) must emit a done pulse OR produce non-empty output. Code changes must be verified if claimed.`,
        },
        timeout,
      });
    }

    // Only add review phase if reviewer is present
    const revName = decision.reviewer;
    if (revName) {
      const sessionReadInstructions = subtaskAgents
        .map(a => `- Use squad_read_session to read ${a}'s session`)
        .join('\n');

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
          'NOTE: Some subtasks may have failed. Review the work that was completed.',
          'Check: code quality, test coverage, pattern consistency, type safety.',
          'IMPORTANT: Check for file conflicts between parallel agents — look for overlapping edits to the same files.',
          'Emit squad_pulse with phase "done" if approved or "blocked" with specific issues.',
        ].join('\n'),
        dependsOn: implementPhaseIds,
        continueOnPartialFailure: true, // Continue review even if some subtasks failed
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
  }

  return phases;
}
