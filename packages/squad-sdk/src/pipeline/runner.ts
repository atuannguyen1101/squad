/**
 * Pipeline Runner — DAG executor for multi-phase agent workflows.
 *
 * Phases run in topological order based on dependsOn edges.
 * Independent phases run in parallel. Phase transitions are code-enforced:
 * the gate.validate() function must return true before downstream phases start.
 */

import type {
  PipelineDefinition,
  PipelineState,
  PhaseResult,
  PhaseDefinition,
  PipelineRunnerDeps,
  PhaseStatus,
} from './types.js';

const DEFAULT_PHASE_TIMEOUT = 900_000; // 15 minutes
const DEFAULT_RETRIES = 5;

export class PipelineRunner {
  private definition: PipelineDefinition;
  private deps: PipelineRunnerDeps;
  private state: PipelineState;
  private cancelled = false;

  constructor(definition: PipelineDefinition, deps: PipelineRunnerDeps) {
    this.definition = definition;
    this.deps = deps;
    this.state = {
      pipelineId: definition.id,
      status: 'pending',
      phaseResults: new Map(),
    };
  }

  getState(): PipelineState {
    return this.state;
  }

  cancel(): void {
    this.cancelled = true;
    this.state.status = 'cancelled';
    this.state.completedAt = new Date();
  }

  async run(): Promise<PipelineState> {
    this.state.status = 'running';
    this.state.startedAt = new Date();

    const order = this.topologicalSort();

    try {
      await this.executeLayers(order);
      if (this.cancelled) {
        this.state.status = 'cancelled';
      } else {
        this.state.status = this.hasFailures() ? 'failed' : 'completed';
      }
    } catch (err) {
      this.state.status = 'failed';
      this.deps.onPipelineComplete?.(this.state);
      throw err;
    }

    this.state.completedAt = new Date();
    this.deps.onPipelineComplete?.(this.state);
    return this.state;
  }

  private async executeLayers(order: string[][]): Promise<void> {
    for (const layer of order) {
      if (this.cancelled) break;

      const phases = layer
        .map(id => this.definition.phases.find(p => p.id === id)!)
        .filter(p => !this.shouldSkip(p));

      if (phases.length === 0) continue;

      const results = await Promise.allSettled(
        phases.map(phase => this.executePhase(phase)),
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
          throw new Error(`Phase execution failed: ${error}`);
        }
      }

      if (this.hasFailures() || this.cancelled) break;
    }
  }

  private async executePhase(phase: PhaseDefinition): Promise<PhaseResult> {
    if (this.cancelled) {
      const now = new Date();
      return {
        phaseId: phase.id, agent: phase.agent, status: 'cancelled',
        startedAt: now, completedAt: now, attempt: 0, durationMs: 0,
      };
    }

    const maxAttempts = phase.retries ?? DEFAULT_RETRIES;
    const timeout = phase.timeout ?? DEFAULT_PHASE_TIMEOUT;
    let lastResult: PhaseResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.cancelled) {
        const now = new Date();
        return {
          phaseId: phase.id, agent: phase.agent, status: 'cancelled',
          startedAt: now, completedAt: now, attempt, durationMs: 0,
        };
      }

      const startedAt = new Date();
      this.deps.onPhaseStart?.(phase.id, phase.agent);

      try {
        const contextStr = phase.context
          ? `\n\nContext:\n${JSON.stringify(phase.context, null, 2)}`
          : '';
        
        // On retry after gate failure, send a checklist reminder instead of the original task
        let taskToSend: string;
        if (attempt > 1 && lastResult?.status === 'failed' && lastResult.error?.includes('Gate failed')) {
          taskToSend = [
            'Your previous response did not satisfy the phase completion gate.',
            `Gate requirement: ${phase.gate.description}`,
            'Continue from the current session state and finish the phase before replying again.',
            'Do not stop at in-progress updates like "I asked", "I will wait", or other partial status messages.',
          ].join('\n');
        } else {
          taskToSend = phase.allowedTools
            ? `${phase.task}\n\nYou may only use these tools: ${phase.allowedTools.join(', ')}${contextStr}`
            : `${phase.task}${contextStr}`;
        }

        const dispatchResult = await this.deps.dispatch(phase.agent, taskToSend);
        const response = dispatchResult.response ?? await this.deps.waitForResponse(phase.agent, timeout);

        const output = response ?? '';
        const gatePass = await Promise.resolve(phase.gate.validate(output));
        const status: PhaseStatus = gatePass ? 'completed' : 'failed';
        const completedAt = new Date();

        lastResult = {
          phaseId: phase.id,
          agent: phase.agent,
          status,
          output,
          error: gatePass ? undefined : `Gate failed: ${phase.gate.description}`,
          startedAt,
          completedAt,
          attempt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };

        this.state.phaseResults.set(phase.id, lastResult);
        this.deps.onPhaseComplete?.(lastResult);

        if (gatePass) return lastResult;
        
        // Notify about gate retry before the next attempt
        if (attempt < maxAttempts) {
          this.deps.onPhaseRetry?.(phase.id, phase.agent, attempt, phase.gate.description);
        }
      } catch (err) {
        const completedAt = new Date();
        lastResult = {
          phaseId: phase.id,
          agent: phase.agent,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          startedAt,
          completedAt,
          attempt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        };
        this.state.phaseResults.set(phase.id, lastResult);
        this.deps.onPhaseComplete?.(lastResult);
      }
    }

    return lastResult!;
  }

  private shouldSkip(phase: PhaseDefinition): boolean {
    if (!phase.dependsOn?.length) return false;
    
    // If continueOnPartialFailure is true, only skip if ALL dependencies failed
    if (phase.continueOnPartialFailure) {
      return phase.dependsOn.every(depId => {
        const depResult = this.state.phaseResults.get(depId);
        return depResult?.status === 'failed';
      });
    }
    
    // Default behavior: skip if ANY dependency failed
    return phase.dependsOn.some(depId => {
      const depResult = this.state.phaseResults.get(depId);
      return depResult?.status === 'failed';
    });
  }

  private hasFailures(): boolean {
    for (const result of this.state.phaseResults.values()) {
      if (result.status === 'failed') return true;
    }
    return false;
  }

  /**
   * Topological sort into parallel layers.
   * Each layer contains phases whose dependencies are all in earlier layers.
   */
  topologicalSort(): string[][] {
    const phases = this.definition.phases;
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const phase of phases) {
      inDegree.set(phase.id, phase.dependsOn?.length ?? 0);
      adjacency.set(phase.id, []);
    }

    for (const phase of phases) {
      for (const dep of phase.dependsOn ?? []) {
        const edges = adjacency.get(dep);
        if (edges) edges.push(phase.id);
      }
    }

    const layers: string[][] = [];
    const remaining = new Set(phases.map(p => p.id));

    while (remaining.size > 0) {
      const layer: string[] = [];
      for (const id of remaining) {
        if ((inDegree.get(id) ?? 0) === 0) {
          layer.push(id);
        }
      }

      if (layer.length === 0) {
        throw new Error(`Cycle detected in pipeline phases: ${[...remaining].join(', ')}`);
      }

      for (const id of layer) {
        remaining.delete(id);
        for (const downstream of adjacency.get(id) ?? []) {
          inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1);
        }
      }

      layers.push(layer);
    }

    return layers;
  }
}
