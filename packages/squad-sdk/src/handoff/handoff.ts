import { randomUUID } from 'node:crypto';

export type HandoffKind =
  | 'analysis'
  | 'patch'
  | 'review'
  | 'test-result'
  | 'question'
  | 'artifact'
  | 'summary';

export type HandoffConfidence = 'low' | 'medium' | 'high';

export interface HandoffEntry {
  handoffId: string;
  runId?: string;
  fromAgent: string;
  toAgent?: string;
  kind: HandoffKind;
  summary: string;
  details: string;
  artifactKeys: string[];
  blockers: string[];
  questions: string[];
  confidence: HandoffConfidence;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishHandoffInput {
  runId?: string;
  fromAgent: string;
  toAgent?: string;
  kind: HandoffKind;
  summary: string;
  details: string;
  artifactKeys?: string[];
  blockers?: string[];
  questions?: string[];
  confidence?: HandoffConfidence;
  tags?: string[];
}

export interface HandoffFilter {
  fromAgent?: string;
  toAgent?: string;
  kind?: HandoffKind;
  tag?: string;
  includeBroadcast?: boolean;
}

export class HandoffStore {
  private entries: Map<string, HandoffEntry> = new Map();

  publish(input: PublishHandoffInput): HandoffEntry {
    const now = new Date().toISOString();
    const entry: HandoffEntry = {
      handoffId: randomUUID(),
      runId: input.runId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      kind: input.kind,
      summary: input.summary,
      details: input.details,
      artifactKeys: [...(input.artifactKeys ?? [])],
      blockers: [...(input.blockers ?? [])],
      questions: [...(input.questions ?? [])],
      confidence: input.confidence ?? 'medium',
      tags: [...(input.tags ?? [])],
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(entry.handoffId, entry);
    return entry;
  }

  read(handoffId: string): HandoffEntry | null {
    return this.entries.get(handoffId) ?? null;
  }

  list(filter?: HandoffFilter): HandoffEntry[] {
    let entries = Array.from(this.entries.values());

    if (filter?.fromAgent) {
      entries = entries.filter((entry) => entry.fromAgent === filter.fromAgent);
    }

    if (filter?.toAgent) {
      const includeBroadcast = filter.includeBroadcast ?? true;
      entries = entries.filter((entry) => entry.toAgent === filter.toAgent || (includeBroadcast && !entry.toAgent));
    }

    if (filter?.kind) {
      entries = entries.filter((entry) => entry.kind === filter.kind);
    }

    if (filter?.tag) {
      const tag = filter.tag;
      entries = entries.filter((entry) => entry.tags.includes(tag));
    }

    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  clear(): void {
    this.entries.clear();
  }
}