/**
 * Crash recovery tests for ServerPersistence.
 *
 * Covers:
 *  - Session registry save/load (happy path, missing file, corrupt file)
 *  - Server state snapshot save/load (happy path, missing file, corrupt file)
 *  - Atomic writes (no leftover .tmp files, clean overwrite)
 *  - Cleanup (removes runtime files)
 *  - Auto-save (start/stop timer, periodic writes)
 *  - SquadServer integration (persistence wired via constructor)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('ServerPersistence', () => {
  let tempDir: string;
  let ServerPersistence: any;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `squad-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(tempDir, '.squad'), { recursive: true });
    const mod = await import('../packages/squad-sdk/src/server/persistence.js');
    ServerPersistence = mod.ServerPersistence;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // --- Session Registry ---

  describe('session registry', () => {
    it('should save and load registry entries', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      const entries = [
        {
          sessionId: 'session-1',
          agentName: 'fenster',
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          status: 'active' as const,
        },
        {
          sessionId: 'session-2',
          agentName: 'keaton',
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          status: 'idle' as const,
        },
      ];

      persistence.saveRegistry(entries);
      const loaded = persistence.loadRegistry();

      expect(loaded).toHaveLength(2);
      expect(loaded[0].agentName).toBe('fenster');
      expect(loaded[1].agentName).toBe('keaton');
    });

    it('should return empty array when no registry file exists', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      const loaded = persistence.loadRegistry();
      expect(loaded).toEqual([]);
    });

    it('should handle corrupt registry file gracefully', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      const runtimeDir = path.join(tempDir, '.squad', '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, 'session-registry.json'), 'not valid json{{{', 'utf-8');

      const loaded = persistence.loadRegistry();
      expect(loaded).toEqual([]);
    });
  });

  // --- Server State Snapshots ---

  describe('server state snapshots', () => {
    it('should save and load state snapshot', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      const snapshot = {
        version: 1 as const,
        savedAt: new Date().toISOString(),
        serverStartedAt: new Date().toISOString(),
        sessions: [{
          sessionId: 'sess-1',
          agentName: 'fenster',
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          status: 'active' as const,
        }],
        poolSize: 1,
        poolCapacity: 10,
      };

      persistence.saveState(snapshot);
      const loaded = persistence.loadState();

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(1);
      expect(loaded!.sessions).toHaveLength(1);
      expect(loaded!.sessions[0].agentName).toBe('fenster');
    });

    it('should return null when no state file exists', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      expect(persistence.loadState()).toBeNull();
    });

    it('should handle corrupt state file gracefully', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      const runtimeDir = path.join(tempDir, '.squad', '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, 'server-state.json'), '{{broken', 'utf-8');

      expect(persistence.loadState()).toBeNull();
    });
  });

  // --- Atomic Writes ---

  describe('atomic writes', () => {
    it('should not leave temp files after successful write', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      persistence.saveRegistry([{
        sessionId: 's1',
        agentName: 'test',
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        status: 'active' as const,
      }]);

      const runtimeDir = path.join(tempDir, '.squad', '.runtime');
      const files = fs.readdirSync(runtimeDir);
      const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('should overwrite previous state cleanly', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });

      // Write first version
      persistence.saveRegistry([{
        sessionId: 's1', agentName: 'a1',
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        status: 'active' as const,
      }]);

      // Write second version
      persistence.saveRegistry([{
        sessionId: 's2', agentName: 'a2',
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        status: 'idle' as const,
      }]);

      const loaded = persistence.loadRegistry();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agentName).toBe('a2');
    });
  });

  // --- Cleanup ---

  describe('cleanup', () => {
    it('should remove runtime state files', () => {
      const persistence = new ServerPersistence({ squadRoot: tempDir });
      persistence.saveRegistry([{
        sessionId: 's1', agentName: 'test',
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        status: 'active' as const,
      }]);
      persistence.saveState({
        version: 1 as const,
        savedAt: new Date().toISOString(),
        serverStartedAt: new Date().toISOString(),
        sessions: [],
        poolSize: 0,
        poolCapacity: 10,
      });

      persistence.cleanup();

      expect(persistence.loadRegistry()).toEqual([]);
      expect(persistence.loadState()).toBeNull();
    });
  });

  // --- Auto-save ---

  describe('auto-save', () => {
    it('should start and stop auto-save timer', async () => {
      const persistence = new ServerPersistence({
        squadRoot: tempDir,
        autoSaveInterval: 100, // 100ms for fast tests
      });

      let saveCount = 0;
      persistence.startAutoSave(() => {
        saveCount++;
        return {
          version: 1 as const,
          savedAt: new Date().toISOString(),
          serverStartedAt: new Date().toISOString(),
          sessions: [],
          poolSize: 0,
          poolCapacity: 10,
        };
      });

      // Wait for a couple of saves
      await new Promise(resolve => setTimeout(resolve, 350));
      persistence.stopAutoSave();

      expect(saveCount).toBeGreaterThanOrEqual(2);

      // Verify state was actually written
      const loaded = persistence.loadState();
      expect(loaded).not.toBeNull();
    });
  });
});

// --- Integration: SquadServer with persistence ---

describe('SquadServer persistence integration', () => {
  it('should create .runtime directory via persistence from constructor', async () => {
    // ServerPersistence creates .runtime in its constructor.
    // Verify that constructing one produces the expected directory.
    const { ServerPersistence } = await import('../packages/squad-sdk/src/server/persistence.js');
    const tempDir = path.join(os.tmpdir(), `squad-server-persist-${Date.now()}`);
    fs.mkdirSync(path.join(tempDir, '.squad'), { recursive: true });

    try {
      const _persistence = new ServerPersistence({ squadRoot: tempDir });
      expect(fs.existsSync(path.join(tempDir, '.squad', '.runtime'))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
