/**
 * Pulse Protocol — Structured agent status updates.
 *
 * Agents emit Pulses at milestones instead of free-form text.
 * The Coordinator filters user-relevant Pulses and forwards them to Ben.
 * This keeps context bounded and monitoring predictable.
 */

export type PulsePhase = 'starting' | 'analyzing' | 'implementing' | 'testing' | 'reviewing' | 'done' | 'blocked';
export type PulseStatus = 'ok' | 'warning' | 'error';

export interface Pulse {
  agent: string;
  phase: PulsePhase;
  status: PulseStatus;
  progressPct: number;
  summary: string;
  blockers: string[];
  questionsForUser: string[];
  artifacts: string[];
  nextStep: string;
  timestamp: string;
}

export interface PulseFilter {
  userRelevant: boolean;
  reason: string;
}

export function createPulse(fields: Omit<Pulse, 'timestamp'>): Pulse {
  return {
    ...fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Determine if a Pulse should be surfaced to the user via Ben.
 * User-relevant: has questions, has blockers, is done, or is an error.
 */
export function filterPulseForUser(pulse: Pulse): PulseFilter {
  if (pulse.questionsForUser.length > 0) {
    return { userRelevant: true, reason: 'has questions for user' };
  }
  if (pulse.status === 'error') {
    return { userRelevant: true, reason: 'error reported' };
  }
  if (pulse.blockers.length > 0) {
    return { userRelevant: true, reason: 'blocked' };
  }
  if (pulse.phase === 'done') {
    return { userRelevant: true, reason: 'phase completed' };
  }
  return { userRelevant: false, reason: 'internal progress update' };
}

/**
 * Format a Pulse for human consumption (Ben translates for the user).
 */
export function formatPulseForUser(pulse: Pulse): string {
  const lines: string[] = [];
  lines.push(`[${pulse.agent}] ${pulse.phase} (${pulse.progressPct}%) — ${pulse.summary}`);

  if (pulse.blockers.length > 0) {
    lines.push(`Blocked: ${pulse.blockers.join('; ')}`);
  }
  if (pulse.questionsForUser.length > 0) {
    lines.push(`Questions: ${pulse.questionsForUser.join('; ')}`);
  }
  if (pulse.artifacts.length > 0) {
    lines.push(`Artifacts: ${pulse.artifacts.join(', ')}`);
  }
  if (pulse.nextStep) {
    lines.push(`Next: ${pulse.nextStep}`);
  }

  return lines.join('\n');
}

export class PulseCollector {
  private pulses: Pulse[] = [];
  private userQueue: Pulse[] = [];
  private onUserRelevantPulse?: (pulse: Pulse) => void;
  private pulseListeners: Array<(pulse: Pulse) => void> = [];

  setOnUserRelevantPulse(callback: (pulse: Pulse) => void): void {
    this.onUserRelevantPulse = callback;
  }

  record(pulse: Pulse): PulseFilter {
    this.pulses.push(pulse);
    const filter = filterPulseForUser(pulse);
    if (filter.userRelevant) {
      this.userQueue.push(pulse);
      this.onUserRelevantPulse?.(pulse);
    }
    // Notify all pulse listeners (used by waitForDonePulse)
    for (const listener of this.pulseListeners) {
      try { listener(pulse); } catch { /* listener errors are non-fatal */ }
    }
    return filter;
  }

  /**
   * Subscribe to ALL pulses (not just user-relevant ones).
   * Returns an unsubscribe function.
   */
  onPulse(listener: (pulse: Pulse) => void): () => void {
    this.pulseListeners.push(listener);
    return () => {
      const idx = this.pulseListeners.indexOf(listener);
      if (idx !== -1) this.pulseListeners.splice(idx, 1);
    };
  }

  /**
   * Wait until a specific agent emits a pulse with the given phase.
   * Checks already-recorded pulses first, then subscribes for new ones.
   * Returns the matching pulse, or null on timeout.
   *
   * Also resolves early if the agent emits an 'error' status or 'blocked' phase,
   * since those indicate the agent won't reach 'done'.
   */
  waitForDonePulse(
    agentName: string,
    timeoutMs: number,
    targetPhase: PulsePhase = 'done',
  ): Promise<Pulse | null> {
    // Check if we already have a matching pulse
    const existing = this.pulses.find(
      p => p.agent === agentName && (p.phase === targetPhase || p.status === 'error' || p.phase === 'blocked'),
    );
    if (existing) return Promise.resolve(existing);

    return new Promise<Pulse | null>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        resolve(null);
      }, timeoutMs);

      const unsub = this.onPulse((pulse) => {
        if (settled) return;
        if (pulse.agent !== agentName) return;
        if (pulse.phase === targetPhase || pulse.status === 'error' || pulse.phase === 'blocked') {
          settled = true;
          clearTimeout(timer);
          unsub();
          resolve(pulse);
        }
      });
    });
  }

  drainUserQueue(): Pulse[] {
    const queued = [...this.userQueue];
    this.userQueue = [];
    return queued;
  }

  getAll(): readonly Pulse[] {
    return this.pulses;
  }

  getByAgent(agent: string): Pulse[] {
    return this.pulses.filter(p => p.agent === agent);
  }

  getLatestByAgent(): Map<string, Pulse> {
    const latest = new Map<string, Pulse>();
    for (const pulse of this.pulses) {
      latest.set(pulse.agent, pulse);
    }
    return latest;
  }

  hasUserRelevantPulses(): boolean {
    return this.userQueue.length > 0;
  }

  clear(): void {
    this.pulses = [];
    this.userQueue = [];
  }
}
