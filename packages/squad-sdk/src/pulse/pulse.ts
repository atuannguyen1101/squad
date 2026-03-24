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
    blockers: Array.isArray(fields.blockers) ? fields.blockers : [],
    questionsForUser: Array.isArray(fields.questionsForUser) ? fields.questionsForUser : [],
    artifacts: Array.isArray(fields.artifacts) ? fields.artifacts : [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Determine if a Pulse should be surfaced to the user via Ben.
 * User-relevant: has questions, has blockers, is done, or is an error.
 */
export function filterPulseForUser(pulse: Pulse): PulseFilter {
  const questions = Array.isArray(pulse.questionsForUser) ? pulse.questionsForUser : [];
  const blockers = Array.isArray(pulse.blockers) ? pulse.blockers : [];
  if (questions.length > 0) {
    return { userRelevant: true, reason: 'has questions for user' };
  }
  if (pulse.status === 'error') {
    return { userRelevant: true, reason: 'error reported' };
  }
  if (blockers.length > 0) {
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

  if (pulse.blockers && pulse.blockers.length > 0) {
    const blockerList = Array.isArray(pulse.blockers) ? pulse.blockers : [String(pulse.blockers)];
    lines.push(`Blocked: ${blockerList.join('; ')}`);
  }
  if (pulse.questionsForUser && pulse.questionsForUser.length > 0) {
    const questionList = Array.isArray(pulse.questionsForUser) ? pulse.questionsForUser : [String(pulse.questionsForUser)];
    lines.push(`Questions: ${questionList.join('; ')}`);
  }
  if (pulse.artifacts && pulse.artifacts.length > 0) {
    const artifactList = Array.isArray(pulse.artifacts) ? pulse.artifacts : [String(pulse.artifacts)];
    lines.push(`Artifacts: ${artifactList.join(', ')}`);
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
  private progressWarningListener?: (agent: string, oldProgress: number, newProgress: number) => void;
  private messageCountWarningThreshold: number = 25;
  private messageCountsByAgent: Map<string, number> = new Map();
  private messageCountWarningsEmitted: Set<string> = new Set();

  setOnUserRelevantPulse(callback: (pulse: Pulse) => void): void {
    this.onUserRelevantPulse = callback;
  }

  /**
   * Set callback for progress regression warnings.
   * Called when an agent's progress goes backward (e.g., 100 → 30).
   */
  setOnProgressRegression(callback: (agent: string, oldProgress: number, newProgress: number) => void): void {
    this.progressWarningListener = callback;
  }

  /**
   * Track a message for an agent and emit a warning if threshold is exceeded.
   */
  trackMessage(agentName: string): void {
    const currentCount = this.messageCountsByAgent.get(agentName) || 0;
    const newCount = currentCount + 1;
    this.messageCountsByAgent.set(agentName, newCount);

    // Warning at threshold — informational only, no session termination
    if (newCount >= this.messageCountWarningThreshold && 
        !this.messageCountWarningsEmitted.has(agentName)) {
      this.messageCountWarningsEmitted.add(agentName);
      const warningPulse: Pulse = {
        agent: 'System',
        phase: 'reviewing',
        status: 'warning',
        progressPct: 0,
        summary: `Message count threshold exceeded: ${agentName} has ${newCount} messages (threshold: ${this.messageCountWarningThreshold}). Consider task decomposition.`,
        blockers: [],
        questionsForUser: [],
        artifacts: [],
        nextStep: 'Review task complexity',
        timestamp: new Date().toISOString(),
      };
      this.pulses.push(warningPulse);
      const filter = filterPulseForUser(warningPulse);
      if (filter.userRelevant) {
        this.userQueue.push(warningPulse);
        this.onUserRelevantPulse?.(warningPulse);
      }
    }
  }

  record(pulse: Pulse): PulseFilter {
    // Check for progress regression before recording
    const previousPulses = this.pulses.filter(p => p.agent === pulse.agent);
    if (previousPulses.length > 0) {
      const lastPulse = previousPulses[previousPulses.length - 1];
      // Detect backward progress (regression threshold: >10% backward movement)
      if (lastPulse && lastPulse.progressPct > pulse.progressPct && 
          lastPulse.progressPct - pulse.progressPct > 10) {
        this.progressWarningListener?.(pulse.agent, lastPulse.progressPct, pulse.progressPct);
        // Optionally emit a warning pulse
        const warningPulse: Pulse = {
          agent: 'System',
          phase: 'reviewing',
          status: 'warning',
          progressPct: 0,
          summary: `Progress regression detected: ${pulse.agent} went from ${lastPulse.progressPct}% to ${pulse.progressPct}%`,
          blockers: [],
          questionsForUser: [],
          artifacts: [],
          nextStep: 'Review agent progress',
          timestamp: new Date().toISOString(),
        };
        // Record the warning pulse
        this.pulses.push(warningPulse);
        const warningFilter = filterPulseForUser(warningPulse);
        if (warningFilter.userRelevant) {
          this.userQueue.push(warningPulse);
          this.onUserRelevantPulse?.(warningPulse);
        }
      }
    }

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
   *
   * Auto-pulse safety net: If no pulse is received within autoPulseThresholdMs,
   * generates a "still working" pulse to prevent hanging.
   */
  waitForDonePulse(
    agentName: string,
    timeoutMs: number,
    targetPhase: PulsePhase = 'done',
    autoPulseThresholdMs: number = 60000, // Default: 60 seconds
  ): Promise<Pulse | null> {
    // Check if we already have a matching pulse (case-insensitive)
    const lowerAgentName = agentName.toLowerCase();
    const existing = this.pulses.find(
      p => p.agent.toLowerCase() === lowerAgentName && (p.phase === targetPhase || p.status === 'error' || p.phase === 'blocked'),
    );
    if (existing) return Promise.resolve(existing);

    return new Promise<Pulse | null>((resolve) => {
      let settled = false;
      let autoPulseTimer: NodeJS.Timeout | null = null;
      let lastPulseTime = Date.now();

      // Auto-pulse safety net: generate "still working" pulse if silent too long
      const startAutoPulseTimer = () => {
        if (autoPulseTimer) clearTimeout(autoPulseTimer);
        autoPulseTimer = setTimeout(() => {
          if (settled) return;
          const timeSinceLastPulse = Date.now() - lastPulseTime;
          if (timeSinceLastPulse >= autoPulseThresholdMs) {
            // Generate an auto-pulse
            const autoPulse: Pulse = {
              agent: agentName,
              phase: 'implementing',
              status: 'ok',
              progressPct: 0,
              summary: 'Still working (auto-generated pulse)',
              blockers: [],
              questionsForUser: [],
              artifacts: [],
              nextStep: 'Continuing work',
              timestamp: new Date().toISOString(),
            };
            this.record(autoPulse);
            lastPulseTime = Date.now();
            // Restart the timer
            startAutoPulseTimer();
          }
        }, autoPulseThresholdMs);
      };

      startAutoPulseTimer();

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (autoPulseTimer) clearTimeout(autoPulseTimer);
        unsub();
        resolve(null);
      }, timeoutMs);

      const unsub = this.onPulse((pulse) => {
        if (settled) return;
        // Case-insensitive agent name comparison
        if (pulse.agent.toLowerCase() !== lowerAgentName) return;
        
        // Update last pulse time
        lastPulseTime = Date.now();
        
        if (pulse.phase === targetPhase || pulse.status === 'error' || pulse.phase === 'blocked') {
          settled = true;
          clearTimeout(timer);
          if (autoPulseTimer) clearTimeout(autoPulseTimer);
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
    const lowerAgent = agent.toLowerCase();
    return this.pulses.filter(p => p.agent.toLowerCase() === lowerAgent);
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
    this.messageCountsByAgent.clear();
    this.messageCountWarningsEmitted.clear();
  }

  /**
   * Set the message count warning threshold.
   * When an agent exceeds this many messages, a warning pulse is emitted.
   */
  setMessageCountWarningThreshold(threshold: number): void {
    this.messageCountWarningThreshold = threshold;
  }

  /**
   * Get the current message count for an agent.
   */
  getMessageCount(agentName: string): number {
    return this.messageCountsByAgent.get(agentName) ?? 0;
  }
}
