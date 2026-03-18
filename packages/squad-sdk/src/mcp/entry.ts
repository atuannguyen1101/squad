#!/usr/bin/env node
/**
 * MCP Server Entry Point
 * 
 * Standalone executable for use in .copilot/mcp-config.json:
 * { "command": "node", "args": ["path/to/dist/mcp/entry.js"] }
 * 
 * Reads SQUAD_ROOT from environment to locate .squad/ directory.
 */

import { createSquadMCPServer } from './server.js';

const squadRoot = process.env['SQUAD_ROOT'] || process.cwd();

createSquadMCPServer({ squadRoot }).catch((err) => {
  process.stderr.write(`[squad-mcp] Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
