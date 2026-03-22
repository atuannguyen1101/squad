/**
 * Parse Phase Output — Extract intent graph updates from agent responses.
 *
 * Ben's understand phase produces freeform text that may contain structured
 * sections (## Constraints, ## Acceptance Criteria). The coordinator's route
 * phase produces JSON with agent assignments.
 *
 * These parsers are best-effort: they extract what they can and return
 * partial updates suitable for updateIntentGraph().
 */

import type { IntentGraph, IntentTask } from './intent-graph.js';

export type UnderstandPhaseUpdate = Partial<
  Pick<IntentGraph, 'goal' | 'constraints' | 'acceptanceCriteria' | 'currentStatus'>
>;

export type RoutePhaseUpdate = { tasks: IntentTask[]; currentStatus: 'in-progress' };

/**
 * Extract goal, constraints, and acceptance criteria from Ben's understand
 * phase output. Looks for markdown section headers first, then falls back
 * to keyword-based extraction.
 */
export function parseUnderstandPhaseOutput(text: string): UnderstandPhaseUpdate {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const constraints: string[] = [];
  const acceptanceCriteria: string[] = [];
  let goal: string | undefined;

  let currentSection: 'none' | 'constraints' | 'acceptance' | 'other' = 'none';

  for (const line of lines) {
    // Detect section headers
    if (/^#+\s*constraints?/i.test(line) || /^constraints?:/i.test(line)) {
      currentSection = 'constraints';
      continue;
    }
    if (/^#+\s*acceptance/i.test(line) || /^acceptance\s*criter/i.test(line)) {
      currentSection = 'acceptance';
      continue;
    }
    // Any other heading resets the section
    if (/^#+\s/.test(line)) {
      currentSection = 'other';
      continue;
    }

    // Collect bullet items based on current section
    const isBullet = /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
    const cleanLine = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '');

    if (currentSection === 'constraints' && isBullet) {
      constraints.push(cleanLine);
    } else if (currentSection === 'acceptance' && isBullet) {
      acceptanceCriteria.push(cleanLine);
    }
  }

  // Extract goal: first non-heading, non-bullet line with substance
  for (const line of lines) {
    if (/^#+\s/.test(line)) continue;
    if (/^[-*•]\s/.test(line)) continue;
    if (/^\d+[.)]\s/.test(line)) continue;
    if (line.length > 20) {
      goal = line;
      break;
    }
  }

  return {
    ...(goal ? { goal } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    currentStatus: 'ready',
  };
}

/**
 * Extract task assignments from Coordinator's route phase JSON output.
 * Expects: {"implementer": "name", "reviewer": "name", "architect": null}
 */
export function parseRoutePhaseOutput(text: string): RoutePhaseUpdate {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { tasks: [], currentStatus: 'in-progress' };

  try {
    const routing = JSON.parse(jsonMatch[0]) as {
      implementer?: string;
      reviewer?: string;
      architect?: string | null;
    };
    const tasks: IntentTask[] = [];

    if (routing.implementer) {
      tasks.push({
        id: 'implement',
        description: 'Implementation',
        assignedAgent: routing.implementer,
        status: 'pending',
      });
    }
    if (routing.reviewer) {
      tasks.push({
        id: 'review',
        description: 'Code review',
        assignedAgent: routing.reviewer,
        status: 'pending',
        dependencies: ['implement'],
      });
    }
    if (routing.architect) {
      tasks.push({
        id: 'architect',
        description: 'Architecture assessment',
        assignedAgent: routing.architect,
        status: 'pending',
      });
    }

    return { tasks, currentStatus: 'in-progress' };
  } catch {
    return { tasks: [], currentStatus: 'in-progress' };
  }
}
