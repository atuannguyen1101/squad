/**
 * Intent Graph — Structured representation of user intent.
 *
 * Ben extracts this from user conversation and passes it as a compact,
 * typed handoff instead of raw conversation text.
 * This keeps Ben's context bounded and gives downstream agents
 * machine-readable task structure.
 */

export interface IntentGraph {
  goal: string;
  constraints: string[];
  preferences: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  currentStatus: IntentStatus;
  tasks: IntentTask[];
  metadata: IntentMetadata;
}

export type IntentStatus = 'clarifying' | 'ready' | 'in-progress' | 'blocked' | 'completed';

export interface IntentTask {
  id: string;
  description: string;
  assignedAgent?: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  dependencies?: string[];
}

export interface IntentMetadata {
  createdAt: string;
  updatedAt: string;
  clarificationRounds: number;
  version: number;
}

export function createEmptyIntentGraph(goal: string): IntentGraph {
  const now = new Date().toISOString();
  return {
    goal,
    constraints: [],
    preferences: [],
    acceptanceCriteria: [],
    openQuestions: [],
    currentStatus: 'clarifying',
    tasks: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      clarificationRounds: 0,
      version: 1,
    },
  };
}

export function serializeIntentGraph(graph: IntentGraph): string {
  return JSON.stringify(graph, null, 2);
}

export function deserializeIntentGraph(json: string): IntentGraph {
  const parsed = JSON.parse(json) as IntentGraph;
  if (!parsed.goal || !parsed.metadata) {
    throw new Error('Invalid IntentGraph: missing required fields');
  }
  return parsed;
}

/**
 * Merge updates into an existing IntentGraph.
 * Increments version and updatedAt. Arrays are unioned (no duplicates).
 */
export function updateIntentGraph(
  current: IntentGraph,
  updates: Partial<Pick<IntentGraph, 'goal' | 'constraints' | 'preferences' | 'acceptanceCriteria' | 'openQuestions' | 'currentStatus' | 'tasks'>>,
): IntentGraph {
  const unionArrays = <T>(existing: T[], incoming?: T[]): T[] => {
    if (!incoming) return existing;
    const set = new Set([...existing.map(String), ...incoming.map(String)]);
    return [...set] as unknown as T[];
  };

  return {
    goal: updates.goal ?? current.goal,
    constraints: unionArrays(current.constraints, updates.constraints),
    preferences: unionArrays(current.preferences, updates.preferences),
    acceptanceCriteria: unionArrays(current.acceptanceCriteria, updates.acceptanceCriteria),
    openQuestions: updates.openQuestions ?? current.openQuestions,
    currentStatus: updates.currentStatus ?? current.currentStatus,
    tasks: updates.tasks ?? current.tasks,
    metadata: {
      ...current.metadata,
      updatedAt: new Date().toISOString(),
      version: current.metadata.version + 1,
    },
  };
}
