/**
 * Squad MCP — Start MCP server for Copilot integration
 *
 * `squad mcp [--squad-root <path>]`
 * Starts a stdio MCP server that Copilot can connect to.
 * Exposes squad_dispatch, squad_status tools.
 */

import path from 'node:path';
import fs from 'node:fs';
import { detectSquadDir } from '../core/detect-squad-dir.js';

export interface MCPOptions {
  squadRoot?: string;
}

export async function runMCP(cwd: string, options: MCPOptions): Promise<void> {
  // 1. Resolve squad root
  const squadRoot = options.squadRoot || (() => {
    try {
      const info = detectSquadDir(cwd);
      return path.dirname(info.path);
    } catch {
      return cwd;
    }
  })();

  // 2. Load minimal config
  let squadConfig: any = { team: { name: 'squad' }, routing: { rules: [] } };
  const configPath = path.join(squadRoot, 'squad.config.ts');
  if (fs.existsSync(configPath)) {
    try {
      const module = await import(configPath);
      squadConfig = module.default;
    } catch {
      // Fall back to minimal config
    }
  }

  // 3. Start MCP server (dynamic import to avoid loading when not needed)
  const { createSquadMCPServer } = await import('@bradygaster/squad-sdk/mcp');

  await createSquadMCPServer({
    squadRoot,
    squadConfig,
  });
}
