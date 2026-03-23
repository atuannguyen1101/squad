/**
 * Retrospective Ceremony — Built-in ceremony implementation.
 *
 * Provides a ready-to-use retrospective ceremony configuration
 * and helper functions for creating retrospective-type ceremonies.
 *
 * Agenda template: "What went well? What didn't? What to change?"
 * Inputs: all pulses from completed sessions, proposals, error/blocker summaries
 * Output: structured retrospective report saved to `.squad/ceremonies/retros/`
 */

import type { CeremonyConfigExtended } from '../ceremony-runner.js';

// ─── Built-in Retrospective Config ──────────────────────────────────────────

/**
 * Default retrospective ceremony configuration.
 *
 * Fires when all sessions are closed. Includes the standard retro agenda.
 * Participants should be set at the team level.
 */
export function createDefaultRetrospective(
  participants: string[] = [],
): CeremonyConfigExtended {
  return {
    name: 'retrospective',
    type: 'retrospective',
    trigger: 'all-sessions-closed',
    participants,
    agenda: [
      'Reflect on the completed run using the data provided.',
      '',
      '1. **What went well?** — Identify successful patterns and wins.',
      '2. **What didn\'t go well?** — Flag errors, blockers, and friction.',
      '3. **What should we change?** — Propose concrete improvements.',
      '',
      'Use squad_proposals to create improvement proposals.',
      'Use squad_memory to record key learnings.',
    ].join('\n'),
    enabled: true,
  };
}

/**
 * Create a pipeline-idle retrospective that fires after the pipeline goes quiet.
 */
export function createIdleRetrospective(
  participants: string[] = [],
  idleTimeoutMs = 120_000,
): CeremonyConfigExtended {
  return {
    name: 'idle-retrospective',
    type: 'retrospective',
    trigger: 'pipeline-idle',
    idleTimeoutMs,
    participants,
    agenda: [
      'The pipeline has been idle. Review the run so far.',
      '',
      '1. What progress was made before the pipeline went idle?',
      '2. Were there any blockers that caused the idle state?',
      '3. What should be done next?',
    ].join('\n'),
    enabled: true,
  };
}

/**
 * Validate that a ceremony config has the minimum required fields.
 * Returns an array of validation errors (empty = valid).
 */
export function validateCeremonyConfig(config: CeremonyConfigExtended): string[] {
  const errors: string[] = [];

  if (!config.name || config.name.trim() === '') {
    errors.push('Ceremony name is required');
  }

  if (config.type && config.type !== 'retrospective' && config.type !== 'custom') {
    errors.push(`Invalid ceremony type: "${config.type}" (expected "retrospective" or "custom")`);
  }

  if (config.trigger === 'schedule') {
    errors.push('Scheduled triggers (cron) are not supported — use "all-sessions-closed", "pipeline-idle", or "manual"');
  }

  if (config.participants && !Array.isArray(config.participants)) {
    errors.push('Participants must be an array of agent names');
  }

  return errors;
}
