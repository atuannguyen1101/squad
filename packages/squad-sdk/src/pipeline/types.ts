/**
 * Pipeline Types — Deterministic DAG execution for multi-agent workflows.
 *
 * Phases are connected by typed gates. The runner checks that each phase
 * produced the required output before advancing. Agents are constrained
 * to tools scoped to their phase.
 */

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface PhaseGate<T = unknown> {
  validate: (output: T) => boolean;
  description: string;
}

export interface PhaseDefinition<TOutput = unknown> {
  id: string;
  agent: string;
  task: string;
  dependsOn?: string[];
  gate: PhaseGate<TOutput>;
  allowedTools?: string[];
  timeout?: number;
  retries?: number;
  context?: Record<string, unknown>;
}

export interface PhaseResult<T = unknown> {
  phaseId: string;
  agent: string;
  status: PhaseStatus;
  output?: T;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  attempt: number;
  durationMs: number;
}

export interface PipelineDefinition {
  id: string;
  name: string;
  phases: PhaseDefinition[];
}

export interface PipelineState {
  pipelineId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  phaseResults: Map<string, PhaseResult>;
  startedAt?: Date;
  completedAt?: Date;
}

export interface PipelineRunnerDeps {
  dispatch: (agentName: string, task: string, context?: string) => Promise<{ sessionId: string; status: string; agentName: string; response?: string }>;
  waitForResponse: (agentName: string, timeoutMs: number) => Promise<string | null>;
  onPhaseStart?: (phaseId: string, agent: string) => void;
  onPhaseComplete?: (result: PhaseResult) => void;
  onPipelineComplete?: (state: PipelineState) => void;
}

export type PipelineEvent =
  | { type: 'phase:start'; phaseId: string; agent: string }
  | { type: 'phase:complete'; result: PhaseResult }
  | { type: 'phase:failed'; phaseId: string; error: string }
  | { type: 'pipeline:complete'; state: PipelineState }
  | { type: 'pipeline:failed'; state: PipelineState; error: string };
