/**
 * Ceremony Trigger Engine
 *
 * Gives ceremonies a runtime execution layer. Reads ceremony configs,
 * subscribes to EventBus session:destroyed events, and auto-dispatches
 * ceremony participants when trigger conditions are met.
 */

import type { CeremonyConfig } from '../config/schema.js';

// ============================================================================
// Types
// ============================================================================

/** Function that dispatches a message to a named agent. */
type DispatchFn = (agentName: string, message: string) => Promise<unknown>;

/** Function that returns the names of all currently active agent sessions. */
type ActiveAgentsFn = () => string[];

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

// ============================================================================
// CeremonyTriggerEngine
// ============================================================================

export class CeremonyTriggerEngine {
  private readonly ceremonies: CeremonyConfig[];
  private readonly dispatch: DispatchFn;
  private readonly getActiveAgents: ActiveAgentsFn;
  private readonly fired: Set<string> = new Set();
  private readonly idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastActivityAt: number = Date.now();
  private disabled = false;

  constructor(
    ceremonies: CeremonyConfig[],
    dispatch: DispatchFn,
    getActiveAgents: ActiveAgentsFn,
  ) {
    this.ceremonies = ceremonies.filter(c => c.enabled !== false);
    this.dispatch = dispatch;
    this.getActiveAgents = getActiveAgents;
  }

  onSessionClosed(agentName: string): void {
    if (this.disabled) return;
    this.lastActivityAt = Date.now();

    for (const ceremony of this.ceremonies) {
      if (this.fired.has(ceremony.name)) continue;
      if (this.isCeremonyParticipant(ceremony, agentName)) continue;

      if (ceremony.trigger === 'all-sessions-closed') {
        const activeNonCeremony = this.countNonCeremonyActive();
        if (activeNonCeremony === 0) {
          void this.fireCeremony(ceremony);
        }
      }

      if (ceremony.trigger === 'pipeline-idle') {
        this.scheduleIdleCheck(ceremony);
      }
    }
  }

  onActivity(): void {
    this.lastActivityAt = Date.now();
  }

  disable(): void {
    this.disabled = true;
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
  }

  reset(): void {
    this.disabled = false;
    this.fired.clear();
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
  }

  private scheduleIdleCheck(ceremony: CeremonyConfig): void {
    const existing = this.idleTimers.get(ceremony.name);
    if (existing) clearTimeout(existing);

    const timeout = ceremony.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const elapsed = Date.now() - this.lastActivityAt;
    const delay = Math.max(0, timeout - elapsed);
    const timer = setTimeout(() => {
      if (this.disabled || this.fired.has(ceremony.name)) return;
      const currentElapsed = Date.now() - this.lastActivityAt;
      if (currentElapsed >= timeout) {
        void this.fireCeremony(ceremony);
      } else {
        this.scheduleIdleCheck(ceremony);
      }
    }, delay);
    this.idleTimers.set(ceremony.name, timer);
  }

  private async fireCeremony(ceremony: CeremonyConfig): Promise<void> {
    this.fired.add(ceremony.name);

    const participants = ceremony.participants ?? [];
    const agenda = ceremony.agenda ?? `Run ${ceremony.name} ceremony`;

    for (const participant of participants) {
      const name = participant.replace(/^@/, '');
      try {
        await this.dispatch(name, agenda);
        process.stderr.write(`[ceremony] Dispatched ${name} for "${ceremony.name}"\n`);
      } catch (err) {
        process.stderr.write(`[ceremony] Failed to dispatch ${name}: ${err instanceof Error ? err.message : err}\n`);
      }
    }
  }

  private isCeremonyParticipant(ceremony: CeremonyConfig, agentName: string): boolean {
    return (ceremony.participants ?? []).some(
      p => p.replace(/^@/, '') === agentName,
    );
  }

  private countNonCeremonyActive(): number {
    const ceremonyAgents = new Set(
      this.ceremonies.flatMap(c => (c.participants ?? []).map(p => p.replace(/^@/, ''))),
    );
    const activeAgents = this.getActiveAgents();
    return activeAgents.filter(name => !ceremonyAgents.has(name)).length;
  }
}