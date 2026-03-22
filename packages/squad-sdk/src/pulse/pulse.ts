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
    return filter;
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
