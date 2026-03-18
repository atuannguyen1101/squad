/**
 * Event History — Ring buffer for server events
 *
 * Captures the last N events from EventBus for monitoring.
 * Events are timestamped and typed for filtering.
 */

export interface HistoryEvent {
  id: number;
  timestamp: string; // ISO 8601
  type: string; // e.g. 'session:created', 'dispatch', 'tool:squad_route'
  agentName?: string;
  summary: string; // Human-readable one-liner
  details?: Record<string, unknown>;
}

export class EventHistory {
  private events: HistoryEvent[] = [];
  private maxSize: number;
  private nextId = 1;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /** Add an event to the history */
  push(event: Omit<HistoryEvent, 'id' | 'timestamp'>): HistoryEvent {
    const entry: HistoryEvent = {
      ...event,
      id: this.nextId++,
      timestamp: new Date().toISOString(),
    };
    this.events.push(entry);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
    return entry;
  }

  /** Get recent events, optionally filtered */
  recent(count = 20, filter?: { type?: string; agentName?: string }): HistoryEvent[] {
    let filtered = this.events;
    if (filter?.type) {
      filtered = filtered.filter(e => e.type.includes(filter.type!));
    }
    if (filter?.agentName) {
      filtered = filtered.filter(e => e.agentName === filter.agentName);
    }
    return filtered.slice(-count);
  }

  /** Get total event count */
  get size(): number {
    return this.events.length;
  }

  /** Clear all events */
  clear(): void {
    this.events = [];
  }
}
