/**
 * Shared Scratchpad — Cross-agent artifact sharing during a run.
 *
 * A simple key-value store that any agent can read/write during a run.
 * Cleared between runs. Keys are namespaced by producer agent for clarity
 * but any agent can read any key.
 *
 * Design principles:
 * - No persistence across runs (ephemeral by design)
 * - Thread-safe via synchronous Map operations (Node.js single-threaded)
 * - Events emitted on write for reactive consumers
 * - Bounded: configurable max entries and max value size
 */

// ============================================================================
// Types
// ============================================================================

export interface ScratchpadEntry {
  /** The key (typically `agent:artifact-name`) */
  key: string;
  /** The stored value (any serializable data) */
  value: string;
  /** Agent that wrote this entry */
  producer: string;
  /** When the entry was written */
  createdAt: string;
  /** When the entry was last updated */
  updatedAt: string;
  /** Optional metadata tags for filtering */
  tags: string[];
}

export interface ScratchpadConfig {
  /** Maximum number of entries. Default: 200 */
  maxEntries: number;
  /** Maximum value size in characters. Default: 50000 */
  maxValueSize: number;
}

export interface ScratchpadWriteResult {
  /** Whether the write succeeded */
  success: boolean;
  /** The key that was written */
  key: string;
  /** Whether this was a new entry or an update */
  created: boolean;
  /** Error message if write failed */
  error?: string;
}

export interface ScratchpadStats {
  /** Total number of entries */
  entryCount: number;
  /** Total size of all values in characters */
  totalSize: number;
  /** Number of unique producers */
  producerCount: number;
  /** Producers and their entry counts */
  producers: Record<string, number>;
}

/** Callback invoked when a new entry is written or updated */
export type ScratchpadListener = (entry: ScratchpadEntry) => void;

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_SCRATCHPAD_CONFIG: ScratchpadConfig = {
  maxEntries: 200,
  maxValueSize: 50_000,
};

// ============================================================================
// Scratchpad
// ============================================================================

export class Scratchpad {
  private entries: Map<string, ScratchpadEntry> = new Map();
  private listeners: ScratchpadListener[] = [];
  private readonly config: ScratchpadConfig;

  constructor(config: Partial<ScratchpadConfig> = {}) {
    this.config = { ...DEFAULT_SCRATCHPAD_CONFIG, ...config };
  }

  /**
   * Write a value to the scratchpad.
   * If the key already exists, the value is overwritten.
   */
  write(key: string, value: string, producer: string, tags: string[] = []): ScratchpadWriteResult {
    if (!key || key.trim().length === 0) {
      return { success: false, key, created: false, error: 'Key must not be empty' };
    }

    if (value.length > this.config.maxValueSize) {
      return {
        success: false,
        key,
        created: false,
        error: `Value exceeds maximum size (${value.length} > ${this.config.maxValueSize})`,
      };
    }

    const existing = this.entries.get(key);

    // Check capacity (only for new entries)
    if (!existing && this.entries.size >= this.config.maxEntries) {
      return {
        success: false,
        key,
        created: false,
        error: `Scratchpad full (${this.config.maxEntries} entries). Delete old entries first.`,
      };
    }

    const now = new Date().toISOString();
    const entry: ScratchpadEntry = {
      key,
      value,
      producer,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      tags: [...tags],
    };

    this.entries.set(key, entry);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Don't let listener errors break the write
      }
    }

    return { success: true, key, created: !existing };
  }

  /**
   * Read a value from the scratchpad.
   * Returns null if the key doesn't exist.
   */
  read(key: string): ScratchpadEntry | null {
    return this.entries.get(key) ?? null;
  }

  /**
   * Delete a key from the scratchpad.
   * Returns true if the key existed and was deleted.
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Check if a key exists.
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * List all keys, optionally filtered by producer or tags.
   */
  list(filter?: { producer?: string; tag?: string }): ScratchpadEntry[] {
    let entries = Array.from(this.entries.values());

    if (filter?.producer) {
      entries = entries.filter(e => e.producer === filter.producer);
    }
    if (filter?.tag) {
      entries = entries.filter(e => e.tags.includes(filter.tag!));
    }

    return entries;
  }

  /**
   * Get statistics about the scratchpad.
   */
  stats(): ScratchpadStats {
    const producers: Record<string, number> = {};
    let totalSize = 0;

    for (const entry of this.entries.values()) {
      totalSize += entry.value.length;
      producers[entry.producer] = (producers[entry.producer] ?? 0) + 1;
    }

    return {
      entryCount: this.entries.size,
      totalSize,
      producerCount: Object.keys(producers).length,
      producers,
    };
  }

  /**
   * Clear all entries. Called between runs.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Subscribe to write events.
   * Returns an unsubscribe function.
   */
  onWrite(listener: ScratchpadListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Get the number of entries.
   */
  get size(): number {
    return this.entries.size;
  }
}
