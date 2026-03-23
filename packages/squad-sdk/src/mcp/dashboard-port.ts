/**
 * Dashboard Port Persistence
 *
 * Provides stable port selection for the Squad MCP dashboard.
 *
 * Resolution order:
 *   1. Explicit `dashboardPort` in squad.config.json
 *   2. `SQUAD_DASHBOARD_PORT` environment variable
 *   3. Previously persisted port from `.squad/.mcp-port` (if still available)
 *   4. Default port 3850
 *   5. OS-assigned random port (fallback when all above are in use)
 *
 * After the dashboard binds, the actual port is written to
 * `.squad/.mcp-port` so the next restart can reclaim it.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default dashboard port when nothing else is configured. */
export const DEFAULT_DASHBOARD_PORT = 3850;

/** Filename used to persist the port inside `.squad/`. */
export const PORT_FILE_NAME = '.mcp-port';

// ============================================================================
// Port availability check
// ============================================================================

/**
 * Tests whether a TCP port is available for binding on localhost.
 *
 * Creates a temporary server, attempts to listen, then tears it down.
 * Returns `true` if the port is free, `false` if it's in use.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => {
      resolve(false);
    });
    tester.listen(port, '127.0.0.1', () => {
      tester.close(() => resolve(true));
    });
  });
}

// ============================================================================
// Port file helpers
// ============================================================================

/**
 * Returns the absolute path to the port persistence file.
 */
export function portFilePath(squadRoot: string): string {
  return path.join(squadRoot, '.squad', PORT_FILE_NAME);
}

/**
 * Reads the persisted port from `.squad/.mcp-port`.
 *
 * Returns the port number, or `undefined` if the file doesn't exist or
 * contains invalid content.
 */
export function readPersistedPort(squadRoot: string): number | undefined {
  const filePath = portFilePath(squadRoot);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const port = parseInt(content, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) return undefined;
    return port;
  } catch {
    return undefined;
  }
}

/**
 * Writes the active dashboard port to `.squad/.mcp-port`.
 *
 * Creates the `.squad/` directory if it doesn't exist.
 */
export function persistPort(squadRoot: string, port: number): void {
  const filePath = portFilePath(squadRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, String(port), 'utf-8');
}

/**
 * Removes the persisted port file.
 *
 * Called during graceful shutdown so a stale file doesn't mislead the
 * next startup.
 */
export function clearPersistedPort(squadRoot: string): void {
  const filePath = portFilePath(squadRoot);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore — best-effort cleanup
  }
}

// ============================================================================
// Port resolution
// ============================================================================

/**
 * Options accepted by {@link resolveDashboardPort}.
 */
export interface PortResolutionOptions {
  /** Squad project root directory. */
  squadRoot: string;

  /**
   * Explicit port from `dashboardPort` in squad.config.json.
   * Takes highest priority when set.
   */
  configPort?: number;

  /**
   * Port read from `SQUAD_DASHBOARD_PORT` env var.
   * Second-highest priority.
   */
  envPort?: number;
}

/**
 * Resolves the best port for the dashboard to bind on.
 *
 * Resolution order:
 *   1. `configPort` (from squad.config.json `dashboardPort`)
 *   2. `envPort` (from SQUAD_DASHBOARD_PORT environment variable)
 *   3. Previously persisted port (from `.squad/.mcp-port`)
 *   4. {@link DEFAULT_DASHBOARD_PORT} (3850)
 *
 * For each candidate, availability is checked first. If a candidate port is
 * occupied, the next source is tried. If all candidates are exhausted, `0`
 * is returned to let the OS pick a random free port.
 *
 * @returns The port number to bind on (0 means "let the OS decide").
 */
export async function resolveDashboardPort(
  opts: PortResolutionOptions,
): Promise<number> {
  const candidates: number[] = [];

  // 1. Explicit config port
  if (opts.configPort != null && opts.configPort > 0) {
    candidates.push(opts.configPort);
  }

  // 2. Environment variable
  if (opts.envPort != null && opts.envPort > 0) {
    // Avoid duplicating the config port
    if (!candidates.includes(opts.envPort)) {
      candidates.push(opts.envPort);
    }
  }

  // 3. Persisted port
  const persisted = readPersistedPort(opts.squadRoot);
  if (persisted != null && !candidates.includes(persisted)) {
    candidates.push(persisted);
  }

  // 4. Default port
  if (!candidates.includes(DEFAULT_DASHBOARD_PORT)) {
    candidates.push(DEFAULT_DASHBOARD_PORT);
  }

  // Try each candidate in order
  for (const port of candidates) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  // All candidates occupied — let the OS assign one
  return 0;
}
