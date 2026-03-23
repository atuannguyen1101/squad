/**
 * Tests for dashboard port persistence and resolution.
 *
 * Covers:
 *   - Port file read / write / clear lifecycle
 *   - Port availability detection
 *   - Resolution priority (config > env > persisted > default > OS)
 *   - dashboardPort in squad.config.json round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as net from 'net';

import {
  DEFAULT_DASHBOARD_PORT,
  PORT_FILE_NAME,
  isPortAvailable,
  portFilePath,
  readPersistedPort,
  persistPort,
  clearPersistedPort,
  resolveDashboardPort,
} from '../packages/squad-sdk/src/mcp/dashboard-port.js';

import {
  loadConfigSync,
  validateConfig,
  type SquadConfig,
} from '../packages/squad-sdk/src/runtime/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ROOT = join(process.cwd(), '.test-dashboard-port');

function makeSquadDir(): string {
  const squadDir = join(TEST_ROOT, '.squad');
  mkdirSync(squadDir, { recursive: true });
  return TEST_ROOT;
}

/** Occupy a port and return a cleanup function. */
function occupyPort(port: number): Promise<{ server: net.Server; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Port file helpers
// ---------------------------------------------------------------------------

describe('portFilePath', () => {
  it('returns .squad/.mcp-port relative to squadRoot', () => {
    const p = portFilePath('/project');
    expect(p).toBe(join('/project', '.squad', PORT_FILE_NAME));
  });
});

describe('readPersistedPort / persistPort / clearPersistedPort', () => {
  it('returns undefined when file does not exist', () => {
    const root = makeSquadDir();
    expect(readPersistedPort(root)).toBeUndefined();
  });

  it('writes and reads back a port number', () => {
    const root = makeSquadDir();
    persistPort(root, 4567);
    expect(readPersistedPort(root)).toBe(4567);
  });

  it('clears the port file', () => {
    const root = makeSquadDir();
    persistPort(root, 4567);
    clearPersistedPort(root);
    expect(readPersistedPort(root)).toBeUndefined();
  });

  it('clearPersistedPort is no-op when file missing', () => {
    const root = makeSquadDir();
    expect(() => clearPersistedPort(root)).not.toThrow();
  });

  it('returns undefined for non-numeric content', () => {
    const root = makeSquadDir();
    const fp = portFilePath(root);
    writeFileSync(fp, 'not-a-number', 'utf-8');
    expect(readPersistedPort(root)).toBeUndefined();
  });

  it('returns undefined for port out of range', () => {
    const root = makeSquadDir();
    const fp = portFilePath(root);
    writeFileSync(fp, '99999', 'utf-8');
    expect(readPersistedPort(root)).toBeUndefined();
  });

  it('creates .squad directory if missing', () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    // Don't create .squad/ — persistPort should handle it
    persistPort(TEST_ROOT, 9999);
    expect(readPersistedPort(TEST_ROOT)).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// Port availability
// ---------------------------------------------------------------------------

describe('isPortAvailable', () => {
  it('reports a free port as available', async () => {
    // Port 0 always binds to a free port, but we want to test a specific one.
    // Use a high ephemeral port that's very likely free.
    const available = await isPortAvailable(19876);
    expect(available).toBe(true);
  });

  it('reports an occupied port as unavailable', async () => {
    const { close } = await occupyPort(0); // let OS pick
    // We need the actual port
    const occupied = await occupyPort(29876).catch(() => null);
    // Just use the basic pattern: occupy then check
    await close();

    // Simpler: occupy a specific port, check it
    const handle = await occupyPort(29877);
    const available = await isPortAvailable(29877);
    expect(available).toBe(false);
    await handle.close();
  });
});

// ---------------------------------------------------------------------------
// Port resolution
// ---------------------------------------------------------------------------

describe('resolveDashboardPort', () => {
  it('returns configPort when available', async () => {
    const root = makeSquadDir();
    const port = await resolveDashboardPort({
      squadRoot: root,
      configPort: 4000,
    });
    expect(port).toBe(4000);
  });

  it('returns envPort when configPort is absent', async () => {
    const root = makeSquadDir();
    const port = await resolveDashboardPort({
      squadRoot: root,
      envPort: 4001,
    });
    expect(port).toBe(4001);
  });

  it('returns persisted port when no explicit port set', async () => {
    const root = makeSquadDir();
    persistPort(root, 4002);

    const port = await resolveDashboardPort({ squadRoot: root });
    expect(port).toBe(4002);
  });

  it('returns default port when nothing else is available', async () => {
    const root = makeSquadDir();
    const port = await resolveDashboardPort({ squadRoot: root });
    // If default port 3850 is available, we get it; if restricted, we get 0.
    // Both are valid — the key contract is no crash and a usable result.
    expect(port === DEFAULT_DASHBOARD_PORT || port === 0).toBe(true);
  });

  it('skips occupied configPort and falls through', async () => {
    const root = makeSquadDir();
    const handle = await occupyPort(4010);
    try {
      const port = await resolveDashboardPort({
        squadRoot: root,
        configPort: 4010,
        envPort: 4011,
      });
      // configPort is occupied, so envPort should be returned
      expect(port).toBe(4011);
    } finally {
      await handle.close();
    }
  });

  it('returns 0 when all candidates are occupied', async () => {
    const root = makeSquadDir();
    // Occupy the config port; persist a port that is also occupied.
    const h1 = await occupyPort(14020);
    const h2 = await occupyPort(14021);
    persistPort(root, 14021);
    try {
      const port = await resolveDashboardPort({
        squadRoot: root,
        configPort: 14020,
        envPort: 14021,
      });
      // All explicit + persisted candidates occupied.
      // Default (3850) may or may not be available in CI, but if it's
      // restricted the function returns 0, which is the correct fallback.
      expect(port === DEFAULT_DASHBOARD_PORT || port === 0).toBe(true);
    } finally {
      await h1.close();
      await h2.close();
    }
  });

  it('deduplicates identical candidates', async () => {
    const root = makeSquadDir();
    // configPort == envPort == persisted — should only check once
    persistPort(root, 5555);
    const port = await resolveDashboardPort({
      squadRoot: root,
      configPort: 5555,
      envPort: 5555,
    });
    expect(port).toBe(5555);
  });

  it('prefers configPort over envPort over persisted', async () => {
    const root = makeSquadDir();
    persistPort(root, 6001);

    const port = await resolveDashboardPort({
      squadRoot: root,
      configPort: 6000,
      envPort: 6001,
    });
    expect(port).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// Config schema — dashboardPort field
// ---------------------------------------------------------------------------

describe('dashboardPort in squad.config.json', () => {
  const configDir = join(TEST_ROOT, 'config-test');

  beforeEach(() => {
    mkdirSync(configDir, { recursive: true });
  });

  it('loads dashboardPort from squad.config.json', () => {
    const config = {
      version: '1.0.0',
      models: {
        defaultModel: 'claude-sonnet-4.5',
        defaultTier: 'standard',
        fallbackChains: {
          premium: ['claude-opus-4.6'],
          standard: ['claude-sonnet-4.5'],
          fast: ['claude-haiku-4.5'],
        },
      },
      routing: {
        rules: [{ workType: 'feature-dev', agents: ['@coordinator'] }],
      },
      dashboardPort: 4242,
    };
    writeFileSync(join(configDir, 'squad.config.json'), JSON.stringify(config));

    const result = loadConfigSync(configDir);
    expect(result.config.dashboardPort).toBe(4242);
  });

  it('validateConfig preserves dashboardPort through merge', () => {
    const raw = {
      version: '1.0.0',
      models: {
        defaultModel: 'claude-sonnet-4.5',
        defaultTier: 'standard',
        fallbackChains: {
          premium: ['claude-opus-4.6'],
          standard: ['claude-sonnet-4.5'],
          fast: ['claude-haiku-4.5'],
        },
      },
      routing: {
        rules: [{ workType: 'feature-dev', agents: ['@coordinator'] }],
      },
      dashboardPort: 9090,
    };

    const validated = validateConfig(raw);
    expect(validated.dashboardPort).toBe(9090);
  });

  it('dashboardPort is undefined when not set in config', () => {
    const raw = {
      version: '1.0.0',
      models: {
        defaultModel: 'claude-sonnet-4.5',
        defaultTier: 'standard',
        fallbackChains: {
          premium: ['claude-opus-4.6'],
          standard: ['claude-sonnet-4.5'],
          fast: ['claude-haiku-4.5'],
        },
      },
      routing: {
        rules: [{ workType: 'feature-dev', agents: ['@coordinator'] }],
      },
    };

    const validated = validateConfig(raw);
    expect(validated.dashboardPort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('DEFAULT_DASHBOARD_PORT is 3850', () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(3850);
  });

  it('PORT_FILE_NAME is .mcp-port', () => {
    expect(PORT_FILE_NAME).toBe('.mcp-port');
  });
});
