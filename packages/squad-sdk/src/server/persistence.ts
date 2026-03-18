/**
 * Server State Persistence
 *
 * Persists session registry and server state to disk for crash recovery.
 * Uses atomic writes (temp file + rename) to prevent corruption.
 *
 * State directory: {squadRoot}/.squad/.runtime/
 * Files:
 *   session-registry.json — sessionId → agentName mapping
 *   server-state.json     — full server state snapshot
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface SessionRegistryEntry {
  sessionId: string;
  agentName: string;
  createdAt: string;       // ISO 8601
  lastMessageAt: string;   // ISO 8601
  charterHash?: string;    // Quick check if charter changed
  status: 'active' | 'idle' | 'error';
}

export interface ServerStateSnapshot {
  version: 1;
  savedAt: string;         // ISO 8601
  serverStartedAt: string; // ISO 8601
  sessions: SessionRegistryEntry[];
  poolSize: number;
  poolCapacity: number;
}

export interface PersistenceConfig {
  /** Squad root directory */
  squadRoot: string;
  /** Auto-save interval in ms (default: 30000 = 30s) */
  autoSaveInterval?: number;
  /** Enable auto-save timer */
  autoSave?: boolean;
}

// ============================================================================
// ServerPersistence
// ============================================================================

const REGISTRY_FILE = 'session-registry.json';
const STATE_FILE = 'server-state.json';

export class ServerPersistence {
  private readonly runtimeDir: string;
  private readonly autoSaveInterval: number;
  private readonly autoSaveEnabled: boolean;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: PersistenceConfig) {
    this.runtimeDir = path.join(config.squadRoot, '.squad', '.runtime');
    this.autoSaveInterval = config.autoSaveInterval ?? 30_000;
    this.autoSaveEnabled = config.autoSave ?? false;

    // Ensure state directory exists
    fs.mkdirSync(this.runtimeDir, { recursive: true });
  }

  // --------------------------------------------------------------------------
  // Atomic file I/O
  // --------------------------------------------------------------------------

  /**
   * Write data to a file atomically: write to a temp file then rename.
   * Prevents half-written JSON files on crash.
   */
  private atomicWrite(filePath: string, data: string): void {
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, data, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file if rename failed
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Session Registry
  // --------------------------------------------------------------------------

  /**
   * Save the session registry to disk.
   */
  saveRegistry(entries: SessionRegistryEntry[]): void {
    const filePath = path.join(this.runtimeDir, REGISTRY_FILE);
    this.atomicWrite(filePath, JSON.stringify(entries, null, 2));
  }

  /**
   * Load the session registry from disk.
   * Returns an empty array if the file doesn't exist or is corrupt.
   */
  loadRegistry(): SessionRegistryEntry[] {
    const filePath = path.join(this.runtimeDir, REGISTRY_FILE);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        process.stderr.write(`[persistence] session-registry.json is not an array, ignoring\n`);
        return [];
      }
      return parsed as SessionRegistryEntry[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[persistence] Failed to load session-registry.json: ${err}\n`);
      }
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Server State Snapshot
  // --------------------------------------------------------------------------

  /**
   * Save a full server state snapshot to disk.
   */
  saveState(snapshot: ServerStateSnapshot): void {
    const filePath = path.join(this.runtimeDir, STATE_FILE);
    this.atomicWrite(filePath, JSON.stringify(snapshot, null, 2));
  }

  /**
   * Load the server state snapshot from disk.
   * Returns null if the file doesn't exist or is corrupt.
   */
  loadState(): ServerStateSnapshot | null {
    const filePath = path.join(this.runtimeDir, STATE_FILE);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
        process.stderr.write(`[persistence] server-state.json has invalid format, ignoring\n`);
        return null;
      }
      return parsed as ServerStateSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[persistence] Failed to load server-state.json: ${err}\n`);
      }
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Auto-save
  // --------------------------------------------------------------------------

  /**
   * Start a periodic auto-save timer that snapshots state to disk.
   * The timer is unref'd so it doesn't prevent process exit.
   */
  startAutoSave(getSnapshot: () => ServerStateSnapshot): void {
    this.stopAutoSave();
    this.autoSaveTimer = setInterval(() => {
      try {
        const snapshot = getSnapshot();
        this.saveState(snapshot);
        this.saveRegistry(snapshot.sessions);
      } catch (err) {
        process.stderr.write(`[persistence] Auto-save failed: ${err}\n`);
      }
    }, this.autoSaveInterval);
    // Don't prevent process exit
    this.autoSaveTimer.unref();
  }

  /**
   * Stop the auto-save timer.
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer !== null) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * Delete runtime state files (for clean shutdown when state isn't needed).
   */
  cleanup(): void {
    this.stopAutoSave();
    for (const file of [REGISTRY_FILE, STATE_FILE]) {
      try {
        fs.unlinkSync(path.join(this.runtimeDir, file));
      } catch {
        // File may not exist — that's fine
      }
    }
  }
}
